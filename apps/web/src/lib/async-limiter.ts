/**
 * Bounds how many async tasks run at once. Tasks queue FIFO; a task whose
 * signal aborts while still queued is dropped without ever starting, so
 * scrolling past a long list never leaves a backlog of unwanted requests.
 */
export interface AsyncLimiter {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function createAsyncLimiter(maxConcurrent: number): AsyncLimiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    queue.shift()?.();
  };

  return {
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const start = () => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) {
            // Aborted in the instant between being dequeued and starting.
            reject(abortError());
            queue.shift()?.();
            return;
          }
          active += 1;
          task().then(resolve, reject).finally(release);
        };
        const onAbort = () => {
          const index = queue.indexOf(start);
          if (index !== -1) {
            queue.splice(index, 1);
            reject(abortError());
          }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (active < maxConcurrent) start();
        else queue.push(start);
      });
    },
  };
}
