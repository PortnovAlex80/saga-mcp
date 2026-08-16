// Factory Core View — L2 «Ячейка под микроскопом» (исполнитель C).
//
// Контракт (core-view/SPEC.md):
//   export const viewId; mount(container, ctx); update(snapshot); destroy();
//   ctx = { api:{snapshotUrl, projectsUrl, eventsUrl, cellUrl},
//           selectWorkplace(ref), selectProject(id) }.
//
// Данные: собственный poll GET /api/core/cell?workplace=<ref> каждые 1500 мс,
// пока вид смонтирован. Выбор станции — window CustomEvent
// 'core:select-workplace' ({detail:{workplaceRef}}) или поле поиска
// (workplaceRef / workKey / productionCellId).
//
// На верхнем уровне DOM-вызовов нет: единственное исключение —
// guarded-подписка на событие выбора, чтобы поймать выбор станции даже
// ДО mount (модуль живёт в ESM-кэше, main.js переключает таб после dispatch).

export const viewId = 'core-cell';

/* ============================== константы ============================== */

const POLL_MS = 1500;

// Круговой цикл клетки: сегменты по окружности, по часовой от «12 часов».
const SEGMENTS = [
  { id: 'author', label: 'Автор' },
  { id: 'candidate', label: 'Кандидат' },
  { id: 'gate', label: 'Гейт' },
  { id: 'reviewer', label: 'Ревьюер' },
  { id: 'final', label: 'Финал' },
  { id: 'effect', label: 'Эффект' },
];
const SEG_INDEX = Object.fromEntries(SEGMENTS.map((s, i) => [s.id, i]));
const SEG_ARC = 360 / SEGMENTS.length; // 60°
const SEG_GAP = 6; // градусов между сегментами

/* ============================ module state ============================= */

// Пойманный из события выбор станции; живёт между mount/destroy.
let lastWorkplaceRef = null;

// Режим «следить за живым»: вид сам переходит к станции с живым воркером,
// когда завод уходит к следующей работе. Ручной выбор (клик/поиск) закрепляет.
let followLive = true;

let root = null; // контейнер вида (.core-cell), null = вид не смонтирован
let ctx = null;
let apiCell = '/api/core/cell';

let snapshot = null; // последний snapshot от main.js (может быть null)
let cellData = null; // последний ответ /api/core/cell (ok)
let selectedRef = null;

let pollTimer = 0;
let inflight = false;
let abortCtl = null;
let fetchErr = '';
let lastOkAt = 0;

/* ======================= событие выбора станции ======================== */

// Guarded: в Node (проверка импорта) window нет — подписка не ставится.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('core:select-workplace', (ev) => {
    const ref = ev && ev.detail && ev.detail.workplaceRef;
    if (typeof ref === 'string' && ref) {
      lastWorkplaceRef = ref;
      followLive = false; // явный выбор пользователя — закрепляем
      renderFollowBtn();
      if (root) applySelection(ref);
    }
  });
}

/* ================================ API ================================== */

export function mount(container, viewCtx) {
  if (!container) return;
  ctx = viewCtx || {};
  apiCell = (ctx.api && ctx.api.cellUrl) || '/api/core/cell';

  ensureStyles(cssHref('cell.css'));

  root = document.createElement('div');
  root.className = 'core-cell';
  root.innerHTML = [
    '<div class="core-cell-toolbar">',
    '  <div class="core-cell-title">',
    '    <span class="core-cell-title-name">Ячейка под микроскопом</span>',
    '    <span class="core-cell-title-sub">L2 · projection</span>',
    '  </div>',
    '  <form class="core-cell-search" autocomplete="off">',
    '    <input class="core-cell-search-input" type="text"',
    '           placeholder="workplaceRef / workKey / cellId…" spellcheck="false">',
    '    <button class="core-cell-search-btn" type="submit">Показать</button>',
    '  </form>',
    '  <button class="core-cell-follow" type="button" title="Автопереход к станции с живым воркером">следить за живым</button>',
    '  <div class="core-cell-status">',
    '    <span class="core-cell-status-dot"></span>',
    '    <span class="core-cell-status-text">монтирован</span>',
    '  </div>',
    '</div>',
    '<div class="core-cell-body"></div>',
  ].join('');
  container.appendChild(root);

  const form = root.querySelector('.core-cell-search');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = root.querySelector('.core-cell-search-input');
    const v = (input && input.value || '').trim();
    if (!v) return;
    const ref = resolveWorkplace(v);
    if (ref) {
      followLive = false; // ручной поиск — закрепляем
      renderFollowBtn();
      applySelection(ref);
    }
    else setStatus('err', `станция не найдена: ${v}`);
  });

  const followBtn = root.querySelector('.core-cell-follow');
  followBtn.addEventListener('click', () => {
    followLive = !followLive;
    renderFollowBtn();
    if (followLive) {
      // сразу перепрыгнуть к живой станции, не дожидаясь следующего тика
      const hot = hottestAliveWorkplace((snapshot && snapshot.workplaces) || []);
      if (hot && hot !== selectedRef) applySelection(hot);
    }
  });
  renderFollowBtn();

  // В закреплённом режиме восстанавливаем последний выбор (событие могло
  // прийти до mount). В режиме слежения выбор подберёт update() из снапшота.
  if (!followLive && lastWorkplaceRef) applySelection(lastWorkplaceRef);

  pollTimer = setInterval(tick, POLL_MS);
  render();
}

export function update(snap) {
  snapshot = snap && snap.ok !== false ? snap : null;
  if (!root) return;
  const ws = (snapshot && snapshot.workplaces) || [];
  if (!selectedRef) {
    const ref = (!followLive && lastWorkplaceRef) || autoPickWorkplace(ws);
    if (ref) {
      applySelection(ref);
      return;
    }
  } else if (followLive) {
    // Слежение: завод ушёл к другой работе — переходим за живым воркером.
    const hot = hottestAliveWorkplace(ws);
    if (hot && hot !== selectedRef) {
      applySelection(hot);
      return;
    }
  }
  render();
  // update() приходит только активному виду — освежаем данные сразу.
  if (selectedRef && !inflight && viewVisible()) tick();
}

export function destroy() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
  if (abortCtl) { try { abortCtl.abort(); } catch (_) { /* noop */ } abortCtl = null; }
  inflight = false;
  cellData = null;
  fetchErr = '';
  if (root && root.parentNode) root.parentNode.removeChild(root);
  root = null;
  ctx = null;
}

/* ============================ внутренности ============================= */

function applySelection(ref) {
  if (!ref || ref === selectedRef) { if (root) render(); return; }
  selectedRef = ref;
  lastWorkplaceRef = ref;
  cellData = null; // не смешиваем данные разных станций
  fetchErr = '';
  if (root) {
    setStatus('idle', 'загрузка…');
    tick();
  }
}

// Вид считается открытым, пока его DOM не спрятан (main.js прячет секцию
// атрибутом hidden, не размонтируя — poll должен остановиться).
function viewVisible() {
  if (!root) return false;
  try {
    if (typeof document !== 'undefined' && document.contains
      && typeof document.contains === 'function' && !document.contains(root)) return false;
    if (typeof root.closest === 'function' && root.closest('[hidden]')) return false;
  } catch (_) { /* best effort: скрытность проверяем, но не падаем */ }
  return true;
}

async function tick() {
  if (!root || inflight || !selectedRef || !viewVisible()) return;
  inflight = true;
  const ctl = new AbortController();
  abortCtl = ctl;
  try {
    const url = withQuery(apiCell, 'workplace=' + encodeURIComponent(selectedRef));
    const res = await fetch(url, { signal: ctl.signal });
    const json = await res.json().catch(() => null);
    if (!root) return;
    if (json && json.ok) {
      cellData = json;
      fetchErr = '';
      lastOkAt = Date.now();
    } else {
      fetchErr = (json && json.error) || ('HTTP ' + res.status);
    }
  } catch (err) {
    if (root && err && err.name !== 'AbortError') {
      fetchErr = String((err && err.message) || err);
    }
  } finally {
    inflight = false;
    abortCtl = null;
    if (root) render();
  }
}

function withQuery(base, q) {
  if (!base) base = '/api/core/cell';
  return base + (base.includes('?') ? '&' : '?') + q;
}

// Поиск станции по подстроке: точный ref → workKey → cellId → включение.
function resolveWorkplace(v) {
  const ws = (snapshot && snapshot.workplaces) || [];
  const byRef = ws.find((w) => w.workplaceRef === v);
  if (byRef) return byRef.workplaceRef;
  const byKey = ws.find((w) => w.workKey === v);
  if (byKey) return byKey.workplaceRef;
  const byCell = ws.find((w) => w.productionCellId === v);
  if (byCell) return byCell.workplaceRef;
  const bySub = ws.find((w) =>
    String(w.workplaceRef || '').includes(v) ||
    String(w.workKey || '').includes(v) ||
    String(w.productionCellId || '').includes(v));
  if (bySub) return bySub.workplaceRef;
  // Снапшота может не быть — разрешаем сырой ref (best effort).
  return v.includes('/') ? v : null;
}

// Автовыбор «самой живой» станции, пока пользователь ничего не выбрал.
function autoPickWorkplace(ws) {
  if (!Array.isArray(ws) || ws.length === 0) return null;
  const rank = (w) => {
    const alive = w.worker && w.worker.alive ? 1000 : 0;
    const ph = String(w.kanbanPhase || '');
    const phScore = ph === 'in_progress' ? 500 : ph === 'review' ? 400
      : ph === 'blocked' ? 300 : ph === 'todo' ? 100 : 0;
    return alive + phScore + (parseTs(w.updatedAt) || 0) / 1e13;
  };
  let best = null;
  let bestScore = -Infinity;
  for (const w of ws) {
    if (!w || !w.workplaceRef) continue;
    const s = rank(w);
    if (s > bestScore) { bestScore = s; best = w; }
  }
  return best ? best.workplaceRef : null;
}

// Станция с живым воркером и самым свежим пульсом — цель режима слежения.
// Если живых нет, возвращаем null (остаёмся на текущей станции).
function hottestAliveWorkplace(ws) {
  if (!Array.isArray(ws)) return null;
  let best = null;
  let bestAge = Infinity;
  for (const w of ws) {
    if (!w || !w.workplaceRef || !(w.worker && w.worker.alive)) continue;
    const age = Number.isFinite(w.worker.heartbeatAgeMs) ? w.worker.heartbeatAgeMs : Infinity;
    if (age < bestAge) { bestAge = age; best = w; }
  }
  return best ? best.workplaceRef : null;
}

function renderFollowBtn() {
  if (!root) return;
  const btn = root.querySelector('.core-cell-follow');
  if (!btn) return;
  btn.classList.toggle('is-on', followLive);
  btn.textContent = followLive ? '◉ следит за живым' : '◎ закреплено — следить за живым';
}

// «только что» без «назад», остальное — с «назад».
function agoText(t, now) {
  const s = relTime(t, now);
  return s === 'только что' || s === '—' ? s : s + ' назад';
}

function setStatus(kind, text) {
  if (!root) return;
  const dot = root.querySelector('.core-cell-status-dot');
  const txt = root.querySelector('.core-cell-status-text');
  if (dot) dot.className = 'core-cell-status-dot core-cell-status-dot--' + kind;
  if (txt) txt.textContent = text;
}

/* ============================== рендер ================================= */

function render() {
  if (!root) return;
  const body = root.querySelector('.core-cell-body');
  if (!body) return;

  if (!selectedRef) {
    setStatus('idle', 'станция не выбрана');
    body.innerHTML = [
      '<div class="core-cell-empty">',
      '  <div class="core-cell-empty-big">Станция не выбрана</div>',
      '  <div class="core-cell-empty-hint">Кликните станцию в «Цепочке» (L1) или гейт-событие в «Хронике» (L3),',
      '    либо введите workplaceRef / workKey в поле поиска выше.</div>',
      '</div>',
    ].join('');
    return;
  }

  if (!cellData) {
    if (fetchErr) {
      setStatus('err', 'нет данных');
      body.innerHTML = [
        '<div class="core-cell-empty">',
        '  <div class="core-cell-empty-big">Завод недоступен</div>',
        '  <div class="core-cell-empty-hint">', esc(fetchErr), '</div>',
        '  <div class="core-cell-empty-hint">Повтор запроса каждые ', Math.round(POLL_MS / 1000), ' с.</div>',
        '</div>',
      ].join('');
    } else {
      setStatus('idle', 'загрузка…');
      body.innerHTML = '<div class="core-cell-empty"><div class="core-cell-empty-big">Загрузка…</div></div>';
    }
    return;
  }

  const w = cellData.workplace || {};
  setStatus('ok', 'обновлено ' + agoText(lastOkAt, Date.now()));

  body.innerHTML = [
    renderWorkplaceBar(w),
    '<div class="core-cell-grid">',
    '  <section class="core-cell-cyclecard">',
    buildCycleSvg(w, cellData),
    renderCycleLegend(deriveCycle(w, cellData)),
    '  </section>',
    '  <div class="core-cell-side">',
    renderCounters(w, cellData),
    renderTimeline(cellData),
    renderTerminal(cellData.logTail),
    renderExtras(cellData),
    '  </div>',
    '</div>',
  ].join('');
}

function renderWorkplaceBar(w) {
  const chips = [];
  const push = (label, value, tone) => {
    if (value === undefined || value === null || value === '') return;
    chips.push('<span class="core-cell-chip' + (tone ? ' core-cell-chip--' + tone : '') + '">'
      + '<b>' + esc(label) + '</b>' + esc(value) + '</span>');
  };
  push('фаза', w.kanbanPhase);
  push('loop', w.loopState);
  push('next', w.nextRole);
  push('rev', w.revision);
  push('task', w.taskId);
  push('терминал', w.terminalReason, 'fail');
  push('обновлено', agoText(parseTs(w.updatedAt), Date.now()));
  return [
    '<div class="core-cell-wpbar">',
    '  <div class="core-cell-wpref" title="', esc(w.workplaceRef || ''), '">', esc(w.workplaceRef || '—'), '</div>',
    '  <div class="core-cell-wpchips">', chips.join(''), '</div>',
    '</div>',
  ].join('');
}

/* --------------------------- цикл клетки (SVG) -------------------------- */

// Правило активного сегмента (приоритет сверху вниз):
//  1. terminal accepted (finalAcceptance | phase done/accepted | loop accepted)
//     → зелёное свечение всего кольца, светятся final+effect, активный effect;
//  2. терминал-отказ (terminalReason при не-accepted) → тон fail;
//  3. repair (lastGate.verdict=repair_required | loopState содержит «repair»)
//     → amber-дуга назад до repairTargetRole, активный сегмент = цель ремонта
//     (fallback: nextRole → author);
//  4. nextRole → сегмент по роли (author/reviewer/candidate/gate/final/effect);
//  5. kanbanPhase: review→reviewer, in_progress→candidate, todo→author
//     (приглушён), blocked→gate (amber);
//  6. иначе — candidate приглушённый.
function deriveCycle(w, data) {
  const phase = String(w.kanbanPhase || '').toLowerCase();
  const loop = String(w.loopState || '').toLowerCase();
  const nextRole = String(w.nextRole || '');
  const verdict = w.lastGate && String(w.lastGate.verdict || '').toLowerCase() || '';

  const accepted = Boolean(data && data.finalAcceptance)
    || phase === 'done' || phase === 'accepted'
    || loop === 'accepted' || loop.includes('accept');
  if (accepted) {
    return { seg: 'effect', tone: 'ok', mode: 'accepted', label: 'принято' };
  }

  if (w.terminalReason) {
    return {
      seg: roleToSegment(nextRole) || phaseToSegment(phase) || 'gate',
      tone: 'fail', mode: 'failed', label: String(w.terminalReason),
    };
  }

  const isRepair = verdict === 'repair_required' || loop.includes('repair');
  if (isRepair) {
    const target = latestRepairTarget(data) || nextRole;
    return {
      seg: roleToSegment(target) || 'author',
      tone: 'wait', mode: 'repair', repair: true,
      label: 'ремонт → ' + (target || 'author'),
    };
  }

  const byRole = roleToSegment(nextRole);
  if (byRole) {
    const tone = phase === 'blocked' ? 'wait' : 'flow';
    return { seg: byRole, tone, mode: phase === 'todo' ? 'idle' : 'run', label: nextRole };
  }

  const byPhase = phaseToSegment(phase);
  if (byPhase === 'reviewer') return { seg: 'reviewer', tone: 'scan', mode: 'run', label: 'review' };
  if (byPhase === 'candidate') return { seg: 'candidate', tone: 'flow', mode: 'run', label: 'производство' };
  if (byPhase === 'author') return { seg: 'author', tone: 'muted', mode: 'idle', label: 'в очереди' };
  if (byPhase === 'gate') return { seg: 'gate', tone: 'wait', mode: 'wait', label: 'блокировка' };
  return { seg: 'candidate', tone: 'muted', mode: 'idle', label: loop || '—' };
}

function roleToSegment(role) {
  const r = String(role || '').toLowerCase();
  if (!r) return null;
  if (r.includes('review')) return 'reviewer';
  if (r.includes('author') || r.includes('writer') || r.includes('producer')) return 'author';
  if (r.includes('candidate')) return 'candidate';
  if (r.includes('verif') || r.includes('gate') || r.includes('qc')) return 'gate';
  if (r.includes('final')) return 'final';
  if (r.includes('effect') || r.includes('git')) return 'effect';
  return null;
}

function phaseToSegment(phase) {
  const p = String(phase || '').toLowerCase();
  if (p === 'review') return 'reviewer';
  if (p === 'in_progress' || p === 'busy' || p === 'running') return 'candidate';
  if (p === 'todo' || p === 'idle' || p === 'queued') return 'author';
  if (p === 'blocked' || p === 'wait') return 'gate';
  return null;
}

// Роль цели ремонта: последний гейт с repair_required → его repairTargetRole.
function latestRepairTarget(data) {
  const gates = (data && data.gates) || [];
  for (let i = gates.length - 1; i >= 0; i--) {
    const g = gates[i];
    if (g && String(g.verdict || '').toLowerCase() === 'repair_required') {
      return g.repairTargetRole || null;
    }
  }
  return null;
}

function buildCycleSvg(w, data) {
  const cyc = deriveCycle(w, data);
  const C = 180;      // центр 360×360
  const R = 118;      // радиус основного кольца
  const repairs = Number(w.stats && w.stats.repairs) || 0;

  let out = '<svg class="core-cell-svg" viewBox="0 0 360 360" role="img" aria-label="Цикл клетки">';
  out += '<defs>'
    + '<marker id="core-cell-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">'
    + '<path d="M 0 0 L 10 5 L 0 10 z" class="core-cell-arrowhead"/></marker>'
    + '</defs>';

  // Свечение терминальных состояний (accepted=зелёный, failed=красный).
  if (cyc.mode === 'accepted' || cyc.mode === 'failed') {
    out += circle(C, C, 130, 'core-cell-halo core-cell-halo--' + cyc.tone);
  }

  // Сегменты цикла.
  for (let i = 0; i < SEGMENTS.length; i++) {
    const s = SEGMENTS[i];
    const a0 = i * SEG_ARC + SEG_GAP / 2;
    const a1 = (i + 1) * SEG_ARC - SEG_GAP / 2;
    let cls = 'core-cell-seg';
    const done = cyc.mode === 'accepted' && (s.id === 'final' || s.id === 'effect');
    if (s.id === cyc.seg) cls += ' core-cell-seg--on core-cell-t-' + cyc.tone;
    else if (done) cls += ' core-cell-seg--done';
    out += '<path class="' + cls + '" d="' + arcPath(C, C, R, a0, a1) + '"><title>'
      + esc(s.label) + (s.id === cyc.seg ? ' — активная фаза' : '') + '</title></path>';
  }

  // Подписи сегментов.
  for (let i = 0; i < SEGMENTS.length; i++) {
    const s = SEGMENTS[i];
    const mid = i * SEG_ARC + SEG_ARC / 2;
    const p = polar(C, C, R + 36, mid);
    const on = s.id === cyc.seg;
    out += '<text class="core-cell-seglbl' + (on ? ' core-cell-seglbl--on core-cell-t-' + cyc.tone : '')
      + '" x="' + fx(p.x) + '" y="' + fx(p.y) + '" text-anchor="middle" dominant-baseline="middle">'
      + esc(s.label) + '</text>';
  }

  // Попытки = концентрические кольца ревизий (наружное = текущая попытка).
  const rev = Number(w.revision) || 0;
  const rings = Math.min(rev, 5);
  for (let i = 0; i < rings; i++) {
    out += circle(C, C, 102 - i * 9,
      'core-cell-revring' + (i === 0 ? ' core-cell-revring--latest' : ''));
  }

  // Ремонт: загибающаяся дуга назад (amber), к цели ремонта.
  if (cyc.repair || repairs > 0) {
    const fromSeg = (w.lastGate && roleToSegment(w.lastGate.gatePhase)) || 'gate';
    const toSeg = cyc.repair ? cyc.seg
      : (roleToSegment(latestRepairTarget(data)) || 'author');
    const fromA = midAngle(fromSeg);
    const toA = midAngle(toSeg);
    const delta = (fromA - toA + 360) % 360;
    if (delta > 4) {
      out += '<path class="core-cell-repair' + (cyc.repair ? ' core-cell-repair--on' : '')
        + '" d="' + arcPathCCW(C, C, R + 14, fromA, toA) + '" marker-end="url(#core-cell-arrow)"><title>'
        + 'ремонт: назад к «' + esc(segLabel(toSeg)) + '»' + '</title></path>';
    }
  }

  // Ядро: идентификация станции и состояние.
  out += circle(C, C, 56, 'core-cell-core');
  out += '<text class="core-cell-coreline core-cell-coreline--name" x="' + C + '" y="158" text-anchor="middle">'
    + esc(trunc(w.productionCellId || '—', 24)) + '</text>';
  out += '<text class="core-cell-coreline" x="' + C + '" y="173" text-anchor="middle">'
    + esc(trunc(w.workKey || '', 24)) + '</text>';
  out += '<text class="core-cell-coreline core-cell-coreline--state core-cell-t-' + cyc.tone
    + '" x="' + C + '" y="191" text-anchor="middle">'
    + esc(trunc((w.kanbanPhase || '—') + ' · ' + (w.loopState || '—'), 30)) + '</text>';
  out += '<text class="core-cell-coreline core-cell-coreline--dim" x="' + C + '" y="207" text-anchor="middle">'
    + '↻' + (rev || 0) + ' · next: ' + esc(w.nextRole || '—') + '</text>';

  out += '</svg>';
  return out;
}

function renderCycleLegend(cyc) {
  const items = [
    '<span class="core-cell-lg"><i class="core-cell-lgdot core-cell-t-' + cyc.tone + '"></i>'
      + esc('фаза: ' + (cyc.label || '—')) + '</span>',
    '<span class="core-cell-lg"><i class="core-cell-lgdot core-cell-t-wait"></i>ремонт — дуга назад</span>',
    '<span class="core-cell-lg"><i class="core-cell-lgdot core-cell-t-replay"></i>replay-капсула</span>',
    '<span class="core-cell-lg"><i class="core-cell-lgdot core-cell-t-ok"></i>принято</span>',
    '<span class="core-cell-lg core-cell-lg--dim">кольца внутри — попытки (revision)</span>',
  ];
  return '<div class="core-cell-legend">' + items.join('') + '</div>';
}

function midAngle(segId) {
  const i = SEG_INDEX[segId];
  const idx = i === undefined ? SEG_INDEX.gate : i;
  return idx * SEG_ARC + SEG_ARC / 2;
}

function segLabel(segId) {
  const s = SEGMENTS.find((x) => x.id === segId);
  return s ? s.label : segId;
}

function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180 - Math.PI / 2;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// Дуга по часовой стрелке от a0 до a1 (градусы, 0 = «12 часов»).
function arcPath(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const large = (a1 - a0) % 360 > 180 ? 1 : 0;
  return 'M ' + fx(p0.x) + ' ' + fx(p0.y) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + fx(p1.x) + ' ' + fx(p1.y);
}

// Дуга ПРОТИВ часовой (назад) от a0 к a1 — ремонтная петля.
function arcPathCCW(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const delta = (a0 - a1 + 360) % 360;
  const large = delta > 180 ? 1 : 0;
  return 'M ' + fx(p0.x) + ' ' + fx(p0.y) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 0 ' + fx(p1.x) + ' ' + fx(p1.y);
}

function circle(cx, cy, r, cls) {
  return '<circle class="' + cls + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>';
}

/* ------------------------------ счётчики ------------------------------- */

function renderCounters(w, data) {
  const st = w.stats || {};
  const chip = (label, value, tone) =>
    '<span class="core-cell-counter' + (tone ? ' core-cell-counter--' + tone : '') + '">'
    + '<b>' + esc(value) + '</b>' + esc(label) + '</span>';
  return [
    '<div class="core-cell-counters">',
    chip('кандидаты', ((data.candidates || []).length) + (st.candidateSets ? '/' + st.candidateSets : '')),
    chip('гейты', ((data.gates || []).length) + (st.gateDecisions ? '/' + st.gateDecisions : '')),
    chip('запуски', (data.executions || []).length),
    chip('ремонты', st.repairs != null ? st.repairs : '—', Number(st.repairs) > 0 ? 'wait' : ''),
    chip('ревизия', w.revision != null ? w.revision : '—'),
    '</div>',
  ].join('');
}

/* ---------------------------- хронология ------------------------------- */

function renderTimeline(data) {
  const items = [];
  for (const g of data.gates || []) {
    items.push({
      at: parseTs(g.decidedAt), ts: g.decidedAt, kind: 'gate',
      verdict: String(g.verdict || ''), gatePhase: g.gatePhase, ref: g.gateRunRef,
    });
  }
  for (const e of data.executions || []) {
    items.push({
      at: parseTs(e.startedAt), ts: e.startedAt, kind: 'exec',
      state: String(e.state || ''), ref: e.executionId, workerId: e.workerId,
      replay: replayHint(e.meta),
    });
  }
  items.sort((a, b) => (b.at || 0) - (a.at || 0)); // новые сверху

  const rows = items.map((it) => {
    const t = Number.isNaN(it.at) ? String(it.ts || '—') : fmtTime(it.at);
    if (it.kind === 'gate') {
      const v = it.verdict.toLowerCase();
      const tone = v === 'accepted' ? 'ok'
        : v.includes('repair') ? 'wait'
          : v.includes('reject') || v.includes('fail') ? 'fail' : 'scan';
      return '<div class="core-cell-tl-row">'
        + '<span class="core-cell-tl-time">' + esc(t) + '</span>'
        + '<i class="core-cell-tl-dot core-cell-t-' + tone + '"></i>'
        + '<span class="core-cell-tl-text">гейт <b>' + esc(it.gatePhase || '—') + '</b> → '
        + esc(it.verdict || '—') + '</span>'
        + '</div>';
    }
    const s = it.state.toLowerCase();
    const tone = s === 'running' || s === 'cancel_requested' ? 'flow'
      : s === 'failed' || s === 'error' ? 'fail' : 'muted';
    return '<div class="core-cell-tl-row">'
      + '<span class="core-cell-tl-time">' + esc(t) + '</span>'
      + '<i class="core-cell-tl-dot core-cell-t-' + tone + (s === 'running' ? ' core-cell-tl-dot--live' : '') + '"></i>'
      + '<span class="core-cell-tl-text">воркер <b>' + esc(trunc(it.workerId || it.ref || '—', 18)) + '</b> · '
      + esc(it.state || '—') + '</span>'
      + (it.replay ? '<span class="core-cell-replaybadge">replay</span>' : '')
      + '</div>';
  }).join('');

  return [
    '<section class="core-cell-card">',
    '  <div class="core-cell-card-title">Хронология попыток <span class="core-cell-card-note">'
    + items.length + ' · gates + executions</span></div>',
    '  <div class="core-cell-timeline">', rows || '<div class="core-cell-none">попыток нет</div>', '</div>',
    '</section>',
  ].join('');
}

// Best effort: любой replay/capsule-след в meta выполнения.
function replayHint(meta) {
  if (!meta || typeof meta !== 'object') return false;
  try {
    const s = JSON.stringify(meta).toLowerCase();
    return s.includes('replay') || s.includes('capsule');
  } catch (_) { return false; }
}

/* ------------------------------ терминал ------------------------------- */

function renderTerminal(logTail) {
  let inner;
  if (!logTail || !Array.isArray(logTail.lines) || logTail.lines.length === 0) {
    inner = '<div class="core-cell-none">лог недоступен</div>';
  } else {
    // Подряд идущие одинаковые строки схлопываем: одна строка + счётчик ×N
    // (как повторы в консоли браузера) — иначе system/thinking_tokens
    // заливают терминал.
    const rows = [];
    for (const l of logTail.lines) {
      const lv = String((l && l.level) || 'info').toLowerCase();
      const text = String((l && l.text) || '');
      const lastRow = rows[rows.length - 1];
      if (lastRow && lastRow.lv === lv && lastRow.text === text) { lastRow.n += 1; continue; }
      rows.push({ lv, text, ts: (l && l.ts) || '', n: 1 });
    }
    // Консольный режим: строки однострочные (полный текст — в подсказке),
    // самые свежие сверху, окно фиксированной высоты (~10 строк).
    inner = rows.slice().reverse().map((r) => {
      const cls = r.lv.startsWith('warn') ? 'lv-warn'
        : r.lv.startsWith('err') ? 'lv-error'
        : r.lv.startsWith('think') ? 'lv-think'
        : r.lv.startsWith('tool') ? 'lv-tool'
        : r.lv.startsWith('sys') ? 'lv-sys'
        : 'lv-info';
      const t = parseTs(r.ts);
      const ts = Number.isNaN(t) ? trunc(String(r.ts || ''), 12) : fmtTime(t);
      const full = r.text + (r.n > 1 ? '  (×' + r.n + ')' : '');
      return '<div class="core-cell-logline ' + cls + '" title="' + esc(full) + '">'
        + '<span class="core-cell-logts">' + esc(ts) + '</span>'
        + '<span class="core-cell-logtext">' + esc(r.text) + '</span>'
        + (r.n > 1 ? '<span class="core-cell-logrepeat">×' + r.n + '</span>' : '')
        + '</div>';
    }).join('');
  }
  return [
    '<section class="core-cell-card core-cell-card--term">',
    '  <div class="core-cell-card-title">Терминал <span class="core-cell-card-note">logTail · фиолетовое — мысли модели</span></div>',
    '  <div class="core-cell-terminal">', inner, '</div>',
    '</section>',
  ].join('');
}

/* ------------------------ эффекты / recovery --------------------------- */

function renderExtras(data) {
  const fa = data.finalAcceptance;
  const faHtml = fa
    ? '<section class="core-cell-card core-cell-card--ok">'
      + '  <div class="core-cell-card-title core-cell-t-ok">Финальное принятие</div>'
      + '  <div class="core-cell-kv"><span>ref</span><code>' + esc(trunc(fa.ref || '—', 44)) + '</code></div>'
      + (fa.subjectCandidateSetRef
        ? '<div class="core-cell-kv"><span>кандидат</span><code>' + esc(trunc(fa.subjectCandidateSetRef, 44)) + '</code></div>'
        : '')
      + '</section>'
    : '';

  const rec = data.recovery || [];
  const recHtml = [
    '<section class="core-cell-card">',
    '  <div class="core-cell-card-title">Recovery <span class="core-cell-card-note">'
    + (rec.length ? rec.length : 'пусто') + '</span></div>',
    rec.length
      ? rec.map((r) => '<div class="core-cell-kv"><span>' + esc(fmtTimeOrRaw(r.createdAt)) + '</span><code>'
        + esc(trunc(r.caseRef || r.issueRef || '—', 44)) + '</code></div>').join('')
      : '<div class="core-cell-none">нет</div>',
    '</section>',
  ].join('');

  const eff = data.effects || [];
  const effHtml = [
    '<section class="core-cell-card">',
    '  <div class="core-cell-card-title">Эффекты наружу <span class="core-cell-card-note">'
    + (eff.length ? eff.length : 'пусто') + '</span></div>',
    eff.length
      ? eff.map((e) => '<div class="core-cell-kv"><span>' + esc(String(e.kind || '—')) + '</span><code>'
        + esc(String(e.state || '—')) + (e.receipt ? ' · receipt' : '') + '</code></div>').join('')
      : '<div class="core-cell-none">нет</div>',
    '</section>',
  ].join('');

  return '<div class="core-cell-extras">' + faHtml + recHtml + effHtml + '</div>';
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

function fx(v) { return Math.round(v * 100) / 100; }

// ISO или 'YYYY-MM-DD HH:MM:SS' (как в БД) → ms; NaN если не парсится.
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

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtTimeOrRaw(v) {
  const t = parseTs(v);
  return Number.isNaN(t) ? trunc(String(v == null ? '—' : v), 19) : fmtTime(t);
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
    // file:// бывает только при локальной проверке импорта — на сервере стика
    // public/ является web-корнем, поэтому views лежат по /views/.
    if (u.protocol === 'file:') return '/views/' + name;
    return u.pathname;
  } catch (_) {
    return '/views/' + name;
  }
}
