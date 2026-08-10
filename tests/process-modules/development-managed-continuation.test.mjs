import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const { developmentContinuationProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-continuation-process-module.js'
);
const { createDevelopmentContinuationTaskGraphHandler } = await import(
  '../../dist/modules/development/infrastructure/development-continuation-installation.js'
);
const { ReferenceDevelopmentTaskGraphPolicy, hashDevelopmentPolicy } = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);

test('managed continuation has no planner and grants no mutable shell/Git tools', () => {
  assert.equal(developmentContinuationProcessModule.flow.entryNodeId, 'resolve-task-graph');
  assert.equal(
    developmentContinuationProcessModule.flow.nodes.some(node => node.id === 'plan-task-graph'),
    false,
  );
  const author = developmentContinuationProcessModule.executionProfiles.find(
    profile => profile.id === 'development-managed-source-author',
  );
  assert.equal(author.executionMode, 'artifact_change');
  for (const denied of [
    'Bash', 'Write', 'Edit', 'worker_merge_acquire', 'worker_merge_release',
  ]) {
    assert.equal(author.allowedTools.includes(denied), false, denied);
  }
  const implementation = developmentContinuationProcessModule.flow.nodes.find(
    node => node.id === 'implement-work-items',
  );
  assert.equal(
    implementation.cellDefinition.productContracts[0].schemaRef,
    'factory.source-change-candidate.v1',
  );
});

test('managed continuation deterministically emits one repair item and fresh verification for every AC', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_production_adoption_decisions (
      adoption_ref TEXT PRIMARY KEY,
      continuation_ref TEXT NOT NULL,
      project_repository_id INTEGER NOT NULL,
      integration_branch TEXT NOT NULL,
      integrated_commit TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      covered_acceptance_criteria TEXT NOT NULL
    );
    INSERT INTO factory_production_adoption_decisions VALUES
      ('adoption:1','continuation:1',7,'dev','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','[14,15]');
  `);
  let persisted = null;
  const deps = {
    taskGraphPolicy: new ReferenceDevelopmentTaskGraphPolicy(),
    taskGraph: {
      materializeValidatedTaskGraph(input) {
        persisted = input.graph;
        return {
          graph: input.graph,
          reference: {
            schema: input.graph.schemaVersion,
            ref: `graph:${input.graph.graphHash}`,
            hash: input.graph.graphHash,
          },
        };
      },
    },
  };
  const developmentCase = {
    schemaVersion: 'factory.development-case.v1',
    projectId: 1,
    epicId: 2,
    formalizationCertificate: { schema: 'cert', ref: 'cert:1', hash: 'c'.repeat(64), decision: 'formalized' },
    solutionContract: { schema: 'contract', ref: 'contract:1', hash: 'd'.repeat(64) },
    acceptanceBaselineHash: 'e'.repeat(64),
    srs: { schema: 'srs', ref: 'srs:1', hash: 'f'.repeat(64) },
    acceptanceCriteria: [
      { artifactId: 14, code: 'AC-1', acceptedHash: '1'.repeat(64), implementationRequired: true, criticality: 'blocker' },
      { artifactId: 15, code: 'AC-2', acceptedHash: '2'.repeat(64), implementationRequired: true, criticality: 'degradable' },
    ],
    repositories: [{ projectRepositoryId: 7, integrationBranch: 'dev', expectedBaseCommit: 'a'.repeat(40) }],
    policy: { id: 'p', version: '1', contentHash: '' },
    initiatedBy: 'operator',
    continuationRecovery: {
      authorizationRef: 'continuation:1',
      externalBaseline: {
        head: 'a'.repeat(40),
        remainingChangeScopes: ['index.html', 'js/app.js'],
      },
      adoptions: [{ ref: 'adoption:1', digest: 'b'.repeat(64) }],
    },
  };
  developmentCase.policy.contentHash = hashDevelopmentPolicy(developmentCase.policy);
  const handler = createDevelopmentContinuationTaskGraphHandler(db, deps);
  const result = handler({
    projectId: 1,
    epicId: 2,
    processRunId: 3,
    node: { id: 'resolve-task-graph' },
    input: developmentCase,
    frame: { runInput: developmentCase, productions: {} },
    heartbeat() {},
    initiatedBy: 'operator',
  });
  assert.equal(result.event, 'valid');
  assert.equal(persisted.implementationItems.length, 1);
  assert.deepEqual(persisted.implementationItems[0].acceptanceCriterionIds, [14, 15]);
  assert.equal(persisted.implementationItems[0].executionMode, 'artifact_change');
  assert.equal(persisted.verificationItems.length, 2);
  assert.equal(persisted.integrationTargets[0].expectedBaseCommit, 'a'.repeat(40));
  db.close();
});
