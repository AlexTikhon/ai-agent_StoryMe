import '../setup';
import { PrismaService } from '../../../src/database/prisma.service';
import { GenerationExecutionService } from '../../../src/agent/generation-execution.service';
import { GenerationRunService } from '../../../src/agent/generation-run.service';
import { LocalImageAssetStorage } from '../../../src/images/image-asset-storage';
import { LocalPdfStorage } from '../../../src/pdf/pdf-storage';
import { MockStoryGenerationProvider } from '../../../src/agent/story-generation-provider';
import { MockCharacterProfileProvider } from '../../../src/agent/character-profile-provider';
import { MockImageGenerationProvider } from '../../../src/images/image-generation-provider';
import { createTestAgentService } from '../../../src/common/test-utils/create-test-agent-service';
import type { GenerationExecutionContext } from '../../../src/agent/generation-execution-context';

async function main() {
  const db = new PrismaService();
  const stopAfterStoredImages = Number(process.argv[3] ?? '3');
  if (!Number.isInteger(stopAfterStoredImages) || stopAfterStoredImages < 1) {
    throw new Error('A positive stored-image termination boundary is required');
  }
  const run = await new GenerationRunService(db).claim(process.argv[2]!, 'child', 'child', 60_000);
  if (!run) throw new Error('Test run could not be claimed');
  const execution = new GenerationExecutionService(db);
  const checkpoint = execution.checkpoint.bind(execution);
  let tail = Promise.resolve();
  let storedImages = 0;
  execution.checkpoint = (...args) => {
    tail = tail.then(async () => {
      await checkpoint(...args);
      if (Object.keys(args[3] ?? {}).some((label) => label !== 'character_sheet')) {
        storedImages++;
        // Abrupt process death: no disconnect, cleanup, catch, or failure transition.
        if (storedImages === stopAfterStoredImages) process.exit(86);
      }
    });
    return tail;
  };
  const agent = createTestAgentService(
    db,
    new LocalPdfStorage(),
    new LocalImageAssetStorage(),
    new MockStoryGenerationProvider(),
    new MockImageGenerationProvider(),
    new MockCharacterProfileProvider(),
    execution,
  );
  await agent.startBookGeneration({
    runId: run.id,
    bookId: run.bookId,
    fencingVersion: run.fencingVersion,
    inputHash: run.inputHash,
    inputSnapshot: run.inputSnapshot as GenerationExecutionContext['inputSnapshot'],
    executionAuthorization: run.executionAuthorization,
  });
  throw new Error('Worker did not reach the termination boundary');
}
void main().catch(() => process.exit(1));
