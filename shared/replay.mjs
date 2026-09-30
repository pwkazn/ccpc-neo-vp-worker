/**
 * Replay controller: turns a wire timeline plus a VP clock into board frames.
 *
 * Responsibilities:
 *   - clip the visible contest time according to the freeze configuration,
 *   - seek efficiently using periodic snapshots,
 *   - expose replayed state plus the live per-problem status and a board.
 *
 * The per-problem status (live solve count, alias reveal, row-header order) is
 * derived from the replayed state at the displayed second, never from published
 * final figures. That is what makes the board behave like the real scoreboard:
 * a problem's alias appears the moment enough teams have solved it, and the
 * header keeps re-sorting as the solve counts change.
 */

import {
  applyEvent,
  cloneState,
  computeBoard,
  createState,
  medalBands,
  problemStatus,
  replayTo,
} from './rules.mjs';

/** How many teams are ranked (official) in a replay state. */
function countOfficial(state) {
  let count = 0;
  for (let teamIdx = 0; teamIdx < state.teamCount; teamIdx++) {
    if (state.timeline.teams[teamIdx]?.official !== false) count++;
  }
  return count;
}

/**
 * Cumulative per-team, per-problem submission counts at contest second `limit`.
 *
 * A frozen ranklist still shows *that* a team submitted — it just withholds the
 * result. So while the board's contents are pinned to the freeze second, the
 * number of pending submissions keeps growing in real time. This builds the
 * tally that makes that possible.
 *
 * @param {object} timeline
 * @param {number} limit contest second (inclusive)
 * @returns {Int32Array} length = teams * problems, indexed team * problems + p
 */
export function submissionCountsAt(timeline, limit) {
  const teams = timeline.teams.length;
  const problems = timeline.problems.length;
  const counts = new Int32Array(teams * problems);
  const solved = new Uint8Array(teams * problems);
  const capped = Math.max(0, Math.floor(limit));

  for (const event of timeline.events) {
    const tSec = event[0];
    if (tSec > capped) break;
    const key = event[1] * problems + event[2];
    // Rule 4: submissions after a team's AC are ignored, so they are not
    // pending either.
    if (solved[key]) continue;
    counts[key] += 1;
    if (event[3] === 1 || event[3] === 2) solved[key] = 1; // AC | FB
  }

  return counts;
}

/**
 * Distinct submitting teams per problem at contest second `limit`.
 *
 * The header shows "accepted / submitted"; while frozen the accepted figure is
 * pinned but the submitted figure keeps growing, so it needs its own live tally.
 *
 * @param {object} timeline
 * @param {number} limit
 * @param {boolean[]|null} [counted] which teams participate (null = all)
 * @returns {Int32Array} length = problems
 */
export function submittedTeamsAt(timeline, limit, counted = null) {
  const problems = timeline.problems.length;
  const teams = timeline.teams.length;
  const perProblem = new Int32Array(problems);
  const seen = new Uint8Array(teams * problems);
  const solved = new Uint8Array(teams * problems);
  const capped = Math.max(0, Math.floor(limit));

  for (const event of timeline.events) {
    if (event[0] > capped) break;
    const [tSec, teamIdx, probIdx, code] = event;
    const key = teamIdx * problems + probIdx;
    if (counted && !counted[teamIdx]) continue;
    if (solved[key]) continue; // rule 4: ignored after the AC
    if (!seen[key]) {
      seen[key] = 1;
      perProblem[probIdx] += 1;
    }
    if (code === 1 || code === 2) solved[key] = 1;
  }

  return perProblem;
}

/**
 * Build a frame from scratch at a given contest second.
 * Convenient for tests and one-off queries; the live UI uses `createEpochReplay`.
 *
 * @param {object} timeline
 * @param {number} tSec
 * @param {object} [options]
 * @param {'all'|'official'} [options.revealScope]
 * @param {ArrayLike<number>} [options.triesFallback]
 * @param {boolean} [options.officialOnly]
 * @param {number} [options.ratio]
 * @param {number} [options.min]
 */
export function frameAt(timeline, tSec, options = {}) {
  const { state } = replayTo(timeline, tSec, { revealScope: options.revealScope });
  const stats = problemStatus(state, tSec, { ratio: options.ratio, min: options.min });
  const officialTeams = countOfficial(state);
  const { rows } = computeBoard(state, tSec, stats, {
    triesFallback: options.triesFallback ?? timeline.triesFallback ?? null,
    officialOnly: options.officialOnly,
    medals: medalBands(timeline, officialTeams),
  });
  return { tSec, state, stats, rows, officialTeams };
}

/**
 * Random-access replay with periodic snapshots.
 *
 * A full replay of the largest RankLand contests is only a few milliseconds,
 * but scrubbing the timeline fires many seeks per second, so we keep sparse
 * snapshots and resume from the nearest one. Snapshots record the state *after*
 * a specific event, so resuming never re-applies or skips an event.
 *
 * @param {object} timeline
 * @param {object} [options]
 * @param {number} [options.snapshotIntervalSec]
 * @param {'all'|'official'} [options.revealScope]
 * @param {number} [options.ratio]
 * @param {number} [options.min]
 */
export function createEpochReplay(timeline, options = {}) {
  const snapshotIntervalSec = options.snapshotIntervalSec ?? 300;
  const revealScope = options.revealScope === 'official' ? 'official' : 'all';
  const triesFallback = options.triesFallback ?? timeline.triesFallback ?? null;
  const ratio = options.ratio;
  const min = options.min;
  const events = timeline.events;

  const stateOptions = { revealScope };

  /** @type {Array<{state: object, index: number, tSec: number}>} ascending by tSec */
  const snapshots = [];
  let snapshotTimes = [];

  // One forward pass builds every snapshot; the final state becomes live.
  {
    const writer = createState(timeline, stateOptions);
    let lastSnapshotSec = 0;
    snapshots.push({ state: cloneState(writer), index: 0, tSec: 0 });

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      applyEvent(writer, event);
      const tSec = event[0];
      if (tSec - lastSnapshotSec >= snapshotIntervalSec) {
        snapshots.push({ state: cloneState(writer), index: i + 1, tSec });
        lastSnapshotSec = tSec;
      }
    }
    snapshotTimes = snapshots.map((snapshot) => snapshot.tSec);
  }

  const last = snapshots[snapshots.length - 1];
  let current = cloneState(last.state);
  let currentIndex = last.index;
  let currentSec = last.tSec;

  /** memo for `liveSubmissionsAt` */
  let liveCache = null;
  let liveCacheSec = -1;
  /** memo for `submittedTeamsAt` */
  let submittedCache = null;
  let submittedCacheSec = -1;
  /** official-only filter, when the reveal scope asks for it */
  const countedTeams = revealScope === 'official'
    ? timeline.teams.map((team) => team.official !== false)
    : null;

  /** Index of the latest snapshot whose tSec is <= `tSec`. */
  function findSnapshot(tSec) {
    let low = 0;
    let high = snapshotTimes.length - 1;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (snapshotTimes[mid] <= tSec) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  /** Reinstall the live state from the nearest snapshot at or before `tSec`. */
  function restore(tSec) {
    const slot = snapshots[findSnapshot(tSec)];
    current = cloneState(slot.state);
    currentIndex = slot.index;
    currentSec = slot.tSec;
  }

  /** Advance the live state so that every event with `t <= tSec` is applied. */
  function seekTo(tSec) {
    const limit = Math.max(0, Math.floor(tSec));
    if (limit < currentSec) restore(limit);

    let index = currentIndex;
    while (index < events.length && events[index][0] <= limit) {
      applyEvent(current, events[index]);
      currentSec = events[index][0];
      index++;
    }
    currentIndex = index;
    return current;
  }

  return {
    timeline,
    revealScope,
    snapshotCount: snapshots.length,

    get state() { return current; },
    get currentSec() { return currentSec; },

    seekTo,

    /**
     * Cumulative team/problem submission counts up to `tSec`, cached by second.
     *
     * Used while frozen: the board's *results* stay pinned, but the pending
     * submission tally keeps advancing live.
     */
    liveSubmissionsAt(tSec) {
      const limit = Math.max(0, Math.floor(tSec));
      if (liveCache && liveCacheSec === limit) return liveCache;
      liveCache = submissionCountsAt(timeline, limit);
      liveCacheSec = limit;
      return liveCache;
    },

    /** Distinct submitting teams per problem up to `tSec`. */
    submittedTeamsAt(tSec) {
      const limit = Math.max(0, Math.floor(tSec));
      if (submittedCache && submittedCacheSec === limit) return submittedCache;
      submittedCache = submittedTeamsAt(timeline, limit, countedTeams);
      submittedCacheSec = limit;
      return submittedCache;
    },

    /** Live per-problem status at `tSec` (does not seek). */
    statsAt(tSec) {
      return problemStatus(current, tSec, { ratio, min });
    },

    /** Board at `tSec` (state and stats are computed together). */
    frameAt(tSec, frameOptions = {}) {
      seekTo(tSec);
      const stats = problemStatus(current, tSec, { ratio, min });
      // The award quota depends on how many teams are actually ranked, so it is
      // derived per frame rather than cached once.
      const officialTeams = countOfficial(current);
      const { rows } = computeBoard(current, tSec, stats, {
        triesFallback,
        officialOnly: frameOptions.officialOnly,
        medals: medalBands(timeline, officialTeams),
      });
      return {
        tSec,
        state: current,
        stats,
        reveal: stats,
        rows,
        officialTeams,
      };
    },

    stats() {
      return {
        snapshots: snapshots.length,
        currentSec,
        currentIndex,
        eventCount: events.length,
      };
    },
  };
}

/**
 * Resolve the visible contest time under the freeze configuration.
 *
 * @param {object} params
 * @param {number} params.contestSec requested contest time (may exceed duration)
 * @param {number} params.durationSec
 * @param {number} params.freezeDurationSec how long the freeze lasts; a freeze
 *   can be requested even for contests whose ranklist declares none
 * @param {boolean} [params.freezeEnabled] false disables the freeze entirely
 * @param {boolean} [params.revealed] force-unfreeze (end of the VP, or manual)
 * @returns {{ visibleSec: number, frozen: boolean, frozenAtSec: number|null, revealPending: boolean }}
 */
export function resolveFreeze({
  contestSec,
  durationSec,
  freezeDurationSec,
  freezeEnabled = true,
  revealed = false,
}) {
  const clip = (value) => Math.max(0, Math.min(value, durationSec));
  const window = Math.max(0, Math.min(freezeDurationSec ?? 0, durationSec));
  const usesFreeze = freezeEnabled !== false && window > 0;

  // No freeze requested: the board is always live.
  if (!usesFreeze) {
    return { visibleSec: clip(contestSec), frozen: false, frozenAtSec: null, revealPending: false };
  }

  const frozenAtSec = clip(durationSec - window);

  // Before the freeze starts the board is live.
  if (contestSec <= frozenAtSec) {
    return { visibleSec: clip(contestSec), frozen: false, frozenAtSec, revealPending: false };
  }

  // Inside the freeze window: hold the board at the freeze second.
  if (!revealed) {
    return { visibleSec: frozenAtSec, frozen: true, frozenAtSec, revealPending: true };
  }

  // Unfrozen: show the true state at the real contest second.
  return { visibleSec: clip(contestSec), frozen: false, frozenAtSec, revealPending: false };
}

/** Format seconds as `H:MM:SS`. */
export function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Format a penalty in seconds as whole minutes (ICPC convention). */
export function formatPenalty(seconds) {
  return String(Math.floor(seconds / 60));
}

export { computeBoard, problemStatus };
