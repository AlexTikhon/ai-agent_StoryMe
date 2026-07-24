import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const target = resolve(root, 'apps', 'api', 'tmp');
const apply = process.argv.slice(2).includes('--apply');

if (relative(root, target).startsWith('..')) {
  throw new Error('Refusing to inspect a cleanup target outside the repository.');
}

async function countFiles(directory) {
  let count = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) count += await countFiles(join(directory, item.name));
    else if (item.isFile()) count += 1;
  }
  return count;
}

let fileCount = 0;
try {
  if (!(await stat(target)).isDirectory()) throw new Error('not a directory');
  fileCount = await countFiles(target);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.log('No local StoryMe artifact directory exists; nothing to clean.');
    process.exit(0);
  }
  throw error;
}

if (!apply) {
  console.log(`Dry run: would remove ${fileCount} file(s) under apps/api/tmp.`);
  console.log('Nothing was deleted. Re-run with --apply to confirm this exact cleanup scope.');
} else {
  await rm(target, { recursive: true, force: false });
  console.log(
    `Removed apps/api/tmp (${fileCount} file(s)). This local deletion is not recoverable by StoryMe.`,
  );
}
