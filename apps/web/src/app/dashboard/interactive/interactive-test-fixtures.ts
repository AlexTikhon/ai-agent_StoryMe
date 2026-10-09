import type { InteractiveSessionViewDto } from '@book/types';

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
