/**
 * tests/process-modules/formalization-constraint-disposition.test.mjs
 *
 * AC-drift remedy, network 1 (reaction): the product-contract author MUST
 * dispose every constraint-register ID in the brief's metadata.
 *
 * Forensic ground truth (stage 11): the author SAW all three requirements
 * (they rode the discovery proposal payload into the spawn prompt) and
 * rewrote the order without them. The defect is "no obligation to react",
 * not "content not delivered". This gate makes the reaction mandatory:
 * register IDs minus brief dispositions must be empty, else
 * FORMALIZATION_CONSTRAINT_UNDISPOSED with one typed per-ID SubmissionGap
 * (relation: covers_constraint) through the existing recovery-feedback path.
 *
 * Retro-compatibility: no register in the case -> empty diff -> accept.
 *
 * ADR-090 (CC-IC-2) + the 2026-08-23 waiver-authority decision
 * (docs/architecture/decision-journal/2026-08-23-cc-ic2-waiver-authority.md):
 * the v2 EXACT kind/state grammar — kind `open-question` disposes
 * `resolved`+evidenceRef or `deferred`+reason+owner+unblockCriterion ONLY;
 * every other kind disposes `accepted` ONLY; `waived` is TYPED UNAVAILABLE
 * on v2 (brief metadata is worker-authored, so even a perfectly shaped
 * operator-attribution record is a worker string — reject at the gate, at
 * the settlement freeze, and NEVER subtract it from coverage). Plus exact
 * disposition-key/register-id set equality and the authored-against
 * registerDigest pin (m2d) — verified against the CERTIFICATE register (the
 * same authority the settlement resolves), with the frozen-legacy-v1 corpus
 * keeping exactly the prior green behavior (waived+reason stays lawful on
 * v1, bit-identically).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { createFormalizationContractValidator } from '../../dist/modules/formalization/application/formalization-contract-validator.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../dist/process-modules/lifecycles/product-delivery-module-contracts.js';
import {
  CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD,
  buildSolutionContractConstraintCoverage,
  checkConstraintDispositionsForRegister,
  constraintDispositionsDigest,
  verifyWarrantDispositionsBinding,
  waivedConstraintIdsForRegister,
} from '../../dist/modules/formalization/domain/formalization-schemas.js';
import { buildOrderConstraintRegister, buildOrderConstraintRegisterV2 } from '../../dist/shared/constraint-register.js';
import {
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
} from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      module_name TEXT NOT NULL,
      module_version TEXT NOT NULL,
      module_ref_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      executor_kind TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      input_snapshot TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_managed_artifact_productions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL,
      module_ref TEXT NOT NULL,
      node_id TEXT NOT NULL,
      intent_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      execution_id TEXT NOT NULL,
      artifact_id INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_status TEXT NOT NULL,
      content_hash TEXT,
      operation TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'p')`).run();
  db.prepare(`INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e')`).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (2, 1, 'solution-formalization', '1.0.0', 'solution-formalization@1.0.0',
             'k', 'generic-flow', 's', '{}', 'h', 'running')`,
  ).run();
  return db;
}

const hash = (s) => createHash('sha256').update(s).digest('hex');

function seedArtifact(db, id, type, code, metadata = {}) {
  const h = hash(`${type}-${code}-${id}`);
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
     VALUES (?, 1, 1, ?, ?, ?, 'docs/x.md', 'accepted', ?, ?, 'clean', 'file_backed', '[]', ?)`,
  ).run(id, type, code, code, h, h, JSON.stringify(metadata));
}

function seedManagedProduction(db, artifactId, type) {
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (2, 'solution-formalization@1.0.0', 'define-product-contract',
             5, 5, 'exec-test', ?, ?, 'draft', 'h', 'create')`,
  ).run(artifactId, type);
}

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
      ...(orderConstraints === undefined
        ? {}
        : { order_constraints: orderConstraints }),
    },
    initiativeSubject: 'docking slice',
    initiatedBy: 'operator',
  };
}

function seedTask(db, processNodeInput) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, metadata)
     VALUES (5, 1, 'author brief+PRD', 'in_progress', ?)`,
  ).run(JSON.stringify({ process_node_input: processNodeInput }));
}

function seedCompleteProductContract(db, briefMetadata) {
  seedArtifact(db, 1, 'brief', 'BRIEF-1', briefMetadata);
  seedArtifact(db, 2, 'PRD', 'PRD', {});
  seedArtifact(db, 3, 'FR', 'FR-1', {});
  // PRD → brief root edge (required by findContractGap product mode)
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (2, 'artifact', 1, 'derived_from')`,
  ).run();
  // FR → PRD
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (3, 'artifact', 2, 'derived_from')`,
  ).run();
  seedManagedProduction(db, 1, 'brief');
  seedManagedProduction(db, 2, 'PRD');
  seedManagedProduction(db, 3, 'FR');
}

function validator(db) {
  return createFormalizationContractValidator(
    db,
    'formalization.product-contract.v1',
    'define-product-contract',
    { product: true, constraintDispositions: true },
  );
}

const INPUT = {
  processRunId: 2,
  moduleRef: 'solution-formalization@1.0.0',
  nodeId: 'define-product-contract',
  executionId: 'exec-test',
  taskId: 5,
  epicId: 1,
  projectId: 1,
};

test('undisposed constraint ID rejects with FORMALIZATION_CONSTRAINT_UNDISPOSED and a per-ID gap', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'waived', reason: 'plain JS accepted for slice' },
      // ord-c-003 NOT disposed — the gap
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.equal(result.gaps.length, 1);
  const gap = result.gaps[0];
  assert.equal(gap.missing.relation, 'covers_constraint');
  assert.ok(gap.message.includes('ord-c-003'));
  assert.ok(gap.message.includes('Chrome client feel'));
});

test('every ID disposed (accepted or waived+reason) accepts with a receipt', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'accepted' },
      'ord-c-003': { disposition: 'waived', reason: 'operator deferred the human check' },
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
  assert.ok(result.receipt.validatedAt);
});

test('waived disposition without a reason is a gap (waiver requires reason)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'accepted' },
      'ord-c-003': { disposition: 'waived' },
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.ok(result.gaps.some(gap => gap.message.includes('ord-c-003')
    && gap.message.includes('reason')));
});

test('unknown disposition enum value is a gap', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'accepted' },
      'ord-c-003': { disposition: 'maybe' },
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
});

test('no register in the case accepts (retro-compat: empty diff is green)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(undefined));
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('case with empty order_constraints array accepts (no register)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase([]));
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('missing task metadata / missing process_node_input accepts (retro-compat)', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, metadata)
     VALUES (5, 1, 'author brief+PRD', 'in_progress', '{}')`,
  ).run();
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('register present but brief artifact absent rejects every ID', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  // No brief at all: the product contract is structurally incomplete anyway,
  // but the disposition gate must not silently pass on a missing brief.
  seedArtifact(db, 2, 'PRD', 'PRD', {});
  seedArtifact(db, 3, 'FR', 'FR-1', {});
  seedManagedProduction(db, 2, 'PRD');
  seedManagedProduction(db, 3, 'FR');
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.equal(result.gaps.length, 3);
});

test('constraint diff runs alongside the structural product gap (both reported)', () => {
  const db = freshDb();
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  // Complete product contract but no dispositions at all.
  seedCompleteProductContract(db, {});
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.equal(result.gaps.length, 3);
  assert.ok(result.gaps.every(gap => gap.missing.relation === 'covers_constraint'));
});

// ---------------------------------------------------------------------------
// ADR-090 (CC-IC-2): the v2 kind-aware disposition grammar, the certificate
// register authority, the authored-against registerDigest pin, and the
// deterministic freeze digests. The blocking mutations of the packet live
// here: m2, m2a, m2b, m2c (single + en masse), m2d.
// ---------------------------------------------------------------------------

/** Build the golden-corpus-shaped v2 register: unknowns + declared injections. */
function buildV2Register() {
  return buildOrderConstraintRegisterV2({
    unknowns: ['Which dynamic pricing algorithm applies?'],
    injections: [{
      table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
      tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
    }],
  });
}

/**
 * Seed the certificate-backed v2 corpus: the certificate row carries the
 * built v2 register; the case pins the certificate by ref + content hash and
 * carries NO explicit binding (the certificate is the sole supplier — the
 * certificate-first authority under test). `tamperedRowHash` stores a hash on
 * the ROW that diverges from the case pin (the m2/m6 authority-divergence
 * shape: the gate must fail closed, never silently diff a rebuilt register).
 */
function seedV2Corpus(db, { register = buildV2Register(), tamperedRowHash } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_outcome_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      certificate_payload TEXT,
      certificate_hash TEXT
    );
  `);
  const payload = { schemaVersion: 'factory.discovery-certificate.v1', constraintRegister: register };
  const pinnedHash = hash(JSON.stringify(payload));
  db.prepare(
    `INSERT INTO factory_process_outcome_certificates (id, certificate_payload, certificate_hash)
     VALUES (7, ?, ?)`,
  ).run(JSON.stringify(payload), tamperedRowHash ?? pinnedHash);
  const v2Case = {
    schemaVersion: FORMALIZATION_CASE_SCHEMA,
    discoveryEpicId: 1,
    formalizationEpicId: 1,
    discoveryCertificateRef: 'certificate:7',
    discoveryCertificateHash: pinnedHash,
    discoveryOutcome: 'go',
    discoveryProposalRef: 'proposal:1',
    discoveryProposalHash: 'b'.repeat(64),
    discoveryProposalPayload: {
      problem_statement: 'p',
      observed_context: 'o',
      stakeholders_or_actors: ['a'],
      assumptions: [],
      unknowns: ['Which dynamic pricing algorithm applies?'],
      risks: [],
      candidate_scope: 's',
      evidence_refs: ['e'],
      recommended_outcome: 'go',
      rationale: 'r',
    },
    initiativeSubject: 'docking slice',
    initiatedBy: 'operator',
  };
  seedTask(db, v2Case);
  return { register, caseValue: v2Case };
}

/**
 * The lawful v2 disposition set: open-question resolved with AUTHENTIC
 * evidence (the Discovery readiness assessment's unknowns_manageability
 * dimension — the product that adjudicated the unknown in this corpus),
 * non-open-question entries accepted. No waiver exists on v2.
 */
function lawfulV2Dispositions(register) {
  const dispositions = {};
  for (const entry of register.constraints) {
    dispositions[entry.id] = entry.kind === 'open-question'
      ? {
        disposition: 'resolved',
        evidenceRef: 'factory.discovery-readiness-assessment.v2:unknowns_manageability',
      }
      : { disposition: 'accepted' };
  }
  return dispositions;
}

/**
 * A PERFECTLY SHAPED fake operator waiver — every field the first CC-IC-2
 * implementation's attribution parser demanded, plausible strings. The named
 * counterexample of the 2026-08-23 waiver-authority decision: brief metadata
 * is worker-authored by construction, so this record carries zero operator
 * authority. It must be red at the gate and must NEVER subtract.
 */
const PERFECTLY_SHAPED_FAKE_OPERATOR_WAIVER = {
  disposition: 'waived',
  waiver: {
    kind: 'operator-waiver',
    operator: 'platform-operator',
    reason: 'operator reviewed and waived this obligation',
    provenanceRef: 'operator-decision-ledger:42',
  },
};

test('CC-IC-2 green: v2 register fully disposed in the kind grammar with the digest pin accepts', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  seedCompleteProductContract(db, {
    constraint_dispositions: lawfulV2Dispositions(register),
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
  assert.ok(result.receipt.validatedAt);
});

test('CC-IC-2 m2: an undisposed open-question entry is a per-ID red with grammar guidance', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  const dispositions = lawfulV2Dispositions(register);
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  delete dispositions[openQuestionId];
  seedCompleteProductContract(db, {
    constraint_dispositions: dispositions,
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  const gap = result.gaps.find(g => g.artifactCode === openQuestionId);
  assert.ok(gap, `gap names the undisposed entry ${openQuestionId}`);
  assert.equal(gap.missing.relation, 'covers_constraint');
  assert.ok(gap.message.includes(openQuestionId));
  assert.ok(gap.message.includes('open-question'));
  assert.ok(gap.message.includes('resolved'));
  assert.ok(gap.message.includes('deferred'));
});

test('CC-IC-2 m2a: a deferral without owner/unblockCriterion is red', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  const dispositions = lawfulV2Dispositions(register);
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  dispositions[openQuestionId] = { disposition: 'deferred', reason: 'later' };
  seedCompleteProductContract(db, {
    constraint_dispositions: dispositions,
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  const gap = result.gaps.find(g => g.artifactCode === openQuestionId);
  assert.ok(gap, 'gap names the incomplete deferral');
  assert.ok(gap.message.includes('DEFERRED_INCOMPLETE'));
  assert.ok(gap.message.includes('owner'));
  assert.ok(gap.message.includes('unblockCriterion'));
});

test('CC-IC-2 m2b: resolved without evidenceRef is red', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  const dispositions = lawfulV2Dispositions(register);
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  dispositions[openQuestionId] = { disposition: 'resolved' };
  seedCompleteProductContract(db, {
    constraint_dispositions: dispositions,
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  const gap = result.gaps.find(g => g.artifactCode === openQuestionId);
  assert.ok(gap, 'gap names the evidence-less resolution');
  assert.ok(gap.message.includes('RESOLVED_EVIDENCE_REF_REQUIRED'));
});

test('CC-IC-2 m2c: a v1-shaped author waiver on a v2 entry is red (WAIVER_UNAVAILABLE)', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  const dispositions = lawfulV2Dispositions(register);
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  // The v1-shaped author waiver (disposition+reason, no attribution record)
  // — worker-authored, never a v2 discharge.
  dispositions[openQuestionId] = {
    disposition: 'waived',
    reason: 'the author decided the pricing question does not matter',
  };
  seedCompleteProductContract(db, {
    constraint_dispositions: dispositions,
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  const gap = result.gaps.find(g => g.artifactCode === openQuestionId);
  assert.ok(gap, 'gap names the author-attributed waiver');
  assert.ok(gap.message.includes('WAIVER_UNAVAILABLE'));
});

test('CC-IC-2 m2c (the Option A hole): a PERFECTLY SHAPED fake operator waiver is red', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  const dispositions = lawfulV2Dispositions(register);
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  // The named counterexample: every attribution field perfectly shaped, all
  // strings plausible — and still worker-authored brief metadata. No
  // operator-owned channel exists to read trust from, so shape proves
  // nothing: the state itself is typed unavailable.
  dispositions[openQuestionId] = PERFECTLY_SHAPED_FAKE_OPERATOR_WAIVER;
  seedCompleteProductContract(db, {
    constraint_dispositions: dispositions,
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  const gap = result.gaps.find(g => g.artifactCode === openQuestionId);
  assert.ok(gap, 'gap names the forged operator waiver');
  assert.ok(gap.message.includes('WAIVER_UNAVAILABLE'));
});

test('CC-IC-2 m2c (en masse): waiving EVERY entry in one act is the same per-entry red repeated', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  const dispositions = {};
  for (const entry of register.constraints) {
    dispositions[entry.id] = {
      disposition: 'waived',
      reason: 'author waives everything at once',
    };
  }
  seedCompleteProductContract(db, {
    constraint_dispositions: dispositions,
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  // No undefined "mass waiver" concept: every entry carries the SAME typed
  // per-entry red — the count equals the register size, never one summary.
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.equal(result.gaps.length, register.constraints.length);
  assert.ok(result.gaps.every(gap => gap.message.includes('WAIVER_UNAVAILABLE')));
});

test('CC-IC-2 m2d: a disposition set with NO registerDigest pin is a set-level red', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  seedCompleteProductContract(db, {
    constraint_dispositions: lawfulV2Dispositions(register),
    // pin deliberately omitted
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID');
  assert.ok(result.gaps.some(gap => gap.message.includes('REGISTER_DIGEST_PIN_MISSING')));
  assert.ok(result.gaps.some(gap => gap.message.includes(CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD)));
});

test('CC-IC-2 m2d: dispositions pinned to a DIFFERENT register digest are red (positional ord-c reuse)', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  seedCompleteProductContract(db, {
    constraint_dispositions: lawfulV2Dispositions(register),
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: 'f'.repeat(64),
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID');
  assert.ok(result.gaps.some(gap => gap.message.includes('REGISTER_DIGEST_PIN_MISMATCH')));
});

test('CC-IC-2: an EXTRA disposition key (a different register\'s id) is a set-level red', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  const dispositions = lawfulV2Dispositions(register);
  dispositions['ord-c-999'] = { disposition: 'accepted' };
  seedCompleteProductContract(db, {
    constraint_dispositions: dispositions,
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID');
  assert.ok(result.gaps.some(gap => gap.message.includes('ID_SET_MISMATCH')));
  assert.ok(result.gaps.some(gap => gap.message.includes('ord-c-999')));
});

test('CC-IC-2: exact kind/state grammar — accepted on open-question and resolved/deferred on other kinds are red', () => {
  // accepted on an open-question: a rubber stamp — the question is an
  // obligation that must be resolved or owned-deferred, never 'accepted'.
  const acceptedOnOpenQuestion = (() => {
    const db = freshDb();
    const { register } = seedV2Corpus(db);
    const dispositions = lawfulV2Dispositions(register);
    const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
    dispositions[openQuestionId] = { disposition: 'accepted' };
    seedCompleteProductContract(db, {
      constraint_dispositions: dispositions,
      [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
    });
    return validator(db).validate(INPUT);
  })();
  assert.equal(acceptedOnOpenQuestion.accepted, false);
  assert.ok(
    acceptedOnOpenQuestion.gaps.some(gap => gap.message.includes('STATE_INVALID_FOR_KIND')),
    'accepted-on-open-question is a STATE_INVALID_FOR_KIND red',
  );

  // resolved on a non-open-question (the injected synthesis entry): the
  // clause grammar defines accepted ONLY — resolved is a state the clause
  // never defined.
  const resolvedOnSynthesis = (() => {
    const db = freshDb();
    const { register } = seedV2Corpus(db);
    const dispositions = lawfulV2Dispositions(register);
    const synthesisId = register.constraints.find(e => e.kind === 'synthesis').id;
    dispositions[synthesisId] = {
      disposition: 'resolved',
      evidenceRef: 'factory.discovery-readiness-assessment.v2:unknowns_manageability',
    };
    seedCompleteProductContract(db, {
      constraint_dispositions: dispositions,
      [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
    });
    return validator(db).validate(INPUT);
  })();
  assert.equal(resolvedOnSynthesis.accepted, false);
  assert.ok(
    resolvedOnSynthesis.gaps.some(gap => gap.message.includes('STATE_INVALID_FOR_KIND')),
    'resolved-on-synthesis is a STATE_INVALID_FOR_KIND red',
  );

  // deferred on a non-open-question (the ordered-smoke entry): same rule.
  const deferredOnOrderedSmoke = (() => {
    const db = freshDb();
    const { register } = seedV2Corpus(db);
    const dispositions = lawfulV2Dispositions(register);
    const smokeId = register.constraints.find(e => e.kind === 'ordered-smoke').id;
    dispositions[smokeId] = {
      disposition: 'deferred', reason: 'r', owner: 'o', unblockCriterion: 'u',
    };
    seedCompleteProductContract(db, {
      constraint_dispositions: dispositions,
      [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
    });
    return validator(db).validate(INPUT);
  })();
  assert.equal(deferredOnOrderedSmoke.accepted, false);
  assert.ok(
    deferredOnOrderedSmoke.gaps.some(gap => gap.message.includes('STATE_INVALID_FOR_KIND')),
    'deferred-on-ordered-smoke is a STATE_INVALID_FOR_KIND red',
  );
});

test('CC-IC-2: unknown disposition state, unknown field and snake_case alias are per-entry reds', () => {
  const unknownState = (() => {
    const db = freshDb();
    const { register } = seedV2Corpus(db);
    const dispositions = lawfulV2Dispositions(register);
    const id = register.constraints[0].id;
    dispositions[id] = { disposition: 'maybe' };
    seedCompleteProductContract(db, {
      constraint_dispositions: dispositions,
      [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
    });
    return validator(db).validate(INPUT);
  })();
  assert.equal(unknownState.accepted, false);
  assert.ok(unknownState.gaps.some(gap => gap.message.includes('STATE_INVALID')));

  const unknownField = (() => {
    const db = freshDb();
    const { register } = seedV2Corpus(db);
    const dispositions = lawfulV2Dispositions(register);
    // a non-open-question entry: `accepted` is its lawful state, so the
    // extra field is the defect the field check owns.
    const synthesisId = register.constraints.find(e => e.kind === 'synthesis').id;
    dispositions[synthesisId] = { disposition: 'accepted', extra: 'field' };
    seedCompleteProductContract(db, {
      constraint_dispositions: dispositions,
      [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
    });
    return validator(db).validate(INPUT);
  })();
  assert.equal(unknownField.accepted, false);
  assert.ok(unknownField.gaps.some(gap => gap.message.includes('FIELD_REJECTED')));

  const snakeCase = (() => {
    const db = freshDb();
    const { register } = seedV2Corpus(db);
    const dispositions = lawfulV2Dispositions(register);
    const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
    dispositions[openQuestionId] = { disposition: 'resolved', evidence_ref: 'evidence:x' };
    seedCompleteProductContract(db, {
      constraint_dispositions: dispositions,
      [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
    });
    return validator(db).validate(INPUT);
  })();
  assert.equal(snakeCase.accepted, false);
  assert.ok(snakeCase.gaps.some(gap => gap.message.includes('ALIAS_REJECTED')));
});

test('CC-IC-2: a certificate that diverges from the case pin is a typed red (never a silent rebuild diff)', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db, { tamperedRowHash: '0'.repeat(64) });
  seedCompleteProductContract(db, {
    constraint_dispositions: lawfulV2Dispositions(register),
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID');
  assert.ok(result.gaps.some(gap => gap.message.includes('hashes')));
});

test('CC-IC-2 fail-closed review: certificate TABLE exists but pinned ROW missing is a typed red', () => {
  const db = freshDb();
  const { register } = seedV2Corpus(db);
  // The case pins certificate:7; delete the row the ref names — the pinned
  // authority no longer resolves, and the gate must never diff against an
  // unverifiable rebuild.
  db.prepare('DELETE FROM factory_process_outcome_certificates WHERE id=7').run();
  seedCompleteProductContract(db, {
    constraint_dispositions: lawfulV2Dispositions(register),
    [CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD]: register.registerDigest,
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORMALIZATION_CONSTRAINT_DISPOSITIONS_INVALID');
  assert.ok(result.gaps.some(gap => gap.message.includes('certificate:7')
    && gap.message.includes('does not resolve')));
});

test('CC-IC-2 fail-closed review: NO certificate table (legacy host) keeps the frozen legacy fallback green', () => {
  // The documented frozen-legacy exception: v1 fixtures seed certificate-
  // shaped refs on hosts whose schema never created the certificate table
  // (tests/process-modules/formalization-constraint-coverage.test.mjs and
  // peers). A missing TABLE is indistinguishable from a legacy host; the
  // deterministic v1 rebuild stays the supplier, bit-identically.
  const db = freshDb();
  // freshDb creates NO factory_process_outcome_certificates table — the
  // certificate:1 ref below cannot resolve a row, yet the v1 gate stays
  // green exactly as before CC-IC-2.
  seedTask(db, formalizationCase(ORDER_CONSTRAINTS));
  seedCompleteProductContract(db, {
    constraint_dispositions: {
      'ord-c-001': { disposition: 'accepted' },
      'ord-c-002': { disposition: 'accepted' },
      'ord-c-003': { disposition: 'waived', reason: 'legacy reasoned waiver' },
    },
  });
  const result = validator(db).validate(INPUT);
  assert.equal(result.accepted, true);
});

test('CC-IC-2: the settlement freeze rejects a v2 waived record (checkConstraintDispositionsForRegister)', () => {
  const register = buildV2Register();
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  const dispositions = lawfulV2Dispositions(register);
  dispositions[openQuestionId] = PERFECTLY_SHAPED_FAKE_OPERATOR_WAIVER;
  // The exact check the settlement freeze runs (no pin there — the kernel
  // port carries the map only): the forged waiver must be red at the freeze
  // too, so it can never ride the warrant into an immutable certificate.
  const checked = checkConstraintDispositionsForRegister({
    register,
    dispositions,
  });
  assert.ok(checked.gaps.length > 0, 'the freeze rejects the forged waiver');
  const waiverGap = checked.gaps.find(gap => gap.targetId === openQuestionId);
  assert.ok(waiverGap, 'the gap names the forged entry');
  assert.ok(waiverGap.reason.includes('WAIVER_UNAVAILABLE'));
});

test('CC-IC-2: honest coverage arithmetic — NOTHING subtracts on v2 (resolved/deferred are states, waivers are unavailable)', () => {
  const register = buildV2Register();
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  // resolved: stays in the required set
  assert.deepEqual(
    waivedConstraintIdsForRegister(register, {
      [openQuestionId]: { disposition: 'resolved', evidenceRef: 'e' },
    }),
    [],
  );
  // deferred with the full triple: STILL stays in the required set
  assert.deepEqual(
    waivedConstraintIdsForRegister(register, {
      [openQuestionId]: {
        disposition: 'deferred', reason: 'r', owner: 'o', unblockCriterion: 'u',
      },
    }),
    [],
  );
  // author-attributed waiver (v1 shape): never subtracts on v2
  assert.deepEqual(
    waivedConstraintIdsForRegister(register, {
      [openQuestionId]: { disposition: 'waived', reason: 'author says fine' },
    }),
    [],
  );
  // the perfectly shaped fake operator waiver: STILL never subtracts — the
  // Option A hole closure. Shape is not authority.
  assert.deepEqual(
    waivedConstraintIdsForRegister(register, {
      [openQuestionId]: PERFECTLY_SHAPED_FAKE_OPERATOR_WAIVER,
    }),
    [],
  );
  // wholesale: every entry waived with perfect operator strings subtracts
  // NOTHING (and is per-entry red at the gate above).
  const allForged = {};
  for (const entry of register.constraints) {
    allForged[entry.id] = PERFECTLY_SHAPED_FAKE_OPERATOR_WAIVER;
  }
  assert.deepEqual(waivedConstraintIdsForRegister(register, allForged), []);
});

test('CC-IC-2: v1 waiver arithmetic keeps the frozen legacy rule (waived+reason subtracts)', () => {
  // The v1 legacy predicate stays exported and unchanged: reasoned waivers
  // subtract on v1 registers (frozen behavior), through the same per-schema
  // dispatch used by the coverage readers.
  const legacyDispositions = {
    'ord-c-001': { disposition: 'accepted' },
    'ord-c-002': { disposition: 'waived', reason: 'legacy reasoned waiver' },
    'ord-c-003': { disposition: 'waived', reason: '' },
  };
  const v1Register = buildOrderConstraintRegister([
    { class: 'execution', text: 'a', evidence_ref: 'order.source_body' },
    { class: 'material', text: 'b', evidence_ref: 'order.source_body' },
    { class: 'human', text: 'c', evidence_ref: 'order.source_body' },
  ]);
  assert.ok(v1Register, 'v1 register builds');
  assert.deepEqual(
    waivedConstraintIdsForRegister(v1Register, legacyDispositions),
    ['ord-c-002'],
  );
});

test('CC-IC-2: the freeze coverage block subtracts NOTHING on v2 (waivedIds always empty)', () => {
  const register = buildV2Register();
  const openQuestionId = register.constraints.find(e => e.kind === 'open-question').id;
  const binding = {
    constraintRegisterRef: 'ref',
    constraintRegisterDigest: register.registerDigest,
    constraintRegister: register,
  };
  const resolved = buildSolutionContractConstraintCoverage(binding, {
    [openQuestionId]: { disposition: 'resolved', evidenceRef: 'evidence:1' },
  });
  assert.deepEqual(resolved.waivedIds, []);
  // even a perfectly shaped forged operator waiver freezes an EMPTY
  // waivedIds — the fake never reaches the warrant/Development handoff.
  const forged = buildSolutionContractConstraintCoverage(binding, {
    [openQuestionId]: PERFECTLY_SHAPED_FAKE_OPERATOR_WAIVER,
  });
  assert.deepEqual(forged.waivedIds, []);
});

test('CC-IC-2: dispositionsDigest is deterministic over authoring/read-back key order', () => {
  const a = { 'ord-c-001': { disposition: 'accepted' }, 'ord-c-002': { disposition: 'accepted' } };
  const b = { 'ord-c-002': { disposition: 'accepted' }, 'ord-c-001': { disposition: 'accepted' } };
  assert.equal(constraintDispositionsDigest(a), constraintDispositionsDigest(b));
  assert.equal(constraintDispositionsDigest(undefined), constraintDispositionsDigest(null));
  const changed = {
    'ord-c-001': { disposition: 'accepted' },
    'ord-c-002': {
      disposition: 'deferred', reason: 'r', owner: 'o', unblockCriterion: 'u',
    },
  };
  assert.notEqual(constraintDispositionsDigest(a), constraintDispositionsDigest(changed));
});

test('CC-IC-2: warrant dispositions binding — drift between the frozen map and its digest is a typed red', () => {
  const dispositions = lawfulV2Dispositions(buildV2Register());
  const digest = constraintDispositionsDigest(dispositions);
  verifyWarrantDispositionsBinding({
    constraintRegisterDigest: 'a'.repeat(64),
    dispositionsDigest: digest,
    dispositions,
  });
  assert.throws(
    () => verifyWarrantDispositionsBinding({
      constraintRegisterDigest: 'a'.repeat(64),
      dispositionsDigest: 'b'.repeat(64),
      dispositions,
    }),
    /WARRANT_DISPOSITIONS_DIGEST_DRIFT/,
  );
  assert.throws(
    () => verifyWarrantDispositionsBinding({
      constraintRegisterDigest: 'not-hex',
      dispositionsDigest: digest,
      dispositions,
    }),
    /WARRANT_DISPOSITIONS_BINDING_INVALID/,
  );
});
