// tracker-view-ek — клон legacy доски трекера на НОВОМ событийном ядре.
// Порт визуального языка legacy board-render (колонки/карточки/чипы/heartbeat)
// + замена слоя данных: колонки = лейны проекции нового ядра, карточки =
// work item + состояние его Workplace, значки = обязательства/ожидания.
//
// ДВА РЕЖИМА:
//   LIVE  (по умолчанию): TRACKER_DB указывает на рабочую копию kernel.sqlite;
//         поднимается полная композиция (composeProduction) и командная
//         консоль (handleConsoleRequest): чтение — проекция/мир, запись —
//         ТОЛЬКО типизированные команды POST /api/command. Требует
//         SAGA_REAL_CLAUDE_PATH (opencode shim) для armed-композиции.
//   SAFE  (TRACKER_READONLY=1): БЕЗ композиции, только sqlite readonly:true
//         на каждый запрос (как core-view). Кнопки команд скрыты, консольные
//         endpoint-ы отвечают типизированным отказом. Так можно смотреть
//         ЖИВОЙ qualification DB, не записывая в него ни байта.
//
// Законы EK-7/EK-8 сохранены: никакого card-status, никаких прямых записей
// в задачи — только типизированные команды через консольные адаптеры.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = 'D:/Development/saga-mcp-SAGA4';
const require = createRequire(`file://${ROOT}/package.json`);
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT ?? 4330);
const DB = process.env.TRACKER_DB ?? '';
const SAFE = process.env.TRACKER_READONLY === '1';

if (!DB || !existsSync(DB)) {
  console.error('tracker-view-ek: задай TRACKER_DB=<путь к kernel.sqlite нового ядра>');
  process.exit(1);
}

// ---------------------------------------------------------------- SAFE data
// SQL-зеркало projector factsOfItem + cards.deriveLane: тот же порядок
// прецедента (terminal > waiting > repair > review > in-progress > todo),
// те же durable-факты (workplace_work_intent binding, obligations, waits,
// proofs). Чтение строго readonly, соединение на каждый запрос.
const REPAIR_STATUSES = new Set(['repair-wait-entered', 'repair-epoch-rolled-over', 'authority-scope-widened', 'effect-retryable']);
const REVIEW_STATUSES = new Set(['author-gate-decided', 'reviewer-intent-admitted', 'reviewer-contribution-recorded', 'reviewer-revision-sealed', 'reviewer-candidates-presented']);

const openReadonly = () => new Database(DB, { readonly: true });
const tryAll = (db, sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };

function deriveLane({ terminal, pendingWaits, workplaceStatus, hasWorkplace }) {
  if (terminal) return 'terminal';
  if (pendingWaits > 0) return 'waiting';
  if (hasWorkplace && REPAIR_STATUSES.has(workplaceStatus)) return 'repair';
  if (hasWorkplace && REVIEW_STATUSES.has(workplaceStatus)) return 'review';
  if (hasWorkplace) return 'in-progress';
  return 'todo';
}

function safeBoard() {
  const db = openReadonly();
  try {
    const items = tryAll(db, 'SELECT instance_id, status, terminal, revision, last_sequence FROM work_item ORDER BY instance_id');
    const workplaces = tryAll(db, 'SELECT instance_id, status, terminal, revision, last_sequence FROM workplace');
    const wpById = new Map(workplaces.map(w => [w.instance_id, w]));
    const openObl = tryAll(db, "SELECT kind, source_instance_id, target_instance_id FROM transition_obligation WHERE state='open'");
    const waits = tryAll(db, "SELECT kind, owner_instance_id FROM typed_wait WHERE state='pending'");
    const proofs = tryAll(db, 'SELECT owner_instance_id, proof_kind FROM terminal_proof');
    const lastSeqRow = db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM workflow_event').get();
    const cards = items.map(it => {
      const intents = tryAll(db, 'SELECT intent_ref, workplace_instance_id, protocol_role FROM workplace_work_intent WHERE work_item_ref = ? ORDER BY rowid', it.instance_id);
      const wps = [...new Set(intents.map(i => i.workplace_instance_id))];
      const active = wps.length ? wps[wps.length - 1] : null;
      const wp = active ? wpById.get(active) : null;
      const scope = wps; // зеркало projector factsOfItem: relevant = только цеха
      const obligs = openObl.filter(o => scope.includes(o.source_instance_id) || (o.target_instance_id !== null && scope.includes(o.target_instance_id)));
      const pending = waits.filter(w => scope.includes(w.owner_instance_id));
      const terminal = Boolean((wp && wp.terminal) || it.terminal || proofs.some(p => wps.includes(p.owner_instance_id)));
      const lane = deriveLane({ terminal, pendingWaits: pending.length, workplaceStatus: wp ? wp.status : null, hasWorkplace: Boolean(wp) });
      const proof = proofs.filter(p => wps.includes(p.owner_instance_id)).pop();
      return {
        cardId: `card:${it.instance_id.replace(/^work-item:/, '')}`,
        workItemRef: it.instance_id.replace(/^work-item:/, ''),
        workItemInstanceId: it.instance_id,
        workItemStatus: it.status,
        workplaceInstanceId: active,
        workplaceStatus: wp ? wp.status : null,
        lane,
        openObligationKinds: [...new Set(obligs.map(o => o.kind))].sort(),
        pendingWaits: pending.map(w => ({ kind: w.kind })),
        terminalProof: proof ? { scope: proof.proof_kind } : null,
        roles: [...new Set(intents.map(i => i.protocol_role))],
        revision: wp ? wp.revision : it.revision,
        lastSequence: (wp ? wp.last_sequence : it.last_sequence) ?? 0,
        globalSequence: lastSeqRow.n,
      };
    });
    return { ok: true, mode: 'safe', cards, sequence: lastSeqRow.n };
  } finally { db.close(); }
}

function safeSummary() {
  const db = openReadonly();
  try {
    const one = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
    return {
      ok: true, mode: 'safe', db: DB,
      workItems: one('SELECT COUNT(*) n FROM work_item'),
      workplaces: one('SELECT COUNT(*) n FROM workplace'),
      openObligations: one("SELECT COUNT(*) n FROM transition_obligation WHERE state='open'"),
      pendingWaits: one("SELECT COUNT(*) n FROM typed_wait WHERE state='pending'"),
      events: one('SELECT COUNT(*) n FROM workflow_event'),
      proofs: one('SELECT COUNT(*) n FROM terminal_proof'),
      lastSequence: one('SELECT COALESCE(MAX(sequence),0) n FROM workflow_event'),
    };
  } finally { db.close(); }
}

// Хроника для вкладки «Мир» в SAFE-режиме (readonly SQL).
function safeEvents(limit = 80) {
  const db = openReadonly();
  try {
    return { ok: true, events: tryAll(db, 'SELECT sequence, kind, source_instance_id, source_status, transition FROM workflow_event ORDER BY sequence DESC LIMIT ?', Math.min(300, limit)) };
  } finally { db.close(); }
}

// ---------------------------------------------------------------- LIVE data
let composition = null;
let deps = null;
let handleConsoleRequest = null;
if (!SAFE) {
  // Env-аранжи для armed-композиции (AGENTS.md: opencode shim, никогда claude).
  process.env.SAGA_REAL_CLAUDE_PATH ??= 'node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs';
  process.env.SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS ??= '1';
  const production = await import(`file://${ROOT}/dist/workflow-kernel/composition/production.js`.replaceAll('\\', '/'));
  const consoleModule = await import(`file://${ROOT}/dist/workflow-kernel/composition/console.js`.replaceAll('\\', '/'));
  composition = production.composeProduction({ dbPath: DB, env: process.env });
  deps = production.consoleAdapterDeps(composition);
  handleConsoleRequest = consoleModule.handleConsoleRequest;
  // Одноразовый автодогрев проекции: пустой store после свежего копирования БД
  // перестраивается из авторитетных фактов (диспозабельна по построению).
  try {
    if (composition.cards.all().length === 0) {
      const out = handleConsoleRequest(composition, deps, { method: 'POST', path: '/api/projection/rebuild' }, {});
      console.log(`tracker-view-ek: projection auto-rebuild → ${JSON.stringify(out.body)}`);
    }
  } catch (e) { console.error('auto-rebuild failed:', e.message); }
}

// LIVE-доска: чтение ТОЛЬКО из одноразовой проекции (kanban_card payload).
// Голова журнала (для точки свежести) — readonly-взгляд на ledger sequence.
function liveBoard() {
  let globSeq = 0;
  try { const db = openReadonly(); try { globSeq = db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM workflow_event').get().n; } finally { db.close(); } } catch { /* проекция без головы */ }
  const cards = composition.cards.all().map(row => {
    const p = row.payload || {};
    return {
      cardId: row.cardId,
      workItemRef: row.workItemRef,
      workItemInstanceId: p.workItemInstanceId ?? null,
      workItemStatus: p.workItemStatus ?? null,
      workplaceInstanceId: p.workplaceInstanceId ?? null,
      workplaceStatus: p.workplaceStatus ?? null,
      lane: row.lane,
      openObligationKinds: p.openObligationKinds ?? [],
      pendingWaits: (p.pendingWaits ?? []).map(w => ({ kind: w.kind })),
      terminalProof: p.terminalProof ? { scope: p.terminalProof.scope } : null,
      roles: [...new Set((p.pinnedRoleContracts ?? []).map(c => c.protocolRole).filter(Boolean))],
      lastSequence: p.projectedSequence ?? row.projectedSequence ?? 0,
      globalSequence: globSeq,
    };
  });
  return { ok: true, mode: 'live', cards, sequence: globSeq };
}

// Heartbeat одинаков в обоих режимах: возраст последней записи в журнале
// (ledger sequence). Таймстампов в новом ядре нет — пульс по росту sequence.
function heartbeat() {
  const db = openReadonly();
  try {
    const row = db.prepare('SELECT COALESCE(MAX(sequence),0) n, COUNT(*) c FROM workflow_event').get();
    return { ok: true, last: row.n, total: row.c, mode: SAFE ? 'safe' : 'live' };
  } finally { db.close(); }
}

const refuseConsole = (method, path) => ({
  status: 403,
  body: {
    refused: true, code: 'SAFE_READONLY_MODE',
    detail: `${method} ${path} отключён: tracker-view-ek запущен с TRACKER_READONLY=1 (sqlite readonly, без композиции). Перезапусти без TRACKER_READONLY и с TRACKER_DB, указывающим на РАБОЧУЮ КОПИЮ kernel.sqlite, чтобы включить командную консоль.`,
  },
});

// ---------------------------------------------------------------- HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };

  if (url.pathname.startsWith('/api/')) {
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }
    // -- собственные endpoint-ы доски (работают в обоих режимов) ----------
    try {
      if (req.method === 'GET' && url.pathname === '/api/board') return json(200, SAFE ? safeBoard() : liveBoard());
      if (req.method === 'GET' && url.pathname === '/api/summary') return json(200, SAFE ? safeSummary() : (s => (s.mode = 'live', s))(safeSummary()));
      if (req.method === 'GET' && url.pathname === '/api/heartbeat') return json(200, heartbeat());
      if (req.method === 'GET' && url.pathname === '/api/events') return json(200, safeEvents(Number(url.searchParams.get('limit') ?? 80)));
    } catch (e) { return json(500, { ok: false, error: e.message }); }

    // -- консольные endpoint-ы ядра (только LIVE) --------------------------
    if (!SAFE) {
      const out = handleConsoleRequest(composition, deps, { method: req.method, path: url.pathname, query: url.searchParams }, body);
      return json(out.status, out.body);
    }
    return json(403, refuseConsole(req.method, url.pathname).body);
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = join(dirname(fileURLToPath(import.meta.url)), 'public', file);
  if (!full.startsWith(join(dirname(fileURLToPath(import.meta.url)), 'public')) || !existsSync(full)) {
    res.writeHead(404); return res.end('not found');
  }
  const type = full.endsWith('.html') ? 'text/html; charset=utf-8'
    : full.endsWith('.js') ? 'text/javascript' : full.endsWith('.css') ? 'text/css' : 'text/plain';
  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(full));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tracker-view-ek: http://localhost:${PORT} — DB ${DB}`);
  console.log(SAFE
    ? 'режим SAFE (readonly): кнопки команд скрыты, консоль закрыта типизированным отказом'
    : 'режим LIVE: команды → POST /api/command; проекция → POST /api/projection/rebuild');
});
