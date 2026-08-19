// tests/factory-contract/snapshot-reach-development.test.mjs
//
// SNAPSHOT-TEST MVP: a deterministic, zero-token regression proving THE
// FACTORY REACHES THE DEVELOPMENT STAGE, driven by the REAL captured
// material of the stage-11 docking run (frozen copy:
// factory-snapshots/stage11-replay-fitness, integrity ok, 2026-08-19).
//
// The test spawns the REAL dist/orchestrate-cli.js (golden-path driver
// composition: setupFreshDb -> launchEngine -> convergence) with the
// snapshot-stage11-scenarios.mjs tape. Scripted workers replay captured
// products/artifacts/traces/verdicts byte-exactly through the real MCP
// gateway; no LLM is ever called.
//
// Assertions (content-class only — no run ids):
//   (a) the lifecycle REACHES solution-development: factory_process_runs
//       gains the development module row (the operator's exact fixation);
//       in the replay it runs to completion ('verified') — one module
//       further than the captured 'paused' terminal.
//   (b) per-cell gate verdict sequence equals the captured one — including
//       the REAL plan-task-graph repair loop (rejected #1, rejected #2,
//       accepted #3). Documented deviation: formalization-architecture-
//       contract replays only its accepted round (the rejected v1 SRS body
//       was never captured — see scenario file header).
//   (c) every replayed product's content hash equals the harvested corpus
//       hash, paired per node/schema (byte-exact replay of the NN output).
//   (d) orchestrate-cli exits 0 and leaves zero stranded worker executions.
//
// Fixture determinism: the product repository base commit 807faf1… is
// reproduced bit-exactly (fixed tree, author, committer and dates), which is
// what the captured planner proposals' expectedBaseCommit refers to.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();
const CORPUS_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'golden-corpus');
const SCENARIOS_PATH = path.join(REPO_ROOT, 'tests', 'factory-contract', 'snapshot-stage11-scenarios.mjs');

// The captured run's product-repository initial commit (planner proposals'
// expectedBaseCommit). Reproduced deterministically below.
const CAPTURED_BASE_COMMIT = '807faf164525cc086507247512a04550864adccf';
const CAPTURED_REPO_NAME = '.factory-sandboxes/stage11-repo';

// --- captured expectations (from the harvested corpus manifest) ---

const corpusManifest = JSON.parse(
  readFileSync(path.join(CORPUS_ROOT, 'stage11-docking', 'manifest.json'), 'utf8'),
);

function capturedProductHashes(node, { exclude = [], excludeArtifactRefs = [] } = {}) {
  return corpusManifest.products
    .filter(product => product.nodeId === node)
    .filter(product => !exclude.includes(`${product.schemaId}#${product.ordinal}`))
    .filter(product => {
      if (product.schemaId !== 'factory.artifact-ref.v1' || excludeArtifactRefs.length === 0) return true;
      // Identify the corpus ref by its payload artifactId (the file name only
      // carries an ordinal; the payload is authoritative).
      const payload = JSON.parse(readFileSync(path.join(CORPUS_ROOT, 'stage11-docking', product.file), 'utf8'));
      return !excludeArtifactRefs.includes(`artifact:${payload.artifactId}`);
    })
    .map(product => ({ schema: product.schemaId, hash: product.sourcePayloadHash }))
    .sort(bySchemaThenHash);
}

function bySchemaThenHash(a, b) {
  if (a.schema !== b.schema) return a.schema < b.schema ? -1 : 1;
  return a.hash < b.hash ? -1 : 1;
}

// Per-node expected product hashes (schema, payload_hash). Every entry is a
// corpus-captured product that the tape replays byte-exactly.
//
// Creation-intermediate artifact-refs excluded (both sides, by product key):
// the artifact-ref product freezes the document bytes AT CREATION TIME. For
// two artifacts the real worker later rewrote the file (artifact:3 FR-1 and
// artifact:17 SRS), and only the FINAL bytes are captured on disk — the
// intermediate states exist solely as hashes in the frozen run. The replay
// creates those artifacts directly at their final bytes, so their refs hash
// differently. The final-state evidence (artifact rows, bundles, verdicts)
// still asserts byte-exact for every cell.
const INTERMEDIATE_REF_EXCLUSIONS = ['artifact:3', 'artifact:17'];

const EXPECTED_PRODUCT_HASHES = [
  { node: 'produce-proposal', products: capturedProductHashes('produce-proposal') },
  { node: 'assess-readiness', products: capturedProductHashes('assess-readiness') },
  {
    node: 'define-product-contract',
    products: capturedProductHashes('define-product-contract', { excludeArtifactRefs: ['artifact:3'] }),
  },
  { node: 'model-use-cases', products: capturedProductHashes('model-use-cases') },
  { node: 'define-acceptance-contract', products: capturedProductHashes('define-acceptance-contract') },
  { node: 'reconcile-what', products: capturedProductHashes('reconcile-what') },
  {
    node: 'define-architecture-contract',
    products: capturedProductHashes('define-architecture-contract', {
      // Rejected v1 round not replayed (v1 SRS body not captured) — see the
      // scenario file header; artifact:17's ref froze an intermediate state.
      exclude: [
        'factory.formalization-architecture-bundle.v1#1',
        'factory.review-verdict.v1#1',
      ],
      excludeArtifactRefs: ['artifact:17'],
    }),
  },
  { node: 'plan-task-graph', products: capturedProductHashes('plan-task-graph') },
];

// Captured gate verdict sequence per production cell (phase, verdict),
// joined from factory_gate_decisions of the frozen run. The architecture
// cell documents its single-round deviation.
const EXPECTED_GATE_SEQUENCE = new Map([
  ['discovery-proposal', [['final', 'accepted']]],
  ['discovery-readiness', [['final', 'accepted']]],
  ['formalization-product-contract', [['author', 'accepted'], ['final', 'accepted']]],
  ['formalization-use-cases', [['author', 'accepted'], ['final', 'accepted']]],
  // The stage-10 killer cell: byte-exact real material through this gate.
  ['formalization-acceptance-contract', [['author', 'accepted'], ['final', 'accepted']]],
  ['formalization-reconciliation', [['author', 'accepted'], ['final', 'accepted']]],
  // Captured: [final repair_required, author accepted, final accepted].
  // Replayed: accepted round only (v1 SRS body not captured).
  ['formalization-architecture-contract', [['author', 'accepted'], ['final', 'accepted']]],
  // The REAL planner repair loop, replayed on the captured proposals.
  ['development-plan-task-graph', [
    ['final', 'repair_required'],
    ['final', 'repair_required'],
    ['final', 'accepted'],
  ]],
]);

// --- fixture: reproduce the captured product-repo base commit bit-exactly ---

function buildDeterministicRepo(dir) {
  const repoPath = path.join(dir, 'product-repo');
  mkdirSync(repoPath, { recursive: true });
  // Blob/tree/commit must match the captured 807faf1 exactly: README bytes,
  // identity "Saga Factory <saga-factory@example.test>", unix timestamp
  // 1787132568 +0300, message "chore: initialize product", branch dev,
  // core.autocrlf off (blob stored with LF).
  writeFileSync(path.join(repoPath, 'README.md'), '# .factory-sandboxes/stage11\n');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Saga Factory',
    GIT_AUTHOR_EMAIL: 'saga-factory@example.test',
    GIT_COMMITTER_NAME: 'Saga Factory',
    GIT_COMMITTER_EMAIL: 'saga-factory@example.test',
    GIT_AUTHOR_DATE: '@1787132568 +0300',
    GIT_COMMITTER_DATE: '@1787132568 +0300',
  };
  execSync(
    'git init -q -b dev && git config core.autocrlf false'
    + ' && git config user.email saga-factory@example.test'
    + ' && git config user.name "Saga Factory"'
    + ' && git add README.md && git commit -q -m "chore: initialize product"',
    { cwd: repoPath, env: gitEnv, windowsHide: true, stdio: 'pipe' },
  );
  const baseCommit = execSync('git rev-parse HEAD', {
    cwd: repoPath, encoding: 'utf8', windowsHide: true,
  }).trim();
  assert.equal(
    baseCommit, CAPTURED_BASE_COMMIT,
    'fixture repo must reproduce the captured base commit bit-exactly',
  );
  return repoPath;
}

// --- fresh DB + launch request (golden-path composition, stage-11 names) ---

async function setupFreshDb(repoPath) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-snapshot-'));
  const dbPath = path.join(dir, 'snapshot.db');
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const { ensureReplayCapsuleSchema } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.js')).href);
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,description,status,tags,metadata)
              VALUES (1,'.factory-sandboxes/stage11','snapshot replay test','active','[]','{}')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name,status,priority)
              VALUES (1,1,'REQ-001','planned','high')`).run();
  db.prepare(`INSERT INTO lifecycle_execution_controls
              (epic_id,concurrency,model_concurrency_limit)
              VALUES (1,1,1)`).run();
  // Repository name must match the captured lifecycle input's repositoryRef.
  db.prepare(`INSERT INTO repositories (id,name,default_branch,metadata)
              VALUES (1,?,'dev','{}')`).run(CAPTURED_REPO_NAME);
  db.prepare(`INSERT INTO project_repositories
              (id,project_id,repository_id,role,local_path,integration_branch,status)
              VALUES (1,1,1,'component',?,'dev','active')`).run(repoPath);
  // Verification settlement needs the deterministic evidence provider for the
  // development verification contract (same as golden-path).
  db.prepare(`INSERT INTO trusted_providers
    (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
    VALUES (9103,1,'deterministic_evidence','development.verification-product-contract.v2',
            'snapshot replay test verification provider','full','factory-contract','L0','2.0.0','active')`).run();
  ensureReplayCapsuleSchema(db);
  closeDb();

  // The captured launch input, byte-verbatim from
  // factory_launch_requests.lifecycle_input_json of the frozen run.
  const lifecycleInput = JSON.parse(
    readFileSync(path.join(CORPUS_ROOT, 'stage11-launch-input.json'), 'utf8'),
  );

  const { getDb: getDb2, closeDb: closeDb2 } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const { requestFactoryLaunch } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
  process.env.DB_PATH = dbPath;
  const db2 = getDb2();
  const orderRef = `order-snapshot-${randomUUID()}`;
  db2.prepare(`INSERT INTO factory_orders
              (order_ref,project_id,epic_id,source_kind,state)
              VALUES (?,1,1,'idea_url','starting')`).run(orderRef);
  const launchRef = requestFactoryLaunch({
    orderRef,
    mode: 'new',
    projectId: 1,
    epicId: 1,
    initiatedBy: 'snapshot-replay-test',
    idempotencyKey: `snapshot-${randomUUID()}`,
    concurrency: 1,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db2);
  closeDb2();
  return { dbPath, launchRef, dir };
}

async function runOrchestrateCli(launchRef, dbPath, repoPath, invocationLogPath, timeoutMs) {
  const child = spawn('node', [
    path.join(REPO_ROOT, 'dist', 'orchestrate-cli.js'),
    `--launch-ref=${launchRef}`,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      SAGA_REPO_ROOT: REPO_ROOT,
      SAGA_BUTTON_REPO_PATH: repoPath,
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: path.join(REPO_ROOT, 'tests', 'factory-contract', 'scenario-composition.mjs'),
      SAGA_SCENARIOS: SCENARIOS_PATH,
      SAGA_INVOCATION_LOG: invocationLogPath,
      SAGA_CONCURRENCY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { stderr += c; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`TIMEOUT after ${timeoutMs}ms\n${stderr.slice(-4000)}`));
    }, timeoutMs);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr };
}

function readGateSequence(db) {
  const rows = db.prepare(
    `SELECT w.production_cell_id AS cell, d.gate_phase AS phase, d.verdict AS verdict
       FROM factory_gate_decisions d
       JOIN factory_workplaces w ON w.workplace_ref = d.workplace_ref
      ORDER BY d.rowid`,
  ).all();
  const sequence = new Map();
  for (const row of rows) {
    if (!sequence.has(row.cell)) sequence.set(row.cell, []);
    sequence.get(row.cell).push([row.phase, row.verdict]);
  }
  return sequence;
}

test('snapshot replay: stage-11 captured tape reaches solution-development', { timeout: 900000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-snapshot-repo-'));
  const repoPath = buildDeterministicRepo(dir);
  const invocationLogPath = path.join(dir, 'invocations.json');
  writeFileSync(invocationLogPath, '[]');
  const { dbPath, launchRef, dir: dbDir } = await setupFreshDb(repoPath);

  try {
    const run = await runOrchestrateCli(launchRef, dbPath, repoPath, invocationLogPath, 840000);

    // (d) exit 0 — the lifecycle terminated by completing, not by pausing.
    assert.equal(run.exitCode, 0, `orchestrate-cli exited ${run.exitCode}\n${run.stderr.slice(-6000)}`);

    const db = new Database(dbPath, { readonly: true });
    const diagnostics = `\n--- orchestrator stderr ---\n${run.stderr.slice(-8000)}`;

    // (a) the lifecycle REACHED solution-development: the module row exists.
    const runs = db.prepare(
      'SELECT module_name,status,local_outcome FROM factory_process_runs ORDER BY id',
    ).all();
    const byModule = new Map(runs.map(row => [row.module_name, row]));
    assert.ok(byModule.has('product-discovery'), `discovery ProcessRun exists${diagnostics}`);
    assert.ok(byModule.has('solution-formalization'), `formalization ProcessRun exists${diagnostics}`);
    const developmentRun = byModule.get('solution-development');
    assert.ok(developmentRun, `solution-development ProcessRun exists (REACHED development)${diagnostics}`);
    assert.equal(byModule.get('product-discovery').status, 'completed');
    assert.equal(byModule.get('product-discovery').local_outcome, 'go');
    assert.equal(byModule.get('solution-formalization').status, 'completed');
    assert.equal(byModule.get('solution-formalization').local_outcome, 'formalized');
    // The captured run was paused mid-development; the deterministic replay
    // runs the scripted tail to the module's terminal outcome.
    assert.equal(developmentRun.status, 'completed', `development completed${diagnostics}`);
    assert.equal(developmentRun.local_outcome, 'verified');

    // Development actually dispatched work (implementation workplaces exist).
    const implWorkplaces = db.prepare(
      `SELECT COUNT(*) AS n FROM factory_workplaces WHERE production_cell_id='development-implementation'`,
    ).get().n;
    assert.ok(implWorkplaces >= 1, `development-implementation workplaces exist${diagnostics}`);

    // (b) per-cell gate verdict sequence equals the captured one.
    const sequence = readGateSequence(db);
    for (const [cell, expected] of EXPECTED_GATE_SEQUENCE) {
      assert.deepEqual(
        sequence.get(cell) || [],
        expected,
        `gate sequence for ${cell} must match the captured run${diagnostics}`,
      );
    }

    // (c) content-class identity: every replayed product's payload hash equals
    // the harvested corpus hash, paired per node/schema.
    const replayProducts = db.prepare(
      'SELECT node_id, schema_id, product_key, payload_hash FROM factory_process_products ORDER BY id',
    ).all();
    for (const { node, products: expected } of EXPECTED_PRODUCT_HASHES) {
      const actual = replayProducts
        .filter(product => product.node_id === node)
        .filter(product => !(product.schema_id === 'factory.artifact-ref.v1'
          && INTERMEDIATE_REF_EXCLUSIONS.includes(product.product_key)))
        .map(product => ({ schema: product.schema_id, hash: product.payload_hash }))
        .sort(bySchemaThenHash);
      assert.deepEqual(
        actual, expected,
        `product hashes for node ${node} must equal the harvested corpus${diagnostics}`,
      );
    }

    // (d) zero stranded worker executions.
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM worker_executions
                  WHERE state IN ('reserved','running','cancel_requested')`).get().n,
      0,
      `no stranded worker executions${diagnostics}`,
    );
    db.close();

    // The planner repair loop ran on the REAL captured proposals: three
    // durable author attempts (reject #1, reject #2, accept #3).
    const invocations = JSON.parse(readFileSync(invocationLogPath, 'utf8'));
    const plannerAttempts = invocations
      .filter(invocation => invocation.keyStr === 'solution-development@1.4.4/plan-task-graph/author/singleton')
      .map(invocation => invocation.attempt);
    assert.deepEqual(
      plannerAttempts.slice(0, 3), [1, 2, 3],
      `planner repair loop attempts (got ${JSON.stringify(plannerAttempts)})`,
    );
  } finally {
    if (process.env.SAGA_KEEP_FACTORY_TEST_DIR === '1') {
      console.error(`[snapshot-test] preserved repo=${dir} db=${dbDir}`);
    } else {
      try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
});
