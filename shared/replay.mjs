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
  problemStatus,
  replayTo,
} from './rules.mjs';

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
  const { rows, officialTeams } = computeBoard(state, tSec, stats, {
    triesFallback: options.triesFallback ?? timeline.triesFallback ?? null,
    officialOnly: options.officialOnly,
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

    /** Live per-problem status at `tSec` (does not seek). */
    statsAt(tSec) {
      return problemStatus(current, tSec, { ratio, min });
    },

    /** Board at `tSec` (state and stats are computed together). */
    frameAt(tSec, frameOptions = {}) {
      seekTo(tSec);
      const stats = problemStatus(current, tSec, { ratio, min });
      const { rows, officialTeams } = computeBoard(current, tSec, stats, {
        triesFallback,
        officialOnly: frameOptions.officialOnly,
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
