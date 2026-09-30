/**
 * Rule-level tests for the CCPC new ranklist engine.
 *
 * These use small hand-built timelines so every branch of the reveal,
 * column-ordering, scoring and ranking rules is asserted explicitly.
 *
 * Reveal is *dynamic* here: nothing precomputes reveal times, so a test
 * controls the threshold through the team count and the solve events, exactly
 * as the live board does. See docs/rules.md for the rule text mapping.
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
  medalBands,
  medalFor,
  problemStatus,
  replayTo,
  revealThreshold,
  sharedColumnOrder,
} from '../shared/rules.mjs';
import { frameAt, createEpochReplay, resolveFreeze, formatClock } from '../shared/replay.mjs';
import { createSession, PHASE, DEFAULT_FREEZE_MINUTES } from '../shared/live.mjs';

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
 * @param {boolean[]} [spec.official]
 * @param {number} [spec.accepted] value reported in `problems[].accepted`
 */
function makeTimeline(spec) {
  const teamCount = spec.teams;
  const problemCount = spec.problems;
  const official = spec.official ?? new Array(teamCount).fill(true);

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
      accepted: spec.accepted ?? null,
      submitted: null,
    })),
    teams: Array.from({ length: teamCount }, (_, i) => ({
      id: String(i),
      name: `Team ${i}`,
      organization: `Org ${i}`,
      official: official[i],
      members: [],
      markers: [],
    })),
    reveal: { ratio: 0.2, min: 50 },
    sorter: {
      algorithm: 'ICPC',
      penaltySec: spec.penaltySec ?? 1200,
      noPenaltyResults: ['FB', 'AC', '?', 'NOUT', 'CE', 'UKE', null],
      noPenaltyCodes: [RESULT.FB, RESULT.AC, RESULT.UNKNOWN, RESULT.NOUT, RESULT.CE, RESULT.UKE],
      timePrecision: spec.timePrecision ?? 'min',
      rankingTimePrecision: spec.timePrecision ?? 'min',
    },
    events: spec.events,
    triesFallback: spec.triesFallback ?? null,
    coverage: { exact: true, events: spec.events.length, droppedEvents: 0, noPenaltyResults: [] },
  };
}

/** Convenience: replayed state plus live problem stats at `tSec`. */
function replay(timeline, tSec, options = {}) {
  const { state } = replayTo(timeline, tSec, options);
  return { state, stats: problemStatus(state, tSec, options) };
}

// ------------------------------------------------------------- threshold rule

test('revealThreshold is the smaller of floor(N * 20%) and 50', () => {
  // Small contest: 20% is the binding constraint.
  assert.equal(revealThreshold(10), 2);
  assert.equal(revealThreshold(45), 9);
  assert.equal(revealThreshold(100), 20);
  // Large field: the 50-team figure caps it.
  assert.equal(revealThreshold(300), 50);
  assert.equal(revealThreshold(2170), 50);
  // A tiny field would floor to 0, which would reveal before anyone solved it,
  // so the threshold never drops below 1.
  assert.equal(revealThreshold(1), 1);
  assert.equal(revealThreshold(4), 1);
  assert.equal(revealThreshold(0), 1);
});

test('1000-team fixture reveals at 50 solves, not 200', () => {
  const events = [];
  for (let team = 0; team < 60; team++) events.push([100 + team, team, 0, RESULT.AC]);
  const timeline = makeTimeline({ teams: 1000, problems: 1, events });
  const { stats } = replay(timeline, 9999);
  assert.equal(stats.threshold, Math.min(Math.floor(1000 * 0.2), 50));
  assert.equal(stats.threshold, 50);
  assert.equal(stats.solved[0], 60);
  assert.ok(stats.revealed[0], '60 solvers clears a threshold of 50');
});

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
    events: [
      [100, 0, 0, RESULT.WA],
      [200, 0, 0, RESULT.TLE],
      [600, 0, 0, RESULT.AC],
    ],
  });
  const { state } = replay(timeline, 1000);
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
  const { state } = replay(timeline, 1000);
  assert.equal(state.penalty[0], 600 + 1200, 'only the WA carries a penalty');
});

test('submissions after an AC are ignored entirely (rule 4)', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [600, 0, 0, RESULT.AC],
      [700, 0, 0, RESULT.WA],
      [800, 0, 0, RESULT.WA],
    ],
  });
  const { state } = replay(timeline, 1000);
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
  const { state } = replay(timeline, 1000);
  assert.equal(state.solved[0], 1);
  assert.equal(state.penalty[0], 600);
});

test('an RJ submission counts as a try but carries no penalty when configured so', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.RJ],
      [600, 0, 0, RESULT.AC],
    ],
  });
  timeline.sorter.noPenaltyCodes = [...timeline.sorter.noPenaltyCodes, RESULT.RJ];
  const { state } = replay(timeline, 1000);
  assert.equal(state.subs[0], 2, 'both submissions are visible');
  assert.equal(state.solved[0], 1);
  assert.equal(state.penalty[0], 600, 'RJ adds no penalty time');
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
  assert.equal(replay(timeline, 150).state.solved[0], 1);
  assert.equal(replay(timeline, 200).state.solved[0], 2);
});

// ------------------------------------------------------------- ranking

test('ranking sorts by solves desc, penalty asc, then earliest last AC', () => {
  const timeline = makeTimeline({
    teams: 3,
    problems: 2,
    events: [
      [600, 0, 0, RESULT.AC],
      [1200, 0, 1, RESULT.AC],
      [1200, 1, 0, RESULT.AC],
      [1800, 1, 1, RESULT.AC],
      [300, 2, 0, RESULT.AC],
    ],
  });
  const { state, stats } = replay(timeline, 9999);
  const board = computeBoard(state, 9999, stats);
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
  const { state, stats } = replay(timeline, 9999);
  const board = computeBoard(state, 9999, stats);
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
      [600, 1, 0, RESULT.AC],
      [1200, 0, 0, RESULT.AC],
    ],
  });
  const { state, stats } = replay(timeline, 9999);
  const board = computeBoard(state, 9999, stats);
  assert.equal(board.officialTeams, 1);
  assert.equal(board.rows[0].teamIdx, 0, 'official teams come first');
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[1].teamIdx, 1);
  assert.equal(board.rows[1].rank, 0, 'unofficial rows carry no rank');
});

test('an unsolved board is all zeroes and still rankable', () => {
  const timeline = makeTimeline({ teams: 2, problems: 1, events: [] });
  const { state, stats } = replay(timeline, 100);
  const board = computeBoard(state, 100, stats);
  assert.equal(board.rows.length, 2);
  assert.ok(board.rows.every((row) => row.solved === 0 && row.penalty === 0));
  assert.deepEqual(board.rows.map((row) => row.rank), [1, 1]);
});

// ------------------------------------------------------- reveal (rule 1)

test('a problem is revealed exactly when the live count reaches the threshold', () => {
  // 10 teams -> floor(2) = 2, capped by min(.,50) => threshold 2.
  const timeline = makeTimeline({
    teams: 10,
    problems: 2,
    events: [
      [100, 0, 0, RESULT.AC],
      [200, 1, 0, RESULT.AC], // count 2 -> revealed at 200
      [300, 2, 1, RESULT.AC], // problem B only ever has one solver
    ],
  });

  assert.equal(problemStatus(replayTo(timeline, 100).state, 100).revealed[0], false);
  assert.equal(problemStatus(replayTo(timeline, 199).state, 199).revealed[0], false);
  assert.equal(problemStatus(replayTo(timeline, 200).state, 200).revealed[0], true);
  assert.equal(problemStatus(replayTo(timeline, 9999).state, 9999).revealed[1], false,
    'problem B never reaches the threshold');
});

test('an unrevealed problem keeps its alias hidden in cellInfo', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 2,
    events: [[100, 0, 0, RESULT.AC]],
  });
  const { state, stats } = replay(timeline, 200);
  assert.equal(cellInfo(state, 0, 0, stats, 200).alias, null, 'only 1 solve, threshold 2');
  assert.equal(cellInfo(state, 0, 1, stats, 200).alias, null);
});

test('after enough solves the alias becomes visible', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.AC],
      [200, 1, 0, RESULT.AC],
    ],
  });
  const { state, stats } = replay(timeline, 9999);
  const info = cellInfo(state, 0, 0, stats, 9999);
  assert.equal(info.alias, 'A');
  assert.equal(info.revealed, true);
  assert.equal(info.solved, true);
});

test('the official scope ignores unofficial solvers', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    official: [true, false, false, false, false, false, false, false, false, false],
    events: [
      [100, 1, 0, RESULT.AC],
      [200, 2, 0, RESULT.AC],
      [300, 3, 0, RESULT.AC],
    ],
  });

  const asAll = replay(timeline, 9999, { revealScope: 'all' });
  assert.equal(asAll.stats.solved[0], 3);
  assert.ok(asAll.stats.revealed[0], '3 >= min(floor(10*.2),50) = 2');

  // Only one team is official, so the population is 1 and the threshold is 0
  // while the *count* excludes the unofficial solvers.
  const asOfficial = replay(timeline, 9999, { revealScope: 'official' });
  assert.equal(asOfficial.stats.teamsRanked, 1);
  assert.equal(asOfficial.stats.solved[0], 0, 'unofficial solves are not counted');
});

// ------------------------------------- header order (rule 5, live counts)

test('the header orders problems by live solve count, ties by number', () => {
  const timeline = makeTimeline({
    teams: 30,
    problems: 3,
    events: [
      // P0 gets 2 solvers, P1 gets 5, P2 gets 1
      [10, 0, 0, RESULT.AC], [11, 1, 0, RESULT.AC],
      [12, 0, 1, RESULT.AC], [13, 1, 1, RESULT.AC], [14, 2, 1, RESULT.AC],
      [15, 3, 1, RESULT.AC], [16, 4, 1, RESULT.AC],
      [17, 0, 2, RESULT.AC],
    ],
  });
  const { stats } = replay(timeline, 9999);
  assert.deepEqual(stats.solved, [2, 5, 1]);
  assert.deepEqual(stats.order, [1, 0, 2], 'P1 (5) > P0 (2) > P2 (1)');
});

test('the header order is stable for equal counts', () => {
  const timeline = makeTimeline({
    teams: 30,
    problems: 3,
    events: [
      [10, 0, 2, RESULT.AC],
      [11, 0, 0, RESULT.AC],
      [12, 0, 1, RESULT.AC],
    ],
  });
  const { stats } = replay(timeline, 9999);
  assert.deepEqual(stats.solved, [1, 1, 1]);
  assert.deepEqual(stats.order, [0, 1, 2], 'ties fall back to problem number');
});

test('the header re-sorts as counts change over time', () => {
  const timeline = makeTimeline({
    teams: 30,
    problems: 2,
    events: [
      [100, 0, 0, RESULT.AC], // P0 leads early
      [200, 0, 1, RESULT.AC],
      [300, 1, 1, RESULT.AC],
      [400, 2, 1, RESULT.AC], // P1 now leads
    ],
  });
  assert.deepEqual(problemStatus(replayTo(timeline, 150).state, 150).order, [0, 1]);
  assert.deepEqual(problemStatus(replayTo(timeline, 450).state, 450).order, [1, 0]);
});

// ------------------------------------------------ column ordering (rule 3)

test('columnOrder applies the four buckets in order', () => {
  // 10 teams => threshold 2, so P0+P1 need two solvers each to be revealed.
  const timeline = makeTimeline({
    teams: 10,
    problems: 5,
    events: [
      // reveal P0 and P1
      [10, 5, 0, RESULT.AC], [11, 6, 0, RESULT.AC],
      [12, 5, 1, RESULT.AC], [13, 6, 1, RESULT.AC],
      // team 0's own history
      [300, 0, 2, RESULT.AC],  // hidden solve
      [800, 0, 3, RESULT.WA],  // hidden attempt
      [1000, 0, 0, RESULT.AC], // revealed solve
    ],
  });
  const { state, stats } = replay(timeline, 2000);
  const order = columnOrder(state, 0, 2000, stats.aliasRevealed);
  // bucket 1 (revealed 0,1) -> 0,1 ; bucket 2 (hidden solve) -> 2 ;
  // bucket 3 (hidden attempt) -> 3 ; bucket 4 (untouched) -> 4
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('columnOrder puts revealed problems first even if solved later', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 3,
    events: [
      [10, 5, 0, RESULT.AC], [11, 6, 0, RESULT.AC], // reveal P0
      [100, 0, 1, RESULT.AC], // hidden solve, early
      [200, 0, 2, RESULT.AC], // hidden solve, later
      [9000, 0, 0, RESULT.AC], // revealed, solved last
    ],
  });
  const { state, stats } = replay(timeline, 9999);
  const order = columnOrder(state, 0, 9999, stats.aliasRevealed);
  assert.deepEqual(order, [0, 1, 2], 'revealed bucket (P0) wins despite the later solve');
});

test('columnOrder sorts hidden solves by AC time ascending', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 3,
    events: [
      [500, 0, 2, RESULT.AC],
      [100, 0, 0, RESULT.AC],
      [300, 0, 1, RESULT.AC],
    ],
  });
  const { state, stats } = replay(timeline, 9999);
  assert.deepEqual(columnOrder(state, 0, 9999, stats.aliasRevealed), [0, 1, 2], 'P0 100, P1 300, P2 500');
});

test('columnOrder sorts un-solved attempts by latest submission ascending', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 3,
    events: [
      [900, 0, 0, RESULT.WA],
      [100, 0, 1, RESULT.WA],
      [500, 0, 2, RESULT.WA],
    ],
  });
  const { state, stats } = replay(timeline, 9999);
  assert.deepEqual(columnOrder(state, 0, 9999, stats.aliasRevealed), [1, 2, 0], 'P1 100, P2 500, P0 900');
});

test('columnOrder puts never-submitted problems last, by problem number', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 4,
    events: [[100, 0, 3, RESULT.WA]],
  });
  const { state, stats } = replay(timeline, 9999);
  assert.deepEqual(columnOrder(state, 0, 9999, stats.aliasRevealed), [3, 0, 1, 2]);
});

test('columnOrder uses the legacy fallback attempt counts', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 2,
    events: [],
    triesFallback: [[0, 5]],
  });
  const { state, stats } = replay(timeline, 100);
  const order = columnOrder(state, 0, 100, stats.aliasRevealed, {
    triesFallback: timeline.triesFallback,
  });
  assert.deepEqual(order, [1, 0], 'P1 has attempts, so it precedes untouched P0');
});

test('column order changes over time as a problem is revealed', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 2,
    events: [
      [100, 0, 1, RESULT.AC], // hidden solve
      [200, 5, 0, RESULT.AC], [300, 6, 0, RESULT.AC], // reveal P0 at 300
      [400, 0, 0, RESULT.AC],
    ],
  });
  const before = replay(timeline, 250);
  assert.deepEqual(columnOrder(before.state, 0, 250, before.stats.aliasRevealed), [1, 0], 'P0 still hidden');

  const after = replay(timeline, 9999);
  assert.deepEqual(columnOrder(after.state, 0, 9999, after.stats.aliasRevealed), [0, 1], 'P0 revealed, takes slot 1');
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
    const fast = epoch.frameAt(tSec);
    const exact = frameAt(timeline, tSec);
    assert.deepEqual(
      fast.rows.map((row) => [row.teamIdx, row.solved, row.penalty, row.rank]),
      exact.rows.map((row) => [row.teamIdx, row.solved, row.penalty, row.rank]),
      `frame at ${tSec}s matches a from-scratch replay`,
    );
    assert.deepEqual(fast.stats.solved, exact.stats.solved, `counts at ${tSec}s match`);
    assert.deepEqual(fast.stats.order, exact.stats.order, `order at ${tSec}s matches`);
  }
});

test('createEpochReplay keeps solve counts correct when seeking backwards', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.AC],
      [200, 1, 0, RESULT.AC],
      [300, 2, 0, RESULT.AC],
      [400, 3, 0, RESULT.AC],
    ],
  });
  const epoch = createEpochReplay(timeline, { snapshotIntervalSec: 100 });
  assert.equal(epoch.frameAt(450).stats.solved[0], 4);
  assert.equal(epoch.frameAt(250).stats.solved[0], 2, 'rewind drops later solvers');
  assert.equal(epoch.frameAt(50).stats.solved[0], 0);
  assert.equal(epoch.frameAt(350).stats.solved[0], 3, 're-advance restores them');
});

test('reveal flips on within one epoch replay as counts cross the threshold', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    events: [[100, 0, 0, RESULT.AC], [500, 1, 0, RESULT.AC]],
  });
  const epoch = createEpochReplay(timeline);
  assert.equal(epoch.frameAt(200).stats.revealed[0], false);
  assert.equal(epoch.frameAt(600).stats.revealed[0], true);
});

// ------------------------------------------------------------- freeze

test('resolveFreeze clips the board once the freeze starts', () => {
  const params = { durationSec: 18000, freezeDurationSec: 3600 };
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

test('resolveFreeze with reveal unlocks the true board', () => {
  const result = resolveFreeze({
    contestSec: 18000, durationSec: 18000, freezeDurationSec: 3600, revealed: true,
  });
  assert.equal(result.visibleSec, 18000);
  assert.equal(result.frozen, false);
});

test('resolveFreeze never freezes when the mode is never', () => {
  const result = resolveFreeze({
    contestSec: 15000, durationSec: 18000, freezeDurationSec: 3600, freezeEnabled: false,
  });
  assert.equal(result.visibleSec, 15000);
  assert.equal(result.frozen, false);
  assert.equal(result.frozenAtSec, null);
});

test('resolveFreeze is a no-op for contests without a freeze window', () => {
  const result = resolveFreeze({
    contestSec: 15000, durationSec: 18000, freezeDurationSec: 0,
  });
  assert.equal(result.visibleSec, 15000);
  assert.equal(result.frozen, false);
});

test('resolveFreeze clamps beyond the contest duration', () => {
  const result = resolveFreeze({
    contestSec: 99999, durationSec: 18000, freezeDurationSec: 0,
  });
  assert.equal(result.visibleSec, 18000);
});

test('a freeze can be requested for a contest that declares none', () => {
  // The ranklist says no freeze, but the VP explicitly asks for the last hour.
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    durationSec: 18000,
    frozenDurationSec: 0,
    events: [],
  });
  const t0 = 1_000_000_000_000;

  const off = createSession(timeline, { startAt: t0, now: t0 });
  assert.equal(off.freezeEnabled, false, 'a declared zero freeze stays off by default');
  assert.equal(off.update(t0 + 15_000_000).frozen, false);

  const on = createSession(timeline, {
    startAt: t0, now: t0, freezeEnabled: true, freezeMinutes: 60,
  });
  const frozen = on.update(t0 + 15_000_000);
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.visibleSec, 14400, 'the explicit hour applies');
});

test('an undeclared freeze length falls back to the 60-minute convention', () => {
  const timeline = makeTimeline({
    teams: 10, problems: 1, durationSec: 18000, frozenDurationSec: 3600, events: [],
  });
  // Drop the declared length entirely: the 60-minute convention takes over.
  delete timeline.contest.frozenDurationSec;
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });
  assert.equal(session.freezeDurationSec, DEFAULT_FREEZE_MINUTES * 60);
  assert.equal(session.freezeEnabled, true);
  assert.equal(session.update(t0 + 15_000_000).frozen, true);
});

test('the declared freeze length is adopted when present', () => {
  const timeline = makeTimeline({
    teams: 10, problems: 1, durationSec: 18000, frozenDurationSec: 1800, events: [],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });
  assert.equal(session.freezeDurationSec, 1800);
  // A 30-minute freeze starts at 16200, so 15000 is still live.
  assert.equal(session.update(t0 + 15_000_000).frozen, false);
  assert.equal(session.update(t0 + 15_000_000).visibleSec, 15000);
  const frozen = session.update(t0 + 16_300_000);
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.visibleSec, 16200);
});

test('the freeze length can be changed mid-VP', () => {
  const timeline = makeTimeline({
    teams: 10, problems: 1, durationSec: 18000, frozenDurationSec: 3600, events: [],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });
  assert.equal(session.update(t0 + 16_000_000).visibleSec, 14400);
  session.setFreezeMinutes(120, t0 + 16_000_000);
  assert.equal(session.update(t0 + 16_000_000).visibleSec, 10800);
  session.setFreezeEnabled(false, t0 + 16_000_000);
  const live = session.update(t0 + 16_000_000);
  assert.equal(live.frozen, false);
  assert.equal(live.visibleSec, 16000);
});

test('the freeze length accepts ordinary round numbers', () => {
  // Regression: a `step="5"` attribute on the number input made 60 awkward to
  // pick. The model must accept any minute count, including 60 exactly.
  const timeline = makeTimeline({
    teams: 10, problems: 1, durationSec: 18000, frozenDurationSec: 3600, events: [],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  for (const minutes of [60, 56, 61, 1, 90, 600]) {
    session.setFreezeMinutes(minutes, t0 + 16_000_000);
    assert.equal(session.freezeDurationSec, minutes * 60, `${minutes} minutes is stored exactly`);
  }

  session.setFreezeMinutes(60, t0 + 16_000_000);
  assert.equal(session.freezeDurationSec, 3600);
  assert.equal(session.update(t0 + 16_000_000).visibleSec, 14400, 'freeze starts at 14400');
});

test('a zero or negative freeze length disables the freeze', () => {
  const timeline = makeTimeline({
    teams: 10, problems: 1, durationSec: 18000, frozenDurationSec: 3600, events: [],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });
  session.setFreezeMinutes(0, t0 + 16_000_000);
  assert.equal(session.freezeDurationSec, 0);
  assert.equal(session.update(t0 + 16_000_000).frozen, false);
});

// ------------------------------------------------- live submit counts

test('problemStatus reports distinct submitting teams as well as solvers', () => {
  const timeline = makeTimeline({
    teams: 30,
    problems: 2,
    events: [
      // P0: 3 submitters, 2 solvers
      [10, 0, 0, RESULT.WA], [11, 1, 0, RESULT.AC], [12, 2, 0, RESULT.AC],
      // P1: 1 submitter, 0 solvers
      [13, 3, 1, RESULT.TLE],
    ],
  });
  const { stats } = replay(timeline, 9999);
  assert.deepEqual(stats.solved, [2, 0]);
  assert.deepEqual(stats.submitted, [3, 1]);
});

test('repeated submissions by one team count once towards the submitted total', () => {
  const timeline = makeTimeline({
    teams: 30,
    problems: 1,
    events: [
      [10, 0, 0, RESULT.WA],
      [20, 0, 0, RESULT.WA],
      [30, 0, 0, RESULT.WA],
    ],
  });
  const { stats } = replay(timeline, 9999);
  assert.equal(stats.submitted[0], 1, 'one distinct submitting team');
  assert.equal(stats.solved[0], 0);
});

test('submitted counts follow the reveal scope', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    official: [true, false, false, false, false, false, false, false, false, false],
    events: [[10, 1, 0, RESULT.WA], [20, 2, 0, RESULT.WA]],
  });
  assert.equal(replay(timeline, 9999, { revealScope: 'all' }).stats.submitted[0], 2);
  assert.equal(replay(timeline, 9999, { revealScope: 'official' }).stats.submitted[0], 0);
});

test('submitted counts rewind correctly when seeking backwards', () => {
  const timeline = makeTimeline({
    teams: 30,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.WA],
      [200, 1, 0, RESULT.WA],
      [300, 2, 0, RESULT.WA],
    ],
  });
  const epoch = createEpochReplay(timeline, { snapshotIntervalSec: 100 });
  assert.equal(epoch.frameAt(350).stats.submitted[0], 3);
  assert.equal(epoch.frameAt(150).stats.submitted[0], 1, 'rewound');
  assert.equal(epoch.frameAt(250).stats.submitted[0], 2);
});

// ------------------------------------------------------------- session

test('session goes through countdown, running, frozen and revealed', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    durationSec: 18000,
    frozenDurationSec: 3600,
    events: [[600, 0, 0, RESULT.AC]],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0 + 10_000, now: t0 });

  assert.equal(session.update(t0).phase, PHASE.PENDING);
  assert.equal(session.update(t0 + 20_000).phase, PHASE.RUNNING);

  const frozen = session.update(t0 + 10_000 + 15_000_000);
  assert.equal(frozen.phase, PHASE.FROZEN);
  assert.equal(frozen.visibleSec, 14400, 'board is pinned to the freeze second');
  assert.ok(frozen.contestSec > 14400, 'the real clock keeps running while frozen');

  const end = session.update(t0 + 10_000 + 18_000_000);
  assert.equal(end.phase, PHASE.ENDED);
  assert.equal(end.revealed, true, 'the freeze lifts automatically at the end');
  assert.equal(end.visibleSec, 18000);
});

test('a frozen board keeps its clock and progress running', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 2,
    durationSec: 18000,
    frozenDurationSec: 3600, // freezes at 14400
    events: [[600, 0, 0, RESULT.AC], [15000, 0, 1, RESULT.AC]],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  const early = session.update(t0 + 15_000_000);
  assert.equal(early.frozen, true);
  assert.equal(early.boardSec, 14400, 'board contents held at the freeze second');
  assert.equal(early.contestSec, 15000, 'the contest clock keeps running');

  const later = session.update(t0 + 17_000_000);
  assert.equal(later.frozen, true);
  assert.equal(later.boardSec, 14400, 'still frozen');
  assert.equal(later.contestSec, 17000, 'and the clock advanced');

  // The board contents must not change while frozen...
  assert.equal(early.rows[0].solved, later.rows[0].solved);
  // ...but once unfrozen they catch up.
  const ended = session.update(t0 + 18_100_000);
  assert.equal(ended.frozen, false);
  assert.equal(ended.boardSec, 18000);
  assert.equal(ended.rows[0].solved, 2);
});

test('a frozen session stops reflecting new events, and unfreezing reveals them', () => {
  const timeline = makeTimeline({
    teams: 10,
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
  assert.equal(revealed.revealed, true);
  assert.equal(revealed.rows[0].solved, 2, 'unfreezing exposes the real result');

  const refrozen = session.unreveal(t0 + 16_000_000);
  assert.equal(refrozen.frozen, true);
  assert.equal(refrozen.rows[0].solved, 1, 'and it can be frozen again');
});

test('freeze mode never keeps the board live to the end', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 2,
    durationSec: 18000,
    frozenDurationSec: 3600,
    events: [[600, 0, 0, RESULT.AC], [15000, 0, 1, RESULT.AC]],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0, freezeEnabled: false });
  const frame = session.update(t0 + 16_000_000);
  assert.equal(frame.frozen, false);
  assert.equal(frame.visibleSec, 16000);
  assert.equal(frame.rows[0].solved, 2);
});

test('a whole contest freezes, holds, then fully unfreezes at the end', () => {
  // 20 teams => threshold min(floor(20*0.2), 50) = 4.
  const timeline = makeTimeline({
    teams: 20,
    problems: 3,
    durationSec: 18000,
    frozenDurationSec: 3600, // freezes at 14400
    events: [
      // Problem A: 4 solvers before the freeze point -> revealed while frozen
      [100, 0, 0, RESULT.AC],
      [200, 1, 0, RESULT.AC],
      [300, 2, 0, RESULT.AC],
      [14390, 3, 0, RESULT.AC],
      // Problem B: only reaches the threshold AFTER the freeze
      [15000, 4, 1, RESULT.AC],
      [15100, 5, 1, RESULT.AC],
      [15200, 6, 1, RESULT.AC],
      [15300, 7, 1, RESULT.AC],
      // Problem C: never reaches it
      [16000, 8, 2, RESULT.AC],
    ],
  });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  // Just before the freeze: live, A revealed, B/C hidden.
  const before = session.update(t0 + 14399 * 1000);
  assert.equal(before.phase, PHASE.RUNNING);
  assert.equal(before.frozen, false);
  assert.deepEqual(before.stats.revealed, [true, false, false]);

  // Inside the freeze window: pinned, and the later solves are invisible.
  const frozen = session.update(t0 + 16000 * 1000);
  assert.equal(frozen.phase, PHASE.FROZEN);
  assert.equal(frozen.visibleSec, 14400);
  assert.equal(frozen.revealed, false, 'not unfrozen yet');
  assert.deepEqual(frozen.stats.solved, [4, 0, 0], 'post-freeze solves are hidden');
  assert.deepEqual(frozen.stats.revealed, [true, false, false]);

  // Past the end: the freeze lifts by itself and everything is visible.
  const ended = session.update(t0 + 18001 * 1000);
  assert.equal(ended.phase, PHASE.ENDED);
  assert.equal(ended.frozen, false);
  assert.equal(ended.revealed, true);
  assert.equal(ended.visibleSec, 18000);
  assert.deepEqual(ended.stats.solved, [4, 4, 1], 'the true final counts');
  assert.deepEqual(ended.stats.revealed, [true, true, false], 'B reveals, C never does');
});

test('session pause and resume preserve the contest second', () => {
  const timeline = makeTimeline({ teams: 2, problems: 1, events: [] });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  assert.equal(session.update(t0 + 600_000).contestSec, 600);
  session.pause(t0 + 600_000);
  assert.equal(session.update(t0 + 900_000).contestSec, 600, 'paused clock does not advance');
  session.resume(t0 + 900_000);
  assert.equal(session.update(t0 + 910_000).contestSec, 610, 'resumes from where it stopped');
});

test('session speed changes keep the current contest second', () => {
  const timeline = makeTimeline({ teams: 2, problems: 1, events: [] });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  session.update(t0 + 600_000);
  session.setSpeed(60);
  assert.equal(session.update(t0 + 600_000).contestSec, 600);
  assert.equal(session.update(t0 + 610_000).contestSec, 1200, '10s wall = 600 contest seconds');
});

test('session seek detaches and followLive rejoins', () => {
  const timeline = makeTimeline({ teams: 2, problems: 1, events: [] });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });

  session.seek(5000, t0 + 100_000);
  assert.equal(session.update(t0 + 200_000).contestSec, 5000, 'detached clock is stable');
  session.followLive(t0 + 200_000);
  assert.equal(session.update(t0 + 205_000).contestSec, 5005, 'rejoined at the same second');
});

test('session clamps seek to the contest duration', () => {
  const timeline = makeTimeline({ teams: 1, problems: 1, events: [], durationSec: 1000 });
  const t0 = 1_000_000_000_000;
  const session = createSession(timeline, { startAt: t0, now: t0 });
  assert.equal(session.seek(99999, t0).visibleSec, 1000);
  assert.equal(session.seek(-5, t0).visibleSec, 0);
});

test('session switching reveal scope changes the counted population', () => {
  const timeline = makeTimeline({
    teams: 10,
    problems: 1,
    official: [true, false, false, false, false, false, false, false, false, false],
    events: [[100, 1, 0, RESULT.AC], [200, 2, 0, RESULT.AC]],
  });
  const t0 = 1_000_000_000_000;
  const at = t0 + 1000 * 1000; // 1000 contest seconds in
  const session = createSession(timeline, { startAt: t0, now: t0, revealScope: 'all' });
  assert.equal(session.update(at).contestSec, 1000, 'the clock is in seconds, not ms');
  assert.equal(session.update(at).stats.solved[0], 2, 'both solvers counted');
  session.setRevealScope('official', at);
  assert.equal(session.update(at).stats.solved[0], 0, 'unofficial solvers excluded');
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

test('BUCKET ordering matches the documented priority', () => {
  assert.ok(BUCKET.REVEALED < BUCKET.SOLVED_HIDDEN);
  assert.ok(BUCKET.SOLVED_HIDDEN < BUCKET.ATTEMPTED_HIDDEN);
  assert.ok(BUCKET.ATTEMPTED_HIDDEN < BUCKET.UNTOUCHED);
});

// ------------------------------------------- shared column order (rule 1)

test('every row uses the header order, so a column means one problem', () => {
  // 30 teams => threshold min(floor(30*0.2), 50) = 6.
  const timeline = makeTimeline({
    teams: 30,
    problems: 3,
    events: [
      // P1 gets 6 solvers (revealed, leads), P0 gets 6 (revealed), P2 gets none.
      [10, 0, 1, RESULT.AC], [11, 1, 1, RESULT.AC], [12, 2, 1, RESULT.AC],
      [13, 3, 1, RESULT.AC], [14, 4, 1, RESULT.AC], [15, 5, 1, RESULT.AC],
      [20, 0, 0, RESULT.AC], [21, 1, 0, RESULT.AC], [22, 2, 0, RESULT.AC],
      [23, 3, 0, RESULT.AC], [24, 4, 0, RESULT.AC], [25, 5, 0, RESULT.AC],
      // Two teams have wildly different personal histories.
      [30, 10, 2, RESULT.WA],
      [31, 10, 1, RESULT.AC],
    ],
  });
  const { state, stats } = replay(timeline, 9999);
  const board = computeBoard(state, 9999, stats);

  assert.deepEqual(stats.order, [0, 1, 2].sort((a, b) => stats.solved[b] - stats.solved[a] || a - b));

  const reference = board.rows[0].columns;
  const sameOrder = board.rows.every((row) => row.columns === reference
    || JSON.stringify(row.columns) === JSON.stringify(reference));
  assert.ok(sameOrder, 'all rows share one column order');
  assert.deepEqual(reference, stats.order, 'and that order is the header order');

  // The two teams with different histories still render into the same columns.
  const byTeam = new Map(board.rows.map((row) => [row.teamIdx, row]));
  assert.deepEqual(byTeam.get(10).columns, reference);
  assert.deepEqual(byTeam.get(0).columns, reference);
});

test('sharedColumnOrder returns a copy so callers cannot corrupt the header', () => {
  const order = [2, 0, 1];
  const copy = sharedColumnOrder(order);
  copy.reverse();
  assert.deepEqual(order, [2, 0, 1], 'the source order is untouched');
});

// ------------------------------------------------------- medals (rule 8)

test('medalBands uses the ICPC 10/20/30 ratios when counts are placeholders', () => {
  const timeline = {
    awards: {
      segments: [
        { style: 'gold', title: 'Gold Award' },
        { style: 'silver', title: 'Silver Award' },
        { style: 'bronze', title: 'Bronze Award' },
      ],
      counts: [0, 0, 0],
      ratios: null,
    },
  };
  const bands = medalBands(timeline, 100);
  assert.equal(bands.source, 'default');
  // Contiguous bands covering the top 10% / 20% / 30%.
  assert.deepEqual(bands.limits, [10, 30, 60]);
  assert.deepEqual(bands.medals.map((m) => m.count), [10, 20, 30]);
});

test('medalBands honours explicitly declared counts', () => {
  const timeline = {
    awards: {
      segments: [{ style: 'gold' }, { style: 'silver' }, { style: 'bronze' }],
      counts: [5, 10, 20],
      ratios: null,
    },
  };
  const bands = medalBands(timeline, 999);
  assert.equal(bands.source, 'declared');
  assert.deepEqual(bands.limits, [5, 15, 35]);
  assert.deepEqual(bands.medals.map((m) => m.count), [5, 10, 20]);
});

test('medalBands scales with the live ranked-team count', () => {
  const timeline = {
    awards: { segments: [{ style: 'gold' }, { style: 'silver' }, { style: 'bronze' }], counts: [0, 0, 0] },
  };
  assert.deepEqual(medalBands(timeline, 10).limits, [1, 3, 6]);
  assert.deepEqual(medalBands(timeline, 1000).limits, [100, 300, 600]);
  assert.equal(medalBands(timeline, 0), null, 'no ranked teams, no awards');
});

test('medalFor maps a rank to its band and skips unranked rows', () => {
  const bands = medalBands({
    awards: {
      segments: [{ style: 'gold' }, { style: 'silver' }, { style: 'bronze' }],
      counts: [2, 3, 5],
    },
  }, 100);

  assert.equal(medalFor(bands, 1, true), 'gold');
  assert.equal(medalFor(bands, 2, true), 'gold');
  assert.equal(medalFor(bands, 3, true), 'silver');
  assert.equal(medalFor(bands, 5, true), 'silver');
  assert.equal(medalFor(bands, 6, true), 'bronze');
  assert.equal(medalFor(bands, 10, true), 'bronze');
  assert.equal(medalFor(bands, 11, true), null, 'past the last band');
  assert.equal(medalFor(bands, 1, false), null, 'unofficial teams get nothing');
  assert.equal(medalFor(bands, 0, true), null, 'unranked');
  assert.equal(medalFor(null, 1, true), null);
});

test('computeBoard attaches a medal to official rows only', () => {
  const timeline = makeTimeline({
    teams: 20,
    problems: 1,
    // Team 1 is unofficial and solves first.
    official: [true, false, true, true, true, true, true, true, true, true,
      true, true, true, true, true, true, true, true, true, true],
    events: [
      [10, 1, 0, RESULT.AC],
      [20, 0, 0, RESULT.AC],
      [30, 2, 0, RESULT.AC],
    ],
  });
  timeline.awards = {
    segments: [{ style: 'gold' }, { style: 'silver' }, { style: 'bronze' }],
    counts: [1, 1, 1],
  };

  const { state, stats } = replay(timeline, 9999);
  const officialTeams = 19;
  const board = computeBoard(state, 9999, stats, {
    medals: medalBands(timeline, officialTeams),
  });

  // 19 official teams with default ratios => gold ends at floor(19 * 10%) = 1.
  const bands = medalBands(timeline, officialTeams);
  assert.equal(bands.limits[0], 1);

  // Teams 0 and 2 are both rank 1 (the unofficial team in between is not
  // ranked and scores identically), so both are in the gold band.
  const gold = board.rows.filter((row) => row.medal === 'gold');
  assert.equal(gold.length, 2, 'both tied rank-1 official teams are gold');
  assert.ok(gold.every((row) => row.official), 'gold only ever goes to official teams');
  assert.ok(gold.every((row) => row.rank === 1));
  assert.ok(board.rows.filter((row) => !row.official).every((row) => row.medal === null));
});

test('computeBoard leaves medals null when the ranklist declares none', () => {
  const timeline = makeTimeline({ teams: 5, problems: 1, events: [[10, 0, 0, RESULT.AC]] });
  const { state, stats } = replay(timeline, 9999);
  const board = computeBoard(state, 9999, stats);
  assert.ok(board.rows.every((row) => row.medal === null));
});
