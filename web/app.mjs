/**
 * CCPC Neo VP — browser application.
 *
 * Flow: pick a contest + start time -> countdown -> live board -> final reveal.
 * The heavy lifting (SRK normalisation) happens on the server; this module
 * drives the client-side replay engine and the DOM.
 */

import { createBoard } from '/app/board.mjs';
import { createSession, PHASE, SPEEDS } from '/shared/live.mjs';
import { formatClock } from '/shared/replay.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  contestName: $('contest-name'),
  badgePhase: $('badge-phase'),
  badgeFreeze: $('badge-freeze'),
  badgeCoverage: $('badge-coverage'),
  btnSettings: $('btn-settings'),
  btnChange: $('btn-change'),

  player: $('player'),
  clockContest: $('clock-contest'),
  clockTotal: $('clock-total'),
  clockWall: $('clock-wall'),
  seek: $('seek'),
  playerStatus: $('player-status'),
  btnPause: $('btn-pause'),
  btnLive: $('btn-live'),
  btnReveal: $('btn-reveal'),
  speedButtons: [...document.querySelectorAll('[data-speed]')],

  filterbar: $('filterbar'),
  teamFilter: $('team-filter'),
  officialOnly: $('official-only'),
  boardSummary: $('board-summary'),

  viewPicker: $('view-picker'),
  viewCountdown: $('view-countdown'),
  viewBoard: $('view-board'),

  setup: $('setup'),
  contestSearch: $('contest-search'),
  contestHint: $('contest-hint'),
  contestList: $('contest-list'),
  startMode: $('start-mode'),
  fieldDelay: $('field-delay'),
  fieldAbsolute: $('field-absolute'),
  startDelay: $('start-delay'),
  startAbsolute: $('start-absolute'),
  freezeMode: $('freeze-mode'),
  revealScope: $('reveal-scope'),
  setupError: $('setup-error'),
  btnStart: $('btn-start'),

  countdownValue: $('countdown-value'),
  countdownMeta: $('countdown-meta'),
  btnCountdownSkip: $('btn-countdown-skip'),
  btnCountdownCancel: $('btn-countdown-cancel'),

  board: $('board'),
  footerSource: $('footer-source'),

  settingsDialog: $('settings-dialog'),
  settingsFreeze: $('settings-freeze'),
  settingsScope: $('settings-scope'),
  settingsInfo: $('settings-info'),
};

const app = {
  contests: [],
  contestsFetchedAt: 0,
  selectedUk: null,
  timeline: null,
  session: null,
  board: null,
  rafId: 0,
  lastBoardRender: 0,
  /** teams retained for the future balloon feature */
  pinnedTeamId: null,
};

// --------------------------------------------------------------- utilities

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error?.message) detail = body.error.message;
    } catch { /* keep the status text */ }
    throw new Error(detail);
  }
  return response.json();
}

/** Fetch and gunzip the timeline payload. */
async function fetchTimeline(uk) {
  const response = await fetch(`/api/timeline?uk=${encodeURIComponent(uk)}`, {
    headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error?.message) detail = body.error.message;
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const encoding = response.headers.get('content-encoding') ?? '';
  let text;
  if (encoding.includes('gzip') && response.body && typeof DecompressionStream === 'function') {
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = await response.text();
  }

  const body = JSON.parse(text);
  return { timeline: body.data.timeline, cached: body.data.cached, stale: body.data.stale };
}

const durationLabel = (seconds) =>
  seconds === null || seconds === undefined ? '—' : formatClock(seconds);

const startLabel = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
};

function showView(name) {
  el.viewPicker.hidden = name !== 'picker';
  el.viewCountdown.hidden = name !== 'countdown';
  el.viewBoard.hidden = name !== 'board';
  el.player.hidden = name === 'picker';
  el.filterbar.hidden = name !== 'board';
}

function setError(message) {
  el.setupError.hidden = !message;
  el.setupError.textContent = message ?? '';
}

// ------------------------------------------------------------ contest list

async function loadContests({ refresh = false } = {}) {
  el.contestHint.textContent = '正在加载比赛列表…';
  try {
    const body = await getJson(`/api/contests${refresh ? '?refresh=1' : ''}`);
    app.contests = body.data.contests;
    app.contestsFetchedAt = body.data.fetchedAt;
    renderContestList();
    const selectable = app.contests.filter((contest) => contest.hasRanklist).length;
    el.contestHint.textContent = `共 ${app.contests.length} 场（其中 ${selectable} 场有榜单）`
      + (body.data.stale ? ' · 数据源暂不可用，正在使用缓存' : '');
  } catch (error) {
    el.contestHint.textContent = '';
    setError(`比赛列表加载失败：${error.message}`);
  }
}

function renderContestList() {
  const needle = el.contestSearch.value.trim().toLowerCase();
  const filtered = app.contests
    .filter((contest) => !needle
      || contest.name.toLowerCase().includes(needle)
      || contest.uk.toLowerCase().includes(needle))
    .slice(0, 200);

  el.contestList.replaceChildren();
  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.textContent = '没有匹配的比赛';
    li.setAttribute('aria-disabled', 'true');
    el.contestList.append(li);
    return;
  }

  for (const contest of filtered) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.uk = contest.uk;
    const disabled = !contest.hasRanklist;
    if (disabled) li.setAttribute('aria-disabled', 'true');
    li.setAttribute('aria-selected', String(app.selectedUk === contest.uk));

    const name = document.createElement('span');
    name.className = 'cl-name';
    name.textContent = contest.name;

    const meta = document.createElement('span');
    meta.className = 'cl-meta';
    const frozen = Number(contest.frozenDurationSec) > 0
      ? ' · 有封榜'
      : '';
    meta.textContent = `${contest.uk} · ${durationLabel(contest.durationSec)}${frozen}`;

    li.append(name, meta);
    li.title = `${contest.name}\n开始: ${startLabel(contest.startAt)}\n时长: ${durationLabel(contest.durationSec)}`
      + `${disabled ? '\n(无榜单数据)' : ''}`;

    if (!disabled) {
      li.addEventListener('click', () => {
        app.selectedUk = contest.uk;
        el.btnStart.disabled = false;
        renderContestList();
        el.contestList.scrollIntoView({ block: 'nearest' });
      });
    }

    el.contestList.append(li);
  }
}

// ---------------------------------------------------------------- starting

function setupStartMode() {
  const absolute = el.startMode.value === 'absolute';
  el.fieldDelay.hidden = absolute;
  el.fieldAbsolute.hidden = !absolute;
}

/** Resolve the chosen start time into epoch ms. */
function resolveStartAt() {
  if (el.startMode.value === 'absolute') {
    const value = el.startAbsolute.value;
    if (!value) throw new Error('请选择开赛时刻');
    const parsed = new Date(value).getTime();
    if (Number.isNaN(parsed)) throw new Error('开赛时刻格式不正确');
    return parsed;
  }
  const delaySec = Number(el.startDelay.value) || 0;
  return Date.now() + delaySec * 1000;
}

async function startVp() {
  if (!app.selectedUk) {
    setError('请先选择一场比赛');
    return;
  }

  let startAt;
  try {
    startAt = resolveStartAt();
  } catch (error) {
    setError(error.message);
    return;
  }

  setError(null);
  el.btnStart.disabled = true;
  el.btnStart.textContent = '正在下载并回放…';

  try {
    const { timeline } = await fetchTimeline(app.selectedUk);
    app.timeline = timeline;
    app.session = createSession(timeline, {
      startAt,
      now: Date.now(),
      freezeMode: el.freezeMode.value,
      revealScope: el.revealScope.value,
      officialOnly: el.officialOnly.checked,
    });
    enterCountdown();
  } catch (error) {
    setError(`加载失败：${error.message}`);
  } finally {
    el.btnStart.disabled = false;
    el.btnStart.textContent = '加载并开始';
  }
}

function enterCountdown() {
  el.contestName.textContent = app.timeline.name || app.selectedUk;
  el.clockTotal.textContent = `/ ${formatClock(app.timeline.contest.durationSec)}`;
  el.badgeCoverage.hidden = app.timeline.coverage.exact !== false;
  el.seek.max = String(app.timeline.contest.durationSec);
  el.seek.value = '0';

  el.officialOnly.checked = app.session.officialOnly;
  el.settingsFreeze.value = app.session.freezeMode;
  el.settingsScope.value = app.session.revealScope;

  el.countdownMeta.textContent = buildCountdownMeta();
  showView('countdown');
  startLoop();
}

function buildCountdownMeta() {
  const { timeline, session } = app;
  const parts = [
    `时长 ${formatClock(timeline.contest.durationSec)}`,
    `队伍 ${timeline.teams.length}`,
    `题目 ${timeline.problems.length}`,
  ];
  if (timeline.contest.frozenDurationSec > 0 && session.freezeMode !== 'never') {
    parts.push(`封榜 ${Math.round(timeline.contest.frozenDurationSec / 60)} 分钟`);
  } else {
    parts.push('全程实时');
  }
  if (timeline.coverage.exact === false) parts.push('⚠ 排序规则已降级（无提交时间轴）');
  parts.push(`开赛 ${new Date(session.startAt).toLocaleString('zh-CN', { hour12: false })}`);
  return parts.join(' · ');
}

function enterBoard() {
  if (!app.board) {
    app.board = createBoard({ container: el.board, timeline: app.timeline });
  }
  app.board.setPinnedTeam(app.pinnedTeamId);
  el.footerSource.textContent = app.timeline.source.srkUrl
    ? `榜单文件: ${app.timeline.source.srkUrl.split('/').slice(-2).join('/')}`
    : '';
  el.settingsInfo.textContent = `过题门限：${app.timeline.reveal.all.threshold} 队`
    + `（全部 ${app.timeline.reveal.all.teamsRanked} 队）`
    + ` / ${app.timeline.reveal.official.threshold} 队（官方 ${app.timeline.reveal.official.teamsRanked} 队）`;
  showView('board');
}

// ------------------------------------------------------------------- loop

function startLoop() {
  if (app.rafId) return;
  const tick = () => {
    app.rafId = requestAnimationFrame(tick);
    updateUi();
  };
  app.rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (app.rafId) cancelAnimationFrame(app.rafId);
  app.rafId = 0;
}

function updateUi() {
  const session = app.session;
  if (!session) return;

  const frame = session.update(Date.now());

  if (frame.contestSec < 0) {
    renderCountdown(frame);
    return;
  }
  if (el.viewCountdown.hidden === false) enterBoard();
  renderBoard(frame);
}

function renderCountdown(frame) {
  const remaining = Math.max(0, -frame.contestSec);
  const minutes = Math.floor(remaining / 60);
  const seconds = Math.floor(remaining % 60);
  el.countdownValue.textContent = minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}`
    : `${Math.ceil(remaining)}`;
}

function renderBoard(frame) {
  el.clockContest.textContent = formatClock(Math.max(0, Math.floor(frame.contestSec)));
  el.clockWall.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.seek.value = String(frame.visibleSec);
  el.seek.title = `比赛时间 ${formatClock(frame.visibleSec)}`;

  el.badgeFreeze.hidden = !frame.frozen;
  el.badgePhase.textContent = {
    [PHASE.PENDING]: '等待开始',
    [PHASE.RUNNING]: '进行中',
    [PHASE.FROZEN]: '已封榜',
    [PHASE.ENDED]: '已结束',
  }[frame.phase] ?? frame.phase;
  el.badgePhase.classList.toggle('badge--live', frame.phase === PHASE.RUNNING);

  el.btnReveal.hidden = !frame.revealPending;
  el.btnPause.textContent = frame.detached ? '继续' : '暂停';
  el.btnLive.hidden = !frame.detached;
  for (const button of el.speedButtons) {
    button.classList.toggle('is-active', Number(button.dataset.speed) === frame.speed);
  }

  const status = [];
  if (frame.detached) status.push('已脱离实时（拖动或暂停中）');
  if (frame.revealed) status.push('已揭榜：显示最终榜单');
  else if (frame.frozen) status.push(`已封榜于 ${formatClock(frame.frozenAtSec)}`);
  status.push(`显示 ${frame.rows.length} 队`);
  el.playerStatus.textContent = status.join(' · ');
  el.boardSummary.textContent = `共 ${frame.rows.length} 队 · 当前显示至 ${formatClock(frame.visibleSec)}`;

  const now = performance.now();
  if (app.board && now - app.lastBoardRender >= 200) {
    app.lastBoardRender = now;
    app.board.render(frame);
  }
}

// ------------------------------------------------------------- interactions

el.setup.addEventListener('submit', (event) => {
  event.preventDefault();
  void startVp();
});

el.contestSearch.addEventListener('input', renderContestList);
el.startMode.addEventListener('change', setupStartMode);

el.btnCountdownCancel.addEventListener('click', () => {
  stopLoop();
  app.session = null;
  showView('picker');
});

el.btnCountdownSkip.addEventListener('click', () => {
  if (!app.session) return;
  app.session.setStartAt(Date.now(), Date.now());
  enterBoard();
  updateUi();
});

el.btnChange.addEventListener('click', () => {
  stopLoop();
  app.session = null;
  if (app.board) {
    app.board.destroy();
    app.board = null;
  }
  el.teamFilter.value = '';
  app.pinnedTeamId = null;
  showView('picker');
  el.badgeFreeze.hidden = true;
  el.badgePhase.textContent = '准备中';
});

el.btnPause.addEventListener('click', () => {
  app.session?.togglePause(Date.now());
  updateUi();
});

el.btnLive.addEventListener('click', () => {
  app.session?.followLive(Date.now());
  updateUi();
});

el.btnReveal.addEventListener('click', () => {
  app.session?.reveal(Date.now());
  updateUi();
});

el.seek.addEventListener('input', () => {
  if (!app.session) return;
  app.session.seek(Number(el.seek.value), Date.now());
  updateUi();
});

for (const button of el.speedButtons) {
  button.addEventListener('click', () => {
    if (!app.session) return;
    app.session.setSpeed(Number(button.dataset.speed));
    updateUi();
  });
}

el.teamFilter.addEventListener('input', () => {
  app.board?.setFilter(el.teamFilter.value);
});

el.officialOnly.addEventListener('change', () => {
  app.session?.setOfficialOnly(el.officialOnly.checked, Date.now());
  updateUi();
});

el.btnSettings.addEventListener('click', () => {
  if (app.session) {
    el.settingsFreeze.value = app.session.freezeMode;
    el.settingsScope.value = app.session.revealScope;
  }
  el.settingsDialog.showModal();
});

el.settingsFreeze.addEventListener('change', () => {
  app.session?.setFreezeMode(el.settingsFreeze.value, Date.now());
  el.freezeMode.value = el.settingsFreeze.value;
  updateUi();
});

el.settingsScope.addEventListener('change', () => {
  app.session?.setRevealScope(el.settingsScope.value, Date.now());
  el.revealScope.value = el.settingsScope.value;
  updateUi();
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (!app.session) return;
  if (event.code === 'Space') {
    event.preventDefault();
    app.session.togglePause(Date.now());
    updateUi();
  } else if (event.code === 'ArrowRight') {
    event.preventDefault();
    app.session.seek(app.session.currentSec() + 60, Date.now());
    updateUi();
  } else if (event.code === 'ArrowLeft') {
    event.preventDefault();
    app.session.seek(app.session.currentSec() - 60, Date.now());
    updateUi();
  }
});

window.addEventListener('beforeunload', stopLoop);

// ------------------------------------------------------------------ boot

setupStartMode();
showView('picker');
void loadContests();
