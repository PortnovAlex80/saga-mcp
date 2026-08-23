import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// SEAM-ARCHITECT Layer 2 (a)+(b) — the local-runnability provider as the
// integration-verification cell:
//   (a) a compose declaration in the frozen readiness profile drives typed
//       compose steps (config validation at minimum; full mode: up with a
//       bounded timeout, then down) through an INJECTED runner — hermetic,
//       no docker in CI;
//   (b) every failure emits a typed seam repair-issue ref riding the same
//       evidenceRefs array (local-readiness:<digest>, check-diagnostic, seam)
//       with seamKind by phase, producingTaskRef resolved from the task graph
//       change scopes by file path, and fileHints extracted from the failure
//       output.

const {
  createLocalRunnabilityCheckProvider,
  ensureLocalRunnabilityProviderTrust,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} = await import(
  '../../dist/infrastructure/verification/local-runnability-check-provider.js'
);
const {
  installDockerInfoProbeForTests,
  resetDockerAvailabilityCache,
} = await import(
  '../../dist/infrastructure/verification/docker-readiness-executor.js'
);
const {
  INTEGRATED_CANDIDATE_SCHEMA,
} = await import('../../dist/modules/development/domain/development-schemas.js');
const { decodeSeamRepairIssue } = await import(
  '../../dist/process-modules/domain/workplace/seam-repair-issue.js'
);
const { decodeCheckDiagnostic } = await import(
  '../../dist/process-modules/domain/workplace/check-diagnostic.js'
);
const { HISTORICAL_DIGEST_BY_VERSION } = await import(
  './local-runnability-provider-history.mjs'
);

const PROCESS_RUN_ID = 1;
const PRODUCT_KIND = 'development.integrated-candidate';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture({ passing = true, crashServer = false, composeFile = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saga-seam-readiness-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(
    join(root, 'test.js'),
    passing
      ? 'process.exit(0);\n'
      : [
        "console.error('FAIL src/app.test.js');",
        "console.error('  seam regression in src/broken.ts');",
        'process.exit(1);',
        ].join('\n') + '\n',
  );
  writeFileSync(
    join(root, 'broken-install.js'),
    "console.error('Error: cannot load src/setup.ts'); process.exit(1);\n",
  );
  writeFileSync(join(root, 'server.js'), crashServer
    ? 'process.exit(3);\n'
    : [
      "const http=require('http');",
      "const port=Number(process.env.PORT);",
      "http.createServer((_q,r)=>{r.end('ready')}).listen(port,'127.0.0.1');",
      ].join('\n'));
  if (composeFile !== null) writeFileSync(join(root, composeFile), 'services: {}\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'seam-readiness-fixture', version: '1.0.0',
    scripts: { test: 'node test.js', start: 'node server.js' },
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

function newDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_repositories(id INTEGER PRIMARY KEY, local_path TEXT);
    CREATE TABLE factory_process_products(
      process_run_id INTEGER, product_kind TEXT, schema_id TEXT,
      artifact_ref TEXT, product_hash TEXT, payload_snapshot TEXT
    );
    CREATE TABLE factory_check_receipts(
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_development_task_projections(
      process_run_id INTEGER NOT NULL,
      graph_hash TEXT NOT NULL,
      work_item_key TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      PRIMARY KEY(process_run_id,work_item_key)
    );
    CREATE TABLE factory_workplaces(workplace_ref TEXT PRIMARY KEY, process_run_id INT,
      production_cell_id TEXT, loop_state TEXT, terminal_reason TEXT);
    CREATE TABLE factory_accepted_authority_head(workplace_ref TEXT PRIMARY KEY,
      accepted_author_task_id TEXT);
  `);
  return db;
}

function insertProduct(db, { root, candidateHash, readiness }) {
  const sealedCommit = git(root, 'rev-parse', 'HEAD');
  const sealedTree = git(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare('INSERT INTO project_repositories VALUES (1,?)').run(root);
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID,
    PRODUCT_KIND,
    INTEGRATED_CANDIDATE_SCHEMA,
    `development-integrated-candidate:${PROCESS_RUN_ID}:${candidateHash}`,
    candidateHash,
    JSON.stringify({
      candidateHash,
      repositories: [{
        projectRepositoryId: 1, commitSha: sealedCommit, treeHash: sealedTree,
      }],
      readiness,
    }),
  );
}

function insertTaskGraph(db, { scopes = ['src/'], taskId = 201 } = {}) {
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID,
    'development.task-graph',
    'factory.development-task-graph.v2',
    'development-task-graph:1:graphhash',
    'graphhash',
    JSON.stringify({
      implementationItems: [{
        key: 'implement-ac-1', changeScopes: scopes, projectRepositoryId: 1,
      }],
    }),
  );
  db.prepare(
    `INSERT INTO factory_development_task_projections
       (process_run_id,graph_hash,work_item_key,item_kind,task_id)
     VALUES (?,?,?,'implementation',?)`,
  ).run(PROCESS_RUN_ID, 'graphhash', 'implement-ac-1', taskId);
}

function candidateSetsReader(candidateHash) {
  return {
    read(ref) {
      if (ref !== 'candidate-set/test') return null;
      return {
        candidateSetRef: ref,
        role: 'author',
        workplaceRef: {
          processRunId: PROCESS_RUN_ID,
          moduleRef: 'solution-development',
          productionCellId: 'development-verification',
          workKey: 'AC-1',
        },
        members: [{
          productRef: {
            schemaId: INTEGRATED_CANDIDATE_SCHEMA,
            ref: `development-integrated-candidate:${PROCESS_RUN_ID}:${candidateHash}`,
            digest: candidateHash,
          },
          origin: 'produced',
          sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

const RUN_ARGS = {
  subjectCandidateSetRef: 'candidate-set/test', parameters: {},
  environmentRef: null, candidateSnapshot: {},
};

const SERVED_READINESS = {
  kind: 'served',
  commands: { installCommand: null, testCommand: 'npm test' },
  serve: { startCommand: 'npm start' },
};

function buildProvider({ root, readiness = SERVED_READINESS, taskGraph = null, composeRunner = null }) {
  const db = newDb();
  const candidateHash = 'a'.repeat(64);
  insertProduct(db, { root, candidateHash, readiness });
  if (taskGraph) insertTaskGraph(db, taskGraph);
  return {
    db,
    candidateHash,
    provider: createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSetsReader(candidateHash),
      ...(composeRunner ? { composeRunner } : {}),
    }),
  };
}

async function runSeamCase({ fixtureOpts, readiness, taskGraph, composeRunner }) {
  const root = fixture(fixtureOpts);
  let out;
  const built = buildProvider({ root, readiness, taskGraph, composeRunner });
  try {
    out = {
      result: await built.provider.run(RUN_ARGS),
      db: built.db,
    };
  } finally {
    if (!out) built.db.close();
  }
  rmSync(root, { recursive: true, force: true });
  return out;
}

function decodeSeamIssue(result) {
  for (const ref of result.evidenceRefs) {
    const issue = decodeSeamRepairIssue(ref);
    if (issue) return issue;
  }
  return null;
}

test('failing test command emits seam test-command with owner resolved from task-graph scopes', { timeout: 30000 }, async () => {
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: false },
    taskGraph: { scopes: ['src/'], taskId: 201 },
  });
  try {
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue, 'a typed seam repair-issue ref must ride evidenceRefs');
    assert.equal(issue.seamKind, 'test-command');
    assert.equal(issue.producingTaskRef, 'task:201');
    assert.equal(issue.localization.phase, 'profile-test');
    assert.equal(issue.localization.substrate, 'host');
    assert.ok(issue.localization.fileHints.includes('src/broken.ts'));
    assert.ok(issue.localization.fileHints.includes('src/app.test.js'));
    assert.match(issue.evidence.summary, /seam regression/u);
    assert.equal(issue.subjectCandidateSetRef, 'candidate-set/test');
    // The legacy human-readable check diagnostic is still present (additive).
    assert.ok(result.evidenceRefs.some(ref => decodeCheckDiagnostic(ref) !== null));
  } finally {
    db.close();
  }
});

test('seam owner falls back to the typed integration seam when no single owner covers the files', { timeout: 30000 }, async () => {
  // No task-graph product in the store → the owner cannot be resolved by
  // path. The seam issue must name the INTEGRATION seam (typed fallback),
  // never a guess at a task.
  const { result, db } = await runSeamCase({ fixtureOpts: { passing: false } });
  try {
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue);
    assert.equal(issue.producingTaskRef, 'seam:integration');
  } finally {
    db.close();
  }
});

test('seam owner falls back to the integration seam when files span multiple owners', { timeout: 30000 }, async () => {
  // Two implementation items each cover one of the failing files → the seam
  // is genuinely cross-item; a single producing task would be a lie.
  const root = fixture({ passing: false });
  const built = buildProvider({ root });
  built.db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID, 'development.task-graph',
    'factory.development-task-graph.v2',
    'development-task-graph:1:graphhash', 'graphhash',
    JSON.stringify({
      implementationItems: [
        { key: 'item-a', changeScopes: ['src/broken.ts'], projectRepositoryId: 1 },
        { key: 'item-b', changeScopes: ['src/app.test.js'], projectRepositoryId: 1 },
      ],
    }),
  );
  const insert = built.db.prepare(
    `INSERT INTO factory_development_task_projections
       (process_run_id,graph_hash,work_item_key,item_kind,task_id)
     VALUES (?,?,?,'implementation',?)`,
  );
  insert.run(PROCESS_RUN_ID, 'graphhash', 'item-a', 201);
  insert.run(PROCESS_RUN_ID, 'graphhash', 'item-b', 202);
  try {
    const result = await built.provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue);
    assert.equal(issue.producingTaskRef, 'seam:integration');
  } finally {
    built.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failing install command emits seam install-command', { timeout: 30000 }, async () => {
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: true },
    readiness: {
      kind: 'static',
      commands: {
        installCommand: 'node broken-install.js',
        testCommand: 'npm test',
      },
    },
    taskGraph: { scopes: ['src/'], taskId: 201 },
  });
  try {
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue);
    assert.equal(issue.seamKind, 'install-command');
    assert.equal(issue.localization.phase, 'profile-install');
    assert.ok(issue.localization.fileHints.includes('src/setup.ts'));
    assert.equal(issue.producingTaskRef, 'task:201');
  } finally {
    db.close();
  }
});

test('serve crash emits seam serve-start', { timeout: 30000 }, async () => {
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: true, crashServer: true },
  });
  try {
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue);
    assert.equal(issue.seamKind, 'serve-start');
    assert.equal(issue.localization.phase, 'profile-serve');
  } finally {
    db.close();
  }
});

test('absent/invalid readiness profile emits seam readiness-profile-invalid naming the profile-owning cell', { timeout: 30000 }, async () => {
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: true },
    readiness: { kind: 'served', commands: { installCommand: null, testCommand: '' } },
  });
  try {
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue);
    assert.equal(issue.seamKind, 'readiness-profile-invalid');
    // No accepted readiness-manifest head in the fixture → the typed fallback
    // names the readiness-certification cell that authors profiles.
    assert.equal(issue.producingTaskRef, 'cell:development-readiness-certification');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// (a) docker compose — typed declaration in the frozen profile, injected runner
// ---------------------------------------------------------------------------

function recordingComposeRunner(overrides = {}) {
  const calls = [];
  return {
    calls,
    configValidate(directory, declaration) {
      calls.push(['config', declaration.file, directory]);
      if (overrides.configValidate) return overrides.configValidate(directory, declaration);
      return { step: 'compose-config', status: 'passed' };
    },
    up(directory, declaration, timeoutMs) {
      calls.push(['up', declaration.file, timeoutMs, declaration.projectName ?? null]);
      if (overrides.up) return overrides.up(directory, declaration, timeoutMs);
      return { step: 'compose-up', status: 'passed', detail: 'healthy' };
    },
    down(directory, declaration) {
      calls.push(['down', declaration.file, declaration.projectName ?? null]);
      if (overrides.down) return overrides.down(directory, declaration);
    },
  };
}

const COMPOSE_READINESS = {
  kind: 'static',
  commands: { installCommand: null, testCommand: 'npm test' },
  compose: { file: 'compose.yaml' },
};

test('declared compose drives config-validate, bounded up, then down (typed steps)', { timeout: 30000 }, async () => {
  const runner = recordingComposeRunner();
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: true, composeFile: 'compose.yaml' },
    readiness: COMPOSE_READINESS,
    composeRunner: runner,
  });
  try {
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(runner.calls.map(call => call[0]), ['config', 'up', 'down']);
    assert.equal(runner.calls[0][1], 'compose.yaml');
    assert.ok(
      Number.isFinite(runner.calls[1][2]) && runner.calls[1][2] > 0,
      'compose up must run with a bounded timeout',
    );
  } finally {
    db.close();
  }
});

test('SAGA_LOCAL_RUNNABILITY_COMPOSE=config restricts to config validation', { timeout: 30000 }, async () => {
  process.env.SAGA_LOCAL_RUNNABILITY_COMPOSE = 'config';
  const runner = recordingComposeRunner();
  let out;
  try {
    out = await runSeamCase({
      fixtureOpts: { passing: true, composeFile: 'compose.yaml' },
      readiness: COMPOSE_READINESS,
      composeRunner: runner,
    });
  } finally {
    delete process.env.SAGA_LOCAL_RUNNABILITY_COMPOSE;
  }
  try {
    assert.equal(out.result.outcome, 'passed');
    assert.deepEqual(runner.calls.map(call => call[0]), ['config']);
  } finally {
    out.db.close();
  }
});

test('compose config validation failure fails closed with seam compose-config', { timeout: 30000 }, async () => {
  // ADR-091: a failed compose step is classified by the mechanical daemon
  // re-probe — pin the observed daemon HEALTHY so this proof pins the
  // available+linux direction (invalid config stays product `failed`) on
  // every machine, daemon or no daemon.
  installDockerInfoProbeForTests(() => ({ available: true, linux: true }));
  const runner = recordingComposeRunner({
    configValidate: () => ({
      step: 'compose-config', status: 'failed', detail: 'service "web" has no image',
    }),
  });
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: true, composeFile: 'compose.yaml' },
    readiness: COMPOSE_READINESS,
    composeRunner: runner,
  });
  try {
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue);
    assert.equal(issue.seamKind, 'compose-config');
    assert.equal(issue.localization.phase, 'compose-config');
    assert.match(issue.evidence.summary, /no image/u);
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
    db.close();
  }
});

test('compose up failure fails closed with seam compose-up and down still runs', { timeout: 30000 }, async () => {
  // ADR-091: pin the observed daemon HEALTHY — a failed up with a healthy
  // substrate stays product `failed`; the classification test for the
  // unavailable direction lives in local-runnability-toctou-reprobe.test.mjs.
  installDockerInfoProbeForTests(() => ({ available: true, linux: true }));
  const runner = recordingComposeRunner({
    up: () => ({ step: 'compose-up', status: 'failed', detail: 'timeout waiting for health' }),
  });
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: true, composeFile: 'compose.yaml' },
    readiness: COMPOSE_READINESS,
    composeRunner: runner,
  });
  try {
    assert.equal(result.outcome, 'failed');
    const issue = decodeSeamIssue(result);
    assert.ok(issue);
    assert.equal(issue.seamKind, 'compose-up');
    assert.ok(
      runner.calls.some(call => call[0] === 'down'),
      'compose down must still run after a failed up (clean shutdown)',
    );
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
    db.close();
  }
});

test('compose runner unavailable fails closed with LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE', { timeout: 30000 }, async () => {
  const { ReadinessExecutionError } = await import(
    '../../dist/infrastructure/verification/readiness-executor.js'
  );
  const runner = {
    configValidate() {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE',
        'compose declared but the docker compose CLI is unavailable',
      );
    },
    up() { throw new Error('unreachable'); },
    down() { /* unreachable */ },
  };
  const { result, db } = await runSeamCase({
    fixtureOpts: { passing: true, composeFile: 'compose.yaml' },
    readiness: COMPOSE_READINESS,
    composeRunner: runner,
  });
  try {
    assert.equal(result.outcome, 'failed');
    const diagnostic = result.evidenceRefs
      .map(decodeCheckDiagnostic)
      .find(d => d !== null);
    assert.equal(diagnostic.code, 'LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE');
  } finally {
    db.close();
  }
});

test('malformed compose declaration (traversal / absolute) invalidates the profile', { timeout: 30000 }, async () => {
  for (const badFile of ['../escape.yaml', 'C:\\compose.yaml', '/abs/compose.yaml', '']) {
    const { result, db } = await runSeamCase({
      fixtureOpts: { passing: true },
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'npm test' },
        compose: { file: badFile },
      },
      composeRunner: recordingComposeRunner(),
    });
    try {
      assert.equal(result.outcome, 'failed', `compose.file="${badFile}" must fail closed`);
      const issue = decodeSeamIssue(result);
      assert.ok(issue);
      assert.equal(issue.seamKind, 'readiness-profile-invalid');
    } finally {
      db.close();
    }
  }
});

test('provider version bump migrates the 1.5.0 trust row in place (exact authentic basis)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trusted_providers(
      id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
      category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
    );
  `);
  db.prepare(
    `INSERT INTO trusted_providers
       (project_id,name,version,category,trust_basis,determinism,scope,status)
     VALUES(NULL,'factory.local-runnability.v1','1.5.0','deterministic_evidence',
       ?,'full','local-runnability','active')`,
  ).run(`built-in:${HISTORICAL_DIGEST_BY_VERSION['1.5.0']}`);
  try {
    ensureLocalRunnabilityProviderTrust(db);
    const row = db.prepare(
      'SELECT version FROM trusted_providers WHERE name=?',
    ).get('factory.local-runnability.v1');
    assert.equal(row.version, LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION);
  } finally {
    db.close();
  }
});
