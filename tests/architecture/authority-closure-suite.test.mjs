// tests/architecture/authority-closure-suite.test.mjs
//
// K13 — the authority-closure suite (M3): every accepted write is
// attributable to ONE Gate-proven AuthorityCommit; the accepted head carries
// the pinned K13 byte-identity surface; obligations settle by exact source;
// effect repair is receipt-idempotent.
//
// SUPERSEDED AUDIT DECISION: 09687df7 deliberately did NOT extend the head
// ("minimal pointer"). The stage-9 brief supersedes it — the release card is
// the specification, and §K13 commit 2 names the identity columns. The DDL
// pin below moved WITH the release (card commit 2); same-revision drift in
// any identity dimension fails closed (accepted-head-exact-identity.test.mjs).
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

test('K13/closure: the head DDL is pinned to the exact K13 identity surface', () => {
  const schema = readFileSync(path.join(REPO_ROOT, 'src', 'schema.ts'), 'utf8');
  const match = /CREATE TABLE IF NOT EXISTS factory_accepted_authority_head \(([\s\S]*?)\n\);/.exec(schema);
  assert.ok(match, 'head DDL found');
  const columns = [...match[1].matchAll(/^\s+([a-z_]+)\s+/gm)].map(m => m[1]).sort();
  assert.deepEqual(
    columns,
    ['acceptance_id', 'accepted_author_candidate_set_ref',
     'accepted_author_gate_decision_key', 'accepted_author_task_id',
     'baseline_workplace_revision', 'check_plan_digest',
     'package_fingerprint', 'product_refs', 'production_revision_ref',
     'recorded_at', 'revision', 'workplace_ref'],
    'the head is the six-column pointer PLUS the K13 byte-identity columns '
    + '(card §K13 commit 2: acceptance ID, check-plan digest, package '
    + 'fingerprint, production revision, ProductRefs, CAS baseline — exactly '
    + 'as the card names them). The 09687df7 minimal-pointer audit decision '
    + 'is superseded by the stage-9 brief ("the release card is the '
    + 'specification"). Adding or removing a column is a deliberate '
    + 'architectural act — do it in the same commit as the decision, and '
    + 'update this pin.',
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
