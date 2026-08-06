/**
 * Regression + architecture tests for the SRS contract validator.
 *
 * Two groups:
 *
 *  1. Architecture sync (T1.7) — the validator must not carry its own copies
 *     of enums or required-field lists. Every value comes from SRS_CONTRACT.
 *     These tests break the build if someone re-introduces a hardcoded list
 *     that can drift out of sync with the canonical contract.
 *
 *  2. Behavioural (T1.2/T1.3) — the validator is fail-closed: missing SRS,
 *     missing file, hash mismatch, missing §12, missing Decision Log columns,
 *     missing §D2 fields, invalid enum values all → reject. A complete,
 *     canonical SRS → accept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { initSubmissionRegistries, getSubmissionPolicyRegistry } from '../../dist/process-modules/application/submission-registries.js';
import { createSrsContractValidator } from '../../dist/modules/formalization/application/srs-contract-validator.js';
import { SRS_CONTRACT, SRS_CONTRACT_REF } from '../../dist/modules/formalization/domain/srs-contract.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('p');
  db.prepare('INSERT INTO epics (id, project_id, name) VALUES (1, 1, ?)').run('e');
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (2, 1, 'sf', '1.0.0', 'sf@1', 'k', 'generic-flow', 's', '{}', 'h', 'running')`,
  ).run();
  return db;
}

function seedRepo(db) {
  const tmpDir = path.join(os.tmpdir(), `srs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  db.prepare('INSERT INTO repositories (id, name) VALUES (1, ?)').run('repo');
  db.prepare(
    'INSERT INTO project_repositories (id, project_id, repository_id, role, local_path, integration_branch, status) VALUES (1, 1, 1, ?, ?, ?, ?)',
  ).run('component', tmpDir, 'dev', 'active');
  return tmpDir;
}

function seedPrd(db) {
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, project_repository_id, storage_kind, tags, metadata)
     VALUES (2, 1, 1, 'PRD', null, 'PRD', 'prd.md', 'accepted', ?, ?, 'clean', 1, 'file_backed', '[]', '{}')`,
  ).run(hash('PRD'), hash('PRD'));
}

function seedSrs(db, tmpDir, srsContent) {
  const h = hash(srsContent);
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, project_repository_id, storage_kind, tags, metadata)
     VALUES (42, 1, 1, 'SRS', null, 'SRS', '01-SRS.md', 'draft', ?, ?, 'clean', 1, 'file_backed', '[]', '{}')`,
  ).run(h, h);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions (process_run_id, module_ref, node_id, intent_id, task_id, execution_id, artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'sf@1', 'define-architecture-contract', 7, 7, 'exec', 42, 'SRS', 'draft', ?, 'create')`,
  ).run(h);
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (42, 'artifact', 2, 'derived_from')`,
  ).run();
  writeFileSync(path.join(tmpDir, '01-SRS.md'), srsContent);
}

function seedSrsNoFile(db) {
  const h = hash('nonexistent');
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, project_repository_id, storage_kind, tags, metadata)
     VALUES (42, 1, 1, 'SRS', null, 'SRS', 'missing.md', 'draft', ?, ?, 'clean', 1, 'file_backed', '[]', '{}')`,
  ).run(h, h);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions (process_run_id, module_ref, node_id, intent_id, task_id, execution_id, artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'sf@1', 'define-architecture-contract', 7, 7, 'exec', 42, 'SRS', 'draft', ?, 'create')`,
  ).run(h);
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (42, 'artifact', 2, 'derived_from')`,
  ).run();
}

const validateInput = {
  processRunId: 2, moduleRef: 'sf@1', nodeId: 'define-architecture-contract',
  executionId: 'exec', taskId: 7, epicId: 1, projectId: 1,
};

// Canonical SRS example that exercises every required contract element. Used
// by the "accepts valid SRS" test and by the architecture-sync test.
function canonicalValidSrs() {
  const cols = SRS_CONTRACT.decisionLogColumns.join(' | ');
  const d2Fields = SRS_CONTRACT.d2RequiredFields;
  // Build one §D2 stanza containing every required field + valid enum value.
  const stanza = [
    '- ac: AC-1',
    `  title: "Feature"`,
    `  module: core`,
    `  files: [src/core.ts]`,
    `  invariants: []`,
    `  test_layers: [L0]`,
    `  pattern: ${SRS_CONTRACT.d2EnumFields.pattern[0]}`,
    `  depends_on: []`,
    `  ac_kind: ${SRS_CONTRACT.d2EnumFields.ac_kind[0]}`,
    `  criticality: ${SRS_CONTRACT.d2EnumFields.criticality[0]}`,
  ].join('\n');
  return [
    '# SRS',
    '',
    '## §12 Decision Log',
    '',
    `| ${cols} |`,
    `| ${SRS_CONTRACT.decisionLogColumns.map(() => '---').join(' | ')} |`,
    `| 1 | KISS | inherited | none | simplicity | 2026-01-01 |`,
    '',
    '### §D2. AC Map',
    '',
    '```yaml',
    stanza,
    '```',
    '',
  ].join('\n');
}

// ===========================================================================
// Group 1: Architecture sync — validator cannot drift from SRS_CONTRACT.
// ===========================================================================

test('SRS validator policy: define-architecture-contract is required + version-pinned', () => {
  const db = freshDb();
  initSubmissionRegistries(db);
  const registry = getSubmissionPolicyRegistry();
  const policy = registry.resolve('solution-formalization@1.0.0', 'define-architecture-contract');
  assert.ok(policy);
  assert.equal(policy.mode, 'required');
  assert.equal(policy.validatorId, 'formalization.srs-contract.v1');
  assert.ok(policy.contractRef, 'SRS policy must carry a contractRef for version pinning');
  assert.equal(policy.contractRef.version, SRS_CONTRACT_REF.version);
  assert.equal(policy.contractRef.digest, SRS_CONTRACT_REF.digest);
  db.close();
});

test('SRS_CONTRACT canonical criticality enum uses underscores (not hyphens)', () => {
  // The original bug: canonical had 'nice_to_have' but validator had 'nice-to-have'.
  // This test nails the canonical form so it can never silently flip.
  assert.ok(SRS_CONTRACT.d2EnumFields.criticality.includes('nice_to_have'));
  assert.ok(!SRS_CONTRACT.d2EnumFields.criticality.includes('nice-to-have'));
});

test('canonical valid SRS passes the validator', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedSrs(db, tmpDir, canonicalValidSrs());
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  if (!result.accepted) {
    console.error('GAPS:', JSON.stringify(result.gaps, null, 2));
  }
  assert.equal(result.accepted, true, 'canonical valid SRS must pass');
  db.close();
});

// ===========================================================================
// Group 2: Fail-closed behavioural tests (T1.2 / T1.3).
// ===========================================================================

test('rejects when no SRS artifact exists (fail-closed)', () => {
  const db = freshDb();
  seedRepo(db);
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_SRS_MISSING');
  db.close();
});

test('rejects when SRS file does not exist on disk (fail-closed)', () => {
  const db = freshDb();
  seedRepo(db);
  seedPrd(db);
  seedSrsNoFile(db);
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_SRS_INCOMPLETE');
  db.close();
});

test('rejects when file content hash != artifact.content_hash (fail-closed)', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  // Seed SRS with hash of "content A" but write "content B" to disk.
  const diskContent = '# SRS real content';
  const registeredContent = '# SRS different content';
  const h = hash(registeredContent);
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, project_repository_id, storage_kind, tags, metadata)
     VALUES (42, 1, 1, 'SRS', null, 'SRS', '01-SRS.md', 'draft', ?, ?, 'clean', 1, 'file_backed', '[]', '{}')`,
  ).run(h, h);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions (process_run_id, module_ref, node_id, intent_id, task_id, execution_id, artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'sf@1', 'define-architecture-contract', 7, 7, 'exec', 42, 'SRS', 'draft', ?, 'create')`,
  ).run(h);
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (42, 'artifact', 2, 'derived_from')`,
  ).run();
  writeFileSync(path.join(tmpDir, '01-SRS.md'), diskContent);
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_SRS_INCOMPLETE');
  assert.ok(result.gaps.some(g => g.missing.relation === 'file-hash-match'));
  db.close();
});

test('rejects when §12 Decision Log section is missing', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedSrs(db, tmpDir, '# SRS\n\nNo decision log here.\n');
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_SRS_INCOMPLETE');
  assert.ok(result.gaps.some(g => g.missing.relation === 'section'));
  db.close();
});

test('rejects when §12 table has fewer columns than required', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  // §12 present but table has only 2 columns (< required 6).
  seedSrs(db, tmpDir,
    '# SRS\n\n## §12 Decision Log\n\n| # | Decision |\n|---|----------|\n| 1 | KISS |\n');
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.ok(result.gaps.some(g => g.missing.relation === 'decision-log-columns'));
  db.close();
});

test('rejects when §D2 has no stanzas', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  const cols = SRS_CONTRACT.decisionLogColumns.join(' | ');
  seedSrs(db, tmpDir,
    `# SRS\n\n## §12 Decision Log\n\n| ${cols} |\n| ${SRS_CONTRACT.decisionLogColumns.map(() => '---').join(' | ')} |\n| 1 | KISS | inherited | none | simplicity | 2026-01-01 |\n\n## §D3. Other\n`);
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.ok(result.gaps.some(g => g.missing.relation === 'd2-stanzas'));
  db.close();
});

test('rejects when §D2 stanza is missing a required field (criticality)', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  const cols = SRS_CONTRACT.decisionLogColumns.join(' | ');
  // §D2 stanza missing criticality.
  const srsContent = [
    '# SRS',
    '',
    '## §12 Decision Log',
    '',
    `| ${cols} |`,
    `| ${SRS_CONTRACT.decisionLogColumns.map(() => '---').join(' | ')} |`,
    `| 1 | KISS | inherited | none | simplicity | 2026-01-01 |`,
    '',
    '### §D2. AC Map',
    '',
    '```yaml',
    '- ac: AC-1',
    '  title: "Feature"',
    '  module: core',
    '  files: [src/core.ts]',
    '  invariants: []',
    '  test_layers: [L0]',
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    // criticality intentionally omitted
    '```',
    '',
  ].join('\n');
  seedSrs(db, tmpDir, srsContent);
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.ok(result.gaps.some(g => g.missing.relation === 'd2-field' && g.missing.requiredTargetTypes.includes('criticality')));
  db.close();
});

test('rejects when §D2 criticality value is invalid enum', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  const cols = SRS_CONTRACT.decisionLogColumns.join(' | ');
  const srsContent = [
    '# SRS',
    '',
    '## §12 Decision Log',
    '',
    `| ${cols} |`,
    `| ${SRS_CONTRACT.decisionLogColumns.map(() => '---').join(' | ')} |`,
    `| 1 | KISS | inherited | none | simplicity | 2026-01-01 |`,
    '',
    '### §D2. AC Map',
    '',
    '```yaml',
    '- ac: AC-1',
    '  title: "Feature"',
    '  module: core',
    '  files: [src/core.ts]',
    '  invariants: []',
    '  test_layers: [L0]',
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: nice-to-have',
    '```',
    '',
  ].join('\n');
  seedSrs(db, tmpDir, srsContent);
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, false);
  assert.ok(result.gaps.some(g => g.missing.relation === 'valid-enum-value'));
  db.close();
});

test('rejects on contract version mismatch', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedSrs(db, tmpDir, canonicalValidSrs());
  const v = createSrsContractValidator(db);
  const result = v.validate({
    ...validateInput,
    contractRef: { version: '2.1', digest: '0'.repeat(64) }, // mismatched
  });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'SRS_CONTRACT_VERSION_MISMATCH');
  db.close();
});

test('accepts on contract version match', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedSrs(db, tmpDir, canonicalValidSrs());
  const v = createSrsContractValidator(db);
  const result = v.validate({
    ...validateInput,
    contractRef: SRS_CONTRACT_REF,
  });
  assert.equal(result.accepted, true);
  db.close();
});

test('receipt carries artifact hashes + trace digest (T1.8)', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedSrs(db, tmpDir, canonicalValidSrs());
  const v = createSrsContractValidator(db);
  const result = v.validate(validateInput);
  assert.equal(result.accepted, true);
  const receipt = result.receipt;
  assert.ok(receipt.artifactHashes, 'receipt must carry artifactHashes');
  const srsHash = receipt.artifactHashes['42'];
  assert.ok(srsHash, 'receipt must record the SRS content hash');
  assert.equal(srsHash, hash(canonicalValidSrs()));
  assert.ok('traceDigest' in receipt, 'receipt must carry traceDigest');
  db.close();
});
