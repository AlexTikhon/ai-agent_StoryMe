import { Injectable, Logger } from '@nestjs/common';

/**
 * Schedules generation work to run after the current request finishes,
 * in-process — no external queue/worker. Tracks running book ids in memory
 * only, so de-duplication and "is generating" state do not survive a process
 * restart and do not span multiple instances.
 */
@Injectable()
export class GenerationTaskRunner {
  private readonly logger = new Logger(GenerationTaskRunner.name);
  private readonly running = new Set<string>();

  isRunning(bookId: string): boolean {
    return this.running.has(bookId);
  }

  /**
   * Schedules `task` on the microtask queue. Returns false without
   * scheduling anything if `bookId` is already running — the caller decides
   * whether that's an error or a silent no-op.
   */
  run(bookId: string, task: () => Promise<void>): boolean {
    if (this.running.has(bookId)) {
      return false;
    }
    this.running.add(bookId);
    void Promise.resolve()
      .then(() => task())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Unhandled generation task error for book ${bookId}: ${message}`);
      })
      .finally(() => {
        this.running.delete(bookId);
      });
    return true;
  }
}
