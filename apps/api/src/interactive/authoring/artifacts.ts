import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildFailureReport, buildValidationReport, renderReviewReport } from './review';
import type { AuthoringResult } from './pipeline';

/**
 * Local run artifacts. Everything lands inside one dedicated, git-ignored
 * drafts directory, in a fresh per-run directory that is never overwritten.
 *
 * A run is written to `<run>.incomplete/` and only renamed to its final,
 * status-bearing name once every file is on disk, so a failed or interrupted run
 * can never be mistaken for a complete one:
 *   <run>--review-required/  validated-candidate.json, validation-report.json, review-report.md
 *   <run>--rejected/         run-report.json   (no candidate file)
 *   <run>--stopped/          run-report.json   (no candidate file)
 * Nothing is ever written to public assets or the published scenario directory.
 */

export const DRAFTS_DIR_NAME = 'scenario-drafts';

export type WritableResult = Extract<
  AuthoringResult,
  { status: 'REVIEW_REQUIRED' | 'REJECTED' | 'STOPPED' }
>;

export type DraftsRootCheck = { ok: true; root: string } | { ok: false; error: string };

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The drafts root is either the default location or an explicitly requested
 * directory literally named `scenario-drafts`; it may not sit inside source,
 * assets, build output or any `public` directory, and may not be a symlink.
 */
export function validateDraftsRoot(
  requested: string | undefined,
  defaultRoot: string,
  forbiddenDirs: readonly string[],
): DraftsRootCheck {
  const root = path.resolve(requested ?? defaultRoot);
  if (root !== path.resolve(defaultRoot) && path.basename(root) !== DRAFTS_DIR_NAME) {
    return { ok: false, error: `drafts root must be named "${DRAFTS_DIR_NAME}"` };
  }
  if (forbiddenDirs.some((dir) => isInside(root, path.resolve(dir)))) {
    return { ok: false, error: 'drafts root may not be inside source, assets or build output' };
  }
  if (root.split(path.sep).includes('public')) {
    return { ok: false, error: 'drafts root may not be inside a public directory' };
  }
  try {
    if (lstatSync(root).isSymbolicLink()) {
      return { ok: false, error: 'drafts root may not be a symbolic link' };
    }
  } catch {
    // Does not exist yet: it will be created.
  }
  return { ok: true, root };
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export interface WrittenRun {
  dir: string;
  files: string[];
}

export function writeRunArtifacts(options: {
  result: WritableResult;
  draftsRoot: string;
  now?: Date;
  randomHex?: () => string;
}): WrittenRun {
  const { result, draftsRoot } = options;
  const now = options.now ?? new Date();
  const suffix = (options.randomHex ?? (() => randomBytes(4).toString('hex')))();
  const identity =
    result.status === 'REVIEW_REQUIRED'
      ? result.scenario
      : { id: result.brief.scenarioId, version: result.brief.version };

  mkdirSync(draftsRoot, { recursive: true });
  const base = path.join(draftsRoot, `${stamp(now)}-${identity.id}-v${identity.version}-${suffix}`);
  const label =
    result.status === 'REVIEW_REQUIRED'
      ? 'review-required'
      : result.status === 'REJECTED'
        ? 'rejected'
        : 'stopped';
  const finalDir = `${base}--${label}`;
  const workDir = `${base}.incomplete`;
  if (existsSync(finalDir)) throw new Error('refusing to overwrite an existing run directory');
  mkdirSync(workDir); // non-recursive: throws if it already exists

  const files: Array<[string, string]> =
    result.status === 'REVIEW_REQUIRED'
      ? [
          ['validated-candidate.json', json(result.scenario)],
          ['validation-report.json', json(buildValidationReport(result))],
          ['review-report.md', renderReviewReport(result)],
        ]
      : [['run-report.json', json(buildFailureReport(result))]];

  for (const [name, data] of files) {
    writeFileSync(path.join(workDir, name), data, { flag: 'wx', encoding: 'utf8' });
  }
  renameSync(workDir, finalDir);
  return { dir: finalDir, files: files.map(([name]) => name) };
}
