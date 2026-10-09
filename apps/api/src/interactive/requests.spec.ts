import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  createSessionBodySchema,
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
    expect(parseRequest(createSessionBodySchema, { scenarioId: 'warsaw-last-delivery' })).toEqual({
      scenarioId: 'warsaw-last-delivery',
    });
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
    expect(rejects(createSessionBodySchema, { scenarioId: '../etc' })).toBe(true);
  });

  it('rejects missing fields and non-object bodies', () => {
    expect(rejects(submitChoiceBodySchema, undefined)).toBe(true);
    expect(rejects(submitChoiceBodySchema, 'choice')).toBe(true);
    expect(rejects(submitChoiceBodySchema, { choiceId: valid.choiceId })).toBe(true);
    expect(rejects(createSessionBodySchema, {})).toBe(true);
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
        rejects(createSessionBodySchema, { scenarioId: 'warsaw-last-delivery', ...extra }),
      ).toBe(true);
    }
  });
});
