import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { LineRead, LineSource } from './runner';

/**
 * Bounded, cancellable line reader over any Readable (a TTY, a pipe or a test
 * stream). It deliberately avoids `readline`: there is no interface object to
 * leak, an over-long line is discarded instead of buffered, at most a handful
 * of lines are ever queued (the stream is paused meanwhile), and `close()`
 * detaches every listener so the process can exit on its own.
 */

/** Longest line kept; anything longer is reported once as `oversized`. */
export const MAX_LINE_BYTES = 256;
const MAX_QUEUED_LINES = 16;

export function createLineSource(input: Readable, signal?: AbortSignal): LineSource {
  const decoder = new StringDecoder('utf8');
  const queue: LineRead[] = [];
  let partial = '';
  let discarding = false;
  let ended = false;
  let cancelled = signal?.aborted ?? false;
  let waiter: ((read: LineRead) => void) | null = null;

  const push = (read: LineRead): void => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(read);
    } else {
      queue.push(read);
    }
  };

  const takeLine = (text: string): void => {
    if (discarding) {
      // The tail of an oversized line: swallow it, then resume normally.
      discarding = false;
      return;
    }
    push({ kind: 'line', text: text.endsWith('\r') ? text.slice(0, -1) : text });
  };

  const consume = (chunk: string): void => {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline === -1) break;
      const head = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (!discarding && Buffer.byteLength(partial + head, 'utf8') > MAX_LINE_BYTES) {
        push({ kind: 'oversized' });
        discarding = true;
      }
      takeLine(partial + head);
      partial = '';
    }
    if (!discarding && Buffer.byteLength(partial + rest, 'utf8') > MAX_LINE_BYTES) {
      push({ kind: 'oversized' });
      discarding = true;
      partial = '';
    } else if (!discarding) {
      partial += rest;
    }
    if (queue.length >= MAX_QUEUED_LINES) input.pause();
  };

  const finish = (): void => {
    if (ended) return;
    ended = true;
    const tail = partial + decoder.end();
    partial = '';
    if (tail.length > 0 && !discarding) takeLine(tail);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ kind: 'eof' });
    }
  };

  const onData = (chunk: Buffer | string): void => {
    consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  };
  const onAbort = (): void => {
    cancelled = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ kind: 'cancelled' });
    }
  };

  input.on('data', onData);
  input.on('end', finish);
  input.on('close', finish);
  input.on('error', finish);
  signal?.addEventListener('abort', onAbort, { once: true });

  return {
    next(): Promise<LineRead> {
      if (cancelled) return Promise.resolve({ kind: 'cancelled' });
      const queued = queue.shift();
      if (queued) {
        if (queue.length < MAX_QUEUED_LINES && !ended) input.resume();
        return Promise.resolve(queued);
      }
      if (ended) return Promise.resolve({ kind: 'eof' });
      return new Promise<LineRead>((resolve) => {
        waiter = resolve;
      });
    },
    close(): void {
      input.off('data', onData);
      input.off('end', finish);
      input.off('close', finish);
      input.off('error', finish);
      signal?.removeEventListener('abort', onAbort);
      input.pause();
      queue.length = 0;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ kind: 'eof' });
      }
    },
  };
}
