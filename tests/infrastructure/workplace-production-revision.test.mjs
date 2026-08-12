// tests/infrastructure/workplace-production-revision.test.mjs
//
// ADR-053 Phase 3 — immutable Workplace production material model tests.
//
// Core property (the Run 011 fix): the same material produced through
// different execution partitions yields the SAME semanticDigest. This is
// partition invariance — recovery / carry-forward / repair do not change the
// semantic identity of accepted material.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  assembleRevision,
  buildContribution,
  semanticDigest,
  materialDigest,
} from '../../dist/process-modules/domain/workplace/workplace-production-revision.js';
import { SqliteWorkplaceProductionRevisionRepository } from
  '../../dist/infrastructure/workplace/sqlite-workplace-production-revision-repository.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Minimal parent rows for FK constraints. factory_process_runs is created by
  // a separate repository module, not by SCHEMA_SQL; the workplace row carries
  // process_run_id=1 as a plain integer (FKs are not enforced in-memory).
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,active_reservation_ref)
     VALUES ('workplace/1/cell/item',1,'mod@1.0.0','cell','item',
             'in_progress','running','author',1,'exec-1')`,
  ).run();
  return db;
}

const WORKPLACE = 'workplace/1/cell/item';

function createOp(memberKey, contentDigest) {
  return {
    op: 'create',
    memberKey,
    productRef: `product:${contentDigest}`,
    contentDigest,
    sourceAdapter: 'managed-artifact',
  };
}

// ===========================================================================
// 1. Basic assembly — contributions produce a deterministic revision.
// ===========================================================================
test('Phase 3: assemble a revision from a contribution (deterministic ref)', () => {
  const contribution = buildContribution({
    workplaceRef: WORKPLACE,
    contributorExecutionRef: 'exec-a',
    sourceAdapter: 'managed-artifact',
    operations: [
      createOp('artifact/prd', 'sha256:prd-content'),
      createOp('artifact/fr-1', 'sha256:fr-1-content'),
    ],
    parentContributionRef: null,
  });
  const revision = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contribution],
    presenterRef: 'exec-a',
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(revision.workplaceRef, WORKPLACE);
  assert.equal(revision.parentRevisionRef, null);
  assert.equal(revision.members.length, 2);
  assert.equal(revision.contributingExecutionRefs.length, 1);
  assert.equal(revision.contributingExecutionRefs[0], 'exec-a');
  assert.equal(revision.presenterRef, 'exec-a');
  assert.ok(revision.revisionRef);
  assert.ok(revision.materialDigest);
  assert.ok(revision.semanticDigest);
  assert.notEqual(revision.materialDigest, revision.semanticDigest);

  // Deterministic: same inputs → same ref.
  const revision2 = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [contribution],
    presenterRef: 'exec-a',
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(revision.revisionRef, revision2.revisionRef);
});

// ===========================================================================
// 2. PARTITION INVARIANCE — the Run 011 property.
//
//    Partition A: one execution (exec-A) produces PRD + FR-1.
//    Partition B: exec-A produces PRD, then exec-B produces FR-1.
//
//    Both partitions produce revisions with the SAME semanticDigest, even
//    though their contributingExecutionRefs and materialDigests differ.
// ===========================================================================
test('Phase 3: PARTITION INVARIANCE — same material through different execution partitions yields the same semanticDigest', () => {
  // Partition A: exec-A produces both artifacts in one contribution.
  const partitionA = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      buildContribution({
        workplaceRef: WORKPLACE,
        contributorExecutionRef: 'exec-A',
        sourceAdapter: 'managed-artifact',
        operations: [
          createOp('artifact/prd', 'sha256:prd-content'),
          createOp('artifact/fr-1', 'sha256:fr-1-content'),
        ],
        parentContributionRef: null,
      }),
    ],
    presenterRef: 'exec-A',
    sealedAt: '2026-08-11T12:00:00Z',
  });

  // Partition B: exec-A produces PRD, then exec-B produces FR-1 (recovery).
  const partitionB = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      buildContribution({
        workplaceRef: WORKPLACE,
        contributorExecutionRef: 'exec-A',
        sourceAdapter: 'managed-artifact',
        operations: [createOp('artifact/prd', 'sha256:prd-content')],
        parentContributionRef: null,
      }),
      buildContribution({
        workplaceRef: WORKPLACE,
        contributorExecutionRef: 'exec-B',
        sourceAdapter: 'managed-artifact',
        operations: [createOp('artifact/fr-1', 'sha256:fr-1-content')],
        parentContributionRef: null,
      }),
    ],
    presenterRef: 'exec-B',
    sealedAt: '2026-08-11T13:00:00Z',
  });

  // THE CORE PROPERTY: same semantic digest despite different partitions.
  assert.equal(
    partitionA.semanticDigest,
    partitionB.semanticDigest,
    'partition invariance: same material through different execution partitions ' +
      'must yield the same semanticDigest (Run 011 property)',
  );

  // The materialDigests DIFFER (they include contributor provenance).
  assert.notEqual(
    partitionA.materialDigest,
    partitionB.materialDigest,
    'materialDigest is partition-aware (includes contributor refs)',
  );

  // ADR-053 B-2 — revisionRef remains provenance-aware (deferred to B-9), so
  // the two partitions still derive distinct revisionRefs here at the revision
  // layer. Partition invariance is delivered at the CandidateSet-seal-key level
  // via a semanticDigest convergence probe in the seal path (two partitions
  // sealing equivalent material reuse one revisionRef → one CandidateSet).
  assert.notEqual(partitionA.revisionRef, partitionB.revisionRef);

  // Contributing executions correctly differ.
  assert.deepEqual(partitionA.contributingExecutionRefs, ['exec-A']);
  assert.deepEqual(partitionB.contributingExecutionRefs, ['exec-A', 'exec-B']);
});

// ===========================================================================
// 3. Semantic digest is independent of member ORDER.
// ===========================================================================
test('Phase 3: semanticDigest is order-independent (sorted by memberKey)', () => {
  const d1 = semanticDigest({
    members: [
      { memberKey: 'b', contentDigest: 'x', productRef: 'p', sourceAdapter: 'managed-artifact', contributorExecutionRef: 'e' },
      { memberKey: 'a', contentDigest: 'y', productRef: 'p', sourceAdapter: 'managed-artifact', contributorExecutionRef: 'e' },
    ],
  });
  const d2 = semanticDigest({
    members: [
      { memberKey: 'a', contentDigest: 'y', productRef: 'p', sourceAdapter: 'managed-artifact', contributorExecutionRef: 'e' },
      { memberKey: 'b', contentDigest: 'x', productRef: 'p', sourceAdapter: 'managed-artifact', contributorExecutionRef: 'e' },
    ],
  });
  assert.equal(d1, d2, 'member order does not affect semanticDigest');
});

// ===========================================================================
// 4. Parent chain — revision B builds on revision A.
// ===========================================================================
test('Phase 3: revision B builds on parent revision A (update + create)', () => {
  const revisionA = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      buildContribution({
        workplaceRef: WORKPLACE,
        contributorExecutionRef: 'exec-A',
        sourceAdapter: 'managed-artifact',
        operations: [createOp('artifact/prd', 'sha256:prd-v1')],
        parentContributionRef: null,
      }),
    ],
    presenterRef: 'exec-A',
    sealedAt: '2026-08-11T12:00:00Z',
  });

  const revisionB = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: revisionA,
    contributions: [
      buildContribution({
        workplaceRef: WORKPLACE,
        contributorExecutionRef: 'exec-B',
        sourceAdapter: 'managed-artifact',
        operations: [
          { op: 'update', memberKey: 'artifact/prd', productRef: 'product:prd-v2', contentDigest: 'sha256:prd-v2', sourceAdapter: 'managed-artifact' },
          createOp('artifact/fr-1', 'sha256:fr-1'),
        ],
        parentContributionRef: null,
      }),
    ],
    presenterRef: 'exec-B',
    sealedAt: '2026-08-11T13:00:00Z',
  });

  assert.equal(revisionB.parentRevisionRef, revisionA.revisionRef);
  assert.equal(revisionB.members.length, 2);
  // PRD was updated to v2.
  const prd = revisionB.members.find(m => m.memberKey === 'artifact/prd');
  assert.equal(prd.contentDigest, 'sha256:prd-v2');
  assert.equal(prd.contributorExecutionRef, 'exec-B');
  // Contributors include both executions.
  assert.deepEqual(revisionB.contributingExecutionRefs, ['exec-A', 'exec-B']);
});

// ===========================================================================
// 5. Validation — operations must be consistent with parent state.
// ===========================================================================
test('Phase 3: create on existing key is rejected', () => {
  assert.throws(
    () => assembleRevision({
      workplaceRef: WORKPLACE,
      parent: null,
      contributions: [
        buildContribution({
          workplaceRef: WORKPLACE,
          contributorExecutionRef: 'exec-A',
          sourceAdapter: 'managed-artifact',
          operations: [
            createOp('artifact/prd', 'sha256:prd'),
            createOp('artifact/prd', 'sha256:prd-2'),
          ],
          parentContributionRef: null,
        }),
      ],
      presenterRef: 'exec-A',
    }),
    /REVISION_MEMBER_CREATE_EXISTS/,
  );
});

test('Phase 3: update on absent key is rejected', () => {
  assert.throws(
    () => assembleRevision({
      workplaceRef: WORKPLACE,
      parent: null,
      contributions: [
        buildContribution({
          workplaceRef: WORKPLACE,
          contributorExecutionRef: 'exec-A',
          sourceAdapter: 'managed-artifact',
          operations: [
            { op: 'update', memberKey: 'absent', productRef: 'p', contentDigest: 'd', sourceAdapter: 'managed-artifact' },
          ],
          parentContributionRef: null,
        }),
      ],
      presenterRef: 'exec-A',
    }),
    /REVISION_MEMBER_UPDATE_ABSENT/,
  );
});

test('Phase 3: delete on absent key is rejected', () => {
  assert.throws(
    () => assembleRevision({
      workplaceRef: WORKPLACE,
      parent: null,
      contributions: [
        buildContribution({
          workplaceRef: WORKPLACE,
          contributorExecutionRef: 'exec-A',
          sourceAdapter: 'managed-artifact',
          operations: [{ op: 'delete', memberKey: 'absent' }],
          parentContributionRef: null,
        }),
      ],
      presenterRef: 'exec-A',
    }),
    /REVISION_MEMBER_DELETE_ABSENT/,
  );
});

test('Phase 3: rename to existing key is rejected', () => {
  assert.throws(
    () => assembleRevision({
      workplaceRef: WORKPLACE,
      parent: null,
      contributions: [
        buildContribution({
          workplaceRef: WORKPLACE,
          contributorExecutionRef: 'exec-A',
          sourceAdapter: 'managed-artifact',
          operations: [
            createOp('a', 'da'),
            createOp('b', 'db'),
            { op: 'rename', fromKey: 'a', toKey: 'b' },
          ],
          parentContributionRef: null,
        }),
      ],
      presenterRef: 'exec-A',
    }),
    /REVISION_MEMBER_RENAME_TO_EXISTS/,
  );
});

test('Phase 3: traversal in member key is rejected', () => {
  assert.throws(
    () => assembleRevision({
      workplaceRef: WORKPLACE,
      parent: null,
      contributions: [
        buildContribution({
          workplaceRef: WORKPLACE,
          contributorExecutionRef: 'exec-A',
          sourceAdapter: 'managed-artifact',
          operations: [createOp('../../etc/passwd', 'd')],
          parentContributionRef: null,
        }),
      ],
      presenterRef: 'exec-A',
    }),
    /REVISION_MEMBER_KEY_TRAVERSAL/,
  );
});

// ===========================================================================
// 6. Repository — append + get + partition-invariance probe.
// ===========================================================================
test('Phase 3: repository persists contributions and revisions (append-only, idempotent)', () => {
  const db = makeDb();
  const repo = new SqliteWorkplaceProductionRevisionRepository(db);

  const contribution = repo.appendContribution({
    workplaceRef: WORKPLACE,
    contributorExecutionRef: 'exec-A',
    sourceAdapter: 'managed-artifact',
    operations: [createOp('artifact/prd', 'sha256:prd')],
    parentContributionRef: null,
  });
  assert.ok(contribution.contributionRef);

  // Idempotent: appending the same contribution again is a no-op.
  const contribution2 = repo.appendContribution({
    workplaceRef: WORKPLACE,
    contributorExecutionRef: 'exec-A',
    sourceAdapter: 'managed-artifact',
    operations: [createOp('artifact/prd', 'sha256:prd')],
    parentContributionRef: null,
  });
  assert.equal(contribution.contributionRef, contribution2.contributionRef);

  const fetched = repo.getContribution(contribution.contributionRef);
  assert.ok(fetched);
  assert.equal(fetched.operations.length, 1);

  const revision = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: repo.listContributions(WORKPLACE),
    presenterRef: 'exec-A',
    sealedAt: '2026-08-11T12:00:00Z',
  });
  repo.appendRevision(revision);

  // Idempotent: appending the same revision again is a no-op.
  repo.appendRevision(revision);
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_workplace_production_revisions',
  ).get().n;
  assert.equal(count, 1);

  const fetchedRev = repo.getRevision(revision.revisionRef);
  assert.ok(fetchedRev);
  assert.equal(fetchedRev.semanticDigest, revision.semanticDigest);

  // Partition-invariance probe: find by semantic digest.
  const bySemantic = repo.getRevisionBySemanticDigest(WORKPLACE, revision.semanticDigest);
  assert.ok(bySemantic);
  assert.equal(bySemantic.revisionRef, revision.revisionRef);
  assert.equal(
    repo.getRevisionBySemanticDigest(WORKPLACE, 'sha256:nonexistent'),
    null,
  );
});

// ===========================================================================
// 7. Immutability — triggers reject update and delete.
// ===========================================================================
test('Phase 3: revisions are immutable (triggers reject update + delete)', () => {
  const db = makeDb();
  const repo = new SqliteWorkplaceProductionRevisionRepository(db);
  repo.appendContribution({
    workplaceRef: WORKPLACE,
    contributorExecutionRef: 'exec-A',
    sourceAdapter: 'managed-artifact',
    operations: [createOp('artifact/prd', 'sha256:prd')],
    parentContributionRef: null,
  });
  const revision = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: repo.listContributions(WORKPLACE),
    presenterRef: 'exec-A',
    sealedAt: '2026-08-11T12:00:00Z',
  });
  repo.appendRevision(revision);

  assert.throws(
    () => db.prepare(
      `UPDATE factory_workplace_production_revisions SET presenter_ref = 'tampered'`,
    ).run(),
    /immutable/,
  );
  assert.throws(
    () => db.prepare(
      `DELETE FROM factory_workplace_production_revisions`,
    ).run(),
    /immutable/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE factory_workplace_contributions SET source_adapter = 'tampered'`,
    ).run(),
    /immutable/,
  );
});
