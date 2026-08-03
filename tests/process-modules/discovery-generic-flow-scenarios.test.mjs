/**
 * Discovery generic-flow lineage scenarios.
 *
 * These tests exercise the architectural boundary introduced by P6c:
 *
 *   LM node -> NodeExecutionReceipt -> module-owned resolver -> NodeProduction
 *
 * A completed task is execution evidence, not a Discovery Proposal. The
 * scripted LM executor below invokes the real proposal/normalization/readiness
 * tool handlers, but returns ONLY a receipt. Discovery kernel handlers must
 * materialize exact domain products from canonical SQLite rows.
 *
 * The adversarial rows are intentional: after the target Proposal and
 * ReadinessAssessment are accepted, a newer Proposal/assessment is inserted
 * for the same epic. Settlement must remain pinned to the products resolved
 * for this ProcessRun and must never use an epic-wide "latest" fallback.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteProcessOutcomeCertificateRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);
const { GenericFlowExecutor } = await import(
  '../../dist/process-modules/application/generic-flow-executor.js'
);
const { KernelNodeExecutor } = await import(
  '../../dist/process-modules/application/node-executors/kernel-node-executor.js'
);
const { KernelHandlerRegistry } = await import(
  '../../dist/process-modules/application/kernel-handler-registry.js'
);
const {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} = await import(
  '../../dist/process-modules/application/handlers/process-outcome-emitter.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { createDiscoveryKernelHandlers } = await import(
  '../../dist/process-modules/modules/discovery/discovery-installation.js'
);
const { SqliteSaga3DiscoveryRuntime } = await import(
  '../../dist/modules/discovery/infrastructure/sqlite-saga3-discovery-runtime.js'
);
const { Saga3DiscoverySettlementService } = await import(
  '../../dist/modules/discovery/application/discovery-settlement-service.js'
);
const { createSaga3ProposalHandlers } = await import(
  '../../dist/tools/saga3-proposals.js'
);
const { createSaga3NormalizationHandlers } = await import(
  '../../dist/tools/saga3-normalization.js'
);
const { createSaga3ReadinessHandlers } = await import(
  '../../dist/tools/saga3-readiness.js'
);
const { buildExecutionContext } = await import(
  '../../dist/shared/authority/build-execution-context.js'
);
const { executionContextHash } = await import(
  '../../dist/shared/authority/execution-context.js'
);
const {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_READINESS_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} = await import('../../dist/shared/work-intent.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import(
  '../../dist/modules/discovery/domain/discovery-proposal.js'
);
const { DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA } = await import(
  '../../dist/modules/discovery/domain/discovery-normalization-proposal.js'
);
const {
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  READINESS_DIMENSIONS,
} = await import(
  '../../dist/modules/discovery/domain/discovery-readiness-assessment.js'
);
const { canonicalJson } = await import(
  '../../dist/shared/canonical-json.js'
);

const PROJECT_ID = 1;
const EPIC_ID = 70;

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-disc-generic-lineage-'));
  process.env.DB_PATH = path.join(temp, 'discovery-generic.db');
  const db = getDb();
  db.prepare(
    `INSERT INTO projects (id,name,status) VALUES (?,'P','active')`,
  ).run(PROJECT_ID);
  db.prepare(
    `INSERT INTO epics (id,project_id,name,description)
     VALUES (?,?,'Discovery','Investigate the bounded product problem')`,
  ).run(EPIC_ID, PROJECT_ID);
  db.prepare(
    `INSERT INTO episode_workflows (epic_id,stage,metadata)
     VALUES (?,'discovery','{}')`,
  ).run(EPIC_ID);
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validProposal(overrides = {}) {
  return {
    problem_statement: 'Users cannot validate a bounded product idea quickly.',
    observed_context: 'The repository contains an initial product brief.',
    stakeholders_or_actors: ['product owner', 'end user'],
    assumptions: ['A small first release is acceptable.'],
    unknowns: ['Which workflow has the highest user value?'],
    risks: ['The first release may be scoped too broadly.'],
    candidate_scope: 'Validate one end-to-end workflow.',
    evidence_refs: ['artifact:req-1'],
    recommended_outcome: 'go',
    rationale: 'The problem and first validation boundary are explicit.',
    ...overrides,
  };
}

function semanticAmbiguityProposal() {
  return {
    ...validProposal(),
    // A conflicting supported alias forces the deterministic D1 boundary to
    // preserve the raw submission and request bounded semantic normalization.
    problem: 'A conflicting alias value that needs source-bound resolution.',
  };
}

function validReadiness(proposalId, proposalHash, overrides = {}) {
  const dimensions = {};
  for (const dimension of READINESS_DIMENSIONS) {
    dimensions[dimension] = {
      status: 'sufficient',
      rationale: `${dimension} is grounded in the Proposal.`,
      source_refs: ['$.problem_statement'],
    };
  }
  return {
    proposal_id: proposalId,
    proposal_content_hash: proposalHash,
    overall_readiness: 'ready',
    dimension_assessments: dimensions,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'Every required readiness dimension is sufficiently grounded.',
    ...overrides,
  };
}

/**
 * Track accidental use of the two historical epic-wide lookups. They remain
 * on the legacy persistence port for compatibility, but the generic Discovery
 * Pack is forbidden to call them.
 */
function trackedRuntime() {
  const target = new SqliteSaga3DiscoveryRuntime();
  const legacyLookupCalls = [];
  const forbidden = new Set([
    'readLatestProposalByEpic',
    'readLatestAcceptedReadinessForEpic',
  ]);
  const runtime = new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== 'function') return value;
      if (forbidden.has(property)) {
        return (...args) => {
          legacyLookupCalls.push({ method: property, args });
          return value.apply(object, args);
        };
      }
      return value.bind(object);
    },
  });
  return { runtime, legacyLookupCalls };
}

/**
 * Build the discovery kernel handlers with the settlement service injected
 * EXPLICITLY, mirroring the production composition root (Wave 8 MEDIUM 7):
 * the deterministic D4 settlement service is constructed here and passed
 * through the declared DiscoverySettlementPort. The Discovery module no longer
 * self-provisions it via a dynamic import.
 */
function discoveryHandlers(runtime) {
  return createDiscoveryKernelHandlers({
    runtimePersistence: runtime,
    settlementService: new Saga3DiscoverySettlementService({ runtimePersistence: runtime }),
  });
}

/**
 * Freeze a real execution authority snapshot for an existing WorkIntent/task.
 * This is the minimum worker-plane setup required by the real Saga3 submit
 * handlers: exact task fence, live worker execution and immutable authority.
 */
function bindLiveExecution(db, runtime, {
  intentId,
  taskId,
  executionId,
  workerId,
}) {
  const intent = runtime.readWorkIntent(intentId);
  assert.ok(intent, `WorkIntent ${intentId} must exist`);
  const capturedAt = '2026-07-26T12:00:00.000Z';
  const executionContext = buildExecutionContext({
    modelRoute: {
      model: 'scripted-test-model',
      provider: 'test',
      effort: 'high',
    },
    workIntent: intent,
    capturedAt,
  });

  db.prepare(
    `UPDATE tasks
        SET status='in_progress', assigned_to=?, current_execution_id=?
      WHERE id=?`,
  ).run(workerId, executionId, taskId);
  db.prepare(
    `UPDATE saga3_work_intents SET status='executing' WHERE id=?`,
  ).run(intentId);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        state,phase,metadata)
     VALUES (?,?,?,?,?,?,?,'running','executing',?)`,
  ).run(
    executionId,
    `run-${executionId}`,
    PROJECT_ID,
    EPIC_ID,
    taskId,
    workerId,
    'test-machine',
    JSON.stringify({
      execution_context: executionContext,
      execution_context_hash: executionContextHash(executionContext),
    }),
  );
}

function finishExecution(db, { intentId, taskId, executionId }) {
  db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(taskId);
  db.prepare(
    `UPDATE saga3_work_intents SET status='concluded' WHERE id=?`,
  ).run(intentId);
  db.prepare(
    `UPDATE worker_executions
        SET state='exited', phase='finishing', finished_at=datetime('now')
      WHERE execution_id=?`,
  ).run(executionId);
}

function taskMetadata(db, taskId) {
  const row = db.prepare(`SELECT metadata FROM tasks WHERE id=?`).get(taskId);
  assert.ok(row, `task ${taskId} must exist`);
  return JSON.parse(row.metadata ?? '{}');
}

/**
 * Insert a valid but unrelated newer Proposal + accepted readiness assessment
 * for the same epic. These rows must win any ORDER BY id DESC epic-wide query,
 * making a fallback substitution immediately visible.
 */
function seedNewerDistractor(db) {
  const proposalPayload = validProposal({
    problem_statement: 'DISTRACTOR: unrelated newer proposal.',
    candidate_scope: 'An unrelated scope.',
    evidence_refs: ['artifact:distractor'],
    recommended_outcome: 'reject',
    rationale: 'This row must never be selected by the target ProcessRun.',
  });
  const proposalHash = sha256Canonical(proposalPayload);

  const productTask = db.prepare(
    `INSERT INTO tasks
       (epic_id,title,status,priority,task_kind,workflow_stage,
        execution_skill,execution_mode,generation_key,tags,metadata)
     VALUES (?,'Distractor proposal','done','high','discovery.work','discovery',
        'saga-discovery-worker','tracker_only',?,'[]','{}')`,
  ).run(EPIC_ID, 'distractor-product');
  const productTaskId = Number(productTask.lastInsertRowid);
  const productIntent = db.prepare(
    `INSERT INTO saga3_work_intents
       (epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (?,?,?,'{}',?,'concluded',?)`,
  ).run(
    EPIC_ID,
    DISCOVERY_INTENT_KIND,
    'Unrelated distractor',
    DISCOVERY_WORK_INTENT_SCHEMA,
    productTaskId,
  );
  const productIntentId = Number(productIntent.lastInsertRowid);
  db.prepare(`UPDATE tasks SET metadata=? WHERE id=?`).run(
    JSON.stringify({ work_intent_id: productIntentId }),
    productTaskId,
  );
  const proposal = db.prepare(
    `INSERT INTO saga3_proposals
       (intent_id,task_id,execution_id,kind,schema_version,payload,
        content_hash,status,provenance)
     VALUES (?,?,?,'discovery',?,?,?,'submitted','{}')`,
  ).run(
    productIntentId,
    productTaskId,
    `distractor-product-exec-${productIntentId}`,
    DISCOVERY_PROPOSAL_SCHEMA,
    canonicalJson(proposalPayload),
    proposalHash,
  );
  const proposalId = Number(proposal.lastInsertRowid);

  const readinessTask = db.prepare(
    `INSERT INTO tasks
       (epic_id,title,status,priority,task_kind,workflow_stage,
        execution_skill,execution_mode,generation_key,tags,metadata)
     VALUES (?,'Distractor readiness','done','high','discovery.assess','discovery',
        'saga-discovery-readiness-advisor','tracker_only',?,'[]','{}')`,
  ).run(EPIC_ID, 'distractor-readiness');
  const readinessTaskId = Number(readinessTask.lastInsertRowid);
  const readinessIntent = db.prepare(
    `INSERT INTO saga3_work_intents
       (epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (?,?,?,'{}',?,'concluded',?)`,
  ).run(
    EPIC_ID,
    DISCOVERY_READINESS_INTENT_KIND,
    'Assess unrelated distractor',
    DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
    readinessTaskId,
  );
  const readinessIntentId = Number(readinessIntent.lastInsertRowid);
  db.prepare(`UPDATE tasks SET metadata=? WHERE id=?`).run(
    JSON.stringify({ work_intent_id: readinessIntentId }),
    readinessTaskId,
  );
  const control = db.prepare(
    `INSERT INTO saga3_readiness_control_intents
       (epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,
        authority_intent_id,projected_task_id,status)
     VALUES (?,'AssessDiscoveryReadiness',?,?,?,?,?,'concluded')`,
  ).run(
    EPIC_ID,
    proposalId,
    proposalHash,
    productIntentId,
    readinessIntentId,
    readinessTaskId,
  );
  const controlIntentId = Number(control.lastInsertRowid);
  const assessmentPayload = validReadiness(proposalId, proposalHash, {
    overall_readiness: 'not_ready',
    blocking_gaps: [{
      code: 'DISTRACTOR',
      description: 'This belongs to another Proposal.',
      source_refs: ['$.problem_statement'],
    }],
    recommended_next_action: 'reject',
    rationale: 'This assessment must not be selected by the target run.',
  });
  const assessmentHash = sha256Canonical(assessmentPayload);
  const assessment = db.prepare(
    `INSERT INTO saga3_readiness_assessments
       (control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
        payload,content_hash,status,overall_readiness,recommended_next_action)
     VALUES (?,?,?,?,?,?,?,'accepted_by_kernel','not_ready','reject')`,
  ).run(
    controlIntentId,
    proposalId,
    proposalHash,
    readinessTaskId,
    `distractor-readiness-exec-${readinessIntentId}`,
    canonicalJson(assessmentPayload),
    assessmentHash,
  );

  return {
    proposalId,
    proposalHash,
    assessmentId: Number(assessment.lastInsertRowid),
    assessmentHash,
  };
}

function executionReceipt({
  intentId,
  taskId,
  executionId,
  runtimeStatus = 'completed',
}) {
  return {
    kind: 'task-execution',
    executorKind: 'lm',
    intentId,
    taskId,
    executionId,
    runtimeStatus,
    replayed: false,
  };
}

/**
 * Script the LM plane while preserving the production boundary. Every branch
 * invokes the real module tool handler and then returns only execution evidence.
 */
function createScriptedLmExecutor({
  db,
  runtime,
  processRunId,
  proposalPayload,
  injectDistractor = true,
  reportedRuntimeStatus = 'completed',
}) {
  const proposalTools = createSaga3ProposalHandlers({
    db: () => db,
    now: () => new Date('2026-07-26T12:01:00.000Z'),
  }).handlers;
  const normalizationTools = createSaga3NormalizationHandlers({
    db: () => db,
    now: () => new Date('2026-07-26T12:02:00.000Z'),
  }).handlers;
  const readinessTools = createSaga3ReadinessHandlers({
    db: () => db,
  }).handlers;
  const trace = {
    proposalSubmit: null,
    normalizationGet: null,
    normalizationSubmit: null,
    readinessGet: null,
    readinessSubmit: null,
    normalizationTaskMetadata: null,
    readinessTaskMetadata: null,
    distractor: null,
  };

  return {
    trace,
    executor: {
      kind: 'lm',
      async execute(ctx) {
        if (ctx.node.id === 'produce-proposal') {
          const intent = runtime.createIntent({
            epic_id: EPIC_ID,
            kind: DISCOVERY_INTENT_KIND,
            objective: 'Investigate the bounded product problem',
            authority_scope: {
              snapshot_ref: `process-run:${processRunId}:node:produce-proposal`,
              scope: 'saga-discovery-worker',
              allowed_tools: [
                'task_get',
                'proposal_submit',
                'worker_done',
              ],
              enforcement: 'runtime',
            },
            output_schema: DISCOVERY_WORK_INTENT_SCHEMA,
            token_budget: 0,
            retry_budget: 2,
          });
          const taskId = runtime.ensureProjectedTask({
            epicId: EPIC_ID,
            projectId: PROJECT_ID,
            intentId: intent.id,
            objective: intent.objective,
            taskKind: 'discovery.work',
            executionSkill: 'saga-discovery-worker',
            generationKey: `process-run:${processRunId}:node:produce-proposal`,
            workflowStage: 'discovery',
            executionMode: 'tracker_only',
            titlePrefix: 'Product Discovery: ',
          });
          runtime.setProjectedTask(intent.id, taskId);
          const executionId = `product-exec-${processRunId}`;
          bindLiveExecution(db, runtime, {
            intentId: intent.id,
            taskId,
            executionId,
            workerId: 'product-worker',
          });
          trace.proposalSubmit = proposalTools.proposal_submit({
            intent_id: intent.id,
            task_id: taskId,
            execution_id: executionId,
            kind: DISCOVERY_INTENT_KIND,
            schema_version: DISCOVERY_PROPOSAL_SCHEMA,
            payload: proposalPayload,
          });
          finishExecution(db, {
            intentId: intent.id,
            taskId,
            executionId,
          });
          return {
            runtimeEvent: reportedRuntimeStatus,
            receipt: executionReceipt({
              intentId: intent.id,
              taskId,
              executionId,
              runtimeStatus: reportedRuntimeStatus,
            }),
          };
        }

        if (ctx.node.id === 'normalize-semantic') {
          const bindings = ctx.input?.bindings ?? {};
          const intentId = Number(bindings.preProjectedIntentId ?? 0);
          const taskId = Number(bindings.preProjectedTaskId ?? 0);
          const controlIntentId = Number(bindings.controlIntentId ?? 0);
          const sourceSubmissionId = Number(bindings.rawSubmissionId ?? 0);
          assert.ok(intentId && taskId && controlIntentId && sourceSubmissionId);
          trace.normalizationTaskMetadata = taskMetadata(db, taskId);
          const executionId = `normalization-exec-${processRunId}`;
          bindLiveExecution(db, runtime, {
            intentId,
            taskId,
            executionId,
            workerId: 'normalization-worker',
          });
          trace.normalizationGet = normalizationTools.normalization_get({
            control_intent_id: controlIntentId,
            source_submission_id: sourceSubmissionId,
            execution_id: executionId,
          });
          const normalizedPayload = validProposal();
          const sourceFieldMap = Object.fromEntries(
            Object.keys(normalizedPayload).map(field => [field, [`$.${field}`]]),
          );
          trace.normalizationSubmit = normalizationTools.normalization_submit({
            control_intent_id: controlIntentId,
            source_submission_id: sourceSubmissionId,
            execution_id: executionId,
            schema_version: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
            payload: {
              source_submission_id: sourceSubmissionId,
              source_raw_hash: trace.normalizationGet.source_raw_hash,
              normalized_payload: normalizedPayload,
              source_field_map: sourceFieldMap,
              notes: ['Resolved the conflicting problem alias using the canonical source field.'],
            },
          });
          finishExecution(db, { intentId, taskId, executionId });
          return {
            runtimeEvent: reportedRuntimeStatus,
            receipt: executionReceipt({
              intentId,
              taskId,
              executionId,
              runtimeStatus: reportedRuntimeStatus,
            }),
          };
        }

        if (ctx.node.id === 'assess-readiness') {
          const bindings = ctx.input?.bindings ?? {};
          const intentId = Number(bindings.preProjectedIntentId ?? 0);
          const taskId = Number(bindings.preProjectedTaskId ?? 0);
          const controlIntentId = Number(bindings.controlIntentId ?? 0);
          assert.ok(intentId && taskId && controlIntentId);
          trace.readinessTaskMetadata = taskMetadata(db, taskId);
          const executionId = `readiness-exec-${processRunId}`;
          bindLiveExecution(db, runtime, {
            intentId,
            taskId,
            executionId,
            workerId: 'readiness-worker',
          });
          trace.readinessGet = readinessTools.readiness_get({
            control_intent_id: controlIntentId,
            execution_id: executionId,
          });
          trace.readinessSubmit = readinessTools.readiness_submit({
            control_intent_id: controlIntentId,
            execution_id: executionId,
            schema_version: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
            payload: validReadiness(
              trace.readinessGet.proposal_id,
              trace.readinessGet.proposal_content_hash,
            ),
          });
          finishExecution(db, { intentId, taskId, executionId });

          // This happens after the exact target assessment is accepted but
          // before resolve-readiness and settlement execute.
          if (injectDistractor) {
            trace.distractor = seedNewerDistractor(db);
          }
          return {
            runtimeEvent: reportedRuntimeStatus,
            receipt: executionReceipt({
              intentId,
              taskId,
              executionId,
              runtimeStatus: reportedRuntimeStatus,
            }),
          };
        }

        throw new Error(`unexpected LM node '${ctx.node.id}'`);
      },
    },
  };
}

function buildExecutor({ db, runtime, lmExecutor }) {
  const processRunRepo = new SqliteProcessRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);

  const handlerRegistry = new KernelHandlerRegistry();
  handlerRegistry.register(
    PROCESS_OUTCOME_EMITTER_HANDLER_ID,
    processOutcomeEmitter,
  );
  handlerRegistry.registerAll(
    discoveryHandlers(runtime),
  );

  const kernelExecutor = new KernelNodeExecutor(handlerRegistry);
  const nodeExecutors = new Map([
    ['kernel', kernelExecutor],
    ['lm', lmExecutor],
  ]);
  // v1 dead-path deletion — v2 wiring is now MANDATORY (the v1 frame/
  // completion path is deleted). The productRepo bridge falls back to NodeRun
  // rows for settlement productions not in the content-addressed product
  // store (mirrors v2-production-completion-roundtrip.test.mjs).
  const lookupProduction = db.prepare(
    `SELECT output_schema AS schema, output_ref AS ref, output_hash AS hash,
            output_bindings AS bindingsText
       FROM saga3_node_runs
      WHERE output_schema=? AND output_ref=? AND output_hash=?
        AND status='completed'
      LIMIT 1`,
  );
  const productRepo = {
    getByProductRef(ref) {
      const nr = lookupProduction.get(ref.schemaId, ref.ref, ref.digest);
      if (nr === undefined || nr.schema === null || nr.ref === null || nr.hash === null) {
        return null;
      }
      const bindings = nr.bindingsText ? JSON.parse(nr.bindingsText) : {};
      return {
        productRef: { schemaId: nr.schema, ref: nr.ref, digest: nr.hash },
        payload: { schema: nr.schema, artifactRef: nr.ref, contentHash: nr.hash, bindings },
      };
    },
  };
  const executor = new GenericFlowExecutor({
    moduleRef: discoveryProcessModule.identity,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    nodeExecutors,
    v2: { productRepo },
  });
  return {
    executor,
    processRunRepo,
    certificateRepo,
    nodeRunRepo,
    handlers: discoveryHandlers(runtime),
  };
}

function startRun(processRunRepo, idempotencyKey) {
  const inputPayload = {
    epicId: EPIC_ID,
    projectId: PROJECT_ID,
    objective: 'Investigate the bounded product problem',
  };
  const inputHash = sha256Canonical(inputPayload);
  const { record: run } = processRunRepo.start({
    moduleRef: discoveryProcessModule.identity,
    input: {
      schema: discoveryProcessModule.inputContract.id,
      payload: inputPayload,
      contentHash: inputHash,
    },
    executorKind: 'generic-flow',
    projectedStage: 'discovery',
    invocationContext: {
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      initiatedBy: 'lineage-test',
      idempotencyKey,
    },
  });
  return { run, inputPayload, inputHash };
}

async function runScenario({
  db,
  runtime,
  proposalPayload,
  idempotencyKey,
  reportedRuntimeStatus = 'completed',
}) {
  // Start the ProcessRun first so scripted generation keys and execution ids
  // can be tied to its durable identity.
  const processRunRepo = new SqliteProcessRunRepository(db);
  const started = startRun(processRunRepo, idempotencyKey);
  const scripted = createScriptedLmExecutor({
    db,
    runtime,
    processRunId: started.run.id,
    proposalPayload,
    reportedRuntimeStatus,
  });
  const built = buildExecutor({
    db,
    runtime,
    lmExecutor: scripted.executor,
  });
  const result = await built.executor.execute(discoveryProcessModule, {
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    processRunId: started.run.id,
    inputPayload: started.inputPayload,
    inputHash: started.inputHash,
    initiatedBy: 'lineage-test',
  });
  const certificateRef = result.certificate?.certificateRef ?? '';
  const certificateMatch = /^discovery-certificate:(\d+)$/.exec(certificateRef);
  assert.ok(certificateMatch, 'Discovery must reference its canonical D4 certificate');
  const certificate = db.prepare(
    'SELECT * FROM saga3_discovery_outcome_certificates WHERE id=?',
  ).get(Number(certificateMatch[1]));
  return {
    ...built,
    ...started,
    result,
    trace: scripted.trace,
    finalRun: built.processRunRepo.read(started.run.id),
    nodeRuns: built.nodeRunRepo.list(started.run.id),
    certificate,
    genericCertificate: built.certificateRepo.readByProcessRun(started.run.id),
  };
}

function requireNode(nodeRuns, nodeId) {
  const run = nodeRuns.find(candidate => candidate.nodeId === nodeId);
  assert.ok(run, `node '${nodeId}' must have executed`);
  return run;
}

function assertPinnedCertificate({
  certificate,
  genericCertificate,
  targetProposalId,
  targetAssessmentId,
  distractor,
}) {
  assert.ok(certificate, 'authoritative Discovery D4 certificate must be issued');
  assert.equal(
    genericCertificate,
    null,
    'generic runtime must reference, not duplicate, the canonical Discovery certificate',
  );
  const payload = JSON.parse(certificate.certificate_payload);
  assert.equal(payload.proposal.id, targetProposalId);
  assert.equal(payload.readiness.assessment_id, targetAssessmentId);
  assert.equal(certificate.proposal_id, targetProposalId);
  assert.equal(certificate.readiness_assessment_id, targetAssessmentId);
  assert.notEqual(payload.proposal.id, distractor.proposalId);
  assert.notEqual(payload.readiness.assessment_id, distractor.assessmentId);
}

test('deterministic D1 materializes exact Proposal from receipt and ignores newer epic rows', async () => {
  const ctx = fixture();
  try {
    const tracked = trackedRuntime();
    const scenario = await runScenario({
      db: ctx.db,
      runtime: tracked.runtime,
      proposalPayload: validProposal(),
      idempotencyKey: 'deterministic-lineage',
    });

    assert.equal(scenario.trace.proposalSubmit.status, 'submitted');
    const targetProposalId = scenario.trace.proposalSubmit.proposal_id;
    const targetProposalHash = scenario.trace.proposalSubmit.content_hash;
    const targetAssessmentId = scenario.trace.readinessSubmit.assessment_id;
    assert.ok(targetProposalId > 0);
    assert.ok(targetAssessmentId > 0);
    assert.equal(scenario.result.outcome, 'go');
    assert.equal(scenario.finalRun.status, 'completed');

    const productLm = requireNode(scenario.nodeRuns, 'produce-proposal');
    assert.equal(productLm.outputRef, null, 'LM completion is not a Proposal production');
    assert.equal(productLm.executionReceipt.kind, 'task-execution');
    assert.equal(productLm.executionReceipt.executionId, `product-exec-${scenario.run.id}`);

    const resolved = requireNode(scenario.nodeRuns, 'resolve-proposal-submission');
    assert.equal(resolved.event, 'domain.accepted');
    assert.equal(resolved.outputRef, `proposal:${targetProposalId}`);
    assert.equal(resolved.outputHash, targetProposalHash);
    assert.equal(resolved.outputBindings.proposalId, targetProposalId);

    assert.equal(
      scenario.nodeRuns.some(node => node.nodeId === 'prepare-normalization'),
      false,
      'deterministically accepted Proposal must skip D2',
    );
    assert.equal(
      ctx.db.prepare(
        `SELECT COUNT(*) AS count FROM tasks WHERE task_kind='discovery.normalize'`,
      ).get().count,
      0,
    );

    assert.equal(
      scenario.trace.readinessTaskMetadata.proposal_id,
      targetProposalId,
    );
    assert.equal(
      scenario.trace.readinessTaskMetadata.proposal_content_hash,
      targetProposalHash,
    );
    assert.ok(scenario.trace.readinessTaskMetadata.control_intent_id > 0);

    const latestProposal = ctx.db.prepare(
      `SELECT p.id
         FROM saga3_proposals p
         JOIN saga3_work_intents i ON i.id=p.intent_id
        WHERE i.epic_id=?
        ORDER BY p.id DESC LIMIT 1`,
    ).get(EPIC_ID);
    const latestAssessment = ctx.db.prepare(
      `SELECT a.id
         FROM saga3_readiness_assessments a
         JOIN saga3_readiness_control_intents c ON c.id=a.control_intent_id
        WHERE c.epic_id=? AND a.status='accepted_by_kernel'
        ORDER BY a.id DESC LIMIT 1`,
    ).get(EPIC_ID);
    assert.equal(latestProposal.id, scenario.trace.distractor.proposalId);
    assert.equal(latestAssessment.id, scenario.trace.distractor.assessmentId);

    assertPinnedCertificate({
      certificate: scenario.certificate,
      genericCertificate: scenario.genericCertificate,
      targetProposalId,
      targetAssessmentId,
      distractor: scenario.trace.distractor,
    });
    assert.deepEqual(
      tracked.legacyLookupCalls,
      [],
      'generic Discovery must not call epic-wide latest lookups',
    );
  } finally {
    cleanup(ctx.temp);
  }
});

test('semantic D2 preserves exact raw/control lineage through normalization receipt', async () => {
  const ctx = fixture();
  try {
    const tracked = trackedRuntime();
    const scenario = await runScenario({
      db: ctx.db,
      runtime: tracked.runtime,
      proposalPayload: semanticAmbiguityProposal(),
      idempotencyKey: 'semantic-lineage',
    });

    assert.equal(scenario.trace.proposalSubmit.status, 'normalization_required');
    assert.equal(scenario.trace.proposalSubmit.proposal_id, null);
    const rawSubmissionId = scenario.trace.proposalSubmit.raw_submission_id;
    const normalizedProposalId = scenario.trace.normalizationSubmit.proposal_id;
    const normalizationProposalId =
      scenario.trace.normalizationSubmit.normalization_proposal_id;
    const targetAssessmentId = scenario.trace.readinessSubmit.assessment_id;

    const rawResolve = requireNode(
      scenario.nodeRuns,
      'resolve-proposal-submission',
    );
    assert.equal(rawResolve.event, 'domain.normalization-required');
    assert.equal(rawResolve.outputRef, `raw-submission:${rawSubmissionId}`);
    assert.equal(rawResolve.outputBindings.rawSubmissionId, rawSubmissionId);

    const prepared = requireNode(scenario.nodeRuns, 'prepare-normalization');
    assert.equal(prepared.event, 'domain.prepared');
    assert.equal(
      prepared.outputBindings.rawSubmissionId,
      rawSubmissionId,
    );
    assert.ok(prepared.outputBindings.controlIntentId > 0);
    assert.ok(prepared.outputBindings.preProjectedTaskId > 0);

    assert.equal(
      scenario.trace.normalizationTaskMetadata.source_submission_id,
      rawSubmissionId,
    );
    assert.equal(
      scenario.trace.normalizationTaskMetadata.control_intent_id,
      prepared.outputBindings.controlIntentId,
    );
    assert.equal(
      scenario.trace.normalizationTaskMetadata.work_intent_id,
      prepared.outputBindings.authorityIntentId,
    );

    const normalizationLm = requireNode(
      scenario.nodeRuns,
      'normalize-semantic',
    );
    assert.equal(
      normalizationLm.outputRef,
      null,
      'normalization LM returns execution evidence, not a canonical Proposal',
    );
    assert.equal(normalizationLm.executionReceipt.kind, 'task-execution');
    assert.equal(
      normalizationLm.executionReceipt.taskId,
      prepared.outputBindings.preProjectedTaskId,
    );

    const normalizedResolve = requireNode(
      scenario.nodeRuns,
      'resolve-normalized-proposal',
    );
    assert.equal(normalizedResolve.event, 'domain.accepted');
    assert.equal(
      normalizedResolve.outputRef,
      `proposal:${normalizedProposalId}`,
    );
    assert.equal(
      normalizedResolve.outputBindings.proposalId,
      normalizedProposalId,
    );

    const rawRow = ctx.db.prepare(
      `SELECT status FROM saga3_raw_submissions WHERE id=?`,
    ).get(rawSubmissionId);
    const proposalRow = ctx.db.prepare(
      `SELECT source_submission_id,normalization_proposal_id
         FROM saga3_proposals WHERE id=?`,
    ).get(normalizedProposalId);
    assert.equal(rawRow.status, 'normalized');
    assert.equal(proposalRow.source_submission_id, rawSubmissionId);
    assert.equal(
      proposalRow.normalization_proposal_id,
      normalizationProposalId,
    );
    assert.equal(
      scenario.trace.normalizationGet.source_submission_id,
      rawSubmissionId,
    );
    assert.equal(
      scenario.trace.readinessGet.proposal_id,
      normalizedProposalId,
    );

    assert.equal(scenario.result.outcome, 'go');
    assertPinnedCertificate({
      certificate: scenario.certificate,
      genericCertificate: scenario.genericCertificate,
      targetProposalId: normalizedProposalId,
      targetAssessmentId,
      distractor: scenario.trace.distractor,
    });
    assert.deepEqual(
      tracked.legacyLookupCalls,
      [],
      'D2 resolution and settlement must not call epic-wide latest lookups',
    );
  } finally {
    cleanup(ctx.temp);
  }
});

test('committed domain products survive a later worker failure receipt', async () => {
  const ctx = fixture();
  try {
    const tracked = trackedRuntime();
    const scenario = await runScenario({
      db: ctx.db,
      runtime: tracked.runtime,
      proposalPayload: semanticAmbiguityProposal(),
      idempotencyKey: 'committed-before-worker-failure',
      reportedRuntimeStatus: 'failed',
    });

    assert.equal(scenario.result.outcome, 'go');
    assert.equal(requireNode(scenario.nodeRuns, 'produce-proposal').event, 'runtime.failed');
    assert.equal(requireNode(scenario.nodeRuns, 'resolve-proposal-submission').event, 'domain.normalization-required');
    assert.equal(requireNode(scenario.nodeRuns, 'normalize-semantic').event, 'runtime.failed');
    assert.equal(requireNode(scenario.nodeRuns, 'resolve-normalized-proposal').event, 'domain.accepted');
    assert.equal(requireNode(scenario.nodeRuns, 'assess-readiness').event, 'runtime.failed');
    assert.equal(requireNode(scenario.nodeRuns, 'resolve-readiness').event, 'domain.accepted');

    assertPinnedCertificate({
      certificate: scenario.certificate,
      genericCertificate: scenario.genericCertificate,
      targetProposalId: scenario.trace.normalizationSubmit.proposal_id,
      targetAssessmentId: scenario.trace.readinessSubmit.assessment_id,
      distractor: scenario.trace.distractor,
    });
    assert.deepEqual(tracked.legacyLookupCalls, []);
  } finally {
    cleanup(ctx.temp);
  }
});

test('missing exact lineage fails closed even when newer epic products exist', async () => {
  const ctx = fixture();
  try {
    const tracked = trackedRuntime();
    const distractor = seedNewerDistractor(ctx.db);
    assert.ok(distractor.proposalId > 0);
    assert.ok(distractor.assessmentId > 0);
    const handlers = discoveryHandlers(tracked.runtime);
    const baseContext = {
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      processRunId: 999,
      initiatedBy: 'no-fallback-test',
      frame: {
        runInput: { epicId: EPIC_ID },
        productions: {},
        receipts: {},
      },
    };

    assert.throws(
      () => handlers['discovery-prepare-readiness']({
        ...baseContext,
        node: {
          id: 'prepare-readiness',
          label: 'Prepare',
          kind: 'kernel',
          description: '',
          handler: 'discovery-prepare-readiness',
        },
        input: {
          kind: 'task-execution',
          executorKind: 'lm',
          intentId: 123,
          taskId: 456,
          executionId: 'unrelated',
          runtimeStatus: 'completed',
          replayed: false,
        },
      }),
      /exact Proposal id\/hash lineage is required/,
    );

    await assert.rejects(
      handlers['discovery-settlement-policy']({
        ...baseContext,
        node: {
          id: 'settle',
          label: 'Settle',
          kind: 'kernel',
          description: '',
          handler: 'discovery-settlement-policy',
        },
        input: null,
      }),
      /exact Proposal lineage is required/,
    );
    assert.deepEqual(
      tracked.legacyLookupCalls,
      [],
      'fail-closed handlers must not rescue missing lineage with latest-by-epic',
    );
  } finally {
    cleanup(ctx.temp);
  }
});
