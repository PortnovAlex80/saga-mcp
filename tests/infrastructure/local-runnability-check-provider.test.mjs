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

function providerFor(root) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_repositories(id INTEGER PRIMARY KEY, local_path TEXT);
    CREATE TABLE factory_process_products(
      process_run_id INTEGER, product_kind TEXT, payload_snapshot TEXT
    );
  `);
  const commitSha = git(root, 'rev-parse', 'HEAD');
  const treeHash = git(root, 'rev-parse', 'HEAD^{tree}');
  const candidateHash = 'a'.repeat(64);
  db.prepare('INSERT INTO project_repositories VALUES (1,?)').run(root);
  db.prepare('INSERT INTO factory_process_products VALUES (1,?,?)').run(
    'development.integrated-candidate',
    JSON.stringify({
      candidateHash,
      repositories: [{ projectRepositoryId: 1, commitSha, treeHash }],
    }),
  );
  const candidateSets = {
    read(ref) {
      return ref === 'candidate-set/test' ? {
        candidateSetRef: ref,
        role: 'author',
        workplaceRef: { processRunId: 1, moduleName: 'solution-development',
          moduleVersion: '1.1.0', cellId: 'development-verification', workKey: 'AC-1' },
        members: [], producerExecutionRef: 'worker-execution:test',
      } : null;
    },
  };
  return { db, provider: createLocalRunnabilityCheckProvider({ db, candidateSets }) };
}

test('exact frozen candidate must test, start, answer loopback and stop', { timeout: 30000 }, async () => {
  const root = fixture();
  const { db, provider } = providerFor(root);
  try {
    const result = await provider.run({
      subjectCandidateSetRef: 'candidate-set/test', parameters: {},
      environmentRef: null, candidateSnapshot: {},
    });
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
    const { db, provider } = providerFor(root);
    try {
      const result = await provider.run({
        subjectCandidateSetRef: 'candidate-set/test', parameters: {},
        environmentRef: null, candidateSnapshot: {},
      });
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
  const { db, provider } = providerFor(root);
  try {
    const result = await provider.run({
      subjectCandidateSetRef: 'candidate-set/test', parameters: {},
      environmentRef: null, candidateSnapshot: {},
    });
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
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
