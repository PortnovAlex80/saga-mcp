// HUMAN-GATE-CONSOLE endpoints (docs/architecture/HUMAN-GATE-CONSOLE.md).
//
// The operator-facing answer surface for two "the factory asks a human"
// boundaries that previously had backend but no UI:
//   1. GATE_HUMAN_REQUIRED parks — a quality gate verdict the machine could
//      not decide; the operator answers accept / reject(+feedback) and the
//      engine's re-run converts the indeterminate check citing the answer.
//   2. Open human_requests (worker_ask_need) — a worker's blocking question;
//      the operator writes the answer a fresh worker will read.
//
// Read paths are plain DB projections; the write paths are the audited
// services from dist (append-only resolution row + canonical repair-requeued
// resume, CAS answer flip + needs-human tag clear).

import {
  ensureHumanGateResolutionSchema,
  listPendingHumanGateParks,
  resolveHumanGate,
} from '../dist/app/human-gate-resolution.js';

export function createHumanGateEndpointsApi({
  withDb,
  withDbWrite,
  respondJson,
  readJsonRequest,
}) {
  function handleHumanGatesList(req, res, url) {
    const projectIdRaw = url.searchParams.get('project_id');
    const projectId = projectIdRaw !== null && /^\d+$/.test(projectIdRaw)
      ? Number(projectIdRaw)
      : undefined;
    try {
      const gates = withDb(db => {
        ensureHumanGateResolutionSchema(db);
        return listPendingHumanGateParks(db, projectId);
      });
      return respondJson(res, 200, { gates, count: gates.length });
    } catch (e) {
      return respondJson(res, 500, { ok: false, error: 'human-gates list failed: ' + e.message });
    }
  }

  function handleHumanGateResolve(req, res) {
    readJsonRequest(req, fields => {
      const workplaceRef = typeof fields.workplace_ref === 'string' ? fields.workplace_ref : '';
      const decision = fields.decision;
      const feedback = typeof fields.feedback === 'string' ? fields.feedback : '';
      const actorId = typeof fields.actor_id === 'string' && fields.actor_id.trim().length > 0
        ? fields.actor_id.trim()
        : 'tracker-operator';
      if (!workplaceRef) {
        return respondJson(res, 400, { ok: false, error: 'workplace_ref is required' });
      }
      if (decision !== 'accept' && decision !== 'reject') {
        return respondJson(res, 400, { ok: false, error: "decision must be 'accept' or 'reject'" });
      }
      try {
        const result = withDbWrite(db => resolveHumanGate(db, {
          workplaceRef, decision, feedback, actorId,
        }));
        return respondJson(res, 200, { ok: true, ...result });
      } catch (e) {
        const code = String(e.message).startsWith('HUMAN_GATE_FEEDBACK_REQUIRED')
          || String(e.message).startsWith('HUMAN_GATE_RESOLUTION_INVALID')
          ? 400
          : String(e.message).startsWith('HUMAN_GATE_PARK_NOT_FOUND') ? 409 : 500;
        return respondJson(res, code, { ok: false, error: e.message });
      }
    });
  }

  function handleHumanRequestsList(req, res, url) {
    const projectIdRaw = url.searchParams.get('project_id');
    const projectId = projectIdRaw !== null && /^\d+$/.test(projectIdRaw)
      ? Number(projectIdRaw)
      : undefined;
    try {
      const requests = withDb(db => db.prepare(`
        SELECT hr.request_id, hr.task_id, hr.question, hr.context_json,
               hr.resume_phase, hr.created_at AS asked_at,
               t.title AS task_title, e.name AS epic_name, p.name AS project_name
          FROM human_requests hr
          JOIN tasks t ON t.id = hr.task_id
          JOIN epics e ON e.id = t.epic_id
          JOIN projects p ON p.id = e.project_id
         WHERE hr.state='open'
           ${projectId !== undefined ? 'AND p.id=?' : ''}
         ORDER BY hr.created_at DESC
      `).all(...(projectId !== undefined ? [projectId] : [])));
      return respondJson(res, 200, { requests, count: requests.length });
    } catch (e) {
      // Pre-schema DB (no human_requests table): empty, not a 500.
      return respondJson(res, 200, { requests: [], count: 0, note: e.message });
    }
  }

  // Operator answer to a worker question. Mirrors handleWorkerAskDone's CAS
  // (state='open' → 'answered', needs-human tag clear) with the OPERATOR as
  // the answering identity — a fresh worker reads the question and this
  // answer from human_requests on its next lease.
  function handleHumanRequestAnswer(req, res) {
    readJsonRequest(req, fields => {
      const requestId = typeof fields.request_id === 'string' ? fields.request_id : '';
      const answer = typeof fields.answer === 'string' ? fields.answer.trim() : '';
      const actorId = typeof fields.actor_id === 'string' && fields.actor_id.trim().length > 0
        ? fields.actor_id.trim()
        : 'tracker-operator';
      if (!requestId) {
        return respondJson(res, 400, { ok: false, error: 'request_id is required' });
      }
      if (answer.length === 0) {
        return respondJson(res, 400, { ok: false, error: 'answer text is required' });
      }
      try {
        const result = withDbWrite(db => {
          const row = db.prepare(
            `SELECT task_id FROM human_requests WHERE request_id=?`,
          ).get(requestId);
          if (!row) {
            throw new Error('HUMAN_REQUEST_NOT_FOUND');
          }
          const info = db.prepare(
            `UPDATE human_requests
                SET state='answered', answer=?, answered_by=?,
                    answered_at=datetime('now'), updated_at=datetime('now')
              WHERE request_id=? AND state='open'`,
          ).run(answer, actorId, requestId);
          if (info.changes !== 1) {
            throw new Error('HUMAN_REQUEST_ALREADY_ANSWERED');
          }
          // Clear the needs-human kanban visual (same as the worker path).
          const task = db.prepare('SELECT id, tags FROM tasks WHERE id=?').get(row.task_id);
          if (task) {
            let tags = [];
            try { tags = JSON.parse(task.tags || '[]'); } catch {}
            if (tags.includes('needs-human')) {
              db.prepare(`UPDATE tasks SET tags=?, updated_at=datetime('now') WHERE id=?`)
                .run(JSON.stringify(tags.filter(tag => tag !== 'needs-human')), task.id);
            }
          }
          db.prepare(
            `INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)`,
          ).run(row.task_id, actorId, `OPERATOR ANSWER: ${answer}`);
          return { request_id: requestId, task_id: row.task_id, state: 'answered' };
        });
        return respondJson(res, 200, { ok: true, ...result });
      } catch (e) {
        const code = String(e.message) === 'HUMAN_REQUEST_NOT_FOUND' ? 404
          : String(e.message) === 'HUMAN_REQUEST_ALREADY_ANSWERED' ? 409 : 500;
        return respondJson(res, code, { ok: false, error: e.message });
      }
    });
  }

  return {
    handleHumanGatesList,
    handleHumanGateResolve,
    handleHumanRequestsList,
    handleHumanRequestAnswer,
  };
}
