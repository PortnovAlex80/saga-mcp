// P2 tests: ProcessModuleRunResult contract enforcement.
//
// Covers:
//   - declared outcome required (reject unknown codes)
//   - only terminal outcomes accepted
//   - output shape: { schema, artifactRef, contentHash } enforced
//   - certificate shape: { schema, certificateRef, certificateHash } enforced
//   - certificate without authority → error
//   - both null → warning (not error)
//   - output.schema vs module.outputContract mismatch → warning
//   - valid results pass

import assert from 'node:assert/strict';
import test from 'node:test';

const { validateProcessModuleRunResult } = await import(
  '../../dist/process-modules/application/validate-process-module-run-result.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);

const M = discoveryProcessModule;

test('valid certificate result passes', () => {
  const r = validateProcessModuleRunResult(M, {
    outcome: 'go',
    output: null,
    certificate: {
      schema: 'saga3.discovery-outcome-certificate.v1',
      certificateRef: 'certificate:1',
      certificateHash: 'a'.repeat(64),
    },
    authority: 'discovery_settlement_policy',
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('unknown outcome code is rejected', () => {
  const r = validateProcessModuleRunResult(M, {
    outcome: 'absolutely-unheard-of',
    output: null, certificate: null, authority: null,
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /not declared/.test(e)));
});

test('empty outcome string is rejected', () => {
  const r = validateProcessModuleRunResult(M, {
    outcome: '',
    output: null, certificate: null, authority: null,
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /outcome must be a non-empty string/.test(e)));
});

test('malformed output (missing contentHash) is rejected', () => {
  const r = validateProcessModuleRunResult(M, {
    outcome: 'go',
    output: { schema: 's', artifactRef: 'a:1' }, // missing contentHash
    certificate: null, authority: null,
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /output must be/.test(e)));
});

test('malformed certificate (missing certificateRef) is rejected', () => {
  const r = validateProcessModuleRunResult(M, {
    outcome: 'go',
    output: null,
    certificate: { schema: 's', certificateHash: 'h' }, // missing certificateRef
    authority: 'issuer',
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /certificate must be/.test(e)));
});

test('certificate present but authority missing → error', () => {
  const r = validateProcessModuleRunResult(M, {
    outcome: 'go',
    output: null,
    certificate: {
      schema: 'saga3.discovery-outcome-certificate.v1',
      certificateRef: 'certificate:1',
      certificateHash: 'a'.repeat(64),
    },
    authority: null,
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /certificate is present but authority is missing/.test(e)));
});

test('both output and certificate null → warning, not error', () => {
  // A 'failed' outcome legitimately emits neither — this is allowed.
  const r = validateProcessModuleRunResult(M, {
    outcome: 'failed',
    output: null, certificate: null, authority: null,
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => /neither output nor certificate/.test(w)));
});

test('output.schema mismatch with module.outputContract → warning', () => {
  const r = validateProcessModuleRunResult(M, {
    outcome: 'go',
    output: { schema: 'different-schema', artifactRef: 'a:1', contentHash: 'h' },
    certificate: null, authority: 'external',
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => /output.schema .* differs/.test(w)));
});
