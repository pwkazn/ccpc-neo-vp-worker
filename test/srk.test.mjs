/**
 * Unit tests for the SRK zod-free helpers in shared/srk.mjs and the wire
 * timeline builder in server/build-timeline.mjs.
 *
 * These run against the synthetic fixture in test/fixtures/, so they stay fast
 * and work offline. The real-data regression lives in test/e2e.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESULT,
  decodeResult,
  durationToSeconds,
  encodeResult,
  isAccepted,
  textToString,
} from '../shared/srk.mjs';
import {
  buildTimeline,
  computeReveal,
  countAcceptedPerProblem,
  extractEvents,
  WIRE_VERSION,
} from '../server/build-timeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(here, 'fixtures', name), 'utf8');

const loadFixture = async (name) => JSON.parse(await fixture(name));

// ------------------------------------------------------------------ srk.mjs

test('durationToSeconds converts every SRK time unit', () => {
  assert.equal(durationToSeconds([300, 'min']), 18000);
  assert.equal(durationToSeconds([5, 'h']), 18000);
  assert.equal(durationToSeconds([90, 's']), 90);
  assert.equal(durationToSeconds([1500, 'ms']), 1.5);
  assert.equal(durationToSeconds([1, 'd']), 86400);
});

test('durationToSeconds handles malformed input via the fallback', () => {
  assert.equal(durationToSeconds(null, 7), 7);
  assert.equal(durationToSeconds(undefined, 7), 7);
  assert.equal(durationToSeconds([1, 'fortnight'], 7), 7);
  assert.equal(durationToSeconds(['abc', 'min'], 7), 7);
  assert.equal(durationToSeconds([], 7), 7);
  assert.equal(durationToSeconds({}, 7), 7);
});

test('textToString prefers zh-CN then falls back', () => {
  assert.equal(textToString('plain'), 'plain');
  assert.equal(textToString({ 'en-US': 'English', 'zh-CN': '中文', fallback: 'fb' }), '中文');
  assert.equal(textToString({ 'en-US': 'English', fallback: 'fb' }), 'English');
  assert.equal(textToString({ fallback: 'fb' }), 'fb');
  assert.equal(textToString(null), '');
});

test('result codes round-trip and classify acceptance', () => {
  for (const [name, code] of Object.entries(RESULT)) {
    assert.equal(encodeResult(name), code, `${name} encodes`);
    assert.equal(decodeResult(code), name, `${name} decodes`);
  }
  assert.equal(encodeResult('ac'), RESULT.AC, 'encoding is case-insensitive');
  assert.equal(encodeResult(null), RESULT.UNKNOWN);
  assert.equal(encodeResult('SOMETHING_ELSE'), RESULT.UNKNOWN);
  assert.ok(isAccepted(RESULT.AC));
  assert.ok(isAccepted(RESULT.FB));
  assert.ok(!isAccepted(RESULT.WA));
  assert.ok(!isAccepted(RESULT.UNKNOWN));
});

// ----------------------------------------------------------- extractEvents

test('extractEvents reads per-solution timestamps in the exact format', async () => {
  const srk = await loadFixture('exact.srk.json');
  const { events, triesFallback, exact, droppedEvents } = extractEvents(srk);

  assert.equal(exact, true);
  assert.equal(droppedEvents, 0);
  assert.equal(events.length, 6, 'every submission becomes an event');

  // Events are sorted by timestamp ascending.
  const times = events.map((event) => event[0]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  // ties broken deterministically by team then problem
  assert.deepEqual(events[0], [600, 0, 0, RESULT.AC]);
  assert.deepEqual(events.at(-1), [5400, 1, 1, RESULT.AC]);

  // No legacy fallback counts are recorded when solutions exist.
  assert.deepEqual(triesFallback, [[0, 0], [0, 0]]);
});

test('extractEvents degrades to the aggregate format without timestamps', async () => {
  const srk = await loadFixture('legacy.srk.json');
  const { events, triesFallback, exact } = extractEvents(srk);

  assert.equal(exact, false, 'legacy data is flagged as inexact');

  // Only the two solved problems produce events (at the published solve time).
  assert.deepEqual(events, [
    [600, 1, 0, RESULT.AC],
    [1400, 0, 0, RESULT.AC],
  ]);

  // The attempt counts are preserved per team/problem.
  assert.deepEqual(triesFallback, [[3, 2], [1, 0]]);
});

test('extractEvents skips submissions with unusable timestamps', () => {
  const srk = {
    problems: [{ alias: 'A' }],
    rows: [
      {
        user: { id: '1', name: 'x' },
        score: { value: 0 },
        statuses: [
          {
            result: 'RJ',
            tries: 1,
            solutions: [{ result: 'WA', time: null }, { result: 'WA', time: [-5, 's'] }],
          },
        ],
      },
    ],
  };
  const { events, droppedEvents } = extractEvents(srk);
  assert.equal(events.length, 0);
  assert.equal(droppedEvents, 2, 'both malformed times are reported');
});

// ----------------------------------------------------- countAccepted/reveal

test('countAcceptedPerProblem counts distinct solving teams', async () => {
  const srk = await loadFixture('exact.srk.json');
  const { events } = extractEvents(srk);
  // One distinct solver per problem in the fixture (the fixture's published
  // statistics are intentionally inflated to prove they are not used when
  // per-solution data is available).
  assert.deepEqual(countAcceptedPerProblem(srk, events), [1, 1]);
});

test('countAcceptedPerProblem trusts published statistics when events are missing', () => {
  const srk = {
    problems: [{ alias: 'A', statistics: { accepted: 7, submitted: 9 } }],
    rows: [{ user: { id: '1', name: 'x' }, score: { value: 0 }, statuses: [{}] }],
  };
  assert.deepEqual(countAcceptedPerProblem(srk, []), [7]);
});

test('computeReveal reveals a problem the moment the threshold is reached', () => {
  // 5 counted teams, ratio 0.2 => floor(1.0) = 1, then min(1, 3) = 1.
  const events = [
    [100, 0, 0, RESULT.AC],
    [200, 1, 0, RESULT.AC],
    [300, 2, 0, RESULT.AC],
    [150, 3, 1, RESULT.AC],
  ];
  const { threshold, revealSec, teamsRanked } = computeReveal({
    events,
    problemCount: 2,
    teamCounted: [true, true, true, true, true],
    ratio: 0.2,
    min: 3,
  });

  assert.equal(teamsRanked, 5);
  assert.equal(threshold, 1, 'min(floor(5*0.2), 3) = 1');
  assert.equal(revealSec[0], 100, 'revealed by the first distinct solver');
  assert.equal(revealSec[1], 150, 'the other problem is revealed by its first solver');
});

test('computeReveal is capped by the 50-team figure in a large field', () => {
  const events = [];
  for (let team = 0; team < 60; team++) events.push([100 + team, team, 0, RESULT.AC]);
  const { threshold, revealSec, teamsRanked } = computeReveal({
    events,
    problemCount: 1,
    teamCounted: new Array(1000).fill(true),
    ratio: 0.2,
    min: 50,
  });
  assert.equal(teamsRanked, 1000);
  assert.equal(threshold, 50, 'min(200, 50) = 50, not 200');
  assert.equal(revealSec[0], 149, 'the 50th solver arrives at t=149');
});

test('computeReveal ignores uncounted teams', () => {
  const events = [
    [100, 0, 0, RESULT.AC],
    [200, 1, 0, RESULT.AC],
    [300, 2, 0, RESULT.AC],
  ];
  const { threshold, revealSec } = computeReveal({
    events,
    problemCount: 1,
    teamCounted: [true, false, false],
    ratio: 1,
    min: 0,
  });
  assert.equal(threshold, 1);
  assert.equal(revealSec[0], 100, 'only the counted team can reveal');
});

// ----------------------------------------------------------- buildTimeline

test('buildTimeline produces a stable, deterministic wire document', async () => {
  const srk = await loadFixture('exact.srk.json');
  const meta = { uk: 'fixture', name: 'Fixture', srkHash: 'abc', generatedAt: 1234 };
  const first = buildTimeline(srk, meta);
  const second = buildTimeline(srk, meta);

  assert.equal(first.version, WIRE_VERSION);
  assert.deepEqual(first, second, 'same input yields identical output');
  assert.equal(first.coverage.exact, true);
  assert.equal(first.coverage.events, 6);
  assert.equal(first.contest.durationSec, 18000);
  assert.equal(first.contest.frozenDurationSec, 3600);
  assert.equal(first.sorter.penaltySec, 1200);
  assert.equal(first.sorter.timePrecision, 'min');
  assert.equal(first.problems[0].alias, 'A');
  assert.equal(first.problems[0].color, '#ff0000');
  assert.equal(first.teams[0].name, 'Alpha');
  assert.equal(first.teams[0].organization, 'Team One');
  assert.deepEqual(first.teams[0].members, ['a1', 'a2', 'a3']);
});

test('buildTimeline validates statuses/problems alignment', () => {
  const srk = {
    contest: { duration: [60, 'min'] },
    problems: [{ alias: 'A' }, { alias: 'B' }],
    rows: [{ user: { id: '1', name: 'x' }, score: { value: 0 }, statuses: [{}] }],
  };
  assert.throws(() => buildTimeline(srk, { uk: 'x' }), /statuses/);
});

test('buildTimeline rejects non-objects and missing arrays', () => {
  assert.throws(() => buildTimeline(null), TypeError);
  assert.throws(() => buildTimeline({ contest: {} }, { uk: 'x' }), TypeError);
  const empty = buildTimeline({ contest: {}, problems: [], rows: [] }, { uk: 'x' });
  assert.equal(empty.teams.length, 0);
  assert.equal(empty.problems.length, 0);
});

test('buildTimeline clamps the freeze duration to the contest duration', () => {
  const srk = {
    contest: { duration: [60, 'min'], frozenDuration: [3, 'h'] },
    problems: [{ alias: 'A' }],
    rows: [{ user: { id: '1', name: 'x' }, score: { value: 0 }, statuses: [{}] }],
  };
  const timeline = buildTimeline(srk, { uk: 'x' });
  assert.equal(timeline.contest.durationSec, 3600);
  assert.equal(timeline.contest.frozenDurationSec, 3600, 'never exceeds the duration');
});

test('buildTimeline marks the legacy coverage as inexact', async () => {
  const srk = await loadFixture('legacy.srk.json');
  const timeline = buildTimeline(srk, { uk: 'legacy' });
  assert.equal(timeline.coverage.exact, false);
  assert.equal(timeline.coverage.events, 2);
  assert.deepEqual(timeline.triesFallback, [[3, 2], [1, 0]]);
});

test('buildTimeline exposes both reveal scopes', async () => {
  const srk = await loadFixture('exact.srk.json');
  const timeline = buildTimeline(srk, { uk: 'x', revealRatio: 0.5, revealMin: 1 });
  assert.equal(timeline.reveal.all.teamsRanked, 2);
  assert.equal(timeline.reveal.all.threshold, Math.min(1, 1), 'min(floor(2*0.5), 1) = 1');
  // The fixture has one unofficial team.
  assert.equal(timeline.reveal.official.teamsRanked, 1);
  assert.equal(timeline.reveal.official.threshold, Math.max(1, Math.min(0, 1)), 'floored at 1');
  assert.equal(timeline.reveal.all.revealSec[0], 600);
  assert.equal(timeline.reveal.all.revealSec[1], 1000);
});
