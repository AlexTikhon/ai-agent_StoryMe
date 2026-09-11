import { describe, expect, it } from 'vitest';
import {
  assertStructuredCompletion,
  CHARACTER_RESPONSE_FORMAT,
  STORY_RESPONSE_FORMAT,
} from './structured-output';

describe('Structured Outputs contract', () => {
  it.each(['refusal', 'truncated'] as const)(
    'classifies %s before attempting JSON parsing',
    (kind) => {
      const choice =
        kind === 'refusal'
          ? { message: { refusal: 'Declined', content: null } }
          : { finish_reason: 'length', message: { content: '{' } };
      expect(() => assertStructuredCompletion({ choices: [choice] })).toThrow(
        expect.objectContaining({ failureKind: kind }),
      );
    },
  );
  it('requires all schema properties and disallows extra keys recursively', () => {
    function check(schema: Record<string, unknown>) {
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties as object));
        Object.values(schema.properties as Record<string, Record<string, unknown>>).forEach(check);
      }
      if (schema.items) check(schema.items as Record<string, unknown>);
    }
    check(STORY_RESPONSE_FORMAT.json_schema.schema);
    check(CHARACTER_RESPONSE_FORMAT.json_schema.schema);
  });
});
