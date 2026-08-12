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
} from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import { INTEGRATED_CANDIDATE_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';

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
 */
function insertProduct(db, { repositoryId, root, candidateHash, commitSha, treeHash }) {
  const sealedCommit = commitSha ?? git(root, 'rev-parse', 'HEAD');
  const sealedTree = treeHash ?? git(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare('INSERT INTO project_repositories VALUES (?,?)').run(repositoryId, root);
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
    JSON.stringify({
      candidateHash,
      repositories: [{ projectRepositoryId: repositoryId, commitSha: sealedCommit, treeHash: sealedTree }],
    }),
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

function buildProvider({ root, mode, candidateHash = 'a'.repeat(64), repositoryId = 1 }) {
  const db = newDb();
  insertProduct(db, { repositoryId, root, candidateHash });
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
  // disk, not served). Runnability is proven by `npm test` alone.
  const root = fixture({ testOnly: true });
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
    assert.equal(result, 'error');
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
      assert.equal(result, 'error', `mode=${mode} should fail closed`);
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
      assert.equal(result, 'error', `moving ref "${badAuthority}" must be refused as authority`);
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
      assert.equal(result, 'error', `${c.label} must be refused (fail closed)`);
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
