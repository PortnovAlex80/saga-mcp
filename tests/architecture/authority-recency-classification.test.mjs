// tests/architecture/authority-recency-classification.test.mjs
//
// K7 commit 5 — authority ORDER BY time/latest ban.
//
// THEOREM: chronology never selects a material subject in K7-owned authority
// persistence. Every remaining `ORDER BY ... DESC ... LIMIT 1` site in the
// RECENCY_DIRS scan scope is CLASSIFIED below, and the classified set is
// exactly the allowlist set — so the moment any file gains a newest-wins
// selector it fails (growth), and the moment a classified file is cleaned the
// allowlist must shrink in the same commit (staleness).
//
// K7 CLASSIFICATION OUTCOME (2026-08-17):
//
//   CUT IN K7 (removed from the baseline this commit):
//     - sqlite-process-module-installation-repository.ts —
//       findLatestForModule (ORDER BY id DESC LIMIT 1, newest install wins)
//       DELETED: zero live callers; identity resolves by read(id) /
//       findByPackageDigest (ADR-077 package fingerprint), never recency.
//     - sqlite-production-cell-projection-persistence.ts —
//       readProjectedRoleTask hardened from `ORDER BY id DESC LIMIT 1` to
//       fail-closed exact-key reads (PRODUCTION_CELL_ROLE_TASK_PROJECTION_
//       NOT_UNIQUE on duplicates of the EXACT key): the author key is the
//       stable (workplace, 'author') task; the reviewer key is the exact
//       CURRENT generation (workplace, 'reviewer',
//       subject_candidate_set_ref from the accepted-author authority head).
//       Role ALONE is not unique for the reviewer — generations are minted
//       per accepted author set, so superseded rows legally coexist
//       (task-shadow F1); the reader feeds the accepted-authority head
//       (C5-02) and the recovery budget, where a silent latest-wins
//       tiebreak could bind the wrong task in a repair cycle.
//
//   RECLASSIFIED — legal run-history traversal with exact verification
//   (NOT material selection; the material subject is resolved through the
//   accepted-authority head JOIN / exact product refs, and the boundary row
//   is fail-closed against the exact recorded error/outcome):
//     - sqlite-author-candidate-carry-forward.ts —
//       `ORDER BY attempt DESC,id DESC LIMIT 1` selects the terminal FAILED
//       STAGE/NODE RUN boundary of a parent lifecycle (attempt is a repair-
//       cycle ordinal, not wall-clock). Every subsequent read is exact:
//       the source CandidateSet resolves via factory_accepted_authority_head
//       with uniqueness enforced; gate decisions, submissions, lineage and
//       git identity are all matched by exact key before authorization.
//     - sqlite-modules/development/.../sqlite-development-verification-
//       adoption.ts — same boundary-traversal shape; the boundary row must
//       satisfy DEVELOPMENT_VERIFICATION_ADOPTION_BOUNDARY_INVALID checks
//       (exact status/local_outcome) and material flows through
//       buildSettlementInput exact product references.
//
//   K8-OWNED (exact replay binder replaces newest-wins run-history selection
//   in K8; frozen here so the set cannot grow meanwhile):
//     - sqlite-lifecycle-continuation-repository.ts
//     - sqlite-managed-node-submission-repository.ts
//     - sqlite-node-run-repository.ts
//     - sqlite-protocol-run-repository.ts
//     - sqlite-recovery-case-repository.ts
//
// The epic-scoped-material-read pair (brief-provisioning-ports,
// sqlite-formalization-package-adapters) is INPUT provisioning of the
// pre-lifecycle brief singleton (legacy artifacts table, discovery output
// document) — lifecycle-independent by nature, classified in
// LEGACY-INVENTORY.md, not an accepted-material authority read.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree } from '../../tools/legacy-freeze.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// file → classification. Every scanned recency file MUST appear here, and
// every entry MUST be a currently-scanned file (no stale classifications).
const CLASSIFICATION = Object.freeze({
  'src/infrastructure/workplace/sqlite-author-candidate-carry-forward.ts': {
    release: 'K7',
    verdict: 'reclassified: run-history boundary traversal, exact-verified (material via authority-head JOIN)',
  },
  'src/modules/development/infrastructure/sqlite-development-verification-adoption.ts': {
    release: 'K7',
    verdict: 'reclassified: run-history boundary traversal, exact-verified (material via settlement product refs)',
  },
  'src/process-modules/persistence/sqlite-lifecycle-continuation-repository.ts': {
    release: 'K8',
    verdict: 'K8 cut the outcome-certificate picks to readSingleOutcomeReasonCodes (fail-closed, write-time UNIQUE(process_run_id)); remaining: order-leaf ordinal DESC + boundary attempt DESC frontier traversals',
  },
  'src/process-modules/persistence/sqlite-managed-node-submission-repository.ts': {
    release: 'K8',
    verdict: 'kept: CGAD P18 node-scope submission frontier (designed product frontier, UNIQUE(run,node,execution)); readExact tiebreak is uniqueness-enforced',
  },
  'src/process-modules/persistence/sqlite-node-run-repository.ts': {
    release: 'K8',
    verdict: 'K8 cut the assembler readLatest emulated probe to readByExactCursor and DELETED readLatest/readLatestV2 (interfaces + SQL, zero callers); readLastCompleted(V2) is the linear-chain resume cursor (legal frontier)',
  },
  'src/process-modules/persistence/sqlite-protocol-run-repository.ts': {
    release: 'K8',
    verdict: 'K8 cut active/paused picks to readSingleProtocolRun (fail-closed; active also write-time UNIQUE partial index); remaining: open-step attempt frontier (max open attempt, UNIQUE(protocol_run,step,attempt))',
  },
  'src/process-modules/persistence/sqlite-recovery-case-repository.ts': {
    release: 'K8',
    verdict: 'K8 cut active/exhausted/non-terminal picks to readSingleRecoveryCase + fail-closed resolveActive; remaining: readLastAttemptForCase (max attempt within exact case — structural frontier)',
  },
  'src/infrastructure/workplace/sqlite-gate-finding-set-chain.ts': {
    release: 'FINDING-TRAJECTORY-BUDGET',
    verdict: 'kept: append-only audit frontier — the latest row id of an append-only chain scoped by exact (workplace_ref, repair_target_role) defines the comparison scope (gate_ref + check_plan_digest); the material (finding keys) then flows through the FULL exact-scope tail read, never through the latest row alone; id is the append ordinal (no wall-clock chronology)',
  },
  'src/infrastructure/workplace/sqlite-recovery-epoch-ledger.ts': {
    release: 'TASK-SHADOW-F4',
    verdict: 'kept: append-only epoch-chain frontier — readRecoveryEpochBaseline picks the MAX epoch row of ONE EXACT (workplace_ref, role) pair (epoch is a per-scope ordinal minted monotonically by the rollover writer under UNIQUE(workplace_ref, role, epoch), never wall-clock chronology); the picked row itself carries the full baseline material (counter baselines + last_diagnosis + created_at backoff anchor) that the budget subtracts, so chronology selects the frontier of an already-exactly-named chain, not a material subject. F4 extracted this SQL from the duplicated composition-root closure + test harness into ONE production owner',
  },
  'src/infrastructure/workplace/sqlite-scope-widening-ledger.ts': {
    release: 'STAGE-13',
    verdict: 'kept: append-only authority-revision frontier — readEffectiveChangeScopes picks the MAX granted_revision row per EXACT task (granted_revision is a per-task ordinal minted monotonically by the decide writer, never wall-clock chronology, and the grant row carries the FULL frozen scope set, so the material flows through the picked row itself); readPendingRequest is the latest undecided append row scoped by exact workplace and a request is decided exactly once (grant/refusal reference request_event_id); no material subject is ever selected by recency',
  },
  'src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts': {
    release: 'ADR-075-§15',
    verdict: 'kept (9d37a9e1): append-only repair-desk frontier — the latest repair_required FINAL gate decision per EXACT workplace_ref (rowid is the append ordinal of the gate-decisions chain, never wall-clock chronology; the verdict filter narrows to the repair-target class); the picked row itself carries the material (candidate set ref + decision key) that the repair desk re-projects, and the desk re-projects an ALREADY-ACCEPTED exact product — chronology selects a repair-cycle boundary, not a material subject',
  },
  'src/process-modules/persistence/sqlite-process-product-repository-v2.ts': {
    release: 'PROCESS-PRODUCT-V2',
    verdict: 'kept: exact-logical-key revision tiebreak — readRowByLogicalKey reads the latest row OF ONE EXACT (process_run_id, product_kind, product_key) triple (id is the insert ordinal among revisions of the same logical key); recency never chooses between different subjects, it picks the current revision of an already-exactly-named product',
  },
});

const allowlist = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'docs', 'architecture', 'legacy-allowlist.json'), 'utf8'),
);
const scan = scanTree();

test('K7: every newest-wins selector in authority persistence is classified, and exactly the allowlisted set', () => {
  const scanned = [...scan.categories['recency-selector-authority-persistence']].sort();
  const classified = Object.keys(CLASSIFICATION).sort();
  const allowed = [...allowlist.categories['recency-selector-authority-persistence'].files].sort();

  assert.deepEqual(
    scanned,
    classified,
    'every file carrying `ORDER BY ... DESC ... LIMIT 1` in the authority '
    + 'persistence scan scope must have a classification entry in '
    + 'tests/architecture/authority-recency-classification.test.mjs (and no '
    + 'stale entries). Chronology may not select a material subject; a new '
    + 'newest-wins selector must either be cut to an exact ref or consciously '
    + 'classified here with rationale and an owning release.',
  );
  assert.deepEqual(
    scanned,
    allowed,
    'the scanned recency set must EXACTLY equal the legacy-allowlist.json '
    + 'baseline (both growth and staleness fail). If you removed a selector, '
    + 're-run `node tools/legacy-freeze.mjs --snapshot` in the same commit.',
  );
});

test('K2 provenance: legacy-allowlist capturedAtSha names a commit whose tree contains every allowlisted file', () => {
  // TASK-SHADOW L3 (2026-08-24): the re-snapshot that admitted
  // sqlite-recovery-epoch-ledger.ts had recorded capturedAtSha=ee4090207ff8 —
  // the pre-commit HEAD — but that tree does NOT contain the file (the
  // snapshot content first exists in c33ee9e2's tree). `--snapshot` runs
  // before its own commit, so the honest provenance value is the FIRST
  // commit whose tree actually carries the captured baseline. This check
  // makes that contract machine-enforced: every allowlisted file must exist
  // in the tree of the named commit, so a future re-snapshot cannot point at
  // a tree that predates the files it claims to have captured.
  assert.match(
    String(allowlist.capturedAtSha),
    /^[0-9a-f]{7,40}$/u,
    'legacy-allowlist.json must record a commit hash as capturedAtSha',
  );
  const ls = spawnSync(
    'git',
    ['-C', REPO_ROOT, 'ls-tree', '-r', '--name-only', String(allowlist.capturedAtSha)],
    { encoding: 'utf8' },
  );
  assert.equal(
    ls.status,
    0,
    `capturedAtSha '${allowlist.capturedAtSha}' must name an existing commit: ${ls.stderr}`,
  );
  const treeFiles = new Set(ls.stdout.split(/\r?\n/));
  for (const [category, entry] of Object.entries(allowlist.categories)) {
    for (const file of entry.files ?? []) {
      assert.ok(
        treeFiles.has(file),
        `capturedAtSha ${allowlist.capturedAtSha} (category '${category}') does not contain `
          + `allowlisted file ${file} — the provenance sha must name a commit whose tree `
          + `actually carries the captured baseline; never invent a hash, point at the `
          + `first commit that truly contains the snapshot content`,
      );
    }
  }
});

test('K7: no K7-owned file remains unclassified as authority-latest-wins', () => {
  for (const [file, entry] of Object.entries(CLASSIFICATION)) {
    if (entry.release !== 'K7') continue;
    assert.match(
      entry.verdict,
      /reclassified|deleted|cut/i,
      `${file}: a K7-owned entry must record a K7 disposition (cut / reclassified with rationale)`,
    );
  }
});

test('K7: the K7-reclassified boundary traversals keep their fail-closed exact verification', () => {
  // The reclassification verdict rests on the exact-verification that follows
  // each boundary selection. Pin the load-bearing error codes so the
  // traversal cannot silently degrade into a plain latest-wins read.
  const carryForward = readFileSync(
    path.join(REPO_ROOT, 'src/infrastructure/workplace/sqlite-author-candidate-carry-forward.ts'),
    'utf8',
  );
  assert.match(carryForward, /AUTHOR_CARRY_FORWARD_FAILED_STAGE_NOT_EXACT/u);
  assert.match(carryForward, /AUTHOR_CARRY_FORWARD_SOURCE_SET_NOT_EXACT/u);
  assert.match(carryForward, /factory_accepted_authority_head/u);

  const adoption = readFileSync(
    path.join(REPO_ROOT, 'src/modules/development/infrastructure/sqlite-development-verification-adoption.ts'),
    'utf8',
  );
  assert.match(adoption, /DEVELOPMENT_VERIFICATION_ADOPTION_BOUNDARY_INVALID/u);
});

test('K7: the deleted latest-wins readers stay deleted', () => {
  // Comment-stripped: the deletion theorem concerns CODE. Explanatory
  // comments documenting the deletion legitimately name the dead method.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');

  const installationRepo = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src/process-modules/persistence/sqlite-process-module-installation-repository.ts'),
    'utf8',
  ));
  assert.doesNotMatch(installationRepo, /findLatestForModule/u);

  const projection = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts'),
    'utf8',
  ));
  assert.match(projection, /PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE/u);
  assert.doesNotMatch(projection, /order by id desc limit 1/iu);

  // CC-GAP-8 independent audit (B2): development-verification-ledger.ts was
  // broadened INTO this allowlist without ADR authority (d58ee94a). The
  // allowlist rule says broadening requires a new ADR; instead of granting
  // one, the newest-wins selector was CUT: recordVerificationTerminalRoute
  // now reads the COMPLETE append chain of the exact run
  // (`ORDER BY id`, ascending, no LIMIT) and folds the per-criterion current
  // state in code — the same full-chain reduction the domain projection
  // performs. The file left the freeze scope the only legal way: by removing
  // the pattern. This pin keeps it out.
  const verificationLedger = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src/modules/development/infrastructure/development-verification-ledger.ts'),
    'utf8',
  ));
  assert.doesNotMatch(
    verificationLedger,
    /order by[^;]*desc[^;]*limit 1/iu,
    'development-verification-ledger.ts must derive per-criterion state from the full append chain, never a newest-wins SQL selector',
  );
});
