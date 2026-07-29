// @ts-check
/**
 * W10-A1 — lm-marketing package conformance test.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a1.md`.
 *
 * This is the package-level §0.13.10 proof. It asserts:
 *
 *   1. The manifest envelope passes `validateProcessModuleManifest`
 *      (structural + canonical-serializable) — loads clean.
 *   2. The NodeProtocol passes `validateNodeProtocolDefinition`.
 *   3. Every `resourceIndex` entry resolves to a real file under the package
 *      root and never escapes it (plan §5.3 module-relative resolution).
 *   4. The manifest is canonically serializable and round-trips through JSON.
 *   5. The static `manifest.json` mirrors the built envelope for the fields a
 *      describe interface / W10-A8 proof reads.
 *   6. THE IMPORT-LIST PROOF: every `.mjs` source file in this package imports
 *      ONLY from the public process-module SPI (`dist/process-modules/domain/
 *      spi/*`) or sibling files within the package — NEVER `src/index.ts`,
 *      `modules/catalog.ts`, `tracker-view/`, the composition root, or any
 *      existing built-in module. This IS the §0.13.10 import-list proof at the
 *      package level; W10-A8 re-asserts it across all modules-ext packages.
 *
 * Run: `node --test modules-ext/lm-marketing/lm-marketing.test.mjs`
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  marketingPackageManifest,
  validateMarketingPackageManifest,
  LM_MARKETING_MODULE_KEY,
  LM_MARKETING_MODULE_REF,
  LM_MARKETING_FLOW_NODE_ID,
  marketingDraftCampaignNodeProtocol,
  validateMarketingDraftCampaignNodeProtocol,
  marketingResourceIndex,
  marketingHandlerRefs,
} from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = HERE;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @param {string} label
 */
function assertPlainObject(v, label) {
  assert.ok(
    typeof v === 'object' && v !== null && !Array.isArray(v),
    `${label} must be a plain object`,
  );
}

/** Recursively collect every .mjs file under the package root. */
function collectMjsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip node_modules / dist artifacts if ever present.
      if (entry === 'node_modules' || entry === 'dist') continue;
      collectMjsFiles(full, acc);
    } else if (st.isFile() && entry.endsWith('.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 1. Manifest envelope validates + loads clean.
// ---------------------------------------------------------------------------

test('lm-marketing: manifest envelope passes validateProcessModuleManifest', () => {
  // The barrel already imported the manifest, which validates at load. Re-run
  // the validator explicitly to prove the SPI accepts it independent of the
  // load-time guard.
  const result = validateMarketingPackageManifest();
  assert.equal(result.ok, true, `manifest must validate: ${JSON.stringify(result.errors)}`);
});

test('lm-marketing: manifest has the required envelope fields', () => {
  const m = marketingPackageManifest;
  assert.equal(m.manifestFormatVersion, '1', 'manifestFormatVersion is "1" (real package envelope)');
  assert.equal(m.runtimeCompatibilityRange, '^3.0.0', 'runtimeCompatibilityRange');
  assertPlainObject(m.definition, 'definition');
  assert.ok(Array.isArray(m.resourceIndex) && m.resourceIndex.length > 0, 'resourceIndex non-empty');
  assert.ok(Array.isArray(m.handlerRefs) && m.handlerRefs.length > 0, 'handlerRefs non-empty');
  assertPlainObject(m.inputContractRef, 'inputContractRef');
  assertPlainObject(m.outputContractRef, 'outputContractRef');
});

test('lm-marketing: module identity is lm-marketing@1.0.0 (upgraded from synthetic 0.1.0)', () => {
  const id = marketingPackageManifest.definition.identity;
  assert.equal(id.name, 'lm-marketing', 'identity.name upgraded from synthetic-lm-marketing');
  assert.equal(id.version, '1.0.0', 'identity.version is a real 1.0.0 package');
  assert.equal(id.kind, 'lm-marketing', 'identity.kind');
  assert.equal(typeof id.displayName, 'string', 'displayName');
  assert.equal(typeof id.description, 'string', 'description');
  assert.equal(LM_MARKETING_MODULE_REF.name, 'lm-marketing');
  assert.equal(LM_MARKETING_MODULE_REF.version, '1.0.0');
  assert.equal(LM_MARKETING_MODULE_KEY, 'lm-marketing@1.0.0', 'module key is name@version');
});

test('lm-marketing: flow has exactly one lm node draft-campaign emitting campaign-drafted', () => {
  const flow = marketingPackageManifest.definition.flow;
  assert.equal(flow.entryNodeId, 'draft-campaign', 'entryNodeId');
  assert.equal(flow.nodes.length, 1, 'exactly one node');
  const node = flow.nodes[0];
  assert.equal(node.id, LM_MARKETING_FLOW_NODE_ID, 'node id');
  assert.equal(node.kind, 'lm', 'node kind is lm');
  assert.equal(node.executionProfile, 'marketing-author', 'references marketing-author profile');
  assert.equal(node.emitsOutcome, 'campaign-drafted', 'emits campaign-drafted');
  assert.deepEqual(flow.terminalNodeIds, ['draft-campaign'], 'terminal node');
  const outcomes = marketingPackageManifest.definition.outcomes;
  assert.deepEqual(
    outcomes.map((o) => o.code),
    ['campaign-drafted'],
    'one terminal outcome',
  );
  for (const o of outcomes) {
    assert.equal(typeof o.code, 'string', 'outcome.code');
    assert.equal(typeof o.description, 'string', 'outcome.description');
    assert.equal(o.terminal, true, 'outcome.terminal');
  }
});

// ---------------------------------------------------------------------------
// 2. NodeProtocol validates.
// ---------------------------------------------------------------------------

test('lm-marketing: draft-campaign NodeProtocol passes validateNodeProtocolDefinition', () => {
  const result = validateMarketingDraftCampaignNodeProtocol();
  assert.equal(result.ok, true, `protocol must validate: ${JSON.stringify(result.errors)}`);
});

test('lm-marketing: NodeProtocol owns the draft-campaign node with linear steps', () => {
  const p = marketingDraftCampaignNodeProtocol;
  assert.equal(p.owningFlowNodeId, 'draft-campaign', 'owns the draft-campaign node');
  assert.equal(p.retrySemantics, 'runtime-implemented-linear', 'supported retry semantics');
  assert.equal(p.entryStep, 'load-brief', 'entry step');
  assert.ok(p.steps.length === 4, 'four ordered steps');
  // Every step id is unique.
  const ids = p.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'unique step ids');
  // Every transition references existing steps and is unconditional (Wave 1/10
  // ratchet: only undefined conditions supported — plan §7.4.3 / C065).
  const stepSet = new Set(ids);
  for (const t of p.transitions) {
    assert.ok(stepSet.has(t.from), `transition.from ${t.from} exists`);
    assert.ok(stepSet.has(t.to), `transition.to ${t.to} exists`);
    assert.equal(t.condition, undefined, 'transitions are unconditional (C065 ratchet)');
    assert.equal(t.kind, 'linear', 'linear transitions');
  }
  // Recovery entry steps reference existing steps.
  for (const r of p.recoveryEntrySteps) {
    assert.ok(stepSet.has(r), `recoveryEntrySteps ${r} exists`);
  }
});

// ---------------------------------------------------------------------------
// 3. Resource index resolves under the package root + never escapes.
// ---------------------------------------------------------------------------

test('lm-marketing: every resourceIndex entry resolves under the package root', () => {
  for (const entry of marketingResourceIndex) {
    const resolved = path.resolve(PACKAGE_ROOT, entry.path);
    assert.ok(
      resolved.startsWith(PACKAGE_ROOT + path.sep) || resolved === PACKAGE_ROOT,
      `resource '${entry.logicalId}' (${entry.path}) must not escape the package root`,
    );
    assert.ok(existsSync(resolved), `resource '${entry.logicalId}' resolves at ${entry.path}`);
  }
});

test('lm-marketing: resource logicalIds are unique and kinds are known', () => {
  const ids = marketingResourceIndex.map((e) => e.logicalId);
  assert.equal(new Set(ids).size, ids.length, 'unique resource logicalIds');
  const knownKinds = new Set([
    'skill', 'instruction', 'reviewer-skill', 'template', 'mcp-call-template',
    'checklist', 'schema', 'error-hint', 'description', 'test',
  ]);
  for (const entry of marketingResourceIndex) {
    assert.ok(knownKinds.has(entry.kind), `resource kind '${entry.kind}' is known`);
    assert.equal(entry.digest, 'pending@wave-2', 'placeholder digest until Wave 2');
  }
});

test('lm-marketing: every execution-profile pinned resource is in the resource index', () => {
  const indexIds = new Set(marketingResourceIndex.map((e) => e.logicalId));
  // There are no logicalId references on the profile directly (it uses paths),
  // but the NodeProtocol steps DO reference logicalIds — prove they all resolve.
  for (const step of marketingDraftCampaignNodeProtocol.steps) {
    for (const r of step.resources) {
      assert.ok(indexIds.has(r), `protocol step '${step.id}' resource '${r}' is in the index`);
    }
  }
});

test('lm-marketing: handlerRefs are well-formed with unique logicalIds', () => {
  const ids = marketingHandlerRefs.map((h) => h.logicalId);
  assert.equal(new Set(ids).size, ids.length, 'unique handler logicalIds');
  for (const h of marketingHandlerRefs) {
    assert.equal(typeof h.logicalId, 'string', 'handler logicalId');
    assert.equal(typeof h.version, 'string', 'handler version');
    assert.equal(h.digest, 'pending@wave-2', 'handler placeholder digest');
  }
});

// ---------------------------------------------------------------------------
// 4. Manifest round-trips through canonical JSON.
// ---------------------------------------------------------------------------

test('lm-marketing: manifest round-trips through JSON (canonical-serializable)', () => {
  const json = JSON.stringify(marketingPackageManifest);
  const parsed = JSON.parse(json);
  assert.equal(parsed.definition.identity.name, 'lm-marketing', 'round-trip identity.name');
  assert.equal(parsed.manifestFormatVersion, '1', 'round-trip manifestFormatVersion');
  assert.equal(parsed.resourceIndex.length, marketingResourceIndex.length, 'round-trip resource count');
});

// ---------------------------------------------------------------------------
// 5. Static manifest.json mirrors the built envelope.
// ---------------------------------------------------------------------------

test('lm-marketing: static manifest.json mirrors the built envelope', () => {
  const manifestPath = path.join(PACKAGE_ROOT, 'manifest.json');
  assert.ok(existsSync(manifestPath), 'manifest.json exists');
  /** @type {any} */
  const staticManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(staticManifest.identity?.name ?? staticManifest.definition?.identity?.name, 'lm-marketing', 'static manifest name');
  assert.equal(staticManifest.manifestFormatVersion, '1', 'static manifest format version');
  assert.equal(staticManifest.runtimeCompatibilityRange, '^3.0.0', 'static manifest compat range');
  // The static manifest carries the envelope shape (definition + resourceIndex + handlerRefs).
  assertPlainObject(staticManifest.definition, 'static manifest.definition');
  assert.ok(Array.isArray(staticManifest.resourceIndex), 'static manifest.resourceIndex');
  assert.ok(Array.isArray(staticManifest.handlerRefs), 'static manifest.handlerRefs');
  assert.equal(
    staticManifest.resourceIndex.length,
    marketingResourceIndex.length,
    'static manifest resource count matches built envelope',
  );
});

// ---------------------------------------------------------------------------
// 6. THE IMPORT-LIST PROOF (§0.13.10).
//
// Every .mjs source file in this package must import ONLY from:
//   - sibling files within the package (./ or ../ within modules-ext/lm-marketing)
//   - the public process-module SPI under dist/process-modules/ (runtime surface)
//
// It must NEVER import:
//   - src/index.ts (the monolith entry)
//   - src/process-modules/modules/catalog.ts (built-in catalog)
//   - src/process-modules/modules/installations.ts (built-in installations)
//   - src/process-modules/composition/* (composition root)
//   - tracker-view/*
//   - any built-in module (discovery/formalization/development/delivery)
//
// This IS the §0.13.10 proof: an arbitrary LM package installs and executes
// through the SPI alone, with no Runtime/catalog/runner/gateway/existing-module
// dependency.
// ---------------------------------------------------------------------------

// Relative-import regex (./ or ../ specifiers in import/export ... from '...').
const RELATIVE_IMPORT_RE =
  /(?:^|\n)[ \t]*(?:import|export)[^;]*?\bfrom\s*['"]([.][./][^'"]+)['"]/g;

test('lm-marketing: §0.13.10 import-list proof — SPI-only imports', () => {
  const files = collectMjsFiles(PACKAGE_ROOT);
  assert.ok(files.length >= 4, `expected >=4 .mjs source files, got ${files.length}`);

  /** @type {string[]} */
  const violations = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(PACKAGE_ROOT, file).split(path.sep).join('/');
    let match;
    RELATIVE_IMPORT_RE.lastIndex = 0;
    while ((match = RELATIVE_IMPORT_RE.exec(src)) !== null) {
      const spec = match[1];
      // Sibling imports (./foo, ../foo within the package) are always allowed.
      // The only OUT-OF-PACKAGE relative import permitted is into the public
      // process-module SPI under ../../dist/process-modules/.
      if (spec.startsWith('./') || spec.startsWith('../')) {
        // Resolve and classify.
        const resolved = path.resolve(path.dirname(file), spec).split(path.sep).join('/');
        if (resolved.includes('modules-ext/lm-marketing/')) {
          continue; // intra-package sibling
        }
        // Out-of-package: must land under dist/process-modules/ SPI only.
        const isSpiSurface =
          resolved.includes('/dist/process-modules/domain/spi/') ||
          resolved.includes('/dist/process-modules/installation/') ||
          resolved.includes('/dist/process-modules/application/');
        if (!isSpiSurface) {
          violations.push(`${rel}: ${spec} -> ${resolved.split(/.*\/dist\//)[1] || resolved}`);
        }
        continue;
      }
      violations.push(`${rel}: non-relative import ${spec}`);
    }
  }

  if (violations.length > 0) {
    assert.fail(
      `§0.13.10 violation: lm-marketing imports outside the public SPI:\n  ` +
        violations.join('\n  '),
    );
  }
});

test('lm-marketing: §0.13.10 import-list proof — no banned surfaces', () => {
  // Belt-and-braces: scan raw source for any banned specifier substring. Even a
  // comment-only mention of these surfaces is worth flagging in a proof
  // package, but we only FAIL on actual import/export statements.
  const files = collectMjsFiles(PACKAGE_ROOT);
  const BANNED = [
    'src/index',
    'process-modules/modules/catalog',
    'process-modules/modules/installations',
    'process-modules/composition/',
    'tracker-view/',
    'modules/discovery/',
    'modules/formalization/',
    'modules/development/',
    'modules/delivery/',
  ];
  /** @type {string[]} */
  const violations = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(PACKAGE_ROOT, file).split(path.sep).join('/');
    for (const banned of BANNED) {
      // Only fail on import/export statements that mention a banned surface.
      const re = new RegExp(
        `(?:^|\\n)[ \\t]*(?:import|export)[^;]*?['"][^'"]*${banned.replace(/\//g, '\\/')}`,
      );
      if (re.test(src)) {
        violations.push(`${rel}: imports banned surface '${banned}'`);
      }
    }
  }
  if (violations.length > 0) {
    assert.fail(
      `§0.13.10 violation: lm-marketing imports a banned surface:\n  ` +
        violations.join('\n  '),
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Self-contained: no dependency on any built-in module name at runtime.
// ---------------------------------------------------------------------------

test('lm-marketing: module kind is opaque metadata, not a runtime switch key', () => {
  // The Runtime must never switch on module kind (plan §3.6). This package's
  // kind 'lm-marketing' is opaque metadata for catalog/describe views only —
  // it must NOT collide with any built-in module kind.
  const builtInKinds = new Set([
    'discovery', 'formalization', 'development', 'delivery',
  ]);
  const kind = marketingPackageManifest.definition.identity.kind;
  assert.ok(!builtInKinds.has(kind), `kind '${kind}' must not collide with a built-in module`);
  assert.equal(kind, 'lm-marketing', 'opaque module-kind string');
});
