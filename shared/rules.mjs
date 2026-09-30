/**
 * CCPC "new ranklist" rules, implemented as pure functions.
 *
 * This module is the single authority for:
 *   1. the problem-alias reveal threshold and its exact reveal moment,
 *   2. the row-header order (descending by how many teams solved each problem),
 *   3. per-team column ordering,
 *   4. ICPC scoring (accepted count + penalty) under the new rules,
 *   5. final ranking.
 *
 * Everything here is isomorphic: it runs in Node for tests and in the browser
 * for the live board. It never touches the DOM or the network.
 *
 * See docs/rules.md for the mapping between these functions and the published
 * rule text.
 */

import { isAccepted } from './srk.mjs';

/** Default reveal constants from the CCPC new ranklist rules. */
export const REVEAL_RATIO = 0.2;
export const REVEAL_MIN = 50;

/**
 * The alias of a problem is revealed once the number of distinct teams that
 * solved it reaches `threshold`.
 *
 * NOTE ON THE FORMULA: the rule is the *smaller* of "floor(20% of the ranked
 * teams)" and 50 — i.e. the 50-team figure is an upper bound that keeps small
 * contests from never revealing anything, while a hypothetically huge field
 * still reveals at 50 solves. An earlier revision of this tool used `max`,
 * which was wrong.
 */
export function revealThreshold(teamsRanked, ratio = REVEAL_RATIO, min = REVEAL_MIN) {
  // The outer max(1, ...) is a practical floor: with fewer than 10 ranked teams
  // floor(20%) is 0, and a threshold of 0 would mean "revealed before anyone
  // solved it". A problem always needs at least one solver.
  return Math.max(1, Math.min(Math.floor(teamsRanked * ratio), min));
}

/** Sort buckets for a team's problem columns (see docs/rules.md rule 3). */
export const BUCKET = Object.freeze({
  REVEALED: 0,
  SOLVED_HIDDEN: 1,
  ATTEMPTED_HIDDEN: 2,
  UNTOUCHED: 3,
});

/**
 * Counts, per problem, how many distinct counted teams have solved it and how
 * many have submitted to it.
 *
 * Both counters are needed live: the reveal rule uses the solve count, and the
 * board header shows "accepted / submitted" as of the displayed second.
 *
 * The counters are maintained incrementally during replay (see `applyEvent`)
 * and restored from snapshots when seeking, so they always describe the
 * displayed moment rather than the published final figures.
 */
export class CountedSolves {
  /**
   * @param {number} problemCount
   * @param {boolean[]} [counted] which teams participate in counting
   */
  constructor(problemCount, counted = null) {
    this.counted = counted ?? null;
    this.perProblem = new Int32Array(problemCount);
    this.subPerProblem = new Int32Array(problemCount);
  }

  /** Whether a team contributes to the counters. */
  includes(teamIdx) {
    return this.counted === null || this.counted[teamIdx] === true;
  }

  /** Record a first solve. Returns true when it changed the counter. */
  add(teamIdx, probIdx) {
    if (!this.includes(teamIdx)) return false;
    this.perProblem[probIdx] += 1;
    return true;
  }

  /** Record a team's first submission to a problem. */
  addSubmission(teamIdx, probIdx) {
    if (!this.includes(teamIdx)) return false;
    this.subPerProblem[probIdx] += 1;
    return true;
  }

  /** Number of counted solving teams for one problem. */
  count(probIdx) {
    return this.perProblem[probIdx];
  }

  /** Number of counted submitting teams for one problem. */
  submittedCount(probIdx) {
    return this.subPerProblem[probIdx];
  }

  clone() {
    const copy = new CountedSolves(this.perProblem.length, this.counted);
    copy.perProblem.set(this.perProblem);
    copy.subPerProblem.set(this.subPerProblem);
    return copy;
  }
}

/**
 * Create the initial replay state for a timeline.
 *
 * @param {object} timeline wire timeline
 * @param {object} [options]
 * @param {'all'|'official'} [options.revealScope] teams counted for reveal
 */
export function createState(timeline, options = {}) {
  const teamCount = timeline.teams.length;
  const problemCount = timeline.problems.length;
  const sorter = timeline.sorter ?? {};

  const scope = options.revealScope ?? 'all';
  const counted = scope === 'official'
    ? timeline.teams.map((team) => team.official !== false)
    : null;

  return {
    timeline,
    teamCount,
    problemCount,
    penaltySec: sorter.penaltySec ?? 20 * 60,
    noPenaltyCodes: new Set(sorter.noPenaltyCodes ?? []),
    timePrecision: sorter.timePrecision ?? null,
    revealScope: scope,

    solved: new Int32Array(teamCount),
    penalty: new Float64Array(teamCount),
    lastAc: new Int32Array(teamCount),

    /** @type {Int32Array} AC timestamp per team*problem, -1 when unsolved */
    acAt: new Int32Array(teamCount * problemCount).fill(-1),
    /** @type {Int32Array} number of penalty-bearing submissions before the AC */
    fails: new Int32Array(teamCount * problemCount),
    /** @type {Int32Array} submissions seen so far (pre-AC only) */
    subs: new Int32Array(teamCount * problemCount),
    /** @type {Int32Array} contest second of the latest pre-AC submission, -1 if none */
    lastSub: new Int32Array(teamCount * problemCount).fill(-1),

    /** live "distinct solving teams per problem" counter for the reveal rule */
    counted: new CountedSolves(problemCount, counted),
  };
}

/** Apply a single `[tSec, teamIdx, probIdx, code]` event to the state. */
export function applyEvent(state, event) {
  const tSec = event[0];
  const teamIdx = event[1];
  const probIdx = event[2];
  const code = event[3];
  const key = teamIdx * state.problemCount + probIdx;

  // Rule: once a team has AC'd a problem, all further submissions to it are
  // ignored entirely — they neither count as tries nor move the "latest
  // submission" used for column ordering.
  if (state.acAt[key] !== -1) return false;

  const firstSubmission = state.subs[key] === 0;
  state.subs[key] += 1;
  state.lastSub[key] = tSec;
  // Count distinct submitting teams per problem for the header's totals.
  if (firstSubmission) state.counted.addSubmission(teamIdx, probIdx);

  if (isAccepted(code)) {
    state.acAt[key] = tSec;
    state.solved[teamIdx] += 1;
    state.penalty[teamIdx] += floorToPrecision(tSec, state.timePrecision)
      + state.fails[key] * state.penaltySec;
    if (tSec > state.lastAc[teamIdx]) state.lastAc[teamIdx] = tSec;
    // First solve for this team/problem: feed the reveal counter.
    state.counted.add(teamIdx, probIdx);
    return true;
  }

  if (!state.noPenaltyCodes.has(code)) {
    state.fails[key] += 1;
  }
  return false;
}

/**
 * Replay every event with `tSec <= limitSec`, returning fresh state.
 *
 * @param {object} timeline
 * @param {number} limitSec
 * @param {object} [options]
 * @param {object} [options.state] reuse this state instead of allocating
 * @param {number} [options.fromIndex] index of the first event to apply
 * @param {number} [options.fromSec] contest second already reflected by `state`
 * @param {'all'|'official'} [options.revealScope]
 */
export function replayTo(timeline, limitSec, options = {}) {
  const state = options.state ?? createState(timeline, options);
  const events = timeline.events;
  let index = 0;

  if (options.fromIndex !== undefined) {
    index = Math.max(0, Math.min(options.fromIndex, events.length));
    if (options.fromSec !== undefined) {
      // Rewind to the first event after `fromSec`, so events sharing the
      // boundary second are re-applied rather than skipped. Re-application is
      // safe: after a team solves a problem its later submissions are ignored.
      while (index > 0 && events[index - 1][0] > options.fromSec) index--;
    }
  }

  for (; index < events.length; index++) {
    const event = events[index];
    if (event[0] > limitSec) break;
    applyEvent(state, event);
  }

  return { state, nextIndex: index };
}

/** Clone a replay state (typed arrays and the solve counter are copied). */
export function cloneState(state) {
  return {
    timeline: state.timeline,
    teamCount: state.teamCount,
    problemCount: state.problemCount,
    penaltySec: state.penaltySec,
    noPenaltyCodes: state.noPenaltyCodes,
    timePrecision: state.timePrecision,
    revealScope: state.revealScope,
    solved: state.solved.slice(),
    penalty: state.penalty.slice(),
    lastAc: state.lastAc.slice(),
    acAt: state.acAt.slice(),
    fails: state.fails.slice(),
    subs: state.subs.slice(),
    lastSub: state.lastSub.slice(),
    counted: state.counted.clone(),
  };
}

/**
 * Floor a contest second to the sorter's time precision.
 * The 2026 CCPC contests use `timePrecision: 'min'`, which means both the
 * per-problem solve time and the accumulated total are floored to minutes.
 */
export function floorToPrecision(seconds, precision) {
  switch (precision) {
    case 'min': return Math.floor(seconds / 60) * 60;
    case 'h': return Math.floor(seconds / 3600) * 3600;
    case 'd': return Math.floor(seconds / 86400) * 86400;
    case 'ms': return Math.floor(seconds * 1000) / 1000;
    case 's':
    case null:
    case undefined:
    default:
      return Math.floor(seconds);
  }
}

/**
 * The four per-team column buckets (rule 3).
 *
 * @param {object} state replay state at `tSec`
 * @param {number} teamIdx
 * @param {number} tSec current contest second
 * @param {number[]} aliasRevealed reveal second per problem (`Infinity` = never)
 * @param {object} [options]
 * @param {ArrayLike<number>} [options.triesFallback] legacy per-team attempt counts
 * @returns {number[]} problem indices, in display order
 */
export function columnOrder(state, teamIdx, tSec, aliasRevealed, options = {}) {
  const problemCount = state.problemCount;
  const base = teamIdx * problemCount;
  const fallback = options.triesFallback;

  /** @type {Array<{idx: number, bucket: number, key1: number, key2: number}>} */
  const entries = [];

  for (let probIdx = 0; probIdx < problemCount; probIdx++) {
    const key = base + probIdx;
    const solvedAt = state.acAt[key];
    const revealed = tSec >= aliasRevealed[probIdx];
    const subs = state.subs[key];
    const legacyTries = fallback ? (fallback[teamIdx]?.[probIdx] ?? 0) : 0;
    const attempted = subs > 0 || legacyTries > 0;

    let bucket;
    let key1;
    let key2;
    if (revealed) {
      bucket = BUCKET.REVEALED;
      key1 = probIdx;
      key2 = 0;
    } else if (solvedAt !== -1) {
      bucket = BUCKET.SOLVED_HIDDEN;
      key1 = solvedAt;
      key2 = probIdx;
    } else if (attempted) {
      bucket = BUCKET.ATTEMPTED_HIDDEN;
      // Without timestamps (legacy data) the latest submission is unknown;
      // fall back to the problem number so the order stays deterministic.
      const lastSub = state.lastSub[key];
      key1 = lastSub === -1 ? Number.MAX_SAFE_INTEGER : lastSub;
      key2 = probIdx;
    } else {
      bucket = BUCKET.UNTOUCHED;
      key1 = probIdx;
      key2 = 0;
    }

    entries.push({ idx: probIdx, bucket, key1, key2 });
  }

  entries.sort((a, b) => a.bucket - b.bucket || a.key1 - b.key1 || a.key2 - b.key2);
  return entries.map((entry) => entry.idx);
}

/**
 * Per-problem facts the board needs at the displayed second.
 *
 * `solved` is the live count of distinct counted teams that have solved the
 * problem by `tSec`, `submitted` the live count that has submitted to it, and
 * `revealed` whether the solve count has reached the threshold. `order` is the
 * row-header order.
 *
 * @param {object} state replay state (already replayed to `tSec`)
 * @param {number} tSec
 * @param {object} [options]
 * @param {number} [options.ratio]
 * @param {number} [options.min]
 * @returns {{
 *   threshold: number,
 *   teamsRanked: number,
 *   solved: number[],
 *   submitted: number[],
 *   aliasRevealed: number[],
 *   revealed: boolean[],
 *   order: number[],
 * }}
 */
export function problemStatus(state, tSec, options = {}) {
  const problemCount = state.problemCount;
  const ratio = Number.isFinite(options.ratio) ? options.ratio : REVEAL_RATIO;
  const min = Number.isFinite(options.min) ? options.min : REVEAL_MIN;

  // Teams counted for the threshold. With `revealScope: 'official'` the state's
  // counter already filters, so the population is the official team count.
  let teamsRanked = state.teamCount;
  if (state.revealScope === 'official') {
    teamsRanked = 0;
    for (let i = 0; i < state.teamCount; i++) {
      if (state.counted.includes(i)) teamsRanked++;
    }
  }

  const threshold = revealThreshold(teamsRanked, ratio, min);
  const solved = new Array(problemCount);
  const submitted = new Array(problemCount);
  const revealed = new Array(problemCount);
  const revealedAt = new Array(problemCount);

  for (let probIdx = 0; probIdx < problemCount; probIdx++) {
    const count = state.counted.count(probIdx);
    solved[probIdx] = count;
    submitted[probIdx] = state.counted.submittedCount(probIdx);
    revealed[probIdx] = count >= threshold;
    revealedAt[probIdx] = revealed[probIdx] ? tSec : Infinity;
  }

  // Row-header order: descending by live solve count, then by problem number.
  const order = Array.from({ length: problemCount }, (_, i) => i);
  order.sort((a, b) => solved[b] - solved[a] || a - b);

  return { threshold, teamsRanked, solved, submitted, aliasRevealed: revealedAt, revealed, order };
}

/**
 * Compute the full board at contest second `tSec`.
 *
 * @param {object} state replay state (must already be replayed to `tSec`)
 * @param {number} tSec
 * @param {object} stats output of `problemStatus()`
 * @param {object} [options]
 * @param {boolean} [options.officialOnly] rank official teams only
 * @param {ArrayLike<number>} [options.triesFallback]
 * @returns {{ rows: object[], officialTeams: number }}
 */
export function computeBoard(state, tSec, stats, options = {}) {
  const timeline = state.timeline;
  const rows = [];
  let officialTeams = 0;

  for (let teamIdx = 0; teamIdx < state.teamCount; teamIdx++) {
    const team = timeline.teams[teamIdx];
    const official = team.official !== false;
    if (official) officialTeams++;

    rows.push({
      teamIdx,
      team,
      official,
      solved: state.solved[teamIdx],
      penalty: floorToPrecision(state.penalty[teamIdx], state.timePrecision),
      lastAc: state.lastAc[teamIdx],
      rank: 0,
      columns: null,
    });
  }

  const ranked = rows.filter((row) => row.official);
  ranked.sort(compareRows);

  // Competition ranking (1, 1, 3, ...): tied rows share the rank of the first
  // row in their tie group, and the following rank skips accordingly.
  for (let index = 0; index < ranked.length; index++) {
    const row = ranked[index];
    const previous = index > 0 ? ranked[index - 1] : null;
    // Ties are determined by score alone (solved count + total penalty); the
    // last-AC breaker only orders rows that would otherwise tie.
    if (previous && previous.solved === row.solved && previous.penalty === row.penalty) {
      row.rank = previous.rank;
    } else {
      row.rank = index + 1;
    }
  }

  for (const row of rows) {
    if (!row.official) row.rank = 0;
    row.columns = columnOrder(state, row.teamIdx, tSec, stats.aliasRevealed, {
      triesFallback: options.triesFallback,
    });
  }

  if (options.officialOnly !== false) {
    rows.sort((a, b) => {
      if (a.official !== b.official) return a.official ? -1 : 1;
      if (!a.official) return b.solved - a.solved || a.penalty - b.penalty || a.teamIdx - b.teamIdx;
      return a.rank - b.rank || compareRows(a, b);
    });
  }

  return { rows, officialTeams };
}

/**
 * ICPC comparison: solved descending, penalty ascending, then earliest last-AC.
 * A negative value means `a` ranks ahead of `b`.
 */
export function compareRows(a, b) {
  if (a.solved !== b.solved) return b.solved - a.solved;
  if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  return a.lastAc - b.lastAc;
}

/**
 * Per-problem display facts for one team, used when rendering a cell.
 *
 * @param {object} state
 * @param {number} teamIdx
 * @param {number} probIdx
 * @param {object} stats output of `problemStatus()`
 * @param {number} tSec
 */
export function cellInfo(state, teamIdx, probIdx, stats, tSec) {
  const key = teamIdx * state.problemCount + probIdx;
  const acAt = state.acAt[key];
  const subs = state.subs[key];
  const attempted = subs > 0;
  const revealed = tSec >= stats.aliasRevealed[probIdx];

  return {
    solved: acAt !== -1,
    acAt: acAt === -1 ? null : acAt,
    tries: subs,
    fails: state.fails[key],
    attempted,
    revealed,
    /** Alias to display, or null when it must stay hidden. */
    alias: revealed ? (state.timeline.problems[probIdx]?.alias ?? null) : null,
  };
}
