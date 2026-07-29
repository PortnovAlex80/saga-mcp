// tests/process-modules/formalization-package-manifest.test.mjs
//
// W8-A1 — Formalization package manifest tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
// Task:  docs/refactor-management/05-subagent-tasks/W08-a1.md.
//
// Coverage:
//   - The central `formalizationPackageManifest` is structurally valid
//     (`validateProcessModuleManifest` ok) and loads without throwing.
//   - It wraps the EXISTING `formalizationProcessModule` definition verbatim
//     (no duplication, no drift).
//   - resourceIndex: every entry is unique by logicalId, every path points at
//     a real resource on disk, every kind is a known ResourceKind, every
//     digest is the documented pending placeholder.
//   - handlerRefs: every logicalId matches a handler declared in the formalization
//     definition (FORMALIZATION_HANDLER_IDS), unique by logicalId.
//   - contractRefs: schemaId matches the wrapped definition's input/output
//     contracts.
//   - The manifest round-trips through canonical JSON (pure data, plan §3.5).
//   - resourceIndex pins EVERY execution-profile skill/template/checklist so
//     the module needs no global resource lookup (WAVE8 exit gate §2.2).
//
// Imports run against the COMPILED dist/ output (node --test resolves .mjs
// against the repo root; production files live under
// dist/process-modules/modules/formalization/package/).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { formalizationPackageManifest } from '../../dist/process-modules/modules/formalization/package/manifest.js';
import {
  FORMALIZATION_RESOURCE_INDEX,
  FORMALIZATION_HANDLER_REFS,
  FORMALIZATION_INPUT_CONTRACT_REF,
  FORMALIZATION_OUTPUT_CONTRACT_REF,
  FORMALIZATION_MANIFEST_FORMAT_VERSION,
  FORMALIZATION_RUNTIME_COMPATIBILITY_RANGE,
  FORMALIZATION_MODULE_KEY,
} from '../../dist/process-modules/modules/formalization/package/index.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';
import { FORMALIZATION_HANDLER_IDS } from '../../dist/process-modules/modules/formalization/formalization-installation.js';
import {
  FORMALIZATION_CASE_SCHEMA,
  SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
} from '../../dist/process-modules/modules/formalization/formalization-schemas.js';
import { validateProcessModuleManifest } from '../../dist/process-modules/domain/spi/module-manifest.js';
import { RESOURCE_KINDS } from '../../dist/process-modules/domain/spi/resource-index.js';
import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const RESOURCE_KIND_SET = new Set(RESOURCE_KINDS);

// ===========================================================================
// 1. Structural validity + identity.
// ===========================================================================

test('formalizationPackageManifest validates { ok: true }', () => {
  const result = validateProcessModuleManifest(formalizationPackageManifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('formalizationPackageManifest wraps the existing formalizationProcessModule definition', () => {
  // The manifest WRAPS the pure definition; it must not duplicate or drift.
  assert.equal(
    formalizationPackageManifest.definition,
    formalizationProcessModule,
    'manifest.definition must reference the existing formalizationProcessModule',
  );
});

test('manifestFormatVersion is the migrated "1" (not legacy-0)', () => {
  // Wave 8 bumps formalization from legacy-0 to '1' (populated resource/handler arrays).
  assert.equal(formalizationPackageManifest.manifestFormatVersion, '1');
  assert.equal(FORMALIZATION_MANIFEST_FORMAT_VERSION, '1');
});

test('runtimeCompatibilityRange is a non-empty semver range', () => {
  assert.match(FORMALIZATION_RUNTIME_COMPATIBILITY_RANGE, /\^3\./);
  assert.equal(
    formalizationPackageManifest.runtimeCompatibilityRange,
    FORMALIZATION_RUNTIME_COMPATIBILITY_RANGE,
  );
});

test('FORMALIZATION_MODULE_KEY matches the wrapped definition identity', () => {
  const { name, version } = formalizationProcessModule.identity;
  assert.equal(FORMALIZATION_MODULE_KEY, `${name}@${version}`);
});

// ===========================================================================
// 2. Resource index.
// ===========================================================================

test('resourceIndex is non-empty and exported under the same array', () => {
  assert.ok(formalizationPackageManifest.resourceIndex.length > 0);
  assert.equal(formalizationPackageManifest.resourceIndex, FORMALIZATION_RESOURCE_INDEX);
});

test('every resource logicalId is unique', () => {
  const ids = FORMALIZATION_RESOURCE_INDEX.map((e) => e.logicalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate logicalIds: ${ids.join(', ')}`);
});

test('every resource kind is a known ResourceKind', () => {
  for (const entry of FORMALIZATION_RESOURCE_INDEX) {
    assert.ok(
      RESOURCE_KIND_SET.has(entry.kind),
      `unknown resource kind '${entry.kind}' for ${entry.logicalId}`,
    );
  }
});

test('every resource path points at a real file on disk (pinned, not global)', () => {
  // WAVE8 exit gate §2.1/§2.2: Formalization runs through pinned package
  // resources with no global resource lookup. Each declared path must resolve
  // to a real file under the repository root.
  for (const entry of FORMALIZATION_RESOURCE_INDEX) {
    const resolved = path.resolve(REPO_ROOT, entry.path);
    assert.ok(
      existsSync(resolved),
      `resource ${entry.logicalId} path does not exist on disk: ${entry.path}`,
    );
  }
});

test('every resource path is relative and traversal-safe', () => {
  for (const entry of FORMALIZATION_RESOURCE_INDEX) {
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
  // Wave 8 pins resources by logicalId + path; the Wave 2 content-addressed
  // installer replaces the placeholder with sha256Hex of the real bytes.
  for (const entry of FORMALIZATION_RESOURCE_INDEX) {
    assert.equal(entry.digest, 'pending@wave-2', entry.logicalId);
  }
});

test('resourceIndex pins every execution-profile skill + template + checklist referenced by the definition', () => {
  // Collect every skill/template/checklist string the execution profiles
  // reference. The resourceIndex must pin each so no global lookup is needed.
  const declared = new Set(FORMALIZATION_RESOURCE_INDEX.map((e) => e.path));

  const referencedPaths = new Set();
  for (const profile of formalizationProcessModule.executionProfiles) {
    referencedPaths.add(profile.executionSkill ? skillPath(profile.executionSkill) : null);
    referencedPaths.add(profile.reviewSkill ? skillPath(profile.reviewSkill) : null);
    referencedPaths.add(profile.semanticSkill ? skillPath(profile.semanticSkill) : null);
    referencedPaths.add(profile.protocolSkill ? skillPath(profile.protocolSkill) : null);
    if (profile.trackerTemplate) referencedPaths.add(profile.trackerTemplate);
    for (const t of profile.workspaceTemplates ?? []) referencedPaths.add(t);
    for (const t of profile.callTemplates ?? []) referencedPaths.add(t);
    for (const c of profile.checklists ?? []) referencedPaths.add(c);
  }
  referencedPaths.delete(null);

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
  assert.ok(formalizationPackageManifest.handlerRefs.length > 0);
  assert.equal(formalizationPackageManifest.handlerRefs, FORMALIZATION_HANDLER_REFS);
});

test('every handler logicalId is unique', () => {
  const ids = FORMALIZATION_HANDLER_REFS.map((h) => h.logicalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate handler logicalIds: ${ids.join(', ')}`);
});

test('handlerRefs cover every handler declared in the formalization definition', () => {
  const declared = new Set(FORMALIZATION_HANDLER_REFS.map((h) => h.logicalId));
  // Every handler id the installation registers must be pinned.
  for (const id of Object.values(FORMALIZATION_HANDLER_IDS)) {
    assert.ok(declared.has(id), `handler not pinned in handlerRefs: ${id}`);
  }
  // Every `handler:` field on a kernel node in the flow must be pinned.
  for (const node of formalizationProcessModule.flow.nodes) {
    if (node.kind === 'kernel' && node.handler && node.handler !== 'process-outcome-emitter') {
      assert.ok(
        declared.has(node.handler),
        `flow kernel node handler not pinned: ${node.handler}`,
      );
    }
  }
});

test('every handler version is non-empty and digest is the pending placeholder', () => {
  for (const h of FORMALIZATION_HANDLER_REFS) {
    assert.ok(h.version.length > 0, h.logicalId);
    assert.equal(h.digest, 'pending@wave-2', h.logicalId);
  }
});

// ===========================================================================
// 4. Contract refs.
// ===========================================================================

test('inputContractRef schemaId matches the wrapped definition inputContract', () => {
  assert.equal(FORMALIZATION_INPUT_CONTRACT_REF.schemaId, FORMALIZATION_CASE_SCHEMA);
  assert.equal(
    formalizationPackageManifest.inputContractRef.schemaId,
    formalizationProcessModule.inputContract.id,
  );
});

test('outputContractRef schemaId matches the wrapped definition outputContract', () => {
  assert.equal(FORMALIZATION_OUTPUT_CONTRACT_REF.schemaId, SOLUTION_CONTRACT_CERTIFICATE_SCHEMA);
  assert.equal(
    formalizationPackageManifest.outputContractRef.schemaId,
    formalizationProcessModule.outputContract.id,
  );
});

test('contractRef digests are the documented pending placeholder', () => {
  assert.equal(FORMALIZATION_INPUT_CONTRACT_REF.digest, 'pending@wave-2');
  assert.equal(FORMALIZATION_OUTPUT_CONTRACT_REF.digest, 'pending@wave-2');
});

// ===========================================================================
// 5. Purity: canonical round-trip (plan §3.5).
// ===========================================================================

test('formalizationPackageManifest round-trips through canonical JSON (pure data)', () => {
  const serialized = canonicalJson(formalizationPackageManifest);
  const parsed = JSON.parse(serialized);
  // Re-serialize the parsed value: identical bytes => canonically stable.
  assert.equal(canonicalJson(parsed), serialized);
  // sha256Hex over the manifest is stable (content-addressable).
  const h1 = sha256Hex(formalizationPackageManifest);
  const h2 = sha256Hex(parsed);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ===========================================================================
// Helpers.
// ===========================================================================

/**
 * Map a bare skill name (e.g. 'saga-product') to the on-disk SKILL.md path the
 * resourceIndex declares. The formalization execution profiles reference
 * skills by bare name; the package pins them at skills/<name>/SKILL.md.
 */
function skillPath(skillName) {
  return `skills/${skillName}/SKILL.md`;
}
