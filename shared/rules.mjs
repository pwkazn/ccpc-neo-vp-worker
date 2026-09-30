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
 * The rule is the *smaller* of "floor(20% of the ranked teams)" and 50: the
 * 50-team figure is an upper bound, so a hypothetical huge field still reveals
 * at 50 solves while small contests reveal proportionally.
 *
 * The outer `max(1, ...)` is a practical floor — with fewer than 10 ranked teams
 * `floor(20%)` is 0, and a threshold of 0 would mean "revealed before anyone
 * solved it".
 */
export function revealThreshold(teamsRanked, ratio = REVEAL_RATIO, min = REVEAL_MIN) {
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
 * The order in which problem cells are laid out across the board.
 *
 * A column board has exactly one order for everybody: the header defines it
 * (see rule 5 — descending by live solve count, ties by problem number) and
 * every team's row follows it. A cell's *position* therefore means the same
 * problem on every row, and the only thing that varies per team is what is
 * drawn inside the cell.
 *
 * @param {number[]} headerOrder problem indices, best-first
 * @returns {number[]} a copy, so callers cannot mutate the shared order
 */
export function sharedColumnOrder(headerOrder) {
  return headerOrder.slice();
}

/**
 * The per-team column order described by rule 3.
 *
 * This is the *row-internal* ordering the rule text describes (revealed
 * problems first, then that team's own hidden solves by solve time, then its
 * other attempts, then untouched problems). It is kept because it is the
 * documented behaviour of a per-team scoreboard cell layout and is still
 * exercised by the tests, but the interactive board does not use it: a
 * column board cannot give every row a different order without the columns
 * ceasing to mean anything.
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
 * @param {object} [options.medals] output of `medalBands()`; when given, each
 *   official row gets a `medal` field (`'gold' | 'silver' | 'bronze' | null`)
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

  // One column order for the whole board, defined by the header. Every row
  // follows it, so a column always means the same problem on every row.
  const columns = sharedColumnOrder(stats.order);

  for (const row of rows) {
    if (!row.official) row.rank = 0;
    row.columns = columns;
    // Medal band for this rank, from the ranklist's own ICPC series.
    row.medal = options.medals ? medalFor(options.medals, row.rank, row.official) : null;
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
 * Default award ratios, used when the ranklist does not state its own. These
 * are the ICPC regional conventions (10% gold, 20% silver, 30% bronze).
 */
export const DEFAULT_MEDAL_RATIOS = Object.freeze([0.1, 0.2, 0.3]);

/**
 * Resolve the award bands for a contest.
 *
 * A ranklist declares its awards through an ICPC series segment list, e.g.
 * gold/silver/bronze. The per-award counts can be stated explicitly
 * (`rule.options.count.value`) or left to the ranklist to derive from the
 * number of *official* teams (a `[0,0,0]` placeholder). Only official teams
 * count towards the quota, matching the usual contest rules.
 *
 * @param {object} timeline wire timeline
 * @param {number} officialTeams number of ranked (official) teams
 * @returns {{ medals: Array<{style: string, title: string, count: number}>,
 *             limits: number[], ratios: number[], source: 'declared'|'default' }|null}
 */
export function medalBands(timeline, officialTeams) {
  const declared = timeline?.awards;
  if (!declared || officialTeams <= 0) return null;

  const segments = Array.isArray(declared.segments) ? declared.segments : [];
  if (segments.length === 0) return null;

  // Explicit per-award counts win when any of them is non-zero.
  const declaredCounts = Array.isArray(declared.counts) ? declared.counts : null;
  const hasDeclaredCounts = declaredCounts !== null
    && declaredCounts.some((value) => Number.isFinite(value) && value > 0);

  const ratios = hasDeclaredCounts
    ? null
    : (Array.isArray(declared.ratios) && declared.ratios.length === segments.length
      ? declared.ratios
      : DEFAULT_MEDAL_RATIOS);

  const medals = [];
  let running = 0;
  const limits = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    let count;
    if (hasDeclaredCounts) {
      count = Math.max(0, Math.trunc(declaredCounts[index] ?? 0));
    } else {
      const ratio = ratios[index] ?? 0;
      // Each band boundary is floor(officialTeams * cumulative ratio), so the
      // bands are contiguous and the 10/20/30% ratios mean "top 10%".
      const boundary = Math.floor(officialTeams * (ratios.slice(0, index + 1).reduce((a, b) => a + b, 0)));
      count = Math.max(0, boundary - running);
    }
    running += count;
    limits.push(running);
    medals.push({
      style: segment.style ?? null,
      title: segment.title ?? null,
      count,
    });
  }

  if (running <= 0) return null;
  return {
    medals,
    limits,
    ratios: hasDeclaredCounts ? [] : ratios,
    source: hasDeclaredCounts ? 'declared' : 'default',
  };
}

/**
 * Which award band a rank falls into.
 * @param {object} medals output of `medalBands()`
 * @param {number} rank 1-based competition rank (0 for unranked)
 * @param {boolean} official
 * @returns {string|null} the segment style, e.g. `'gold'`
 */
export function medalFor(medals, rank, official) {
  if (!medals || !official || rank <= 0) return null;
  for (let index = 0; index < medals.limits.length; index++) {
    if (rank <= medals.limits[index]) {
      const segment = medals.medals[index];
      // Fall back to positional names when the ranklist gave no style.
      return segment.style ?? ['gold', 'silver', 'bronze'][index] ?? null;
    }
  }
  return null;
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
