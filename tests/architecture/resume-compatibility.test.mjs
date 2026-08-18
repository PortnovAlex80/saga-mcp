// CONVEYOR Wave 8 — ResumeCompatibilityPolicy tests + mandatory scenario 8.
//
// Spec: docs/architecture/CONVEYOR-MENTAL-MODEL.md Wave 8 (lines ~840-853) +
//   mandatory scenario 8: "Package digest drift does not block a compatible
//   resume."
//
// The policy (src/process-modules/installation/domain/resume-compatibility-
// policy.ts) replaces raw digest equality with an explicit classification:
//   - unchanged     (same digest)
//   - compatible    (digest changed, contract stable → resume)
//   - incompatible  (contract changed → pause without mutating work)
//
// These tests prove all three branches + scenario 8 end-to-end.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyResumeCompatibility,
  extractContractSurface,
  diffContractSurface,
} from '../../dist/process-modules/installation/domain/resume-compatibility-policy.js';

// Minimal manifest factory for tests. Only the fields the policy reads matter.
function makeManifest(overrides = {}) {
  return {
    manifestFormatVersion: '1.0.0',
    definition: {
      identity: {
        name: overrides.name ?? 'solution-development',
        version: overrides.version ?? '1.0.0',
        displayName: 'Development',
        description: 'test',
      },
    },
    handlerRefs: overrides.handlerRefs ?? [
      { logicalId: 'dev-kernel-1' },
      { logicalId: 'dev-kernel-2' },
    ],
    inputContractRef: {
      schemaId: overrides.inputSchemaId ?? 'factory.development-case.v1',
      version: '1.0.0',
      digest: 'd'.repeat(64),
    },
    outputContractRef: {
      schemaId: overrides.outputSchemaId ?? 'factory.verified-integration-bundle.v1',
      version: '1.0.0',
      digest: 'e'.repeat(64),
    },
    resourceIndex: [],
    nodeProtocols: [],
  };
}

// Minimal installation record factory (mirrors ModuleInstallationRecord shape).
function makeRecord(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? 'solution-development',
    version: overrides.version ?? '1.0.0',
    packageDigest: overrides.packageDigest ?? 'aaa111',
    manifestSnapshot: makeManifest({
      name: overrides.name,
      version: overrides.version,
      inputSchemaId: overrides.inputSchemaId,
      outputSchemaId: overrides.outputSchemaId,
      handlerRefs: overrides.handlerRefs,
    }),
    status: 'active',
    installedAt: '2026-08-01T00:00:00Z',
    storeLocation: '/tmp/pkg',
    resourceIndex: [],
    handlerRefs: overrides.handlerRefs ?? [
      { logicalId: 'dev-kernel-1' },
      { logicalId: 'dev-kernel-2' },
    ],
    dependencyLock: { entries: [], lockDigest: 'lock' },
  };
}

test('scenario 8: identical digest → unchanged (resume trivially)', () => {
  const existing = makeRecord({ packageDigest: 'same123' });
  const verdict = classifyResumeCompatibility(existing, 'same123', makeManifest());
  assert.equal(verdict.outcome, 'unchanged');
  assert.equal(verdict.installationId, 1);
  assert.equal(verdict.packageDigest, 'same123');
});

test('scenario 8: digest changed BUT contract stable → compatible (resume proceeds)', () => {
  // The toolset bytes changed (e.g. a skill wording tweak) but the module
  // identity, input/output schemas, and handler surface are identical.
  const existing = makeRecord({ packageDigest: 'old-bytes-hash' });
  // Same manifest → same contract surface, different attempted digest.
  const newManifest = makeManifest();
  const verdict = classifyResumeCompatibility(existing, 'new-bytes-hash', newManifest);

  assert.equal(verdict.outcome, 'compatible');
  assert.equal(verdict.oldPackageDigest, 'old-bytes-hash');
  assert.equal(verdict.newPackageDigest, 'new-bytes-hash');
  assert.equal(verdict.oldInstallationId, 1);
  // The KEY assertion for scenario 8: drift does NOT block resume.
  assert.ok(verdict.reason.includes('resume continues'), `reason should mention resume: ${verdict.reason}`);
});

test('Wave 8: module version bumped → incompatible (pause without mutating work)', () => {
  const existing = makeRecord({ version: '1.0.0', packageDigest: 'old' });
  const newManifest = makeManifest({ version: '1.1.0' }); // version changed
  const verdict = classifyResumeCompatibility(existing, 'new', newManifest);

  assert.equal(verdict.outcome, 'incompatible');
  assert.equal(verdict.oldPackageDigest, 'old');
  assert.equal(verdict.newPackageDigest, 'new');
  assert.ok(verdict.changedFields.length > 0, 'must list changed fields');
  assert.ok(verdict.changedFields.some((f) => f.includes('moduleVersion')));
  assert.ok(verdict.reason.includes('pause'), 'must say pause');
});

test('Wave 8: input schema changed → incompatible', () => {
  const existing = makeRecord({ inputSchemaId: 'factory.development-case.v1', packageDigest: 'old' });
  const newManifest = makeManifest({ inputSchemaId: 'factory.development-case.v2' });
  const verdict = classifyResumeCompatibility(existing, 'new', newManifest);

  assert.equal(verdict.outcome, 'incompatible');
  assert.ok(verdict.changedFields.some((f) => f.includes('inputContractSchemaId')));
});

test('Wave 8: handler surface changed (handler removed) → incompatible', () => {
  const existing = makeRecord({
    handlerRefs: [{ logicalId: 'a' }, { logicalId: 'b' }],
    packageDigest: 'old',
  });
  const newManifest = makeManifest({
    handlerRefs: [{ logicalId: 'a' }], // 'b' removed
  });
  const verdict = classifyResumeCompatibility(existing, 'new', newManifest);

  assert.equal(verdict.outcome, 'incompatible');
  assert.ok(verdict.changedFields.some((f) => f.includes('handlerLogicalIds')));
});

test('extractContractSurface is pure and stable (same manifest → same surface)', () => {
  const m = makeManifest();
  const s1 = extractContractSurface(m);
  const s2 = extractContractSurface(m);
  assert.deepEqual(s1, s2);
});

test('diffContractSurface: identical surfaces → empty diff (compatible)', () => {
  const s = extractContractSurface(makeManifest());
  assert.equal(diffContractSurface(s, s).length, 0);
});

// ---------------------------------------------------------------------------
// K5 (Saga Core Renewal) — the missing high-risk negative theorem.
//
// The 2026-08-16 audit: "Resume compatibility uses handler logical IDs
// without implementation digests. A rewritten handler can be silently
// treated as compatible." K3 made handler digests real; this theorem pins
// the resume side: same logical ID + CHANGED implementation digest must
// never classify as 'compatible' (a resumed workplace would execute
// REWRITTEN code under the same pin).
// ---------------------------------------------------------------------------

test('K5 theorem: same logical ID with CHANGED implementation digest is NOT compatible', () => {
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const stable = 'c'.repeat(64);
  const existing = makeRecord({
    packageDigest: 'old-pkg',
    handlerRefs: [
      { logicalId: 'dev-kernel-1', version: '1.0.0', digest: digestA },
      { logicalId: 'dev-kernel-2', version: '1.0.0', digest: stable },
    ],
  });
  const attempted = makeManifest({
    handlerRefs: [
      { logicalId: 'dev-kernel-1', version: '1.0.0', digest: digestB }, // REWRITTEN implementation
      { logicalId: 'dev-kernel-2', version: '1.0.0', digest: stable },
    ],
  });
  const verdict = classifyResumeCompatibility(existing, 'new-pkg', attempted);
  assert.notEqual(
    verdict.outcome,
    'compatible',
    `a rewritten handler implementation must never be silently compatible (got: ${verdict.outcome})`,
  );
});

test('K5 control: resource-only drift with IDENTICAL handler digests stays compatible', () => {
  const stable = 'c'.repeat(64);
  const existing = makeRecord({
    packageDigest: 'old-pkg',
    handlerRefs: [
      { logicalId: 'dev-kernel-1', version: '1.0.0', digest: stable },
      { logicalId: 'dev-kernel-2', version: '1.0.0', digest: stable },
    ],
  });
  const attempted = makeManifest({
    handlerRefs: [
      { logicalId: 'dev-kernel-1', version: '1.0.0', digest: stable },
      { logicalId: 'dev-kernel-2', version: '1.0.0', digest: stable },
    ],
  });
  const verdict = classifyResumeCompatibility(existing, 'new-pkg', attempted);
  assert.equal(verdict.outcome, 'compatible');
});
