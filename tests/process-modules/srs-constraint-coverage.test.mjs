/**
 * AC-drift remedy, network 2 (structure): the SRS→AC back-edge.
 *
 * The stage-11 SRS "restored" docker/TS into HOW sections (§10/§11) after a
 * review, while the trace graph has no SRS→AC back-edge — nothing obligates
 * covering them. This unit pins:
 *   - §D2 stanzas may carry covered_constraint_ids (comma-separated typed IDs);
 *   - the SRS contract validator diffs union(§D2 covered ids) against the
 *     constraint register (minus brief waivers) — non-empty remainder rejects
 *     with per-ID covers_constraint gaps;
 *   - the structural check provider performs the same diff from explicit
 *     parameters (register + waivers), removing its self-declared blindness.
 *
 * Retro-compatibility: no register -> empty diff -> green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { ensureFormalizationPersistenceSchema } from '../../dist/modules/formalization/infrastructure/formalization-persistence.js';
import { createSrsContractValidator } from '../../dist/modules/formalization/application/srs-contract-validator.js';
import {
  extractD2Stanzas,
  parseD2CoveredConstraintIdsByAc,
} from '../../dist/modules/formalization/application/srs-d2-parser.js';
import { createSrsStructuralCheckProvider } from '../../dist/modules/formalization/application/srs-structural-check-provider.js';
import { SRS_CONTRACT } from '../../dist/modules/formalization/domain/srs-contract.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../dist/process-modules/lifecycles/product-delivery-module-contracts.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

const ORDER_CONSTRAINTS = [
  { class: 'execution', text: 'one-command `docker compose up`', evidence_ref: 'order.source_body' },
  { class: 'material', text: 'TypeScript backend', evidence_ref: 'order.source_body' },
  { class: 'human', text: 'Chrome client feel', evidence_ref: 'order.source_body' },
];

function formalizationCase(orderConstraints) {
  return {
    schemaVersion: FORMALIZATION_CASE_SCHEMA,
    discoveryEpicId: 1,
    formalizationEpicId: 1,
    discoveryCertificateRef: 'certificate:1',
    discoveryCertificateHash: 'a'.repeat(64),
    discoveryOutcome: 'go',
    discoveryProposalRef: 'proposal:1',
    discoveryProposalHash: 'b'.repeat(64),
    discoveryProposalPayload: {
      problem_statement: 'p',
      observed_context: 'o',
      stakeholders_or_actors: ['a'],
      assumptions: [],
      unknowns: [],
      risks: [],
      candidate_scope: 's',
      evidence_refs: ['e'],
      recommended_outcome: 'go',
      rationale: 'r',
      ...(orderConstraints === undefined ? {} : { order_constraints: orderConstraints }),
    },
    initiativeSubject: 'docking slice',
    initiatedBy: 'operator',
  };
}

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);
  ensureFormalizationPersistenceSchema(db);
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('p');
  db.prepare('INSERT INTO epics (id, project_id, name) VALUES (1, 1, ?)').run('e');
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (2, 1, 'sf', '1.0.0', 'sf@1', 'k', 'generic-flow', 's', '{}', 'h', 'running')`,
  ).run();
  const acHash = hash('AC-1');
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status,
       content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (3, 1, 1, 'AC', 'AC-1', 'AC-1', 'ac-1.md', 'accepted', ?, ?,
             'clean', 'db_native', '[]', '{}')`,
  ).run(acHash, acHash);
  const baselinePayload = {
    schemaVersion: 'factory.acceptance-baseline-snapshot.v1',
    processRunId: 2,
    formalizationEpicId: 1,
    sourceReconciliationRef: 'test:reconciliation',
    sourceReconciliationHash: hash('reconciliation'),
    acArtifactIds: [3],
    acArtifactHashes: { 3: acHash },
    baselineHash: hash('baseline'),
  };
  db.prepare(
    `INSERT INTO factory_formalization_acceptance_baselines
       (process_run_id, formalization_epic_id, schema_version, payload,
        baseline_hash, snapshot_hash)
     VALUES (2, 1, ?, ?, ?, ?)`,
  ).run(
    baselinePayload.schemaVersion,
    JSON.stringify(baselinePayload),
    baselinePayload.baselineHash,
    hash(JSON.stringify(baselinePayload)),
  );
  return db;
}

function seedRepo(db) {
  const tmpDir = path.join(os.tmpdir(), `srs-cov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function seedTask(db, processNodeInput) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, metadata)
     VALUES (7, 1, 'define architecture contract', 'in_progress', ?)`,
  ).run(JSON.stringify({ process_node_input: processNodeInput }));
}

function seedBrief(db, dispositions) {
  const h = hash('brief');
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (1, 1, 1, 'brief', 'BRIEF-1', 'Brief', 'brief.md', 'accepted', ?, ?, 'clean', 'db_native', '[]', ?)`,
  ).run(h, h, JSON.stringify({ constraint_dispositions: dispositions }));
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions (process_run_id, module_ref, node_id, intent_id, task_id, execution_id, artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'sf@1', 'define-product-contract', 5, 5, 'exec', 1, 'brief', 'draft', ?, 'create')`,
  ).run(h);
}

function canonicalSrs(d2ExtraLine) {
  const cols = SRS_CONTRACT.decisionLogColumns.join(' | ');
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
    ...(d2ExtraLine ? [d2ExtraLine] : []),
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

const VALIDATE_INPUT = {
  processRunId: 2, moduleRef: 'sf@1', nodeId: 'define-architecture-contract',
  executionId: 'exec', taskId: 7, epicId: 1, projectId: 1,
};

// ---- parser -----------------------------------------------------------------

test('parseD2CoveredConstraintIdsByAc parses comma-separated typed IDs', () => {
  const content = canonicalSrs('  covered_constraint_ids: ord-c-001, ord-c-002');
  assert.deepEqual(
    parseD2CoveredConstraintIdsByAc(content).get('AC-1'),
    ['ord-c-001', 'ord-c-002'],
  );
  // The field also flows through the raw stanza fields.
  assert.equal(
    extractD2Stanzas(content)[0].fields.get('covered_constraint_ids'),
    'ord-c-001, ord-c-002',
  );
});

test('parseD2CoveredConstraintIdsByAc is empty without the field (retro-compat)', () => {
  const map = parseD2CoveredConstraintIdsByAc(canonicalSrs());
  assert.deepEqual(map.get('AC-1'), []);
});

// ---- srs contract validator --------------------------------------------------

test('SRS validator rejects register IDs covered by no §D2 stanza', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedBrief(db, {
    'ord-c-001': { disposition: 'accepted' },
    'ord-c-002': { disposition: 'accepted' },
    'ord-c-003': { disposition: 'waived', reason: 'human check deferred to operator' },
  });
  seedSrs(db, tmpDir, canonicalSrs()); // no covered_constraint_ids anywhere
  const result = createSrsContractValidator(db).validate(VALIDATE_INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_SRS_INCOMPLETE');
  const coverageGaps = result.gaps.filter(gap => gap.missing.relation === 'covers_constraint');
  assert.equal(coverageGaps.length, 2); // ord-c-003 waived
  assert.ok(coverageGaps.some(gap => gap.artifactCode === 'ord-c-001'));
  assert.ok(coverageGaps.some(gap => gap.message.includes('docker compose up')));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('SRS validator accepts when §D2 coverage ∪ waivers = register', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedBrief(db, {
    'ord-c-001': { disposition: 'accepted' },
    'ord-c-002': { disposition: 'accepted' },
    'ord-c-003': { disposition: 'waived', reason: 'human check deferred to operator' },
  });
  seedSrs(db, tmpDir, canonicalSrs('  covered_constraint_ids: ord-c-001,ord-c-002'));
  const result = createSrsContractValidator(db).validate(VALIDATE_INPUT);
  assert.equal(result.accepted, true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('SRS validator stays green without a register (retro-compat)', () => {
  const db = freshDb();
  const tmpDir = seedRepo(db);
  seedPrd(db);
  seedTask(db, formalizationCase(undefined));
  seedSrs(db, tmpDir, canonicalSrs());
  const result = createSrsContractValidator(db).validate(VALIDATE_INPUT);
  assert.equal(result.accepted, true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- structural check provider ------------------------------------------------

function contentReaderFor(content) {
  return { readSrsContent: () => content };
}

test('structural check provider diffs §D2 coverage against explicit register parameters', () => {
  const provider = createSrsStructuralCheckProvider(contentReaderFor(canonicalSrs()));
  // No parameters -> unchanged behavior (passed).
  assert.equal(
    provider.run({ parameters: { srsArtifactRef: 'artifact:42' } }),
    'passed',
  );
  // Register present, nothing covered -> failed.
  assert.equal(
    provider.run({
      parameters: {
        srsArtifactRef: 'artifact:42',
        constraintRegisterIds: JSON.stringify(['ord-c-001', 'ord-c-002']),
        waivedConstraintIds: JSON.stringify(['ord-c-002']),
      },
    }),
    'failed',
  );
  // Covered by the stanza -> passed.
  const covered = createSrsStructuralCheckProvider(
    contentReaderFor(canonicalSrs('  covered_constraint_ids: ord-c-001')),
  );
  assert.equal(
    covered.run({
      parameters: {
        srsArtifactRef: 'artifact:42',
        constraintRegisterIds: JSON.stringify(['ord-c-001', 'ord-c-002']),
        waivedConstraintIds: JSON.stringify(['ord-c-002']),
      },
    }),
    'passed',
  );
});
