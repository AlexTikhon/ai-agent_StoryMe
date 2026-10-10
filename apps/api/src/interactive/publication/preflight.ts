import { sha256Hex } from '../domain/canonical';
import type { analyzeScenario } from '../domain/scenario-analysis';
import {
  boundDiagnostics,
  diagnostic,
  type Diagnostic,
  type ValidationStage,
} from '../authoring/diagnostics';
import {
  isPublishedInRegistry,
  validateNormalizedScenario,
  type MechanicalReport,
} from '../authoring/validate';
import {
  MAX_APPROVAL_FILE_BYTES,
  checkApproval,
  parseApprovalRecord,
  type ApprovalFailureCode,
} from './approval';

/**
 * Read-only publication preflight over the TEXT of a candidate and an approval
 * record. Pure: it reads nothing from disk, calls no provider or database,
 * writes nothing and never touches a registry. Success only means "ready for a
 * deliberate manual source registration"; it publishes nothing.
 *
 * The candidate is the normalized RUNTIME definition (validated-candidate.json),
 * not the provider wire format, so it goes through the shared normalized
 * validation step. Every mechanical check is re-run; no stored report is trusted.
 */

/** Pretty-printed runtime candidates are larger than their 48 kB canonical form. */
export const MAX_CANDIDATE_FILE_BYTES = 200_000;
export { MAX_APPROVAL_FILE_BYTES };

export type PreflightFailureCode =
  | ApprovalFailureCode
  | 'CANDIDATE_UNREADABLE'
  | 'CANDIDATE_TOO_LARGE'
  | 'CANDIDATE_NOT_JSON'
  | 'CANDIDATE_INVALID'
  | 'IDENTITY_ALREADY_PUBLISHED'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_UNREADABLE'
  | 'APPROVAL_TOO_LARGE'
  | 'APPROVAL_NOT_JSON';

export type PreflightResult =
  | {
      status: 'PUBLICATION_PREFLIGHT_PASSED';
      scenario: { id: string; version: number };
      candidateHash: string;
      report: MechanicalReport;
    }
  | {
      status: 'PUBLICATION_PREFLIGHT_FAILED';
      code: PreflightFailureCode;
      message: string;
      /** Set when the candidate failed a mechanical validation stage. */
      stage: ValidationStage | null;
      diagnostics: Diagnostic[];
      droppedDiagnostics: number;
    };

export interface PreflightInput {
  candidateText: string;
  /** null = no approval file was supplied or it does not exist. */
  approvalText: string | null;
  /** Injectable registry lookup; defaults to the real published registry (read-only). */
  isPublished?: (id: string, version: number) => boolean;
  analyze?: typeof analyzeScenario;
  now?: Date;
}

function failed(
  code: PreflightFailureCode,
  message: string,
  stage: ValidationStage | null = null,
  diagnostics: readonly Diagnostic[] = [],
): PreflightResult {
  const bounded = boundDiagnostics(diagnostics);
  return {
    status: 'PUBLICATION_PREFLIGHT_FAILED',
    code,
    message,
    stage,
    diagnostics: bounded.diagnostics,
    droppedDiagnostics: bounded.dropped,
  };
}

export function runPublicationPreflight(input: PreflightInput): PreflightResult {
  const isPublished = input.isPublished ?? isPublishedInRegistry;

  // 1. Bounded candidate text -> JSON -> full mechanical revalidation.
  if (Buffer.byteLength(input.candidateText, 'utf8') > MAX_CANDIDATE_FILE_BYTES) {
    return failed('CANDIDATE_TOO_LARGE', `candidate exceeds ${MAX_CANDIDATE_FILE_BYTES} bytes`);
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(input.candidateText);
  } catch {
    return failed('CANDIDATE_NOT_JSON', 'candidate is not valid JSON');
  }
  const outcome = validateNormalizedScenario(
    candidate,
    sha256Hex(input.candidateText),
    input.analyze,
  );
  if (!outcome.ok) {
    return failed(
      'CANDIDATE_INVALID',
      `candidate failed mechanical validation at stage "${outcome.stage}"`,
      outcome.stage,
      outcome.diagnostics,
    );
  }
  const { scenario, candidateHash } = outcome;

  // 2. A published id/version is append-only and can never be replaced.
  if (isPublished(scenario.id, scenario.version)) {
    return failed(
      'IDENTITY_ALREADY_PUBLISHED',
      'this scenario id and version are already in the published registry',
      'identity',
      [diagnostic('identity', 'IDENTITY_ALREADY_PUBLISHED', 'identity is already published')],
    );
  }

  // 3. The approval must exist and attest to exactly this candidate.
  if (input.approvalText === null) {
    return failed('APPROVAL_MISSING', 'no approval record was provided');
  }
  if (Buffer.byteLength(input.approvalText, 'utf8') > MAX_APPROVAL_FILE_BYTES) {
    return failed('APPROVAL_TOO_LARGE', `approval exceeds ${MAX_APPROVAL_FILE_BYTES} bytes`);
  }
  let rawApproval: unknown;
  try {
    rawApproval = JSON.parse(input.approvalText);
  } catch {
    return failed('APPROVAL_NOT_JSON', 'approval is not valid JSON');
  }
  const parsed = parseApprovalRecord(rawApproval);
  if (!parsed.ok) return failed(parsed.code, parsed.message);
  const checked = checkApproval(
    parsed.record,
    { id: scenario.id, version: scenario.version, candidateHash },
    input.now,
  );
  if (!checked.ok) return failed(checked.code, checked.message);

  return {
    status: 'PUBLICATION_PREFLIGHT_PASSED',
    scenario: { id: scenario.id, version: scenario.version },
    candidateHash,
    report: outcome.report,
  };
}
