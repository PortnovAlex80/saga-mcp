// tests/process-modules/delivery-package-manifest.test.mjs
//
// W9-A5 — Delivery package manifest + flow-node protocols tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
// Task:  docs/refactor-management/05-subagent-tasks/W09-a5.md.
// Plan:  §0.12 (remaining production module migrations — mirrors the Wave 8
//        Formalization pilot), §8.2 (NodeProtocol), §3.5 (canonical-serializable),
//        §5.5.1 (resources resolved under package root).
//
// Coverage:
//   - The central `deliveryPackageManifest` is structurally valid
//     (`validateProcessModuleManifest` ok) and loads without throwing.
//   - It wraps the EXISTING `deliveryProcessModule` definition verbatim
//     (no duplication, no drift).
//   - resourceIndex: every entry is unique by logicalId, every path points at
//     a real resource on disk, every kind is a known ResourceKind, every
//     digest is the documented pending placeholder, every path is relative +
//     traversal-safe.
//   - handlerRefs: every logicalId matches a handler/adapter declared in the
//     delivery definition (kernel handlers + human adapters), unique by
//     logicalId, covers every `handler:`/`interactionContract:` field on the
//     flow nodes, and every digest is the real sha256 of the compiled handler
//     installation module (ADR-066 item 3 / plan item 15 — no placeholder).
//   - contractRefs: schemaId matches the wrapped definition's input/output
//     contracts.
//   - The manifest round-trips through canonical JSON (pure data, plan §3.5).
//   - Flow-node protocols: every NodeProtocolDefinition is structurally valid,
//     owning Flow node ids match the delivery Flow declarations, and the lane
//     self-check `validateDeliveryLaneProtocols()` reports ok.
//
// Imports run against the COMPILED dist/ output (node --test resolves .mjs
// against the repo root; production files live under
// dist/process-modules/modules/delivery/package/).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { deliveryPackageManifest } from '../../dist/process-modules/modules/delivery/package/manifest.js';
import {
  DELIVERY_RESOURCE_INDEX,
  DELIVERY_HANDLER_REFS,
  DELIVERY_KERNEL_HANDLER_REFS,
  DELIVERY_HUMAN_ADAPTER_REFS,
  DELIVERY_INPUT_CONTRACT_REF,
  DELIVERY_OUTPUT_CONTRACT_REF,
  DELIVERY_MANIFEST_FORMAT_VERSION,
  DELIVERY_RUNTIME_COMPATIBILITY_RANGE,
  DELIVERY_MODULE_KEY,
  DELIVERY_NODE_PROTOCOLS,
  DELIVERY_NODE_FLOW_IDS,
  validateDeliveryLaneProtocols,
} from '../../dist/process-modules/modules/delivery/package/index.js';
import { deliveryProcessModule } from '../../dist/process-modules/modules/delivery/delivery-process-module.js';
import {
  DELIVERY_KERNEL_HANDLER_IDS,
  DELIVERY_HUMAN_ADAPTER_IDS,
} from '../../dist/modules/delivery/domain/delivery-kernel-ports.js';
import {
  DELIVERY_RELEASE_CASE_SCHEMA,
  RELEASE_RECORD_SCHEMA,
} from '../../dist/modules/delivery/domain/delivery-schemas.js';
import { validateProcessModuleManifest } from '../../dist/process-modules/domain/spi/module-manifest.js';
import { validateNodeProtocolDefinition } from '../../dist/process-modules/domain/spi/node-protocol.js';
import { RESOURCE_KINDS } from '../../dist/process-modules/domain/spi/resource-index.js';
import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const RESOURCE_KIND_SET = new Set(RESOURCE_KINDS);

// ===========================================================================
// 1. Structural validity + identity.
// ===========================================================================

test('deliveryPackageManifest validates { ok: true }', () => {
  const result = validateProcessModuleManifest(deliveryPackageManifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('deliveryPackageManifest wraps the existing deliveryProcessModule definition', () => {
  // The manifest WRAPS the pure definition; it must not duplicate or drift.
  assert.equal(
    deliveryPackageManifest.definition,
    deliveryProcessModule,
    'manifest.definition must reference the existing deliveryProcessModule',
  );
});

test('manifestFormatVersion is the migrated "1" (not unsupported-0)', () => {
  assert.equal(deliveryPackageManifest.manifestFormatVersion, '1');
  assert.equal(DELIVERY_MANIFEST_FORMAT_VERSION, '1');
});

test('runtimeCompatibilityRange is a non-empty semver range', () => {
  assert.match(DELIVERY_RUNTIME_COMPATIBILITY_RANGE, /\^3\./);
  assert.equal(
    deliveryPackageManifest.runtimeCompatibilityRange,
    DELIVERY_RUNTIME_COMPATIBILITY_RANGE,
  );
});

test('DELIVERY_MODULE_KEY matches the wrapped definition identity', () => {
  const { name, version } = deliveryProcessModule.identity;
  assert.equal(DELIVERY_MODULE_KEY, `${name}@${version}`);
});

// ===========================================================================
// 2. Resource index.
// ===========================================================================

test('resourceIndex is non-empty and exported under the same array', () => {
  assert.ok(deliveryPackageManifest.resourceIndex.length > 0);
  assert.equal(deliveryPackageManifest.resourceIndex, DELIVERY_RESOURCE_INDEX);
});

test('every resource logicalId is unique', () => {
  const ids = DELIVERY_RESOURCE_INDEX.map((e) => e.logicalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate logicalIds: ${ids.join(', ')}`);
});

test('every resource kind is a known ResourceKind', () => {
  for (const entry of DELIVERY_RESOURCE_INDEX) {
    assert.ok(
      RESOURCE_KIND_SET.has(entry.kind),
      `unknown resource kind '${entry.kind}' for ${entry.logicalId}`,
    );
  }
});

test('every resource path points at a real file on disk (pinned, not global)', () => {
  // WAVE9 exit gate §2.1/§2.2: Delivery runs through pinned package resources
  // with no global resource lookup. Each declared path must resolve to a real
  // file under the repository root.
  for (const entry of DELIVERY_RESOURCE_INDEX) {
    const resolved = path.resolve(REPO_ROOT, entry.path);
    assert.ok(
      existsSync(resolved),
      `resource ${entry.logicalId} path does not exist on disk: ${entry.path}`,
    );
  }
});

test('every resource path is relative and traversal-safe', () => {
  for (const entry of DELIVERY_RESOURCE_INDEX) {
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
  for (const entry of DELIVERY_RESOURCE_INDEX) {
    assert.equal(entry.digest, 'pending@wave-2', entry.logicalId);
  }
});

// ===========================================================================
// 3. Handler / adapter refs.
// ===========================================================================

test('handlerRefs is non-empty and exported under the same array', () => {
  assert.ok(deliveryPackageManifest.handlerRefs.length > 0);
  assert.equal(deliveryPackageManifest.handlerRefs, DELIVERY_HANDLER_REFS);
});

test('handlerRefs is the union of kernel + human adapter refs', () => {
  // Commit 0088685 ("remove external node kind") removed the external adapter
  // concept entirely; handlerRefs are now the union of kernel + human only.
  assert.equal(
    DELIVERY_HANDLER_REFS.length,
    DELIVERY_KERNEL_HANDLER_REFS.length +
      DELIVERY_HUMAN_ADAPTER_REFS.length,
  );
});

test('every handler logicalId is unique', () => {
  const ids = DELIVERY_HANDLER_REFS.map((h) => h.logicalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate handler logicalIds: ${ids.join(', ')}`);
});

test('handlerRefs cover every kernel handler declared in the delivery definition', () => {
  const declared = new Set(DELIVERY_HANDLER_REFS.map((h) => h.logicalId));
  for (const id of Object.values(DELIVERY_KERNEL_HANDLER_IDS)) {
    assert.ok(declared.has(id), `kernel handler not pinned in handlerRefs: ${id}`);
  }
});

// (Commit 0088685 removed the external-adapter concept; the corresponding
// "handlerRefs cover every external adapter" test is deleted — no external
// adapters exist anymore.)

test('handlerRefs cover every human interaction adapter declared in the delivery definition', () => {
  const declared = new Set(DELIVERY_HANDLER_REFS.map((h) => h.logicalId));
  for (const id of Object.values(DELIVERY_HUMAN_ADAPTER_IDS)) {
    assert.ok(declared.has(id), `human adapter not pinned in handlerRefs: ${id}`);
  }
});

test('handlerRefs cover every handler/adapter/interaction field on the flow nodes', () => {
  const declared = new Set(DELIVERY_HANDLER_REFS.map((h) => h.logicalId));
  for (const node of deliveryProcessModule.flow.nodes) {
    if (node.kind === 'kernel' && node.handler && node.handler !== 'process-outcome-emitter') {
      assert.ok(declared.has(node.handler), `flow kernel node handler not pinned: ${node.handler}`);
    }
    if (node.kind === 'external' && node.adapter) {
      assert.ok(declared.has(node.adapter), `flow external node adapter not pinned: ${node.adapter}`);
    }
    if (node.kind === 'human' && node.interactionContract) {
      // Delivery's human node carries `interactionContract: { id }` (an object
      // ContractRef, not a bare string). The pinned handler-ref logicalId is
      // the adapter id that object's `id` names.
      const interactionId =
        typeof node.interactionContract === 'string'
          ? node.interactionContract
          : node.interactionContract.id;
      assert.ok(
        declared.has(interactionId),
        `flow human node interactionContract not pinned: ${interactionId}`,
      );
    }
  }
});

test('every handler digest is the real sha256 of the handler installation module (ADR-066 item 3)', () => {
  // Plan item 15: handlerRefs are content-addressed at manifest load. The
  // digest must be the sha256 of the SAME compiled module the composition
  // root imports to register these handlers/adapters — never a placeholder.
  // Recompute it here from the module bytes so the WIRING itself is under
  // test: if the manifest ever hashes the wrong file (or regresses to
  // 'pending@wave-2'), this fails. Raw-bytes sha256 via crypto (matches
  // computeResourceDigest; NOT canonical-json sha256Hex). Covers BOTH the
  // kernel handlers (createDeliveryKernelHandlers) and the human approval
  // adapter (createDeliveryHumanInteractions) — they share one installation
  // module, hence one digest.
  const implPath = path.join(
    REPO_ROOT,
    'dist/modules/delivery/application/delivery-installation.js',
  );
  const expected = createHash('sha256').update(readFileSync(implPath)).digest('hex');
  for (const h of DELIVERY_HANDLER_REFS) {
    assert.ok(h.version.length > 0, h.logicalId);
    assert.match(h.digest, /^[0-9a-f]{64}$/, h.logicalId);
    assert.notEqual(h.digest, 'pending@wave-2', h.logicalId);
    assert.equal(h.digest, expected, h.logicalId);
  }
});

// ===========================================================================
// 4. Contract refs.
// ===========================================================================

test('inputContractRef schemaId matches the wrapped definition inputContract', () => {
  assert.equal(DELIVERY_INPUT_CONTRACT_REF.schemaId, DELIVERY_RELEASE_CASE_SCHEMA);
  assert.equal(
    deliveryPackageManifest.inputContractRef.schemaId,
    deliveryProcessModule.inputContract.id,
  );
});

test('outputContractRef schemaId matches the wrapped definition outputContract', () => {
  assert.equal(DELIVERY_OUTPUT_CONTRACT_REF.schemaId, RELEASE_RECORD_SCHEMA);
  assert.equal(
    deliveryPackageManifest.outputContractRef.schemaId,
    deliveryProcessModule.outputContract.id,
  );
});

test('contractRef digests are the documented pending placeholder', () => {
  assert.equal(DELIVERY_INPUT_CONTRACT_REF.digest, 'pending@wave-2');
  assert.equal(DELIVERY_OUTPUT_CONTRACT_REF.digest, 'pending@wave-2');
});

// ===========================================================================
// 5. Purity: canonical round-trip (plan §3.5).
// ===========================================================================

test('deliveryPackageManifest round-trips through canonical JSON (pure data)', () => {
  const serialized = canonicalJson(deliveryPackageManifest);
  const parsed = JSON.parse(serialized);
  // Re-serialize the parsed value: identical bytes => canonically stable.
  assert.equal(canonicalJson(parsed), serialized);
  // sha256Hex over the manifest is stable (content-addressable).
  const h1 = sha256Hex(deliveryPackageManifest);
  const h2 = sha256Hex(parsed);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ===========================================================================
// 6. Flow-node protocols.
// ===========================================================================

test('DELIVERY_NODE_PROTOCOLS has one protocol per non-terminal delivery flow node', () => {
  const owningIds = new Set(DELIVERY_NODE_PROTOCOLS.map((p) => p.owningFlowNodeId));
  // The five non-terminal flow nodes each own exactly one protocol.
  for (const id of Object.values(DELIVERY_NODE_FLOW_IDS)) {
    assert.ok(owningIds.has(id), `no protocol owns flow node '${id}'`);
  }
  assert.equal(DELIVERY_NODE_PROTOCOLS.length, 5);
});

test('every delivery node protocol owningFlowNodeId matches a real flow node', () => {
  const flowNodeIds = new Set(deliveryProcessModule.flow.nodes.map((n) => n.id));
  for (const proto of DELIVERY_NODE_PROTOCOLS) {
    assert.ok(
      flowNodeIds.has(proto.owningFlowNodeId),
      `protocol ${proto.id} owns unknown flow node '${proto.owningFlowNodeId}'`,
    );
  }
});

test('every delivery node protocol is structurally valid', () => {
  for (const proto of DELIVERY_NODE_PROTOCOLS) {
    const result = validateNodeProtocolDefinition(proto);
    assert.equal(result.ok, true, `protocol ${proto.id}: ${JSON.stringify(result.errors)}`);
  }
});

test('validateDeliveryLaneProtocols reports the lane is structurally valid', () => {
  const result = validateDeliveryLaneProtocols();
  assert.equal(result.ok, true, `expected ok, got errors: ${JSON.stringify(result.errors)}`);
});

test('every delivery node protocol uses a supported retry semantics (not unsupported)', () => {
  for (const proto of DELIVERY_NODE_PROTOCOLS) {
    assert.notEqual(proto.retrySemantics, 'unsupported', proto.id);
    assert.ok(
      proto.retrySemantics === 'runtime-implemented-linear' ||
        proto.retrySemantics === 'runtime-implemented-backoff',
      `${proto.id}: unsupported retry semantics ${proto.retrySemantics}`,
    );
  }
});

test('every delivery node protocol round-trips through canonical JSON (pure data)', () => {
  for (const proto of DELIVERY_NODE_PROTOCOLS) {
    const serialized = canonicalJson(proto);
    const parsed = JSON.parse(serialized);
    assert.equal(canonicalJson(parsed), serialized);
    assert.match(sha256Hex(proto), /^[0-9a-f]{64}$/);
  }
});
