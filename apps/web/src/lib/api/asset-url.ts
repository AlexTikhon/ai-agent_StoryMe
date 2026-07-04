import { getApiBase } from './config';

const API_BASE = getApiBase();

export function resolveAssetUrl(pathOrUrl: string | null | undefined): string | null {
  if (pathOrUrl == null) return null;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  try {
    const { origin } = new URL(API_BASE);
    return `${origin}${pathOrUrl}`;
  } catch {
    return pathOrUrl;
  }
}
