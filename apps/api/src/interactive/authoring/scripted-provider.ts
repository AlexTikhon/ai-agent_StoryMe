import {
  DraftProviderError,
  type DraftFailureKind,
  type DraftRequest,
  type DraftResponse,
  type DraftUsage,
  type ScenarioDraftProvider,
} from './provider';

/**
 * Offline test double that replays a fixed script of provider behaviours.
 * Used by specs and the offline evaluation; never selectable from the CLI.
 */
export type ScriptStep =
  | { candidate: unknown; httpAttempts?: number; usage?: DraftUsage }
  | { fail: DraftFailureKind; httpAttempts?: number }
  /** Never answers; ends only when the pipeline aborts (deadline/cancellation). */
  | { hang: true };

export class ScriptedDraftProvider implements ScenarioDraftProvider {
  readonly name = 'scripted' as const;
  readonly model = null;
  readonly requests: DraftRequest[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: readonly ScriptStep[]) {
    this.steps = [...steps];
  }

  draft(request: DraftRequest): Promise<DraftResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error('script exhausted'));
    if ('hang' in step) {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DraftProviderError('cancelled', 1));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if ('fail' in step) {
      return Promise.reject(new DraftProviderError(step.fail, step.httpAttempts ?? 1));
    }
    return Promise.resolve({
      candidate: step.candidate,
      usage: step.usage ?? {},
      httpAttempts: step.httpAttempts ?? 1,
    });
  }
}
