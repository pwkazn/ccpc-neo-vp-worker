/**
 * VP session model: maps a wall clock plus playback controls onto a contest
 * second, then asks the replay engine for a board frame.
 *
 * Deliberately DOM-free and timer-free. The UI owns the animation loop and
 * calls `update()` with the current wall clock, which keeps the model testable.
 *
 * Clock model
 * -----------
 * A session is either
 *   - "live edge":  contestSec = (now - startAt) * speed / 1000
 *   - "detached":   contestSec = atSec  (paused, or scrubbed to a position)
 * `detach()` freezes the current contest second; `attach(now)` rebases `startAt`
 * so the contest second the user was looking at is preserved exactly.
 */

import { createEpochReplay, resolveFreeze } from './replay.mjs';

export const PHASE = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  FROZEN: 'frozen',
  ENDED: 'ended',
});

/** Playback speeds offered in the UI. */
export const SPEEDS = Object.freeze([1, 2, 5, 10, 60, 300]);

/**
 * @param {object} timeline wire timeline
 * @param {object} [options]
 * @param {number} [options.startAt] epoch ms when the VP starts
 * @param {number} [options.speed] playback multiplier (1 = real time)
 * @param {'auto'|'never'} [options.freezeMode]
 * @param {'all'|'official'} [options.revealScope]
 * @param {boolean} [options.officialOnly] rank official teams only
 * @param {boolean} [options.autoReveal] reveal the frozen board once the contest ends
 * @param {number} [options.now] initial wall clock (defaults to Date.now())
 */
export function createSession(timeline, options = {}) {
  const durationSec = timeline.contest?.durationSec ?? 0;
  const frozenDurationSec = timeline.contest?.frozenDurationSec ?? 0;
  const now = options.now ?? Date.now();

  const session = {
    timeline,
    durationSec,
    frozenDurationSec,

    now,
    startAt: options.startAt ?? now,
    speed: SPEEDS.includes(options.speed) ? options.speed : 1,
    freezeMode: options.freezeMode === 'never' ? 'never' : 'auto',
    revealScope: options.revealScope === 'official' ? 'official' : 'all',
    officialOnly: options.officialOnly !== false,
    autoReveal: options.autoReveal !== false,

    /** true when the clock is detached from the wall clock */
    detached: false,
    /** contest second used while detached */
    atSec: 0,
    /** set once the user (or the end of the contest) unlocks the final board */
    revealed: false,

    epoch: createEpochReplay(timeline, { revealScope: options.revealScope }),
    /** bumped whenever a mode change must invalidate the memoised frame */
    revision: 0,
    lastVisibleSec: -1,
    frame: null,
  };

  /**
   * Contest seconds elapsed according to the wall clock, ignoring detach.
   * Keeps `(now - startAt)/1000 * speed` exact (no per-tick accumulation).
   */
  function liveSec() {
    return ((session.now - session.startAt) / 1000) * session.speed;
  }

  /** Contest second the session is currently showing. */
  function currentSec() {
    return session.detached ? session.atSec : liveSec();
  }

  /** Detach the clock, keeping the current contest second. */
  function detach(now = session.now) {
    session.now = now;
    if (!session.detached) {
      session.atSec = liveSec();
      session.detached = true;
    }
    return session;
  }

  /** Re-attach the clock so playback continues from the current contest second. */
  function attach(now = session.now) {
    session.now = now;
    if (session.detached) {
      const sec = session.atSec;
      session.startAt = now - (sec / session.speed) * 1000;
      session.detached = false;
    }
    return session;
  }

  session.currentSec = currentSec;
  session.liveSec = liveSec;

  /** Freeze-aware view of the requested contest time. */
  session.freezeState = function freezeState() {
    const contestSec = currentSec();
    return resolveFreeze({
      contestSec,
      durationSec: session.durationSec,
      frozenDurationSec: session.frozenDurationSec,
      freezeMode: session.freezeMode,
      revealed: session.isRevealed(),
    });
  };

  /** Whether the board is currently showing the authored final result. */
  session.isRevealed = function isRevealed() {
    if (session.revealed) return true;
    if (!session.autoReveal) return false;
    return currentSec() >= session.durationSec && frozenDurationSec > 0
      && session.freezeMode !== 'never';
  };

  /** Current phase of the VP. */
  session.phase = function phase() {
    const contestSec = currentSec();
    if (contestSec < 0) return PHASE.PENDING;
    if (session.freezeState().frozen) return PHASE.FROZEN;
    if (contestSec >= session.durationSec) return PHASE.ENDED;
    return PHASE.RUNNING;
  };

  /** Compute a fresh board frame and memoise it. */
  session.computeFrame = function computeFrame() {
    const contestSec = currentSec();
    const freeze = session.freezeState();
    const visibleSec = Math.max(0, Math.floor(freeze.visibleSec));

    const { rows } = session.epoch.frameAt(visibleSec, {
      officialOnly: session.officialOnly,
    });

    session.lastVisibleSec = visibleSec;
    session.frame = {
      contestSec,
      visibleSec,
      frozen: freeze.frozen,
      frozenAtSec: freeze.frozenAtSec,
      revealPending: freeze.revealPending,
      revealed: session.isRevealed(),
      phase: session.phase(),
      rows,
      state: session.epoch.state,
      reveal: session.epoch.reveal,
      /** legacy per-team attempt counts, for boards without an event timeline */
      triesFallback: session.timeline.triesFallback ?? null,
      detached: session.detached,
      speed: session.speed,
      revision: session.revision,
    };
    return session.frame;
  };

  /**
   * Advance the session to the current wall clock.
   * Recomputes only when the visible contest second or the revision changed.
   * @returns {object} the current frame
   */
  session.update = function update(now = Date.now()) {
    session.now = now;
    const contestSec = currentSec();
    const visibleSec = Math.max(0, Math.floor(session.freezeState().visibleSec));

    const stale = session.frame === null
      || visibleSec !== session.lastVisibleSec
      || session.frame.revision !== session.revision;

    if (stale) return session.computeFrame();

    session.frame.contestSec = contestSec;
    return session.frame;
  };

  session.setSpeed = function setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return session;
    const now = session.now;
    const sec = currentSec();
    if (session.detached) {
      // Stay detached; playback resumes when the caller re-attaches.
      session.atSec = sec;
      session.speed = speed;
    } else {
      // Stay at the live edge but rebase so the shown second is unchanged.
      session.speed = speed;
      session.startAt = now - (sec / speed) * 1000;
    }
    session.revision++;
    return session.update(now);
  };

  session.pause = function pause(now = session.now) {
    const result = detach(now);
    session.revision++;
    return result.update(now);
  };

  session.resume = function resume(now = Date.now()) {
    const result = attach(now);
    session.revision++;
    return result.update(now);
  };

  session.togglePause = function togglePause(now = Date.now()) {
    return session.detached ? session.resume(now) : session.pause(now);
  };

  /** Jump to an absolute contest second (scrubbing); detaches the clock. */
  session.seek = function seek(contestSec, now = session.now) {
    session.atSec = Math.max(0, Math.min(contestSec, session.durationSec));
    session.detached = true;
    session.now = now;
    session.revision++;
    return session.update(now);
  };

  /** Rejoin the live edge from the current contest second. */
  session.followLive = function followLive(now = Date.now()) {
    const result = attach(now);
    session.revision++;
    return result.update(now);
  };

  /** Set the VP start time (used for the initial countdown). */
  session.setStartAt = function setStartAt(startAt, now = Date.now()) {
    session.startAt = startAt;
    session.detached = false;
    session.revealed = false;
    session.now = now;
    session.lastVisibleSec = -1;
    session.revision++;
    return session.update(now);
  };

  /** Unlock the authored final result. */
  session.reveal = function reveal(now = session.now) {
    session.revealed = true;
    session.revision++;
    return session.update(now);
  };

  session.setFreezeMode = function setFreezeMode(mode, now = session.now) {
    session.freezeMode = mode === 'never' ? 'never' : 'auto';
    session.revision++;
    return session.update(now);
  };

  session.setOfficialOnly = function setOfficialOnly(value, now = session.now) {
    session.officialOnly = Boolean(value);
    session.revision++;
    return session.update(now);
  };

  session.setRevealScope = function setRevealScope(scope, now = session.now) {
    session.revealScope = scope === 'official' ? 'official' : 'all';
    session.epoch = createEpochReplay(session.timeline, { revealScope: session.revealScope });
    session.revision++;
    return session.update(now);
  };

  session.frame = session.computeFrame();
  return session;
}
