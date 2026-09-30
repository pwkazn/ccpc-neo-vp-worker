/**
 * Replay controller: turns a wire timeline plus a VP clock into board frames.
 *
 * Responsibilities:
 *   - clip the visible contest time according to the freeze configuration,
 *   - seek efficiently using periodic snapshots,
 *   - expose replayed state, reveal information and a computed board.
 */

import {
  applyEvent,
  cloneState,
  computeBoard,
  createState,
  replayTo,
  resolveReveal,
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
 */
export function frameAt(timeline, tSec, options = {}) {
  const reveal = resolveReveal(timeline, options.revealScope ?? 'all');
  const { state } = replayTo(timeline, tSec);
  const { rows, officialTeams } = computeBoard(state, tSec, reveal, {
    triesFallback: options.triesFallback ?? timeline.triesFallback ?? null,
    officialOnly: options.officialOnly,
  });
  return { tSec, state, reveal, rows, officialTeams };
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
 */
export function createEpochReplay(timeline, options = {}) {
  const snapshotIntervalSec = options.snapshotIntervalSec ?? 300;
  const revealScope = options.revealScope ?? 'all';
  const triesFallback = options.triesFallback ?? timeline.triesFallback ?? null;
  const reveal = resolveReveal(timeline, revealScope);
  const events = timeline.events;

  /** @type {Array<{state: object, index: number, tSec: number}>} ascending by tSec */
  const snapshots = [];
  /** @type {Array<number>} shared with `snapshots` for binary search */
  let snapshotTimes = [];

  // Build snapshots from a single forward pass, then reuse the final state as
  // the starting point for the live state.
  {
    const writer = createState(timeline);
    let lastSnapshotSec = -Infinity;
    snapshots.push({ state: cloneState(writer), index: 0, tSec: 0 });
    lastSnapshotSec = 0;

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

  let current = cloneState(snapshots[snapshots.length - 1].state);
  let currentIndex = snapshots[snapshots.length - 1].index;
  let currentSec = snapshots[snapshots.length - 1].tSec;

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
    // `currentSec` tracks the last applied event; keep the requested time for
    // callers that ask for it explicitly.
    return current;
  }

  return {
    timeline,
    reveal,
    snapshotCount: snapshots.length,

    get state() { return current; },
    get currentSec() { return currentSec; },

    seekTo,

    /** Board at `tSec` (state is seeked first). */
    frameAt(tSec, frameOptions = {}) {
      seekTo(tSec);
      const { rows, officialTeams } = computeBoard(current, tSec, reveal, {
        triesFallback,
        officialOnly: frameOptions.officialOnly,
      });
      return { tSec, state: current, reveal, rows, officialTeams };
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
 * @param {number} params.frozenDurationSec
 * @param {'auto'|'never'} params.freezeMode `never` keeps the board live all the
 *   way to the end; `auto` freezes for the last `frozenDurationSec`.
 * @param {boolean} [params.revealed] force-unfreeze (end of the VP)
 * @returns {{ visibleSec: number, frozen: boolean, frozenAtSec: number|null, revealPending: boolean }}
 */
export function resolveFreeze({
  contestSec,
  durationSec,
  frozenDurationSec,
  freezeMode = 'auto',
  revealed = false,
}) {
  const clip = (value) => Math.max(0, Math.min(value, durationSec));
  const usesFreeze = freezeMode !== 'never' && frozenDurationSec > 0;
  const frozenAtSec = usesFreeze ? clip(durationSec - frozenDurationSec) : null;

  if (!usesFreeze || revealed) {
    return { visibleSec: clip(contestSec), frozen: false, frozenAtSec, revealPending: false };
  }

  if (contestSec <= frozenAtSec) {
    return { visibleSec: clip(contestSec), frozen: false, frozenAtSec, revealPending: false };
  }

  return { visibleSec: frozenAtSec, frozen: true, frozenAtSec, revealPending: true };
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

export { computeBoard, resolveReveal };
