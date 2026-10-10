import { z } from 'zod';
import { MAX_TITLE_LENGTH } from './scenarios/registry';

/**
 * Display metadata of one session's pinned scenario version. This is not part
 * of the public session view: that view is stored with every event, so adding
 * fields to it would either change historical responses or leave them
 * inconsistent. The metadata is derived on read and never persisted.
 *
 * Strict on the way out as well: only these four fields can reach the wire.
 */
export const sessionMetadataSchema = z
  .object({
    sessionId: z.string().uuid(),
    scenarioId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    scenarioVersion: z.number().int().min(1),
    title: z
      .string()
      .min(1)
      .max(MAX_TITLE_LENGTH)
      .refine((value) => !/[\r\n]/.test(value)),
  })
  .strict();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
