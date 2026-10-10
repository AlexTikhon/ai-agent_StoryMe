import { Injectable } from '@nestjs/common';
import { buildCanonicalNarration } from '../domain/narration';
import type { NarrationRequest, NarratorProvider } from './narrator';

/** Deterministic narrator: returns exactly the trusted rendering for the state. */
@Injectable()
export class MockNarratorProvider implements NarratorProvider {
  readonly providerName = 'mock';

  narrate(request: NarrationRequest): Promise<unknown> {
    return Promise.resolve(buildCanonicalNarration(request.scenario, request.state));
  }
}
