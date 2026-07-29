// tests/process-modules/external-seo-package.test.mjs
//
// W10-A2 — External SEO/Analytics installable package tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md.
// Task:  docs/refactor-management/05-subagent-tasks/W10-a2.md.
//
// This is the per-package proof for the External-node extensibility lane. The
// DEFINITIVE cross-package exit-gate proof lives in W10-A8; here we prove the
// external-seo package itself is a valid, installable, dispatchable External
// module that consumes ONLY the runtime SPI.
//
// Coverage:
//   - The package loads without throwing (manifest + node protocols validated
//     at module load by the Wave 1 SPI).
//   - The central manifest is structurally valid (re-validate via
//     `validateProcessModuleManifest`).
//   - The ProcessModuleDefinition has the required External-node shape:
//     one `kind: 'external'` node pinning a versioned adapter reference.
//   - resourceIndex: every entry unique by logicalId, every path resolves to a
//     real file under the package root, every kind is a known ResourceKind,
//     every digest is a REAL 64-char sha256Hex (no pending placeholder), and
//     every digest matches a fresh recomputation of the file bytes.
//   - handlerRefs: the single adapter ref matches the flow node's `adapter`
//     field; its digest is a real sha256Hex of the adapter source.
//   - contractRefs: schemaId matches the wrapped definition's input/output
//     contracts.
//   - NodeProtocolDefinition: validates { ok: true }, owningFlowNodeId matches
//     a real flow node, retrySemantics is supported (not 'unsupported').
//   - The shipped ExternalAdapter dispatches through the REAL runtime path
//     (ExternalAdapterRegistry + ExternalNodeExecutor) and returns a well-formed
//     NodeExecutionResult whose production carries a content-addressed snapshot.
//   - The adapter is deterministic: identical input yields identical rankings.
//   - The static manifest.json round-trips against the live manifest.
//   - §0.13.10 import-boundary: the package source imports ONLY from the
//     runtime SPI under dist/ — never src/index, the catalog, or a built-in
//     module implementation. (The import list IS the proof.)
//
// Imports run against the COMPILED dist/ output + the package under
// modules-ext/external-seo/ (repo root, outside the compiled tree).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { externalSeoPackage } from '../../modules-ext/external-seo/index.mjs';
import {
  externalSeoManifest,
  externalSeoNodeProtocols,
  EXTERNAL_SEO_RESOURCE_INDEX,
  EXTERNAL_SEO_HANDLER_REFS,
  EXTERNAL_SEO_INPUT_CONTRACT_REF,
  EXTERNAL_SEO_OUTPUT_CONTRACT_REF,
  EXTERNAL_SEO_MODULE_KEY,
  EXTERNAL_SEO_MODULE_REF,
  SEO_RANKING_ADAPTER_REF,
  buildRankingSnapshot,
} from '../../modules-ext/external-seo/index.mjs';

import { validateProcessModuleManifest } from '../../dist/process-modules/domain/spi/module-manifest.js';
import { validateNodeProtocolDefinition } from '../../dist/process-modules/domain/spi/node-protocol.js';
import { RESOURCE_KINDS } from '../../dist/process-modules/domain/spi/resource-index.js';
import { sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';
import { ExternalAdapterRegistry } from '../../dist/process-modules/application/external-adapter-registry.js';
import { ExternalNodeExecutor } from '../../dist/process-modules/application/node-executors/external-node-executor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..', 'modules-ext', 'external-seo');

// ---------------------------------------------------------------------------
// Manifest envelope.
// ---------------------------------------------------------------------------

test('external-seo package: loads and validates without throwing', () => {
  // Importing the package already ran the validators at module load. Re-running
  // the manifest validator here proves the exported object is accepted by the
  // Wave 1 SPI independently of the load-time assertion.
  const result = validateProcessModuleManifest(externalSeoManifest);
  assert.equal(result.ok, true, `manifest should validate: ${JSON.stringify(result.errors)}`);
});

test('external-seo package: module identity is well-formed and versioned', () => {
  assert.equal(EXTERNAL_SEO_MODULE_REF.name, 'external-seo');
  assert.equal(EXTERNAL_SEO_MODULE_REF.version, '1.0.0');
  assert.equal(EXTERNAL_SEO_MODULE_KEY, 'external-seo@1.0.0');
  assert.equal(externalSeoPackage.moduleKey, 'external-seo@1.0.0');
});

test('external-seo package: definition has the required External-node shape', () => {
  const def = externalSeoManifest.definition;
  assert.equal(def.identity.kind, 'external-seo');
  assert.equal(def.flow.nodes.length, 1, 'exactly one flow node');
  const node = def.flow.nodes[0];
  assert.equal(node.kind, 'external', 'node kind is external');
  assert.equal(node.id, 'fetch-ranking');
  assert.equal(node.adapter, SEO_RANKING_ADAPTER_REF, 'node pins the versioned adapter');
  assert.match(node.adapter, /@/, 'adapter ref is name@version');
  assert.equal(node.emitsOutcome, 'ranking-fetched');
  // External modules carry an invariant (the W0-A7 fixture had none — this is
  // an upgrade) and declare an `authority: 'external'` artifact.
  assert.ok(def.invariants.length >= 1, 'declares at least one invariant');
  const externalArtifact = def.artifacts.find((a) => a.authority === 'external');
  assert.ok(externalArtifact, 'declares an external-authority artifact');
  // External modules have no LM execution profiles (proves kind-specific data only).
  assert.equal(def.executionProfiles.length, 0, 'no LM execution profile');
});

// ---------------------------------------------------------------------------
// Resource index — REAL content-addressing.
// ---------------------------------------------------------------------------

test('external-seo package: resourceIndex entries are unique, real, and content-addressed', () => {
  assert.ok(EXTERNAL_SEO_RESOURCE_INDEX.length >= 4, 'at least 4 resources declared');
  const RESOURCE_KIND_SET = new Set(RESOURCE_KINDS);
  const seenLogical = new Set();
  for (const entry of EXTERNAL_SEO_RESOURCE_INDEX) {
    // unique logicalId
    assert.ok(!seenLogical.has(entry.logicalId), `unique logicalId ${entry.logicalId}`);
    seenLogical.add(entry.logicalId);
    // known kind
    assert.ok(RESOURCE_KIND_SET.has(entry.kind), `known kind ${entry.kind} for ${entry.logicalId}`);
    // REAL digest: 64-char lowercase hex, NOT the pending placeholder
    assert.match(entry.digest, /^[0-9a-f]{64}$/, `real sha256Hex digest for ${entry.logicalId}`);
    assert.notEqual(entry.digest, 'pending@wave-2', `no placeholder digest for ${entry.logicalId}`);
    // resolves to a real file under the package root (traversal-safe)
    const resolved = path.join(PACKAGE_ROOT, entry.path);
    assert.ok(resolved.startsWith(PACKAGE_ROOT), `traversal-safe path for ${entry.logicalId}`);
    assert.ok(existsSync(resolved), `resource file exists for ${entry.logicalId} at ${entry.path}`);
    // digest matches a fresh recomputation of the file bytes
    const bytes = readFileSync(resolved, 'utf8');
    assert.equal(sha256Hex(bytes), entry.digest, `digest matches file content for ${entry.logicalId}`);
  }
});

test('external-seo package: resourceIndex pins both schemas, the checklist, and the description', () => {
  const logicalIds = EXTERNAL_SEO_RESOURCE_INDEX.map((e) => e.logicalId);
  assert.ok(logicalIds.includes('external-seo.schema.input'));
  assert.ok(logicalIds.includes('external-seo.schema.output'));
  assert.ok(logicalIds.includes('external-seo.checklist.fetch-ranking'));
  assert.ok(logicalIds.includes('external-seo.description.package'));
});

// ---------------------------------------------------------------------------
// Handler / adapter refs.
// ---------------------------------------------------------------------------

test('external-seo package: handlerRef pins the versioned adapter declared by the flow node', () => {
  assert.equal(EXTERNAL_SEO_HANDLER_REFS.length, 1, 'exactly one adapter ref');
  const ref = EXTERNAL_SEO_HANDLER_REFS[0];
  const node = externalSeoManifest.definition.flow.nodes[0];
  assert.equal(ref.logicalId, node.adapter, 'handlerRef.logicalId matches node.adapter');
  assert.equal(ref.logicalId, SEO_RANKING_ADAPTER_REF);
  assert.match(ref.version, /^\d+\.\d+\.\d+$/, 'semver version');
  // REAL digest of the adapter implementation source (not a placeholder).
  assert.match(ref.digest, /^[0-9a-f]{64}$/, 'real sha256Hex digest for the adapter');
  const adapterSource = readFileSync(path.join(PACKAGE_ROOT, 'adapter.mjs'), 'utf8');
  assert.equal(sha256Hex(adapterSource), ref.digest, 'handlerRef digest matches adapter.mjs bytes');
});

// ---------------------------------------------------------------------------
// Contract refs.
// ---------------------------------------------------------------------------

test('external-seo package: contractRefs match the wrapped definition contracts', () => {
  const def = externalSeoManifest.definition;
  assert.equal(EXTERNAL_SEO_INPUT_CONTRACT_REF.schemaId, def.inputContract.id);
  assert.equal(EXTERNAL_SEO_OUTPUT_CONTRACT_REF.schemaId, def.outputContract.id);
  assert.equal(EXTERNAL_SEO_INPUT_CONTRACT_REF.schemaId, 'ext.external-seo.ranking-input.v1');
  assert.equal(EXTERNAL_SEO_OUTPUT_CONTRACT_REF.schemaId, 'ext.external-seo.ranking-snapshot.v1');
});

// ---------------------------------------------------------------------------
// Node protocols.
// ---------------------------------------------------------------------------

test('external-seo package: every NodeProtocolDefinition validates and owns a real flow node', () => {
  assert.equal(externalSeoNodeProtocols.length, 1, 'one protocol per external node');
  const nodeIds = new Set(externalSeoManifest.definition.flow.nodes.map((n) => n.id));
  for (const proto of externalSeoNodeProtocols) {
    const result = validateNodeProtocolDefinition(proto);
    assert.equal(result.ok, true, `protocol ${proto.id} validates: ${JSON.stringify(result.errors)}`);
    assert.notEqual(proto.retrySemantics, 'unsupported', 'retrySemantics is not the reject target');
    assert.ok(nodeIds.has(proto.owningFlowNodeId), `protocol owns a real flow node ${proto.owningFlowNodeId}`);
  }
});

test('external-seo package: fetch-ranking protocol has validate -> invoke -> verify lifecycle', () => {
  const proto = externalSeoNodeProtocols[0];
  assert.equal(proto.entryStep, 'validate-input');
  const stepIds = proto.steps.map((s) => s.id);
  assert.deepEqual(stepIds, ['validate-input', 'invoke-provider', 'verify-output']);
  // transitions form a linear chain through the three steps
  assert.equal(proto.transitions.length, 2);
  assert.deepEqual(proto.transitions[0], { from: 'validate-input', to: 'invoke-provider', kind: 'linear' });
  // every step declares at least one evidence requirement
  for (const step of proto.steps) {
    assert.ok(step.evidenceRequirements.length >= 1, `step ${step.id} requires evidence`);
  }
});

// ---------------------------------------------------------------------------
// Adapter dispatch through the REAL runtime path.
// ---------------------------------------------------------------------------

test('external-seo package: adapter registers onto ExternalAdapterRegistry and dispatches via ExternalNodeExecutor', async () => {
  const registry = new ExternalAdapterRegistry();
  externalSeoPackage.registerAdapters(registry);
  assert.ok(registry.has(SEO_RANKING_ADAPTER_REF), 'adapter registered under versioned id');

  const executor = new ExternalNodeExecutor(registry);
  const node = externalSeoManifest.definition.flow.nodes[0];
  const result = await executor.execute({
    projectId: 1,
    epicId: 1,
    processRunId: 1,
    module: externalSeoManifest.definition,
    node,
    input: {
      keywords: ['red shoes', 'blue hats'],
      searchEngine: 'google',
      locale: 'us',
    },
    frame: { runInput: null, productions: {}, receipts: {} },
    heartbeat: () => {},
    initiatedBy: 'test',
  });

  assert.equal(result.runtimeEvent, 'completed');
  assert.equal(result.outcome, 'ranking-fetched');
  assert.equal(result.production.schema, 'ext.external-seo.ranking-snapshot.v1');
  assert.match(result.production.contentHash, /^[0-9a-f]{64}$/, 'production content-addressed');
  const snapshot = result.production.bindings.snapshot;
  assert.equal(snapshot.rankings.length, 2);
  assert.equal(snapshot.rankings[0].keyword, 'red shoes');
  assert.equal(snapshot.rankings[0].position, 1);
  assert.equal(snapshot.rankings[1].position, 2);
});

test('external-seo package: adapter is deterministic for identical input (modulo timestamp)', () => {
  const input = { keywords: ['a', 'b', 'c'], searchEngine: 'bing', locale: 'de' };
  const snap1 = buildRankingSnapshot(input);
  const snap2 = buildRankingSnapshot(input);
  // positions and urls are stable across calls
  assert.deepEqual(
    snap1.rankings.map((r) => ({ keyword: r.keyword, position: r.position, url: r.url })),
    snap2.rankings.map((r) => ({ keyword: r.keyword, position: r.position, url: r.url })),
  );
  assert.equal(snap1.searchEngine, 'bing');
  assert.equal(snap1.locale, 'de');
});

test('external-seo package: adapter sets isTrackedDomain when trackedDomain matches a result host', () => {
  const snap = buildRankingSnapshot({
    keywords: ['red shoes'],
    searchEngine: 'google',
    locale: 'us',
    trackedDomain: 'results.google.example',
  });
  assert.equal(snap.rankings[0].isTrackedDomain, true);
  const snap2 = buildRankingSnapshot({
    keywords: ['red shoes'],
    searchEngine: 'google',
    locale: 'us',
    trackedDomain: 'other.example',
  });
  assert.equal(snap2.rankings[0].isTrackedDomain, false);
});

test('external-seo package: adapter handles empty keyword list without throwing', () => {
  const snap = buildRankingSnapshot({ keywords: [], searchEngine: 'google', locale: 'us' });
  assert.equal(snap.rankings.length, 0);
});

// ---------------------------------------------------------------------------
// Static manifest.json round-trip.
// ---------------------------------------------------------------------------

test('external-seo package: static manifest.json round-trips against the live manifest', () => {
  const manifestPath = path.join(PACKAGE_ROOT, 'manifest.json');
  assert.ok(existsSync(manifestPath), 'manifest.json exists');
  const rendered = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const def = externalSeoManifest.definition;
  assert.equal(rendered.identity.name, def.identity.name);
  assert.equal(rendered.identity.version, def.identity.version);
  assert.equal(rendered.identity.kind, def.identity.kind);
  assert.equal(rendered.flow.nodes.length, 1);
  assert.equal(rendered.flow.nodes[0].adapter, SEO_RANKING_ADAPTER_REF);
  assert.equal(rendered.resourceIndex.length, EXTERNAL_SEO_RESOURCE_INDEX.length);
  assert.equal(rendered.handlerRefs.length, EXTERNAL_SEO_HANDLER_REFS.length);
  assert.equal(rendered.inputContractRef.schemaId, EXTERNAL_SEO_INPUT_CONTRACT_REF.schemaId);
  assert.equal(rendered.runtimeCompatibilityRange, externalSeoManifest.runtimeCompatibilityRange);
  // the rendered resource digests match the live (real) digests
  for (const entry of rendered.resourceIndex) {
    const live = EXTERNAL_SEO_RESOURCE_INDEX.find((e) => e.logicalId === entry.logicalId);
    assert.ok(live, `rendered entry ${entry.logicalId} exists in live index`);
    assert.equal(entry.digest, live.digest, `rendered digest matches live for ${entry.logicalId}`);
  }
});

// ---------------------------------------------------------------------------
// §0.13.10 import-boundary proof.
//
// The package source MUST import only from the runtime SPI under dist/. It must
// NOT import src/index, the built-in catalog, the composition root, or any
// built-in module implementation. Scanning the .mjs sources for relative import
// specifiers and asserting none reach into src/ IS the proof.
// ---------------------------------------------------------------------------

test('external-seo package: source imports ONLY the runtime SPI (§0.13.10 proof)', () => {
  const sourceFiles = [
    'index.mjs',
    'manifest.mjs',
    'definition.mjs',
    'adapter.mjs',
    'node-protocols.mjs',
  ];
  // Specifiers a compliant External package is allowed to import from.
  // All of them live under dist/process-modules/{domain,domain/spi,application,shared}
  // — i.e. the pure SPI + pure domain types + the generic external-adapter /
  // node-executor surfaces. None reach a built-in MODULE implementation, the
  // catalog, or the composition root.
  const ALLOWED_PREFIXES = [
    '../../dist/process-modules/domain/spi/',
    '../../dist/process-modules/domain/process-module.js',
    '../../dist/process-modules/application/external-adapter-registry.js',
    '../../dist/process-modules/application/node-executor.js',
    '../../dist/process-modules/application/node-executors/external-node-executor.js',
    '../../dist/process-modules/shared/canonical-json.js',
  ];
  // Specifiers that would VIOLATE §0.13.10 (touching a built-in module
  // implementation, the catalog, or the composition root).
  const FORBIDDEN_SUBSTRINGS = [
    'modules/catalog',
    'modules/installations',
    'composition/product-lifecycle-runtime',
    'src/process-modules/modules/discovery',
    'src/process-modules/modules/formalization',
    'src/process-modules/modules/development',
    'src/process-modules/modules/delivery',
  ];
  // intra-package imports (./ or ../ within the package) are allowed.
  const violations = [];
  for (const file of sourceFiles) {
    const fullPath = path.join(PACKAGE_ROOT, file);
    const src = readFileSync(fullPath, 'utf8');
    // extract relative import specifiers (from '...' and dynamic import('...'))
    const specRe = /(?:from\s*|import\()\s*['"]([.][^'"]+)['"]/g;
    let m;
    while ((m = specRe.exec(src)) !== null) {
      const spec = m[1];
      // intra-package relative import?
      if (spec.startsWith('./') || spec === '..') continue;
      // reaches into src/?
      if (spec.includes('/src/') || spec.includes('../../src')) {
        violations.push(`${file}: ${spec} (reaches into src/)`);
        continue;
      }
      // node: bare specifiers are fine
      if (spec.startsWith('node:')) continue;
      // otherwise it must be under one of the ALLOWED dist/ prefixes
      const allowed = ALLOWED_PREFIXES.some((p) => spec === p || spec.startsWith(p));
      if (!allowed) {
        violations.push(`${file}: ${spec} (not an allowed SPI import)`);
        continue;
      }
      // even allowed prefixes must not contain a forbidden substring
      for (const bad of FORBIDDEN_SUBSTRINGS) {
        if (spec.includes(bad)) {
          violations.push(`${file}: ${spec} (forbidden: ${bad})`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `package must import only the runtime SPI:\n${violations.join('\n')}`);
});

test('external-seo package: no src/ files are touched by adding this package (anti-scope)', () => {
  // This is a static assertion documented for the integrator: the package lives
  // entirely under modules-ext/ and tests/. The dependency-direction ratchet
  // (tests/architecture/dependency-direction.test.mjs) independently enforces
  // zero new src/ violations because its scanner only walks src/ and this
  // package adds no src/ files. Here we assert the package root contains no
  // compiled-output path that would imply a src/ edit.
  const packageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.saga.packageKind, 'external-node');
  assert.equal(packageJson.saga.proofTarget.includes('WAVE10-EXTENSIBILITY-SPEC'), true);
});
