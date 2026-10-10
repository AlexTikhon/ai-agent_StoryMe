import { z } from 'zod';

/**
 * Editorial approval records.
 *
 * A record is a HUMAN-AUTHORED ATTESTATION that a named reviewer read one exact
 * candidate (bound by id, version and canonical hash) and completed a known
 * checklist. It is not an authenticated identity, a signature, or proof that
 * prose quality was verified by software. Tooling may only ever emit a PENDING
 * template; nothing in this codebase writes an approved record.
 *
 * This module depends on nothing but zod so authoring, preflight and the real
 * scenario registry can all use it without an import cycle.
 */

export const APPROVAL_SCHEMA_VERSION = 'scenario-approval/v1';
export const EDITORIAL_CHECKLIST_VERSION = 'editorial-checklist/v1';

/** One id per item of the human-readable REVIEW_CHECKLIST, in the same order. */
export const EDITORIAL_CHECKLIST_ITEMS = [
  'unannotated-secrets',
  'contradictions',
  'pacing',
  'meaningful-choices',
  'audience',
  'originality',
  'endings',
] as const;

export const MAX_APPROVAL_FILE_BYTES = 16 * 1024;
export const MAX_REVIEWER_CHARS = 100;
/** Tolerated clock skew for a review timestamp that is slightly ahead of this machine. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export type ApprovalFailureCode =
  | 'APPROVAL_MALFORMED'
  | 'APPROVAL_UNSUPPORTED_VERSION'
  | 'APPROVAL_IDENTITY_MISMATCH'
  | 'APPROVAL_HASH_MISMATCH'
  | 'APPROVAL_PENDING'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_REVIEWER_INVALID'
  | 'APPROVAL_TIMESTAMP_INVALID'
  | 'APPROVAL_CHECKLIST_INCOMPLETE';

const checklistItemsShape = Object.fromEntries(
  EDITORIAL_CHECKLIST_ITEMS.map((id) => [id, z.boolean()]),
) as Record<(typeof EDITORIAL_CHECKLIST_ITEMS)[number], z.ZodBoolean>;

export const approvalRecordSchema = z
  .object({
    schemaVersion: z.literal(APPROVAL_SCHEMA_VERSION),
    scenario: z
      .object({
        id: z.string().min(1).max(100),
        version: z.number().int().positive(),
      })
      .strict(),
    candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
    decision: z.enum(['pending', 'approved', 'rejected']),
    reviewer: z
      .string()
      .max(MAX_REVIEWER_CHARS * 4)
      .nullable(),
    reviewedAt: z.string().max(64).nullable(),
    checklist: z
      .object({
        version: z.literal(EDITORIAL_CHECKLIST_VERSION),
        items: z.object(checklistItemsShape).strict(),
      })
      .strict(),
  })
  .strict();

export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export interface ApprovalSubject {
  id: string;
  version: number;
  candidateHash: string;
}

export type ApprovalParse =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; code: 'APPROVAL_MALFORMED' | 'APPROVAL_UNSUPPORTED_VERSION'; message: string };

export type ApprovalCheck =
  { ok: true } | { ok: false; code: ApprovalFailureCode; message: string };

/** The only record tooling may emit: pending, with nothing attested. */
export function buildPendingApproval(subject: ApprovalSubject): ApprovalRecord {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    scenario: { id: subject.id, version: subject.version },
    candidateHash: subject.candidateHash,
    decision: 'pending',
    reviewer: null,
    reviewedAt: null,
    checklist: {
      version: EDITORIAL_CHECKLIST_VERSION,
      items: Object.fromEntries(EDITORIAL_CHECKLIST_ITEMS.map((id) => [id, false])) as Record<
        (typeof EDITORIAL_CHECKLIST_ITEMS)[number],
        boolean
      >,
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict parse. Version problems are reported separately from shape problems. */
export function parseApprovalRecord(raw: unknown): ApprovalParse {
  if (!isRecord(raw)) {
    return { ok: false, code: 'APPROVAL_MALFORMED', message: 'approval record is not an object' };
  }
  if (typeof raw.schemaVersion === 'string' && raw.schemaVersion !== APPROVAL_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'APPROVAL_UNSUPPORTED_VERSION',
      message: `unsupported approval record version (supported: ${APPROVAL_SCHEMA_VERSION})`,
    };
  }
  if (
    isRecord(raw.checklist) &&
    typeof raw.checklist.version === 'string' &&
    raw.checklist.version !== EDITORIAL_CHECKLIST_VERSION
  ) {
    return {
      ok: false,
      code: 'APPROVAL_UNSUPPORTED_VERSION',
      message: `unsupported editorial checklist version (supported: ${EDITORIAL_CHECKLIST_VERSION})`,
    };
  }
  const parsed = approvalRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      code: 'APPROVAL_MALFORMED',
      message: `approval record is malformed${first ? ` at ${first.path.join('.') || '(root)'}` : ''}`,
    };
  }
  return { ok: true, record: parsed.data };
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function validTimestamp(value: string | null, now: Date): boolean {
  if (value === null || !UTC_TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  // Date.parse rolls impossible dates (Feb 31) over; require an exact round trip.
  if (new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return false;
  return time <= now.getTime() + FUTURE_SKEW_MS;
}

function validReviewer(value: string | null): boolean {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= MAX_REVIEWER_CHARS &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

const fail = (code: ApprovalFailureCode, message: string): ApprovalCheck => ({
  ok: false,
  code,
  message,
});

/** Does this parsed record approve exactly this candidate? */
export function checkApproval(
  record: ApprovalRecord,
  subject: ApprovalSubject,
  now: Date = new Date(),
): ApprovalCheck {
  if (record.scenario.id !== subject.id || record.scenario.version !== subject.version) {
    return fail('APPROVAL_IDENTITY_MISMATCH', 'approval is for a different scenario id or version');
  }
  if (record.candidateHash !== subject.candidateHash) {
    return fail(
      'APPROVAL_HASH_MISMATCH',
      'approval hash does not match the candidate (the candidate changed or is a different one)',
    );
  }
  if (record.decision === 'pending') return fail('APPROVAL_PENDING', 'approval is still pending');
  if (record.decision === 'rejected') return fail('APPROVAL_REJECTED', 'candidate was rejected');
  if (!validReviewer(record.reviewer)) {
    return fail('APPROVAL_REVIEWER_INVALID', 'approval needs a reviewer identifier');
  }
  if (!validTimestamp(record.reviewedAt, now)) {
    return fail(
      'APPROVAL_TIMESTAMP_INVALID',
      'approval needs an ISO-8601 UTC review timestamp that is not in the future',
    );
  }
  const open = EDITORIAL_CHECKLIST_ITEMS.filter((id) => record.checklist.items[id] !== true);
  if (open.length > 0) {
    return fail(
      'APPROVAL_CHECKLIST_INCOMPLETE',
      `checklist items not completed: ${open.join(', ')}`,
    );
  }
  return { ok: true };
}
