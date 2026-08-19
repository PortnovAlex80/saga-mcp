import test from 'node:test';
import assert from 'node:assert/strict';

// SEAM-ARCHITECT Layer 2 (b) — the typed repair-issue a seam check emits.
// A seam repair issue is NOT a boolean failed: it names WHICH seam broke, the
// task that owns the seam, where the failure localized (files / command /
// substrate), and the evidence digest. It is content-addressed exactly like a
// factory-check-diagnostic so it can ride existing evidence_refs arrays.

const {
  encodeSeamRepairIssue,
  decodeSeamRepairIssue,
  SEAM_KINDS,
  SEAM_REPAIR_ISSUE_PREFIX,
} = await import(
  '../../dist/process-modules/domain/workplace/seam-repair-issue.js'
);

const issue = {
  seamKind: 'test-command',
  producingTaskRef: 'task:201',
  localization: {
    phase: 'profile-test',
    substrate: 'host',
    command: 'npm test',
    fileHints: ['src/broken.ts'],
  },
  evidence: {
    summary: 'command failed (npm test): 1 test failed in src/broken.ts',
    digestRef: 'local-readiness:abc',
  },
  subjectCandidateSetRef: 'candidate-set/test',
};

test('seam kinds are a closed typed set (no free strings)', () => {
  assert.deepEqual(SEAM_KINDS, [
    'readiness-profile-invalid',
    'install-command',
    'test-command',
    'serve-start',
    'serve-probe',
    'serve-shutdown',
    'compose-config',
    'compose-up',
    'compose-down',
    'substrate-unavailable',
  ]);
});

test('encode/decode roundtrip preserves every typed field', () => {
  const ref = encodeSeamRepairIssue(issue);
  assert.match(ref, new RegExp(`^${SEAM_REPAIR_ISSUE_PREFIX}/[a-f0-9]{64}/[A-Za-z0-9_-]+$`));
  const decoded = decodeSeamRepairIssue(ref);
  assert.deepEqual(decoded, issue);
});

test('decode rejects non-seam refs, tampered payloads, and invalid shapes', () => {
  assert.equal(decodeSeamRepairIssue('local-readiness:abc'), null);
  assert.equal(decodeSeamRepairIssue('factory-check-diagnostic/v1/x/y'), null);
  // Tampered body (hash no longer matches content).
  const ref = encodeSeamRepairIssue(issue);
  const parts = ref.split('/');
  const body = JSON.parse(Buffer.from(parts[3], 'base64url').toString('utf8'));
  body.seamKind = 'serve-probe';
  const tampered = `${parts[0]}/${parts[1]}/${parts[2]}/`
    + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  assert.equal(decodeSeamRepairIssue(tampered), null);
  // Unknown seam kind (forward-compat: an issuer from a newer version must not
  // be silently accepted by an older decoder).
  const future = encodeSeamRepairIssue({ ...issue, seamKind: 'quantum-seam' });
  assert.equal(decodeSeamRepairIssue(future), null);
});

test('identical issues encode identically (content-addressed determinism)', () => {
  assert.equal(encodeSeamRepairIssue(issue), encodeSeamRepairIssue({ ...issue }));
  assert.notEqual(
    encodeSeamRepairIssue(issue),
    encodeSeamRepairIssue({ ...issue, seamKind: 'install-command' }),
  );
});
