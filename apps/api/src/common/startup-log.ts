import type { Logger } from '@nestjs/common';

/**
 * Safe process-topology info logged once at boot — presence-only for
 * secrets (REDIS_URL/DATABASE_URL), never the values themselves. Exists so a
 * misconfigured deploy (e.g. a "worker" service that's actually still
 * running `node dist/main`, or pointed at the wrong Redis/Postgres) is
 * visible in logs rather than only showing up as a book stuck in `queued`.
 */
export interface StartupLogInfo {
  mode: 'api' | 'worker';
  workerEnabled: boolean;
  queueName?: string;
  processorRegistered?: boolean;
  redisUrlPresent: boolean;
  databaseUrlPresent: boolean;
}

export function envPresent(value: string | undefined): boolean {
  return Boolean(value && value.length > 0);
}

export function formatStartupLog(info: StartupLogInfo): string {
  const parts = [
    `mode=${info.mode}`,
    `worker enabled=${info.workerEnabled}`,
    ...(info.queueName ? [`queue=${info.queueName}`] : []),
    ...(info.processorRegistered !== undefined
      ? [`processor registered=${info.processorRegistered}`]
      : []),
    `REDIS_URL set=${info.redisUrlPresent}`,
    `DATABASE_URL set=${info.databaseUrlPresent}`,
  ];
  return parts.join(' | ');
}

export function logStartup(logger: Logger, info: StartupLogInfo): void {
  logger.log(formatStartupLog(info));
}
