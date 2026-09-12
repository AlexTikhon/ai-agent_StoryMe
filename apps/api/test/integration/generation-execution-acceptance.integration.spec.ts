import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type Book } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationExecutionService } from '../../src/agent/generation-execution.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import { executionPolicy } from '../../src/agent/generation-execution-policy';
import { GenerationProviderTelemetry } from '../../src/agent/generation-provider-telemetry';
import { OpenAIStoryGenerationProvider } from '../../src/agent/openai-story-generation-provider';
import { MockCharacterProfileProvider } from '../../src/agent/character-profile-provider';

describe('mandatory provider execution acceptance (disposable PostgreSQL, fake HTTP)', () => {
  const db = new PrismaService();
  const execution = new GenerationExecutionService(db);
  const users: string[] = [];

  beforeAll(() => db.$connect());
  afterAll(() => db.$disconnect());
  afterEach(async () => {
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });

  async function queuedBookAndRun() {
    const user = await db.user.create({
      data: { email: `gateway-${randomUUID()}@example.test` },
    });
    users.push(user.id);
    const book = await db.book.create({
      data: {
        userId: user.id,
        status: 'char_build',
        childName: 'Mia',
        childAge: 6,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
      },
    });
    const snapshot = buildInputSnapshot(book);
    const run = await db.generationRun.create({
      data: {
        bookId: book.id,
        userId: user.id,
        kind: 'initial',
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
      },
    });
    await db.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });
    return { book, run, snapshot };
  }

  async function claim(book: Book, runId: string) {
    const run = await new GenerationRunService(db).claim(
      runId,
      randomUUID(),
      'acceptance-worker',
      60_000,
    );
    if (!run) throw new Error('Run could not be claimed');
    return {
      runId: run.id,
      bookId: book.id,
      fencingVersion: run.fencingVersion,
      inputHash: run.inputHash,
      inputSnapshot: run.inputSnapshot as never,
    };
  }

  const openAiPolicy = () =>
    executionPolicy(
      {
        story: { providerName: 'openai' },
        image: { providerName: 'openai' },
        character: { providerName: 'openai' },
      },
      {
        MAX_PAID_PROVIDER_CALLS_PER_RUN: '10',
        REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: '10',
        REAL_GENERATION_MAX_IMAGES_PER_RUN: '10',
        REAL_GENERATION_MAX_ESTIMATED_COST_USD: '1',
        OPENAI_STORY_ESTIMATED_COST_USD: '0.02',
        OPENAI_CHARACTER_PROFILE_ESTIMATED_COST_USD: '0.02',
        OPENAI_IMAGE_ESTIMATED_COST_USD: '0.02',
        OPENAI_MAX_RETRIES: '0',
        OPENAI_IMAGE_TIMEOUT_MAX_RETRIES: '0',
        OPENAI_IMAGE_MAX_RETRIES: '0',
      },
    );

  const providerCall = (
    operation: 'story' | 'story_repair' | 'character_profile' | 'illustration',
  ) => ({
    callIndex: 1,
    operation,
    provider: 'openai' as const,
    promptVersion: 'acceptance-v1',
    promptHash: 'a'.repeat(64),
    operationId: `${operation}:${randomUUID()}`,
    attempt: 1,
    estimatedCostUsd: 0.02,
  });

  it('serializes concurrent durable reservations so the total cap cannot be crossed', async () => {
    const seeded = await queuedBookAndRun();
    const ctx = await claim(seeded.book, seeded.run.id);
    const policy = {
      ...openAiPolicy(),
      maxPaidCalls: 1,
      limits: { ...openAiPolicy().limits, maxProviderCalls: 1 },
    };

    const results = await Promise.allSettled([
      execution.reserveOperation(ctx, policy, providerCall('story')),
      execution.reserveOperation(ctx, policy, providerCall('character_profile')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const persisted = await db.generationRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(persisted.providerOperations).toHaveLength(1);
  });

  it('enforces category, total-dispatch and estimated-cost caps through the same durable gateway', async () => {
    const category = await queuedBookAndRun();
    const categoryCtx = await claim(category.book, category.run.id);
    await db.generationRun.update({
      where: { id: category.run.id },
      data: {
        executionAuthorization: {
          version: 2,
          policy: openAiPolicy(),
          estimate: {
            maximumProviderCalls: 10,
            storyCalls: 1,
            repairAllowanceCalls: 0,
            characterProfileCalls: 1,
            imageCalls: 1,
          },
          envelope: {
            logicalOperations: { story: 1, character: 1, image: 1 },
            attemptsPerOperation: { story: 1, character: 1, image: 1 },
            maxDispatches: 10,
            maxEstimatedExposureUsd: 1,
            repairAllowance: 0,
          },
        } as Prisma.InputJsonValue,
      },
    });
    await execution.reserveOperation(categoryCtx, openAiPolicy(), providerCall('story'));
    await expect(
      execution.reserveOperation(categoryCtx, openAiPolicy(), providerCall('story_repair')),
    ).rejects.toMatchObject({ reason: 'budget_rejection' });

    const total = await queuedBookAndRun();
    const totalCtx = await claim(total.book, total.run.id);
    await db.generationRun.update({
      where: { id: total.run.id },
      data: {
        executionAuthorization: {
          version: 2,
          policy: openAiPolicy(),
          estimate: {
            maximumProviderCalls: 2,
            storyCalls: 1,
            repairAllowanceCalls: 0,
            characterProfileCalls: 1,
            imageCalls: 1,
          },
          envelope: {
            logicalOperations: { story: 1, character: 1, image: 1 },
            attemptsPerOperation: { story: 1, character: 1, image: 1 },
            maxDispatches: 2,
            maxEstimatedExposureUsd: 1,
            repairAllowance: 0,
          },
        } as Prisma.InputJsonValue,
      },
    });
    for (const operation of ['story', 'character_profile'] as const) {
      const index = await execution.reserveOperation(
        totalCtx,
        openAiPolicy(),
        providerCall(operation),
      );
      await execution.reserveHttpAttempt(totalCtx, openAiPolicy(), index);
      await execution.finishOperation(totalCtx, index, 'response_received');
    }
    await expect(
      execution.reserveOperation(totalCtx, openAiPolicy(), providerCall('illustration')),
    ).rejects.toMatchObject({ reason: 'budget_rejection' });

    const cost = await queuedBookAndRun();
    const costCtx = await claim(cost.book, cost.run.id);
    await db.generationRun.update({
      where: { id: cost.run.id },
      data: {
        executionAuthorization: {
          version: 2,
          policy: openAiPolicy(),
          estimate: {
            maximumProviderCalls: 10,
            storyCalls: 1,
            repairAllowanceCalls: 0,
            characterProfileCalls: 1,
            imageCalls: 0,
            estimatedCostUsd: { maximum: 0.03 },
          },
          envelope: {
            logicalOperations: { story: 1, character: 1, image: 0 },
            attemptsPerOperation: { story: 1, character: 1, image: 1 },
            maxDispatches: 10,
            maxEstimatedExposureUsd: 0.03,
            repairAllowance: 0,
          },
        } as Prisma.InputJsonValue,
      },
    });
    const first = await execution.reserveOperation(costCtx, openAiPolicy(), providerCall('story'));
    await execution.reserveHttpAttempt(costCtx, openAiPolicy(), first);
    await expect(
      execution.reserveOperation(costCtx, openAiPolicy(), providerCall('character_profile')),
    ).rejects.toMatchObject({ reason: 'budget_rejection' });
  });

  it.each(['before_intent', 'after_intent'] as const)(
    'survives real process termination %s and preserves the correct dispatch exposure',
    async (boundary) => {
      const seeded = await queuedBookAndRun();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            '-r',
            'tsconfig-paths/register',
            'test/integration/fixtures/terminated-dispatch-worker.ts',
            seeded.run.id,
            boundary,
          ],
          {
            env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.scripts.json' },
            stdio: 'ignore',
          },
        );
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(exitCode).toBe(86);
      const persisted = await db.generationRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
      const operation = (persisted.providerOperations as Array<Record<string, unknown>>)[0]!;
      expect(operation.state).toBe(
        boundary === 'before_intent' ? 'reserved_unsent' : 'dispatch_intent',
      );
      expect(Number(operation.httpAttempts ?? 0)).toBe(boundary === 'before_intent' ? 0 : 1);
    },
  );

  it('routes a fake HTTP OpenAI adapter call through durable accounting without a paid request', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      pageNumber: index + 1,
      title: `Page ${index + 1}`,
      sceneDescription: `Scene ${index + 1}`,
      storyText: `Mia makes a kind choice on page ${index + 1}.`,
      illustrationPrompt: `Mia in scene ${index + 1}`,
      learningGoal: 'Kindness',
    }));
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req_fake_acceptance_123',
      });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  title: 'Mia and the Kind Forest',
                  subtitle: null,
                  theme: 'friendship',
                  educationalMessage: 'Kindness matters',
                  openingHook: 'Mia heard a soft sound.',
                  resolution: 'Everyone helped.',
                  pages,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 41, completion_tokens: 97 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fake provider did not bind');
      const seeded = await queuedBookAndRun();
      const ctx = await claim(seeded.book, seeded.run.id);
      const telemetry = new GenerationProviderTelemetry(1, 1, {
        OPENAI_STORY_ESTIMATED_COST_USD: '0.02',
      });
      telemetry.bind(execution, ctx, openAiPolicy());
      const characterProfile = await new MockCharacterProfileProvider().buildProfile({
        bookId: seeded.book.id,
        childName: 'Mia',
        childAge: 6,
        theme: 'friendship',
        language: 'en',
      });
      const provider = new OpenAIStoryGenerationProvider({
        apiKey: 'fake-local-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'fake-openai-model',
        maxRetries: 0,
      });
      await telemetry.record({
        operation: 'story',
        provider: 'openai',
        model: provider.modelName,
        promptVersion: provider.promptVersion,
        promptInput: { test: 'hash-only' },
        execute: (options) =>
          provider.generateStory(
            {
              bookId: seeded.book.id,
              childName: 'Mia',
              childAge: 6,
              theme: 'friendship',
              language: 'en',
              pageCount: 6,
              characterProfile,
            },
            options,
          ),
      });

      const persisted = await db.generationRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
      const operation = (persisted.providerOperations as Array<Record<string, any>>)[0]!;
      expect(operation).toMatchObject({
        state: 'response_received',
        providerRequestId: 'req_fake_acceptance_123',
        inputTokens: 41,
        outputTokens: 97,
        httpAttempts: 1,
      });
      expect(operation.dispatches).toEqual([
        expect.objectContaining({
          deliveryToken: expect.any(String),
          deliveryFencingVersion: ctx.fencingVersion,
          providerRequestId: 'req_fake_acceptance_123',
          inputTokens: 41,
          outputTokens: 97,
          durationMs: expect.any(Number),
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
