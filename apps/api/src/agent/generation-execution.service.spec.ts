import { AgentStep, GenerationRunStatus } from '@prisma/client';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { GenerationExecutionContext } from './generation-execution-context';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from './generation-execution.service';

describe('GenerationExecutionService.markStep', () => {
  const ctx: GenerationExecutionContext = {
    runId: 'run-1',
    bookId: 'book-1',
    fencingVersion: 3,
    inputSnapshot: {},
    inputHash: 'hash-1',
  };

  it('persists a stage only for the running fenced attempt', async () => {
    const prisma = createMockPrisma();
    prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    const service = new GenerationExecutionService(prisma as never);

    await service.markStep(ctx, AgentStep.image_gen);

    expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
        status: GenerationRunStatus.running,
        fencingVersion: 3,
      },
      data: { currentStep: AgentStep.image_gen },
    });
  });

  it('rejects a stale attempt whose fence no longer matches', async () => {
    const prisma = createMockPrisma();
    prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });
    const service = new GenerationExecutionService(prisma as never);

    await expect(service.markStep(ctx, AgentStep.pdf_render)).rejects.toThrow(
      StaleGenerationRunError,
    );
  });
});
