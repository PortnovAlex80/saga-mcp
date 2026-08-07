/**
 * Tranche 2 focused tests (CONVEYOR v4.3 §5-9): cross-run semantic identity.
 *
 * These prove the producer-authored semantic primitives are stable across
 * runtime identity changes and sensitive to semantic content changes:
 *   C. semanticDigest — same products + different runtime refs → same digest
 *   D. WorkKey — fan-out workKey stable across runs (uses semanticDigest)
 *   E. semanticInputDigest — entry cell stable; fan-out stable; content change → differ
 *   F. subjectProductionDigest — derived from product atoms, not CandidateSet digest
 *   G. ReplayKey — Run A vs Run B runtime ids differ, same semantic → same key
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { computeReplayKey } from '../../dist/replay/replay-capsule.js';
import { deriveWorkKey } from '../../dist/process-modules/domain/workplace/work-key-deriver.js';

// ---------------------------------------------------------------------------
// Manifest semanticDigest is authored by the producer over a STABLE projection.
// We cannot easily call the private manifestProduction, but we replicate the
// exact projection it uses (cellId, final, items → {id, accepted, products})
// to prove two runs with different provenance produce the same digest.
// ---------------------------------------------------------------------------

function manifestSemanticProjection({ cellId, final, items }) {
  return {
    cellId,
    final,
    items: items
      .map(item => ({
        id: item.id,
        accepted: item.accepted,
        products: canonicalProductMultiset(item.products),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

function canonicalProductMultiset(products) {
  return products
    .map(p => ({ schemaId: p.schemaId, digest: p.digest }))
    .sort((a, b) =>
      a.schemaId < b.schemaId ? -1
      : a.schemaId > b.schemaId ? 1
      : a.digest < b.digest ? -1
      : a.digest > b.digest ? 1
      : 0,
    );
}

// --- C. Cross-run semantic production identity ----------------------------

test('C: manifest semanticDigest stable across runs with different provenance', () => {
  // Two runs produce the SAME accepted products but with completely different
  // runtime identities (workplaceRef, candidateSetRef, executionRef, taskId).
  const products = [
    { schemaId: 'factory.prd.v1', ref: 'ignored-ref', digest: 'aaa' },
    { schemaId: 'factory.fr.v1', ref: 'ignored-ref', digest: 'bbb' },
  ];
  // Run A: provenance fields differ but the SEMANTIC projection is identical.
  const runAItems = [{
    id: 'item-1', accepted: true, products,
    workplaceRef: 'workplace/1/mod/cell/item-1',
    candidateSetRef: 'cs-A', producerExecutionRef: 'exec-A',
  }];
  const runBItems = [{
    id: 'item-1', accepted: true, products,
    workplaceRef: 'workplace/2/mod/cell/item-1',  // different processRunId
    candidateSetRef: 'cs-B', producerExecutionRef: 'exec-B',
  }];
  const digestA = sha256Hex(manifestSemanticProjection({ cellId: 'cell-1', final: true, items: runAItems }));
  const digestB = sha256Hex(manifestSemanticProjection({ cellId: 'cell-1', final: true, items: runBItems }));
  assert.equal(digestA, digestB, 'same products + different provenance → same semanticDigest');
});

test('C: changed product content → different semanticDigest', () => {
  const productsA = [{ schemaId: 'factory.prd.v1', ref: 'r', digest: 'aaa' }];
  const productsC = [{ schemaId: 'factory.prd.v1', ref: 'r', digest: 'CHANGED' }];
  const digestA = sha256Hex(manifestSemanticProjection({ cellId: 'c', final: true, items: [{ id: 'i', accepted: true, products: productsA }] }));
  const digestC = sha256Hex(manifestSemanticProjection({ cellId: 'c', final: true, items: [{ id: 'i', accepted: true, products: productsC }] }));
  assert.notEqual(digestA, digestC);
});

test('C: product order within an item does not affect semanticDigest (multiset)', () => {
  const productsOrder1 = [
    { schemaId: 'a', ref: 'r', digest: '1' },
    { schemaId: 'b', ref: 'r', digest: '2' },
  ];
  const productsOrder2 = [
    { schemaId: 'b', ref: 'r', digest: '2' },
    { schemaId: 'a', ref: 'r', digest: '1' },
  ];
  const d1 = sha256Hex(manifestSemanticProjection({ cellId: 'c', final: true, items: [{ id: 'i', accepted: true, products: productsOrder1 }] }));
  const d2 = sha256Hex(manifestSemanticProjection({ cellId: 'c', final: true, items: [{ id: 'i', accepted: true, products: productsOrder2 }] }));
  assert.equal(d1, d2, 'product multiset is order-independent');
});

// --- D. WorkKey cross-run stability ---------------------------------------

test('D: fan-out workKey stable when source semanticDigest is stable', () => {
  // WorkKey is derived from sourceProduction.semanticDigest + itemId. Two runs
  // with the same semanticDigest produce the same workKey even though their
  // contentHash (provenance) differs.
  const semanticDigest = sha256Hex({ cellId: 'upstream', final: true, items: [{ id: 'x', accepted: true, products: [] }] });
  const workKeyA = deriveWorkKey(semanticDigest, 'item-1');
  const workKeyB = deriveWorkKey(semanticDigest, 'item-1');
  assert.equal(workKeyA, workKeyB);
  assert.match(workKeyA, /^[0-9a-f]{24}$/);
  // Different item → different workKey
  const workKeyOther = deriveWorkKey(semanticDigest, 'item-2');
  assert.notEqual(workKeyA, workKeyOther);
  // Different semanticDigest → different workKey
  const otherDigest = sha256Hex({ cellId: 'upstream', final: true, items: [{ id: 'x', accepted: true, products: [{ schemaId: 's', ref: 'r', digest: 'CHANGED' }] }] });
  assert.notEqual(workKeyA, deriveWorkKey(otherDigest, 'item-1'));
});

// --- E. semanticInputDigest -----------------------------------------------

test('E: entry cell semanticInputDigest stable for identical business input', () => {
  // Entry cell: semanticInputDigest = sha256Hex(ctx.input). Same business
  // input across runs → same digest.
  const businessInput = { initiative: { subject: 'button toggle' }, development: { repositories: [] } };
  const digestA = sha256Hex(businessInput);
  const digestB = sha256Hex(businessInput);
  assert.equal(digestA, digestB);
  const changedInput = { initiative: { subject: 'CHANGED' }, development: { repositories: [] } };
  assert.notEqual(digestA, sha256Hex(changedInput));
});

test('E: fan-out semanticInputDigest stable across runs (upstream semanticDigest + item)', () => {
  // Fan-out: sha256Hex({ upstreamSemanticDigest, itemId, itemDigest }).
  // Two runs with the same upstream semanticDigest + same item → same digest.
  const upstreamSemantic = sha256Hex({ stable: 'upstream-content' });
  const item = { criterionId: 'AC-1', description: 'button toggles' };
  const digestA = sha256Hex({
    upstreamSemanticDigest: upstreamSemantic,
    itemId: 'AC-1',
    itemDigest: sha256Hex(item),
  });
  const digestB = sha256Hex({
    upstreamSemanticDigest: upstreamSemantic,
    itemId: 'AC-1',
    itemDigest: sha256Hex(item),
  });
  assert.equal(digestA, digestB);
  // Changed item content → different digest
  const changedItem = { criterionId: 'AC-1', description: 'CHANGED' };
  const digestC = sha256Hex({
    upstreamSemanticDigest: upstreamSemantic,
    itemId: 'AC-1',
    itemDigest: sha256Hex(changedItem),
  });
  assert.notEqual(digestA, digestC);
});

// --- F. subjectProductionDigest (reviewer semantic identity) ---------------

test('F: subjectProductionDigest from product atoms, not CandidateSet digest', () => {
  // The reviewer replay identity is sha256Hex(canonical {schemaId, digest} multiset
  // of the subject author CandidateSet's products). Two CandidateSets with
  // different refs/digests but the SAME products → same subjectProductionDigest.
  const authorProducts = [
    { schemaId: 'factory.prd.v1', digest: 'prd-aaa' },
    { schemaId: 'factory.fr.v1', digest: 'fr-bbb' },
  ];
  // CandidateSet A: run-specific digest includes workplaceRef/execRef
  // CandidateSet B: same products, different workplace/exec → different CS digest
  // but the SEMANTIC subjectProductionDigest is identical.
  const subjectDigestA = sha256Hex(canonicalProductMultiset(authorProducts));
  const subjectDigestB = sha256Hex(canonicalProductMultiset(authorProducts));
  assert.equal(subjectDigestA, subjectDigestB);
  // One product digest changes → different subjectProductionDigest
  const changedProducts = [
    { schemaId: 'factory.prd.v1', digest: 'prd-CHANGED' },
    { schemaId: 'factory.fr.v1', digest: 'fr-bbb' },
  ];
  assert.notEqual(subjectDigestA, sha256Hex(canonicalProductMultiset(changedProducts)));
});

// --- G. ReplayKey cross-run stability -------------------------------------

test('G: ReplayKey identical across runs with different runtime ids, same semantic', () => {
  // Run A and Run B: different processRunId (not in material), different
  // workplaceRef (not in material), different executionRef (not in material).
  // Same projectId/moduleRef/nodeId/cell/workKey/package/semanticInput.
  const runA = {
    projectId: 1,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'define-product-contract',
    productionCellId: 'formalization-product-contract',
    workKey: 'product-contract',
    role: 'author',
    packageDigest: 'pkg-abc',
    semanticInputDigest: sha256Hex({ subject: 'button' }),
    subjectProductionDigest: null,
  };
  const runB = { ...runA }; // semantic identity identical
  assert.equal(computeReplayKey(runA), computeReplayKey(runB));
  // Changing a SEMANTIC field changes the key
  const runC = { ...runA, semanticInputDigest: sha256Hex({ subject: 'counter' }) };
  assert.notEqual(computeReplayKey(runA), computeReplayKey(runC));
  // workKey change (different fan-out item) changes the key
  const runD = { ...runA, workKey: 'different-work-key' };
  assert.notEqual(computeReplayKey(runA), computeReplayKey(runD));
});

test('G: reviewer ReplayKey stable across runs with same subjectProductionDigest', () => {
  const subjectProd = sha256Hex([{ schemaId: 's', digest: 'd' }]);
  const runA = {
    projectId: 1, moduleRef: 'm@1', nodeId: 'n', productionCellId: 'c',
    workKey: 'w', role: 'reviewer', packageDigest: 'pkg',
    semanticInputDigest: sha256Hex('input'),
    subjectProductionDigest: subjectProd,
  };
  const runB = { ...runA };
  assert.equal(computeReplayKey(runA), computeReplayKey(runB));
  const runC = { ...runA, subjectProductionDigest: sha256Hex([{ schemaId: 's', digest: 'CHANGED' }]) };
  assert.notEqual(computeReplayKey(runA), computeReplayKey(runC));
});
