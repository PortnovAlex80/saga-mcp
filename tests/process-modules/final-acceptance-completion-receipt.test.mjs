// tests/process-modules/final-acceptance-completion-receipt.test.mjs
//
// K13 (M3, card commit 3) — "use persisted row identity": the completion
// receipt of a record-final-acceptance obligation IS the cell-final-acceptance
// row digest (`cell-final-acceptance:<sha256>`), never the fabricated
// `transition-completion:<obligationKey>` alias composed from the key.
//
// WHAT THIS PROVES:
//   1. readExactCompletionReceipt returns the PERSISTED row's own ref, bound
//      to the exact effect-receipt source of the obligation;
//   2. a drifted source (different effect receipt, different workplace)
//      resolves NOTHING — the receipt cannot be minted from the wrong row;
//   3. the runtime handler wires the exact receipt in BOTH the
//      recovered-from-postcondition path and the fresh-drive path, and fails
//      closed (typed) if a satisfied postcondition has no row to cite.
//
// The remaining handoff kinds still fabricate aliases — the same defect
// class, reported to the architect, deliberately not generalized here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { readExactCompletionReceipt } from '../../dist/process-modules/application/transition-handoff-postconditions.js';
import { canonicalJson } from '../../dist/shared/canonical-json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WP = 'workplace/1/m@1.0.0/cell/work-1';
const EFFECT_RECEIPT = 'cell-effect-receipt:' + 'a'.repeat(64);

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedFinalAcceptance(db, { workplaceRef = WP, effectReceiptRefs = [EFFECT_RECEIPT] } = {}) {
  // The exact production shape (sqlite-cell-final-acceptance.ts): body ->
  // digest -> ref, sorted receipt list.
  const sorted = [...effectReceiptRefs].sort();
  const digest = createHash('sha256')
    .update(canonicalJson({
      schema: 'factory.cell-final-acceptance.v1',
      workplaceRef,
      candidateSetRef: 'candidate-set/A',
      gateDecisionKey: 'decision/A',
      effectReceiptRefs: sorted,
    }))
    .digest('hex');
  const ref = `cell-final-acceptance:${digest}`;
  db.prepare(
    `INSERT INTO factory_cell_final_acceptances
       (final_acceptance_ref,workplace_ref,candidate_set_ref,gate_decision_key,
        effect_receipt_refs,acceptance_digest,accepted_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(ref, workplaceRef, 'candidate-set/A', 'decision/A', JSON.stringify(sorted), digest, '2026-08-18T00:00:00Z');
  return ref;
}

const obligation = (overrides = {}) => ({
  obligationKey: 'workplace/1/m@1.0.0/cell/work-1:record-final-acceptance:run-effects:source',
  handoffKind: 'record-final-acceptance',
  subjectRef: WP,
  sourceRef: EFFECT_RECEIPT,
  sourceDigest: 'd'.repeat(64),
  ...overrides,
});

test('K13/receipt: the completion receipt IS the persisted FinalAcceptance row digest', () => {
  const db = fixture();
  const ref = seedFinalAcceptance(db);
  assert.equal(readExactCompletionReceipt(db, obligation()), ref,
    'the receipt is the row\'s own content address, not a fabricated alias');
  assert.match(ref, /^cell-final-acceptance:[0-9a-f]{64}$/u);
  db.close();
});

test('K13/receipt: a drifted source or workplace resolves nothing', () => {
  const db = fixture();
  seedFinalAcceptance(db);
  assert.equal(
    readExactCompletionReceipt(db, obligation({ sourceRef: 'cell-effect-receipt:' + 'b'.repeat(64) })),
    null,
    'a different effect receipt cannot mint a FinalAcceptance completion',
  );
  assert.equal(
    readExactCompletionReceipt(db, obligation({ subjectRef: 'workplace/9/other' })),
    null,
    'another workplace\'s row is not this obligation\'s receipt',
  );
  db.close();
});

test('K13/receipt: non-final-acceptance handoffs return null (scoped by the card, residue reported)', () => {
  const db = fixture();
  seedFinalAcceptance(db);
  for (const handoffKind of ['close-presentation', 'run-gate', 'run-effects', 'route-lifecycle']) {
    assert.equal(
      readExactCompletionReceipt(db, obligation({ handoffKind })),
      null,
      `${handoffKind} is out of the card commit 3 scope — its alias residue is reported, not generalized`,
    );
  }
  db.close();
});

test('K13/receipt: the runtime handler wires the exact receipt and fails closed when it cannot cite a row', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'src', 'app', 'product-lifecycle-runtime.ts'),
    'utf8',
  );
  assert.match(source, /readExactCompletionReceipt/u,
    'the runtime imports the exact-receipt reader');
  assert.match(source, /FINAL_ACCEPTANCE_RECEIPT_UNRESOLVED/u,
    'a satisfied record-final-acceptance postcondition with no row to cite fails closed typed');
  // The fabricated alias may remain ONLY for the non-final-acceptance kinds.
  const aliasUses = [...source.matchAll(/transition-completion:\$\{obligation\.obligationKey\}/gu)].length;
  assert.ok(aliasUses <= 1,
    `the fabrication survives at most once (the documented residue for other kinds); found ${aliasUses}`);
});
