import { describe, expect, it } from 'vitest';
import { sessionMetadataSchema } from './session-metadata';

const valid = {
  sessionId: '9b2e7a9e-0f1c-4d5b-8a53-2f0f6a2e7c11',
  scenarioId: 'warsaw-last-delivery',
  scenarioVersion: 1,
  title: 'The Last Delivery',
};

describe('sessionMetadataSchema', () => {
  it('accepts exactly the four allowlisted fields', () => {
    expect(sessionMetadataSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['an extra field', { ...valid, revision: 0 }],
    ['a missing title', { ...valid, title: undefined }],
    ['an empty title', { ...valid, title: '' }],
    ['a multi-line title', { ...valid, title: 'a\nb' }],
    ['an over-long title', { ...valid, title: 'x'.repeat(81) }],
    ['a non-uuid session id', { ...valid, sessionId: 'nope' }],
    ['a zero version', { ...valid, scenarioVersion: 0 }],
    ['a fractional version', { ...valid, scenarioVersion: 1.5 }],
  ])('rejects %s', (_label, value) => {
    expect(sessionMetadataSchema.safeParse(value).success).toBe(false);
  });
});
