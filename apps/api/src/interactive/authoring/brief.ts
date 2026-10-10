import { z } from 'zod';
import { canonicalHash, canonicalJson } from '../domain/canonical';
import { MAX_BRIEF_BYTES, REQUIRED_CHARACTERS, REQUIRED_ENDINGS } from './limits';

/**
 * The only input the authoring workflow accepts: a small, fictional,
 * English-language brief. Validated locally; the prompt is never the guard.
 */

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, 'must be a lowercase kebab-case identifier (max 63 chars)');

// Latin-script prose only (English with names such as "Łukasz"); no control characters.
const LATIN_TEXT = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]+$/u;
const prose = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (v) => LATIN_TEXT.test(v),
      'must be English (Latin-script) text without control characters',
    );

const briefCharacterSchema = z
  .object({
    id: identifier,
    name: prose(2, 80),
    role: prose(2, 80),
    description: prose(10, 300),
    isPlayer: z.boolean(),
  })
  .strict();

const briefEndingSchema = z
  .object({
    id: identifier,
    title: prose(2, 80),
    concept: prose(10, 300),
  })
  .strict();

export const scenarioBriefSchema = z
  .object({
    scenarioId: identifier,
    version: z.number().int().min(1).max(1000),
    premise: prose(20, 600),
    setting: prose(10, 300),
    tone: prose(3, 120),
    characters: z.array(briefCharacterSchema).length(REQUIRED_CHARACTERS),
    endings: z.array(briefEndingSchema).length(REQUIRED_ENDINGS),
  })
  .strict()
  .superRefine((brief, ctx) => {
    if (brief.characters.filter((c) => c.isPlayer).length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'exactly one character must be the player' });
    }
    const dup = (label: string, ids: string[]) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: 'custom', message: `duplicate ${label} id` });
      }
    };
    dup(
      'character',
      brief.characters.map((c) => c.id),
    );
    dup(
      'ending',
      brief.endings.map((e) => e.id),
    );
  });

export type ScenarioBrief = z.infer<typeof scenarioBriefSchema>;

export type BriefParseResult = { ok: true; brief: ScenarioBrief } | { ok: false; issues: string[] };

/** Validates an untrusted brief; issue strings carry paths and rules, never the offending text. */
export function parseBrief(raw: unknown): BriefParseResult {
  let size: number;
  try {
    size = Buffer.byteLength(canonicalJson(raw), 'utf8');
  } catch {
    return { ok: false, issues: ['(root): brief is not canonical JSON'] };
  }
  if (size > MAX_BRIEF_BYTES) {
    return { ok: false, issues: [`(root): brief exceeds ${MAX_BRIEF_BYTES} bytes`] };
  }
  const parsed = scenarioBriefSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, brief: parsed.data };
}

export function hashBrief(brief: ScenarioBrief): string {
  return canonicalHash(brief);
}
