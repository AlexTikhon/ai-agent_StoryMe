import { describe, it, expect, vi } from 'vitest';
import { GenerationTaskRunner } from './generation-task-runner';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('GenerationTaskRunner', () => {
  it('is not running for an id that was never scheduled', () => {
    const runner = new GenerationTaskRunner();
    expect(runner.isRunning('b-1')).toBe(false);
  });

  it('marks a book id as running as soon as run() is called, before the task resolves', () => {
    const runner = new GenerationTaskRunner();
    const pending = new Promise<void>(() => {});

    const scheduled = runner.run('b-1', () => pending);

    expect(scheduled).toBe(true);
    expect(runner.isRunning('b-1')).toBe(true);
  });

  it('eventually invokes the scheduled task', async () => {
    const runner = new GenerationTaskRunner();
    const task = vi.fn().mockResolvedValue(undefined);

    runner.run('b-1', task);
    await flushMicrotasks();

    expect(task).toHaveBeenCalledOnce();
  });

  it('removes the book id from the running set after the task resolves', async () => {
    const runner = new GenerationTaskRunner();
    let resolveTask: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });

    runner.run('b-1', () => pending);
    expect(runner.isRunning('b-1')).toBe(true);

    resolveTask();
    await flushMicrotasks();

    expect(runner.isRunning('b-1')).toBe(false);
  });

  it('removes the book id from the running set and does not throw when the task rejects', async () => {
    const runner = new GenerationTaskRunner();
    const task = vi.fn().mockRejectedValue(new Error('pipeline exploded'));

    expect(() => runner.run('b-1', task)).not.toThrow();
    await flushMicrotasks();

    expect(runner.isRunning('b-1')).toBe(false);
  });

  it('returns false and does not invoke a second task while the first is still running for the same id', async () => {
    const runner = new GenerationTaskRunner();
    const firstTask = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const secondTask = vi.fn().mockResolvedValue(undefined);

    const firstScheduled = runner.run('b-1', firstTask);
    const secondScheduled = runner.run('b-1', secondTask);
    await flushMicrotasks();

    expect(firstScheduled).toBe(true);
    expect(secondScheduled).toBe(false);
    expect(firstTask).toHaveBeenCalledOnce();
    expect(secondTask).not.toHaveBeenCalled();
  });

  it('allows scheduling again for the same id once the previous run has finished', async () => {
    const runner = new GenerationTaskRunner();
    const firstTask = vi.fn().mockResolvedValue(undefined);
    const secondTask = vi.fn().mockResolvedValue(undefined);

    runner.run('b-1', firstTask);
    await flushMicrotasks();
    expect(runner.isRunning('b-1')).toBe(false);

    const secondScheduled = runner.run('b-1', secondTask);
    await flushMicrotasks();

    expect(secondScheduled).toBe(true);
    expect(secondTask).toHaveBeenCalledOnce();
  });

  it('tracks different book ids independently', async () => {
    const runner = new GenerationTaskRunner();
    const pending = new Promise<void>(() => {});

    runner.run('b-1', () => pending);
    const scheduledForOther = runner.run('b-2', () => Promise.resolve());
    await flushMicrotasks();

    expect(scheduledForOther).toBe(true);
    expect(runner.isRunning('b-1')).toBe(true);
    expect(runner.isRunning('b-2')).toBe(false);
  });
});
