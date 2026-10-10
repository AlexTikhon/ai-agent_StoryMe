import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { LineRead, LineSource } from './runner';

/**
 * Bounded, cancellable, pull-based line reader over any Readable (a TTY, a pipe
 * or a test stream). It deliberately avoids `readline`: there is no interface
 * object to leak, an over-long line is discarded instead of buffered, and
 * `close()` detaches every listener so the process can exit on its own.
 *
 * The stream stays paused unless a read is waiting. At most one received chunk
 * (<= MAX_CHUNK_BYTES) plus an unterminated partial line (<= MAX_LINE_BYTES) is
 * ever retained, and lines are split out of it only when `next()` asks, so no
 * line queue exists to outgrow. A chunk above the bound is never buffered: it
 * is reported as `overflow` once the lines before it have been handed out.
 */

/** Longest line kept; anything longer is reported once as `oversized`. */
export const MAX_LINE_BYTES = 256;
/** Largest single chunk accepted (a pipe/TTY/file read is at most this). */
export const MAX_CHUNK_BYTES = 64 * 1024;
/** Hard cap on unparsed text held at once: one chunk plus one partial line. */
export const MAX_RETAINED_BYTES = MAX_CHUNK_BYTES + MAX_LINE_BYTES;

export function createLineSource(input: Readable, signal?: AbortSignal): LineSource {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let pos = 0;
  let discarding = false;
  let overflowed = false;
  let ended = false;
  let closed = false;
  let cancelled = signal?.aborted ?? false;
  let waiter: ((read: LineRead) => void) | null = null;

  const retainedBytes = (): number => Buffer.byteLength(pending.slice(pos), 'utf8');

  /** Splits the next line out of the retained text, or returns null if none is complete. */
  const parseLine = (): LineRead | null => {
    for (;;) {
      const newline = pending.indexOf('\n', pos);
      if (newline === -1) {
        const rest = pending.slice(pos);
        pending = '';
        pos = 0;
        if (discarding) return null;
        if (Buffer.byteLength(rest, 'utf8') > MAX_LINE_BYTES) {
          discarding = true;
          return { kind: 'oversized' };
        }
        pending = rest;
        return null;
      }
      const head = pending.slice(pos, newline);
      pos = newline + 1;
      if (discarding) {
        // The tail of an oversized line: swallow it, then resume normally.
        discarding = false;
        continue;
      }
      if (Buffer.byteLength(head, 'utf8') > MAX_LINE_BYTES) return { kind: 'oversized' };
      return { kind: 'line', text: head.endsWith('\r') ? head.slice(0, -1) : head };
    }
  };

  /** The next read if one is available right now; null means "wait for more input". */
  const poll = (): LineRead | null => {
    const line = parseLine();
    if (line) return line;
    if (overflowed) return { kind: 'overflow' };
    if (ended) return { kind: 'eof' };
    return null;
  };

  const settle = (read: LineRead): void => {
    if (!waiter) return;
    const resolve = waiter;
    waiter = null;
    resolve(read);
  };

  const serveWaiter = (): void => {
    if (!waiter) return;
    const read = poll();
    if (read) {
      settle(read);
      input.pause();
    }
  };

  const finish = (): void => {
    if (ended || closed) return;
    ended = true;
    // After an overflow the text behind the dropped chunk is unknown: the
    // retained complete lines still flow, then `overflow` is reported.
    if (!overflowed) {
      pending = pending.slice(pos) + decoder.end();
      pos = 0;
      // A final unterminated line is parsed like any other.
      if (pending.length > 0 && !pending.endsWith('\n')) pending += '\n';
    }
    serveWaiter();
  };

  const onData = (chunk: Buffer | string): void => {
    if (overflowed) return;
    const incoming = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
    if (incoming > MAX_CHUNK_BYTES || retainedBytes() + incoming > MAX_RETAINED_BYTES) {
      overflowed = true;
      input.pause();
      // Unparsed lines before the overflow are still handed out first.
      if (waiter) serveWaiter();
      return;
    }
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    pending = pos > 0 ? pending.slice(pos) + text : pending + text;
    pos = 0;
    if (waiter) serveWaiter();
    else input.pause();
  };

  const release = (): void => {
    input.off('data', onData);
    input.off('end', finish);
    input.off('close', finish);
    input.off('error', finish);
    signal?.removeEventListener('abort', onAbort);
    input.pause();
    pending = '';
    pos = 0;
  };

  function onAbort(): void {
    cancelled = true;
    release();
    settle({ kind: 'cancelled' });
  }

  input.on('data', onData);
  input.on('end', finish);
  input.on('close', finish);
  input.on('error', finish);
  signal?.addEventListener('abort', onAbort, { once: true });
  // Pull-based: stay paused until a read is waiting.
  input.pause();
  if (cancelled) release();

  return {
    next(): Promise<LineRead> {
      if (cancelled) return Promise.resolve({ kind: 'cancelled' });
      if (closed) return Promise.resolve({ kind: 'eof' });
      const read = poll();
      if (read) return Promise.resolve(read);
      return new Promise<LineRead>((resolve) => {
        waiter = resolve;
        input.resume();
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      release();
      settle({ kind: 'eof' });
    },
  };
}
