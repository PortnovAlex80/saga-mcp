// tests/factory-contract/reviewed-source-mismatch-attribution.test.mjs
//
// STAGE-18 R3 — the misattributed repair diagnosis that produced an
// UNRESOLVABLE loop in the stage-15 run (cell r33/task 22, verified from the
// run DB):
//
//   The worker stamped its COMMIT sha into snapshot.treeSha. The payload
//   accepted (treeSha was merely "a 40-hex string" — a commit sha is one).
//   The integration effect's three-predicate comparison failed on the TREE
//   arm — but the failure message printed the BRANCH arm:
//     "…REVIEWED_SOURCE_MISMATCH: task 22 submitted <sha> but branch is <sha>"
//   with BOTH shas equal (the branch was intact). The worker read "branch is
//   fine", re-submitted byte-identical work, and the loop could never close.
//
// The rule (stage-18 brief, R3):
//   A repair message must attribute the comparison that actually failed.
//   And the stamping defect must be caught at SUBMISSION (the payload
//   contract), not only at integration — a commit sha is never a tree sha.

import test from 'node:test';
import assert from 'node:assert/strict';

let effect = null;
let developmentImplementationPayloadContract = null;
try {
  effect = await import('../../dist/infrastructure/workplace/sqlite-production-cell-integration.js');
} catch { effect = null; }
try {
  ({ developmentImplementationPayloadContract } = await import(
    '../../dist/modules/development/application/development-check-providers.js'
  ));
} catch { developmentImplementationPayloadContract = null; }

const COMMIT = 'c'.repeat(40);
const TREE = '7'.repeat(40);

test('STAGE-18 R3 RED: the mismatch reason is attributed by a named export', () => {
  assert.ok(effect && typeof effect.reviewedSourceMismatchReason === 'function',
    'reviewedSourceMismatchReason must exist — a repair message must name the comparison that failed');
});

test('R3 live shape (branch intact, treeSha = commitSha): the reason attributes the TREE comparison, never the branch', () => {
  if (typeof effect?.reviewedSourceMismatchReason !== 'function') return;
  const reason = effect.reviewedSourceMismatchReason(22, {
    sourceCommit: COMMIT,
    resolvedCommit: COMMIT,        // the commit object exists
    branchHead: COMMIT,            // the branch is intact — EQUAL shas
    sourceTree: TREE,              // the commit's real tree
    claimedTreeSha: COMMIT,        // the stamping defect: commit sha as tree sha
  });
  // The attribution: the TREE comparison failed — both values named.
  assert.match(reason, /tree/i, 'the word tree must appear — the failed arm is the tree comparison');
  assert.ok(reason.includes(TREE) && reason.includes(COMMIT),
    'both the real tree and the claimed (commit-stamped) value must be named');
  // The misattribution that produced the loop: "submitted X but branch is X".
  assert.ok(!/but branch is/i.test(reason),
    'the reason must not present the branch comparison as the failure when the branch is intact');
  assert.ok(/commit sha stamped as a tree sha|stamped/i.test(reason),
    'the likely cause is named — the worker can act on it');
});

test('R3 honest branch case (branch moved): the reason attributes the branch', () => {
  if (typeof effect?.reviewedSourceMismatchReason !== 'function') return;
  const other = 'd'.repeat(40);
  const reason = effect.reviewedSourceMismatchReason(7, {
    sourceCommit: COMMIT,
    resolvedCommit: COMMIT,
    branchHead: other,
    sourceTree: TREE,
    claimedTreeSha: TREE,
  });
  assert.match(reason, /but branch is/i, 'when the branch arm actually failed, the branch comparison is the attribution');
  assert.ok(reason.includes(other));
  assert.ok(!/tree/i.test(reason.replace(/sourceTree|treeSha/g, '')) || /branch/i.test(reason));
});

test('R3 vanished commit case: the reason attributes the missing commit object', () => {
  if (typeof effect?.reviewedSourceMismatchReason !== 'function') return;
  const reason = effect.reviewedSourceMismatchReason(7, {
    sourceCommit: COMMIT,
    resolvedCommit: null,          // rev-parse could not resolve the commit
    branchHead: null,
    sourceTree: null,
    claimedTreeSha: TREE,
  });
  assert.match(reason, /missing|unresolvable|not resolve/i,
    'a vanished commit is attributed as a missing commit, not as a branch or tree mismatch');
});

// ── the submission-boundary arm: the stamping defect fails the contract ────

test('R3 payload contract: a commit sha stamped into snapshot.treeSha is rejected at submission', () => {
  if (!developmentImplementationPayloadContract) return;
  const vc = developmentImplementationPayloadContract;
  const base = {
    workItemKey: 'imp-1',
    repository: { baseCommit: 'a'.repeat(40) },
    snapshot: {
      commitSha: COMMIT,
      changedFiles: ['aaa/thing'],
      treeSha: COMMIT,            // the stamping defect
    },
  };
  const errors = vc.validate(base);
  assert.ok(errors.some(e => /treeSha/i.test(e)),
    `the contract must reject a treeSha equal to commitSha (got: ${JSON.stringify(errors)})`);

  const healed = { ...base, snapshot: { ...base.snapshot, treeSha: TREE } };
  const healedErrors = vc.validate(healed);
  assert.ok(!healedErrors.some(e => /treeSha/i.test(e)),
    `a distinct 40-hex treeSha passes the tree rule (got: ${JSON.stringify(healedErrors)})`);

  const malformed = { ...base, snapshot: { ...base.snapshot, treeSha: 'not-hex' } };
  assert.ok(vc.validate(malformed).some(e => /treeSha/i.test(e)),
    'a non-40-hex treeSha is rejected');
});
