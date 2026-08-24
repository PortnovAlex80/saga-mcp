// tests/factory-proof/mutation-kill-floor.test.mjs
//
// ADR-096 gate item 2 — the BLOCKING, MEASURED, NON-ZERO mutation-kill floor.
//
// "K4 crash/fault edges and a non-zero mutation kill floor are blocking."
//
// The conformance report (CONFORMANCE-CLOSURE-PLAN §"Honest stage status")
// records that mutation data exists but is neither measured nor aggregated,
// and that no blocking floor exists. This suite is the smallest honest fix:
// a DETERMINISTIC, BOUNDED register of production-representative mutations —
// the ADR-053/ADR-095 architectural-ban classes already proven RED in recent
// cycles — each executed against a REAL production rejection boundary from
// dist/ through the shared mutation algebra (mutation-algebra.mjs
// runKillMatrix). No random fuzz: every mutant is declared below, carries an
// operatorId from the algebra's frozen operator tables, and a pinned floor
// count. Shrinking the register, weakening a boundary, or skipping a class
// are all deliberate acts that must turn this suite red first.
//
// Ownership note (plan §"Honest stage status" correction): mutation identity
// and kill closure are K3 responsibilities; K4 owns fault schedules. This
// floor is the K3-owned blocking floor the ADR-096 kill gate couples to the
// K4 fault edges — it is landed with the fault-edge hosting in the same
// package because the gate item binds both.
//
// ── The declared ban classes and their REAL boundaries ────────────────────
//
// A. execution-scoped-lookup (ADR-053 Wave-6 cutover; CGAD P18 §9.11)
//    Product resolution is EXACT by (schemaId, ref, digest) triple. There is
//    no epic-scope, no by-execution and no latest fallback. Boundary:
//    SqliteProcessProductRepositoryV2.getByProductRef (the production reader
//    the executor/gates use) over a seeded table holding TWO revisions of
//    the same (schemaId, ref) — a fallback to "the other revision", "the
//    newest one" or "any run's row" must surface as an ACCEPTED mutant.
//
// B. latest-wins-selection (ADR-053 C5 / K7 chronology ban)
//    Chronology never selects a material subject. Boundary:
//    createSqliteProductionCellProjectionPersistence(db).readProjectedRoleTask —
//    duplicates of the EXACT generation key throw
//    PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE, and when a superseded
//    reviewer generation row has the HIGHER task id, the exact-key read must
//    still resolve the CURRENT generation's task. Same for the product
//    reader: probing the OLDER revision's digest must return the OLDER row
//    byte-exactly, not the newest.
//
// C. scope-fence-bypass (STAGE-13 implementation-scope fence)
//    The frozen-changeScopes fence: a git path is legal iff it is contained
//    by some effective scope. Boundary: the REAL production predicates
//    parseRepositoryScope + repositoryScopeContainsPath (src/shared/
//    repository-scope.ts — the exact functions development.implementation-
//    scope.v1 calls), composed exactly as the provider does (offending =
//    paths contained by NO scope). Traversal, absolute, backslash, .git and
//    sibling-prefix bypass attempts must be refused (typed throw or
//    not-contained), never silently contained. (The full provider — git
//    snapshot, diff, changed-files equality — is driven end-to-end by the
//    hosted w9-06 scope-widening E2E; this floor pins the fence predicate
//    seam itself.)
//
// D. authority-digest-skip (ADR-053 C5 / K13 byte-identity of the head)
//    The accepted-authority head records the FULL acceptance identity
//    (check-plan digest, package fingerprint, production-revision ref,
//    ordered product refs). Replaying the same revision with a MUTATED
//    identity must fail closed. Boundary:
//    SqliteAcceptedAuthorityHeadRepository.record — a mutated replay that
//    succeeds means the identity digest comparison was skipped.
//
// ── Measured floor ─────────────────────────────────────────────────────────
//
// The suite runs ONE kill matrix over all declared mutants and MEASURES the
// kills: killed / total, survivors (must be 0), kill ratio (must be 1), with
// per-class non-vacuity minimums. Positive controls prove each boundary is
// not a blanket rejector — a boundary refusing everything would fake a 100%
// kill ratio (the vacuity trap the CC-10B "vacuous empty-pack mutant" item
// warns about).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import {
  RELATIONAL_OPERATORS,
  STRUCTURAL_OPERATORS,
  runKillMatrix,
  algebraSeedHash,
} from './mutation-algebra.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = rel => import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', rel)).href);

// ---------------------------------------------------------------------------
// Real boundaries (built lazily; all in-memory, fully deterministic).
// ---------------------------------------------------------------------------

const WORKPLACE_REF = 'workplace/1/mod@1.0.0/cell/item';
const WORKPLACE_REF_OBJ = {
  processRunId: 1,
  moduleRef: 'mod@1.0.0',
  productionCellId: 'cell',
  workKey: 'item',
};

const PRODUCT = {
  schemaId: 'factory.kill-floor.product.v1',
  ref: 'product/kill-floor/1',
  // Two content revisions of the SAME (schemaId, ref) identity, plus a
  // foreign product. Digests are arbitrary distinct 64-hex strings.
  digestV1: 'a'.repeat(64),
  digestV2: 'b'.repeat(64),
  foreign: {
    schemaId: 'factory.kill-floor.other.v1',
    ref: 'product/kill-floor/other',
    digest: 'c'.repeat(64),
  },
};

const SUBJECT_CURRENT = 'candidate-set/1/mod@1.0.0/cell/item/author';
const SUBJECT_SUPERSEDED = 'candidate-set/0/mod@1.0.0/cell/item/author';

async function buildProductBoundaryDb() {
  const { SqliteProcessProductRepositoryV2 } = await dist(
    'process-modules/persistence/sqlite-process-product-repository-v2.js',
  );
  const db = new Database(':memory:');
  // Fixture-only: the exact-ref reader under test does not depend on FK
  // enforcement; seeding the whole run/epic parent chain would test nothing.
  db.pragma('foreign_keys = OFF');
  const repo = new SqliteProcessProductRepositoryV2(db);
  const envelopeFor = (schemaId, artifactRef, contentHash, bindings) => ({
    schema: schemaId,
    schemaId: 'node-production-envelope.kill-floor.v1',
    artifactRef,
    contentHash,
    bindings,
    productKey: `kill-floor:${contentHash.slice(0, 8)}`,
  });
  // rev1 (run 1), then rev2 (run 2 — HIGHER autoincrement id: the "newest"
  // row for the same identity), then an unrelated foreign product.
  repo.recordProduct(
    envelopeFor(PRODUCT.schemaId, PRODUCT.ref, PRODUCT.digestV1, { rev: 1 }), 1, 'node-a');
  repo.recordProduct(
    envelopeFor(PRODUCT.schemaId, PRODUCT.ref, PRODUCT.digestV2, { rev: 2 }), 2, 'node-b');
  repo.recordProduct(
    envelopeFor(PRODUCT.foreign.schemaId, PRODUCT.foreign.ref, PRODUCT.foreign.digest, {}),
    1, 'node-c');
  return { repo };
}

async function buildProjectionBoundaryDb() {
  const { createSqliteProductionCellProjectionPersistence } = await dist(
    'infrastructure/workplace/sqlite-production-cell-projection-persistence.js',
  );
  const { SCHEMA_SQL } = await dist('schema.js');
  const db = new Database(':memory:');
  // Fixture-only: the exact-key reader under test does not depend on FK
  // enforcement; tasks fixture rows skip the projects→epics parent chain.
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  const insertTask = db.prepare(
    `INSERT INTO tasks (epic_id, title, workplace_ref, metadata)
     VALUES (1, ?, ?, ?)`,
  );
  const seedTask = (title, metadata) => Number(insertTask.run(
    title, WORKPLACE_REF, JSON.stringify(metadata),
  ).lastInsertRowid);
  // Reviewer generations: the CURRENT generation's task lands FIRST (lower
  // id), the SUPERSEDED generation's task SECOND (higher id) — exactly the
  // task-shadow F1 shape where a latest-wins tiebreak binds the wrong task.
  const currentTaskId = seedTask('reviewer current', {
    role: 'reviewer', subject_candidate_set_ref: SUBJECT_CURRENT,
  });
  seedTask('reviewer superseded', {
    role: 'reviewer', subject_candidate_set_ref: SUBJECT_SUPERSEDED,
  });
  // The stable author task: one row for the desk's life. A SECOND author row
  // (the duplicate-key mutant) must fail closed as NOT_UNIQUE.
  const authorTaskId = seedTask('author stable', { role: 'author' });
  const persistence = createSqliteProductionCellProjectionPersistence(db);
  const removeTask = taskId => db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
  return { persistence, currentTaskId, seedTask, removeTask };
}

async function buildAuthorityHeadBoundary() {
  const { SqliteAcceptedAuthorityHeadRepository } = await dist(
    'infrastructure/workplace/sqlite-accepted-authority-head-repository.js',
  );
  const { SCHEMA_SQL } = await dist('schema.js');
  const db = new Database(':memory:');
  // Fixture-only: the identity recorder under test does not depend on FK
  // enforcement (factory_process_runs is created by a separate repository
  // module, not by SCHEMA_SQL — same fixture note as the C5 head tests).
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES (?,1,'mod@1.0.0','cell','item','in_progress','running','author',0)`,
  ).run(WORKPLACE_REF);
  const repo = new SqliteAcceptedAuthorityHeadRepository(db);
  const canonical = {
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: SUBJECT_CURRENT,
    acceptedAuthorGateDecisionKey: 'gate-decision/author/accepted/rev-1',
    revision: 1,
    acceptedAuthorTaskId: 'task-42',
    checkPlanDigest: 'sha256:check-plan/kill-floor',
    packageFingerprint: 'sha256:installation/kill-floor',
    productionRevisionRef: 'workplace-production-revision/kill-floor',
    productRefs: ['product/kill-floor/1@a', 'product/kill-floor/2@b'],
    baselineWorkplaceRevision: 0,
    now: () => new Date('2026-08-25T00:00:00.000Z'),
  };
  repo.record(canonical);
  return { repo, canonical };
}

const SCOPE_FENCE_FROZEN_SCOPES = ['src/', 'package.json', 'docs/kill-floor/'];

async function scopeFenceBoundaryModules() {
  const { parseRepositoryScope, repositoryScopeContainsPath } = await dist(
    'shared/repository-scope.js',
  );
  return { parseRepositoryScope, repositoryScopeContainsPath };
}

// ---------------------------------------------------------------------------
// The declared mutation register (deterministic, bounded, no generation).
// ---------------------------------------------------------------------------

const BAN_CLASSES = Object.freeze(['execution-scoped-lookup', 'latest-wins-selection', 'scope-fence-bypass', 'authority-digest-skip']);

// The pinned floor: the register is EXACTLY this composition. Growing it is a
// deliberate ratchet bump; shrinking it (or hollowing out a class below its
// per-class minimum) must fail the suite before any report can claim a floor.
export const KILL_FLOOR = Object.freeze({
  total: 21,
  perClass: Object.freeze({
    'execution-scoped-lookup': 4,
    'latest-wins-selection': 4,
    'scope-fence-bypass': 7,
    'authority-digest-skip': 6,
  }),
});

const REGISTER = [
  // ── A. execution-scoped-lookup — exact ProductRef triple, no fallback ──
  {
    registerId: 'A1',
    banClass: 'execution-scoped-lookup',
    operatorId: 'digest-wrong-object',
    boundary: 'product-ref',
    violatedConstraint: 'exact-ref:digest-wrong-object',
    mutant: { schemaId: PRODUCT.schemaId, ref: PRODUCT.ref, digest: 'd'.repeat(64) },
    expectSignal: /EXACT_PRODUCT_REF_MISS/u,
  },
  {
    registerId: 'A2',
    banClass: 'execution-scoped-lookup',
    operatorId: 'ref-foreign',
    boundary: 'product-ref',
    violatedConstraint: 'exact-ref:foreign',
    mutant: { schemaId: PRODUCT.schemaId, ref: `foreign:${PRODUCT.ref}`, digest: PRODUCT.digestV1 },
    expectSignal: /EXACT_PRODUCT_REF_MISS/u,
  },
  {
    registerId: 'A3',
    banClass: 'execution-scoped-lookup',
    operatorId: 'member-substituted',
    boundary: 'product-ref',
    violatedConstraint: 'exact-ref:schema-substituted',
    mutant: { schemaId: `${PRODUCT.schemaId}.evil`, ref: PRODUCT.ref, digest: PRODUCT.digestV1 },
    expectSignal: /EXACT_PRODUCT_REF_MISS/u,
  },
  {
    registerId: 'A4',
    banClass: 'execution-scoped-lookup',
    operatorId: 'ref-cross-run',
    boundary: 'product-ref',
    violatedConstraint: 'exact-ref:cross-run-scope',
    mutant: { schemaId: PRODUCT.schemaId, ref: `${PRODUCT.ref}@run/9999`, digest: PRODUCT.digestV1 },
    expectSignal: /EXACT_PRODUCT_REF_MISS/u,
  },

  // ── B. latest-wins-selection — chronology never selects ──
  {
    registerId: 'B1',
    banClass: 'latest-wins-selection',
    operatorId: 'duplicate-key',
    boundary: 'role-projection',
    violatedConstraint: 'role-task:reviewer-generation-duplicate',
    mutant: { role: 'reviewer', subjectCandidateSetRef: SUBJECT_CURRENT, seedDuplicate: true },
    expectSignal: /PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE/u,
  },
  {
    registerId: 'B2',
    banClass: 'latest-wins-selection',
    operatorId: 'duplicate-key',
    boundary: 'role-projection',
    violatedConstraint: 'role-task:author-duplicate',
    mutant: { role: 'author', seedDuplicate: true },
    expectSignal: /PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE/u,
  },
  {
    registerId: 'B3',
    banClass: 'latest-wins-selection',
    operatorId: 'ordering-swapped',
    boundary: 'role-projection',
    violatedConstraint: 'role-task:superseded-generation-has-higher-id',
    mutant: { role: 'reviewer', subjectCandidateSetRef: SUBJECT_CURRENT, seedDuplicate: false },
    expectSignal: /EXACT_GENERATION_TASK_RESOLVED/u,
  },
  {
    registerId: 'B4',
    banClass: 'latest-wins-selection',
    operatorId: 'ordering-swapped',
    boundary: 'product-ref',
    violatedConstraint: 'exact-ref:older-revision-shadowed-by-newer',
    mutant: { schemaId: PRODUCT.schemaId, ref: PRODUCT.ref, digest: PRODUCT.digestV1, mustResolveHash: PRODUCT.digestV1 },
    expectSignal: /EXACT_PRODUCT_REF_BYTE_IDENTITY/u,
  },

  // ── C. scope-fence-bypass — frozen changeScopes containment ──
  {
    registerId: 'C1',
    banClass: 'scope-fence-bypass',
    operatorId: 'member-extra',
    boundary: 'scope-fence',
    violatedConstraint: 'scope-fence:path-outside-scopes',
    mutant: { path: 'outside/evil.ts' },
    expectSignal: /path-outside-authority/u,
  },
  {
    registerId: 'C2',
    banClass: 'scope-fence-bypass',
    operatorId: 'member-substituted',
    boundary: 'scope-fence',
    violatedConstraint: 'scope-fence:sibling-prefix-near-miss',
    mutant: { path: 'src-evil/file.ts' },
    expectSignal: /path-outside-authority/u,
  },
  {
    registerId: 'C3',
    banClass: 'scope-fence-bypass',
    operatorId: 'grammar-malformed',
    boundary: 'scope-fence',
    violatedConstraint: 'scope-fence:parent-traversal',
    mutant: { path: '../escape.ts' },
    expectSignal: /REPOSITORY_FILE_PATH_INVALID/u,
  },
  {
    registerId: 'C4',
    banClass: 'scope-fence-bypass',
    operatorId: 'grammar-malformed',
    boundary: 'scope-fence',
    violatedConstraint: 'scope-fence:backslash-traversal',
    mutant: { path: '..\\escape.ts' },
    expectSignal: /REPOSITORY_FILE_PATH_INVALID/u,
  },
  {
    registerId: 'C5',
    banClass: 'scope-fence-bypass',
    operatorId: 'grammar-malformed',
    boundary: 'scope-fence',
    violatedConstraint: 'scope-fence:absolute-path',
    mutant: { path: '/etc/passwd' },
    expectSignal: /REPOSITORY_FILE_PATH_INVALID/u,
  },
  {
    registerId: 'C6',
    banClass: 'scope-fence-bypass',
    operatorId: 'member-extra',
    boundary: 'scope-fence',
    violatedConstraint: 'scope-fence:git-internal-path',
    mutant: { path: '.git/config' },
    expectSignal: /REPOSITORY_GIT_INTERNAL_PATH_DENIED|path-outside-authority/u,
  },
  {
    registerId: 'C7',
    banClass: 'scope-fence-bypass',
    operatorId: 'member-substituted',
    boundary: 'scope-fence',
    violatedConstraint: 'scope-fence:exact-file-near-miss',
    mutant: { path: 'package.json.bak' },
    expectSignal: /path-outside-authority/u,
  },

  // ── D. authority-digest-skip — head byte-identity on revision replay ──
  {
    registerId: 'D1',
    banClass: 'authority-digest-skip',
    operatorId: 'digest-wrong-object',
    boundary: 'authority-head',
    violatedConstraint: 'head-identity:check-plan-digest-mutated',
    mutant: { checkPlanDigest: 'sha256:check-plan/MUTATED' },
    expectSignal: /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
  },
  {
    registerId: 'D2',
    banClass: 'authority-digest-skip',
    operatorId: 'digest-wrong-object',
    boundary: 'authority-head',
    violatedConstraint: 'head-identity:package-fingerprint-mutated',
    mutant: { packageFingerprint: 'sha256:installation/MUTATED' },
    expectSignal: /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
  },
  {
    registerId: 'D3',
    banClass: 'authority-digest-skip',
    operatorId: 'ordering-swapped',
    boundary: 'authority-head',
    violatedConstraint: 'head-identity:product-refs-reordered',
    mutant: { productRefs: ['product/kill-floor/2@b', 'product/kill-floor/1@a'] },
    expectSignal: /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
  },
  {
    registerId: 'D4',
    banClass: 'authority-digest-skip',
    operatorId: 'member-extra',
    boundary: 'authority-head',
    violatedConstraint: 'head-identity:product-refs-extra',
    mutant: { productRefs: ['product/kill-floor/1@a', 'product/kill-floor/2@b', 'product/kill-floor/3@c'] },
    expectSignal: /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
  },
  {
    registerId: 'D5',
    banClass: 'authority-digest-skip',
    operatorId: 'empty-value',
    boundary: 'authority-head',
    violatedConstraint: 'head-identity:check-plan-digest-absent',
    mutant: { checkPlanDigest: '' },
    expectSignal: /AUTHORITY_HEAD_IDENTITY_INCOMPLETE/u,
  },
  {
    registerId: 'D6',
    banClass: 'authority-digest-skip',
    operatorId: 'cardinality-zero',
    boundary: 'authority-head',
    violatedConstraint: 'head-identity:product-refs-emptied',
    mutant: { productRefs: [] },
    expectSignal: /AUTHORITY_HEAD_IDENTITY_INCOMPLETE/u,
  },
].map(entry => ({
  ...entry,
  obligationId: `k4-ban.${entry.banClass}`,
  expectedBoundary: entry.boundary,
  seedDigest: algebraSeedHash({
    registerId: entry.registerId,
    obligationId: `k4-ban.${entry.banClass}`,
    operatorId: entry.operatorId,
    violatedConstraint: entry.violatedConstraint,
    mutant: entry.mutant,
  }),
}));

// ---------------------------------------------------------------------------
// The kill-matrix boundary: one dispatcher over the four REAL seams.
// ---------------------------------------------------------------------------

function makeBoundary({ productRepo, projection, projectionCurrentTaskId, authority, scopeFence }) {
  return async (mutantCase) => {
    const m = mutantCase.mutant;
    switch (mutantCase.boundary) {
      case 'product-ref': {
        // REAL reader: exact (schemaId, ref, digest) probe. Any resolution of
        // a non-exact triple — or a byte-mismatched row — is the violation.
        const row = productRepo.getByProductRef({ schemaId: m.schemaId, ref: m.ref, digest: m.digest });
        if (m.mustResolveHash !== undefined) {
          return row !== null && row.reference.hash === m.mustResolveHash
            ? { accepted: false, code: 'EXACT_PRODUCT_REF_BYTE_IDENTITY', reason: 'exact older revision resolved byte-exactly; newest row did not shadow it' }
            : { accepted: true, reason: `non-exact resolution returned ${row ? `hash ${row.reference.hash}` : 'null'}` };
        }
        return row === null
          ? { accepted: false, code: 'EXACT_PRODUCT_REF_MISS', reason: 'exact triple miss returned null — no execution/epic/latest fallback' }
          : { accepted: true, reason: `fallback resolution returned row (run ${row.processRunId}, hash ${row.reference.hash})` };
      }
      case 'role-projection': {
        // REAL reader over the durable projection. Duplicate exact keys must
        // throw; with superseded generations present (higher ids), the
        // exact-key read must resolve the CURRENT generation's task.
        let extraSeed;
        if (m.seedDuplicate) {
          extraSeed = projection.insertDuplicate(m);
        }
        try {
          const resolved = projection.persistence.readProjectedRoleTask(
            WORKPLACE_REF_OBJ, m.role, m.subjectCandidateSetRef,
          );
          if (m.seedDuplicate) {
            return { accepted: true, reason: `duplicate exact key resolved to task ${resolved?.taskId ?? null} instead of failing closed` };
          }
          return resolved !== null && resolved.taskId === projectionCurrentTaskId
            ? { accepted: false, code: 'EXACT_GENERATION_TASK_RESOLVED', reason: 'current generation resolved by exact key; superseded higher-id row did not win' }
            : { accepted: true, reason: `latest-wins selection returned task ${resolved?.taskId ?? null}` };
        } finally {
          if (extraSeed !== undefined) projection.removeTask(extraSeed);
        }
      }
      case 'scope-fence': {
        // REAL production fence predicates, composed exactly as the
        // implementation-scope check provider composes them.
        const normalized = SCOPE_FENCE_FROZEN_SCOPES.map(scopeFence.parseRepositoryScope);
        const offending = [m.path].filter(
          candidate => !normalized.some(scope => scopeFence.repositoryScopeContainsPath(scope, candidate)),
        );
        if (offending.length > 0) {
          return { accepted: false, code: 'path-outside-authority', reason: `[${offending.join(', ')}] outside frozen changeScopes ${SCOPE_FENCE_FROZEN_SCOPES.join(', ')}` };
        }
        return { accepted: true, reason: `fence bypass: ${m.path} was contained` };
      }
      case 'authority-head': {
        // REAL repository: replay the SAME revision with the mutated
        // identity. A clean return means the digest comparison was skipped.
        // No synthetic code — the repository's own typed message is the
        // measured kill signal (precise-oracle pin below).
        try {
          authority.repo.record({ ...authority.canonical, ...m });
          return { accepted: true, reason: 'mutated identity replay accepted — digest comparison skipped' };
        } catch (error) {
          return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
        }
      }
      default:
        throw new Error(`KILL_FLOOR_BOUNDARY_UNKNOWN: ${mutantCase.boundary}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

test('kill-floor register: deterministic, algebra-typed, exactly the pinned floor', async () => {
  assert.equal(REGISTER.length, KILL_FLOOR.total,
    `the register must hold EXACTLY the pinned floor (${KILL_FLOOR.total}); growing or shrinking it is a deliberate ratchet act`);
  assert.ok(KILL_FLOOR.total > 0, 'ADR-096 gate item 2: the mutation-kill floor must be NON-ZERO');

  const operators = new Set([...STRUCTURAL_OPERATORS, ...RELATIONAL_OPERATORS]);
  const ids = new Set();
  const digests = new Set();
  const perClass = {};
  for (const entry of REGISTER) {
    assert.ok(BAN_CLASSES.includes(entry.banClass), `${entry.registerId}: unknown ban class ${entry.banClass}`);
    assert.ok(operators.has(entry.operatorId),
      `${entry.registerId}: operatorId '${entry.operatorId}' is not in the mutation-algebra operator tables — the floor only speaks the algebra's language`);
    assert.ok(entry.expectSignal instanceof RegExp, `${entry.registerId}: expected typed kill signal missing`);
    assert.ok(!ids.has(entry.registerId), `duplicate registerId ${entry.registerId}`);
    assert.ok(!digests.has(entry.seedDigest), `duplicate seedDigest for ${entry.registerId}`);
    ids.add(entry.registerId);
    digests.add(entry.seedDigest);
    perClass[entry.banClass] = (perClass[entry.banClass] ?? 0) + 1;
  }
  assert.deepEqual(perClass, KILL_FLOOR.perClass,
    'the per-class composition of the floor is pinned — hollowing out one class while keeping the total is a red');
});

test('kill-floor positive controls: every boundary accepts the canonical valid input (kills are non-vacuous)', async () => {
  const { repo } = await buildProductBoundaryDb();
  const exact = repo.getByProductRef({ schemaId: PRODUCT.schemaId, ref: PRODUCT.ref, digest: PRODUCT.digestV1 });
  assert.ok(exact && exact.reference.hash === PRODUCT.digestV1,
    'the exact triple MUST resolve — a blanket-rejecting reader would fake every kill');

  const projection = await buildProjectionBoundaryDb();
  const reviewer = projection.persistence.readProjectedRoleTask(WORKPLACE_REF_OBJ, 'reviewer', SUBJECT_CURRENT);
  assert.equal(reviewer?.taskId, projection.currentTaskId,
    'the single current reviewer generation MUST resolve by exact key');
  const author = projection.persistence.readProjectedRoleTask(WORKPLACE_REF_OBJ, 'author');
  assert.ok(author !== null, 'the stable author task MUST resolve');

  const scopeFence = await scopeFenceBoundaryModules();
  const normalized = SCOPE_FENCE_FROZEN_SCOPES.map(scopeFence.parseRepositoryScope);
  for (const legal of ['src/main.ts', 'package.json', 'docs/kill-floor/a.md']) {
    assert.ok(normalized.some(scope => scopeFence.repositoryScopeContainsPath(scope, legal)),
      `legal path ${legal} MUST be contained — a blanket-rejecting fence would fake every kill`);
  }

  const authority = await buildAuthorityHeadBoundary();
  assert.doesNotThrow(() => authority.repo.record({ ...authority.canonical }),
    'the IDENTICAL identity replay at the same revision is idempotent — a blanket-throwing recorder would fake every kill');
});

test('kill-floor measurement: all declared mutants are KILLED by the real boundaries (measured, aggregated, blocking)', async () => {
  const [productDb, projectionDb, authority] = await Promise.all([
    buildProductBoundaryDb(),
    buildProjectionBoundaryDb(),
    buildAuthorityHeadBoundary(),
  ]);
  // The projection boundary mutates its OWN database for the duplicate-key
  // seeds (insert one extra exact-key row, remove it after the probe) — the
  // duplicate must sit in the SAME durable projection the reader scans.
  const projection = {
    persistence: projectionDb.persistence,
    insertDuplicate(m) {
      const metadata = m.role === 'reviewer'
        ? { role: 'reviewer', subject_candidate_set_ref: m.subjectCandidateSetRef }
        : { role: 'author' };
      return projectionDb.seedTask('kill-floor duplicate', metadata);
    },
    removeTask: projectionDb.removeTask,
  };

  const boundary = makeBoundary({
    productRepo: productDb.repo,
    projection,
    projectionCurrentTaskId: projectionDb.currentTaskId,
    authority,
    scopeFence: await scopeFenceBoundaryModules(),
  });

  const { matrix, failures } = await runKillMatrix(REGISTER, boundary, {
    detector: 'adr-096.mutation-kill-floor',
  });
  assert.equal(matrix.length, REGISTER.length, 'every declared mutant produced exactly one measured row');
  assert.deepEqual(failures, [],
    `SURVIVORS — mutants the real boundaries accepted (kill floor broken):\n${
      failures.map(f => `${f.obligationId}/${f.operatorId} → ${f.outcome} (${f.signal ?? ''})`).join('\n')}`);

  // Typed-kill pinning: a kill by an UNEXPECTED signal is not an honest kill
  // of the declared class — the precise oracle stays load-bearing.
  for (const entry of REGISTER) {
    const row = matrix.find(r => r.seedDigest === entry.seedDigest);
    assert.ok(row, `no measured row for ${entry.registerId}`);
    assert.ok(row.outcome === 'KILLED_TYPED' || row.outcome === 'KILLED_THROW',
      `${entry.registerId}: outcome ${row.outcome} is not a kill`);
    assert.match(String(row.signal ?? ''), entry.expectSignal,
      `${entry.registerId} (${entry.banClass}/${entry.operatorId}): killed by an unexpected signal`);
  }

  // The measured, aggregated floor (the harvest aggregation the conformance
  // report records as missing). If this ever regresses, the numbers say so.
  const killed = matrix.filter(r => r.outcome === 'KILLED_TYPED' || r.outcome === 'KILLED_THROW').length;
  const survivors = matrix.length - killed;
  const byClass = {};
  for (const row of matrix) {
    const entry = REGISTER.find(e => e.seedDigest === row.seedDigest);
    byClass[entry.banClass] = (byClass[entry.banClass] ?? 0) + 1;
  }
  console.log('[mutation-kill-floor] measured:', JSON.stringify({
    total: matrix.length,
    killed,
    survivors,
    killRatio: killed / matrix.length,
    byClass,
  }));
  assert.equal(survivors, 0, 'ADR-096 kill floor: zero survivors');
  assert.equal(killed / matrix.length, 1, 'kill ratio must be exactly 1 for the pinned register');
  assert.deepEqual(byClass, KILL_FLOOR.perClass);
});
