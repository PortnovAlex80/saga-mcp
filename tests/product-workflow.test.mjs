import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { after } from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-product-workflow-'));
process.env.DB_PATH = path.join(temp, 'workflow.db');
const repoAPath = path.join(temp, 'repo-a');
const repoBPath = path.join(temp, 'repo-b');
mkdirSync(repoAPath);
mkdirSync(repoBPath);

const { handlers: projects } = await import('../dist/tools/projects.js');
const { handlers: epics } = await import('../dist/tools/epics.js');
const { handlers: tasks } = await import('../dist/tools/tasks.js');
const { handlers: repositories } = await import('../dist/tools/repositories.js');
const { handlers: workflow } = await import('../dist/tools/workflow.js');
const { handlers: dispatcher } = await import('../dist/tools/dispatcher.js');
const { handlers: exportImport } = await import('../dist/tools/export-import.js');
const { handlers: lifecycle } = await import('../dist/tools/lifecycle.js');
const { handlers: artifacts } = await import('../dist/tools/artifacts.js');
const { closeDb, getDb } = await import('../dist/db.js');

after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

test('one logical product registers multiple repositories idempotently', () => {
  const product = projects.project_create({ name: 'Workflow Product' });
  const a = repositories.repository_register({
    project_id: product.id, name: 'repo-a', local_path: repoAPath, role: 'control',
  });
  const b = repositories.repository_register({
    project_id: product.id, name: 'repo-b', local_path: repoBPath, role: 'backend',
  });
  const again = repositories.repository_register({
    project_id: product.id, name: 'repo-a', local_path: repoAPath, role: 'control',
  });
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.equal(again.created, false);
  assert.equal(again.id, a.id);
  repositories.repository_checkout_register({
    project_repository_id: a.id, machine_id: 'export-machine', local_path: repoAPath,
  });
  assert.equal(repositories.repository_list({ project_id: product.id }).count, 2);
});

test('planned repository can bootstrap an explicit machine checkout from git remote', () => {
  const source = path.join(temp, 'bootstrap-source');
  const remote = path.join(temp, 'bootstrap-remote.git');
  const destination = path.join(temp, 'bootstrap-destination');
  mkdirSync(source);
  execFileSync('git', ['init', '-b', 'main'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
  writeFileSync(path.join(source, 'README.md'), 'bootstrap');
  execFileSync('git', ['add', 'README.md'], { cwd: source });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: source });
  execFileSync('git', ['clone', '--bare', source, remote]);
  const product = projects.project_create({ name: 'Bootstrap Product' });
  const repo = repositories.repository_register({
    project_id: product.id, name: 'planned-repo', remote_url: remote,
    default_branch: 'main', status: 'planned',
  });
  const checkout = repositories.repository_checkout_bootstrap({
    project_repository_id: repo.id, machine_id: 'bootstrap-machine', local_path: destination,
  });
  assert.equal(checkout.status, 'active');
  assert.equal(path.resolve(checkout.local_path), path.resolve(destination));
});

test('machine checkout overrides legacy repository path during dispatch', () => {
  const product = projects.project_create({ name: 'Machine Checkout Product' });
  const repo = repositories.repository_register({
    project_id: product.id, name: 'machine-repo', local_path: repoAPath,
  });
  const machinePath = path.join(temp, 'machine-repo');
  mkdirSync(machinePath);
  repositories.repository_checkout_register({
    project_repository_id: repo.id, machine_id: 'builder-01', local_path: machinePath,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-machine' });
  tasks.task_create({
    epic_id: epic.id, title: 'Machine task', priority: 'critical',
    project_repository_id: repo.id,
  });
  const assignment = dispatcher.worker_next({
    project_id: product.id, worker_id: 'machine-worker', machine_id: 'builder-01',
  });
  assert.equal(assignment.repository.local_path, path.resolve(machinePath));
});

test('typed PRD generates SRS and UC exactly once and preserves lineage', () => {
  const product = projects.project_list({}).find(p => p.name === 'Workflow Product');
  const repo = repositories.repository_list({ project_id: product.id }).repositories[0];
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-001 typed flow' });
  const prd = tasks.task_create({
    epic_id: epic.id,
    title: 'PRD: typed flow',
    status: 'done',
    priority: 'critical',
    task_kind: 'formalization.prd',
    workflow_stage: 'formalization',
    execution_skill: 'saga-product',
    review_skill: 'saga-requirements-reviewer',
    project_repository_id: repo.id,
  });

  const first = workflow.workflow_generate_next({
    epic_id: epic.id, source_task_id: prd.id, transition: 'prd_accepted',
  });
  assert.equal(first.created.length, 2);
  assert.deepEqual(first.tasks.map(t => t.task_kind).sort(), ['formalization.srs', 'formalization.uc']);
  assert.ok(first.tasks.every(t => t.generated_from_task_id === prd.id));
  assert.ok(first.tasks.every(t => t.project_repository_id === repo.id));

  const second = workflow.workflow_generate_next({
    epic_id: epic.id, source_task_id: prd.id, transition: 'prd_accepted',
  });
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.reused.sort(), first.created.sort());
  assert.equal(tasks.task_list({ epic_id: epic.id }).filter(t => t.generated_from_task_id === prd.id).length, 2);

  const srs = first.tasks.find(t => t.task_kind === 'formalization.srs');
  const uc = first.tasks.find(t => t.task_kind === 'formalization.uc');
  process.env.SAGA_ALLOW_MANUAL_STATUS = '1';
  tasks.task_update({ id: srs.id, status: 'done' });
  tasks.task_update({ id: uc.id, status: 'done' });
  delete process.env.SAGA_ALLOW_MANUAL_STATUS;

  const reconciliation = workflow.workflow_generate_next({
    epic_id: epic.id, source_task_id: srs.id, transition: 'srs_accepted',
  });
  assert.equal(reconciliation.created.length, 1);
  assert.equal(reconciliation.tasks[0].task_kind, 'formalization.reconciliation');
  assert.equal(reconciliation.tasks[0].status, 'todo');
  const reconciliationAgain = workflow.workflow_generate_next({
    epic_id: epic.id, source_task_id: uc.id, transition: 'uc_accepted',
  });
  assert.deepEqual(reconciliationAgain.reused, reconciliation.created);

  process.env.SAGA_ALLOW_MANUAL_STATUS = '1';
  tasks.task_update({ id: reconciliation.tasks[0].id, status: 'done' });
  delete process.env.SAGA_ALLOW_MANUAL_STATUS;
  const planning = workflow.workflow_generate_next({
    epic_id: epic.id,
    source_task_id: reconciliation.tasks[0].id,
    transition: 'baseline_accepted',
  });
  assert.equal(planning.tasks[0].task_kind, 'planning.decomposition');
  assert.equal(planning.tasks[0].execution_mode, 'tracker_only');
});

test('dispatcher returns typed skill and task repository workspace', () => {
  const product = projects.project_create({ name: 'Routing Product' });
  const repo = repositories.repository_register({
    project_id: product.id, name: 'routing-repo', local_path: repoAPath,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-routing' });
  tasks.task_create({
    epic_id: epic.id, title: 'Typed SRS', priority: 'critical',
    task_kind: 'formalization.srs', workflow_stage: 'formalization',
    execution_skill: 'saga-architect', review_skill: 'saga-architecture-reviewer',
    project_repository_id: repo.id,
  });
  const assignment = dispatcher.worker_next({ worker_id: 'typed-agent', project_id: product.id });
  assert.ok(assignment.task);
  assert.equal(assignment.skill, 'saga-architect');
  const binding = repositories.repository_get({ id: assignment.task.project_repository_id });
  assert.equal(assignment.repository.local_path, binding.local_path);
  assert.equal(assignment.repository.id, assignment.task.project_repository_id);
});

test('review routing uses review_skill instead of producer role', () => {
  const product = projects.project_create({ name: 'Review Product' });
  const repo = repositories.repository_register({
    project_id: product.id, name: 'review-repo', local_path: repoBPath,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-review' });
  tasks.task_create({
    epic_id: epic.id,
    title: 'Review AC',
    status: 'review',
    priority: 'critical',
    task_kind: 'formalization.ac',
    execution_skill: 'saga-analyst',
    review_skill: 'saga-requirements-reviewer',
    project_repository_id: repo.id,
    tags: ['role:analyst'],
  });
  const assignment = dispatcher.worker_next({ worker_id: 'requirements-reviewer', project_id: product.id });
  assert.equal(assignment.skill, 'saga-requirements-reviewer');
  assert.equal(assignment.task.status, 'review');
});

test('typed git work generates downstream only after repository integration', () => {
  const product = projects.project_create({ name: 'Automatic Flow Product' });
  const repo = repositories.repository_register({
    project_id: product.id, name: 'auto-repo', local_path: repoAPath, role: 'control',
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-auto' });
  const prd = tasks.task_create({
    epic_id: epic.id,
    title: 'PRD ready for acceptance',
    status: 'review',
    priority: 'critical',
    task_kind: 'formalization.prd',
    workflow_stage: 'formalization',
    execution_skill: 'saga-product',
    review_skill: 'saga-requirements-reviewer',
    project_repository_id: repo.id,
  });
  const assignment = dispatcher.worker_next({ worker_id: 'auto-reviewer', project_id: product.id });
  assert.equal(assignment.task.id, prd.id);
  const completed = dispatcher.worker_done({
    task_id: prd.id, worker_id: 'auto-reviewer', result: 'APPROVED', verdict: 'approved',
  });
  assert.equal(completed.completed_new_status, 'done');
  assert.equal(completed.workflow_generation, undefined);
  assert.equal(tasks.task_list({ epic_id: epic.id }).filter(t => t.generated_from_task_id === prd.id).length, 0);
  assert.equal(dispatcher.worker_merge_acquire({ task_id: prd.id, worker_id: 'auto-reviewer' }).granted, true);
  dispatcher.worker_merge_release({
    task_id: prd.id, worker_id: 'auto-reviewer', result: 'merged', commit_sha: 'abc123',
  });
  assert.deepEqual(
    tasks.task_list({ epic_id: epic.id }).filter(t => t.generated_from_task_id === prd.id)
      .map(t => t.task_kind).sort(),
    ['formalization.srs', 'formalization.uc'],
  );
});

test('episode planning gate requires an accepted, hash-pinned, drift-free AC baseline', () => {
  const product = projects.project_create({ name: 'Hard Gate Product' });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-hard-gate' });
  assert.equal(lifecycle.episode_status({ epic_id: epic.id }).workflow.stage, 'discovery');
  lifecycle.episode_transition({ epic_id: epic.id, to_stage: 'formalization' });
  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic.id, to_stage: 'planning' }),
    /no AC artifacts/,
  );
  const ac = artifacts.artifact_create({
    project_id: product.id, epic_id: epic.id, type: 'AC', code: 'AC-1',
    title: 'Pinned criterion', path: 'docs/ac.md', status: 'accepted', content_hash: 'hash-v1',
  });
  const advanced = lifecycle.episode_transition({
    epic_id: epic.id, to_stage: 'planning', baseline_artifact_id: ac.id,
  });
  assert.equal(advanced.workflow.stage, 'planning');
  assert.ok(advanced.workflow.baseline_hash);
  const drifted = artifacts.artifact_update({ id: ac.id, content_hash: 'hash-v2' });
  assert.equal(drifted.drift_state, 'drifted');
});

test('artifact hash is read from repository file and out-of-band edits produce drift', () => {
  const product = projects.project_create({ name: 'Disk Hash Product' });
  const repo = repositories.repository_register({
    project_id: product.id, name: 'hash-repo', local_path: repoBPath,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-disk-hash' });
  const file = path.join(repoBPath, 'accepted-ac.md');
  writeFileSync(file, 'version one');
  const ac = artifacts.artifact_create({
    project_id: product.id, epic_id: epic.id, project_repository_id: repo.id,
    type: 'AC', code: 'AC-H', title: 'Disk criterion',
    path: 'accepted-ac.md', status: 'accepted',
  });
  assert.ok(ac.content_hash);
  assert.equal(ac.content_hash, ac.accepted_hash);
  writeFileSync(file, 'version two');
  lifecycle.episode_status({ epic_id: epic.id });
  assert.equal(artifacts.artifact_get({ id: ac.id }).artifact.drift_state, 'drifted');
});

test('initialized episodes enforce downstream provenance and auto-advance ready stages', () => {
  const product = projects.project_create({ name: 'Provenance Product' });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-provenance' });
  lifecycle.episode_status({ epic_id: epic.id });
  lifecycle.episode_transition({ epic_id: epic.id, to_stage: 'formalization' });
  const ac = artifacts.artifact_create({
    project_id: product.id, epic_id: epic.id, type: 'AC', code: 'AC-P',
    title: 'Provenance criterion', path: 'ac-p.md', status: 'accepted', content_hash: 'p-hash',
  });
  lifecycle.episode_transition({ epic_id: epic.id, to_stage: 'planning' });
  tasks.task_create({
    epic_id: epic.id, title: 'Plan', status: 'done',
    task_kind: 'planning.decomposition', workflow_stage: 'planning',
    execution_mode: 'tracker_only',
  });
  assert.throws(
    () => tasks.task_create({
      epic_id: epic.id, title: 'Untraced dev', task_kind: 'development.code',
      workflow_stage: 'development',
    }),
    /requires generated_from_task_id or source_artifact_ids/,
  );
  const dev = tasks.task_create({
    epic_id: epic.id, title: 'Traced dev', priority: 'critical',
    task_kind: 'development.code', workflow_stage: 'development',
    source_artifact_ids: [ac.id],
  });
  const assignment = dispatcher.worker_next({ project_id: product.id, worker_id: 'auto-stage' });
  assert.equal(assignment.task.id, dev.id);
  assert.equal(lifecycle.episode_status({ epic_id: epic.id }).workflow.stage, 'development');
});

test('verified_by is backed by immutable passing evidence for the accepted AC revision', () => {
  const product = projects.project_create({ name: 'Evidence Product' });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-evidence' });
  const ac = artifacts.artifact_create({
    project_id: product.id, epic_id: epic.id, type: 'AC', code: 'AC-E',
    title: 'Evidence criterion', path: 'docs/evidence.md', status: 'accepted', content_hash: 'evidence-hash',
  });
  const verify = tasks.task_create({
    epic_id: epic.id, title: 'Verify AC-E', task_kind: 'verification.ac',
    workflow_stage: 'verification', execution_mode: 'read_only_evidence',
  });
  const held = dispatcher.worker_next({ project_id: product.id, worker_id: 'verifier' });
  assert.equal(held.task.id, verify.id);
  assert.throws(
    () => artifacts.trace_add({
      source_id: ac.id, target_type: 'task', target_id: verify.id, link_type: 'verified_by',
    }),
    /requires passing verification_evidence/,
  );
  assert.throws(
    () => lifecycle.verification_record({
      task_id: verify.id, artifact_id: ac.id, outcome: 'passed',
      evidence: 'report', content_hash: 'wrong-hash', recorded_by: 'verifier',
    }),
    /does not match/,
  );
  lifecycle.verification_record({
    task_id: verify.id, artifact_id: ac.id, outcome: 'passed',
    evidence: 'tests/ac-e.json', recorded_by: 'verifier',
  });
  const evidence = getDb().prepare(
    'SELECT * FROM verification_evidence WHERE task_id=? AND artifact_id=?',
  ).get(verify.id, ac.id);
  assert.equal(evidence.outcome, 'passed');
  assert.equal(artifacts.trace_list({
    source_id: ac.id, target_type: 'task', target_id: verify.id, link_type: 'verified_by',
  }).count, 1);
});

test('verification review cannot approve before passing evidence exists', () => {
  const product = projects.project_create({ name: 'Verification Approval Product' });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-verify-approval' });
  const ac = artifacts.artifact_create({
    project_id: product.id, epic_id: epic.id, type: 'AC', code: 'AC-V',
    title: 'Approval criterion', path: 'ac-v.md', status: 'accepted', content_hash: 'v-hash',
  });
  const verify = tasks.task_create({
    epic_id: epic.id, title: 'Review verification', status: 'review', priority: 'critical',
    task_kind: 'verification.ac', workflow_stage: 'verification',
    execution_mode: 'read_only_evidence', source_artifact_ids: [ac.id],
  });
  dispatcher.worker_next({ project_id: product.id, worker_id: 'verification-reviewer' });
  assert.throws(
    () => dispatcher.worker_done({
      task_id: verify.id, worker_id: 'verification-reviewer', result: 'approved', verdict: 'approved',
    }),
    /cannot be approved without passing evidence/,
  );
  lifecycle.verification_record({
    task_id: verify.id, artifact_id: ac.id, outcome: 'passed',
    evidence: 'verified', recorded_by: 'verification-reviewer',
  });
  assert.equal(dispatcher.worker_done({
    task_id: verify.id, worker_id: 'verification-reviewer', result: 'approved', verdict: 'approved',
  }).completed_new_status, 'done');
});

test('typed dependencies wait for merge and repository merge locks do not block other repositories', () => {
  const product = projects.project_create({ name: 'Repository Gate Product' });
  const repoA = repositories.repository_register({
    project_id: product.id, name: 'gate-a', local_path: repoAPath, integration_branch: 'develop-a',
  });
  const repoB = repositories.repository_register({
    project_id: product.id, name: 'gate-b', local_path: repoBPath, integration_branch: 'develop-b',
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-repo-gates' });
  const upstream = tasks.task_create({
    epic_id: epic.id, title: 'Typed upstream', status: 'review', priority: 'critical',
    task_kind: 'development.code', workflow_stage: 'development',
    project_repository_id: repoA.id,
  });
  const downstream = tasks.task_create({
    epic_id: epic.id, title: 'Typed downstream', priority: 'critical',
    task_kind: 'development.code', workflow_stage: 'development',
    project_repository_id: repoB.id, depends_on: [upstream.id],
  });
  const review = dispatcher.worker_next({ project_id: product.id, worker_id: 'repo-a-reviewer' });
  assert.equal(review.task.id, upstream.id);
  dispatcher.worker_done({
    task_id: upstream.id, worker_id: 'repo-a-reviewer', result: 'approved', verdict: 'approved',
  });
  assert.equal(dispatcher.worker_next({ project_id: product.id, worker_id: 'too-early' }).task, null);

  const independent = tasks.task_create({
    epic_id: epic.id, title: 'Independent repo B merge', status: 'done',
    task_kind: 'development.code', workflow_stage: 'development',
    project_repository_id: repoB.id,
  });
  assert.equal(dispatcher.worker_merge_acquire({
    task_id: upstream.id, worker_id: 'repo-a-reviewer',
  }).granted, true);
  assert.equal(dispatcher.worker_merge_acquire({
    task_id: independent.id, worker_id: 'repo-b-integrator',
  }).granted, true);
  dispatcher.worker_merge_release({
    task_id: independent.id, worker_id: 'repo-b-integrator', result: 'merged', commit_sha: 'bbb',
  });
  dispatcher.worker_merge_release({
    task_id: upstream.id, worker_id: 'repo-a-reviewer', result: 'merged', commit_sha: 'aaa',
  });
  const released = dispatcher.worker_next({ project_id: product.id, worker_id: 'after-merge' });
  assert.equal(released.task.id, downstream.id);
});

test('legacy tasks retain developer and reviewer routing', () => {
  const product = projects.project_create({ name: 'Legacy Product' });
  const epic = epics.epic_create({ project_id: product.id, name: 'Legacy epic' });
  tasks.task_create({ epic_id: epic.id, title: 'Legacy todo', priority: 'critical' });
  const todo = dispatcher.worker_next({ worker_id: 'legacy-dev', project_id: product.id });
  assert.equal(todo.skill, 'saga-developer');
  assert.equal(todo.repository, null);

  const reviewProduct = projects.project_create({ name: 'Legacy Review Product' });
  const reviewEpic = epics.epic_create({ project_id: reviewProduct.id, name: 'Legacy review epic' });
  tasks.task_create({ epic_id: reviewEpic.id, title: 'Legacy review', status: 'review', priority: 'critical' });
  const review = dispatcher.worker_next({ worker_id: 'legacy-review', project_id: reviewProduct.id });
  assert.equal(review.skill, 'saga-reviewer');
});

test('cross-repository dependency blocks downstream and invalid generation is atomic', () => {
  const product = projects.project_create({ name: 'Dependency Product' });
  const [repoA, repoB] = [
    repositories.repository_register({ project_id: product.id, name: 'dep-a', local_path: repoAPath }),
    repositories.repository_register({ project_id: product.id, name: 'dep-b', local_path: repoBPath }),
  ];
  const epic = epics.epic_create({ project_id: product.id, name: 'REQ-dependencies' });
  const upstream = tasks.task_create({
    epic_id: epic.id, title: 'Upstream', priority: 'critical', project_repository_id: repoA.id,
  });
  const downstream = tasks.task_create({
    epic_id: epic.id, title: 'Downstream', priority: 'critical',
    project_repository_id: repoB.id, depends_on: [upstream.id],
  });
  assert.equal(downstream.status, 'blocked');
  const assignment = dispatcher.worker_next({ worker_id: 'dep-agent', project_id: product.id });
  assert.equal(assignment.task.id, upstream.id);
  assert.equal(assignment.repository.id, repoA.id);

  assert.throws(
    () => workflow.workflow_generate_next({
      epic_id: epic.id, source_task_id: upstream.id, transition: 'prd_accepted',
    }),
    /must be done/,
  );
  assert.equal(tasks.task_list({ epic_id: epic.id }).length, 2);
});

test('project export/import 1.4 preserves repository bindings and typed task fields', () => {
  const source = projects.project_list({}).find(p => p.name === 'Workflow Product');
  const exported = exportImport.tracker_export({ project_id: source.id });
  assert.equal(exported.format_version, '1.4');
  assert.equal(exported.project.repositories.length, 2);
  const imported = exportImport.tracker_import({ data: exported });
  const importedRepos = repositories.repository_list({ project_id: imported.project_id });
  assert.equal(importedRepos.count, 2);
  assert.equal(repositories.repository_checkout_list({ project_id: imported.project_id }).count, 1);
  const importedEpics = epics.epic_list({ project_id: imported.project_id });
  const importedTasks = importedEpics.flatMap(e => tasks.task_list({ epic_id: e.id, limit: 200 }));
  const typed = importedTasks.find(t => t.task_kind === 'formalization.srs');
  assert.ok(typed);
  assert.equal(typed.execution_skill, 'saga-architect');
  assert.ok(importedRepos.repositories.some(r => r.id === typed.project_repository_id));
  const generated = importedTasks.find(t => t.generated_from_task_id != null);
  assert.ok(generated);
  assert.ok(importedTasks.some(t => t.id === generated.generated_from_task_id));
});
