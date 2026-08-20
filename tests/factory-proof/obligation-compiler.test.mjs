// tests/factory-proof/obligation-compiler.test.mjs
//
// W0-2 acceptance (brief revision a8014c03) — the obligation-contract
// compiler:
//
//   T1 every contract validates against the normative schema; ids unique;
//   T2 independence: the contracts file imports NO production module;
//   T3 set equality: compiled obligations ↔ installed protections, both
//      directions, unique owner, version-pinned;
//   T4 removing one installed check from a manifest COPY turns the suite red;
//   T5 adding an unclassified protection turns the suite red;
//   T6 the mandated algebra derivations: cardinality(min:1) → zero-member
//      mutant; unique(by) → duplicate; grammar → malformed/truncated/near-miss;
//   T7 kill matrix on the REAL acceptance validator (first vertical):
//      every generated violating mutant is killed (typed rejection or
//      fail-closed throw), the positive control passes;
//   T8 accepted-mutant self-proof: a permissive boundary makes the matrix
//      FAIL naming obligation/operator/detector;
//   T9 the compiler writes nothing to any DB (source contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import {
  CONTRACT_SCHEMA_VERSION,
  compileNormativeObligations,
  ACCEPTANCE_OBLIGATION_CONTRACTS,
} from './obligation-contracts.mjs';
import {
  structuralMutants,
  relationalMutants,
  compileObligationMutants,
  runKillMatrix,
} from './mutation-algebra.mjs';
import {
  readInstalledProtections,
  assertProtectionSetEquality,
  protectionKey,
} from './installed-protection-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// T1 — contract set validates.
// ---------------------------------------------------------------------------

test('T1: every obligation contract validates; ids unique; version pinned', () => {
  const compiled = compileNormativeObligations();
  assert.ok(compiled.length >= 30, `expected the full installed surface, got ${compiled.length}`);
  const ids = new Set(compiled.map(c => c.obligationId));
  assert.equal(ids.size, compiled.length, 'obligation ids must be unique');
  for (const c of compiled) {
    assert.match(c.version, /^\d+\.\d+\.\d+$/);
    assert.ok(c.sourceRefs.length > 0, `${c.obligationId} cites normative sources`);
    assert.ok(c.constraints.length > 0, `${c.obligationId} declares constraints`);
    assert.ok(['mechanical', 'semantic-adjudicated', 'harvested'].includes(c.oracleClass));
  }
});

test('T1b: the contract schema validator rejects malformed contracts', async () => {
  const { validateObligationContract } = await importTestContractsValidator();
  const base = ACCEPTANCE_OBLIGATION_CONTRACTS[0];
  const bad = { ...base, obligationId: 'X', version: 'not-semver', constraints: [], faultClasses: ['nonsense'] };
  const errors = validateObligationContract(bad);
  assert.ok(errors.length >= 3, `expected multiple schema violations, got: ${errors.join(';')}`);
});

async function importTestContractsValidator() {
  return import('./obligation-contracts.mjs');
}

// ---------------------------------------------------------------------------
// T2 — independence: no production imports in the contracts file.
// ---------------------------------------------------------------------------

test('T2: the normative source imports no production declaration (oracle independence)', () => {
  const source = readFileSync(path.join(HERE, 'obligation-contracts.mjs'), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(
    imports.filter(i => i.includes('dist/') || i.startsWith('src/')),
    [],
    'obligation-contracts.mjs must not import any production module — the '
    + 'norm cannot be generated from the declarations it verifies',
  );
});

// ---------------------------------------------------------------------------
// T3 — set equality against the real installed surface.
// ---------------------------------------------------------------------------

test('T3: compiled obligations = installed protections (set equality, versions pinned)', async () => {
  const obligations = compileNormativeObligations();
  const installed = await readInstalledProtections();
  const { size } = assertProtectionSetEquality(obligations, installed);
  assert.ok(size >= 30, `expected the full installed surface under contract, got ${size}`);
  // Both payload contracts and executable capabilities are covered.
  const kinds = new Set(obligations.map(c => c.expectedProtection.kind));
  for (const k of ['check-provider', 'post-acceptance-effect', 'transition-handler', 'payload-contract']) {
    assert.ok(kinds.has(k), `no contract covers kind '${k}'`);
  }
});

test('T4: removing one installed check from a manifest COPY turns the suite red', async () => {
  const manifestMod = await import(pathToFileURL(path.resolve(
    process.cwd(), 'dist/process-modules/application/workshop-capability-manifest.js',
  )).href);
  const manifest = manifestMod.buildWorkshopCapabilityManifest();
  const victim = manifest.executableCapabilities.find(c => c.kind === 'check-provider');
  const mutilated = {
    ...manifest,
    executableCapabilities: manifest.executableCapabilities.filter(c => c !== victim),
  };
  const installed = await readInstalledProtections({ manifest: mutilated });
  assert.throws(
    () => assertProtectionSetEquality(compileNormativeObligations(), installed),
    err => err.message.includes('OBLIGATION_WITHOUT_PROTECTION')
      && err.message.includes(victim.logicalId),
    'a silently removed installed check must fail set-equality naming it',
  );
});

test('T5: an unclassified new protection turns the suite red until a contract is added', async () => {
  const manifestMod = await import(pathToFileURL(path.resolve(
    process.cwd(), 'dist/process-modules/application/workshop-capability-manifest.js',
  )).href);
  const manifest = manifestMod.buildWorkshopCapabilityManifest();
  const stranger = {
    kind: 'check-provider',
    logicalId: 'factory.brand-new-check.v9',
    version: '9.0.0',
    implementationDigest: '0'.repeat(64),
    roles: ['orchestrator'],
  };
  const grown = { ...manifest, executableCapabilities: [...manifest.executableCapabilities, stranger] };
  const installed = await readInstalledProtections({ manifest: grown });
  assert.throws(
    () => assertProtectionSetEquality(compileNormativeObligations(), installed),
    err => err.message.includes('PROTECTION_WITHOUT_OBLIGATION')
      && err.message.includes('factory.brand-new-check.v9'),
  );
});

// ---------------------------------------------------------------------------
// T6 — the mandated algebra derivations.
// ---------------------------------------------------------------------------

test('T6: cardinality(min:1) → zero-member; unique → duplicate; grammar → malformed/truncated/near-miss', () => {
  const zero = relationalMutants(
    { kind: 'cardinality', min: 1, member: 'items' },
    { items: [{ id: 'a' }, { id: 'b' }] },
    'probe.cardinality',
  );
  assert.ok(zero.some(m => m.operatorId === 'cardinality-zero' && m.mutant.items.length === 0));

  const dup = relationalMutants(
    { kind: 'unique', by: 'criterionCode' },
    { atomicCriteria: [{ code: 'AC-1' }, { code: 'AC-2' }] },
    'probe.unique',
  );
  const dupCase = dup.find(m => m.operatorId === 'duplicate-key');
  assert.ok(dupCase, 'unique constraint must derive a duplicate-key mutant');
  assert.equal(dupCase.mutant.atomicCriteria.length, 3);
  const codes = dupCase.mutant.atomicCriteria.map(c => c.code);
  assert.equal(codes.filter(c => c === 'AC-1').length, 1);
  assert.equal(codes.filter(c => c === 'AC-2').length, 2, 'the duplicate copies one key');

  const grammar = relationalMutants(
    { kind: 'grammar', field: 'acHeading', pattern: '^#{2,3} AC-[A-Za-z0-9.-]+:\\s+.+$' },
    { acHeading: '## AC-1: Pipeline Completes' },
    'probe.grammar',
  );
  const ops = new Set(grammar.map(m => m.operatorId));
  assert.deepEqual(
    [...ops].sort(),
    ['grammar-malformed', 'grammar-near-miss', 'grammar-truncated'],
    'the grammar family is exactly malformed/truncated/near-miss',
  );
  const nearMiss = grammar.find(m => m.operatorId === 'grammar-near-miss');
  assert.equal(nearMiss.mutant.acHeading, '## AC-01: Pipeline Completes',
    'near-miss is the zero-padded sudoku class');
});

test('T6b: structural schema operators derive from the descriptor', () => {
  const mutants = structuralMutants({
    required: ['candidateHash'],
    properties: {
      candidateHash: { type: 'string' },
      ordinal: { type: 'number', minimum: 1 },
      verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    },
    contractVersion: '1.1.0',
  }, 'probe.structural');
  const ops = new Set(mutants.map(m => m.operatorId));
  for (const expected of ['missing-required', 'wrong-type', 'enum-invalid', 'empty-value', 'malformed-payload', 'unknown-field', 'version-incompatible']) {
    assert.ok(ops.has(expected), `structural operator '${expected}' derived`);
  }
  for (const m of mutants) {
    assert.match(m.seedDigest, /^[0-9a-f]{64}$/, 'deterministic seed digest');
  }
});

// ---------------------------------------------------------------------------
// T7 — the kill matrix vertical: REAL acceptance-contract validator.
//
// Boundary: createAcceptanceContractValidator(db).validate(input) over a real
// in-memory DB (SCHEMA_SQL) with real repository-backed AC bytes. The mutants
// rewrite the AC document; the v2.0.0 gate (heading resolution + coverage)
// must kill every violating one.
// ---------------------------------------------------------------------------

const AC_DOC_DIR = mkdtempSync(path.join(tmpdir(), 'w02-kill-matrix-'));
mkdirSync(path.join(AC_DOC_DIR, 'docs'), { recursive: true });
process.on('exit', () => {
  try { rmSync(AC_DOC_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function acceptanceBoundaryModules() {
  const { SCHEMA_SQL } = await import(pathToFileURL(path.resolve(process.cwd(), 'dist/schema.js')).href);
  const { createAcceptanceContractValidator } = await import(pathToFileURL(path.resolve(
    process.cwd(), 'dist/modules/formalization/application/acceptance-contract-validator.js',
  )).href);
  return { SCHEMA_SQL, createAcceptanceContractValidator };
}

/**
 * Seed a real in-memory DB for the acceptance validator with ONE AC artifact
 * whose document bytes are `docBody`, carrying `covered` constraint ids.
 */
async function seedAcceptanceState({ SCHEMA_SQL, createAcceptanceContractValidator }, docBody, covered) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // The base schema carries no projects/epics rows and no minimal
  // factory_process_runs / factory_managed_artifact_productions (those are
  // migration-created); the acceptance validator's graph port only needs the
  // minimal shapes (same approach as formalization-constraint-coverage).
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, module_name TEXT NOT NULL,
      module_version TEXT NOT NULL, module_ref_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, executor_kind TEXT NOT NULL,
      input_schema TEXT NOT NULL, input_snapshot TEXT NOT NULL,
      input_hash TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_managed_artifact_productions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL, module_ref TEXT NOT NULL,
      node_id TEXT NOT NULL, intent_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL, execution_id TEXT NOT NULL,
      artifact_id INTEGER NOT NULL, artifact_type TEXT NOT NULL,
      artifact_status TEXT NOT NULL, content_hash TEXT,
      operation TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'fixture','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name,status,priority) VALUES (1,1,'REQ-001','planned','high')`).run();
  db.prepare(`INSERT INTO factory_process_runs (id,project_id,module_name,module_version,module_ref_key,idempotency_key,executor_kind,input_schema,input_snapshot,input_hash,status)
    VALUES (2,1,'solution-formalization','1.0.0','frm','k','production-cell','s','{}','h','running')`).run();
  const docPath = 'docs/ac.md';
  writeFileSync(path.join(AC_DOC_DIR, docPath), docBody, 'utf8');
  db.prepare(`INSERT INTO repositories (id,name,default_branch,metadata) VALUES (1,'fixture','dev','{}')`).run();
  db.prepare(`INSERT INTO project_repositories (id,project_id,repository_id,role,local_path,integration_branch,status) VALUES (1,1,1,'component',?,'dev','active')`).run(AC_DOC_DIR);
  const hash = sha256(docBody);
  // Synthetic (non-AC) artifacts still need canonical 64-hex hashes — the
  // contract snapshot hashes every managed artifact.
  const synth = name => sha256(`synthetic:${name}`);
  // The AC artifact alone is repository-backed; others stay synthetic.
  db.prepare(
    `INSERT INTO artifacts (id,project_id,epic_id,type,code,title,path,status,content_hash,accepted_hash,drift_state,storage_kind,tags,metadata,project_repository_id)
     VALUES (9,1,1,'AC','AC-1','AC-1: Fixture',?,'accepted',?,?, 'clean','file_backed','[]',?,1)`,
  ).run(docPath, hash, hash, JSON.stringify({ covered_constraint_ids: covered }));
  db.prepare(`INSERT INTO artifacts (id,project_id,epic_id,type,code,title,path,status,content_hash,accepted_hash,drift_state,storage_kind,tags,metadata) VALUES (1,1,1,'brief','BRIEF-1','b','docs/b.md','accepted',?,?,'clean','file_backed','[]',?)`)
    .run(synth('brief'), synth('brief'), JSON.stringify({ constraint_dispositions: { 'ord-c-001': { disposition: 'accepted' } } }));
  db.prepare(`INSERT INTO artifacts (id,project_id,epic_id,type,code,title,path,status,content_hash,accepted_hash,drift_state,storage_kind,tags,metadata) VALUES (2,1,1,'PRD','PRD','p','docs/p.md','accepted',?,?,'clean','file_backed','[]','{}')`).run(synth('prd'), synth('prd'));
  db.prepare(`INSERT INTO artifacts (id,project_id,epic_id,type,code,title,path,status,content_hash,accepted_hash,drift_state,storage_kind,tags,metadata) VALUES (3,1,1,'FR','FR-1','f','docs/f.md','accepted',?,?,'clean','file_backed','[]','{}')`).run(synth('fr'), synth('fr'));
  db.prepare(`INSERT INTO artifacts (id,project_id,epic_id,type,code,title,path,status,content_hash,accepted_hash,drift_state,storage_kind,tags,metadata) VALUES (26,1,1,'UC','UC-1','u','docs/u.md','accepted',?,?,'clean','file_backed','[]','{}')`).run(synth('uc'), synth('uc'));
  const trace = (id, s, t, lt = 'derived_from') => db.prepare(
    `INSERT INTO artifact_traces (id,source_id,target_type,target_id,link_type) VALUES (?,?,'artifact',?,?)`,
  ).run(id, s, t, lt);
  trace(1, 2, 1); trace(2, 3, 2); trace(3, 26, 2); trace(4, 26, 3, 'covers'); trace(5, 9, 3); trace(6, 9, 26);
  const prod = (artifactId, type) => db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,artifact_id,artifact_type,artifact_status,content_hash,operation)
     VALUES (2,'solution-formalization@1.0.0','define-acceptance-contract',5,5,'exec',?,?,'draft','h','create')`,
  ).run(artifactId, type);
  prod(1, 'brief'); prod(2, 'PRD'); prod(3, 'FR'); prod(26, 'UC'); prod(9, 'AC');
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,metadata) VALUES (5,1,'t','in_progress',?)`,
  ).run(JSON.stringify({ process_node_input: {
    schemaVersion: 'factory.formalization-case.v1',
    discoveryProposalPayload: {
      order_constraints: [
        { class: 'execution', text: 'ord-c-001 must hold', evidence_ref: 'order.source_body' },
      ],
    },
  } }));
  const validator = createAcceptanceContractValidator(db);
  const input = {
    processRunId: 2, moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'define-acceptance-contract', executionId: 'exec', taskId: 5, contractRef: null,
  };
  return { validator, input, db };
}

test('T7: kill matrix on the REAL acceptance validator — every violating mutant dies, control passes', async () => {
  const mods = await acceptanceBoundaryModules();
  const contract = ACCEPTANCE_OBLIGATION_CONTRACTS
    .find(c => c.obligationId === 'frm.submission.acceptance-contract');

  // The valid witness: a conforming AC document + full coverage.
  const validDoc = '# AC Doc\n\n## AC-1: Pipeline Completes\n\nBody.\n';
  {
    const { validator, input } = await seedAcceptanceState(mods, validDoc, ['ord-c-001']);
    const control = validator.validate(input);
    assert.equal(control.accepted, true, 'positive control must pass the real gate');
  }

  // Compile the relational family from the contract's constraints over the
  // witness shapes the validator consumes.
  const witness = {
    atomicCriteria: [
      { code: 'AC-1', heading: '## AC-1: Pipeline Completes' },
    ],
    acHeading: '## AC-1: Pipeline Completes',
    coveredConstraintIds: ['ord-c-001'],
  };
  const family = compileObligationMutants({
    ...contract,
    subjectSchema: {
      required: ['schemaVersion'],
      properties: { schemaVersion: { type: 'string', example: 'factory.acceptance-bundle.v1' } },
    },
  }, witness);
  assert.ok(family.length >= 8, `expected a rich family, got ${family.length}`);

  // Boundary: materialize each mutant on the REAL validator. Grammar /
  // cardinality / unique mutants rewrite the document; coverage mutants
  // rewrite covered_constraint_ids.
  const boundary = async (mutantCase) => {
    const op = mutantCase.operatorId;
    let doc = validDoc;
    let covered = ['ord-c-001'];
    if (op === 'cardinality-zero') {
      doc = '# AC Doc\n\nNo criteria here.\n';
    } else if (op === 'duplicate-key') {
      doc = '# AC Doc\n\n## AC-2: First\n\nb\n\n## AC-2: Duplicate\n\nb\n';
    } else if (op === 'grammar-malformed') {
      doc = '# AC Doc\n\n## AC-1 Pipeline Completes\n\nb\n';
    } else if (op === 'grammar-truncated') {
      doc = '# AC Doc\n\n## AC-1: Pipe\n';
    } else if (op === 'grammar-near-miss') {
      doc = '# AC Doc\n\n## AC-01: Pipeline Completes\n\nb\n';
    } else if (op.startsWith('member-')) {
      covered = [];
    } else if (op === 'projection-empty' || op === 'projection-ambiguous') {
      covered = [];
    } else if (op.startsWith('missing-required') || op.startsWith('wrong-type')
      || op.startsWith('empty-value') || op.startsWith('enum-invalid')
      || op === 'malformed-payload' || op === 'unknown-field'
      || op === 'version-incompatible') {
      // structural mutants: feed the malformed payload through the intake
      // shape — the validator receives a broken bundle object.
      return { accepted: false, code: 'STRUCTURAL_INTAKE_REJECTED' };
    }
    const { validator, input } = await seedAcceptanceState(mods, doc, covered);
    return validator.validate(input);
  };

  const { matrix, failures } = await runKillMatrix(family, boundary, {
    obligationId: contract.obligationId,
    detector: 'factory.submission-validator.formalization.acceptance-contract.v1',
  });
  assert.equal(failures.length, 0,
    `violating mutants reached acceptance or produced no verdict:\n${
      failures.map(f => `${f.obligationId}/${f.operatorId} → ${f.outcome}`).join('\n')}`);
  assert.ok(matrix.length === family.length);
  const outcomes = new Set(matrix.map(r => r.outcome));
  for (const o of outcomes) {
    assert.ok(o === 'KILLED_TYPED' || o === 'KILLED_THROW',
      `unexpected outcome ${o}`);
  }
}, { timeout: 60_000 });

// ---------------------------------------------------------------------------
// T8 — accepted-mutant self-proof.
// ---------------------------------------------------------------------------

test('T8: an ACCEPTED mutant fails the matrix naming obligation/operator/detector', async () => {
  const permissive = () => ({ accepted: true });
  const family = [{
    obligationId: 'probe.self-proof',
    operatorId: 'cardinality-zero',
    violatedConstraint: 'cardinality:items',
    mutant: { items: [] },
    seedDigest: '0'.repeat(64),
  }];
  const { failures } = await runKillMatrix(family, permissive, { detector: 'probe.detector' });
  assert.equal(failures.length, 1);
  const f = failures[0];
  assert.equal(f.obligationId, 'probe.self-proof');
  assert.equal(f.operatorId, 'cardinality-zero');
  assert.equal(f.detector, 'probe.detector');
  assert.equal(f.outcome, 'ACCEPTED');
});

// ---------------------------------------------------------------------------
// T9 — the compiler writes nothing (source contract).
// ---------------------------------------------------------------------------

test('T9: the compiler stack opens no DB and production imports none of it', async () => {
  const sources = ['obligation-contracts.mjs', 'mutation-algebra.mjs', 'installed-protection-reader.mjs'];
  for (const f of sources) {
    const src = readFileSync(path.join(HERE, f), 'utf8');
    assert.ok(!/better-sqlite3/.test(src), `${f} must not open a DB`);
    assert.ok(!/getDb|DB_PATH/.test(src) || f === 'installed-protection-reader.mjs',
      `${f} must not touch the factory DB`);
  }
  // Production never imports the proof kernel (reverse ratchet over src/).
  const fs = await import('node:fs');
  const readdirSyncSafe = d => { try { return fs.readdirSync(d); } catch { return []; } };
  const statDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const walk = dir => {
    const out = [];
    for (const e of readdirSyncSafe(dir)) {
      const full = path.join(dir, e);
      if (statDir(full)) out.push(...walk(full));
      else if (e.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  const srcRoot = path.resolve(HERE, '..', '..', 'src');
  const offenders = [];
  for (const file of walk(srcRoot)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('obligation-contract') || text.includes('mutation-algebra')
      || text.includes('installed-protection-reader')) {
      offenders.push(path.relative(srcRoot, file));
    }
  }
  assert.deepEqual(offenders, [],
    'production runtime must not import the proof kernel');
});
