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

export const createSessionBodySchema = z
  .object({ scenarioId: identifier, idempotencyKey })
  .strict();

export const submitChoiceBodySchema = z
  .object({
    choiceId: identifier,
    expectedRevision: z.number().int().min(0).max(1_000_000),
    idempotencyKey,
  })
  .strict();

export const sessionIdSchema = z.string().uuid();

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;

/** Decoded keyset position: the last row of the previous page. */
export interface SessionListCursor {
  createdAt: Date;
  id: string;
}

const cursorPayloadSchema = z
  .object({ t: z.string().datetime({ offset: false }), i: z.string().uuid() })
  .strict();

export function encodeListCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id })).toString(
    'base64url',
  );
}

/** Opaque cursor: strictly base64url -> JSON {t, i}; anything else is rejected. */
const cursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,200}$/)
  .transform((raw, ctx): SessionListCursor => {
    try {
      const parsed = cursorPayloadSchema.parse(
        JSON.parse(Buffer.from(raw, 'base64url').toString()),
      );
      return { createdAt: new Date(parsed.t), id: parsed.i };
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid cursor' });
      return z.NEVER;
    }
  });

/** Query strings are strings: `limit` is digits only (1-50), repeated params are rejected. */
export const listSessionsQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .refine((n) => n <= MAX_LIST_LIMIT)
      .optional(),
    cursor: cursor.optional(),
  })
  .strict()
  .transform((q) => ({ limit: q.limit ?? DEFAULT_LIST_LIMIT, cursor: q.cursor ?? null }));

export type ListSessionsQuery = z.output<typeof listSessionsQuerySchema>;
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
export type SubmitChoiceBody = z.infer<typeof submitChoiceBodySchema>;

export function parseRequest<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: 'The request is malformed',
    });
  }
  return parsed.data;
}
