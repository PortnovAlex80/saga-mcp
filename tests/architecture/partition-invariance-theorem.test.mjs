// tests/architecture/partition-invariance-theorem.test.mjs
//
// K10 commit 1 — the partition-invariance theorem, frozen at REVISION level
// (Saga Core Renewal Wave 3; the ADR-053 "Run 011 property" promoted to the
// program's material-ownership exit theorem).
//
// THEOREM (K10 §1): A(X+Y) and A(X)+B(Y) converge to the SAME MATERIAL
// REVISION — not merely the same semantic projection. For one Workplace,
// the revisionRef is content-addressed over material only:
//
//   revisionRef = sha256({ schema, workplaceRef, materialDigest, semanticDigest })
//   materialDigest — members' (memberKey, contentDigest) only
//   semanticDigest — members' (memberKey, contentDigest), validation/* excluded
//
// NO presenter, contributor execution, source adapter, parent-path, or
// ProductRef alias participates. Therefore every path that arrives at the
// same final member set — regardless of how work was partitioned across
// executions, who presented, how many seals happened on the way, or which
// immutable product ref aliased the content — must yield the IDENTICAL
// revisionRef (the row is one: the PK is content-addressed).
//
// The pre-existing adr-053-invariants suite proves semanticDigest equality
// across generated partitions; this theorem is strictly stronger and pins
// the full identity convergence plus the negative control (different
// content ⇒ different revision).
//
// Also pins the crash window named in the K10 test list: a crash between
// the revision seal and the CandidateSet seal cannot fork identity — the
// re-seal after recovery recomputes the same revisionRef (idempotent
// convergence), because the CandidateSet seal key derives from the
// revision ref (workplace + production revision + role), never from the
// sealing execution.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleRevision,
  buildContribution,
  revisionRef,
} from '../../dist/process-modules/domain/workplace/workplace-production-revision.js';
import {
  candidateSetDigestForRevision,
  computeCandidateSetRef,
} from '../../dist/process-modules/domain/workplace/candidate-set.js';

// A valid serialized WorkplaceRef (moduleRef must be name@version).
const WORKPLACE = 'workplace/1/m@1.0.0/cell-x/work-1';

/** Deterministic member factory: N material members with digests from a seed. */
function members(n, seed) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const c = String.fromCharCode(97 + ((seed + i) % 26));
    out.push({
      memberKey: `product/factory.thing.v1/${i}`,
      contentDigest: `${c}${String(seed + i).padStart(3, '0')}${'0'.repeat(60)}`,
    });
  }
  return out;
}

function contributionFor(executionRef, memberSubset, adapter = 'product-ref') {
  return buildContribution({
    workplaceRef: WORKPLACE,
    contributorExecutionRef: executionRef,
    sourceAdapter: adapter,
    operations: memberSubset.map(m => ({
      op: 'put',
      memberKey: m.memberKey,
      productRef: `product/ref/${m.memberKey}`,
      contentDigest: m.contentDigest,
      sourceAdapter: adapter,
    })),
    parentContributionRef: null,
  });
}

test('K10/theorem: A(X+Y) and A(X)+B(Y) converge to the SAME material revision', () => {
  const XY = members(6, 1);
  const X = XY.slice(0, 3);
  const Y = XY.slice(3);

  // Path 1 — one execution presents everything in one seal.
  const single = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', XY)],
    presenterRef: 'presenter-A',
  });

  // Path 2 — A produces X, B continues with Y; two seals chained.
  const first = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', X)],
    presenterRef: 'presenter-A',
  });
  const chained = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: first,
    contributions: [contributionFor('exec-B', Y, 'typed-submission')],
    presenterRef: 'presenter-B',
  });

  // Path 3 — one seal, TWO contributors (co-presented).
  const coPresented = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', X), contributionFor('exec-C', Y)],
    presenterRef: 'presenter-C',
  });

  assert.equal(chained.revisionRef, single.revisionRef,
    'chained A(X)→B(Y) converges to the single-seal revision');
  assert.equal(coPresented.revisionRef, single.revisionRef,
    'co-presented A(X)+C(Y) converges to the same revision');
  assert.equal(chained.materialDigest, single.materialDigest);
  assert.equal(chained.semanticDigest, single.semanticDigest);
  assert.notDeepEqual(chained.contributingExecutionRefs, single.contributingExecutionRefs,
    'the paths genuinely differ in provenance — identity ignores it');
  assert.notEqual(chained.presenterRef, single.presenterRef);
});

test('K10/theorem: ProductRef aliasing does not fork identity', () => {
  const XY = members(4, 7);
  // Same content under DIFFERENT immutable product refs (recovery
  // presentation): the digest excludes refs, so identity converges.
  const aliased = XY.map((m, i) => ({ ...m, productRef: `product/alias-${i}` }));
  const base = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', XY)],
    presenterRef: 'presenter-A',
  });
  const aliasRev = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [buildContribution({
      workplaceRef: WORKPLACE,
      contributorExecutionRef: 'exec-Z',
      sourceAdapter: 'product-ref',
      operations: aliased.map(m => ({
        op: 'put', memberKey: m.memberKey, productRef: m.productRef,
        contentDigest: m.contentDigest, sourceAdapter: 'product-ref',
      })),
      parentContributionRef: null,
    })],
    presenterRef: 'presenter-Z',
  });
  assert.equal(aliasRev.revisionRef, base.revisionRef,
    'same content through different immutable refs is ONE revision');
});

test('K10/theorem: different content never converges (negative control)', () => {
  const a = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', members(3, 1))],
    presenterRef: 'presenter-A',
  });
  const b = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', members(3, 2))],
    presenterRef: 'presenter-A',
  });
  assert.notEqual(a.revisionRef, b.revisionRef,
    'content-addressed identity separates different material');
  assert.notEqual(a.materialDigest, b.materialDigest);
});

test('K10/theorem: crash between revision seal and CandidateSet seal cannot fork identity', () => {
  // The revision is sealed (path 1 above); the process crashes BEFORE the
  // CandidateSet seal. Recovery re-derives everything: the revision
  // re-assembles to the same ref (idempotent), and the CandidateSet seal
  // key is computed from workplace + production revision + role — the
  // sealing EXECUTION appears only in the provenance receipt, so a re-seal
  // by a DIFFERENT execution after recovery produces the SAME seal key.
  const rev = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', members(3, 3))],
    presenterRef: 'presenter-A',
  });
  const recovered = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-RECOVERY', members(3, 3))],
    presenterRef: 'presenter-RECOVERY',
  });
  assert.equal(recovered.revisionRef, rev.revisionRef,
    'recovery re-seal recomputes the identical revision');

  const sealKeyOriginal = candidateSetDigestForRevision({
    workplaceRef: WORKPLACE,
    productionRevisionRef: rev.revisionRef,
    role: 'author',
  });
  const sealKeyRecovery = candidateSetDigestForRevision({
    workplaceRef: WORKPLACE,
    productionRevisionRef: recovered.revisionRef,
    role: 'author',
  });
  assert.equal(sealKeyRecovery, sealKeyOriginal,
    'the CandidateSet seal key is execution-independent');
  assert.equal(computeCandidateSetRef(sealKeyOriginal), sealKeyOriginal,
    'the ref IS the key — one row under the content-addressed identity');
});

test('K10/theorem: the revisionRef formula is exactly the material coordinates', () => {
  // Direct formula pin: the ref must be recomputable from workplace +
  // material digest + semantic digest ALONE (the audit's strongest form:
  // no other input can secretly participate).
  const rev = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contributionFor('exec-A', members(3, 5))],
    presenterRef: 'presenter-A',
  });
  assert.equal(
    rev.revisionRef,
    revisionRef({
      workplaceRef: WORKPLACE,
      materialDigestValue: rev.materialDigest,
      semanticDigestValue: rev.semanticDigest,
    }),
    'revisionRef = f(workplace, materialDigest, semanticDigest) — nothing else',
  );
});
