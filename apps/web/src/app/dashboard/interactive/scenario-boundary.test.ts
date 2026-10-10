import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = resolve(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.|test-fixtures/.test(name) ? [path] : [];
  });
}

/**
 * The browser learns about stories only through the catalogue DTO. Scenario
 * definitions, ids and titles live on the server; none may be imported or
 * hardcoded into code that is bundled for the browser.
 */
describe('browser/server scenario boundary', () => {
  const files = sourceFiles(SRC);

  it('scans the real web sources', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('imports no API package, scenario definition or authoring module', () => {
    const offenders = files.filter((file) =>
      /from\s+['"][^'"]*(@book\/api|apps\/api|interactive\/scenarios|\.v\d+\.json|authoring)[^'"]*['"]/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('hardcodes no scenario identity or title map', () => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /warsaw-last-delivery|warsaw-last-tram|SCENARIO_TITLES|WARSAW_SCENARIO_ID/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
