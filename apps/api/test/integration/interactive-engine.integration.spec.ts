import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashState, parseState } from '../../src/interactive/domain/state';
import { InteractiveService } from '../../src/interactive/interactive.service';
import { WARSAW_ROUTES } from '../../src/interactive/scenarios/routes';
import { PrismaService } from '../../src/database/prisma.service';
import {
  InteractiveTestKit,
  SCENARIO_ID,
  configWithCap,
  startCommand,
  withTransactionFault,
} from './fixtures/interactive-helpers';

/** Resolves to the stable `code` of the HttpException a promise rejects with. */
async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code?: string }).code;
    }
    throw error;
  }
  return undefined;
}

describe('Interactive engine persistence (real Postgres)', () => {
  const kit = new InteractiveTestKit();

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => kit.cleanup());

  it('creates the session and its genesis event atomically', async () => {
    const userId = await kit.createUser();
    const view = await kit.start(userId);

    expect(view).toMatchObject({
      revision: 0,
      status: 'in_progress',
      scene: { id: 's-courtyard' },
    });
    const session = await kit.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: view.sessionId },
    });
    expect(session).toMatchObject({
      userId,
      scenarioId: SCENARIO_ID,
      scenarioVersion: 1,
      revision: 0,
    });
    const events = await kit.prisma.sessionEvent.findMany({ where: { sessionId: view.sessionId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 0,
      type: 'SessionStarted',
      schemaVersion: 1,
      idempotencyKey: null,
      requestHash: null,
      stateHash: hashState(parseState(session.state)),
      response: view,
    });
    await kit.assertReplayMatchesStored(view.sessionId);
  });

  it('rolls back the session when the genesis event cannot be written', async () => {
    const userId = await kit.createUser();
    const faulty = new InteractiveService(
      withTransactionFault(kit.prisma, { model: 'sessionEvent', method: 'create' }),
      kit.narrator,
      configWithCap(50),
    );
    await expect(faulty.createSession(userId, startCommand())).rejects.toThrow(
      'injected write failure',
    );
    expect(await kit.prisma.interactiveSession.count({ where: { userId } })).toBe(0);
  });

  it('rejects an unknown scenario without writing anything', async () => {
    const userId = await kit.createUser();
    expect(
      await failureCode(kit.service.createSession(userId, startCommand('no-such-scenario'))),
    ).toBe('UNKNOWN_SCENARIO');
    expect(await kit.prisma.interactiveSession.count({ where: { userId } })).toBe(0);
  });

  it('keeps replay equal to the stored state after every accepted choice and reaches both endings', async () => {
    const userId = await kit.createUser();
    const endings = new Set<string>();
    for (const route of Object.values(WARSAW_ROUTES)) {
      let view = await kit.start(userId);
      for (const [index, choiceId] of route.entries()) {
        expect(view.choices.map((c) => c.id)).toContain(choiceId);
        view = await kit.choose(userId, view, choiceId);
        expect(view.revision).toBe(index + 1);
        await kit.assertReplayMatchesStored(view.sessionId);
        expect(await kit.eventCount(view.sessionId)).toBe(index + 2);
      }
      expect(view.status).toBe('ended');
      expect(view.choices).toEqual([]);
      endings.add(view.ending!.id);

      // GET returns the stored response for the latest revision.
      expect(await kit.service.getSession(userId, view.sessionId)).toEqual(view);
    }
    expect(endings).toEqual(new Set(['ledger-exposed', 'quiet-delivery']));
  });

  it('rejects choices that are unknown, locked, or after an ending, leaving state untouched', async () => {
    const userId = await kit.createUser();
    let view = await kit.start(userId);
    const attempt = (choiceId: string) => kit.choose(userId, view, choiceId);

    expect(await failureCode(attempt('c-invented'))).toBe('UNKNOWN_CHOICE');
    expect(await failureCode(attempt('c-confront-ines'))).toBe('UNKNOWN_CHOICE');
    for (const choiceId of WARSAW_ROUTES.quietAtDoor)
      view = await kit.choose(userId, view, choiceId);
    expect(view.status).toBe('ended');
    expect(await failureCode(attempt('c-ask-caretaker'))).toBe('SESSION_TERMINAL');

    // Locked branch: the mailbox route has no entry card.
    let other = await kit.start(userId);
    other = await kit.choose(userId, other, 'c-read-mailboxes');
    other = await kit.choose(userId, other, 'c-climb-from-mailboxes');
    expect(other.choices.map((c) => c.id)).not.toContain('c-use-card');
    expect(await failureCode(kit.choose(userId, other, 'c-use-card'))).toBe('CHOICE_UNAVAILABLE');

    await kit.assertReplayMatchesStored(view.sessionId);
    await kit.assertReplayMatchesStored(other.sessionId);
    expect(await kit.eventCount(view.sessionId)).toBe(4);
    expect(await kit.eventCount(other.sessionId)).toBe(3);
  });

  describe('idempotency', () => {
    it('returns the original response for an exact retry, even after later choices', async () => {
      const userId = await kit.createUser();
      const start = await kit.start(userId);
      const command = {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'retry-key-1',
      };

      const first = await kit.service.submitChoice(userId, start.sessionId, command);
      const second = await kit.choose(userId, first, 'c-climb-from-caretaker');
      expect(second.revision).toBe(2);
      const narrateCalls = kit.narrator.calls;

      const retry = await kit.service.submitChoice(userId, start.sessionId, command);
      expect(retry).toEqual(first);
      expect(retry.revision).toBe(1);
      expect(await kit.eventCount(start.sessionId)).toBe(3);
      // No narration is regenerated for a saved response.
      expect(kit.narrator.calls).toBe(narrateCalls);
      await kit.assertReplayMatchesStored(start.sessionId);
    });

    it('rejects the same key with a different command fingerprint', async () => {
      const userId = await kit.createUser();
      const start = await kit.start(userId);
      const key = 'reused-key-1';
      await kit.service.submitChoice(userId, start.sessionId, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: key,
      });

      const differentChoice = kit.service.submitChoice(userId, start.sessionId, {
        choiceId: 'c-read-mailboxes',
        expectedRevision: 0,
        idempotencyKey: key,
      });
      expect(await failureCode(differentChoice)).toBe('IDEMPOTENCY_KEY_REUSED');

      const differentRevision = kit.service.submitChoice(userId, start.sessionId, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 1,
        idempotencyKey: key,
      });
      expect(await failureCode(differentRevision)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await kit.eventCount(start.sessionId)).toBe(2);
    });

    it('accepts equal keys in different sessions', async () => {
      const userId = await kit.createUser();
      const a = await kit.start(userId);
      const b = await kit.start(userId);
      const command = {
        choiceId: 'c-read-mailboxes',
        expectedRevision: 0,
        idempotencyKey: 'shared-key-1',
      };
      const [viewA, viewB] = [
        await kit.service.submitChoice(userId, a.sessionId, command),
        await kit.service.submitChoice(userId, b.sessionId, command),
      ];
      expect(viewA.sessionId).toBe(a.sessionId);
      expect(viewB.sessionId).toBe(b.sessionId);
      expect(viewA.revision).toBe(1);
      expect(viewB.revision).toBe(1);
    });

    it('does not reserve a key for a failed command', async () => {
      const userId = await kit.createUser();
      const start = await kit.start(userId);
      const key = 'failed-then-ok-1';

      expect(
        await failureCode(
          kit.service.submitChoice(userId, start.sessionId, {
            choiceId: 'c-invented',
            expectedRevision: 0,
            idempotencyKey: key,
          }),
        ),
      ).toBe('UNKNOWN_CHOICE');
      expect(
        await failureCode(
          kit.service.submitChoice(userId, start.sessionId, {
            choiceId: 'c-ask-caretaker',
            expectedRevision: 5,
            idempotencyKey: key,
          }),
        ),
      ).toBe('REVISION_CONFLICT');

      const ok = await kit.service.submitChoice(userId, start.sessionId, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: key,
      });
      expect(ok.revision).toBe(1);
    });

    it('reports a stale revision as REVISION_CONFLICT for a fresh key', async () => {
      const userId = await kit.createUser();
      const start = await kit.start(userId);
      await kit.choose(userId, start, 'c-ask-caretaker');
      expect(await failureCode(kit.choose(userId, start, 'c-read-mailboxes'))).toBe(
        'REVISION_CONFLICT',
      );
      expect(await kit.eventCount(start.sessionId)).toBe(2);
    });
  });

  describe('failure handling', () => {
    it('rolls back both the event and the state when the write fails after the insert', async () => {
      const userId = await kit.createUser();
      const start = await kit.start(userId);
      const before = await kit.prisma.interactiveSession.findUniqueOrThrow({
        where: { id: start.sessionId },
      });

      const faulty = new InteractiveService(
        withTransactionFault(kit.prisma, { model: 'interactiveSession', method: 'updateMany' }),
        kit.narrator,
        configWithCap(50),
      );
      await expect(
        faulty.submitChoice(userId, start.sessionId, {
          choiceId: 'c-ask-caretaker',
          expectedRevision: 0,
          idempotencyKey: 'rollback-key-1',
        }),
      ).rejects.toThrow('injected write failure');

      // The event insert happened first inside the transaction and must be gone.
      expect(await kit.eventCount(start.sessionId)).toBe(1);
      const after = await kit.prisma.interactiveSession.findUniqueOrThrow({
        where: { id: start.sessionId },
      });
      expect(after.revision).toBe(0);
      expect(after.state).toEqual(before.state);

      // Neither the key nor the session was poisoned.
      const retried = await kit.service.submitChoice(userId, start.sessionId, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'rollback-key-1',
      });
      expect(retried.revision).toBe(1);
      await kit.assertReplayMatchesStored(start.sessionId);
    });

    it('changes neither state nor event count when narration is invalid', async () => {
      const userId = await kit.createUser();
      const start = await kit.start(userId);

      kit.narrator.mode = 'invalid-text';
      expect(await failureCode(kit.choose(userId, start, 'c-ask-caretaker', 'bad-narr-1'))).toBe(
        'NARRATION_INVALID',
      );
      expect(await kit.eventCount(start.sessionId)).toBe(1);
      const session = await kit.prisma.interactiveSession.findUniqueOrThrow({
        where: { id: start.sessionId },
      });
      expect(session.revision).toBe(0);
      expect(await kit.service.getSession(userId, start.sessionId)).toEqual(start);

      // The session lock was released and the key is reusable once narration is valid.
      kit.narrator.mode = 'valid';
      const ok = await kit.choose(userId, start, 'c-ask-caretaker', 'bad-narr-1');
      expect(ok.revision).toBe(1);
      await kit.assertReplayMatchesStored(start.sessionId);
    });

    it('rejects an invalid choice before any narration is requested', async () => {
      const userId = await kit.createUser();
      const start = await kit.start(userId);
      const before = kit.narrator.calls;
      await failureCode(kit.choose(userId, start, 'c-use-card'));
      expect(kit.narrator.calls).toBe(before);
    });
  });

  describe('ownership', () => {
    it('hides other users sessions: same 404 for read, choose, and cached responses', async () => {
      const ownerId = await kit.createUser();
      const intruderId = await kit.createUser();
      const start = await kit.start(ownerId);
      const command = {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'owner-key-1',
      };
      const owned = await kit.service.submitChoice(ownerId, start.sessionId, command);
      expect(owned.revision).toBe(1);

      const missingId = randomUUID();
      const bodyOf = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (error) {
          return {
            status: (error as HttpException).getStatus(),
            body: (error as HttpException).getResponse(),
          };
        }
        throw new Error('expected a rejection');
      };
      const missing = await bodyOf(kit.service.getSession(ownerId, missingId));
      expect(missing.status).toBe(404);

      // Same status and body as a session that does not exist.
      expect(await bodyOf(kit.service.getSession(intruderId, start.sessionId))).toEqual(missing);
      // The owner's saved response is not obtainable by replaying the owner's key.
      expect(await bodyOf(kit.service.submitChoice(intruderId, start.sessionId, command))).toEqual(
        missing,
      );
      expect(
        await bodyOf(
          kit.service.submitChoice(intruderId, start.sessionId, {
            ...command,
            idempotencyKey: 'fresh-key-1',
          }),
        ),
      ).toEqual(missing);
      expect(await bodyOf(kit.service.submitChoice(ownerId, missingId, command))).toEqual(missing);

      expect(await kit.eventCount(start.sessionId)).toBe(2);
      await kit.assertReplayMatchesStored(start.sessionId);
    });
  });

  it('resumes the same session through a new service instance', async () => {
    const userId = await kit.createUser();
    let view = await kit.start(userId);
    view = await kit.choose(userId, view, 'c-ask-caretaker');

    const freshPrisma = new PrismaService();
    await freshPrisma.$connect();
    try {
      const fresh = new InteractiveService(freshPrisma, kit.narrator, configWithCap(50));
      expect(await fresh.getSession(userId, view.sessionId)).toEqual(view);
      const next = await fresh.submitChoice(userId, view.sessionId, {
        choiceId: 'c-climb-from-caretaker',
        expectedRevision: 1,
        idempotencyKey: 'resume-key-1',
      });
      expect(next).toMatchObject({ revision: 2, scene: { id: 's-door' } });
    } finally {
      await freshPrisma.$disconnect();
    }
    await kit.assertReplayMatchesStored(view.sessionId);
  });

  it('keeps sessions pinned to their scenario version', async () => {
    const userId = await kit.createUser();
    const view = await kit.start(userId);
    const session = await kit.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: view.sessionId },
    });
    expect(session.scenarioVersion).toBe(1);
    // A session pinned to a version this build does not ship is refused, not migrated.
    await kit.prisma.interactiveSession.update({
      where: { id: view.sessionId },
      data: { scenarioVersion: 2 },
    });
    expect(await failureCode(kit.choose(userId, view, 'c-ask-caretaker'))).toBe(
      'SCENARIO_VERSION_UNAVAILABLE',
    );
    expect(await kit.eventCount(view.sessionId)).toBe(1);
  });
});
