// core-view-ek — пассивный наблюдатель за НОВЫМ ядром событий (порт 4323).
// Клон legacy core-view с информационной плотностью старой доски:
//   - вкладки: Цеха / Конвейер (дерево run-ов) / Обязательства / Ожидания /
//     Хроника (kind-coloring);
//   - тёмная тема и таблицы в визуальном языке legacy board-render.
// Железные правила (SPEC legacy core-view), без исключений:
//   - better-sqlite3 СТРОГО readonly:true;
//   - открытие БД НА КАЖДЫЙ запрос (свежие данные, нет долгоживущих хэндлов);
//   - НИ ОДНОЙ записи; bind 127.0.0.1.
// Схема: workflow_event / workplace / work_item / transition_obligation /
// typed_wait / terminal_proof / activity_attempt (+receipts) / *_run heads /
// workplace_work_intent (durable binding work-item -> workplace -> role).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('file://D:/Development/saga-mcp-SAGA4/package.json');
const Database = require('better-sqlite3');

const PORT = Number(process.env.CORE_VIEW_PORT ?? process.env.PORT ?? 4323);
const DB = process.env.CORE_VIEW_DB ?? '';
if (!DB || !existsSync(DB)) {
  console.error('core-view-ek: задай CORE_VIEW_DB=<путь к kernel.sqlite нового ядра>');
  process.exit(1);
}

// Открытие строго readonly, на каждый запрос. Никаких pragma-записей.
const open = () => new Database(DB, { readonly: true });

// --- lane derivation: SQL-зеркало projection/cards.js deriveLane ----------
// Тот же порядок прецедента: terminal > waiting > repair > review > in-progress > todo.
const REPAIR_STATUSES = new Set([
  'repair-wait-entered', 'repair-epoch-rolled-over', 'authority-scope-widened', 'effect-retryable',
]);
const REVIEW_STATUSES = new Set([
  'author-gate-decided', 'reviewer-intent-admitted', 'reviewer-contribution-recorded',
  'reviewer-revision-sealed', 'reviewer-candidates-presented',
]);

function laneOfCard({ workplaceTerminal, itemTerminal, proofs, pendingWaits, workplaceStatus, hasWorkplace }) {
  if (workplaceTerminal || itemTerminal || proofs > 0) return 'terminal';
  if (pendingWaits > 0) return 'waiting';
  if (hasWorkplace && REPAIR_STATUSES.has(workplaceStatus)) return 'repair';
  if (hasWorkplace && REVIEW_STATUSES.has(workplaceStatus)) return 'review';
  if (hasWorkplace) return 'in-progress';
  return 'todo';
}

// Все guards: таблица может отсутствовать в более ранней миграции ядра.
const tryAll = (db, sql, ...args) => {
  try { return db.prepare(sql).all(...args); } catch { return []; }
};

const api = {
  // ---- snapshot: счётчики + головы run-ов + цеха с lane -------------------
  snapshot: () => {
    const db = open();
    try {
      const one = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
      const runs = {};
      for (const t of ['factory_run', 'lifecycle_run', 'stage_run', 'process_run', 'node_run']) {
        try { runs[t] = db.prepare(`SELECT instance_id, status, terminal, revision FROM ${t}`).all(); } catch { runs[t] = []; }
      }
      const workplaces = tryAll(db, 'SELECT instance_id, status, terminal, revision FROM workplace');
      const proofsAll = tryAll(db, 'SELECT owner_instance_id FROM terminal_proof');
      const proofOwners = new Set(proofsAll.map(p => p.owner_instance_id));
      const items = tryAll(db, 'SELECT instance_id, status, terminal, revision FROM work_item');
      const waits = tryAll(db, "SELECT owner_instance_id FROM typed_wait WHERE state='pending'");
      const waitOwners = new Set(waits.map(w => w.owner_instance_id));
      const cards = items.map(it => {
        const intents = tryAll(db, 'SELECT intent_ref, workplace_instance_id, protocol_role, role_contract_ref FROM workplace_work_intent WHERE work_item_ref = ?', it.instance_id);
        const wps = intents.map(i => i.workplace_instance_id);
        const active = wps.length ? wps[wps.length - 1] : null;
        const wp = active ? workplaces.find(w => w.instance_id === active) : null;
        const proofs = [...wps, it.instance_id].filter(x => proofOwners.has(x)).length;
        const pendingWaits = [...wps, it.instance_id].filter(x => waitOwners.has(x)).length;
        const lane = laneOfCard({
          workplaceTerminal: Boolean(wp && wp.terminal), itemTerminal: Boolean(it.terminal),
          proofs, pendingWaits, workplaceStatus: wp ? wp.status : null, hasWorkplace: Boolean(wp),
        });
        return {
          work_item: it.instance_id, item_status: it.status, item_terminal: it.terminal,
          workplace: active, workplace_status: wp ? wp.status : null, workplace_terminal: wp ? wp.terminal : null,
          revision: it.revision, lane,
          roles: [...new Set(intents.map(i => i.protocol_role))],
          role_pins: intents.map(i => ({ role: i.protocol_role, pin: i.role_contract_ref })),
        };
      });
      return {
        ok: true, db: DB,
        counters: {
          events: one('SELECT COUNT(*) n FROM workflow_event'),
          attempts: one('SELECT COUNT(*) n FROM activity_attempt'),
          receipts: one('SELECT COUNT(*) n FROM activity_attempt_prompt_assembly_receipt'),
          proofs: one('SELECT COUNT(*) n FROM terminal_proof'),
          openObligations: one("SELECT COUNT(*) n FROM transition_obligation WHERE state='open'"),
          doneObligations: one("SELECT COUNT(*) n FROM transition_obligation WHERE state='completed'"),
          pendingWaits: one("SELECT COUNT(*) n FROM typed_wait WHERE state='pending'"),
          workplaces: workplaces.length,
          workItems: items.length,
          lastSequence: one('SELECT COALESCE(MAX(sequence),0) n FROM workflow_event'),
        },
        runs, cards,
      };
    } finally { db.close(); }
  },

  // ---- obligations: таблица по видам + открытый список --------------------
  obligations: () => {
    const db = open();
    try {
      return {
        ok: true,
        byKind: tryAll(db, `SELECT kind, state, COUNT(*) n FROM transition_obligation GROUP BY kind, state ORDER BY kind, state`),
        openList: tryAll(db, `SELECT id, kind, source, source_instance_id, target, target_aggregate, target_instance_id, state
                              FROM transition_obligation WHERE state='open' ORDER BY id`),
      };
    } finally { db.close(); }
  },

  // ---- waits: панель ожиданий со ссылками на владельцев -------------------
  waits: () => {
    const db = open();
    try {
      const all = tryAll(db, `SELECT id, kind, owner_aggregate, owner_instance_id, wake_commands_json,
                                     wake_obligation_kinds_json, dead_wake_conversion, state, discharge_evidence_ref
                              FROM typed_wait ORDER BY state='pending' DESC, id`);
      return {
        ok: true,
        pending: all.filter(w => w.state === 'pending').map(w => ({
          ...w,
          wake_commands: (() => { try { return JSON.parse(w.wake_commands_json || '[]'); } catch { return []; } })(),
          wake_obligation_kinds: (() => { try { return JSON.parse(w.wake_obligation_kinds_json || '[]'); } catch { return []; } })(),
        })),
        discharged: all.filter(w => w.state !== 'pending').map(w => ({ id: w.id, kind: w.kind, owner_instance_id: w.owner_instance_id, state: w.state })),
      };
    } finally { db.close(); }
  },

  // ---- events: хроника с kind/transition ----------------------------------
  events: (limit = 100) => {
    const db = open();
    try {
      const rows = tryAll(db, `SELECT sequence, kind, source_owner, source_instance_id, source_revision,
                                      source_status, transition FROM workflow_event ORDER BY sequence DESC LIMIT ?`,
        Math.min(500, Math.max(1, limit)));
      return { ok: true, events: rows };
    } finally { db.close(); }
  },

  // ---- tree: конвейер factory > lifecycle > stage > process > node --------
  // Родительских колонок в *_run головах нет — иерархию собираем по порядку
  // первого появления инстанса в workflow_event (creation-событие) и
  // структурному рангу агрегата. Это display-grouping закоммиченных фактов.
  tree: () => {
    const db = open();
    try {
      const events = tryAll(db, 'SELECT sequence, source_owner, source_instance_id, kind FROM workflow_event ORDER BY sequence ASC');
      const firstSeen = new Map();
      for (const e of events) {
        if (!firstSeen.has(e.source_instance_id)) firstSeen.set(e.source_instance_id, { sequence: e.sequence, kind: e.kind });
      }
      const RANK = [
        ['factory_run', 'factory-run', '🏭 FactoryRun'],
        ['lifecycle_run', 'lifecycle-run', '🧭 LifecycleRun'],
        ['stage_run', 'stage-run', '🎯 StageRun'],
        ['process_run', 'process-run', '⚙ ProcessRun'],
        ['node_run', 'node-run', '🔧 NodeRun'],
      ];
      const nodes = [];
      for (const [table, prefix, label] of RANK) {
        const rows = tryAll(db, `SELECT instance_id, status, terminal, revision FROM ${table}`);
        for (const r of rows) {
          nodes.push({
            table, id: r.instance_id, label, status: r.status, terminal: r.terminal,
            revision: r.revision, first_sequence: firstSeen.get(r.instance_id)?.sequence ?? null,
            first_kind: firstSeen.get(r.instance_id)?.kind ?? null,
          });
        }
      }
      const intents = tryAll(db, 'SELECT intent_ref, work_item_ref, workplace_instance_id, protocol_role FROM workplace_work_intent');
      const workplaces = tryAll(db, 'SELECT instance_id, status, terminal, revision FROM workplace');
      const items = tryAll(db, 'SELECT instance_id, status, terminal, revision FROM work_item');
      const wpChildren = new Map();
      for (const i of intents) {
        if (!wpChildren.has(i.workplace_instance_id)) wpChildren.set(i.workplace_instance_id, []);
        wpChildren.get(i.workplace_instance_id).push({ role: i.protocol_role, item: i.work_item_ref });
      }
      return {
        ok: true,
        runs: nodes.sort((a, b) => (a.first_sequence ?? 0) - (b.first_sequence ?? 0)),
        workplaces: workplaces.map(w => ({
          ...w, first_sequence: firstSeen.get(w.instance_id)?.sequence ?? null,
          intents: wpChildren.get(w.instance_id) || [],
        })),
        work_items: items.map(it => ({ ...it, first_sequence: firstSeen.get(it.instance_id)?.sequence ?? null })),
      };
    } finally { db.close(); }
  },

  // ---- proofs: терминальные доказательства --------------------------------
  proofs: () => {
    const db = open();
    try {
      return { ok: true, proofs: tryAll(db, 'SELECT id, proof_kind, scope, owner_aggregate, owner_instance_id, created_sequence FROM terminal_proof ORDER BY created_sequence') };
    } finally { db.close(); }
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).split('/')[0];
    try {
      const fn = api[name];
      if (!fn) return json({ ok: false, error: 'unknown endpoint: ' + name });
      return json(fn(Number(url.searchParams.get('limit') ?? 100)));
    } catch (e) { return json({ ok: false, error: e.message }); }
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
server.listen(PORT, '127.0.0.1', () => console.log(`core-view-ek(new kernel, readonly): http://localhost:${PORT} — DB ${DB}`));
