/**
 * Saga 3 — Full pipeline test.
 *
 * Exercises the entire condition dependency graph:
 * MandatePresent → ConstitutionReady → ContractConsistent → ... → ObservationHealthy → SUCCEEDED.
 *
 * Each step: controller finds deficit → authorizes work → test simulates worker
 * output (artifact + evidence) → controller ingests → condition True → next deficit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EpisodeController } from '../../dist/saga3/app/controller.js';
import { OracleRegistry } from '../../dist/saga3/evidence/attestation.js';
import { BudgetLedger } from '../../dist/saga3/budgets/budget-ledger.js';
import { allSkills } from '../../dist/saga3/executions/skill-registry.js';
import {
  PIPELINE_CONDITIONS,
  PIPELINE_ACTIONS,
  DISPLAY_STAGES,
  MANDATORY_CONDITIONS,
  initialConditions,
} from '../../dist/saga3/domain/pipeline-contracts.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function makePorts() {
  return {
    clock: { now: () => 0, deadline: (ms) => ({ at: ms, expired: () => false }) },
    ids: { next: (p) => `${p}-1` },
    random: { pick: (i) => i[0], jitter: (b) => b, unit: () => 0.5 },
    model: { async propose() { return { kind: 'refusal', message: 'no model in test' }; } },
    oracle: { async observe() { return { verdict: 'passed', rawDigest: 'ok', executed: true }; } },
    effects: { async execute() { return { outcome: 'succeeded', resultDigest: 'ok' }; } },
    repository: {
      async observeHead() { return { head: 'h', clean: true }; },
      async sourceFingerprint() { return { fingerprint: 'fp', head: 'h', dirty: false }; },
    },
    processes: {
      async start() { return { id: 'p', repo: '.' }; },
      async observe() { return { state: 'exited', code: 0 }; },
      async stop() {},
    },
    store: { transact: (fn) => fn({ get: () => undefined, all: () => [], run: () => ({ changes: 1, lastInsertRowid: 1 }) }) },
    scheduler: { admit: () => ({ admitted: true, launchOrder: 0 }) },
    faults: { arm: () => {}, shouldFail: () => false, reset: () => {} },
  };
}

function makeContext(repoDir) {
  const spec = {
    id: 'spec-1', generation: 1,
    platformPolicyHash: 'pp', constitutionHash: 'pc', governanceHash: 'gp',
    sourceBaseline: sha256('init'), environmentBaseline: 'env-1', sealed: true,
  };

  const conditions = initialConditions(spec.id);
  // MandatePresent starts True (mandate was received).
  conditions.get('MandatePresent').status = 'True';
  conditions.get('MandatePresent').sourceFingerprint = 'fp';

  const oracleRegistry = new OracleRegistry();
  for (const c of PIPELINE_CONDITIONS) {
    oracleRegistry.register({
      oracleId: c.oracleRequired,
      version: '1',
      trustClass: 'deterministic',
      scope: c.conditionType,
      proxyAllowed: false,
    });
  }

  const budget = new BudgetLedger(spec.id);
  budget.allocate(10000);

  return {
    spec,
    conditionContracts: PIPELINE_CONDITIONS,
    actionContracts: PIPELINE_ACTIONS,
    conditions,
    skills: allSkills(),
    budget,
    oracleRegistry,
    currentSourceFingerprint: 'fp',
    currentEnvironmentFingerprint: 'env-1',
    repositoryRoot: repoDir,
    heldClaims: [],
    completedIntents: new Set(),
    dependencyEdges: [],
    certificate: null,
    leaseEpoch: 0,
    currentAssignment: null,
  };
}

function workerOutput(conditionType) {
  return {
    assignmentId: 'a',
    workIntentId: 'wi',
    result: 'completed',
    artifacts: [{ kind: 'text', path: `${conditionType}.md`, content: conditionType, digest: sha256(conditionType) }],
    observations: [{
      oracleId: PIPELINE_CONDITIONS.find((c) => c.conditionType === conditionType)?.oracleRequired ?? 'check',
      oracleVersion: '1',
      command: `${conditionType}.md`,
      verdict: 'passed',
      rawDigest: sha256('ok'),
      stdout: 'ok',
      exitCode: 0,
    }],
    summary: conditionType,
  };
}

test('Full pipeline: MandatePresent → ... → ObservationHealthy → SUCCEEDED', () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga3-pipe-'));
  try {
    const ports = makePorts();
    const ctx = makeContext(repoDir);
    const controller = new EpisodeController(ports, ctx);

    const steps = [];
    const conditionsToProduce = [
      'ConstitutionReady',
      'ContractConsistent',
      'BaselineFrozen',
      'ArchitectureReady',
      'PlanReady',
      'ImplementationComplete',
      'VerificationCurrent',
      'IntegrationComplete',
      'ReleaseReady',
      'ReleaseCompleted',
      'ObservationHealthy',
    ];

    for (const condType of conditionsToProduce) {
      // Controller should find this deficit and authorize work.
      const result = controller.stepEpisode();
      steps.push({ condition: condType, result: result.kind });
      assert.equal(result.kind, 'did_work', `${condType}: controller should authorize work`);

      // Simulate worker producing artifact + evidence.
      controller.ingestOutput(workerOutput(condType), condType, 'obl');
      assert.equal(ctx.conditions.get(condType).status, 'True', `${condType} should be True after ingestion`);

      // Artifact should be on disk.
      assert.ok(existsSync(path.join(repoDir, `${condType}.md`)), `${condType}.md on disk`);
    }

    // All conditions True → SUCCEEDED.
    const terminal = controller.stepEpisode();
    assert.equal(terminal.kind, 'terminal');
    assert.equal(terminal.outcome, 'SUCCEEDED');
    assert.ok(terminal.certificate);

    // Absorbing.
    const terminal2 = controller.stepEpisode();
    assert.equal(terminal2.kind, 'terminal');

    console.log(`Pipeline: ${steps.length} conditions produced, all artifacts on disk, SUCCEEDED certified.`);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
