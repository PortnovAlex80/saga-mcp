// @ts-check
/**
 * W8-A3 — Use-case node protocol + package-local resources tests.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`
 * §1 (W8-A3), §2 (exit gate: pinned package resources, no global lookup).
 * Plan: §0.11, §8.2 (NodeProtocol), §3.5 (canonical serializability),
 * §7.4.3 / C065 (flow-condition ratchet).
 *
 * Verifies:
 *   1. `USE_CASE_NODE_PROTOCOL` passes the pure structural validator.
 *   2. Every declared `ResourceIndexEntry` resolves to a real file on disk
 *      under the package root (Wave 8: pinned package resources, no global
 *      lookup, no fallback context).
 *   3. Every step `resources[]` and the resource index use stable `logicalId`s.
 *   4. The protocol + resources round-trip through canonical JSON with a stable
 *      digest (plan §0.4.11 serial precondition).
 *   5. Structural invariants: entry step exists, transitions reference real
 *      steps, recovery entries reference real steps, no opaque flow conditions
 *      (C065 ratchet).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PACKAGE_ROOT = path.join(
  ROOT,
  'src',
  'process-modules',
  'modules',
  'formalization',
);

const {
  USE_CASE_NODE_PROTOCOL,
  USE_CASE_NODE_RESOURCES,
  USE_CASE_NODE_HANDLER_REFS,
  USE_CASE_OWNING_FLOW_NODE_ID,
  USE_CASE_RESOLVER_HANDLER_ID,
  validateUseCaseNodeProtocol,
} = await import(
  '../../dist/process-modules/modules/formalization/package/nodes/use-case/use-case-node-protocol.js'
);

const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

const PENDING_DIGEST = 'pending@wave-2';

// ---------------------------------------------------------------------------
// 1. Structural validation of the NodeProtocolDefinition.
// ---------------------------------------------------------------------------

test('USE_CASE_NODE_PROTOCOL passes the pure structural validator', () => {
  const result = validateUseCaseNodeProtocol();
  assert.equal(result.ok, true, `expected ok, got errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.errors.length, 0);
});

test('USE_CASE_NODE_PROTOCOL describes the model-use-cases flow node', () => {
  assert.equal(USE_CASE_NODE_PROTOCOL.owningFlowNodeId, USE_CASE_OWNING_FLOW_NODE_ID);
  assert.equal(USE_CASE_OWNING_FLOW_NODE_ID, 'model-use-cases');
  assert.equal(USE_CASE_NODE_PROTOCOL.retrySemantics, 'runtime-implemented-linear');
  // C065 ratchet: no opaque flow conditions on any transition.
  for (const t of USE_CASE_NODE_PROTOCOL.transitions) {
    assert.equal(t.condition, undefined, `transition ${t.from}->${t.to} must be unconditional`);
  }
});

test('USE_CASE_NODE_PROTOCOL steps form a linear chain from entryStep with reachable recovery entries', () => {
  const ids = new Set(USE_CASE_NODE_PROTOCOL.steps.map(s => s.id));
  assert.ok(ids.has(USE_CASE_NODE_PROTOCOL.entryStep), 'entryStep must be a real step');
  assert.equal(USE_CASE_NODE_PROTOCOL.entryStep, 'load-product-contract');
  // Every transition references existing steps.
  for (const t of USE_CASE_NODE_PROTOCOL.transitions) {
    assert.ok(ids.has(t.from), `transition.from ${t.from} is unknown`);
    assert.ok(ids.has(t.to), `transition.to ${t.to} is unknown`);
  }
  // Recovery entries reference real steps.
  assert.ok(
    USE_CASE_NODE_PROTOCOL.recoveryEntrySteps.length > 0,
    'must declare at least one recovery entry step',
  );
  for (const r of USE_CASE_NODE_PROTOCOL.recoveryEntrySteps) {
    assert.ok(ids.has(r), `recoveryEntrySteps entry ${r} is unknown`);
  }
  // Every step declares at least one evidence requirement.
  for (const s of USE_CASE_NODE_PROTOCOL.steps) {
    assert.ok(
      s.evidenceRequirements.length > 0,
      `step ${s.id} must declare evidence requirements`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Pinned package resources exist on disk (WAVE8 §0.11.11).
// ---------------------------------------------------------------------------

test('every declared USE_CASE_NODE_RESOURCE resolves to a real package-local file', () => {
  assert.ok(USE_CASE_NODE_RESOURCES.length >= 4, 'expected at least 4 pinned resources');
  const seenLogicalIds = new Set();
  for (const entry of USE_CASE_NODE_RESOURCES) {
    // Unique logicalId.
    assert.ok(
      !seenLogicalIds.has(entry.logicalId),
      `duplicate resource logicalId ${entry.logicalId}`,
    );
    seenLogicalIds.add(entry.logicalId);
    // Module-relative POSIX path, no traversal outside the package root.
    assert.ok(
      !entry.path.startsWith('/') && !entry.path.includes('..'),
      `resource ${entry.logicalId} path must be module-relative and non-traversing: ${entry.path}`,
    );
    assert.ok(
      entry.path.startsWith('package/nodes/use-case/resources/'),
      `resource ${entry.logicalId} must live under the use-case package root: ${entry.path}`,
    );
    // File exists on disk relative to the formalization module dir.
    const abs = path.join(PACKAGE_ROOT, ...entry.path.split('/'));
    assert.ok(existsSync(abs), `pinned resource missing on disk: ${entry.path} (${abs})`);
    assert.ok(statSync(abs).isFile(), `pinned resource is not a file: ${entry.path}`);
    // Wave 8 placeholder digest convention (Wave 2 installer fills the real hash).
    assert.equal(entry.digest, PENDING_DIGEST, `resource ${entry.logicalId} digest must be the Wave-2 placeholder`);
  }
});

test('every step resource references a declared ResourceIndexEntry logicalId', () => {
  const declared = new Set(USE_CASE_NODE_RESOURCES.map(r => r.logicalId));
  for (const step of USE_CASE_NODE_PROTOCOL.steps) {
    for (const ref of step.resources) {
      assert.ok(
        declared.has(ref),
        `step ${step.id} references undeclared resource logicalId '${ref}'`,
      );
    }
  }
});

test('USE_CASE_NODE_HANDLER_REFS references the use-case resolver handler', () => {
  assert.ok(USE_CASE_NODE_HANDLER_REFS.length >= 1, 'expected at least one handler ref');
  const ids = USE_CASE_NODE_HANDLER_REFS.map(h => h.logicalId);
  assert.ok(ids.includes(USE_CASE_RESOLVER_HANDLER_ID));
  assert.equal(USE_CASE_RESOLVER_HANDLER_ID, 'formalization-resolve-use-cases');
  for (const h of USE_CASE_NODE_HANDLER_REFS) {
    assert.equal(h.digest, PENDING_DIGEST, `handler ${h.logicalId} digest must be the Wave-2 placeholder`);
  }
});

// ---------------------------------------------------------------------------
// 3. Package-local resource file content sanity (WAVE8: pinned, self-contained).
// ---------------------------------------------------------------------------

test('use-case skill instruction forbids global lookup and self-acceptance', () => {
  const entry = USE_CASE_NODE_RESOURCES.find(r => r.logicalId === 'use-case-skill');
  assert.ok(entry, 'use-case-skill resource declared');
  const abs = path.join(PACKAGE_ROOT, ...entry.path.split('/'));
  const text = readFileSync(abs, 'utf8');
  assert.match(text, /derived_from/, 'skill must name the derived_from trace');
  assert.match(text, /covers/, 'skill must name the covers trace');
  assert.match(text, /Never accept an artifact yourself/, 'skill must forbid self-acceptance');
});

test('use-case create call template targets the UC artifact type with provenance metadata', () => {
  const entry = USE_CASE_NODE_RESOURCES.find(r => r.logicalId === 'use-case-create-call-template');
  assert.ok(entry, 'create call template resource declared');
  const abs = path.join(PACKAGE_ROOT, ...entry.path.split('/'));
  const template = JSON.parse(readFileSync(abs, 'utf8'));
  assert.equal(template.tool, 'artifact_create');
  assert.equal(template.arguments.type, 'UC');
  assert.equal(template.arguments.status, 'draft');
  assert.equal(template.arguments.metadata.process_module_ref, 'solution-formalization@1.0.0');
  assert.equal(template.arguments.metadata.node_id, 'model-use-cases');
});

test('use-case trace call templates match the real trace_add contract', () => {
  for (const [logicalId, expectedLink] of [
    ['use-case-derived-from-prd-call-template', 'derived_from'],
    ['use-case-covers-fr-call-template', 'covers'],
  ]) {
    const entry = USE_CASE_NODE_RESOURCES.find(r => r.logicalId === logicalId);
    assert.ok(entry, `${logicalId} resource declared`);
    const abs = path.join(PACKAGE_ROOT, ...entry.path.split('/'));
    const template = JSON.parse(readFileSync(abs, 'utf8'));
    assert.equal(template.tool, 'trace_add');
    assert.equal(template.arguments.target_type, 'artifact');
    assert.equal(template.arguments.link_type, expectedLink);
  }
});

// ---------------------------------------------------------------------------
// 4. Canonical round-trip + stable digest (plan §0.4.11 serial precondition).
// ---------------------------------------------------------------------------

test('USE_CASE_NODE_PROTOCOL round-trips through canonical JSON with a stable digest', () => {
  const wire = canonicalJson(USE_CASE_NODE_PROTOCOL);
  const roundTripped = JSON.parse(wire);
  assert.deepEqual(roundTripped, USE_CASE_NODE_PROTOCOL);
  const d1 = sha256Hex(USE_CASE_NODE_PROTOCOL);
  const d2 = sha256Hex(JSON.parse(wire));
  assert.equal(d1, d2, 'digest must be stable across the canonical round trip');
  assert.match(d1, /^[0-9a-f]{64}$/, 'digest must be a 64-hex sha256');
});

test('USE_CASE_NODE_RESOURCES round-trips through canonical JSON with a stable digest', () => {
  const wire = canonicalJson(USE_CASE_NODE_RESOURCES);
  assert.deepEqual(JSON.parse(wire), USE_CASE_NODE_RESOURCES);
  assert.equal(sha256Hex(USE_CASE_NODE_RESOURCES), sha256Hex(JSON.parse(wire)));
});
