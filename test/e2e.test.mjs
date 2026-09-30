/**
 * End-to-end regression against real RankLand data.
 *
 * Skipped by default because it needs the network. Run it with:
 *
 *   VP_E2E=1 node --test test/e2e.test.mjs
 *
 * It downloads an SRK ranklist, builds the wire timeline, replays every
 * submission and asserts that the replayed board reproduces the published one
 * exactly. This is the guarantee that the whole tool rests on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRanklandClient } from '../server/rankland.mjs';
import { buildTimeline } from '../server/build-timeline.mjs';
import { createEpochReplay, frameAt } from '../shared/replay.mjs';

const ENABLED = process.env.VP_E2E === '1';
/** Contest used for the regression; override with VP_E2E_UK. */
const UK = process.env.VP_E2E_UK ?? 'ccpc2026preliminary';
const TIMEOUT = Number(process.env.VP_E2E_TIMEOUT_MS ?? 600_000);

/** Convert an SRK duration to seconds. */
function toSec(duration) {
  if (!duration) return 0;
  const [value, unit] = duration;
  return unit === 'min' ? value * 60 : unit === 'h' ? value * 3600 : value;
}

async function loadTimeline() {
  const client = createRanklandClient({});
  const contests = await client.listContests();
  const summary = contests.find((contest) => contest.uk === UK);
  assert.ok(summary, `contest ${UK} exists on RankLand`);
  assert.ok(summary.srkFileID, `contest ${UK} has a ranklist file`);

  const meta = await client.getFileMeta(summary.srkFileID);
  const { ranklist } = await client.fetchSrk(meta.url);
  const timeline = buildTimeline(ranklist, {
    uk: summary.uk,
    name: summary.name,
    srkHash: meta.hashValue,
    srkUrl: meta.url,
    srkSize: meta.size,
  });
  return { timeline, ranklist, summary };
}

test('real ranklist: replayed board matches the published board', { timeout: TIMEOUT, skip: !ENABLED }, async () => {
  const { timeline, ranklist } = await loadTimeline();

  assert.equal(timeline.coverage.exact, true, 'this contest must carry per-solution timestamps');
  assert.ok(timeline.events.length > 1000, 'the timeline has a meaningful number of events');
  assert.equal(timeline.teams.length, ranklist.rows.length);
  assert.equal(timeline.problems.length, ranklist.problems.length);

  const frame = frameAt(timeline, timeline.contest.durationSec, { officialOnly: false });
  const byId = new Map(frame.rows.map((row) => [row.team.id, row]));

  let missing = 0;
  let solvedMismatch = 0;
  let penaltyMismatch = 0;

  for (const published of ranklist.rows) {
    const mine = byId.get(String(published.user.id));
    if (!mine) {
      missing++;
      continue;
    }
    if (mine.solved !== published.score.value) solvedMismatch++;
    const publishedPenalty = published.score.time ? toSec(published.score.time) : 0;
    if (mine.penalty !== publishedPenalty) penaltyMismatch++;
  }

  assert.equal(missing, 0, 'every published row is present');
  assert.equal(solvedMismatch, 0, 'solved counts match the published board');
  assert.equal(penaltyMismatch, 0, 'total penalties match the published board');
});

test('real ranklist: rank order is consistent with the published order', { timeout: TIMEOUT, skip: !ENABLED }, async () => {
  const { timeline, ranklist } = await loadTimeline();
  const frame = frameAt(timeline, timeline.contest.durationSec);

  const published = ranklist.rows.filter((row) => row.user.official !== false);
  const replayed = frame.rows.filter((row) => row.official);

  assert.equal(replayed.length, published.length, 'same number of ranked teams');

  // 1. The score sequence must be strictly non-worsening along the ranking.
  for (let i = 1; i < replayed.length; i++) {
    const previous = replayed[i - 1];
    const current = replayed[i];
    assert.ok(
      previous.solved > current.solved
        || (previous.solved === current.solved && previous.penalty <= current.penalty),
      `rank ${i + 1} is not worse than rank ${i}`,
    );
  }

  // 2. RankLand's own row order must itself be sorted by (solved, penalty).
  const publishedScores = published.map((row) => [row.score.value, row.score.time ? toSec(row.score.time) : 0]);
  for (let i = 1; i < publishedScores.length; i++) {
    const [prevSolved, prevPenalty] = publishedScores[i - 1];
    const [curSolved, curPenalty] = publishedScores[i];
    assert.ok(
      prevSolved > curSolved || (prevSolved === curSolved && prevPenalty <= curPenalty),
      `published rank ${i + 1} is not worse than rank ${i}`,
    );
  }

  // 3. Our order must match up to ties: the multiset of score keys at every
  //    prefix position must agree. Within a (solved, penalty) group the order is
  //    a tiebreak we do not attempt to reproduce exactly, because RankLand's
  //    published order does not follow last-AC for every tie.
  const keyOf = (solved, penalty) => `${solved}|${penalty}`;
  const replayedKeys = replayed.map((row) => keyOf(row.solved, row.penalty));
  const publishedKeys = publishedScores.map(([solved, penalty]) => keyOf(solved, penalty));

  for (let i = 0; i < publishedKeys.length; i++) {
    assert.equal(
      replayedKeys[i],
      publishedKeys[i],
      `rank ${i + 1} has the same (solved, penalty) as the published board`,
    );
  }
});

test('real ranklist: epoch snapshots agree with a full replay', { timeout: TIMEOUT, skip: !ENABLED }, async () => {
  const { timeline } = await loadTimeline();
  const epoch = createEpochReplay(timeline);
  const duration = timeline.contest.durationSec;

  for (const ratio of [0, 0.13, 0.4, 0.5, 0.77, 0.95, 1]) {
    const tSec = Math.floor(duration * ratio);
    const fast = epoch.frameAt(tSec).rows;
    const exact = frameAt(timeline, tSec).rows;
    assert.deepEqual(
      fast.map((row) => [row.teamIdx, row.solved, row.penalty, row.rank]),
      exact.map((row) => [row.teamIdx, row.solved, row.penalty, row.rank]),
      `frame at ${tSec}s matches`,
    );
  }
});

test('real ranklist: a legacy contest degrades without crashing', { timeout: TIMEOUT, skip: !ENABLED }, async () => {
  // Older RankLand ranklists carry no per-solution timestamps; the engine must
  // still produce a usable (if coarse) board.
  const client = createRanklandClient({});
  const contests = await client.listContests();
  const legacy = contests.find((contest) => contest.uk === 'ccpc2017qinhuangdao');
  assert.ok(legacy?.srkFileID, 'the legacy fixture contest exists');

  const meta = await client.getFileMeta(legacy.srkFileID);
  const { ranklist } = await client.fetchSrk(meta.url);
  const timeline = buildTimeline(ranklist, { uk: legacy.uk, name: legacy.name, srkHash: meta.hashValue });

  assert.equal(timeline.coverage.exact, false, 'legacy data is flagged inexact');
  assert.ok(timeline.events.length > 0, 'solves still produce events');
  assert.ok(timeline.triesFallback.length === timeline.teams.length);

  const frame = frameAt(timeline, timeline.contest.durationSec);
  assert.equal(frame.rows.length, timeline.teams.length);

  // Published solved counts must still be reproduced: the legacy timeline emits
  // a solve event at the published solve time for every solved problem.
  const byId = new Map(frame.rows.map((row) => [row.team.id, row]));
  let mismatches = 0;
  for (const published of ranklist.rows) {
    const mine = byId.get(String(published.user.id));
    if (!mine || mine.solved !== published.score.value) mismatches++;
  }
  assert.equal(mismatches, 0, 'legacy solved counts still match the published board');
});

test('real ranklist: reveal times follow the live accepted count', { timeout: TIMEOUT, skip: !ENABLED }, async () => {
  const { timeline } = await loadTimeline();
  const threshold = timeline.reveal.all.threshold;

  // Recompute the live "distinct solving teams" counter straight from the
  // event stream. The reveal rule must key off this counter, not off the
  // published `statistics.accepted`, which is a snapshot taken at a different
  // moment and can differ (e.g. after judge re-runs).
  const solved = new Set();
  const counts = new Array(timeline.problems.length).fill(0);
  const liveReveal = new Array(timeline.problems.length).fill(null);

  for (const [tSec, teamIdx, probIdx] of timeline.events) {
    if (liveReveal[probIdx] !== null) continue;
    const key = `${teamIdx}:${probIdx}`;
    if (solved.has(key)) continue;
    solved.add(key);
    counts[probIdx]++;
    if (counts[probIdx] >= threshold) liveReveal[probIdx] = tSec;
  }

  assert.deepEqual(
    liveReveal,
    timeline.reveal.all.revealSec,
    'the precomputed reveal times match a live recount',
  );

  assert.equal(
    threshold,
    Math.max(1, Math.min(Math.floor(timeline.reveal.all.teamsRanked * 0.2), 50)),
    'threshold is min(floor(N * 20%), 50)',
  );
  assert.ok(threshold <= 50, 'the 50-team figure is an upper bound');

  for (let i = 0; i < timeline.problems.length; i++) {
    if (timeline.reveal.all.revealSec[i] === null) {
      assert.ok(counts[i] < threshold, `problem ${i} never reached the threshold`);
    } else {
      assert.ok(counts[i] >= threshold, `problem ${i} reached the threshold`);
      // The reveal second must be within the contest.
      assert.ok(
        timeline.reveal.all.revealSec[i] <= timeline.contest.durationSec,
        `problem ${i} reveals inside the contest`,
      );
    }
  }
});
