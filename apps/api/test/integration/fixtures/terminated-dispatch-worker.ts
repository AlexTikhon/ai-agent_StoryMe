import '../setup';
import { PrismaService } from '../../../src/database/prisma.service';
import { GenerationExecutionService } from '../../../src/agent/generation-execution.service';
import { GenerationRunService } from '../../../src/agent/generation-run.service';
import { executionPolicy } from '../../../src/agent/generation-execution-policy';

async function main() {
  const runId = process.argv[2]!;
  const boundary = process.argv[3];
  if (boundary !== 'before_intent' && boundary !== 'after_intent') {
    throw new Error('Expected before_intent or after_intent');
  }
  const db = new PrismaService();
  const run = await new GenerationRunService(db).claim(
    runId,
    `terminated-${boundary}`,
    `terminated-${boundary}`,
    60_000,
  );
  if (!run) throw new Error('Run was not claimable');
  const execution = new GenerationExecutionService(db);
  const ctx = {
    runId: run.id,
    bookId: run.bookId,
    fencingVersion: run.fencingVersion,
    inputHash: run.inputHash,
    inputSnapshot: run.inputSnapshot as never,
  };
  const policy = executionPolicy(
    {
      story: { providerName: 'openai' },
      image: { providerName: 'mock' },
      character: { providerName: 'mock' },
    },
    {
      MAX_PAID_PROVIDER_CALLS_PER_RUN: '1',
      REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: '1',
    },
  );
  const index = await execution.reserveOperation(ctx, policy, {
    callIndex: 1,
    operation: 'story',
    provider: 'openai',
    promptVersion: 'termination-v1',
    promptHash: 'a'.repeat(64),
    operationId: 'story:singleton',
    attempt: 1,
  });
  if (boundary === 'before_intent') process.exit(86);
  await execution.reserveHttpAttempt(ctx, policy, index);
  process.exit(86);
}

void main().catch(() => process.exit(1));
