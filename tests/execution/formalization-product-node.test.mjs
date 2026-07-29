// @ts-check
/**
 * W8-A2 — Product (PRD) node protocol + package-local resources tests.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a2.md`.
 *
 * Wave 8 exit gate (§0.11.11): formalization runs through PINNED PACKAGE
 * RESOURCES with no global skill/template lookup. This test proves the
 * `define-product-contract` (PRD) node package delivers on that contract:
 *
 *   1. The NodeProtocolDefinition is structurally valid (W1-A4 validator),
 *      canonically serializable, and round-trips through canonical JSON with a
 *      stable digest.
 *   2. Every declared ResourceIndexEntry path resolves to a real file under
 *      the package root, and every kind is a known ResourceKind.
 *   3. The protocol owns the formalization Flow entry node
 *      `define-product-contract` and matches the live ProcessModuleDefinition
 *      (execution profile + output schema) the runtime binds against.
 *   4. Package paths are module-relative (no absolute / traversal paths), so
 *      the Wave 2 content-addressed installer can resolve them.
 *   5. Resource logical ids are unique within this node package.
 *
 * The protocol definition is imported from the package source (.mjs) directly
 * because it is PURE DATA (plan §3.5). The validator is imported from `dist/`
 * (compiled SPI). If the dist SPI is not built, the dynamic import fails with
 * ERR_MODULE_NOT_FOUND — run `npm run build` first.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Package source (pure data — imported directly, no compilation needed).
const productNodePkg = await import(
  '../../modules/formalization/package/nodes/product/index.mjs'
);
const {
  productNodeProtocol,
  productNodeResources,
  productNodeHandlerRefs,
  PRODUCT_NODE_ID,
  PRODUCT_EXECUTION_PROFILE,
  PRODUCT_OUTPUT_SCHEMA,
  PRODUCT_RESOURCE_IDS,
} = productNodePkg;

// Compiled SPI (run `npm run build` first).
const { validateNodeProtocolDefinition } = await import(
  '../../dist/process-modules/domain/spi/node-protocol.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const { RESOURCE_KINDS } = await import(
  '../../dist/process-modules/domain/spi/resource-index.js'
);

// Live formalization ProcessModuleDefinition — proves the node package matches
// the Flow the runtime actually drives.
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);

const NODE_PACKAGE_DIR = path.resolve(
  REPO_ROOT,
  'modules/formalization/package/nodes/product',
);

// ---------------------------------------------------------------------------
// 1. NodeProtocolDefinition structural validity + canonical round-trip.
// ---------------------------------------------------------------------------

test('W8-A2: productNodeProtocol passes validateNodeProtocolDefinition', () => {
  const result = validateNodeProtocolDefinition(productNodeProtocol);
  assert.equal(
    result.ok,
    true,
    `expected valid protocol, got errors: ${JSON.stringify(result.errors)}`,
  );
});

test('W8-A2: productNodeProtocol owns the formalization entry node', () => {
  assert.equal(productNodeProtocol.owningFlowNodeId, PRODUCT_NODE_ID);
  assert.equal(PRODUCT_NODE_ID, 'define-product-contract');
  assert.equal(
    productNodeProtocol.owningFlowNodeId,
    formalizationProcessModule.flow.entryNodeId,
    'protocol must own the formalization Flow entry node',
  );
});

test('W8-A2: productNodeProtocol uses a supported retry semantics kind', () => {
  assert.notEqual(productNodeProtocol.retrySemantics, 'unsupported');
  assert.ok(
    ['runtime-implemented-linear', 'runtime-implemented-backoff'].includes(
      productNodeProtocol.retrySemantics,
    ),
  );
});

test('W8-A2: productNodeProtocol round-trips through canonical JSON with a stable digest', () => {
  const wire = canonicalJson(productNodeProtocol);
  const parsed = JSON.parse(wire);
  assert.deepEqual(parsed, productNodeProtocol);
  assert.equal(
    sha256Hex(productNodeProtocol),
    sha256Hex(productNodeProtocol),
    'digest must be stable across two runs',
  );
});

test('W8-A2: productNodeProtocol entry step exists and recovery entries resolve', () => {
  const stepIds = new Set(productNodeProtocol.steps.map((s) => s.id));
  assert.ok(stepIds.has(productNodeProtocol.entryStep));
  for (const id of productNodeProtocol.recoveryEntrySteps) {
    assert.ok(stepIds.has(id), `recovery entry ${id} must be a real step`);
  }
});

test('W8-A2: productNodeProtocol steps are linear with no opaque flow conditions', () => {
  for (const t of productNodeProtocol.transitions) {
    assert.equal(t.condition, undefined, 'Wave 8 supports only undefined conditions (C065)');
  }
});

// ---------------------------------------------------------------------------
// 2. Resource index: paths resolve, kinds known, ids unique, paths safe.
// ---------------------------------------------------------------------------

test('W8-A2: productNodeResources declares the full PRD resource set', () => {
  const ids = productNodeResources.map((r) => r.logicalId);
  for (const key of Object.values(PRODUCT_RESOURCE_IDS)) {
    assert.ok(ids.includes(key), `missing resource logical id ${key}`);
  }
});

test('W8-A2: every declared resource path resolves to a real file under the package root', () => {
  assert.ok(existsSync(NODE_PACKAGE_DIR), 'node package directory must exist');
  for (const entry of productNodeResources) {
    const resolved = path.resolve(NODE_PACKAGE_DIR, entry.path);
    assert.ok(
      resolved.startsWith(NODE_PACKAGE_DIR + path.sep),
      `resource path '${entry.path}' escapes the package root`,
    );
    assert.ok(
      existsSync(resolved),
      `resource path '${entry.path}' does not resolve to a file`,
    );
    const st = statSync(resolved);
    assert.equal(st.isFile(), true, `resource path '${entry.path}' is not a file`);
  }
});

test('W8-A2: every resource kind is a known ResourceKind', () => {
  const known = new Set(RESOURCE_KINDS);
  for (const entry of productNodeResources) {
    assert.ok(
      known.has(entry.kind),
      `unknown resource kind '${entry.kind}' on ${entry.logicalId}`,
    );
  }
});

test('W8-A2: resource logical ids are unique within the node package', () => {
  const ids = productNodeResources.map((r) => r.logicalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate resource logical id');
});

test('W8-A2: resource paths are package-relative (no absolute or traversal paths)', () => {
  for (const entry of productNodeResources) {
    assert.ok(
      !path.isAbsolute(entry.path),
      `resource path '${entry.path}' is absolute`,
    );
    const parts = entry.path.split('/');
    assert.ok(
      !parts.includes('..'),
      `resource path '${entry.path}' contains a traversal segment`,
    );
  }
});

test('W8-A2: resource digests use the documented Wave-1 placeholder', () => {
  for (const entry of productNodeResources) {
    assert.equal(
      entry.digest,
      'pending@wave-2',
      `resource ${entry.logicalId} must carry the Wave-1 placeholder digest until Wave 2 binds real bytes`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Alignment with the live formalization ProcessModuleDefinition.
// ---------------------------------------------------------------------------

test('W8-A2: execution profile + output schema match the live formalization Flow node', () => {
  const node = formalizationProcessModule.flow.nodes.find(
    (n) => n.id === PRODUCT_NODE_ID,
  );
  assert.ok(node, `formalization Flow has no node '${PRODUCT_NODE_ID}'`);
  assert.equal(node.executionProfile, PRODUCT_EXECUTION_PROFILE);
  assert.equal(node.outputSchema.id, PRODUCT_OUTPUT_SCHEMA);
  assert.equal(node.kind, 'lm');

  const profile = formalizationProcessModule.executionProfiles.find(
    (p) => p.id === PRODUCT_EXECUTION_PROFILE,
  );
  assert.ok(profile, `formalization has no execution profile '${PRODUCT_EXECUTION_PROFILE}'`);
  assert.equal(profile.artifactAcceptanceAuthority, 'kernel-gate');
});

test('W8-A2: the PRD node artifact family is declared in the formalization module artifacts', () => {
  const types = new Set(formalizationProcessModule.artifacts.map((a) => a.type));
  for (const t of ['PRD', 'FR', 'NFR', 'RULE']) {
    assert.ok(types.has(t), `formalization module does not declare artifact type ${t}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Handler refs + JSON resource sanity.
// ---------------------------------------------------------------------------

test('W8-A2: productNodeHandlerRefs are unique and reference the kernel resolver', () => {
  const ids = productNodeHandlerRefs.map((h) => h.logicalId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(
    ids.includes('formalization-resolve-product-contract'),
    'must reference the product-contract kernel resolver',
  );
  for (const h of productNodeHandlerRefs) {
    assert.ok(h.version, `handler ${h.logicalId} missing version`);
    assert.ok(h.digest, `handler ${h.logicalId} missing digest`);
  }
});

test('W8-A2: package-local JSON templates are valid JSON', () => {
  for (const entry of productNodeResources) {
    if (entry.path.endsWith('.json')) {
      const resolved = path.resolve(NODE_PACKAGE_DIR, entry.path);
      const raw = readFileSync(resolved, 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw), `${entry.path} is not valid JSON`);
    }
  }
});

test('W8-A2: package-local JSON schema declares the product bundle schema id', () => {
  const schemaPath = path.resolve(NODE_PACKAGE_DIR, 'schemas/product-bundle.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.$id, PRODUCT_OUTPUT_SCHEMA);
  assert.equal(schema.properties.schemaVersion.const, PRODUCT_OUTPUT_SCHEMA);
});
