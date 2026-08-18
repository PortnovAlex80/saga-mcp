// tests/architecture/authority-closure-suite.test.mjs
//
// K13 — the authority-closure suite (M3): every accepted write is
// attributable to ONE Gate-proven AuthorityCommit; the accepted head does
// not denormalize; obligations settle by exact source; effect repair is
// receipt-idempotent.
//
// AUDIT DECISIONS RECORDED (the plan's commit 2 "extend
// AcceptedAuthorityHead" was deliberately NOT implemented as denormalized
// columns): K10 proved the full accepted identity is DERIVABLE through the
// exact chain head -> GateDecision (check-plan digest) -> CandidateSet
// (members/ProductRefs) -> WorkplaceProductionRevision (package/semantic
// digests). Copying those fields onto the head would add drift surfaces
// against the byte-identical-identity invariant (pinned by
// accepted-head-monotonicity.test.mjs). The head stays the minimal
// monotonic pointer; its DDL is pinned to exactly the six columns.
//
// AUDIT (commit 4): obligations already settle by EXACT source — complete()
// requires the lease fence, the owner, and a completionReceipt; a replay
// with a DIFFERENT receipt fails typed. The handoff postconditions bind
// receipts to exact durable facts (transition-handoff-postconditions,
// since K7). Pinned here.
//
// AUDIT (commit 5): the ADR-074 repair feedback path is re-certified by
// the merged mainline fix (serialized workplaceRef in the repair-issue
// context) + its regression test; effect invocation is receipt-idempotent
// (settleAcceptanceEffect reads the durable receipt BEFORE invoking the
// provider). Pinned here.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

function listTypeScriptFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...listTypeScriptFiles(abs));
    else if (entry.endsWith('.ts')) {
      out.push({ rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'), abs });
    }
  }
  return out;
}

test('K13/closure: ONE accepted-head writer — SQL only in the repository, record() only from the verified acceptance', () => {
  const files = listTypeScriptFiles(SRC_ROOT);
  const sqlWriters = [];
  const recordCallers = [];
  for (const { rel, abs } of files) {
    const source = stripComments(readFileSync(abs, 'utf8'));
    if (/INSERT (OR REPLACE )?INTO factory_accepted_authority_head/iu.test(source)
      && rel !== 'src/infrastructure/workplace/sqlite-accepted-authority-head-repository.ts') {
      sqlWriters.push(rel);
    }
    if (/authorityHeadRepo\s*\.\s*record\s*\(/u.test(source)
      && rel !== 'src/process-modules/application/production-cell-coordinator.ts') {
      recordCallers.push(rel);
    }
  }
  assert.deepEqual(sqlWriters, [],
    'the accepted head table is written ONLY by its repository');
  assert.deepEqual(recordCallers, [],
    'the repository record() is called ONLY from applyVerifiedAcceptance — '
    + 'every accepted write is attributable to one Gate-proven AuthorityCommit');
});

test('K13/closure: the accepted head stays the minimal pointer (no denormalized identity drift)', () => {
  const schema = readFileSync(path.join(REPO_ROOT, 'src', 'schema.ts'), 'utf8');
  const match = /CREATE TABLE IF NOT EXISTS factory_accepted_authority_head \(([\s\S]*?)\n\);/.exec(schema);
  assert.ok(match, 'head DDL found');
  const columns = [...match[1].matchAll(/^\s+([a-z_]+)\s+/gm)].map(m => m[1]).sort();
  assert.deepEqual(
    columns,
    ['accepted_author_candidate_set_ref', 'accepted_author_gate_decision_key',
     'accepted_author_task_id', 'recorded_at', 'revision', 'workplace_ref'],
    'the head is exactly the six-column monotonic pointer. Adding a '
    + 'denormalized identity column (products/plan/package/baseline) creates '
    + 'drift against the byte-identical-identity invariant — extend the '
    + 'DERIVED chain instead (K10-proven), and update this pin via an ADR.',
  );
});

test('K13/closure: obligations settle by exact source — lease-fenced, receipt-bound, replay-typed', () => {
  const source = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'process-modules', 'persistence', 'sqlite-transition-obligation-ledger.ts'),
    'utf8',
  ));
  const completeAt = source.indexOf('complete(input: CompleteObligationInput)');
  const region = source.slice(completeAt, completeAt + 2200);
  assert.match(region, /assertLeaseFence/u, 'completion requires the lease fence');
  assert.match(region, /requireOwner\(input\.owner, 'COMPLETION'/u, 'completion requires the lease owner');
  assert.match(region, /completion_receipt=@receipt/u, 'completion persists the exact receipt');
  assert.match(
    region,
    /TRANSITION_OBLIGATION_ALREADY_COMPLETED[\s\S]{0,200}cannot replace/u,
    'a replay with a DIFFERENT receipt fails typed — generic status cannot settle',
  );
  assert.match(
    region,
    /state='in_progress'\s+AND lease_owner=@owner\s+AND lease_fence=@fence/u,
    'the UPDATE itself is fenced: only the current lease at the exact fence can settle',
  );
});

test('K13/closure: effect repair is receipt-idempotent (ADR-074 re-certified)', () => {
  const executor = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'process-modules', 'application', 'node-executors', 'production-cell-node-executor.ts'),
    'utf8',
  ));
  const settleAt = executor.indexOf('private settleAcceptanceEffect');
  const region = executor.slice(settleAt, settleAt + 3000);
  const receiptRead = region.indexOf('readEffectReceipt(');
  const providerInvoke = region.indexOf('postAcceptanceEffects.run(');
  assert.ok(receiptRead >= 0 && providerInvoke > receiptRead,
    'the durable effect receipt is read BEFORE the provider may be invoked — '
    + 'a settled receipt cannot produce a duplicate provider call');
  assert.match(region, /AUTHOR.?_ACCEPTANCE_DIGEST|computeAcceptanceDigest/u,
    'the receipt and repair evidence bind the exact acceptance digest');

  // The merged mainline fix + regression test carry the ADR-074 feedback
  // (serialized workplaceRef in the repair-issue context).
  const fixTest = readFileSync(
    path.join(REPO_ROOT, 'tests', 'process-modules', 'effect-repair-issue-context.test.mjs'),
    'utf8',
  );
  assert.match(fixTest, /serializeWorkplaceRef|deserializeWorkplaceRef/u,
    'the ADR-074 repair-context regression test exists and pins ref serialization');
});
