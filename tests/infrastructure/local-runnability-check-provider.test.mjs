import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createLocalRunnabilityCheckProvider,
  ensureLocalRunnabilityProviderTrust,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import { isDockerAvailableForReadiness } from '../../dist/infrastructure/verification/docker-readiness-executor.js';

const PROCESS_RUN_ID = 1;
const PRODUCT_KIND = 'development.integrated-candidate';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture({ passing = true, scripts = true, testOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saga-readiness-test-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(join(root, 'test.js'), `process.exit(${passing ? 0 : 1});\n`);
  writeFileSync(join(root, 'server.js'), [
    "const http=require('http');",
    "const port=Number(process.env.PORT);",
    "http.createServer((_q,r)=>{r.end('ready')}).listen(port,'127.0.0.1');",
  ].join('\n'));
  const scriptMap = testOnly
    ? { test: 'node test.js' }
    : (scripts ? { test: 'node test.js', start: 'node server.js' } : {});
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'readiness-fixture', version: '1.0.0',
    scripts: scriptMap,
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

/**
 * Build the ProductRef the development module persists for an integrated
 * candidate: artifact_ref = `<prefix>:<processRunId>:<candidateHash>`, and the
 * product_hash (== the member's digest) IS the candidateHash.
 */
function integratedProductRef(candidateHash) {
  return {
    schemaId: INTEGRATED_CANDIDATE_SCHEMA,
    ref: `development-integrated-candidate:${PROCESS_RUN_ID}:${candidateHash}`,
    digest: candidateHash,
  };
}

/**
 * Insert one sealed integrated-candidate product row plus its repository
 * binding. The row is addressable by its EXACT (schema_id, artifact_ref,
 * product_hash) identity — the way the real SqliteProcessProductRepository
 * persists it. `commitSha`/`treeHash` override the repo's current HEAD so a
 * test can seal an authority that is NOT the tip (a moving ref, a stale
 * commit, or a mismatched object).
 *
 * `readiness` (LR-04) is the explicit served|static readiness profile stated by
 * the accepted product. It defaults to a SERVED profile whose commands match
 * the standard fixture (npm test + npm start). Pass `includeReadiness: false`
 * to seal a contract that carries NO profile (fail-closed case), or a malformed
 * `readiness` value to exercise validation.
 */
function insertProduct(db, {
  repositoryId, root, candidateHash, commitSha, treeHash,
  readiness = {
    kind: 'served',
    commands: { installCommand: null, testCommand: 'npm test' },
    serve: { startCommand: 'npm start' },
  },
  includeReadiness = true,
}) {
  const sealedCommit = commitSha ?? git(root, 'rev-parse', 'HEAD');
  const sealedTree = treeHash ?? git(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare('INSERT INTO project_repositories VALUES (?,?)').run(repositoryId, root);
  const payload = {
    candidateHash,
    repositories: [{ projectRepositoryId: repositoryId, commitSha: sealedCommit, treeHash: sealedTree }],
  };
  if (includeReadiness) payload.readiness = readiness;
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID,
    PRODUCT_KIND,
    INTEGRATED_CANDIDATE_SCHEMA,
    integratedProductRef(candidateHash).ref,
    candidateHash,
    JSON.stringify(payload),
  );
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
  `);
  return db;
}

/**
 * Build a candidateSets reader mock. `mode` controls the fail-closed branches:
 *   - 'author' (default): author set whose single member is the integrated
 *     candidate identified by `candidateHash`.
 *   - 'absent': read returns null (no sealed set).
 *   - 'reviewer': set is role=reviewer (wrong role).
 *   - 'no-member': author set with NO integrated-candidate member (e.g. only
 *     verification evidence) — the sealed set does not carry the runnable
 *     product.
 *   - 'stale-ref': author member points at a productRef that has no matching
 *     product row (the sealed product is absent / unsealed in this store).
 */
function candidateSetsReader(mode = 'author', candidateHash = 'a'.repeat(64)) {
  return {
    read(ref) {
      if (ref !== 'candidate-set/test') return null;
      if (mode === 'absent') return null;
      const workplaceRef = {
        processRunId: PROCESS_RUN_ID,
        moduleRef: 'solution-development',
        productionCellId: 'development-verification',
        workKey: 'AC-1',
      };
      if (mode === 'reviewer') {
        return { candidateSetRef: ref, role: 'reviewer', workplaceRef, members: [] };
      }
      if (mode === 'no-member') {
        // Author set carrying only verification evidence — no integrated
        // candidate is sealed here (the real verification-cell author set).
        return {
          candidateSetRef: ref, role: 'author', workplaceRef,
          members: [{
            productRef: {
              schemaId: 'factory.candidate-verification-evidence-product.v2',
              ref: 'managed-node-submission:42',
              digest: 'c'.repeat(64),
            },
            origin: 'produced', sourceCandidateSetRef: null,
          }],
        };
      }
      const memberProductRef = mode === 'stale-ref'
        ? integratedProductRef('d'.repeat(64))
        : integratedProductRef(candidateHash);
      return {
        candidateSetRef: ref, role: 'author', workplaceRef,
        members: [{ productRef: memberProductRef, origin: 'produced', sourceCandidateSetRef: null }],
      };
    },
  };
}

function buildProvider({ root, mode, candidateHash = 'a'.repeat(64), repositoryId = 1, ...readinessOpts }) {
  const db = newDb();
  insertProduct(db, { repositoryId, root, candidateHash, ...readinessOpts });
  const candidateSets = candidateSetsReader(mode, candidateHash);
  return { db, provider: createLocalRunnabilityCheckProvider({ db, candidateSets }) };
}

const RUN_ARGS = {
  subjectCandidateSetRef: 'candidate-set/test', parameters: {},
  environmentRef: null, candidateSnapshot: {},
};

test('exact frozen candidate must test, start, answer loopback and stop', { timeout: 30000 }, async () => {
  const root = fixture();
  const { db, provider } = buildProvider({ root });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing scripts and failing tests fail closed', { timeout: 30000 }, async () => {
  for (const options of [{ scripts: false }, { passing: false }]) {
    const root = fixture(options);
    const { db, provider } = buildProvider({ root });
    try {
      const result = await provider.run(RUN_ARGS);
      assert.equal(result.outcome, 'failed');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('static product (test only, no start script) passes runnability', { timeout: 30000 }, async () => {
  // A static site / counter app has a `test` script but no `start` (opened from
  // disk, not served). The explicit STATIC profile states runnability by the
  // test command alone; runnability is proven by `npm test` with no serve.
  const root = fixture({ testOnly: true });
  const { db, provider } = buildProvider({
    root,
    readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' } },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ADR-053 / LR-01 — subject resolution must read the EXACT sealed member.
// ---------------------------------------------------------------------------

test('proves runnable the EXACT sealed member, not a co-existing product for the same kind', { timeout: 30000 }, async () => {
  // Two integrated-candidate product rows exist for the SAME process_run_id and
  // the SAME product_kind. The provider MUST test the one the sealed member
  // points at (proves 'passed' for the green repo, 'failed' for the red repo),
  // never an arbitrary/newest row a process+kind query would pick.
  const greenRoot = fixture({ passing: true });
  const redRoot = fixture({ passing: false });
  const greenHash = 'a'.repeat(64);
  const redHash = 'b'.repeat(64);
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root: greenRoot, candidateHash: greenHash });
  insertProduct(db, { repositoryId: 2, root: redRoot, candidateHash: redHash });
  try {
    // Member → green: must pass.
    const greenProvider = createLocalRunnabilityCheckProvider({
      db, candidateSets: candidateSetsReader('author', greenHash),
    });
    const greenResult = await greenProvider.run(RUN_ARGS);
    assert.equal(greenResult.outcome, 'passed');

    // Member → red: must fail. A process/kind query could not distinguish them.
    const redProvider = createLocalRunnabilityCheckProvider({
      db, candidateSets: candidateSetsReader('author', redHash),
    });
    const redResult = await redProvider.run(RUN_ARGS);
    assert.equal(redResult.outcome, 'failed');
  } finally {
    db.close();
    rmSync(greenRoot, { recursive: true, force: true });
    rmSync(redRoot, { recursive: true, force: true });
  }
});

test('does not fall back to a process+kind product when the sealed set carries no integrated-candidate member', { timeout: 30000 }, async () => {
  // A perfectly valid integrated-candidate product row exists for this process
  // run + kind (the OLD process/kind query would find it and PASS). But the
  // sealed candidate set is an author set that carries only verification
  // evidence — the runnable product was never sealed as a member. ADR-053: fail
  // closed, do not guess via process/kind.
  const root = fixture({ passing: true });
  const { db, provider } = buildProvider({ root, mode: 'no-member' });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'error');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when the exact candidate set is absent, non-author, or the sealed product row is missing', { timeout: 30000 }, async () => {
  const root = fixture({ passing: true });
  for (const mode of ['absent', 'reviewer', 'stale-ref']) {
    const { db, provider } = buildProvider({ root, mode });
    try {
      const result = await provider.run(RUN_ARGS);
      // 'error' is the provider's fail-closed outcome for any subject-resolution
      // failure (absent set, wrong role, or sealed product not present in store).
      assert.equal(result.outcome, 'error', `mode=${mode} should fail closed`);
    } finally {
      db.close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('trusted provider installation fails closed on authority drift', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trusted_providers(
    id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
    category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
  )`);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES(NULL,'factory.local-runnability.v1','1.0.0','deterministic_evidence',
      'tampered','none','local-runnability','active')`).run();
  assert.throws(
    () => ensureLocalRunnabilityProviderTrust(db),
    /LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT/u,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// ADR-053 / LR-02 — verify the EXACT content-addressed git object authority.
// The runnability proof binds to an immutable object identity (commit SHA +
// tree SHA read by `git cat-file`), NEVER to a moving ref / tip / working-tree
// checkout, and it never mutates the canonical branch.
// ---------------------------------------------------------------------------

test('proves runnable the EXACT sealed object, not the moved branch tip / working tree', { timeout: 30000 }, async () => {
  // Seal commit A (green test) as the authority, then advance the repo's tip to
  // commit B which BREAKS the test. The provider MUST test the exact sealed
  // object A (→ passed), never the tip / working tree (B → failed).
  const root = fixture({ passing: true });
  const sealedCommit = git(root, 'rev-parse', 'HEAD');
  const sealedTree = git(root, 'rev-parse', 'HEAD^{tree}');
  const sealedHash = 'a'.repeat(64);
  // Advance the tip to a RED commit and leave the working tree on it.
  writeFileSync(join(root, 'test.js'), 'process.exit(1);\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'break the test');
  assert.notEqual(git(root, 'rev-parse', 'HEAD'), sealedCommit, 'tip must have moved past sealed commit');
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root, candidateHash: sealedHash, commitSha: sealedCommit, treeHash: sealedTree });
  try {
    const result = await createLocalRunnabilityCheckProvider({
      db, candidateSets: candidateSetsReader('author', sealedHash),
    }).run(RUN_ARGS);
    // passed ⇒ the exact object A was tested, not the red tip / working tree.
    assert.equal(result.outcome, 'passed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a moving ref / branch tip / HEAD as the runnability authority', { timeout: 30000 }, async () => {
  // The sealed authority must be a content-addressed object id. A branch name,
  // 'HEAD', or any other movable pointer is refused — the proof binds to an
  // immutable object, not a pointer that can move under it.
  const root = fixture({ passing: true });
  const realTree = git(root, 'rev-parse', 'HEAD^{tree}');
  const branchName = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  for (const badAuthority of [branchName, 'HEAD', 'origin/main']) {
    const db = newDb();
    insertProduct(db, {
      repositoryId: 1, root, candidateHash: 'e'.repeat(64),
      commitSha: badAuthority, treeHash: realTree,
    });
    try {
      const result = await createLocalRunnabilityCheckProvider({
        db, candidateSets: candidateSetsReader('author', 'e'.repeat(64)),
      }).run(RUN_ARGS);
      assert.equal(result.outcome, 'error', `moving ref "${badAuthority}" must be refused as authority`);
    } finally {
      db.close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('rejects a missing or mismatched git object as the authority', { timeout: 30000 }, async () => {
  const root = fixture({ passing: true });
  const realCommit = git(root, 'rev-parse', 'HEAD');
  const realTree = git(root, 'rev-parse', 'HEAD^{tree}');
  // A valid-looking 40-hex object id that does not exist in this repo's DB.
  const ghostCommit = '0'.repeat(40);
  // A real commit whose sealed tree does NOT match (points elsewhere / drift).
  const wrongTree = '1'.repeat(40);

  const cases = [
    { label: 'commit object absent', commitSha: ghostCommit, treeHash: realTree },
    { label: 'tree object absent', commitSha: realCommit, treeHash: wrongTree },
  ];
  for (const c of cases) {
    const db = newDb();
    insertProduct(db, {
      repositoryId: 1, root, candidateHash: 'f'.repeat(64),
      commitSha: c.commitSha, treeHash: c.treeHash,
    });
    try {
      const result = await createLocalRunnabilityCheckProvider({
        db, candidateSets: candidateSetsReader('author', 'f'.repeat(64)),
      }).run(RUN_ARGS);
      assert.equal(result.outcome, 'error', `${c.label} must be refused (fail closed)`);
    } finally {
      db.close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('never checks out or mutates the canonical branch while proving runnability', { timeout: 30000 }, async () => {
  // The provider reads the object by identity (cat-file / rev-parse / archive)
  // and must NOT advance, create, or delete any ref, must NOT move HEAD, and
  // must NOT touch the working tree of the canonical checkout.
  const root = fixture({ passing: true });
  const sealedHash = 'a'.repeat(64);
  const before = {
    head: git(root, 'rev-parse', 'HEAD'),
    refs: git(root, 'show-ref'),
    status: git(root, 'status', '--porcelain'),
    refCount: git(root, 'rev-list', '--all', '--count'),
  };
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root, candidateHash: sealedHash });
  try {
    const result = await createLocalRunnabilityCheckProvider({
      db, candidateSets: candidateSetsReader('author', sealedHash),
    }).run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
  } finally {
    db.close();
  }
  const after = {
    head: git(root, 'rev-parse', 'HEAD'),
    refs: git(root, 'show-ref'),
    status: git(root, 'status', '--porcelain'),
    refCount: git(root, 'rev-list', '--all', '--count'),
  };
  assert.equal(after.head, before.head, 'HEAD (canonical branch tip) must not move');
  assert.equal(after.refs, before.refs, 'no ref may be created, advanced, or deleted');
  assert.equal(after.status, before.status, 'working tree must not be mutated');
  assert.equal(after.refCount, before.refCount, 'no new commits may be introduced');
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ADR-053 / LR-03 — install + test commands are DETERMINISTIC, sourced from
// the accepted product contract's explicit readiness profile (LR-04), NOT
// inferred from incidental files (package.json / build.gradle). Build-system
// detection stays as a validator for execution-environment selection; the
// AUTHORITY for which commands prove runnability is the explicit profile. If
// the profile cannot state its commands, the provider fails closed rather than
// guessing.
// ---------------------------------------------------------------------------

/** Seed a throwaway git repo with the given {path: contents} files and commit. */
function seedRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'saga-readiness-contract-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(root, path), contents);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'seed');
  return root;
}

test('runs the contract-stated test command verbatim, not a package.json script it would have to guess', { timeout: 30000 }, async () => {
  // The candidate has a package.json with NO `test` script. The pre-LR-03
  // file-guessing engine (cb3e944) would fail with "required npm script test is
  // missing". The accepted product's STATIC readiness profile states the exact
  // test command; the provider runs THAT and passes — the command is
  // deterministic, from the profile, never guessed from files.
  const root = seedRepo({
    'check.js': 'process.exit(0);\n',
    'package.json': JSON.stringify({ name: 'no-scripts', version: '1.0.0' }),
  });
  const { db, provider } = buildProvider({
    root,
    readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'node check.js' } },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-070 readiness manifest executes against its exact integrated-source ProductRef', { timeout: 30000 }, async () => {
  const root = fixture({ testOnly: true });
  const db = newDb();
  const sourceHash = '7'.repeat(64);
  const manifestHash = '8'.repeat(64);
  const commitSha = git(root, 'rev-parse', 'HEAD');
  const treeHash = git(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare('INSERT INTO project_repositories VALUES (?,?)').run(7, root);
  const sourceRef = {
    schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
    ref: `development-integrated-source:${PROCESS_RUN_ID}:${sourceHash}`,
    hash: sourceHash,
  };
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id,product_kind,schema_id,artifact_ref,product_hash,payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID,
    'development.integrated-source-candidate',
    sourceRef.schema,
    sourceRef.ref,
    sourceRef.hash,
    JSON.stringify({
      sourceHash,
      repositories: [{ projectRepositoryId: 7, commitSha, treeHash }],
    }),
  );
  db.exec(`CREATE TABLE factory_managed_node_submissions(
    id INTEGER PRIMARY KEY, process_run_id INTEGER, schema_version TEXT,
    content_hash TEXT, payload_snapshot TEXT
  )`);
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?)').run(
    41,
    PROCESS_RUN_ID,
    DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    manifestHash,
    JSON.stringify({
      schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
      sourceCandidate: sourceRef,
      targets: [{
        key: 'primary',
        readiness: {
          kind: 'static',
          commands: { installCommand: null, testCommand: 'npm test' },
        },
      }],
    }),
  );
  const candidateSets = {
    read(ref) {
      return ref === 'candidate-set/test' ? {
        candidateSetRef: ref,
        role: 'author',
        workplaceRef: {
          processRunId: PROCESS_RUN_ID,
          moduleRef: 'solution-development',
          productionCellId: 'development-readiness-certification',
          workKey: 'singleton',
        },
        members: [{
          productRef: {
            schemaId: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
            ref: 'managed-node-submission:41',
            digest: manifestHash,
          },
          origin: 'produced', sourceCandidateSetRef: null,
        }],
      } : null;
    },
  };
  try {
    const provider = createLocalRunnabilityCheckProvider({ db, candidateSets });
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs an explicit pip profile in a disposable virtualenv instead of system Python', { timeout: 120000 }, async () => {
  const root = seedRepo({
    'requirements.txt': '',
    'check_venv.py': [
      'import sys',
      'raise SystemExit(0 if sys.prefix != sys.base_prefix else 41)',
      '',
    ].join('\n'),
  });
  const { db, provider } = buildProvider({
    root,
    readiness: {
      kind: 'static',
      commands: {
        installCommand: 'pip install -r requirements.txt',
        testCommand: 'python check_venv.py',
      },
    },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the contract test command is the authority, not the package.json test script', { timeout: 30000 }, async () => {
  // package.json scripts.test points at a FAILING script. The readiness profile
  // states a DIFFERENT test command that passes. The provider MUST run the
  // profile command (pass), never the file-inferred npm test (fail) — proving
  // the file detection is not the command authority.
  const root = seedRepo({
    'passing.js': 'process.exit(0);\n',
    'failing.js': 'process.exit(1);\n',
    'package.json': JSON.stringify({
      name: 'misleading', version: '1.0.0',
      scripts: { test: 'node failing.js' },
    }),
  });
  const { db, provider } = buildProvider({
    root,
    readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'node passing.js' } },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when the readiness profile is invalid', { timeout: 30000 }, async () => {
  // Each variant is a profile the provider "cannot accept". A distinct
  // candidateHash per case avoids the provider's result cache so every variant
  // is actually executed, not shadowed by a prior cached outcome.
  const root = fixture({ passing: true });
  const cases = [
    { label: 'null', readiness: null },
    { label: 'missing kind', readiness: { commands: { installCommand: null, testCommand: 'npm test' } } },
    { label: 'unknown kind', readiness: { kind: 'batch', commands: { installCommand: null, testCommand: 'npm test' } } },
    { label: 'empty testCommand', readiness: { kind: 'static', commands: { installCommand: null, testCommand: '' } } },
    { label: 'missing testCommand', readiness: { kind: 'static', commands: { installCommand: 'npm install' } } },
    { label: 'non-string testCommand', readiness: { kind: 'static', commands: { testCommand: 42 } } },
    { label: 'non-string installCommand', readiness: { kind: 'static', commands: { installCommand: 7, testCommand: 'npm test' } } },
    { label: 'served missing serve', readiness: { kind: 'served', commands: { installCommand: null, testCommand: 'npm test' } } },
    { label: 'served empty startCommand', readiness: { kind: 'served', commands: { installCommand: null, testCommand: 'npm test' }, serve: { startCommand: '' } } },
  ];
  try {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const hash = (i + 1).toString(16).padStart(64, '0');
      const { db, provider } = buildProvider({ root, candidateHash: hash, readiness: c.readiness });
      try {
        const result = await provider.run(RUN_ARGS);
        assert.equal(result.outcome, 'failed', `${c.label} must fail closed`);
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ADR-053 / LR-04 — readiness is an EXPLICIT profile (served | static). The
// provider does NOT infer served/static (or product kind) from package.json /
// build files. Absent profile ⇒ fail closed. The profile is the single
// authority for the subject's runnability shape AND its commands.
// ---------------------------------------------------------------------------

test('SERVED readiness profile drives start, loopback probe, and clean shutdown', { timeout: 30000 }, async () => {
  // The candidate carries an explicit SERVED profile. The provider runs the
  // profile's test command, then starts the STATED serve command (`node
  // server.js`, not an npm script it guessed), probes loopback, and shuts it
  // down. The readiness shape is driven entirely by the profile.
  const root = seedRepo({
    'test.js': 'process.exit(0);\n',
    'server.js': [
      "const http=require('http');",
      "const port=Number(process.env.PORT);",
      "http.createServer((_q,r)=>{r.end('ready')}).listen(port,'127.0.0.1');",
    ].join('\n'),
    'package.json': JSON.stringify({ name: 'served', version: '1.0.0', scripts: { test: 'node test.js' } }),
  });
  const { db, provider } = buildProvider({
    root,
    readiness: {
      kind: 'served',
      commands: { installCommand: null, testCommand: 'node test.js' },
      serve: { startCommand: 'node server.js' },
    },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('STATIC readiness profile proves runnability without serving', { timeout: 30000 }, async () => {
  // package.json carries a `start` script that would crash if started (no such
  // file), so a wrongly-served run would time out the loopback probe and FAIL.
  // The STATIC profile says runnability is the test command alone — the
  // provider MUST NOT serve. Outcome 'passed' proves the serve phase never ran:
  // the profile kind, not the file's start script, decides readiness shape.
  const root = seedRepo({
    'test.js': 'process.exit(0);\n',
    'package.json': JSON.stringify({
      name: 'static-looks-served', version: '1.0.0',
      scripts: { test: 'node test.js', start: 'node no-such-server.js' },
    }),
  });
  const { db, provider } = buildProvider({
    root,
    readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'node test.js' } },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('absent readiness profile fails closed', { timeout: 30000 }, async () => {
  // The candidate is perfectly runnable (test + start scripts present), but the
  // sealed product carries NO readiness profile. The provider must fail closed
  // rather than inferring readiness/commands from incidental files.
  const root = fixture({ passing: true });
  const { db, provider } = buildProvider({ root, includeReadiness: false });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'failed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('served/static readiness is not inferred from package.json fields alone', { timeout: 30000 }, async () => {
  // (a) package.json HAS a servable start script, but NO readiness profile is
  //     sealed. Pre-LR-04 file-inference would have treated this as served and
  //     PASSED. The provider MUST fail closed — it does not infer served-ness
  //     from package.json.scripts.start alone.
  const servedLooking = fixture({ passing: true });
  try {
    const a = buildProvider({ root: servedLooking, includeReadiness: false });
    try {
      const resultA = await a.provider.run(RUN_ARGS);
      assert.equal(resultA.outcome, 'failed', 'has-start + no profile must fail closed');
    } finally {
      a.db.close();
    }
  } finally {
    rmSync(servedLooking, { recursive: true, force: true });
  }

  // (b) package.json has NO start script (file-inference would say "not
  //     served"), but the SERVED profile explicitly states the serve command.
  //     The provider MUST serve it — proving the profile, not the file, is the
  //     authority for readiness shape.
  const staticLooking = seedRepo({
    'test.js': 'process.exit(0);\n',
    'server.js': [
      "const http=require('http');",
      "const port=Number(process.env.PORT);",
      "http.createServer((_q,r)=>{r.end('ready')}).listen(port,'127.0.0.1');",
    ].join('\n'),
    'package.json': JSON.stringify({ name: 'no-start-but-served', version: '1.0.0', scripts: { test: 'node test.js' } }),
  });
  try {
    const b = buildProvider({
      root: staticLooking,
      readiness: {
        kind: 'served',
        commands: { installCommand: null, testCommand: 'node test.js' },
        serve: { startCommand: 'node server.js' },
      },
    });
    try {
      const resultB = await b.provider.run(RUN_ARGS);
      assert.equal(resultB.outcome, 'passed', 'no-start + served profile must serve and pass');
    } finally {
      b.db.close();
    }
  } finally {
    rmSync(staticLooking, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// LR-06 — DURABLE + REPLAY-SAFE local readiness evidence. The readiness outcome
// + proof are persisted in factory_check_receipts (the Gate-receipt substrate).
// On any re-query for the same subject + provider — including after a process
// restart — the persisted receipt is returned verbatim. The provider is NOT
// re-invoked and the process is NOT re-spawned. There is no second store: the
// provider only READS receipts; the GateRun driver writes them.
// ---------------------------------------------------------------------------

/**
 * Insert a check receipt for the local-runnability provider, simulating the
 * GateRun driver having recorded one after a prior run.
 */
function insertReadinessReceipt(db, {
  subjectCandidateSetRef = 'candidate-set/test',
  outcome = 'passed',
  evidenceRefs = ['local-readiness:prior-proof-digest'],
  providerId = LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  providerDigest = LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  receiptRef = 'receipt:gate-run:prior:0:factory.local-runnability.v1',
} = {}) {
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref, check_run_ref, subject_candidate_set_ref,
        assessment_candidate_set_refs, provider_id, provider_version,
        provider_digest, environment_ref, outcome, evidence_refs, receipt_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    receiptRef,
    'gate-run:prior',
    subjectCandidateSetRef,
    '[]',
    providerId,
    '1.0.0',
    providerDigest,
    null,
    outcome,
    JSON.stringify(evidenceRefs),
    'prior-receipt-digest',
  );
}

test('LR-06: replay returns the persisted Gate receipt verbatim without re-running the provider', { timeout: 30000 }, async () => {
  // A prior GateRun recorded a 'passed' receipt for this subject. On re-query
  // (e.g. after a restart), the provider MUST return that receipt's outcome +
  // evidence verbatim — it must NOT re-invoke the readiness check or re-spawn
  // the served process.
  //
  // PROOF the provider did not re-run: we seed the receipt, then REMOVE the git
  // fixture directory entirely. If the provider tried to re-run, subject
  // resolution would fail (no repo → 'error'). Getting 'passed' back proves the
  // provider read the persisted receipt and returned it without executing.
  const root = fixture({ passing: true });
  const candidateHash = 'a'.repeat(64);
  const sealedEvidenceRef = 'local-readiness:persisted-proof-aaaa';
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root, candidateHash });
  insertReadinessReceipt(db, {
    outcome: 'passed',
    evidenceRefs: [sealedEvidenceRef],
  });
  // Simulate a restart: destroy the git fixture so a re-run would fail.
  rmSync(root, { recursive: true, force: true });
  try {
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSetsReader('author', candidateHash),
    });
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed', 'must return the persisted outcome');
    assert.deepEqual(result.evidenceRefs, [sealedEvidenceRef],
      'must return the persisted evidence refs verbatim');
  } finally {
    db.close();
  }
});

test('LR-06: replay works across a simulated restart (new provider instance, same durable DB)', { timeout: 30000 }, async () => {
  // Run the provider once (real readiness check), record what the GateRun driver
  // would persist, then simulate a restart: a BRAND-NEW provider instance with
  // the SAME durable DB. The second run MUST return the persisted outcome
  // without re-running — proved by removing the git fixture before the second run.
  const root = fixture({ passing: true });
  const candidateHash = 'b'.repeat(64);
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root, candidateHash });
  const candidateSets = candidateSetsReader('author', candidateHash);
  try {
    // First run: real readiness check against the live git fixture.
    const provider1 = createLocalRunnabilityCheckProvider({ db, candidateSets });
    const firstResult = await provider1.run(RUN_ARGS);
    assert.equal(firstResult.outcome, 'passed');

    // The GateRun driver records a receipt from the provider's result.
    insertReadinessReceipt(db, {
      outcome: firstResult.outcome,
      evidenceRefs: [...firstResult.evidenceRefs],
    });

    // Restart: destroy the git fixture so a re-run would fail.
    rmSync(root, { recursive: true, force: true });

    // New provider instance — same durable DB, empty in-memory state.
    const provider2 = createLocalRunnabilityCheckProvider({ db, candidateSets });
    const replayedResult = await provider2.run(RUN_ARGS);

    // The persisted decision is returned verbatim; the provider did NOT re-run
    // (the fixture is gone — a re-run would have produced 'error').
    assert.equal(replayedResult.outcome, 'passed');
    assert.deepEqual(replayedResult.evidenceRefs, [...firstResult.evidenceRefs],
      'replay must return the exact same evidence refs');
  } finally {
    db.close();
  }
});

test('LR-06: a failed receipt is also replayed verbatim (durable negative evidence)', { timeout: 30000 }, async () => {
  // A prior run produced a 'failed' readiness outcome. On replay, the persisted
  // 'failed' decision is returned — the provider does NOT re-run the failing
  // check. This is the negative-evidence counterpart: once a sealed subject is
  // proven not-ready, that proof is durable.
  const root = fixture({ passing: true });
  const candidateHash = 'c'.repeat(64);
  const failedEvidenceRef = 'local-readiness:failed-proof-bbbb';
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root, candidateHash });
  insertReadinessReceipt(db, {
    outcome: 'failed',
    evidenceRefs: [failedEvidenceRef],
  });
  rmSync(root, { recursive: true, force: true });
  try {
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSetsReader('author', candidateHash),
    });
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'failed', 'must replay the persisted failure');
    assert.deepEqual(result.evidenceRefs, [failedEvidenceRef]);
  } finally {
    db.close();
  }
});

test('LR-06: an error receipt is NOT replayed — indeterminate outcomes are retried', { timeout: 30000 }, async () => {
  // An 'error' receipt represents a subject-resolution or execution failure
  // that may have been transient. It MUST NOT be replayed — the provider
  // re-resolves and re-runs so a transient failure can recover on the next
  // invocation.
  const root = fixture({ passing: true });
  const candidateHash = 'd'.repeat(64);
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root, candidateHash });
  insertReadinessReceipt(db, {
    outcome: 'error',
    evidenceRefs: [],
  });
  try {
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSetsReader('author', candidateHash),
    });
    const result = await provider.run(RUN_ARGS);
    // The git fixture is live and passing, so the re-run produces 'passed'
    // (NOT the stale 'error'). This proves the error receipt was not replayed.
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('LR-06: a receipt for a different provider digest is not replayed', { timeout: 30000 }, async () => {
  // A receipt recorded under a DIFFERENT provider digest (a swapped
  // implementation) must NOT be replayed — the installed implementation must
  // re-run, not inherit a stale receipt from a different version.
  const root = fixture({ passing: true });
  const candidateHash = 'e'.repeat(64);
  const db = newDb();
  insertProduct(db, { repositoryId: 1, root, candidateHash });
  insertReadinessReceipt(db, {
    outcome: 'passed',
    evidenceRefs: ['local-readiness:stale'],
    providerDigest: '0'.repeat(64), // different digest
  });
  try {
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSetsReader('author', candidateHash),
    });
    const result = await provider.run(RUN_ARGS);
    // The stale-digest receipt is not matched; the provider re-runs and produces
    // a fresh 'passed' with fresh evidence (not the stale ref).
    assert.equal(result.outcome, 'passed');
    assert.notDeepEqual(result.evidenceRefs, ['local-readiness:stale']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase-1 dockerization — environment.image on the readiness profile.
// ---------------------------------------------------------------------------

/**
 * Decode the diagnostic code from a 'failed' result's evidence refs. The
 * provider appends a factory-check-diagnostic/v1 ref as evidenceRefs[1] when
 * the outcome is 'failed'; this extracts the `code` field so tests can assert
 * the specific failure category.
 */
function decodeFailedDiagnosticCode(result) {
  for (const ref of result.evidenceRefs) {
    const diag = decodeCheckDiagnostic(ref);
    if (diag) return diag.code;
  }
  return null;
}

test('invalid environment.image on the readiness profile fails closed (profile invalid)', { timeout: 30000 }, async () => {
  // The profile states an environment with an invalid image. The provider MUST
  // reject the whole profile (validateReadinessProfile returns null) and fail
  // closed — it does not guess whether to use docker or host, and it does not
  // silently strip the environment field.
  const root = fixture({ passing: true });
  const cases = [
    { label: 'empty image', readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' }, environment: { image: '' } } },
    { label: 'non-string image', readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' }, environment: { image: 42 } } },
    { label: 'environment not object', readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' }, environment: 'alpine' } },
    { label: 'environment null', readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' }, environment: null } },
    { label: 'served invalid image', readiness: { kind: 'served', commands: { installCommand: null, testCommand: 'npm test' }, serve: { startCommand: 'npm start' }, environment: { image: '' } } },
  ];
  try {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const hash = (i + 10).toString(16).padStart(64, '0');
      const { db, provider } = buildProvider({ root, candidateHash: hash, readiness: c.readiness });
      try {
        const result = await provider.run(RUN_ARGS);
        assert.equal(result.outcome, 'failed', `${c.label} must fail closed`);
        // The diagnostic code is the generic 'local-runnability' because the
        // profile itself is invalid (not a docker substrate failure).
        const code = decodeFailedDiagnosticCode(result);
        assert.equal(code, 'local-runnability', `${c.label} diagnostic code`);
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('valid profile without environment.image uses the host substrate (backwards compatible)', { timeout: 30000 }, async () => {
  // A profile with NO environment field must behave exactly as before Phase-1:
  // host executor, no docker involvement. This is the backwards-compatibility
  // guarantee — existing candidates are unaffected.
  const root = fixture({ passing: true });
  const { db, provider } = buildProvider({ root });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Trust migration: legacy baselines migrate ONLY on the exact
// version→built-in-digest pair (K19 exact trust migration). The digests are
// the authentic historical ones (recovered from the git history of
// candidate-check-contracts.ts); a forged basis on a known version is
// policy drift — the exact-pair battery lives in
// local-runnability-toctou-reprobe.test.mjs (f).
// ---------------------------------------------------------------------------

const AUTHENTIC_1_0_0 = '93b49183279fa1e94d833d8107ef3a894558c6666cad433fd3e1e9659f510dfb';
const AUTHENTIC_1_1_0 = '19dd6a5c10442e694614a7948c6a4efdbd6ddeb32ccba2720af834e2fa6ff278';
const AUTHENTIC_1_4_0 = 'c9a58ea385cde7dec013fc04be7c131df3091ac6ca78eedcacfd08114811a5506';

test('trust migration: existing 1.0.0 row with the exact authentic basis is migrated to the current version', () => {
  // A prior run installed the provider at version 1.0.0 with the EXACT
  // built-in digest 1.0.0 presented (correct category, determinism=full,
  // status=active). Additive bumps UPDATE the trust row in place rather
  // than treating it as drift — but only on the exact version→digest pair.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trusted_providers(
    id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
    category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
  )`);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES(NULL,'factory.local-runnability.v1','1.0.0','deterministic_evidence',
      ?,'full','local-runnability','active')`).run(`built-in:${AUTHENTIC_1_0_0}`);
  ensureLocalRunnabilityProviderTrust(db);
  const row = db.prepare(`SELECT version FROM trusted_providers WHERE name=?`)
    .get('factory.local-runnability.v1');
  assert.equal(row.version, LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
    'the authentic 1.0.0 row must be migrated to the current version');
  db.close();
});

test('trust migration: existing 1.1.0 row with the exact authentic basis is migrated in place', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trusted_providers(
    id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
    category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
  )`);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES(NULL,'factory.local-runnability.v1','1.1.0','deterministic_evidence',
      ?,'full','local-runnability','active')`).run(`built-in:${AUTHENTIC_1_1_0}`);
  ensureLocalRunnabilityProviderTrust(db);
  const row = db.prepare(`SELECT version FROM trusted_providers WHERE name=?`)
    .get('factory.local-runnability.v1');
  assert.equal(row.version, LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION);
  db.close();
});

test('trust migration: existing 1.4.0 row with the exact authentic basis advances to the current provider trust', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trusted_providers(
    id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
    category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
  )`);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES(NULL,'factory.local-runnability.v1','1.4.0','deterministic_evidence',
      ?,'full','local-runnability','active')`).run(`built-in:${AUTHENTIC_1_4_0}`);
  ensureLocalRunnabilityProviderTrust(db);
  const row = db.prepare(`SELECT version,trust_basis FROM trusted_providers WHERE name=?`)
    .get('factory.local-runnability.v1');
  assert.deepEqual(row, {
    version: LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
    trust_basis: `built-in:${LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST}`,
  });
  db.close();
});

test('trust migration: a known legacy version carrying a FORGED basis is drift, never laundered', () => {
  // The laundering shape the exact-pair requirement removes: a 1.1.0 row
  // whose trust_basis is not the digest 1.1.0 actually presented. The
  // version is known, the metadata is perfect — the pair is foreign, so
  // the row drifts instead of being silently re-trusted.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trusted_providers(
    id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
    category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
  )`);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES(NULL,'factory.local-runnability.v1','1.1.0','deterministic_evidence',
      'built-in:foreign-forged-digest','full','local-runnability','active')`).run();
  assert.throws(
    () => ensureLocalRunnabilityProviderTrust(db),
    /LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT/u,
    'a forged basis on a known legacy version fails closed — never migrated, never re-trusted',
  );
  db.close();
});

test('trust migration: 1.0.0 row with tampered determinism still drifts (not migrated)', () => {
  // A 1.0.0 row whose determinism was tampered (none instead of full) is NOT
  // eligible for the additive migration — it drifts. This proves the migration
  // only accepts genuinely trustworthy baseline rows.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trusted_providers(
    id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
    category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
  )`);
  db.prepare(`INSERT INTO trusted_providers
    (project_id,name,version,category,trust_basis,determinism,scope,status)
    VALUES(NULL,'factory.local-runnability.v1','1.0.0','deterministic_evidence',
      'tampered','none','local-runnability','active')`).run();
  assert.throws(
    () => ensureLocalRunnabilityProviderTrust(db),
    /LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT/u,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Docker substrate: fail-closed when daemon is unavailable, e2e when it is.
// ---------------------------------------------------------------------------

const DOCKER_AVAILABLE = isDockerAvailableForReadiness();

test('image declared + docker precondition missing → bounded in-check retry, then typed unknown (CC-GAP-9 / ADR-089)', {
  timeout: 30_000,
  skip: DOCKER_AVAILABLE ? 'docker daemon is available — covered by the e2e test' : false,
}, async () => {
  // The profile declares environment.image=alpine. Docker is NOT running.
  // CC-GAP-9 / ADR-089: the provider retries the environment precondition
  // inside the check up to the frozen bound (3 attempts, 1000ms schedule),
  // then emits the typed unknown `warrant-blocked-environment` outcome —
  // never 'failed' (the product was never exercised) and never 'error'
  // (which the gate would retry forever). Hermetic per-code proofs and the
  // blocking mutations live in local-runnability-substrate-retry.test.mjs.
  const root = fixture({ passing: true });
  const { db, provider } = buildProvider({
    root,
    readiness: {
      kind: 'static',
      commands: { installCommand: null, testCommand: 'echo ok' },
      environment: { image: 'alpine' },
    },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'unknown',
      'docker precondition missing after the frozen retry bound must be typed unknown');
    const code = decodeFailedDiagnosticCode(result);
    assert.equal(code, 'warrant-blocked-environment',
      'diagnostic must carry the frozen ADR-089 unknown vocabulary');
    assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
      'a substrate precondition is not a product defect — no seam repair issue');
    db.close();
  } catch (error) {
    db.close();
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docker e2e: static alpine profile passes in a container', {
  timeout: 120_000,
  skip: DOCKER_AVAILABLE ? false : 'docker daemon not available',
}, async () => {
  // A minimal static profile declaring image=alpine with testCommand 'echo ok'.
  // The provider runs the command inside the alpine container via docker run.
  // Outcome 'passed' proves the docker executor correctly: created the volume,
  // streamed the tree, ran the command in the container, and cleaned up.
  const root = seedRepo({
    'placeholder.txt': 'this file exists so git archive produces a non-empty tree\n',
    'package.json': JSON.stringify({ name: 'docker-e2e', version: '1.0.0' }),
  });
  const { db, provider } = buildProvider({
    root,
    readiness: {
      kind: 'static',
      commands: { installCommand: null, testCommand: 'echo ok' },
      environment: { image: 'alpine' },
    },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('docker e2e: one prepared image conserves install state and isolates test from serve', {
  timeout: 120_000,
  skip: DOCKER_AVAILABLE ? false : 'docker daemon not available',
}, async () => {
  const ownedResources = () => ({
    containers: execFileSync('docker', [
      'ps', '-aq', '--filter', 'label=saga.readiness.session',
    ], { encoding: 'utf8' }).trim().split(/\s+/u).filter(Boolean).sort(),
    images: execFileSync('docker', [
      'images', '-q', '--filter', 'label=saga.readiness.session',
    ], { encoding: 'utf8' }).trim().split(/\s+/u).filter(Boolean).sort(),
  });
  const before = ownedResources();
  const root = seedRepo({
    'index.html': '<!doctype html><title>prepared</title>\n',
  });
  const { db, provider } = buildProvider({
    root,
    readiness: {
      kind: 'served',
      commands: {
        installCommand: 'mkdir -p /opt && printf installed > /opt/saga-installed',
        testCommand: 'test -f /opt/saga-installed && touch /work/test-only',
      },
      serve: {
        startCommand:
          'test -f /opt/saga-installed && test ! -f /work/test-only '
          + '&& exec python3 -m http.server "$PORT" --bind 0.0.0.0 --directory /work',
      },
      environment: { image: 'python:3.11-slim' },
    },
  });
  try {
    const result = await provider.run(RUN_ARGS);
    assert.equal(result.outcome, 'passed', JSON.stringify(result.evidenceRefs));
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(ownedResources(), before,
    'the provider must remove its served container and prepared/base image tags');
});
