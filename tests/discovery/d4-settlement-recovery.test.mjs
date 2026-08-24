import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import(
  '../../dist/modules/discovery/domain/discovery-proposal.js'
);
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA, READINESS_DIMENSIONS } = await import(
  '../../dist/modules/discovery/domain/discovery-readiness-assessment.js'
);
const { canonicalJson, sha256Hex } = await import('../../dist/shared/canonical-json.js');
const { createDiscoveryProductionCellKernelHandlers } = await import(
  '../../dist/modules/discovery/application/discovery-production-cell-installation.js'
);
const { SqliteLifecycleRunRepository, ensureFactoryLifecycleRunSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const {
  productBuildLifecycle,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST,
} = await import('../../dist/process-modules/lifecycles/product-build-lifecycle.js');

const PROPOSAL = {
  problem_statement: 'p', observed_context: 'o', stakeholders_or_actors: ['a'],
  assumptions: [], unknowns: ['the pricing algorithm is not yet chosen'], risks: [],
  candidate_scope: 's', evidence_refs: ['e'], recommended_outcome: 'go', rationale: 'r',
};

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function seedRun(db, { lifecycleRunId, processRunId }) {
  const definitionHash = sha256Hex(productBuildLifecycle);
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
        definition_snapshot,definition_hash,project_id,epic_id,initiated_by,idempotency_key,
        input_schema,input_snapshot,input_hash,status,entry_stage_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'created',?)`,
  ).run(
    lifecycleRunId, 'product-build', '1.2.0', 'product-build@1.2.0', 'd', 'd',
    canonicalJson(productBuildLifecycle), definitionHash, 1, 10, 'm6a',
    `m6a-${lifecycleRunId}`, 's', '{}', sha256Hex({}), 'initial-discovery',
  );
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,1,10,'discovery','1.0.0','discovery@1.0.0',?,'generic-flow','x','{}',?,'running')`,
  ).run(processRunId, `m6a-${processRunId}`, sha256Hex({}));
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,module_ref_key,
        binding_snapshot,binding_hash,input_schema,input_snapshot,input_hash,status,process_run_id)
     VALUES (?,?,1,'initial-discovery',1,'discovery','1.0.0','discovery@1.0.0','{}',?,
             's','{}',?,'created',?)`,
  ).run(lifecycleRunId * 10, lifecycleRunId, sha256Hex({}), sha256Hex({}), processRunId);
}

const readinessId = (processRunId) => 2000 + processRunId;

function seedSubmissions(db, { processRunId, proposal }) {
  const proposalHash = sha256Hex(proposal);
  const dimensions = {};
  for (const dimension of READINESS_DIMENSIONS) {
    dimensions[dimension] = { status: 'sufficient', rationale: 'g', source_refs: ['$.problem_statement'] };
  }
  const readiness = {
    proposal_content_hash: proposalHash,
    overall_readiness: 'ready',
    dimension_assessments: dimensions,
    blocking_gaps: [], non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement', confidence: 0.9, rationale: 'g',
  };
  const readinessHash = sha256Hex(readiness);
  const proposalId = 1000 + processRunId;
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (?,10,'S','done','discovery.work')`).run(proposalId);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES (?,?,?,?,?,'w','m','terminated','executing')`,
  ).run(`exec-m6a-${processRunId}`, `run-${processRunId}`, 1, proposalId, proposalId);
  const insert = db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    proposalId, processRunId, 'discovery@1.0.0', 'produce-proposal', proposalId, proposalId,
    `exec-m6a-${processRunId}`, DISCOVERY_PROPOSAL_SCHEMA, JSON.stringify(proposal), proposalHash,
  );
  insert.run(
    readinessId(processRunId), processRunId, 'discovery@1.0.0', 'produce-readiness', proposalId,
    proposalId, `exec-m6a-${processRunId}`, DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
    JSON.stringify(readiness), readinessHash,
  );
  return {
    schemaId: DISCOVERY_PROPOSAL_SCHEMA,
    ref: `managed-node-submission:${proposalId}`,
    digest: proposalHash,
  };
}

function settle(db, { processRunId, product }) {
  const repo = new SqliteLifecycleRunRepository(db);
  const issued = [];
  const handlers = createDiscoveryProductionCellKernelHandlers({
    db,
    certificates: {
      issue: (command) => {
        issued.push(command);
        return { record: { id: 900 + issued.length, certificateHash: command.certificateHash } };
      },
    },
    lifecycleDefinitionReader: { readDefinitionByProcessRun: (id) => repo.readDefinitionByProcessRun(id) },
    lifecycleInjectionDeclarations: [{
      table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
      tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
      tableDigest: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST,
    }],
    lifecycleInjectionRequiredClassifications: ['runnable-local'],
  });
  const manifest = (ref) => ({
    schema: 'factory.production-cell-output-manifest.v1',
    bindings: {
      final: true,
      items: [{
        accepted: true, id: 'i', workKey: 'w', workplaceRef: 'wp', candidateSetRef: 'cs',
        execution: { intentId: 1, taskId: 1, executionRef: `exec-${ref.ref}` },
        products: [ref],
      }],
    },
  });
  const readiness = db.prepare(
    'SELECT content_hash FROM factory_managed_node_submissions WHERE id=?',
  ).get(readinessId(processRunId));
  const result = handlers['discovery-settlement-policy']({
    projectId: 1, epicId: 10, processRunId,
    node: { id: 'settle-discovery' },
    input: manifest({
      schemaId: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
      ref: `managed-node-submission:${readinessId(processRunId)}`,
      digest: readiness.content_hash,
    }),
    frame: { productions: { 'produce-proposal': manifest(product) } },
    heartbeat: () => {}, initiatedBy: 'm6a',
  });
  return { result, issued };
}

test('m6a: a continuation inherits the original register; drifted re-extraction is typed red', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-d4-m6a-'));
  process.env.DB_PATH = path.join(temp, 'd4m6a.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
    ensureFactoryLifecycleRunSchema(db);

    seedRun(db, { lifecycleRunId: 1, processRunId: 100 });
    const originalProduct = seedSubmissions(db, { processRunId: 100, proposal: PROPOSAL });
    const originalRun = settle(db, { processRunId: 100, product: originalProduct });
    const original = originalRun.issued[0].payload.constraintRegister;
    assert.ok(original);

    db.prepare(`UPDATE factory_lifecycle_runs SET status='completed' WHERE id=1`).run();
    seedRun(db, { lifecycleRunId: 2, processRunId: 200 });
    const continuationProduct = seedSubmissions(db, { processRunId: 200, proposal: PROPOSAL });
    const continuation = settle(db, { processRunId: 200, product: continuationProduct });
    assert.equal(continuation.issued[0].payload.constraintRegister.registerDigest, original.registerDigest);

    const drifted = {
      ...PROPOSAL,
      unknowns: [],
      order_constraints: [{ class: 'material', text: 'a re-extracted constraint', evidence_ref: 'order.source_body' }],
    };
    db.prepare(`UPDATE factory_lifecycle_runs SET status='completed' WHERE id=2`).run();
    seedRun(db, { lifecycleRunId: 3, processRunId: 300 });
    seedSubmissions(db, { processRunId: 300, proposal: drifted });
    const reextract = settle(db, {
      processRunId: 300,
      product: { ...originalProduct, digest: sha256Hex(drifted) },
    });
    assert.equal(reextract.result.event, 'failed');
    assert.match(reextract.result.production.bindings.error, /DISCOVERY_PRODUCT_MISSING/);
    assert.equal(reextract.issued.length, 0);
  } finally {
    cleanup(temp);
  }
});
