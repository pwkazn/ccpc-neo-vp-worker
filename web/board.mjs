/**
 * Virtualised ranklist board renderer.
 *
 * Only the rows inside the viewport (plus an overscan margin) exist in the DOM,
 * which keeps a 2700-team board smooth.
 *
 * Column layout follows the CCPC new ranklist rules: the header lists every
 * problem in problem-number order (aliases hidden until revealed), while each
 * *row* reorders its own cells so that the problems that team solved most
 * recently appear first. Because the column order is per team, a cell's
 * position is not a problem identity — the cell datasets carry the identity.
 */

const OVERSCAN = 8;
const ROW_HEIGHT = 26;
const HEAD_HEIGHT = 52;
const STICKY = ['rank', 'team', 'org', 'solved', 'penalty'];

/** Sticky column widths, mirrored in ui.css. */
export const COLUMN_WIDTHS = Object.freeze({
  rank: 50,
  team: 172,
  org: 150,
  solved: 58,
  penalty: 58,
});

/**
 * Content of one problem cell, derived only from replayed state.
 *
 * The alias being hidden does not affect this: a team's solve on an unrevealed
 * problem is still shown (the CCPC new format shows *that* a problem was solved,
 * just not which one).
 *
 * @param {object} state replay state
 * @param {number} teamIdx
 * @param {number} probIdx
 * @param {ArrayLike<number>|null} [triesFallback] per-team attempt counts used by
 *   legacy ranklists that carry no per-solution timestamps. Pass `null` when the
 *   timeline is exact, so the live count is authoritative. A per-problem entry of
 *   `-1` also means "unknown, use the live count".
 * @returns {{ text: string, className: string, solved: boolean, attempted: boolean }}
 */
export function cellContent(state, teamIdx, probIdx, triesFallback = null) {
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
    };
  }

  if (tries > 0) {
    return {
      text: `-${tries}`,
      className: 'cell cell--failed',
      solved: false,
      attempted: true,
    };
  }

  return { text: '', className: 'cell', solved: false, attempted: false };
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container scroll container (`#board`)
 * @param {object} options.timeline wire timeline
 */
export function createBoard({ container, timeline }) {
  container.replaceChildren();

  const problemCount = timeline.problems.length;
  const totalColumns = STICKY.length + problemCount;

  const table = document.createElement('table');
  table.className = 'board__table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  const headers = {};
  for (const name of STICKY) {
    const cell = document.createElement('th');
    cell.className = `col-${name}`;
    cell.textContent = { rank: '名次', team: '队伍', org: '学校', solved: '题数', penalty: '罚时' }[name];
    headers[name] = cell;
    headRow.append(cell);
  }

  /** @type {Array<{cell: HTMLElement, alias: HTMLElement, acc: HTMLElement}>} */
  const probHeaders = timeline.problems.map((problem) => {
    const cell = document.createElement('th');
    cell.className = 'prob';
    const chip = document.createElement('span');
    chip.className = 'prob-chip';
    const swatch = document.createElement('span');
    swatch.className = 'prob-swatch';
    if (problem.color) swatch.style.background = problem.color;
    const alias = document.createElement('span');
    alias.className = 'prob-alias';
    alias.textContent = '?';
    const acc = document.createElement('span');
    acc.className = 'prob-acc';
    chip.append(swatch, alias, acc);
    cell.append(chip);
    cell.title = problem.title
      ? `${problem.alias} — ${problem.title}`
      : String(problem.alias ?? '');
    headRow.append(cell);
    return { cell, alias, acc, problem };
  });

  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');

  // Scroll spacers keep the container's scrollable height correct.
  const makeSpacer = () => {
    const tr = document.createElement('tr');
    tr.className = 'spacer';
    const td = document.createElement('td');
    td.colSpan = totalColumns;
    tr.append(td);
    return tr;
  };
  const spacerTop = makeSpacer();
  const spacerBottom = makeSpacer();
  tbody.append(spacerTop, spacerBottom);
  table.append(tbody);
  container.append(table);

  // ---- render state -------------------------------------------------------
  let rows = [];
  let frame = null;
  /** team index -> row element currently in the DOM */
  const rendered = new Map();
  let windowStart = -1;
  let windowCount = 0;

  let filterText = '';
  let pinnedTeamId = null;
  let lastHeaderKey = '';

  const matchesFilter = (row) => filterText.length > 0 && (
    row.team.name.toLowerCase().includes(filterText)
    || (row.team.organization ?? '').toLowerCase().includes(filterText)
  );

  function createRow() {
    const tr = document.createElement('tr');
    const cells = new Array(totalColumns);
    for (let i = 0; i < STICKY.length; i++) {
      const td = document.createElement('td');
      td.className = `col-${STICKY[i]}`;
      cells[i] = td;
      tr.append(td);
    }
    for (let p = 0; p < problemCount; p++) {
      const td = document.createElement('td');
      td.className = 'cell';
      cells[STICKY.length + p] = td;
      tr.append(td);
    }
    tr._cells = cells;
    return tr;
  }

  /**
   * Fill one row element from a board row. Cells are physically reordered
   * outside the DOM (via `replaceChildren`) only when the order changed.
   */
  function renderRow(tr, row) {
    const { reveal, visibleSec, state } = frame;
    const cells = tr._cells;
    const order = row.columns;

    tr.className = row.official ? '' : 'is-unofficial';
    if ((pinnedTeamId !== null && row.team.id === pinnedTeamId) || matchesFilter(row)) {
      tr.classList.add('is-match');
    }
    tr.dataset.teamId = row.team.id;

    const rankCell = cells[0];
    const rankText = row.official ? String(row.rank) : '—';
    if (rankCell.textContent !== rankText) rankCell.textContent = rankText;

    const teamCell = cells[1];
    if (teamCell.textContent !== row.team.name) teamCell.textContent = row.team.name;
    const title = row.team.members?.length ? row.team.members.join(' / ') : row.team.name;
    if (teamCell.title !== title) teamCell.title = title;

    const orgCell = cells[2];
    const org = row.team.organization ?? '';
    if (orgCell.textContent !== org) orgCell.textContent = org;

    const solvedCell = cells[3];
    const solvedText = String(row.solved);
    if (solvedCell.textContent !== solvedText) solvedCell.textContent = solvedText;

    const penaltyCell = cells[4];
    const penaltyText = String(Math.floor(row.penalty / 60));
    if (penaltyCell.textContent !== penaltyText) penaltyCell.textContent = penaltyText;

    for (let position = 0; position < problemCount; position++) {
      const probIdx = order[position];
      const td = cells[STICKY.length + position];
      const content = cellContent(state, row.teamIdx, probIdx, frame.triesFallback);

      if (td.className !== content.className) td.className = content.className;
      if (td.textContent !== content.text) td.textContent = content.text;

      const prob = String(probIdx);
      if (td.dataset.prob !== prob) td.dataset.prob = prob;
      const isRevealed = reveal.revealSec[probIdx] !== Infinity
        && visibleSec >= reveal.revealSec[probIdx];
      if (td.dataset.revealed !== (isRevealed ? '1' : '0')) {
        td.dataset.revealed = isRevealed ? '1' : '0';
      }
    }

    tr._order = order;
  }

  /** Problem header shows every problem in problem-number order. */
  function renderHeader() {
    const { reveal, visibleSec } = frame;
    const headerKey = probHeaders
      .map((entry, i) => (reveal.revealSec[i] !== Infinity && visibleSec >= reveal.revealSec[i] ? 1 : 0))
      .join('');
    if (headerKey === lastHeaderKey) return;
    lastHeaderKey = headerKey;

    for (let i = 0; i < probHeaders.length; i++) {
      const { cell, alias, acc, problem } = probHeaders[i];
      const shown = reveal.revealSec[i] !== Infinity && visibleSec >= reveal.revealSec[i];
      const aliasText = shown ? String(problem.alias ?? '?') : '?';
      if (alias.textContent !== aliasText) alias.textContent = aliasText;
      const accText = shown && Number.isFinite(problem.accepted) ? String(problem.accepted) : '';
      if (acc.textContent !== accText) acc.textContent = accText;
      cell.classList.toggle('is-hidden', !shown);
      cell.title = shown
        ? `${problem.alias}${problem.title ? ` — ${problem.title}` : ''}`
        : '题号尚未显示（过题队伍数未达门限）';
    }
  }

  function viewportRowCount() {
    const height = container.clientHeight || 600;
    return Math.max(1, Math.ceil((height - HEAD_HEIGHT) / ROW_HEIGHT) + OVERSCAN * 2);
  }

  function ensureRow(teamIdx) {
    let tr = rendered.get(teamIdx);
    if (!tr) {
      tr = createRow();
      rendered.set(teamIdx, tr);
    }
    return tr;
  }

  /** Repaint the visible window. */
  function paint() {
    if (!frame || rows.length === 0) {
      spacerTop.firstChild.style.height = '0px';
      spacerBottom.firstChild.style.height = '0px';
      return;
    }

    const total = rows.length;
    const first = Math.max(0, Math.floor(container.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.min(total - first, viewportRowCount());

    spacerTop.firstChild.style.height = `${first * ROW_HEIGHT}px`;
    spacerBottom.firstChild.style.height = `${Math.max(0, total - first - count) * ROW_HEIGHT}px`;

    const nextElements = new Array(count);
    const keep = new Set();

    for (let i = 0; i < count; i++) {
      const row = rows[first + i];
      const tr = ensureRow(row.teamIdx);
      keep.add(row.teamIdx);
      // The column order is per team, so apply it before filling the cells.
      if (tr._domOrder !== row.columns) {
        tr.replaceChildren(...tr._cells);
        tr._domOrder = row.columns;
      }
      renderRow(tr, row);
      nextElements[i] = tr;
    }

    // Drop elements that scrolled out of the window.
    let pruned = false;
    for (const [teamIdx, tr] of rendered) {
      if (!keep.has(teamIdx)) {
        rendered.delete(teamIdx);
        tr.remove();
        pruned = true;
      }
    }

    if (pruned || count !== windowCount || first !== windowStart) {
      const fragment = document.createDocumentFragment();
      fragment.append(spacerTop);
      for (const tr of nextElements) fragment.append(tr);
      fragment.append(spacerBottom);
      tbody.replaceChildren(fragment);
    }

    windowStart = first;
    windowCount = count;
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
    /** Update the board from a session frame. */
    render(nextFrame) {
      frame = nextFrame;
      rows = nextFrame.rows;
      renderHeader();
      schedulePaint();
    },

    setPinnedTeam(teamId) {
      pinnedTeamId = teamId ?? null;
      windowStart = -1;
      schedulePaint();
    },

    setFilter(text) {
      filterText = text.trim().toLowerCase();
      schedulePaint();
    },

    /** Scroll so that a team is visible. */
    scrollToTeam(teamIdx) {
      const index = rows.findIndex((row) => row.teamIdx === teamIdx);
      if (index < 0) return;
      container.scrollTop = Math.max(0, index * ROW_HEIGHT - container.clientHeight / 3);
      schedulePaint();
    },

    scrollToIndex(index) {
      container.scrollTop = Math.max(0, index * ROW_HEIGHT);
      schedulePaint();
    },

    get rowCount() { return rows.length; },
    get rows() { return rows; },
    get contentWidth() { return table.scrollWidth; },

    destroy() {
      container.removeEventListener('scroll', schedulePaint);
      container.replaceChildren();
    },
  };
}
