import type { AgentStep, Prisma } from '@prisma/client';
import { BookStatus } from '@prisma/client';

/**
 * What AgentService.startBookGeneration computed for one claimed run, without
 * itself writing Book.status=complete/failed — that terminal flip must happen
 * atomically alongside the GenerationRun terminal transition and
 * activeRunId/publishedRunId update (see GenerationRunCoordinator.completeRun)
 * so a crash between "Book looks done" and "GenerationRun/activeRunId agree"
 * can never happen. `bookUpdate` never contains `status`, `errorMessage`, or
 * `failedStep` — those three are applied by the coordinator only.
 */
export interface GenerationOutcome {
  readonly status: typeof BookStatus.complete | typeof BookStatus.failed;
  readonly completedStep: AgentStep;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly failedStep?: AgentStep;
  readonly bookUpdate: Prisma.BookUpdateInput;
}
