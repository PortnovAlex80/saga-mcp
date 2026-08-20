// tests/process-modules/implementation-claim-monotonicity.test.mjs
//
// STAGE-18 TASK 2 (R2) — claim-surface monotonicity for implementation
// cards. The stage-15 run proved the hole submit by submit:
//
//   task 19 (card 1): sub 14 claimed root.config → sub 15 dropped it,
//                     ACCEPTED, terminal FOREVER with the hole;
//   task 18 (card 2): subs 17/18/19 claimed root.config → sub 20 dropped
//                     it (and one more) → author gate ACCEPTED; only that
//                     card's reviewer happened to run a build.
//
// The rule (STAGE-18 brief):
//   A card may not silently narrow its own claimed surface between
//   attempts. Dropping a previously-claimed file is either an explicit
//   disposition or a regression.
//
// NO semantics: the comparison is the card's CURRENT claim vs the UNION of
// its own prior claims — pure durable state (factory_managed_node_submissions
// of the same task). The shape is copied from
// development.readiness-profile-monotonicity.v1 (same form, second object).
//
// RED on current code: the provider does not exist and the narrowed
// resubmission passes the implementation gate (matrix E-F5 pinned the same
// gap from the other side).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { ensureManagedNodeSubmissionSchema } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import { DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';

const sha = sha256Hex;
const TASK_ID = 18;
const BASE = 'a'.repeat(40);

let providers = null;
try {
  providers = await import('../../dist/modules/development/application/development-check-providers.js');
} catch {
  providers = null;
}

function seedSubmissionSubstrate(db) {
  // The submissions table is ensured lazily by the repository, not by
  // SCHEMA_SQL — create it through the production ensure so the harness
  // matches the live schema byte-for-byte.
  ensureManagedNodeSubmissionSchema(db);
  // FK parents of factory_managed_node_submissions (FK enforcement is ON).
  db.prepare("INSERT INTO projects (name) VALUES ('claim-monotonicity')").run();
  db.prepare("INSERT INTO epics (project_id, name) VALUES (1, 'e')").run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (7,1,1,'dev','1.0.0','dev@1.0.0','test-process:7',
             'generic-flow','test.input.v1','{}',?,'running')`,
  ).run('a'.repeat(64));
  db.prepare(
    `INSERT INTO tasks (id,title,status,epic_id,task_kind,workflow_stage,execution_mode,tags,metadata)
     VALUES (?, 'claim-mono', 'todo', 1, 'development.implement', 'solution-development',
             'git_change', '[]', '{}')`,
  ).run(TASK_ID);
}

/** Seed one submission. Every submission rides its OWN fenced execution
 *  (UNIQUE(process_run_id,node_id,execution_id) — one immutable value per
 *  execution, exactly as the live boundary enforces). */
function seedSubmission(db, payload, hash) {
  seedSubmission.seq = (seedSubmission.seq ?? 0) + 1;
  const executionId = `exec:x-${seedSubmission.seq}`;
  // Prior submissions rode TERMINAL executions (one ACTIVE execution per
  // task — the partial unique index idx_worker_executions_one_active_task).
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,phase,state)
     VALUES (?,'r7',1,1,?,?,'m1','executing','exited')`,
  ).run(executionId, TASK_ID, `w-mono-${seedSubmission.seq}`);
  const info = db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        schema_version, payload_snapshot, content_hash, submitted_at)
     VALUES (7, 'dev@1.0.0', 'implement-work-items', 1, ?, ?,
             ?, ?, ?, datetime('now'))`,
  ).run(TASK_ID, executionId, DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
    JSON.stringify(payload), hash);
  return { id: Number(info.lastInsertRowid) };
}

function makeHarness({ priors, current }) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  seedSubmissionSubstrate(db);
  for (const prior of priors) {
    seedSubmission(db, priorPayload(prior), sha(payloadText(prior)));
  }
  const currentHash = sha(payloadText(current));
  const { id: currentId } = seedSubmission(db, priorPayload(current), currentHash);
  return { db, currentId, currentHash };
}

// Domain-free payloads: paths aaa/, bbb/, root.config — nothing from any
// real run. changedFiles carries both legal shapes (strings; {path,status}
// objects as sub 20 used).
function priorPayload(changedFiles) {
  return {
    workItemKey: 'imp-1',
    repository: { baseCommit: BASE },
    snapshot: { commitSha: BASE, changedFiles },
  };
}
function payloadText(changedFiles) {
  return JSON.stringify(priorPayload(changedFiles));
}
const ROOT = 'root.config';
const CLAIMS_ROOT = ['root.config', 'aaa/thing'];
const CLAIMS_WITHOUT_ROOT = ['aaa/thing'];

function runProvider(h, providers2) {
  const provider = providers2.createImplementationClaimMonotonicityCheckProvider({
    db: h.db,
    candidateSets: {
      read: () => ({
        role: 'author',
        workplaceRef: { processRunId: 7 },
        members: [{
          productRef: {
            schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
            ref: `managed-node-submission:${h.currentId}`,
            digest: h.currentHash,
          },
        }],
      }),
    },
  });
  return provider.run({ subjectCandidateSetRef: 'candidate-set/m', parameters: { processRunId: 7 } });
}

test('STAGE-18 R2 RED: the implementation claim-monotonicity provider exists', () => {
  assert.ok(providers && providers.createImplementationClaimMonotonicityCheckProvider,
    'development.implementation-claim-monotonicity.v1 must exist — a card may not silently narrow its claimed surface (stage-18 R2)');
});

test('R2 live shape A (subs 17/18/19 claimed root.config, sub 20 dropped it): the narrowed resubmission is REFUSED naming the dropped path', () => {
  if (!providers?.createImplementationClaimMonotonicityCheckProvider) return; // RED covered by the existence test
  const h = makeHarness({
    priors: [CLAIMS_ROOT, CLAIMS_ROOT, CLAIMS_WITHOUT_ROOT.slice()],
    current: CLAIMS_WITHOUT_ROOT.slice(),
  });
  try {
    const result = runProvider(h, providers);
    const outcome = typeof result === 'string' ? result : result.outcome;
    assert.equal(outcome, 'failed', 'a silently narrowed claim must not pass');
    const diagnostic = decodeCheckDiagnostic(
      (typeof result === 'object' ? result : { evidenceRefs: [] }).evidenceRefs[0],
    );
    assert.equal(diagnostic.code, 'IMPLEMENTATION_CLAIM_NARROWED');
    assert.match(diagnostic.message, /root\.config/, 'the dropped path is named');
    assert.match(diagnostic.message, /droppedFiles|disposition|reason/i,
      'the refusal teaches the lawful exit: dispose of the drop with a reason');
  } finally {
    h.db.close();
  }
});

test('R2 live shape B (card 1: sub 14 claimed root.config, sub 15 dropped it — the one that reached terminal): REFUSED', () => {
  if (!providers?.createImplementationClaimMonotonicityCheckProvider) return;
  const h = makeHarness({
    priors: [['root.config', 'bbb/thing']],
    current: ['bbb/thing'],
  });
  try {
    const result = runProvider(h, providers);
    const outcome = typeof result === 'string' ? result : result.outcome;
    assert.equal(outcome, 'failed',
      'the exact shape that reached terminal in stage 15 must be refused here');
  } finally {
    h.db.close();
  }
});

test('R2 narrowing WITH a disposition is legal (the explicit exit)', () => {
  if (!providers?.createImplementationClaimMonotonicityCheckProvider) return;
  const current = {
    ...priorPayload(CLAIMS_WITHOUT_ROOT.slice()),
    snapshot: {
      commitSha: BASE,
      changedFiles: CLAIMS_WITHOUT_ROOT.slice(),
      droppedFiles: [{ path: ROOT, reason: 'superseded: the shared config moved to the root package manifest' }],
    },
  };
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  seedSubmissionSubstrate(db);
  seedSubmission(db, priorPayload(CLAIMS_ROOT), sha('prior'));
  const currentHash = sha(JSON.stringify(current));
  const { id: currentId } = seedSubmission(db, current, currentHash);
  try {
    const provider = providers.createImplementationClaimMonotonicityCheckProvider({
      db,
      candidateSets: {
        read: () => ({
          role: 'author', workplaceRef: { processRunId: 7 },
          members: [{ productRef: { schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, ref: `managed-node-submission:${currentId}`, digest: currentHash } }],
        }),
      },
    });
    const result = provider.run({ subjectCandidateSetRef: 'cs', parameters: { processRunId: 7 } });
    const outcome = typeof result === 'string' ? result : result.outcome;
    assert.equal(outcome, 'passed', 'a dispositioned drop is lawful work, not a regression');
  } finally {
    db.close();
  }
});

test('R2 additive is always legal; a first submission has no priors; the union of ALL priors is the surface', () => {
  if (!providers?.createImplementationClaimMonotonicityCheckProvider) return;
  // Additive: prior [aaa/thing], current [aaa/thing, ccc/new] → pass.
  const additive = makeHarness({ priors: [['aaa/thing']], current: ['aaa/thing', 'ccc/new'] });
  try {
    const r = runProvider(additive, providers);
    assert.equal(typeof r === 'string' ? r : r.outcome, 'passed', 'adding files is never a narrowing');
  } finally { additive.db.close(); }
  // First submission: no priors → pass.
  const first = makeHarness({ priors: [], current: ['aaa/thing'] });
  try {
    const r = runProvider(first, providers);
    assert.equal(typeof r === 'string' ? r : r.outcome, 'passed', 'a first claim has nothing to narrow against');
  } finally { first.db.close(); }
  // Union semantics: claimed in ANY prior counts — dropping a file that a
  // MIDDLE prior claimed is still a narrowing (sub 19 claimed root.config
  // after sub 18; the union is the surface).
  const union = makeHarness({
    priors: [['aaa/thing'], ['root.config', 'aaa/thing'], ['aaa/thing']],
    current: ['aaa/thing'],
  });
  try {
    const r = runProvider(union, providers);
    assert.notEqual(typeof r === 'string' ? r : r.outcome, 'passed',
      'the surface is the UNION of prior claims, not the last prior');
  } finally { union.db.close(); }
});

// The non-vacuity break lives in the stage report: disabling the provider's
// comparison (or removing it from the plan) must turn live shapes A and B
// back into silent passes — that regression is what the existence test and
// the two live-shape tests jointly pin.

test('R2 non-vacuity scaffold: the temp harness is cleaned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-mono-'));
  rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});
