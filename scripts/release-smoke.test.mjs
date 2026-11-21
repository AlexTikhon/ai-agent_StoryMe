import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  assertOwnedProject,
  buildComposeSpec,
  createInvocation,
  createReleaseSmoke,
  DEFAULT_IMAGE,
  dockerEnvironment,
  EXIT,
  parseArguments,
  quoteShellArgument,
  recoveryCommand,
} from './release-smoke.mjs';
import {
  decodePng,
  inspectPdf,
  PUBLISHED_IMAGE_IDS,
  runReleaseJourney,
} from './release-smoke-journey.mjs';

const fixedRandom = (byte) => (size) => Buffer.alloc(size, byte);
const invocation = createInvocation(fixedRandom(0xab));

describe('ownership', () => {
  it('generates a fresh owned project name and disposable credentials per invocation', () => {
    const first = createInvocation();
    const second = createInvocation();
    assert.match(first.project, /^storyme-release-[a-f0-9]{16}$/);
    assert.notEqual(first.project, second.project);
    assert.notEqual(first.database.password, second.database.password);
    assert.equal(first.database.name, first.project.replace(/-/g, '_'));
    assert.equal(first.storage.bucket, first.project);
    for (const account of Object.values(first.accounts)) {
      assert.match(account.email, /@release-smoke\.storyme\.test$/);
    }
  });

  it('refuses every project name it did not generate', () => {
    for (const project of [
      'storyme-integration',
      'storyme-verify-0123456789abcdef',
      'storyme-release-',
      'storyme-release-0123456789ABCDEF',
      'storyme',
      undefined,
    ]) {
      assert.throws(() => assertOwnedProject(project), /does not own/);
    }
    assert.throws(
      () => buildComposeSpec({ ...invocation, project: 'storyme-integration' }, 'img'),
      /does not own/,
    );
  });
});

describe('compose spec', () => {
  const spec = buildComposeSpec(invocation, 'storyme-api:test');
  const { api, worker, tools } = spec.services;

  it('publishes only the API, on loopback', () => {
    assert.deepEqual(api.ports, ['127.0.0.1::4000']);
    for (const [name, service] of Object.entries(spec.services)) {
      if (name !== 'api') assert.equal(service.ports, undefined, name);
    }
  });

  it('mounts no host paths and never interpolates', () => {
    for (const [name, service] of Object.entries(spec.services)) {
      assert.equal(service.volumes, undefined, name);
    }
    assert.equal(JSON.stringify(spec).includes('$'), false);
    assert.equal(spec.name, invocation.project);
  });

  it('runs API and worker from the same image with their compiled entrypoints', () => {
    assert.equal(api.image, 'storyme-api:test');
    assert.equal(worker.image, 'storyme-api:test');
    assert.deepEqual(api.command, ['node', 'dist/main']);
    assert.deepEqual(worker.command, ['node', 'dist/worker']);
    assert.equal(api.healthcheck, undefined, "API keeps the image's own healthcheck");
    assert.deepEqual(worker.healthcheck, { disable: true });
    assert.deepEqual(tools.profiles, ['tools']);
  });

  it('keeps the production runtime, mock providers and s3 storage for both artifact kinds', () => {
    for (const environment of [api.environment, worker.environment]) {
      assert.equal(environment.NODE_ENV, 'production');
      assert.equal(environment.AUTH_MODE, 'jwt');
      assert.equal(environment.PRODUCT_MODE, 'home');
      assert.equal(environment.STRIPE_BILLING_ENABLED, 'false');
      assert.equal(environment.RUN_PAID_AI_EVALS, 'false');
      assert.equal(environment.MOCK_FAILURES_ENABLED, 'false');
      for (const key of [
        'STORY_GENERATION_PROVIDER',
        'CHARACTER_PROFILE_PROVIDER',
        'IMAGE_GENERATION_PROVIDER',
      ]) {
        assert.equal(environment[key], 'mock', key);
      }
      assert.equal(environment.PDF_STORAGE_DRIVER, 's3');
      assert.equal(environment.IMAGE_STORAGE_DRIVER, 's3');
      assert.equal(environment.PDF_STORAGE_BUCKET, invocation.storage.bucket);
      assert.match(
        environment.DATABASE_URL,
        new RegExp(`@postgres:5432/${invocation.database.name}$`),
      );
      assert.equal(environment.OPENAI_API_KEY, undefined);
    }
    assert.equal(api.environment.ENABLE_GENERATION_WORKER, 'false');
  });
});

describe('docker environment', () => {
  it('passes only what the Docker CLI needs', () => {
    const env = dockerEnvironment({
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      DOCKER_HOST: 'npipe:////./pipe/docker_engine',
      OPENAI_API_KEY: 'sk-real',
      AWS_ACCESS_KEY_ID: 'AKIA',
      PDF_STORAGE_SECRET_ACCESS_KEY: 'secret',
      DATABASE_URL: 'postgresql://prod',
      COMPOSE_PROJECT_NAME: 'storyme-integration',
      COMPOSE_FILE: 'docker-compose.yml',
    });
    assert.deepEqual(Object.keys(env).sort(), ['DOCKER_HOST', 'Path', 'SystemRoot']);
  });
});

describe('arguments', () => {
  it('accepts an optional image and rejects anything else', () => {
    assert.deepEqual(parseArguments([]), { image: undefined });
    assert.deepEqual(parseArguments(['--', '--image', 'storyme-api:ci']), {
      image: 'storyme-api:ci',
    });
    assert.deepEqual(parseArguments(['--image=storyme-api:ci']), { image: 'storyme-api:ci' });
    assert.throws(() => parseArguments(['--keep']), /Unknown argument/);
    assert.throws(() => parseArguments(['--image']), /requires an image/);
    assert.throws(() => parseArguments(['--image', 'a', '--image', 'b']), /only once/);
  });
});

// ─── Lifecycle with a scripted Docker ────────────────────────────────────────

const ok = (stdout = '') => ({ status: 0, signal: null, stdout, stderr: '' });

function scriptedDocker(overrides = []) {
  const calls = [];
  const execute = async (command, args, options) => {
    const line = command === 'docker' ? args.join(' ') : `node ${args.join(' ')}`;
    calls.push({ line, args, options });
    for (const [pattern, respond] of overrides) {
      if (line.includes(pattern)) return respond(args, options);
    }
    if (line.includes('current_database')) {
      const { name, role } = invocation.database;
      return ok(JSON.stringify({ database: name, role, tables: 0 }));
    }
    if (line.includes('migrate deploy'))
      return ok('All migrations have been successfully applied.');
    if (line.includes('ListObjectsV2Command')) {
      return ok(JSON.stringify(['books/book-1/cover.png', 'previews/book-1/preview.pdf']));
    }
    if (line.includes(' port api 4000')) return ok('127.0.0.1:55555\n');
    if (line.includes(' ps -q api')) return ok('container-api\n');
    if (line.startsWith('inspect')) {
      return ok(
        JSON.stringify({
          Mounts: [],
          Config: { Healthcheck: { Test: ['CMD-SHELL', 'node -e … /api/health'] } },
          HostConfig: {
            PortBindings: { '4000/tcp': [{ HostIp: '127.0.0.1', HostPort: '55555' }] },
          },
        }),
      );
    }
    if (line.includes('exec -T api node')) {
      return ok(
        JSON.stringify({
          uid: 1001,
          cmd: ['node', 'dist/main'],
          nodeEnv: 'production',
          worker: 'false',
        }),
      );
    }
    return ok();
  };
  return { calls, execute };
}

// A Windows temp directory containing a space, as os.tmpdir() returns for many profiles.
const SPEC_DIRECTORY = `C:\\Users\\Release Tester\\AppData\\Local\\Temp\\${invocation.project}-a1B2c3`;
const COMPOSE_FILE = `${SPEC_DIRECTORY}\\compose.json`;

function smokeWith({
  overrides,
  journey,
  onJourney,
  removeSpec,
  specDirectory = SPEC_DIRECTORY,
  platform = 'win32',
} = {}) {
  const docker = scriptedDocker(overrides);
  const removed = [];
  const output = [];
  const smoke = createReleaseSmoke({
    invocation,
    env: {},
    platform,
    execute: docker.execute,
    probeHealth: async () => true,
    writeSpec: () => specDirectory,
    removeSpec: (directory) => (removeSpec ? removeSpec(directory) : removed.push(directory)),
    sleep: async () => {},
    log: (message) => output.push(message),
    logError: (message) => output.push(message),
    journey:
      journey ??
      (async (context) => {
        await onJourney?.(context);
        return { bookId: 'book-1', artifacts: { cover: {}, pdf: {} } };
      }),
  });
  return { smoke, docker, removed, output: () => output.join('\n') };
}

const composeCalls = (calls) =>
  calls.filter((call) => call.args[0] === 'compose' && call.args[1] === '-p');

describe('lifecycle', () => {
  it('builds by default, cleans up its own project, and passes', async () => {
    const { smoke, docker, removed, output } = smokeWith();
    assert.equal(await smoke.run([]), 0);
    assert.ok(
      docker.calls.some(
        (call) => call.line === `build -f apps/api/Dockerfile -t ${DEFAULT_IMAGE} .`,
      ),
    );
    for (const call of composeCalls(docker.calls)) assert.equal(call.args[2], invocation.project);
    const down = docker.calls.filter((call) => call.line.includes(' down '));
    assert.equal(down.length, 1);
    assert.match(down[0].line, /down --volumes --remove-orphans/);
    assert.deepEqual(removed, [SPEC_DIRECTORY]);
    assert.match(output(), /Result: PASS/);
    assert.match(output(), /real AWS S3 \/ Cloudflare R2/);
  });

  it('reuses a provided image without building', async () => {
    const { smoke, docker } = smokeWith();
    assert.equal(await smoke.run(['--image', 'storyme-api:ci']), 0);
    assert.equal(
      docker.calls.some((call) => call.args[0] === 'build'),
      false,
    );
    assert.ok(
      docker.calls.some((call) => call.line === 'node scripts/api-image-smoke.mjs storyme-api:ci'),
    );
  });

  it('runs migrations before starting any application container', async () => {
    const { smoke, docker } = smokeWith();
    await smoke.run([]);
    const index = (pattern) => docker.calls.findIndex((call) => call.line.includes(pattern));
    assert.ok(index('current_database') < index('migrate deploy'));
    assert.ok(index('migrate deploy') < index('up -d --no-deps api'));
  });

  it('reports unavailable Docker separately and starts nothing', async () => {
    const { smoke, docker, removed, output } = smokeWith({
      overrides: [
        ['version --format', () => ({ status: null, error: new Error('spawn docker ENOENT') })],
      ],
    });
    assert.equal(await smoke.run([]), EXIT.unavailable);
    assert.equal(docker.calls.length, 1);
    assert.deepEqual(removed, []);
    assert.match(output(), /UNAVAILABLE/);
    assert.match(output(), /nothing was started/i);
  });

  it('rejects bad arguments before running anything', async () => {
    const { smoke, docker } = smokeWith();
    assert.equal(await smoke.run(['--bogus']), EXIT.usage);
    assert.equal(docker.calls.length, 0);
  });

  it('collects bounded diagnostics, then tears down, when the journey fails', async () => {
    const { smoke, docker, removed, output } = smokeWith({
      journey: async () => {
        throw new Error('generation ended failed');
      },
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    const logs = docker.calls.findIndex((call) =>
      call.line.includes(' logs --no-color --timestamps --tail 80'),
    );
    const down = docker.calls.findIndex((call) => call.line.includes(' down --volumes'));
    assert.ok(logs > 0 && down > logs);
    assert.deepEqual(removed, [SPEC_DIRECTORY]);
    assert.match(output(), /FAIL .*Book journey/);
    assert.match(output(), /NOT RUN .*Artifacts stored in S3/);
  });

  it('refuses to migrate when DATABASE_URL reaches another database', async () => {
    const { smoke, docker } = smokeWith({
      overrides: [
        [
          'current_database',
          () => ok(JSON.stringify({ database: 'storyme', role: 'postgres', tables: 0 })),
        ],
      ],
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.equal(
      docker.calls.some((call) => call.line.includes('migrate deploy')),
      false,
    );
    assert.ok(docker.calls.some((call) => call.line.includes(' down --volumes')));
  });

  it('still tears down after an interruption and skips diagnostics', async () => {
    let smokeRef;
    const { smoke, docker, removed, output } = smokeWith({
      onJourney: async () => {
        smokeRef.cancel('SIGINT');
        throw new Error('fetch aborted');
      },
    });
    smokeRef = smoke;
    const status = await smoke.run([]);
    assert.equal(status, 130);
    assert.equal(
      docker.calls.some((call) => call.line.includes(' logs --no-color --timestamps')),
      false,
    );
    assert.ok(docker.calls.some((call) => call.line.includes(' down --volumes')));
    assert.deepEqual(removed, [SPEC_DIRECTORY]);
    assert.match(output(), /CANCELLED by SIGINT/);
  });
});

// ─── Cleanup verification and recovery ───────────────────────────────────────

/** Overrides that answer `compose down` and the post-teardown enumeration as scripted. */
function teardown({ down = () => ok(), enumerate = () => ok() } = {}) {
  let downDone = false;
  const listing = (kind) => () => (downDone ? enumerate(kind) : ok());
  return [
    [' down --volumes', (...args) => ((downDone = true), down(...args))],
    ['ps -a -q --filter', listing('container')],
    ['network ls -q --filter', listing('network')],
    ['volume ls -q --filter', listing('volume')],
  ];
}

const windowsRecovery =
  `docker compose -p ${invocation.project} -f "${COMPOSE_FILE}" ` +
  'down --volumes --remove-orphans';

function assertRetained({ removed, output }) {
  assert.deepEqual(removed, [], 'the generated Compose directory must be kept');
  const text = output();
  assert.match(text, /Cleanup INCOMPLETE: /);
  assert.ok(text.includes(`\n    ${COMPOSE_FILE}\n`), 'prints the kept absolute compose.json path');
  assert.ok(text.includes(windowsRecovery), 'prints a recovery command with -p and a quoted -f');
  assert.ok(text.includes(`docker volume ls -q --filter label=com.docker.compose.project=`));
  assert.match(text, /Only after that teardown succeeds and nothing remains, delete the kept/);
  assert.ok(text.includes(`"${SPEC_DIRECTORY}"`), 'names the kept directory, quoted');
}

describe('cleanup and recovery', () => {
  it('removes the generated directory only after a verified teardown', async () => {
    const { smoke, docker, removed, output } = smokeWith();
    assert.equal(await smoke.run([]), 0);
    const down = docker.calls.findIndex((call) => call.line.includes(' down --volumes'));
    const lastListing = docker.calls.findLastIndex((call) => call.line.startsWith('volume ls'));
    assert.ok(down > 0 && lastListing > down, 'enumerates after compose down');
    assert.deepEqual(removed, [SPEC_DIRECTORY]);
    assert.match(output(), /labelled storyme-release-[a-f0-9]{16}, and the generated Compose dir/);
    assert.equal(output().includes('Recover with'), false);
  });

  it('every compose call names the generated file explicitly', async () => {
    const { smoke, docker } = smokeWith();
    await smoke.run([]);
    for (const call of composeCalls(docker.calls)) {
      assert.deepEqual(call.args.slice(2, 5), [invocation.project, '-f', COMPOSE_FILE]);
    }
  });

  it('keeps the directory when compose down fails, even if nothing is listed afterwards', async () => {
    const { smoke, removed, output } = smokeWith({
      overrides: teardown({
        down: () => ({ status: 1, signal: null, stdout: '', stderr: 'daemon error' }),
      }),
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.match(output(), /Cleanup INCOMPLETE: compose down exit 1: daemon error/);
    assertRetained({ removed, output });
  });

  it('keeps the directory when compose down times out', async () => {
    const { smoke, removed, output } = smokeWith({
      overrides: teardown({
        down: () => ({
          status: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          timeoutMs: 180_000,
        }),
      }),
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.match(output(), /compose down timed out after 180s/);
    assertRetained({ removed, output });
  });

  it('keeps the directory when resources survive teardown', async () => {
    const { smoke, removed, output } = smokeWith({
      overrides: teardown({
        enumerate: (kind) => ok(kind === 'volume' ? 'leftover-volume\n' : ''),
      }),
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.match(output(), /Cleanup INCOMPLETE: still present: volume leftover-vol/);
    assertRetained({ removed, output });
  });

  it('keeps the directory when the leftover enumeration itself fails', async () => {
    const { smoke, removed, output } = smokeWith({
      overrides: teardown({
        enumerate: (kind) =>
          kind === 'network'
            ? { status: 1, signal: null, stdout: '', stderr: 'cannot connect' }
            : ok(),
      }),
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.match(output(), /could not list leftovers: docker network ls: exit 1/);
    assertRetained({ removed, output });
  });

  it('keeps the directory when an interrupted run is interrupted again during teardown', async () => {
    let smokeRef;
    const { smoke, removed, output } = smokeWith({
      onJourney: async () => {
        smokeRef.cancel('SIGINT');
        throw new Error('fetch aborted');
      },
      overrides: teardown({
        // A repeated Ctrl+C reaches the Docker child directly and kills `compose down`.
        down: () => (
          smokeRef.cancel('SIGINT'),
          { status: null, signal: 'SIGINT', stdout: '', stderr: '' }
        ),
      }),
    });
    smokeRef = smoke;
    assert.equal(await smoke.run([]), 130);
    assert.match(output(), /Cleanup already in progress/);
    assert.match(output(), /compose down signal SIGINT/);
    assert.match(output(), /CANCELLED by SIGINT \(exit 130\)/);
    assertRetained({ removed, output });
  });

  it('keeps the directory when cleanup crashes before verification', async () => {
    const { smoke, removed, output } = smokeWith({
      overrides: [
        [
          ' down --volumes',
          () => {
            throw new Error('spawn EPERM');
          },
        ],
      ],
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.match(output(), /Cleanup INCOMPLETE: cleanup crashed: spawn EPERM/);
    assertRetained({ removed, output });
  });

  it('fails without a recovery command when only deleting the verified directory fails', async () => {
    const { smoke, output } = smokeWith({
      removeSpec: () => {
        throw new Error('EBUSY');
      },
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.match(output(), /removed every container, network and volume labelled .*\.\n/);
    assert.match(output(), /could not remove .*Release Tester.*: EBUSY/);
    assert.match(output(), /delete it manually/);
    assert.equal(output().includes('Recover with'), false);
  });

  it('quotes a POSIX temp path with spaces and an apostrophe', async () => {
    const specDirectory = `/tmp/Release Tester's tmp/${invocation.project}-a1B2c3`;
    const { smoke, removed, output } = smokeWith({
      platform: 'linux',
      specDirectory,
      overrides: teardown({ down: () => ({ status: 1, signal: null, stdout: '', stderr: '' }) }),
    });
    assert.equal(await smoke.run([]), EXIT.fail);
    assert.deepEqual(removed, []);
    assert.ok(output().includes(`\n    ${specDirectory}/compose.json\n`));
    assert.ok(
      output().includes(
        `docker compose -p ${invocation.project} -f ` +
          `'/tmp/Release Tester'\\''s tmp/${invocation.project}-a1B2c3/compose.json' ` +
          'down --volumes --remove-orphans',
      ),
    );
  });

  it('builds recovery commands only for owned projects', () => {
    assert.equal(
      recoveryCommand(invocation.project, 'C:\\Temp Dir\\compose.json', 'win32'),
      `docker compose -p ${invocation.project} -f "C:\\Temp Dir\\compose.json" down --volumes --remove-orphans`,
    );
    assert.throws(() => recoveryCommand('storyme', '/tmp/compose.json', 'linux'), /does not own/);
    assert.equal(quoteShellArgument('/a b/c', 'darwin'), "'/a b/c'");
    assert.equal(quoteShellArgument('C:\\a b', 'win32'), '"C:\\a b"');
  });
});

// ─── Artifact validators ─────────────────────────────────────────────────────

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width, height, rows = Buffer.alloc(height * (1 + width * 3))) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('decodePng', () => {
  it('decodes a well-formed RGB PNG', () => {
    assert.deepEqual(decodePng(png(8, 8)), { format: 'png', width: 8, height: 8 });
  });

  it('rejects corrupt chunks, short data and non-PNG bytes', () => {
    const corrupt = png(8, 8);
    corrupt[corrupt.length - 20] ^= 0xff;
    assert.throws(() => decodePng(corrupt), /CRC mismatch|inflate/);
    assert.throws(() => decodePng(png(8, 8, Buffer.alloc(8 * 20))), /shorter|length/);
    assert.throws(() => decodePng(Buffer.from('%PDF-1.3')), /not a PNG/);
  });
});

function pdf({ pages, fonts = 1 }) {
  const image = deflateSync(Buffer.alloc(16));
  const parts = [
    '%PDF-1.3\n',
    `1 0 obj\n<<\n/Type /Pages\n/Count ${pages}\n/Kids []\n>>\nendobj\n`,
  ];
  for (let i = 0; i < pages; i++)
    parts.push(`${10 + i} 0 obj\n<<\n/Type /Page\n/Parent 1 0 R\n>>\nendobj\n`);
  for (let i = 0; i < fonts; i++)
    parts.push(`${30 + i} 0 obj\n<<\n/Length 1\n/FontFile2 2 0 R\n>>\nendobj\n`);
  const head = Buffer.from(
    parts.join('') +
      `40 0 obj\n<<\n/Type /XObject\n/Subtype /Image\n/Filter /FlateDecode\n/Length ${image.length}\n>>\nstream\n`,
    'latin1',
  );
  return Buffer.concat([
    head,
    image,
    Buffer.from('\nendstream\nendobj\nstartxref\n123\n%%EOF\n', 'latin1'),
  ]);
}

describe('inspectPdf', () => {
  it('counts pages, embedded fonts and decodable images', () => {
    const result = inspectPdf(pdf({ pages: 6 }));
    assert.equal(result.pageObjects, 6);
    assert.equal(result.pageTreeCount, 6);
    assert.equal(result.embeddedFonts, 1);
    assert.equal(result.images, 1);
    assert.equal(result.decodedImages, 1);
  });

  it('rejects non-PDF bytes and a missing trailer', () => {
    assert.throws(() => inspectPdf(png(1, 1)), /not a PDF/);
    assert.throws(() => inspectPdf(Buffer.from('%PDF-1.3\n1 0 obj\n')), /trailer/);
  });
});

describe('journey gate', () => {
  it('never schedules generation unless the server estimate reports mock providers', async () => {
    const requests = [];
    const respond = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    let logins = 0;
    const fetchStub = async (url, init) => {
      const path = new URL(url).pathname.replace('/api', '');
      requests.push(`${init.method} ${path}`);
      if (path === '/auth/register') return respond(201, {});
      if (path === '/auth/login') {
        logins++;
        return logins === 1
          ? respond(401, { code: 'EMAIL_NOT_VERIFIED' })
          : respond(200, { accessToken: `token-${logins}` });
      }
      if (path === '/books') return respond(201, { id: 'book-1' });
      if (path.endsWith('/generation-estimate')) return respond(200, { providerMode: 'real' });
      return respond(500, {});
    };
    const infra = {
      apiBaseUrl: async () => 'http://127.0.0.1:1/api',
      markAccountsVerified: async (emails) => emails,
    };
    await assert.rejects(
      runReleaseJourney({ infra, accounts: invocation.accounts, log: () => {}, fetch: fetchStub }),
      /providerMode is real, not "mock"/,
    );
    assert.equal(
      requests.some((request) => request.endsWith('/generate')),
      false,
    );
  });

  it('expects the cover, every page illustration and the back cover', () => {
    assert.deepEqual(PUBLISHED_IMAGE_IDS, [
      'cover',
      'page-1',
      'page-2',
      'page-3',
      'page-4',
      'back-cover',
    ]);
  });
});
