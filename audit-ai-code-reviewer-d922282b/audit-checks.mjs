import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { truncatePatch } from './ai-code-reviewer/.test-dist/src/review/patch.js';
import { parseArgs } from './ai-code-reviewer/.test-dist/src/cli/args.js';
import { isIgnoredPath, parseIgnoreFile } from './ai-code-reviewer/.test-dist/src/review/ignore.js';
import { classifyFile } from './ai-code-reviewer/.test-dist/src/review/file-classifier.js';
import { filterFilesNode } from './ai-code-reviewer/.test-dist/src/graph/nodes/filter-files.node.js';
import { countLines, parseNameStatus } from './ai-code-reviewer/.test-dist/src/review-sources/local/local.js';
import { finalizeNode } from './ai-code-reviewer/.test-dist/src/graph/nodes/finalize.node.js';

const patch = '@@ -0,0 +1 @@\n+' + 'x'.repeat(100000);
const truncated = truncatePatch(patch);
assert.ok(truncated.length > 100000);
console.log('CONFIRMED: 100,000-character first hunk passes the 15,000-character limit; output length=' + truncated.length);

const filtered = await filterFilesNode({files: [{filename: '.env', patch: '@@ -0,0 +1 @@\n+SYNTHETIC_SECRET=example'}]});
assert.equal(filtered.filteredFiles[0].filename, '.env');
console.log('CONFIRMED: .env is classified as config and accepted for model review. Synthetic input only.');

for (const [pattern, name] of [['**/*.snap', 'root.snap'], ['dist/', 'packages/a/dist/app.ts'], ['node_modules', 'node_modules/pkg/index.ts'], ['/private/', 'private/key.ts']]) {
  assert.equal(isIgnoredPath(name, parseIgnoreFile(pattern)), false);
  console.log('CONFIRMED: ignore pattern ' + JSON.stringify(pattern) + ' fails to exclude ' + JSON.stringify(name));
}

assert.equal(parseArgs(['--local', '--base', '--repo', 'somewhere']).localBaseRef, '--repo');
assert.equal(parseArgs(['o', 'r', 'Infinity']).pullNumber, Infinity);
console.log('CONFIRMED: --base consumes --repo as its value; Infinity accepted as PR number.');
assert.equal(classifyFile('src/tests/.env.production'), 'test');
assert.equal(classifyFile('tests/test_user.py'), 'source');
assert.equal(classifyFile('src/user_test.go'), 'source');
console.log('CONFIRMED: test directory classification overrides secret-looking filename; Python/Go test naming is not recognized.');

assert.equal(countLines('a\n'), 2);
const quoted = parseNameStatus('M\t"src/\\303\\251.ts"\n')[0].filename;
assert.ok(quoted.startsWith('"'));
assert.equal(classifyFile(quoted), 'unknown');
console.log('CONFIRMED: trailing newline creates an extra synthetic added line; quoted Git filenames remain quoted and can be skipped.');

const result = await finalizeNode({errors: ['fetch failed'], files: [], findings: []});
assert.match(result.summary, /Review completed/);
assert.match(result.summary, /No meaningful issues found/);
console.log('CONFIRMED: finalize reports review completed/no issues even when fetching failed.');

const cliUrl = new URL('./ai-code-reviewer/.test-dist/src/cli.js', import.meta.url).href;
const missingRepo = fileURLToPath(new URL('./does-not-exist', import.meta.url));
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `globalThis.fetch=async()=>{throw new Error('Audit blocks all network calls')};process.argv=['node','cli','--local','--repo',${JSON.stringify(missingRepo)}];await import(${JSON.stringify(cliUrl)});`], {
  cwd: fileURLToPath(new URL('./ai-code-reviewer/', import.meta.url)),
  env: {...process.env, OPENAI_API_KEY:'audit-placeholder-no-network', LANGCHAIN_TRACING:'false', LANGCHAIN_TRACING_V2:'false', LANGSMITH_TRACING:'false'},
  encoding:'utf8', timeout:15000
});
assert.equal(child.status, 0, child.stderr);
assert.match(child.stderr, /ENOENT/);
assert.match(child.stdout, /Review completed/);
console.log('CONFIRMED END-TO-END: CLI on nonexistent repository logs ENOENT, reports Review completed, exits 0. All fetch calls disabled.');
