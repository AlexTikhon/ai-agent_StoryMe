import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Request parsing for the interactive endpoints. Schemas are strict: clients
 * may submit only a scenario id or a choice command, never events, state,
 * effects, narration or an owner id. Parsing failures carry the stable code
 * INVALID_REQUEST and never echo the offending values.
 */

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

export const createSessionBodySchema = z.object({ scenarioId: identifier }).strict();

export const submitChoiceBodySchema = z
  .object({
    choiceId: identifier,
    expectedRevision: z.number().int().min(0).max(1_000_000),
    idempotencyKey,
  })
  .strict();

export const sessionIdSchema = z.string().uuid();

export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
export type SubmitChoiceBody = z.infer<typeof submitChoiceBodySchema>;

export function parseRequest<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: 'The request is malformed',
    });
  }
  return parsed.data;
}
