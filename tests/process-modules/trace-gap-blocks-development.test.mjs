// Integration test: a traceability gap in Formalization blocks Development.
//
// After the saga4 cutover, traceability is enforced by the Formalization Process
// Module's settlement policy, NOT by a deleted `episode_transition` MCP tool.
// This test proves the end-to-end routing invariant:
//
//   broken trace edge  ->  settlement decision `inconsistent`
//                       ->  no `formalized` certificate
//                       ->  no Development ProcessRun/StageRun created
//
// The chain is exercised in two halves, exactly as the task specifies, because
// the full LifecycleOrchestrator is too heavy to construct against a unit DB:
//
//   Half A (real SQLite graph + full settlement):
//     Seed a formalization episode with a deliberately broken canonical trace
//     edge. Drive the REAL Saga3FormalizationEngine (composition-root entry
//     point) end-to-end. Assert: findFirstTraceabilityGap detects the gap;
//     the settlement decision is `inconsistent`; no `formalized` certificate is
//     issued; the persisted ProcessRun outcome is `inconsistent` (not formalized).
//
//   Half B (declarative routing invariant):
//     Assert directly against the canonical Product Delivery Lifecycle that an
//     `inconsistent` Formalization outcome routes to a TERMINAL target — not a
//     stage — so the orchestrator can never build a Development next-stage
//     command. Then assert empirically that running the formalization engine for
//     the broken-graph epic leaves zero ProcessRun rows projected onto the
//     development stage.
//
// The harness mirrors tests/process-modules/formalization-e2e-smoke.test.mjs:
// getDb() bootstraps the full schema from DB_PATH, we seed fixtures, then clean
// up the temp DB.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { canonicalJson } = await import('../../dist/saga3/shared/discovery-canonical.js');
const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteProcessOutcomeCertificateRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);
const { Saga3FormalizationEngine } = await import(
  '../../dist/engines/saga3-formalization-engine.js'
);
const {
  ReferenceFormalizationSettlementPolicy,
  SqliteFormalizationArtifactGraph,
} = await import(
  '../../dist/infrastructure/process-modules/formalization/sqlite-formalization-kernel.js'
);
const { routeProcessOutcome } = await import(
  '../../dist/process-modules/application/lifecycle-router.js'
);
const { productDeliveryLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { DEVELOPMENT_PROCESS_MODULE_REF } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);

// --- Harness -----------------------------------------------------------------

const FORMALIZATION_EPIC_ID = 100;
const DISCOVERY_EPIC_ID = 50;
const PROJECT_ID = 1;
const ACCEPTED_HASH = 'a'.repeat(64);

function makeTempDb() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga4-tracegap-'));
  process.env.DB_PATH = path.join(temp, 'e2e.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (?,'P','active')`).run(PROJECT_ID);
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (?,?,'Disc')`)
    .run(DISCOVERY_EPIC_ID, PROJECT_ID);
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (?,?,'Form')`)
    .run(FORMALIZATION_EPIC_ID, PROJECT_ID);
  // brief artifact lives in the discovery epic (PRD traces back to it cross-epic).
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (?,?,'Brief')`)
    .run(9999, PROJECT_ID);
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/**
 * Seed a formalization episode whose contract is complete (PRD/FR/NFR/UC/AC/SRS
 * all accepted, baseline clean, formalization task done+merged) EXCEPT for one
 * deliberately broken canonical trace edge.
 *
 * `brokenEdge` selects which canonical edge to omit:
 *   'ac-to-fr'   — AC-1 has no derived_from -> FR/NFR (FIRST gap the policy hits)
 *   'uc-to-fr'   — UC-1 has no covers -> FR
 *   'ac-to-uc'   — FR-derived AC-1 has no derived_from -> UC
 *
 * Every other canonical edge (PRD->brief, SRS->PRD, UC->PRD, AC->FR for the
 * non-broken ACs, AC->UC) is present, so the gap we inject is the ONLY gap.
 */
function seedCompleteGraphExcept(db, brokenEdge) {
  const ins = db.prepare(
    `INSERT INTO artifacts (id,project_id,epic_id,type,code,status,content_hash,accepted_hash,drift_state,path,title)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // brief (discovery epic)
  ins.run(1, PROJECT_ID, 9999, 'brief', null, 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/brief.md', 'Brief');
  // PRD
  ins.run(2, PROJECT_ID, FORMALIZATION_EPIC_ID, 'PRD', 'PRD', 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/prd.md', 'PRD');
  // FR / NFR
  ins.run(10, PROJECT_ID, FORMALIZATION_EPIC_ID, 'FR', 'FR-1', 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/fr-1.md', 'FR-1');
  ins.run(11, PROJECT_ID, FORMALIZATION_EPIC_ID, 'NFR', 'NFR-1', 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/nfr-1.md', 'NFR-1');
  // UC
  ins.run(20, PROJECT_ID, FORMALIZATION_EPIC_ID, 'UC', 'UC-1', 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/uc-1.md', 'UC-1');
  // ACs
  ins.run(30, PROJECT_ID, FORMALIZATION_EPIC_ID, 'AC', 'AC-1', 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/ac-1.md', 'AC-1');
  ins.run(31, PROJECT_ID, FORMALIZATION_EPIC_ID, 'AC', 'AC-2', 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/ac-2.md', 'AC-2');
  // SRS
  ins.run(40, PROJECT_ID, FORMALIZATION_EPIC_ID, 'SRS', 'SRS', 'accepted', ACCEPTED_HASH, ACCEPTED_HASH, 'clean', 'docs/srs.md', 'SRS');

  const trace = db.prepare(
    `INSERT INTO artifact_traces (source_id,target_type,target_id,link_type) VALUES (?,?,?,?)`,
  );
  // PRD -> brief
  trace.run(2, 'artifact', 1, 'derived_from');
  // SRS -> PRD
  trace.run(40, 'artifact', 2, 'derived_from');
  // UC -> PRD
  trace.run(20, 'artifact', 2, 'derived_from');
  // UC -> FR (covers) — omit when testing the UC->FR edge
  if (brokenEdge !== 'uc-to-fr') trace.run(20, 'artifact', 10, 'covers');

  // AC -> FR/NFR (derived_from). AC-1 is the broken one for ac-to-fr / ac-to-uc.
  if (brokenEdge !== 'ac-to-fr' && brokenEdge !== 'ac-to-uc') {
    trace.run(30, 'artifact', 10, 'derived_from');
  }
  // AC-2 is always fully traced so it is not the gap (isolates the break to AC-1).
  trace.run(31, 'artifact', 10, 'derived_from');
  // FR-derived ACs must also trace to the behavioural UC. Omit for AC-1 when
  // testing ac-to-uc.
  if (brokenEdge !== 'ac-to-uc') {
    trace.run(30, 'artifact', 20, 'derived_from');
  }
  trace.run(31, 'artifact', 20, 'derived_from');

  // Formalization task — done + merged, so areTasksReady() does not mask the
  // traceability gap (the policy checks the gap BEFORE tasks).
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,priority,task_kind,workflow_stage,execution_skill,execution_mode,integration_state,generation_key,tags,metadata)
     VALUES (?,?,?,?,?,'formalization.prd','formalization','saga-product','tracker_only',?,'g','[]','{}')`,
  ).run(70, FORMALIZATION_EPIC_ID, 'PRD task', 'done', 'high', 'merged');
}

function buildEngine(db) {
  const processRunRepo = new SqliteProcessRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const engine = new Saga3FormalizationEngine({
    db, processRunRepo, certificateRepo,
    resolveFormalizationCase: () => ({
      discoveryEpicId: DISCOVERY_EPIC_ID,
      formalizationEpicId: FORMALIZATION_EPIC_ID,
      discoveryCertificateRef: 'certificate:5',
      discoveryCertificateHash: 'd'.repeat(64),
      discoveryOutcome: 'go',
      initiatedBy: 'operator',
    }),
  });
  return { engine, processRunRepo, certificateRepo };
}

// ============================================================================
// Half A — real graph port detects the gap; full settlement returns inconsistent
// ============================================================================

test('Half A: graph port findFirstTraceabilityGap detects the broken AC->FR edge', () => {
  const { temp, db } = makeTempDb();
  try {
    seedCompleteGraphExcept(db, 'ac-to-fr');
    const graph = new SqliteFormalizationArtifactGraph(db);
    const gap = graph.findFirstTraceabilityGap(FORMALIZATION_EPIC_ID);
    assert.ok(gap, 'findFirstTraceabilityGap must return a non-null gap for the broken edge');
    assert.equal(gap.artifactType, 'AC');
    assert.equal(gap.artifactId, 30, 'the gap is on AC-1 (#30)');
    assert.match(gap.missingEdge, /derived_from → FR\/NFR/);
  } finally { cleanup(temp); }
});

test('Half A: graph port detects the broken UC->FR covers edge', () => {
  const { temp, db } = makeTempDb();
  try {
    seedCompleteGraphExcept(db, 'uc-to-fr');
    const graph = new SqliteFormalizationArtifactGraph(db);
    const gap = graph.findFirstTraceabilityGap(FORMALIZATION_EPIC_ID);
    assert.ok(gap);
    assert.equal(gap.artifactType, 'UC');
    assert.equal(gap.artifactId, 20);
    assert.match(gap.missingEdge, /covers → FR/);
  } finally { cleanup(temp); }
});

test('Half A: full Saga3FormalizationEngine returns `inconsistent` for the broken graph', async () => {
  const { temp, db } = makeTempDb();
  try {
    seedCompleteGraphExcept(db, 'ac-to-fr');
    const { engine } = buildEngine(db);
    const result = await engine.run({ projectId: PROJECT_ID, epicId: FORMALIZATION_EPIC_ID });
    assert.equal(result.outcome, 'inconsistent');
    assert.equal(result.processModule.kind, 'formalization');
    assert.equal(result.processOutcome.authority, 'formalization_settlement_policy');
  } finally { cleanup(temp); }
});

test('Half A: settlement reasonCodes include `traceability-gap` (the gap, not tasks/baseline)', () => {
  // Run the deterministic policy directly over the real SQLite graph + a
  // bundle derived from that graph. This is exactly what the adapter does, but
  // called here so we can inspect reasonCodes (the engine result does not
  // surface them).
  const { temp, db } = makeTempDb();
  try {
    seedCompleteGraphExcept(db, 'ac-to-fr');
    const graph = new SqliteFormalizationArtifactGraph(db);
    const policy = new ReferenceFormalizationSettlementPolicy();

    // Build a settlement input whose bundle matches the real accepted graph
    // (the policy fails closed on any bundle/graph mismatch).
    const artifacts = graph.readAcceptedArtifacts(FORMALIZATION_EPIC_ID);
    const baseline = graph.readAcceptanceBaselineHash(FORMALIZATION_EPIC_ID);
    const bundlePartial = {
      schemaVersion: 'saga3.solution-contract-certificate.v1',
      formalizationEpicId: FORMALIZATION_EPIC_ID,
      prdArtifactId: artifacts.prd,
      frArtifactIds: [...artifacts.frs],
      nfrArtifactIds: [...artifacts.nfrs],
      ruleArtifactIds: [...artifacts.rules],
      ucArtifactIds: [...artifacts.ucs],
      acArtifactIds: [...artifacts.acs],
      acceptanceBaselineHash: baseline.hash,
      srsArtifactId: artifacts.srs,
    };
    const bundleHash = createHash('sha256')
      .update(canonicalJson(bundlePartial))
      .digest('hex');
    const input = {
      schemaVersion: 'saga3.formalization-settlement-input.v1',
      formalizationEpicId: FORMALIZATION_EPIC_ID,
      discoveryCertificateRef: 'certificate:5',
      discoveryCertificateHash: 'd'.repeat(64),
      bundle: { ...bundlePartial, bundleHash },
    };
    const decision = policy.settle(graph, input);
    assert.equal(decision.decision, 'inconsistent');
    assert.ok(
      decision.reasonCodes.includes('traceability-gap'),
      `expected traceability-gap in reasonCodes, got ${JSON.stringify(decision.reasonCodes)}`,
    );
    assert.match(decision.rationale, /Traceability gap/);
  } finally { cleanup(temp); }
});

// ============================================================================
// Half A: no `formalized` certificate is issued
// ============================================================================

test('Half A: no `formalized` certificate is issued for the broken-graph epic', async () => {
  const { temp, db } = makeTempDb();
  try {
    seedCompleteGraphExcept(db, 'ac-to-fr');
    const { engine, certificateRepo } = buildEngine(db);
    await engine.run({ projectId: PROJECT_ID, epicId: FORMALIZATION_EPIC_ID });

    const certs = certificateRepo.list(PROJECT_ID, FORMALIZATION_EPIC_ID);
    assert.equal(certs.length, 1, 'a certificate is issued for every terminal outcome');
    // The certificate decision is `inconsistent`, never `formalized`.
    assert.notEqual(certs[0].decision, 'formalized');
    assert.equal(certs[0].decision, 'inconsistent');
    assert.equal(certs[0].authority, 'formalization_settlement_policy');
  } finally { cleanup(temp); }
});

test('Half A: persisted ProcessRun outcome is `inconsistent`, not `formalized`', async () => {
  const { temp, db } = makeTempDb();
  try {
    seedCompleteGraphExcept(db, 'ac-to-fr');
    const { engine, processRunRepo } = buildEngine(db);
    await engine.run({ projectId: PROJECT_ID, epicId: FORMALIZATION_EPIC_ID });

    const runs = processRunRepo.list(PROJECT_ID, FORMALIZATION_EPIC_ID);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed', 'the run is terminal');
    assert.equal(runs[0].localOutcome, 'inconsistent');
    assert.notEqual(runs[0].localOutcome, 'formalized');
    assert.equal(runs[0].projectedStage, 'formalization', 'run is projected onto formalization, not development');
  } finally { cleanup(temp); }
});

// ============================================================================
// Half B — routing invariant: `inconsistent` cannot create a Development run
// ============================================================================

test('Half B: lifecycle routes `inconsistent` Formalization outcome to a terminal, not to Development', () => {
  const formalizationStage = productDeliveryLifecycle.stages.find(
    s => s.id === 'solution-formalization',
  );
  assert.ok(formalizationStage, 'formalization stage exists in the canonical lifecycle');

  const route = routeProcessOutcome(formalizationStage, 'inconsistent');
  // A terminal target means completeStage records no nextStage — the orchestrator
  // never builds a Development next-stage command, so no Development ProcessRun
  // or StageRun can be created for this outcome.
  assert.equal(route.target.type, 'terminal');
  assert.equal(route.target.status, 'formalization-inconsistent');
  assert.notEqual(route.target.type, 'stage');

  // Contrast: only `formalized` advances to the development stage.
  const formalizedRoute = routeProcessOutcome(formalizationStage, 'formalized');
  assert.equal(formalizedRoute.target.type, 'stage');
  assert.equal(formalizedRoute.target.stageId, 'solution-development');
});

test('Half B: running the formalization engine for a broken-graph epic leaves zero Development ProcessRuns', async () => {
  const { temp, db } = makeTempDb();
  try {
    seedCompleteGraphExcept(db, 'uc-to-fr');
    const { engine, processRunRepo } = buildEngine(db);
    await engine.run({ projectId: PROJECT_ID, epicId: FORMALIZATION_EPIC_ID });

    const allRuns = processRunRepo.list(PROJECT_ID, null); // unscoped: every run for the project
    const devRuns = allRuns.filter(
      r => r.moduleRef.name === DEVELOPMENT_PROCESS_MODULE_REF.name
        || r.projectedStage === 'development',
    );
    assert.equal(
      devRuns.length,
      0,
      `expected no Development ProcessRuns, got ${JSON.stringify(devRuns.map(r => ({ name: r.moduleRef.name, stage: r.projectedStage, outcome: r.localOutcome })))}`,
    );
    // And the single run that does exist is the (inconsistent) formalization run.
    const formRuns = allRuns.filter(r => r.projectedStage === 'formalization');
    assert.equal(formRuns.length, 1);
    assert.equal(formRuns[0].localOutcome, 'inconsistent');
  } finally { cleanup(temp); }
});
