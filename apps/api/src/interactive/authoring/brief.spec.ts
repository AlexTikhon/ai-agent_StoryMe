import { describe, expect, it } from 'vitest';
import { hashBrief, parseBrief } from './brief';
import { LAST_TRAM_BRIEF } from './the-last-tram';

const brief = () =>
  structuredClone(LAST_TRAM_BRIEF) as unknown as Record<string, unknown> & {
    characters: Array<Record<string, unknown>>;
    endings: Array<Record<string, unknown>>;
  };

const issues = (raw: unknown) => {
  const result = parseBrief(raw);
  return result.ok ? [] : result.issues;
};

describe('parseBrief', () => {
  it('accepts the original fictional brief and hashes it stably', () => {
    const parsed = parseBrief(LAST_TRAM_BRIEF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(hashBrief(parsed.brief)).toBe(hashBrief(structuredClone(parsed.brief)));
    expect(hashBrief(parsed.brief)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires exactly three characters, exactly one of them the player', () => {
    const two = brief();
    two.characters.pop();
    expect(issues(two).join()).toContain('characters');
    const twoPlayers = brief();
    twoPlayers.characters[1]!['isPlayer'] = true;
    expect(issues(twoPlayers).join()).toContain('exactly one character must be the player');
    const noPlayer = brief();
    noPlayer.characters[0]!['isPlayer'] = false;
    expect(issues(noPlayer).length).toBeGreaterThan(0);
  });

  it('requires exactly two endings with distinct ids', () => {
    const three = brief();
    three.endings.push({ ...three.endings[0]!, id: 'third' });
    expect(issues(three).join()).toContain('endings');
    const dup = brief();
    dup.endings[1]!['id'] = dup.endings[0]!['id'];
    expect(issues(dup).join()).toContain('duplicate ending id');
  });

  it('rejects unknown fields, bad identifiers and out-of-range versions', () => {
    expect(issues({ ...brief(), extra: 1 }).length).toBeGreaterThan(0);
    expect(issues({ ...brief(), scenarioId: 'Not Kebab' }).length).toBeGreaterThan(0);
    expect(issues({ ...brief(), version: 0 }).length).toBeGreaterThan(0);
  });

  it('rejects non-Latin text and control characters without echoing them', () => {
    const cyrillic = {
      ...brief(),
      premise: 'Последний трамвай ночью в Варшаве идёт без остановок.',
    };
    const out = issues(cyrillic);
    expect(out.join()).toContain('English');
    expect(out.join()).not.toContain('Последний');
    expect(issues({ ...brief(), tone: 'calm\u0000tone' }).length).toBeGreaterThan(0);
  });

  it('bounds the brief size and rejects non-JSON values', () => {
    const big = brief();
    for (const c of big.characters) c['description'] = 'a'.repeat(300);
    big['premise'] = 'b'.repeat(600);
    // Within per-field limits, so size alone cannot be exceeded legitimately;
    // an oversized payload has to come from an unknown/oversized field and is refused.
    expect(issues({ ...big, padding: 'p'.repeat(9000) }).join()).toContain('exceeds');
    expect(issues({ self: undefined })).not.toEqual([]);
    expect(issues(BigInt(1) as unknown)).not.toEqual([]);
  });
});
