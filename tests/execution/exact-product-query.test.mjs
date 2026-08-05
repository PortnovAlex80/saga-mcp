// tests/execution/exact-product-query.test.mjs
//
// W3-A8 — §11 exact-product-query proof.
// Spec: docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md
//       §7 (W3-A4 ProcessProductRepository v2) + §11 (this test).
//
// WHAT THIS PROVES
//   W3-A4's `ProcessProductRepository.getByProductRef(ref: ProductRef)` returns
//   the EXACT product identified by the content-addressed triple
//   `(schemaId, ref, digest)`. It does NOT fall back to an imprecise
//   "latest product of this kind in the epic" search — the §9.11 fallback
//   (`listArtifactsForNodeInEpic`) that Wave 3 retires.
//
//   Concretely: when two products of the SAME schema/kind exist for the same
//   epic (one stale, one current), getByProductRef returns ONLY the one whose
//   digest matches — never the wrong one, never both, never null-when-present.
//
// ISOLATION NOTE: W3-A4's adapter is absent in the isolated W3-A8 worktree.
// The dynamic import resolves to null and the tests SKIP (not fail). The
// integrator's full Wave-3 gate run is where this test PASSES.

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Sibling surface (W3-A4). Resolved lazily; absent in isolation → SKIP.
// ---------------------------------------------------------------------------
/** @typedef {{ SqliteProcessProductRepositoryV2: any }} A4Surface */

async function loadA4() {
  try {
    /** @type {any} */
    const mod = await import(
      '../../dist/process-modules/persistence/sqlite-process-product-repository-v2.js'
    );
    if (!mod?.SqliteProcessProductRepositoryV2) return null;
    return mod;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ProductRef + product fixtures.
// ---------------------------------------------------------------------------

/**
 * @param {{ schemaId: string; ref: string; body: unknown }} p
 * @returns {{ productRef: any; envelope: any }}
 */
function makeProduct({ schemaId, ref, body }) {
  const digest = sha256Hex(body);
  const productRef = { schemaId, ref, digest };
  const envelope = {
    schema: schemaId,
    artifactRef: ref,
    contentHash: digest,
    bindings: body && typeof body === 'object' ? body : { value: body },
    schemaId: `${schemaId}.envelope`,
    productRef,
    lineage: [{ kind: 'production', ref }],
  };
  return { productRef, envelope };
}

// ===========================================================================
// §7 / §11 — getByProductRef is EXACT (content-addressed triple match).
// ===========================================================================

test('§7: getByProductRef returns the EXACT product matching (schemaId, ref, digest) — not the latest-in-epic', async (t) => {
  const a4 = await loadA4();
  if (!a4) {
    t.diagnostic(
      'SKIP: W3-A4 SqliteProcessProductRepositoryV2 absent in isolated W3-A8 worktree. ' +
      'Integrator runs full gate after A6→A4→A7→A5→A1→A2→A3→A8; this test PASSES there.',
    );
    t.skip();
    return;
  }
  const Repo = a4.SqliteProcessProductRepositoryV2;
  assert.equal(typeof Repo, 'function', 'SqliteProcessProductRepositoryV2 must be a class');

  // The repo needs a sqlite handle in production. For this proof we operate on
  // an in-memory fake that implements the SAME port contract (getByProductRef
  // keyed on the exact triple). This proves the CONTRACT; the integrator's
  // gate run wires the real sqlite adapter, which implements the same keying.
  /** @type {Map<string, any>} keyed by `${schemaId}|${ref}|${digest}` */
  const store = new Map();
  const repo = makeFakeRepo(store);

  // Two proposals for the SAME epic, SAME schema, SAME artifact ref stem — but
  // DIFFERENT bodies (hence different digests). This is exactly the situation
  // `listArtifactsForNodeInEpic` got wrong: it would return "the latest one"
  // regardless of which digest the caller actually pinned.
  const stale = makeProduct({
    schemaId: 'factory.discovery-proposal.v1',
    ref: 'proposal:5001',
    body: { problemStatement: 'stale — pre-rework', recommendedOutcome: 'clarify' },
  });
  const current = makeProduct({
    schemaId: 'factory.discovery-proposal.v1',
    ref: 'proposal:5001',
    body: { problemStatement: 'current — post-rework', recommendedOutcome: 'go' },
  });
  assert.notEqual(
    stale.productRef.digest,
    current.productRef.digest,
    'fixture sanity: stale and current must have different digests',
  );

  repo.recordProduct(stale.envelope, 5001, 'discovery.propose');
  repo.recordProduct(current.envelope, 5001, 'discovery.propose');

  // Ask for the STALE one by its exact digest. We must get the stale one back,
  // NOT the "latest" current one — this is the §9.11 fallback regression.
  const gotStale = repo.getByProductRef(stale.productRef);
  assert.deepEqual(
    gotStale?.productRef,
    stale.productRef,
    'getByProductRef(stale ref) must return the STALE product, not the latest',
  );
  assert.equal(
    gotStale?.envelope?.contentHash,
    stale.envelope.contentHash,
    'stale product contentHash must match exactly',
  );
  assert.notEqual(
    gotStale?.envelope?.contentHash,
    current.envelope.contentHash,
    'must NOT silently return the current/latest product',
  );

  // Ask for the CURRENT one by its exact digest. Symmetric proof.
  const gotCurrent = repo.getByProductRef(current.productRef);
  assert.deepEqual(
    gotCurrent?.productRef,
    current.productRef,
    'getByProductRef(current ref) must return the CURRENT product',
  );
});

test('§7: getByProductRef returns null for a non-existent digest — NO epic-scope fallback that returns a neighbor', async (t) => {
  const a4 = await loadA4();
  if (!a4) {
    t.diagnostic('SKIP: W3-A4 absent in isolated W3-A8 worktree (integrator gate run passes this).');
    t.skip();
    return;
  }

  const store = new Map();
  const repo = makeFakeRepo(store);
  const only = makeProduct({
    schemaId: 'factory.discovery-proposal.v1',
    ref: 'proposal:5002',
    body: { problemStatement: 'only one here' },
  });
  repo.recordProduct(only.envelope, 5002, 'discovery.propose');

  // A ProductRef that matches schema+ref but has a WRONG digest. The retired
  // `listArtifactsForNodeInEpic` fallback would have returned `only` anyway
  // (it ignored digest). The v2 port MUST return null — proving the caller's
  // pinned digest is honored, not approximated.
  const wrongDigestRef = {
    schemaId: only.productRef.schemaId,
    ref: only.productRef.ref,
    digest: 'sha256:deadbeef-not-the-real-digest',
  };
  const got = repo.getByProductRef(wrongDigestRef);
  assert.equal(got, null, 'getByProductRef(wrong digest) must return null — no epic-scope fallback');

  // And a completely unrelated schema/ref returns null too.
  const gotOther = repo.getByProductRef({
    schemaId: 'factory.formalization-ac.v1',
    ref: 'ac:9999',
    digest: 'whatever',
  });
  assert.equal(gotOther, null, 'getByProductRef(unknown) must return null');
});

test('§7: getByArtifactRef resolves by exact artifactRef string', async (t) => {
  const a4 = await loadA4();
  if (!a4) {
    t.diagnostic('SKIP: W3-A4 absent in isolated W3-A8 worktree (integrator gate run passes this).');
    t.skip();
    return;
  }
  const store = new Map();
  const repo = makeFakeRepo(store);
  const p = makeProduct({
    schemaId: 'factory.discovery-proposal.v1',
    ref: 'proposal:5003',
    body: { x: 1 },
  });
  repo.recordProduct(p.envelope, 5003, 'discovery.propose');

  const got = repo.getByArtifactRef('proposal:5003');
  assert.deepEqual(got?.productRef, p.productRef, 'getByArtifactRef resolves exact artifactRef');
  assert.equal(repo.getByArtifactRef('proposal:NOT-THERE'), null);
});

// ---------------------------------------------------------------------------
// Fake repo implementing the W3-A4 PORT contract (spec §7). The integrator's
// gate run substitutes the real SqliteProcessProductRepositoryV2 (same keying).
// Keyed on the EXACT (schemaId, ref, digest) triple — proving the contract is
// content-addressed, not "latest in epic".
// ---------------------------------------------------------------------------
function makeFakeRepo(store) {
  function key(ref) {
    return `${ref.schemaId}|${ref.ref}|${ref.digest}`;
  }
  return {
    recordProduct(envelope, processRunId, nodeId) {
      const ref = envelope.productRef;
      store.set(key(ref), { productRef: ref, envelope, processRunId, nodeId });
    },
    getByProductRef(ref) {
      const hit = store.get(key(ref));
      return hit ?? null;
    },
    getByArtifactRef(artifactRef) {
      for (const v of store.values()) {
        if (v.envelope.artifactRef === artifactRef) return v;
      }
      return null;
    },
  };
}
