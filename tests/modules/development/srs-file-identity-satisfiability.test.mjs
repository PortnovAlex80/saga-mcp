// BM-5 / MM-4 repair — §2.2 × §D2/§D1 cross-section file-identity satisfiability.
//
// RED/GREEN regression suite for the Elite-8 counterexample
// (docs/factory-map/BRIDGE_MATRIX.md §4) and the silent
// DEFAULT_REQUIRED_CHANGE_SCOPES fallback:
//
//   RED (proven on the unfixed tree, 2026-08-24):
//     1. an accepted SRS whose §2.2 Module Manifest declares BARE filenames
//        while §D2/§D1 declare the same files as full repository paths admits
//        NO jointly satisfying plan: the correct plan (scopes covering the
//        real full-path files) is rejected `srs-module-uncovered` because the
//        bare §2.2 tokens are compared verbatim under exact-string scope
//        containment. The SRS is frozen upstream — the planner can only burn
//        budget (the Elite-8 death);
//     2. an AMBIGUOUS §2.2 token (two §D2/§D1 files share the basename) is
//        reported as a plan defect (`srs-module-uncovered`) on every plan —
//        the SRS's own identity defect is never attributed;
//     3. `buildReferenceDevelopmentPolicy` silently invents
//        ['package.json','tests/'] scopes when no SRS content is available
//        (fresh project) — authority invented out of nothing.
//
//   GREEN (after the repair — same file, unchanged assertions):
//     1. the Elite-8 SRS + the correct full-path plan PASSES the gate: §2.2
//        tokens are identity-resolved against the canonical §D2/§D1 file
//        surface before coverage evaluation;
//     2. an ambiguous token fails the gate TYPED (`srs-file-identity-conflict`)
//        with the candidate paths as witnesses, PLAN-INDEPENDENTLY, before
//        any implementation worker is spawned;
//     3. the policy snapshot carries EMPTY requiredChangeScopes when nothing
//        is derivable — no invented fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
} = await import('../../../dist/modules/development/domain/development-schemas.js');
const { hashDevelopmentPolicy } = await import(
  '../../../dist/modules/development/domain/development-settlement-policy.js'
);
const { createDevelopmentTaskGraphCheckProvider } = await import(
  '../../../dist/modules/development/application/development-check-providers.js'
);
const { decodeCheckDiagnostic } = await import(
  '../../../dist/process-modules/domain/workplace/check-diagnostic.js'
);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/**
 * The Elite-8 counterexample shape (verbatim class, not bytes): §2.2 declares
 * BARE filenames; §D2 AC Map + §D1 Canonical File Surface declare the SAME
 * files as full repository paths. The §2.5/§3 sections name package.json as
 * a real file (full-path side of the trap).
 */
const ELITE8_SRS = `# REQ: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`smoke\` | End-to-end smoke coverage | \`smoke.test.js\` |
| \`web\` | Browser product | \`index.html\` |

### 2.5 Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Build | npm | scripts in \`package.json\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`frontend/index.html\` | web | Browser product entry |
| \`e2e/smoke.test.js\` | smoke | E2E smoke test |
| \`package.json\` | app | npm manifest |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Browser product is served
  module: web
  files: [frontend/index.html]
  criticality: blocker
- ac: AC-2
  title: Smoke test passes
  module: smoke
  files: [e2e/smoke.test.js]
  criticality: blocker
\`\`\`
`;

/** Ambiguous §2.2 token: TWO §D2/§D1 files share the basename `index.html`. */
const AMBIGUOUS_SRS = `# REQ: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`web\` | Browser product | \`index.html\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`frontend/index.html\` | web | Customer product |
| \`admin/index.html\` | admin | Admin product |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Customer product served
  module: web
  files: [frontend/index.html]
  criticality: blocker
- ac: AC-2
  title: Admin product served
  module: admin
  files: [admin/index.html]
  criticality: blocker
\`\`\`
`;

/** Workshop P07/P08 shape: §2.2 "Owned Surfaces" are MODULE-RELATIVE paths. */
const MODULE_RELATIVE_SRS = `# REQ: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`data/categories\` | Static category definitions | \`data/categories.js\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`js/data/categories.js\` | data/categories | Category data |
| \`js/app.js\` | app | Bootstrap |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Category selection works
  module: data/categories
  files: [js/data/categories.js]
  criticality: blocker
\`\`\`
`;

/**
 * Ordinary non-game product with NO cross-section mismatch: §2.2 tokens are
 * exactly the §D1/§D2 full paths. Coverage semantics must be unchanged for
 * this class (both the pass and the genuine-gap rejection).
 */
const ORDINARY_SRS = `# REQ: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`engine\` | Conversion engine | \`js/engine.js\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`js/engine.js\` | engine | Conversion engine |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Conversion works
  module: engine
  files: [js/engine.js]
  criticality: blocker
\`\`\`
`;

function developmentCase() {
  const policySeed = { id: 'policy', version: '1.0.0', contentHash: '' };
  return {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 1,
    formalizationCertificate: {
      schema: 'cert', ref: 'cert:1', hash: '1'.repeat(64), decision: 'formalized',
    },
    solutionContract: { schema: 'contract', ref: 'contract:1', hash: '2'.repeat(64) },
    acceptanceBaselineHash: '3'.repeat(64),
    srs: { schema: 'srs', ref: 'artifact:55', hash: '4'.repeat(64) },
    acceptanceCriteria: [
      { artifactId: 11, code: 'AC-1', acceptedHash: '5'.repeat(64), implementationRequired: true, criticality: 'blocker' },
      { artifactId: 12, code: 'AC-2', acceptedHash: '6'.repeat(64), implementationRequired: true, criticality: 'blocker' },
    ],
    repositories: [{ projectRepositoryId: 1, integrationBranch: 'dev', expectedBaseCommit: 'abc' }],
    policy: { ...policySeed, contentHash: hashDevelopmentPolicy(policySeed) },
    initiatedBy: 'test',
  };
}

function implementationItem(key, extra = {}) {
  return {
    key,
    kind: 'implementation',
    taskKind: 'development.code',
    executionSkill: 'saga-worker',
    executionMode: 'git_change',
    projectRepositoryId: 1,
    acceptanceCriterionKeys: ['11:AC-1', '12:AC-2'],
    dependsOnKeys: [],
    changeScopes: [],
    required: true,
    criticality: 'blocker',
    ...extra,
  };
}

function proposal(items) {
  return {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: items,
    verificationItems: ['11:AC-1', '12:AC-2'].map(id => ({
      key: `verify-${id}`,
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: 1,
      acceptanceCriterionKeys: [id],
      dependsOnKeys: [items[0]?.key ?? 'impl'],
      changeScopes: [],
      required: true,
      criticality: 'blocker',
    })),
    integrationTargets: [{
      projectRepositoryId: 1,
      sourceWorkItemKeys: items.filter(item => item.required).map(item => item.key),
      targetBranch: 'dev',
      expectedBaseCommit: 'abc',
    }],
  };
}

function runProvider({ items, srsContent }) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, process_run_id INTEGER, execution_id TEXT,
      schema_version TEXT, payload_snapshot TEXT, content_hash TEXT
    );
    CREATE TABLE factory_process_runs (
      id INTEGER PRIMARY KEY, input_schema TEXT, input_snapshot TEXT
    );
  `);
  db.prepare('INSERT INTO factory_process_runs VALUES (1,?,?)')
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(developmentCase()));
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1,1,?,?,?,?)')
    .run('execution:1', DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      JSON.stringify(proposal(items)), 'a'.repeat(64));
  const provider = createDevelopmentTaskGraphCheckProvider({
    db,
    candidateSets: { read: () => ({
      role: 'author',
      members: [{
        productRef: {
          schemaId: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
          ref: 'managed-node-submission:1',
          digest: 'a'.repeat(64),
        },
      }],
    }) },
    readSrsContent: () => ({ status: 'read', content: srsContent }),
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
  });
  db.close();
  return result;
}

function diagnosticsOf(result) {
  assert.equal(typeof result, 'object', 'expected a receipted gate result');
  assert.equal(result.outcome, 'failed');
  return result.evidenceRefs.map(decodeCheckDiagnostic);
}

// ---------------------------------------------------------------------------
// 1. The Elite-8 counterexample: the CORRECT plan must PASS (was RED).
// ---------------------------------------------------------------------------

test('Elite-8 shape: a plan scoping the REAL §D2/§D1 full-path files passes the §2.2 manifest gate', () => {
  const result = runProvider({
    items: [implementationItem('impl', { changeScopes: ['e2e/', 'frontend/', 'package.json', 'tests/'] })],
    srsContent: ELITE8_SRS,
  });
  assert.equal(result, 'passed',
    'the bare §2.2 tokens (smoke.test.js, index.html) must be identity-resolved '
    + 'against the §D2/§D1 surface (e2e/smoke.test.js, frontend/index.html) '
    + 'before coverage — the plan that scopes the real files satisfies §2.2');
});

test('Elite-8 shape: a headless plan that drops the frontend entirely is still rejected', () => {
  const result = runProvider({
    items: [implementationItem('impl', { changeScopes: ['e2e/', 'package.json', 'tests/'] })],
    srsContent: ELITE8_SRS,
  });
  const diagnostics = diagnosticsOf(result);
  const uncovered = diagnostics.find(d => d.code === 'srs-module-uncovered');
  assert.ok(uncovered, 'the genuinely uncovered module file is still a typed red');
  assert.match(uncovered.message, /frontend\/index\.html/);
});

// ---------------------------------------------------------------------------
// 2. Ambiguous identity: typed, plan-independent, pre-workers.
// ---------------------------------------------------------------------------

test('ambiguous §2.2 basename fails TYPED as an SRS identity conflict with named witnesses', () => {
  for (const scopes of [
    ['frontend/', 'admin/'],
    ['frontend/', 'admin/', 'index.html'],
    ['src/'],
  ]) {
    const result = runProvider({
      items: [implementationItem('impl', { changeScopes: scopes })],
      srsContent: AMBIGUOUS_SRS,
    });
    const diagnostics = diagnosticsOf(result);
    const conflict = diagnostics.find(d => d.code === 'srs-file-identity-conflict');
    assert.ok(conflict,
      `scopes [${scopes.join(', ')}]: the identity conflict must be attributed to the SRS, not the plan`);
    assert.match(conflict.message, /index\.html/);
    assert.match(conflict.message, /frontend\/index\.html/);
    assert.match(conflict.message, /admin\/index\.html/);
    assert.equal(
      diagnostics.some(d => d.code === 'srs-module-uncovered'),
      false,
      'a plan-coverage verdict over an undecidable identity must not also be emitted',
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Module-relative §2.2 surfaces resolve to the canonical full path (P08).
// ---------------------------------------------------------------------------

test('workshop P08 shape: module-relative §2.2 surface resolves against §D1/§D2 and passes', () => {
  const result = runProvider({
    items: [implementationItem('impl', { changeScopes: ['js/', 'tests/'] })],
    srsContent: MODULE_RELATIVE_SRS,
  });
  assert.equal(result, 'passed');
});

// ---------------------------------------------------------------------------
// 4. Ordinary non-game product: unchanged semantics both directions.
// ---------------------------------------------------------------------------

test('ordinary product: exact-match tokens keep the pass and the genuine-gap rejection unchanged', () => {
  const pass = runProvider({
    items: [implementationItem('impl', { changeScopes: ['js/', 'tests/'] })],
    srsContent: ORDINARY_SRS,
  });
  assert.equal(pass, 'passed');

  const gap = runProvider({
    items: [implementationItem('impl', { changeScopes: ['docs/', 'tests/'] })],
    srsContent: ORDINARY_SRS,
  });
  const diagnostics = diagnosticsOf(gap);
  const uncovered = diagnostics.find(d => d.code === 'srs-module-uncovered');
  assert.ok(uncovered, 'an uncovered declared module file stays a typed red');
  assert.match(uncovered.message, /js\/engine\.js/);
});

// ---------------------------------------------------------------------------
// 5. No invented policy fallback.
// ---------------------------------------------------------------------------

test('buildReferenceDevelopmentPolicy invents NO scopes when no SRS content is available', async () => {
  const { buildReferenceDevelopmentPolicy } = await import(
    '../../../dist/app/start-product-lifecycle-from-idea.js'
  );
  for (const absent of [undefined, null, '', '   \n\t ']) {
    const policy = buildReferenceDevelopmentPolicy(absent);
    assert.deepEqual(
      policy.requiredChangeScopes,
      [],
      `SRS content ${JSON.stringify(absent)}: requiredChangeScopes must be EMPTY, never invented`,
    );
    assert.equal(hashDevelopmentPolicy(policy), policy.contentHash);
  }
});

test('buildReferenceDevelopmentPolicy still derives real scopes from an SRS file surface', async () => {
  const { buildReferenceDevelopmentPolicy } = await import(
    '../../../dist/app/start-product-lifecycle-from-idea.js'
  );
  const policy = buildReferenceDevelopmentPolicy(ELITE8_SRS);
  assert.deepEqual(policy.requiredChangeScopes, ['e2e/', 'frontend/', 'package.json', 'tests/']);
  assert.equal(hashDevelopmentPolicy(policy), policy.contentHash);
});

// ---------------------------------------------------------------------------
// 6. The canonical manifest unit surface (identity vocabulary itself).
// ---------------------------------------------------------------------------

test('buildSrsFileIdentityManifest resolves exact, basename-unique, ambiguous and off-surface tokens', async () => {
  const { buildSrsFileIdentityManifest } = await import(
    '../../../dist/modules/development/domain/srs-file-identity.js'
  );
  const elite8 = buildSrsFileIdentityManifest(ELITE8_SRS);
  assert.deepEqual(elite8.fileSurface,
    ['e2e/smoke.test.js', 'frontend/index.html', 'package.json']);
  const byToken = new Map(elite8.resolutions.map(r => [r.token, r]));
  assert.equal(byToken.get('smoke.test.js')?.resolution, 'basename-unique');
  assert.equal(byToken.get('smoke.test.js')?.identityPath, 'e2e/smoke.test.js');
  assert.equal(byToken.get('index.html')?.resolution, 'basename-unique');
  assert.equal(byToken.get('index.html')?.identityPath, 'frontend/index.html');
  assert.equal(elite8.ambiguous.length, 0);

  const ambiguous = buildSrsFileIdentityManifest(AMBIGUOUS_SRS);
  assert.equal(ambiguous.ambiguous.length, 1);
  assert.equal(ambiguous.ambiguous[0].token, 'index.html');
  assert.deepEqual(ambiguous.ambiguous[0].candidates,
    ['admin/index.html', 'frontend/index.html']);
  assert.equal(ambiguous.resolutions.find(r => r.token === 'index.html')?.identityPath
    ?? null, null);

  const offSurface = buildSrsFileIdentityManifest(MODULE_RELATIVE_SRS);
  const relative = offSurface.resolutions.find(r => r.token === 'data/categories.js');
  assert.equal(relative?.resolution, 'basename-unique');
  assert.equal(relative?.identityPath, 'js/data/categories.js');

  const ordinary = buildSrsFileIdentityManifest(ORDINARY_SRS);
  assert.equal(
    ordinary.resolutions.find(r => r.token === 'js/engine.js')?.resolution,
    'exact',
  );
});
