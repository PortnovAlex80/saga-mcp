#!/usr/bin/env node
// tests/factory-proof/w1-4-two-lifecycles-drive.mjs
//
// W1-4 — the ADR-078 two-lifecycle composition proof: TWO Formalization
// lifecycles on ONE epic, different material each, through the canonical
// composition (W0-1) and the production driver (requestFreshHarnessLaunch —
// the production second-launch API, no test-side authority writes).
//
//   Run A: the W9 happy handlers — material A (AC-1/AC-2). Driven to its
//          lifecycle terminal (runnable-local).
//   Run B: variant handlers — material B (AC-B1/AC-B2/AC-B3, three criteria,
//          different codes/sections) + an accepted decoy artifact created by
//          B's OWN product-contract cell (fully traced FR+UC). Run B is
//          driven until its Formalization stage settles (stopOnStageOutcome).
//
// Pinned semantics this drive evidences (ADR-078):
//
//   F-1  WITHIN-LIFECYCLE CONSERVATION — the acceptance freeze seals EVERY
//        accepted AC authored during the lifecycle, including the decoy the
//        product-contract cell accepted: capsule B = {AC-B1..B3, AC-DECOY},
//        and the SRS gate then forces §D2 decomposition of all four. No
//        accepted AC can escape the frozen contract (fail-closed). If the
//        architect later rules the sweep itself a defect, TIGHTEN this test
//        to exclude AC-DECOY — never the reverse.
//   F-2  CROSS-LIFECYCLE ISOLATION — A's AC-1/AC-2 are NOT swept into B's
//        capsule; A's baseline hash is byte-identical before and after run B.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness, requestFreshHarnessLaunch } = harness;
const { HARNESS_CONCURRENCY_CEILING } = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { buildCanonicalProofComposition, createScriptedObserver } = await import('./canonical-proof-composition.mjs');
const { W9_HAPPY_HANDLERS } = await import('../factory-e2e/w9-happy-handlers.mjs');

const FRM = 'solution-formalization@1.0.0';

// ADR-090 (CC-IC-2): the covered_constraint_ids relay read back from the
// ACCEPTED brief's authored dispositions (this drive's DB is the harness DB —
// the same read the W9 corpus performs through artifact_list): EVERY
// non-waived id — accepted AND resolved/deferred alike. On v2,
// resolved/deferred are disposition states, never coverage discharges, so
// the open-question entries stay obligations the AC/SRS work must cover;
// legacy v1 reasoned waivers are the only lawful exclusion.
function coveredConstraintIdsFromBriefDb(db, epicId) {
  const brief = db.prepare(
    `SELECT metadata FROM artifacts
      WHERE epic_id=? AND type='brief' AND status='accepted'
      ORDER BY id DESC LIMIT 1`,
  ).get(epicId);
  if (!brief?.metadata) return [];
  try {
    const parsed = JSON.parse(brief.metadata);
    const dispositions = parsed?.constraint_dispositions;
    if (!dispositions || typeof dispositions !== 'object') return [];
    return Object.entries(dispositions)
      .filter(([, value]) => value && value.disposition !== 'waived')
      .map(([id]) => id)
      .sort();
  } catch {
    return [];
  }
}

// --- Material B handlers: three criteria, different sections --------------
function acceptanceAuthorB({ handlers, assignment, context, db }) {
  const taskRow = db.prepare(
    'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
  ).get(Number(assignment.taskId));
  const projectId = taskRow?.project_id ?? 1;
  const epicId = taskRow?.epic_id ?? 1;
  const repoPath = context.workspaceRoot;
  // B's contract snapshot is run-scoped: A's FR/NFR/UC rows are invisible to
  // B's validator even though the traces would land. Bind to the LATEST
  // accepted rows (B's own productions have the highest ids).
  const accepted = type => db.prepare(
    `SELECT id FROM artifacts WHERE epic_id=? AND type=? AND status='accepted' ORDER BY id DESC`,
  ).all(epicId, type);
  const frs = accepted('FR');
  const nfrs = accepted('NFR');
  const ucs = accepted('UC');
  if (!frs.length) throw new Error('w1-4: no accepted FR for acceptance B');
  // ADR-090 (CC-IC-2): the first B criterion carries the covered_constraint_ids
  // relay read back from B's accepted brief — EVERY non-waived id (the
  // acceptance coverage gate diffs the v2 register, which never subtracts,
  // against it).
  const coveredIds = coveredConstraintIdsFromBriefDb(db, epicId);

  const specs = [
    ['AC-B1', 'AC-B1: Hyperspace Fuel Model'],
    ['AC-B2', 'AC-B2: Market Price Spread'],
    ['AC-B3', 'AC-B3: Pirate Encounter Risk'],
  ];
  const { writeFileSync } = require('node:fs');
  for (const [code, title] of specs) {
    const p = `docs/formalization/${code}.md`;
    const full = path.join(repoPath, p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `## ${title}\n\nMaterial B atomic criterion ${code}.\n`, 'utf8');
    const ac = handlers.artifact_create({
      project_id: projectId, epic_id: epicId, type: 'AC', code, title,
      path: p, status: 'accepted',
      ...(code === 'AC-B1' && coveredIds.length > 0
        ? { metadata: { covered_constraint_ids: coveredIds } }
        : {}),
    });
    handlers.trace_add({ source_id: ac.id, target_type: 'artifact', target_id: frs[0].id, link_type: 'derived_from' });
    if (ucs.length) handlers.trace_add({ source_id: ac.id, target_type: 'artifact', target_id: ucs[0].id, link_type: 'derived_from' });
    if (nfrs.length && code === 'AC-B3') {
      handlers.trace_add({ source_id: ac.id, target_type: 'artifact', target_id: nfrs[0].id, link_type: 'derived_from' });
    }
  }
  handlers.worker_done({
    task_id: Number(assignment.taskId), worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId, result: 'w1-4 acceptance B: three criteria',
  });
  return { kind: 'worker-done-accepted' };
}

function architectureAuthorB({ handlers, assignment, context, db }) {
  const taskRow = db.prepare(
    'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
  ).get(Number(assignment.taskId));
  const projectId = taskRow?.project_id ?? 1;
  const epicId = taskRow?.epic_id ?? 1;
  const repoPath = context.workspaceRoot;
  const prds = db.prepare(
    `SELECT id FROM artifacts WHERE epic_id=? AND type='PRD' AND status='accepted' ORDER BY id LIMIT 1`,
  ).all(epicId);
  if (!prds.length) throw new Error('w1-4: no accepted PRD for architecture B');
  // ADR-090 (CC-IC-2): the first §D2 stanza carries the covered_constraint_ids
  // relay read back from B's accepted brief — EVERY non-waived id. The SRS
  // coverage diff requires the union over stanzas to cover register B
  // (which never subtracts on v2 — resolved/deferred stay obligations).
  const coveredIds = coveredConstraintIdsFromBriefDb(db, epicId);
  const coveredField = coveredIds.length > 0
    ? `\n  covered_constraint_ids: ${coveredIds.join(', ')}`
    : '';
  const stanza = (ac, title, files, kind, extra = '') => [
    `- ac: ${ac}`, `  title: ${title}`, '  module: src/material-b',
    `  files: ["${files}"]`, "  invariants: ['Deterministic']", "  test_layers: ['contract']",
    '  pattern: A', '  depends_on: []', `  ac_kind: ${kind}`, `  criticality: blocker${extra}`,
  ].join('\n');
  const srsContent = [
    '# SRS B', '', '## §D2 Acceptance Criteria Decomposition', '', '```yaml',
    stanza('AC-B1', 'Hyperspace Fuel Model', 'src/material-b/fuel.js', 'implementation', coveredField),
    stanza('AC-B2', 'Market Price Spread', 'src/material-b/market.js', 'implementation'),
    stanza('AC-B3', 'Pirate Encounter Risk', 'src/material-b/risk.js', 'implementation'),
    // ADR-078 F-1 (pinned semantics): the freeze conserves EVERY accepted AC
    // authored during this lifecycle — including the decoy the product-contract
    // cell accepted. The SRS must decompose all of them; no accepted AC may
    // escape the frozen capsule. Cross-lifecycle material (AC-1/AC-2) stays out.
    stanza('AC-DECOY', 'Never In Any Contract', 'src/material-b/decoy.js', 'implementation'),
    '```', '', '## §12 Decision Log', '',
    '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
    '|---|----------|----------------|--------------------------|-----------|------|',
    '| 1 | Material B split | CONVEYOR §16 | Material A reuse | Different product | 2026-08-21 |', '',
  ].join('\n');
  const srsPath = 'docs/formalization/SRS-B.md';
  const { writeFileSync, mkdirSync: mk } = require('node:fs');
  const full = path.join(repoPath, srsPath);
  mk(path.dirname(full), { recursive: true });
  writeFileSync(full, srsContent, 'utf8');
  const srs = handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type: 'SRS', code: 'SRS-B',
    title: 'SRS B', path: srsPath, status: 'draft', project_repository_id: 1,
  });
  handlers.trace_add({ source_id: srs.id, target_type: 'artifact', target_id: prds[0].id, link_type: 'derived_from' });
  handlers.worker_done({
    task_id: Number(assignment.taskId), worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId, result: 'w1-4 architecture B',
  });
  return { kind: 'worker-done-accepted' };
}

// The decoy probe: B's product-contract author ALSO creates a properly
// traced ACCEPTED artifact that neither lifecycle's contract ever names.
// Option-1 (2026-08-21): B's OWN contract bytes must differ too — the happy
// fixtures are byte-identical across runs, downstream input snapshots bind
// the brief/PRD digests, and identical bytes made B's use-cases/acceptance
// cells lawfully replay A's capsules (observed: capsule B carried A's
// AC-1/AC-2). A real second product has a different brief and PRD.
function productContractAuthorWithDecoy(base) {
  return function withDecoy({ handlers, assignment, meta, context, db }) {
    const mutated = new Set();
    const upstreamCreate = handlers.artifact_create;
    const diffHandlers = {
      ...handlers,
      artifact_create(input) {
        if ((input?.type === 'brief' || input?.type === 'PRD' || input?.type === 'FR')
            && !mutated.has(input.type)) {
          mutated.add(input.type);
          const { readFileSync, writeFileSync } = require('node:fs');
          const fp = path.join(context.workspaceRoot, String(input.path).split('#')[0]);
          const content = readFileSync(fp, 'utf8');
          writeFileSync(fp, `${content}\n## Material B: the three-criteria trade-sim product (run B)\n`, 'utf8');
        }
        return upstreamCreate(input);
      },
    };
    // meta MUST forward: the CC-IC-2 disposition helper inside the base reads
    // the FormalizationCase from the task's own process_node_input.
    const out = base({ handlers: diffHandlers, assignment, meta, context, db });
    try {
      const taskRow = db.prepare(
        'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
      ).get(Number(assignment.taskId));
      const repoPath = context.workspaceRoot;
      const frs = db.prepare(
        `SELECT id FROM artifacts WHERE epic_id=? AND type='FR' AND status='accepted' ORDER BY id DESC LIMIT 1`,
      ).all(taskRow.epic_id);
      const p = 'docs/formalization/AC-DECOY.md';
      const { writeFileSync, mkdirSync: mk } = require('node:fs');
      const full = path.join(repoPath, p);
      mk(path.dirname(full), { recursive: true });
      writeFileSync(full, '## AC-DECOY: Never In Any Contract\n\nThe epic-accumulator probe.\n', 'utf8');
      const decoy = handlers.artifact_create({
        project_id: taskRow.project_id, epic_id: taskRow.epic_id,
        type: 'AC', code: 'AC-DECOY', title: 'AC-DECOY: Never In Any Contract',
        path: p, status: 'accepted',
      });
      if (frs.length) handlers.trace_add({
        source_id: decoy.id, target_type: 'artifact', target_id: frs[0].id, link_type: 'derived_from',
      });
      // The acceptance gate demands full per-AC legitimacy (FR+UC) for every
      // accepted AC — and the validator's contract snapshot is RUN-SCOPED: a
      // trace into run A's UC is invisible to run B. The decoy therefore
      // carries its OWN UC (created in the same cell, derived from the same
      // PRD/FR) — a self-consistent probe pair visible to B's validator.
      const ucPath = 'docs/formalization/UC-DECOY.md';
      const ucFull = path.join(repoPath, ucPath);
      writeFileSync(ucFull,
        '# Use Case DECOY\n\nThe epic-accumulator probe companion.\n', 'utf8');
      const ucDecoy = handlers.artifact_create({
        project_id: taskRow.project_id, epic_id: taskRow.epic_id,
        type: 'UC', code: 'UC-DECOY', title: 'Use Case DECOY',
        path: ucPath, status: 'accepted',
      });
      const prdRow = db.prepare(
        `SELECT id FROM artifacts WHERE epic_id=? AND type='PRD' AND status='accepted' ORDER BY id DESC LIMIT 1`,
      ).get(taskRow.epic_id);
      if (prdRow) handlers.trace_add({
        source_id: ucDecoy.id, target_type: 'artifact', target_id: prdRow.id, link_type: 'derived_from',
      });
      if (frs.length) handlers.trace_add({
        source_id: ucDecoy.id, target_type: 'artifact', target_id: frs[0].id, link_type: 'covers',
      });
      handlers.trace_add({
        source_id: decoy.id, target_type: 'artifact', target_id: ucDecoy.id, link_type: 'derived_from',
      });
    } catch { /* the probe never blocks the product contract cell */ }
    return out;
  };
}

const DIS = 'product-discovery@4.0.0';

// Option-1: B's use-cases output must differ too — the UC fixture bytes are
// identical across runs and the acceptance cell's input snapshot binds the
// UC digests, so identical UCs lawfully replayed A's acceptance capsule.
function useCasesAuthorB({ handlers, assignment, context, db }) {
  const taskRow = db.prepare(
    'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
  ).get(Number(assignment.taskId));
  const epicId = taskRow?.epic_id ?? 1;
  const projectId = taskRow?.project_id ?? 1;
  const repoPath = context.workspaceRoot;
  const pick = (type, excluded) => db.prepare(
    `SELECT id FROM artifacts WHERE epic_id=? AND type=? AND status='accepted' ORDER BY id`,
  ).all(epicId, type).filter(row => !excluded.includes(row.id));
  const prds = pick('PRD', []);
  const frs = pick('FR', []);
  if (!prds.length || !frs.length) throw new Error('w1-4: no accepted PRD/FR for use-cases B');
  const ucPath = 'docs/formalization/UC-B1.md';
  const { writeFileSync, mkdirSync: mk } = require('node:fs');
  const full = path.join(repoPath, ucPath);
  mk(path.dirname(full), { recursive: true });
  writeFileSync(full,
    '# Use Case B1\n\nThe trade crew consolidates fuel, price spread and encounter risk into one route plan.\n', 'utf8');
  const uc = handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type: 'UC', code: 'UC-B1',
    title: 'Use Case B1', path: ucPath, status: 'draft', project_repository_id: 1,
  });
  handlers.trace_add({ source_id: uc.id, target_type: 'artifact', target_id: prds[0].id, link_type: 'derived_from' });
  handlers.trace_add({ source_id: uc.id, target_type: 'artifact', target_id: frs[0].id, link_type: 'covers' });
  handlers.worker_done({
    task_id: Number(assignment.taskId), worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId, result: 'w1-4 use-cases B: UC-B1->PRD+FR',
  });
  return { kind: 'worker-done-accepted' };
}

// Option-1 (2026-08-21): the W9 discovery proposal payload is a FIXED
// fixture — the idea string never enters it — so run B's discovery produced
// byte-identical products and every downstream formalization cell hit run
// A's replay capsules (observed: capsule B carried A's AC-1/AC-2). B's
// semantic input must differ from the very head of the chain: the B
// proposal carries materially different (still contract-valid) content.
function discoveryProposalB({ handlers, assignment }) {
  handlers.product_submit({
    schema: 'factory.discovery-proposal.v1',
    content: {
      problem_statement: 'Trade crews plan routes with no consolidated fuel, price and encounter risk view.',
      observed_context: 'Spreadsheets track each risk factor separately. No consolidated trade-sim exists.',
      stakeholders_or_actors: ['Trade crews', 'Quartermasters', 'Market watchers'],
      assumptions: ['Factor models are stable within a voyage.', 'Deterministic workers can substitute LLM.'],
      unknowns: ['Pirate encounter model calibration.'],
      risks: ['Factor drift within a long voyage.'],
      candidate_scope: 'A three-criteria trade-sim through the real Factory with deterministic physical workers.',
      evidence_refs: ['CONVEYOR-MENTAL-MODEL.md', 'factory-e2e harness'],
      recommended_outcome: 'go',
      rationale: 'Three bounded criteria, consolidated model, deterministic verification path.',
    },
  });
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result: 'produced discovery proposal (material B) with recommended_outcome=go',
  });
  return { kind: 'worker-done-accepted' };
}

const B_HANDLERS = {
  ...W9_HAPPY_HANDLERS,
  [`${DIS}/produce-proposal/author/singleton`]: discoveryProposalB,
  [`${FRM}/model-use-cases/author/singleton`]: useCasesAuthorB,
  [`${FRM}/define-acceptance-contract/author/singleton`]: acceptanceAuthorB,
  [`${FRM}/define-architecture-contract/author/singleton`]: architectureAuthorB,
  [`${FRM}/define-product-contract/author/singleton`]: productContractAuthorWithDecoy(
    W9_HAPPY_HANDLERS[`${FRM}/define-product-contract/author/singleton`]),
};
function capsuleOf(db, lifecycleRunId) {
  // lifecycle -> stage run -> process run -> frozen baseline (the real joins)
  const runIds = db.prepare(
    `SELECT process_run_id FROM factory_stage_runs
      WHERE lifecycle_run_id=? AND process_run_id IS NOT NULL ORDER BY id`,
  ).all(lifecycleRunId).map(r => r.process_run_id);
  if (runIds.length === 0) return null;
  const placeholders = runIds.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT payload, baseline_hash FROM factory_formalization_acceptance_baselines
      WHERE process_run_id IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
  ).get(...runIds);
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  return {
    baselineHash: row.baseline_hash,
    codes: (payload.acceptanceCriteria ?? []).map(m => m.code).sort(),
    memberHashes: (payload.acceptanceCriteria ?? []).map(m => m.contentHash),
  };
}

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  ...(process.env.PROOF_KEEP_DIR ? { tempDir: process.env.PROOF_KEEP_DIR } : {}),
  idea: 'W1-4 material A: the two-criteria pipeline product (run A)',
});

try {
  bootstrap.assertNoAuthorityWritesYet();

  // ---- Run A -------------------------------------------------------------
  const observerA = createScriptedObserver();
  const compositionA = buildCanonicalProofComposition({
    observer: observerA, repoPath: bootstrap.repoPath, sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: W9_HAPPY_HANDLERS,
  });
  const resultA = await driveFreshHarness({
    bootstrap, composition: compositionA,
    scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
    maxCycles: 160, pollMs: 5, maxEmptyDispatchStreak: 12, scriptedObserver: observerA,
  });

  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();
  const lifecycles = db.prepare('SELECT id, status, terminal_status FROM factory_lifecycle_runs ORDER BY id').all();
  const capsuleA = capsuleOf(db, lifecycles[0].id);
  const stageA = db.prepare(
    `SELECT local_outcome FROM factory_stage_runs
      WHERE stage_id='solution-formalization' AND lifecycle_run_id=? ORDER BY id DESC`,
  ).get(lifecycles[0].id);

  // ---- Run B: a NEW launch on the SAME project/epic ----------------------
  const launchB = requestFreshHarnessLaunch(bootstrap, {
    idea: 'W1-4 material B: the three-criteria trade-sim product (run B)',
  });
  const observerB = createScriptedObserver();
  const compositionB = buildCanonicalProofComposition({
    observer: observerB, repoPath: bootstrap.repoPath, sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: B_HANDLERS,
  });
  const resultB = await driveFreshHarness({
    bootstrap, composition: compositionB, launchRef: launchB,
    scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
    maxCycles: 200, pollMs: 5, maxEmptyDispatchStreak: 12, scriptedObserver: observerB,
    // W1-4 scope is the Formalization stage: stop when it settles instead of
    // driving Development to completion.
    stopOnStageOutcome: 'formalized',
  });

  const lifecyclesAfter = db.prepare('SELECT id, status, terminal_status FROM factory_lifecycle_runs ORDER BY id').all();
  const capsuleAAfter = capsuleOf(db, lifecyclesAfter[0].id);
  const capsuleB = capsuleOf(db, lifecyclesAfter[1]?.id);
  const stageB = db.prepare(
    `SELECT local_outcome FROM factory_stage_runs WHERE stage_id='solution-formalization' AND lifecycle_run_id=? ORDER BY id DESC`,
  ).get(lifecyclesAfter[1]?.id);
  const decoyArtifact = db.prepare(
    `SELECT id, status, content_hash FROM artifacts WHERE code='AC-DECOY' ORDER BY id`,
  ).all();

  const bWorkplaces = db.prepare(
    `SELECT w.workplace_ref, w.kanban_phase, w.loop_state, w.terminal_reason
       FROM factory_workplaces w JOIN factory_process_runs pr ON pr.id=w.process_run_id
      WHERE pr.id IN (SELECT process_run_id FROM factory_stage_runs WHERE lifecycle_run_id=?)
      ORDER BY w.workplace_ref`,
  ).all(lifecyclesAfter[1]?.id);
  process.stdout.write(JSON.stringify({
    bWorkplaces,
    runA: { terminalReason: resultA.terminalReason, stage: stageA?.local_outcome ?? null,
      invocations: observerA.getInvocationCount(), replays: observerA.getReplayCount(),
      lifecycle: lifecycles[0], capsule: capsuleA },
    runB: { terminalReason: resultB.terminalReason, stoppedByStageOutcome: resultB.stoppedByStageOutcome,
      invocations: observerB.getInvocationCount(), replays: observerB.getReplayCount(),
      stage: stageB?.local_outcome ?? null,
      lifecycle: lifecyclesAfter[1] ?? null, capsule: capsuleB },
    immutability: {
      capsuleABefore: capsuleA?.baselineHash ?? null,
      capsuleAAfter: capsuleAAfter?.baselineHash ?? null,
      unchanged: (capsuleA?.baselineHash ?? null) === (capsuleAAfter?.baselineHash ?? null),
    },
    decoy: {
      rows: decoyArtifact.length,
      inCapsuleA: capsuleAAfter?.codes?.includes('AC-DECOY') ?? false,
      inCapsuleB: capsuleB?.codes?.includes('AC-DECOY') ?? false,
    },
    stranded: resultA.strandedActiveExecutions + resultB.strandedActiveExecutions,
  }) + '\n');
} finally {
  bootstrap.cleanup();
}
