import type { Book, GenerationJob, GenerationRun } from '@prisma/client';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import type { AgentService } from '../agent/agent.service';
import type { GenerationExecutionContext } from '../agent/generation-execution-context';
import { StaleGenerationRunError } from '../agent/generation-execution.service';
import type { GenerationJobService } from '../agent/generation-job.service';
import type { GenerationOutcome } from '../agent/generation-outcome';
import type { GenerationQueueService } from '../agent/generation-queue.service';
import {
  type GenerationRunCoordinator,
  GenerationRunMirrorInvariantError,
} from '../agent/generation-run-coordinator.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { BookGenerationExecutionService } from './book-generation-execution.service';

const SNAPSHOT = {
  childName: 'Mia',
  childAge: 5,
  language: 'en',
  theme: 'friendship',
  educationalMessage: null,
  pageCount: 6,
  childPhoto: null,
};

const CTX: GenerationExecutionContext = {
  runId: 'run-1',
  bookId: 'book-1',
  fencingVersion: 3,
  inputHash: 'input-hash',
  inputSnapshot: SNAPSHOT,
};

function makeBook(): Book {
  return {
    id: 'book-1',
    userId: 'user-1',
    title: 'Mia and the Moon',
    childName: 'Mia',
    childAge: 5,
    language: 'en',
    theme: 'friendship',
    educationalMessage: null,
    pageCount: 6,
    status: 'cancelled',
    characterCard: null,
    storyPlan: null,
    bookPreview: null,
    imageGenerationResult: null,
    bookLayout: null,
    characterProfile: null,
    previewPdfUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as Book;
}

function makeJob(): GenerationJob {
  return { id: 'job-1', bookId: 'book-1' } as GenerationJob;
}

function makeOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
  return {
    status: 'complete',
    completedStep: 'pdf_render',
    bookUpdate: {},
    agentLogs: [],
    ...overrides,
  };
}

describe('BookGenerationExecutionService', () => {
  const prisma = createMockPrisma();
  const agent = {
    startBookGeneration: vi.fn(),
  } as unknown as jest.Mocked<AgentService>;
  const queue = {
    removeIfSafe: vi.fn(),
  } as unknown as jest.Mocked<GenerationQueueService>;
  const jobs = {
    findActive: vi.fn(),
    markRunning: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    markCancelled: vi.fn(),
  } as unknown as jest.Mocked<GenerationJobService>;
  const coordinator = {
    cancelGeneration: vi.fn(),
    completeRun: vi.fn(),
    failAbandoned: vi.fn(),
  } as unknown as jest.Mocked<GenerationRunCoordinator>;

  let service: BookGenerationExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    jobs.findActive.mockResolvedValue(null);
    jobs.markRunning.mockResolvedValue(makeJob());
    jobs.markCompleted.mockResolvedValue(makeJob());
    jobs.markFailed.mockResolvedValue(makeJob());
    jobs.markCancelled.mockResolvedValue(makeJob());
    queue.removeIfSafe.mockResolvedValue(undefined);
    coordinator.completeRun.mockResolvedValue('applied');
    coordinator.failAbandoned.mockResolvedValue('applied');
    agent.startBookGeneration.mockResolvedValue(makeOutcome());
    service = new BookGenerationExecutionService(prisma as never, agent, queue, jobs, coordinator);
  });

  it('runs cancellation follow-ups only after the authoritative transaction applies', async () => {
    coordinator.cancelGeneration.mockResolvedValue({
      kind: 'applied',
      runId: 'run-1',
      book: makeBook(),
      creditsRefunded: true,
    });
    jobs.findActive.mockResolvedValue(makeJob());

    const result = await service.cancelGeneration('user-1', 'book-1');

    expect(coordinator.cancelGeneration).toHaveBeenCalledWith({
      userId: 'user-1',
      bookId: 'book-1',
    });
    expect(jobs.markCancelled).toHaveBeenCalledWith('job-1');
    expect(queue.removeIfSafe).toHaveBeenCalledWith('run-1');
    expect(result.creditsRefunded).toBe(true);
  });

  it('publishes a successful pipeline outcome through the fenced coordinator', async () => {
    const outcome = makeOutcome();
    agent.startBookGeneration.mockResolvedValue(outcome);

    await service.runGenerationPipeline(CTX);

    expect(agent.startBookGeneration).toHaveBeenCalledWith(CTX);
    expect(coordinator.completeRun).toHaveBeenCalledWith(CTX, outcome);
  });

  it('quietly abandons a stale claim without attempting publication', async () => {
    agent.startBookGeneration.mockRejectedValue(new StaleGenerationRunError('run-1', 'layout'));

    await expect(service.runGenerationPipeline(CTX)).resolves.toBeUndefined();

    expect(coordinator.completeRun).not.toHaveBeenCalled();
  });

  it('rethrows unexpected pipeline errors so BullMQ can retry them', async () => {
    jobs.findActive.mockResolvedValue(makeJob());
    agent.startBookGeneration.mockRejectedValue(new Error('temporary database failure'));

    await expect(service.runGenerationPipeline(CTX)).rejects.toThrow('temporary database failure');

    expect(coordinator.completeRun).not.toHaveBeenCalled();
    expect(jobs.markFailed).toHaveBeenCalledWith('job-1', {
      errorMessage: 'temporary database failure',
    });
  });

  it('turns a coordinator mirror mismatch into a retryable invariant error', async () => {
    coordinator.completeRun.mockResolvedValue('book_mirror_mismatch');

    await expect(service.runGenerationPipeline(CTX)).rejects.toBeInstanceOf(
      GenerationRunMirrorInvariantError,
    );
  });

  it('fences the exhausted-retry backstop on the running GenerationRun', async () => {
    prisma.generationRun.findUnique.mockResolvedValue({
      id: 'run-1',
      bookId: 'book-1',
      status: 'running',
      fencingVersion: 3,
    } as GenerationRun);

    await service.markRunPermanentlyFailedAfterExhaustedRetries('run-1');

    expect(coordinator.failAbandoned).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        bookId: 'book-1',
        fencingVersion: 3,
        fromStatus: 'running',
      },
      {
        errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE',
        errorMessage: expect.any(String),
      },
    );
  });
});
