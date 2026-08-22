/**
 * D7 — settlement lifecycle-classification wiring (ADR-090 / CC-IC-1).
 *
 * Thesis: the frozen lifecycle classification reaches Discovery settlement
 * ONLY through the pinned per-run read — `ctx.processRunId` → join
 * `factory_stage_runs.process_run_id` → `lifecycle_run_id` → the pinned
 * `factory_lifecycle_runs` `definition_snapshot` + `definition_hash` through
 * the typed `readDefinitionByProcessRun` port/repository — injected by
 * composition. No ambient/default `lifecycleDefinition` substitute, no
 * lifecycle module import inside Discovery, no repository construction
 * inside Discovery. A missing row or a definition-hash mismatch fails closed
 * with a typed error.
 *
 * This suite drives the REAL production-cell settlement handler over a REAL
 * better-sqlite3 temp-file DB (the REAL SqliteLifecycleRunRepository supplies
 * the pinned read) and the REAL declared injection table owned by the
 * product-build lifecycle — the same wiring `src/app/product-lifecycle-runtime.ts`
 * composes.
 *
 * Blocking mutations proven here (plan §7A / CC-IC-1):
 *   m4  — runnable-local declared without the injected synthesis/smoke
 *         entries: settlement red (LIFECYCLE_INJECTION_TABLE_MISSING).
 *   m4a — injection from an undeclared/ad-hoc table: settlement red
 *         (LIFECYCLE_INJECTION_TABLE_DIGEST_MISMATCH).
 *   m6  — a new v2 Factory Start whose settlement produces a silent null
 *         register: red — a no-obligation order carries the explicit typed
 *         no-obligations attestation; a runnable-local order carries the
 *         injected entries.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { canonicalJson, sha256Hex } = await import('../../dist/shared/canonical-json.js');
const {
  verifyOrderConstraintRegister,
} = await import('../../dist/shared/constraint-register.js');
const {
  DISCOVERY_PROPOSAL_SCHEMA,
} = await import('../../dist/modules/discovery/domain/discovery-proposal.js');
const {
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  READINESS_DIMENSIONS,
} = await import('../../dist/modules/discovery/domain/discovery-readiness-assessment.js');
const {
  createDiscoveryProductionCellKernelHandlers,
  DISCOVERY_NO_OBLIGATIONS_ATTESTATION_SCHEMA,
} = await import(
  '../../dist/modules/discovery/application/discovery-production-cell-installation.js'
);
const { SqliteLifecycleRunRepository, ensureFactoryLifecycleRunSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { productBuildLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-build-lifecycle.js'
);
const { productDeliveryLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const {
  RUNNABLE_LOCAL_CLASSIFICATION,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
} = await import('../../dist/process-modules/lifecycles/product-build-lifecycle.js');

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

/** The declared injection wiring `product-lifecycle-runtime.ts` composes. */
const RUNNABLE_LOCAL_DECLARATION = {
  table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
  tableDigest: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST,
};

const PROPOSAL_PAYLOAD_BASE = {
  problem_statement: 'the problem',
  observed_context: 'the context',
  stakeholders_or_actors: ['user'],
  assumptions: ['assumption'],
  unknowns: [],
  risks: ['risk'],
  candidate_scope: 'scope',
  evidence_refs: ['artifact:req-1'],
  recommended_outcome: 'go',
  rationale: 'rationale',
};

function readinessPayload(proposalHash) {
  const dims = {};
  for (const d of READINESS_DIMENSIONS) {
    dims[d] = { status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'] };
  }
  return {
    proposal_content_hash: proposalHash,
    overall_readiness: 'ready',
    dimension_assessments: dims,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'well grounded',
  };
}

/**
 * Seed one lifecycle: a lifecycle run pinned to the given definition plus a
 * stage run bound to the given process run id. Returns the real repository
 * read for the definition.
 */
function seedLifecycle(db, { definition, processRunId, lifecycleRunId, tamperHash = false }) {
  const snapshot = canonicalJson(definition);
  const definitionHash = sha256Hex(definition);
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
        definition_snapshot,definition_hash,project_id,epic_id,initiated_by,idempotency_key,
        input_schema,input_snapshot,input_hash,status,entry_stage_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'created',?)`,
  ).run(
    lifecycleRunId,
    definition.identity.name,
    definition.identity.version,
    `${definition.identity.name}@${definition.identity.version}`,
    definition.identity.displayName,
    definition.identity.description,
    snapshot,
    tamperHash ? 'f'.repeat(64) : definitionHash,
    1,
    10,
    'd7-fixture',
    `d7-lifecycle-${lifecycleRunId}`,
    'factory.product-delivery-input.v1',
    '{}',
    sha256({}),
    Array.isArray(definition.stages) && definition.stages[0]
      ? definition.stages[0].id
      : 'initial-discovery',
  );
  // The process run must exist before the stage run references it (FK).
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,1,10,'discovery','1.0.0','discovery@1.0.0',?,'generic-flow','x','{}',?, 'running')`,
  ).run(processRunId, `d7-process-${processRunId}`, sha256({}));
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,module_ref_key,
        binding_snapshot,binding_hash,input_schema,input_snapshot,input_hash,status,process_run_id)
     VALUES (?,?,1,'initial-discovery',1,'discovery','1.0.0','discovery@1.0.0','{}',?,
             'factory.product-delivery-input.v1','{}',?, 'created',?)`,
  ).run(
    lifecycleRunId * 10,
    lifecycleRunId,
    sha256({}),
    sha256({}),
    processRunId,
  );
  return { snapshot, definitionHash };
}

function seedSubmission(db, { id, processRunId, schema, payload }) {
  // FK chain of factory_managed_node_submissions: tasks + worker_executions.
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (?,10,'S','done','discovery.work')`,
  ).run(id);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES (:exec,:run,1,10,:task,:worker,:machine,'terminated','executing')`,
  ).run({ exec: `exec-${id}`, run: `run-${id}`, task: id, worker: `w-${id}`, machine: `m-${id}` });
  const contentHash = sha256Hex(payload);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash,submitted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
  ).run(id, processRunId, 'discovery@1.0.0', 'produce-proposal', id, id, `exec-${id}`, schema, JSON.stringify(payload), contentHash);
  return { schemaId: schema, ref: `managed-node-submission:${id}`, digest: contentHash };
}

function cellManifest(product) {
  return {
    schema: 'factory.production-cell-output-manifest.v1',
    bindings: {
      final: true,
      items: [{
        accepted: true,
        id: 'item-1',
        workKey: 'proposal',
        workplaceRef: 'workplace/1',
        candidateSetRef: 'candidate-set/1',
        execution: { intentId: 1, taskId: 1, executionRef: 'exec-1' },
        products: [product],
      }],
    },
  };
}

function makeHandlers(db, { declarations = [RUNNABLE_LOCAL_DECLARATION], required = [RUNNABLE_LOCAL_CLASSIFICATION] } = {}) {
  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);
  const issued = [];
  const handlers = createDiscoveryProductionCellKernelHandlers({
    db,
    certificates: {
      issue: command => {
        issued.push(command);
        return { record: { id: 500 + issued.length, certificateHash: command.certificateHash } };
      },
    },
    lifecycleDefinitionReader: {
      readDefinitionByProcessRun: processRunId =>
        lifecycleRunRepo.readDefinitionByProcessRun(processRunId),
    },
    lifecycleInjectionDeclarations: declarations,
    lifecycleInjectionRequiredClassifications: required,
  });
  return { handlers, issued };
}

function settle(db, { processRunId, proposalProduct, readinessProduct }) {
  const { handlers, issued } = makeHandlers(db);
  const result = handlers['discovery-settlement-policy']({
    projectId: 1,
    epicId: 10,
    processRunId,
    node: { id: 'settle-discovery' },
    input: cellManifest(readinessProduct),
    frame: { productions: { 'produce-proposal': cellManifest(proposalProduct) } },
    heartbeat: () => {},
    initiatedBy: 'd7',
  });
  return { result, issued };
}

function fixture(definition = productBuildLifecycle, { tamperHash = false } = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-d7-'));
  process.env.DB_PATH = path.join(temp, 'd7.db');
  const db = getDb();
  try {
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
    ensureFactoryLifecycleRunSchema(db);
    const lifecycle = seedLifecycle(db, { definition, processRunId: 100, lifecycleRunId: 1, tamperHash });
    return { temp, db, lifecycle };
  } catch (error) {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
    throw error;
  }
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

// ---------------------------------------------------------------------------
// The pinned read itself (the typed port/repository)
// ---------------------------------------------------------------------------

test('d7: readDefinitionByProcessRun returns the pinned definition_snapshot + definition_hash', () => {
  const { temp, db, lifecycle } = fixture();
  try {
    const repo = new SqliteLifecycleRunRepository(db);
    const read = repo.readDefinitionByProcessRun(100);
    assert.equal(read.definitionHash, lifecycle.definitionHash);
    assert.equal(read.lifecycleRunId, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(read.definition)), JSON.parse(JSON.stringify(productBuildLifecycle)));
  } finally {
    cleanup(temp);
  }
});

test('d7: a process run bound to no lifecycle row fails closed with a typed error', () => {
  const { temp, db } = fixture();
  try {
    const repo = new SqliteLifecycleRunRepository(db);
    assert.throws(
      () => repo.readDefinitionByProcessRun(9999),
      /LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_MISSING/,
    );
  } finally {
    cleanup(temp);
  }
});

test('d7: a definition-hash mismatch on the pinned row fails closed (never a substitute)', () => {
  const { temp } = fixture(productBuildLifecycle, { tamperHash: true });
  try {
    const db = getDb();
    const repo = new SqliteLifecycleRunRepository(db);
    assert.throws(
      () => repo.readDefinitionByProcessRun(100),
      /LIFECYCLE_DEFINITION_HASH_MISMATCH/,
    );
  } finally {
    cleanup(temp);
  }
});

test('d7: an unparseable pinned definition snapshot fails closed with a typed error (never a substitute)', () => {
  const { temp } = fixture();
  try {
    const db = getDb();
    db.prepare(`UPDATE factory_lifecycle_runs SET definition_snapshot='not-json' WHERE id=1`).run();
    const repo = new SqliteLifecycleRunRepository(db);
    assert.throws(
      () => repo.readDefinitionByProcessRun(100),
      /LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_INVALID.*unparseable/,
    );
  } finally {
    cleanup(temp);
  }
});

test('d7: a non-object pinned definition snapshot (JSON array) fails closed with a typed error', () => {
  const { temp } = fixture();
  try {
    const db = getDb();
    db.prepare(`UPDATE factory_lifecycle_runs SET definition_snapshot='[1,2,3]' WHERE id=1`).run();
    const repo = new SqliteLifecycleRunRepository(db);
    assert.throws(
      () => repo.readDefinitionByProcessRun(100),
      /LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_INVALID.*non-object/,
    );
  } finally {
    cleanup(temp);
  }
});

test('d7: settlement with NO pinned lifecycle row for the process run fails closed with the typed error in bindings', () => {
  const { temp, db } = fixture();
  try {
    // Process run 101 exists but is bound to no stage run / lifecycle run.
    db.prepare(
      `INSERT INTO factory_process_runs
         (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
          executor_kind,input_schema,input_snapshot,input_hash,status)
       VALUES (101,1,10,'discovery','1.0.0','discovery@1.0.0','d7-process-101','generic-flow','x','{}',?, 'running')`,
    ).run(sha256({}));
    const proposalProduct = seedSubmission(db, { id: 511, processRunId: 101, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: PROPOSAL_PAYLOAD_BASE });
    const readinessProduct = seedSubmission(db, { id: 512, processRunId: 101, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    const { result } = settle(db, { processRunId: 101, proposalProduct, readinessProduct });
    assert.equal(result.event, 'failed');
    assert.match(result.production.bindings.error, /LIFECYCLE_DEFINITION_FOR_PROCESS_RUN_MISSING/);
  } finally {
    cleanup(temp);
  }
});

test('d7: a declared table cannot be replayed twice — duplicate runnable-local declarations are a typed settlement red', () => {
  const { temp, db } = fixture();
  try {
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: PROPOSAL_PAYLOAD_BASE });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    // The MUTATION wiring: the SAME declared, digest-pinned table arrives
    // twice through composition — the injected block must not silently double.
    const { handlers } = makeHandlers(db, {
      declarations: [RUNNABLE_LOCAL_DECLARATION, RUNNABLE_LOCAL_DECLARATION],
    });
    const result = handlers['discovery-settlement-policy']({
      projectId: 1, epicId: 10, processRunId: 100,
      node: { id: 'settle-discovery' },
      input: cellManifest(readinessProduct),
      frame: { productions: { 'produce-proposal': cellManifest(proposalProduct) } },
      heartbeat: () => {}, initiatedBy: 'd7',
    });
    assert.equal(result.event, 'failed');
    assert.match(result.production.bindings.error, /LIFECYCLE_INJECTION_TABLE_DUPLICATE/);
  } finally {
    cleanup(temp);
  }
});

test('d7: the settlement DI is fail-closed — no injected reader, no handlers', () => {
  const { temp, db } = fixture();
  try {
    assert.throws(
      () => createDiscoveryProductionCellKernelHandlers({
        db,
        certificates: { issue: () => ({ record: { id: 1, certificateHash: 'x' } }) },
        lifecycleDefinitionReader: undefined,
        lifecycleInjectionDeclarations: [],
        lifecycleInjectionRequiredClassifications: [],
      }),
      /DISCOVERY_SETTLEMENT_LIFECYCLE_READER_REQUIRED/,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// Settlement under the pinned runnable-local classification
// ---------------------------------------------------------------------------

test('d7: runnable-local settlement appends the injected synthesis+ordered-smoke block after the proposal-derived block', () => {
  const { temp, db } = fixture();
  try {
    const proposal = {
      ...PROPOSAL_PAYLOAD_BASE,
      unknowns: ['the pricing algorithm is not yet chosen'],
      order_constraints: [
        { class: 'execution', text: 'docker compose up', evidence_ref: 'order.source_body' },
        { class: 'material', kind: 'quality', evidence_ref: 'order.source_body', text: 'feels fast', measurability: { state: 'measurable', interpretation_ref: 'p95 under 200ms' } },
      ],
    };
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: proposal });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });

    const { result, issued } = settle(db, { processRunId: 100, proposalProduct, readinessProduct });
    assert.ok(
      ['go', 'clarify', 'reject'].includes(result.event),
      `unexpected settlement event ${result.event}: ${result.production?.bindings?.error}`,
    );
    assert.equal(issued.length, 1);
    const payload = issued[0].payload;

    const register = payload.constraintRegister;
    assert.ok(register, 'the certificate payload must carry the built v2 register');
    assert.equal(register.schemaVersion, 'factory.order-constraint-register.v2');
    // Normative interleave order: proposal block (drafts in payload order,
    // then unknowns 1:1/positionally) FIRST, injected block APPENDED in the
    // declared table order (synthesis, then ordered-smoke) — never interleaved.
    assert.deepEqual(
      register.constraints.map(entry => [entry.id, entry.kind]),
      [
        ['ord-c-001', 'scope'],
        ['ord-c-002', 'quality'],
        ['ord-c-003', 'open-question'],
        ['ord-c-004', 'synthesis'],
        ['ord-c-005', 'ordered-smoke'],
      ],
    );
    assert.equal(register.constraints[2].text, 'the pricing algorithm is not yet chosen');
    assert.equal(register.constraints[2].evidenceRef, 'proposal.unknowns');
    assert.equal(register.constraints[3].lifecycleSynthesis.injectionTableRef, RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF);
    assert.equal(register.constraints[3].lifecycleSynthesis.classification, 'runnable-local');
    assert.equal(register.constraints[4].lifecycleSynthesis.injectionTableRef, RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF);

    // The v2 register round-trips through the repaired read-back verifier.
    const verified = verifyOrderConstraintRegister(JSON.parse(JSON.stringify(register)));
    assert.equal(verified.registerDigest, register.registerDigest);

    // The settlement record cites the pinned classification + table digest.
    const binding = payload.lifecycleBinding;
    assert.ok(binding);
    assert.ok(binding.terminalClassifications.includes('runnable-local'));
    assert.equal(binding.definitionHash, sha256Hex(productBuildLifecycle));
    assert.deepEqual(binding.injectionTableRefs, [RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF]);
    // Never a silent null: a v2 settlement carries non-null typed authority.
    assert.ok(payload.constraintRegister || payload.noObligationsAttestation);
    assert.equal(payload.noObligationsAttestation, undefined);
  } finally {
    cleanup(temp);
  }
});

test('d7 · m4: runnable-local declared without the injected entries is a typed settlement red', () => {
  const { temp, db } = fixture();
  try {
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: PROPOSAL_PAYLOAD_BASE });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    // The MUTANT wiring: the required classification is still declared, but
    // the injection table declaration was dropped (an undeclared/ad-hoc
    // composition). Settlement must fail closed — never silently skip.
    const { handlers } = makeHandlers(db, { declarations: [], required: [RUNNABLE_LOCAL_CLASSIFICATION] });
    const result = handlers['discovery-settlement-policy']({
      projectId: 1, epicId: 10, processRunId: 100,
      node: { id: 'settle-discovery' },
      input: cellManifest(readinessProduct),
      frame: { productions: { 'produce-proposal': cellManifest(proposalProduct) } },
      heartbeat: () => {}, initiatedBy: 'd7',
    });
    assert.equal(result.event, 'failed');
    assert.match(result.production.bindings.error, /LIFECYCLE_INJECTION_TABLE_MISSING/);
  } finally {
    cleanup(temp);
  }
});

test('d7 · m4a: an injection whose declared digest does not pin the table is a typed settlement red', () => {
  const { temp, db } = fixture();
  try {
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: PROPOSAL_PAYLOAD_BASE });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    // The MUTANT: an ad-hoc table (entries reordered/altered) presented under
    // the DECLARED table's digest/ref — the digest must pin what is consumed.
    const adHocTable = {
      ...RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
      entries: [
        ...RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE.entries.slice(1),
        RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE.entries[0],
      ],
    };
    const { handlers } = makeHandlers(db, {
      declarations: [{ table: adHocTable, tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF, tableDigest: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST }],
    });
    const result = handlers['discovery-settlement-policy']({
      projectId: 1, epicId: 10, processRunId: 100,
      node: { id: 'settle-discovery' },
      input: cellManifest(readinessProduct),
      frame: { productions: { 'produce-proposal': cellManifest(proposalProduct) } },
      heartbeat: () => {}, initiatedBy: 'd7',
    });
    assert.equal(result.event, 'failed');
    assert.match(result.production.bindings.error, /LIFECYCLE_INJECTION_TABLE_DIGEST_MISMATCH/);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// m6 — never a silent null register on a new v2 Factory Start
// ---------------------------------------------------------------------------

test('d7 · m6: an obligation-free order under a non-runnable-local pinned definition carries the typed no-obligations attestation', () => {
  const { temp, db } = fixture(productDeliveryLifecycle);
  try {
    const proposal = { ...PROPOSAL_PAYLOAD_BASE, unknowns: [] };
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: proposal });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    const { result, issued } = settle(db, { processRunId: 100, proposalProduct, readinessProduct });
    assert.ok(
      ['go', 'clarify', 'reject'].includes(result.event),
      `unexpected settlement event ${result.event}: ${result.production?.bindings?.error}`,
    );
    const payload = issued[0].payload;
    assert.equal(payload.constraintRegister, undefined, 'no obligations counted — no register');
    const attestation = payload.noObligationsAttestation;
    assert.ok(attestation, 'the explicit typed no-obligations attestation must be present');
    assert.equal(attestation.schemaVersion, DISCOVERY_NO_OBLIGATIONS_ATTESTATION_SCHEMA);
    assert.match(attestation.attestationDigest, /^[a-f0-9]{64}$/);
    // The attestation is digest-pinned over its own content (coherent).
    assert.equal(
      attestation.attestationDigest,
      sha256Hex({
        schemaVersion: attestation.schemaVersion,
        attestation: 'no-obligations',
        lifecycleBinding: attestation.lifecycleBinding,
      }),
    );
  } finally {
    cleanup(temp);
  }
});

test('d7 · m6: a runnable-local order with no drafts and no unknowns still builds the injected register (never a silent null)', () => {
  const { temp, db } = fixture();
  try {
    const proposal = { ...PROPOSAL_PAYLOAD_BASE, unknowns: [] };
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: proposal });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    const { issued } = settle(db, { processRunId: 100, proposalProduct, readinessProduct });
    const payload = issued[0].payload;
    assert.ok(payload.constraintRegister, 'the injected obligations are counted — a register exists');
    assert.deepEqual(
      payload.constraintRegister.constraints.map(entry => entry.kind),
      ['synthesis', 'ordered-smoke'],
    );
    assert.equal(payload.noObligationsAttestation, undefined);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// No ambient/default lifecycleDefinition substitute
// ---------------------------------------------------------------------------

test('d7: settlement consumes the PINNED classification — the ambient product-build default is never consulted', () => {
  // The pinned definition is product-DELIVERY (no runnable-local terminal).
  // Even though the composition-level default lifecycle in the engine adapter
  // is product-build, settlement must read the pinned row only: no injection,
  // attestation for an obligation-free order, and the lifecycleBinding cites
  // the DELIVERY definition hash.
  const { temp, db } = fixture(productDeliveryLifecycle);
  try {
    const proposal = { ...PROPOSAL_PAYLOAD_BASE, unknowns: [] };
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: proposal });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    const { issued } = settle(db, { processRunId: 100, proposalProduct, readinessProduct });
    const payload = issued[0].payload;
    assert.equal(payload.constraintRegister, undefined);
    const attestation = payload.noObligationsAttestation;
    assert.ok(attestation);
    const binding = attestation.lifecycleBinding;
    assert.equal(binding.definitionHash, sha256Hex(productDeliveryLifecycle));
    assert.equal(
      binding.terminalClassifications.includes('runnable-local'),
      false,
    );
    assert.equal(binding.injectionTableRefs, undefined);
  } finally {
    cleanup(temp);
  }
});

test('d7: a lifecycle-shaped JSON blob without stages fails closed (no prose re-derivation)', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-d7-'));
  process.env.DB_PATH = path.join(temp, 'd7.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
    ensureFactoryLifecycleRunSchema(db);
    seedLifecycle(db, {
      definition: { identity: { name: 'x', version: '1.0.0', displayName: 'x', description: 'x' } },
      processRunId: 100,
      lifecycleRunId: 1,
    });
    const proposalProduct = seedSubmission(db, { id: 501, processRunId: 100, schema: DISCOVERY_PROPOSAL_SCHEMA, payload: PROPOSAL_PAYLOAD_BASE });
    const readinessProduct = seedSubmission(db, { id: 502, processRunId: 100, schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA, payload: readinessPayload(proposalProduct.digest) });
    const { result } = settle(db, { processRunId: 100, proposalProduct, readinessProduct });
    assert.equal(result.event, 'failed');
    assert.match(result.production.bindings.error, /DISCOVERY_LIFECYCLE_DEFINITION_INVALID/);
  } finally {
    cleanup(temp);
  }
});
