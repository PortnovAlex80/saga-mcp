// ADR-088 (CC-GAP-6) — register-conditional synthesis coverage: the four
// blocking mutations of the Elite-6 product-claim defect, plus the legacy
// registerless positives.
//
// The Elite-6 shape being closed mechanically (CC-00C
// CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md):
//   - an ordered browser-product claim (execution-class constraint with a
//     declared entrypoint, the missing index.html) reached terminal while no
//     item owned whole-product synthesis;
//   - AC-22 existed and was only NOMINALLY attached to an item whose scopes
//     could not own the claim;
//   - the SRS §2.2 manifest obligation could be dodged by omitting the
//     section (an unconditional legacy skip);
//   - the planner could forge coveredConstraintIds on proposal items.
//
// Mutations (each must make this file's group red when the fix is reversed):
//   a. drop whole-product synthesis coverage while keeping the criterion
//      nominally attached — the reverse diff fails planning admission with
//      the typed reason `constraint-register-uncovered`;
//   b. under a non-empty register, remove the §2.2 manifest (absent,
//      file-less, or unavailable SRS) — typed red
//      `srs-module-manifest-missing`, never `srs-module-manifest-skip`;
//   c. attach a wide decoy item whose change scopes contain the
//      execution-class entrypoint file while covering no such constraint —
//      typed red `constraint-entrypoint-unowned` (the conjunction on ONE
//      item: covering AND owning);
//   d. inject a planner-proposed coveredConstraintIds set — the
//      kernel-derived relay is unchanged (the forged set cannot reach the
//      frozen item or the reverse diff).
//
// Positives: the SOLE grandfather condition is the registerless corpus —
// empty diff, typed legacy skip, green gates; frozen legacy cases (no relay)
// behave identically; a fully-waived register is empty for enforcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  resolveDevelopmentConstraintRegisterCoverage,
} = await import('../../../dist/modules/development/domain/development-schemas.js');
const { hashDevelopmentPolicy, ReferenceDevelopmentTaskGraphPolicy } = await import(
  '../../../dist/modules/development/domain/development-settlement-policy.js'
);
const {
  buildCanonicalDevelopmentTaskGraph,
  decodeDevelopmentTaskGraphProposal,
} = await import(
  '../../../dist/modules/development/domain/development-task-graph.js'
);
const { createDevelopmentTaskGraphCheckProvider } = await import(
  '../../../dist/modules/development/application/development-check-providers.js'
);
const { decodeCheckDiagnostic } = await import(
  '../../../dist/process-modules/domain/workplace/check-diagnostic.js'
);
const { buildSolutionContractConstraintCoverage } = await import(
  '../../../dist/modules/formalization/domain/formalization-schemas.js'
);
const {
  buildOrderConstraintRegister,
  orderConstraintRegisterRef,
} = await import('../../../dist/shared/constraint-register.js');

// ---------------------------------------------------------------------------
// Elite-6-shaped fixtures.
// ---------------------------------------------------------------------------

/** The Elite-6 order's counted deliverable claim. */
const ELITE6_REGISTER_DRAFTS = [
  {
    class: 'execution',
    text: 'npm install plus npm start lead to an accessible running browser product',
    evidence_ref: 'order.source_body',
    entrypoint_files: ['index.html'],
  },
  {
    class: 'material',
    text: 'TypeScript sources',
    evidence_ref: 'order.source_body',
  },
];

function elite6Coverage({ waivedIds = [] } = {}) {
  const register = buildOrderConstraintRegister(ELITE6_REGISTER_DRAFTS);
  assert.ok(register);
  return buildSolutionContractConstraintCoverage({
    constraintRegisterRef: orderConstraintRegisterRef(register),
    constraintRegisterDigest: register.registerDigest,
    constraintRegister: register,
  }, Object.fromEntries(waivedIds.map(id => [
    id,
    { disposition: 'waived', reason: 'operator: out of scope' },
  ])));
}

/**
 * A register-bearing DevelopmentCase shaped like Elite-6: AC-1 is the
 * nominal-attachment criterion (impl item references it), AC-2 covers the
 * material constraint. Whether AC-1 covers ord-c-001 is the mutation knob.
 */
function developmentCase({ coverage, acCoverage } = {}) {
  const policySeed = { id: 'policy', version: '1.0.0', contentHash: '' };
  return {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 1,
    formalizationCertificate: {
      schema: 'cert', ref: 'cert:1', hash: '1'.repeat(64), decision: 'formalized',
    },
    solutionContract: { schema: 'contract', ref: 'contract:1', hash: '2'.repeat(64) },
    ...(coverage
      ? { solutionContractPayload: { constraintRegisterCoverage: coverage } }
      : {}),
    acceptanceBaselineHash: '3'.repeat(64),
    srs: { schema: 'srs', ref: 'artifact:55', hash: '4'.repeat(64) },
    acceptanceCriteria: [
      {
        artifactId: 11,
        code: 'AC-1',
        acceptedHash: '5'.repeat(64),
        implementationRequired: true,
        criticality: 'blocker',
        ...(acCoverage ? { coveredConstraintIds: acCoverage } : {}),
      },
      {
        artifactId: 12,
        code: 'AC-2',
        acceptedHash: '6'.repeat(64),
        implementationRequired: true,
        criticality: 'blocker',
        coveredConstraintIds: ['ord-c-002'],
      },
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
    changeScopes: ['src/', 'data/domain/tests', 'package.json'],
    required: true,
    criticality: 'blocker',
    ...extra,
  };
}

function verificationItems() {
  return ['11:AC-1', '12:AC-2'].map(id => ({
    key: `verify-${id}`,
    kind: 'verification',
    taskKind: 'verification.ac',
    executionSkill: 'saga-verifier',
    executionMode: 'read_only_evidence',
    projectRepositoryId: 1,
    acceptanceCriterionKeys: [id],
    dependsOnKeys: ['impl'],
    changeScopes: [],
    required: true,
    criticality: 'blocker',
  }));
}

function proposal(implementationItems) {
  return {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems,
    verificationItems: verificationItems(),
    integrationTargets: [{
      projectRepositoryId: 1,
      sourceWorkItemKeys: implementationItems
        .filter(item => item.required).map(item => item.key),
      targetBranch: 'dev',
      expectedBaseCommit: 'abc',
    }],
  };
}

function buildGraph(inputCase, items) {
  return buildCanonicalDevelopmentTaskGraph(inputCase, proposal(items), {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:1',
    hash: '7'.repeat(64),
  });
}

function validate(inputCase, items) {
  return new ReferenceDevelopmentTaskGraphPolicy().validate(inputCase, buildGraph(inputCase, items));
}

const MANIFEST_SRS = `### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`app\` | Application bootstrap | \`index.html\`, \`src/app.js\` |

### 2.3 Port Registry
`;

const MANIFEST_LESS_SRS = '# SRS\n\n## §2 Architecture\n\nNo module manifest here.\n';
const FILE_LESS_MANIFEST_SRS = '### 2.2 Module Manifest\n\nOnly prose, no files.\n\n### 2.3 Port Registry\n';

function runProvider({ inputCase, items, srs }) {
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
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(inputCase));
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
    readSrsContent: () => srs,
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
  });
  db.close();
  return result;
}

// ---------------------------------------------------------------------------
// Mutation (a): the reverse diff — nominal attachment satisfies nothing.
// ---------------------------------------------------------------------------

test('MUTATION a: uncovered execution constraint behind a nominally attached criterion fails admission', () => {
  const inputCase = developmentCase({ coverage: elite6Coverage() });
  // AC-1 (the AC-22 analog) references the impl item (nominal attachment)
  // but carries NO coveredConstraintIds; ord-c-001 stays uncovered.
  const result = validate(inputCase, [implementationItem('impl')]);
  assert.equal(result.valid, false, 'the reverse diff must fail planning admission');
  assert.equal(result.reasonCodes.includes('constraint-register-uncovered'), true);
  const message = result.errors.find(error => error.includes('uncovered constraint ids'));
  assert.ok(message);
  assert.match(message, /ord-c-001/);
  assert.doesNotMatch(message, /ord-c-002/, 'the covered material constraint is not a gap');
});

test('MUTATION a (positive): covering the constraint from the frozen criterion closes the diff', () => {
  const inputCase = developmentCase({
    coverage: elite6Coverage(),
    acCoverage: ['ord-c-001'],
  });
  const result = validate(inputCase, [
    implementationItem('impl', { changeScopes: ['src/', 'data/domain/tests', 'package.json', 'index.html'] }),
  ]);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('MUTATION a (provider): the reverse-diff red reaches the gate receipt as a typed diagnostic', () => {
  const result = runProvider({
    inputCase: developmentCase({ coverage: elite6Coverage() }),
    items: [implementationItem('impl')],
    srs: { status: 'read', content: MANIFEST_SRS },
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed');
  const diagnostics = result.evidenceRefs.map(decodeCheckDiagnostic);
  assert.equal(diagnostics.some(d => d.code === 'constraint-register-uncovered'), true);
  // One-shot repair: the SRS-manifest obligation rides the same receipt.
  assert.equal(diagnostics.some(d => d.code === 'srs-module-uncovered'), true);
});

test('waived constraints are subtracted before the red decision (typed waiver = the only escape hatch)', () => {
  const inputCase = developmentCase({
    coverage: elite6Coverage({ waivedIds: ['ord-c-001'] }),
  });
  const result = validate(inputCase, [
    implementationItem('impl', { changeScopes: ['src/', 'data/domain/tests', 'package.json'] }),
  ]);
  assert.equal(result.reasonCodes.includes('constraint-register-uncovered'), false);
  assert.equal(result.reasonCodes.includes('constraint-entrypoint-unowned'), false,
    'a waived entry is empty for enforcement — no contradictory red');
  assert.equal(result.valid, true, result.errors.join('; '));
});

// ---------------------------------------------------------------------------
// Mutation (b): register-conditional §2.2 manifest red, never a skip.
// ---------------------------------------------------------------------------

test('MUTATION b: absent §2.2 under a non-empty register is typed red, never a skip', () => {
  const result = runProvider({
    inputCase: developmentCase({
      coverage: elite6Coverage(),
      acCoverage: ['ord-c-001'],
    }),
    items: [implementationItem('impl', { changeScopes: ['src/', 'index.html', 'package.json'] })],
    srs: { status: 'read', content: MANIFEST_LESS_SRS },
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'srs-module-manifest-missing');
  assert.match(diagnostic.message, /non-empty constraint register/);
});

test('MUTATION b: file-less §2.2 under a non-empty register is typed red', () => {
  const result = runProvider({
    inputCase: developmentCase({
      coverage: elite6Coverage(),
      acCoverage: ['ord-c-001'],
    }),
    items: [implementationItem('impl', { changeScopes: ['src/', 'index.html', 'package.json'] })],
    srs: { status: 'read', content: FILE_LESS_MANIFEST_SRS },
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed');
  assert.equal(decodeCheckDiagnostic(result.evidenceRefs[0]).code, 'srs-module-manifest-missing');
});

test('MUTATION b: unavailable SRS under a non-empty register is typed red', () => {
  const result = runProvider({
    inputCase: developmentCase({
      coverage: elite6Coverage(),
      acCoverage: ['ord-c-001'],
    }),
    items: [implementationItem('impl', { changeScopes: ['src/', 'index.html', 'package.json'] })],
    srs: { status: 'unavailable', reason: 'SRS artifact 55 has no repository binding' },
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'srs-module-manifest-missing');
  assert.match(diagnostic.message, /no repository binding/);
});

// ---------------------------------------------------------------------------
// Mutation (c): the decoy — file ownership WITHOUT constraint coverage.
// ---------------------------------------------------------------------------

test('MUTATION c: a wide decoy item containing the entrypoint while covering no such constraint fails ownership', () => {
  // The Elite-6 shape exactly: `impl-galaxy-ship-foundation` — wide scopes
  // containing index.html, nominally attached via AC-1... but the criterion
  // covers no constraint (no frozen coverage), so the ONLY item contains the
  // file while owning nothing.
  const decoyCase = developmentCase({ coverage: elite6Coverage() });
  const result = validate(decoyCase, [
    implementationItem('impl', { changeScopes: ['src/', 'index.html', 'package.json'] }),
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.reasonCodes.includes('constraint-entrypoint-unowned'), true);
  const message = result.errors.find(error => error.includes('entrypoint files not owned'));
  assert.ok(message);
  assert.match(message, /ord-c-001:index\.html/);
  assert.match(message, /kernel-derived coveredConstraintIds/);
});

test('MUTATION c (positive conjunction): one item BOTH covering the constraint AND owning the file passes', () => {
  const inputCase = developmentCase({
    coverage: elite6Coverage(),
    acCoverage: ['ord-c-001'],
  });
  const result = validate(inputCase, [
    implementationItem('impl', { changeScopes: ['src/', 'index.html', 'package.json'] }),
  ]);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('MUTATION c (second half): a covering item owning NONE of the declared files does not satisfy it', () => {
  const inputCase = developmentCase({
    coverage: elite6Coverage(),
    acCoverage: ['ord-c-001'],
  });
  // The covering item owns data/domain/tests + package.json only; a wide
  // DECOY contains index.html. No single item does both — red (the exact
  // Elite-6 AC-22 attachment shape: scopes package.json + data/domain/tests).
  const result = validate(inputCase, [
    implementationItem('impl', {
      changeScopes: ['package.json', 'data/domain/tests'],
    }),
    implementationItem('bootstrap-decoy', {
      key: 'bootstrap-decoy',
      acceptanceCriterionKeys: [],
      changeScopes: ['index.html', 'static/'],
    }),
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.reasonCodes.includes('constraint-entrypoint-unowned'), true);
});

// ---------------------------------------------------------------------------
// Mutation (d): the forge — planner-supplied coveredConstraintIds.
// ---------------------------------------------------------------------------

test('MUTATION d: a forged coveredConstraintIds set cannot reach the frozen item (canonicalization derives unconditionally)', () => {
  const inputCase = developmentCase({ coverage: elite6Coverage() });
  const forged = proposal([implementationItem('impl')]);
  // Bypass the decode boundary the way any in-process caller could: attach a
  // forged set directly to the typed proposal value.
  (forged.implementationItems[0]).coveredConstraintIds = ['ord-c-001', 'ord-c-002'];
  const graph = buildCanonicalDevelopmentTaskGraph(inputCase, forged, {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:1',
    hash: '7'.repeat(64),
  });
  // The relay is EXACTLY the kernel-derived union over the frozen criteria
  // (AC-2 covers ord-c-002; nothing covers ord-c-001). The forged
  // ord-c-001 must NOT survive canonicalization.
  assert.deepEqual(
    graph.implementationItems[0].coveredConstraintIds,
    ['ord-c-002'],
    'the relay carries only the kernel-derived set — the forged ord-c-001 is discarded',
  );
  // And the reverse diff still sees the uncovered constraint.
  const result = new ReferenceDevelopmentTaskGraphPolicy().validate(inputCase, graph);
  assert.equal(result.reasonCodes.includes('constraint-register-uncovered'), true);
});

test('MUTATION d: decode trims a planner-echoed coveredConstraintIds field (proposals are trimmed, not failed)', () => {
  const payload = proposal([implementationItem('impl')]);
  payload.implementationItems[0].coveredConstraintIds = ['ord-c-999'];
  const decoded = decodeDevelopmentTaskGraphProposal(payload);
  assert.equal(decoded.ok, true, 'decode discards the field mechanically — no planner friction');
  assert.equal('coveredConstraintIds' in decoded.value.implementationItems[0], false);
});

test('MUTATION d (sharpest): a forged set on an item whose criteria carry NO coverage cannot reach the frozen item or the reverse diff', () => {
  // ADR-088 defect 3, exact shape: the pre-GAP-6 canonicalization overrode
  // coveredConstraintIds only when the inherited union was NON-empty, so a
  // planner-supplied set survived the spread precisely when the referenced
  // criteria carried no coverage — the forge could green the reverse diff.
  // This mutation must redden when the unconditional strip is reversed.
  const inputCase = developmentCase({ coverage: elite6Coverage() });
  const forged = proposal([
    implementationItem('impl', { acceptanceCriterionKeys: ['11:AC-1'] }),
  ]);
  forged.implementationItems[0].coveredConstraintIds = ['ord-c-001', 'ord-c-002'];
  const graph = buildCanonicalDevelopmentTaskGraph(inputCase, forged, {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:1',
    hash: '7'.repeat(64),
  });
  assert.equal(
    'coveredConstraintIds' in graph.implementationItems[0],
    false,
    'the forged set is discarded — no inherited coverage exists to relay',
  );
  const result = new ReferenceDevelopmentTaskGraphPolicy().validate(inputCase, graph);
  assert.equal(
    result.reasonCodes.includes('constraint-register-uncovered'),
    true,
    'the reverse diff stays red — the forge cannot green it',
  );
});

test('MUTATION d (provider): a forged set in the submitted proposal cannot green the reverse diff', () => {
  const inputCase = developmentCase({ coverage: elite6Coverage() });
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
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(inputCase));
  const forgedPayload = proposal([implementationItem('impl')]);
  forgedPayload.implementationItems[0].coveredConstraintIds = ['ord-c-001'];
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1,1,?,?,?,?)')
    .run('execution:1', DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      JSON.stringify(forgedPayload), 'a'.repeat(64));
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
    readSrsContent: () => ({ status: 'read', content: MANIFEST_SRS }),
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
  });
  db.close();
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed', 'the forged relay cannot forge the diff green');
  assert.equal(
    result.evidenceRefs.map(decodeCheckDiagnostic)
      .some(d => d.code === 'constraint-register-uncovered'),
    true,
  );
});

// ---------------------------------------------------------------------------
// Legacy registerless positives — the SOLE grandfather condition.
// ---------------------------------------------------------------------------

test('POSITIVE (registerless): no register → no reds, manifest-less SRS keeps the typed legacy skip', () => {
  const result = runProvider({
    inputCase: developmentCase(),
    items: [implementationItem('impl')],
    srs: { status: 'read', content: MANIFEST_LESS_SRS },
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'passed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'srs-module-manifest-skip');
});

test('POSITIVE (registerless): unavailable SRS keeps the typed legacy skip', () => {
  const result = runProvider({
    inputCase: developmentCase(),
    items: [implementationItem('impl')],
    srs: { status: 'unavailable', reason: 'no repository binding' },
  });
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'passed');
  assert.equal(decodeCheckDiagnostic(result.evidenceRefs[0]).code, 'srs-module-manifest-skip');
});

test('POSITIVE (legacy mapped case): a payload predating the relay resolves registerless and stays green', () => {
  const legacyCase = developmentCase();
  legacyCase.solutionContractPayload = {
    schemaVersion: 'factory.solution-contract-certificate.v1',
    acceptanceCriteria: [],
  };
  assert.equal(resolveDevelopmentConstraintRegisterCoverage(legacyCase), null);
  const result = validate(legacyCase, [implementationItem('impl')]);
  assert.equal(result.valid, true, result.errors.join('; '));
  const providerResult = runProvider({
    inputCase: legacyCase,
    items: [implementationItem('impl')],
    srs: { status: 'read', content: MANIFEST_LESS_SRS },
  });
  assert.equal(typeof providerResult, 'object');
  assert.equal(providerResult.outcome, 'passed');
  assert.equal(
    decodeCheckDiagnostic(providerResult.evidenceRefs[0]).code,
    'srs-module-manifest-skip',
  );
});

test('POSITIVE (registerless): canonical items relay exactly the frozen criteria — nothing inherited from a register', () => {
  const graph = buildGraph(developmentCase(), [implementationItem('impl')]);
  // The relay is criterion-derived only: AC-2's ord-c-002 rides the item
  // because the item references AC-2 — the register (which the case does not
  // carry) contributes nothing.
  assert.deepEqual(graph.implementationItems[0].coveredConstraintIds, ['ord-c-002']);
});

// ---------------------------------------------------------------------------
// Fail-closed resolver: a present-but-malformed block is never a silent
// return to grandfathering.
// ---------------------------------------------------------------------------

test('a malformed coverage block fails closed (never silent grandfathering)', () => {
  const broken = developmentCase();
  broken.solutionContractPayload = { constraintRegisterCoverage: { entries: [] } };
  assert.throws(
    () => resolveDevelopmentConstraintRegisterCoverage(broken),
    /DEVELOPMENT_CONSTRAINT_COVERAGE_INVALID/,
  );
  const brokenProvider = runProvider({
    inputCase: broken,
    items: [implementationItem('impl')],
    srs: { status: 'read', content: MANIFEST_SRS },
  });
  assert.equal(brokenProvider, 'error');
});
