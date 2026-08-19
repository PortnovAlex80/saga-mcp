import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createReviewVerdictCheckProvider } from '../../dist/process-modules/application/review-verdict-check-provider.js';
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

// ADR-062 executable: a BLOCKING finding whose every declared path lies outside
// the subject item's frozen changeScopes is DEFERRED (an observation owned by
// another work item) and cannot alone produce changes_requested.
// Universal: abstract zones/paths only — no languages, no workshop names.

const WORKPLACE = {
  processRunId: 1,
  moduleRef: 'unit@1.0.0',
  productionCellId: 'cell-x',
  workKey: 'item-1',
};
const WORKPLACE_REF = serializeWorkplaceRef(WORKPLACE);
const SCOPES = ['zone-a/', 'zone-b/manifest'];

function fixture({ scopes }) {
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
  const metadata = {
    role: 'author',
    cell_input_item: scopes ? { key: 'item-1', changeScopes: scopes } : undefined,
  };
  db.prepare('INSERT INTO tasks VALUES (1, ?, ?)')
    .run(WORKPLACE_REF, JSON.stringify(metadata));
  db.prepare('INSERT INTO factory_accepted_authority_head VALUES (?, ?, ?)')
    .run(WORKPLACE_REF, 'candidate-set/subject', '1');
  const candidateSets = {
    read(ref) {
      if (ref !== 'candidate-set/review') return null;
      return {
        candidateSetRef: ref,
        role: 'reviewer',
        subjectCandidateSetRef: 'candidate-set/subject',
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

const SUBJECT = 'candidate-set/subject';
let VERDICT_DIGEST = '';

function runProvider(db, candidateSets, findings) {
  const payload = {
    subject_candidate_set_ref: SUBJECT,
    verdict: 'changes_requested',
    findings,
  };
  VERDICT_DIGEST = sha256Hex(payload);
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1, ?, ?, ?)')
    .run('factory.review-verdict.v1', JSON.stringify(payload), VERDICT_DIGEST);
  const provider = createReviewVerdictCheckProvider({ db, candidateSets });
  return provider.run({
    subjectCandidateSetRef: SUBJECT,
    parameters: { assessmentCandidateSetRefs: ['candidate-set/review'] },
  });
}

function decoded(result) {
  return (result.evidenceRefs ?? []).map(ref => decodeCheckDiagnostic(ref));
}

test('all blockers out-of-scope → verdict passes, findings deferred as observations', () => {
  const { db, candidateSets } = fixture({ scopes: SCOPES });
  const result = runProvider(db, candidateSets, [
    { message: 'switch broken', severity: 'error', paths: ['launcher/switch-x'] },
  ]);
  assert.equal(result.outcome, 'passed');
  const diag = decoded(result);
  assert.equal(diag.length, 1);
  assert.equal(diag[0].code, 'deferred-out-of-scope:launcher/switch-x');
  assert.match(diag[0].message, /DEFERRED — outside this item's frozen changeScopes/);
  db.close();
});

test('in-scope blocker keeps force; out-of-scope one rides as deferred', () => {
  const { db, candidateSets } = fixture({ scopes: SCOPES });
  const result = runProvider(db, candidateSets, [
    { message: 'widget broken', severity: 'error', paths: ['zone-a/widget-x'] },
    { message: 'switch broken', severity: 'error', paths: ['launcher/switch-x'] },
  ]);
  assert.equal(result.outcome, 'failed');
  const diag = decoded(result);
  const blocking = diag.filter(d => d.code === 'review-finding:zone-a/widget-x');
  const deferred = diag.filter(d => d.code === 'deferred-out-of-scope:launcher/switch-x');
  assert.equal(blocking.length, 1);
  assert.equal(deferred.length, 1);
  assert.match(deferred[0].message, /DEFERRED/);
  db.close();
});

test('no declared scopes (non-repository cell) → filter is a no-op', () => {
  const { db, candidateSets } = fixture({ scopes: null });
  const result = runProvider(db, candidateSets, [
    { message: 'any path', severity: 'error', paths: ['elsewhere/thing'] },
  ]);
  assert.equal(result.outcome, 'failed');
  const diag = decoded(result);
  assert.equal(diag[0].code, 'review-finding:elsewhere/thing');
  db.close();
});

test('partially in-scope paths stay actionable (conservative)', () => {
  const { db, candidateSets } = fixture({ scopes: SCOPES });
  const result = runProvider(db, candidateSets, [
    { message: 'mixed', severity: 'error', paths: ['zone-a/widget-x', 'launcher/switch-x'] },
  ]);
  assert.equal(result.outcome, 'failed');
  assert.equal(decoded(result)[0].code, 'review-finding:launcher/switch-x|zone-a/widget-x');
  db.close();
});

test('file-scope matches exactly; directory scope matches descendants', () => {
  const { db, candidateSets } = fixture({ scopes: SCOPES });
  const result = runProvider(db, candidateSets, [
    { message: 'exact file scope', severity: 'error', paths: ['zone-b/manifest'] },
  ]);
  // zone-b/manifest is an exact declared scope → actionable blocker stays.
  assert.equal(result.outcome, 'failed');
  db.close();
});

test('a later author task cannot change the sealed subject scope authority', () => {
  const { db, candidateSets } = fixture({ scopes: SCOPES });
  db.prepare('INSERT INTO tasks VALUES (2, ?, ?)').run(
    WORKPLACE_REF,
    JSON.stringify({
      role: 'author',
      cell_input_item: { key: 'repair-decoy', changeScopes: ['launcher/'] },
    }),
  );
  const result = runProvider(db, candidateSets, [
    { message: 'accepted-scope defect', severity: 'error', paths: ['zone-a/widget-x'] },
  ]);
  assert.equal(result.outcome, 'failed');
  assert.equal(decoded(result)[0].code, 'review-finding:zone-a/widget-x');
  db.close();
});
