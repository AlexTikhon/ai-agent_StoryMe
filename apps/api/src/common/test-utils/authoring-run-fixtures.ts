import {
  runAuthoring,
  type AuthoringResult,
  type PipelineLimits,
} from '../../interactive/authoring/pipeline';
import { buildFailureReport, buildValidationReport } from '../../interactive/authoring/review';
import {
  ScriptedDraftProvider,
  type ScriptStep,
} from '../../interactive/authoring/scripted-provider';
import {
  LAST_TRAM_BRIEF,
  LAST_TRAM_SCENARIO,
} from '../../interactive/authoring/the-last-tram';
import { scenarioToWire } from '../../interactive/authoring/wire';

/**
 * Offline fixtures for the authoring run-report comparison specs. Every report
 * is produced by the REAL pipeline and the REAL report builders with a scripted
 * provider and a fake clock: no network, no keys, no filesystem.
 */

export const FAST_LIMITS: PipelineLimits = {
  maxOutputTokens: 4000,
  requestTimeoutMs: 20,
  deadlineMs: 5000,
};

/** A candidate that passes every validation stage. */
export const validCandidate = (): string => JSON.stringify(scenarioToWire(LAST_TRAM_SCENARIO));

/** Fails the `definition` stage (unresolved scene reference). */
export const invalidCandidate = (): string => {
  const wire = structuredClone(scenarioToWire(LAST_TRAM_SCENARIO));
  const choice = wire.scenes.flatMap((s) => s.choices).find((c) => c.id === 'c-leave-cab')!;
  choice.to = 's-missing';
  return JSON.stringify(wire);
};

/** Deterministic clock: every reading advances by `stepMs`. */
export function fakeClock(stepMs = 7, startMs = Date.UTC(2026, 0, 1)): () => number {
  let t = startMs;
  return () => {
    t += stepMs;
    return t;
  };
}

export async function runScripted(
  steps: readonly ScriptStep[],
  options: { stepMs?: number; startMs?: number } = {},
): Promise<AuthoringResult> {
  return runAuthoring({
    rawBrief: LAST_TRAM_BRIEF,
    provider: new ScriptedDraftProvider(steps),
    limits: FAST_LIMITS,
    now: fakeClock(options.stepMs, options.startMs),
  });
}

/** The exact JSON text the artifact writer stores for this result. */
export function reportText(result: AuthoringResult): string {
  switch (result.status) {
    case 'REVIEW_REQUIRED':
      return `${JSON.stringify(buildValidationReport(result), null, 2)}\n`;
    case 'REJECTED':
    case 'STOPPED':
      return `${JSON.stringify(buildFailureReport(result), null, 2)}\n`;
    case 'BRIEF_REJECTED':
      throw new Error('BRIEF_REJECTED runs write no report');
  }
}

export const reportFileNameFor = (result: AuthoringResult): string =>
  result.status === 'REVIEW_REQUIRED' ? 'validation-report.json' : 'run-report.json';

/** Parse, mutate and re-serialize a report text (for malformed/inconsistent fixtures). */
export function mutateReport(text: string, mutate: (report: Record<string, any>) => void): string {
  const report = JSON.parse(text) as Record<string, any>;
  mutate(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}
