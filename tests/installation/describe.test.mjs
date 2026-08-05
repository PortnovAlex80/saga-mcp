// @ts-check
/**
 * W2-A7 — `describeInstallation` pure-projection tests.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 *        §1 row 14, §6 exit-gate item 5.
 * Task: `docs/refactor-management/05-subagent-tasks/W02-A7-3rd-synthetic-describe.md`.
 *
 * What this file proves:
 *   1. A `ModuleInstallationRecord` built from the 3rd synthetic fixture
 *      (`synthetic-compliance-check`) wrapped via `createProcessModuleManifest`
 *      + a fake `resourceIndex` (the fixture's declared resources) projects to
 *      the correct counts (resources/handlers/tools/capabilities), flow
 *      summary (node count, node kinds, outcomes), and contract refs.
 *   2. Pure projection: same record → structurally-equal description
 *      (determinism). Calling `describeInstallation` twice yields identical
 *      frozen objects.
 *   3. The description is canonically serializable (round-trips through
 *      canonical JSON — plan §3.5) so it can be persisted/transported.
 *
 * Anti-scope:
 *   - We do NOT install the 3rd module here (W2-A8 conformance does the full
 *     install-replay proof). We only construct an in-memory record and project
 *     it.
 *   - We do NOT exercise the W2-A1 store, W2-A2 repo, or W2-A3 installer —
 *     those lanes own their own tests. We consume only the W0-A7/W2-A7
 *     fixtures + the Wave 1 SPI + this lane's `describeInstallation`.
 *
 * Imports run against the COMPILED dist/ output (`node --test` resolves .mjs
 * against the repo root; production files live under
 * `dist/process-modules/...`).
 *
 * Run: `node --test tests/installation/describe.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';

// W2-A7 3rd synthetic fixture (data-only).
import complianceCheckModule, {
  COMPLIANCE_CHECK_MODULE_REF,
  COMPLIANCE_CHECK_INPUT_SCHEMA,
  COMPLIANCE_CHECK_OUTPUT_SCHEMA,
  COMPLIANCE_CHECK_HANDLER_REF,
  complianceCheckResourceIndex,
} from './fixtures/3rd-synthetic-module/definition.mjs';

// Wave 1 SPI — legacy adapter (wraps the definition into a manifest envelope).
const { createProcessModuleManifest } = await import(
  '../../dist/process-modules/domain/spi/index.js'
);

// This lane — describeInstallation (pure projection).
const { describeInstallation } = await import(
  '../../dist/process-modules/installation/domain/describe.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stand-in resource digest. Wave 1 allows `'pending@wave-2'`; here we use a
 * real sha256 of the resource logicalId so the description is reproducible
 * without depending on Wave 2's installer having run.
 */
function fakeDigest(logicalId) {
  return sha256Hex({ logicalId });
}

/**
 * Construct a fake `ModuleInstallationRecord` from the 3rd synthetic fixture:
 *
 *   1. Wrap the fixture's `ProcessModuleDefinition` via
 *      `createProcessModuleManifest` (Wave 1 SPI) → a `ProcessModuleManifest`
 *      envelope with empty `resourceIndex` / `handlerRefs` (the legacy adapter
 *      zeroes them; a real install resolves them — that's W2-A3's job).
 *   2. Build the record with:
 *        - `manifestSnapshot`    = the wrapped manifest;
 *        - `resourceIndex`       = the fixture's declared resources (with
 *                                  real digests filled in — what W2-A3 would
 *                                  produce post-install);
 *        - `handlerRefs`         = one HandlerRef per declared handler;
 *        - `packageDigest`       = sha256 of canonical manifest+resources
 *                                  (stand-in; W2-A3 computes the real one);
 *        - `status = 'active'`   + ISO timestamps.
 *
 * This mirrors the W2-A2 `ModuleInstallationRecord` shape verbatim. The local
 * structural alias in `describe.ts` (`InstallationRecordView`) accepts this
 * without any adapter.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function buildRecord(overrides = {}) {
  const manifest = createProcessModuleManifest(complianceCheckModule);

  // Real-shaped resource index (what the installer would resolve post-install).
  const resourceIndex = complianceCheckResourceIndex.map((r) => ({
    logicalId: r.logicalId,
    path: r.path,
    kind: r.kind,
    digest: fakeDigest(r.logicalId),
  }));

  // Real-shaped handler refs (Kernel node declares one handler).
  const handlerRefs = [
    {
      logicalId: COMPLIANCE_CHECK_HANDLER_REF.split('@')[0],
      version: COMPLIANCE_CHECK_HANDLER_REF.split('@')[1] ?? '1.0.0',
      digest: fakeDigest(COMPLIANCE_CHECK_HANDLER_REF),
    },
  ];

  // Stand-in package digest (W2-A3 computes the real one over canonical
  // manifest+resources). Using sha256Hex keeps the determinism proof honest.
  const packageDigest = sha256Hex({
    manifest,
    resourceIndex,
    handlerRefs,
  });

  return {
    id: 1,
    name: COMPLIANCE_CHECK_MODULE_REF.name,
    version: COMPLIANCE_CHECK_MODULE_REF.version,
    packageDigest,
    manifestSnapshot: manifest,
    storeLocation: `<root>/${packageDigest.slice(0, 2)}/${packageDigest}/`,
    resourceIndex,
    handlerRefs,
    dependencyLock: { kind: 'stand-in', resolvedAt: '1970-01-01T00:00:00.000Z' },
    status: 'active',
    installedAt: '2026-07-28T00:00:00.000Z',
    activatedAt: '2026-07-28T00:00:01.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('describeInstallation projects the 3rd synthetic module correctly', () => {
  const record = buildRecord();
  const desc = describeInstallation(record);

  // Identity.
  assert.equal(desc.name, 'synthetic-compliance-check');
  assert.equal(desc.version, '0.1.0');
  assert.equal(desc.packageDigest, record.packageDigest);

  // Flow summary: one Kernel node, one outcome.
  assert.equal(desc.flowSummary.nodeCount, 1, 'one Kernel node');
  assert.deepEqual(
    [...desc.flowSummary.nodeKinds],
    ['kernel'],
    'nodeKinds deduped + sorted',
  );
  assert.deepEqual(
    [...desc.flowSummary.outcomes],
    ['compliance-passed'],
    'outcomes sorted',
  );

  // Counts: 2 resources (checklist + schema), 1 handler, 0 tools, 0 caps.
  assert.equal(desc.resourceCount, 2, 'resourceCount = fixture resourceIndex length');
  assert.equal(desc.handlerCount, 1, 'handlerCount = record.handlerRefs length');
  assert.equal(desc.toolCount, 0, 'toolCount defaults to 0 when manifest omits toolContributions');
  assert.equal(
    desc.capabilityCount,
    0,
    'capabilityCount defaults to 0 when manifest omits capabilityRequirements',
  );

  // Contract refs forwarded verbatim from the manifest snapshot.
  assert.equal(desc.inputContractRef.schemaId, COMPLIANCE_CHECK_INPUT_SCHEMA);
  assert.equal(desc.outputContractRef.schemaId, COMPLIANCE_CHECK_OUTPUT_SCHEMA);
});

test('describeInstallation is a pure deterministic projection', () => {
  const record = buildRecord();
  const a = describeInstallation(record);
  const b = describeInstallation(record);

  // Structural equality — same record → same description.
  assert.deepEqual(a, b, 'same record yields structurally-equal description');

  // Field-by-field stability (defensive — deepEqual already covers this).
  assert.equal(a.flowSummary.nodeCount, b.flowSummary.nodeCount);
  assert.deepEqual([...a.flowSummary.nodeKinds], [...b.flowSummary.nodeKinds]);
  assert.deepEqual([...a.flowSummary.outcomes], [...b.flowSummary.outcomes]);
  assert.equal(a.resourceCount, b.resourceCount);
  assert.equal(a.handlerCount, b.handlerCount);
  assert.equal(a.toolCount, b.toolCount);
  assert.equal(a.capabilityCount, b.capabilityCount);
});

test('InstallationDescription is canonically serializable (round-trips, plan §3.5)', () => {
  const record = buildRecord();
  const desc = describeInstallation(record);

  // No functions, no Maps/Sets, no class instances — must round-trip through
  // JSON.parse(canonicalJson(x)) byte-for-byte.
  const json = canonicalJson(desc);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, desc, 'round-trip via JSON.parse(canonicalJson(x))');

  // sha256Hex stable across two serializations.
  const h1 = sha256Hex(desc);
  const h2 = sha256Hex(desc);
  assert.equal(h1, h2, 'sha256Hex stable across two runs');
});

test('describeInstallation reflects record-level overrides (counts track record, not manifest)', () => {
  // The legacy adapter zeroed the manifest's resourceIndex/handlerRefs, but
  // the RECORD carries its own resolved arrays. describeInstallation MUST
  // count from the record (post-install resolution), not from the manifest
  // snapshot. Verify by overriding the record's arrays and confirming the
  // counts track the record.
  const record = buildRecord({
    resourceIndex: [
      {
        logicalId: 'extra-a',
        path: 'a.md',
        kind: 'checklist',
        digest: fakeDigest('extra-a'),
      },
      {
        logicalId: 'extra-b',
        path: 'b.json',
        kind: 'schema',
        digest: fakeDigest('extra-b'),
      },
      {
        logicalId: 'extra-c',
        path: 'c.md',
        kind: 'instruction',
        digest: fakeDigest('extra-c'),
      },
    ],
    handlerRefs: [
      {
        logicalId: 'h1',
        version: '1.0.0',
        digest: fakeDigest('h1'),
      },
      {
        logicalId: 'h2',
        version: '2.0.0',
        digest: fakeDigest('h2'),
      },
    ],
  });

  const desc = describeInstallation(record);
  assert.equal(desc.resourceCount, 3, 'resourceCount tracks record.resourceIndex');
  assert.equal(desc.handlerCount, 2, 'handlerCount tracks record.handlerRefs');
  // Flow summary unchanged (still read from manifestSnapshot).
  assert.equal(desc.flowSummary.nodeCount, 1);
  assert.deepEqual([...desc.flowSummary.nodeKinds], ['kernel']);
});

test('describeInstallation surfaces toolCount/capabilityCount when the manifest declares them', () => {
  // Build a record whose manifestSnapshot declares toolContributions and
  // capabilityRequirements. createProcessModuleManifest drops these (legacy
  // modules don't carry them), so we splice a richer manifest in directly.
  const baseRecord = buildRecord();
  const richManifest = {
    ...baseRecord.manifestSnapshot,
    toolContributions: [
      {
        logicalId: 'compliance.run_check',
        version: '1.0.0',
        inputContractRef: baseRecord.manifestSnapshot.inputContractRef,
        outputContractRef: baseRecord.manifestSnapshot.outputContractRef,
        handlerRef: COMPLIANCE_CHECK_HANDLER_REF,
        guardBindings: [],
        idempotency: 'none',
        sideEffect: 'read',
      },
      {
        logicalId: 'compliance.explain',
        version: '1.0.0',
        inputContractRef: baseRecord.manifestSnapshot.inputContractRef,
        outputContractRef: baseRecord.manifestSnapshot.outputContractRef,
        handlerRef: COMPLIANCE_CHECK_HANDLER_REF,
        guardBindings: [],
        idempotency: 'idempotent',
        sideEffect: 'none',
      },
    ],
    capabilityRequirements: [
      { ref: 'compliance.engine', version: '1.0.0' },
    ],
  };
  const record = { ...baseRecord, manifestSnapshot: richManifest };

  const desc = describeInstallation(record);
  assert.equal(desc.toolCount, 2, 'toolCount from manifestSnapshot.toolContributions');
  assert.equal(
    desc.capabilityCount,
    1,
    'capabilityCount from manifestSnapshot.capabilityRequirements',
  );
});

test('describeInstallation dedupes + sorts nodeKinds across a multi-kind flow', () => {
  // Synthetic record with a multi-kind flow to exercise dedup + sort.
  // Reuse the compliance fixture identity but swap the flow.
  const baseRecord = buildRecord();
  const multiKindManifest = {
    ...baseRecord.manifestSnapshot,
    definition: {
      ...baseRecord.manifestSnapshot.definition,
      flow: {
        ...baseRecord.manifestSnapshot.definition.flow,
        nodes: [
          { id: 'n1', label: 'L1', kind: 'kernel', description: '' },
          { id: 'n2', label: 'L2', kind: 'lm', description: '' },
          { id: 'n3', label: 'L3', kind: 'kernel', description: '' },
          { id: 'n4', label: 'L4', kind: 'external', description: '' },
          { id: 'n5', label: 'L5', kind: 'human', description: '' },
        ],
      },
      outcomes: [
        { code: 'zeta', description: '', terminal: true },
        { code: 'alpha', description: '', terminal: true },
        { code: 'alpha', description: 'dupe', terminal: true },
        { code: 'mu', description: '', terminal: true },
      ],
    },
  };
  const record = { ...baseRecord, manifestSnapshot: multiKindManifest };

  const desc = describeInstallation(record);
  assert.equal(desc.flowSummary.nodeCount, 5);
  // deduped (kernel appears twice) + sorted.
  assert.deepEqual(
    [...desc.flowSummary.nodeKinds],
    ['external', 'human', 'kernel', 'lm'],
  );
  // deduped (alpha appears twice) + sorted.
  assert.deepEqual(
    [...desc.flowSummary.outcomes],
    ['alpha', 'mu', 'zeta'],
  );
});

test('the 3rd synthetic fixture itself is well-formed (smoke check)', () => {
  // Defensive: confirm the fixture we hand to W2-A8 conformance is valid.
  assert.equal(complianceCheckModule.identity.name, 'synthetic-compliance-check');
  assert.equal(complianceCheckModule.identity.version, '0.1.0');
  assert.equal(complianceCheckModule.identity.kind, 'compliance');
  assert.equal(complianceCheckModule.flow.nodes[0].kind, 'kernel');
  assert.equal(
    complianceCheckModule.flow.nodes[0].handler,
    COMPLIANCE_CHECK_HANDLER_REF,
  );
  assert.equal(
    complianceCheckModule.outcomes.length,
    1,
    'exactly one outcome (per task spec)',
  );
  assert.equal(
    complianceCheckResourceIndex.length,
    2,
    'resourceIndex non-empty (2 resources — checklist + schema)',
  );
  // Resource paths are module-relative (no absolute / traversal).
  for (const r of complianceCheckResourceIndex) {
    assert.ok(
      !r.path.startsWith('/') && !r.path.startsWith('../') && !r.path.includes('..'),
      `resource path '${r.path}' is module-relative (no traversal)`,
    );
  }
});
