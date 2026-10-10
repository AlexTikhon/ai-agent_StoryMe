import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLineSource, MAX_LINE_BYTES } from './line-source';

describe('createLineSource', () => {
  it('yields complete lines across chunk boundaries and strips CR', async () => {
    const input = new PassThrough();
    const source = createLineSource(input);
    input.write('on');
    input.write('e\r\ntw');
    input.write('o\nthree');
    input.end();
    expect(await source.next()).toEqual({ kind: 'line', text: 'one' });
    expect(await source.next()).toEqual({ kind: 'line', text: 'two' });
    expect(await source.next()).toEqual({ kind: 'line', text: 'three' });
    expect(await source.next()).toEqual({ kind: 'eof' });
    expect(await source.next()).toEqual({ kind: 'eof' });
    source.close();
  });

  it('waits for input and resolves a pending read when a line arrives', async () => {
    const input = new PassThrough();
    const source = createLineSource(input);
    const pending = source.next();
    input.write('later\n');
    expect(await pending).toEqual({ kind: 'line', text: 'later' });
    source.close();
  });

  it('reports an oversized line once and resumes at the next line', async () => {
    const input = new PassThrough();
    const source = createLineSource(input);
    input.write('x'.repeat(MAX_LINE_BYTES + 10));
    input.write('yyy\nok\n');
    input.end();
    expect(await source.next()).toEqual({ kind: 'oversized' });
    expect(await source.next()).toEqual({ kind: 'line', text: 'ok' });
    expect(await source.next()).toEqual({ kind: 'eof' });
    source.close();
  });

  it('resolves a pending read as cancelled when the signal aborts', async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const source = createLineSource(input, controller.signal);
    const pending = source.next();
    controller.abort();
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(await source.next()).toEqual({ kind: 'cancelled' });
    source.close();
  });

  it('is cancelled immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const input = new PassThrough();
    input.write('ignored\n');
    const source = createLineSource(input, controller.signal);
    expect(await source.next()).toEqual({ kind: 'cancelled' });
    source.close();
  });

  it('treats a stream error as end of input', async () => {
    const input = new PassThrough();
    const source = createLineSource(input);
    const pending = source.next();
    input.destroy(new Error('boom'));
    expect(await pending).toEqual({ kind: 'eof' });
    source.close();
  });

  it('close() detaches every listener and pauses the stream', () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const source = createLineSource(input, controller.signal);
    expect(input.listenerCount('data')).toBeGreaterThan(0);
    source.close();
    for (const event of ['data', 'end', 'close', 'error']) {
      expect(input.listenerCount(event)).toBe(0);
    }
    expect(input.isPaused()).toBe(true);
  });
});
