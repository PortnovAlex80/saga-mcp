// tests/process-modules/documentation-package-manifest.test.mjs
//
// Documentation workshop package manifest tests (mirrors the delivery W9-A5
// manifest test shape). Imports run against the COMPILED dist/ output.
//
// Coverage:
//   - the central `documentationPackageManifest` loads and is structurally
//     valid (`validateProcessModuleManifest` is invoked at module load);
//   - it wraps the existing `documentationProcessModule` definition verbatim;
//   - every resourceIndex entry has a unique logicalId, a known kind, the
//     documented pending digest and a real file on disk at a repo-relative
//     traversal-safe path;
//   - handlerRefs cover every kernel `handler:` field declared by the flow
//     (excluding the shared `process-outcome-emitter`);
//   - contractRefs match the wrapped definition input/output contracts;
//   - the manifest round-trips through canonical JSON (pure data).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { documentationPackageManifest } from '../../dist/process-modules/modules/documentation/package/manifest.js';
import { documentationProcessModule } from '../../dist/process-modules/modules/documentation/documentation-process-module.js';
import { DOCUMENTATION_KERNEL_HANDLER_IDS } from '../../dist/modules/documentation/domain/documentation-kernel-ports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWN_RESOURCE_KINDS = new Set([
  'skill', 'reviewer-skill', 'instruction', 'checklist', 'template',
  'mcp-call-template', 'error-hint',
]);

test('documentation manifest wraps the module definition verbatim', () => {
  assert.equal(documentationPackageManifest.definition, documentationProcessModule);
  assert.equal(
    documentationPackageManifest.manifestFormatVersion,
    '1',
  );
});

test('documentation resourceIndex entries are unique, known-kind, pending-digest and exist on disk', () => {
  const seen = new Set();
  assert.ok(documentationPackageManifest.resourceIndex.length > 0);
  for (const entry of documentationPackageManifest.resourceIndex) {
    assert.ok(!seen.has(entry.logicalId), `duplicate logicalId ${entry.logicalId}`);
    seen.add(entry.logicalId);
    assert.ok(KNOWN_RESOURCE_KINDS.has(entry.kind), `unknown kind ${entry.kind}`);
    assert.ok(!path.isAbsolute(entry.path), `absolute path ${entry.path}`);
    assert.ok(!entry.path.includes('..'), `traversal path ${entry.path}`);
    assert.equal(entry.digest, 'pending@wave-2');
    const absolute = path.join(REPO_ROOT, entry.path);
    assert.ok(existsSync(absolute), `missing resource ${entry.path}`);
  }
});

test('documentation handlerRefs cover every declared kernel handler', () => {
  const declared = new Set(
    documentationProcessModule.flow.nodes
      .filter(node => node.kind === 'kernel' && node.handler !== 'process-outcome-emitter')
      .map(node => node.handler),
  );
  const pinned = new Set(
    documentationPackageManifest.handlerRefs.map(ref => ref.logicalId),
  );
  assert.deepEqual(
    [...declared].sort(),
    [...pinned].sort(),
  );
  for (const ref of documentationPackageManifest.handlerRefs) {
    assert.ok(ref.digest.length >= 16 && ref.digest !== 'pending', `placeholder digest on ${ref.logicalId}`);
  }
  assert.ok(pinned.has(DOCUMENTATION_KERNEL_HANDLER_IDS.assemble));
  assert.ok(pinned.has(DOCUMENTATION_KERNEL_HANDLER_IDS.render));
  assert.ok(pinned.has(DOCUMENTATION_KERNEL_HANDLER_IDS.settle));
});

test('documentation contractRefs match the definition contracts', () => {
  assert.equal(
    documentationPackageManifest.inputContractRef.schemaId,
    documentationProcessModule.inputContract.id,
  );
  assert.equal(
    documentationPackageManifest.outputContractRef.schemaId,
    documentationProcessModule.outputContract.id,
  );
});

test('documentation manifest round-trips through JSON', () => {
  const serialized = JSON.parse(JSON.stringify(documentationPackageManifest));
  assert.equal(serialized.definition.identity.name, 'documentation-release');
  assert.equal(serialized.definition.identity.version, '1.0.0');
});
