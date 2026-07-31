export type MockFailureStage = 'story' | 'character' | 'image';

export interface MockFailureConfig {
  enabled: boolean;
  failureStage?: MockFailureStage;
  failurePage?: number;
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
  return {
    enabled,
    ...(stage && { failureStage: stage }),
    ...(Number.isInteger(page) && page > 0 && { failurePage: page }),
    stageDelayMs: Number.isInteger(delay) && delay >= 0 ? delay : 0,
  };
}

export class MockFailureController {
  constructor(private readonly config: MockFailureConfig) {}

  async before(stage: MockFailureStage, page?: number): Promise<void> {
    if (!this.config.enabled) return;
    if (this.config.stageDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.stageDelayMs));
    }
    if (
      this.config.failureStage === stage &&
      (stage !== 'image' ||
        this.config.failurePage === undefined ||
        this.config.failurePage === page)
    ) {
      throw new Error(
        `Injected deterministic mock failure at ${stage}${page ? ` page ${page}` : ''}`,
      );
    }
  }
}
