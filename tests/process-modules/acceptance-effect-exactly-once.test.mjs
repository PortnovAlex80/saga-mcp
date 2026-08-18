// tests/process-modules/acceptance-effect-exactly-once.test.mjs
//
// K13 (M3, card commit 5) — re-certify the ADR-074 repair feedback:
// NO DUPLICATE PROVIDER CALL after an exact durable repair receipt, and a
// repair receipt for a STALE acceptance never satisfies a newer one.
//
// The mechanism under test is the reconciler pre-check: before any handler
// re-drive, readTransitionHandoffPostcondition must see the durable repair
// receipt (repair issue + the repair's resulting workplace revision) as a
// TERMINAL run-effects postcondition — "external post-acceptance effects
// must never be repeated merely to obtain an obligation receipt"
// (product-lifecycle-runtime). If the postcondition is satisfied, the
// handler returns without re-running the episode, so the provider is never
// invoked again. The receipt-side ordering (readEffectReceipt BEFORE
// postAcceptanceEffects.run) is pinned separately by the authority-closure
// suite; the external-effect ledger's claim/observe fencing is exercised
// end-to-end by the crash test in tests/factory-contract/.
//
// STALENESS: the postcondition binds the EXACT gate decision key AND digest
// — a repair receipt issued for an older acceptance cannot settle the
// obligation of a newer one (the "effect repair and later candidate
// staleness" card scenario).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { readTransitionHandoffPostcondition } from '../../dist/process-modules/application/transition-handoff-postconditions.js';

const WP = 'workplace/1/m@1.0.0/cell/work-1';
const HEX = 'a'.repeat(64);
const E64 = 'e'.repeat(64);
const X64 = 'x'.repeat(64);
const I64 = 'i'.repeat(64);
const D64 = 'd'.repeat(64);
const P64 = 'p'.repeat(64);

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES (?,7,'m@1.0.0','cell','work-1','in_progress','effect_pending','author',5)`,
  ).run(WP);
  return db;
}

function seedRepairIssue(db, {
  effectRepairRef = 'cell-effect-repair:' + HEX,
  gateDecisionKey = 'decision:A',
  gateDecisionDigest = D64,
  expected = 5,
} = {}) {
  db.prepare(
    `INSERT INTO factory_cell_effect_repair_issues
       (effect_repair_ref,workplace_ref,effect_id,effect_version,effect_digest,
        candidate_set_ref,production_revision_ref,gate_decision_key,
        gate_decision_digest,acceptance_digest,expected_workplace_revision,
        resulting_workplace_revision,issue_snapshot,issue_digest,receipt_digest)
     VALUES (?,?, 'git-integration','1.0.0',?,
        'candidate-set/A','revision/A',?,?,
        ?,?,?, '{}',?, ?)`,
  ).run(effectRepairRef, WP, E64, gateDecisionKey, gateDecisionDigest,
    X64, expected, expected + 1, I64,
    createHash('sha256').update(effectRepairRef).digest('hex'));
}

const runEffectsObligation = (overrides = {}) => ({
  obligationKey: `${WP}:run-effects:gate-accepted:${'decision:A'}`,
  sourceKind: 'gate-accepted',
  sourceRef: 'decision:A',
  sourceDigest: D64,
  subjectRef: WP,
  handoffKind: 'run-effects',
  ownerCapability: 'production-cell-node-executor',
  fence: 1,
  leaseFence: null,
  state: 'in_progress',
  attempt: 1,
  leaseOwner: 'test',
  leaseExpiresAt: null,
  completionReceipt: null,
  resultDigest: null,
  lastError: null,
  createdAt: '2026-08-18T00:00:00Z',
  updatedAt: '2026-08-18T00:00:00Z',
  ...overrides,
});

test('K13/ADR-074: the exact durable repair receipt is a TERMINAL run-effects postcondition (no re-drive, no provider call)', () => {
  const db = fixture();
  seedRepairIssue(db, { expected: 5 });
  // The workplace has NOT advanced to the repair's resulting revision yet:
  // the repair is recorded, but its state transition is not durable.
  assert.equal(readTransitionHandoffPostcondition(db, runEffectsObligation()).satisfied, false,
    'a repair issue without the resulting workplace revision is not yet terminal');

  db.prepare('UPDATE factory_workplaces SET revision=6 WHERE workplace_ref=?').run(WP);
  const postcondition = readTransitionHandoffPostcondition(db, runEffectsObligation());
  assert.equal(postcondition.satisfied, true,
    `the durable repair receipt settles the obligation without re-running the provider: ${postcondition.reason}`);
  db.close();
});

test('K13/ADR-074 (staleness): a repair receipt for an OLDER decision never satisfies a newer one', () => {
  const db = fixture();
  // Repair receipt issued for decision:A; the current obligation is for
  // decision:B (a later acceptance superseded A).
  seedRepairIssue(db, { gateDecisionKey: 'decision:A', gateDecisionDigest: D64, expected: 5 });
  db.prepare('UPDATE factory_workplaces SET revision=6 WHERE workplace_ref=?').run(WP);
  for (const drifted of [
    { sourceRef: 'decision:B' },
    { sourceDigest: E64 }, // same key, different decision digest
  ]) {
    const postcondition = readTransitionHandoffPostcondition(db, runEffectsObligation(drifted));
    assert.equal(postcondition.satisfied, false,
      `a stale repair receipt cannot settle a newer acceptance (${JSON.stringify(drifted)}): ${postcondition.reason}`);
  }
  db.close();
});

test('K13/ADR-074: an exact effect receipt is terminal regardless of repair state', () => {
  const db = fixture();
  db.prepare(
    `INSERT INTO factory_cell_effect_receipts
       (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,gate_decision_key,
        provider_receipt_ref,provider_receipt_digest,receipt_digest)
     VALUES (?, ?, 'git-integration', 'candidate-set/A', 'decision:A', 'provider:1', ?, ?)`,
  ).run('cell-effect-receipt:' + HEX, WP, P64, HEX);
  const postcondition = readTransitionHandoffPostcondition(db, runEffectsObligation());
  assert.equal(postcondition.satisfied, true,
    'the settled effect receipt is terminal — the provider is never re-invoked to obtain another receipt');
  db.close();
});

test('K13/ADR-074: a bare workplace effect_pending->terminal status write settles nothing', () => {
  const db = fixture();
  db.prepare(
    `UPDATE factory_workplaces SET loop_state='terminal', terminal_reason='accepted' WHERE workplace_ref=?`,
  ).run(WP);
  assert.equal(readTransitionHandoffPostcondition(db, runEffectsObligation()).satisfied, false,
    'a changed loop state alone is never a completion proof (the pre-K13 comment, now pinned)');
  db.close();
});
