/**
 * Rule-level tests for the CCPC new ranklist engine.
 *
 * These use small hand-built timelines so every branch of the reveal,
 * column-ordering, scoring and ranking rules is asserted explicitly.
 * See docs/rules.md for the mapping to the published rule text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RESULT } from '../shared/srk.mjs';
import {
  BUCKET,
  cellInfo,
  columnOrder,
  computeBoard,
  createState,
  floorToPrecision,
  isRevealed,
  replayTo,
  resolveReveal,
} from '../shared/rules.mjs';
import { frameAt, createEpochReplay, resolveFreeze, formatClock } from '../shared/replay.mjs';
import { createSession, PHASE } from '../shared/live.mjs';

/**
 * Build a minimal wire timeline.
 *
 * @param {object} spec
 * @param {number} spec.teams
 * @param {number} spec.problems
 * @param {Array<[number, number, number, number]>} spec.events
 * @param {number} [spec.durationSec]
 * @param {number} [spec.frozenDurationSec]
 * @param {number} [spec.penaltySec]
 * @param {string} [spec.timePrecision]
 * @param {number[]} [spec.revealSec] explicit reveal times (Infinity allowed)
 * @param {boolean[]} [spec.official]
 */
function makeTimeline(spec) {
  const teamCount = spec.teams;
  const problemCount = spec.problems;
  const official = spec.official ?? new Array(teamCount).fill(true);
  const revealSec = spec.revealSec ?? new Array(problemCount).fill(Infinity);
  const threshold = spec.threshold ?? teamCount;

  return {
    version: 1,
    uk: 'test',
    name: 'Test Contest',
    contest: {
      durationSec: spec.durationSec ?? 18000,
      frozenDurationSec: spec.frozenDurationSec ?? 0,
    },
    problems: Array.from({ length: problemCount }, (_, i) => ({
      alias: String.fromCharCode(65 + i),
      title: `Problem ${i}`,
      color: null,
      accepted: null,
    })),
    teams: Array.from({ length: teamCount }, (_, i) => ({
      id: String(i),
      name: `Team ${i}`,
      organization: `Org ${i}`,
      official: official[i],
      members: [],
      markers: [],
    })),
    reveal: {
      ratio: 0.2,
      min: 50,
      all: { teamsRanked: teamCount, threshold, revealSec },
      official: { teamsRanked: teamCount, threshold, revealSec },
    },
    sorter: {
      algorithm: 'ICPC',
      penaltySec: spec.penaltySec ?? 1200,
      noPenaltyResults: ['FB', 'AC', '?', 'NOUT', 'CE', 'UKE', null],
      // Mirrors the codes RankLand actually publishes for these contests.
      noPenaltyCodes: [RESULT.FB, RESULT.AC, RESULT.UNKNOWN, RESULT.NOUT, RESULT.CE, RESULT.UKE],
      timePrecision: spec.timePrecision ?? 'min',
      rankingTimePrecision: spec.timePrecision ?? 'min',
    },
    events: spec.events,
    triesFallback: spec.triesFallback ?? null,
    coverage: { exact: true, events: spec.events.length, droppedEvents: 0, noPenaltyResults: [] },
  };
}

// ------------------------------------------------------------ time precision

test('floorToPrecision floors to the configured unit', () => {
  assert.equal(floorToPrecision(61, 'min'), 60);
  assert.equal(floorToPrecision(119, 'min'), 60);
  assert.equal(floorToPrecision(120, 'min'), 120);
  assert.equal(floorToPrecision(3661, 'h'), 3600);
  assert.equal(floorToPrecision(61.5, 's'), 61);
  assert.equal(floorToPrecision(61, null), 61);
});

// --------------------------------------------------------------- scoring

test('a solve adds floored solve time plus 20 minutes per failed attempt', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    // floor(600/60)=10min solve, 2 penalty-bearing failures
    events: [
      [100, 0, 0, RESULT.WA],
      [200, 0, 0, RESULT.TLE],
      [600, 0, 0, RESULT.AC],
    ],
  });
  const { state } = replayTo(timeline, 1000);
  assert.equal(state.solved[0], 1);
  assert.equal(state.penalty[0], 600 + 2 * 1200);
});

test('no-penalty results do not count as failed attempts', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.CE], // in noPenaltyResults
      [200, 0, 0, RESULT.WA], // counts
      [600, 0, 0, RESULT.AC],
    ],
  });
  const { state } = replayTo(timeline, 1000);
  assert.equal(state.penalty[0], 600 + 1200, 'only the WA carries a penalty');
});

test('submissions after an AC are ignored entirely (rule 4)', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [600, 0, 0, RESULT.AC],
      [700, 0, 0, RESULT.WA], // ignored: no try, no penalty
      [800, 0, 0, RESULT.WA], // ignored
    ],
  });
  const { state } = replayTo(timeline, 1000);
  assert.equal(state.solved[0], 1);
  assert.equal(state.penalty[0], 600);
  assert.equal(state.subs[0], 1, 'post-AC submissions do not increase the count');
  assert.equal(state.lastSub[0], 600, 'post-AC submissions do not move last-submit');
});

test('a second AC on the same problem is ignored', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [600, 0, 0, RESULT.AC],
      [900, 0, 0, RESULT.AC],
    ],
  });
  const { state } = replayTo(timeline, 1000);
  assert.equal(state.solved[0], 1, 'one problem solved once');
  assert.equal(state.penalty[0], 600);
});

test('an RJ submission counts as a try but carries no penalty', () => {
  // RJ is *not* in the SRK default noPenaltyResults list, so this is really a
  // test of the state machine: RJ produces no penalty because RankLand gives it
  // no submission time, exercised here through the explicit code list.
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.RJ],
      [600, 0, 0, RESULT.AC],
    ],
  });
  timeline.sorter.noPenaltyCodes = [...timeline.sorter.noPenaltyCodes, RESULT.RJ];

  const { state } = replayTo(timeline, 1000);
  assert.equal(state.subs[0], 2, 'both submissions are visible');
  assert.equal(state.solved[0], 1);
  const board = computeBoard(state, 1000, resolveReveal(timeline));
  assert.equal(board.rows[0].penalty, 600, 'RJ adds no penalty time');
});

test('an RJ submission counts as a penalty-bearing try when the sorter says so', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.RJ],
      [600, 0, 0, RESULT.AC],
    ],
  });
  timeline.sorter.noPenaltyCodes = timeline.sorter.noPenaltyCodes.filter(
    (code) => code !== RESULT.RJ,
  );
  const { state } = replayTo(timeline, 1000);
  assert.equal(state.penalty[0], 600 + 1200, 'RJ counts as a failed attempt');
});

test('only events at or before the limit are applied', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 2,
    events: [
      [100, 0, 0, RESULT.AC],
      [200, 0, 1, RESULT.AC],
    ],
  });
  assert.equal(replayTo(timeline, 150).state.solved[0], 1);
  assert.equal(replayTo(timeline, 200).state.solved[0], 2);
});

// ------------------------------------------------------------- ranking

test('ranking sorts by solves desc, penalty asc, then earliest last AC', () => {
  const timeline = makeTimeline({
    teams: 3,
    problems: 2,
    events: [
      // team 0: 2 solves, penalty floor(600/60)+floor(1200/60)=10+20=30min
      [600, 0, 0, RESULT.AC],
      [1200, 0, 1, RESULT.AC],
      // team 1: 2 solves, penalty 20+30=50min
      [1200, 1, 0, RESULT.AC],
      [1800, 1, 1, RESULT.AC],
      // team 2: 1 solve
      [300, 2, 0, RESULT.AC],
    ],
  });
  const board = computeBoard(replayTo(timeline, 9999).state, 9999, resolveReveal(timeline));
  assert.deepEqual(board.rows.map((row) => row.teamIdx), [0, 1, 2]);
  assert.deepEqual(board.rows.map((row) => row.rank), [1, 2, 3]);
  assert.equal(board.rows[0].penalty, 1800, '30 minutes in seconds');
  assert.equal(board.rows[1].penalty, 3000, '50 minutes in seconds');
});

test('teams tied on solves and penalty share a rank and the next rank skips', () => {
  const timeline = makeTimeline({
    teams: 3,
    problems: 1,
    events: [
      [600, 0, 0, RESULT.AC],
      [600, 1, 0, RESULT.AC],
      [1200, 2, 0, RESULT.AC],
    ],
  });
  const board = computeBoard(replayTo(timeline, 9999).state, 9999, resolveReveal(timeline));
  const byTeam = new Map(board.rows.map((row) => [row.teamIdx, row.rank]));
  assert.equal(byTeam.get(0), 1);
  assert.equal(byTeam.get(1), 1, 'identical score shares the rank');
  assert.equal(byTeam.get(2), 3, 'the following rank skips');
});

test('official:false teams are listed but never ranked', () => {
  const timeline = makeTimeline({
    teams: 2,
    problems: 1,
    official: [true, false],
    events: [
      [600, 1, 0, RESULT.AC], // unofficial solves first
      [1200, 0, 0, RESULT.AC],
    ],
  });
  const board = computeBoard(replayTo(timeline, 9999).state, 9999, resolveReveal(timeline));
  assert.equal(board.officialTeams, 1);
  assert.equal(board.rows[0].teamIdx, 0, 'official teams come first');
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[1].teamIdx, 1);
  assert.equal(board.rows[1].rank, 0, 'unofficial rows carry no rank');
});

test('an unsolved board is all zeroes and still rankable', () => {
  const timeline = makeTimeline({ teams: 2, problems: 1, events: [] });
  const board = computeBoard(replayTo(timeline, 100).state, 100, resolveReveal(timeline));
  assert.equal(board.rows.length, 2);
  assert.ok(board.rows.every((row) => row.solved === 0 && row.penalty === 0));
  assert.deepEqual(board.rows.map((row) => row.rank), [1, 1]);
});

// ------------------------------------------------------- reveal (rule 1)

test('isRevealed flips exactly at the reveal second', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [],
    revealSec: [100],
  });
  const reveal = resolveReveal(timeline, 'all');
  assert.ok(!isRevealed(reveal, 0, 99));
  assert.ok(isRevealed(reveal, 0, 100));
});

test('an unrevealed problem keeps its alias hidden in cellInfo', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 2,
    events: [[100, 0, 0, RESULT.AC]],
    revealSec: [100, Infinity],
  });
  const { state } = replayTo(timeline, 200);
  const reveal = resolveReveal(timeline, 'all');
  assert.equal(cellInfo(state, 0, 0, reveal, 200).alias, 'A');
  assert.equal(cellInfo(state, 0, 1, reveal, 200).alias, null, 'hidden alias stays null');
});

// ------------------------------------------------ column ordering (rule 3)

test('columnOrder applies the four buckets in order', () => {
  // 5 problems.
  //  - P0 revealed; team solved it at 1000
  //  - P1 revealed; untouched
  //  - P2 hidden; solved at 300
  //  - P3 hidden; attempted, last submission 800
  //  - P4 hidden; never touched
  const timeline = makeTimeline({
    teams: 1,
    problems: 5,
    revealSec: [0, 0, Infinity, Infinity, Infinity],
    events: [
      [300, 0, 2, RESULT.AC],
      [800, 0, 3, RESULT.WA],
      [1000, 0, 0, RESULT.AC],
    ],
  });
  const { state } = replayTo(timeline, 2000);
  const reveal = resolveReveal(timeline, 'all');
  const order = columnOrder(state, 0, 2000, reveal);
  // bucket 1: revealed problems by index -> 0, 1
  // bucket 2: solved hidden by AC time -> 2
  // bucket 3: attempted hidden by last submit -> 3
  // bucket 4: untouched hidden by index -> 4
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('columnOrder puts revealed problems first even if solved later', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 3,
    revealSec: [0, Infinity, Infinity],
    events: [
      [100, 0, 1, RESULT.AC], // hidden solve, early
      [200, 0, 2, RESULT.AC], // hidden solve, later
      [9000, 0, 0, RESULT.AC], // revealed, solved last
    ],
  });
  const { state } = replayTo(timeline, 9999);
  const reveal = resolveReveal(timeline, 'all');
  const order = columnOrder(state, 0, 9999, reveal);
  assert.deepEqual(order, [0, 1, 2], 'revealed bucket (P0) wins despite the later solve');
});

test('columnOrder sorts hidden solves by AC time ascending', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 3,
    revealSec: [Infinity, Infinity, Infinity],
    events: [
      [500, 0, 2, RESULT.AC],
      [100, 0, 0, RESULT.AC],
      [300, 0, 1, RESULT.AC],
    ],
  });
  const { state } = replayTo(timeline, 9999);
  const order = columnOrder(state, 0, 9999, resolveReveal(timeline, 'all'));
  assert.deepEqual(order, [0, 1, 2], 'P0 (100s), P1 (300s), P2 (500s)');
});

test('columnOrder sorts un-solved attempts by latest submission ascending', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 3,
    revealSec: [Infinity, Infinity, Infinity],
    events: [
      [900, 0, 0, RESULT.WA],
      [100, 0, 1, RESULT.WA],
      [500, 0, 2, RESULT.WA],
    ],
  });
  const { state } = replayTo(timeline, 9999);
  const order = columnOrder(state, 0, 9999, resolveReveal(timeline, 'all'));
  assert.deepEqual(order, [1, 2, 0], 'P1 (100s), P2 (500s), P0 (900s)');
});

test('columnOrder puts never-submitted problems last, by problem number', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 4,
    revealSec: [Infinity, Infinity, Infinity, Infinity],
    events: [[100, 0, 3, RESULT.WA]],
  });
  const { state } = replayTo(timeline, 9999);
  const order = columnOrder(state, 0, 9999, resolveReveal(timeline, 'all'));
  assert.deepEqual(order, [3, 0, 1, 2], 'attempted P3 first, then untouched P0..P2');
});

test('columnOrder uses the legacy fallback attempt counts', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 2,
    revealSec: [Infinity, Infinity],
    events: [],
    triesFallback: [[0, 5]],
  });
  const { state } = replayTo(timeline, 100);
  const order = columnOrder(state, 0, 100, resolveReveal(timeline, 'all'), {
    triesFallback: timeline.triesFallback,
  });
  assert.deepEqual(order, [1, 0], 'P1 has attempts, so it precedes untouched P0');
});

test('column order changes over time as problems are revealed', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 2,
    revealSec: [1000, Infinity],
    events: [
      [500, 0, 1, RESULT.AC],
      [2000, 0, 0, RESULT.AC],
    ],
  });
  const reveal = resolveReveal(timeline, 'all');

  const early = replayTo(timeline, 900).state;
  assert.deepEqual(columnOrder(early, 0, 900, reveal), [1, 0], 'P0 still hidden');

  const late = replayTo(timeline, 2500).state;
  assert.deepEqual(columnOrder(late, 0, 2500, reveal), [0, 1], 'P0 revealed, takes slot 1');
});

// ----------------------------------------------------------- epoch replay

test('createEpochReplay matches a full replay at every probe', () => {
  const events = [];
  for (let t = 1; t <= 600; t++) {
    events.push([t * 10, t % 7, t % 5, t % 11 === 0 ? RESULT.AC : RESULT.WA]);
  }
  const timeline = makeTimeline({ teams: 7, problems: 5, events });
  const epoch = createEpochReplay(timeline, { snapshotIntervalSec: 300 });

  for (const tSec of [0, 1, 55, 300, 3000, 5999, 6000, 6001]) {
    const fromEpoch = epoch.frameAt(tSec).rows;
    const fromScratch = frameAt(timeline, tSec).rows;
    assert.deepEqual(
      fromEpoch.map((row) => [row.teamIdx, row.solved, row.penalty, row.rank]),
      fromScratch.map((row) => [row.teamIdx, row.solved, row.penalty, row.rank]),
      `frame at ${tSec}s matches a from-scratch replay`,
    );
  }
});

test('createEpochReplay handles seeking backwards then forwards', () => {
  const timeline = makeTimeline({
    teams: 2,
    problems: 2,
    events: [
      [100, 0, 0, RESULT.AC],
      [200, 1, 0, RESULT.AC],
      [300, 0, 1, RESULT.AC],
      [400, 1, 1, RESULT.AC],
    ],
  });
  const epoch = createEpochReplay(timeline, { snapshotIntervalSec: 100 });
  assert.equal(epoch.frameAt(150).rows.find((r) => r.teamIdx === 0).solved, 1);
  assert.equal(epoch.frameAt(350).rows.find((r) => r.teamIdx === 0).solved, 2);
  assert.equal(epoch.frameAt(250).rows.find((r) => r.teamIdx === 0).solved, 1, 'rewind works');
  assert.equal(epoch.frameAt(450).rows.find((r) => r.teamIdx === 0).solved, 2, 're-advance works');
});

// ------------------------------------------------------------- freeze

test('resolveFreeze clips the board once the freeze starts', () => {
  const params = { durationSec: 18000, frozenDurationSec: 3600, freezeMode: 'auto' };
  assert.deepEqual(resolveFreeze({ ...params, contestSec: 14399 }), {
    visibleSec: 14399, frozen: false, frozenAtSec: 14400, revealPending: false,
  });
  assert.deepEqual(resolveFreeze({ ...params, contestSec: 14400 }), {
    visibleSec: 14400, frozen: false, frozenAtSec: 14400, revealPending: false,
  });
  assert.deepEqual(resolveFreeze({ ...params, contestSec: 15000 }), {
    visibleSec: 14400, frozen: true, frozenAtSec: 14400, revealPending: true,
  });
});

test('resolveFreeze with reveal unlocks the true final board', () => {
  const result = resolveFreeze({
    contestSec: 18000, durationSec: 18000, frozenDurationSec: 3600, freezeMode: 'auto', revealed: true,
  });
  assert.equal(result.visibleSec, 18000);
  assert.equal(result.frozen, false);
});

test('resolveFreeze never freezes when the mode is never', () => {
  const result = resolveFreeze({
    contestSec: 15000, durationSec: 18000, frozenDurationSec: 3600, freezeMode: 'never',
  });
  assert.equal(result.visibleSec, 15000);
  assert.equal(result.frozen, false);
  assert.equal(result.revealPending, false);
});

test('resolveFreeze is a no-op for contests without a freeze window', () => {
  const result = resolveFreeze({
    contestSec: 15000, durationSec: 18000, frozenDurationSec: 0, freezeMode: 'auto',
  });
  assert.equal(result.visibleSec, 15000);
  assert.equal(result.frozen, false);
});

test('resolveFreeze clamps beyond the contest duration', () => {
  const result = resolveFreeze({
    contestSec: 99999, durationSec: 18000, frozenDurationSec: 0, freezeMode: 'auto',
  });
  assert.equal(result.visibleSec, 18000);
});

// ------------------------------------------------------------- session

test('session goes through countdown, running, frozen and revealed', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    durationSec: 18000,
    frozenDurationSec: 3600,
    events: [[600, 0, 0, RESULT.AC]],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0 + 10_000, now: t0 });

  assert.equal(session.update(t0).phase, PHASE.PENDING);
  assert.equal(session.update(t0 + 20_000).phase, PHASE.RUNNING);
  assert.equal(session.update(t0 + 10_000 + 14_500_000).phase, PHASE.FROZEN);
  const end = session.update(t0 + 10_000 + 18_000_000);
  assert.equal(end.phase, PHASE.ENDED);
  assert.equal(end.revealed, true, 'the frozen board is revealed at the end');
  assert.equal(end.visibleSec, 18000);
});

test('a frozen session stops reflecting new events', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 2,
    durationSec: 18000,
    frozenDurationSec: 3600,
    events: [
      [600, 0, 0, RESULT.AC],
      [15000, 0, 1, RESULT.AC], // inside the freeze window
    ],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  const frozen = session.update(t0 + 16_000_000);
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.visibleSec, 14400);
  assert.equal(frozen.rows[0].solved, 1, 'the 15000s solve is invisible while frozen');

  const revealed = session.reveal(t0 + 16_000_000);
  assert.equal(revealed.rows[0].solved, 2, 'revealing exposes the real result');
});

test('session pause and resume preserve the contest second', () => {
  const timeline = makeTimeline({ teams: 1, problems: 1, events: [] });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  assert.equal(session.update(t0 + 600_000).contestSec, 600);
  session.pause(t0 + 600_000);
  assert.equal(session.update(t0 + 900_000).contestSec, 600, 'paused clock does not advance');
  session.resume(t0 + 900_000);
  assert.equal(session.update(t0 + 910_000).contestSec, 610, 'resumes from where it stopped');
});

test('session speed changes keep the current contest second', () => {
  const timeline = makeTimeline({ teams: 1, problems: 1, events: [] });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  session.update(t0 + 600_000);
  session.setSpeed(60);
  assert.equal(session.update(t0 + 600_000).contestSec, 600, 'instant change preserves the position');
  assert.equal(session.update(t0 + 610_000).contestSec, 1200, '10s of wall time is 600 contest seconds');
});

test('session seek detaches and followLive rejoins', () => {
  const timeline = makeTimeline({ teams: 1, problems: 1, events: [] });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  session.seek(5000, t0 + 100_000);
  assert.equal(session.update(t0 + 200_000).contestSec, 5000, 'detached clock is stable');
  assert.equal(session.detached, true);
  session.followLive(t0 + 200_000);
  assert.equal(session.detached, false);
  assert.equal(session.update(t0 + 205_000).contestSec, 5005, 'rejoined at the same second');
});

test('session clamps seek to the contest duration', () => {
  const timeline = makeTimeline({ teams: 1, problems: 1, events: [], durationSec: 1000 });
  const session = createSession(timeline, { startAt: 0, now: 0 });
  assert.equal(session.seek(99999, 0).visibleSec, 1000);
  assert.equal(session.seek(-5, 0).visibleSec, 0);
});

test('session switching reveal scope recalculates the threshold', () => {
  const timeline = makeTimeline({
    teams: 2,
    problems: 1,
    events: [[100, 0, 0, RESULT.AC]],
    revealSec: [100],
  });
  timeline.reveal.official = { teamsRanked: 1, threshold: 1, revealSec: [100] };
  timeline.reveal.all = { teamsRanked: 2, threshold: 2, revealSec: [Infinity] };

  const session = createSession(timeline, { startAt: 0, now: 0, revealScope: 'all' });
  assert.equal(session.update(1000).reveal.revealSec[0], Infinity);
  session.setRevealScope('official', 1000);
  assert.equal(session.update(1000).reveal.revealSec[0], 100);
});

// ------------------------------------------------------------- formatting

test('formatClock prints H:MM:SS', () => {
  assert.equal(formatClock(0), '0:00:00');
  assert.equal(formatClock(59), '0:00:59');
  assert.equal(formatClock(3600), '1:00:00');
  assert.equal(formatClock(18000), '5:00:00');
  assert.equal(formatClock(3661), '1:01:01');
  assert.equal(formatClock(-5), '0:00:00');
});
