import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createSession, PHASE, SPEEDS } from '../shared/live.mjs';
import { formatClock } from '../shared/replay.mjs';
import { buildTimeline } from '../server/build-timeline.mjs';

const source = (await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');
const timeline = buildTimeline(JSON.parse(await readFile(new URL('./fixtures/exact.srk.json', import.meta.url))));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function boot(search) {
  const nodes = new Map();
  function node() {
    return {
      value: '', checked: true, hidden: true, textContent: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {},
    };
  }
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  get('freeze-minutes').value = '60';
  const requests = [];
  let resolveTimeline;
  let painted;
  const context = vm.createContext({
    createSession, PHASE, SPEEDS, formatClock, URLSearchParams,
    createBoard: () => ({ setPinnedTeam() {}, render(frame) { painted = frame; } }),
    document: { getElementById: get, querySelectorAll: () => [], addEventListener() {}, createElement: node },
    window: { addEventListener() {} },
    location: { search, pathname: '/' }, history: { replaceState() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch(url) {
      requests.push(url);
      if (url.startsWith('/api/timeline')) return new Promise((resolve) => { resolveTimeline = resolve; });
      // A slow catalogue must not hold up the direct-link board.
      return new Promise(() => {});
    },
  });
  vm.runInContext(source, context);
  return {
    get, requests, context, get painted() { return painted; },
    async finish(ok = true) {
      resolveTimeline({ ok, status: 503,
        text: async () => JSON.stringify({ data: { timeline } }),
        json: async () => ({ error: { message: 'unavailable' } }),
      });
      await flush();
    },
  };
}

test('past-start direct link loads on its own view and opens the board without waiting for the catalogue', async () => {
  const app = boot(`?uk=example&start=${Date.now() - 60_000}`);
  assert.equal(app.get('view-picker').hidden, true);
  assert.equal(app.get('view-loading').hidden, false);
  assert.equal(app.requests.length, 1);
  assert.match(app.requests[0], /^\/api\/timeline/);
  await app.finish();
  assert.equal(app.get('view-board').hidden, false);
  assert.equal(app.get('view-loading').hidden, true);
  assert.ok(app.painted);
});

test('future-start direct link automatically enters countdown', async () => {
  const app = boot(`?uk=example&start=${Date.now() + 3600_000}`);
  assert.equal(app.get('view-loading').hidden, false);
  await app.finish();
  assert.equal(app.get('view-countdown').hidden, false);
  assert.equal(app.get('view-picker').hidden, true);
});

test('direct-link errors return to the picker with a visible retryable error', async () => {
  const app = boot('?uk=example&start_now=1');
  await app.finish(false);
  assert.equal(app.get('view-picker').hidden, false);
  assert.equal(app.get('view-loading').hidden, true);
  assert.equal(app.get('setup-error').hidden, false);
  assert.match(app.get('setup-error').textContent, /unavailable/);
  assert.equal(app.get('btn-start').disabled, false);
});

test('an ended direct link stops its clock, reveals every problem and can rewind', async () => {
  const app = boot(`?uk=example&start=${Date.now() - (timeline.contest.durationSec + 100) * 1000}`);
  await app.finish();
  assert.equal(app.painted.contestSec, timeline.contest.durationSec);
  assert.ok(app.painted.stats.revealed.every(Boolean));
  assert.equal(app.get('btn-pause').disabled, true);
  vm.runInContext('app.session.seek(0, Date.now()); updateUi();', app.context);
  assert.equal(app.get('btn-pause').disabled, false);
  assert.equal(app.painted.contestSec, 0);
});
