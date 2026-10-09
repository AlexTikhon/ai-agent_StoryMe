import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIST_LIMIT,
  createSessionBodySchema,
  encodeListCursor,
  listSessionsQuerySchema,
  parseRequest,
  sessionIdSchema,
  submitChoiceBodySchema,
} from './requests';

const valid = {
  choiceId: 'c-ask-caretaker',
  expectedRevision: 0,
  idempotencyKey: 'key_1234-abcd',
};

function rejects(schema: Parameters<typeof parseRequest>[0], value: unknown): boolean {
  try {
    parseRequest(schema, value);
    return false;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_REQUEST' });
    return true;
  }
}

describe('interactive request validation', () => {
  it('accepts a well-formed choice command and session creation body', () => {
    expect(parseRequest(submitChoiceBodySchema, valid)).toEqual(valid);
    const create = { scenarioId: 'warsaw-last-delivery', idempotencyKey: 'start-1234-abcd' };
    expect(parseRequest(createSessionBodySchema, create)).toEqual(create);
    expect(parseRequest(sessionIdSchema, '3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBeTruthy();
  });

  it('rejects malformed session ids', () => {
    for (const id of ['', 'abc', '3f2504e0-4f89-41d3-9a0c-0305e82c33', "1'; DROP TABLE x;--"]) {
      expect(rejects(sessionIdSchema, id)).toBe(true);
    }
  });

  it('rejects bad revisions', () => {
    for (const expectedRevision of [-1, 1.5, '1', null, Number.NaN, 2_000_000, undefined]) {
      expect(rejects(submitChoiceBodySchema, { ...valid, expectedRevision })).toBe(true);
    }
  });

  it('rejects unbounded or malformed identifiers and keys', () => {
    expect(rejects(submitChoiceBodySchema, { ...valid, choiceId: 'C Bad' })).toBe(true);
    expect(rejects(submitChoiceBodySchema, { ...valid, choiceId: 'c'.repeat(64) })).toBe(true);
    expect(rejects(submitChoiceBodySchema, { ...valid, idempotencyKey: '' })).toBe(true);
    expect(rejects(submitChoiceBodySchema, { ...valid, idempotencyKey: 'k'.repeat(129) })).toBe(
      true,
    );
    expect(rejects(submitChoiceBodySchema, { ...valid, idempotencyKey: 'has space' })).toBe(true);
    const create = { scenarioId: 'warsaw-last-delivery', idempotencyKey: 'start-1234-abcd' };
    expect(rejects(createSessionBodySchema, { ...create, scenarioId: '../etc' })).toBe(true);
    for (const key of ['', 'k'.repeat(129), 'has space', 42, null]) {
      expect(rejects(createSessionBodySchema, { ...create, idempotencyKey: key })).toBe(true);
    }
  });

  it('rejects missing fields and non-object bodies', () => {
    expect(rejects(submitChoiceBodySchema, undefined)).toBe(true);
    expect(rejects(submitChoiceBodySchema, 'choice')).toBe(true);
    expect(rejects(submitChoiceBodySchema, { choiceId: valid.choiceId })).toBe(true);
    expect(rejects(createSessionBodySchema, {})).toBe(true);
    // The idempotency key is required for creation.
    expect(rejects(createSessionBodySchema, { scenarioId: 'warsaw-last-delivery' })).toBe(true);
  });

  it('refuses client-supplied events, state, effects, narration or owner', () => {
    for (const extra of [
      { userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      { events: [] },
      { state: { revision: 99 } },
      { effects: [{ kind: 'giveItem', item: 'parcel' }] },
      { narration: 'The story ends happily.' },
    ]) {
      expect(rejects(submitChoiceBodySchema, { ...valid, ...extra })).toBe(true);
      expect(
        rejects(createSessionBodySchema, {
          scenarioId: 'warsaw-last-delivery',
          idempotencyKey: 'start-1234-abcd',
          ...extra,
        }),
      ).toBe(true);
    }
  });

  describe('session list query', () => {
    const cursorValue = encodeListCursor({
      createdAt: new Date('2026-10-09T10:11:12.345Z'),
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });

    it('defaults the limit and accepts a round-tripped cursor', () => {
      expect(parseRequest(listSessionsQuerySchema, {})).toEqual({
        limit: DEFAULT_LIST_LIMIT,
        cursor: null,
      });
      const parsed = parseRequest(listSessionsQuerySchema, { limit: '50', cursor: cursorValue });
      expect(parsed.limit).toBe(50);
      expect(parsed.cursor).toEqual({
        createdAt: new Date('2026-10-09T10:11:12.345Z'),
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      });
    });

    it('rejects out-of-range, non-numeric and repeated limits', () => {
      for (const limit of ['0', '51', '-1', '1.5', '1e1', ' 5', '007', 'abc', '', ['1', '2']]) {
        expect(rejects(listSessionsQuerySchema, { limit }), String(limit)).toBe(true);
      }
    });

    it('rejects malformed, forged and oversized cursors', () => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const bad = [
        '',
        'not base64!',
        'a'.repeat(201),
        encode({ t: 'yesterday', i: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }),
        encode({ t: '2026-10-09T10:11:12.345Z', i: "1' OR '1'='1" }),
        encode({ t: '2026-10-09T10:11:12.345Z', i: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', x: 1 }),
        encode('plain string'),
        Buffer.from('{not json').toString('base64url'),
      ];
      for (const cursor of bad) expect(rejects(listSessionsQuerySchema, { cursor })).toBe(true);
    });

    it('rejects unknown query parameters such as an owner id', () => {
      expect(rejects(listSessionsQuerySchema, { userId: 'someone-else' })).toBe(true);
    });
  });
});
