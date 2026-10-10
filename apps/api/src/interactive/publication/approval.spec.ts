import { describe, expect, it } from 'vitest';
import { hashScenarioDefinition } from '../domain/scenario-schema';
import { LAST_TRAM_SCENARIO } from '../authoring/the-last-tram';
import { REVIEW_CHECKLIST } from '../authoring/review';
import {
  APPROVAL_SCHEMA_VERSION,
  EDITORIAL_CHECKLIST_ITEMS,
  EDITORIAL_CHECKLIST_VERSION,
  buildPendingApproval,
  checkApproval,
  parseApprovalRecord,
  type ApprovalRecord,
} from './approval';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const subject = {
  id: LAST_TRAM_SCENARIO.id,
  version: LAST_TRAM_SCENARIO.version,
  candidateHash: hashScenarioDefinition(LAST_TRAM_SCENARIO),
};

/** Test-only attestation. Real candidates are never approved by tests or tooling. */
function approved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pending = buildPendingApproval(subject);
  return {
    ...pending,
    decision: 'approved',
    reviewer: 'test-reviewer',
    reviewedAt: '2026-10-09T10:00:00Z',
    checklist: {
      version: EDITORIAL_CHECKLIST_VERSION,
      items: Object.fromEntries(EDITORIAL_CHECKLIST_ITEMS.map((i) => [i, true])),
    },
    ...overrides,
  };
}

const failure = (raw: unknown, s = subject) => {
  const parsed = parseApprovalRecord(raw);
  if (!parsed.ok) return parsed;
  return checkApproval(parsed.record, s, NOW);
};

describe('buildPendingApproval', () => {
  it('starts pending with no reviewer, timestamp or completed check', () => {
    const t = buildPendingApproval(subject);
    expect(t).toEqual({
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      scenario: { id: subject.id, version: subject.version },
      candidateHash: subject.candidateHash,
      decision: 'pending',
      reviewer: null,
      reviewedAt: null,
      checklist: {
        version: EDITORIAL_CHECKLIST_VERSION,
        items: Object.fromEntries(EDITORIAL_CHECKLIST_ITEMS.map((i) => [i, false])),
      },
    });
  });

  it('round-trips through the parser but is never an approval', () => {
    const parsed = parseApprovalRecord(JSON.parse(JSON.stringify(buildPendingApproval(subject))));
    expect(parsed.ok).toBe(true);
    expect(failure(buildPendingApproval(subject))).toMatchObject({
      ok: false,
      code: 'APPROVAL_PENDING',
    });
  });

  it('has one checklist id for every item of the human-readable review checklist', () => {
    expect(EDITORIAL_CHECKLIST_ITEMS).toHaveLength(REVIEW_CHECKLIST.length);
  });
});

describe('parseApprovalRecord', () => {
  it('accepts a complete approved record', () => {
    expect(parseApprovalRecord(approved()).ok).toBe(true);
  });

  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['an array', []],
  ])('rejects %s as malformed', (_name, raw) => {
    expect(parseApprovalRecord(raw)).toMatchObject({ ok: false, code: 'APPROVAL_MALFORMED' });
  });

  it('rejects unknown top-level, scenario and checklist fields', () => {
    expect(parseApprovalRecord(approved({ approved: true }))).toMatchObject({
      code: 'APPROVAL_MALFORMED',
    });
    expect(
      parseApprovalRecord(approved({ scenario: { id: subject.id, version: 1, x: 1 } })),
    ).toMatchObject({
      code: 'APPROVAL_MALFORMED',
    });
    const record = approved() as { checklist: { version: string; items: Record<string, boolean> } };
    expect(
      parseApprovalRecord({
        ...record,
        checklist: { ...record.checklist, items: { ...record.checklist.items, bonus: true } },
      }),
    ).toMatchObject({ code: 'APPROVAL_MALFORMED' });
  });

  it('rejects an unsupported record version or checklist version', () => {
    expect(parseApprovalRecord(approved({ schemaVersion: 'scenario-approval/v2' }))).toMatchObject({
      ok: false,
      code: 'APPROVAL_UNSUPPORTED_VERSION',
    });
    const record = approved() as { checklist: { items: unknown } };
    expect(
      parseApprovalRecord({
        ...record,
        checklist: { ...record.checklist, version: 'editorial-checklist/v0' },
      }),
    ).toMatchObject({ ok: false, code: 'APPROVAL_UNSUPPORTED_VERSION' });
  });

  it('rejects missing checklist items, non-boolean items and malformed hashes', () => {
    const record = approved() as { checklist: { version: string; items: Record<string, boolean> } };
    const { [EDITORIAL_CHECKLIST_ITEMS[0]!]: _dropped, ...rest } = record.checklist.items;
    expect(
      parseApprovalRecord({ ...record, checklist: { ...record.checklist, items: rest } }),
    ).toMatchObject({ code: 'APPROVAL_MALFORMED' });
    expect(
      parseApprovalRecord({
        ...record,
        checklist: { ...record.checklist, items: { ...record.checklist.items, pacing: 'yes' } },
      }),
    ).toMatchObject({ code: 'APPROVAL_MALFORMED' });
    expect(parseApprovalRecord(approved({ candidateHash: 'abc' }))).toMatchObject({
      code: 'APPROVAL_MALFORMED',
    });
    expect(parseApprovalRecord(approved({ decision: 'maybe' }))).toMatchObject({
      code: 'APPROVAL_MALFORMED',
    });
  });

  it('bounds reviewer length', () => {
    expect(parseApprovalRecord(approved({ reviewer: 'x'.repeat(5000) }))).toMatchObject({
      code: 'APPROVAL_MALFORMED',
    });
  });
});

describe('checkApproval', () => {
  it('passes only for a matching, approved, complete record', () => {
    const parsed = parseApprovalRecord(approved());
    if (!parsed.ok) throw new Error('fixture invalid');
    expect(checkApproval(parsed.record, subject, NOW)).toEqual({ ok: true });
  });

  it('refuses pending and rejected decisions', () => {
    expect(failure(approved({ decision: 'pending' }))).toMatchObject({ code: 'APPROVAL_PENDING' });
    expect(failure(approved({ decision: 'rejected' }))).toMatchObject({
      code: 'APPROVAL_REJECTED',
    });
  });

  it('refuses a different scenario id or version', () => {
    expect(
      failure(approved({ scenario: { id: 'other', version: subject.version } })),
    ).toMatchObject({
      code: 'APPROVAL_IDENTITY_MISMATCH',
    });
    expect(
      failure(approved({ scenario: { id: subject.id, version: subject.version + 1 } })),
    ).toMatchObject({
      code: 'APPROVAL_IDENTITY_MISMATCH',
    });
  });

  it('refuses a different candidate hash', () => {
    expect(failure(approved({ candidateHash: 'f'.repeat(64) }))).toMatchObject({
      code: 'APPROVAL_HASH_MISMATCH',
    });
  });

  it('is invalidated when prose or effects change the canonical hash', () => {
    const editedProse = structuredClone(LAST_TRAM_SCENARIO);
    editedProse.scenes[0]!.narration[0]!.text += ' (edited)';
    const editedHash = hashScenarioDefinition(editedProse);
    expect(editedHash).not.toBe(subject.candidateHash);
    expect(failure(approved(), { ...subject, candidateHash: editedHash })).toMatchObject({
      code: 'APPROVAL_HASH_MISMATCH',
    });
  });

  it('requires a valid reviewer', () => {
    for (const reviewer of [null, '', '   ', ' padded ', 'bad\nname']) {
      expect(failure(approved({ reviewer }))).toMatchObject({ code: 'APPROVAL_REVIEWER_INVALID' });
    }
  });

  it('requires a valid, non-future UTC timestamp', () => {
    for (const reviewedAt of [
      null,
      '',
      'yesterday',
      '2026-10-09',
      '2026-10-09T10:00:00+02:00',
      '2026-02-31T10:00:00Z',
      '2026-10-11T10:00:00Z',
    ]) {
      expect(failure(approved({ reviewedAt }))).toMatchObject({
        code: 'APPROVAL_TIMESTAMP_INVALID',
      });
    }
  });

  it('requires every checklist item to be completed', () => {
    const record = approved() as { checklist: { version: string; items: Record<string, boolean> } };
    for (const item of EDITORIAL_CHECKLIST_ITEMS) {
      const items = { ...record.checklist.items, [item]: false };
      expect(failure({ ...record, checklist: { ...record.checklist, items } })).toMatchObject({
        code: 'APPROVAL_CHECKLIST_INCOMPLETE',
      });
    }
  });

  it('exposes a type for callers', () => {
    const parsed = parseApprovalRecord(approved());
    if (parsed.ok) {
      const record: ApprovalRecord = parsed.record;
      expect(record.decision).toBe('approved');
    }
  });
});
