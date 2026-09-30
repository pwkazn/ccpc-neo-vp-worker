/**
 * Board-rendering tests.
 *
 * The visible contract of the board is: each row's cells are laid out in that
 * team's own column order, while every cell's content comes from the replayed
 * state. `cellContent` is the pure half of that and is tested directly; the
 * ordering half is asserted against the engine's own `columnOrder`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cellContent } from '../web/board.mjs';
import { columnOrder, replayTo, resolveReveal } from '../shared/rules.mjs';
import { RESULT } from '../shared/srk.mjs';

/** Minimal wire timeline helper (mirrors the one in rules.test.mjs). */
function makeTimeline({ teams = 1, problems = 1, events = [], revealSec = [], triesFallback = null }) {
  return {
    version: 1,
    uk: 't',
    name: 't',
    contest: { durationSec: 18000, frozenDurationSec: 0 },
    problems: Array.from({ length: problems }, (_, i) => ({ alias: String.fromCharCode(65 + i), color: null })),
    teams: Array.from({ length: teams }, (_, i) => ({
      id: String(i), name: `T${i}`, organization: '', official: true, members: [], markers: [],
    })),
    reveal: {
      ratio: 0.2,
      min: 50,
      all: { teamsRanked: teams, threshold: teams, revealSec: Array.from({ length: problems }, (_, i) => revealSec[i] ?? Infinity) },
      official: { teamsRanked: teams, threshold: teams, revealSec: Array.from({ length: problems }, (_, i) => revealSec[i] ?? Infinity) },
    },
    sorter: {
      algorithm: 'ICPC',
      penaltySec: 1200,
      noPenaltyResults: [],
      noPenaltyCodes: [RESULT.FB, RESULT.AC, RESULT.UNKNOWN, RESULT.NOUT, RESULT.CE, RESULT.UKE],
      timePrecision: 'min',
    },
    events,
    triesFallback,
    coverage: { exact: true, events: events.length, droppedEvents: 0 },
  };
}

test('cellContent renders a solve as minutes and in-cell wrong attempts', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [300, 0, 0, RESULT.WA],
      [900, 0, 0, RESULT.WA],
      [1500, 0, 0, RESULT.AC],
    ],
  });
  const { state } = replayTo(timeline, 9999);
  const cell = cellContent(state, 0, 0);
  assert.equal(cell.text, '25(2)', 'floor(1500/60)=25 minutes, 2 wrong attempts');
  assert.equal(cell.className, 'cell cell--solved');
  assert.equal(cell.solved, true);
  assert.equal(cell.attempted, true);
});

test('cellContent renders a first-try solve as bare minutes', () => {
  const timeline = makeTimeline({ teams: 1, problems: 1, events: [[600, 0, 0, RESULT.AC]] });
  const { state } = replayTo(timeline, 9999);
  assert.equal(cellContent(state, 0, 0).text, '10');
});

test('cellContent renders attempts as -N', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [100, 0, 0, RESULT.WA],
      [200, 0, 0, RESULT.TLE],
    ],
  });
  const { state } = replayTo(timeline, 9999);
  const cell = cellContent(state, 0, 0);
  assert.equal(cell.text, '-2');
  assert.equal(cell.className, 'cell cell--failed');
  assert.equal(cell.solved, false);
  assert.equal(cell.attempted, true);
});

test('cellContent is empty for an untouched problem', () => {
  const timeline = makeTimeline({ teams: 1, problems: 2, events: [[100, 0, 0, RESULT.AC]] });
  const { state } = replayTo(timeline, 9999);
  const cell = cellContent(state, 0, 1);
  assert.equal(cell.text, '');
  assert.equal(cell.className, 'cell');
  assert.equal(cell.attempted, false);
});

test('cellContent does not grow after an AC (rule 4)', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [
      [600, 0, 0, RESULT.AC],
      [700, 0, 0, RESULT.WA],
      [800, 0, 0, RESULT.WA],
    ],
  });
  const { state } = replayTo(timeline, 9999);
  // The simulated freeze must be the limit: post-AC submissions are dropped by
  // the engine, so the rendered cell never changes.
  assert.equal(cellContent(state, 0, 0).text, '10');
});

test('cellContent falls back to legacy attempt counts', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 2,
    events: [],
    triesFallback: [[2, 0]],
  });
  const { state } = replayTo(timeline, 100);
  assert.equal(
    cellContent(state, 0, 0, timeline.triesFallback).text,
    '-2',
    'legacy attempts are shown',
  );
  assert.equal(
    cellContent(state, 0, 1, timeline.triesFallback).text,
    '',
    'untouched stays empty',
  );
});

test('cellContent ignores legacy fallbacks for exact timelines', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 1,
    events: [[100, 0, 0, RESULT.WA]],
    triesFallback: [[9]],
  });
  const { state } = replayTo(timeline, 9999);
  assert.equal(cellContent(state, 0, 0, null).text, '-1', 'the exact count is authoritative');
});

test('cellContent uses the legacy fallback only when it is larger', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 2,
    events: [[100, 0, 0, RESULT.WA]],
    triesFallback: [[3, -1]],
  });
  const { state } = replayTo(timeline, 9999);
  assert.equal(
    cellContent(state, 0, 0, timeline.triesFallback).text,
    '-3',
    'the published aggregate carries more attempts than the event stream found',
  );
  assert.equal(
    cellContent(state, 0, 1, timeline.triesFallback).text,
    '',
    '-1 means unknown, so the untouched problem stays empty',
  );
});

test('a row rendered in column order shows the right cell per position', () => {
  // 3 problems: P0 revealed and solved late, P1 hidden and solved early,
  // P2 hidden and attempted only.
  const timeline = makeTimeline({
    teams: 1,
    problems: 3,
    revealSec: [0, Infinity, Infinity],
    events: [
      [200, 0, 1, RESULT.AC],
      [500, 0, 2, RESULT.WA],
      [1000, 0, 0, RESULT.AC],
    ],
  });
  const { state } = replayTo(timeline, 9999);
  const reveal = resolveReveal(timeline, 'all');
  const order = columnOrder(state, 0, 9999, reveal);

  // Expected: revealed P0 first, then hidden solve P1, then hidden attempt P2.
  assert.deepEqual(order, [0, 1, 2]);

  // Simulate what the renderer does: walk positions, read cells by problem index.
  const rendered = order.map((probIdx) => cellContent(state, 0, probIdx).text);
  assert.deepEqual(rendered, ['16', '3', '-1']);
});

test('column order and cell content stay consistent when the order is not identity', () => {
  const timeline = makeTimeline({
    teams: 1,
    problems: 4,
    revealSec: [Infinity, Infinity, Infinity, Infinity],
    events: [
      [100, 0, 3, RESULT.WA], // latest submission 100 -> first in bucket 3
      [900, 0, 0, RESULT.WA],
      [500, 0, 1, RESULT.AC], // solved at 500 -> bucket 2
    ],
  });
  const { state } = replayTo(timeline, 9999);
  const order = columnOrder(state, 0, 9999, resolveReveal(timeline, 'all'));
  // bucket 2: P1 (solved) ; bucket 3: P3 (100s), P0 (900s) ; bucket 4: P2
  assert.deepEqual(order, [1, 3, 0, 2]);

  const rendered = order.map((probIdx) => cellContent(state, 0, probIdx).text);
  assert.deepEqual(rendered, ['8', '-1', '-1', '']);
});
