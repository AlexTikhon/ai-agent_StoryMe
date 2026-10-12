import type { InteractivePresentationPanelDto } from '@book/types';
import { isPanel } from '../../presentation-panels';
import type { AcceptedTranscriptPage } from './accepted-page';

/** The pack identity and panels shown for one chapter. */
export interface ChapterArtworkPack {
  readonly packId: string;
  readonly packVersion: number;
  readonly panels: readonly InteractivePresentationPanelDto[];
}

export type TranscriptArtworkCheck =
  | {
      ok: true;
      /** One entry per text step, in order; `null` where no artwork is configured. */
      steps: readonly (ChapterArtworkPack | null)[];
    }
  | { ok: false; reason: string };

const PACK_ID = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_PANELS_PER_SCENE = 4;
const MAX_DIMENSION = 4000;
const MAX_ALT_LENGTH = 300;
const MAX_PANEL_ID_LENGTH = 63;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readPack(raw: unknown): ChapterArtworkPack | string {
  if (!isRecord(raw)) return 'presentation is not an object';
  const { packId, packVersion, panels } = raw;
  if (typeof packId !== 'string' || !PACK_ID.test(packId)) return 'invalid pack id';
  if (!Number.isSafeInteger(packVersion) || (packVersion as number) < 1) {
    return 'invalid pack version';
  }
  if (!Array.isArray(panels) || panels.length === 0 || panels.length > MAX_PANELS_PER_SCENE) {
    return 'unexpected number of panels';
  }
  const directory = `/interactive/${packId}/v${packVersion as number}/`;
  const seen = new Set<string>();
  const clean: InteractivePresentationPanelDto[] = [];
  for (const panel of panels as unknown[]) {
    if (!isPanel(panel)) return 'invalid panel';
    if (
      panel.id.length > MAX_PANEL_ID_LENGTH ||
      panel.width > MAX_DIMENSION ||
      panel.height > MAX_DIMENSION ||
      panel.alt.length > MAX_ALT_LENGTH
    ) {
      return 'panel metadata out of bounds';
    }
    if (!panel.src.startsWith(directory)) return 'panel is outside its pack directory';
    if (seen.has(panel.id)) return 'duplicate panel id';
    seen.add(panel.id);
    // Only known fields survive; anything extra the response carried is dropped.
    clean.push(
      Object.freeze({
        id: panel.id,
        src: panel.src,
        width: panel.width,
        height: panel.height,
        alt: panel.alt,
      }),
    );
  }
  return Object.freeze({
    packId,
    packVersion: packVersion as number,
    panels: Object.freeze(clean),
  });
}

/**
 * Checks one artwork page against the accepted text page it must illustrate:
 * same session, scenario, version and completed revision; the same ordered
 * revisions and scene ids; the same cursor; and well-formed, bounded, safe
 * artwork. Nothing from a page that fails any check is attached anywhere.
 */
export function checkTranscriptArtwork(
  raw: unknown,
  page: AcceptedTranscriptPage,
): TranscriptArtworkCheck {
  const fail = (reason: string): TranscriptArtworkCheck => ({ ok: false, reason });
  if (!isRecord(raw)) return fail('not an object');
  if (raw['sessionId'] !== page.sessionId) return fail('artwork is for another session');
  if (raw['scenarioId'] !== page.scenarioId) return fail('artwork is for another scenario');
  if (raw['scenarioVersion'] !== page.scenarioVersion) return fail('artwork scenario version');
  if (raw['completedRevision'] !== page.completedRevision) return fail('completed revision');
  if (raw['nextCursor'] !== page.nextCursor) return fail('next cursor differs from the text page');

  const rawSteps = raw['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length !== page.revisions.length) {
    return fail('artwork step count differs from the text page');
  }
  const steps: (ChapterArtworkPack | null)[] = [];
  let packKey: string | null = null;
  for (const [index, rawStep] of (rawSteps as unknown[]).entries()) {
    if (!isRecord(rawStep)) return fail('malformed artwork step');
    if (rawStep['revision'] !== page.revisions[index]) return fail('artwork revision order');
    if (rawStep['sceneId'] !== page.sceneIds[index]) return fail('artwork scene differs');
    const presentation = rawStep['presentation'];
    if (presentation === null) {
      steps.push(null);
      continue;
    }
    const pack = readPack(presentation);
    if (typeof pack === 'string') return fail(pack);
    const key = `${pack.packId}@${pack.packVersion}`;
    if (packKey !== null && packKey !== key) return fail('mixed packs within one page');
    packKey = key;
    steps.push(pack);
  }
  return { ok: true, steps: Object.freeze(steps) };
}
