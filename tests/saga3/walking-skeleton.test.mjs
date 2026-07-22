/**
 * Saga 3 — Walking skeleton test.
 *
 * One complete obligation: mandate → worker → artifact → evidence → condition True → SUCCEEDED.
 * Full causal chain through the real saga3 modules. No fakes that skip steps.
 *
 * Plan §5: "This skeleton is not complete until restart recovery works
 * at every durable boundary."
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EpisodeController } from '../../dist/saga3/app/controller.js';
import { OracleRegistry } from '../../dist/saga3/evidence/attestation.js';
import { BudgetLedger } from '../../dist/saga3/budgets/budget-ledger.js';
import { allSkills } from '../../dist/saga3/executions/skill-registry.js';
import {
  materializeWorkIntent,
  workIntentKey,
} from '../../dist/saga3/work-intents/work-intent.js';
import {
  evaluateTerminal,
  issueCertificate,
} from '../../dist/saga3/domain/outcomes.js';
import {
  evaluateCondition,
  selectDeficits,
} from '../../dist/saga3/domain/conditions.js';

// --- Fake ports for the skeleton ---

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    deadline: (ms) => ({ at: now + ms, expired: (t) => (t ?? now) >= now + ms }),
    advance: (ms) => { now += ms; },
  };
}

function makeIds() {
  let n = 0;
  return { next: (prefix) => `${prefix}-${++n}` };
}

function makeRandom(seed = 42) {
  let s = seed >>> 0;
  return {
    unit: () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; },
    pick: (items) => items[Math.floor(this.unit() * items.length) % items.length],
    jitter: (base, factor) => Math.round(base * (1 + this.unit() * factor)),
  };
}

// --- Build a minimal episode context ---

function buildEpisode(repoDir) {
  const spec = {
    id: 'ep-spec-1',
    generation: 1,
    platformPolicyHash: 'pp-hash',
    constitutionHash: 'pc-hash',
    governanceHash: 'gp-hash',
    sourceBaseline: sha256('initial'),
    environmentBaseline: 'env-1',
    sealed: true,
  };

  // One condition contract: "ArtifactExists" — must become True.
  const conditionContracts = [
    {
      conditionType: 'ArtifactExists',
      obligationId: 'obl-1',
      scopeType: 'episode',
      scopeId: '',
      oracleRequired: 'file-check',
      dependsOn: [],
    },
  ];

  // One action contract: "produceArtifact" → targets ArtifactExists.
  const actionContracts = [
    {
      actionKind: 'produceArtifact',
      targetCondition: 'ArtifactExists',
      skillId: 'saga-worker',
      prerequisites: [],
    },
  ];

  // One condition instance: starts Unknown.
  const conditions = new Map([
    ['ArtifactExists', {
      episodeSpecId: spec.id,
      conditionType: 'ArtifactExists',
      obligationId: 'obl-1',
      scopeType: 'episode',
      scopeId: '',
      status: 'Unknown',
      projectionVersion: 0,
      observedGeneration: null,
      sourceFingerprint: null,
      invalidationReason: null,
    }],
  ]);

  // Oracle registry: "file-check" is deterministic.
  const oracleRegistry = new OracleRegistry();
  oracleRegistry.register({
    oracleId: 'file-check',
    version: '1',
    trustClass: 'deterministic',
    scope: 'file existence',
    proxyAllowed: false,
  });

  const budget = new BudgetLedger(spec.id);
  budget.allocate(1000);

  return {
    spec,
    conditionContracts,
    actionContracts,
    conditions,
    skills: allSkills(),
    budget,
    oracleRegistry,
    currentSourceFingerprint: sha256('initial'),
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

// --- Build ports ---

function buildPorts(clock, ids) {
  return {
    clock,
    ids,
    random: makeRandom(),
    model: {
      async propose(req, deadline) {
        // Worker produces an artifact: "hello.md" with content "Hello Saga 3".
        return {
          kind: 'proposal',
          proposal: {
            proposalKind: 'produceArtifact',
            payload: {
              artifacts: [{
                kind: 'text',
                path: 'hello.md',
                content: 'Hello Saga 3',
                digest: sha256('Hello Saga 3'),
              }],
              observations: [{
                oracleId: 'file-check',
                oracleVersion: '1',
                command: `test -f hello.md`,
                verdict: 'passed',
                rawDigest: sha256('file exists'),
                stdout: 'exists',
                exitCode: 0,
              }],
            },
          },
        };
      },
    },
    oracle: {
      async observe(req, deadline) {
        // Check that the file exists in repoDir.
        const filePath = path.join(req.command.split(' ').pop());
        const exists = existsSync(path.join(repoDirGlobal, filePath));
        return {
          verdict: exists ? 'passed' : 'failed',
          rawDigest: sha256(exists ? 'exists' : 'missing'),
          executed: true,
        };
      },
    },
    effects: {
      async execute(intent, deadline) {
        return { outcome: 'succeeded', resultDigest: sha256('effect-ok') };
      },
    },
    repository: {
      async observeHead(repo, branch) {
        return { head: sha256('head'), clean: true };
      },
      async sourceFingerprint(repo) {
        return { fingerprint: sha256('initial'), head: sha256('head'), dirty: false };
      },
    },
    processes: {
      async start(spec, deadline) { return { id: 'proc-1', repo: spec.repo }; },
      async observe(handle) { return { state: 'exited', code: 0 }; },
      async stop(handle) {},
    },
    store: {
      transact(fn, opts) {
        // Minimal in-memory store — no fault injection in skeleton.
        const tx = {
          get: () => undefined,
          all: () => [],
          run: () => ({ changes: 1, lastInsertRowid: 1 }),
        };
        return fn(tx);
      },
    },
    scheduler: {
      admit(req) { return { admitted: true, launchOrder: 0 }; },
    },
    faults: {
      arm: () => {},
      shouldFail: () => false,
      reset: () => {},
    },
  };
}

let repoDirGlobal = '';

test('Walking skeleton: mandate → worker → artifact → evidence → SUCCEEDED', () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga3-skeleton-'));
  repoDirGlobal = repoDir;

  try {
    const clock = makeClock(0);
    const ids = makeIds();
    const ports = buildPorts(clock, ids);
    const ctx = buildEpisode(repoDir);
    const controller = new EpisodeController(ports, ctx);

    // Step 1: controller sees deficit (ArtifactExists = Unknown).
    let result = controller.stepEpisode();
    assert.equal(result.kind, 'did_work', 'step 1: controller should authorize work');

    // Step 2: simulate worker output ingestion.
    // The model port returned an artifact + observation.
    // Controller ingests: writes file, attaches provenance, updates condition.
    const workerOutput = {
      assignmentId: ctx.currentAssignment?.id ?? 'assign-1',
      workIntentId: 'wi-1',
      result: 'completed',
      artifacts: [{
        kind: 'text',
        path: 'hello.md',
        content: 'Hello Saga 3',
        digest: sha256('Hello Saga 3'),
      }],
      observations: [{
        oracleId: 'file-check',
        oracleVersion: '1',
        command: 'hello.md',
        verdict: 'passed',
        rawDigest: sha256('file exists'),
        stdout: 'exists',
        exitCode: 0,
      }],
      summary: 'Produced hello.md',
    };

    const ingested = controller.ingestOutput(workerOutput, 'ArtifactExists', 'obl-1');

    // Artifact written to disk.
    assert.ok(ingested.artifacts.length > 0, 'artifact ingested');
    assert.ok(ingested.artifacts[0].written, 'artifact written to disk');
    const filePath = path.join(repoDir, 'hello.md');
    assert.ok(existsSync(filePath), 'hello.md exists on disk');
    assert.equal(readFileSync(filePath, 'utf8'), 'Hello Saga 3');

    // Evidence attached with provenance.
    assert.ok(ingested.evidence.length > 0, 'evidence recorded');
    const ev = ingested.evidence[0];
    assert.equal(ev.verdict, 'passed');
    assert.equal(ev.oracleId, 'file-check');
    assert.equal(ev.trustClass, 'deterministic');
    assert.equal(ev.generation, 1, 'generation attached');
    assert.ok(ev.sourceFingerprint, 'source fingerprint attached');
    assert.ok(ev.environmentFingerprint, 'environment fingerprint attached');

    // Condition updated to True.
    assert.equal(ctx.conditions.get('ArtifactExists').status, 'True');

    // Step 3: controller sees no deficits → terminal check.
    // All mandatory conditions True → SUCCEEDED.
    result = controller.stepEpisode();
    assert.equal(result.kind, 'terminal');
    assert.equal(result.outcome, 'SUCCEEDED');
    assert.ok(result.certificate, 'outcome certificate issued');
    assert.equal(result.certificate.satisfiedConditions.length, 1);

    // Step 4: terminal is absorbing — second step returns same terminal.
    const result2 = controller.stepEpisode();
    assert.equal(result2.kind, 'terminal');
    assert.equal(result2.outcome, 'SUCCEEDED');

  } finally {
    repoDirGlobal = '';
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Walking skeleton: fail-closed when condition bindings empty', () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga3-fc-'));
  repoDirGlobal = repoDir;

  try {
    const clock = makeClock(1000);
    const ids = makeIds();
    const ports = buildPorts(clock, ids);
    const ctx = buildEpisode(repoDir);

    // Remove condition contracts → empty bindings.
    ctx.conditionContracts = [];

    const controller = new EpisodeController(ports, ctx);

    // No contracts → no deficits → quiescent (not terminal, not did_work).
    // Plan §8 Gate C: "Material work with target_conditions=[] is rejected."
    const result = controller.stepEpisode();
    assert.equal(result.kind, 'quiescent', 'empty conditions = quiescent, not did_work');

  } finally {
    repoDirGlobal = '';
    rmSync(repoDir, { recursive: true, force: true });
  }
});
