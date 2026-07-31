import { spawnSync } from 'node:child_process';
import { selectChangedFiles } from './changed-files-lib.mjs';

const mode = process.argv[2];
if (mode !== 'format' && mode !== 'lint') {
  throw new Error('Usage: changed-files.mjs <format|lint> [--base <git-ref>]');
}

const separator = process.argv.indexOf('--');
const args = process.argv.slice(3).filter((arg, index, all) => {
  if (arg === '--') return false;
  return separator < 0 || index + 3 !== separator;
});
const baseIndex = args.indexOf('--base');
const base =
  (baseIndex >= 0 ? args[baseIndex + 1] : undefined) ?? process.env['CHANGED_FILES_BASE'] ?? 'HEAD';
if (!base || (baseIndex >= 0 && !args[baseIndex + 1])) {
  throw new Error('--base requires a Git ref.');
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

run('git', ['rev-parse', '--verify', `${base}^{commit}`]);
const diff = run('git', [
  'diff',
  '--name-only',
  '-z',
  '--find-renames',
  '--diff-filter=ACMR',
  base,
  '--',
]);
const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z']);
const files = selectChangedFiles(diff, untracked, mode);

if (files.length === 0) {
  console.log(`No changed ${mode === 'format' ? 'formattable' : 'lintable'} files.`);
  process.exit(0);
}

const pnpmCli = process.env['npm_execpath'];
if (!pnpmCli) throw new Error('Run this command through pnpm so its CLI can be located safely.');
const toolArgs =
  mode === 'format'
    ? ['prettier', '--check', ...files]
    : ['eslint', '--max-warnings', '0', ...files];
console.log(`${mode === 'format' ? 'Formatting' : 'Linting'} ${files.length} changed file(s).`);
const result = spawnSync(process.execPath, [pnpmCli, 'exec', ...toolArgs], {
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
