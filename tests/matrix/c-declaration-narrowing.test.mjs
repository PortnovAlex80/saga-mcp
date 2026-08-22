// tests/matrix/c-declaration-narrowing.test.mjs
//
// STAGE-16 SPACE C — self-declaration narrowing (defect shape S2).
//
// Thesis (see tests/matrix/README.md): the candidate declares, the factory
// acts. The S2 defect shape is a declaration that NARROWS the factory's
// canonical requirement — `testCommand` listing 7 of 9 files, an install
// command omitting an imported package. Two surfaces are already closed with
// the "derived beats declared" pattern:
//
//   - testCommand  → derived-canonical enforcement
//     (src/infrastructure/verification/local-runnability-check-provider.ts:789,
//      tests/infrastructure/local-runnability-derived-canonical.test.mjs)
//   - installCommand → environment derivation
//     (src/infrastructure/verification/environment-derivation.ts:154,
//      tests/infrastructure/environment-derivation.test.mjs)
//
// This space enumerates EVERY candidate-declared surface the factory reads to
// decide HOW to check the candidate, asks derived-or-declared for each, drives
// the narrowing direction on every one, and records — without fixing — the
// surfaces where narrowing still succeeds (brief §SPACE C, C1–C6).
//
// Fixture budget (brief §0.2): everything here is tier-3 structure with
// arbitrary text — zzz/, aaa/, invented packages, invented constraint ids.
// The ONE sanctioned exception: factory.local-runnability.v1 really executes
// commands, so the runnability cells use the three-file fake-project pattern
// from tests/infrastructure/local-runnability-derived-canonical.test.mjs
// (green test files + a red one), never faked with strings.
//
// Findings are recorded, not fixed (brief §2). The suite stays GREEN while
// stating each gap in the FINDINGS registry below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { createLocalRunnabilityCheckProvider } from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  augmentInstallCommand,
  deriveExecutionEnvironment,
  installCommandPackages,
} from '../../dist/infrastructure/verification/environment-derivation.js';
import {
  createDevelopmentImplementationScopeCheckProvider,
  createDevelopmentReadinessMonotonicityCheckProvider,
  createDevelopmentVerificationCheckProvider,
  developmentReadinessManifestPayloadContract,
} from '../../dist/modules/development/application/development-check-providers.js';
import {
  evaluateSrsModuleManifestCoverage,
  parseSrsModuleManifest,
} from '../../dist/modules/development/domain/srs-module-manifest.js';
import {
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import { createReviewVerdictCheckProvider } from '../../dist/process-modules/application/review-verdict-check-provider.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

// ── C1/C2: the surface table ────────────────────────────────────────────────
// Enumerated FROM CODE (readiness manifest/profile fields, implementation
// result, verification product, review verdict, SRS §2.2, discovery binding),
// each with the site that READS the declaration. mode:
//   'derived'  — the canonical requirement is derived from sealed/factory
//                bytes; the declaration is additive-only.
//   'declared' — the declaration IS the canonical requirement (or gates
//                whether a whole verification family runs at all).
// narrowing: 'blocked' (declare-less does not pass), 'succeeds' (declare-less
// still passes — FINDINGS entry), 'n/a' (no canonical requirement exists to
// narrow, or the declared value is not acted on).
const SURFACES = [
  {
    id: 'S01', surface: 'readiness.commands.testCommand',
    readingSite: 'src/infrastructure/verification/local-runnability-check-provider.ts:789 (enforceDerivedCanonicalTestSet), :897 (executed)',
    canonical: 'sealed tree tests/** universe ∪ sealed package.json scripts.test enumeration (readiness-test-surface.ts:109)',
    mode: 'derived', narrowing: 'blocked',
    additive: 'legal — extra declared files run verbatim (R2)',
  },
  {
    id: 'S02', surface: 'readiness.commands.installCommand',
    readingSite: 'src/infrastructure/verification/local-runnability-check-provider.ts:815 (deriveExecutionEnvironment), :851 (augmentInstallCommand)',
    canonical: 'bare module specifiers the sealed tree imports, vs manifests + declared install (environment-derivation.ts:154,163)',
    mode: 'derived', narrowing: 'blocked',
    additive: 'legal — a superset declared install leaves undeclaredImports empty (E1)',
  },
  {
    id: 'S03', surface: 'readiness.kind (static | served)',
    readingSite: 'src/infrastructure/verification/local-runnability-check-provider.ts:908 (profile.kind === \'served\' branch), :751-755 (refuses to infer)',
    canonical: 'none — LR-04: the provider does NOT infer served/static from package.json/build files; the declaration is the only authority',
    mode: 'declared', narrowing: 'succeeds', finding: 'F-C1',
    additive: 'n/a — the declaration selects which verification families run at all',
  },
  {
    id: 'S04', surface: 'readiness.serve.startCommand',
    readingSite: 'src/infrastructure/verification/local-runnability-check-provider.ts:919 (executor.runServed(profile.serve.startCommand,...))',
    canonical: 'no canonical serve command exists; the PORT is factory-derived (:915) and a hardcoded numeric port is rejected at the manifest contract (development-check-providers.ts:419)',
    mode: 'declared', narrowing: 'succeeds', finding: 'F-C1',
    additive: 'n/a — reachable only through kind=served (F-C1 narrows the whole family away)',
  },
  {
    id: 'S05', surface: 'readiness.compose.{file,projectName}',
    readingSite: 'src/infrastructure/verification/local-runnability-check-provider.ts:1006-1009 (runDeclaredCompose → validateComposeDeclaration)',
    canonical: 'none by design — "never an inference from compose files incidentally present in the tree"; omitting compose skips ALL compose verification',
    mode: 'declared', narrowing: 'succeeds', finding: 'F-C2',
    additive: 'n/a — presence/absence of the declaration switches the whole step',
  },
  {
    id: 'S06', surface: 'readiness.environment.image',
    readingSite: 'src/infrastructure/verification/local-runnability-check-provider.ts:1229 (selectReadinessExecutor: profile.environment?.image)',
    canonical: 'none — a substrate choice (docker if declared, host otherwise); both substrates run the SAME derived commands; residual: host env vars are not derived',
    mode: 'declared', narrowing: 'n/a',
    additive: 'n/a',
  },
  {
    id: 'S07', surface: 'readiness manifest sourceCandidate {schema,ref,hash}',
    readingSite: 'src/infrastructure/verification/local-runnability-check-provider.ts:504-533 (LOCAL_READINESS_MANIFEST_INVALID), :141/:323-394 (D1 bytes-keyed receipt binding)',
    canonical: 'the exact sealed integrated-source product row + candidate BYTES (candidateHash:commit:tree)',
    mode: 'derived', narrowing: 'blocked',
    additive: 'exact identity — any delta fails closed',
  },
  {
    id: 'S08', surface: 'readiness manifest warrantRef (constraint register + dispositions digests)',
    readingSite: 'src/modules/development/application/development-check-providers.ts:430-448 (validateDevelopmentReadinessManifest)',
    canonical: 'absent is LEGAL ("until the warrant phases land"); when present only digest SHAPES are checked, never that a register exists',
    mode: 'declared', narrowing: 'succeeds', finding: 'F-C3',
    additive: 'n/a — omission is the narrowing',
  },
  {
    id: 'S09', surface: 'implementation result snapshot.changedFiles',
    readingSite: 'src/modules/development/application/development-check-providers.ts:789 (payload.snapshot?.changedFiles), :849-874 (authoritative git diff)',
    canonical: 'git diff --name-only effective_base..commit, both sides filtered by the same factory-managed predicate',
    mode: 'derived', narrowing: 'blocked',
    additive: 'exact identity — a SUPERSET also fails (changed-files-mismatch, I2b); the canonical is an identity, not a floor',
  },
  {
    id: 'S10', surface: 'implementation result repository.baseCommit',
    readingSite: 'src/modules/development/application/development-check-providers.ts:795 (base !== row.effective_base_commit → scope-input-invalid)',
    canonical: 'factory_effective_desk_base_receipts.effective_base_commit',
    mode: 'derived', narrowing: 'blocked',
    additive: 'exact identity',
  },
  {
    id: 'S11', surface: 'implementation result workItemKey',
    readingSite: 'src/modules/development/application/development-check-providers.ts:807 (payload.workItemKey !== cell_input_item.key → work-item-key-mismatch)',
    canonical: 'the kernel-authoritative cell_input_item.key projected into the author task metadata',
    mode: 'derived', narrowing: 'blocked',
    additive: 'exact identity',
  },
  {
    id: 'S12', surface: 'implementation result source.branch',
    readingSite: 'src/modules/development/application/development-check-providers.ts:837-848 (declaredBranch present → merge-base(commit, branch) === commit)',
    canonical: 'none for the branch check itself — "Absent declaration stays unchecked (older payloads) — ancestry above is the hard floor"',
    mode: 'declared', narrowing: 'succeeds', finding: 'F-C4',
    additive: 'n/a — omission skips the whole discipline',
  },
  {
    id: 'S13', surface: 'verification evidence coveredConstraintIds',
    readingSite: 'src/modules/development/application/development-check-providers.ts:1093-1096 (sameStringSet vs card-pinned coveredConstraintIds)',
    canonical: 'the verification card\'s pinned constraint set (cell_input_item.coveredConstraintIds)',
    mode: 'derived', narrowing: 'blocked',
    additive: 'exact identity — superset also fails (V1b)',
  },
  {
    id: 'S14', surface: 'verification evidence outcome',
    readingSite: 'src/modules/development/application/development-check-providers.ts:1114-1117 ("does not trust the LM-authored outcome" → return \'passed\')',
    canonical: 'n/a — the declared outcome is deliberately NOT acted on; shape + lineage only (V2 asserts an outcome:failed payload still passes shape/lineage)',
    mode: 'declared', narrowing: 'n/a',
    additive: 'n/a',
  },
  {
    id: 'S15', surface: 'review verdict findings[].{severity,paths} (ADR-062 deferral)',
    readingSite: 'src/process-modules/application/review-verdict-check-provider.ts:169-177 (blocking + all declared paths outside frozen scopes → DEFERRED)',
    canonical: 'the subject item\'s frozen changeScopes decide reparability — but the PATHS are the reviewer\'s own declaration',
    mode: 'declared', narrowing: 'succeeds', finding: 'F-C5',
    additive: 'n/a — the declaration converts its own blocker into an observation',
  },
  {
    id: 'S16', surface: 'SRS §2.2 Module Manifest (module files)',
    readingSite: 'src/modules/development/domain/srs-module-manifest.ts:76 (parse); src/modules/development/application/development-check-providers.ts:975 (evaluate), :962-973 (absent/no-files → skip, fail-open)',
    canonical: 'the SRS\'s own manifest IS the canonical coverage requirement — no derivation from the repository or the order',
    mode: 'declared', narrowing: 'succeeds', finding: 'F-C6',
    additive: 'n/a — dropping declared module rows shrinks the requirement',
  },
  {
    id: 'S17', surface: 'discovery readiness proposal_content_hash + cited sources',
    readingSite: 'src/modules/discovery/application/discovery-check-providers.ts:112-133 (content-hash bound proposal lookup), :156-166 (allowedProposalSourceRefs derived from the accepted proposal)',
    canonical: 'the exact accepted proposal submission (content hash) and its own keys/evidence_refs',
    mode: 'derived', narrowing: 'blocked',
    additive: 'exact identity (cite-only-allowed-sources)',
  },
  {
    id: 'S18', surface: 'accessible-counter candidate files',
    readingSite: 'src/infrastructure/verification/accessible-counter-check-providers.ts:144-147 (FIXED paths index.html, css/styles.css, js/app.js read from the sealed commit)',
    canonical: 'fixed by the provider; no candidate declaration is read at all',
    mode: 'derived', narrowing: 'n/a',
    additive: 'n/a — no declared surface exists',
  },
  {
    id: 'S19', surface: 'task-graph implementationItems[].changeScopes',
    readingSite: 'src/modules/development/application/development-check-providers.ts:788 (fence reads metadata.cell_input_item.changeScopes, projected from the planner\'s accepted proposal)',
    canonical: 'the accepted task-graph proposal + SRS §2.2 cross-check (S16); narrowing one\'s own scopes only tightens one\'s own fence — cross-authority is SPACE D',
    mode: 'derived', narrowing: 'blocked',
    additive: 'widening requires the stage-13 append-only ledger (readEffectiveChangeScopes, :887-889)',
  },
  {
    id: 'S20', surface: 'readiness.commands across rounds (monotonicity ratchet)',
    readingSite: 'src/modules/development/application/development-check-providers.ts:1365-1401 (prior manifests of the SAME sourceCandidate; READINESS_PROFILE_NARROWED / READINESS_DECLARATION_CHANGED)',
    canonical: 'the union of prior sealed declarations of the same bytes',
    mode: 'derived', narrowing: 'blocked',
    additive: 'escalates too — an ADDITIVE command change is a human-review escalation, never a silent pass (M2)',
  },
];

// ── C4: the FINDINGS registry (ordered by real-run severity, worst first) ───
// Recorded, NOT fixed. Each names the surface, the reading site and the
// narrowing that still succeeds; the corresponding test below asserts the
// CURRENT (gap) behavior so the registry can never silently drift.
const FINDINGS = [
  {
    id: 'F-C1', surfaces: ['S03', 'S04'], severity: 'high',
    file: 'src/infrastructure/verification/local-runnability-check-provider.ts', line: 908,
    summary: 'readiness.kind is declaration-taken: declaring "static" on a served-shaped product removes the serve/loopback/clean-shutdown verification family entirely — the same tree that fails as "served" passes as "static" (R5 vs R6).',
  },
  {
    id: 'F-C2', surfaces: ['S05'], severity: 'high-medium',
    file: 'src/infrastructure/verification/local-runnability-check-provider.ts', line: 1009,
    summary: 'compose verification is opt-in by declaration: omitting readiness.compose runs ZERO compose steps and still passes (R2 asserts the compose runner is never called); a broken composition is unverifiable by omission.',
  },
  {
    id: 'F-C6', surfaces: ['S16'], severity: 'medium',
    file: 'src/modules/development/application/development-check-providers.ts', line: 962,
    summary: 'the SRS §2.2 Module Manifest is its own canonical: an SRS that omits the section (legacy tolerance, fail-open) or drops module rows shrinks the required plan coverage to nothing — the exact workshop regression the check exists for (S1).',
  },
  {
    id: 'F-C5', surfaces: ['S15'], severity: 'medium',
    file: 'src/process-modules/application/review-verdict-check-provider.ts', line: 169,
    summary: 'ADR-062 deferral keys on the REVIEWER-declared finding paths: a blocking finding whose declared paths all lie outside the item scopes is deferred and the verdict PASSES (RV1) — a reviewer can defuse its own blocker by where it points.',
  },
  {
    id: 'F-C4', surfaces: ['S12'], severity: 'low-medium',
    file: 'src/modules/development/application/development-check-providers.ts', line: 838,
    summary: 'source.branch is optional declaration-taken evidence: omitting it skips the task-branch discipline entirely (I3) — a commit off the provisioned branch passes while the same commit with the branch declared fails; only the ancestry floor remains.',
  },
  {
    id: 'F-C3', surfaces: ['S08'], severity: 'low (today) / structural when warrant phases land',
    file: 'src/modules/development/application/development-check-providers.ts', line: 431,
    summary: 'warrantRef is optional and only shape-checked: an absent warrant is legal and a present one never proves a register exists — the constraint-warrant requirement is narrowed away by omission (W1).',
  },
];

const SURFACE_BY_ID = new Map(SURFACES.map(s => [s.id, s]));

test('C1/C2 — the surface table is complete, well-formed and cross-linked to findings', () => {
  assert.ok(SURFACES.length >= 20, 'the enumeration must cover every reader found by the C1 sweep');
  for (const surface of SURFACES) {
    assert.ok(surface.readingSite && /:\d+/.test(surface.readingSite),
      `${surface.id} must cite a reading site with file:line`);
    assert.ok(['derived', 'declared'].includes(surface.mode), `${surface.id} mode`);
    assert.ok(['blocked', 'succeeds', 'n/a'].includes(surface.narrowing), `${surface.id} narrowing`);
  }
  for (const finding of FINDINGS) {
    assert.ok(finding.file && finding.line > 0, `${finding.id} must carry file + line`);
    assert.ok(finding.summary.length > 0, `${finding.id} must state the gap`);
    for (const surfaceId of finding.surfaces) {
      const surface = SURFACE_BY_ID.get(surfaceId);
      assert.ok(surface, `${finding.id} references unknown surface ${surfaceId}`);
      assert.equal(surface.mode, 'declared',
        `${finding.id}: a narrowing-that-succeeds can only live on a declaration-taken surface`);
      assert.equal(surface.finding, finding.id, `${surfaceId} must point back at ${finding.id}`);
    }
  }
  // The two closed surfaces must be present and classified derived/blocked.
  assert.equal(SURFACE_BY_ID.get('S01').narrowing, 'blocked');
  assert.equal(SURFACE_BY_ID.get('S02').narrowing, 'blocked');
  // Every declared surface with narrowing 'succeeds' has a finding; every
  // finding has a test below (by id in the test names).
  for (const surface of SURFACES) {
    if (surface.narrowing === 'succeeds') {
      assert.ok(surface.finding, `${surface.id} narrows successfully but has no finding`);
    }
  }
});

// ── shared harness ──────────────────────────────────────────────────────────

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** One throwaway git fixture: paths → contents, single commit (w9-06 style:
 * arbitrary paths, real structure). Caller removes it. */
function gitTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'saga-matrix-c-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'matrix@example.test');
  git(root, 'config', 'user.name', 'Matrix C');
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'matrix fixture');
  return root;
}

function greenTestFile(name) {
  return [
    `// ${name}`,
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    `test('${name} green', () => { assert.equal(1 + 1, 2); });`,
    '',
  ].join('\n');
}

function redTestFile(name) {
  return [
    `// ${name} — red on the sealed bytes`,
    "const { test } = require('node:test');",
    `test('${name} red', () => { throw new Error('${name} fails on the sealed bytes'); });`,
    '',
  ].join('\n');
}

// HARNESS SCRUB (see local-runnability-derived-canonical.test.mjs): an
// inherited NODE_TEST_CONTEXT would silence the provider-spawned `node --test`.
async function withScrubbedTestContext(fn) {
  const savedExec = process.env.SAGA_LOCAL_RUNNABILITY_EXEC;
  const savedCompose = process.env.SAGA_LOCAL_RUNNABILITY_COMPOSE;
  const savedContext = process.env.NODE_TEST_CONTEXT;
  process.env.SAGA_LOCAL_RUNNABILITY_EXEC = 'host'; // no docker anywhere here
  process.env.SAGA_LOCAL_RUNNABILITY_COMPOSE = 'up'; // deterministic compose mode
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await fn();
  } finally {
    if (savedExec !== undefined) process.env.SAGA_LOCAL_RUNNABILITY_EXEC = savedExec;
    else delete process.env.SAGA_LOCAL_RUNNABILITY_EXEC;
    if (savedCompose !== undefined) process.env.SAGA_LOCAL_RUNNABILITY_COMPOSE = savedCompose;
    else delete process.env.SAGA_LOCAL_RUNNABILITY_COMPOSE;
    if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext;
  }
}

const PROCESS_RUN_ID = 1;
const RUN_ARGS = { subjectCandidateSetRef: 'candidate-set/test', parameters: {}, environmentRef: null, candidateSnapshot: {} };

function minimalDb(root, candidateHash, readiness) {
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
  const commitSha = git(root, 'rev-parse', 'HEAD');
  const treeHash = git(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare('INSERT INTO project_repositories VALUES (?,?)').run(1, root);
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID,
    'development.integrated-candidate',
    INTEGRATED_CANDIDATE_SCHEMA,
    `development-integrated-candidate:${PROCESS_RUN_ID}:${candidateHash}`,
    candidateHash,
    JSON.stringify({
      candidateHash,
      repositories: [{ projectRepositoryId: 1, commitSha, treeHash }],
      readiness,
    }),
  );
  return db;
}

function readerFor(candidateHash) {
  return {
    read(ref) {
      if (ref !== 'candidate-set/test') return null;
      return {
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
            schemaId: INTEGRATED_CANDIDATE_SCHEMA,
            ref: `development-integrated-candidate:${PROCESS_RUN_ID}:${candidateHash}`,
            digest: candidateHash,
          },
          origin: 'produced', sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

async function runReadiness({ root, candidateHash, readiness, composeRunner }) {
  const db = minimalDb(root, candidateHash, readiness);
  try {
    return await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db,
      candidateSets: readerFor(candidateHash),
      ...(composeRunner !== undefined ? { composeRunner } : {}),
    }).run(RUN_ARGS));
  } finally {
    db.close();
  }
}

function outcomeOf(result) {
  return typeof result === 'string' ? result : result.outcome;
}

function diagnostics(result) {
  const refs = typeof result === 'string' ? [] : result.evidenceRefs;
  return refs.map(decodeCheckDiagnostic).filter(Boolean);
}

function diagnosticByCode(result, code) {
  return diagnostics(result).find(diag => diag.code === code) ?? null;
}

// The green tree: canonical tests/zzz-a.test.js + tests/aaa-b.test.js (both in
// scripts.test), plus spec/mmm-extra.test.js OUTSIDE tests/ (non-canonical).
function greenTree() {
  return gitTree({
    'package.json': JSON.stringify({
      name: 'mmm-fixture', version: '1.0.0',
      scripts: { test: 'node --test tests/zzz-a.test.js tests/aaa-b.test.js' },
    }, null, 2),
    'tests/zzz-a.test.js': greenTestFile('zzz-a'),
    'tests/aaa-b.test.js': greenTestFile('aaa-b'),
    'spec/mmm-extra.test.js': greenTestFile('mmm-extra'),
  });
}

// The narrowed tree: identical, except tests/aaa-b.test.js is RED on the
// sealed bytes — the declaration will try to exclude exactly it.
function narrowedTree() {
  return gitTree({
    'package.json': JSON.stringify({
      name: 'mmm-fixture', version: '1.0.0',
      scripts: { test: 'node --test tests/zzz-a.test.js tests/aaa-b.test.js' },
    }, null, 2),
    'tests/zzz-a.test.js': greenTestFile('zzz-a'),
    'tests/aaa-b.test.js': redTestFile('aaa-b'),
  });
}

// ── C3: narrowing on the two DERIVED surfaces must NOT pass ─────────────────

test('S01 (C3, real execution): a testCommand declaring fewer files than the canonical sealed-tree universe MUST NOT PASS — the excluded red file runs', { timeout: 120000 }, async () => {
  const root = narrowedTree();
  try {
    const result = await runReadiness({
      root,
      candidateHash: 'a'.repeat(64),
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node --test tests/zzz-a.test.js' },
      },
    });
    assert.notEqual(outcomeOf(result), 'passed',
      'S2 narrowing must not pass: a testCommand declaring fewer files than the canonical sealed-tree universe was honored verbatim');
    assert.equal(outcomeOf(result), 'failed');
    const failure = diagnosticByCode(result, 'local-runnability');
    assert.ok(failure, 'the failure rides a decodable diagnostic');
    assert.match(failure.message, /aaa-b/u,
      'the real red output of the excluded canonical file must be part of the failure');
    const coverage = diagnosticByCode(result, 'readiness-test-coverage');
    assert.ok(coverage);
    assert.match(coverage.message, /gate DERIVED the executed command from the sealed tree/u);
    assert.match(coverage.message, /tests\/aaa-b\.test\.js/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S02 (C3): an install command narrower than the artefact\'s imports MUST NOT PASS — derivation fails closed before any spawn', { timeout: 120000 }, async () => {
  const root = gitTree({
    'package.json': JSON.stringify({
      name: 'mmm-fixture', version: '1.0.0',
      scripts: { test: 'node --test tests/zzz-a.test.js' },
    }, null, 2),
    'src/qqq-catalog.js': [
      "// the artefact's honest need — invented package, declared nowhere",
      "const orbital = require('aaa-orbital');",
      'module.exports = { orbital };',
      '',
    ].join('\n'),
    'tests/zzz-a.test.js': greenTestFile('zzz-a'),
  });
  try {
    const result = await runReadiness({
      root,
      candidateHash: 'b'.repeat(64),
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node --test tests/zzz-a.test.js' },
      },
    });
    assert.equal(outcomeOf(result), 'failed',
      'S2 narrowing must not pass: the artefact imports aaa-orbital and no declaration provides it');
    const derivation = diagnosticByCode(result, 'ENVIRONMENT_DERIVATION_UNDECLARED_NEED');
    assert.ok(derivation, 'the typed derivation diagnostic rides the evidence');
    assert.match(derivation.message, /aaa-orbital/u,
      'the diagnostic NAMES the package the declaration omitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── C5: the additive direction stays LEGAL on every derived floor surface ───

test('S01/S02 (C5): additive declarations pass — an EXTRA declared test file runs verbatim, and a superset declared install covers every import', { timeout: 120000 }, async () => {
  // Additive testCommand (real execution): canonical ∪ one extra non-canonical
  // green file — honored verbatim, not gate-derived.
  const root = greenTree();
  const compose = fakeComposeRunner(); // also the compose-omission probe (F-C2)
  try {
    const result = await runReadiness({
      root,
      candidateHash: 'c'.repeat(64),
      readiness: {
        kind: 'static',
        commands: {
          installCommand: null,
          testCommand: 'node --test tests/zzz-a.test.js tests/aaa-b.test.js spec/mmm-extra.test.js',
        },
      },
      composeRunner: compose,
    });
    assert.equal(outcomeOf(result), 'passed',
      'an additive declaration (canonical plus one extra green file) must pass');
    const coverage = diagnosticByCode(result, 'readiness-test-coverage');
    assert.ok(coverage);
    assert.doesNotMatch(coverage.message, /gate DERIVED/u,
      'no derivation — the additive declaration was honored as stated');
    assert.equal(compose.calls.config.length, 0,
      'F-C2 (recorded, not fixed): no compose declared → the compose runner is never invoked, and the check still passes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Additive installCommand (pure): a declared superset leaves no gap.
  const dir = mkdtempSync(join(tmpdir(), 'saga-matrix-c-env-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'qqq-catalog.js'), "const o = require('aaa-orbital');\nmodule.exports = { o };\n");
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mmm-fixture', version: '1.0.0', dependencies: {} }));
    const derived = deriveExecutionEnvironment({
      directory: dir,
      installCommand: 'npm install aaa-orbital nnn-extra',
    });
    assert.deepEqual(derived.undeclaredImports, [],
      'an additive install (superset of the scanned imports) is legal — no gap');
    assert.deepEqual(derived.declaredInstallPackages, ['aaa-orbital', 'nnn-extra']);
    assert.deepEqual(installCommandPackages('npm install aaa-orbital nnn-extra'), ['aaa-orbital', 'nnn-extra']);
    assert.equal(
      augmentInstallCommand('npm install nnn-extra', ['aaa-orbital']),
      'npm install nnn-extra aaa-orbital',
      'augmentation is additive: declared tokens verbatim, the derived gap appended',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C3/C4 on the DECLARED surfaces: narrowing still succeeds — findings ─────

test('S03/S04 (C4, real execution): FINDING F-C1 — the same tree fails as "served" and passes as "static"; the declaration alone decides the serve family', { timeout: 120000 }, async () => {
  const root = greenTree();
  try {
    // kind: 'served' — the serve/loopback/shutdown family RUNS and this tree
    // cannot serve (the stated start command exits before answering).
    const served = await runReadiness({
      root,
      candidateHash: 'd'.repeat(64),
      readiness: {
        kind: 'served',
        commands: { installCommand: null, testCommand: 'node --test tests/zzz-a.test.js tests/aaa-b.test.js' },
        serve: { startCommand: 'node -e process.exit(3)' },
      },
    });
    assert.equal(outcomeOf(served), 'failed',
      'a served declaration that cannot serve must fail (the serve family is real verification)');

    // kind: 'static' — same tree, same commands, only the declaration
    // narrowed: the entire serve family disappears and the check PASSES.
    // Recorded as FINDING F-C1; not fixed here.
    const staticResult = await runReadiness({
      root,
      candidateHash: 'e'.repeat(64),
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node --test tests/zzz-a.test.js tests/aaa-b.test.js' },
      },
    });
    assert.equal(outcomeOf(staticResult), 'passed',
      'F-C1 (recorded, not fixed): declaring "static" on the very tree that failed as "served" passes — readiness.kind narrows the canonical requirement');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S05 (C4, real execution): FINDING F-C2 — declaring compose turns the verification on; the declaration routes it', { timeout: 120000 }, async () => {
  const root = greenTree();
  const compose = fakeComposeRunner();
  try {
    const result = await runReadiness({
      root,
      candidateHash: 'f'.repeat(64),
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node --test tests/zzz-a.test.js tests/aaa-b.test.js' },
        compose: { file: 'zzz/stack.yaml', projectName: 'mmm' },
      },
      composeRunner: compose,
    });
    assert.equal(outcomeOf(result), 'passed', 'a declared compose with a passing fake substrate passes');
    assert.deepEqual(compose.calls.config, ['zzz/stack.yaml'],
      'the DECLARED file is what gets validated — the factory never derives which composition to check');
    assert.deepEqual(compose.calls.up, ['zzz/stack.yaml']);
    // Contrast with the C5 test above (same provider, no compose declared):
    // zero calls, still passed. Narrowing by omission succeeds — F-C2.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeComposeRunner() {
  const calls = { config: [], up: [], down: [] };
  return {
    calls,
    configValidate(_directory, declaration) {
      calls.config.push(declaration.file);
      return { step: 'compose-config', status: 'passed' };
    },
    up(_directory, declaration, _timeoutMs) {
      calls.up.push(declaration.file);
      return { step: 'compose-up', status: 'passed' };
    },
    down(_directory, declaration) {
      calls.down.push(declaration.file);
    },
  };
}

test('S08 (C4): FINDING F-C3 — an absent warrantRef is legal (the requirement is narrowed away by omission); a present one is shape-checked only', () => {
  const base = {
    schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: {
      schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
      ref: 'candidate/mmm-1',
      hash: 'e'.repeat(64),
    },
    targets: [{
      key: 'primary',
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node --test tests/zzz-a.test.js' },
      },
    }],
  };
  // Omission: zero errors — the warrant requirement does not exist unless the
  // candidate deigns to declare it. Recorded as F-C3; not fixed here.
  assert.deepEqual(developmentReadinessManifestPayloadContract.validate(base), [],
    'F-C3 (recorded, not fixed): a readiness manifest with NO warrantRef validates clean');
  // A malformed present warrant is rejected — but the check is digest SHAPES,
  // never that a constraint register actually exists behind them.
  const malformed = {
    ...base,
    warrantRef: { constraintRegisterRef: 'not-the-typed-shape' },
  };
  const errors = developmentReadinessManifestPayloadContract.validate(malformed);
  assert.ok(errors.length > 0, 'a present-but-malformed warrant fails the payload contract');
  // The factory-derived serve PORT beats a declared hardcoded one (S04 note):
  // the manifest contract rejects a numeric port in startCommand.
  const hardcodedPort = developmentReadinessManifestPayloadContract.validate({
    ...base,
    targets: [{
      key: 'primary',
      readiness: {
        kind: 'served',
        commands: { installCommand: null, testCommand: 'node --test tests/zzz-a.test.js' },
        serve: { startCommand: 'node zzz-serve.js --port 8080' },
      },
    }],
  });
  assert.ok(hardcodedPort.some(message => /PORT environment variable/u.test(message)),
    'a hardcoded serve port is rejected — the factory-derived port is the authority');
});

// ── S09–S12: the implementation-scope provider over a real git fixture ──────

function implementationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'saga-matrix-c-impl-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'matrix@example.test');
  git(root, 'config', 'user.name', 'Matrix C');
  writeFileSync(join(root, 'zzz-base.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  mkdirSync(join(root, 'zzz'), { recursive: true });
  mkdirSync(join(root, 'aaa'), { recursive: true });
  writeFileSync(join(root, 'zzz', 'one.txt'), 'one\n');
  writeFileSync(join(root, 'aaa', 'two.txt'), 'two\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'work');
  const head = git(root, 'rev-parse', 'HEAD');
  // A task branch that does NOT contain the work commit (probe for S12).
  git(root, 'branch', 'task/mmm-probe', base);
  return { root, base, head };
}

function implementationDb({ root, base, payload, contentHash }) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_repositories(id INTEGER PRIMARY KEY, local_path TEXT);
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY, workplace_ref TEXT, metadata TEXT,
      project_repository_id INTEGER, verification_target_artifact_id INTEGER
    );
    CREATE TABLE factory_managed_node_submissions(
      id INTEGER PRIMARY KEY, task_id INTEGER, execution_id TEXT,
      process_run_id INTEGER, schema_version TEXT,
      payload_snapshot TEXT, content_hash TEXT
    );
    CREATE TABLE factory_effective_desk_base_receipts(
      execution_ref TEXT, task_id INTEGER, effective_base_commit TEXT
    );
  `);
  db.prepare('INSERT INTO project_repositories VALUES (?,?)').run(1, root);
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(
    5,
    'workplace/1/solution-development/impl-cell/item-zzz',
    JSON.stringify({
      role: 'author',
      cell_input_item: { key: 'item-zzz', changeScopes: ['zzz/', 'aaa/'] },
    }),
    1, null,
  );
  db.prepare(
    'INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?,?,?)',
  ).run(
    11, 5, 'exec-1', PROCESS_RUN_ID, DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
    JSON.stringify(payload), contentHash,
  );
  db.prepare(
    'INSERT INTO factory_effective_desk_base_receipts VALUES (?,?,?)',
  ).run('exec-1', 5, base);
  return db;
}

function implementationReader(contentHash) {
  return {
    read(ref) {
      if (ref !== 'candidate-set/test') return null;
      return {
        candidateSetRef: ref,
        role: 'author',
        workplaceRef: {
          processRunId: PROCESS_RUN_ID,
          moduleRef: 'solution-development',
          productionCellId: 'impl-cell',
          workKey: 'item-zzz',
        },
        members: [{
          productRef: {
            schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
            ref: 'managed-node-submission:11',
            digest: contentHash,
          },
          origin: 'produced', sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

function gitPort() {
  return {
    read(localPath, args) {
      try {
        return execFileSync('git', ['-C', localPath, ...args], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      } catch {
        return null;
      }
    },
  };
}

function implementationPayload({ root, base, changedFiles, branch, baseCommit }) {
  return {
    workItemKey: 'item-zzz',
    repository: { baseCommit: baseCommit ?? base },
    snapshot: {
      commitSha: git(root, 'rev-parse', 'HEAD'),
      changedFiles,
    },
    ...(branch !== undefined ? { source: { branch } } : {}),
  };
}

const IMPL_RUN_ARGS = {
  subjectCandidateSetRef: 'candidate-set/test',
  parameters: { processRunId: PROCESS_RUN_ID },
  environmentRef: null, candidateSnapshot: {},
};

function runImplementation({ fixture, payload }) {
  const contentHash = 'f'.repeat(64);
  const db = implementationDb({ ...fixture, payload, contentHash });
  try {
    return createDevelopmentImplementationScopeCheckProvider({
      db,
      candidateSets: implementationReader(contentHash),
      git: gitPort(),
    }).run(IMPL_RUN_ARGS);
  } finally {
    db.close();
  }
}

test('S09 (C3): changedFiles narrower than the authoritative git diff MUST NOT PASS (derived beats declared)', () => {
  const fixture = implementationFixture();
  try {
    const diff = git(fixture.root, 'diff', '--name-only', `${fixture.base}..${fixture.head}`);
    assert.equal(diff, 'aaa/two.txt\nzzz/one.txt', 'fixture sanity: the diff is the canonical set');
    // Narrowing: declare one of the two diff paths.
    const narrowed = runImplementation({
      fixture,
      payload: implementationPayload({ ...fixture, changedFiles: ['zzz/one.txt'] }),
    });
    assert.equal(outcomeOf(narrowed), 'failed');
    assert.equal(diagnosticByCode(narrowed, 'changed-files-mismatch')?.code, 'changed-files-mismatch',
      'the omitted path aaa/two.txt is caught by derivation from the git diff');
    // Exact identity: the exact set passes…
    const exact = runImplementation({
      fixture,
      payload: implementationPayload({ ...fixture, changedFiles: ['zzz/one.txt', 'aaa/two.txt'] }),
    });
    assert.equal(outcomeOf(exact), 'passed');
    // …and a SUPERSET fails too — this canonical is an identity, not a floor,
    // so the C5 additive allowance does not (and must not) apply here.
    const superset = runImplementation({
      fixture,
      payload: implementationPayload({ ...fixture, changedFiles: ['zzz/one.txt', 'aaa/two.txt', 'qqq/phantom.txt'] }),
    });
    assert.equal(outcomeOf(superset), 'failed');
    assert.equal(diagnosticByCode(superset, 'changed-files-mismatch')?.code, 'changed-files-mismatch',
      'declaring MORE than the diff is a false claim, not an additive pass');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('S10/S11 (C3): a narrowed baseCommit or workItemKey MUST NOT PASS (both are factory-derived identities)', () => {
  const fixture = implementationFixture();
  try {
    const wrongBase = runImplementation({
      fixture,
      payload: implementationPayload({
        ...fixture, changedFiles: ['zzz/one.txt', 'aaa/two.txt'], baseCommit: fixture.head,
      }),
    });
    assert.equal(outcomeOf(wrongBase), 'failed');
    assert.equal(diagnosticByCode(wrongBase, 'scope-input-invalid')?.code, 'scope-input-invalid',
      'a declared base other than the frozen effective desk base fails closed');
    const contentHash = 'f'.repeat(64);
    const payload = implementationPayload({ ...fixture, changedFiles: ['zzz/one.txt', 'aaa/two.txt'] });
    const db = implementationDb({
      ...fixture, payload: { ...payload, workItemKey: 'workplace-work-key-mismatch' }, contentHash,
    });
    try {
      const wrongKey = createDevelopmentImplementationScopeCheckProvider({
        db, candidateSets: implementationReader(contentHash), git: gitPort(),
      }).run(IMPL_RUN_ARGS);
      assert.equal(outcomeOf(wrongKey), 'failed');
      assert.equal(diagnosticByCode(wrongKey, 'work-item-key-mismatch')?.code, 'work-item-key-mismatch',
        'the kernel-authoritative cell_input_item.key is the identity, not the declaration');
    } finally {
      db.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('S12 (C4): FINDING F-C4 — omitting source.branch skips the task-branch discipline entirely', () => {
  const fixture = implementationFixture();
  try {
    // Declared: the work commit is NOT reachable from the declared branch
    // (the branch sits at the base) → typed failure.
    const declared = runImplementation({
      fixture,
      payload: implementationPayload({
        ...fixture, changedFiles: ['zzz/one.txt', 'aaa/two.txt'], branch: 'task/mmm-probe',
      }),
    });
    assert.equal(outcomeOf(declared), 'failed');
    assert.equal(diagnosticByCode(declared, 'commit-not-on-task-branch')?.code, 'commit-not-on-task-branch',
      'a declared branch is really checked');
    // Omitted: the same off-branch commit passes — narrowing by omission
    // succeeds. Recorded as F-C4; not fixed here.
    const omitted = runImplementation({
      fixture,
      payload: implementationPayload({ ...fixture, changedFiles: ['zzz/one.txt', 'aaa/two.txt'] }),
    });
    assert.equal(outcomeOf(omitted), 'passed',
      'F-C4 (recorded, not fixed): the identical commit passes when source.branch is simply not declared');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ── S13/S14: the verification product lineage (derived exact-set) ────────────

function verificationRun({ coveredConstraintIds, declaredOutcome }) {
  const frozenHash = '1'.repeat(64);
  const acceptedHash = '2'.repeat(64);
  const payload = {
    schemaVersion: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
    verificationItemKey: 'item-v',
    acceptanceCriterionKey: '77:AC-1',
    acceptedCriterionHash: acceptedHash,
    candidateHash: frozenHash,
    ...(coveredConstraintIds !== undefined ? { coveredConstraintIds } : {}),
    outcome: declaredOutcome ?? 'passed',
    evidence: { summary: 'x', observations: ['y'], limitations: [] },
  };
  const contentHash = '3'.repeat(64);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions(
      id INTEGER PRIMARY KEY, task_id INTEGER, execution_id TEXT,
      process_run_id INTEGER, schema_version TEXT,
      payload_snapshot TEXT, content_hash TEXT
    );
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY, workplace_ref TEXT, metadata TEXT,
      project_repository_id INTEGER, verification_target_artifact_id INTEGER
    );
    CREATE TABLE artifacts(id INTEGER PRIMARY KEY, code TEXT, accepted_hash TEXT);
  `);
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(
    5, 'workplace/1/solution-development/verify-cell/item-v',
    JSON.stringify({
      role: 'author',
      cell_input_item: {
        key: 'item-v',
        acceptanceCriterionKeys: ['77:AC-1'],
        coveredConstraintIds: ['zzz-c1', 'aaa-c2'],
      },
      process_node_input: { upstream: { bindings: { candidate: { candidateHash: frozenHash } } } },
    }),
    1, 77,
  );
  db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(77, 'AC-zzz', acceptedHash);
  db.prepare(
    'INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?,?,?)',
  ).run(12, 5, 'exec-2', PROCESS_RUN_ID, DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
    JSON.stringify(payload), contentHash);
  try {
    return createDevelopmentVerificationCheckProvider({
      db,
      candidateSets: {
        read(ref) {
          if (ref !== 'candidate-set/test') return null;
          return {
            candidateSetRef: ref,
            role: 'author',
            workplaceRef: {
              processRunId: PROCESS_RUN_ID, moduleRef: 'solution-development',
              productionCellId: 'verify-cell', workKey: 'item-v',
            },
            members: [{
              productRef: {
                schemaId: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
                ref: 'managed-node-submission:12',
                digest: contentHash,
              },
              origin: 'produced', sourceCandidateSetRef: null,
            }],
          };
        },
      },
    }).run({
      subjectCandidateSetRef: 'candidate-set/test',
      parameters: { processRunId: PROCESS_RUN_ID },
      environmentRef: null, candidateSnapshot: {},
    });
  } finally {
    db.close();
  }
}

test('S13 (C3): coveredConstraintIds narrower than the card-pinned set MUST NOT PASS; a superset fails too (exact identity)', () => {
  const narrowed = verificationRun({ coveredConstraintIds: ['zzz-c1'] });
  assert.equal(outcomeOf(narrowed), 'failed');
  assert.equal(diagnosticByCode(narrowed, 'verification-lineage-mismatch')?.code, 'verification-lineage-mismatch',
    'dropping aaa-c2 from the declared coverage is caught against the card-pinned set');
  const superset = verificationRun({ coveredConstraintIds: ['zzz-c1', 'aaa-c2', 'qqq-c3'] });
  assert.equal(outcomeOf(superset), 'failed',
    'declaring MORE constraints than the card pins is also a lineage mismatch — exact identity, not a floor');
  const exact = verificationRun({ coveredConstraintIds: ['zzz-c1', 'aaa-c2'] });
  assert.equal(outcomeOf(exact), 'passed');
});

test('S14 (C2 note): the declared verification outcome is NOT acted on — shape + lineage pass regardless of outcome:failed', () => {
  const declaredFailed = verificationRun({
    coveredConstraintIds: ['zzz-c1', 'aaa-c2'], // exact lineage; only outcome differs
    declaredOutcome: 'failed',
  });
  assert.equal(outcomeOf(declaredFailed), 'passed',
    'the provider deliberately ignores the LM-authored outcome (executable evidence is the local-runnability provider\'s job)');
});

// ── S20: the between-rounds declaration ratchet (derived from prior seals) ───

function manifestPayload(testCommand) {
  return {
    schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: {
      schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
      ref: 'candidate/mmm-1',
      hash: 'e'.repeat(64),
    },
    targets: [{
      key: 'primary',
      readiness: { kind: 'static', commands: { installCommand: null, testCommand } },
    }],
  };
}

function monotonicityRun({ currentCommand }) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions(
      id INTEGER PRIMARY KEY, task_id INTEGER, execution_id TEXT,
      process_run_id INTEGER, schema_version TEXT,
      payload_snapshot TEXT, content_hash TEXT
    );
  `);
  const prior = manifestPayload('node --test tests/zzz-a.test.js tests/aaa-b.test.js');
  const current = manifestPayload(currentCommand);
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?,?,?)')
    .run(1, null, null, PROCESS_RUN_ID, DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
      JSON.stringify(prior), '4'.repeat(64));
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?,?,?)')
    .run(2, null, null, PROCESS_RUN_ID, DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
      JSON.stringify(current), '5'.repeat(64));
  try {
    return createDevelopmentReadinessMonotonicityCheckProvider({
      db,
      candidateSets: {
        read(ref) {
          if (ref !== 'candidate-set/test') return null;
          return {
            candidateSetRef: ref,
            role: 'author',
            workplaceRef: {
              processRunId: PROCESS_RUN_ID, moduleRef: 'solution-development',
              productionCellId: 'development-readiness-certification', workKey: 'singleton',
            },
            members: [{
              productRef: {
                schemaId: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
                ref: 'managed-node-submission:2',
                digest: '5'.repeat(64),
              },
              origin: 'produced', sourceCandidateSetRef: null,
            }],
          };
        },
      },
      git: { read: () => null }, // unreadable substrate: the declaration-diff path still fires
    }).run({
      subjectCandidateSetRef: 'candidate-set/test',
      parameters: { processRunId: PROCESS_RUN_ID },
      environmentRef: null, candidateSnapshot: {},
    });
  } finally {
    db.close();
  }
}

test('S20 (C3): narrowing against a prior sealed declaration of the same bytes MUST NOT silently pass', () => {
  const narrowed = monotonicityRun({ currentCommand: 'node --test tests/zzz-a.test.js' });
  assert.equal(outcomeOf(narrowed), 'unknown');
  const diagnostic = diagnostics(narrowed)[0];
  assert.equal(diagnostic?.code, 'READINESS_PROFILE_NARROWED');
  assert.match(diagnostic.message, /tests\/aaa-b\.test\.js/u,
    'the dropped file is named in the escalation');
});

test('S20 (C5 note): an ADDITIVE command change escalates too — human review, never a silent pass', () => {
  const additive = monotonicityRun({
    currentCommand: 'node --test tests/zzz-a.test.js tests/aaa-b.test.js spec/mmm-extra.test.js',
  });
  assert.equal(outcomeOf(additive), 'unknown');
  assert.equal(diagnostics(additive)[0]?.code, 'READINESS_DECLARATION_CHANGED',
    'on unchanged bytes even an additive declaration change is an escalation, not a silent pass (the C5 additive freedom lives at the derived-canonical layer, S01)');
});

// ── S15: the review-verdict ADR-062 deferral (declared paths) ────────────────

const REVIEW_WORKPLACE = 'workplace/1/mmm-module@1/review-cell/item-r';

function reviewRun({ paths }) {
  const payload = {
    subject_candidate_set_ref: 'candidate-set/author-1',
    verdict: 'changes_requested',
    findings: [{ message: 'qqq break', severity: 'error', paths }],
  };
  const contentHash = '6'.repeat(64);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions(
      id INTEGER PRIMARY KEY, schema_version TEXT,
      payload_snapshot TEXT, content_hash TEXT
    );
    CREATE TABLE tasks(id INTEGER PRIMARY KEY, workplace_ref TEXT, metadata TEXT);
    CREATE TABLE factory_accepted_authority_head(
      workplace_ref TEXT, accepted_author_task_id TEXT,
      accepted_author_candidate_set_ref TEXT
    );
  `);
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?)')
    .run(9, 'factory.review-verdict.v1', JSON.stringify(payload), contentHash);
  db.prepare('INSERT INTO tasks VALUES (?,?,?)').run(
    5, REVIEW_WORKPLACE,
    JSON.stringify({ role: 'author', cell_input_item: { key: 'item-r', changeScopes: ['zzz/'] } }),
  );
  db.prepare('INSERT INTO factory_accepted_authority_head VALUES (?,?,?)')
    .run(REVIEW_WORKPLACE, '5', 'candidate-set/author-1');
  try {
    return createReviewVerdictCheckProvider({
      db,
      candidateSets: {
        read(ref) {
          if (ref !== 'candidate-set/review-1') return null;
          return {
            candidateSetRef: ref,
            role: 'reviewer',
            subjectCandidateSetRef: 'candidate-set/author-1',
            workplaceRef: {
              processRunId: 1, moduleRef: 'mmm-module@1',
              productionCellId: 'review-cell', workKey: 'item-r',
            },
            members: [{
              productRef: {
                schemaId: 'factory.review-verdict.v1',
                ref: 'managed-node-submission:9',
                digest: contentHash,
              },
              origin: 'produced', sourceCandidateSetRef: 'candidate-set/author-1',
            }],
          };
        },
      },
    }).run({
      subjectCandidateSetRef: 'candidate-set/author-1',
      parameters: { assessmentCandidateSetRefs: ['candidate-set/review-1'] },
      environmentRef: null, candidateSnapshot: {},
    });
  } finally {
    db.close();
  }
}

test('S15 (C4): FINDING F-C5 — a blocking finding whose DECLARED paths all lie outside the scopes is deferred and the verdict passes', () => {
  // The reviewer declares paths outside the item's frozen scopes → ADR-062
  // defers the reviewer's own blocking finding → outcome 'passed'. The
  // declared paths, not the defect, decide whether the gate blocks.
  // Recorded as F-C5; not fixed here.
  const deferred = reviewRun({ paths: ['qqq/outside.js'] });
  assert.equal(outcomeOf(deferred), 'passed',
    'F-C5 (recorded, not fixed): the reviewer-declared paths defuse the reviewer-declared blocker');
  const deferredDiag = diagnostics(deferred)[0];
  assert.ok(deferredDiag?.code.startsWith('deferred-out-of-scope:'),
    'the deferral is visible as a typed diagnostic, but the verdict passes');
  // Contrast: the same finding with a path INSIDE the scopes (or none) blocks.
  const blocking = reviewRun({ paths: ['zzz/inside.js'] });
  assert.equal(outcomeOf(blocking), 'failed',
    'the identical finding blocks when its declared path lies inside the scopes');
  assert.ok(diagnostics(blocking).some(diag => diag.code.startsWith('review-finding:')));
});

// ── S16: the SRS §2.2 module manifest is its own canonical ──────────────────

const SRS_WITH_BOTH_MODULES = [
  '# SRS mmm',
  '',
  '## 2.2 Module Manifest',
  '',
  '| Module | Files |',
  '| --- | --- |',
  '| zzz-mod | zzz/one.js |',
  '| aaa-mod | aaa/two.js |',
  '',
].join('\n');

test('S16 (C4): FINDING F-C6 — the manifest\'s own breadth decides the coverage requirement; narrowing it (or omitting it) succeeds', () => {
  const items = [{ changeScopes: ['zzz/'] }];
  // The full manifest: aaa/two.js is uncovered → the gate has something to
  // enforce.
  const full = parseSrsModuleManifest(SRS_WITH_BOTH_MODULES);
  assert.equal(full.status, 'present');
  assert.equal(full.modules.length, 2);
  const fullCoverage = evaluateSrsModuleManifestCoverage(full, items);
  assert.equal(fullCoverage.outcome, 'uncovered');
  assert.deepEqual(fullCoverage.gaps.map(gap => gap.module), ['aaa-mod'],
    'the two-module manifest requires coverage of both');
  // The NARROWED manifest (aaa-mod row dropped by the SRS author): the same
  // plan now COVERS. The declaration shrank the canonical requirement.
  // Recorded as F-C6; not fixed here.
  const narrowed = parseSrsModuleManifest(SRS_WITH_BOTH_MODULES.replace('| aaa-mod | aaa/two.js |\n', ''));
  assert.equal(narrowed.modules.length, 1);
  assert.equal(evaluateSrsModuleManifestCoverage(narrowed, items).outcome, 'covered',
    'F-C6 (recorded, not fixed): dropping the module row removes the requirement');
  // The OMITTED manifest: no §2.2 section at all → 'absent' → the provider
  // fail-opens (development-check-providers.ts:962-973, legacy tolerance).
  assert.equal(parseSrsModuleManifest('# SRS mmm\n\nno manifest here\n').status, 'absent',
    'F-C6: an SRS without the section narrows the requirement to nothing');
});

// ── C6: report the table ────────────────────────────────────────────────────

test('C6 — the surface table: surface → derived|declared → narrowing blocked (console)', () => {
  const lines = SURFACES.map(surface => [
    surface.id.padEnd(4),
    surface.surface.padEnd(52),
    surface.mode === 'derived' ? 'derived ' : 'declared',
    surface.narrowing === 'blocked' ? 'no  (blocked)'
      : surface.narrowing === 'succeeds' ? `YES (${surface.finding})`
        : 'n/a',
  ].join(' '));
  // eslint-disable-next-line no-console
  console.log([
    '[space C] declaration-narrowing table '
      + '(narrowing blocked? "no" = the check itself refuses the narrowed declaration):',
    ...lines,
    `surfaces: ${SURFACES.length} `
      + `(derived ${SURFACES.filter(s => s.mode === 'derived').length}, `
      + `declared ${SURFACES.filter(s => s.mode === 'declared').length}); `
      + `narrowing blocked on ${SURFACES.filter(s => s.narrowing === 'blocked').length}, `
      + `succeeds on ${SURFACES.filter(s => s.narrowing === 'succeeds').length} `
      + `(FINDINGS: ${FINDINGS.map(f => f.id).join(', ')})`,
  ].join('\n'));
  const distinctFindings = new Set(
    SURFACES.filter(s => s.narrowing === 'succeeds').map(s => s.finding));
  assert.equal(distinctFindings.size, FINDINGS.length,
    'every narrowing-that-succeeds maps to a registry finding, and every finding covers at least one (F-C1 owns two surfaces)');
});
