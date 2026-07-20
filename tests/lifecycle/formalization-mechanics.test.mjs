// Slice 5 of formalization-mechanics fix — now updated for ADR-013
// (pipeline-reorder-srs-after-ac).
//
// Pins the ADR-013 transition chain end-to-end:
//   kickstart → brief_accepted → PRD
//   PRD       → prd_accepted   → UC   (UC ONLY, no parallel SRS)
//   UC        → uc_accepted    → AC   (no SRS sibling gate)
//   AC        → ac_accepted    → reconciliation
//   reconcile → baseline_accepted → SRS (NEW — SRS now post-AC)
//   SRS       → srs_accepted   → planning.decomposition (NEW transition)
//
// Also covers the structural invariants that originally stranded epic 128:
//   (1) every formalization task_kind is tracker_only — no integration_state gate
//   (2) formalization→planning gate calls assertTasksReady('formalization')

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

// ===========================================================================
// ADR-013 (pipeline-reorder-srs-after-ac) — the canonical transition chain.
//
//   kickstart → brief_accepted → formalization.prd
//   prd       → prd_accepted   → formalization.uc      (UC only, not SRS+UC)
//   uc        → uc_accepted    → formalization.ac      (no SRS sibling gate)
//   ac        → ac_accepted    → formalization.reconciliation
//   reconcile → baseline_accepted → formalization.srs  (SRS POST-baseline, NEW)
//   srs       → srs_accepted   → planning.decomposition (NEW transition)
//
// Tests below pin each rung of this ladder. Earlier tests covered the legacy
// "SRS spawns in parallel from PRD, AC waits for both siblings" chain — that
// chain is intentionally retired by ADR-013 (see
// docs/architecture/decisions/013-pipeline-reorder-srs-after-ac.md).
// ===========================================================================

// ---------------------------------------------------------------------------
// Test 1: prd_accepted spawns EXACTLY ONE formalization.uc, no SRS.
// (Regression for ADR-013: PRD used to spawn SRS+UC in parallel.)
// ---------------------------------------------------------------------------

test('workflow: prd_accepted spawns ONLY formalization.uc (not SRS+UC)', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: prd-accepted-only' });

  const result = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  // ADR-013 contract: PRD emits EXACTLY ONE downstream — UC.
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.tasks.map(t => t.task_kind), ['formalization.uc']);
  // No SRS must appear — SRS now lives AFTER baseline (baseline_accepted).
  assert.ok(!result.tasks.some(t => t.task_kind === 'formalization.srs'),
    'SRS must NOT be spawned by prd_accepted under ADR-013');
  assert.equal(result.tasks[0].execution_skill, 'saga-analyst');
  assert.equal(result.tasks[0].review_skill, 'saga-requirements-reviewer');
  assert.equal(result.tasks[0].execution_mode, 'tracker_only');
  assert.equal(result.tasks[0].generated_from_task_id, prd.id);
  // Idempotency: re-running returns the same UC, created=0.
  const again = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  assert.equal(again.created.length, 0);
  assert.deepEqual(again.reused, result.created);
});

// ---------------------------------------------------------------------------
// Test 2: uc_accepted spawns formalization.ac with deps on UC only.
// (ADR-013: AC no longer waits for a parallel SRS sibling — UC is the only
// precondition. The legacy "deps on SRS+UC" is gone.)
// ---------------------------------------------------------------------------

test('workflow: uc_accepted spawns formalization.ac with deps on UC only', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: uc-to-ac' });
  const ucOnly = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const uc = ucOnly.tasks.find(t => t.task_kind === 'formalization.uc');
  assert.ok(uc, 'prd_accepted must seed UC so uc_accepted can fire');
  setStatus(uc.id, 'done');

  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  assert.equal(ac.created.length, 1);
  assert.equal(ac.tasks[0].task_kind, 'formalization.ac');
  assert.equal(ac.tasks[0].execution_skill, 'saga-analyst');
  assert.equal(ac.tasks[0].execution_mode, 'tracker_only');

  // AC deps must include the source UC. SRS MUST NOT appear — SRS does not
  // exist yet (it is created downstream by baseline_accepted).
  const deps = tasks.task_get({ id: ac.tasks[0].id }).depends_on.map(d => d.id);
  assert.ok(deps.includes(uc.id), 'AC must depend on its source UC');
  assert.ok(!deps.some(id => {
    const t = tasks.task_get({ id });
    return t.task_kind === 'formalization.srs';
  }), 'AC must NOT depend on SRS (SRS is post-baseline under ADR-013)');
});

// ---------------------------------------------------------------------------
// Test 3: ac_accepted → formalization.reconciliation.
// (ADR-013: reconciliation NO LONGER depends on SRS — SRS is created after
// the AC baseline is frozen. The reconciliation task itself runs before SRS.)
// ---------------------------------------------------------------------------

test('workflow: ac_accepted spawns formalization.reconciliation', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: ac-to-recon' });
  const ucOnly = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const uc = ucOnly.tasks.find(t => t.task_kind === 'formalization.uc');
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

  // Reconciliation deps MUST include BOTH source AC AND the upstream UC
  // (UC is the direct parent of AC under ADR-013; reconciliation needs UC
  // done so it can verify UC↔AC traceability). SRS MUST NOT be a dep — SRS
  // does not exist yet (it is spawned downstream by baseline_accepted).
  // Regression: previously `ac_accepted` used source.generated_from_task_id
  // as the PRD id, but after the reorder that field points to UC, not PRD.
  // The sibling() lookup then searched for a UC whose parent was the UC id
  // (impossible) and silently dropped the UC dep. This assertion locks the
  // correct behaviour in.
  const deps = tasks.task_get({ id: recon.tasks[0].id }).depends_on.map(d => d.id);
  assert.ok(deps.includes(ac.tasks[0].id),
    'reconciliation must depend on its source AC');
  assert.ok(deps.includes(uc.id),
    'reconciliation must depend on the upstream UC (regression: was dropped when AC.generated_from_task_id pointed to UC, not PRD)');
  assert.ok(!deps.some(id => {
    const t = tasks.task_get({ id });
    return t.task_kind === 'formalization.srs';
  }), 'reconciliation must NOT depend on SRS (SRS is post-baseline under ADR-013)');
});

// ---------------------------------------------------------------------------
// Test 3b: baseline_accepted → formalization.srs (NEW post-AC SRS).
// (ADR-013: SRS is created AFTER the AC baseline is frozen. baseline_accepted
// is fired by the reconciliation task and spawns the architect.)
// ---------------------------------------------------------------------------

test('workflow: baseline_accepted spawns formalization.srs (post-AC)', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: baseline-to-srs' });
  const ucOnly = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const uc = ucOnly.tasks.find(t => t.task_kind === 'formalization.uc');
  setStatus(uc.id, 'done');
  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  setStatus(ac.tasks[0].id, 'done');
  const recon = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: ac.tasks[0].id, transition: 'ac_accepted',
  });
  setStatus(recon.tasks[0].id, 'done');

  const srsResult = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: recon.tasks[0].id, transition: 'baseline_accepted',
  });
  assert.equal(srsResult.created.length, 1);
  assert.equal(srsResult.tasks[0].task_kind, 'formalization.srs');
  assert.equal(srsResult.tasks[0].execution_skill, 'saga-architect');
  assert.equal(srsResult.tasks[0].review_skill, 'saga-architecture-reviewer');
  assert.equal(srsResult.tasks[0].execution_mode, 'tracker_only');
  assert.equal(srsResult.tasks[0].workflow_stage, 'formalization',
    'SRS stays in formalization so the formalization→planning gate waits for it');
  assert.equal(srsResult.tasks[0].generated_from_task_id, recon.tasks[0].id);
});

// ---------------------------------------------------------------------------
// Test 3c: srs_accepted → planning.decomposition (NEW transition).
// (ADR-013: SRS is the LAST formalization deliverable. Once the architecture
// reviewer accepts it, the planner can run as a dumb §D copier.)
// ---------------------------------------------------------------------------

test('workflow: srs_accepted spawns planning.decomposition', () => {
  const epic = makeEpic();
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: srs-to-planning' });
  const ucOnly = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const uc = ucOnly.tasks.find(t => t.task_kind === 'formalization.uc');
  setStatus(uc.id, 'done');
  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  setStatus(ac.tasks[0].id, 'done');
  const recon = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: ac.tasks[0].id, transition: 'ac_accepted',
  });
  setStatus(recon.tasks[0].id, 'done');
  const srs = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: recon.tasks[0].id, transition: 'baseline_accepted',
  });
  setStatus(srs.tasks[0].id, 'done');

  const plan = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: srs.tasks[0].id, transition: 'srs_accepted',
  });
  assert.equal(plan.created.length, 1);
  assert.equal(plan.tasks[0].task_kind, 'planning.decomposition');
  assert.equal(plan.tasks[0].execution_skill, 'saga-planner');
  assert.equal(plan.tasks[0].execution_mode, 'tracker_only');
  assert.equal(plan.tasks[0].workflow_stage, 'planning');
  assert.equal(plan.tasks[0].generated_from_task_id, srs.tasks[0].id);
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

  // Simulate a complete ADR-013 formalization pipeline at the task level.
  //   PRD → UC → AC → reconciliation → SRS (post-baseline)
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: success', task_kind: 'formalization.prd' });
  const ucOnly = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  const uc = ucOnly.tasks.find(t => t.task_kind === 'formalization.uc');
  setStatus(uc.id, 'done');
  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  setStatus(ac.tasks[0].id, 'done');
  const recon = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: ac.tasks[0].id, transition: 'ac_accepted',
  });
  setStatus(recon.tasks[0].id, 'done');
  const srs = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: recon.tasks[0].id, transition: 'baseline_accepted',
  });
  setStatus(srs.tasks[0].id, 'done');

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
  // Walk the full ADR-013 chain and assert each emitted task is tracker_only.
  // Regression: prior code used 'git_change', stranding downstream tasks
  // because dependency-checker requires integration_state='merged'.
  const checks = [];

  const ucOnly = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  for (const t of ucOnly.tasks) {
    assert.equal(t.execution_mode, 'tracker_only',
      `${t.task_kind} must be tracker_only — formalization artifacts are markdown, not git-delivered code`);
    checks.push(t.task_kind);
  }
  const uc = ucOnly.tasks.find(t => t.task_kind === 'formalization.uc');
  setStatus(uc.id, 'done');

  const ac = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: uc.id, transition: 'uc_accepted',
  });
  for (const t of ac.tasks) {
    assert.equal(t.execution_mode, 'tracker_only', 'formalization.ac must be tracker_only');
    checks.push(t.task_kind);
  }
  setStatus(ac.tasks[0].id, 'done');

  const recon = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: ac.tasks[0].id, transition: 'ac_accepted',
  });
  for (const t of recon.tasks) {
    assert.equal(t.execution_mode, 'tracker_only', 'formalization.reconciliation must be tracker_only');
    checks.push(t.task_kind);
  }
  setStatus(recon.tasks[0].id, 'done');

  const srs = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: recon.tasks[0].id, transition: 'baseline_accepted',
  });
  for (const t of srs.tasks) {
    assert.equal(t.execution_mode, 'tracker_only', 'formalization.srs must be tracker_only');
    checks.push(t.task_kind);
  }
  // Sanity: every ADR-013 formalization task_kind appeared in the chain.
  assert.ok(checks.includes('formalization.uc'));
  assert.ok(checks.includes('formalization.ac'));
  assert.ok(checks.includes('formalization.reconciliation'));
  assert.ok(checks.includes('formalization.srs'));
});

// ---------------------------------------------------------------------------
// Test 7: tracker_only downstream tasks unblock on parent 'done' alone —
//         no integration_state='merged' requirement.
//         (ADR-013: PRD now seeds only UC; the same tracker_only guarantee
//         must hold — UC must be 'todo' immediately, never 'blocked' on a
//         pending git merge of the PRD.)
// ---------------------------------------------------------------------------

test('tracker_only: UC unblocks on PRD done without git merge', () => {
  const epic = makeEpic();
  // Create PRD already done (simulating saga-product worker completed it).
  const prd = makeDoneTask({ epic_id: epic, title: 'PRD: dep-test' });
  // Generate UC — it should be status='todo' (not 'blocked'), because its
  // only dep is the PRD, satisfied by PRD done alone (tracker_only parent).
  const ucOnly = workflow.workflow_generate_next({
    epic_id: epic, source_task_id: prd.id, transition: 'prd_accepted',
  });
  for (const t of ucOnly.tasks) {
    assert.equal(t.status, 'todo',
      `${t.task_kind} must be 'todo' not 'blocked' — tracker_only parents don't require git merge`);
  }
  assert.ok(ucOnly.tasks.some(t => t.task_kind === 'formalization.uc'));
});
