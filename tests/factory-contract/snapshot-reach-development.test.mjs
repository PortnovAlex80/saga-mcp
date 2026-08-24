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
// HARNESS NATURE (scoped claim): this is a replay/corpus REGRESSION — the
// assertions are content-class only (byte hashes, gate sequences, captured
// ids, transition trace). It is NOT a semantic product oracle (nothing here
// judges whether the captured PRD/SRS is a good document — only that it is
// the exact gate-accepted captured material routed through the current
// factory) and NOT a replacement for a real worker spawn: the scripted
// executor substitutes the inference spawn seam only (CONVEYOR §23 L3
// rule 9); assignment, desks, MCP/tool authority, product submission, gates,
// effects and persistence are production code.
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
//   (e) zero model tokens: every worker execution of the run is accounted
//       1:1 by the scenario invocation ledger (see the assertion below —
//       a provider/model spawn would create an execution row with no
//       ledger entry).
//   (f) corpus provenance: the manifest's pinned replay module refs equal
//       the module rows the replay actually created (a future canonical
//       module bump cannot silently orphan the corpus), and the captured
//       transition trace matches the per-cell oracle (modulo the documented
//       architecture deviation).
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
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { deriveArchitectureSrsText } from './snapshot-stage11-scenarios.mjs';
import { buildOrderConstraintRegisterV2 } from '../../dist/shared/constraint-register.js';
import {
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
} from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

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

function capturedProductHashes(node, { exclude = [], excludeArtifactRefs = [], excludeVerdicts = false } = {}) {
  return corpusManifest.products
    .filter(product => product.nodeId === node)
    .filter(product => !exclude.includes(`${product.schemaId}#${product.ordinal}`))
    .filter(product => !(excludeVerdicts && product.schemaId === 'factory.review-verdict.v1'))
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
  {
    node: 'produce-proposal',
    products: capturedProductHashes('produce-proposal', {
      // The discovery-proposal-ref projection product existed only under the
      // captured 3.0.2 module; ADR-095's Discovery cutover removed the legacy
      // projection entirely (no emission site in product-discovery@4.0.0 —
      // the settlement binds proposalRef through the cell's durable bindings
      // instead). The captured ref row has no runtime counterpart BY DESIGN;
      // the proposal MATERIAL itself stays byte-pinned below.
      exclude: ['factory.discovery-proposal-ref.v1#1'],
    }),
  },
  { node: 'assess-readiness', products: capturedProductHashes('assess-readiness') },
  {
    node: 'define-product-contract',
    products: capturedProductHashes('define-product-contract', { excludeArtifactRefs: ['artifact:3'], excludeVerdicts: true }),
  },
  { node: 'model-use-cases', products: capturedProductHashes('model-use-cases', { excludeVerdicts: true }) },
  { node: 'define-acceptance-contract', products: capturedProductHashes('define-acceptance-contract', { excludeVerdicts: true }) },
  { node: 'reconcile-what', products: capturedProductHashes('reconcile-what', { excludeVerdicts: true }) },
  {
    node: 'define-architecture-contract',
    products: capturedProductHashes('define-architecture-contract', {
      // Rejected v1 round not replayed (v1 SRS body not captured) — see the
      // scenario file header; artifact:17's ref froze an intermediate state.
      exclude: [
        'factory.formalization-architecture-bundle.v1#1',
        // The ACCEPTED v2 bundle carries the DERIVED SRS contentHash for
        // artifact 17 (the §D2 coverage relay postdates the capture — the
        // document is captured bytes + one derived stanza field). Compared
        // by the dedicated parsed-content oracle below, not by digest.
        'factory.formalization-architecture-bundle.v1#2',
        'factory.review-verdict.v1#1',
      ],
      excludeArtifactRefs: ['artifact:17'],
      excludeVerdicts: true,
    }),
  },
  {
    node: 'plan-task-graph',
    products: capturedProductHashes('plan-task-graph', {
      // The three planner proposals are replayed in the CURRENT grammar
      // (acceptanceCriterionKeys relay, ADR-088 CC-GAP-6 — postdates the
      // capture), so strict digest equality is impossible by construction.
      // The dedicated parsed-content oracle (c4) below compares them
      // byte-exactly modulo the documented substitution.
      exclude: [
        'factory.development-task-graph-proposal.v1#1',
        'factory.development-task-graph-proposal.v1#2',
        'factory.development-task-graph-proposal.v1#3',
      ],
    }),
  },
];

// Captured reviewer verdicts, replayed with the subject ref rebound to the
// runtime candidate (see the tape header for the documented deviation: the
// submission-validation-receipt member postdates the capture, so the runtime
// candidate REF can never equal the captured one while the MATERIAL stays
// byte-exact). Each entry is verified by parsed-content equality modulo
// subject_candidate_set_ref, PLUS the binding check that the submitted ref
// is exactly the runtime author candidate of the same cell — a stale/foreign
// ref here is an authority defect, not a hash difference.
const EXPECTED_VERDICTS = [
  { node: 'define-product-contract', cell: 'formalization-product-contract', file: 'define-product-contract.factory.review-verdict.v1.1.json' },
  { node: 'model-use-cases', cell: 'formalization-use-cases', file: 'model-use-cases.factory.review-verdict.v1.1.json' },
  { node: 'define-acceptance-contract', cell: 'formalization-acceptance-contract', file: 'define-acceptance-contract.factory.review-verdict.v1.1.json' },
  { node: 'reconcile-what', cell: 'formalization-reconciliation', file: 'reconcile-what.factory.review-verdict.v1.1.json' },
  { node: 'define-architecture-contract', cell: 'formalization-architecture-contract', file: 'define-architecture-contract.factory.review-verdict.v1.2.json' },
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
              (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
              VALUES (1,1,'zai','glm-4.7','high',2)`).run();
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
  if (process.env.SAGA_DUMP_ORCHESTRATOR_STDERR) {
    writeFileSync(process.env.SAGA_DUMP_ORCHESTRATOR_STDERR, stderr, 'utf8');
  }
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
      'SELECT module_name,module_version,status,local_outcome FROM factory_process_runs ORDER BY id',
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
    assert.equal(developmentRun.local_outcome, 'verified', `development outcome verified${diagnostics}`);

    // Development actually dispatched work (implementation workplaces exist).
    const implWorkplaces = db.prepare(
      `SELECT COUNT(*) AS n FROM factory_workplaces WHERE production_cell_id='development-implementation'`,
    ).get().n;
    assert.ok(implWorkplaces >= 1, `development-implementation workplaces exist${diagnostics}`);

    // (f1) corpus provenance pin: the manifest's replayModuleRefs must equal
    // the module rows the replay ACTUALLY created. Load-bearing: a future
    // canonical module bump (the ADR-095 Phase-4 3.0.2 -> 4.0.0 class) turns
    // this red until the corpus provenance is consciously re-pinned — the
    // corpus can never silently drift onto an unpinned module identity.
    const provenance = corpusManifest.provenance;
    assert.ok(provenance, 'corpus manifest carries a provenance block');
    assert.equal(provenance.sourceBuildCommit.length, 40, 'source build commit is a full SHA');
    const runtimeModuleRefs = new Map(runs.map(row => [row.module_name, row.module_version]));
    for (const [moduleName, pinnedVersion] of Object.entries(provenance.replayModuleRefs)) {
      assert.equal(
        runtimeModuleRefs.get(moduleName), pinnedVersion,
        `replay module ref pin: ${moduleName} must run at the manifest-pinned ${pinnedVersion}`,
      );
    }
    // The captured trace rows must equal the per-cell oracle for every cell
    // the tape replays, modulo the documented deviations: the architecture
    // cell drops its rejected v1 round (body never captured) and the
    // development-implementation tail is scripted (captured run was paused).
    const capturedTrace = new Map();
    for (const [cell, phase, verdict] of provenance.expectedTransitionTrace) {
      if (!capturedTrace.has(cell)) capturedTrace.set(cell, []);
        capturedTrace.get(cell).push([phase, verdict]);
    }
    const ARCHITECTURE_CAPTURED = [['author', 'accepted'], ['final', 'repair_required'],
      ['author', 'accepted'], ['final', 'accepted']];
    for (const [cell, expected] of EXPECTED_GATE_SEQUENCE) {
      if (cell === 'formalization-architecture-contract') {
        assert.deepEqual(
          capturedTrace.get(cell), ARCHITECTURE_CAPTURED,
          'captured architecture trace must document the rejected round the replay omits',
        );
        continue;
      }
      assert.deepEqual(
        capturedTrace.get(cell), expected,
        `captured trace for ${cell} must equal the replay oracle (trace/manifest divergence)`,
      );
    }
    assert.ok(
      capturedTrace.has('development-implementation'),
      'captured trace honestly includes the paused development-implementation tail',
    );

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
    // the harvested corpus hash, paired per node/schema. The actual side
    // applies the SAME documented deviations as the expected side: reviewer
    // verdicts are rebound (verified byte-exact by c2), the accepted
    // architecture bundle carries the derived SRS hash (parsed-content
    // oracle c3), and the planner proposals carry the criterion-keys grammar
    // relay (parsed-content oracle c4). No product escapes pinning: each
    // excluded schema is pinned by its dedicated oracle below.
    const ACTUAL_SCHEMA_EXCLUSIONS = {
      'define-product-contract': ['factory.review-verdict.v1'],
      'model-use-cases': ['factory.review-verdict.v1'],
      'define-acceptance-contract': ['factory.review-verdict.v1'],
      'reconcile-what': ['factory.review-verdict.v1'],
      'define-architecture-contract': [
        'factory.review-verdict.v1',
        'factory.formalization-architecture-bundle.v1',
      ],
      'plan-task-graph': ['factory.development-task-graph-proposal.v1'],
    };
    const replayProducts = db.prepare(
      'SELECT node_id, schema_id, product_key, payload_hash FROM factory_process_products ORDER BY id',
    ).all();
    for (const { node, products: expected } of EXPECTED_PRODUCT_HASHES) {
      const excludedSchemas = ACTUAL_SCHEMA_EXCLUSIONS[node] ?? [];
      const actual = replayProducts
        .filter(product => product.node_id === node)
        .filter(product => !(product.schema_id === 'factory.artifact-ref.v1'
          && INTERMEDIATE_REF_EXCLUSIONS.includes(product.product_key)))
        .filter(product => !excludedSchemas.includes(product.schema_id))
        .map(product => ({ schema: product.schema_id, hash: product.payload_hash }))
        .sort(bySchemaThenHash);
      assert.deepEqual(
        actual, expected,
        `product hashes for node ${node} must equal the harvested corpus${diagnostics}`,
      );
    }

    // (c2) captured reviewer verdicts: parsed-content equality modulo the
    // rebound subject ref, PLUS the authority binding — the submitted ref
    // must be exactly the CURRENT runtime author candidate of that cell.
    // (A stale or foreign ref here is an authority defect, not a hash diff.)
    const verdictRows = db.prepare(
      `SELECT node_id, payload_snapshot FROM factory_process_products
        WHERE schema_id='factory.review-verdict.v1' ORDER BY id`,
    ).all();
    const runtimeAuthorRefs = new Map(db.prepare(
      `SELECT w.production_cell_id AS cell, cs.candidate_set_ref AS ref
         FROM factory_candidate_sets cs
         JOIN factory_workplaces w ON w.workplace_ref = cs.workplace_ref
        WHERE cs.role='author'`,
    ).all().map(row => [row.cell, row.ref]));
    assert.equal(
      verdictRows.length, EXPECTED_VERDICTS.length,
      `captured-verdict count (got nodes ${verdictRows.map(r => r.node_id).join(',')})${diagnostics}`,
    );
    for (const row of verdictRows) {
      const expected = EXPECTED_VERDICTS.find(verdict => verdict.node === row.node_id);
      assert.ok(expected, `unexpected verdict product for node ${row.node_id}${diagnostics}`);
      const captured = JSON.parse(readFileSync(
        path.join(CORPUS_ROOT, 'stage11-docking', 'products', expected.file), 'utf8',
      ));
      const submitted = JSON.parse(row.payload_snapshot);
      const { subject_candidate_set_ref: submittedRef, ...submittedRest } = submitted;
      const { subject_candidate_set_ref: _capturedRef, ...capturedRest } = captured;
      assert.deepEqual(
        submittedRest, capturedRest,
        `verdict content for ${row.node_id} must equal the captured verdict modulo the subject ref${diagnostics}`,
      );
      assert.equal(
        submittedRef, runtimeAuthorRefs.get(expected.cell),
        `verdict for ${row.node_id} must bind the CURRENT runtime author candidate of ${expected.cell}${diagnostics}`,
      );
    }

    // (c3) architecture SRS derived-relay oracle. The CURRENT factory's §D2
    // constraint-coverage gate postdates the capture, so the replayed SRS is
    // the captured document plus exactly one derived stanza field (the
    // full covered-constraint-id list — golden-path relay shape). Prove:
    //   - the SRS artifact row pins the DERIVED document hash (the factory
    //     hashes the file server-side, so this proves the exact bytes);
    //   - the architecture bundle equals the captured v2 bundle modulo
    //     artifact 17's contentHash, which must be that same derived hash.
    const capturedProposal = JSON.parse(readFileSync(path.join(
      CORPUS_ROOT, 'stage11-docking', 'products', 'produce-proposal.factory.discovery-proposal.v1.1.json',
    ), 'utf8'));
    const register = buildOrderConstraintRegisterV2({
      drafts: capturedProposal.order_constraints,
      unknowns: capturedProposal.unknowns,
      injections: [{
        table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
        tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
      }],
    });
    const coveredIds = register.constraints.map(entry => entry.id).sort();
    assert.ok(coveredIds.length > 0, 'captured proposal must yield a non-empty constraint register');
    const srsDocEntry = corpusManifest.documents.find(doc => doc.source === 'artifacts/requirements/REQ-001/12-SRS.md');
    const capturedSrs = readFileSync(path.join(CORPUS_ROOT, 'stage11-docking', srsDocEntry.file), 'utf8')
      .replace(/\r\n/g, '\n');
    const derivedSrsHash = createHash('sha256')
      .update(deriveArchitectureSrsText(capturedSrs, coveredIds), 'utf8').digest('hex');
    const srsArtifact = db.prepare("SELECT id, type, content_hash FROM artifacts WHERE id=17").get();
    assert.ok(srsArtifact, 'SRS artifact row exists (captured id 17)');
    assert.equal(srsArtifact.type, 'SRS');
    assert.equal(
      srsArtifact.content_hash, derivedSrsHash,
      `SRS artifact must pin the derived document hash (derived relay over ${coveredIds.length} constraint ids)`,
    );
    const architectureBundleRow = db.prepare(
      `SELECT payload_snapshot FROM factory_process_products
        WHERE node_id='define-architecture-contract'
          AND schema_id='factory.formalization-architecture-bundle.v1'`,
    ).get();
    assert.ok(architectureBundleRow, 'architecture bundle product exists');
    const runtimeBundle = JSON.parse(architectureBundleRow.payload_snapshot);
    const capturedBundle = JSON.parse(readFileSync(path.join(
      CORPUS_ROOT, 'stage11-docking',
      corpusManifest.products.find(product => product.nodeId === 'define-architecture-contract'
        && product.schemaId === 'factory.formalization-architecture-bundle.v1'
        && product.ordinal === 2).file,
    ), 'utf8'));
    assert.equal(
      runtimeBundle.artifacts.length, capturedBundle.artifacts.length,
      'architecture bundle artifact cardinality matches the captured bundle',
    );
    for (let index = 0; index < capturedBundle.artifacts.length; index += 1) {
      const runtimeArtifact = runtimeBundle.artifacts[index];
      const capturedArtifact = capturedBundle.artifacts[index];
      const { contentHash: runtimeHash, ...runtimeRest } = runtimeArtifact;
      const { contentHash: capturedHash, ...capturedRest } = capturedArtifact;
      assert.deepEqual(
        runtimeRest, capturedRest,
        `architecture bundle artifact ${capturedArtifact.artifactId} must equal the capture beyond the contentHash`,
      );
      if (Number(capturedArtifact.artifactId) === 17) {
        assert.equal(
          runtimeHash, derivedSrsHash,
          'architecture bundle artifact 17 must carry the derived SRS hash',
        );
      } else {
        assert.equal(
          runtimeHash, capturedHash,
          `architecture bundle artifact ${capturedArtifact.artifactId} must carry the captured hash`,
        );
      }
    }

    // (c4) planner grammar relay (ADR-088 CC-GAP-6 postdates the capture):
    // the replayed planner proposals equal the captured proposals modulo the
    // documented acceptanceCriterionIds -> acceptanceCriterionKeys
    // substitution, and every substituted key is an ACCEPTED runtime AC
    // artifact identity (artifactId:code) — authority-derived coverage,
    // never invented. Each item's referenced artifact id set must be exactly
    // the captured reference set (no coverage added or dropped by the relay).
    const plannerProposalRows = db.prepare(
      `SELECT payload_snapshot FROM factory_process_products
        WHERE node_id='plan-task-graph'
          AND schema_id='factory.development-task-graph-proposal.v1' ORDER BY id`,
    ).all();
    assert.equal(
      plannerProposalRows.length, 3,
      `planner proposal count (3 captured repair-loop rounds)${diagnostics}`,
    );
    const acceptedAcCodes = new Map(db.prepare(
      "SELECT id, code FROM artifacts WHERE type='AC'",
    ).all().map(row => [Number(row.id), String(row.code)]));
    assert.ok(
      acceptedAcCodes.size >= 5,
      `accepted AC artifact identities exist${diagnostics}`,
    );
    plannerProposalRows.forEach((row, index) => {
      const ordinal = index + 1;
      const captured = JSON.parse(readFileSync(path.join(
        CORPUS_ROOT, 'stage11-docking', 'products',
        `plan-task-graph.factory.development-task-graph-proposal.v1.${ordinal}.json`,
      ), 'utf8'));
      const submitted = JSON.parse(row.payload_snapshot);
      const stripKeys = item => {
        const { acceptanceCriterionKeys, ...rest } = item;
        return rest;
      };
      const stripIds = item => {
        const { acceptanceCriterionIds, ...rest } = item;
        return rest;
      };
      assert.deepEqual(
        {
          ...submitted,
          implementationItems: submitted.implementationItems.map(stripKeys),
          verificationItems: submitted.verificationItems.map(stripKeys),
        },
        {
          ...captured,
          implementationItems: captured.implementationItems.map(stripIds),
          verificationItems: captured.verificationItems.map(stripIds),
        },
        `planner proposal #${ordinal} must equal the capture modulo the criterion-keys relay${diagnostics}`,
      );
      const capturedItemByKey = new Map([
        ...captured.implementationItems,
        ...captured.verificationItems,
      ].map(item => [item.key, item]));
      for (const item of [...submitted.implementationItems, ...submitted.verificationItems]) {
        for (const key of item.acceptanceCriterionKeys) {
          const separator = key.indexOf(':');
          const artifactId = Number(key.slice(0, separator));
          const code = key.slice(separator + 1);
          assert.equal(
            acceptedAcCodes.get(artifactId), code,
            `planner key ${key} (item ${item.key}) must be an accepted AC artifact identity${diagnostics}`,
          );
        }
        assert.deepEqual(
          [...new Set(item.acceptanceCriterionKeys
            .map(key => Number(key.slice(0, key.indexOf(':')))))].sort(),
          [...new Set(capturedItemByKey.get(item.key).acceptanceCriterionIds)]
            .map(Number).sort(),
          `planner item ${item.key} must reference exactly the captured artifact set${diagnostics}`,
        );
      }
    });

    // (d) zero stranded worker executions.
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM worker_executions
                  WHERE state IN ('reserved','running','cancel_requested')`).get().n,
      0,
      `no stranded worker executions${diagnostics}`,
    );

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

    // (e) ZERO-TOKEN accounting. The composition registers exactly one
    // physical worker executor — the scripted scenario executor behind the
    // real WorkerExecutorFactory port (scenario-composition.mjs; claudePath
    // stays undefined). The executable proof: every worker_executions row of
    // the run maps 1:1 to an invocation-ledger entry that a scenario process
    // reserved BEFORE its handler ran. A provider/model spawn — anything
    // bypassing the scripted executor — would create an execution row with
    // no ledger entry (and no scenario keyStr), so set equality proves zero
    // model tokens were spent. This tape runs on a fresh DB with no capsule
    // seeding, so no capsule-replay execution can exist outside the ledger.
    const executionIds = db.prepare('SELECT execution_id AS id FROM worker_executions')
      .all().map(row => row.id).sort();
    const ledgerExecutionIds = invocations
      .map(invocation => invocation.executionId).sort();
    assert.deepEqual(
      ledgerExecutionIds, executionIds,
      'every worker execution must be a ledger-accounted scripted scenario invocation (zero model tokens)',
    );
    const tapeModulePrefixes = ['product-discovery@4.0.0/', 'solution-formalization@1.0.0/', 'solution-development@1.4.4/'];
    for (const invocation of invocations) {
      assert.ok(
        tapeModulePrefixes.some(prefix => invocation.keyStr.startsWith(prefix)),
        `every invocation must be a tape scenario key (got ${invocation.keyStr})`,
      );
    }
    db.close();
  } finally {
    if (process.env.SAGA_KEEP_FACTORY_TEST_DIR === '1') {
      console.error(`[snapshot-test] preserved repo=${dir} db=${dbDir}`);
    } else {
      try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
});
