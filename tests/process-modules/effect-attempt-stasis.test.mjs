// tests/process-modules/effect-attempt-stasis.test.mjs
//
// BLINDSIGHT F1 (persistence layer, PREVENTIVE-HUNT «Слепота по слоям»):
// `factory_effect_attempts` was written on EVERY post-acceptance effect
// invocation (typed outcome + reason, append-only, per exact desired state)
// while its reader `readEffectAttempts` had ZERO callers. The durable
// detector data existed and no decision point consumed it: an effect that
// returns the SAME `pending`/failure reason forever kept the Workplace in
// `effect_pending` with no typed exit — an unbounded spin loop.
//
// This suite pins the honest repair, mirroring the obligation reason-identity
// valve (transition-obligation-reconciler.ts, CONVEYOR §15 "Budget must count
// spin, not work"):
//   - K consecutive attempts with the SAME typed identity (outcome + reason)
//     on one idempotency key = spin → the executor routes the workplace to a
//     typed human park (ACCEPTANCE_EFFECT_ATTEMPT_STASIS), fail-closed;
//   - a NEW reason identity RESETS the consecutive counter — converging
//     chains (each attempt removing another defect) are never taxed;
//   - the gate is NOT weakened: the park only ENDS the wait; final acceptance
//     still requires the exact effect receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_SQL } from '../../dist/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const {
  DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD,
  detectEffectAttemptStasis,
} = await import('../../dist/process-modules/domain/workplace/effect-attempt-stasis.js');
const { SqliteCellFinalAcceptance } = await import(
  '../../dist/infrastructure/workplace/sqlite-cell-final-acceptance.js'
);

const WORKPLACE_REF = {
  processRunId: 7,
  moduleRef: 'm@1.0.0',
  productionCellId: 'cell',
  workKey: 'work-1',
};

function attempt(outcome, reason, attemptNo) {
  return { attemptNo, outcome, reason };
}

test('F1 unit: K consecutive identical typed identities trip the stasis detector', () => {
  const K = DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD;
  assert.equal(typeof K, 'number', 'threshold is exported and parameterizable');
  assert.ok(K >= 2, 'threshold is at least 2 (a repeat, not a single occurrence)');

  const spin = detectEffectAttemptStasis(
    Array.from({ length: K }, (_, i) => attempt('pending', 'provider lease held', i + 1)),
  );
  assert.ok(spin, 'K identical attempts are detected as stasis');
  assert.equal(spin.outcome, 'pending');
  assert.equal(spin.reason, 'provider lease held');
  assert.equal(spin.consecutive, K);
});

test('F1 unit: below K identical attempts does NOT trip (one more honest retry is allowed)', () => {
  const K = DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD;
  const below = detectEffectAttemptStasis(
    Array.from({ length: K - 1 }, (_, i) => attempt('pending', 'provider lease held', i + 1)),
  );
  assert.equal(below, null);
});

test('F1 unit: a NEW reason identity RESETS the consecutive counter (converging chains are work, never taxed)', () => {
  const K = DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD;
  // Two identical 'first blocker' attempts, then the chain MOVES to a new
  // typed reason. Even with one more repeat of the new reason the tail run
  // (2) is below K — the earlier identical run does NOT accumulate.
  const resetBelow = detectEffectAttemptStasis([
    attempt('pending', 'first blocker', 1),
    attempt('pending', 'first blocker', 2),
    attempt('pending', 'second blocker', 3),
    attempt('pending', 'second blocker', 4),
  ]);
  assert.equal(
    resetBelow,
    null,
    `a changed identity resets the counter — tail run of ${K - 1} does not trip even after ${K - 1} earlier identical attempts`,
  );

  // Only when the NEW identity itself repeats K times consecutively does the
  // detector trip — reporting the NEW identity and only its own run length.
  const detection = detectEffectAttemptStasis([
    attempt('pending', 'first blocker', 1),
    attempt('pending', 'first blocker', 2),
    ...Array.from({ length: K }, (_, i) => attempt('pending', 'second blocker', 3 + i)),
  ]);
  assert.ok(detection, 'K identical tail attempts still trip');
  assert.equal(detection.reason, 'second blocker');
  assert.equal(detection.consecutive, K, 'only the tail run counts');

  // A chain where every reason is distinct NEVER trips — that is convergence.
  const converging = detectEffectAttemptStasis([
    attempt('pending', 'a', 1),
    attempt('pending', 'b', 2),
    attempt('pending', 'c', 3),
    attempt('pending', 'd', 4),
  ]);
  assert.equal(converging, null, 'four distinct reasons in a row are work, not spin');
});

test('F1 unit: typed identity includes the outcome (same reason, different outcome = different identity)', () => {
  const K = DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD;
  const mixed = detectEffectAttemptStasis([
    attempt('pending', 'shared reason', 1),
    attempt('repair_required', 'shared reason', 2),
    attempt('pending', 'shared reason', 3),
  ]);
  assert.equal(
    mixed,
    null,
    `outcome is part of the identity — an alternating pattern below ${K} consecutive same-outcome attempts is not yet typed spin`,
  );
});

test('F1 unit: null reason is a typed identity of its own (pending without reason)', () => {
  const K = DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD;
  const detection = detectEffectAttemptStasis(
    Array.from({ length: K }, (_, i) => attempt('pending', null, i + 1)),
  );
  assert.ok(detection, 'K consecutive reason-less pendings are still spin');
  assert.equal(detection.reason, null);
});

test('F1 repo: readEffectAttempts returns the full append-only chain oldest-first', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  const finalAcceptance = new SqliteCellFinalAcceptance(db);
  const effect = {
    effectId: 'stasis-effect',
    version: '1.0.0',
    effectDigest: 'd'.repeat(64),
  };
  const key = 'idem:stasis';
  for (let i = 1; i <= DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD; i += 1) {
    finalAcceptance.recordEffectAttempt({
      workplaceRef: WORKPLACE_REF,
      effect,
      candidateSetRef: 'candidate-set/A',
      gateDecisionKey: 'decision:A',
      idempotencyKey: key,
      outcome: 'pending',
      reason: 'provider lease held',
    });
  }
  const chain = finalAcceptance.readEffectAttempts(WORKPLACE_REF, 'stasis-effect', key);
  assert.equal(chain.length, DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD);
  assert.deepEqual(
    chain.map(row => row.attemptNo),
    [1, 2, 3].slice(0, DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD),
  );
  assert.ok(chain.every(row => row.outcome === 'pending'));
  db.close();
});

test('F1 wiring: settleAcceptanceEffect consumes the attempt chain and routes stasis to a typed human park', () => {
  const executorSource = readFileSync(path.join(
    REPO_ROOT,
    'src/process-modules/application/node-executors/production-cell-node-executor.ts',
  ), 'utf8');

  // The dead reader is now called at the decision point.
  assert.match(
    executorSource,
    /readEffectAttempts\(/,
    'the executor must call readEffectAttempts (the previously dead reader) at the effect-pending decision point',
  );
  // The stasis exit is typed and fail-closed (same shape as ACCEPTANCE_EFFECT_BLOCKED).
  assert.match(
    executorSource,
    /ACCEPTANCE_EFFECT_ATTEMPT_STASIS/,
    'the executor must route effect-attempt stasis to a typed park reason',
  );
  assert.match(
    executorSource,
    /detectEffectAttemptStasis\(/,
    'the executor must run the stasis detector over the durable attempt chain',
  );
});
