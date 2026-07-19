// Slice 5 of formalization-mechanics fix.
//
// Covers the three structural defects that stranded epic 128:
//   (1) formalization.ac transition now exists (workflow.ts)
//   (2) formalization tasks are tracker_only — no integration_state gate
//   (3) formalization→planning gate now calls assertTasksReady('formalization')
//
// Plus regression: every formalization task_kind has execution_mode='tracker_only'.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-form-mech-'));
process.env.DB_PATH = path.join(temp, 'form-mech.db');

const { handlers: projects } = await import('../../dist/tools/projects.js');
const { handlers: epics } = await import('../../dist/tools/epics.js');
const { handlers: tasks } = await import('../../dist/tools/tasks.js');
const { handlers: workflow } = await import('../../dist/tools/workflow.js');
const { handlers: lifecycle } = await import('../../dist/tools/lifecycle.js');
const { handlers: artifacts } = await import('../../dist/tools/artifacts.js');
const { closeDb, getDb } = await import('../../dist/db.js');

let product, repo;

before(() => {
  product = projects.project_create({ name: 'Formalization Mechanics' });
  // workflow.specsForTransition reads repo from source.project_repository_id.
  // We don't actually write files in this suite, so a synthetic repo row suffices.
  repo = null;
});

after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function makeEpic(name = 'REQ-form-mech') {
  return epics.epic_create({ project_id: product.id, name }).id;
}

function makeDoneTask(overrides) {
  const epicId = overrides.epic_id ?? makeEpic();
  return tasks.task_create({
    epic_id: epicId,
    title: overrides.title ?? 'PRD',
    status: 'done',
    priority: 'high',
    task_kind: overrides.task_kind ?? 'formalization.prd',
    workflow_stage: overrides.workflow_stage ?? 'formalization',
    execution_skill: overrides.execution_skill ?? 'saga-product',
    review_skill: overrides.review_skill ?? 'saga-requirements-reviewer',
    // tracker_only matches what workflow_generate_next emits for formalization
    // task_kinds (PRD/SRS/UC/AC/reconciliation). The slice-3 gate would reject
    // a git_change parent whose integration_state != 'merged' — not what we
    // want to test here.
    execution_mode: overrides.execution_mode ?? 'tracker_only',
    project_repository_id: overrides.project_repository_id ?? null,
    generated_from_task_id: overrides.generated_from_task_id ?? null,
  });
}

function setStatus(taskId, status) {
  process.env.SAGA_ALLOW_MANUAL_STATUS = '1';
  try {
    tasks.task_update({ id: taskId, status });
  } finally {
    delete process.env.SAGA_ALLOW_MANUAL_STATUS;
  }
}

// ---------------------------------------------------------------------------
// Test 1: srs_accepted with UC still pending → returns [] (AC must wait).
// ---------------------------------------------------------------------------

test('workflow: srs_accepted returns no tasks when UC sibling not done', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: wait-test' });
  const srs_uc = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const srs = srs_uc.tasks.find(t => t.task_kind === 'formalization.srs');
  setStatus(srs.id, 'done');
  const result = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: srs.id, transition: 'srs_accepted',
  });
  assert.equal(result.created.length, 0);
  assert.equal(result.tasks.length, 0);
});

// ---------------------------------------------------------------------------
// Test 2: uc_accepted with SRS done → spawns formalization.ac with deps on both.
// ---------------------------------------------------------------------------

test('workflow: uc_accepted spawns formalization.ac with deps on SRS+UC', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: ac-spawn-test' });
  const srs_uc = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const srs = srs_uc.tasks.find(t => t.task_kind === 'formalization.srs');
  const uc = srs_uc.tasks.find(t => t.task_kind === 'formalization.uc');
  setStatus(srs.id, 'done');
  setStatus(uc.id, 'done');

  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  assert.equal(ac.created.length, 1);
  assert.equal(ac.tasks[0].task_kind, 'formalization.ac');
  assert.equal(ac.tasks[0].execution_skill, 'saga-analyst');
  assert.equal(ac.tasks[0].execution_mode, 'tracker_only');

  // AC task deps must include BOTH siblings — without this, AC could start
  // before one of its preconditions (SRS or UC) is fully done.
  const deps = tasks.task_get({ id: ac.tasks[0].id }).depends_on.map(d => d.id).sort();
  assert.deepEqual(deps, [srs.id, uc.id].sort());
});

// ---------------------------------------------------------------------------
// Test 3: ac_accepted → reconciliation, not baseline_accepted.
// ---------------------------------------------------------------------------

test('workflow: ac_accepted spawns formalization.reconciliation', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: ac-to-recon' });
  const srs_uc = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const srs = srs_uc.tasks.find(t => t.task_kind === 'formalization.srs');
  const uc = srs_uc.tasks.find(t => t.task_kind === 'formalization.uc');
  setStatus(srs.id, 'done');
  setStatus(uc.id, 'done');
  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  setStatus(ac.tasks[0].id, 'done');

  const recon = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: ac.tasks[0].id, transition: 'ac_accepted',
  });
  assert.equal(recon.created.length, 1);
  assert.equal(recon.tasks[0].task_kind, 'formalization.reconciliation');
  assert.equal(recon.tasks[0].execution_mode, 'tracker_only');
});

// ---------------------------------------------------------------------------
// Test 4: episode_transition(formalization→planning) rejects when
//         formalization tasks not all done.
// ---------------------------------------------------------------------------

test('gate: formalization→planning rejects when formalization.prd not done', () => {
  const epic = makeEpic();
  // Seed episode_workflows with stage='formalization'.
  lifecycle.episode_transition({ epic_id: epic, to_stage: 'formalization' });
  // PRD still 'todo' — not done.
  tasks.task_create({
    epic_id: epic,
    title: 'PRD: gate-test',
    status: 'todo',
    priority: 'high',
    task_kind: 'formalization.prd',
    workflow_stage: 'formalization',
    execution_skill: 'saga-product',
    review_skill: 'saga-requirements-reviewer',
    execution_mode: 'tracker_only',
  });
  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /formalization gate failed: tasks not completed/i,
    'gate must reject when formalization.prd is still todo',
  );
});

// ---------------------------------------------------------------------------
// Test 5: episode_transition(formalization→planning) succeeds when
//         gateable formalization tasks are all done. (summary.stage and
//         recovery.heal are excluded — they should not block.)
// ---------------------------------------------------------------------------

test('gate: formalization→planning succeeds when gateable tasks done', () => {
  const epic = makeEpic();
  lifecycle.episode_transition({ epic_id: epic, to_stage: 'formalization' });

  // Simulate a complete formalization pipeline at the task level.
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: success', task_kind: 'formalization.prd' });
  const srs_uc = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  for (const t of srs_uc.tasks) setStatus(t.id, 'done');
  const uc = srs_uc.tasks.find(t => t.task_kind === 'formalization.uc');
  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  setStatus(ac.tasks[0].id, 'done');
  const recon = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: ac.tasks[0].id, transition: 'ac_accepted',
  });
  setStatus(recon.tasks[0].id, 'done');

  // Also add a summary.stage and a recovery.heal task — these MUST NOT
  // block the gate (they are bookkeeping, not deliverables).
  tasks.task_create({
    epic_id: epic, title: 'Summary', status: 'review', priority: 'high',
    task_kind: 'summary.stage', workflow_stage: 'formalization',
    execution_skill: 'saga-worker',
  });
  tasks.task_create({
    epic_id: epic, title: 'Recovery', status: 'review', priority: 'high',
    task_kind: 'recovery.heal', workflow_stage: 'formalization',
    execution_skill: 'saga-worker', execution_mode: 'tracker_only',
  });

  // To pass the gate we also need accepted AC artifacts with clean hashes
  // (acceptedBaseline) AND canonical lineage edges (assertTraceability).
  // Build a minimal pyramid: brief → PRD → SRS+FR+UC → AC, with traces.
  const brief = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'brief', code: 'BRIEF-1',
    title: 'Brief', path: `docs/test/brief-${epic}.md`, status: 'accepted',
    metadata: { brief_payload: {
      classification: 'tech-task', complexity: { tshirt: 'S', risk_triggers: [] },
      decision: 'go', reasoning: 'test', affected_projects: [product.id],
      topology_hint: 'sequence', scaffold_artifacts: [], shared_mutation_risk: false,
      completeness: 'high', degraded: false,
    } },
  });
  const prdArt = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'PRD', code: null,
    title: 'PRD', path: `docs/test/prd-${epic}.md`, status: 'accepted',
  });
  artifacts.trace_add({ source_id: prdArt.id, target_type: 'artifact', target_id: brief.id, link_type: 'derived_from' });
  const srsArt = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'SRS', code: 'SRS-1',
    title: 'SRS', path: `docs/test/srs-${epic}.md`, status: 'accepted',
  });
  artifacts.trace_add({ source_id: srsArt.id, target_type: 'artifact', target_id: prdArt.id, link_type: 'derived_from' });
  const frArt = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'FR', code: 'FR-1',
    title: 'FR', path: `docs/test/srs-${epic}.md#FR-1`, status: 'accepted',
  });
  const ucArt = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'UC', code: 'UC-1',
    title: 'UC', path: `docs/test/uc-${epic}.md#UC-1`, status: 'accepted',
  });
  artifacts.trace_add({ source_id: ucArt.id, target_type: 'artifact', target_id: prdArt.id, link_type: 'derived_from' });
  artifacts.trace_add({ source_id: ucArt.id, target_type: 'artifact', target_id: frArt.id, link_type: 'covers' });
  const acArtifact = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'AC', code: 'AC-1',
    title: 'Test AC', path: `docs/test/ac-${epic}.md#AC-1`, status: 'accepted',
  });
  artifacts.trace_add({ source_id: acArtifact.id, target_type: 'artifact', target_id: ucArt.id, link_type: 'derived_from' });
  artifacts.trace_add({ source_id: acArtifact.id, target_type: 'artifact', target_id: frArt.id, link_type: 'derived_from' });
  // Pin accepted_hash = content_hash to satisfy acceptedBaseline's clean check.
  const db = getDb();
  const hash = '0'.repeat(64);
  db.prepare(
    `UPDATE artifacts SET content_hash=?, accepted_hash=?, drift_state='clean' WHERE id=?`,
  ).run(hash, hash, acArtifact.id);

  assert.doesNotThrow(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    'gate must succeed when all gateable formalization tasks done + AC baseline accepted + traces complete',
  );
});

// ---------------------------------------------------------------------------
// Test 6: formalization task_specs always emit execution_mode='tracker_only'.
//         Regression: prior code used 'git_change', stranding downstream tasks
//         because dependency-checker requires integration_state='merged'.
// ---------------------------------------------------------------------------

test('regression: every formalization task spec has execution_mode=tracker_only', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: regression-scan' });
  const srs_uc = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  for (const t of srs_uc.tasks) {
    assert.equal(t.execution_mode, 'tracker_only',
      `${t.task_kind} must be tracker_only — formalization artifacts are markdown, not git-delivered code`);
  }
  for (const t of srs_uc.tasks) setStatus(t.id, 'done');
  const uc = srs_uc.tasks.find(t => t.task_kind === 'formalization.uc');
  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  for (const t of ac.tasks) {
    assert.equal(t.execution_mode, 'tracker_only', 'formalization.ac must be tracker_only');
  }
  setStatus(ac.tasks[0].id, 'done');
  const recon = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: ac.tasks[0].id, transition: 'ac_accepted',
  });
  for (const t of recon.tasks) {
    assert.equal(t.execution_mode, 'tracker_only', 'formalization.reconciliation must be tracker_only');
  }
});

// ---------------------------------------------------------------------------
// Test 7: tracker_only downstream tasks unblock on parent 'done' alone —
//         no integration_state='merged' requirement.
// ---------------------------------------------------------------------------

test('tracker_only: SRS unblocks on PRD done without git merge', () => {
  const epic = makeEpic();
  // Create PRD already done (simulating saga-product worker completed it).
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: dep-test' });
  // Generate SRS+UC — they should both be status='todo' (not 'blocked'),
  // because deps are satisfied by PRD done alone (tracker_only parent).
  const srs_uc = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  for (const t of srs_uc.tasks) {
    assert.equal(t.status, 'todo',
      `${t.task_kind} must be 'todo' not 'blocked' — tracker_only parents don't require git merge`);
  }
});
