// tests/installation/agent-launch-spec.test.mjs
//
// W3-A3 — AgentLaunchSpec activation tests (spec §6).
//
// Spec: docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md
//        §6 (W3-A3 — AgentLaunchSpec activation, after A2).
// Task: docs/refactor-management/05-subagent-tasks/W03-A3-agent-launch-spec.md.
//
// What this file proves:
//   1. PINNED path: a ProcessRun with non-null installationId resolves the
//      pinned module installation via the Wave 2 PackageRegistry (NOT the
//      catalog), verifies the pinned packageDigest, and projects the full
//      AgentLaunchSpec (resource digests, capability set, role, driver config).
//   2. LEGACY path (§14.3.7): a ProcessRun with NULL installationId falls
//      back to resolving the installation by moduleRef (name + exact version)
//      through the SAME PackageRegistry; the spec surfaces the null pin.
//   3. Determinism: two resolutions of the same (processRun, node) yield
//      structurally-equal AgentLaunchSpecs.
//   4. Digest mismatch on the pinned path throws PROCESS_RUN_PIN_DIGEST_MISMATCH.
//   5. Non-lm node yields a null executionProfileId and an empty role/driver
//      surface (no agent launched).
//   6. The Wave 2 thread is closed end-to-end: the sqlite repository surfaces
//      installationId/packageDigest on ProcessRunRecord through start + read,
//      and a legacy command (omitting the fields) stays null + replays clean.
//
// The resolver is exercised against a hand-rolled in-memory PackageRegistry
// (structural implementation of the Wave 2 port) — no sqlite, no catalog. This
// keeps the test focused on resolution logic and immune to catalog drift.
//
// Run: `node --test tests/installation/agent-launch-spec.test.mjs`

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

const { resolveAgentLaunchSpec } = await import(
  '../../dist/process-modules/application/agent-launch-spec.js'
);
const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ProcessModuleManifest`-shaped object with one LM node that
 * references an execution profile, plus declared capabilityRequirements and a
 * resourceIndex on the manifest. This is the shape the resolver projects from
 * `installation.manifestSnapshot`.
 */
function buildManifest({
  moduleName = 'w3a3-fixture-module',
  moduleVersion = '1.2.0',
  moduleKind = 'fixture',
  nodeId = 'produce-artifact',
  profileId = 'fixture-producer',
  executionSkill = 'saga-fixture-producer',
  reviewSkill = 'saga-fixture-reviewer',
  semanticSkill = 'fixture-semantic',
  protocolSkill = 'fixture-protocol',
  executionMode = 'git_change',
  allowedTools = ['fixture.tool.read', 'fixture.tool.write'],
  capabilityRefs = ['capability.fixture.read', 'capability.fixture.optional'],
  resourceLogicalIds = ['producer-skill', 'producer-checklist'],
} = {}) {
  return {
    manifestFormatVersion: '0.1.0',
    definition: {
      identity: {
        name: moduleName,
        version: moduleVersion,
        kind: moduleKind,
        displayName: 'W3-A3 Fixture',
        description: 'W3-A3 resolver fixture',
      },
      inputContract: { id: 'fixture.input.v1' },
      outputContract: { id: 'fixture.output.v1' },
      outcomes: [{ code: 'fixture-done', description: 'done', terminal: true }],
      flow: {
        id: 'fixture.flow',
        version: '1.0.0',
        entryNodeId: nodeId,
        nodes: [
          {
            id: nodeId,
            label: 'Produce',
            kind: 'lm',
            description: 'lm node',
            executionProfile: profileId,
          },
        ],
        transitions: [],
        terminalNodeIds: [nodeId],
      },
      artifacts: [],
      policies: [],
      invariants: [],
      executionProfiles: [
        {
          id: profileId,
          workIntentKind: moduleKind,
          workIntentSchema: { id: 'fixture.workintent.v1' },
          taskKind: `${moduleKind}.produce`,
          executionSkill,
          reviewSkill,
          protocolSkill,
          semanticSkill,
          executionMode,
          allowedTools,
          trackerTemplate: 'fixture-tracker',
          workspaceTemplates: [],
          callTemplates: [],
          checklists: [],
          outputSchema: { id: 'fixture.output.v1' },
          retryPolicy: { maxAttempts: 1, retryOn: [], backoff: 'none' },
          recoveryPolicy: {
            resumeFromCheckpoint: false,
            reuseWorkIntent: false,
            reuseAcceptedOutput: false,
            onExhausted: 'fail',
          },
        },
      ],
    },
    resourceIndex: resourceLogicalIds.map((logicalId) => ({
      logicalId,
      path: `resources/${logicalId}.md`,
      kind: logicalId.endsWith('checklist') ? 'checklist' : 'skill',
      digest: sha256Hex({ logicalId }),
    })),
    handlerRefs: [],
    inputContractRef: { schemaId: 'fixture.input.v1', version: '1.0.0', digest: 'd-in' },
    outputContractRef: { schemaId: 'fixture.output.v1', version: '1.0.0', digest: 'd-out' },
    runtimeCompatibilityRange: '^3.0.0',
    capabilityRequirements: capabilityRefs.map((ref, i) => ({
      ref,
      version: '1.0.0',
      optional: i === 1, // the 2nd declared capability is optional
    })),
  };
}

/**
 * Build a `ModuleInstallationRecord`-shaped object. `packageDigest` defaults to
 * a stable sha256; tests override it to construct mismatch scenarios.
 */
function buildInstallation({
  id = 42,
  name = 'w3a3-fixture-module',
  version = '1.2.0',
  manifest,
  packageDigest,
} = {}) {
  const resolvedManifest = manifest ?? buildManifest({ moduleName: name, moduleVersion: version });
  return {
    id,
    name,
    version,
    packageDigest: packageDigest ?? sha256Hex({ resolvedManifest }),
    manifestSnapshot: resolvedManifest,
    storeLocation: '<root>/fixture/',
    resourceIndex: resolvedManifest.resourceIndex,
    handlerRefs: [],
    dependencyLock: {},
    status: 'active',
    installedAt: '2026-07-29T00:00:00.000Z',
    activatedAt: '2026-07-29T00:00:01.000Z',
  };
}

/**
 * Hand-rolled in-memory `PackageRegistry` (structural implementation of the
 * Wave 2 port). `select` returns the installation whose name+exact-version
 * matches, or throws PACKAGE_NOT_INSTALLED — exactly the contract the
 * resolver depends on for BOTH the pinned and legacy paths.
 */
function fakeRegistry(installations) {
  return {
    select(selector) {
      const hit = installations.find(
        (r) => r.name === selector.name && r.version === selector.versionRange,
      );
      if (!hit) {
        const err = new Error(
          `PACKAGE_NOT_INSTALLED: name=${selector.name} versionRange=${selector.versionRange}`,
        );
        err.code = 'PACKAGE_NOT_INSTALLED';
        throw err;
      }
      return hit;
    },
    has(selector) {
      return installations.some(
        (r) => r.name === selector.name && r.version === selector.versionRange,
      );
    },
    registerInstallation() {},
    listSelectors() {
      return installations.map((r) => ({ name: r.name, versionRange: r.version }));
    },
  };
}

/**
 * Build a `ProcessRunRecord`-shaped object with only the fields the resolver
 * reads (the resolver reads moduleRef/moduleRefKey/installationId/packageDigest
 * + id). Extra fields are omitted — the resolver must not depend on them.
 */
function buildProcessRun({
  id = 7,
  name = 'w3a3-fixture-module',
  version = '1.2.0',
  installationId = 42,
  packageDigest,
  manifest,
} = {}) {
  const inst = buildInstallation({
    id: installationId ?? 42,
    name,
    version,
    manifest,
    packageDigest,
  });
  return {
    id,
    moduleRef: { name, version },
    moduleRefKey: `${name}@${version}`,
    installationId: installationId === undefined ? 42 : installationId,
    packageDigest: packageDigest === undefined ? inst.packageDigest : packageDigest,
  };
}

/** The LM node from the fixture manifest. */
function lmNode(manifest) {
  return manifest.definition.flow.nodes[0];
}

// ===========================================================================
// PINNED path (non-null installationId, spec §6).
// ===========================================================================

test('pinned run resolves via PackageRegistry and verifies the digest', () => {
  const manifest = buildManifest();
  const installation = buildInstallation({ manifest });
  const registry = fakeRegistry([installation]);
  const processRun = buildProcessRun({
    installationId: installation.id,
    packageDigest: installation.packageDigest,
    manifest,
  });

  const spec = resolveAgentLaunchSpec(processRun, lmNode(manifest), registry);

  // Pin surfaced verbatim.
  assert.equal(spec.installationId, installation.id);
  assert.equal(spec.packageDigest, installation.packageDigest);

  // Identity.
  assert.equal(spec.nodeId, 'produce-artifact');
  assert.equal(spec.executionProfileId, 'fixture-producer');
  assert.equal(
    spec.nodeProtocolId,
    'w3a3-fixture-module@1.2.0#produce-artifact',
    'nodeProtocolId is module-namespaced + stable',
  );

  // Resources projected from the pinned installation's resourceIndex.
  assert.equal(spec.resolvedResourceDigests.length, 2);
  assert.deepEqual(
    spec.resolvedResourceDigests.map((r) => r.logicalId),
    ['producer-skill', 'producer-checklist'],
  );
  for (const r of spec.resolvedResourceDigests) {
    assert.equal(r.digest, sha256Hex({ logicalId: r.logicalId }), 'real content digest');
  }

  // Effective capability set: only the REQUIRED capability (optional excluded)
  // plus the profile's allowed tools.
  assert.deepEqual(
    [...spec.effectiveCapabilitySet.requiredCapabilityRefs],
    ['capability.fixture.read'],
    'optional capability excluded',
  );
  assert.deepEqual(
    [...spec.effectiveCapabilitySet.allowedToolIds],
    ['fixture.tool.read', 'fixture.tool.write'],
  );

  // Role + driver config from the resolved profile.
  assert.equal(spec.authorOrReviewerRole.executionSkill, 'saga-fixture-producer');
  assert.equal(spec.authorOrReviewerRole.reviewSkill, 'saga-fixture-reviewer');
  assert.equal(spec.authorOrReviewerRole.semanticSkill, 'fixture-semantic');
  assert.equal(spec.authorOrReviewerRole.protocolSkill, 'fixture-protocol');
  assert.equal(spec.driverConfig.driverName, 'saga-board-claude');
  assert.equal(spec.driverConfig.executionMode, 'git_change');
  assert.equal(spec.driverConfig.trackerTemplate, 'fixture-tracker');
});

test('pinned path throws PROCESS_RUN_PIN_DIGEST_MISMATCH on a corrupt digest', () => {
  const manifest = buildManifest();
  const installation = buildInstallation({ manifest });
  const registry = fakeRegistry([installation]);
  // Run pinned to a DIFFERENT digest than the resolved installation carries.
  const processRun = buildProcessRun({
    installationId: installation.id,
    packageDigest: 'a1b2c3d4e5'.padEnd(64, '0'),
    manifest,
  });

  assert.throws(
    () => resolveAgentLaunchSpec(processRun, lmNode(manifest), registry),
    /PROCESS_RUN_PIN_DIGEST_MISMATCH/,
  );
});

test('pinned path throws PROCESS_RUN_PIN_DIGEST_MISMATCH when the resolved id differs', () => {
  const manifest = buildManifest();
  const installation = buildInstallation({ id: 42, manifest });
  const registry = fakeRegistry([installation]);
  // Run pinned to installationId=999 but the registry resolves id=42.
  const processRun = buildProcessRun({
    installationId: 999,
    packageDigest: installation.packageDigest,
    manifest,
  });

  assert.throws(
    () => resolveAgentLaunchSpec(processRun, lmNode(manifest), registry),
    /PROCESS_RUN_PIN_DIGEST_MISMATCH/,
  );
});

// ===========================================================================
// LEGACY path (null installationId, plan §14.3.7).
// ===========================================================================

test('legacy run (null installationId) resolves by moduleRef and surfaces null pin', () => {
  const manifest = buildManifest();
  const installation = buildInstallation({ manifest });
  const registry = fakeRegistry([installation]);
  const processRun = buildProcessRun({
    installationId: null,
    packageDigest: null,
    manifest,
  });

  const spec = resolveAgentLaunchSpec(processRun, lmNode(manifest), registry);

  // Legacy pin surfaced verbatim — null, NOT promoted to the resolved digest.
  assert.equal(spec.installationId, null);
  assert.equal(spec.packageDigest, null);

  // The resolved installation still drives the projection (resources, caps,
  // role). This proves the fallback resolved by name+version through the same
  // registry port.
  assert.equal(spec.resolvedResourceDigests.length, 2);
  assert.equal(spec.authorOrReviewerRole.executionSkill, 'saga-fixture-producer');
  assert.equal(spec.executionProfileId, 'fixture-producer');
});

test('legacy path rethrows PACKAGE_NOT_INSTALLED when no active installation matches', () => {
  const manifest = buildManifest();
  // Empty registry — nothing resolves.
  const registry = fakeRegistry([]);
  const processRun = buildProcessRun({
    installationId: null,
    packageDigest: null,
    manifest,
  });

  assert.throws(
    () => resolveAgentLaunchSpec(processRun, lmNode(manifest), registry),
    /PACKAGE_NOT_INSTALLED/,
  );
});

// ===========================================================================
// Determinism (spec: "two resolutions of the same (run, node) yield equal specs").
// ===========================================================================

test('resolveAgentLaunchSpec is deterministic for the same inputs', () => {
  const manifest = buildManifest();
  const installation = buildInstallation({ manifest });
  const registry = fakeRegistry([installation]);
  const processRun = buildProcessRun({
    installationId: installation.id,
    packageDigest: installation.packageDigest,
    manifest,
  });

  const a = resolveAgentLaunchSpec(processRun, lmNode(manifest), registry);
  const b = resolveAgentLaunchSpec(processRun, lmNode(manifest), registry);

  assert.deepEqual(a, b, 'same inputs → structurally-equal AgentLaunchSpec');
});

// ===========================================================================
// Non-lm node (null executionProfileId, empty role/driver surface).
// ===========================================================================

test('non-lm node yields null executionProfileId and an empty role surface', () => {
  const manifest = buildManifest();
  // Replace the LM node with a Kernel node (no executionProfile).
  const kernelNode = {
    id: 'verify',
    label: 'Verify',
    kind: 'kernel',
    description: 'kernel node',
    handler: 'verify-handler@1.0.0',
  };
  const installation = buildInstallation({ manifest });
  const registry = fakeRegistry([installation]);
  const processRun = buildProcessRun({
    installationId: installation.id,
    packageDigest: installation.packageDigest,
    manifest,
  });

  const spec = resolveAgentLaunchSpec(processRun, kernelNode, registry);

  assert.equal(spec.nodeId, 'verify');
  assert.equal(spec.executionProfileId, null, 'non-lm node has no profile');
  // The module-level capability/resource projection still runs (it does not
  // depend on the profile).
  assert.equal(spec.resolvedResourceDigests.length, 2);
  assert.deepEqual(
    [...spec.effectiveCapabilitySet.requiredCapabilityRefs],
    ['capability.fixture.read'],
  );
  assert.deepEqual(
    [...spec.effectiveCapabilitySet.allowedToolIds],
    [],
    'no profile → no allowed-tool surface',
  );
  // Role + driver surface empty for non-lm (no agent launched).
  assert.equal(spec.authorOrReviewerRole.executionSkill, '');
  assert.equal(spec.authorOrReviewerRole.reviewSkill, null);
  assert.equal(spec.driverConfig.driverName, '');
  assert.equal(spec.driverConfig.trackerTemplate, null);
});

// ===========================================================================
// End-to-end: the surfaced pin on ProcessRunRecord via the sqlite repository.
// (Wave 2 thread closed — spec §6 exit-gate item 5.)
// ===========================================================================

function freshDb() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w3a3-'));
  process.env.DB_PATH = path.join(temp, 'w3a3.db');
  const db = getDb();
  db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'P','active')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')").run();
  return { db, temp };
}

function cleanup(temp, previousDbPath) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  if (previousDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = previousDbPath;
  }
}

test('sqlite repo surfaces installationId/packageDigest on start + read (pinned)', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const repo = new SqliteProcessRunRepository(db);
    const payload = { case: 'pinned' };
    const { record, replayed } = repo.start({
      moduleRef: { name: 'w3a3-fixture-module', version: '1.2.0' },
      executorKind: 'generic-flow',
      projectedStage: 'fixture',
      input: {
        schema: 'fixture.input.v1',
        payload,
        contentHash: sha256Hex(payload),
      },
      installationId: 42,
      packageDigest: 'cafebabe'.padEnd(64, '0'),
      invocationContext: {
        projectId: 1,
        epicId: 10,
        initiatedBy: 'test',
        idempotencyKey: 'pinned-k1',
      },
    });

    assert.equal(replayed, false);
    assert.equal(record.installationId, 42, 'pin surfaced on start result');
    assert.equal(record.packageDigest, 'cafebabe'.padEnd(64, '0'));

    // read() round-trips the pin too.
    const reread = repo.read(record.id);
    assert.equal(reread.installationId, 42);
    assert.equal(reread.packageDigest, 'cafebabe'.padEnd(64, '0'));
  } finally {
    cleanup(temp, previous);
  }
});

test('sqlite repo: legacy command (omitting fields) stays null and replays clean', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const repo = new SqliteProcessRunRepository(db);
    const payload = { case: 'legacy' };
    // NOTE: installationId/packageDigest intentionally OMITTED — a pre-Wave-3
    // caller does not know about the fields. The repo MUST treat absent the
    // same as explicit null (legacy run) and MUST replay identically.
    const first = repo.start({
      moduleRef: { name: 'w3a3-fixture-module', version: '1.2.0' },
      executorKind: 'generic-flow',
      projectedStage: 'fixture',
      input: {
        schema: 'fixture.input.v1',
        payload,
        contentHash: sha256Hex(payload),
      },
      invocationContext: {
        projectId: 1,
        epicId: 10,
        initiatedBy: 'test',
        idempotencyKey: 'legacy-k1',
      },
    });

    assert.equal(first.record.installationId, null, 'omitted → null');
    assert.equal(first.record.packageDigest, null);
    assert.equal(first.replayed, false);

    // Replay with the SAME command shape (fields still omitted).
    const replay = repo.start({
      moduleRef: { name: 'w3a3-fixture-module', version: '1.2.0' },
      executorKind: 'generic-flow',
      projectedStage: 'fixture',
      input: {
        schema: 'fixture.input.v1',
        payload,
        contentHash: sha256Hex(payload),
      },
      invocationContext: {
        projectId: 1,
        epicId: 10,
        initiatedBy: 'test',
        idempotencyKey: 'legacy-k1',
      },
    });

    assert.equal(replay.replayed, true, 'same key + same input → replay');
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.installationId, null);
    assert.equal(replay.record.packageDigest, null);
  } finally {
    cleanup(temp, previous);
  }
});

test('sqlite repo: replaying a pinned run with a different digest throws', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const repo = new SqliteProcessRunRepository(db);
    const payload = { case: 'replay-mismatch' };
    const base = {
      moduleRef: { name: 'w3a3-fixture-module', version: '1.2.0' },
      executorKind: 'generic-flow',
      projectedStage: 'fixture',
      input: {
        schema: 'fixture.input.v1',
        payload,
        contentHash: sha256Hex(payload),
      },
      invocationContext: {
        projectId: 1,
        epicId: 10,
        initiatedBy: 'test',
        idempotencyKey: 'mismatch-k1',
      },
    };
    repo.start({ ...base, installationId: 5, packageDigest: 'first'.padEnd(64, '0') });

    // Same key, different packageDigest → IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT.
    assert.throws(
      () => repo.start({ ...base, installationId: 5, packageDigest: 'second'.padEnd(64, '0') }),
      /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT/,
    );
  } finally {
    cleanup(temp, previous);
  }
});
