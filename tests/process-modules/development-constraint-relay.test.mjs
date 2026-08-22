/**
 * AC-drift remedy, network 2 relay: constraint IDs must survive the handoff
 * into Development — the planner card inherits the frozen AC's
 * coveredConstraintIds, and the verification evidence lineage check pins them
 * together with criterionId. This is what lets the A3 execution network later
 * close a warrant line by ID+digest (the seam), without re-reading the order.
 *
 * Retro-compatibility: criteria without coveredConstraintIds relay nothing;
 * every existing shape stays valid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureManagedNodeSubmissionSchema } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import {
  buildCanonicalDevelopmentTaskGraph,
} from '../../dist/modules/development/domain/development-task-graph.js';
import {
  buildDevelopmentTaskGraphSubmitCallFromCase,
} from '../../dist/modules/development/application/development-workspace-preparation.js';
import {
  decodeDevelopmentVerificationProduct,
} from '../../dist/modules/development/domain/development-verification-product.js';
import {
  createDevelopmentVerificationCheckProvider,
} from '../../dist/modules/development/application/development-check-providers.js';
import {
  buildSolutionContractPayload,
} from '../../dist/modules/formalization/application/formalization-production-cell-installation.js';
import { SRS_CONTRACT } from '../../dist/modules/formalization/domain/srs-contract.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

function developmentCase(criteria) {
  return {
    schemaVersion: 'factory.development-case.v1',
    projectId: 1,
    epicId: 1,
    formalizationCertificate: {
      schema: 'factory.formalization-certificate.generic.v1',
      ref: 'certificate:9',
      hash: 'f'.repeat(64),
      decision: 'formalized',
    },
    solutionContract: { schema: 's', ref: 'r', hash: 'c'.repeat(64) },
    acceptanceBaselineHash: 'a'.repeat(64),
    srs: { schema: 'factory.srs.v1', ref: 'artifact:40', hash: 'd'.repeat(64) },
    acceptanceCriteria: criteria,
    repositories: [{
      projectRepositoryId: 1,
      integrationBranch: 'dev',
      expectedBaseCommit: '0'.repeat(40),
    }],
    policy: { id: 'p', version: '1', contentHash: 'e'.repeat(64) },
    initiatedBy: 'operator',
  };
}

function criterion(overrides = {}) {
  return {
    criterionId: 30,
    artifactId: 30,
    code: 'AC-1',
    acceptedHash: '1'.repeat(64),
    implementationRequired: true,
    criticality: 'blocker',
    ...overrides,
  };
}

function proposal(items) {
  return {
    schemaVersion: 'factory.development-task-graph-proposal.v1',
    implementationItems: items,
    verificationItems: [{
      key: 'verify-ac-1',
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: 1,
      acceptanceCriterionKeys: ['30:AC-1'],
      dependsOnKeys: [],
      changeScopes: [],
      required: true,
      criticality: 'blocker',
    }],
    integrationTargets: [{
      projectRepositoryId: 1,
      sourceWorkItemKeys: [],
      targetBranch: 'dev',
      expectedBaseCommit: '0'.repeat(40),
    }],
  };
}

function implementationItem(overrides = {}) {
  return {
    key: 'impl-1',
    kind: 'implementation',
    taskKind: 'development.impl',
    executionSkill: 'saga-worker',
    executionMode: 'tracker_only',
    projectRepositoryId: 1,
    acceptanceCriterionKeys: ['30:AC-1'],
    dependsOnKeys: [],
    changeScopes: ['work-item:impl-1'],
    required: true,
    criticality: 'blocker',
    ...overrides,
  };
}

const PLANNER_SUBMISSION = { schema: 's', ref: 'r', hash: 'h'.repeat(64) };

test('canonical task graph items inherit coveredConstraintIds from their frozen criteria', () => {
  const case_ = developmentCase([
    criterion({ coveredConstraintIds: ['ord-c-001', 'ord-c-002'] }),
  ]);
  const graph = buildCanonicalDevelopmentTaskGraph(
    case_,
    proposal([implementationItem()]),
    PLANNER_SUBMISSION,
  );
  for (const item of [...graph.implementationItems, ...graph.verificationItems]) {
    assert.deepEqual(item.coveredConstraintIds, ['ord-c-001', 'ord-c-002']);
  }
});

test('canonical task graph items relay nothing when criteria carry no coverage (retro)', () => {
  const case_ = developmentCase([criterion()]);
  const graph = buildCanonicalDevelopmentTaskGraph(
    case_,
    proposal([implementationItem()]),
    PLANNER_SUBMISSION,
  );
  for (const item of [...graph.implementationItems, ...graph.verificationItems]) {
    assert.equal(item.coveredConstraintIds, undefined);
  }
});

test('machine-filled planner submit call carries criterion coveredConstraintIds', () => {
  const call = buildDevelopmentTaskGraphSubmitCallFromCase(
    developmentCase([criterion({ coveredConstraintIds: ['ord-c-001'] })]),
  );
  assert.deepEqual(call.content.verificationItems[0].coveredConstraintIds, ['ord-c-001']);
});

// ---- solution contract payload carries D2 coverage ---------------------------

function srsContentWithCoverage() {
  const cols = SRS_CONTRACT.decisionLogColumns.join(' | ');
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
    '- ac: AC-1',
    '  title: "Feature"',
    '  module: core',
    '  files: [src/core.ts]',
    '  invariants: []',
    '  test_layers: [L0]',
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '  covered_constraint_ids: ord-c-001,ord-c-002',
    '```',
    '',
  ].join('\n');
}

test('solution contract acceptanceCriteria carry §D2 covered_constraint_ids', () => {
  const deps = {
    graph: {
      readArtifactsByIds: (ids) => ids.map((id) => ({
        id,
        projectId: 1,
        epicId: 1,
        type: id === 29 ? 'AC' : id === 40 ? 'SRS' : 'PRD',
        code: id === 29 ? 'AC-1' : null,
        status: 'accepted',
        contentHash: hash(`artifact-${id}`),
        acceptedHash: hash(`artifact-${id}`),
        driftState: 'clean',
        tags: '[]',
        metadata: {},
      })),
      readOutgoingArtifactTraces: () => [],
    },
    baselineRepository: {
      readByProcessRun: () => ({
        payload: {
          acceptanceCriteria: [
            { artifactId: 29, code: 'AC-1', title: 'Feature', contentHash: hash('ac-29') },
          ],
        },
      }),
    },
    readArtifactContent: (id) => (id === 40 ? srsContentWithCoverage() : 'x'),
  };
  const bundle = {
    schemaVersion: 'factory.solution-contract-certificate.v1',
    formalizationEpicId: 1,
    prdArtifactId: 2,
    frArtifactIds: [3],
    nfrArtifactIds: [],
    ruleArtifactIds: [],
    ucArtifactIds: [26],
    acArtifactIds: [29],
    acceptanceBaselineHash: 'a'.repeat(64),
    srsArtifactId: 40,
    bundleHash: 'b'.repeat(64),
  };
  const payload = buildSolutionContractPayload(
    deps,
    {
      processRunId: 2,
      projectId: 1,
      epicId: 1,
    },
    {
      schemaVersion: 'factory.formalization-case.v1',
      discoveryCertificateRef: 'certificate:1',
      discoveryCertificateHash: 'a'.repeat(64),
      formalizationEpicId: 1,
    },
    bundle,
    'baseline-ref',
    'b'.repeat(64),
  );
  assert.equal(payload.acceptanceCriteria.length, 1);
  assert.deepEqual(
    payload.acceptanceCriteria[0].coveredConstraintIds,
    ['ord-c-001', 'ord-c-002'],
  );
});

// ---- verification evidence lineage pins coveredConstraintIds ------------------

function lineageFixture({ cardConstraintIds, evidenceConstraintIds }) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureManagedNodeSubmissionSchema(db);
  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'p')`).run();
  db.prepare(`INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e')`).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (2, 1, 'sd', '1.4.4', 'sd@1.4.4', 'k', 'generic-flow', 's', '{}', 'h', 'running')`,
  ).run();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase)
     VALUES ('exec-v', 'run-1', 1, 1, 7, 'w', 'm', 'running', 'executing')`,
  ).run();
  const accepted = hash('criterion');
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (30, 1, 1, 'AC', 'AC-1', 'AC-1', 'ac.md', 'accepted', ?, ?, 'clean', 'db_native', '[]', '{}')`,
  ).run(accepted, accepted);
  const candidateHash = hash('candidate');
  const card = {
    key: 'verify-ac-1',
    acceptanceCriterionKeys: ['30:AC-1'],
    ...(cardConstraintIds === null ? {} : { coveredConstraintIds: cardConstraintIds }),
  };
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, verification_target_artifact_id, metadata)
     VALUES (7, 1, 'verify ac-1', 'in_progress', 30, ?)`,
  ).run(JSON.stringify({
    cell_input_item: card,
    process_node_input: { upstream: { bindings: { candidate: { candidateHash } } } },
  }));
  const product = evidenceProduct(
    evidenceConstraintIds === null
      ? {}
      : { coveredConstraintIds: evidenceConstraintIds },
  );
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id, process_run_id, module_ref, node_id, intent_id, task_id, execution_id, schema_version, payload_snapshot, content_hash, submitted_at)
     VALUES (11, 2, 'sd@1.4.4', 'verify-acceptance', 6, 7, 'exec-v',
             'factory.candidate-verification-evidence-product.v2', ?, ?, ?)`,
  ).run(
    JSON.stringify(product),
    hash(JSON.stringify(product)),
    new Date().toISOString(),
  );
  return { db, digest: hash(JSON.stringify(product)) };
}

function evidenceProduct(overrides = {}) {
  return {
    schemaVersion: 'factory.candidate-verification-evidence-product.v2',
    verificationItemKey: 'verify-ac-1',
    acceptanceCriterionKey: '30:AC-1',
    acceptedCriterionHash: hash('criterion'),
    candidateHash: hash('candidate'),
    outcome: 'passed',
    evidence: {
      summary: 'verified',
      observations: ['observed'],
      limitations: [],
    },
    ...overrides,
  };
}

function fakeCandidateSets() {
  return {
    read: () => ({
      role: 'author',
      workplaceRef: { processRunId: 2 },
      members: [{
        productRef: {
          schemaId: 'factory.candidate-verification-evidence-product.v2',
          ref: 'managed-node-submission:11',
          digest: hash(JSON.stringify(evidenceProduct())),
        },
      }],
    }),
  };
}

function runProvider(db, digest) {
  const outcome = createDevelopmentVerificationCheckProvider({
    db,
    candidateSets: {
      read: () => ({
        role: 'author',
        workplaceRef: { processRunId: 2 },
        members: [{
          productRef: {
            schemaId: 'factory.candidate-verification-evidence-product.v2',
            ref: 'managed-node-submission:11',
            digest,
          },
        }],
      }),
    },
  }).run({ subjectCandidateSetRef: 'cset:1', parameters: { processRunId: 2 } });
  return typeof outcome === 'string' ? outcome : outcome.outcome;
}

test('evidence carrying the card coveredConstraintIds passes lineage', () => {
  const { db, digest } = lineageFixture({
    cardConstraintIds: ['ord-c-001', 'ord-c-002'],
    evidenceConstraintIds: ['ord-c-001', 'ord-c-002'],
  });
  assert.equal(runProvider(db, digest), 'passed'); // provider proves shape + exact lineage
  db.close();
});

test('evidence omitting coveredConstraintIds fails lineage when the card pins them', () => {
  const { db, digest } = lineageFixture({
    cardConstraintIds: ['ord-c-001', 'ord-c-002'],
    evidenceConstraintIds: null,
  });
  assert.equal(runProvider(db, digest), 'failed');
  db.close();
});

test('evidence with divergent coveredConstraintIds fails lineage', () => {
  const { db, digest } = lineageFixture({
    cardConstraintIds: ['ord-c-001', 'ord-c-002'],
    evidenceConstraintIds: ['ord-c-001'],
  });
  assert.equal(runProvider(db, digest), 'failed');
  db.close();
});

test('card without coveredConstraintIds keeps legacy lineage behavior (retro)', () => {
  const { db, digest } = lineageFixture({
    cardConstraintIds: null,
    evidenceConstraintIds: null,
  });
  assert.equal(runProvider(db, digest), 'passed');
  db.close();
});

test('verification product decoder accepts coveredConstraintIds as a string array', () => {
  const decoded = decodeDevelopmentVerificationProduct(
    evidenceProduct({ coveredConstraintIds: ['ord-c-001'] }),
  );
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.value.coveredConstraintIds, ['ord-c-001']);
});
