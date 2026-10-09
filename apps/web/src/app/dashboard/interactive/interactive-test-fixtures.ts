import type {
  InteractiveSessionListDto,
  InteractiveSessionSummaryDto,
  InteractiveSessionViewDto,
} from '@book/types';

export const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

export function makeView(
  revision: number,
  overrides: Partial<InteractiveSessionViewDto> = {},
): InteractiveSessionViewDto {
  return {
    sessionId: SESSION_ID,
    revision,
    scenarioId: 'warsaw-last-delivery',
    scenarioVersion: 1,
    scene: { id: `scene-${revision}`, title: `Scene ${revision}` },
    narration: `Narration for revision ${revision}.`,
    choices: [{ id: 'c-a', label: 'Choice A' }],
    player: { knowledge: [], inventory: [] },
    status: 'in_progress',
    ending: null,
    ...overrides,
  };
}

/** Deterministic summary `n`: ids and dates descend with n, as the API returns them. */
export function makeSummary(
  n: number,
  overrides: Partial<InteractiveSessionSummaryDto> = {},
): InteractiveSessionSummaryDto {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    sessionId: id,
    scenarioId: 'warsaw-last-delivery',
    scenarioVersion: 1,
    sceneTitle: `Scene of story ${n}`,
    status: 'in_progress',
    endingTitle: null,
    createdAt: `2026-10-0${Math.min(n, 9)}T10:00:00.000Z`,
    updatedAt: `2026-10-0${Math.min(n, 9)}T11:00:00.000Z`,
    ...overrides,
  };
}

export function makePage(
  summaries: InteractiveSessionSummaryDto[],
  nextCursor: string | null = null,
): InteractiveSessionListDto {
  return { sessions: summaries, nextCursor };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
