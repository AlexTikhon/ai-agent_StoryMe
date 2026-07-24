import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.idea',
  '.next',
  '.nyc_output',
  '.pnpm-store',
  '.turbo',
  '.vscode',
  '.vitest',
  'coverage',
  'dist',
  'generated-images',
  'minio-data',
  'node_modules',
  'out',
  'tmp',
]);

const PRIVATE_DIRECTORY_NAMES = new Set([
  'artifacts',
  'child-photos',
  'database-dumps',
  'private',
  'uploads',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.7z',
  '.bak',
  '.backup',
  '.db',
  '.db3',
  '.dump',
  '.gif',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp4',
  '.pdf',
  '.png',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.webp',
  '.zip',
]);

const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function normalize(relativePath) {
  return relativePath.split(sep).join('/');
}

export function exclusionReason(relativePath) {
  const normalized = normalize(relativePath);
  const parts = normalized.split('/');
  const fileName = parts.at(-1) ?? '';
  const lowerName = fileName.toLowerCase();
  const lowerParts = parts.map((part) => part.toLowerCase());

  for (const part of lowerParts.slice(0, -1)) {
    if (EXCLUDED_DIRECTORIES.has(part)) return `excluded directory: ${part}`;
    if (PRIVATE_DIRECTORY_NAMES.has(part)) return `private-data directory: ${part}`;
  }

  if (lowerName === '.env.example') return null;
  if (lowerName === '.env' || lowerName.startsWith('.env.')) return 'environment/secret file';
  if (EXCLUDED_FILES.has(fileName)) return 'OS metadata';
  if (lowerName.endsWith('.tsbuildinfo')) return 'TypeScript build output';
  if (lowerName.endsWith('.log')) return 'log file';
  if (lowerName.startsWith('storyme-clean-')) return 'previous clean archive';
  if (EXCLUDED_EXTENSIONS.has(extname(lowerName))) return 'binary/private artifact';

  return null;
}

export function assertSafeArchiveEntries(entries) {
  for (const entry of entries) {
    const reason = exclusionReason(entry);
    if (reason) {
      throw new Error(`Refusing to include unsafe archive entry "${entry}" (${reason}).`);
    }
  }
}

export async function collectArchiveEntries(root) {
  const included = [];
  const excludedCounts = new Map();

  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, item.name);
      const relativePath = normalize(relative(root, absolutePath));
      const reason = exclusionReason(relativePath);

      if (reason) {
        excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);
        continue;
      }

      if (item.isSymbolicLink()) {
        excludedCounts.set('symbolic link', (excludedCounts.get('symbolic link') ?? 0) + 1);
        continue;
      }
      if (item.isDirectory()) {
        await walk(absolutePath);
      } else if (item.isFile()) {
        included.push(relativePath);
      }
    }
  }

  await walk(root);
  included.sort();
  assertSafeArchiveEntries(included);
  return { included, excludedCounts };
}

function archiveName(now = new Date()) {
  return `storyme-clean-${now.toISOString().replace(/[:.]/g, '-')}.tar.gz`;
}

export async function createCleanArchive(root = process.cwd()) {
  const resolvedRoot = resolve(root);
  const rootStats = await stat(resolvedRoot);
  if (!rootStats.isDirectory())
    throw new Error(`Repository root is not a directory: ${resolvedRoot}`);

  const { included, excludedCounts } = await collectArchiveEntries(resolvedRoot);
  const stagingRoot = await mkdtemp(join(tmpdir(), 'storyme-clean-archive-'));
  const stagedProject = join(stagingRoot, 'storyme');
  const outputPath = join(resolvedRoot, archiveName());

  try {
    for (const entry of included) {
      const source = join(resolvedRoot, ...entry.split('/'));
      const destination = join(stagedProject, ...entry.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }

    const result = spawnSync(
      'tar',
      ['-czf', outputPath, '-C', stagingRoot, basename(stagedProject)],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`tar failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
    }
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  return { outputPath, includedCount: included.length, excludedCounts };
}

async function main() {
  const result = await createCleanArchive();
  const excludedSummary = [...result.excludedCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  console.log(`Clean archive: ${result.outputPath}`);
  console.log(
    `Included ${result.includedCount} source, migration, test, configuration, and documentation files.`,
  );
  console.log(`Excluded: ${excludedSummary || 'none'}.`);
  console.log('No excluded file contents were read.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
