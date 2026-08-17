// tests/architecture/replay-dispatch-routing.test.mjs
//
// K8 commit 4 — replay claims route through the exact binder with TYPED
// outcomes, not engine death (ADR-079 §2–3).
//
// The dispatch side was already typed when K8 audited it (plan item 19's
// typed dispatch outcomes; the ADR-053 Phase 7 binder). This test pins the
// routing so it cannot regress:
//
//   1. BEHAVIORAL — ineligibility is DERIVED from durable evidence and
//      downgrades the outcome to a typed miss: a capsule rejected by the
//      current gate in this workplace yields capsuleRef=null with the
//      semantic key still frozen (the next execution takes its normal
//      selected route). No exception, no engine involvement.
//   2. SOURCE-PINNED — the assignment adapter routes binder failures
//      through the per-card typed path: bindReplayToClaim runs INSIDE the
//      guarded region; a failure releases the reservation and annotates the
//      throwable with taskId before rethrowing, so the dispatch loop poisons
//      exactly this card and continues the drain (composed with
//      tests/infrastructure/dispatch-typed-outcomes.test.mjs, which proves
//      the loop side behaviorally).
//   3. SOURCE-PINNED — ineligibility evidence is exact-key: gate rejection
//      by (workplace, capsule) presentation attempt, or a failed replay
//      execution — no row-order semantics in the eligibility derivation.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import {
  freshDb,
  seedProcessRun,
  seedExecution,
  makeTask,
  taskMetadata,
  insertCapsule,
} from '../infrastructure/lib/replay-binder-fixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

const PKG = 'pkg-digest-stable';

// ---------------------------------------------------------------------------
// 1. Behavioral — gate-rejected capsule in this workplace = typed miss
// ---------------------------------------------------------------------------

test('K8/routing: a gate-rejected capsule in this workplace downgrades to a typed miss', () => {
  const db = freshDb();
  seedProcessRun(db, 900, 7, PKG);
  const key = computeReplayKey({
    projectId: 7,
    moduleRef: 'm@1.0.0',
    nodeId: 'node-produce',
    productionCellId: 'cell-x',
    workKey: 'work-1',
    role: 'author',
    packageDigest: PKG,
    semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
  const capsuleRef = `replay-capsule:${key}:p1`;
  insertCapsule(db, { capsuleRef, replayKey: key, projectId: 7, payloadHash: 'p1' });

  // Durable rejection evidence: a non-accepted gate decision in this
  // workplace whose presentation attempt presented exactly this capsule.
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key, workplace_ref, subject_candidate_set_ref,
        assessment_candidate_set_refs, gate_run_ref, verdict)
     VALUES ('decision-1', 'wp-x', 'cs-1', '[]', 'gate-run-1', 'rejected')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_gate_presentation_attempts
       (gate_run_ref, replay_capsule_ref)
     VALUES ('gate-run-1', ?)`,
  ).run(capsuleRef);

  seedExecution(db, 'exec-r1', 61, 7);
  const selection = bindReplayToClaim(db, {
    task: makeTask(61, taskMetadata(900), 'wp-x'),
    executionId: 'exec-r1',
    role: 'author',
  });

  assert.ok(selection, 'the claim still resolves a selection object');
  assert.equal(selection.capsuleRef, null,
    'the ineligible capsule is downgraded to a typed miss — not an error, '
    + 'not a nearby-row substitution');
  assert.equal(selection.replayKey, key,
    'the semantic key stays frozen on the claim for observability');

  // The same capsule stays eligible in a DIFFERENT workplace (rejection is
  // workplace-scoped durable evidence, not a global blacklist).
  seedExecution(db, 'exec-r2', 62, 7);
  const otherWorkplace = bindReplayToClaim(db, {
    task: makeTask(62, taskMetadata(900), 'wp-other'),
    executionId: 'exec-r2',
    role: 'author',
  });
  assert.equal(otherWorkplace.capsuleRef, capsuleRef,
    'a different workplace with no rejection evidence resolves the capsule');
});

// ---------------------------------------------------------------------------
// 2. Source pin — the adapter's typed per-card failure routing
// ---------------------------------------------------------------------------

test('K8/routing: the assignment adapter routes binder failures through release + taskId annotation', () => {
  const source = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'infrastructure', 'work', 'sqlite-work-assignment-adapter.ts'),
    'utf8',
  ));
  const start = source.indexOf('bindReplayToClaim(this.db');
  assert.ok(start >= 0, 'the adapter invokes the exact binder');
  // The guarded region: from the binder call, the catch must release the
  // assignment and annotate the throwable with the card id before rethrow.
  const region = source.slice(start, source.indexOf('countClaimable(', start));
  const catchAt = region.indexOf('catch (buildError)');
  assert.ok(catchAt > 0, 'the binder call sits inside a guarded region with a catch');
  const catchRegion = region.slice(catchAt);
  assert.match(catchRegion, /this\.releaseAssignment\(/u,
    'a binder failure releases the reserved assignment');
  assert.match(catchRegion, /taskId = task\.id/u,
    'the throwable is annotated with the card identity for per-card poisoning');
  assert.ok(catchRegion.indexOf('throw buildError') > catchRegion.indexOf('releaseAssignment'),
    'the original error is rethrown after the release');
});

// ---------------------------------------------------------------------------
// 3. Source pin — ineligibility evidence is exact-key, not row order
// ---------------------------------------------------------------------------

test('K8/routing: ineligibility derivation reads exact durable evidence, no ordering semantics', () => {
  const source = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'infrastructure', 'replay', 'replay-claim-binder.ts'),
    'utf8',
  ));
  const start = source.indexOf('function isCapsuleIneligibleInWorkplace');
  assert.ok(start >= 0, 'the eligibility derivation exists');
  const region = source.slice(start, source.indexOf('function metadataObject', start));
  assert.doesNotMatch(region, /order\s+by/iu,
    'eligibility is derived by exact-key existence probes, never by ordering');
  assert.match(region, /verdict\s*!=\s*'accepted'/u,
    'gate rejection is read from the durable decision verdict');
  assert.match(region, /replay_capsule_ref=\?/u,
    'the presentation attempt binds the exact capsule ref');
});
