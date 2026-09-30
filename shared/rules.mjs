/**
 * CCPC "new ranklist" rules, implemented as pure functions.
 *
 * This module is the single authority for:
 *   1. problem-alias reveal thresholds,
 *   2. per-team problem column ordering,
 *   3. ICPC scoring (accepted count + penalty) under the new rules,
 *   4. final ranking.
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

/** Sort buckets for a team's problem columns (see docs/rules.md rule 3). */
export const BUCKET = Object.freeze({
  REVEALED: 0,
  SOLVED_HIDDEN: 1,
  ATTEMPTED_HIDDEN: 2,
  UNTOUCHED: 3,
});

/**
 * Create the initial replay state for a timeline.
 *
 * @param {object} timeline wire timeline
 */
export function createState(timeline) {
  const teamCount = timeline.teams.length;
  const problemCount = timeline.problems.length;
  const sorter = timeline.sorter ?? {};

  return {
    timeline,
    teamCount,
    problemCount,
    penaltySec: sorter.penaltySec ?? 20 * 60,
    noPenaltyCodes: new Set(sorter.noPenaltyCodes ?? []),
    timePrecision: sorter.timePrecision ?? null,

    solved: new Int32Array(teamCount),
    penalty: new Float64Array(teamCount),
    lastAc: new Int32Array(teamCount),

    /** @type {Int32Array} AC timestamp per team*problem, -1 when unsolved */
    acAt: new Int32Array(teamCount * problemCount).fill(-1),
    /** @type {Int32Array} number of penalty-bearing submissions before the AC */
    fails: new Int32Array(teamCount * problemCount),
    /** @type {Int32Array} submissions seen so far (pre-AC only, per the rules) */
    subs: new Int32Array(teamCount * problemCount),
    /** @type {Int32Array} contest second of the latest pre-AC submission, -1 if none */
    lastSub: new Int32Array(teamCount * problemCount).fill(-1),
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

  state.subs[key] += 1;
  state.lastSub[key] = tSec;

  if (isAccepted(code)) {
    state.acAt[key] = tSec;
    state.solved[teamIdx] += 1;
    state.penalty[teamIdx] += floorToPrecision(tSec, state.timePrecision)
      + state.fails[key] * state.penaltySec;
    if (tSec > state.lastAc[teamIdx]) state.lastAc[teamIdx] = tSec;
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
 * A full replay of a large contest (~31k events) takes a few milliseconds, so
 * this is used directly for seeking and for the per-second redraw.
 *
 * @param {object} timeline
 * @param {number} limitSec
 * @param {object} [options]
 * @param {object} [options.state] reuse this state instead of allocating
 * @param {number} [options.fromIndex] index of the first event to apply
 * @param {number} [options.fromSec] only apply events after this second
 */
export function replayTo(timeline, limitSec, options = {}) {
  const state = options.state ?? createState(timeline);
  const events = timeline.events;
  let index = 0;

  if (options.fromIndex !== undefined) {
    index = Math.max(0, Math.min(options.fromIndex, events.length));
    if (options.fromSec !== undefined) {
      // Rewind to the first event strictly after `fromSec`, so that events
      // sharing the boundary second are re-applied rather than skipped.
      // Re-application is safe: after a team solves a problem all of its
      // later submissions to that problem are ignored.
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

/** Clone a replay state (typed arrays are copied). */
export function cloneState(state) {
  return {
    timeline: state.timeline,
    teamCount: state.teamCount,
    problemCount: state.problemCount,
    penaltySec: state.penaltySec,
    noPenaltyCodes: state.noPenaltyCodes,
    timePrecision: state.timePrecision,
    solved: state.solved.slice(),
    penalty: state.penalty.slice(),
    lastAc: state.lastAc.slice(),
    acAt: state.acAt.slice(),
    fails: state.fails.slice(),
    subs: state.subs.slice(),
    lastSub: state.lastSub.slice(),
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
 * Compute, per problem, the contest second at which its alias becomes visible.
 *
 * Rule 1: a problem's alias is revealed once the number of distinct teams that
 * solved it reaches `max(floor(N * ratio), min)`.
 *
 * @param {object} timeline
 * @param {'all'|'official'} [scope] which teams count towards N
 * @returns {{ threshold: number, teamsRanked: number, revealSec: number[] }}
 */
export function resolveReveal(timeline, scope = 'all') {
  const variant = timeline.reveal?.[scope] ?? timeline.reveal?.all;
  const revealSec = (variant?.revealSec ?? []).map((value) => (value === null ? Infinity : value));
  return {
    threshold: variant?.threshold ?? Math.max(Math.floor(timeline.teams.length * REVEAL_RATIO), REVEAL_MIN),
    teamsRanked: variant?.teamsRanked ?? timeline.teams.length,
    revealSec,
  };
}

/** Is a problem's alias visible at contest second `tSec`? */
export function isRevealed(reveal, probIdx, tSec) {
  return tSec >= reveal.revealSec[probIdx];
}

/**
 * Build the ordered list of problem columns for one team, implementing rule 3.
 *
 * 1. revealed problems, ascending by problem number (the SRK problem order);
 * 2. remaining problems the team has solved, by solve time ascending;
 * 3. remaining problems the team has submitted to, by latest submission
 *    ascending (never-submitted problems sort last);
 * 4. never-submitted problems, ascending by problem number.
 *
 * Buckets 2-4 keep the alias hidden; only bucket 1 shows it.
 *
 * @param {object} state replay state
 * @param {number} teamIdx
 * @param {number} tSec current contest second
 * @param {object} reveal output of resolveReveal()
 * @param {object} [options]
 * @param {ArrayLike<number>} [options.triesFallback] legacy per-team attempt counts
 * @returns {number[]} problem indices, in display order
 */
export function columnOrder(state, teamIdx, tSec, reveal, options = {}) {
  const problemCount = state.problemCount;
  const base = teamIdx * problemCount;
  const fallback = options.triesFallback;

  /** @type {Array<{idx: number, bucket: number, key1: number, key2: number}>} */
  const entries = [];

  for (let probIdx = 0; probIdx < problemCount; probIdx++) {
    const key = base + probIdx;
    const solvedAt = state.acAt[key];
    const revealed = isRevealed(reveal, probIdx, tSec);
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
      // Without timestamps (legacy data) the "latest submission" is unknown;
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
 * Compute the full board at contest second `tSec`.
 *
 * @param {object} state replay state (must already be replayed to `tSec`)
 * @param {number} tSec
 * @param {object} reveal
 * @param {object} [options]
 * @param {boolean} [options.officialOnly] rank official teams only
 * @param {ArrayLike<number>} [options.triesFallback]
 * @returns {{ rows: object[], officialTeams: number }}
 */
export function computeBoard(state, tSec, reveal, options = {}) {
  const timeline = state.timeline;
  const rows = [];
  let officialTeams = 0;

  for (let teamIdx = 0; teamIdx < state.teamCount; teamIdx++) {
    const team = timeline.teams[teamIdx];
    const official = team.official !== false;
    if (official) officialTeams++;

    const solved = state.solved[teamIdx];
    const penalty = floorToPrecision(state.penalty[teamIdx], state.timePrecision);

    rows.push({
      teamIdx,
      team,
      official,
      solved,
      penalty,
      lastAc: state.lastAc[teamIdx],
      rank: 0,
      columns: null,
    });
  }

  const ranked = rows.filter((row) => row.official);
  ranked.sort(compareRows);

  let rank = 0;
  let previous = null;
  for (const row of ranked) {
    if (previous && compareRows(previous, row) === 0) {
      row.rank = previous.rank;
    } else {
      rank++;
      row.rank = rank;
    }
    previous = row;
  }

  for (const row of rows) {
    if (!row.official) row.rank = 0;
    row.columns = columnOrder(state, row.teamIdx, tSec, reveal, {
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
 * @param {object} reveal
 * @param {number} tSec
 */
export function cellInfo(state, teamIdx, probIdx, reveal, tSec) {
  const key = teamIdx * state.problemCount + probIdx;
  const acAt = state.acAt[key];
  const subs = state.subs[key];
  const attempted = subs > 0;
  const revealed = isRevealed(reveal, probIdx, tSec);

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
