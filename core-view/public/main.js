// Factory Core View — каркас приложения (исполнитель B).
//
// Пассивный наблюдатель за заводом saga-mcp (контракт: core-view/SPEC.md):
//   • polling /api/core/snapshot каждые 1000 мс, /api/core/projects каждые
//     5000 мс; каждый запрос со своим AbortController и таймаутом;
//   • экспоненциальный бэкофф при ошибках (сброс на первом же успехе);
//   • store последнего хорошего снапшота; при деградации связи сцена
//     приглушается классом .core-degraded, но последний рендер остаётся;
//   • четыре вида (Пульс/Цепочка/Ячейка/Хроника) грузятся динамическим
//     import() в try/catch: отсутствие модуля (cell/pulse до интеграции
//     исполнителя C) — не ошибка, показывается заглушка «вид в разработке»;
//   • кросс-видовой протокол — CustomEvent на window:
//       core:select-workplace {detail:{workplaceRef}} → переключение на «Ячейку»
//       core:select-project   {detail:{projectId}}   → смена проекта снапшота.
//
// Vanilla ESM, без билд-степа. Импорт вне браузера безопасен: весь DOM-код
// запускается только из boot() под guard'ом typeof document.

export const coreViewShellVersion = '0.1.0';

const SNAPSHOT_INTERVAL_MS = 1000;
const PROJECTS_INTERVAL_MS = 5000;
const FETCH_TIMEOUT_MS = 8000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15000;
const FLASH_MS = 2400;

const VIEW_IDS = ['pulse', 'chain', 'cell', 'tape'];
const VIEW_TITLES = { pulse: 'Пульс', chain: 'Цепочка', cell: 'Ячейка', tape: 'Хроника' };
const DEFAULT_VIEW = 'chain';

// ---- API-адреса (SPEC: ctx.api для видов — плоские строки-базы) -------------

const api = {
  snapshotUrl: '/api/core/snapshot',
  projectsUrl: '/api/core/projects',
  eventsUrl: '/api/core/events',
  cellUrl: '/api/core/cell',
};

// ---- store -------------------------------------------------------------------

const state = {
  activeView: DEFAULT_VIEW,
  projectId: null,        // null/'' — авто: сервер берёт последний активный
  snapshot: null,         // последний УСПЕШНЫЙ ответ /api/core/snapshot
  projects: null,         // последний успешный ответ /api/core/projects
  connection: 'boot',     // boot | live | degraded
  lastError: null,
  views: new Map(),       // viewId -> {status:loading|ready|missing|error, module, mounted}
  lastWorkplaceRef: null, // последний core:select-workplace (для re-delivery после монтирования)
  lastWorkplaceAt: 0,
  stopped: false,
};

const els = {}; // DOM-хэндлы шелла, заполняются в boot()

// ctx, который получает каждый вид (SPEC: Front-end контракт, в точности)
const viewCtx = {
  api,
  selectWorkplace(ref) {
    window.dispatchEvent(new CustomEvent('core:select-workplace', { detail: { workplaceRef: ref } }));
  },
  selectProject(id, opts) {
    window.dispatchEvent(new CustomEvent('core:select-project', {
      detail: { projectId: id, view: opts && opts.view },
    }));
  },
};

// ---- утилиты -----------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `at` может быть ISO-строкой или «YYYY-MM-DD HH:MM:SS» как в БД (SPEC).
function parseTime(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const s = String(value);
  let t = Date.parse(s);
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T') + 'Z'); // БД-формат как UTC
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T'));       // последняя попытка, локальные
  return Number.isNaN(t) ? null : t;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

// ---- polling-циклы -----------------------------------------------------------

let snapshotBusy = false;

async function tickSnapshot() {
  if (snapshotBusy || state.stopped) return; // общий мьютюкс цикла и ручных «пинков»
  snapshotBusy = true;
  try {
    const url = state.projectId
      ? api.snapshotUrl + '?project=' + encodeURIComponent(state.projectId)
      : api.snapshotUrl;
    const data = await fetchJson(url);
    if (!data || data.ok !== true) {
      // SPEC: {ok:false, error} с кодом 200 → «завод недоступен», не падаем
      throw new Error((data && data.error) || 'snapshot: ok=false');
    }
    state.snapshot = data;
    setConnection('live', null);
    renderHeader();
    renderStatusline();
    pushSnapshot();
  } finally {
    snapshotBusy = false;
  }
}

async function tickProjects() {
  if (state.stopped) return;
  const data = await fetchJson(api.projectsUrl);
  if (!data || data.ok !== true) throw new Error((data && data.error) || 'projects: ok=false');
  state.projects = data;
  renderProjects();
}

// Общий скелет цикла: tick → успех (сброс счётчика) / ошибка (бэкофф 2^n).
async function pollLoop(intervalMs, tick) {
  let failures = 0;
  while (!state.stopped) {
    try {
      await tick();
      failures = 0;
      setConnection('live', null);
    } catch (err) {
      failures += 1;
      setConnection('degraded', err && err.message ? err.message : String(err));
    }
    const delay = failures
      ? Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
      : intervalMs;
    await sleep(delay);
  }
}

function setConnection(kind, error) {
  if (state.connection === kind && state.lastError === error) return;
  state.connection = kind;
  state.lastError = error;
  renderConnection();
  const app = document.getElementById('core-app');
  if (app) app.classList.toggle('core-degraded', kind === 'degraded');
}

// ---- доставка снапшота активному виду ----------------------------------------

function pushSnapshot() {
  const entry = state.views.get(state.activeView);
  if (!entry || entry.status !== 'ready' || !entry.mounted) return;
  const mod = entry.module;
  if (typeof mod.update !== 'function') return;
  try {
    mod.update(state.snapshot);
  } catch (err) {
    console.error('[core-view] update(' + state.activeView + ') упал:', err);
  }
}

// ---- загрузка и показ видов --------------------------------------------------

function loadingStub(text) {
  const div = document.createElement('div');
  div.className = 'core-stub';
  const glyph = document.createElement('div');
  glyph.className = 'core-stub-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '◌';
  const title = document.createElement('div');
  title.className = 'core-stub-title';
  title.textContent = text || 'компонуется…';
  div.append(glyph, title);
  return div;
}

function missingStub(viewId, err) {
  const div = document.createElement('div');
  div.className = 'core-stub';
  const title = document.createElement('div');
  title.className = 'core-stub-title';
  title.textContent = 'Вид «' + (VIEW_TITLES[viewId] || viewId) + '» в разработке';
  const note = document.createElement('div');
  note.className = 'core-stub-note';
  note.textContent = 'модуль public/views/' + viewId + '.js ещё не интегрирован — как только он появится, вид подхватится автоматически (динамический import)';
  const hint = document.createElement('div');
  hint.className = 'core-stub-hint';
  hint.textContent = err && err.message ? ('причина: ' + err.message) : '';
  div.append(title, note);
  if (hint.textContent) div.append(hint);
  return div;
}

async function ensureView(viewId) {
  if (state.views.has(viewId)) return state.views.get(viewId);
  const entry = { status: 'loading', module: null, mounted: false };
  state.views.set(viewId, entry);
  try {
    // динамический import: свой chain/tape есть всегда, cell/pulse может не быть
    const mod = await import('./views/' + viewId + '.js');
    if (!mod || typeof mod.mount !== 'function' || typeof mod.update !== 'function') {
      throw new Error('модуль вида не экспортирует mount()/update()');
    }
    entry.module = mod;
    entry.status = 'ready';
  } catch (err) {
    // 404 / синтаксис / отсутствие файла — трактуем одинаково: вид в разработке
    entry.status = 'missing';
    entry.error = err;
  }
  if (state.activeView === viewId) presentView(viewId);
  return entry;
}

function presentView(viewId) {
  const section = els.views[viewId];
  if (!section) return;
  const entry = state.views.get(viewId);
  if (!entry) {
    section.textContent = '';
    section.appendChild(loadingStub('вид «' + (VIEW_TITLES[viewId] || viewId) + '» компонуется…'));
    ensureView(viewId);
    return;
  }
  if (entry.status === 'loading') return; // заглушка «компонуется» уже стоит
  if (entry.status !== 'ready') {
    section.textContent = '';
    section.appendChild(missingStub(viewId, entry.error));
    return;
  }
  if (!entry.mounted) {
    section.textContent = '';
    try {
      entry.module.mount(section, viewCtx);
      entry.mounted = true;
    } catch (err) {
      console.error('[core-view] mount(' + viewId + ') упал:', err);
      entry.status = 'missing';
      entry.error = err;
      section.textContent = '';
      section.appendChild(missingStub(viewId, err));
      return;
    }
    pushSnapshot();
    redeliverPendingWorkplace(viewId);
  }
}

// Если core:select-workplace пришёл до монтирования вида «Ячейка», событие
// терялось (подписчик ещё не существовал). Пере-доставляем один раз после
// монтирования — интеграция исполнителя C остаётся прозрачной.
function redeliverPendingWorkplace(viewId) {
  if (viewId !== 'cell') return;
  if (!state.lastWorkplaceRef) return;
  if (Date.now() - state.lastWorkplaceAt > 30000) return; // протухший выбор
  viewCtx.selectWorkplace(state.lastWorkplaceRef);
}

function showView(viewId) {
  if (!VIEW_IDS.includes(viewId)) return;
  state.activeView = viewId;
  for (const id of VIEW_IDS) {
    if (els.views[id]) els.views[id].hidden = id !== viewId;
    if (els.tabs[id]) els.tabs[id].classList.toggle('core-tab-active', id === viewId);
  }
  if (typeof location !== 'undefined' && location.hash !== '#' + viewId) {
    history.replaceState(null, '', '#' + viewId);
  }
  presentView(viewId);
}

// ---- рендер шелла ------------------------------------------------------------

function renderConnection() {
  const el = els.conn;
  if (!el) return;
  el.classList.remove('conn-live', 'conn-boot', 'conn-dead');
  if (state.connection === 'live') {
    el.classList.add('conn-live');
    setText(el, 'связь: живая');
  } else if (state.connection === 'degraded') {
    el.classList.add('conn-dead');
    const why = state.lastError ? ' — ' + state.lastError : '';
    setText(el, 'завод недоступен' + why);
  } else {
    el.classList.add('conn-boot');
    setText(el, 'подключение…');
  }
}

function renderHeader() {
  const snap = state.snapshot;
  const name = snap && snap.project ? ('#' + snap.project.id + ' ' + snap.project.name) : null;
  setText(els.projectName, 'проект: ' + (name || '—'));

  const dot = els.pulseDot;
  if (!dot) return;
  let cls = 'p-unknown';
  let title = 'нет данных о пульсе';
  if (state.connection === 'degraded') {
    cls = 'p-err';
    title = 'нет связи с наблюдателем';
  } else if (snap && snap.pulse) {
    const at = parseTime(snap.pulse.lastActivityAt);
    const now = parseTime(snap.now) != null ? parseTime(snap.now) : Date.now();
    const age = at != null ? now - at : null;
    if (age == null) {
      cls = 'p-unknown';
      title = 'активность неизвестна';
    } else if (age <= 60 * 1000) {
      cls = 'p-live';
    } else if (age <= 5 * 60 * 1000) {
      cls = 'p-warm';
    } else {
      cls = 'p-stale';
    }
    if (cls !== 'p-unknown') {
      const perMin = snap.pulse.activityPerMin != null ? snap.pulse.activityPerMin : 0;
      title = 'активность ' + perMin + '/мин · последняя: ' + (snap.pulse.lastActivityAt || '—');
    }
  }
  dot.className = 'core-pulse-dot ' + cls;
  dot.title = title;
}

function renderStatusline() {
  const snap = state.snapshot;
  if (!snap) {
    setText(els.facts, '');
    return;
  }
  const workplaces = Array.isArray(snap.workplaces) ? snap.workplaces : [];
  const workers = Array.isArray(snap.workers) ? snap.workers : [];
  const alive = workers.filter((w) => w && w.alive).length;
  const parts = [
    'станций: ' + workplaces.length,
    'воркеров живо: ' + alive + '/' + workers.length,
  ];
  if (snap.pulse && snap.pulse.activityPerMin != null) {
    parts.push('активность: ' + snap.pulse.activityPerMin + '/мин');
  }
  if (snap.lifecycle && snap.lifecycle.currentStageId) {
    parts.push('стадия: ' + snap.lifecycle.currentStageId);
  }
  setText(els.facts, parts.join(' · '));
}

function renderProjects() {
  const sel = els.projectSelect;
  if (!sel) return;
  const list = state.projects && Array.isArray(state.projects.projects)
    ? state.projects.projects
    : [];
  const wanted = state.projectId == null ? '' : String(state.projectId);
  sel.textContent = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'авто — последний активный';
  sel.appendChild(auto);

  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    const lc = p.lifecycle || null;
    const stage = lc && lc.currentStageId
      ? lc.currentStageId
      : (lc && lc.terminalStatus ? lc.terminalStatus : '—');
    const tasks = p.tasks ? ' · ' + p.tasks.done + '/' + p.tasks.total : '';
    opt.textContent = '#' + p.id + ' ' + (p.name || '?') + ' · ' + stage + tasks;
    sel.appendChild(opt);
  }

  sel.value = wanted;
  if (sel.value !== wanted) sel.value = ''; // выбранный проект исчез из списка → авто
}

let flashTimer = null;
function flash(text) {
  if (!els.flash) return;
  setText(els.flash, text);
  els.flash.classList.add('core-flash-on');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (els.flash) els.flash.classList.remove('core-flash-on');
  }, FLASH_MS);
}

// ---- кросс-видовой протокол --------------------------------------------------

function onSelectWorkplace(ev) {
  const ref = ev.detail && ev.detail.workplaceRef;
  if (!ref) return;
  state.lastWorkplaceRef = ref;
  state.lastWorkplaceAt = Date.now();
  flash('станция: ' + ref);
  showView('cell');
}

function onSelectProject(ev) {
  const id = ev.detail && ev.detail.projectId;
  if (id == null || id === '') {
    state.projectId = null;
  } else {
    const num = Number(id);
    state.projectId = Number.isFinite(num) ? num : id;
  }
  if (els.projectSelect) {
    els.projectSelect.value = state.projectId == null ? '' : String(state.projectId);
    if (els.projectSelect.value !== (state.projectId == null ? '' : String(state.projectId))) {
      els.projectSelect.value = ''; // проекта нет в списке — вернёмся к авто
      state.projectId = null;
    }
  }
  flash('проект: ' + (state.projectId == null ? 'авто' : state.projectId));
  // опционально: сразу показать вид (например, «Цепочку» из «Пульса»)
  const wantView = ev.detail && ev.detail.view;
  if (wantView && VIEW_IDS.includes(wantView)) showView(wantView);
  tickSnapshot(); // мгновенный пинок, не ждём следующего тика
}

// ---- запуск ------------------------------------------------------------------

function boot() {
  els.app = document.getElementById('core-app');
  els.projectSelect = document.getElementById('core-project-select');
  els.tabs = {};
  els.views = {};
  for (const el of document.querySelectorAll('#core-tabs .core-tab')) {
    els.tabs[el.dataset.view] = el;
    el.addEventListener('click', () => showView(el.dataset.view));
  }
  for (const id of VIEW_IDS) {
    els.views[id] = document.getElementById('core-view-' + id);
  }
  els.pulseDot = document.getElementById('core-pulse-dot');
  els.clock = document.getElementById('core-clock');
  els.conn = document.getElementById('core-conn');
  els.projectName = document.getElementById('core-project-name');
  els.facts = document.getElementById('core-facts');
  els.flash = document.getElementById('core-flash');

  els.projectSelect.addEventListener('change', () => {
    const v = els.projectSelect.value;
    state.projectId = v === '' ? null : Number(v);
    tickSnapshot();
  });

  window.addEventListener('core:select-workplace', onSelectWorkplace);
  window.addEventListener('core:select-project', onSelectProject);

  // часы оператора: местное время, раз в секунду
  const tickClock = () => setText(els.clock, new Date().toLocaleTimeString('ru-RU'));
  tickClock();
  setInterval(tickClock, 1000);

  // deep-link: #chain / #tape / …
  const fromHash = (location.hash || '').replace('#', '');
  showView(VIEW_IDS.includes(fromHash) ? fromHash : DEFAULT_VIEW);

  // главные циклы: snapshot 1с, projects 5с (бэкофф внутри pollLoop)
  pollLoop(SNAPSHOT_INTERVAL_MS, tickSnapshot);
  pollLoop(PROJECTS_INTERVAL_MS, tickProjects);

  // приветственный снапшот не ждём тика
  tickSnapshot();
}

// Импорт без DOM (node -e "import(...)") не должен падать — только определение.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const ready = document.readyState;
  if (ready === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
