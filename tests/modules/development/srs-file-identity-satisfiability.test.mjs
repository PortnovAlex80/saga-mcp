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
//
//   Red-Team correction follow-up (2026-08-24), sections 7-10:
//     7. basename-unique MASKING — a multi-segment §2.2 token whose basename
//        coincides with a surface file in a DIFFERENT directory is never
//        re-identified (segment-aligned suffix resolution; §7 also pins the
//        typo'd-prefix boundary `s/engine.js` ≠ `js/engine.js`);
//     8. directory-shaped §D1/§D2 tokens (`js/`) never become file
//        identities and never invent scope authority (non-broadening);
//     9. the empty-scope boundary: manifest present + EMPTY-scope plan is a
//        typed red, never a silent pass;
//     10. registerless grandfather boundary: an ambiguous token fails closed
//         EVEN registerless (documented compatibility reversal) with a
//         truthful, waiver-free, upstream-actionable message; under a
//         register the waiver's impossibility is stated explicitly.
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

test('buildSrsFileIdentityManifest resolves exact, module-relative, ambiguous and off-surface tokens', async () => {
  const { buildSrsFileIdentityManifest } = await import(
    '../../../dist/modules/development/domain/srs-file-identity.js'
  );
  const elite8 = buildSrsFileIdentityManifest(ELITE8_SRS);
  assert.deepEqual(elite8.fileSurface,
    ['e2e/smoke.test.js', 'frontend/index.html', 'package.json']);
  const byToken = new Map(elite8.resolutions.map(r => [r.token, r]));
  // A bare filename is the degenerate (repo-root-relative) module-relative
  // token — single segment, segment-aligned suffix = basename match.
  assert.equal(byToken.get('smoke.test.js')?.resolution, 'module-relative');
  assert.equal(byToken.get('smoke.test.js')?.identityPath, 'e2e/smoke.test.js');
  assert.equal(byToken.get('index.html')?.resolution, 'module-relative');
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
  assert.equal(relative?.resolution, 'module-relative');
  assert.equal(relative?.identityPath, 'js/data/categories.js');

  const ordinary = buildSrsFileIdentityManifest(ORDINARY_SRS);
  assert.equal(
    ordinary.resolutions.find(r => r.token === 'js/engine.js')?.resolution,
    'exact',
  );
});

// ---------------------------------------------------------------------------
// 7. Red-Team masking correction: a multi-segment token whose basename
//    coincides with a surface file but whose DIRECTORY structure does not
//    extend it is NOT re-identified (not-on-surface, as-declared semantics).
// ---------------------------------------------------------------------------

const MASKING_SRS = `# REQ: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`web\` | Browser product | \`admin/index.html\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`frontend/index.html\` | web | The only index.html on the surface |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Product served
  module: web
  files: [frontend/index.html]
  criticality: blocker
\`\`\`
`;

test('masking correction: a basename coincidence across DIFFERENT directories never re-identifies the token', () => {
  // Plan scopes ONLY frontend/ — the §2.2 admin/index.html declaration must
  // surface as a typed coverage gap (as-declared semantics), NOT be silently
  // satisfied through the frontend/index.html basename match.
  const frontendOnly = runProvider({
    items: [implementationItem('impl', { changeScopes: ['frontend/'] })],
    srsContent: MASKING_SRS,
  });
  const diagnostics = diagnosticsOf(frontendOnly);
  const uncovered = diagnostics.find(d => d.code === 'srs-module-uncovered');
  assert.ok(uncovered, 'the masked declaration must stay a typed red');
  assert.match(uncovered.message, /admin\/index\.html/);
  assert.equal(
    diagnostics.some(d => d.code === 'srs-file-identity-conflict'),
    false,
    'a basename coincidence across different directories is not an identity conflict',
  );

  // The lawful satisfying plan scopes the DECLARED path (as-declared
  // semantics for off-surface tokens).
  const asDeclared = runProvider({
    items: [implementationItem('impl', { changeScopes: ['frontend/', 'admin/'] })],
    srsContent: MASKING_SRS,
  });
  assert.equal(asDeclared, 'passed');
});

test('masking correction (unit): suffix segments must align on path-segment boundaries', async () => {
  const { buildSrsFileIdentityManifest } = await import(
    '../../../dist/modules/development/domain/srs-file-identity.js'
  );
  const manifest = buildSrsFileIdentityManifest(`# SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`eng\` | Engine | \`s/engine.js\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`js/engine.js\` | eng | Engine |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Works
  module: eng
  files: [js/engine.js]
  criticality: blocker
\`\`\`
`);
  const typoed = manifest.resolutions.find(r => r.token === 's/engine.js');
  // 's/engine.js' is NOT a segment-aligned suffix of 'js/engine.js' — the
  // token stays off-surface instead of matching on the shared tail string.
  assert.equal(typoed?.resolution, 'not-on-surface');
});

// ---------------------------------------------------------------------------
// 8. Directory-shaped surface tokens (js/): scope vocabulary, never file
//    identity (documented non-broadening).
// ---------------------------------------------------------------------------

const DIRECTORY_TOKEN_SRS = `# REQ: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`app\` | Bootstrap | \`app.js\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`js/\` | app | Module surface directory |
| \`js/app.js\` | app | Bootstrap |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Boots
  module: app
  files: [js/app.js]
  criticality: blocker
\`\`\`
`;

test('directory-shaped §D1/§D2 tokens never become file identities (non-broadening)', async () => {
  const { buildSrsFileIdentityManifest } = await import(
    '../../../dist/modules/development/domain/srs-file-identity.js'
  );
  const { deriveRequiredChangeScopesFromSrs } = await import(
    '../../../dist/modules/development/domain/srs-derived-change-scopes.js'
  );
  const manifest = buildSrsFileIdentityManifest(DIRECTORY_TOKEN_SRS);
  assert.equal(
    manifest.fileSurface.includes('js/'),
    false,
    'a trailing-slash token is scope vocabulary, not a file identity',
  );
  assert.deepEqual(manifest.fileSurface, ['js/app.js']);
  // The bare token still resolves through the REAL file on the surface, and
  // the directory token creates no ambiguity and masks nothing.
  const app = manifest.resolutions.find(r => r.token === 'app.js');
  assert.equal(app?.resolution, 'module-relative');
  assert.equal(app?.identityPath, 'js/app.js');
  assert.equal(manifest.ambiguous.length, 0);

  // An SRS whose ONLY declaration is a directory token derives NOTHING —
  // no scope authority is invented from scope vocabulary.
  const dirOnly = `# REQ: SRS

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`js/\` | app | Module surface directory |
`;
  assert.equal(deriveRequiredChangeScopesFromSrs(dirOnly), null);
});

// ---------------------------------------------------------------------------
// 9. Empty-scope boundary: a manifest-present SRS with an EMPTY-scope plan
//    is a typed red, never a silent pass and never a crash.
// ---------------------------------------------------------------------------

test('empty-scope boundary: no implementation item scopes anything → typed red, not a silent pass', () => {
  const result = runProvider({
    items: [implementationItem('impl', { changeScopes: [] })],
    srsContent: ORDINARY_SRS,
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed');
  const diagnostics = result.evidenceRefs.map(decodeCheckDiagnostic);
  assert.equal(
    diagnostics.some(d => d.code === 'srs-module-uncovered'),
    true,
    'the §2.2 obligation stays visible when nothing is scoped',
  );
});

// ---------------------------------------------------------------------------
// 10. Registerless grandfather boundary (Red-Team correction 2): an
//     ambiguous §2.2 token fails closed EVEN registerless, and the message
//     advertises no impossible waiver.
// ---------------------------------------------------------------------------

test('registerless ambiguity: fail-closed, no waiver advertising, actionable upstream repair', async () => {
  // The default developmentCase() carries no constraint register — the sole
  // ADR-088 grandfather condition.
  const result = runProvider({
    items: [implementationItem('impl', { changeScopes: ['frontend/'] })],
    srsContent: AMBIGUOUS_SRS,
  });
  const diagnostics = diagnosticsOf(result);
  const conflict = diagnostics.find(d => d.code === 'srs-file-identity-conflict');
  assert.ok(conflict, 'registerless corpus still fails the identity conflict closed');
  // Truthful message discipline: no constraint register exists in this
  // corpus, so none may be advertised as a waiver exit.
  assert.doesNotMatch(conflict.message, /waive/i);
  assert.match(conflict.message, /no constraint register/i);
  // The actionable repair names the upstream SRS declaration.
  assert.match(conflict.message, /Repair the SRS §2\.2 declaration upstream/);
  assert.match(conflict.message, /does not depend on the submitted plan/);

  // The compatibility reversal is deliberate and BOUNDED: the same
  // registerless corpus keeps the typed legacy SKIP for a manifest-less SRS
  // (the grandfather survives exactly there and only there).
  const skip = runProvider({
    items: [implementationItem('impl', { changeScopes: ['frontend/'] })],
    srsContent: '# SRS\n\nNo module manifest at all.\n',
  });
  assert.equal(typeof skip, 'object');
  assert.equal(skip.outcome, 'passed');
  const note = decodeCheckDiagnostic(skip.evidenceRefs[0]);
  assert.equal(note.code, 'srs-module-manifest-skip');
});

test('register-bearing ambiguity: same fail-closed conflict, waiver correctly scoped', async () => {
  const { buildOrderConstraintRegister, orderConstraintRegisterRef } = await import(
    '../../../dist/shared/constraint-register.js'
  );
  const { buildSolutionContractConstraintCoverage } = await import(
    '../../../dist/modules/formalization/domain/formalization-schemas.js'
  );
  const register = buildOrderConstraintRegister([
    { class: 'material', text: 'a browser product', evidence_ref: 'order.source_body' },
  ]);
  assert.ok(register);
  const coverage = buildSolutionContractConstraintCoverage({
    constraintRegisterRef: orderConstraintRegisterRef(register),
    constraintRegisterDigest: register.registerDigest,
    constraintRegister: register,
  }, {});
  const registerCase = developmentCase();
  registerCase.solutionContractPayload = { constraintRegisterCoverage: coverage };

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
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(registerCase));
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1,1,?,?,?,?)')
    .run('execution:1', DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      JSON.stringify(proposal([implementationItem('impl', { changeScopes: ['frontend/'] })])),
      'a'.repeat(64));
  const { createDevelopmentTaskGraphCheckProvider } = await import(
    '../../../dist/modules/development/application/development-check-providers.js'
  );
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
    readSrsContent: () => ({ status: 'read', content: AMBIGUOUS_SRS }),
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
  });
  db.close();
  const diagnostics = diagnosticsOf(result);
  const conflict = diagnostics.find(d => d.code === 'srs-file-identity-conflict');
  assert.ok(conflict, 'register-bearing corpus fails the same identity conflict');
  // Under a register the waiver EXPLANATION is lawful (it exists but cannot
  // decide identity) — still no waiver EXIT is advertised.
  assert.match(conflict.message, /cannot waive a file-identity ambiguity/);
  assert.match(conflict.message, /Repair the SRS §2\.2 declaration upstream/);
});
