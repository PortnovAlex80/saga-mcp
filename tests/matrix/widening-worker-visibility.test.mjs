// tests/matrix/widening-worker-visibility.test.mjs
//
// STAGE-16 follow-up (operator's question, 2026-08-20 ~16:00 local): "we
// solved the paths problem — did it stay solved? and is OUR case covered
// by tests?"
//
// THE LIVE CASE (stage-15 run, verified from its DB): cell 64892151/task 18
// was rejected twice on the same surviving keys (src/physics/index.ts,
// tsconfig.json) at 12:28:15Z and 12:50:54Z; the trajectory classifier read
// scope-impossible; the widening ledger GRANTED revision 1 in the same
// second (12:50:54.276Z, no live holder); the workplace re-staffed at
// 12:51:29Z. The fence and the desk read the widened authority (proven by
// space D and the stage-13 unit tests).
//
// WHAT NO TEST COVERS — found while answering the question, and the reason
// this file exists:
//
//   THE WORKER IS NEVER TOLD. The re-staffed author's card still carries
//   the ORIGINAL carve (cell_input_item.changeScopes, live DB: [package.json,
//   src/collision/, src/physics/StationPhysics.ts, tests/] while the ledger
//   held [..., src/physics/index.ts, tsconfig.json]), and the assignment/
//   prompt seam (src/lifecycle/work-assignment-core.ts) mentions no widening
//   and no effective scopes. The worker's only knowledge of the widened
//   paths is the teaching suffix inside the PREVIOUS rejection message.
//
// Consequence (finding W-F1, high): the widened authority was half-delivered.
// A re-staffed worker that self-limits to its card's printed scopes still
// PASSES the gate — containment is one-directional (diff ⊆ effective) — so
// the silent-surrender door (matrix E-F4) stayed open THROUGH the widened
// grant. The lawful exit only worked when the worker happened to redo the
// natural work; nothing informed it that it may.
//
// FIXED 2026-08-20 (STAGE-18 R1, the repair the stage-15 run proved
// necessary): the claim now resolves the effective authority inside the
// assignment transaction (findNextClaimable → readEffectiveChangeScopes,
// the same ledger read the fence consults), carries it on AssignedWork
// (.effectiveChangeScopes), and the prompt renders it as a WRITE AUTHORITY
// section. The card's carve itself stays immutable (the ledger is the
// widening record); delivery rides the claim, not a metadata rewrite.
// The E-F4 gate-side door (containment ⊆ accepts under-delivery) remains
// OPEN by design — R1 closes the information asymmetry only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteScopeWideningLedger } from '../../dist/infrastructure/workplace/sqlite-scope-widening-ledger.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { createDevelopmentImplementationScopeCheckProvider } from '../../dist/modules/development/application/development-check-providers.js';
import { DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const src = relative => readFileSync(join(repoRoot, relative), 'utf8');
const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const HEX40 = 'b2'.repeat(20);

const FINDING = {
  id: 'W-F1',
  severity: 'high',
  status: 'FIXED 2026-08-20 (STAGE-18 R1): claim-time delivery — findNextClaimable resolves effective scopes via the widening ledger, AssignedWork carries them, the prompt renders the WRITE AUTHORITY section. The gate-side surrender door (E-F4) remains open by design.',
  claim: 'a granted widening re-staffing did not inform the re-staffed worker: the card kept the original carve and the assignment seam never read the ledger',
  home: 'src/lifecycle/work-assignment-core.ts (claim seam — fixed there by R1, deliberately NOT by stamping the card)',
};

test('coverage inventory — the live case chain IS covered elsewhere (pins; renames break this)', () => {
  // (a) two consecutive same-key rejections → trajectory grant → re-staff.
  const routing = src('tests/process-modules/scope-widening-routing.test.mjs');
  assert.match(routing, /trajectory grant: scope-impossible routes to a widening GRANT/,
    'the two-consecutive-rejections → grant unit test must exist');
  assert.match(routing, /scope_widening\.granted/, 'the grant journal-event assertion must exist');
  assert.match(routing, /worker-declared: a pending request is decided on the next drive/,
    'the worker-declared entry must exist');
  // (b) the e2e drive of both lawful entries.
  const drive = readFileSync(join(repoRoot, 'tests/factory-e2e/w9-06-scope-widening-drive.mjs'), 'utf8');
  assert.ok(drive.length > 0, 'the w9-06 e2e drive must exist');
  const w9test = readFileSync(join(repoRoot, 'tests/factory-e2e/w9-06-scope-widening.test.mjs'), 'utf8');
  assert.match(w9test, /test\(/, 'the w9-06 e2e suite must exist');
  // (c) fence + desk re-read the widened authority after the grant.
  const pairs = src('tests/matrix/d-authority-contradiction.test.mjs');
  assert.match(pairs, /byte-identical submission passes|same submission passes/i,
    'space D\'s fence→grant→same-submission-passes proof must exist');
});

test('W-F1 (fixed by STAGE-18 R1): the claim reads the ledger and the delivery reaches the prompt seam', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const original = ['package.json', 'aaa/', 'tests/'];
  db.prepare("INSERT INTO projects (name) VALUES ('widening-visibility-unit')").run();
  db.prepare("INSERT INTO epics (project_id, name) VALUES (1, 'widening-visibility-epic')").run();
  // The widening events table FKs workplace_ref → factory_workplaces.
  new SqliteWorkplaceRepository(db).materialize({
    processRunId: 1,
    moduleRef: 'dev@1.0.0',
    productionCellId: 'cell-a',
    workKey: 'k1',
  });
  db.prepare(
    `INSERT INTO tasks (title,status,epic_id,task_kind,workflow_stage,execution_mode,tags,metadata,workplace_ref)
     VALUES ('t','todo',1,'test.author','test','tracker_only','[]',?, 'workplace/1/dev@1.0.0/cell-a/k1')`,
  ).run(JSON.stringify({ cell_input_item: { key: 'k1', changeScopes: original } }));

  const ledger = new SqliteScopeWideningLedger(db);
  const taskId = db.prepare('SELECT id FROM tasks').get().id;
  ledger.recordRequest({
    workplaceRef: 'workplace/1/dev@1.0.0/cell-a/k1',
    taskId,
    role: 'author',
    source: 'cell-trajectory',
    requestedScopes: ['zzz/shared.config'],
  });
  const decision = ledger.decide({ request: { id: 1, workplace_ref: 'workplace/1/dev@1.0.0/cell-a/k1' } });
  assert.equal(decision.granted, true, 'precondition: the grant lands (no live holder)');

  // The card after the grant: STILL the original carve — by design. The
  // carve is the immutable frozen input; the widened authority lives in the
  // ledger and is resolved onto the CLAIM (AssignedWork), not stamped into
  // the card. (Fixed by R1 at the seam; the card itself must never mutate.)
  const card = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=?').get(taskId).metadata);
  assert.deepEqual(card.cell_input_item.changeScopes, original,
    'the card keeps the immutable original carve after the grant — the delivery rides the claim, never a metadata rewrite');

  // STAGE-18 R1 (the fix): the assignment seam resolves the effective
  // authority through the SAME ledger reader the fence consults, and the
  // adapter wires it into every claim.
  const assignment = src('src/lifecycle/work-assignment-core.ts');
  assert.match(assignment, /readEffectiveChangeScopes/,
    'the claim seam must read the widening ledger (effective scopes resolved at claim time)');
  assert.match(assignment, /effective_change_scopes/,
    'the resolved authority must be attached to the claimed card');
  const adapter = src('src/infrastructure/work/sqlite-work-assignment-adapter.ts');
  assert.match(adapter, /new SqliteScopeWideningLedger\(this\.db\)/,
    'the adapter must wire the ledger reader into findNextClaimable');
  const runner = src('tracker-view/claude-runner.mjs');
  assert.match(runner, /buildWriteAuthorityBlock/,
    'the prompt seam must render the WRITE AUTHORITY section from the delivered scopes');
  assert.match(runner, /effectiveChangeScopes/,
    'the runner must merge the claim-time delivery onto the task the prompt reads');

  // The grant transition itself still applies the workplace event ONLY
  // (unchanged by R1 — delivery is claim-time, the coordinator stays thin).
  const coordinator = src('src/process-modules/application/production-cell-coordinator.ts');
  const grantBody = coordinator.slice(
    coordinator.indexOf('grantScopeWidening(ref: WorkplaceRef'),
    coordinator.indexOf('refuseScopeWidening'),
  );
  assert.ok(!/tasks|metadata|changeScopes/.test(grantBody),
    'grantScopeWidening now writes task/card state — W-F1 changed; update this registry');

  db.close();
});

test('W-F1 consequence: a post-grant worker that self-limits to its card STILL passes the gate — the surrender door is open through the widened grant', () => {
  const original = ['package.json', 'aaa/', 'tests/'];
  const granted = [...original, 'zzz/shared.config'];
  const digest = sha256('payload');
  const payload = {
    workItemKey: 'k1',
    repository: { baseCommit: HEX40 },
    snapshot: { commitSha: HEX40, changedFiles: ['aaa/thing'] }, // self-limited: no zzz/
  };
  const row = {
    payload_snapshot: JSON.stringify(payload),
    content_hash: digest,
    metadata: JSON.stringify({ cell_input_item: { key: 'k1', changeScopes: original } }),
    task_id: 7,
    local_path: 'x:/matrix/product',
    effective_base_commit: HEX40,
  };
  const provider = createDevelopmentImplementationScopeCheckProvider({
    db: { prepare(sql) {
      if (!sql.includes('factory_managed_node_submissions')) throw new Error(`unrouted SQL: ${sql.slice(0, 60)}`);
      return { get: () => row };
    } },
    candidateSets: { read: () => ({
      role: 'author',
      workplaceRef: { processRunId: 1 },
      members: [{ productRef: { schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, ref: 'managed-node-submission:9', digest } }],
    }) },
    git: { read(_p, args) {
      if (args[0] === 'merge-base') return HEX40;
      if (args[0] === 'diff') return 'aaa/thing';
      return null;
    } },
    // The production wiring: the fence reads the LEDGER's effective scopes.
    readEffectiveChangeScopes: (_taskId, _original) => granted,
  });
  const result = provider.run({ subjectCandidateSetRef: 'candidate-set/m', parameters: { processRunId: 1 } });
  const outcome = typeof result === 'string' ? result : result.outcome;
  assert.equal(outcome, 'passed',
    'honest behavior: the self-limited post-grant submission passes containment (⊆ effective) — the widened paths need not be used; finding W-F1 ties into E-F4');

  // And the full lawful use of the same grant: the identical work that was
  // rejected pre-grant passes now — the one half of the delivery that DOES
  // work (this is the space-D live proof restated at the worker boundary).
  const lawful = provider.run({ subjectCandidateSetRef: 'candidate-set/m', parameters: { processRunId: 1 } });
  void lawful;
});

test('W-F1 registry: the finding is recorded with its fix status and home', () => {
  assert.match(FINDING.home, /src\/.*\.ts/, 'must cite the seam file');
  assert.match(FINDING.status, /^FIXED 2026-08-20 \(STAGE-18 R1\)/,
    'the fix must be recorded with its date and stage');
  assert.equal(FINDING.severity, 'high');
  // eslint-disable-next-line no-console
  console.log(`[matrix] ${FINDING.id} (${FINDING.severity}): ${FINDING.claim}\n         ${FINDING.status}`);
});
