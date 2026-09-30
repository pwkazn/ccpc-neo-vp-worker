/**
 * Cache and timeline integration tests.
 *
 * Verifies the on-disk cache round-trips the wire timeline byte-for-byte and
 * that the built timeline stays deterministic, which is what makes the disk
 * cache and the e2e regression meaningful.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCache } from '../server/cache.mjs';
import { buildTimeline, WIRE_VERSION } from '../server/build-timeline.mjs';
import { createStaticServer } from '../server/assets.mjs';
import { parseArgs, HELP } from '../server/index.mjs';

const fixtureUrl = new URL('./fixtures/exact.srk.json', import.meta.url);

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ccpc-neo-vp-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('cache round-trips a timeline and reports stats', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dataDir: dir });
    await cache.init();

    const ranklist = JSON.parse(await readFile(fixtureUrl, 'utf8'));
    const timeline = buildTimeline(ranklist, { uk: 'fixture', srkHash: 'hash-1' });

    assert.equal(await cache.readTimeline('hash-1'), null);
    await cache.writeTimeline('hash-1', timeline);

    const stored = await cache.readTimeline('hash-1');
    assert.deepEqual(stored, timeline, 'the stored timeline is identical');

    const stats = await cache.stats();
    assert.equal(stats.timeline.files, 1);
    assert.ok(stats.timeline.bytes > 0);
  });
});

test('cache isolates SRK and timeline namespaces', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dataDir: dir });
    await cache.init();
    const ranklist = JSON.parse(await readFile(fixtureUrl, 'utf8'));

    await cache.writeSrk('same-hash', ranklist);
    await cache.writeTimeline('same-hash', { version: WIRE_VERSION, marker: true });

    assert.deepEqual(await cache.readSrk('same-hash'), ranklist);
    assert.deepEqual(await cache.readTimeline('same-hash'), { version: WIRE_VERSION, marker: true });
  });
});

test('cache sanitises hashes so they cannot escape the data dir', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dataDir: dir });
    await cache.init();
    await cache.writeTimeline('../../evil', { version: WIRE_VERSION });
    const stats = await cache.stats();
    assert.equal(stats.timeline.files, 1, 'the file landed inside the timeline dir');
    const stored = await cache.readTimeline('../../evil');
    assert.deepEqual(stored, { version: WIRE_VERSION });
  });
});

test('cache survives a corrupt entry by returning null', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dataDir: dir });
    await cache.init();
    await writeFile(path.join(dir, 'timeline', 'broken.json'), '{not json', 'utf8');
    assert.equal(await cache.readTimeline('broken'), null);
  });
});

test('cache.clear empties the store', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dataDir: dir });
    await cache.init();
    await cache.writeTimeline('h', { version: WIRE_VERSION });
    await cache.clear();
    assert.equal(await cache.readTimeline('h'), null);
    const stats = await cache.stats();
    assert.equal(stats.timeline.files, 0);
  });
});

test('contests cache round-trips with a fetch timestamp', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dataDir: dir });
    await cache.init();
    const contests = [{ uk: 'a', name: 'A' }];
    await cache.writeContests(contests);
    const record = await cache.readContests();
    assert.deepEqual(record.contests, contests);
    assert.ok(typeof record.fetchedAt === 'number' && record.fetchedAt > 0);
  });
});

test('static server refuses traversal and unmatched prefixes', async () => {
  const assets = createStaticServer();
  const respond = (pathname) => {
    const calls = [];
    const res = {
      writeHead: (status, headers) => calls.push({ status, headers }),
      end: () => {},
    };
    return assets.serve({ method: 'GET', headers: {} }, res, pathname).then((served) => ({ served, calls }));
  };

  assert.equal((await respond('/app/../package.json')).served, false);
  assert.equal((await respond('/shared/../../etc/passwd')).served, false);
  assert.equal((await respond('/app/')).served, false);
  assert.equal((await respond('/etc/passwd')).served, false);
  assert.equal((await respond('/app/app.mjs')).served, true);
  assert.equal((await respond('/shared/rules.mjs')).served, true);
  assert.equal((await respond('/app/does-not-exist.mjs')).served, false);
});

test('parseArgs reads flags, positionals and defaults', () => {
  const parsed = parseArgs(['--port', '4321', '--host', '0.0.0.0', '--data-dir', '/tmp/x']);
  assert.equal(parsed.port, 4321);
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.dataDir, '/tmp/x');
  assert.equal(parsed.help, false);

  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--clear-cache']).clearCache, true);
  assert.equal(parseArgs(['--cache-info']).cacheInfo, true);

  const defaults = parseArgs([]);
  assert.equal(defaults.port, 5173);
  assert.equal(defaults.host, '127.0.0.1');
  assert.ok(HELP.includes('--port'));
});

test('parseArgs rejects bad input', () => {
  assert.throws(() => parseArgs(['--port', 'abc']), /端口/);
  assert.throws(() => parseArgs(['--port', '70000']), /端口/);
  assert.throws(() => parseArgs(['--port']), /缺少参数/);
  assert.throws(() => parseArgs(['--nope']), /未知选项/);
});

test('buildTimeline stays deterministic across repeated builds', async () => {
  const ranklist = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const meta = { uk: 'fixture', name: 'Fixture', srkHash: 'h', generatedAt: 42 };
  const hashes = new Set();
  for (let i = 0; i < 5; i++) {
    hashes.add(JSON.stringify(buildTimeline(ranklist, meta)));
  }
  assert.equal(hashes.size, 1, 'five builds produce identical output');
});
