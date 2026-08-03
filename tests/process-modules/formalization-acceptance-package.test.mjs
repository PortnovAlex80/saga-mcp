// tests/process-modules/formalization-acceptance-package.test.mjs
//
// W8-A4 — Acceptance + reconciliation node protocols + package-local resources.
//
// Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
// Task: docs/refactor-management/05-subagent-tasks/W08-a4.md.
// Plan: §0.11.5 + §0.11.11 (Formalization runs through pinned package resources).
//
// This test is the W8-A4 lane's verification surface. It imports:
//   - the W1-A4 NodeProtocolDefinition validator from dist/ (compiled src);
//   - the W1-A1 canonical-serialization guard from dist/ (compiled src);
//   - the W1-A2 ProcessModuleManifest validator + RESOURCE_KINDS from dist/;
//   - the package-local protocol + resource-index data from
//     modules/formalization/package/nodes/acceptance/.
//
// Coverage:
//   1. Every protocol in the acceptance + reconciliation subtree validates
//      { ok: true } against validateNodeProtocolDefinition (plan §8.2.11).
//   2. Every protocol + resource index entry is canonical-serializable and
//      round-trips through canonical JSON (plan §3.5).
//   3. Every protocol node id matches a node declared in the frozen
//      formalization ProcessModuleDefinition (no invented node identities).
//   4. The resource index is well-formed: unique logicalId, every path is
//      module-relative POSIX (no absolute / traversal), every kind is in the
//      frozen RESOURCE_KINDS set, every digest is the documented placeholder.
//   5. Closure: every resource path a protocol step references appears in the
//      resource index (no dangling resource references); every declared
//      authoring resource is referenced by at least one protocol step.
//   6. Reconciler authority boundary: the reconcile-what protocol does NOT
//      carry `artifact_create` in any step's allowedTools (only trace repair).
//   7. The on-disk resource files exist for every declared resource path
//      (Wave 2 content-addressed installer replaces the placeholder digests).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  validateNodeProtocolDefinition,
} from '../../dist/process-modules/domain/spi/node-protocol.js';
import {
  assertCanonicalSerializable,
} from '../../dist/process-modules/domain/spi/canonical-serialization.js';
import {
  canonicalJson,
  sha256Hex,
} from '../../dist/shared/canonical-json.js';
import {
  RESOURCE_KINDS,
} from '../../dist/process-modules/domain/spi/resource-index.js';
import {
  formalizationProcessModule,
} from '../../dist/process-modules/modules/formalization/formalization-process-module.js';

import {
  ACCEPTANCE_SUBTREE_NODE_PROTOCOLS,
  ACCEPTANCE_NODE_PROTOCOLS,
  RECONCILIATION_NODE_PROTOCOLS,
  ACCEPTANCE_NODE_IDS,
  RECONCILIATION_NODE_IDS,
  ACCEPTANCE_RESOURCE_PATHS,
  RECONCILIATION_RESOURCE_PATHS,
  ACCEPTANCE_RESOURCE_INDEX,
  ACCEPTANCE_RESOURCE_LOGICAL_IDS,
} from '../../modules/formalization/package/nodes/acceptance/index.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PACKAGE_ROOT = path.join(
  REPO_ROOT,
  'modules',
  'formalization',
  'package',
);

// ---------------------------------------------------------------------------
// 1. Every protocol in the subtree validates { ok: true }.
// ---------------------------------------------------------------------------

test('W8-A4: every acceptance + reconciliation protocol validates ok', () => {
  assert.ok(
    ACCEPTANCE_SUBTREE_NODE_PROTOCOLS.length === 5,
    `expected 5 protocols in subtree, got ${ACCEPTANCE_SUBTREE_NODE_PROTOCOLS.length}`,
  );
  for (const proto of ACCEPTANCE_SUBTREE_NODE_PROTOCOLS) {
    const result = validateNodeProtocolDefinition(proto);
    assert.ok(
      result.ok,
      `protocol ${proto.id} failed validation: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('W8-A4: acceptance pair has exactly the two expected protocols', () => {
  const ids = ACCEPTANCE_NODE_PROTOCOLS.map((p) => p.owningFlowNodeId).sort();
  assert.deepEqual(ids, [ACCEPTANCE_NODE_IDS.DEFINE, ACCEPTANCE_NODE_IDS.RESOLVE].sort());
});

test('W8-A4: reconciliation trio has exactly the three expected protocols', () => {
  const ids = RECONCILIATION_NODE_PROTOCOLS.map((p) => p.owningFlowNodeId).sort();
  assert.deepEqual(
    ids,
    [
      RECONCILIATION_NODE_IDS.RECONCILE,
      RECONCILIATION_NODE_IDS.RESOLVE,
      RECONCILIATION_NODE_IDS.FREEZE_BASELINE,
    ].sort(),
  );
});

// ---------------------------------------------------------------------------
// 2. Canonical-serializable + round-trip stable (plan §3.5).
// ---------------------------------------------------------------------------

test('W8-A4: every protocol is canonical-serializable and round-trips', () => {
  for (const proto of ACCEPTANCE_SUBTREE_NODE_PROTOCOLS) {
    assertCanonicalSerializable(proto);
    const serialized = canonicalJson(proto);
    const reparsed = JSON.parse(serialized);
    const reserialized = canonicalJson(reparsed);
    assert.equal(
      sha256Hex(proto),
      sha256Hex(reparsed),
      `protocol ${proto.id} digest changed across canonical-JSON round-trip`,
    );
    assert.equal(serialized, reserialized, `protocol ${proto.id} canonical form not stable`);
  }
});

test('W8-A4: resource index is canonical-serializable and round-trips', () => {
  assertCanonicalSerializable([...ACCEPTANCE_RESOURCE_INDEX]);
  const serialized = canonicalJson([...ACCEPTANCE_RESOURCE_INDEX]);
  const reparsed = JSON.parse(serialized);
  assert.equal(
    sha256Hex([...ACCEPTANCE_RESOURCE_INDEX]),
    sha256Hex(reparsed),
    'resource index digest changed across canonical-JSON round-trip',
  );
});

// ---------------------------------------------------------------------------
// 3. Every protocol node id exists in the frozen formalization Flow.
// ---------------------------------------------------------------------------

test('W8-A4: every owningFlowNodeId exists in the formalization Flow', () => {
  const flowNodeIds = new Set(
    formalizationProcessModule.flow.nodes.map((n) => n.id),
  );
  for (const proto of ACCEPTANCE_SUBTREE_NODE_PROTOCOLS) {
    assert.ok(
      flowNodeIds.has(proto.owningFlowNodeId),
      `protocol ${proto.id} references unknown flow node "${proto.owningFlowNodeId}"`,
    );
  }
});

test('W8-A4: every owningFlowNodeId matches the flow node kind contract', () => {
  const flowNodeById = new Map(
    formalizationProcessModule.flow.nodes.map((n) => [n.id, n]),
  );
  // LM-owned protocols must map to LM flow nodes; resolver/freezer protocols
  // must map to kernel flow nodes. Mirrors the flow's node kind declarations.
  const expected = new Map([
    [ACCEPTANCE_NODE_IDS.DEFINE, 'lm'],
    [ACCEPTANCE_NODE_IDS.RESOLVE, 'kernel'],
    [RECONCILIATION_NODE_IDS.RECONCILE, 'lm'],
    [RECONCILIATION_NODE_IDS.RESOLVE, 'kernel'],
    [RECONCILIATION_NODE_IDS.FREEZE_BASELINE, 'kernel'],
  ]);
  for (const proto of ACCEPTANCE_SUBTREE_NODE_PROTOCOLS) {
    const flowNode = flowNodeById.get(proto.owningFlowNodeId);
    const want = expected.get(proto.owningFlowNodeId);
    assert.equal(
      flowNode.kind,
      want,
      `flow node ${proto.owningFlowNodeId} expected kind ${want}, got ${flowNode.kind}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Resource index well-formedness.
// ---------------------------------------------------------------------------

test('W8-A4: resource index has unique logicalId', () => {
  const seen = new Set();
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
    assert.ok(
      !seen.has(entry.logicalId),
      `duplicate resource logicalId "${entry.logicalId}"`,
    );
    seen.add(entry.logicalId);
  }
});

test('W8-A4: every resource kind is in the frozen RESOURCE_KINDS set', () => {
  const valid = new Set(RESOURCE_KINDS);
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
    assert.ok(
      valid.has(entry.kind),
      `resource ${entry.logicalId} has unknown kind "${entry.kind}"`,
    );
  }
});

test('W8-A4: every resource digest uses the pending@wave-2 placeholder', () => {
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
    assert.equal(
      entry.digest,
      'pending@wave-2',
      `resource ${entry.logicalId} digest must be pending@wave-2 (Wave 2 installer replaces it), got "${entry.digest}"`,
    );
  }
});

test('W8-A4: every resource path is module-relative POSIX (no absolute / traversal)', () => {
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
    const p = entry.path;
    assert.ok(
      !path.isAbsolute(p),
      `resource ${entry.logicalId} path must be relative, got "${p}"`,
    );
    assert.ok(
      !p.includes('..'),
      `resource ${entry.logicalId} path must not traverse parent, got "${p}"`,
    );
    assert.ok(
      !p.includes('\\'),
      `resource ${entry.logicalId} path must be POSIX (forward slashes), got "${p}"`,
    );
  }
});

test('W8-A4: ACCEPTANCE_RESOURCE_LOGICAL_IDS mirrors the index', () => {
  const fromIndex = ACCEPTANCE_RESOURCE_INDEX.map((e) => e.logicalId);
  assert.deepEqual([...ACCEPTANCE_RESOURCE_LOGICAL_IDS], fromIndex);
});

// ---------------------------------------------------------------------------
// 5. Closure: protocol step resources <-> resource index.
// ---------------------------------------------------------------------------

test('W8-A4: every protocol step resource path is declared in the resource index', () => {
  const declared = new Set(ACCEPTANCE_RESOURCE_INDEX.map((e) => e.path));
  for (const proto of ACCEPTANCE_SUBTREE_NODE_PROTOCOLS) {
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

test('W8-A4: every declared authoring resource path is referenced by at least one step', () => {
  // Reviewer-skill resources (kind 'reviewer-skill') are consumed by the
  // execution profile's review pass (the reviewSkill field W8-A1 wires into
  // the central manifest), NOT by LM author/resolver steps. They are the
  // package-local replacements for the global saga-requirements-reviewer
  // skill (Wave 8 exit gate §0.11.11: no global skill lookup). Every other
  // declared resource MUST be referenced by at least one protocol step.
  const referenced = new Set();
  for (const proto of ACCEPTANCE_SUBTREE_NODE_PROTOCOLS) {
    for (const step of proto.steps) {
      for (const r of step.resources) referenced.add(r);
    }
  }
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
    if (entry.kind === 'reviewer-skill') continue;
    assert.ok(
      referenced.has(entry.path),
      `declared resource ${entry.logicalId} (${entry.path}) is not referenced by any protocol step`,
    );
  }
});

test('W8-A4: every reviewer-skill resource is declared and resolves on disk', () => {
  // The reviewer-skill resources are the package-local review-pass surface.
  // Asserted separately so the closure test above can stay strict for the
  // authoring resources.
  const reviewerSkills = ACCEPTANCE_RESOURCE_INDEX.filter(
    (e) => e.kind === 'reviewer-skill',
  );
  assert.equal(
    reviewerSkills.length,
    2,
    'expected exactly two reviewer-skill resources (acceptance + reconciliation)',
  );
  for (const entry of reviewerSkills) {
    const abs = path.join(PACKAGE_ROOT, entry.path);
    assert.ok(existsSync(abs), `reviewer skill ${entry.logicalId} missing at ${abs}`);
  }
});

test('W8-A4: ACCEPTANCE_RESOURCE_PATHS + RECONCILIATION_RESOURCE_PATHS match the index paths', () => {
  const indexPaths = new Set(ACCEPTANCE_RESOURCE_INDEX.map((e) => e.path));
  // Flatten the two constant objects WITHOUT spreading (spread would dedupe
  // the shared key names TRACE_CALL / DONE_CALL / CHECKLIST that both objects
  // legitimately carry, since acceptance and reconciliation each own their
  // own call-template siblings).
  const constantPaths = [
    ...Object.values(ACCEPTANCE_RESOURCE_PATHS),
    ...Object.values(RECONCILIATION_RESOURCE_PATHS),
  ];
  assert.equal(
    constantPaths.length,
    ACCEPTANCE_RESOURCE_INDEX.length,
    `constant path count (${constantPaths.length}) must match index entry count (${ACCEPTANCE_RESOURCE_INDEX.length})`,
  );
  for (const p of constantPaths) {
    assert.ok(
      indexPaths.has(p),
      `resource path constant "${p}" is not present in the resource index`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Reconciler authority boundary (no artifact_create).
// ---------------------------------------------------------------------------

test('W8-A4: reconcile-what protocol has no artifact_create in any step allowedTools', () => {
  const reconcileProto = RECONCILIATION_NODE_PROTOCOLS.find(
    (p) => p.owningFlowNodeId === RECONCILIATION_NODE_IDS.RECONCILE,
  );
  assert.ok(reconcileProto, 'reconcile-what protocol missing');
  for (const step of reconcileProto.steps) {
    assert.ok(
      !step.allowedTools.includes('artifact_create'),
      `reconcile-what step ${step.id} must NOT allow artifact_create (authority stays with the kernel gate)`,
    );
  }
});

test('W8-A4: acceptance author protocol DOES allow artifact_create', () => {
  const defineProto = ACCEPTANCE_NODE_PROTOCOLS.find(
    (p) => p.owningFlowNodeId === ACCEPTANCE_NODE_IDS.DEFINE,
  );
  assert.ok(defineProto, 'define-acceptance-contract protocol missing');
  const allTools = new Set(defineProto.steps.flatMap((s) => s.allowedTools));
  assert.ok(allTools.has('artifact_create'), 'AC author must be able to create artifacts');
});

test('W8-A4: baseline freezer protocol has empty authoring allowedTools', () => {
  const freezeProto = RECONCILIATION_NODE_PROTOCOLS.find(
    (p) => p.owningFlowNodeId === RECONCILIATION_NODE_IDS.FREEZE_BASELINE,
  );
  assert.ok(freezeProto, 'freeze-acceptance-baseline protocol missing');
  for (const step of freezeProto.steps) {
    assert.equal(
      step.allowedTools.length,
      0,
      `baseline freezer step ${step.id} must have no authoring tools (kernel-authority only)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. On-disk resource files exist for every declared path.
// ---------------------------------------------------------------------------

test('W8-A4: every declared resource path resolves to a file on disk', () => {
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
    const abs = path.join(PACKAGE_ROOT, entry.path);
    assert.ok(
      existsSync(abs),
      `resource ${entry.logicalId} file not found at ${abs}`,
    );
  }
});

test('W8-A4: every JSON resource file parses as valid JSON', () => {
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
    if (!entry.path.endsWith('.json')) continue;
    const abs = path.join(PACKAGE_ROOT, entry.path);
    const txt = readFileSync(abs, 'utf8');
    assert.doesNotThrow(
      () => JSON.parse(txt),
      `resource ${entry.logicalId} (${entry.path}) is not valid JSON`,
    );
  }
});

test('W8-A4: every JSON schema resource carries the matching $id', () => {
  const schemaIdByLogicalId = new Map([
    ['formalization.acceptance.bundle-schema', 'saga3.formalization-acceptance-bundle.v1'],
    ['formalization.reconciliation.report-schema', 'saga3.formalization-reconciliation-report.v1'],
    ['formalization.reconciliation.baseline-schema', 'saga3.acceptance-baseline-snapshot.v1'],
  ]);
  for (const entry of ACCEPTANCE_RESOURCE_INDEX) {
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
