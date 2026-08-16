// core-cell.mjs — детали одной Production Cell для L2 (GET /api/core/cell?workplace=<ref>).
//
// Реальные связи живой БД (выборки, не SPEC-гипотезы):
//   * candidates: factory_candidate_sets.workplace_ref; members — count строк
//     factory_candidate_set_members по candidate_set_ref;
//   * gates: factory_gate_decisions.workplace_ref (gate_run_ref есть в самой
//     строке решения);
//   * executions: worker_executions по task_id ячейки. На живой БД связь
//     tasks.workplace_ref — каноническая (покрывает все ячейки);
//     factory_workplace_graph_items — fallback (только implementation-графы);
//     metadata — JSON, парсим аккуратно (там execution_context/model/replay);
//   * recovery: factory_recovery_cases по process_run_id (в тестбеде пусто —
//     норма); реального case_ref нет, собираем канонический 'recovery-case:<id>';
//   * effects: factory_cell_effect_receipts.workplace_ref (receipt:true);
//     factory_external_effect_actions не имеет прямой ссылки на workplace —
//     джойним по (process_run_id, module_ref_key), best effort (пусто в тестбеде);
//   * finalAcceptance: factory_cell_final_acceptances.workplace_ref, последний
//     по accepted_at.

import {
  toIso, parseJsonSafe, decorateWorkplaces, workerForWorkplace,
} from './core-snapshot.mjs';
import { tailJsonl } from './log-tail.mjs';

const MAX_CANDIDATES = 50;
const MAX_GATES = 50;
const MAX_EXECUTIONS = 20;

/** GET /api/core/cell?workplace=<ref>. */
export function buildCell(db, { workplaceRef } = {}) {
  const now = new Date().toISOString();

  const w = db.prepare(
    'SELECT * FROM factory_workplaces WHERE workplace_ref = ?',
  ).get(workplaceRef);
  if (!w) return { ok: false, error: `workplace not found: ${workplaceRef}` };

  // Тот же обогащённый вид карточки, что в snapshot.workplaces[]
  const { workplaces } = decorateWorkplaces(db, [w]);
  const workplace = workplaces[0];

  // --- candidates (+ members) ---
  const candidateRows = db.prepare(
    `SELECT candidate_set_ref, role, candidate_set_digest, sealed_at
       FROM factory_candidate_sets
      WHERE workplace_ref = ? ORDER BY sealed_at DESC LIMIT ${MAX_CANDIDATES}`,
  ).all(workplaceRef);
  const candidateRefs = candidateRows.map(c => c.candidate_set_ref);
  const membersByRef = new Map();
  if (candidateRefs.length) {
    const ph = candidateRefs.map(() => '?').join(',');
    const memberRows = db.prepare(
      `SELECT candidate_set_ref, count(*) AS n
         FROM factory_candidate_set_members
        WHERE candidate_set_ref IN (${ph}) GROUP BY candidate_set_ref`,
    ).all(...candidateRefs);
    for (const m of memberRows) membersByRef.set(m.candidate_set_ref, m.n);
  }
  const candidates = candidateRows.map(c => ({
    candidateSetRef: c.candidate_set_ref,
    role: c.role ?? null,
    digest: c.candidate_set_digest ?? null,
    sealedAt: toIso(c.sealed_at),
    members: membersByRef.get(c.candidate_set_ref) ?? 0,
  }));

  // --- gates ---
  const gateRows = db.prepare(
    `SELECT gate_run_ref, gate_phase, verdict, repair_target_role, decided_at,
            assessment_candidate_set_refs
       FROM factory_gate_decisions
      WHERE workplace_ref = ? ORDER BY decided_at DESC, rowid DESC LIMIT ${MAX_GATES}`,
  ).all(workplaceRef);
  const gates = gateRows.map(g => ({
    gateRunRef: g.gate_run_ref ?? null,
    gatePhase: g.gate_phase ?? null,
    verdict: g.verdict ?? null,
    repairTargetRole: g.repair_target_role ?? null,
    decidedAt: toIso(g.decided_at),
    reason: g.verdict === 'repair_required' ? resolveRepairReason(db, g) : null,
  }));

  // --- executions (по task_id ячейки: tasks.workplace_ref + graph fallback) ---
  const taskIds = db.prepare(
    'SELECT DISTINCT id FROM tasks WHERE workplace_ref = ?',
  ).all(workplaceRef).map(r => r.id);
  for (const g of db.prepare(
    'SELECT DISTINCT task_id FROM factory_workplace_graph_items WHERE workplace_ref = ?',
  ).all(workplaceRef)) {
    if (g.task_id != null && !taskIds.includes(g.task_id)) taskIds.push(g.task_id);
  }
  let executions = [];
  let lastLogPath = null;
  if (taskIds.length) {
    const ph = taskIds.map(() => '?').join(',');
    const execRows = db.prepare(
      `SELECT * FROM worker_executions WHERE task_id IN (${ph})
        ORDER BY started_at DESC, rowid DESC LIMIT ${MAX_EXECUTIONS}`,
    ).all(...taskIds);
    executions = execRows.map(e => {
      if (!lastLogPath && e.log_path) lastLogPath = e.log_path;
      return {
        executionId: e.execution_id,
        state: e.state ?? null,
        workerId: e.worker_id ?? null,
        pid: e.pid ?? null,
        startedAt: toIso(e.started_at),
        finishedAt: toIso(e.finished_at),
        logPath: e.log_path ?? null,
        meta: parseJsonSafe(e.metadata),
      };
    });
  }

  // --- recovery (пусто в тестбеде — норма) ---
  const recoveryRows = db.prepare(
    `SELECT id, opened_at, last_issue_ref FROM factory_recovery_cases
      WHERE process_run_id = ? ORDER BY opened_at DESC LIMIT 20`,
  ).all(w.process_run_id);
  const recovery = recoveryRows.map(r => ({
    caseRef: `recovery-case:${r.id}`,
    createdAt: toIso(r.opened_at),
    issueRef: r.last_issue_ref ?? null,
  }));

  // --- effects: receipts (факт) + actions (best effort) ---
  const effects = [];
  const receiptRows = db.prepare(
    `SELECT effect_receipt_ref, effect_id, created_at
       FROM factory_cell_effect_receipts
      WHERE workplace_ref = ? ORDER BY created_at DESC LIMIT 50`,
  ).all(workplaceRef);
  for (const r of receiptRows) {
    effects.push({
      ref: r.effect_receipt_ref,
      kind: r.effect_id ?? null,
      state: 'receipted',
      at: toIso(r.created_at),
      receipt: true,
    });
  }
  const actionRows = db.prepare(
    `SELECT id, action_key, state, created_at
       FROM factory_external_effect_actions
      WHERE process_run_id = ? AND module_ref_key = ?
      ORDER BY created_at DESC LIMIT 50`,
  ).all(w.process_run_id, w.module_ref);
  for (const a of actionRows) {
    effects.push({
      ref: `effect-action:${a.id}`,
      kind: a.action_key ?? null,
      state: a.state ?? null,
      at: toIso(a.created_at),
      receipt: false,
    });
  }

  // --- final acceptance (последний по accepted_at) ---
  const acceptanceRow = db.prepare(
    `SELECT final_acceptance_ref, candidate_set_ref
       FROM factory_cell_final_acceptances
      WHERE workplace_ref = ? ORDER BY accepted_at DESC LIMIT 1`,
  ).get(workplaceRef);
  const finalAcceptance = acceptanceRow ? {
    ref: acceptanceRow.final_acceptance_ref,
    subjectCandidateSetRef: acceptanceRow.candidate_set_ref ?? null,
  } : null;

  // --- logTail: хвост JSONL живого/последнего execution ---
  let logTail = null;
  if (lastLogPath) logTail = tailJsonl(lastLogPath, 120);

  // --- kanban: карточки этой станции (авторская + ревьюерская) с их колонками ---
  // Колонка доски (:4321) — это tasks.status; ячейка обычно представлена
  // двумя карточками: /author: и /reviewer:.
  const cardRows = db.prepare(
    'SELECT id, title, status, epic_id FROM tasks WHERE workplace_ref = ? ORDER BY id',
  ).all(workplaceRef);
  const cards = cardRows.map(t => ({
    taskId: t.id,
    title: t.title ?? null,
    status: t.status ?? null,
    role: /\/reviewer:/.test(String(t.title || '')) ? 'reviewer'
      : /\/author:/.test(String(t.title || '')) ? 'author' : null,
  }));
  let projectId = null;
  let projectName = null;
  if (cardRows.length) {
    const p = db.prepare(
      `SELECT p.id AS id, p.name AS name FROM projects p
         JOIN epics e ON e.project_id = p.id WHERE e.id = ? LIMIT 1`,
    ).get(cardRows[0].epic_id);
    if (p) { projectId = p.id; projectName = p.name ?? null; }
  }

  return {
    ok: true,
    now,
    workplace,
    candidates,
    gates,
    executions,
    recovery,
    effects,
    finalAcceptance,
    logTail,
    cards,
    projectId,
    projectName,
  };
}

// workerForWorkplace реэкспортируется для симметрии импорта сервера (не часть
// HTTP-контракта).
export { workerForWorkplace };

// Коды диагностики чеков (base64-evidence) → человеческие фразы.
const CHECK_CODE_PHRASES = {
  'path-outside-authority': 'изменения вне разрешённых файлов задачи',
  'implementation-coverage-gap': 'покрытие реализации не равно принятому объёму AC',
  'implementation-scope-overlap': 'области реализации пересекаются без порядка зависимостей',
  'verification-lineage-mismatch': 'линейка верификации не совпадает с предметом',
  'review-finding-1': 'замечание ревью',
};
function checkPhrase(code) {
  return CHECK_CODE_PHRASES[code] || (code ? 'чек: ' + code : 'провален чек');
}

/**
 * Причина возврата (repair_required) — прогрессивное раскрытие:
 *  1) findings ревью-вердикта из assessment-сета (человеческий текст);
 *  2) fallback — проваленные чеки гейт-рана: evidence-рефы несут base64
 *     диагностику {code, message} — декодируем в читаемую причину.
 * decisionRow: строка factory_gate_decisions (нужны assessment_candidate_set_refs,
 * gate_run_ref). Возвращает { source, summary?, reviewVerdict?, findings?[],
 * checksFailed?[{provider,code,phrase,message}] } | null.
 */
export function resolveRepairReason(db, decisionRow) {
  // 1) ревью-вердикт: assessment-сеты → члены → материал со схемой *review-verdict*
  const assessRaw = decisionRow.assessment_candidate_set_refs;
  const assess = (() => { try { return JSON.parse(assessRaw || '[]'); } catch { return []; } })();
  if (Array.isArray(assess) && assess.length) {
    const ph = assess.map(() => '?').join(',');
    const members = db.prepare(
      `SELECT product_digest FROM factory_candidate_set_members
        WHERE candidate_set_ref IN (${ph})`,
    ).all(...assess);
    for (const m of members) {
      const mat = db.prepare(
        `SELECT schema_id, payload_snapshot FROM factory_sealed_product_materials
          WHERE content_digest = ? AND schema_id LIKE '%review-verdict%'`,
      ).get(m.product_digest);
      if (!mat) continue;
      try {
        const j = JSON.parse(mat.payload_snapshot);
        const findings = Array.isArray(j.findings)
          ? j.findings.map(f => String(f)).slice(0, 8) : [];
        return {
          source: 'review',
          reviewVerdict: j.verdict ?? null,
          findings,
          summary: findings.length ? findings[0].slice(0, 160)
            : 'ревью: ' + (j.verdict || 'вердикт без текста'),
        };
      } catch { /* повреждённый payload — идём к чекам */ }
    }
  }
  // 2) проваленные чеки авторского гейта: evidence-рефы несут base64-диагностику
  //    {code, message} — декодируем в читаемую причину.
  const failed = db.prepare(
    `SELECT provider_id, outcome, evidence_refs FROM factory_check_receipts
      WHERE check_run_ref = ? AND outcome IS NOT NULL AND outcome != 'passed'`,
  ).all(decisionRow.gate_run_ref).slice(0, 4);
  if (failed.length) {
    const checksFailed = failed.map(f => {
      const item = { provider: f.provider_id, code: null, phrase: checkPhrase(null), message: null };
      try {
        const refs = JSON.parse(f.evidence_refs || '[]');
        const b64 = String(refs[0] || '').split('/').pop();
        const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        item.code = j.code ?? null;
        item.phrase = checkPhrase(j.code);
        if (j.message) item.message = String(j.message).slice(0, 240);
      } catch { /* evidence не декодируется — останется провайдер */ }
      return item;
    });
    const first = checksFailed[0];
    const summary = first
      ? first.phrase + (first.message ? ': ' + first.message.slice(0, 140)
          : ' (' + first.provider + ')')
      : 'провалены чеки';
    return { source: 'checks', checksFailed, summary };
  }
  return null;
}
