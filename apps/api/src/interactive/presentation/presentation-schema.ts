import { z } from 'zod';

/**
 * Presentation packs describe artwork only. They are typed data, validated at
 * load: no expressions, templates, remote URLs or model-generated metadata, and
 * no reference to story state. A pack never changes what a scene means.
 */

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

/**
 * Same-origin public static SVGs under a versioned directory,
 * e.g. `/interactive/warsaw-noir/v1/s-courtyard.svg`. Anything else (remote
 * URLs, traversal, query strings, other extensions) is rejected.
 */
export const ASSET_PATH_PATTERN =
  /^\/interactive\/[a-z0-9-]{1,40}\/v[1-9][0-9]{0,2}\/[a-z0-9-]{1,60}\.svg$/;

export const panelSchema = z
  .object({
    id: identifier,
    src: z.string().regex(ASSET_PATH_PATTERN),
    width: z.number().int().min(200).max(4000),
    height: z.number().int().min(100).max(4000),
    alt: z.string().min(20).max(300),
  })
  .strict();

export const presentationPackSchema = z
  .object({
    packId: identifier,
    packVersion: z.number().int().min(1),
    scenarioId: identifier,
    scenarioVersion: z.number().int().min(1),
    /** sceneId -> the panels shown for that scene. */
    scenes: z.record(identifier, z.array(panelSchema).min(1).max(4)),
  })
  .strict();

export type PresentationPanel = z.infer<typeof panelSchema>;
export type PresentationPack = z.infer<typeof presentationPackSchema>;

export class PresentationPackError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid presentation pack:\n- ${issues.join('\n- ')}`);
    this.name = 'PresentationPackError';
  }
}

/** Structural validation plus uniqueness of panel ids and asset paths. */
export function parsePresentationPack(raw: unknown): PresentationPack {
  const parsed = presentationPackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PresentationPackError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const pack = parsed.data;
  const issues: string[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [sceneId, panels] of Object.entries(pack.scenes)) {
    for (const panel of panels) {
      if (ids.has(panel.id)) issues.push(`${sceneId}: duplicate panel id ${panel.id}`);
      if (paths.has(panel.src)) issues.push(`${sceneId}: duplicate asset path ${panel.src}`);
      ids.add(panel.id);
      paths.add(panel.src);
      if (!panel.src.includes(`/${pack.packId}/v${pack.packVersion}/`)) {
        issues.push(
          `${panel.id}: asset path must live under /${pack.packId}/v${pack.packVersion}/`,
        );
      }
    }
  }
  if (issues.length > 0) throw new PresentationPackError(issues);
  return pack;
}
