// Factory Core View — L0 «Пульс завода» (исполнитель C).
//
// Контракт (core-view/SPEC.md):
//   export const viewId; mount(container, ctx); update(snapshot); destroy();
//   ctx = { api:{snapshotUrl, projectsUrl, eventsUrl, cellUrl},
//           selectWorkplace(ref), selectProject(id) }.
//
// Данные:
//   * GET /api/core/projects — poll 5000 мс → сетка мини-реакторов;
//   * GET /api/core/events?since=<ISO> — poll 2000 мс, оверлап+дедуп по key
//     → собственный кольцевой буфер активности → спарклайн;
//   * counters для верхней полосы приходят через update(snapshot) от main.js
//     (snapshot может быть null — не падаем).
//
// На верхнем уровне DOM-вызовов нет (вся логика внутри mount).

export const viewId = 'core-pulse';

/* ============================== константы ============================== */

const PROJECTS_POLL_MS = 5000;
const EVENTS_POLL_MS = 2000;
const SPARK_BUCKETS = 60;          // 60 × 2 c = 2 минуты окна
const SPARK_SEED_MS = 120000;      // стартовое окно поиска событий
const SEEN_CAP = 3000;             // предел множества дедупликации

/* ============================== state ================================== */

let root = null;
let ctx = null;
let apiProjects = '/api/core/projects';
let apiEvents = '/api/core/events';

let snapshot = null;        // от main.js (может быть null)
let projectsData = null;    // последний ok-ответ /api/core/projects
let projectsErr = '';
let eventsErr = '';

let projectsTimer = 0;
let eventsTimer = 0;
let projectsInflight = false;
let eventsInflight = false;
let abortCtl = null;

let sinceIso = null;        // курсор событий
let seenKeys = new Map();   // key → 1 (insertion-ordered, дедуп)
let ring = [];              // кольцевой буфер: новые события на каждый тик

/* ================================ API ================================== */

export function mount(container, viewCtx) {
  if (!container) return;
  ctx = viewCtx || {};
  apiProjects = (ctx.api && ctx.api.projectsUrl) || '/api/core/projects';
  apiEvents = (ctx.api && ctx.api.eventsUrl) || '/api/core/events';

  ensureStyles(cssHref('pulse.css'));

  root = document.createElement('div');
  root.className = 'core-pulse';
  root.innerHTML = [
    '<div class="core-pulse-top">',
    '  <div class="core-pulse-counters" id="core-pulse-counters"></div>',
    '  <div class="core-pulse-sparkbox">',
    '    <svg class="core-pulse-spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-label="Спарклайн активности">',
    '      <polyline class="core-pulse-spark-area" points=""></polyline>',
    '      <polyline class="core-pulse-spark-line" points=""></polyline>',
    '    </svg>',
    '    <div class="core-pulse-spark-label"><span class="core-pulse-spark-rate">—</span> соб/мин · 2 мин</div>',
    '  </div>',
    '</div>',
    '<div class="core-pulse-err"></div>',
    '<div class="core-pulse-grid" id="core-pulse-grid"></div>',
  ].join('');
  container.appendChild(root);

  tickProjects();
  tickEvents();
  projectsTimer = setInterval(tickProjects, PROJECTS_POLL_MS);
  eventsTimer = setInterval(tickEvents, EVENTS_POLL_MS);
  renderCounters();
  renderGrid();
}

export function update(snap) {
  snapshot = snap && snap.ok !== false ? snap : null;
  if (!root) return;
  renderCounters();
  renderGrid(); // подсветка активного проекта могла измениться
  // update() приходит только активному виду — освежаем данные сразу.
  if (viewVisible()) { tickProjects(); tickEvents(); }
}

export function destroy() {
  if (projectsTimer) { clearInterval(projectsTimer); projectsTimer = 0; }
  if (eventsTimer) { clearInterval(eventsTimer); eventsTimer = 0; }
  if (abortCtl) { try { abortCtl.abort(); } catch (_) { /* noop */ } abortCtl = null; }
  projectsInflight = false;
  eventsInflight = false;
  projectsData = null;
  projectsErr = '';
  eventsErr = '';
  snapshot = null;
  sinceIso = null;
  seenKeys = new Map();
  ring = [];
  if (root && root.parentNode) root.parentNode.removeChild(root);
  root = null;
  ctx = null;
}

/* ============================ poll: projects =========================== */

// Вид считается открытым, пока его DOM не спрятан (main.js прячет секцию
// атрибутом hidden, не размонтируя — poll должен остановиться).
function viewVisible() {
  if (!root) return false;
  try {
    if (typeof document !== 'undefined' && document.contains
      && typeof document.contains === 'function' && !document.contains(root)) return false;
    if (typeof root.closest === 'function' && root.closest('[hidden]')) return false;
  } catch (_) { /* best effort: скрытость проверяем, но не падаем */ }
  return true;
}

async function tickProjects() {
  if (!root || projectsInflight || !viewVisible()) return;
  projectsInflight = true;
  const ctl = new AbortController();
  abortCtl = ctl;
  try {
    const res = await fetch(apiProjects, { signal: ctl.signal });
    const json = await res.json().catch(() => null);
    if (!root) return;
    if (json && json.ok) {
      projectsData = json;
      projectsErr = '';
    } else {
      projectsData = null;
      projectsErr = (json && json.error) || ('HTTP ' + res.status);
    }
  } catch (err) {
    if (root && err && err.name !== 'AbortError') {
      projectsData = null;
      projectsErr = String((err && err.message) || err);
    }
  } finally {
    projectsInflight = false;
    abortCtl = null;
    if (root) { renderError(); renderGrid(); }
  }
}

/* ============================= poll: events ============================ */

async function tickEvents() {
  if (!root || eventsInflight || !viewVisible()) return;
  eventsInflight = true;
  try {
    const since = sinceIso || new Date(Date.now() - SPARK_SEED_MS).toISOString();
    const url = apiEvents
      + (apiEvents.includes('?') ? '&' : '?')
      + 'since=' + encodeURIComponent(since) + '&limit=200';
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!root) return;
    if (json && json.ok) {
      eventsErr = '';
      let fresh = 0;
      let maxAt = '';
      for (const ev of json.events || []) {
        if (!ev) continue;
        if (!seenKeys.has(ev.key)) {
          seenKeys.set(ev.key, 1);
          fresh++;
        }
        if (ev.at && String(ev.at) > maxAt) maxAt = String(ev.at);
      }
      trimSeen();
      // Курсор: максимум времени событий, иначе серверное now.
      sinceIso = maxAt || json.now || since;
      ring.push(fresh);
      if (ring.length > SPARK_BUCKETS) ring.shift();
      renderSpark();
    } else {
      eventsErr = (json && json.error) || ('HTTP ' + res.status);
      renderError();
    }
  } catch (err) {
    if (root && err && err.name !== 'AbortError') {
      eventsErr = String((err && err.message) || err);
      renderError();
    }
  } finally {
    eventsInflight = false;
  }
}

function trimSeen() {
  if (seenKeys.size <= SEEN_CAP) return;
  let toDrop = SEEN_CAP / 2;
  for (const k of seenKeys.keys()) {
    if (toDrop-- <= 0) break;
    seenKeys.delete(k);
  }
}

/* ============================== рендер ================================= */

function renderError() {
  if (!root) return;
  const box = root.querySelector('.core-pulse-err');
  if (!box) return;
  const parts = [];
  if (projectsErr) parts.push('проекты: ' + projectsErr);
  if (eventsErr) parts.push('события: ' + eventsErr);
  if (parts.length) {
    box.textContent = 'Завод недоступен — ' + parts.join(' · ');
    box.classList.add('is-on');
  } else {
    box.textContent = '';
    box.classList.remove('is-on');
  }
}

function renderCounters() {
  if (!root) return;
  const box = root.querySelector('#core-pulse-counters');
  if (!box) return;

  const c = (snapshot && snapshot.counters) || null;
  if (!c) {
    box.innerHTML = '<span class="core-pulse-counter core-pulse-counter--none">'
      + 'счётчики: снапшот ещё не получен</span>'
      + pulseNote();
    return;
  }
  const chip = (label, value, tone) =>
    '<span class="core-pulse-counter' + (tone ? ' core-pulse-counter--' + tone : '') + '">'
    + '<b>' + esc(fmtNum(value)) + '</b>' + esc(label) + '</span>';
  box.innerHTML = [
    chip('капсулы', c.replayCapsules, 'replay'),
    chip('принятия', c.finalAcceptances, 'ok'),
    chip('recovery', c.recoveryCases),
    chip('кандидат-сеты', c.candidateSets),
    chip('гейты', c.gateDecisions),
    pulseNote(),
  ].join('');
}

function pulseNote() {
  const p = snapshot && snapshot.pulse;
  const last = p && p.lastActivityAt ? parseTs(p.lastActivityAt) : NaN;
  const rate = p && p.activityPerMin != null ? p.activityPerMin : null;
  const bits = [];
  if (!Number.isNaN(last)) bits.push('активность ' + relTime(last, Date.now()) + ' назад');
  if (rate != null) bits.push(rate + '/мин');
  return bits.length
    ? '<span class="core-pulse-counter core-pulse-counter--none">' + esc(bits.join(' · ')) + '</span>'
    : '';
}

function renderGrid() {
  if (!root) return;
  const grid = root.querySelector('#core-pulse-grid');
  if (!grid) return;

  const projects = (projectsData && projectsData.projects) || null;
  if (!projects) {
    grid.innerHTML = '<div class="core-pulse-empty">'
      + '<div class="core-pulse-empty-big">' + (projectsErr ? 'Нет данных' : 'Загрузка…') + '</div>'
      + '</div>';
    return;
  }
  if (projects.length === 0) {
    grid.innerHTML = '<div class="core-pulse-empty">'
      + '<div class="core-pulse-empty-big">Проектов нет</div>'
      + '</div>';
    return;
  }

  const activeId = snapshot && snapshot.project ? snapshot.project.id : null;
  grid.innerHTML = projects.map((p) => reactorCard(p, p.id === activeId)).join('');
  bindCardClicks(grid);
}

function reactorCard(p, isActive) {
  const lc = p.lifecycle || null;
  const lamp = lampClass(lc);
  const stage = lc && lc.currentStageId ? lc.currentStageId : '—';
  const tasks = p.tasks || {};
  const total = Number(tasks.total) || 0;
  const done = Number(tasks.done) || 0;
  const frac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;

  const hbT = parseTs(p.lastHeartbeatAt);
  const freshCls = Number.isNaN(hbT) ? 'core-pulse-fresh--none'
    : (Date.now() - hbT < 30000 ? 'core-pulse-fresh--live'
      : Date.now() - hbT < 300000 ? '' : 'core-pulse-fresh--stale');
  const freshTxt = Number.isNaN(hbT) ? 'нет пульса'
    : relTime(hbT, Date.now()) + ' назад';

  return [
    '<article class="core-pulse-reactor' + (isActive ? ' is-active' : '')
    + '" data-core-pulse-project="' + esc(p.id) + '" tabindex="0" role="button">',
    '  <span class="core-pulse-lamp ' + lamp + '"></span>',
    reactorSvg(frac, lamp),
    '  <div class="core-pulse-rname" title="' + esc(p.name || ('#' + p.id)) + '">' + esc(p.name || ('#' + p.id)) + '</div>',
    '  <div class="core-pulse-rstage">' + esc(trunc(stage, 26)) + '</div>',
    '  <div class="core-pulse-rprogress">' + (total > 0 ? done + '/' + total : '—') + '</div>',
    '  <div class="core-pulse-fresh ' + freshCls + '">' + esc(freshTxt) + '</div>',
    '</article>',
  ].join('');
}

// Мини-реактор: ядро-точка + кольцо прогресса задач.
function reactorSvg(frac, lamp) {
  const cx = 32, cy = 32, r = 24;
  const c = 2 * Math.PI * r;
  const dash = (frac * c).toFixed(1);
  const coreCls = 'core-pulse-rsvgcore ' + lamp;
  return [
    '<svg class="core-pulse-rsvg" viewBox="0 0 64 64" aria-hidden="true">',
    '<circle class="core-pulse-rtrack" cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>',
    '<circle class="core-pulse-rarc" cx="' + cx + '" cy="' + cy + '" r="' + r + '"',
    '  stroke-dasharray="' + dash + ' ' + c.toFixed(1) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>',
    '<circle class="' + coreCls + '" cx="' + cx + '" cy="' + cy + '" r="9"/>',
    '</svg>',
  ].join('');
}

function lampClass(lc) {
  if (!lc) return 'core-pulse-lamp--idle';
  const st = String(lc.status || '').toLowerCase();
  const term = String(lc.terminalStatus || '').toLowerCase();
  if (term === 'failed' || st === 'failed' || st === 'error') return 'core-pulse-lamp--failed';
  if (term === 'completed' || st === 'completed' || st === 'success') return 'core-pulse-lamp--completed';
  if (st === 'running') return 'core-pulse-lamp--running';
  return 'core-pulse-lamp--idle';
}

function bindCardClicks(grid) {
  grid.querySelectorAll('[data-core-pulse-project]').forEach((el) => {
    el.addEventListener('click', () => selectProject(el.getAttribute('data-core-pulse-project')));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        selectProject(el.getAttribute('data-core-pulse-project'));
      }
    });
  });
}

// Клик по проекту в «Пульсе» — переход в его «Цепочку» (предложение оператора).
function selectProject(rawId) {
  const id = Number(rawId);
  if (!Number.isFinite(id)) return;
  if (ctx && typeof ctx.selectProject === 'function') ctx.selectProject(id, { view: 'chain' });
}

/* ------------------------------ спарклайн ------------------------------ */

function renderSpark() {
  if (!root) return;
  const line = root.querySelector('.core-pulse-spark-line');
  const area = root.querySelector('.core-pulse-spark-area');
  const rate = root.querySelector('.core-pulse-spark-rate');
  if (!line) return;

  const n = SPARK_BUCKETS;
  const pad = ring.length < n ? new Array(n - ring.length).fill(0) : [];
  const data = pad.concat(ring).slice(-n);
  const maxV = Math.max(4, Math.max.apply(null, data));
  const W = 120, H = 32;

  const pts = data.map((v, i) => {
    const x = (i / (n - 1)) * W;
    const y = H - 2 - (v / maxV) * (H - 6);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  line.setAttribute('points', pts.join(' '));
  area.setAttribute('points', '0,' + H + ' ' + pts.join(' ') + ' ' + W + ',' + H);

  if (rate) {
    // Бакет = EVENTS_POLL_MS; за минуту — 60000/EVENTS_POLL_MS бакетов.
    const perMin = Math.round(60000 / EVENTS_POLL_MS);
    const sum = data.slice(-perMin).reduce((a, b) => a + b, 0);
    rate.textContent = String(sum);
  }
}

/* ------------------------------- утилиты ------------------------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function trunc(s, n) {
  const v = String(s == null ? '' : s);
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

function fmtNum(v) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

function parseTs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  let t = Date.parse(s);
  if (Number.isNaN(t) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    t = Date.parse(s.replace(' ', 'T'));
  }
  return t;
}

function relTime(t, now) {
  if (!t || Number.isNaN(t)) return '—';
  const d = Math.max(0, Math.round((now - t) / 1000));
  if (d < 3) return 'только что';
  if (d < 60) return d + ' с';
  if (d < 3600) return Math.round(d / 60) + ' мин';
  if (d < 86400) return Math.round(d / 3600) + ' ч';
  return Math.round(d / 86400) + ' дн';
}

// Подключение собственного css (если B ещё не подключил его статически).
function ensureStyles(href) {
  if (typeof document === 'undefined') return;
  const links = document.querySelectorAll('link[rel="stylesheet"]');
  for (let i = 0; i < links.length; i++) {
    if (links[i].getAttribute('href') === href) return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function cssHref(name) {
  try {
    const u = new URL('./' + name, import.meta.url);
    if (u.protocol === 'file:') return '/views/' + name;
    return u.pathname;
  } catch (_) {
    return '/views/' + name;
  }
}
