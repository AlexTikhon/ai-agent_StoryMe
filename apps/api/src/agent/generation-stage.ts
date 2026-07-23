import type { AgentStep } from '@prisma/client';

/**
 * Small orchestration boundary for one pipeline step.
 *
 * Stages own deterministic work and provider/storage calls for their step;
 * AgentService remains responsible for ordering, fencing checkpoints and
 * assembling the terminal GenerationOutcome.
 */
export interface GenerationStage<Input, Output> {
  readonly step: AgentStep;
  execute(input: Input): Output | Promise<Output>;
}
