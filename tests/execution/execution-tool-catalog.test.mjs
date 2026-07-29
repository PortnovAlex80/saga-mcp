// @ts-check
/**
 * W6-A7 — Execution-scoped tool catalog tests (plan §11.11).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md` Lane W6-A7.
 * Task: `docs/refactor-management/05-subagent-tasks/W06-a7.md`.
 *
 * What this file proves:
 *   1. §11.11 — the catalog is assembled from pinned platform capabilities
 *      AND module installation. Both surfaces contribute entries; each entry
 *      is attributed to its source ('platform' | 'module') and origin ref.
 *   2. §11.11 — descriptions are GENERATED from registered contracts. When a
 *      ContractDescriptionLookup is supplied, the registered summary/detail is
 *      embedded; when omitted, a stable contract-derived description is
 *      synthesized from the contribution's contract refs + classification.
 *   3. Determinism — same inputs yield a structurally-equal catalog including
 *      a stable contentHash, regardless of input array order.
 *   4. Collision handling — a logicalId present in BOTH a platform capability
 *      and a module installation is surfaced in `collisions`; the platform
 *      entry wins (§11.2 — platform owns shared capabilities) and the module
 *      duplicate is dropped so the listing has no duplicate logicalIds.
 *   5. Pure output — the catalog and every entry round-trip through canonical
 *      JSON (plan §3.5) so it can be serialized for the gateway tools/list.
 *   6. findCatalogEntry — read-only lookup returns the entry or undefined.
 *
 * Anti-scope: this lane owns only the catalog assembler. We do NOT exercise
 * the gateway guard (W6-A3), PreToolUse projection (W6-A4), or the real
 * CapabilityPackage/ModuleToolRegistry adapters (W6-A1/W6-A2) — those lanes
 * own their own tests. We construct in-memory pinned inputs and assemble.
 *
 * Imports run against the COMPILED dist/ output (`node --test` resolves .mjs
 * against the repo root; production files live under `dist/application/...`).
 *
 * Run: `node --test tests/execution/execution-tool-catalog.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';
import {
  assembleExecutionToolCatalog,
  generateToolDescription,
  findCatalogEntry,
} from '../../dist/application/execution-tool-catalog.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ref(schemaId, version, digest = `d-${schemaId}`) {
  return { schemaId, version, digest };
}

/** A platform capability tool (W6-A2 PinnedCapabilityTool shape). */
function platformTool(logicalId, opts = {}) {
  return {
    logicalId,
    version: opts.version ?? '1.0.0',
    inputContractRef: opts.inputContractRef ?? ref(`${logicalId}.input`, '1.0.0'),
    outputContractRef: opts.outputContractRef ?? ref(`${logicalId}.output`, '1.0.0'),
    handlerRef: opts.handlerRef ?? `handler:${logicalId}`,
    idempotency: opts.idempotency ?? 'none',
    sideEffect: opts.sideEffect ?? 'read',
    capabilityRef: opts.capabilityRef ?? 'saga.capability.tasks',
    capabilityVersion: opts.capabilityVersion ?? '1.0.0',
  };
}

function capability(refStr, tools, version = '1.0.0') {
  return { ref: refStr, version, tools };
}

/** A module tool contribution (W1-A6 ModuleToolContribution shape). */
function moduleContribution(logicalId, opts = {}) {
  return {
    logicalId,
    version: opts.version ?? '1.0.0',
    inputContractRef: opts.inputContractRef ?? ref(`${logicalId}.input`, '1.0.0'),
    outputContractRef: opts.outputContractRef ?? ref(`${logicalId}.output`, '1.0.0'),
    handlerRef: opts.handlerRef ?? `handler:${logicalId}`,
    callTemplateRef: opts.callTemplateRef,
    checklistRef: opts.checklistRef,
    errorHintRef: opts.errorHintRef,
    guardBindings: opts.guardBindings ?? [],
    idempotency: opts.idempotency ?? 'idempotent',
    sideEffect: opts.sideEffect ?? 'write',
  };
}

function installation(name, contributions, version = '3.0.0') {
  return { name, version, toolContributions: contributions };
}

// ---------------------------------------------------------------------------
// 1. §11.11 — assembled from platform capabilities + module installation.
// ---------------------------------------------------------------------------

test('assembles entries from both platform capabilities and module installations', () => {
  const input = {
    capabilities: [
      capability('saga.capability.tasks', [
        platformTool('platform.task_create'),
        platformTool('platform.task_list'),
      ]),
    ],
    installations: [
      installation('product-discovery', [
        moduleContribution('discovery.proposal_submit'),
      ]),
    ],
  };

  const catalog = assembleExecutionToolCatalog(input);

  assert.equal(catalog.platformCount, 2);
  assert.equal(catalog.moduleCount, 1);
  assert.equal(catalog.entries.length, 3);
  assert.deepEqual(catalog.collisions, []);

  const ids = catalog.entries.map((e) => e.logicalId);
  assert.deepEqual(ids, [
    'discovery.proposal_submit',
    'platform.task_create',
    'platform.task_list',
  ]);

  // Source attribution.
  const platformEntry = catalog.entries.find((e) => e.logicalId === 'platform.task_create');
  assert.equal(platformEntry.source, 'platform');
  assert.equal(platformEntry.sourceRef, 'saga.capability.tasks');
  assert.equal(platformEntry.sourceVersion, '1.0.0');

  const moduleEntry = catalog.entries.find((e) => e.logicalId === 'discovery.proposal_submit');
  assert.equal(moduleEntry.source, 'module');
  assert.equal(moduleEntry.sourceRef, 'product-discovery');
  assert.equal(moduleEntry.sourceVersion, '3.0.0');
});

test('empty inputs produce an empty but well-formed catalog', () => {
  const catalog = assembleExecutionToolCatalog({ capabilities: [], installations: [] });
  assert.equal(catalog.entries.length, 0);
  assert.equal(catalog.platformCount, 0);
  assert.equal(catalog.moduleCount, 0);
  assert.deepEqual(catalog.collisions, []);
  // contentHash is still a stable 64-char hex over the empty array.
  assert.match(catalog.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(catalog.contentHash, sha256Hex(canonicalJson([])));
});

// ---------------------------------------------------------------------------
// 2. §11.11 — descriptions generated from registered contracts.
// ---------------------------------------------------------------------------

test('description uses registered contract summary when lookup is supplied', () => {
  const lookup = (r) => {
    if (r.schemaId === 'platform.task_create.input') {
      return { summary: 'Create a tracker task.' };
    }
    return undefined;
  };
  const catalog = assembleExecutionToolCatalog({
    capabilities: [capability('saga.capability.tasks', [platformTool('platform.task_create')])],
    installations: [],
    describeContract: lookup,
  });
  assert.equal(catalog.entries[0].description, 'Create a tracker task.');
});

test('description falls back to output contract detail when input has none', () => {
  const lookup = (r) => {
    if (r.schemaId === 'platform.task_create.output') {
      return { detail: 'Returns the created task record.' };
    }
    return undefined;
  };
  const catalog = assembleExecutionToolCatalog({
    capabilities: [capability('saga.capability.tasks', [platformTool('platform.task_create')])],
    installations: [],
    describeContract: lookup,
  });
  assert.equal(catalog.entries[0].description, 'Returns the created task record.');
});

test('description falls back to contract-derived prose when no lookup is supplied', () => {
  const tool = platformTool('platform.task_create', {
    idempotency: 'idempotent',
    sideEffect: 'write',
  });
  const catalog = assembleExecutionToolCatalog({
    capabilities: [capability('saga.capability.tasks', [tool])],
    installations: [],
  });
  // Synthesized from logicalId + contract refs + classification.
  const desc = catalog.entries[0].description;
  assert.ok(desc.includes('platform.task_create'), `desc includes logicalId: ${desc}`);
  assert.ok(desc.includes('input=platform.task_create.input@1.0.0'), `desc includes input ref: ${desc}`);
  assert.ok(desc.includes('idempotent'), `desc includes idempotency: ${desc}`);
  assert.ok(desc.includes('sideEffect:write'), `desc includes sideEffect: ${desc}`);
});

test('description omits idempotency/sideEffect markers when they are none', () => {
  const tool = platformTool('platform.task_get', {
    idempotency: 'none',
    sideEffect: 'none',
  });
  const catalog = assembleExecutionToolCatalog({
    capabilities: [capability('saga.capability.tasks', [tool])],
    installations: [],
  });
  const desc = catalog.entries[0].description;
  assert.ok(!desc.includes('idempotent'), `none-idempotency not mentioned: ${desc}`);
  assert.ok(!desc.includes('sideEffect'), `none-sideEffect not mentioned: ${desc}`);
});

test('generateToolDescription is exposed and deterministic standalone', () => {
  const args = {
    logicalId: 'x.y',
    inputContractRef: ref('x.y.input', '1.0.0'),
    outputContractRef: ref('x.y.output', '2.0.0'),
    idempotency: 'none',
    sideEffect: 'read',
  };
  const a = generateToolDescription(args);
  const b = generateToolDescription(args);
  assert.equal(a, b);
  assert.ok(a.startsWith('x.y'));
});

// ---------------------------------------------------------------------------
// 3. Determinism — same inputs (any order) → equal catalog + stable hash.
// ---------------------------------------------------------------------------

test('identical inputs produce identical contentHash regardless of array order', () => {
  const capsA = [
    capability('saga.capability.tasks', [platformTool('platform.task_create')]),
    capability('saga.capability.artifacts', [platformTool('platform.artifact_list')]),
  ];
  const capsB = [...capsA].reverse();
  const instsA = [
    installation('product-discovery', [moduleContribution('discovery.proposal_submit')]),
    installation('product-formalization', [moduleContribution('formalization.uc_accept')]),
  ];
  const instsB = [...instsA].reverse();

  const catA = assembleExecutionToolCatalog({ capabilities: capsA, installations: instsA });
  const catB = assembleExecutionToolCatalog({ capabilities: capsB, installations: instsB });

  // Sorted output is identical.
  assert.deepEqual(
    catA.entries.map((e) => e.logicalId),
    catB.entries.map((e) => e.logicalId),
  );
  assert.equal(catA.contentHash, catB.contentHash);
});

test('catalog is frozen and canonically serializable (round-trips through JSON)', () => {
  const catalog = assembleExecutionToolCatalog({
    capabilities: [capability('saga.capability.tasks', [platformTool('platform.task_create')])],
    installations: [installation('m', [moduleContribution('m.tool')])],
  });
  assert.ok(Object.isFrozen(catalog), 'catalog is frozen');
  assert.ok(Object.isFrozen(catalog.entries), 'entries are frozen');
  // Round-trip: no functions/Maps/Sets/class instances.
  const json = canonicalJson(catalog);
  const reparsed = JSON.parse(json);
  assert.equal(reparsed.entries.length, 2);
  assert.equal(reparsed.contentHash, catalog.contentHash);
});

// ---------------------------------------------------------------------------
// 4. Collision handling (§11.2 platform wins, §11.5 collision surfacing).
// ---------------------------------------------------------------------------

test('collision: platform wins and module duplicate is dropped + surfaced', () => {
  const sharedId = 'platform.task_create';
  const input = {
    capabilities: [
      capability('saga.capability.tasks', [platformTool(sharedId)]),
    ],
    installations: [
      installation('rogue-module', [moduleContribution(sharedId)]),
    ],
  };
  const catalog = assembleExecutionToolCatalog(input);

  // Only one entry for the shared logicalId, and it's the platform one.
  const matches = catalog.entries.filter((e) => e.logicalId === sharedId);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source, 'platform');
  assert.equal(catalog.platformCount, 1);
  assert.equal(catalog.moduleCount, 0);
  assert.deepEqual(catalog.collisions, [sharedId]);
});

test('collision list is sorted and deduped when multiple modules collide', () => {
  const input = {
    capabilities: [
      capability('saga.capability.tasks', [
        platformTool('platform.task_create'),
        platformTool('platform.task_list'),
      ]),
    ],
    installations: [
      installation('m1', [moduleContribution('platform.task_create')]),
      installation('m2', [
        moduleContribution('platform.task_create'),
        moduleContribution('platform.task_list'),
      ]),
    ],
  };
  const catalog = assembleExecutionToolCatalog(input);
  assert.deepEqual(catalog.collisions, ['platform.task_create', 'platform.task_list']);
});

test('non-colliding module tools are kept alongside platform tools', () => {
  const input = {
    capabilities: [capability('saga.capability.tasks', [platformTool('platform.task_create')])],
    installations: [
      installation('m', [
        moduleContribution('platform.task_create'), // collides -> dropped
        moduleContribution('m.unique_tool'),        // kept
      ]),
    ],
  };
  const catalog = assembleExecutionToolCatalog(input);
  const ids = catalog.entries.map((e) => e.logicalId).sort();
  assert.deepEqual(ids, ['m.unique_tool', 'platform.task_create']);
  assert.deepEqual(catalog.collisions, ['platform.task_create']);
});

// ---------------------------------------------------------------------------
// 5. findCatalogEntry — read-only lookup.
// ---------------------------------------------------------------------------

test('findCatalogEntry returns the entry by logicalId or undefined', () => {
  const catalog = assembleExecutionToolCatalog({
    capabilities: [capability('saga.capability.tasks', [platformTool('platform.task_create')])],
    installations: [installation('m', [moduleContribution('m.tool')])],
  });
  const found = findCatalogEntry(catalog, 'm.tool');
  assert.equal(found?.source, 'module');
  assert.equal(findCatalogEntry(catalog, 'absent.tool'), undefined);
});

// ---------------------------------------------------------------------------
// 6. contentHash stability under description changes.
// ---------------------------------------------------------------------------

test('contentHash changes when a registered description changes the entry text', () => {
  const baseInput = {
    capabilities: [capability('saga.capability.tasks', [platformTool('platform.task_create')])],
    installations: [],
  };
  const noLookup = assembleExecutionToolCatalog(baseInput);
  const withLookup = assembleExecutionToolCatalog({
    ...baseInput,
    describeContract: () => ({ summary: 'Different description text.' }),
  });
  // Descriptions differ -> entries differ -> hash differs.
  assert.notEqual(noLookup.entries[0].description, withLookup.entries[0].description);
  assert.notEqual(noLookup.contentHash, withLookup.contentHash);
});
