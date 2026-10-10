import type { NarrationOutput, NarrationRejectionCode } from '../domain/narration';
import { validateNarration } from '../domain/narration';
import type { ScenarioDefinition } from '../domain/scenario-schema';
import { hashState, type InteractiveState } from '../domain/state';

export const NARRATOR_PROVIDER = Symbol('INTERACTIVE_NARRATOR_PROVIDER');

export interface NarrationRequest {
  scenario: ScenarioDefinition;
  /** The already-validated state to narrate (after the transition, if any). */
  state: InteractiveState;
  stateHash: string;
}

/**
 * Describes a validated scene. A narrator never mutates state, grants items,
 * unlocks choices or introduces canonical facts: its only output is a
 * NarrationOutput that must pass `validateNarration`. It returns `unknown` on
 * purpose, so a future network-backed provider cannot skip validation.
 *
 * Implementations may perform network I/O, so callers must never invoke
 * `narrate` inside a database transaction.
 */
export interface NarratorProvider {
  readonly providerName: string;
  narrate(request: NarrationRequest): Promise<unknown>;
}

export class NarrationRejectedError extends Error {
  constructor(readonly reason: NarrationRejectionCode | 'NARRATION_PROVIDER_FAILED') {
    super(`Narration rejected: ${reason}`);
    this.name = 'NarrationRejectedError';
  }
}

/** Calls the provider and returns only output that passed trusted validation. */
export async function prepareNarration(
  provider: NarratorProvider,
  scenario: ScenarioDefinition,
  state: InteractiveState,
): Promise<NarrationOutput> {
  let output: unknown;
  try {
    output = await provider.narrate({ scenario, state, stateHash: hashState(state) });
  } catch {
    throw new NarrationRejectedError('NARRATION_PROVIDER_FAILED');
  }
  const validation = validateNarration(output, scenario, state);
  if (!validation.ok) throw new NarrationRejectedError(validation.code);
  return validation.narration;
}
