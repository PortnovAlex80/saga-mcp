// tests/process-modules/discovery-package-manifest.test.mjs
//
// W9-A1 — Discovery package manifest + node protocols tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
// Task:  docs/refactor-management/05-subagent-tasks/W09-a1.md.
//
// Coverage:
//   - The central `discoveryPackageManifest` is structurally valid
//     (`validateProcessModuleManifest` ok) and loads without throwing.
//   - It wraps the EXISTING `discoveryProcessModule` definition verbatim
//     (no duplication, no drift).
//   - resourceIndex: every entry is unique by logicalId, every path points at
//     a real resource on disk, every kind is a known ResourceKind, every
//     digest is the documented pending placeholder.
//   - resourceIndex pins EVERY execution-profile skill/template/checklist so
//     the module needs no global resource lookup (WAVE9 exit gate §2).
//   - handlerRefs: every logicalId matches a discovery kernel handler, unique
//     by logicalId, and covers every `handler:` field on the flow's kernel
//     nodes (except the runtime-owned `process-outcome-emitter`).
//   - contractRefs: schemaId matches the wrapped definition's input/output
//     contracts.
//   - The manifest round-trips through canonical JSON (pure data, plan §3.5).
//   - Every LM-node NodeProtocolDefinition validates { ok: true } against
//     `validateNodeProtocolDefinition` and its owningFlowNodeId matches a
//     real flow node.
//   - Node-subtree resources: unique logicalId, real files on disk, known
//     kinds, traversal-safe paths, closure with the central resourceIndex.
//
// Imports run against the COMPILED dist/ output (node --test resolves .mjs
// against the repo root; production files live under
// dist/process-modules/modules/discovery/package/).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { discoveryPackageManifest } from '../../dist/process-modules/modules/discovery/package/manifest.js';
import {
  DISCOVERY_RESOURCE_INDEX,
  DISCOVERY_HANDLER_REFS,
  DISCOVERY_INPUT_CONTRACT_REF,
  DISCOVERY_OUTPUT_CONTRACT_REF,
  DISCOVERY_MANIFEST_FORMAT_VERSION,
  DISCOVERY_RUNTIME_COMPATIBILITY_RANGE,
  DISCOVERY_MODULE_KEY,
  DISCOVERY_HANDLER_IDS,
  DISCOVERY_CASE_SCHEMA,
  DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
} from '../../dist/process-modules/modules/discovery/package/index.js';
import { discoveryProcessModule } from '../../dist/process-modules/modules/discovery/discovery-process-module.js';
import { validateProcessModuleManifest } from '../../dist/process-modules/domain/spi/module-manifest.js';
import {
  validateNodeProtocolDefinition,
} from '../../dist/process-modules/domain/spi/node-protocol.js';
import { RESOURCE_KINDS } from '../../dist/process-modules/domain/spi/resource-index.js';
import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

// Node-subtree imports (package-local .mjs, resolved at runtime).
import {
  DISCOVERY_NODE_PROTOCOLS,
  DISCOVERY_NODE_RESOURCES,
  DISCOVERY_NODE_IDS,
  PROPOSAL_NODE_ID,
  PROPOSAL_NODE_RESOURCES,
  NORMALIZATION_NODE_ID,
  NORMALIZATION_NODE_RESOURCES,
  READINESS_NODE_ID,
  READINESS_NODE_RESOURCES,
} from '../../modules/discovery/package/nodes/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const RESOURCE_KIND_SET = new Set(RESOURCE_KINDS);

// ===========================================================================
// 1. Structural validity + identity.
// ===========================================================================

test('discoveryPackageManifest validates { ok: true }', () => {
  const result = validateProcessModuleManifest(discoveryPackageManifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('discoveryPackageManifest wraps the existing discoveryProcessModule definition', () => {
  // The manifest WRAPS the pure definition; it must not duplicate or drift.
  assert.equal(
    discoveryPackageManifest.definition,
    discoveryProcessModule,
    'manifest.definition must reference the existing discoveryProcessModule',
  );
});

test('manifestFormatVersion is the migrated "1" (not legacy-0)', () => {
  // Wave 9 bumps discovery from legacy-0 to '1' (populated resource/handler arrays).
  assert.equal(discoveryPackageManifest.manifestFormatVersion, '1');
  assert.equal(DISCOVERY_MANIFEST_FORMAT_VERSION, '1');
});

test('runtimeCompatibilityRange is a non-empty semver range', () => {
  assert.match(DISCOVERY_RUNTIME_COMPATIBILITY_RANGE, /\^3\./);
  assert.equal(
    discoveryPackageManifest.runtimeCompatibilityRange,
    DISCOVERY_RUNTIME_COMPATIBILITY_RANGE,
  );
});

test('DISCOVERY_MODULE_KEY matches the wrapped definition identity', () => {
  const { name, version } = discoveryProcessModule.identity;
  assert.equal(DISCOVERY_MODULE_KEY, `${name}@${version}`);
});

// ===========================================================================
// 2. Resource index.
// ===========================================================================

test('resourceIndex is non-empty and exported under the same array', () => {
  assert.ok(discoveryPackageManifest.resourceIndex.length > 0);
  assert.equal(discoveryPackageManifest.resourceIndex, DISCOVERY_RESOURCE_INDEX);
});

test('every resource logicalId is unique', () => {
  const ids = DISCOVERY_RESOURCE_INDEX.map((e) => e.logicalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate logicalIds: ${ids.join(', ')}`);
});

test('every resource kind is a known ResourceKind', () => {
  for (const entry of DISCOVERY_RESOURCE_INDEX) {
    assert.ok(
      RESOURCE_KIND_SET.has(entry.kind),
      `unknown resource kind '${entry.kind}' for ${entry.logicalId}`,
    );
  }
});

test('every resource path points at a real file on disk (pinned, not global)', () => {
  // WAVE9 exit gate §2: Discovery runs through pinned package resources with
  // no global resource lookup. Each declared path must resolve to a real file
  // under the repository root.
  for (const entry of DISCOVERY_RESOURCE_INDEX) {
    const resolved = path.resolve(REPO_ROOT, entry.path);
    assert.ok(
      existsSync(resolved),
      `resource ${entry.logicalId} path does not exist on disk: ${entry.path}`,
    );
  }
});

test('every resource path is relative and traversal-safe', () => {
  for (const entry of DISCOVERY_RESOURCE_INDEX) {
    assert.ok(
      !path.isAbsolute(entry.path),
      `resource ${entry.logicalId} path must be relative: ${entry.path}`,
    );
    assert.ok(
      !entry.path.includes('..'),
      `resource ${entry.logicalId} path must not traverse: ${entry.path}`,
    );
  }
});

test('every resource digest is the documented pending placeholder', () => {
  for (const entry of DISCOVERY_RESOURCE_INDEX) {
    assert.equal(entry.digest, 'pending@wave-2', entry.logicalId);
  }
});

test('resourceIndex pins every execution-profile skill + template + checklist referenced by the definition', () => {
  // Collect every skill/template/checklist string the execution profiles
  // reference. The resourceIndex must pin each so no global lookup is needed.
  const declared = new Set(DISCOVERY_RESOURCE_INDEX.map((e) => e.path));

  const referencedPaths = new Set();
  for (const profile of discoveryProcessModule.executionProfiles) {
    if (profile.executionSkill) referencedPaths.add(skillPath(profile.executionSkill));
    if (profile.reviewSkill) referencedPaths.add(skillPath(profile.reviewSkill));
    if (profile.semanticSkill) referencedPaths.add(skillPath(profile.semanticSkill));
    if (profile.protocolSkill) referencedPaths.add(skillPath(profile.protocolSkill));
    if (profile.trackerTemplate) referencedPaths.add(profile.trackerTemplate);
    for (const t of profile.workspaceTemplates ?? []) referencedPaths.add(t);
    for (const t of profile.callTemplates ?? []) referencedPaths.add(t);
    for (const c of profile.checklists ?? []) referencedPaths.add(c);
  }

  for (const ref of referencedPaths) {
    assert.ok(
      declared.has(ref),
      `execution-profile resource not pinned in resourceIndex: ${ref}`,
    );
  }
});

// ===========================================================================
// 3. Handler refs.
// ===========================================================================

test('handlerRefs is non-empty and exported under the same array', () => {
  assert.ok(discoveryPackageManifest.handlerRefs.length > 0);
  assert.equal(discoveryPackageManifest.handlerRefs, DISCOVERY_HANDLER_REFS);
});

test('every handler logicalId is unique', () => {
  const ids = DISCOVERY_HANDLER_REFS.map((h) => h.logicalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate handler logicalIds: ${ids.join(', ')}`);
});

test('handlerRefs cover every discovery-owned handler id', () => {
  // Every handler id the manifest pins (DISCOVERY_HANDLER_IDS) must appear.
  const declared = new Set(DISCOVERY_HANDLER_REFS.map((h) => h.logicalId));
  for (const id of Object.values(DISCOVERY_HANDLER_IDS)) {
    assert.ok(declared.has(id), `handler not pinned in handlerRefs: ${id}`);
  }
});

test('handlerRefs cover every module-owned handler declared on the flow kernel nodes', () => {
  // Every `handler:` field on a kernel node in the flow must be pinned, except
  // the runtime-owned `process-outcome-emitter`.
  const declared = new Set(DISCOVERY_HANDLER_REFS.map((h) => h.logicalId));
  for (const node of discoveryProcessModule.flow.nodes) {
    if (node.kind === 'kernel' && node.handler && node.handler !== 'process-outcome-emitter') {
      assert.ok(
        declared.has(node.handler),
        `flow kernel node handler not pinned: ${node.handler}`,
      );
    }
  }
});

test('every handler version is non-empty and digest is the pending placeholder', () => {
  for (const h of DISCOVERY_HANDLER_REFS) {
    assert.ok(h.version.length > 0, h.logicalId);
    assert.equal(h.digest, 'pending@wave-2', h.logicalId);
  }
});

// ===========================================================================
// 4. Contract refs.
// ===========================================================================

test('inputContractRef schemaId matches the wrapped definition inputContract', () => {
  assert.equal(DISCOVERY_INPUT_CONTRACT_REF.schemaId, DISCOVERY_CASE_SCHEMA);
  assert.equal(
    discoveryPackageManifest.inputContractRef.schemaId,
    discoveryProcessModule.inputContract.id,
  );
});

test('outputContractRef schemaId matches the wrapped definition outputContract', () => {
  assert.equal(DISCOVERY_OUTPUT_CONTRACT_REF.schemaId, DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA);
  assert.equal(
    discoveryPackageManifest.outputContractRef.schemaId,
    discoveryProcessModule.outputContract.id,
  );
});

test('contractRef digests are the documented pending placeholder', () => {
  assert.equal(DISCOVERY_INPUT_CONTRACT_REF.digest, 'pending@wave-2');
  assert.equal(DISCOVERY_OUTPUT_CONTRACT_REF.digest, 'pending@wave-2');
});

// ===========================================================================
// 5. Purity: canonical round-trip (plan §3.5).
// ===========================================================================

test('discoveryPackageManifest round-trips through canonical JSON (pure data)', () => {
  const serialized = canonicalJson(discoveryPackageManifest);
  const parsed = JSON.parse(serialized);
  // Re-serialize the parsed value: identical bytes => canonically stable.
  assert.equal(canonicalJson(parsed), serialized);
  // sha256Hex over the manifest is stable (content-addressable).
  const h1 = sha256Hex(discoveryPackageManifest);
  const h2 = sha256Hex(parsed);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ===========================================================================
// 6. Node protocols (LM-operated discovery nodes).
// ===========================================================================

test('DISCOVERY_NODE_PROTOCOLS is non-empty and frozen', () => {
  assert.ok(DISCOVERY_NODE_PROTOCOLS.length > 0);
  assert.ok(Object.isFrozen(DISCOVERY_NODE_PROTOCOLS));
});

test('every discovery node protocol validates { ok: true } against validateNodeProtocolDefinition', () => {
  for (const proto of DISCOVERY_NODE_PROTOCOLS) {
    const result = validateNodeProtocolDefinition(proto);
    assert.equal(
      result.ok,
      true,
      `protocol ${proto.id} failed validation: ${JSON.stringify(result.errors, null, 2)}`,
    );
  }
});

test('every discovery node protocol owningFlowNodeId matches a real flow node', () => {
  const flowNodeIds = new Set(discoveryProcessModule.flow.nodes.map((n) => n.id));
  for (const proto of DISCOVERY_NODE_PROTOCOLS) {
    assert.ok(
      flowNodeIds.has(proto.owningFlowNodeId),
      `protocol ${proto.id} references unknown flow node: ${proto.owningFlowNodeId}`,
    );
  }
});

test('every discovery node protocol owningFlowNodeId is an LM node', () => {
  const lmNodes = new Map(
    discoveryProcessModule.flow.nodes
      .filter((n) => n.kind === 'lm')
      .map((n) => [n.id, n]),
  );
  for (const proto of DISCOVERY_NODE_PROTOCOLS) {
    assert.ok(
      lmNodes.has(proto.owningFlowNodeId),
      `protocol ${proto.id} owns a non-LM node: ${proto.owningFlowNodeId}`,
    );
  }
});

test('DISCOVERY_NODE_IDS covers exactly the three LM-operated flow nodes', () => {
  // produce-proposal, normalize-semantic, assess-readiness are the LM nodes.
  // (diagnosis-advisor has no flow node — advisory-only profile.)
  const lmNodeIds = discoveryProcessModule.flow.nodes
    .filter((n) => n.kind === 'lm')
    .map((n) => n.id)
    .sort();
  assert.deepEqual([...DISCOVERY_NODE_IDS].sort(), lmNodeIds);
});

test('every node-subtree resource points at a real file on disk', () => {
  for (const entry of DISCOVERY_NODE_RESOURCES) {
    const resolved = path.resolve(REPO_ROOT, entry.path);
    assert.ok(
      existsSync(resolved),
      `node resource ${entry.logicalId} path does not exist on disk: ${entry.path}`,
    );
  }
});

test('node-subtree resources are unique by logicalId within each node', () => {
  // The shared `discovery.skill.process-protocol` is intentionally pinned by
  // every LM node (each worker loads it); it correctly repeats ACROSS nodes.
  // Within a single node's declared resource array, each logicalId is unique.
  // (A resource may be referenced by several steps of the same node — that is
  //  expected; this check is about the declared resource index, not step refs.)
  const perNodeResources = [
    { node: PROPOSAL_NODE_ID, resources: PROPOSAL_NODE_RESOURCES },
    { node: NORMALIZATION_NODE_ID, resources: NORMALIZATION_NODE_RESOURCES },
    { node: READINESS_NODE_ID, resources: READINESS_NODE_RESOURCES },
  ];
  for (const { node, resources } of perNodeResources) {
    const ids = resources.map((e) => e.logicalId);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `node ${node} declares a resource logicalId twice: ${ids.join(', ')}`,
    );
  }
});

test('node-subtree resource logicalIds only repeat for the shared process-protocol skill', () => {
  // The aggregate pins each logicalId at most once per node; the only cross-
  // node repeat is the shared process-protocol skill (each LM worker loads it).
  const allIds = DISCOVERY_NODE_RESOURCES.map((e) => e.logicalId);
  const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  for (const d of new Set(dupes)) {
    assert.equal(
      d,
      'discovery.skill.process-protocol',
      `unexpected cross-node duplicate logicalId: ${d}`,
    );
  }
});

test('node-subtree resources use known kinds + pending digests + traversal-safe paths', () => {
  for (const entry of DISCOVERY_NODE_RESOURCES) {
    assert.ok(RESOURCE_KIND_SET.has(entry.kind), `unknown kind ${entry.kind}`);
    assert.equal(entry.digest, 'pending@wave-2', entry.logicalId);
    assert.ok(!path.isAbsolute(entry.path), `absolute path ${entry.path}`);
    assert.ok(!entry.path.includes('..'), `traversal path ${entry.path}`);
  }
});

test('every node-subtree resource logicalId is also pinned by the central resourceIndex (closure)', () => {
  // The node subtree's resource logicalIds must be a SUBSET of the central
  // manifest's resourceIndex — the central manifest is the authoritative
  // superset and A1 owns it.
  const centralIds = new Set(DISCOVERY_RESOURCE_INDEX.map((e) => e.logicalId));
  for (const entry of DISCOVERY_NODE_RESOURCES) {
    assert.ok(
      centralIds.has(entry.logicalId),
      `node resource ${entry.logicalId} not pinned by central resourceIndex`,
    );
  }
});

test('every node-subtree resource path matches the central resourceIndex path for the same logicalId', () => {
  const centralByLogicalId = new Map(
    DISCOVERY_RESOURCE_INDEX.map((e) => [e.logicalId, e.path]),
  );
  for (const entry of DISCOVERY_NODE_RESOURCES) {
    assert.equal(
      entry.path,
      centralByLogicalId.get(entry.logicalId),
      `node resource ${entry.logicalId} path drifts from central resourceIndex`,
    );
  }
});

// ===========================================================================
// Helpers.
// ===========================================================================

/**
 * Map a bare skill name (e.g. 'saga-discovery-worker') to the on-disk SKILL.md
 * path the resourceIndex declares. Discovery execution profiles reference
 * skills by bare name; the package pins them at skills/<name>/SKILL.md.
 */
function skillPath(skillName) {
  return `skills/${skillName}/SKILL.md`;
}
