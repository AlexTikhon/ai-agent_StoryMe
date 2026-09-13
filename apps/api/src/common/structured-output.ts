/** Chat Completions Structured Outputs; local Zod/business validation still applies.
 * https://developers.openai.com/api/docs/guides/structured-outputs
 */
import { GenerationControlError } from './provider-execution';
function object(properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const strings = (keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, { type: 'string' }]));
export const STORY_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'story',
    strict: true,
    schema: object({
      ...strings(['title', 'theme', 'educationalMessage', 'openingHook', 'resolution']),
      subtitle: { type: ['string', 'null'] },
      pages: {
        type: 'array',
        items: object({
          pageNumber: { type: 'integer' },
          ...strings([
            'title',
            'sceneDescription',
            'storyText',
            'illustrationPrompt',
            'learningGoal',
          ]),
        }),
      },
    }),
  },
};
export const CHARACTER_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'character',
    strict: true,
    schema: object(
      strings([
        'visualDescription',
        'faceDescription',
        'hairDescription',
        'eyeDescription',
        'outfitDescription',
        'personalitySummary',
        'illustrationStyle',
      ]),
    ),
  },
};

export class StructuredOutputError extends GenerationControlError {
  constructor(readonly failureKind: 'refusal' | 'truncated' | 'schema_error') {
    super(
      failureKind === 'refusal' ? 'refusal' : 'invalid_output',
      `Provider output ${failureKind}`,
    );
  }
}
export function assertStructuredCompletion(payload: unknown): void {
  const choice = (
    payload as { choices?: Array<{ finish_reason?: string; message?: { refusal?: unknown } }> }
  )?.choices?.[0];
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter')
    throw new StructuredOutputError('refusal');
  if (choice?.finish_reason === 'length') throw new StructuredOutputError('truncated');
}
