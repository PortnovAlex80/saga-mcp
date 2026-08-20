// tests/spi/module-manifest.test.mjs
//
// W1-A2 — ProcessModuleManifest + ResourceIndex validator tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 rows 4,5,
//       §2 (validators), §3 (negative test contract), §4 (round-trip contract).
// Task: docs/refactor-management/05-subagent-tasks/W01-A2-module-manifest.md.
//
// Coverage:
//   - Positive: a manifest wrapping the W0-A7 lm-marketing ProcessModuleDefinition
//     validates { ok: true } AND round-trips through canonical JSON (parse ==
//     original, sha256Hex stable).
//   - Negative (spec §3): for EVERY forbidden value kind (function, Map, Set,
//     undefined-in-array, class instance, NaN, Infinity, -Infinity, Symbol,
//     Symbol key) the validator rejects via assertCanonicalSerializable.
//   - Negative (structural): duplicate resourceIndex logicalId, duplicate
//     handlerRefs logicalId, empty manifestFormatVersion, unknown ResourceKind,
//     missing required fields.
//
// Imports run against the COMPILED dist/ output (node --test resolves .mjs
// against the repo root; the production files live under
// dist/process-modules/domain/spi/). The sibling-lane runtime imports
// (canonical-serialization.js from W1-A1, contract-ref.js from W1-A5) are
// type-only at the manifest level EXCEPT assertCanonicalSerializable, which is
// a value import. If those lanes have not landed in this worktree the build
// will emit a dangling import; the negative cases that depend on
// assertCanonicalSerializable are then expected to fail-with-unresolved-import
// and the integrator resolves them at cherry-pick time. The structural
// positive/negative cases that do NOT trigger canonical serialization still
// exercise the validator logic.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateProcessModuleManifest,
  PENDING_DIGEST,
  RESOURCE_KINDS,
} from '../../dist/process-modules/domain/spi/module-manifest.js';
import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';
import { lmMarketingModule } from '../../tests/fixtures/synthetic-modules/lm-marketing/definition.mjs';

// ---------------------------------------------------------------------------
// Helpers — build a valid baseline manifest, then mutate copies for negatives.
// ---------------------------------------------------------------------------

function makeContractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: PENDING_DIGEST,
  };
}

function makeValidManifest(overrides = {}) {
  return {
    manifestFormatVersion: '0.1.0',
    definition: lmMarketingModule,
    resourceIndex: [
      {
        logicalId: 'semantic-skill',
        path: 'skills/synthetic-marketing-skill.md',
        kind: 'skill',
        digest: PENDING_DIGEST,
      },
      {
        logicalId: 'campaign-template',
        path: 'templates/campaign-draft-template.md',
        kind: 'template',
        digest: PENDING_DIGEST,
      },
    ],
    handlerRefs: [
      // K3 (de9b2f88): a handlerRef must pin a REAL implementation digest —
      // the placeholder is legal on resources only.
      { logicalId: 'draft-handler', version: '1.0.0', digest: 'e'.repeat(64) },
    ],
    inputContractRef: makeContractRef('synthetic.marketing.input.v1'),
    outputContractRef: makeContractRef('synthetic.marketing.output.v1'),
    runtimeCompatibilityRange: '^3.0.0',
    ...overrides,
  };
}

// Deep-clone via canonical round-trip so nested mutations don't leak across
// cases. Only valid for canonically-serializable values.
function clone(value) {
  return JSON.parse(canonicalJson(value));
}

// ===========================================================================
// POSITIVE
// ===========================================================================

test('positive: lm-marketing manifest validates ok', () => {
  const m = makeValidManifest();
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, true, `expected ok, errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.errors.length, 0);
});

test('positive: manifest round-trips through canonical JSON (parse === original)', () => {
  const m = makeValidManifest();
  const json = canonicalJson(m);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, m);
});

test('positive: sha256Hex of the manifest is stable across repeated calls', () => {
  const m = makeValidManifest();
  const h1 = sha256Hex(m);
  const h2 = sha256Hex(m);
  const h3 = sha256Hex(canonicalJson(m));
  assert.equal(h1, h2, 'sha256Hex must be deterministic');
  // canonicalJson-of-canonicalJson-of-string equals canonicalJson of the
  // string only for plain strings (JSON.stringify quotes). The stability
  // guarantee is h1 === h2 only.
  assert.equal(typeof h1, 'string');
  assert.equal(h1.length, 64);
});

test('positive: every declared ResourceKind is accepted', () => {
  for (const kind of RESOURCE_KINDS) {
    const m = makeValidManifest({
      resourceIndex: [
        { logicalId: `r-${kind}`, path: `p/${kind}.md`, kind, digest: PENDING_DIGEST },
      ],
    });
    const result = validateProcessModuleManifest(m);
    assert.equal(result.ok, true, `kind '${kind}' should be accepted; errors: ${JSON.stringify(result.errors)}`);
  }
});

test('positive: empty resourceIndex and handlerRefs are valid', () => {
  const m = makeValidManifest({ resourceIndex: [], handlerRefs: [] });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, true, `errors: ${JSON.stringify(result.errors)}`);
});

// ===========================================================================
// NEGATIVE — structural
// ===========================================================================

test('negative: empty manifestFormatVersion rejected', () => {
  const m = makeValidManifest({ manifestFormatVersion: '' });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MANIFEST_FORMAT_VERSION_EMPTY'));
});

test('negative: duplicate resourceIndex logicalId rejected', () => {
  const m = makeValidManifest({
    resourceIndex: [
      { logicalId: 'dup', path: 'a.md', kind: 'skill', digest: PENDING_DIGEST },
      { logicalId: 'dup', path: 'b.md', kind: 'template', digest: PENDING_DIGEST },
    ],
  });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'RESOURCE_LOGICAL_ID_DUPLICATE'));
});

test('negative: duplicate handlerRefs logicalId rejected', () => {
  const m = makeValidManifest({
    handlerRefs: [
      { logicalId: 'dup', version: '1.0.0', digest: PENDING_DIGEST },
      { logicalId: 'dup', version: '2.0.0', digest: PENDING_DIGEST },
    ],
  });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'HANDLER_LOGICAL_ID_DUPLICATE'));
});

test('negative: unknown ResourceKind rejected', () => {
  const m = makeValidManifest({
    resourceIndex: [
      { logicalId: 'bad', path: 'x.md', kind: 'not-a-real-kind', digest: PENDING_DIGEST },
    ],
  });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'RESOURCE_KIND_UNKNOWN'));
});

test('negative: missing definition rejected', () => {
  const m = makeValidManifest();
  delete m.definition;
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MANIFEST_DEFINITION_MISSING'));
});

test('negative: definition missing required nested fields rejected', () => {
  const m = makeValidManifest({ definition: { identity: {} } });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('MANIFEST_DEFINITION_FIELD_INVALID'));
});

test('negative: missing resourceIndex rejected', () => {
  const m = makeValidManifest();
  delete m.resourceIndex;
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MANIFEST_RESOURCE_INDEX_MISSING'));
});

test('negative: missing inputContractRef rejected', () => {
  const m = makeValidManifest();
  delete m.inputContractRef;
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MANIFEST_CONTRACT_REF_INVALID'));
});

test('negative: empty runtimeCompatibilityRange rejected', () => {
  const m = makeValidManifest({ runtimeCompatibilityRange: '' });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MANIFEST_COMPAT_RANGE_INVALID'));
});

test('negative: manifest is not a plain object', () => {
  const result = validateProcessModuleManifest('not-a-manifest');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'MANIFEST_NOT_OBJECT'));
});

test('negative: resourceIndex entry missing digest rejected', () => {
  const m = makeValidManifest({
    resourceIndex: [{ logicalId: 'r', path: 'p.md', kind: 'skill' }],
  });
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'RESOURCE_DIGEST_INVALID'));
});

// ===========================================================================
// NEGATIVE — canonical serialization (spec §3 forbidden value kinds).
//
// assertCanonicalSerializable throws on the FIRST offending value. We wrap each
// call in assert.throws to prove the validator surfaces the impurity rather
// than silently accepting it. The forbidden kinds are exercised against the
// top-level manifest object so the recursion visits every nested field.
// ===========================================================================

/**
 * Inject a forbidden value into a nested field of the manifest and assert the
 * validator throws (the impurity is caught by canonical serialization before
 * the structural checks run).
 */
function assertRejectsForbidden(label, mutate) {
  test(`negative canonical: manifest carrying ${label} is rejected`, () => {
    const m = makeValidManifest();
    // Use a structural clone so the mutation survives canonical-serialization
    // recursion only where we inject the forbidden value. We rebuild the
    // nested array directly (NOT via clone, since the forbidden value is not
    // serializable).
    const mutated = {
      ...m,
      resourceIndex: m.resourceIndex.map((e) => ({ ...e })),
    };
    mutate(mutated);
    assert.throws(
      () => validateProcessModuleManifest(mutated),
      (e) => {
        assert.ok(e && typeof e === 'object', 'expected thrown error object');
        // W1-A1's CanonicalSerializationError carries code + path + reason.
        assert.equal(e.code, 'CANONICAL_SERIALIZATION_INVALID');
        assert.ok(typeof e.path === 'string' && e.path.length > 0, 'expected non-empty path');
        return true;
      },
      `expected validator to throw CANONICAL_SERIALIZATION_INVALID for ${label}`,
    );
  });
}

assertRejectsForbidden('a function in a field', (m) => {
  m.resourceIndex[0].path = () => 'bad';
});

assertRejectsForbidden('a Map', (m) => {
  m.resourceIndex[0].extras = new Map([['k', 1]]);
});

assertRejectsForbidden('a Set', (m) => {
  m.resourceIndex[0].tags = new Set([1, 2]);
});

assertRejectsForbidden('undefined inside an array', (m) => {
  m.resourceIndex[0].path = 'ok.md';
  m.resourceIndex.push(undefined);
});

assertRejectsForbidden('a class instance', (m) => {
  class Bad {}
  m.resourceIndex[0].payload = new Bad();
});

assertRejectsForbidden('NaN', (m) => {
  m.resourceIndex[0].weight = NaN;
});

assertRejectsForbidden('Infinity', (m) => {
  m.resourceIndex[0].weight = Infinity;
});

assertRejectsForbidden('-Infinity', (m) => {
  m.resourceIndex[0].weight = -Infinity;
});

assertRejectsForbidden('a Symbol value', (m) => {
  m.resourceIndex[0].marker = Symbol('bad');
});

assertRejectsForbidden('a Symbol key', (m) => {
  m.resourceIndex[0][Symbol('hidden')] = 1;
});

// Also exercise forbidden values on the top-level manifest fields directly,
// not just nested resourceIndex — proves recursion reaches handlerRefs,
// definition, contract refs.
test('negative canonical: function on top-level manifestFormatVersion rejected', () => {
  const m = makeValidManifest();
  m.manifestFormatVersion = () => '0.1.0';
  assert.throws(
    () => validateProcessModuleManifest(m),
    (e) => e.code === 'CANONICAL_SERIALIZATION_INVALID',
  );
});

test('negative canonical: class instance on handlerRefs rejected', () => {
  class Bad {}
  const m = makeValidManifest({
    handlerRefs: [new Bad()],
  });
  assert.throws(
    () => validateProcessModuleManifest(m),
    (e) => e.code === 'CANONICAL_SERIALIZATION_INVALID',
  );
});
