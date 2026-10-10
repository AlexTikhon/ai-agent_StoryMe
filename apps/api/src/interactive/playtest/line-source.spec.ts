import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLineSource, MAX_CHUNK_BYTES, MAX_LINE_BYTES } from './line-source';

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

  describe('input bounds', () => {
    it('hands out thousands of short lines from one chunk on demand, without truncating', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      input.write(Buffer.from('1\n'.repeat(10_000)));
      await new Promise((r) => setImmediate(r));
      // The chunk is held as raw text; its lines are only split out per next().
      expect(input.isPaused()).toBe(true);
      for (let i = 0; i < 10_000; i += 1) {
        expect(await source.next()).toEqual({ kind: 'line', text: '1' });
      }
      input.end();
      expect(await source.next()).toEqual({ kind: 'eof' });
      source.close();
    });

    it('delivers more lines than the old queue capacity from one chunk, in order', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
      input.end(lines.join('\n') + '\n');
      for (const text of lines) expect(await source.next()).toEqual({ kind: 'line', text });
      expect(await source.next()).toEqual({ kind: 'eof' });
      source.close();
    });

    it('delivers a long run of lines that spans several chunks', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      const lines = Array.from({ length: 60 }, (_, i) => `n${i}`);
      const body = lines.join('\n') + '\n';
      for (let at = 0; at < body.length; at += 37) input.write(body.slice(at, at + 37));
      input.end();
      for (const text of lines) expect(await source.next()).toEqual({ kind: 'line', text });
      expect(await source.next()).toEqual({ kind: 'eof' });
      source.close();
    });

    it('decodes a multibyte character split across chunks', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      const bytes = Buffer.from('zażółć\n', 'utf8');
      const split = bytes.indexOf(0xc5) + 1; // between the two bytes of 'ż'
      input.write(bytes.subarray(0, split));
      input.write(bytes.subarray(split));
      input.end();
      expect(await source.next()).toEqual({ kind: 'line', text: 'zażółć' });
      source.close();
    });

    it('handles CRLF whose CR and LF arrive in different chunks', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      input.write('a\r');
      input.write('\nb\r\n');
      input.end();
      expect(await source.next()).toEqual({ kind: 'line', text: 'a' });
      expect(await source.next()).toEqual({ kind: 'line', text: 'b' });
      source.close();
    });

    it('reports each oversized line once and then recovers, even inside one chunk', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      const big = 'x'.repeat(MAX_LINE_BYTES * 4);
      input.end(`${big}\n1\n${big}\n2\n`);
      expect(await source.next()).toEqual({ kind: 'oversized' });
      expect(await source.next()).toEqual({ kind: 'line', text: '1' });
      expect(await source.next()).toEqual({ kind: 'oversized' });
      expect(await source.next()).toEqual({ kind: 'line', text: '2' });
      expect(await source.next()).toEqual({ kind: 'eof' });
      source.close();
    });

    it('discards an oversized line streamed over many chunks without retaining it', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      const first = source.next();
      for (let i = 0; i < 50; i += 1) input.write('y'.repeat(MAX_LINE_BYTES));
      input.write('\nafter\n');
      input.end();
      expect(await first).toEqual({ kind: 'oversized' });
      expect(await source.next()).toEqual({ kind: 'line', text: 'after' });
      expect(await source.next()).toEqual({ kind: 'eof' });
      source.close();
    });

    it('fails with an explicit overflow, not eof, when one chunk exceeds the retained bound', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      input.write('1\n2\n');
      input.write(Buffer.from('3\n'.repeat(MAX_CHUNK_BYTES)));
      expect(await source.next()).toEqual({ kind: 'line', text: '1' });
      expect(await source.next()).toEqual({ kind: 'line', text: '2' });
      expect(await source.next()).toEqual({ kind: 'overflow' });
      expect(await source.next()).toEqual({ kind: 'overflow' });
      source.close();
    });

    it('resolves a pending read as overflow when an oversized chunk arrives', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      const pending = source.next();
      input.write(Buffer.alloc(MAX_CHUNK_BYTES + 1, 0x31));
      expect(await pending).toEqual({ kind: 'overflow' });
      source.close();
    });

    it('accepts a chunk of exactly the bound', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      input.end(Buffer.from('1\n'.repeat(MAX_CHUNK_BYTES / 2)));
      expect(await source.next()).toEqual({ kind: 'line', text: '1' });
      source.close();
    });
  });

  describe('cancellation and close', () => {
    it('close() with buffered input drops it, settles later reads and detaches', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      input.write('a\nb\nc\n');
      await new Promise((r) => setImmediate(r));
      source.close();
      for (const event of ['data', 'end', 'close', 'error']) {
        expect(input.listenerCount(event)).toBe(0);
      }
      expect(await source.next()).toEqual({ kind: 'eof' });
    });

    it('close() settles a pending read as eof', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      const pending = source.next();
      source.close();
      expect(await pending).toEqual({ kind: 'eof' });
    });

    it('abort with buffered input drops it and detaches every listener', async () => {
      const input = new PassThrough();
      const controller = new AbortController();
      const source = createLineSource(input, controller.signal);
      input.write('a\nb\nc\n');
      await new Promise((r) => setImmediate(r));
      controller.abort();
      for (const event of ['data', 'end', 'close', 'error']) {
        expect(input.listenerCount(event)).toBe(0);
      }
      expect(input.isPaused()).toBe(true);
      expect(await source.next()).toEqual({ kind: 'cancelled' });
      source.close();
    });

    it('abort while a read is pending settles it as cancelled and detaches', async () => {
      const input = new PassThrough();
      const controller = new AbortController();
      const source = createLineSource(input, controller.signal);
      const pending = source.next();
      controller.abort();
      expect(await pending).toEqual({ kind: 'cancelled' });
      expect(input.listenerCount('data')).toBe(0);
      source.close();
    });

    it('input arriving after close is ignored', async () => {
      const input = new PassThrough();
      const source = createLineSource(input);
      source.close();
      input.write('late\n');
      expect(await source.next()).toEqual({ kind: 'eof' });
    });
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
