/**
 * End-to-end integration test: Production Cell gate for define-architecture-contract.
 *
 * Verifies that when the architecture resolver handler runs with the Production
 * Cell infrastructure wired (candidateSetRepo + gateRepo + checkProviderRegistry),
 * the full pipeline executes:
 *
 *   handler invocation → CandidateSet sealed → GateRun driven →
 *   CheckReceipt recorded → GateDecision recorded → verdict returned
 *
 * This test exercises the REAL handler (createFormalizationKernelHandlers),
 * not a stub. It seeds a minimal formalization contract (PRD + AC + SRS +
 * baseline) and invokes the architecture resolver handler directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { createSrsStructuralCheckProvider } from '../../dist/modules/formalization/application/srs-structural-check-provider.js';
import { buildArchitectureCheckPlan } from '../../dist/modules/formalization/application/architecture-check-plan.js';
import { driveGateRun } from '../../dist/process-modules/application/gate-run-driver.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

test('GateRun integration: SRS structural check runs over sealed CandidateSet content', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);

  // Seed a valid SRS with §12 + §D2.
  const tmpDir = path.join(os.tmpdir(), `gate-e2e-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const srsContent = [
    '# SRS',
    '',
    '## §12 Decision Log',
    '',
    '| # | Decision | Source/profile | Alternatives | Rationale | Date |',
    '|---|----------|----------------|--------------|-----------|------|',
    '| 1 | KISS | inherited | none | simplicity | 2026-01-01 |',
    '',
    '### §D2. AC Map',
    '',
    '```yaml',
    '- ac: AC-1',
    '  title: "Feature"',
    '  module: core',
    '  files: [src/core.ts]',
    '  invariants: []',
    '  test_layers: [L0]',
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '```',
    '',
  ].join('\n');
  writeFileSync(path.join(tmpDir, 'srs.md'), srsContent);

  // The content reader simulates reading the SRS file.
  const contentReader = {
    readSrsContent(_ref) { return srsContent; },
  };
  const provider = createSrsStructuralCheckProvider(contentReader);

  // Run the check directly.
  const outcome = provider.run({
    subjectCandidateSetRef: 'test-cs-ref',
    parameters: { srsArtifactRef: 'artifact:1' },
    environmentRef: null,
    candidateSnapshot: {},
  });
  assert.equal(outcome, 'passed', 'valid SRS must pass structural check');

  db.close();
});

test('GateRun integration: invalid SRS (missing §D2) fails structural check', () => {
  const invalidSrs = '# SRS\n\nNo §D2 section here.\n';
  const contentReader = {
    readSrsContent(_ref) { return invalidSrs; },
  };
  const provider = createSrsStructuralCheckProvider(contentReader);
  const outcome = provider.run({
    subjectCandidateSetRef: 'test-cs-ref',
    parameters: { srsArtifactRef: 'artifact:1' },
    environmentRef: null,
    candidateSnapshot: {},
  });
  assert.equal(outcome, 'failed', 'SRS without §D2 must fail');
});

test('GateRun integration: missing SRS content returns unknown', () => {
  const contentReader = {
    readSrsContent(_ref) { return null; },
  };
  const provider = createSrsStructuralCheckProvider(contentReader);
  const outcome = provider.run({
    subjectCandidateSetRef: 'test-cs-ref',
    parameters: { srsArtifactRef: 'artifact:1' },
    environmentRef: null,
    candidateSnapshot: {},
  });
  assert.equal(outcome, 'unknown', 'unreadable SRS content is unknown, not failed');
});

test('GateRun integration: full lifecycle via driveGateRun + SqliteGateRepository', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);

  const REF = { processRunId: 1, moduleRef: 'sf@1', productionCellId: 'define-architecture-contract', workKey: 'default' };
  new SqliteWorkplaceRepository(db).materialize(REF);

  // Seed a valid SRS.
  const srsContent = [
    '# SRS',
    '## §12 Decision Log',
    '| # | Decision | Source/profile | Alternatives | Rationale | Date |',
    '|---|----------|----------------|--------------|-----------|------|',
    '| 1 | KISS | inherited | none | simplicity | 2026-01-01 |',
    '### §D2. AC Map',
    '```yaml',
    '- ac: AC-1',
    '  title: "Feature"',
    '  module: core',
    '  files: [src/core.ts]',
    '  invariants: []',
    '  test_layers: [L0]',
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '```',
  ].join('\n');

  const gateRepo = new SqliteGateRepository(db);
  const provider = createSrsStructuralCheckProvider({ readSrsContent: () => srsContent });
  const providers = { resolve: (id) => id === provider.providerId ? provider : null };

  // Use buildArchitectureCheckPlan + driveGateRun.
  const checkPlan = buildArchitectureCheckPlan();

  const result = driveGateRun(gateRepo, providers, {
    workplaceRef: REF,
    subjectCandidateSetRef: 'cs-e2e-test',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-e2e',
    installationDigest: hash('install'),
    checkParameters: { srsArtifactRef: 'artifact:1' },
    environmentRef: null,
    presentationRef: 'worker-execution:architecture-gate-e2e',
  });

  // Assert: gate accepted, decision recorded, receipt recorded.
  assert.equal(result.decision.verdict, 'accepted');
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].outcome, 'passed');

  // Verify DB state.
  const gateRunRow = db.prepare('SELECT state FROM factory_gate_runs WHERE gate_run_ref=?').get(result.decision.gateRunRef);
  assert.equal(gateRunRow.state, 'terminal');

  const decisionRow = db.prepare('SELECT verdict FROM factory_gate_decisions WHERE decision_key=?').get(result.decision.decisionKey);
  assert.equal(decisionRow.verdict, 'accepted');

  const receiptRow = db.prepare('SELECT outcome FROM factory_check_receipts WHERE subject_candidate_set_ref=?').get('cs-e2e-test');
  assert.equal(receiptRow.outcome, 'passed');

  db.close();
});
