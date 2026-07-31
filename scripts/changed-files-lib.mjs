import path from 'node:path';

const GENERATED_SEGMENTS = new Set([
  'node_modules',
  '.next',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  'tmp',
]);

const FORMAT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md']);
const LINT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);

export function parseNulList(output) {
  return output.split('\0').filter(Boolean);
}

function isGenerated(file) {
  return file.split(/[\\/]/u).some((segment) => GENERATED_SEGMENTS.has(segment));
}

export function selectChangedFiles(diffOutput, untrackedOutput, mode) {
  const extensions = mode === 'format' ? FORMAT_EXTENSIONS : LINT_EXTENSIONS;
  return [...new Set([...parseNulList(diffOutput), ...parseNulList(untrackedOutput)])]
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !isGenerated(file) && extensions.has(path.posix.extname(file)))
    .sort();
}
