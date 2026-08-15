// tests/process-modules/capability-packages.test.mjs
//
// W6-A2 — Platform Capability Packages tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md
//        Lane W6-A2, §1 table, §2 exit-gate items 2 + 4.
// Task:  docs/refactor-management/05-subagent-tasks/W06-a2.md.
//
// What this file proves:
//   1. The five platform packages exist and cover the five named shared-tool
//      surfaces (tasks, artifact graph, repository, worker completion,
//      protocol checkpointing).
//   2. Every tool contribution in every package is a structurally valid
//      ModuleToolContribution per the Wave 1 SPI validator.
//   3. Every platform tool logicalId is GLOBALLY unique across all packages
//      (the platform-wide collision guarantee — W6-A1 relies on it).
//   4. Every package capabilityId is unique and platform-namespaced.
//   5. Idempotency/sideEffect classification is declared per tool (the fields
//      the W6-A3 gateway guard switches on are present and well-formed).
//   6. The protocol-checkpoint package re-uses the W4-A5 contribution verbatim
//      (single source of truth — no re-declaration that would collide).
//   7. The catalog, lookup, flatten, and validation helpers are pure,
//      deterministic, and behave correctly on known + malformed inputs.
//   8. The module-load self-check passes (a malformed platform catalog would
//      have thrown at import time; reaching these tests proves it did not).
//   9. Immutability: packages and their tools are frozen.
//
// Run: `node --test tests/process-modules/capability-packages.test.mjs`
// (auto-discovered by tools/run-process-module-tests.mjs.)

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  CAPABILITY_PACKAGE_FORMAT_VERSION,
  PLATFORM_CAPABILITY_PACKAGE_VERSION,
  PLATFORM_TASKS_CAPABILITY_ID,
  PLATFORM_ARTIFACT_GRAPH_CAPABILITY_ID,
  PLATFORM_REPOSITORY_CAPABILITY_ID,
  PLATFORM_WORKER_COMPLETION_CAPABILITY_ID,
  PLATFORM_PROTOCOL_CHECKPOINT_CAPABILITY_ID,
  PLATFORM_TASKS_PACKAGE,
  PLATFORM_ARTIFACT_GRAPH_PACKAGE,
  PLATFORM_REPOSITORY_PACKAGE,
  PLATFORM_WORKER_COMPLETION_PACKAGE,
  PLATFORM_PROTOCOL_CHECKPOINT_PACKAGE,
  PLATFORM_CAPABILITY_PACKAGES,
  PROTOCOL_STEP_COMPLETE_TOOL_LOGICAL_ID,
  getPlatformCapabilityPackage,
  listPlatformToolContributions,
  getPlatformToolContribution,
  validateCapabilityPackage,
  validatePlatformCapabilityPackages,
} = await import(
  '../../dist/process-modules/application/capability-packages.js'
);

const { validateModuleToolContribution } = await import(
  '../../dist/process-modules/domain/spi/tool-contribution.js'
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Collect every logicalId across the catalog, preserving multiplicity. */
function allLogicalIds() {
  const ids = [];
  for (const pkg of PLATFORM_CAPABILITY_PACKAGES) {
    for (const tool of pkg.tools) ids.push(tool.logicalId);
  }
  return ids;
}

/** Assert a value is frozen (immutable). */
function assertFrozen(value, label) {
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`);
}

// ---------------------------------------------------------------------------
// §1 The five packages exist and cover the five named surfaces.
// ---------------------------------------------------------------------------

test('catalog contains exactly five platform packages', () => {
  assert.equal(PLATFORM_CAPABILITY_PACKAGES.length, 5);
});

test('catalog covers the five named shared-tool surfaces with stable ids', () => {
  const ids = PLATFORM_CAPABILITY_PACKAGES.map((p) => p.capabilityId);
  assert.deepEqual(
    [...ids].sort(),
    [
      PLATFORM_ARTIFACT_GRAPH_CAPABILITY_ID,
      PLATFORM_PROTOCOL_CHECKPOINT_CAPABILITY_ID,
      PLATFORM_REPOSITORY_CAPABILITY_ID,
      PLATFORM_TASKS_CAPABILITY_ID,
      PLATFORM_WORKER_COMPLETION_CAPABILITY_ID,
    ].sort(),
  );
});

test('the five named singleton packages are the catalog entries', () => {
  assert.equal(PLATFORM_TASKS_PACKAGE.capabilityId, PLATFORM_TASKS_CAPABILITY_ID);
  assert.equal(
    PLATFORM_ARTIFACT_GRAPH_PACKAGE.capabilityId,
    PLATFORM_ARTIFACT_GRAPH_CAPABILITY_ID,
  );
  assert.equal(
    PLATFORM_REPOSITORY_PACKAGE.capabilityId,
    PLATFORM_REPOSITORY_CAPABILITY_ID,
  );
  assert.equal(
    PLATFORM_WORKER_COMPLETION_PACKAGE.capabilityId,
    PLATFORM_WORKER_COMPLETION_CAPABILITY_ID,
  );
  assert.equal(
    PLATFORM_PROTOCOL_CHECKPOINT_PACKAGE.capabilityId,
    PLATFORM_PROTOCOL_CHECKPOINT_CAPABILITY_ID,
  );
  // Every singleton is referenced by the catalog (not a copy).
  for (const pkg of [
    PLATFORM_TASKS_PACKAGE,
    PLATFORM_ARTIFACT_GRAPH_PACKAGE,
    PLATFORM_REPOSITORY_PACKAGE,
    PLATFORM_WORKER_COMPLETION_PACKAGE,
    PLATFORM_PROTOCOL_CHECKPOINT_PACKAGE,
  ]) {
    assert.ok(
      PLATFORM_CAPABILITY_PACKAGES.includes(pkg),
      `${pkg.capabilityId} singleton must be referenced by the catalog`,
    );
  }
});

test('every package declares the platform envelope fields', () => {
  for (const pkg of PLATFORM_CAPABILITY_PACKAGES) {
    assert.equal(pkg.formatVersion, CAPABILITY_PACKAGE_FORMAT_VERSION);
    assert.equal(pkg.version, PLATFORM_CAPABILITY_PACKAGE_VERSION);
    assert.equal(typeof pkg.runtimeCompatibilityRange, 'string');
    assert.ok(pkg.runtimeCompatibilityRange.length > 0);
    assert.equal(typeof pkg.description, 'string');
    assert.ok(pkg.description.length > 0);
    assert.ok(Array.isArray(pkg.tools));
    assert.ok(pkg.tools.length > 0);
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test('platform.tasks surfaces task_create/list/get/update', () => {
  const ids = PLATFORM_TASKS_PACKAGE.tools.map((t) => t.logicalId);
  assert.deepEqual(ids, [
    'platform.tasks.task_create',
    'platform.tasks.task_list',
    'platform.tasks.task_get',
    'platform.tasks.task_update',
  ]);
});

test('platform.artifact-graph surfaces artifact + trace + coverage tools', () => {
  const ids = PLATFORM_ARTIFACT_GRAPH_PACKAGE.tools.map((t) => t.logicalId);
  assert.deepEqual(ids, [
    'platform.artifact-graph.artifact_create',
    'platform.artifact-graph.artifact_get',
    'platform.artifact-graph.artifact_list',
    'platform.artifact-graph.artifact_update',
    'platform.artifact-graph.trace_add',
    'platform.artifact-graph.trace_list',
    'platform.artifact-graph.trace_delete',
    'platform.artifact-graph.artifact_coverage',
  ]);
});

test('platform.repository surfaces repository + checkout tools', () => {
  const ids = PLATFORM_REPOSITORY_PACKAGE.tools.map((t) => t.logicalId);
  assert.deepEqual(ids, [
    'platform.repository.repository_register',
    'platform.repository.repository_list',
    'platform.repository.repository_get',
    'platform.repository.repository_update',
    'platform.repository.repository_checkout_register',
    'platform.repository.repository_checkout_list',
    'platform.repository.repository_checkout_bootstrap',
  ]);
});

test('platform.worker-completion surfaces the completion + merge fence (NO worker_next)', () => {
  // WAVE-3 (conveyor-wave-review ПОВТОРНАЯ ПРОВЕРКА 2026-08-02): worker_next is
  // removed from the assigned-worker capability package. One launch = one card:
  // an assigned worker must not re-enter the dispatch queue. The dispatcher
  // invokes worker_next as a raw MCP tool, not via this package, and the
  // server-side fence rejection in handleWorkerNext is the hard guarantee.
  const ids = PLATFORM_WORKER_COMPLETION_PACKAGE.tools.map((t) => t.logicalId);
  assert.deepEqual(ids, [
    'platform.worker-completion.worker_done',
    'platform.worker-completion.worker_ask_need',
    'platform.worker-completion.worker_ask_done',
    'platform.worker-completion.worker_merge_acquire',
    'platform.worker-completion.worker_merge_release',
    'platform.worker-completion.worker_health',
  ]);
  // Explicit negative assertion: worker_next must NOT be granted to assigned
  // workers through this package.
  assert.ok(
    !ids.includes('platform.worker-completion.worker_next'),
    'worker_next must not appear in the assigned-worker capability package',
  );
});

test('platform.protocol-checkpoint surfaces exactly the W4-A5 protocol tool', () => {
  const ids = PLATFORM_PROTOCOL_CHECKPOINT_PACKAGE.tools.map(
    (t) => t.logicalId,
  );
  assert.deepEqual(ids, [PROTOCOL_STEP_COMPLETE_TOOL_LOGICAL_ID]);
  assert.deepEqual(ids, ['runtime.protocol.step_complete']);
});

// ---------------------------------------------------------------------------
// §3 Every tool contribution passes the Wave 1 SPI structural validator.
// ---------------------------------------------------------------------------

test('every platform tool is a structurally valid ModuleToolContribution', async () => {
  const tools = listPlatformToolContributions();
  assert.ok(tools.length >= 5, 'catalog must surface at least 5 tools');
  for (const tool of tools) {
    const verdict = await validateModuleToolContribution(tool);
    if (!verdict.ok) {
      assert.fail(
        `tool '${tool.logicalId}' failed SPI validation: ${
          verdict.errors
            .map((e) => `${e.code}(${e.path}): ${e.message}`)
            .join('; ')
        }`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// §4 Global uniqueness: tool logicalIds + package capabilityIds.
// ---------------------------------------------------------------------------

test('every platform tool logicalId is globally unique across the catalog', () => {
  const ids = allLogicalIds();
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate tool logicalIds: ${dupes.join(', ')}`);
});

test('every package capabilityId is unique', () => {
  const ids = PLATFORM_CAPABILITY_PACKAGES.map((p) => p.capabilityId);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, []);
});

test('every platform tool logicalId is platform- or runtime-namespaced', () => {
  for (const id of allLogicalIds()) {
    assert.ok(
      id.startsWith('platform.') || id.startsWith('runtime.'),
      `tool logicalId '${id}' must be platform.* or runtime.* namespaced`,
    );
  }
});

// ---------------------------------------------------------------------------
// §5 Idempotency / sideEffect classification (what W6-A3 switches on).
// ---------------------------------------------------------------------------

const VALID_IDEMPOTENCY = new Set(['none', 'idempotent']);
const VALID_SIDE_EFFECT = new Set(['none', 'read', 'write', 'external']);

test('every platform tool declares a well-formed idempotency + sideEffect', () => {
  for (const tool of listPlatformToolContributions()) {
    assert.ok(
      VALID_IDEMPOTENCY.has(tool.idempotency),
      `${tool.logicalId} has bad idempotency '${tool.idempotency}'`,
    );
    assert.ok(
      VALID_SIDE_EFFECT.has(tool.sideEffect),
      `${tool.logicalId} has bad sideEffect '${tool.sideEffect}'`,
    );
  }
});

test('read-only tools are classified idempotent+read', () => {
  const readTools = listPlatformToolContributions().filter(
    (t) => t.sideEffect === 'read',
  );
  assert.ok(readTools.length > 0);
  for (const t of readTools) {
    assert.equal(t.idempotency, 'idempotent', `${t.logicalId} read must be idempotent`);
  }
});

test('the protocol checkpoint tool keeps its W4-A5 classification (idempotent+write)', () => {
  const t = getPlatformToolContribution(PROTOCOL_STEP_COMPLETE_TOOL_LOGICAL_ID);
  assert.ok(t);
  assert.equal(t.idempotency, 'idempotent');
  assert.equal(t.sideEffect, 'write');
});

test('repository_checkout_bootstrap is classified external (git clone)', () => {
  const t = getPlatformToolContribution(
    'platform.repository.repository_checkout_bootstrap',
  );
  assert.ok(t);
  assert.equal(t.sideEffect, 'external');
});

// ---------------------------------------------------------------------------
// §6 Lookup helpers.
// ---------------------------------------------------------------------------

test('getPlatformCapabilityPackage resolves known ids and rejects unknown', () => {
  assert.equal(
    getPlatformCapabilityPackage(PLATFORM_TASKS_CAPABILITY_ID),
    PLATFORM_TASKS_PACKAGE,
  );
  assert.equal(
    getPlatformCapabilityPackage('platform.does-not-exist'),
    undefined,
  );
  assert.equal(getPlatformCapabilityPackage('discovery.proposal_submit'), undefined);
});

test('getPlatformToolContribution resolves known logicalIds and rejects unknown', () => {
  const t = getPlatformToolContribution('platform.tasks.task_create');
  assert.ok(t);
  assert.equal(t.logicalId, 'platform.tasks.task_create');
  assert.equal(getPlatformToolContribution('nope'), undefined);
  // A module-namespaced id is NOT a platform tool.
  assert.equal(
    getPlatformToolContribution('discovery.proposal_submit'),
    undefined,
  );
});

test('listPlatformToolContributions is deterministic across calls', () => {
  const a = listPlatformToolContributions().map((t) => t.logicalId);
  const b = listPlatformToolContributions().map((t) => t.logicalId);
  assert.deepEqual(a, b);
  // Returns the full catalog surface.
  assert.equal(a.length, allLogicalIds().length);
});

// ---------------------------------------------------------------------------
// §7 validateCapabilityPackage.
// ---------------------------------------------------------------------------

test('validateCapabilityPackage accepts every real platform package', () => {
  for (const pkg of PLATFORM_CAPABILITY_PACKAGES) {
    const result = validateCapabilityPackage(pkg);
    assert.equal(
      result.ok,
      true,
      `${pkg.capabilityId}: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('validateCapabilityPackage rejects non-platform namespace', () => {
  const pkg = {
    ...PLATFORM_TASKS_PACKAGE,
    capabilityId: 'discovery.something',
  };
  const result = validateCapabilityPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'PACKAGE_CAPABILITY_ID_NAMESPACE'));
});

test('validateCapabilityPackage rejects wrong format version', () => {
  const pkg = { ...PLATFORM_TASKS_PACKAGE, formatVersion: '9.9.9' };
  const result = validateCapabilityPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'PACKAGE_FORMAT_VERSION_MISMATCH'));
});

test('validateCapabilityPackage rejects empty tools', () => {
  const pkg = { ...PLATFORM_TASKS_PACKAGE, tools: [] };
  const result = validateCapabilityPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'PACKAGE_TOOLS_EMPTY'));
});

test('validateCapabilityPackage rejects duplicate tool logicalIds within a package', () => {
  const dup = { ...PLATFORM_TASKS_PACKAGE.tools[0] };
  const pkg = {
    ...PLATFORM_TASKS_PACKAGE,
    tools: [...PLATFORM_TASKS_PACKAGE.tools, dup],
  };
  const result = validateCapabilityPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === 'PACKAGE_TOOL_LOGICAL_ID_DUPLICATE'),
  );
});

test('validateCapabilityPackage rejects non-object', () => {
  const result = validateCapabilityPackage(null);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'PACKAGE_NOT_OBJECT');
});

test('validateCapabilityPackage collects multiple errors (non-short-circuit)', () => {
  const pkg = {
    formatVersion: 'bad',
    capabilityId: 'bad-namespace',
    version: '',
    runtimeCompatibilityRange: '',
    description: '',
    tools: 'not-an-array',
  };
  const result = validateCapabilityPackage(pkg);
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('PACKAGE_FORMAT_VERSION_MISMATCH'));
  assert.ok(codes.includes('PACKAGE_CAPABILITY_ID_NAMESPACE'));
  assert.ok(codes.includes('PACKAGE_VERSION_EMPTY'));
  assert.ok(codes.includes('PACKAGE_COMPAT_RANGE_EMPTY'));
  assert.ok(codes.includes('PACKAGE_DESCRIPTION_EMPTY'));
  assert.ok(codes.includes('PACKAGE_TOOLS_NOT_ARRAY'));
});

// ---------------------------------------------------------------------------
// §8 validatePlatformCapabilityPackages — cross-package collisions.
// ---------------------------------------------------------------------------

test('validatePlatformCapabilityPackages accepts the real catalog', () => {
  const result = validatePlatformCapabilityPackages(PLATFORM_CAPABILITY_PACKAGES);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('validatePlatformCapabilityPackages detects a cross-package tool collision', () => {
  // Forge a second package that re-surfaces a tool already in platform.tasks.
  const evil = {
    ...PLATFORM_REPOSITORY_PACKAGE,
    capabilityId: 'platform.evil',
    tools: [
      ...PLATFORM_REPOSITORY_PACKAGE.tools,
      { ...PLATFORM_TASKS_PACKAGE.tools[0] },
    ],
  };
  const result = validatePlatformCapabilityPackages([
    PLATFORM_TASKS_PACKAGE,
    evil,
  ]);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === 'PLATFORM_TOOL_LOGICAL_ID_COLLISION'),
  );
});

test('validatePlatformCapabilityPackages detects a duplicate package id', () => {
  const result = validatePlatformCapabilityPackages([
    PLATFORM_TASKS_PACKAGE,
    PLATFORM_TASKS_PACKAGE,
  ]);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === 'PLATFORM_PACKAGE_ID_DUPLICATE'),
  );
});

// ---------------------------------------------------------------------------
// §9 Immutability + the module-load self-check.
// ---------------------------------------------------------------------------

test('packages, the catalog, and tool lists are frozen', () => {
  assertFrozen(PLATFORM_CAPABILITY_PACKAGES, 'catalog');
  for (const pkg of PLATFORM_CAPABILITY_PACKAGES) {
    assertFrozen(pkg, pkg.capabilityId);
    assertFrozen(pkg.tools, `${pkg.capabilityId}.tools`);
  }
});

test('module-load self-check passed (import succeeded => catalog is well-formed)', () => {
  // Reaching this test means the synchronous self-check in capability-packages.ts
  // did not throw. Confirm the invariant explicitly here too.
  const result = validatePlatformCapabilityPackages(PLATFORM_CAPABILITY_PACKAGES);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// §10 Single source of truth: protocol tool identity.
// ---------------------------------------------------------------------------

test('the protocol tool appears exactly once in the flattened catalog', () => {
  const matches = listPlatformToolContributions().filter(
    (t) => t.logicalId === PROTOCOL_STEP_COMPLETE_TOOL_LOGICAL_ID,
  );
  assert.equal(matches.length, 1);
});

test('every platform tool declares a unique handlerRef (dispatch target)', () => {
  const refs = listPlatformToolContributions().map((t) => t.handlerRef);
  const seen = new Set();
  const dupes = [];
  for (const r of refs) {
    if (seen.has(r)) dupes.push(r);
    seen.add(r);
  }
  // The protocol tool's handlerRef ('runtime:protocol-checkpoint-service:applyCheckpoint')
  // is distinct from the platform:* refs; no duplicates expected.
  assert.deepEqual(dupes, [], `duplicate handlerRefs: ${dupes.join(', ')}`);
});
