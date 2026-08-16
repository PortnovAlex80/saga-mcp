// L3 «Хроника» — единая лента событий завода, «чёрный ящик» (исполнитель B,
// контракт: core-view/SPEC.md).
//
// Механика:
//   • собственный poll /api/core/events каждые 1000 мс: since = последнее
//     видимое `at` (сервер сам возвращает оверлап ~5с), клиент дедуплицирует
//     по `key` — повторные события из зоны оверлапа не размножаются;
//   • кольцевой буфер ≤ 500 событий, новые сверху;
//   • автоскролл к верхушке при появлении новых, с паузой на hover: пока
//     курсор над лентой, прокрутка стоит, копится счётчик пропущенного;
//     позиция чтения оператора не прыгает;
//   • фильтр-чипы по kind (activity | gate | transition), цвет строки по kind:
//     activity — текст, gate — по вердикту из title `gate:<phase>:<verdict>`,
//     transition — scan-синий;
//   • клик по gate-событию с workplaceRef → ctx.selectWorkplace(ref).
//
// update(snapshot) используется точечно: полоса «активность N/мин» из пульса.
// Никаких записей: вид только читает.

export const viewId = 'tape';

const POLL_MS = 1000;
const BUFFER_MAX = 500;        // SPEC: буфер ≤ 500 событий
const FETCH_TIMEOUT_MS = 8000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 10000;
const INITIAL_WINDOW_MS = 60 * 60 * 1000; // первый запрос — последний час
const LIMIT = 200;             // SPEC: limit=200

const KNOWN_KINDS = ['activity', 'gate', 'transition'];

// ---- состояние модуля (один экземпляр вида на страницу) ----------------------

let ctx = null;
let root = null;
let listEl = null;
let statusEl = null;
let countEl = null;
let actEl = null;
let pauseBadge = null;
let emptyEl = null;

let buffer = [];          // события, новые сверху (индекс 0 — самое свежее)
let keySet = new Set();   // дедуп по key в пределах буфера
let kindCounts = { activity: 0, gate: 0, transition: 0, other: 0 };
let filters = new Set(KNOWN_KINDS.concat(['other'])); // неизвестные kind видимы по умолчанию
let lastAt = null;        // сырое строковое `at` самого свежего события
let paused = false;
let missedWhilePaused = 0;
let wasAtTop = true;
let stopped = false;
let listeners = [];
let filterChips = new Map(); // kind -> { chip, badge }

// ---- утилиты -----------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTime(value) {
  if (value == null) return null;
  const s = String(value);
  let t = Date.parse(s);
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

// «15:06:12» из ISO или «YYYY-MM-DD HH:MM:SS» — без часовых сюрпризов,
// просто срез строки после разделителя.
function fmtClock(at) {
  const s = String(at || '');
  const t = s.indexOf('T');
  const sp = s.indexOf(' ');
  const i = t >= 0 ? t : sp;
  if (i < 0) return s;
  let rest = s.slice(i + 1);
  const dot = rest.indexOf('.');
  if (dot > 0) rest = rest.slice(0, dot);
  return rest.slice(0, 8);
}

function kindOf(ev) {
  return KNOWN_KINDS.includes(ev.kind) ? ev.kind : 'other';
}

// gate:<phase>:<verdict> → класс цвета вердикта
function gateVerdictClass(ev) {
  const m = /^gate:[^:]*:([a-z_]+)\b/i.exec(String(ev.title || ''));
  const verdict = m ? m[1] : '';
  if (verdict === 'accepted') return 'v-accepted';
  if (verdict === 'repair_required') return 'v-repair';
  if (verdict === 'rejected' || verdict === 'failed') return 'v-rejected';
  return 'v-other';
}

// workplaceRef из gate-события: SPEC не фиксирует поле, поэтому пробуем
// известные места (явное поле, entityType=Workplace, ref в detail) — best effort.
function workplaceRefOf(ev) {
  if (!ev || ev.kind !== 'gate') return null;
  if (ev.workplaceRef && typeof ev.workplaceRef === 'string') return ev.workplaceRef;
  if (ev.entityType === 'Workplace' && ev.entityId && typeof ev.entityId === 'string') {
    return ev.entityId;
  }
  if (typeof ev.detail === 'string' && ev.detail.indexOf('workplace/') === 0) {
    return ev.detail.split(/\s+/)[0];
  }
  return null;
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

// ---- рендер строки -----------------------------------------------------------

function buildRow(ev) {
  const row = el('div', 'tape-row k-' + kindOf(ev));
  row.dataset.key = ev.key;

  const time = el('span', 'tape-time', fmtClock(ev.at));
  const kind = el('span', 'tape-kind', kindOf(ev));
  const title = el('span', 'tape-title', ev.title || '');
  const detail = el('span', 'tape-detail', ev.detail || '');

  if (kindOf(ev) === 'gate') title.classList.add(gateVerdictClass(ev));

  row.title = (ev.at || '') + '\n' + (ev.title || '') + '\n' + (ev.detail || '') +
    (ev.entityType ? '\n' + ev.entityType + ': ' + (ev.entityId || '') : '');

  const ref = workplaceRefOf(ev);
  if (ref) {
    row.classList.add('tape-clickable');
    row.addEventListener('click', () => {
      if (ctx && typeof ctx.selectWorkplace === 'function') ctx.selectWorkplace(ref);
    });
  }

  row.append(time, kind, title, detail);
  return row;
}

// ---- приём событий -----------------------------------------------------------

function ingest(events) {
  const fresh = [];
  let maxAt = null;
  let maxAtT = lastAt != null ? (parseTime(lastAt) ?? -Infinity) : -Infinity;

  for (const ev of events || []) {
    if (!ev || ev.key == null) continue;
    if (keySet.has(ev.key)) continue; // дедуп по key (оверлап 5с от сервера)
    keySet.add(ev.key);
    kindCounts[kindOf(ev)] += 1;
    fresh.push(ev);
    const t = parseTime(ev.at) ?? -Infinity;
    if (t >= maxAtT) {
      maxAtT = t;
      maxAt = ev.at; // сырое значение — его и вернём как since
    }
  }
  if (maxAt != null) lastAt = maxAt;
  if (!fresh.length) return;

  fresh.sort((a, b) => (parseTime(a.at) ?? 0) - (parseTime(b.at) ?? 0));

  // если оператор читает середину ленты — фиксируем его позицию:
  // prepended-строки меняют scrollHeight, компенсируем scrollTop дельтой
  const keepPosition = !wasAtTop && !paused;
  const beforeHeight = keepPosition ? listEl.scrollHeight : 0;
  const beforeTop = keepPosition ? listEl.scrollTop : 0;

  for (const ev of fresh) {
    const row = buildRow(ev);
    buffer.unshift({ ev, row });
    listEl.insertBefore(row, listEl.firstChild);
  }
  if (keepPosition) {
    listEl.scrollTop = beforeTop + (listEl.scrollHeight - beforeHeight);
  }

  trimBuffer();
  updateToolbar();
  autoscroll(fresh.length);
}

function trimBuffer() {
  while (buffer.length > BUFFER_MAX) {
    const dropped = buffer.pop();
    keySet.delete(dropped.ev.key);
    kindCounts[kindOf(dropped.ev)] -= 1;
    if (dropped.row.parentNode) dropped.row.parentNode.removeChild(dropped.row);
  }
}

function autoscroll(n) {
  if (paused) {
    missedWhilePaused += n;
    updatePauseBadge();
    return;
  }
  if (wasAtTop) listEl.scrollTop = 0;
}

function updatePauseBadge() {
  if (!pauseBadge) return;
  if (paused && missedWhilePaused > 0) {
    pauseBadge.hidden = false;
    pauseBadge.textContent = '⏸ прокрутка на паузе · +' + missedWhilePaused;
  } else if (paused) {
    pauseBadge.hidden = false;
    pauseBadge.textContent = '⏸ прокрутка на паузе';
  } else {
    pauseBadge.hidden = true;
  }
}

function updateToolbar() {
  if (countEl) countEl.textContent = buffer.length + ' / ' + BUFFER_MAX;
  for (const [kind, refs] of filterChips) {
    refs.chip.classList.toggle('is-off', !filters.has(kind));
    refs.badge.textContent = String(kindCounts[kind] || 0);
    if (kind === 'other') refs.chip.hidden = kindCounts.other === 0;
  }
}

function applyFilters() {
  for (const kind of KNOWN_KINDS.concat(['other'])) {
    listEl.classList.toggle('hide-' + kind, !filters.has(kind));
  }
}

// ---- poll-цикл ---------------------------------------------------------------

async function pollLoop() {
  let failures = 0;
  while (!stopped) {
    try {
      const since = lastAt != null ? lastAt : new Date(Date.now() - INITIAL_WINDOW_MS).toISOString();
      const url = ctx.api.eventsUrl +
        '?since=' + encodeURIComponent(since) + '&limit=' + LIMIT;
      const data = await fetchJson(url);
      if (!data || data.ok !== true) throw new Error((data && data.error) || 'events: ok=false');
      failures = 0;
      if (statusEl) {
        statusEl.textContent = 'связь: живая';
        statusEl.classList.remove('tape-status-dead');
      }
      ingest(Array.isArray(data.events) ? data.events : []);
    } catch (err) {
      failures += 1;
      if (statusEl) {
        statusEl.textContent = 'нет связи — ' + (err && err.message ? err.message : err);
        statusEl.classList.add('tape-status-dead');
      }
    }
    const delay = failures
      ? Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
      : POLL_MS;
    await sleep(delay);
  }
}

// ---- каркас вида -------------------------------------------------------------

function buildSkeleton() {
  root = el('div', 'tape-root');

  const toolbar = el('div', 'tape-toolbar');
  const title = el('span', 'tape-titlebar', 'ХРОНИКА · чёрный ящик');
  toolbar.appendChild(title);

  const makeFilterChip = (kind, label) => {
    const chip = el('button', 'tape-filter');
    chip.type = 'button';
    chip.dataset.kind = kind;
    const badge = el('i', null, '0');
    chip.append(el('span', null, label), badge);
    chip.addEventListener('click', () => {
      if (filters.has(kind)) filters.delete(kind);
      else filters.add(kind);
      applyFilters();
      updateToolbar();
    });
    filterChips.set(kind, { chip, badge });
    if (kind === 'other') chip.hidden = true; // появляется при первых «прочих»
    toolbar.appendChild(chip);
  };
  for (const kind of KNOWN_KINDS) makeFilterChip(kind, kind);
  makeFilterChip('other', 'прочее'); // виден только когда есть неизвестные kind

  pauseBadge = el('span', 'tape-pause');
  pauseBadge.hidden = true;
  toolbar.appendChild(pauseBadge);

  const spacer = el('span', 'tape-toolbar-spacer');
  toolbar.appendChild(spacer);

  actEl = el('span', 'tape-act', '');
  toolbar.appendChild(actEl);

  statusEl = el('span', 'tape-status', 'подключение…');
  toolbar.appendChild(statusEl);

  countEl = el('span', 'tape-count', '0 / ' + BUFFER_MAX);
  toolbar.appendChild(countEl);

  listEl = el('div', 'tape-list');
  listEl.setAttribute('tabindex', '0');
  emptyEl = el('div', 'tape-empty', 'событий пока нет — ждём поток от ядра…');
  listEl.appendChild(emptyEl);

  root.append(toolbar, listEl);
}

// ---- интерфейс модуля вида (SPEC: строго четыре экспорта) --------------------

export function mount(container, viewCtx) {
  ctx = viewCtx;
  stopped = false;
  container.textContent = '';
  buildSkeleton();
  container.appendChild(root);

  const onScroll = () => {
    wasAtTop = listEl.scrollTop < 8;
    if (wasAtTop && !paused && missedWhilePaused > 0) missedWhilePaused = 0;
    updatePauseBadge();
  };
  const onEnter = () => {
    paused = true;
    updatePauseBadge();
  };
  const onLeave = () => {
    paused = false;
    missedWhilePaused = 0;
    if (wasAtTop) listEl.scrollTop = 0;
    updatePauseBadge();
  };
  listEl.addEventListener('scroll', onScroll, { passive: true });
  listEl.addEventListener('mouseenter', onEnter);
  listEl.addEventListener('mouseleave', onLeave);
  listeners = [
    [listEl, 'scroll', onScroll],
    [listEl, 'mouseenter', onEnter],
    [listEl, 'mouseleave', onLeave],
  ];

  applyFilters();
  pollLoop();
}

export function update(snapshot) {
  if (stopped || !root) return;
  // из снапшота берем только пульс — остальное хроника тянет сама
  if (snapshot && snapshot.pulse && snapshot.pulse.activityPerMin != null) {
    actEl.textContent = 'активность: ' + snapshot.pulse.activityPerMin + '/мин';
  }
}

export function destroy() {
  stopped = true;
  for (const [node, type, fn] of listeners) node.removeEventListener(type, fn);
  listeners = [];
  for (const item of buffer) {
    if (item.row.parentNode) item.row.parentNode.removeChild(item.row);
  }
  buffer = [];
  keySet.clear();
  kindCounts = { activity: 0, gate: 0, transition: 0, other: 0 };
  lastAt = null;
  paused = false;
  missedWhilePaused = 0;
  if (root && root.parentNode) root.parentNode.removeChild(root);
  root = null;
  ctx = null;
}
