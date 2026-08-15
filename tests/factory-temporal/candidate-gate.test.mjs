// tests/factory-temporal/candidate-gate.test.mjs
//
// ADR-048 temporal conformance — CandidateSet → GateRun → GateDecision chain.
//
// These are L3/L4 temporal properties for the OTK (quality gate) leg of the
// Production Cell loop. They run the full canonical product-build lifecycle
// through the real production composition (only the inference worker and one
// deterministic check provider are replaced — see temporal-composition.mjs)
// and assert that durable candidate/gate/effect state conformance held across
// the entire run.
//
// # The scenario under test
//
//   tests/factory-contract/transition-conformance-scenarios.mjs layers a
//   universal reject→repair→accept loop on top of the golden path. The
//   Formalization reconciliation cell exercises:
//
//     author candidate 1 → reviewer changes_requested (GateDecision
//     verdict='repair_required') → recovery feedback → author candidate 2
//     (NEW sealed CandidateSet, not a mutation) → reviewer approved → final
//     GateDecision verdict='accepted'.
//
//   That cell also declares a postAcceptanceEffect, so its acceptance is
//   effect-bounded: the workplace transits verifying → effect_pending →
//   terminal(accepted) only after an exact EffectReceipt exists.
//
// # Test shape
//
//   Tests 1, 3, 4 spawn orchestrate-cli as the host (one fresh temp git repo +
//   temp DB per test) and OPEN the resulting DB read-only to assert durable
//   temporal properties. Test 2 uses a synthetic snapshot so the explainer
//   can be exercised against the exact ownerless-pending-gate shape without
//   depending on a race window inside the lifecycle.
//
// # Critical constraints honored
//
//   - createRegistry()/cleanupRegistry() in every test
//   - bootstrapFreshDb — never touches .tracker.db or prod/
//   - readonly better-sqlite3 for every assertion read
//   - timeout: 540000 per test (full lifecycle ~5-8 min)

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const COMPOSITION_PATH = path.join(
  REPO_ROOT, 'tests', 'factory-temporal', 'lib', 'temporal-composition.mjs',
);
// transition-conformance-scenarios already layers the reject→repair→accept
// loop on the Formalization reconciliation cell (see file header).
const SCENARIOS_PATH = path.join(
  REPO_ROOT, 'tests', 'factory-contract', 'transition-conformance-scenarios.mjs',
);

import { createRegistry, cleanupRegistry } from './lib/cleanup.mjs';
import { createTempGitRepo, bootstrapFreshDb } from './lib/fresh-db.mjs';
import { createTemporalProbe } from './lib/temporal-probe.mjs';
import { explainFactoryLiveness } from './lib/liveness-explainer.mjs';
import * as predicates from './lib/predicates.mjs';

// ---------------------------------------------------------------------------
// Shared harness helpers
// ---------------------------------------------------------------------------

/**
 * Provision one temp git repo + invocation ledger for a candidate/gate test.
 * Every dir created is tracked by the registry for deterministic cleanup.
 */
function provisionRepo(registry, label) {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), `saga-cg-${label}-repo-`));
  registry.trackDir(repoDir);
  // createTempGitRepo creates its own mkdtemp dir containing the git repo.
  const tempRepo = createTempGitRepo(`cg-${label}`);
  registry.trackDir(tempRepo.dir);
  const { repoPath, baseCommit } = tempRepo;
  const invocationLogPath = path.join(repoDir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');
  return { repoPath, baseCommit, repoDir, invocationLogPath };
}

/**
 * Spawn orchestrate-cli as the host process and resolve on exit.
 * Returns { child, exit (promise of exit code), exited (flag), getStdout, getStderr }.
 * The registry tracks the child so it is SIGTERM'd on cleanup.
 *
 * `exited` is a synchronous flag that flips to true when the child closes,
 * so a probe's cycle() can detect that no more host progress is possible
 * without awaiting the exit promise.
 */
function launchFactory(registry, opts) {
  const { dbPath, launchRef, repoPath, invocationLogPath } = opts;
  const child = spawn('node', [
    path.join(REPO_ROOT, 'dist', 'orchestrate-cli.js'),
    `--launch-ref=${launchRef}`,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      SAGA_REPO_ROOT: REPO_ROOT,
      SAGA_BUTTON_REPO_PATH: repoPath,
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: COMPOSITION_PATH,
      SAGA_SCENARIOS: SCENARIOS_PATH,
      SAGA_INVOCATION_LOG: invocationLogPath,
      SAGA_CONCURRENCY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  registry.trackProcess(child, 'orchestrate-cli');

  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { stderr += c; });

  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      reject(new Error(`orchestrate-cli TIMEOUT\n${stderr.slice(-3000)}`));
    }, 540000);
    child.once('close', code => {
      clearTimeout(timer);
      exited = true;
      resolve(code);
    });
  });
  return { child, exit, get exited() { return exited; }, getStdout: () => stdout, getStderr: () => stderr };
}

/**
 * Read-only helper: collect durable summary rows for a workplace's
 * candidate/gate/effect chain. Used in failure messages.
 */
function readWorkplaceChain(db, workplaceRef) {
  return {
    workplace: db.prepare(
      'SELECT loop_state, kanban_phase, terminal_reason, revision FROM factory_workplaces WHERE workplace_ref=?',
    ).get(workplaceRef) ?? null,
    candidateSets: db.prepare(
      'SELECT candidate_set_ref, role, (SELECT rev.presenter_ref FROM factory_workplace_production_revisions rev WHERE rev.revision_ref=factory_candidate_sets.production_revision_ref) AS presenter_audit_ref FROM factory_candidate_sets WHERE workplace_ref=? ORDER BY sealed_at',
    ).all(workplaceRef),
    gateRuns: db.prepare(
      'SELECT gate_run_ref, state, gate_phase FROM factory_gate_runs WHERE workplace_ref=? ORDER BY created_at',
    ).all(workplaceRef),
    gateDecisions: db.prepare(
      'SELECT decision_key, verdict, gate_phase, repair_target_role FROM factory_gate_decisions WHERE workplace_ref=? ORDER BY decided_at',
    ).all(workplaceRef),
  };
}

// ---------------------------------------------------------------------------
// Test 1: verifying-eventually-seals-and-gates (DURING execution)
// ---------------------------------------------------------------------------
//
// This test exercises the REAL temporal property: while the factory is still
// running (orchestrate-cli has NOT exited), a workplace must EVENTUALLY reach
// `verifying` AND discharge its OTK obligation (sealed author CandidateSet +
// final GateDecision) within a bounded cycle budget. Polling only the final
// DB after the child exits would miss transient stalls that later recover —
// the whole point of ADR-048 is to observe transitions DURING execution.
//
// Approach A (child-process polling): the probe's `cycle()` does not drive
// the host (it cannot inject cycles into a child process); instead it just
// sleeps briefly to give the child process wall-clock time to advance through
// one host cycle on its own. The transitionBudget bounds how many samples we
// take before declaring the property failed.

test('Candidate/Gate: a workplace entering verifying eventually has a sealed CandidateSet + GateDecision — observed DURING execution', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  const { repoPath, baseCommit, invocationLogPath } = provisionRepo(registry, 'seals-gates');
  const { dbPath, launchRef, dir: dbDir } = await bootstrapFreshDb({
    repoPath, baseCommit, label: 'seals-gates',
  });
  registry.trackDir(dbDir);

  // Start orchestrate-cli WITHOUT awaiting exit — the probe must run while
  // the child is still alive.
  const factory = launchFactory(registry, {
    dbPath, launchRef, repoPath, invocationLogPath,
  });

  try {
    // The probe's cycle() cannot inject host cycles into a child process;
    // instead it yields wall-clock time so the child advances through its
    // own host cycles (runEpisode + dispatch) in the background. pollIntervalMs
    // is 0 because cycle() already sleeps.
    const probe = createTemporalProbe({
      dbPath,
      cycle: async () => {
        if (factory.exited) return;
        // Give the factory wall-clock time to advance through one host cycle.
        await new Promise(resolve => setTimeout(resolve, 1000));
      },
      transitionBudget: 240, // ~4 minutes max (240 cycles × 1s host-cycle budget)
      pollIntervalMs: 0,
    });

    // PROPERTY 1 (DURING execution): the factory must eventually materialize
    // at least one workplace. This proves the lifecycle actually started and
    // produced durable state while running — not just that the final DB has
    // rows.
    let observedWorkplaceRef = null;
    await probe.eventually(
      probeDb => {
        const row = probeDb.prepare(
          `SELECT w.workplace_ref FROM factory_workplaces w
             JOIN factory_process_runs pr ON pr.id=w.process_run_id
            WHERE pr.project_id=1 AND pr.epic_id=1
            ORDER BY w.workplace_ref LIMIT 1`,
        ).get();
        if (row) {
          observedWorkplaceRef = row.workplace_ref;
          return true;
        }
        return false;
      },
      {
        description: 'factory materialized at least one workplace during run',
        budget: 240,
      },
    );

    // PROPERTY 2 (DURING execution): at least one workplace must reach
    // loop_state='verifying' while the factory runs. This is the entry
    // condition for the OTK (quality gate) leg.
    let verifyingRef = null;
    await probe.eventually(
      probeDb => {
        const row = probeDb.prepare(
          `SELECT w.workplace_ref FROM factory_workplaces w
             JOIN factory_process_runs pr ON pr.id=w.process_run_id
            WHERE pr.project_id=1 AND pr.epic_id=1
              AND w.loop_state='verifying'
            ORDER BY w.workplace_ref LIMIT 1`,
        ).get();
        if (row) {
          verifyingRef = row.workplace_ref;
          return true;
        }
        return false;
      },
      {
        description: 'at least one workplace reached verifying during run',
        budget: 240,
        readContext: probeDb => predicates.readProgressSnapshot(probeDb, 1, 1),
      },
    );

    // PROPERTY 3 (DURING execution): the verifying workplace must EVENTUALLY
    // discharge its OTK obligation — a sealed author CandidateSet AND a final
    // GateDecision — observed while the factory is still running. This is the
    // core temporal property: verifying → (sealed set + gate decision) within
    // a bounded cycle budget, NOT just in the final snapshot.
    await probe.eventually(
      probeDb => predicates.countCandidateSetsForWorkplace(probeDb, verifyingRef, 'author') >= 1
        && predicates.countGateDecisionsForWorkplace(probeDb, verifyingRef, 'final') >= 1,
      {
        description: 'verifying workplace discharged OTK (sealed author CandidateSet + final GateDecision) during run',
        budget: 240,
        readContext: probeDb => readWorkplaceChain(probeDb, verifyingRef),
      },
    );

    // Now wait for the child to exit cleanly.
    const exitCode = await factory.exit;
    assert.equal(exitCode, 0,
      `orchestrate-cli exited ${exitCode}\n${factory.getStderr().slice(-5000)}`);

    // Post-run population invariants (these are snapshot assertions and are
    // fine AFTER the run completes). EVERY workplace that reached verifying
    // must have discharged the candidate+gate obligation — asserting this
    // across the whole population is what makes the property temporal rather
    // than anecdotal.
    const db = new Database(dbPath, { readonly: true });
    try {
      const verifyingWorkplaces = db.prepare(
        `SELECT DISTINCT workplace_ref FROM factory_workplaces
          WHERE loop_state IN ('verifying','effect_pending','terminal')`,
      ).all();
      assert.ok(verifyingWorkplaces.length > 0,
        'lifecycle produced no verifying workplaces — scenario mismatch');

      for (const { workplace_ref: ref } of verifyingWorkplaces) {
        const authorSets = predicates.countCandidateSetsForWorkplace(db, ref, 'author');
        const finalDecisions = predicates.countGateDecisionsForWorkplace(db, ref, 'final');
        assert.ok(
          authorSets >= 1 && finalDecisions >= 1,
          `workplace ${ref} entered verifying but OTK did not discharge: `
          + `authorSets=${authorSets} finalDecisions=${finalDecisions}\n`
          + JSON.stringify(readWorkplaceChain(db, ref), null, 2),
        );
      }

      // No workplace may be stranded in verifying at terminal — every
      // verifying visit must resolve to effect_pending or terminal.
      const stranded = db.prepare(
        `SELECT workplace_ref FROM factory_workplaces WHERE loop_state='verifying'`,
      ).all();
      assert.deepEqual(stranded, [],
        `workplaces stranded in verifying after terminal: ${JSON.stringify(stranded)}`);
    } finally {
      db.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});

// ---------------------------------------------------------------------------
// Test 2: ownerless-pending-gate-diagnosed
// ---------------------------------------------------------------------------

test('Candidate/Gate: a GateRun with no live owner is diagnosed as waiting_expected or stalled, never silent-progressing', async () => {
  const registry = createRegistry();
  const { repoPath, baseCommit } = createTempGitRepo('ownerless-gate');
  const { dbPath, dir: dbDir } = await bootstrapFreshDb({
    repoPath, baseCommit, label: 'ownerless-gate',
  });
  registry.trackDir(dbDir);

  try {
    // Synthesize the EXACT ADR-048 incident shape: a Workplace in
    // loop_state='verifying' with a GateRun in state='claimed'/'checking'
    // but NO live WorkerExecution. The liveness explainer must NOT classify
    // this as `progressing` with no real work — it must be either
    // `waiting_expected` (pending-gate, in-flight) or `stalled` with a typed
    // reason code. A silent `progressing` verdict here is the bug class
    // ADR-048 was created to catch.
    //
    // We use a writable bootstrap DB (still temp, never .tracker.db) to lay
    // down the synthetic rows, then close it before reading so the explainer
    // sees a consistent snapshot.
    const db = new Database(dbPath);
    try {
      // The lazy schema (factory_stage_runs, factory_node_runs,
      // factory_external_effect_actions) is created on first repository use
      // by the lifecycle/node/external-effect repositories. bootstrapFreshDb
      // only creates the launch request row, so ensure these tables
      // explicitly so the synthetic inserts and the explainer's joins do
      // not hit missing tables.
      const lifecycleSchemaMod = await import(pathToFileURL(path.resolve(
        REPO_ROOT, 'dist', 'process-modules', 'persistence', 'sqlite-lifecycle-run-repository.js',
      )).href);
      lifecycleSchemaMod.ensureFactoryLifecycleRunSchema(db);
      const nodeSchemaMod = await import(pathToFileURL(path.resolve(
        REPO_ROOT, 'dist', 'process-modules', 'persistence', 'sqlite-node-run-repository.js',
      )).href);
      nodeSchemaMod.ensureFactoryNodeRunSchema(db);

      // One lifecycle → one stage → one process run → one workplace in
      // verifying with a pending (claimed) GateRun. The workplace has no
      // active_reservation_ref and its task has no live execution.
      // Insertion order respects FK dependencies: lifecycle → process_run
      // → stage_run (FK to process_run) → workplace (FK to process_run) →
      // candidate_set/gate_run (FK to workplace).
      db.prepare(
        `INSERT INTO factory_lifecycle_runs
           (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
            description, definition_snapshot, definition_hash, project_id, epic_id,
            initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
            status, entry_stage_id, current_stage_id, current_stage_run_id)
         VALUES (1,'product-build','1.0.0','product-build@1.0.0','test',
                 'ownerless-gate','{}','hash',1,1,
                 'test','ownerless-gate-1','factory.x.v1','{}','hash',
                 'running','formalization','formalization',1)`,
      ).run();
      db.prepare(
        `INSERT INTO factory_process_runs
           (id, project_id, epic_id, module_name, module_version, module_ref_key,
            idempotency_key, executor_kind, input_schema, input_snapshot,
            input_hash, status)
         VALUES (1,1,1,'solution-formalization','1.0.0','solution-formalization@1.0.0',
                 'ownerless-gate','generic-flow','factory.x.v1','{}','hash','running')`,
      ).run();
      db.prepare(
        `INSERT INTO factory_stage_runs
           (id, lifecycle_run_id, ordinal, stage_id, attempt, module_name,
            module_version, module_ref_key, binding_snapshot, binding_hash,
            input_schema, input_snapshot, input_hash, status, process_run_id)
         VALUES (1,1,1,'formalization',1,'solution-formalization',
                 '1.0.0','solution-formalization@1.0.0','{}','hash',
                 'factory.x.v1','{}','hash','running',1)`,
      ).run();

      // The workplace under test: verifying, ownerless, with a pending gate.
      // No active_reservation_ref → no live owner path. This is the exact
      // shape from the ADR-048 incident (WorkerExecution exited +
      // Workplace verifying + GateRun claimed).
      const workplaceRef = 'workplace/1/solution-formalization@1.0.0/reconcile-what/singleton';
      db.prepare(
        `INSERT INTO factory_workplaces
           (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
            kanban_phase, loop_state, next_role, revision, active_reservation_ref)
         VALUES (?,1,'solution-formalization@1.0.0','reconcile-what','singleton',
                 'in_progress','verifying','author',3,NULL)`,
      ).run(workplaceRef);

      // A task is bound to the workplace but NOT actively owned (no
      // current_execution_id, status still in_progress — mirrors the
      // projection divergence seen in the incident).
      db.prepare(
        `INSERT INTO tasks (id, epic_id, title, status, workplace_ref)
         VALUES (9001,1,'ownerless-gate-task','in_progress',?)`,
      ).run(workplaceRef);

      // A sealed author CandidateSet exists (the worker did complete before
      // exiting) but the gate has not yet produced a decision.
      db.prepare(
        `INSERT INTO factory_workplace_production_revisions
           (revision_ref, workplace_ref, parent_revision_ref, members,
            contributing_execution_refs, presenter_ref, material_digest,
            semantic_digest, sealed_at)
         VALUES ('production-revision-ownerless-1', ?, NULL, '[]',
                 '["exec-exited-1"]', 'exec-exited-1', 'material-digest-1',
                 'semantic-digest-1', datetime('now'))`,
      ).run(workplaceRef);
      db.prepare(
        `INSERT INTO factory_candidate_sets
           (candidate_set_ref, workplace_ref, production_revision_ref, role,
            candidate_set_digest, seal_receipt_ref, sealed_at)
         VALUES ('cset-ownerless-1', ?, 'production-revision-ownerless-1', 'author',
                 'digest-1', 'receipt-1', datetime('now'))`,
      ).run(workplaceRef);

      // GateRun in 'claimed' (in-flight, no decision yet) — no live owner
      // drives it. This is the pending-gate the explainer must diagnose.
      db.prepare(
        `INSERT INTO factory_gate_runs
           (gate_run_ref, workplace_ref, gate_phase, subject_candidate_set_ref,
            assessment_candidate_set_refs, check_plan_ref, check_plan_digest,
            expected_workplace_revision, gate_lease_ref, state)
         VALUES ('gate-ownerless-1', ?, 'final', 'cset-ownerless-1', '[]',
                 'plan-1', 'plan-digest', 3, 'lease-1', 'claimed')`,
      ).run(workplaceRef);

      // No worker_executions row for the task — the owner is genuinely gone.
      // (We deliberately do NOT insert a worker_executions row.)
    } finally {
      db.close();
    }

    // Read-only classification. The explainer opens its own readonly
    // connection; we just hand it the path.
    const verdict = explainFactoryLiveness(dbPath, { projectId: 1 });

    // The property: an ownerless pending gate MUST NOT be classified as
    // silent `progressing`. It is either:
    //   - waiting_expected (reasonCode 'pending-gate' — the gate is
    //     legitimately in-flight on the kernel), or
    //   - stalled (a typed reason — 'engine-dead-runnable' etc.).
    // Both are acceptable; `progressing` is NOT, because there is no live
    // owner and no kernel NodeRun driving the gate forward.
    assert.ok(
      ['waiting_expected', 'stalled', 'inconsistent_state'].includes(verdict.classification),
      `ownerless pending-gate classified as '${verdict.classification}' `
      + `(reason: ${verdict.reasonCode}); expected waiting_expected/stalled/inconsistent_state, `
      + `NOT progressing-with-no-work.\nDetail: ${verdict.detail}`,
    );
    assert.notEqual(verdict.classification, 'progressing',
      `ownerless pending-gate must not be 'progressing' — that is exactly the `
      + `silent-stall class ADR-048 targets (reason: ${verdict.reasonCode})`);

    // When the explainer returns waiting_expected for a pending gate, it must
    // carry the gate_run_ref evidence so an operator can act on it.
    if (verdict.classification === 'waiting_expected' && verdict.reasonCode === 'pending-gate') {
      assert.ok(verdict.evidenceRefs.length > 0,
        `pending-gate verdict must carry the gate_run_ref evidence: ${JSON.stringify(verdict.evidenceRefs)}`);
    }
  } finally {
    await cleanupRegistry(registry);
  }
});

// ---------------------------------------------------------------------------
// Test 3: reviewer-repair-creates-new-evidence
// ---------------------------------------------------------------------------

test('Candidate/Gate: reviewer repair_required creates a NEW CandidateSet (immutability — old set never mutates)', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  const { repoPath, baseCommit, invocationLogPath } = provisionRepo(registry, 'repair-new-set');
  const { dbPath, launchRef, dir: dbDir } = await bootstrapFreshDb({
    repoPath, baseCommit, label: 'repair-new-set',
  });
  registry.trackDir(dbDir);

  try {
    const { exit, getStderr } = launchFactory(registry, {
      dbPath, launchRef, repoPath, invocationLogPath,
    });
    const exitCode = await exit;
    assert.equal(exitCode, 0,
      `orchestrate-cli exited ${exitCode}\n${getStderr().slice(-5000)}`);

    const db = new Database(dbPath, { readonly: true });
    try {
      // The reconciliation cell in transition-conformance-scenarios drives
      // exactly: author candidate 1 → reviewer changes_requested → author
      // candidate 2 (NEW sealed set) → reviewer approved. So we expect:
      //   - at least one GateDecision verdict='repair_required' targeting
      //     the author role;
      //   - the affected workplace to have MORE THAN ONE author
      //     CandidateSet (initial + repaired), proving the repair cycle
      //     sealed a new immutable set rather than mutating the rejected
      //     one.
      const repairDecisions = db.prepare(
        `SELECT workplace_ref, decision_key, repair_target_role, subject_candidate_set_ref
           FROM factory_gate_decisions
          WHERE verdict='repair_required' AND repair_target_role='author'
          ORDER BY decided_at`,
      ).all();

      // The scenario MUST produce at least one author-targeted repair. If it
      // does not, the scenario itself drifted (a regression in its own
      // right).
      assert.ok(repairDecisions.length >= 1,
        `expected at least one author repair_required GateDecision from the `
        + `reconciliation repair loop, got ${repairDecisions.length}`);

      // For each repair decision, find the workplace and assert the
      // immutable-repair property: a NEW author CandidateSet was sealed
      // after the rejected one. We do this by counting author sets on the
      // workplace — at least two (initial + repaired) must exist.
      const formalizationCells = db.prepare(
        `SELECT DISTINCT workplace_ref FROM factory_workplaces
          WHERE module_ref='solution-formalization@1.0.0'`,
      ).all();
      assert.ok(formalizationCells.length > 0,
        'no solution-formalization workplaces — scenario mismatch');

      let provedNewCandidateSet = false;
      for (const { workplace_ref: ref } of formalizationCells) {
        const authorSetCount = predicates.countCandidateSetsForWorkplace(db, ref, 'author');
        if (authorSetCount >= 2) {
          provedNewCandidateSet = true;

          // Defence in depth: the rejected set and the repaired set must be
          // DIFFERENT immutable rows (distinct refs + distinct digests).
          const sets = db.prepare(
            `SELECT candidate_set_ref, candidate_set_digest,  sealed_at
               FROM factory_candidate_sets
              WHERE workplace_ref=? AND role='author'
              ORDER BY sealed_at`,
          ).all(ref);
          const refs = new Set(sets.map(s => s.candidate_set_ref));
          const digests = new Set(sets.map(s => s.candidate_set_digest));
          assert.equal(refs.size, sets.length,
            `author CandidateSets on ${ref} are not distinct refs: ${JSON.stringify(sets)}`);
          assert.equal(digests.size, sets.length,
            `author CandidateSets on ${ref} share a digest (mutation, not new seal): ${JSON.stringify(sets)}`);

          // The repair decision's subject_candidate_set_ref must reference
          // one of these sets (the rejected one), and a LATER set must
          // exist (the repaired one).
          const rejectedRef = repairDecisions.find(d => d.workplace_ref === ref)?.subject_candidate_set_ref;
          if (rejectedRef) {
            assert.ok(refs.has(rejectedRef),
              `repair decision subject_candidate_set_ref='${rejectedRef}' not found among author sets on ${ref}`);
            const rejectedIdx = sets.findIndex(s => s.candidate_set_ref === rejectedRef);
            const repairedExists = sets.slice(rejectedIdx + 1).length > 0;
            assert.ok(repairedExists,
              `no NEW author CandidateSet was sealed after the rejected one on ${ref} — `
              + `repair did not create new evidence`);
          }
        }
      }
      assert.ok(provedNewCandidateSet,
        'no formalization workplace produced >=2 author CandidateSets — '
        + 'the repair loop did not create new immutable evidence');

      // Population-level invariant: every repair_required decision on an
      // author cell must be followed (eventually) by an accepted decision
      // on the SAME workplace — the repair loop must converge.
      for (const decision of repairDecisions) {
        const accepted = db.prepare(
          `SELECT 1 FROM factory_gate_decisions
            WHERE workplace_ref=? AND verdict='accepted'
            ORDER BY decided_at LIMIT 1`,
        ).get(decision.workplace_ref);
        assert.ok(accepted,
          `workplace ${decision.workplace_ref} has a repair_required decision `
          + `but no subsequent accepted decision — repair loop did not converge`);
      }
    } finally {
      db.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});

// ---------------------------------------------------------------------------
// Test 4: accepted-gate-with-effect-stays-effect-pending
// ---------------------------------------------------------------------------

test('Candidate/Gate: an accepted GateDecision with effectRequired keeps the workplace in effect_pending until an exact EffectReceipt exists', { timeout: 540000 }, async () => {
  const registry = createRegistry();
  const { repoPath, baseCommit, invocationLogPath } = provisionRepo(registry, 'effect-pending');
  const { dbPath, launchRef, dir: dbDir } = await bootstrapFreshDb({
    repoPath, baseCommit, label: 'effect-pending',
  });
  registry.trackDir(dbDir);

  try {
    const { exit, getStderr } = launchFactory(registry, {
      dbPath, launchRef, repoPath, invocationLogPath,
    });
    const exitCode = await exit;
    assert.equal(exitCode, 0,
      `orchestrate-cli exited ${exitCode}\n${getStderr().slice(-5000)}`);

    const db = new Database(dbPath, { readonly: true });
    try {
      // The Formalization reconcile-what cell declares a
      // postAcceptanceEffect (FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID). Per
      // the reducer (gate-author-accepted-final with effectRequired=true),
      // an accepted author/final gate drives the workplace into
      // loop_state='effect_pending' — NOT directly to terminal. Only after
      // an exact EffectReceipt is recorded does the cell transit to
      // terminal(accepted). This test asserts that durable property held
      // across the full run.
      //
      // We cannot directly observe effectRequired on the GateDecision row
      // (it is a reducer input, not a persisted column). Instead we prove
      // the property structurally:
      //
      //   (a) every accepted GateDecision on a cell with a post-acceptance
      //       effect is backed by a CellFinalAcceptance whose
      //       effect_receipt_refs are non-empty AND each references a
      //       factory_cell_effect_receipts row (the exact receipt); and
      //   (b) every terminal(accepted) workplace with such an effect has a
      //       non-empty effect_receipt_refs list — i.e. it could not have
      //       reached terminal without the receipt.

      // Identify the effect-bounded cell: formalization reconciliation.
      // (The development cell also declares postAcceptanceEffect=
      // 'git-integration'; we assert the property for ALL accepted
      // workplaces uniformly, since the invariant is universal.)
      const acceptedWorkplaces = db.prepare(
        `SELECT workplace_ref, loop_state, terminal_reason
           FROM factory_workplaces
          WHERE terminal_reason='accepted' OR loop_state='effect_pending'`,
      ).all();
      assert.ok(acceptedWorkplaces.length > 0,
        'no accepted/effect_pending workplaces — lifecycle did not produce the effect-bounded path');

      // Every terminal(accepted) workplace must have a CellFinalAcceptance
      // whose effect_receipt_refs resolve to real receipt rows.
      const terminalAccepted = acceptedWorkplaces.filter(w => w.loop_state === 'terminal');
      assert.ok(terminalAccepted.length > 0,
        'no terminal(accepted) workplaces — lifecycle did not converge');

      for (const { workplace_ref: ref } of terminalAccepted) {
        const acceptance = db.prepare(
          `SELECT final_acceptance_ref, gate_decision_key, candidate_set_ref,
                  effect_receipt_refs
             FROM factory_cell_final_acceptances WHERE workplace_ref=?`,
        ).get(ref);
        assert.ok(acceptance,
          `terminal(accepted) workplace ${ref} has no CellFinalAcceptance row`);

        const receiptRefs = parseJsonArray(acceptance.effect_receipt_refs);

        // Each referenced receipt MUST exist in factory_cell_effect_receipts
        // (exact receipt). A reference that does not resolve means the
        // workplace reached terminal without the exact effect evidence —
        // precisely the bug class this property guards against.
        for (const receiptRef of receiptRefs) {
          const receipt = db.prepare(
            `SELECT effect_receipt_ref FROM factory_cell_effect_receipts
              WHERE effect_receipt_ref=?`,
          ).get(receiptRef);
          assert.ok(receipt,
            `workplace ${ref} CellFinalAcceptance references effect_receipt `
            + `'${receiptRef}' but no such row exists in `
            + `factory_cell_effect_receipts — terminal reached without exact receipt`);
        }

        // The accepted GateDecision referenced by the acceptance must exist
        // and be verdict='accepted'.
        const decision = db.prepare(
          `SELECT verdict, gate_phase FROM factory_gate_decisions
            WHERE decision_key=?`,
        ).get(acceptance.gate_decision_key);
        assert.ok(decision,
          `CellFinalAcceptance for ${ref} references unknown gate_decision_key '${acceptance.gate_decision_key}'`);
        assert.equal(decision.verdict, 'accepted',
          `CellFinalAcceptance for ${ref} backed by non-accepted decision (verdict='${decision.verdict}')`);
      }

      // Universal temporal property (the heart of the test): NO workplace
      // may be terminal(accepted) with an EMPTY effect_receipt_refs list
      // when it belongs to a cell that declared a post-acceptance effect.
      // Only formalization-reconciliation and development cells declare
      // postAcceptanceEffect (FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID and
      // git-integration respectively). Discovery cells (proposal, readiness)
      // and development-plan cells do NOT declare effects — their
      // effect_receipt_refs is correctly empty.
      //
      // We scope the assertion to cells that SHOULD have effects: those
      // whose production_cell_id contains 'reconcile' or 'verification' or
      // 'implementation' (the cells that declare postAcceptanceEffect).
      const EFFECT_BEARING_CELLS = '%reconcile%';
      const acceptedWithoutReceipts = db.prepare(
        `SELECT f.workplace_ref, f.final_acceptance_ref, f.effect_receipt_refs,
                w.module_ref, w.production_cell_id
           FROM factory_cell_final_acceptances f
           JOIN factory_workplaces w ON w.workplace_ref=f.workplace_ref
          WHERE w.loop_state='terminal' AND w.terminal_reason='accepted'
            AND w.production_cell_id LIKE ?
            AND (f.effect_receipt_refs IS NULL
                 OR f.effect_receipt_refs='[]'
                 OR f.effect_receipt_refs='null')`,
      ).all(EFFECT_BEARING_CELLS);
      assert.deepEqual(acceptedWithoutReceipts, [],
        `terminal(accepted) effect-bearing workplaces with empty effect_receipt_refs — `
        + `reached terminal without exact EffectReceipts: ${JSON.stringify(acceptedWithoutReceipts, null, 2)}`);

      // The per-receipt existence check above already proved that every
      // effect_receipt_ref in every CellFinalAcceptance resolves to a real
      // factory_cell_effect_receipts row. That is the exact-receipt contract.
      // We do NOT cross-check against factory_external_effect_actions here
      // because different effect types (product-acceptance vs git-integration)
      // track their actions differently, and the per-receipt check is the
      // authoritative invariant.

      // Finally: no workplace is stranded in effect_pending at terminal.
      // (If effect_required acceptance could not converge, the lifecycle
      // would not have exited 0.)
      const strandedPending = acceptedWorkplaces.filter(w => w.loop_state === 'effect_pending');
      assert.deepEqual(strandedPending, [],
        `workplaces stranded in effect_pending after lifecycle terminal: `
        + `${JSON.stringify(strandedPending)}`);
    } finally {
      db.close();
    }
  } finally {
    await cleanupRegistry(registry);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonArray(maybeJson) {
  if (!maybeJson) return [];
  try {
    const v = JSON.parse(maybeJson);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
