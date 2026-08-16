// L1 «Цепочка» — нормативная цепочка завода как горизонтальный конвейер
// (исполнитель B, контракт: core-view/SPEC.md).
//
// Что рисуется из snapshot:
//   • полоса стадий lifecycle (степпер с attempt-бейджами «↻N»);
//   • слева «двигатель» диспетчера: живой параллелизм (workers alive),
//     очередь (todo/idle), в работе, tok/s, счётчики ядра;
//   • лента станций-чипов по workplaces: workKey, productionCellId, цвет по
//     kanbanPhase, loopState+nextRole, кольцо ревизий (revision → сегменты),
//     лампа обязательства (obligation; null при non-terminal loopState =
//     мигающий красный STALLED), точка воркера (heartbeatAgeMs > 30с → серый),
//     мини-иконка lastGate.verdict;
//   • зависимости dependencies: SVG-рёбра между чипами при hover + подсветка
//     предшественников/последователей, остальные приглушаются.
//
// Чипы кликабельны: ctx.selectWorkplace(workplaceRef) → таб «Ячейка».
// Анимация потока — CSS (вспышка чипа при росте revision, бегущая лента,
// пульс ламп), всё гасится prefers-reduced-motion в chain.css.
//
// Рендер — key-based reconciliation по workplaceRef: DOM чипа обновляется на
// месте, поэтому hover и анимации переживают ежесекундный update.

export const viewId = 'chain';

const HEARTBEAT_STALE_MS = 30000; // SPEC: heartbeatAgeMs > 30s → серый/stale
const RING_MAX_SEGMENTS = 16;     // больше ревизий — сегменты сливаются, число в бейдже
const FLASH_MS = 900;

// kanbanPhase → класс цвета чипа (SPEC: todo=приглушён, in_progress=cyan,
// review=scan-синий, blocked=amber; терминальные — green/red по смыслу).
const PHASE_CLASSES = {
  todo: 'ph-todo', idle: 'ph-todo', new: 'ph-todo',
  in_progress: 'ph-in_progress', admitted: 'ph-in_progress', running: 'ph-in_progress',
  review: 'ph-review', in_review: 'ph-review',
  blocked: 'ph-blocked', repair: 'ph-blocked', waiting: 'ph-blocked',
  done: 'ph-done', accepted: 'ph-done', completed: 'ph-done',
  failed: 'ph-failed', rejected: 'ph-failed',
};

// lastGate.verdict → [глиф, класс] (accepted=ок, repair_required=↻, rejected=✗)
const GATE_ICONS = {
  accepted: ['✓', 'gate-accepted'],
  repair_required: ['↻', 'gate-repair'],
  rejected: ['✗', 'gate-rejected'],
  timeout: ['⏱', 'gate-other'],
  escalated: ['⇑', 'gate-other'],
};

// ---- состояние модуля (один экземпляр вида на страницу) ----------------------

let ctx = null;
let root = null;
let stagesEl = null;
let dispatcherEl = null;
let beltEl = null;
let beltContent = null;
let svgEdges = null;
let emptyEl = null;

let chipMap = new Map();   // workplaceRef -> { el, revBadge, ring, key, cell, loop, role, lamp, worker, gate, stats, lastRevision }
let depPred = new Map();   // workplaceRef -> Set(workplaceRef)
let depSucc = new Map();
let workplacesByRef = new Map(); // workplaceRef -> workplace (для лампы зависимостей)
let hoveredRef = null;
let lastOrderKey = '';
let flashTimers = new Set();
let destroyed = false;
let listeners = []; // [node, type, fn] — снимаются в destroy()
let dispRefs = null; // прямые ссылки на значения двигателя диспетчера

// ---- маленькие утилиты -------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// `at` может быть ISO или «YYYY-MM-DD HH:MM:SS» (формат БД в SPEC)
function parseTime(value) {
  if (value == null) return null;
  const s = String(value);
  let t = Date.parse(s);
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return Math.max(0, Math.round(ms)) + 'мс';
  if (ms < 60 * 1000) return (ms / 1000).toFixed(1) + 'с';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m + 'м' + (s ? ' ' + s + 'с' : '');
}

function phaseClass(kanbanPhase) {
  return PHASE_CLASSES[kanbanPhase] || 'ph-todo';
}

// Лампа обязательства — прямая проекция прогресс-обязательства (§23/§27):
// live owner=пульсирующий cyan, typed wait=amber, transition due=синий,
// STALLED (obligation==null при non-terminal loopState)=мигающий красный,
// противоречие=violet.
function obligationLamp(w) {
  const terminal = w.terminalReason != null;
  const ob = w.obligation;
  if (!ob) {
    if (!terminal) {
      if (w.worker && w.worker.alive) {
        return {
          cls: 'ob-live',
          label: 'live owner',
          tip: 'живой WorkerExecution держит работу (lease/fence)\nobligation: нет — переходной долг ещё не создан',
        };
      }
      // Долга нет и живого владельца нет — но это может быть законное ожидание
      // фанаута: не admitted, пока предшественники не приняты (§18), либо
      // очередь диспетчера (§22/§23 — typed wait). Красный STALLED оставляем
      // только для настоящего «никто ничего не должен и никто не работает».
      const preds = depPred.get(w.workplaceRef);
      if (preds && preds.size) {
        const shortKey = (pw) => pw.workKey || String(pw.workplaceRef).split('/').pop();
        const failed = [];
        const pending = [];
        for (const p of preds) {
          const pw = workplacesByRef.get(p);
          if (!pw) continue;
          if (pw.terminalReason != null && pw.terminalReason !== 'accepted') failed.push(shortKey(pw));
          else if (pw.terminalReason == null) pending.push(shortKey(pw));
        }
        if (failed.length) {
          return {
            cls: 'ob-contradiction',
            label: 'зависимость не принята',
            tip: 'предшественник завершился не-accepted: ' + failed.join(', '),
          };
        }
        if (pending.length) {
          return {
            cls: 'ob-wait',
            label: 'ждёт зависимость',
            tip: 'не admitted: предшественники ещё не приняты (§18 fan-out)\nждёт: ' + pending.join(', '),
          };
        }
      }
      if (String(w.kanbanPhase || '') === 'todo') {
        return {
          cls: 'ob-wait',
          label: 'в очереди',
          tip: 'todo в очереди диспетчера — ждёт слот/приём (typed wait, §22)',
        };
      }
      return {
        cls: 'ob-stalled',
        label: 'STALLED — обязательства нет, цикл не терминальный',
        tip: 'obligation: null\nloopState: ' + (w.loopState || '?') + ' (non-terminal)',
      };
    }
    return { cls: 'ob-off', label: '—', tip: 'обязательство отсутствует, цикл терминальный' };
  }
  const st = ob.state || '';
  const kind = ob.kind || '';
  const tip = 'obligation ' + kind + ':' + st +
    (ob.leaseOwner ? '\nowner: ' + ob.leaseOwner : '') +
    (ob.attempt != null ? '\nattempt: ' + ob.attempt : '') +
    (ob.lastError ? '\nlastError: ' + ob.lastError : '');
  if (ob.lastError) return { cls: 'ob-error', label: 'error', tip };
  if (st === 'pending' && ob.leaseOwner) {
    return { cls: 'ob-live', label: 'live owner', tip };
  }
  if (/wait|blocked|hold/i.test(st)) return { cls: 'ob-wait', label: st, tip };
  if (st === 'pending') {
    if (kind === 'transition') return { cls: 'ob-due', label: 'transition due', tip };
    return { cls: 'ob-wait', label: 'typed wait', tip };
  }
  if (st === 'satisfied' || st === 'done' || st === 'fulfilled' || st === 'cleared') {
    return { cls: 'ob-off', label: st, tip };
  }
  return { cls: 'ob-contradiction', label: kind + ':' + st, tip }; // неизвестная комбинация
}

function gateIcon(lastGate) {
  if (!lastGate || !lastGate.verdict) return null;
  const known = GATE_ICONS[lastGate.verdict];
  if (known) return { glyph: known[0], cls: known[1] };
  return { glyph: '⌾', cls: 'gate-other' };
}

// ---- DAG: глубина для укладки «корни слева, зависимые правее» -----------------

function buildDepMaps(workplaces, dependencies) {
  depPred = new Map();
  depSucc = new Map();
  const known = new Set(workplaces.map((w) => w.workplaceRef));
  for (const d of dependencies || []) {
    if (!d || !known.has(d.from) || !known.has(d.to) || d.from === d.to) continue;
    if (!depPred.has(d.to)) depPred.set(d.to, new Set());
    depPred.get(d.to).add(d.from);
    if (!depSucc.has(d.from)) depSucc.set(d.from, new Set());
    depSucc.get(d.from).add(d.to);
  }
}

function orderWorkplaces(workplaces) {
  const depth = new Map();
  const visiting = new Set();
  const visit = (ref) => {
    if (depth.has(ref)) return depth.get(ref);
    if (visiting.has(ref)) return 0; // защита от цикла в данных
    visiting.add(ref);
    const preds = depPred.get(ref);
    let d = 0;
    if (preds && preds.size) d = 1 + Math.max(...[...preds].map(visit));
    visiting.delete(ref);
    depth.set(ref, d);
    return d;
  };
  const items = workplaces.map((w) => ({ w, d: visit(w.workplaceRef) }));
  items.sort((a, b) => {
    if (a.d !== b.d) return a.d - b.d;
    const ca = parseTime(a.w.createdAt) ?? 0;
    const cb = parseTime(b.w.createdAt) ?? 0;
    if (ca !== cb) return ca - cb;
    return String(a.w.workplaceRef).localeCompare(String(b.w.workplaceRef));
  });
  return items.map((i) => i.w);
}

// ---- построение чипа ---------------------------------------------------------

function buildChip(w) {
  const chip = el('button', 'chain-chip');
  chip.type = 'button';
  chip.dataset.ref = w.workplaceRef;

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('class', 'chain-chip-ring');
  ring.setAttribute('viewBox', '0 0 100 100');
  ring.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '50');
  circle.setAttribute('cy', '50');
  circle.setAttribute('r', '47');
  circle.setAttribute('pathLength', '100');
  ring.appendChild(circle);

  const top = el('div', 'chain-chip-top');
  const key = el('span', 'chain-chip-key');
  const revBadge = el('span', 'chain-chip-rev');
  const gate = el('span', 'chain-chip-gate');
  top.append(key, revBadge, gate);

  const cell = el('div', 'chain-chip-cell');

  const meta = el('div', 'chain-chip-meta');
  const loop = el('span', 'chain-chip-loop');
  const role = el('span', 'chain-chip-role');
  const lamp = el('span', 'chain-chip-obligation');
  const worker = el('span', 'chain-chip-worker');
  meta.append(loop, role, lamp, worker);

  const stats = el('div', 'chain-chip-stats');

  chip.append(ring, top, cell, meta, stats);
  return {
    el: chip, ring: circle, revBadge, key, cell, loop, role, lamp, worker, gate, stats,
    lastRevision: null,
  };
}

function updateChip(rec, w) {
  const chip = rec.el;

  // фаза канбана → базовый цвет (hover-классы не трогаем)
  chip.classList.remove(...Object.values(PHASE_CLASSES));
  chip.classList.add(phaseClass(w.kanbanPhase));
  chip.title = w.workplaceRef +
    '\n' + (w.moduleRef || '') + ' / ' + (w.productionCellId || '') +
    '\nkanban: ' + (w.kanbanPhase || '?') + ' · loop: ' + (w.loopState || '?') +
    (w.terminalReason ? '\nterminal: ' + w.terminalReason : '') +
    '\nсоздан: ' + (w.createdAt || '?') + ' · обновлён: ' + (w.updatedAt || '?');

  rec.key.textContent = w.workKey || '?';
  rec.cell.textContent = w.productionCellId || w.moduleRef || '';

  // кольцо ревизий: revision → число сегментов орбиты (cap + бейдж «R<n>»)
  const rev = Number.isFinite(w.revision) ? w.revision : 0;
  rec.revBadge.textContent = 'R' + rev;
  const segments = Math.min(Math.max(rev, 0), RING_MAX_SEGMENTS);
  if (segments > 0) {
    const arc = 100 / segments;
    rec.ring.setAttribute('stroke-dasharray', (arc * 0.68).toFixed(2) + ' ' + (arc * 0.32).toFixed(2));
    rec.ring.parentNode.style.display = '';
  } else {
    rec.ring.parentNode.style.display = 'none';
  }
  // вспышка «материал пришёл» при росте ревизии
  if (rec.lastRevision != null && rev > rec.lastRevision) {
    chip.classList.remove('chain-flash');
    void chip.offsetWidth; // рестарт анимации
    chip.classList.add('chain-flash');
    const t = setTimeout(() => {
      chip.classList.remove('chain-flash');
      flashTimers.delete(t);
    }, FLASH_MS);
    flashTimers.add(t);
  }
  rec.lastRevision = rev;

  rec.loop.textContent = w.loopState || '—';
  rec.role.textContent = w.nextRole ? '→ ' + w.nextRole : '';

  const lampInfo = obligationLamp(w);
  rec.lamp.className = 'chain-chip-obligation ' + lampInfo.cls;
  rec.lamp.textContent = lampInfo.label;
  rec.lamp.title = lampInfo.tip;

  // точка воркера: живой — cyan, heartbeatAgeMs > 30с или не alive — серый
  const wk = w.worker;
  if (wk) {
    const age = Number.isFinite(wk.heartbeatAgeMs) ? wk.heartbeatAgeMs : null;
    const stale = wk.alive === false || (age != null && age > HEARTBEAT_STALE_MS);
    rec.worker.className = 'chain-chip-worker ' + (stale ? 'wk-stale' : 'wk-live');
    rec.worker.textContent = '▮ ' + formatAge(age);
    rec.worker.title = 'воркер ' + (wk.executionId || '?') +
      '\nstate: ' + (wk.state || '?') + (wk.phase ? ' · phase: ' + wk.phase : '') +
      (wk.pid != null ? '\npid: ' + wk.pid : '') +
      '\nheartbeat: ' + (wk.heartbeatAt || '?') + ' (' + formatAge(age) + ' назад)';
    rec.worker.style.display = '';
  } else {
    rec.worker.style.display = 'none';
    rec.worker.title = '';
  }

  const gi = gateIcon(w.lastGate);
  if (gi) {
    rec.gate.textContent = gi.glyph;
    rec.gate.className = 'chain-chip-gate ' + gi.cls;
    rec.gate.title = 'gate ' + (w.lastGate.gatePhase || '?') + ' → ' + w.lastGate.verdict +
      '\n' + (w.lastGate.decidedAt || '');
    rec.gate.style.display = '';
  } else {
    rec.gate.style.display = 'none';
  }

  const st = w.stats || {};
  rec.stats.textContent =
    'c' + (st.candidateSets ?? 0) +
    ' g' + (st.gateDecisions ?? 0) +
    ' r' + (st.repairs ?? 0);
  rec.stats.title = 'candidateSets: ' + (st.candidateSets ?? 0) +
    '\ngateDecisions: ' + (st.gateDecisions ?? 0) +
    '\nrepairs: ' + (st.repairs ?? 0);
}

// ---- полоса стадий lifecycle --------------------------------------------------

function renderStages(lifecycle) {
  stagesEl.textContent = '';
  if (!lifecycle) {
    stagesEl.appendChild(el('span', 'chain-stages-meta', 'lifecycle: —'));
    return;
  }
  const meta = el('span', 'chain-stages-meta',
    'run #' + (lifecycle.runId ?? '?') + ' · ' + (lifecycle.status || '?') +
    (lifecycle.currentStageId ? ' · стадия: ' + lifecycle.currentStageId : ''));
  meta.classList.add('st-' + statusClass(lifecycle.status));
  stagesEl.appendChild(meta);

  const stepper = el('ol', 'chain-stepper');
  const stages = Array.isArray(lifecycle.stages) ? lifecycle.stages : [];
  stages.forEach((stage, i) => {
    if (i > 0) stepper.appendChild(el('li', 'chain-stage-arrow', '›'));
    const li = el('li', 'chain-stage st-' + statusClass(stage.status));
    if (stage.stageId && stage.stageId === lifecycle.currentStageId) li.classList.add('is-current');
    const name = el('span', 'chain-stage-name', stage.name || stage.stageId || ('#' + (stage.stageRunId ?? i)));
    li.appendChild(name);
    if (stage.attempt != null && stage.attempt > 1) {
      li.appendChild(el('span', 'chain-stage-attempt', '↻' + stage.attempt));
    }
    if (stage.outcome) li.appendChild(el('span', 'chain-stage-outcome', stage.outcome));
    li.title = 'stageRun #' + (stage.stageRunId ?? '?') + ' · ' + (stage.status || '?') +
      '\n' + (stage.startedAt || '?') + ' → ' + (stage.completedAt || '…');
    stepper.appendChild(li);
  });
  stagesEl.appendChild(stepper);
}

function statusClass(status) {
  switch (status) {
    case 'completed': case 'done': return 'completed';
    case 'running': case 'in_progress': return 'running';
    case 'failed': case 'error': return 'failed';
    case 'paused': case 'waiting': return 'paused';
    default: return 'pending';
  }
}

// ---- двигатель диспетчера ----------------------------------------------------

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function renderDispatcher(snap) {
  const workers = Array.isArray(snap.workers) ? snap.workers : [];
  const workplaces = Array.isArray(snap.workplaces) ? snap.workplaces : [];
  const alive = workers.filter((w) => w && w.alive);
  const queue = workplaces.filter((w) => w.kanbanPhase === 'todo' || w.kanbanPhase === 'idle').length;
  const inFlight = workplaces.filter((w) => w.kanbanPhase === 'in_progress' || w.kanbanPhase === 'admitted').length;
  const toks = alive
    .filter((w) => !w.stale && typeof w.tokPerSec === 'number')
    .reduce((acc, w) => acc + w.tokPerSec, 0);

  setText(dispRefs.alive, alive.length + ' / ' + workers.length);
  setText(dispRefs.queue, String(queue));
  setText(dispRefs.run, String(inFlight));
  const pulse = snap.pulse || {};
  setText(dispRefs.act, (pulse.activityPerMin != null ? pulse.activityPerMin : 0) + '/мин');
  setText(dispRefs.tok, toks > 0 ? toks.toFixed(1) : '—');

  const counters = snap.counters || {};
  setText(dispRefs.counters,
    'капсулы ' + (counters.replayCapsules ?? 0) +
    ' · принятия ' + (counters.finalAcceptances ?? 0) +
    ' · гейты ' + (counters.gateDecisions ?? 0) +
    ' · recovery ' + (counters.recoveryCases ?? 0));

  const lastAct = pulse.lastActivityAt ? parseTime(pulse.lastActivityAt) : null;
  const now = parseTime(snap.now) != null ? parseTime(snap.now) : Date.now();
  dispatcherEl.classList.toggle('is-quiet', lastAct == null || now - lastAct > 60 * 1000);
}

// ---- hover: подсветка зависимостей + SVG-рёбра -------------------------------

function setHover(ref) {
  if (hoveredRef === ref) return;
  hoveredRef = ref;
  applyHoverClasses();
  drawEdges();
}

function relatedOf(ref) {
  const rel = new Set([ref]);
  for (const p of depPred.get(ref) || []) rel.add(p);
  for (const s of depSucc.get(ref) || []) rel.add(s);
  return rel;
}

function applyHoverClasses() {
  if (!hoveredRef) {
    for (const rec of chipMap.values()) {
      rec.el.classList.remove('is-hover', 'is-dep', 'is-dim');
    }
    return;
  }
  const rel = relatedOf(hoveredRef);
  for (const [ref, rec] of chipMap) {
    rec.el.classList.remove('is-hover', 'is-dep', 'is-dim');
    if (ref === hoveredRef) rec.el.classList.add('is-hover');
    else if (rel.has(ref)) rec.el.classList.add('is-dep');
    else rec.el.classList.add('is-dim');
  }
}

function chipCenter(ref) {
  const rec = chipMap.get(ref);
  if (!rec || !rec.el.parentNode) return null;
  return {
    x: rec.el.offsetLeft + rec.el.offsetWidth / 2,
    y: rec.el.offsetTop + rec.el.offsetHeight / 2,
  };
}

function drawEdges() {
  if (!svgEdges || !beltContent) return;
  svgEdges.textContent = '';
  const ref = hoveredRef;
  if (!ref) {
    svgEdges.style.display = 'none';
    return;
  }
  const pairs = [];
  for (const p of depPred.get(ref) || []) pairs.push([p, ref]);
  for (const s of depSucc.get(ref) || []) pairs.push([ref, s]);
  if (!pairs.length) {
    svgEdges.style.display = 'none';
    return;
  }
  svgEdges.style.display = '';
  svgEdges.setAttribute('width', String(beltContent.scrollWidth));
  svgEdges.setAttribute('height', String(beltContent.scrollHeight));
  const NS = 'http://www.w3.org/2000/svg';
  for (const [fromRef, toRef] of pairs) {
    const a = chipCenter(fromRef);
    const b = chipCenter(toRef);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const path = document.createElementNS(NS, 'path');
    // лёгкая дуга, чтобы ребро не перекрывало чипы
    path.setAttribute('d',
      'M ' + a.x + ' ' + a.y + ' Q ' + mx + ' ' + (Math.min(a.y, b.y) - 26) + ' ' + b.x + ' ' + b.y);
    path.setAttribute('class', 'chain-edge');
    svgEdges.appendChild(path);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', String(b.x));
    dot.setAttribute('cy', String(b.y));
    dot.setAttribute('r', '3');
    dot.setAttribute('class', 'chain-edge-dot');
    svgEdges.appendChild(dot);
  }
}

// ---- reconciliation ленты ----------------------------------------------------

function reconcileChips(workplaces) {
  const order = orderWorkplaces(workplaces);
  const seen = new Set(order.map((w) => w.workplaceRef));

  for (const w of order) {
    let rec = chipMap.get(w.workplaceRef);
    if (!rec) {
      rec = buildChip(w);
      chipMap.set(w.workplaceRef, rec);
    }
    updateChip(rec, w);
  }

  // порядок DOM = порядок укладки; меняем только если реально изменился
  const orderKey = order.map((w) => w.workplaceRef).join('|');
  if (orderKey !== lastOrderKey) {
    lastOrderKey = orderKey;
    for (const w of order) beltContent.appendChild(chipMap.get(w.workplaceRef).el);
    beltContent.appendChild(svgEdges); // слой рёбер поверх чипов
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(drawEdges);
    else drawEdges();
  }

  for (const [ref, rec] of chipMap) {
    if (!seen.has(ref)) {
      rec.el.remove();
      chipMap.delete(ref);
    }
  }
}

// ---- каркас вида -------------------------------------------------------------

function buildSkeleton() {
  root = el('div', 'chain-root');

  stagesEl = el('div', 'chain-stages');
  root.appendChild(stagesEl);

  const body = el('div', 'chain-body');

  dispatcherEl = el('aside', 'chain-dispatcher');
  const engine = el('div', 'chain-engine');
  const engineCore = el('span', 'chain-engine-core');
  engineCore.setAttribute('aria-hidden', 'true');
  engine.append(engineCore, el('span', null, 'диспетчер'));
  dispatcherEl.appendChild(engine);

  dispRefs = {};
  const dispRow = (labelText, refKey, valueClass) => {
    const row = el('div', 'chain-disp-row');
    row.appendChild(el('span', null, labelText));
    const value = el('b', valueClass || null, '—');
    dispRefs[refKey] = value;
    row.appendChild(value);
    dispatcherEl.appendChild(row);
  };
  dispRow('параллелизм (живых)', 'alive', 'chain-disp-alive-v');
  dispRow('очередь todo/idle', 'queue');
  dispRow('в работе', 'run');
  dispRow('активность', 'act');
  dispRow('tok/s (живых)', 'tok');
  dispRefs.counters = el('div', 'chain-disp-counters', '—');
  dispatcherEl.appendChild(dispRefs.counters);
  body.appendChild(dispatcherEl);

  beltEl = el('div', 'chain-belt');
  beltContent = el('div', 'chain-belt-content');
  svgEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEdges.setAttribute('class', 'chain-svg');
  beltContent.appendChild(svgEdges);
  beltEl.appendChild(beltContent);

  emptyEl = el('div', 'chain-empty', 'станций нет — на этой стадии нет process-run');
  emptyEl.hidden = true;
  beltEl.appendChild(emptyEl);

  body.appendChild(beltEl);
  root.appendChild(body);

  const legend = el('div', 'chain-legend');
  legend.innerHTML =
    '<span class="chain-lg"><i class="lg-ph ph-todo"></i>todo</span>' +
    '<span class="chain-lg"><i class="lg-ph ph-in_progress"></i>in_progress</span>' +
    '<span class="chain-lg"><i class="lg-ph ph-review"></i>review</span>' +
    '<span class="chain-lg"><i class="lg-ph ph-blocked"></i>blocked</span>' +
    '<span class="chain-lg-sep"></span>' +
    '<span class="chain-lg"><i class="lg-ob ob-live"></i>live owner</span>' +
    '<span class="chain-lg"><i class="lg-ob ob-wait"></i>typed wait — ожидание (зависимость/очередь)</span>' +
    '<span class="chain-lg"><i class="lg-ob ob-due"></i>transition due</span>' +
    '<span class="chain-lg"><i class="lg-ob ob-stalled"></i>STALLED</span>' +
    '<span class="chain-lg"><i class="lg-ob ob-contradiction"></i>противоречие</span>' +
    '<span class="chain-lg-sep"></span>' +
    '<span class="chain-lg"><i class="lg-ring"></i>кольцо — ревизии</span>' +
    '<span class="chain-lg">c/g/r — кандидаты · гейты · ремонты</span>' +
    '<span class="chain-lg">клик по станции → вид «Ячейка»</span>';
  root.appendChild(legend);
}

// ---- интерфейс модуля вида (SPEC: строго четыре экспорта) --------------------

export function mount(container, viewCtx) {
  ctx = viewCtx;
  destroyed = false;
  container.textContent = '';
  buildSkeleton();
  container.appendChild(root);

  const onOver = (ev) => {
    const chip = ev.target.closest && ev.target.closest('.chain-chip');
    if (chip) setHover(chip.dataset.ref);
  };
  const onOut = (ev) => {
    const chip = ev.target.closest && ev.target.closest('.chain-chip');
    if (chip && !(ev.relatedTarget && chip.contains(ev.relatedTarget))) setHover(null);
  };
  const onClick = (ev) => {
    const chip = ev.target.closest && ev.target.closest('.chain-chip');
    if (chip && ctx && typeof ctx.selectWorkplace === 'function') {
      ctx.selectWorkplace(chip.dataset.ref);
    }
  };
  beltContent.addEventListener('mouseover', onOver);
  beltContent.addEventListener('mouseout', onOut);
  beltContent.addEventListener('click', onClick);
  listeners = [
    [beltContent, 'mouseover', onOver],
    [beltContent, 'mouseout', onOut],
    [beltContent, 'click', onClick],
  ];

  // первичная отрисовка «ожидание данных»
  stagesEl.textContent = '';
  stagesEl.appendChild(el('span', 'chain-stages-meta', 'lifecycle: ожидание снапшота…'));
}

export function update(snapshot) {
  if (destroyed || !root) return;
  if (!snapshot || snapshot.ok === false || !Array.isArray(snapshot.workplaces)) {
    stagesEl.textContent = '';
    stagesEl.appendChild(el('span', 'chain-stages-meta', 'нет данных снапшота'));
    emptyEl.hidden = false;
    emptyEl.textContent = snapshot && snapshot.error
      ? 'завод недоступен — ' + snapshot.error
      : 'ожидание снапшота…';
    return;
  }
  emptyEl.hidden = snapshot.workplaces.length > 0;
  renderStages(snapshot.lifecycle);
  buildDepMaps(snapshot.workplaces, snapshot.dependencies);
  workplacesByRef = new Map(snapshot.workplaces.map((w) => [w.workplaceRef, w]));
  reconcileChips(snapshot.workplaces);
  renderDispatcher(snapshot);
}

export function destroy() {
  destroyed = true;
  for (const [node, type, fn] of listeners) node.removeEventListener(type, fn);
  listeners = [];
  for (const t of flashTimers) clearTimeout(t);
  flashTimers.clear();
  chipMap.clear();
  depPred.clear();
  depSucc.clear();
  workplacesByRef.clear();
  hoveredRef = null;
  lastOrderKey = '';
  if (root && root.parentNode) root.parentNode.removeChild(root);
  root = null;
  ctx = null;
}
