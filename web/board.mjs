/**
 * Virtualised ranklist board.
 *
 * Layout notes
 * ------------
 * Rows are absolutely positioned inside a tall relative "inner" element and
 * moved with `transform: translateY(...)`. That is what makes rank swaps slide
 * instead of jumping, and it keeps each team bound to one DOM element so a
 * reorder never rebuilds a row. The header is `position: sticky` inside the
 * same scroller, and the identity columns stick horizontally, so both work
 * without a native <table> (whose rows cannot be positioned this way).
 *
 * CCPC new-ranklist behaviour implemented here:
 *   1. the header lists every problem ordered by live solve count (descending,
 *      ties by problem number) and shows that count; an unrevealed problem
 *      shows `?` with no colour;
 *   2. each row orders its own cells (revealed by number, then hidden solves by
 *      solve time, then other attempts by latest submission, then untouched).
 *      A cell's position is therefore not a problem identity.
 */

const OVERSCAN = 10;
const ROW_HEIGHT = 30;
const HEAD_HEIGHT = 56;
const STICKY = ['rank', 'team', 'org', 'solved', 'penalty'];

/** Fixed column widths in px; mirrored in ui.css. */
export const COLUMN_WIDTHS = Object.freeze({
  rank: 56,
  team: 190,
  org: 165,
  solved: 60,
  penalty: 66,
});

/** Horizontal offset of each sticky column, derived from the widths. */
export const STICKY_OFFSETS = (() => {
  const offsets = {};
  let x = 0;
  for (const name of STICKY) {
    offsets[name] = x;
    x += COLUMN_WIDTHS[name];
  }
  return offsets;
})();

/**
 * Content of one problem cell, derived only from replayed state.
 *
 * A hidden alias does not change this: the new format shows *that* a problem
 * was solved, just not which one.
 *
 * @param {object} state replay state
 * @param {number} teamIdx
 * @param {number} probIdx
 * @param {ArrayLike<number>|null} [triesFallback] legacy per-team attempt counts
 *   (`null` when the timeline is exact; a per-problem value of `-1` also means
 *   "use the live count")
 * @param {object} [options]
 * @param {boolean} [options.frozen] when frozen, an unsolved but attempted
 *   problem is an *unknown* result and is rendered as a pending `?N` cell
 * @returns {{ text: string, className: string, solved: boolean, attempted: boolean, pending: boolean }}
 */
export function cellContent(state, teamIdx, probIdx, triesFallback = null, options = {}) {
  const key = teamIdx * state.problemCount + probIdx;
  const acAt = state.acAt[key];
  const live = state.subs[key];
  const fallback = triesFallback?.[teamIdx]?.[probIdx] ?? -1;
  const tries = fallback >= 0 ? Math.max(live, fallback) : live;

  if (acAt !== -1) {
    const minutes = Math.floor(acAt / 60);
    const wrong = Math.max(0, tries - 1);
    return {
      text: wrong > 0 ? `${minutes}(${wrong})` : String(minutes),
      className: 'cell cell--solved',
      solved: true,
      attempted: true,
      pending: false,
    };
  }

  if (tries > 0) {
    // Frozen ranklists show this as "submitted, result unknown": the old ICPC
    // board drew a blue question mark with the number of attempts.
    if (options.frozen) {
      return {
        text: `?${tries}`,
        className: 'cell cell--pending',
        solved: false,
        attempted: true,
        pending: true,
      };
    }
    return {
      text: `-${tries}`,
      className: 'cell cell--failed',
      solved: false,
      attempted: true,
      pending: false,
    };
  }

  return { text: '', className: 'cell', solved: false, attempted: false, pending: false };
}

/** Tooltip for a header cell. */
export function headerTitle(problem, revealed, solved, submitted) {
  if (!revealed) {
    return `题号尚未显示：过题队伍数未达门限（当前过题 ${solved} 队，提交 ${submitted} 队）`
      + (problem.title ? `\n(题目：${problem.title})` : '');
  }
  const lines = [`${problem.alias}${problem.title ? ` — ${problem.title}` : ''}`];
  lines.push(`过题 ${solved} 队 / 提交 ${submitted} 队`);
  return lines.join('\n');
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container scroll container
 * @param {object} options.timeline wire timeline
 */
export function createBoard({ container, timeline }) {
  container.replaceChildren();

  const problemCount = timeline.problems.length;
  const stickyWidth = STICKY.reduce((sum, name) => sum + COLUMN_WIDTHS[name], 0);
  const totalWidth = stickyWidth + problemCount * COLUMN_WIDTHS.solved;

  const inner = document.createElement('div');
  inner.className = 'board__inner';
  inner.style.width = `${Math.max(totalWidth, 100)}px`;

  // ---- header -------------------------------------------------------------
  const head = document.createElement('div');
  head.className = 'board__head';
  head.style.height = `${HEAD_HEIGHT}px`;
  head.style.width = `${Math.max(totalWidth, 100)}px`;

  const stickyLabels = { rank: '名次', team: '队伍', org: '学校', solved: '题数', penalty: '罚时' };
  /** @type {Record<string, HTMLElement>} */
  const stickyCells = {};
  for (const name of STICKY) {
    const cell = document.createElement('div');
    cell.className = `head-cell col-${name}`;
    cell.textContent = stickyLabels[name];
    cell.style.width = `${COLUMN_WIDTHS[name]}px`;
    cell.style.left = `${STICKY_OFFSETS[name]}px`;
    stickyCells[name] = cell;
    head.append(cell);
  }

  /**
   * One stable element per problem, re-ordered in place so the header slides
   * between orderings. All of them are rendered; only the order changes.
   * @type {Array<{cell: HTMLElement, alias: HTMLElement, count: HTMLElement, problem: object}>}
   */
  const headers = timeline.problems.map((problem) => {
    const cell = document.createElement('div');
    cell.className = 'head-cell prob';
    cell.style.width = `${COLUMN_WIDTHS.solved}px`;
    if (problem.color) cell.style.setProperty('--prob-color', problem.color);

    const alias = document.createElement('span');
    alias.className = 'prob-alias';
    alias.textContent = '?';

    const count = document.createElement('span');
    count.className = 'prob-count';
    count.textContent = '0';

    cell.append(alias, count);
    return { cell, alias, count, problem };
  });

  // The header's problem cells live in their own flex row so re-ordering them
  // cannot disturb the sticky identity columns.
  const headProbs = document.createElement('div');
  headProbs.className = 'board__head-probs';
  headProbs.style.left = `${stickyWidth}px`;
  for (const entry of headers) headProbs.append(entry.cell);
  head.append(headProbs);

  inner.append(head);
  container.append(inner);

  // ---- state --------------------------------------------------------------
  let rows = [];
  let frame = null;
  /** team index -> row element (kept for the lifetime of the board) */
  const rendered = new Map();
  let lastHeaderOrder = '';
  let filterText = '';
  let pinnedTeamId = null;

  const matchesFilter = (row) => filterText.length > 0 && (
    row.team.name.toLowerCase().includes(filterText)
    || (row.team.organization ?? '').toLowerCase().includes(filterText)
  );

  function createRow() {
    const tr = document.createElement('div');
    tr.className = 'board__row';
    tr.style.height = `${ROW_HEIGHT}px`;
    tr.style.width = `${Math.max(totalWidth, 100)}px`;

    const cells = new Array(STICKY.length + problemCount);
    for (let i = 0; i < STICKY.length; i++) {
      const name = STICKY[i];
      const td = document.createElement('div');
      td.className = `row-cell col-${name}`;
      td.style.width = `${COLUMN_WIDTHS[name]}px`;
      td.style.left = `${STICKY_OFFSETS[name]}px`;
      cells[i] = td;
      tr.append(td);
    }
    for (let p = 0; p < problemCount; p++) {
      const td = document.createElement('div');
      td.className = 'cell';
      td.style.width = `${COLUMN_WIDTHS.solved}px`;
      cells[STICKY.length + p] = td;
      tr.append(td);
    }
    tr._cells = cells;
    tr._cellsAttached = true;
    return tr;
  }

  /**
   * Whether a problem's alias is visible *on this board*.
   *
   * While frozen the board behaves like the classic ICPC frozen ranklist: every
   * problem's alias is shown, because the point of the freeze is to hide
   * *results*, not problem identities. When live, the CCPC-new-ranklist reveal
   * threshold applies.
   */
  function aliasVisible(probIdx) {
    if (frame.frozen) return true;
    return frame.visibleSec >= frame.stats.aliasRevealed[probIdx];
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  /**
   * Update text, flashing the cell **once** when the value actually changes.
   *
   * The previous version restarted the animation on every repaint, which made
   * every solve count on the board blink continuously.
   */
  function pulseText(node, text) {
    if (node.textContent === text) return;
    node.textContent = text;
    if (text === '') return;
    node.classList.add('is-changed');
    if (node._flashTimer) clearTimeout(node._flashTimer);
    node._flashTimer = setTimeout(() => {
      node.classList.remove('is-changed');
      node._flashTimer = null;
    }, 750);
  }

  /** Fill one row element from a board row. */
  function renderRow(tr, row) {
    const { state, frozen, stats } = frame;
    const cells = tr._cells;

    let className = 'board__row';
    if (!row.official) className += ' is-unofficial';
    if ((pinnedTeamId !== null && row.team.id === pinnedTeamId) || matchesFilter(row)) {
      className += ' is-match';
    } else if (filterText) {
      className += ' is-dimmed';
    }
    if (tr.className !== className) tr.className = className;
    if (tr.dataset.teamId !== row.team.id) tr.dataset.teamId = row.team.id;

    setText(cells[0], row.official ? String(row.rank) : '—');
    setText(cells[1], row.team.name);
    const title = row.team.members?.length ? row.team.members.join(' / ') : row.team.name;
    if (cells[1].title !== title) cells[1].title = title;
    setText(cells[2], row.team.organization ?? '');
    pulseText(cells[3], String(row.solved));
    setText(cells[4], String(Math.floor(row.penalty / 60)));

    const order = row.columns;
    for (let position = 0; position < problemCount; position++) {
      const probIdx = order[position];
      const td = cells[STICKY.length + position];
      const content = cellContent(state, row.teamIdx, probIdx, frame.triesFallback, { frozen });
      const revealed = aliasVisible(probIdx);

      // A solve on a still-hidden problem is shown as solved but tinted
      // differently, so it is visually clear the problem number is unknown.
      const cls = (!revealed && content.solved)
        ? `${content.className} cell--hidden-solve`
        : content.className;

      if (td.className !== cls) td.className = cls;
      if (td.dataset.prob !== String(probIdx)) td.dataset.prob = String(probIdx);
      if (td.dataset.revealed !== (revealed ? '1' : '0')) {
        td.dataset.revealed = revealed ? '1' : '0';
      }
      if (td.dataset.pending !== (content.pending ? '1' : '0')) {
        td.dataset.pending = content.pending ? '1' : '0';
      }
      pulseText(td, content.text);
    }

    tr._order = order;
  }

  /** Header: live solve/submit counts, order, and colour only when revealed. */
  function renderHeader() {
    const { stats, visibleSec } = frame;

    const orderKey = stats.order.join(',');
    if (orderKey !== lastHeaderOrder) {
      lastHeaderOrder = orderKey;
      const fragment = document.createDocumentFragment();
      for (const probIdx of stats.order) fragment.append(headers[probIdx].cell);
      headProbs.append(fragment);
    }

    for (let probIdx = 0; probIdx < problemCount; probIdx++) {
      const entry = headers[probIdx];
      const solved = stats.solved[probIdx] ?? 0;
      const submitted = stats.submitted[probIdx] ?? 0;
      const revealed = aliasVisible(probIdx);

      // Flash once when a problem's alias first appears.
      if (revealed && entry._wasRevealed === false) {
        entry.cell.classList.add('is-just-revealed');
      } else if (!revealed) {
        entry.cell.classList.remove('is-just-revealed');
      }
      entry._wasRevealed = revealed;

      setText(entry.alias, revealed ? String(entry.problem.alias ?? '?') : '?');
      // The header shows accepted / submitted as of the displayed second.
      pulseText(entry.count, `${solved}/${submitted}`);

      // Toggle the state class rather than assigning the whole className, so
      // the reveal animation is never clobbered mid-flight.
      entry.cell.classList.toggle('is-hidden', !revealed);

      const title = headerTitle(entry.problem, revealed, solved, submitted);
      if (entry.cell.title !== title) entry.cell.title = title;
      if (entry.cell.dataset.count !== String(solved)) entry.cell.dataset.count = String(solved);
    }
  }

  function viewportRowCount() {
    const height = container.clientHeight || 600;
    return Math.max(1, Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2);
  }

  /** Repaint the visible window. */
  function paint() {
    if (!frame) return;

    const total = rows.length;
    inner.style.height = `${HEAD_HEIGHT + total * ROW_HEIGHT}px`;

    const first = Math.max(0, Math.floor(container.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = total === 0 ? 0 : Math.min(total - first, viewportRowCount());

    const nextElements = new Array(count);
    const keep = new Set();

    for (let i = 0; i < count; i++) {
      const row = rows[first + i];
      let tr = rendered.get(row.teamIdx);
      if (!tr) {
        tr = createRow();
        rendered.set(row.teamIdx, tr);
      }
      keep.add(row.teamIdx);

      // Re-apply the team's own column order only when it actually changed.
      if (tr._order !== row.columns) {
        tr.replaceChildren(...tr._cells);
        tr._order = row.columns;
      }
      // `transform` (not `top`) so rank swaps can be animated by CSS.
      tr.style.transform = `translateY(${HEAD_HEIGHT + (first + i) * ROW_HEIGHT}px)`;
      renderRow(tr, row);
      nextElements[i] = tr;
    }

    reconcile(nextElements);
    prune(keep, nextElements);
  }

  /**
   * Make the DOM order match `nextElements`.
   *
   * Elements are reused across updates, so this moves nodes rather than
   * rebuilding them: a rank swap is a single insertBefore, and CSS transitions
   * the two rows to their new positions instead of flickering.
   */
  function reconcile(nextElements) {
    let cursor = head.nextSibling;
    for (const tr of nextElements) {
      if (tr === cursor) {
        cursor = tr.nextSibling;
        continue;
      }
      inner.insertBefore(tr, cursor);
    }
  }

  /** Detach rows that are neither in the window nor requested again. */
  function prune(keep, nextElements) {
    const kept = new Set(nextElements);
    for (const [teamIdx, tr] of rendered) {
      if (keep.has(teamIdx)) continue;
      if (kept.has(tr)) continue;
      rendered.delete(teamIdx);
      tr.remove();
    }
  }

  let scheduled = false;
  function schedulePaint() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        paint();
      } catch (error) {
        console.error('[board] paint failed', error);
      }
    });
  }

  container.addEventListener('scroll', schedulePaint, { passive: true });

  return {
    render(nextFrame) {
      frame = nextFrame;
      rows = nextFrame.rows;
      renderHeader();
      schedulePaint();
    },

    setPinnedTeam(teamId) {
      pinnedTeamId = teamId ?? null;
      schedulePaint();
    },

    setFilter(text) {
      filterText = text.trim().toLowerCase();
      schedulePaint();
    },

    scrollToTeam(teamIdx) {
      const index = rows.findIndex((row) => row.teamIdx === teamIdx);
      if (index < 0) return;
      container.scrollTop = Math.max(0, index * ROW_HEIGHT);
      schedulePaint();
    },

    get rowCount() { return rows.length; },
    get rows() { return rows; },

    destroy() {
      container.removeEventListener('scroll', schedulePaint);
      container.replaceChildren();
    },
  };
}
