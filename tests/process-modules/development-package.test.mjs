// tests/process-modules/development-package.test.mjs
//
// W9-A3 — Development package manifest + planning node protocol +
// package-local resources + central exports.
//
// Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
// Task: docs/refactor-management/05-subagent-tasks/W09-a3.md.
// Plan: §0.12.5 + §0.12.12 (Development runs through pinned package resources).
//
// saga4 cutover (REAL-BUG #11): the dead `verificationNodeProtocol` orphan was
// removed. This test is the canary that caught it. The live verification
// pipeline runs through projected kanban tasks (`taskKind: 'verification.ac'` +
// the `saga-verifier` skill), NOT through a NodeProtocolDefinition. Only the
// planning node protocol remains under test here.
//
// This test is the W9-A3 lane's verification surface. It imports:
//   - the W1-A4 NodeProtocolDefinition validator from dist/ (compiled src);
//   - the W1-A1 canonical-serialization guard from dist/ (compiled src);
//   - the W1-A2 ProcessModuleManifest validator + RESOURCE_KINDS from dist/;
//   - the compiled development ProcessModuleDefinition from dist/;
//   - the package-local manifest + protocol + resource-index data from
//     modules/development/package/.
//
// Coverage:
//   1. The central manifest validates { ok: true } against
//      validateProcessModuleManifest (plan §3.5 / spec §1 row 5).
//   2. Every protocol (planning) validates { ok: true } against
//      validateNodeProtocolDefinition (plan §8.2.11) and is canonical-
//      serializable + round-trip stable.
//   3. Every protocol owningFlowNodeId matches a node declared in the frozen
//      development ProcessModuleDefinition (no invented node identities) and
//      matches the flow node kind contract.
//   4. The package resource index is well-formed: unique logicalId, every path
//      is package-relative POSIX (no absolute / traversal), every kind is in
//      the frozen RESOURCE_KINDS set, every digest is the documented placeholder.
//   5. Closure: every resource logicalId a protocol step references appears in
//      the resource index; every declared resource is referenced by at least
//      one protocol step (or is a reviewer skill — none here, all are authoring).
//   6. Authority boundaries: planning is tracker_only (no task_create / no
//      Git mutation tools).
//   7. The on-disk resource files exist for every declared resource path and
//      every JSON resource parses as valid JSON with the matching schema $id.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { validateProcessModuleManifest } from '../../dist/process-modules/domain/spi/module-manifest.js';
import { validateNodeProtocolDefinition } from '../../dist/process-modules/domain/spi/node-protocol.js';
import { assertCanonicalSerializable } from '../../dist/process-modules/domain/spi/canonical-serialization.js';
import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';
import { RESOURCE_KINDS } from '../../dist/process-modules/domain/spi/resource-index.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';

import {
  developmentPackageManifest,
  DEVELOPMENT_PACKAGE_RESOURCE_INDEX,
  DEVELOPMENT_PACKAGE_RESOURCE_LOGICAL_IDS,
  DEVELOPMENT_NODE_PROTOCOLS,
  planningNodeProtocol,
  PLANNING_NODE_ID,
} from '../../modules/development/package/index.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PACKAGE_ROOT = path.join(REPO_ROOT, 'modules', 'development', 'package');

// ---------------------------------------------------------------------------
// 1. Central manifest validates.
// ---------------------------------------------------------------------------

test('W9-A3: central manifest validates ok against validateProcessModuleManifest', () => {
  const result = validateProcessModuleManifest(developmentPackageManifest);
  assert.ok(
    result.ok,
    `manifest failed validation: ${JSON.stringify(result.errors)}`,
  );
});

test('W9-A3: manifest wraps the frozen development definition', () => {
  assert.equal(
    developmentPackageManifest.definition.identity.name,
    developmentProcessModule.identity.name,
  );
  assert.equal(
    developmentPackageManifest.definition.identity.version,
    developmentProcessModule.identity.version,
  );
  assert.equal(
    developmentPackageManifest.definition.flow.id,
    developmentProcessModule.flow.id,
  );
});

test('W9-A3: manifest carries rich input/output contract refs', () => {
  assert.equal(developmentPackageManifest.inputContractRef.schemaId, 'factory.development-case.v1');
  assert.equal(developmentPackageManifest.outputContractRef.schemaId, 'factory.verified-integration-bundle.v1');
  for (const ref of [developmentPackageManifest.inputContractRef, developmentPackageManifest.outputContractRef]) {
    assert.equal(ref.digest, 'pending@wave-2');
    assert.ok(ref.version.length > 0);
  }
});

test('W9-A3: manifest is canonical-serializable and round-trips', () => {
  assertCanonicalSerializable(developmentPackageManifest);
  const serialized = canonicalJson(developmentPackageManifest);
  const reparsed = JSON.parse(serialized);
  assert.equal(
    sha256Hex(developmentPackageManifest),
    sha256Hex(reparsed),
    'manifest digest changed across canonical-JSON round-trip',
  );
});

// ---------------------------------------------------------------------------
// 2. Protocols validate + are canonical-serializable.
// ---------------------------------------------------------------------------

test('W9-A3: package exposes exactly the planning protocol', () => {
  // saga4 cutover: verification/integration external nodes removed; Flow is
  // lm+kernel only. Only the planning node has a protocol.
  assert.equal(DEVELOPMENT_NODE_PROTOCOLS.length, 1, 'expected exactly one node protocol (plan-task-graph)');
  const ids = DEVELOPMENT_NODE_PROTOCOLS.map((p) => p.owningFlowNodeId).sort();
  assert.deepEqual(ids, [PLANNING_NODE_ID].sort());
});

test('W9-A3: every protocol validates ok', () => {
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    const result = validateNodeProtocolDefinition(proto);
    assert.ok(
      result.ok,
      `protocol ${proto.id} failed validation: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('W9-A3: every protocol is canonical-serializable and round-trips', () => {
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    assertCanonicalSerializable(proto);
    const serialized = canonicalJson(proto);
    const reparsed = JSON.parse(serialized);
    assert.equal(
      sha256Hex(proto),
      sha256Hex(reparsed),
      `protocol ${proto.id} digest changed across canonical-JSON round-trip`,
    );
    assert.equal(serialized, canonicalJson(reparsed), `protocol ${proto.id} canonical form not stable`);
  }
});

test('W9-A3: every protocol declares runtime-implemented-linear retry semantics', () => {
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    assert.equal(
      proto.retrySemantics,
      'runtime-implemented-linear',
      `protocol ${proto.id} retrySemantics must be runtime-implemented-linear`,
    );
  }
});

test('W9-A3: every protocol recovery entry step references an existing step', () => {
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    const stepIds = new Set(proto.steps.map((s) => s.id));
    assert.ok(proto.recoveryEntrySteps.length >= 1, `protocol ${proto.id} has no recovery entry step`);
    for (const re of proto.recoveryEntrySteps) {
      assert.ok(stepIds.has(re), `protocol ${proto.id} recovery entry "${re}" is not a known step`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Protocols bind to real development Flow nodes + kind contract.
// ---------------------------------------------------------------------------

test('W9-A3: every owningFlowNodeId exists in the frozen development Flow', () => {
  const flowNodeIds = new Set(developmentProcessModule.flow.nodes.map((n) => n.id));
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    assert.ok(
      flowNodeIds.has(proto.owningFlowNodeId),
      `protocol ${proto.id} references unknown flow node "${proto.owningFlowNodeId}"`,
    );
  }
});

test('W9-A3: every owningFlowNodeId matches the flow node kind contract', () => {
  const flowNodeById = new Map(developmentProcessModule.flow.nodes.map((n) => [n.id, n]));
  // saga4 cutover: Flow is lm+kernel only. plan-task-graph is the sole LM node.
  const expected = new Map([
    [PLANNING_NODE_ID, 'lm'],
  ]);
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    const flowNode = flowNodeById.get(proto.owningFlowNodeId);
    const want = expected.get(proto.owningFlowNodeId);
    assert.equal(
      flowNode.kind,
      want,
      `flow node ${proto.owningFlowNodeId} expected kind ${want}, got ${flowNode?.kind}`,
    );
  }
});

test('W9-A3: planning node id is the development Flow entry node', () => {
  assert.equal(developmentProcessModule.flow.entryNodeId, PLANNING_NODE_ID);
});

// ---------------------------------------------------------------------------
// 4. Resource index well-formedness.
// ---------------------------------------------------------------------------

test('W9-A3: resource index has unique logicalId', () => {
  const seen = new Set();
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    assert.ok(
      !seen.has(entry.logicalId),
      `duplicate resource logicalId "${entry.logicalId}"`,
    );
    seen.add(entry.logicalId);
  }
});

test('W9-A3: every resource kind is in the frozen RESOURCE_KINDS set', () => {
  const valid = new Set(RESOURCE_KINDS);
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    assert.ok(
      valid.has(entry.kind),
      `resource ${entry.logicalId} has unknown kind "${entry.kind}"`,
    );
  }
});

test('W9-A3: every resource digest uses the pending@wave-2 placeholder', () => {
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    assert.equal(
      entry.digest,
      'pending@wave-2',
      `resource ${entry.logicalId} digest must be pending@wave-2 (Wave 2 installer replaces it), got "${entry.digest}"`,
    );
  }
});

test('W9-A3: every resource path is package-relative POSIX (no absolute / traversal)', () => {
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    const p = entry.path;
    assert.ok(!path.isAbsolute(p), `resource ${entry.logicalId} path must be relative, got "${p}"`);
    assert.ok(!p.includes('..'), `resource ${entry.logicalId} path must not traverse parent, got "${p}"`);
    assert.ok(!p.includes('\\'), `resource ${entry.logicalId} path must be POSIX (forward slashes), got "${p}"`);
    assert.ok(
      p.startsWith('nodes/planning/'),
      `resource ${entry.logicalId} path must sit under the planning node subtree, got "${p}"`,
    );
  }
});

test('W9-A3: DEVELOPMENT_PACKAGE_RESOURCE_LOGICAL_IDS mirrors the index', () => {
  const fromIndex = DEVELOPMENT_PACKAGE_RESOURCE_INDEX.map((e) => e.logicalId);
  assert.deepEqual([...DEVELOPMENT_PACKAGE_RESOURCE_LOGICAL_IDS], fromIndex);
});

test('W9-A3: manifest resourceIndex === DEVELOPMENT_PACKAGE_RESOURCE_INDEX', () => {
  assert.equal(
    developmentPackageManifest.resourceIndex,
    DEVELOPMENT_PACKAGE_RESOURCE_INDEX,
    'manifest must surface the stitched package resource index by identity',
  );
});

// ---------------------------------------------------------------------------
// 5. Closure: protocol step resources <-> resource index.
// ---------------------------------------------------------------------------

test('W9-A3: every protocol step resource logicalId is declared in the resource index', () => {
  const declared = new Set(DEVELOPMENT_PACKAGE_RESOURCE_INDEX.map((e) => e.logicalId));
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    for (const step of proto.steps) {
      for (const r of step.resources) {
        assert.ok(
          declared.has(r),
          `protocol ${proto.id} step ${step.id} references undeclared resource "${r}"`,
        );
      }
    }
  }
});

test('W9-A3: every declared resource is referenced by at least one step', () => {
  const referenced = new Set();
  for (const proto of DEVELOPMENT_NODE_PROTOCOLS) {
    for (const step of proto.steps) {
      for (const r of step.resources) referenced.add(r);
    }
  }
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    assert.ok(
      referenced.has(entry.logicalId),
      `declared resource ${entry.logicalId} is not referenced by any protocol step`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Authority boundaries.
// ---------------------------------------------------------------------------

test('W9-A3: planning protocol is tracker_only (no task_create / no Git mutation)', () => {
  const forbidden = ['task_create', 'task_update', 'Bash', 'Write', 'Edit', 'git'];
  for (const step of planningNodeProtocol.steps) {
    for (const tool of forbidden) {
      assert.ok(
        !step.allowedTools.includes(tool),
        `planning step ${step.id} must NOT allow ${tool} (tracker_only authority)`,
      );
    }
  }
  // The planner's single authoritative write is process_node_submit + worker_done.
  const allTools = new Set(planningNodeProtocol.steps.flatMap((s) => s.allowedTools));
  assert.ok(allTools.has('process_node_submit'), 'planner must be able to submit the proposal');
  assert.ok(allTools.has('worker_done'), 'planner must be able to complete');
});

test('W9-A3: handler refs are unique and surface the kernel downstream handlers', () => {
  const ids = developmentPackageManifest.handlerRefs.map((h) => h.logicalId);
  assert.equal(new Set(ids).size, ids.length, 'handler ref logicalId must be unique');
  assert.ok(ids.includes('development-resolve-task-graph'), 'planning downstream resolver handler missing');
  // `development-settlement-policy` is the module-level settlement kernel handler
  // (DEVELOPMENT_KERNEL_HANDLER_IDS.settle, wired to settle-development). It was
  // re-homed from the deleted verificationNodeHandlerRefs orphan to the package
  // manifest level in REAL-BUG #11.
  assert.ok(ids.includes('development-settlement-policy'), 'settlement kernel handler ref missing');
  for (const h of developmentPackageManifest.handlerRefs) {
    assert.equal(h.digest, 'pending@wave-2');
  }
});

// ---------------------------------------------------------------------------
// 7. On-disk resource files exist + JSON validity + schema $id.
// ---------------------------------------------------------------------------

test('W9-A3: every declared resource path resolves to a file on disk', () => {
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    const abs = path.join(PACKAGE_ROOT, entry.path);
    assert.ok(existsSync(abs), `resource ${entry.logicalId} file not found at ${abs}`);
  }
});

test('W9-A3: every JSON resource file parses as valid JSON', () => {
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    if (!entry.path.endsWith('.json')) continue;
    const abs = path.join(PACKAGE_ROOT, entry.path);
    const txt = readFileSync(abs, 'utf8');
    assert.doesNotThrow(
      () => JSON.parse(txt),
      `resource ${entry.logicalId} (${entry.path}) is not valid JSON`,
    );
  }
});

test('W9-A3: every JSON schema resource carries the matching $id', () => {
  // saga4 cutover (REAL-BUG #11): the `verification-workset-schema` entry was
  // removed along with the deleted verification node protocol orphan; only the
  // planning proposal schema remains in the package resource index.
  const schemaIdByLogicalId = new Map([
    ['planning-task-graph-proposal-schema', 'factory.development-task-graph-proposal.v1'],
  ]);
  for (const entry of DEVELOPMENT_PACKAGE_RESOURCE_INDEX) {
    const expectedId = schemaIdByLogicalId.get(entry.logicalId);
    if (!expectedId) continue;
    const abs = path.join(PACKAGE_ROOT, entry.path);
    const doc = JSON.parse(readFileSync(abs, 'utf8'));
    assert.equal(
      doc.$id,
      expectedId,
      `resource ${entry.logicalId} $id must be ${expectedId}, got ${doc.$id}`,
    );
  }
});
