// core-events.mjs — хроника для L3 (GET /api/core/events?since=<ISO>&limit=200).
//
// Три источника (SPEC): activity_log (action→title, summary→detail),
// factory_gate_decisions (title=gate:<phase>:<verdict>, detail=workplace),
// factory_process_transitions (title=transition:<key>:<outcome>).
// Смешение форматов времени ('YYYY-MM-DD HH:MM:SS' UTC и ISO-Z) — все
// сравнения и сортировка через parseTs в JS, в ответе всё нормализовано в ISO.
// Оверлап +5s к since; клиент дедуплицирует по key.

import { parseTs, toIso } from './core-snapshot.mjs';
import { resolveRepairReason } from './core-cell.mjs';

const OVERLAP_MS = 5_000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function cap(value) { return truncate(value, 240); }
function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function capEntity(type) {
  const t = String(type ?? '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

/** Слить источники и вернуть страницу событий. sinceMs==null → последняя
 *  страница (самые свежие limit штук, по возрастанию времени). */
export function buildEvents(db, { since, limit } = {}) {
  const now = new Date().toISOString();
  const maxEvents = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sinceMs = since != null && since !== '' ? parseTs(since) : null;

  // Каждый источник читаем с запасом (2x) — после merge-фильтра остаётся
  // достаточно строк даже при перекосе объёма между источниками.
  const fetch = maxEvents * 2;

  const events = [];

  // 1) activity_log — общая хроника (глобальная, по всему заводу)
  const activity = db.prepare(
    `SELECT id, entity_type, entity_id, action, summary, created_at
       FROM activity_log ORDER BY id DESC LIMIT ?`,
  ).all(fetch);
  for (const a of activity) {
    events.push({
      key: `activity:${a.id}`,
      atMs: parseTs(a.created_at),
      at: toIso(a.created_at),
      kind: 'activity',
      title: a.action ?? 'activity',
      detail: cap(a.summary),
      entityType: capEntity(a.entity_type),
      entityId: a.entity_id == null ? null : String(a.entity_id),
    });
  }

  // 2) gate decisions — решения QC
  const gates = db.prepare(
    `SELECT decision_key, workplace_ref, gate_phase, verdict, decided_at,
            gate_run_ref, assessment_candidate_set_refs
       FROM factory_gate_decisions ORDER BY decided_at DESC, rowid DESC LIMIT ?`,
  ).all(fetch);
  for (const g of gates) {
    // у возврата — короткая причина (готовый summary из resolveRepairReason)
    let detail = cap(g.workplace_ref);
    if (g.verdict === 'repair_required') {
      const r = resolveRepairReason(db, g);
      if (r && r.summary) detail += ' — ' + String(r.summary).slice(0, 110);
    }
    events.push({
      key: `gate:${g.decision_key}`,
      atMs: parseTs(g.decided_at),
      at: toIso(g.decided_at),
      kind: 'gate',
      title: `gate:${g.gate_phase ?? '?'}:${g.verdict ?? '?'}`,
      detail,
      entityType: 'Workplace',
      entityId: g.workplace_ref ?? null,
    });
  }

  // 3) process transitions — переходы стадий lifecycle
  const transitions = db.prepare(
    `SELECT id, lifecycle_run_id, transition_key, outcome, target_stage_id,
            terminal_status, created_at
       FROM factory_process_transitions ORDER BY id DESC LIMIT ?`,
  ).all(fetch);
  for (const t of transitions) {
    const detail = t.target_stage_id
      ? `→ stage ${t.target_stage_id}`
      : (t.terminal_status ? `terminal: ${t.terminal_status}` : '');
    events.push({
      key: `transition:${t.id}`,
      atMs: parseTs(t.created_at),
      at: toIso(t.created_at),
      kind: 'transition',
      title: `transition:${t.transition_key ?? '?'}:${t.outcome ?? '?'}`,
      detail: cap(detail),
      entityType: 'LifecycleRun',
      entityId: t.lifecycle_run_id == null ? null : String(t.lifecycle_run_id),
    });
  }

  // Фильтр по времени (оверлап 5s), дедуп по key (источники не пересекаются по
  // префиксу, но защита дешёвая), сортировка по возрастанию, кап по limit.
  const seen = new Set();
  let filtered = [];
  for (const e of events) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    if (e.atMs == null) continue; // битое время — не показываем в хронике
    if (sinceMs != null && e.atMs <= sinceMs - OVERLAP_MS) continue;
    filtered.push(e);
  }
  filtered.sort((a, b) => a.atMs - b.atMs || (a.key < b.key ? -1 : 1));
  if (filtered.length > maxEvents) {
    // держим самые свежие (полоса справа временной оси), порядок — возрастание
    filtered = filtered.slice(filtered.length - maxEvents);
  }

  return {
    ok: true,
    now,
    events: filtered.map(({ atMs, ...rest }) => rest),
  };
}
