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

/** CCPC convention for the freeze window: the last hour. */
export const DEFAULT_FREEZE_MINUTES = 60;

/**
 * @param {object} timeline wire timeline
 * @param {object} [options]
 * @param {number} [options.startAt] epoch ms when the VP starts
 * @param {number} [options.speed] playback multiplier (1 = real time)
 * @param {boolean} [options.freezeEnabled] false disables the freeze entirely
 * @param {number} [options.freezeMinutes] freeze length in minutes; defaults to
 *   the ranklist's own `frozenDuration`, or the CCPC convention of 60 minutes
 *   when the ranklist declares none. Any contest can be frozen this way.
 * @param {'all'|'official'} [options.revealScope]
 * @param {boolean} [options.officialOnly] rank official teams only
 * @param {boolean} [options.autoReveal] unfreeze automatically once the contest ends
 * @param {number} [options.now] initial wall clock (defaults to Date.now())
 */
export function createSession(timeline, options = {}) {
  const durationSec = timeline.contest?.durationSec ?? 0;
  /**
   * `frozenDurationSec` is optional in the ranklist format. Three cases:
   *   - a positive value: that is the author's freeze window, used as-is;
   *   - an explicit 0: the ranklist says "no freeze", so default to off;
   *   - absent: no information, so fall back to the CCPC convention (last hour).
   */
  const declaredFreezeSec = timeline.contest?.frozenDurationSec ?? null;
  const declaredDuration = declaredFreezeSec ?? DEFAULT_FREEZE_MINUTES * 60;
  const now = options.now ?? Date.now();

  // The freeze is a per-VP setting: any contest can be frozen, including one
  // whose ranklist declares no freeze.
  const freezeEnabled = options.freezeEnabled ?? (declaredFreezeSec !== 0);
  const freezeDurationSec = Math.max(
    0,
    options.freezeMinutes !== undefined ? options.freezeMinutes * 60 : declaredDuration,
  );

  const session = {
    timeline,
    durationSec,
    declaredFreezeSec,

    now,
    /**
     * The contest clock is anchored by (contest second, wall clock) plus a
     * playback rate. Keeping the anchor explicit and separate from the rate is
     * what makes `start` mean "this many contest seconds have already elapsed
     * at 1x" regardless of the speed chosen for *future* playback.
     */
    anchorSec: 0,
    anchorMs: now,
    speed: SPEEDS.includes(options.speed) ? options.speed : 1,
    freezeEnabled,
    freezeDurationSec,

    /** `startAt` is the wall clock at which the contest second was 0 */
    startAt: options.startAt ?? now,

    revealScope: options.revealScope === 'official' ? 'official' : 'all',
    officialOnly: options.officialOnly !== false,
    autoReveal: options.autoReveal !== false,

    /** true when the clock is detached from the wall clock (paused/scrubbing) */
    detached: false,
    /** contest second the clock is frozen at while detached */
    detachSec: 0,
    /** set once the board is unlocked (end of contest, or manual reveal) */
    revealed: false,

    epoch: createEpochReplay(timeline, { revealScope: options.revealScope }),
    revision: 0,
    lastBoardSec: -1,
    frame: null,
  };

  /**
   * Contest seconds elapsed since the anchor, at the current speed.
   * `(now - anchorMs)` is the *live* elapsed time, so the initial "already
   * elapsed" amount lands in `anchorSec` and is never scaled.
   */
  function elapsedSec() {
    return ((session.now - session.anchorMs) / 1000) * session.speed;
  }

  /** Contest second the session is currently showing. */
  function currentSec() {
    return session.detached
      ? session.detachSec
      : session.anchorSec + elapsedSec();
  }

  /**
   * Re-anchor the clock at `(sec, ms)`.
   * Use before changing `speed` so the shown second does not jump.
   */
  function rebase(sec, ms) {
    session.anchorSec = sec;
    session.anchorMs = ms;
  }

  /** Detach the clock, keeping the current contest second. */
  function detach(nowSec = session.now) {
    session.now = nowSec;
    if (!session.detached) {
      session.detachSec = currentSec();
      session.detached = true;
    }
    return session;
  }

  /** Re-attach the clock so playback continues from the current contest second. */
  function attach(nowSec = session.now) {
    session.now = nowSec;
    if (session.detached) {
      const sec = session.detachSec;
      session.detached = false;
      rebase(sec, nowSec);
    }
    return session;
  }

  session.currentSec = currentSec;
  session.elapsedSec = elapsedSec;
  session.rebase = rebase;

  /** Freeze-aware view of the requested contest time. */
  session.freezeState = function freezeState() {
    return resolveFreeze({
      contestSec: currentSec(),
      durationSec: session.durationSec,
      freezeDurationSec: session.freezeDurationSec,
      freezeEnabled: session.freezeEnabled,
      revealed: session.isRevealed(),
    });
  };

  /**
   * Whether the board is currently unlocked: either the user asked for it, or
   * the contest ran past its end and the freeze should lift by itself.
   */
  session.isRevealed = function isRevealed() {
    if (session.revealed) return true;
    if (!session.autoReveal) return false;
    return currentSec() >= session.durationSec;
  };

  /** Current phase of the VP. */
  session.phase = function phase() {
    const contestSec = currentSec();
    if (contestSec < 0) return PHASE.PENDING;
    const freeze = session.freezeState();
    if (freeze.frozen) return PHASE.FROZEN;
    if (contestSec >= session.durationSec) return PHASE.ENDED;
    return PHASE.RUNNING;
  };

  /** Compute a fresh board frame and memoise it. */
  session.computeFrame = function computeFrame() {
    /**
     * Three times matter:
     *   - `contestSec` is the real contest clock. It always runs, so the timer
     *     and progress bar stay honest;
     *   - `boardSec` is the second the *results* on the board describe. During a
     *     freeze it is held at the freeze second, so no post-freeze solve or
     *     penalty can leak out;
     *   - `pendingSec` is the second the *submission counts* describe. A frozen
     *     ranklist still shows that a team submitted, so pending attempts keep
     *     appearing live even while every result is withheld.
     */
    const contestSec = currentSec();
    const freeze = session.freezeState();
    const boardSec = Math.max(0, Math.floor(freeze.visibleSec));
    const pendingSec = freeze.frozen ? Math.max(boardSec, Math.floor(contestSec)) : boardSec;

    const { rows, stats } = session.epoch.frameAt(boardSec, {
      officialOnly: session.officialOnly,
    });

    // While frozen, how many submissions landed after the board second. The
    // board adds these to the pre-freeze attempt count to render `?N`, and the
    // header's submitted figure keeps growing with them.
    let liveSubs = null;
    if (freeze.frozen) {
      const live = session.epoch.liveSubmissionsAt(pendingSec);
      const base = session.epoch.liveSubmissionsAt(boardSec);
      if (live.length === base.length) {
        liveSubs = new Int32Array(live.length);
        for (let i = 0; i < live.length; i++) liveSubs[i] = live[i] - base[i];
      }
      const liveTeams = session.epoch.submittedTeamsAt(pendingSec);
      stats.submitted = Array.from(liveTeams);
    }

    session.lastBoardSec = boardSec;
    session.frame = {
      contestSec,
      boardSec,
      pendingSec,
      frozen: freeze.frozen,
      frozenAtSec: freeze.frozenAtSec,
      revealPending: freeze.revealPending,
      revealed: session.isRevealed(),
      phase: session.phase(),
      rows,
      state: session.epoch.state,
      /** live per-problem solve counts, reveal flags and header order */
      stats,
      /** post-board-second submissions, for the pending `?N` tally */
      liveSubs,
      triesFallback: session.timeline.triesFallback ?? null,
      detached: session.detached,
      speed: session.speed,
      revision: session.revision,
    };
    return session.frame;
  };

  /**
   * Advance the session to the current wall clock.
   *
   * Recomputes when the board second changed, or — while frozen — when the
   * pending second advanced, so pending submissions keep appearing on time.
   */
  session.update = function update(nowSec = Date.now()) {
    session.now = nowSec;
    const contestSec = currentSec();
    const freeze = session.freezeState();
    const boardSec = Math.max(0, Math.floor(freeze.visibleSec));
    const pendingSec = freeze.frozen ? Math.max(boardSec, Math.floor(contestSec)) : boardSec;

    const stale = session.frame === null
      || boardSec !== session.lastBoardSec
      || session.frame.pendingSec !== pendingSec
      || session.frame.revision !== session.revision;

    if (stale) return session.computeFrame();

    session.frame.contestSec = contestSec;
    return session.frame;
  };

  session.setSpeed = function setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return session;
    const nowSec = session.now;
    const sec = currentSec();
    if (session.detached) {
      // Stay detached; playback resumes when the caller re-attaches.
      session.detachSec = sec;
      session.speed = speed;
    } else {
      // Keep the shown second fixed and let the new rate apply from here on.
      session.speed = speed;
      rebase(sec, nowSec);
    }
    session.revision++;
    return session.update(nowSec);
  };

  session.pause = function pause(nowSec = session.now) {
    const result = detach(nowSec);
    session.revision++;
    return result.update(nowSec);
  };

  session.resume = function resume(nowSec = Date.now()) {
    const result = attach(nowSec);
    session.revision++;
    return result.update(nowSec);
  };

  session.togglePause = function togglePause(nowSec = Date.now()) {
    return session.detached ? session.resume(nowSec) : session.pause(nowSec);
  };

  /** Jump to an absolute contest second (scrubbing); detaches the clock. */
  session.seek = function seek(contestSec, nowSec = session.now) {
    session.detachSec = Math.max(0, Math.min(contestSec, session.durationSec));
    session.detached = true;
    session.now = nowSec;
    session.revision++;
    return session.update(nowSec);
  };

  /** Rejoin the live edge from the current contest second. */
  session.followLive = function followLive(nowSec = Date.now()) {
    const result = attach(nowSec);
    session.revision++;
    return result.update(nowSec);
  };

  /**
   * Set the VP start time (used for the initial countdown).
   *
   * The contest second at `nowSec` is the plain wall-clock difference — never
   * scaled by the playback speed. Speed only ever affects how fast the clock
   * advances from here.
   */
  session.setStartAt = function setStartAt(startAt, nowSec = Date.now()) {
    session.startAt = startAt;
    session.detached = false;
    session.revealed = false;
    session.now = nowSec;
    rebase((nowSec - startAt) / 1000, nowSec);
    session.lastBoardSec = -1;
    session.revision++;
    return session.update(nowSec);
  };

  /** Unlock the board (manual reveal). */
  session.reveal = function reveal(nowSec = session.now) {
    session.revealed = true;
    session.revision++;
    return session.update(nowSec);
  };

  /** Re-enter the freeze, undoing a reveal (for checking the frozen view). */
  session.unreveal = function unreveal(nowSec = session.now) {
    session.revealed = false;
    session.revision++;
    return session.update(nowSec);
  };

  /** Enable or disable the freeze window. */
  session.setFreezeEnabled = function setFreezeEnabled(enabled, nowSec = session.now) {
    session.freezeEnabled = Boolean(enabled);
    session.revision++;
    return session.update(nowSec);
  };

  /** Change the freeze length in minutes. */
  session.setFreezeMinutes = function setFreezeMinutes(minutes, nowSec = session.now) {
    session.freezeDurationSec = Math.max(0, Number(minutes) || 0) * 60;
    session.revision++;
    return session.update(nowSec);
  };

  session.setOfficialOnly = function setOfficialOnly(value, nowSec = session.now) {
    session.officialOnly = Boolean(value);
    session.revision++;
    return session.update(nowSec);
  };

  session.setRevealScope = function setRevealScope(scope, nowSec = session.now) {
    session.revealScope = scope === 'official' ? 'official' : 'all';
    session.epoch = createEpochReplay(session.timeline, { revealScope: session.revealScope });
    session.lastBoardSec = -1;
    session.revision++;
    return session.update(nowSec);
  };

  /**
   * Prime the frame using the plain wall-clock offset from `startAt`. This must
   * not depend on the playback speed: `speed` is how fast the clock will run
   * from now on, not a factor applied to the contest time already elapsed.
   */
  rebase((session.now - session.startAt) / 1000, session.now);
  session.frame = session.computeFrame();
  return session;
}
