// tests/process-modules/review-finding-structural-codes.test.mjs
//
// BLINDSIGHT (f) (Authority/Gate layer): reviewer finding codes were ORDINAL
// (review-finding-N) — the numbering collapses on every round (a finding that
// was review-finding-1 becomes review-finding-3 after another finding is
// fixed), so trajectory comparison between rounds was structurally impossible
// and the finding-trajectory budget had to EXCLUDE review findings entirely
// («Сравнение отключено» — the fourth form of blindness).
//
//   SC1 structural codes — a finding's code is derived from its FILE scope
//       (declared paths, sorted/deduped; 'unscoped' for pathless prose),
//       never from its index;
//   SC2 index-shift stability — removing one finding between rounds keeps
//       the surviving findings' codes byte-identical;
//   SC3 review findings become COMPARABLE — two rounds of the same verdict
//       produce a strict-subset trajectory ('converging'), i.e. cosmetic
//       resubmission is now machine-visible;
//   SC4 legacy ordinal codes (review-finding-N in already-written chains)
//       stay excluded from comparison — old rows must not suddenly compare.
//
// BEFORE the fix SC1..SC3 are RED: codes are review-finding-1/2/3.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createReviewVerdictCheckProvider } from '../../dist/process-modules/application/review-verdict-check-provider.js';
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  findingSet,
  trajectory,
} from '../../dist/process-modules/domain/workplace/finding-trajectory.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const WORKPLACE = {
  processRunId: 1,
  moduleRef: 'unit@1.0.0',
  productionCellId: 'cell-x',
  workKey: 'item-1',
};
const WORKPLACE_REF = serializeWorkplaceRef(WORKPLACE);
const SUBJECT = 'candidate-set/subject';
const PROVIDER = 'factory.review-verdict.v1';
const SCOPES = ['zone-a/', 'zone-b/manifest'];

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, workplace_ref TEXT, metadata TEXT
    );
    CREATE TABLE factory_accepted_authority_head (
      workplace_ref TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref TEXT NOT NULL,
      accepted_author_task_id TEXT
    );
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, schema_version TEXT,
      payload_snapshot TEXT, content_hash TEXT
    );
  `);
  db.prepare('INSERT INTO tasks VALUES (1, ?, ?)').run(
    WORKPLACE_REF,
    JSON.stringify({ role: 'author', cell_input_item: { key: 'item-1', changeScopes: SCOPES } }),
  );
  db.prepare('INSERT INTO factory_accepted_authority_head VALUES (?, ?, ?)')
    .run(WORKPLACE_REF, SUBJECT, '1');
  const candidateSets = {
    read(ref) {
      if (ref !== 'candidate-set/review') return null;
      return {
        candidateSetRef: ref,
        role: 'reviewer',
        subjectCandidateSetRef: SUBJECT,
        workplaceRef: WORKPLACE,
        members: [{
          productRef: {
            schemaId: 'factory.review-verdict.v1',
            ref: 'managed-node-submission:1',
            digest: VERDICT_DIGEST,
          },
        }],
      };
    },
  };
  return { db, candidateSets };
}

let VERDICT_DIGEST = '';

function runProvider(db, candidateSets, findings) {
  const payload = { subject_candidate_set_ref: SUBJECT, verdict: 'changes_requested', findings };
  VERDICT_DIGEST = sha256Hex(payload);
  db.prepare('DELETE FROM factory_managed_node_submissions').run();
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1, ?, ?, ?)')
    .run('factory.review-verdict.v1', JSON.stringify(payload), VERDICT_DIGEST);
  const provider = createReviewVerdictCheckProvider({ db, candidateSets });
  return provider.run({
    subjectCandidateSetRef: SUBJECT,
    parameters: { assessmentCandidateSetRefs: ['candidate-set/review'] },
  });
}

/** Decode a provider result into comparable TrajectoryFindings, exactly the
 * way decodeFindingsForDecision composes provider-scoped codes. */
function comparableFindings(result) {
  return (result.evidenceRefs ?? [])
    .map(ref => decodeCheckDiagnostic(ref))
    .filter(Boolean)
    .map(diagnostic => ({
      code: `${PROVIDER}:${diagnostic.code}`,
      severity: 'error',
      message: diagnostic.message,
    }));
}

test('SC1: finding codes are structural (file scope), never ordinal', () => {
  const { db, candidateSets } = fixture();
  const result = runProvider(db, candidateSets, [
    { message: 'widget broken', severity: 'error', paths: ['zone-a/widget-x'] },
    { message: 'manifest stale', severity: 'error', paths: ['zone-b/manifest', 'zone-a/widget-x'] },
    'bare prose without paths',
  ]);
  assert.equal(result.outcome, 'failed');
  const codes = comparableFindings(result).map(finding => finding.code.split(':').slice(1).join(':'));
  assert.deepEqual(codes.sort(), [
    'review-finding:unscoped',
    'review-finding:zone-a/widget-x',
    'review-finding:zone-a/widget-x|zone-b/manifest',
  ], 'codes derive from sorted deduped paths (or unscoped), not from indexes');
  db.close();
});

test('SC2: index shifts between rounds do not change surviving codes', () => {
  const { db, candidateSets } = fixture();
  const round1 = runProvider(db, candidateSets, [
    { message: 'widget broken', severity: 'error', paths: ['zone-a/widget-x'] },
    { message: 'gasket worn', severity: 'error', paths: ['zone-a/gasket-y'] },
    { message: 'bolt loose', severity: 'error', paths: ['zone-a/bolt-z'] },
  ]);
  // Round 2: the gasket was fixed — its finding disappeared; the two
  // survivors shifted up by one index.
  const round2 = runProvider(db, candidateSets, [
    { message: 'widget broken', severity: 'error', paths: ['zone-a/widget-x'] },
    { message: 'bolt loose', severity: 'error', paths: ['zone-a/bolt-z'] },
  ]);
  const codes1 = comparableFindings(round1).map(f => f.code).sort();
  const codes2 = comparableFindings(round2).map(f => f.code).sort();
  assert.deepEqual(codes2, [codes1[0], codes1[2]].sort(),
    'surviving findings keep byte-identical codes despite the index shift');
  db.close();
});

test('SC3: review findings are comparable — cosmetic resubmission is machine-visible', () => {
  const { db, candidateSets } = fixture();
  const round1 = runProvider(db, candidateSets, [
    { message: 'widget broken', severity: 'error', paths: ['zone-a/widget-x'] },
    { message: 'bolt loose', severity: 'error', paths: ['zone-a/bolt-z'] },
  ]);
  const identicalResubmission = runProvider(db, candidateSets, [
    { message: 'widget broken', severity: 'error', paths: ['zone-a/widget-x'] },
    { message: 'bolt loose', severity: 'error', paths: ['zone-a/bolt-z'] },
  ]);
  const partialFix = runProvider(db, candidateSets, [
    { message: 'widget broken', severity: 'error', paths: ['zone-a/widget-x'] },
  ]);

  const set1 = findingSet(comparableFindings(round1));
  const setSame = findingSet(comparableFindings(identicalResubmission));
  const setFixed = findingSet(comparableFindings(partialFix));

  assert.ok(set1.count >= 2, 'review findings must be INCLUDED in the comparable set');
  assert.equal(trajectory(set1, setSame), 'spinning',
    'a byte-identical resubmission must read as spinning');
  assert.equal(trajectory(set1, setFixed), 'converging',
    'a strict-subset round must read as converging');
  db.close();
});

test('SC4: legacy ordinal review codes stay excluded from comparison', () => {
  const legacy = findingSet([
    { code: 'factory.review-verdict.v1:review-finding-1', severity: 'error', message: 'old prose' },
    { code: 'factory.review-verdict.v1:deferred-out-of-scope-3', severity: 'error', message: 'old prose 2' },
  ]);
  assert.equal(legacy.count, 0,
    'already-written ordinal keys must never suddenly compare');
});
