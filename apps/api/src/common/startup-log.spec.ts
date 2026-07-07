import { describe, it, expect } from 'vitest';
import { envPresent, formatStartupLog } from './startup-log';

describe('envPresent', () => {
  it('is false for undefined and empty string', () => {
    expect(envPresent(undefined)).toBe(false);
    expect(envPresent('')).toBe(false);
  });

  it('is true for a non-empty string', () => {
    expect(envPresent('redis://localhost:6379')).toBe(true);
  });
});

describe('formatStartupLog', () => {
  it('reports api mode without a queue/processor field', () => {
    const line = formatStartupLog({
      mode: 'api',
      workerEnabled: false,
      redisUrlPresent: true,
      databaseUrlPresent: true,
    });

    expect(line).toContain('mode=api');
    expect(line).toContain('worker enabled=false');
    expect(line).not.toContain('queue=');
    expect(line).not.toContain('processor registered=');
  });

  it('reports worker mode with queue name and processor registered', () => {
    const line = formatStartupLog({
      mode: 'worker',
      workerEnabled: true,
      queueName: 'book-generation',
      processorRegistered: true,
      redisUrlPresent: true,
      databaseUrlPresent: false,
    });

    expect(line).toContain('mode=worker');
    expect(line).toContain('queue=book-generation');
    expect(line).toContain('processor registered=true');
    expect(line).toContain('REDIS_URL set=true');
    expect(line).toContain('DATABASE_URL set=false');
  });

  it('never includes an actual URL value, only presence booleans', () => {
    const line = formatStartupLog({
      mode: 'api',
      workerEnabled: false,
      redisUrlPresent: true,
      databaseUrlPresent: true,
    });

    expect(line).not.toMatch(/redis:\/\//);
    expect(line).not.toMatch(/postgres(ql)?:\/\//);
  });
});
