/**
 * Build the compact "wire timeline" consumed by the browser replay engine.
 *
 * The wire format is deliberately frozen and deterministic: the same SRK file
 * always produces byte-identical output, so it can be cached on disk and used
 * in regression tests.
 *
 * Two shapes of SRK data exist in the wild and both are handled here:
 *
 *  - "exact" (modern): `ranklist.rows[].statuses[].solutions[]` carries every
 *    submission with its own timestamp, so the board can be replayed submission
 *    by submission.
 *  - "legacy": `solutions` is empty or absent. Only the per-problem aggregate
 *    (`result`, `tries`, sometimes `time`) is known, so the timeline degrades to
 *    one synthetic "attempt" plus a solve event at the published solve time.
 */

import {
  RESULT,
  SRK_DEFAULT_NO_PENALTY_RESULTS,
  decodeResult,
  durationToSeconds,
  encodeResult,
  isAccepted,
  textToString,
} from '../shared/srk.mjs';

/** Bump when the wire layout changes in an incompatible way. */
export const WIRE_VERSION = 1;

/** Default threshold constants from the CCPC new ranklist rules. */
export const DEFAULT_REVEAL_RATIO = 0.2;
export const DEFAULT_REVEAL_MIN = 50;

/**
 * Extract the submission events plus the aggregate fallback information for a
 * single SRK ranklist.
 *
 * @param {object} ranklist parsed SRK document
 * @returns {{
 *   events: Array<[number, number, number, number]>,
 *   triesFallback: Array<Array<number>>,
 *   exact: boolean,
 *   droppedEvents: number,
 * }}
 */
export function extractEvents(ranklist) {
  const rows = ranklist.rows;
  const problemCount = ranklist.problems.length;

  const events = [];
  const triesFallback = rows.map(() => new Array(problemCount).fill(0));
  let sawSolutions = false;
  let droppedEvents = 0;

  for (let teamIdx = 0; teamIdx < rows.length; teamIdx++) {
    const statuses = rows[teamIdx].statuses ?? [];
    for (let probIdx = 0; probIdx < problemCount; probIdx++) {
      const status = statuses[probIdx];
      if (!status) continue;

      const solutions = Array.isArray(status.solutions) ? status.solutions : [];
      if (solutions.length > 0) {
        sawSolutions = true;
        for (const solution of solutions) {
          const tSec = durationToSeconds(solution.time, null);
          if (tSec === null || tSec < 0) {
            droppedEvents++;
            continue;
          }
          events.push([tSec, teamIdx, probIdx, encodeResult(solution.result)]);
        }
        continue;
      }

      // Legacy aggregate path: we know how many effective tries happened but
      // not their timestamps.
      const tries = Number.isFinite(status.tries) ? Math.max(0, Math.trunc(status.tries)) : 0;
      triesFallback[teamIdx][probIdx] = tries;

      const resultCode = status.result === null || status.result === undefined
        ? null
        : encodeResult(status.result);

      if (resultCode !== null && isAccepted(resultCode)) {
        const tSec = durationToSeconds(status.time, null);
        if (tSec === null || tSec < 0) {
          droppedEvents++;
          continue;
        }
        // Emit the earlier attempts as attempts-only events is impossible
        // without timestamps, so the engine counts `triesFallback` instead.
        events.push([tSec, teamIdx, probIdx, resultCode]);
      }
    }
  }

  events.sort(
    (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3],
  );

  return {
    events,
    triesFallback,
    exact: sawSolutions,
    droppedEvents,
  };
}

/**
 * Count how many teams solved each problem in total, using the best available
 * signal (per-solution results, falling back to the published statistics).
 *
 * @param {object} ranklist
 * @param {Array<[number, number, number, number]>} events
 * @returns {number[]} accepted team count per problem index
 */
export function countAcceptedPerProblem(ranklist, events) {
  const counts = new Array(ranklist.problems.length).fill(0);
  const solved = new Set(); // `${teamIdx}:${probIdx}`

  for (const event of events) {
    if (!isAccepted(event[3])) continue;
    const key = `${event[1]}:${event[2]}`;
    if (solved.has(key)) continue;
    solved.add(key);
    counts[event[2]]++;
  }

  // If a problem reports published statistics but our event scan found nothing
  // (legacy data without solve times for that problem), trust the statistics so
  // the reveal rule stays correct.
  for (let i = 0; i < counts.length; i++) {
    const published = ranklist.problems[i]?.statistics?.accepted;
    if (counts[i] === 0 && Number.isFinite(published) && published > 0) {
      counts[i] = Math.trunc(published);
    }
  }

  return counts;
}

/**
 * Compute, for each problem, the earliest contest time at which its alias
 * becomes visible on the board.
 *
 * Rule: a problem's alias is revealed once the number of distinct teams that
 * solved it reaches `max(floor(teamsRanked * ratio), min)`.
 *
 * @param {object} params
 * @param {Array<[number, number, number, number]>} params.events
 * @param {number} params.problemCount
 * @param {boolean[]} params.teamCounted which teams participate in the count
 * @param {number} params.ratio
 * @param {number} params.min
 * @returns {{ threshold: number, revealSec: Array<number|null> }}
 */
export function computeReveal({ events, problemCount, teamCounted, ratio, min }) {
  const teamsRanked = teamCounted.reduce((acc, counted) => acc + (counted ? 1 : 0), 0);
  const threshold = Math.max(Math.floor(teamsRanked * ratio), min);

  const counts = new Array(problemCount).fill(0);
  const solved = new Set();
  const revealSec = new Array(problemCount).fill(null);

  for (const [tSec, teamIdx, probIdx] of events) {
    if (revealSec[probIdx] !== null) continue;
    if (!teamCounted[teamIdx]) continue;
    const key = `${teamIdx}:${probIdx}`;
    if (solved.has(key)) continue;
    solved.add(key);
    counts[probIdx]++;
    if (counts[probIdx] >= threshold) revealSec[probIdx] = tSec;
  }

  return { threshold, revealSec, teamsRanked };
}

/**
 * Build the wire timeline for one contest.
 *
 * @param {object} ranklist parsed SRK document
 * @param {object} meta
 * @param {string} meta.uk contest unique key
 * @param {string} meta.name display name
 * @param {string} [meta.srkHash] content hash of the SRK file
 * @param {string} [meta.srkUrl] origin URL of the SRK file
 * @param {number|string} [meta.srkSize] byte size of the SRK file
 * @param {number} [meta.generatedAt] epoch ms
 * @param {number} [meta.revealRatio]
 * @param {number} [meta.revealMin]
 * @returns {object} wire timeline
 */
export function buildTimeline(ranklist, meta = {}) {
  if (!ranklist || typeof ranklist !== 'object') {
    throw new TypeError('ranklist must be an object');
  }
  if (!Array.isArray(ranklist.problems) || !Array.isArray(ranklist.rows)) {
    throw new TypeError('ranklist is missing problems[] or rows[]');
  }

  const problems = ranklist.problems;
  const rows = ranklist.rows;

  for (let i = 0; i < rows.length; i++) {
    const statuses = rows[i].statuses;
    if (!Array.isArray(statuses) || statuses.length !== problems.length) {
      throw new RangeError(
        `row ${i} has ${Array.isArray(statuses) ? statuses.length : 'no'} statuses, expected ${problems.length}`,
      );
    }
  }

  const { events, triesFallback, exact, droppedEvents } = extractEvents(ranklist);

  const teamCounted = rows.map((row) => row.user?.official !== false);
  const allCounted = rows.map(() => true);

  const ratio = Number.isFinite(meta.revealRatio) ? meta.revealRatio : DEFAULT_REVEAL_RATIO;
  const min = Number.isFinite(meta.revealMin) ? meta.revealMin : DEFAULT_REVEAL_MIN;

  const officialReveal = computeReveal({
    events,
    problemCount: problems.length,
    teamCounted,
    ratio,
    min,
  });
  const allReveal = computeReveal({
    events,
    problemCount: problems.length,
    teamCounted: allCounted,
    ratio,
    min,
  });

  const durationSec = durationToSeconds(ranklist.contest?.duration, 0) ?? 0;
  const frozenSecRaw = durationToSeconds(ranklist.contest?.frozenDuration, 0) ?? 0;
  const frozenDurationSec = Math.max(0, Math.min(frozenSecRaw, durationSec));

  const sorterConfig = ranklist.sorter?.config ?? {};
  const noPenaltyResults = Array.isArray(sorterConfig.noPenaltyResults)
    ? sorterConfig.noPenaltyResults
    : SRK_DEFAULT_NO_PENALTY_RESULTS;
  const penaltySec = durationToSeconds(sorterConfig.penalty, 20 * 60) ?? 20 * 60;

  return {
    version: WIRE_VERSION,
    uk: meta.uk ?? '',
    name: meta.name ?? textToString(ranklist.contest?.title) ?? '',
    source: {
      srkHash: meta.srkHash ?? null,
      srkUrl: meta.srkUrl ?? null,
      srkSize: Number.isFinite(meta.srkSize) ? meta.srkSize : null,
      generatedAt: meta.generatedAt ?? Date.now(),
    },
    contest: {
      startAt: ranklist.contest?.startAt ?? null,
      durationSec,
      frozenDurationSec,
      title: textToString(ranklist.contest?.title),
      refLinks: (ranklist.contest?.refLinks ?? []).map((link) => ({
        title: textToString(link.title),
        link: String(link.link ?? ''),
      })),
    },
    problems: problems.map((problem, index) => ({
      alias: problem.alias ?? String.fromCharCode(65 + index),
      title: textToString(problem.title),
      link: problem.link ?? null,
      color: problem.style?.backgroundColor ?? null,
      accepted: Number.isFinite(problem.statistics?.accepted)
        ? problem.statistics.accepted
        : null,
      // NOTE: `accepted` above is the published snapshot and is only used as a
      // display label. The reveal rule keys off the live distinct-solver count
      // derived from `events`, which can legitimately differ from the published
      // number (see docs/rules.md).
      submitted: Number.isFinite(problem.statistics?.submitted)
        ? problem.statistics.submitted
        : null,
    })),
    teams: rows.map((row) => ({
      id: String(row.user?.id ?? ''),
      name: textToString(row.user?.name),
      organization: textToString(row.user?.organization),
      official: row.user?.official !== false,
      members: (row.user?.teamMembers ?? [])
        .map((member) => textToString(member?.name))
        .filter((name) => name.length > 0),
      markers: Array.isArray(row.user?.markers)
        ? row.user.markers
        : row.user?.marker
          ? [row.user.marker]
          : [],
    })),
    reveal: {
      ratio,
      min,
      official: { teamsRanked: officialReveal.teamsRanked, threshold: officialReveal.threshold, revealSec: officialReveal.revealSec },
      all: { teamsRanked: allReveal.teamsRanked, threshold: allReveal.threshold, revealSec: allReveal.revealSec },
    },
    sorter: {
      algorithm: ranklist.sorter?.algorithm ?? 'ICPC',
      penaltySec,
      noPenaltyResults,
      noPenaltyCodes: noPenaltyResults.map((result) => encodeResult(result)),
      timePrecision: sorterConfig.timePrecision ?? null,
      rankingTimePrecision: sorterConfig.rankingTimePrecision ?? null,
      timeRounding: sorterConfig.timeRounding ?? 'floor',
    },
    events,
    triesFallback,
    coverage: {
      exact,
      events: events.length,
      droppedEvents,
      // Result names are kept so the UI can explain what counted as an attempt.
      noPenaltyResults: noPenaltyResults.map((result) => result ?? 'null'),
    },
    markers: ranklist.markers ?? [],
  };
}

/** Human readable label for a wire result code, used by tests and debugging. */
export { decodeResult, RESULT };
