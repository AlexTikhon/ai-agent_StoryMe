import type { InteractivePresentationPanelDto } from '@book/types';

/** The same-origin public SVG paths the API allow-lists; anything else is never rendered. */
export const SAFE_PANEL_SRC =
  /^\/interactive\/[a-z0-9-]{1,40}\/v[1-9][0-9]{0,2}\/[a-z0-9-]{1,60}\.svg$/;

/** Shape check shared by the live reader and the rereading view; unknown fields are dropped by callers. */
export function isPanel(value: unknown): value is InteractivePresentationPanelDto {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    typeof p['src'] === 'string' &&
    SAFE_PANEL_SRC.test(p['src']) &&
    Number.isInteger(p['width']) &&
    (p['width'] as number) > 0 &&
    Number.isInteger(p['height']) &&
    (p['height'] as number) > 0 &&
    typeof p['alt'] === 'string' &&
    p['alt'].length > 0
  );
}
