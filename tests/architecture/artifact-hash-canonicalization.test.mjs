// tests/architecture/artifact-hash-canonicalization.test.mjs
//
// SERVER-SIDE CANONICALIZATION OF ARTIFACT CONTENT HASHES.
//
// Found live on another machine's formalization run (2026-08-20, qwen worker,
// task 7): the worker could not produce a canonical SHA-256 of its artifact
// content, so it FABRICATED one (first 32 hex of a known md5 padded to 64
// chars — passes any [a-f0-9]{64} regex) and the factory accepted it:
// artifact_create/update trust `args.content_hash` verbatim whenever the
// artifact file does not resolve on disk. The worker then panic-looped for
// 12+ minutes against an unattributed `artifact 15 has no canonical SHA-256
// content hash` (no repair recipe), superseding its own artifacts one by one
// while its context bloated to 99k tokens.
//
// THE PRINCIPLE (already honored by product_submit and pinned by
// tests/infrastructure/product-repository.test.mjs: "internal canonicalization
// — no caller-supplied digest"): a worker must NEVER be asked to compute a
// representation the server can canonicalize itself. The factory receives the
// artifact FILE; it hashes the file from disk; a worker-supplied digest is
// either redundant (the server re-hashes anyway) or fabricated (the live
// defect).
//
// The contract under test:
//   1. A resolvable file → the SERVER hash wins; the caller-supplied value is
//      ignored even when it differs.
//   2. An unresolvable file + a caller-supplied digest → REJECTED typed with a
//      repair recipe (never trusted, never stored).
//   3. A malformed digest → REJECTED typed at intake.
//   4. The downstream analysis error names the repair path, not just the id.
//
// The checklists already teach the designed flow ("If content_hash is NULL
// after artifact_create, the file was not found — STOP and fix"): the
// worker-supplied fallback was never part of the protocol.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'saga-artifact-hash-'));
process.env.DB_PATH = join(temp, 'ah.db');

const { closeDb, getDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/artifacts.js');

// The managed-execution fence the artifact handlers ride on (the same idiom
// as tests/app/operator-soft-stop.test.mjs): a running worker_executions row,
// a task carrying the managed metadata, and the env triple.
process.env.SAGA_MANAGED_EXECUTION = '1';
process.env.SAGA_EXECUTION_ID = 'exec-artifact-hash';
process.env.SAGA_TASK_ID = '9001';

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// The live fabrication shape: 32 hex of a real digest padded to 64 chars —
// passes any [a-f0-9]{64} format check, is not the hash of anything.
const FABRICATED = sha256(Buffer.from('password01')).slice(0, 32) + '0'.repeat(32);

const repoDir = join(temp, 'repo');

test.before(() => {
  const db = getDb();
  db.prepare("INSERT INTO projects (name) VALUES ('artifact-hash')").run();
  db.prepare("INSERT INTO epics (project_id, name) VALUES (1, 'e')").run();
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, task_kind, workflow_stage, execution_mode,
                        tags, metadata, current_execution_id)
     VALUES (9001, 1, 'artifact-hash card', 'in_progress', 'formalization.author', 'formalization',
             'git_change', '[]', ?, 'exec-artifact-hash')`,
  ).run(JSON.stringify({
    process_run_id: 9001,
    process_node_id: 'author-node',
    process_module_ref: 'formalization@1.0.0',
    process_input_hash: 'a'.repeat(64),
    work_intent_id: 9001,
  }));
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
        state, phase)
     VALUES ('exec-artifact-hash', 'r', 1, 1, 9001, 'w', 'm', 'running', 'executing')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_work_intents
       (id, epic_id, kind, objective, authority_scope, output_schema,
        token_budget, retry_budget, projected_task_id, status)
     VALUES (9001, 1, 'formalization', 'artifact hash test', '{}',
             'factory.formalization.v1', 0, 0, 9001, 'executing')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (9001,1,1,'formalization','1.0.0','formalization@1.0.0','test-process:9001',
             'generic-flow','test.input.v1','{}',?,'running')`,
  ).run('a'.repeat(64));
  mkdirSync(join(repoDir, 'docs'), { recursive: true });
  db.prepare("INSERT INTO repositories (name) VALUES ('r')").run();
  db.prepare(
    `INSERT INTO project_repositories (project_id, repository_id, local_path, integration_branch)
     VALUES (1, 1, ?, 'main')`,
  ).run(repoDir);
});

function artifactByCode(db, code) {
  return db.prepare('SELECT id, content_hash, status FROM artifacts WHERE code=?').get(code);
}

test('RED: a resolvable file — the SERVER hash wins over any caller-supplied digest', () => {
  const db = getDb();
  writeFileSync(join(repoDir, 'docs', 'prd.md'), 'the product content');
  handlers.artifact_create({
    project_id: 1,
    epic_id: 1,
    type: 'PRD',
    code: 'PRD-1',
    title: 'Product brief',
    path: 'docs/prd.md',
    status: 'accepted',
    project_repository_id: 1,
    // A WRONG caller-supplied digest: must be ignored — the row must hold
    // the sha256 of the file bytes.
    content_hash: FABRICATED,
  });
  const row = artifactByCode(db, 'PRD-1');
  assert.ok(row, 'artifact created');
  assert.equal(row.content_hash, sha256(Buffer.from('the product content')),
    'the server-computed digest of the file must win over the caller-supplied value');
});

test('RED: an unresolvable file + a caller-supplied digest is REJECTED typed with a repair recipe', () => {
  const db = getDb();
  assert.throws(
    () => handlers.artifact_create({
      project_id: 1,
      epic_id: 1,
      type: 'FR',
      code: 'FR-1',
      title: 'Functional requirement',
      path: 'docs/does-not-exist.md',
      status: 'draft',
      project_repository_id: 1,
      content_hash: FABRICATED,
    }),
    err => err instanceof Error
      && /ARTIFACT_CONTENT_HASH_UNVERIFIABLE/.test(err.message)
      && /from disk|without content_hash|file/i.test(err.message),
    'the fabricated digest must never be stored; the error must teach the exit (the factory hashes the file itself)',
  );
  assert.equal(artifactByCode(db, 'FR-1'), undefined,
    'nothing was persisted from the rejected call');
});

test('RED: artifact_update with an unresolvable file + a caller digest is REJECTED the same way', () => {
  const db = getDb();
  // A hashless artifact created via the designed path (file absent → null).
  handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'NFR', code: 'NFR-1',
    title: 'Non-functional', path: 'docs/nfr.md', status: 'draft',
    project_repository_id: 1,
  });
  const row = artifactByCode(db, 'NFR-1');
  assert.ok(row && row.content_hash === null,
    'precondition: the designed path leaves content_hash null when no file resolves');
  assert.throws(
    () => handlers.artifact_update({ id: row.id, content_hash: FABRICATED, status: 'accepted' }),
    /ARTIFACT_CONTENT_HASH_UNVERIFIABLE/,
    'the update path must not launder a fabricated digest into an accepted artifact either',
  );
});

test('RED: a malformed digest is rejected typed at intake (not silently stored)', () => {
  assert.throws(
    () => handlers.artifact_create({
      project_id: 1, epic_id: 1, type: 'RULE', code: 'RULE-1',
      title: 'Rule', path: 'docs/rule.md', status: 'draft',
      project_repository_id: 1,
      content_hash: 'not-a-sha256',
    }),
    /ARTIFACT_CONTENT_HASH_INVALID/,
    'format is checked at intake — a malformed digest fails loudly, not at analysis time',
  );
});

test('RED: the analysis error names the repair path, not just the artifact id', async () => {
  const db = getDb();
  // Seed a hashless artifact row directly (the legacy shape the analysis trips on).
  db.prepare(
    `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status, tags, metadata)
     VALUES (1, 1, 'AC', 'AC-99', 'Orphan', 'docs/orphan.md', 'accepted', '[]', '{}')`,
  ).run();
  const { buildContractSnapshot } = await import(
    '../../dist/modules/formalization/application/formalization-contract-analysis.js'
  );
  const artifacts = db.prepare(
    "SELECT id, type, code, status, content_hash AS contentHash FROM artifacts WHERE code='AC-99'",
  ).all().map(a => ({ ...a, content: null }));
  const graph = {
    readOutgoingArtifactTraces: () => [],
    readArtifactsByIds: () => [],
  };
  assert.throws(
    () => buildContractSnapshot(graph, artifacts),
    err => err instanceof Error
      && /no canonical SHA-256/.test(err.message)
      && /artifact_update|from disk|re-run/i.test(err.message),
    'the error must carry the repair recipe (re-run artifact_update so the factory re-hashes from disk)',
  );
});
