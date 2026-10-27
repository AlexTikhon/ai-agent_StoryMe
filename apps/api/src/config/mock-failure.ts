export type MockFailureStage = 'story' | 'character' | 'image';

export interface MockFailureConfig {
  enabled: boolean;
  failureStage?: MockFailureStage;
  failurePage?: number;
  /** When set, only this 1-based matching invocation fails; every other match succeeds. */
  failureOnMatch?: number;
  stageDelayMs: number;
}

export function readMockFailureConfig(env: NodeJS.ProcessEnv = process.env): MockFailureConfig {
  const enabled = env['MOCK_FAILURES_ENABLED'] === 'true';
  if (enabled && env['NODE_ENV'] === 'production') {
    throw new Error('Mock failure injection is forbidden when NODE_ENV=production');
  }
  const stage = env['MOCK_FAILURE_STAGE'] as MockFailureStage | undefined;
  const page = Number(env['MOCK_FAILURE_PAGE']);
  const delay = Number(env['MOCK_STAGE_DELAY_MS']);
  const rawOnMatch = env['MOCK_FAILURE_ON_MATCH'];
  const onMatch = Number(rawOnMatch);
  // Silently ignoring a malformed value would fall back to failing every match.
  if (
    rawOnMatch !== undefined &&
    !(rawOnMatch.trim() !== '' && Number.isInteger(onMatch) && onMatch > 0)
  ) {
    throw new Error(`MOCK_FAILURE_ON_MATCH must be a positive integer, got "${rawOnMatch}"`);
  }
  return {
    enabled,
    ...(stage && { failureStage: stage }),
    ...(Number.isInteger(page) && page > 0 && { failurePage: page }),
    ...(rawOnMatch !== undefined && { failureOnMatch: onMatch }),
    stageDelayMs: Number.isInteger(delay) && delay >= 0 ? delay : 0,
  };
}

export class MockFailureController {
  // Matching invocations seen by this instance. Each call takes its ordinal
  // synchronously on entry, so concurrent calls get distinct numbers in call order.
  private matchCount = 0;

  constructor(private readonly config: MockFailureConfig) {}

  async before(stage: MockFailureStage, page?: number): Promise<void> {
    if (!this.config.enabled) return;
    const matches =
      this.config.failureStage === stage &&
      (stage !== 'image' ||
        this.config.failurePage === undefined ||
        this.config.failurePage === page);
    const ordinal = matches ? ++this.matchCount : 0;
    if (this.config.stageDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.stageDelayMs));
    }
    if (!matches) return;
    const onMatch = this.config.failureOnMatch;
    if (onMatch !== undefined && ordinal !== onMatch) return;
    throw new Error(
      `Injected deterministic mock failure at ${stage}${page ? ` page ${page}` : ''}` +
        (onMatch !== undefined ? ` on matching invocation ${ordinal}` : ''),
    );
  }
}
