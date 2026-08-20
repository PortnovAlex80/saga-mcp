// tests/matrix/d-authority-contradiction.test.mjs
//
// STAGE-16 SPACE D — cross-authority contradiction (defect shape S3): for
// every PAIR of constraints enforced simultaneously on ONE card, does an
// assignment satisfying both exist — and if not, is there a lawful transition
// out of the contradiction?
//
// Stage 14 closed ONE decidable instance (scope-vs-AC via the widening
// ledger, at the LEDGER level: tests/architecture/gate-conjunction-satisfiability.test.mjs).
// This file generalizes it to the FULL pair matrix:
//
//   D1  enumerate the constraints enforced on a single card at once, FROM
//       CODE (provider ids walked out of the installed module definitions;
//       fences, contracts, the ledger and the key authority cited file:line).
//   D2  classify every pair independent / potentially-contradictory with a
//       one-line reason (the table below).
//   D3  for every contradictory pair, prove satisfiability (construct the
//       assignment) or prove the lawful transition — with REAL production
//       functions from ../../dist wherever they exist: the REAL scope gate
//       over a REAL temp git repo, the REAL desk materializer, the REAL
//       review-verdict provider over the REAL candidate-set/authority-head
//       tables, the REAL monotonicity ratchet, the REAL widening ledger.
//   D4  a DOMAIN-FREE RED-grade reproduction for pairs OTHER than scope-vs-AC
//       (review-gate vs fence via ADR-062 deferral; readiness contract vs
//       ratchet via human-required escalation) — proving the
//       contradiction→transition method generalizes beyond stage 14's one
//       instance. Domain-free per brief §0.2: three strings (zzz/thing.txt,
//       aaa/, tests/bbb.test.mjs) — no realistic product.
//   D5  no pair can livelock: a repeated contradiction is CHARGED by the real
//       trajectory budget (never "converging"), a surviving
//       path-outside-authority key mandates re-plan (scope-impossible), and
//       every plan arm carries a typed exit. The honest boundary is stated
//       in the D5 test.
//   D6  the pair matrix with classifications is printed in the test output.
//
// Findings are recorded, not fixed (brief §2). Every assertion here has been
// seen RED (patch dist → RED → restore byte-exact → GREEN); the verbatim RED
// lives in the stage report, not in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';
import { SqliteScopeWideningLedger } from '../../dist/infrastructure/workplace/sqlite-scope-widening-ledger.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { ensureManagedNodeSubmissionSchema } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import {
  createDevelopmentImplementationScopeCheckProvider,
  createDevelopmentReadinessMonotonicityCheckProvider,
} from '../../dist/modules/development/application/development-check-providers.js';
import { createReviewVerdictCheckProvider } from '../../dist/process-modules/application/review-verdict-check-provider.js';
import {
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import {
  materializeManagedSourceChange,
  SOURCE_CHANGE_CANDIDATE_SCHEMA,
} from '../../dist/infrastructure/source-change/managed-source-change-candidate.js';
import {
  findingSet,
  isOrdinalReviewCode,
  trajectory,
} from '../../dist/process-modules/domain/workplace/finding-trajectory.js';
import { resolveDeclaredTestSurface } from '../../dist/modules/development/domain/readiness-test-surface.js';

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the constraint set, enumerated from code (citations are load-bearing:
// they are the authority boundary each pair crosses).
//
// Cards (one card = one Workplace author/review loop):
//   K1 implementation card   development-process-module.ts:242-302
//   K2 readiness-cert card   development-process-module.ts:313-337
//   K3 planner card          development-process-module.ts:204-230
//   K4 verification card     development-process-module.ts:348-398
// A fourth fact cuts across cards: `factory.product-contract.v1` is injected
// into EVERY plan by buildCheckPlan (standard-check-providers.ts:96-101) — the
// plan-level arm of the payload-contract family, validated at seal time by the
// production-cell reconciler. The concrete per-product validators are the
// *-CONTRACT rows below.
// ─────────────────────────────────────────────────────────────────────────────
const CONSTRAINTS = [
  {
    id: 'IMPL-CONTRACT', card: 'K1', family: 'payload-contract',
    demand: 'implementation result shape: workItemKey non-empty, baseCommit/commitSha 40-hex, changedFiles a non-empty path array',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:206-297 (validate 267-297; non-empty changedFiles 285-290)',
  },
  {
    id: 'DESK-FENCE', card: 'K1', family: 'fence',
    demand: 'every submitted change entry lies inside the task\'s CURRENT write authority (ledger effective scopes); base commit equals the frozen desk receipt',
    enforcedAt: 'src/infrastructure/source-change/managed-source-change-candidate.ts:107-115 (containment), 187-192 (base), 206-207 (ledger read), 52-117 (shape)',
  },
  {
    id: 'GATE-FENCE', card: 'K1', family: 'check-plan-provider',
    providerId: 'development.implementation-scope.v1',
    demand: 'declared changedFiles == exact git diff; diff within effective scopes; commit descends from the frozen base; workItemKey == cell_input_item.key',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:717-917 (containment 887-899, exact-set 872-881, key 806-813, ancestry 821-832, branch 837-848)',
  },
  {
    id: 'REVIEW-GATE', card: 'K1', family: 'check-plan-provider',
    providerId: 'factory.review-verdict.v1',
    demand: 'reviewer verdict binds the exact author candidate; changes_requested fails the gate UNLESS every blocking finding is repairable within the frozen scopes (ADR-062 deferral); finding codes are STRUCTURAL (file-scoped)',
    enforcedAt: 'src/process-modules/application/review-verdict-check-provider.ts:100-239 (verdict 151, deferral 169-179+206-222, structural codes 197-199, jurisdiction 247-281); same provider seats every formalization final gate (formalization-process-module.ts:78-87)',
  },
  {
    id: 'REVIEW-CONTRACT', card: 'K1', family: 'payload-contract',
    demand: 'review verdict shape: exact candidate-set/ subject ref, verdict approved|changes_requested, findings an array of strings/objects',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:550-593',
  },
  {
    id: 'WIDEN-LEDGER', card: 'K1', family: 'ledger',
    demand: 'a scope revision may only widen (union, monotone); a widening is granted iff no other LIVE cell\'s authority overlaps; a refusal names every contending holder',
    enforcedAt: 'src/infrastructure/workplace/sqlite-scope-widening-ledger.ts:211-252 (contention), 275-348 (decide), 385-400 (effective scopes never narrow)',
  },
  {
    id: 'CLAIM-RATCHET', card: 'K1', family: 'check-plan-provider',
    providerId: 'development.implementation-claim-monotonicity.v1',
    demand: 'the claimed file surface never silently narrows between submissions of one card — a dropped file is an explicit snapshot.droppedFiles {path, reason} disposition or a failed submission (STAGE-18 R2)',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:1464-1630 (surface 1481-1494, disposition 1499-1512, ratchet 1514-1630); plan seat development.implementation.author.v3 (development-process-module.ts:127-133)',
  },
  {
    id: 'KEY-AUTH', card: 'K1', family: 'key-authority',
    demand: 'the work-item key is the kernel-projected cell_input_item.key, not any non-empty worker string (the units epic-8 cert#37 mis-keying)',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:806-813 (gate); carried in tasks.metadata.cell_input_item.key',
  },
  {
    id: 'READY-CONTRACT', card: 'K2', family: 'payload-contract',
    demand: 'readiness manifest shape: exactly one primary target; commands shape; a served startCommand must NOT hardcode a numeric port (bind the factory-provided PORT)',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:366-450 (port rule 416-425)',
  },
  {
    id: 'RATCHET', card: 'K2', family: 'check-plan-provider',
    providerId: 'development.readiness-profile-monotonicity.v1',
    demand: 'the declared verification surface may never shrink or silently change between readiness manifests of the SAME sourceCandidate',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:1149-1428 (narrowed 1386-1401, changed 1403-1417); escalation wiring development-process-module.ts:146-160',
  },
  {
    id: 'RUNNABILITY', card: 'K2', family: 'check-plan-provider',
    providerId: 'factory.local-runnability.v1',
    demand: 'the declared run contract actually executes against the exact frozen source in a derived environment; the executed check set is DERIVED (declarations are additive-only)',
    enforcedAt: 'plan entry src/process-modules/modules/development/development-process-module.ts:162-182 (failureOwnership upstream at 178); provider identity src/modules/development/application/candidate-check-contracts.ts:21-60',
  },
  {
    id: 'TG-CONTRACT', card: 'K3', family: 'payload-contract',
    demand: 'task-graph proposal shape is decodable before durable submission',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:170-197',
  },
  {
    id: 'TG-GATE', card: 'K3', family: 'check-plan-provider',
    providerId: 'development.task-graph-contract.v1',
    demand: 'graph lineage/coverage/DAG semantics; every SRS §2.2 module file lies inside some implementation item\'s changeScopes',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:602-715 + manifest coverage 935-994 (srs-module-uncovered 982-993)',
  },
  {
    id: 'VERIF-CONTRACT', card: 'K4', family: 'payload-contract',
    demand: 'verification evidence shape: outcome passed|failed|unknown|error, evidence {summary,observations,limitations}, hashes lowercase-sha256',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:516-548',
  },
  {
    id: 'VERIF-GATE', card: 'K4', family: 'check-plan-provider',
    providerId: 'development.verification-product-contract.v2',
    demand: 'exact frozen lineage: verificationItemKey == item key, acceptanceCriterionId == the single card criterion AND the AC artifact id, acceptedCriterionHash/candidateHash match, coveredConstraintIds echo the card-pinned set',
    enforcedAt: 'src/modules/development/application/development-check-providers.ts:1013-1123 (lineage mismatch 1097-1113)',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the pair matrix. cls: 'independent' (cannot contradict — one line why)
// or 'contradiction' (overlapping variables across authorities — why).
// exit (contradiction pairs only, D3): { kind: 'sat' | 'transition' |
// 'sat+transition', proof: 'live:<test>' | 'construction' | 'wiring', detail }.
// ─────────────────────────────────────────────────────────────────────────────
const PAIRS = [
  // ── K1 (implementation card) ──────────────────────────────────────────────
  { a: 'IMPL-CONTRACT', b: 'DESK-FENCE', cls: 'contradiction',
    why: 'both constrain the change path set from different authorities at different moments (shape at submit, containment at the desk)',
    exit: { kind: 'sat', proof: 'live:desk', detail: 'the materialized desk product carries exactly the contract fields (workItemKey, 40-hex base/commit, non-empty files)' } },
  { a: 'IMPL-CONTRACT', b: 'GATE-FENCE', cls: 'contradiction',
    why: 'the contract admits any non-empty changedFiles; the gate demands equality with the git diff AND containment in the frozen authority',
    exit: { kind: 'sat+transition', proof: 'live:gate', detail: 'assignment {changedFiles = git diff ⊆ effective scopes} passes; the contradiction arms are typed (path-outside-authority, changed-files-mismatch) with repair recipes' } },
  { a: 'IMPL-CONTRACT', b: 'REVIEW-GATE', cls: 'independent',
    why: 'disjoint subjects: the contract shapes the author product, the gate consumes the reviewer verdict; any demanded repair can be restated in a contract-valid payload' },
  { a: 'IMPL-CONTRACT', b: 'REVIEW-CONTRACT', cls: 'independent',
    why: 'disjoint subjects (author payload vs reviewer payload); no shared variable' },
  { a: 'IMPL-CONTRACT', b: 'WIDEN-LEDGER', cls: 'independent',
    why: 'the ledger constrains scope revisions and never reads the implementation payload' },
  { a: 'IMPL-CONTRACT', b: 'KEY-AUTH', cls: 'contradiction',
    why: 'the contract admits ANY non-empty workItemKey; the key authority demands the kernel\'s exact cell_input_item.key (the epic-8 cert#37 defect)',
    exit: { kind: 'sat+transition', proof: 'live:gate', detail: 'assignment {workItemKey = cell_input_item.key} passes; divergence fails typed work-item-key-mismatch naming the authoritative value' } },
  { a: 'DESK-FENCE', b: 'GATE-FENCE', cls: 'contradiction',
    why: 'two fences over the same variable at two moments; satisfiable only because the authority between them is monotone (grants only widen)',
    exit: { kind: 'sat+transition', proof: 'live:desk+gate', detail: 'sqlite-scope-widening-ledger.ts:316 (union) and 396-399 (never narrows): whatever passed the desk passes the gate\'s containment later' } },
  { a: 'DESK-FENCE', b: 'REVIEW-GATE', cls: 'contradiction',
    why: 'the reviewer can demand (blocking finding) a write the desk fence forbids',
    exit: { kind: 'transition', proof: 'live:review', detail: 'ADR-062 deferral: a blocking finding whose every path is outside the scopes is DEFERRED to the owning item — the verdict passes, the contradiction dissolves lawfully' } },
  { a: 'DESK-FENCE', b: 'REVIEW-CONTRACT', cls: 'independent',
    why: 'the reviewer payload shape never reads the write authority' },
  { a: 'DESK-FENCE', b: 'WIDEN-LEDGER', cls: 'contradiction',
    why: 'the desk fence\'s authority IS the ledger\'s current revision — the stage-12 deadlock at the desk boundary',
    exit: { kind: 'transition', proof: 'live:desk', detail: 'SOURCE_CHANGE_OUT_OF_SCOPE → recordRequest → decide → grant → the SAME manifest materializes' } },
  { a: 'DESK-FENCE', b: 'KEY-AUTH', cls: 'contradiction',
    why: 'the desk manifest\'s workItemKey is only checked non-empty at the desk (managed-source-change-candidate.ts:148-152); the kernel key is demanded later',
    exit: { kind: 'transition', proof: 'live:gate', detail: 'the gate fails typed work-item-key-mismatch with the recipe — but only AFTER the desk accepted it (FINDING d-2: one epoch burned)' } },
  { a: 'GATE-FENCE', b: 'REVIEW-GATE', cls: 'contradiction',
    why: 'review demands zzz/ while the fence forbids writing zzz/ — the stage-12 shape at the review boundary',
    exit: { kind: 'transition', proof: 'live:review', detail: 'ADR-062 deferral for path-declared findings; otherwise the author\'s lawful exit is worker_done(scope-insufficient) → ledger (the gate\'s own recipe, development-check-providers.ts:894-899)' } },
  { a: 'GATE-FENCE', b: 'REVIEW-CONTRACT', cls: 'independent',
    why: 'the fence reads the author product; the reviewer payload is not its input' },
  { a: 'GATE-FENCE', b: 'WIDEN-LEDGER', cls: 'contradiction',
    why: 'the fence consults the ledger\'s current revision (development-check-providers.ts:887-889) — {diff touches zzz/} ∧ {no grant covers zzz/} is the stage-12 deadlock',
    exit: { kind: 'sat+transition', proof: 'live:gate', detail: 'the REAL gate fails typed → the REAL ledger grants (uncontended) → the SAME submission passes the SAME gate; contended: refusal names the live holder' } },
  { a: 'GATE-FENCE', b: 'KEY-AUTH', cls: 'independent',
    why: 'subsumed: the fence IS the enforcement point of the key authority (806-813) — one constraint, one direction, it cannot contradict itself' },
  { a: 'REVIEW-GATE', b: 'REVIEW-CONTRACT', cls: 'contradiction',
    why: 'the contract admits changes_requested with any findings; the gate may OVERRIDE changes_requested to passed when every blocking finding is out-of-scope',
    exit: { kind: 'sat', proof: 'live:review', detail: 'both arms are lawful and typed: actionable finding → failed(review-finding:<paths>); all-deferred → passed(deferred-out-of-scope:<paths>)' } },
  { a: 'REVIEW-GATE', b: 'WIDEN-LEDGER', cls: 'contradiction',
    why: 'the review gate\'s jurisdiction filter reads the ORIGINAL carve from task metadata (review-verdict-check-provider.ts:274-279), not the ledger\'s widened authority — a blocking finding inside a GRANTED scope is still deferred (FINDING d-1)',
    exit: { kind: 'transition', proof: 'live:review', detail: 'the deferral is itself lawful and information-preserving (the diagnostic rides along); the drift between the two scope authorities is recorded as a finding, not repaired' } },
  { a: 'REVIEW-GATE', b: 'KEY-AUTH', cls: 'independent',
    why: 'the verdict binds candidate-set refs, never work-item keys' },
  { a: 'REVIEW-CONTRACT', b: 'WIDEN-LEDGER', cls: 'independent',
    why: 'payload shape vs scope revisions — disjoint variables' },
  { a: 'REVIEW-CONTRACT', b: 'KEY-AUTH', cls: 'independent',
    why: 'payload shape vs item identity — disjoint variables' },
  { a: 'WIDEN-LEDGER', b: 'KEY-AUTH', cls: 'independent',
    why: 'a grant never changes the item key; the carve is per-key, both kernel-side' },
  { a: 'CLAIM-RATCHET', b: 'IMPL-CONTRACT', cls: 'contradiction',
    why: 'the contract admits any non-empty changedFiles (including a narrowed one); the ratchet demands claim ⊇ union of the prior claims of this card',
    exit: { kind: 'sat+transition', proof: 'live:ratchet', detail: 'assignment {changedFiles ⊇ prior union} passes; a narrowing fails typed IMPLEMENTATION_CLAIM_NARROWED naming the dropped path, with the droppedFiles disposition as the lawful exit' } },
  { a: 'CLAIM-RATCHET', b: 'DESK-FENCE', cls: 'independent',
    why: 'the desk fences paths against the per-attempt write authority; the ratchet compares claims across attempts — disjoint reference frames' },
  { a: 'CLAIM-RATCHET', b: 'GATE-FENCE', cls: 'contradiction',
    why: 'both bind the same changedFiles variable from different references — the gate against the live git diff, the ratchet against the durable prior claims',
    exit: { kind: 'sat', proof: 'live:ratchet', detail: 'assignment {changedFiles = git diff ⊇ union of prior claims} passes both; the stage-15 hole was the gate alone having no cross-attempt memory' } },
  { a: 'CLAIM-RATCHET', b: 'REVIEW-GATE', cls: 'contradiction',
    why: 'a blocking reviewer finding can demand removing a file the card previously claimed',
    exit: { kind: 'transition', proof: 'live:ratchet', detail: 'the removal becomes an EXPLICIT droppedFiles {path, reason} disposition — the typed exit that makes a lawful removal distinguishable from a silent surrender' } },
  { a: 'CLAIM-RATCHET', b: 'REVIEW-CONTRACT', cls: 'independent',
    why: 'disjoint payloads: the ratchet reads the author snapshot, the contract shapes the reviewer verdict' },
  { a: 'CLAIM-RATCHET', b: 'WIDEN-LEDGER', cls: 'independent',
    why: 'the ledger only ever WIDENS the allowed surface (union, monotone); the ratchet forbids voluntary claim shrinkage — the relations compose, they never conflict' },
  { a: 'CLAIM-RATCHET', b: 'KEY-AUTH', cls: 'independent',
    why: 'item identity vs file surface: the ratchet never reads the work-item key' },
  // ── K2 (readiness certification card) ─────────────────────────────────────
  { a: 'READY-CONTRACT', b: 'RATCHET', cls: 'contradiction',
    why: 'the contract admits ANY non-empty testCommand; the ratchet forbids surface shrink or quiet change on the same sourceCandidate',
    exit: { kind: 'sat+transition', proof: 'live:ratchet', detail: 'UNSAT on the card for a narrowed re-declaration → outcome unknown + indeterminateDisposition human-required → complete-blocked; SAT: an identical re-declaration passes' } },
  { a: 'READY-CONTRACT', b: 'RUNNABILITY', cls: 'contradiction',
    why: 'the contract admits any commands; runnability EXECUTES them against the frozen source and can refute them deterministically (and derives the executed set — declarations are additive-only)',
    exit: { kind: 'sat+transition', proof: 'wiring+construction', detail: 'SAT {commands that pass in the derived environment, e.g. serve binds $PORT not a literal}; a deterministic refutation is failureOwnership upstream — the defect re-routes to the producing workshop, never a local repair loop. Boundary: this provider executes real containers (brief §0.2 exception) — proven by plan wiring here, not executed' } },
  { a: 'RATCHET', b: 'RUNNABILITY', cls: 'contradiction',
    why: 'the ratchet freezes the declaration; runnability requires it to pass — {only a passing command differs from the frozen prior} is unsatisfiable on the card',
    exit: { kind: 'sat+transition', proof: 'wiring+construction', detail: 'SAT {the frozen declaration is the passing one}; otherwise the two arms escalate through DIFFERENT typed exits (human-required / upstream) — no third, looping arm exists' } },
  // ── K3 (planner card) ─────────────────────────────────────────────────────
  { a: 'TG-CONTRACT', b: 'TG-GATE', cls: 'contradiction',
    why: 'the contract admits any decodable proposal; the gate demands coverage/lineage/DAG plus SRS §2.2 module-manifest coverage',
    exit: { kind: 'sat+transition', proof: 'construction+wiring', detail: 'SAT {an implementation item\'s changeScopes cover every declared module file}; contradiction arm fails typed (srs-module-uncovered names module+files+declared scopes) into the planner repair loop (maxAttempts 3, onExhausted requeue). Boundary: not executed live — a full DevelopmentCase fixture is a realistic product the brief forbids' } },
  // ── K4 (verification card) ────────────────────────────────────────────────
  { a: 'VERIF-CONTRACT', b: 'VERIF-GATE', cls: 'contradiction',
    why: 'the contract admits any decodable evidence; the gate demands exact frozen lineage (item key, criterion id AND artifact id, both hashes, constraint echo)',
    exit: { kind: 'sat+transition', proof: 'construction+wiring', detail: 'SAT {echo the frozen lineage verbatim}; divergence fails typed verification-lineage-mismatch naming every field (development-check-providers.ts:1108-1112) into the bounded repair loop (maxAttempts 2, onExhausted requeue). Boundary: not executed live — the lineage fixture requires the full AC artifact graph, a realistic product the brief forbids' } },
];

// ─────────────────────────────────────────────────────────────────────────────
// FINDINGS registry (brief §2: findings, not fixes). Every gap this matrix
// found is recorded here with file:line and left alone.
// ─────────────────────────────────────────────────────────────────────────────
const FINDINGS = [
  {
    id: 'd-1', pair: 'REVIEW-GATE × WIDEN-LEDGER',
    gap: 'the review gate\'s ADR-062 jurisdiction filter reads the ORIGINAL carve from task metadata, not the ledger\'s widened effective authority — a blocking finding inside a GRANTED scope is still deferred, so the gate can pass work the author could now lawfully repair',
    at: 'src/process-modules/application/review-verdict-check-provider.ts:274-279 (readSubjectChangeScopes) vs src/modules/development/application/development-check-providers.ts:887-889 (the fence reads effective scopes)',
    severity: 'medium (real run): a review demand repairable under a widened revision is deferred to another item; information preserved in the deferred diagnostic, but the verdict fails open',
  },
  {
    id: 'd-2', pair: 'DESK-FENCE × KEY-AUTH',
    gap: 'the desk materializer accepts ANY non-empty workItemKey; key equality with the kernel cell_input_item.key is enforced only later at the author gate — the desk accepts what the gate rejects',
    at: 'src/infrastructure/source-change/managed-source-change-candidate.ts:148-152 (non-empty only) vs src/modules/development/application/development-check-providers.ts:806-813 (equality)',
    severity: 'low (real run): one burned epoch — the desk materializes a candidate the gate then rejects typed (the units epic-8 cert#37 shape); the typed failure carries the repair recipe',
  },
  {
    id: 'd-3', pair: 'DESK/GATE-FENCE × WIDEN-LEDGER (shared path, D7)',
    gap: 'two LIVE cards that legitimately must write the same root path are refused-by-design: the second gets a typed refusal naming the first holder. This is the stage-15 shared-root shape and the case the stage-13 brief said to escalate — serialized access is lawful, permanent refusal is not',
    at: 'src/infrastructure/workplace/sqlite-scope-widening-ledger.ts:211-252 (findLiveContentionHolders — live workplaces/tasks only) and 295-311 (refusal arm)',
    severity: 'medium (real run): N cards needing one shared root file serialize on it; each waits for the previous holder to complete. NOT a permanent refusal — the D7 test proves the path re-grants after every release axis',
  },
];

// ── shared helpers ───────────────────────────────────────────────────────────

/** Walk an installed module definition and collect (planName, providerId). */
function collectInstalledPlanProviders(moduleDefinition) {
  const found = [];
  const pushPlan = (planName, plan) => {
    for (const entry of plan?.entries ?? []) {
      found.push({ planName, providerId: entry.check?.providerId ?? null });
    }
  };
  for (const node of moduleDefinition.flow?.nodes ?? []) {
    const cell = node.cellDefinition;
    if (!cell) continue;
    if (cell.authorGate?.checkPlan) pushPlan(`${cell.id}:author`, cell.authorGate.checkPlan);
    if (cell.review?.finalGate?.checkPlan ?? cell.review?.checkPlan) {
      pushPlan(`${cell.id}:final`, cell.review?.finalGate?.checkPlan ?? cell.review?.checkPlan);
    }
    if (cell.checkPlan) pushPlan(`${cell.id}:plan`, cell.checkPlan);
  }
  return found;
}

/** Decode a CheckProviderResult to { outcome, diagnostics } (closed 4-valued). */
function decodeResult(result) {
  if (typeof result === 'string') return { outcome: result, diagnostics: [] };
  return {
    outcome: result.outcome,
    diagnostics: result.evidenceRefs.map(ref => decodeCheckDiagnostic(ref)),
  };
}

/** Domain-free temp git repo: base commit touches aaa/seed.txt, worker commit zzz/thing.txt. */
function createTmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-d-repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Matrix D', GIT_AUTHOR_EMAIL: 'matrix@local.invalid',
    GIT_COMMITTER_NAME: 'Matrix D', GIT_COMMITTER_EMAIL: 'matrix@local.invalid',
  };
  const g = args => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(['init', '-q']);
  g(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'aaa'), { recursive: true });
  writeFileSync(join(dir, 'aaa', 'seed.txt'), 'seed\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'base']);
  const base = g(['rev-parse', 'HEAD']);
  mkdirSync(join(dir, 'zzz'), { recursive: true });
  writeFileSync(join(dir, 'zzz', 'thing.txt'), 'zzz\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'worker']);
  const worker = g(['rev-parse', 'HEAD']);
  return { dir, base, worker };
}

/** The REAL GitPort over the REAL git binary (no scripting seam at all). */
const gitPort = {
  read(repoPath, args) {
    const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
  },
  ok(repoPath, args) {
    return spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', windowsHide: true }).status === 0;
  },
};

const digestOf = value => sha256Hex(value);

function seedDb(db) {
  db.exec(SCHEMA_SQL);
  ensureManagedNodeSubmissionSchema(db);
  db.prepare("INSERT INTO projects (name) VALUES ('matrix-d')").run();
  db.prepare("INSERT INTO epics (project_id, name) VALUES (1, 'matrix-d-epic')").run();
  // better-sqlite3 enforces FKs on this connection: every process_run_id a
  // submission references must exist.
  const insertRun = db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, epic_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
     VALUES (?, 1, 1, 'test', '1.0.0', 'test@1.0.0', ?, 'module-adapter', 'x', '{}', 'seed')`,
  );
  for (const runId of [7, 11, 21, 22]) insertRun.run(runId, `matrix-d-${runId}`);
}

function insertWorkplace(db, processRunId, workKey, cellId = 'd-cell') {
  new SqliteWorkplaceRepository(db).materialize({
    processRunId, moduleRef: 'test@1.0.0', productionCellId: cellId, workKey,
  });
  return `workplace/${processRunId}/test@1.0.0/${cellId}/${workKey}`;
}

/** tasks row carrying the kernel-authoritative cell_input_item (role author). */
function insertTask(db, { workplaceRef, key, changeScopes, projectRepositoryId = null }) {
  const info = db.prepare(
    `INSERT INTO tasks (title, status, epic_id, task_kind, workflow_stage, execution_mode, tags, metadata, workplace_ref, project_repository_id)
     VALUES (?, 'todo', 1, 'test.author', 'test', 'tracker_only', '[]', ?, ?, ?)`,
  ).run(
    `matrix-d-${key}`,
    JSON.stringify({ role: 'author', process_run_id: 7, cell_input_item: { key, changeScopes } }),
    workplaceRef,
    projectRepositoryId,
  );
  return Number(info.lastInsertRowid);
}

function insertSubmission(db, { processRunId, taskId, executionId, schema, payload, node }) {
  const snapshot = JSON.stringify(payload);
  const info = db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id, schema_version, payload_snapshot, content_hash)
     VALUES (?, 'test@1.0.0', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(processRunId, node, taskId, executionId, schema, snapshot, digestOf(payload));
  return Number(info.lastInsertRowid);
}

/** A worker execution row (machine_id/phase NOT NULL; worker_id AND task_id
 * are UNIQUE — one execution per task — so several submissions of one task
 * share its execution and differ by node_id). */
function insertExecution(db, executionId, taskId) {
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, phase)
     VALUES (?, 'run-d', 1, 1, ?, ?, 'matrix-machine', 'executing')`,
  ).run(executionId, taskId, `w-${executionId}`);
}

function insertCandidateSet(db, { ref, workplaceRef, role, subject, member }) {
  // FK chain: candidate set -> production revision -> workplace.
  db.prepare(
    `INSERT OR IGNORE INTO factory_workplace_production_revisions
       (revision_ref, workplace_ref, members, contributing_execution_refs, presenter_ref,
        material_digest, semantic_digest, sealed_at)
     VALUES (?, ?, '[]', '[]', 'matrix-d', ?, ?, '2026-01-01T00:00:00Z')`,
  ).run(`rev-d:${ref}`, workplaceRef, digestOf(ref), digestOf(ref));
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref, workplace_ref, production_revision_ref, role, subject_candidate_set_ref, candidate_set_digest, seal_receipt_ref, sealed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'seal-d', '2026-01-01T00:00:00Z')`,
  ).run(ref, workplaceRef, `rev-d:${ref}`, role, subject, digestOf({ ref, member }));
  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref, ordinal, product_schema, product_ref, product_digest, origin, source_candidate_set_ref)
     VALUES (?, 0, ?, ?, ?, 'produced', NULL)`,
  ).run(ref, member.schema, member.ref, member.digest);
}

const LIVE_RESULTS = []; // every real provider outcome observed below (D5 input)

// ─────────────────────────────────────────────────────────────────────────────
// D1/D2 ratchet + D6 print
// ─────────────────────────────────────────────────────────────────────────────
test('space D — D1/D2: the constraint enumeration is the installed code, and the pair matrix is complete over it', () => {
  // Every check provider installed in the development lifecycle is one of the
  // enumerated constraints (or the universal product-contract arm): a new gate
  // cannot be added without entering the pair matrix in the same commit.
  const installed = collectInstalledPlanProviders(developmentProcessModule);
  assert.ok(installed.length >= 5, `module plans did not enumerate (found ${installed.length})`);
  const enumeratedProviders = new Set(CONSTRAINTS.filter(c => c.providerId).map(c => c.providerId));
  const unclassified = installed.filter(({ providerId }) =>
    providerId !== 'factory.product-contract.v1' && !enumeratedProviders.has(providerId));
  assert.deepEqual(
    unclassified.map(e => `${e.planName}:${e.providerId}`), [],
    'a provider is installed in the development lifecycle but missing from the D1 constraint set');
  // No dead rows: every enumerated provider really is installed somewhere.
  const installedIds = new Set(installed.map(e => e.providerId));
  for (const id of enumeratedProviders) {
    assert.ok(installedIds.has(id), `constraint ${id} names a provider no plan installs`);
  }
  // The universal payload-contract arm sits in EVERY plan (buildCheckPlan
  // injects factory.product-contract.v1 — the plan-level contract family).
  for (const planName of new Set(installed.map(e => e.planName))) {
    const hasContract = installed.some(e => e.planName === planName
      && e.providerId === 'factory.product-contract.v1');
    assert.ok(hasContract, `plan ${planName} lacks the product-contract arm`);
  }
  // The review gate is cross-lifecycle: every formalization final gate seats
  // the SAME provider, so REVIEW-GATE's semantics (including its no-scope
  // no-op behaviour on non-repository cards) apply beyond development.
  const formalizationInstalled = collectInstalledPlanProviders(formalizationProcessModule);
  const formalizationFinalProviders = formalizationInstalled
    .filter(e => e.planName.endsWith(':final'))
    .map(e => e.providerId);
  assert.ok(formalizationFinalProviders.length >= 1, 'formalization module exposes no final gates');
  for (const planName of new Set(formalizationInstalled.filter(e => e.planName.endsWith(':final')).map(e => e.planName))) {
    const providers = formalizationInstalled.filter(e => e.planName === planName).map(e => e.providerId);
    assert.ok(providers.includes('factory.review-verdict.v1'),
      `formalization final gate ${planName} does not seat the shared review-verdict provider (has ${providers.join(', ')})`);
  }

  // Completeness: PAIRS is EXACTLY the set of unordered pairs within each card.
  const byCard = new Map();
  for (const c of CONSTRAINTS) {
    if (!byCard.has(c.card)) byCard.set(c.card, []);
    byCard.get(c.card).push(c.id);
  }
  const expected = [];
  for (const [card, ids] of byCard) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        expected.push(`${card}|${[ids[i], ids[j]].sort().join('+')}`);
      }
    }
  }
  const constraintIds = new Set(CONSTRAINTS.map(c => c.id));
  const actual = PAIRS.map(p => {
    const cardA = CONSTRAINTS.find(c => c.id === p.a).card;
    const cardB = CONSTRAINTS.find(c => c.id === p.b).card;
    assert.ok(constraintIds.has(p.a) && constraintIds.has(p.b), `pair names an unenumerated constraint: ${p.a}+${p.b}`);
    assert.equal(cardA, cardB, `pair ${p.a}+${p.b} spans two cards — pairs are within one card`);
    return `${cardA}|${[p.a, p.b].sort().join('+')}`;
  });
  assert.deepEqual([...actual].sort(), [...expected].sort(),
    'the pair matrix must cover every within-card pair exactly once');
  // D3 completeness: every contradictory pair carries an exit (sat or transition).
  for (const p of PAIRS) {
    if (p.cls === 'contradiction') {
      assert.ok(p.exit && ['sat', 'transition', 'sat+transition'].includes(p.exit.kind),
        `contradiction pair ${p.a}+${p.b} has no exit — a defect shape with no lawful resolution`);
    } else {
      assert.equal(p.exit, undefined, `independent pair ${p.a}+${p.b} carries an exit anyway`);
      assert.ok(p.why, `independent pair ${p.a}+${p.b} lacks its one-line reason`);
    }
  }

  // D6 — the pair matrix, printed.
  const contradiction = PAIRS.filter(p => p.cls === 'contradiction');
  // eslint-disable-next-line no-console
  console.log([
    '[space D] pair matrix — '
    + `${CONSTRAINTS.length} constraints, ${PAIRS.length} pairs `
    + `(${contradiction.length} contradiction / ${PAIRS.length - contradiction.length} independent):`,
    ...PAIRS.map(p => `  ${p.cls === 'contradiction' ? '×' : '·'} ${p.a} × ${p.b} — ${p.why}`
      + (p.exit ? ` [exit: ${p.exit.kind}, ${p.exit.proof}]` : '')),
  ].join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 (live) — pair GATE-FENCE × WIDEN-LEDGER: contradiction → typed failure →
// grant → the SAME submission passes the SAME gate; refusal names the holder.
// Also carries the KEY-AUTH arms (pair IMPL-CONTRACT/DESK-FENCE × KEY-AUTH).
// ─────────────────────────────────────────────────────────────────────────────
test('space D — D3 live: the REAL scope gate over a REAL git repo contradicts, the REAL ledger widens, the SAME submission passes; contention refuses with the holder named', () => {
  const repo = createTmpRepo();
  const db = new Database(':memory:');
  try {
    seedDb(db);
    const requesterWp = insertWorkplace(db, 7, 'card-z');
    const holderWp = insertWorkplace(db, 7, 'card-holder');
    db.prepare("INSERT INTO repositories (name) VALUES ('repo-d')").run();
    db.prepare(
      "INSERT INTO project_repositories (project_id, repository_id, local_path, integration_branch) VALUES (1, 1, ?, 'dev')",
    ).run(repo.dir);
    const requesterTaskId = insertTask(db, {
      workplaceRef: requesterWp, key: 'item-z', changeScopes: ['aaa/'], projectRepositoryId: 1,
    });
    // The holder card live-holds the EXACT FILE zzz/other.txt: it does not
    // contend the first request (zzz/thing.txt), but contends any attempt to
    // widen into its file.
    insertTask(db, { workplaceRef: holderWp, key: 'item-h', changeScopes: ['zzz/other.txt'], projectRepositoryId: 1 });
    db.prepare(
      `INSERT INTO factory_effective_desk_base_receipts
         (receipt_ref, execution_ref, task_id, workplace_ref, process_run_id, project_repository_id,
          integration_branch, lineage_anchor_commit, effective_base_commit, observed_integration_head, receipt_digest)
       VALUES ('receipt-z', 'exec-z', ?, ?, 7, 1, 'dev', ?, ?, ?, ?)`,
    ).run(requesterTaskId, requesterWp, repo.base, repo.base, repo.base, 'd'.repeat(64));
    insertExecution(db, 'exec-z', requesterTaskId);

    const payload = {
      workItemKey: 'item-z',
      repository: { baseCommit: repo.base },
      snapshot: { commitSha: repo.worker, changedFiles: ['zzz/thing.txt'] },
    };
    const subId = insertSubmission(db, {
      processRunId: 7, taskId: requesterTaskId, executionId: 'exec-z',
      schema: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, payload, node: 'impl-z',
    });
    insertCandidateSet(db, {
      ref: 'candidate-set/impl-author', workplaceRef: requesterWp, role: 'author', subject: null,
      member: { schema: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, ref: `managed-node-submission:${subId}`, digest: digestOf(payload) },
    });

    const ledger = new SqliteScopeWideningLedger(db);
    const provider = createDevelopmentImplementationScopeCheckProvider({
      db,
      candidateSets: new SqliteCandidateSetRepository(db),
      git: gitPort,
      readEffectiveChangeScopes: (taskId, original) => ledger.readEffectiveChangeScopes(taskId, original),
    });
    const runGate = () => decodeResult(provider.run({
      subjectCandidateSetRef: 'candidate-set/impl-author',
      parameters: { processRunId: 7 },
    }));

    // 1. The conjunction {criteria need zzz/thing.txt} ∧ {frozen authority is aaa/}
    //    CONTRADICTS — the REAL gate says so, typed, with the lawful exit named.
    const contradiction = runGate();
    LIVE_RESULTS.push({ pair: 'GATE-FENCE×WIDEN-LEDGER', result: contradiction });
    assert.equal(contradiction.outcome, 'failed');
    assert.equal(contradiction.diagnostics[0].code, 'path-outside-authority');
    assert.match(contradiction.diagnostics[0].message, /zzz\/thing\.txt/);
    assert.match(contradiction.diagnostics[0].message, /scope-insufficient/);

    // 2. The lawful transition: the ledger grants the uncontended widening.
    const requestId = ledger.recordRequest({
      workplaceRef: requesterWp, taskId: requesterTaskId, role: 'author',
      source: 'worker-declared', requestedScopes: ['zzz/thing.txt'],
    });
    const grant = ledger.decide({ request: { id: requestId, workplace_ref: requesterWp } });
    assert.equal(grant.granted, true);
    assert.equal(grant.grantedRevision, 1);
    assert.deepEqual(grant.grantedScopes, ['aaa/', 'zzz/thing.txt']);

    // 3. SAT: the SAME submission (byte-identical payload, commit, candidate
    //    set) now passes the SAME provider — the conjunction is satisfiable
    //    via the widened revision. No epoch was burned to discover this.
    const satisfied = runGate();
    LIVE_RESULTS.push({ pair: 'GATE-FENCE×WIDEN-LEDGER (sat)', result: satisfied });
    assert.equal(satisfied.outcome, 'passed');

    // 4. The refusal arm: card-holder LIVE-holds zzz/other.txt — a widening
    //    into that file is contended, refused, and the refusal NAMES the
    //    holder (terminal-exit material a human can act on).
    const refusedId = ledger.recordRequest({
      workplaceRef: requesterWp, taskId: requesterTaskId, role: 'author',
      source: 'worker-declared', requestedScopes: ['zzz/other.txt'],
    });
    const refusal = ledger.decide({ request: { id: refusedId, workplace_ref: requesterWp } });
    assert.equal(refusal.granted, false);
    assert.equal(refusal.holders.length, 1);
    assert.equal(refusal.holders[0].workKey, 'card-holder');
    assert.equal(refusal.holders[0].scope, 'zzz/other.txt');

    // 5. KEY-AUTH arms. SAT: the payload above (workItemKey ===
    //    cell_input_item.key 'item-z') already passed the key check. The
    //    contradiction arm: the workplace-key mis-stamp (the real defect) is
    //    rejected typed, with the authoritative value in the recipe.
    const badPayload = { ...payload, workItemKey: 'card-z' };
    const badId = insertSubmission(db, {
      processRunId: 7, taskId: requesterTaskId, executionId: 'exec-z',
      schema: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, payload: badPayload, node: 'impl-badkey',
    });
    insertCandidateSet(db, {
      ref: 'candidate-set/impl-author-badkey', workplaceRef: requesterWp, role: 'author', subject: null,
      member: { schema: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, ref: `managed-node-submission:${badId}`, digest: digestOf(badPayload) },
    });
    const misKeyed = decodeResult(provider.run({
      subjectCandidateSetRef: 'candidate-set/impl-author-badkey',
      parameters: { processRunId: 7 },
    }));
    LIVE_RESULTS.push({ pair: 'IMPL-CONTRACT×KEY-AUTH (contradiction arm)', result: misKeyed });
    assert.equal(misKeyed.outcome, 'failed');
    assert.equal(misKeyed.diagnostics[0].code, 'work-item-key-mismatch');
    assert.match(misKeyed.diagnostics[0].message, /cell_input_item\.key/);
  } finally {
    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 (live) — pairs DESK-FENCE × WIDEN-LEDGER and DESK-FENCE × GATE-FENCE:
// the REAL desk materializer rejects out-of-authority writes, and the SAME
// ledger grant that satisfies the gate satisfies the desk.
// ─────────────────────────────────────────────────────────────────────────────
test('space D — D3 live: the REAL desk fence rejects zzz/thing.txt, the ledger grant widens the desk, the SAME manifest materializes', () => {
  const repo = createTmpRepo();
  const db = new Database(':memory:');
  const deskWp = 'workplace/9/test@1.0.0/desk-cell/card-y';
  try {
    seedDb(db);
    new SqliteWorkplaceRepository(db).materialize({
      processRunId: 9, moduleRef: 'test@1.0.0', productionCellId: 'desk-cell', workKey: 'card-y',
    });
    db.prepare("INSERT INTO repositories (name) VALUES ('repo-d2')").run();
    db.prepare(
      "INSERT INTO project_repositories (project_id, repository_id, local_path, integration_branch) VALUES (1, 1, ?, 'dev')",
    ).run(repo.dir);
    const taskId = insertTask(db, {
      workplaceRef: deskWp, key: 'item-y', changeScopes: ['aaa/'], projectRepositoryId: 1,
    });
    db.prepare(
      `INSERT INTO factory_effective_desk_base_receipts
         (receipt_ref, execution_ref, task_id, workplace_ref, process_run_id, project_repository_id,
          integration_branch, lineage_anchor_commit, effective_base_commit, observed_integration_head, receipt_digest)
       VALUES ('receipt-y', 'exec-y', ?, ?, 9, 1, 'dev', ?, ?, ?, ?)`,
    ).run(taskId, deskWp, repo.base, repo.base, repo.base, 'y'.repeat(64));
    insertExecution(db, 'exec-y', taskId);

    const content = {
      schemaVersion: SOURCE_CHANGE_CANDIDATE_SCHEMA,
      workItemKey: 'item-y',
      baseCommit: repo.base,
      entries: [{ path: 'zzz/thing.txt', operation: 'create', content: 'zzz' }],
    };

    // 1. The contradiction at the desk: the manifest is well-formed but the
    //    path lies outside the frozen authority. Fail BEFORE any durable
    //    submission — no epoch is spent, repair happens in the same execution.
    process.env.SAGA_EXECUTION_ID = 'exec-y';
    assert.throws(
      () => materializeManagedSourceChange(db, SOURCE_CHANGE_CANDIDATE_SCHEMA, content),
      /SOURCE_CHANGE_OUT_OF_SCOPE: zzz\/thing\.txt.*scope-insufficient/s,
    );

    // 2. The SAME transition authority the gate consults.
    const ledger = new SqliteScopeWideningLedger(db);
    const requestId = ledger.recordRequest({
      workplaceRef: deskWp, taskId, role: 'author',
      source: 'worker-declared', requestedScopes: ['zzz/thing.txt'],
    });
    const decision = ledger.decide({ request: { id: requestId, workplace_ref: deskWp } });
    assert.equal(decision.granted, true);

    // 3. SAT: the SAME manifest materializes into a factory-authored git
    //    candidate — and (pair IMPL-CONTRACT × DESK-FENCE) the materialized
    //    product carries exactly the fields the implementation payload
    //    contract validates.
    const materialized = materializeManagedSourceChange(db, SOURCE_CHANGE_CANDIDATE_SCHEMA, content);
    assert.deepEqual(materialized.snapshot.files, ['zzz/thing.txt']);
    assert.match(materialized.source.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(typeof materialized.workItemKey, 'string');
    assert.match(materialized.repository.baseCommit, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(materialized.snapshot.files) && materialized.snapshot.files.length > 0);
  } finally {
    delete process.env.SAGA_EXECUTION_ID;
    db.close();
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 (live #1) — pairs DESK/GATE-FENCE × REVIEW-GATE and REVIEW-GATE ×
// REVIEW-CONTRACT: the REAL review-verdict provider over the REAL
// candidate-set + accepted-authority-head tables. A blocking finding whose
// every path lies OUTSIDE the frozen scopes is DEFERRED (ADR-062) — the
// contradiction reaches a lawful transition, not a livelock. NOT scope-vs-AC:
// the transition here is deferral-to-the-owning-item, decided by the review
// gate itself, not a widening.
// ─────────────────────────────────────────────────────────────────────────────
test('space D — D4 live: review-gate × fence — the out-of-scope blocking finding is DEFERRED; the in-scope one fails the gate', () => {
  const db = new Database(':memory:');
  try {
    seedDb(db);
    const wp = insertWorkplace(db, 11, 'card-r', 'rev-cell');
    const taskId = insertTask(db, {
      workplaceRef: wp, key: 'item-r', changeScopes: ['aaa/'],
    });
    // The ADR-053 B-6 authority: the accepted author task whose immutable
    // candidate set is under review fixes the review's jurisdiction.
    db.prepare(
      `INSERT INTO factory_accepted_authority_head
         (workplace_ref, accepted_author_candidate_set_ref, accepted_author_gate_decision_key, revision, recorded_at, accepted_author_task_id)
       VALUES (?, 'candidate-set/author-r', 'gate-key-1', 1, '2026-01-01T00:00:00Z', ?)`,
    ).run(wp, String(taskId));

    const deferredPayload = {
      subject_candidate_set_ref: 'candidate-set/author-r',
      verdict: 'changes_requested',
      findings: [{ message: 'rework the registry map', severity: 'blocker', paths: ['zzz/thing.txt'] }],
    };
    const actionablePayload = {
      subject_candidate_set_ref: 'candidate-set/author-r',
      verdict: 'changes_requested',
      findings: [{ message: 'fix the seed', severity: 'blocker', paths: ['aaa/seed.txt'] }],
    };
    insertExecution(db, 'exec-r1', taskId);
    const subDeferred = insertSubmission(db, {
      processRunId: 11, taskId, executionId: 'exec-r1',
      schema: DEVELOPMENT_REVIEW_VERDICT_SCHEMA, payload: deferredPayload, node: 'rev-1',
    });
    const subActionable = insertSubmission(db, {
      processRunId: 11, taskId, executionId: 'exec-r1',
      schema: DEVELOPMENT_REVIEW_VERDICT_SCHEMA, payload: actionablePayload, node: 'rev-2',
    });
    insertCandidateSet(db, {
      ref: 'candidate-set/review-deferred', workplaceRef: wp, role: 'reviewer',
      subject: 'candidate-set/author-r',
      member: { schema: DEVELOPMENT_REVIEW_VERDICT_SCHEMA, ref: `managed-node-submission:${subDeferred}`, digest: digestOf(deferredPayload) },
    });
    insertCandidateSet(db, {
      ref: 'candidate-set/review-actionable', workplaceRef: wp, role: 'reviewer',
      subject: 'candidate-set/author-r',
      member: { schema: DEVELOPMENT_REVIEW_VERDICT_SCHEMA, ref: `managed-node-submission:${subActionable}`, digest: digestOf(actionablePayload) },
    });

    const provider = createReviewVerdictCheckProvider({
      db, candidateSets: new SqliteCandidateSetRepository(db),
    });
    const runReview = assessmentRef => decodeResult(provider.run({
      subjectCandidateSetRef: 'candidate-set/author-r',
      parameters: { assessmentCandidateSetRefs: [assessmentRef], verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA },
    }));

    // The contradiction {review demands zzz/thing.txt} ∧ {fence forbids
    // zzz/thing.txt} → DEFERRAL: verdict passes, the finding rides along as a
    // decodable diagnostic addressed to the owning item. Typed, lawful, and
    // NOT the widening path — the method generalizes.
    const deferred = runReview('candidate-set/review-deferred');
    LIVE_RESULTS.push({ pair: 'REVIEW-GATE×FENCE (deferred)', result: deferred });
    assert.equal(deferred.outcome, 'passed');
    assert.equal(deferred.diagnostics[0].code, 'deferred-out-of-scope:zzz/thing.txt');
    assert.match(deferred.diagnostics[0].message, /DEFERRED/);

    // The contrast arm (pair REVIEW-GATE × REVIEW-CONTRACT): an in-scope
    // blocking finding on the same card FAILS the gate — proving the deferral
    // branch above is load-bearing, not decorative.
    const actionable = runReview('candidate-set/review-actionable');
    LIVE_RESULTS.push({ pair: 'REVIEW-GATE×REVIEW-CONTRACT (actionable)', result: actionable });
    assert.equal(actionable.outcome, 'failed');
    assert.equal(actionable.diagnostics[0].code, 'review-finding:aaa/seed.txt');
  } finally {
    db.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 (live #2) — pair READY-CONTRACT × RATCHET: the REAL monotonicity
// provider over the REAL submission history. A contract-valid NARROWED
// re-declaration is unsatisfiable on the card — and the exit is the
// human-required escalation wired in the plan, never a repair loop.
// ─────────────────────────────────────────────────────────────────────────────
test('space D — D4 live: readiness contract × ratchet — the narrowed re-declaration escalates human-required; the identical one passes', () => {
  const db = new Database(':memory:');
  const certWp = 'workplace/21/test@1.0.0/cert-cell/card-c';
  try {
    seedDb(db);
    new SqliteWorkplaceRepository(db).materialize({
      processRunId: 21, moduleRef: 'test@1.0.0', productionCellId: 'cert-cell', workKey: 'card-c',
    });
    const certTaskId = insertTask(db, {
      workplaceRef: certWp, key: 'item-c', changeScopes: ['aaa/'],
    });
    insertExecution(db, 'exec-t1', certTaskId);
    const sourceHash = 'ab'.repeat(32);
    const manifest = testCommand => ({
      schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
      sourceCandidate: {
        schema: 'factory.integrated-source-candidate.v1',
        ref: 'integrated-source-candidate/x',
        hash: sourceHash,
      },
      targets: [{
        key: 'primary',
        readiness: { kind: 'static', commands: { installCommand: null, testCommand } },
      }],
    });
    const wide = manifest('node --test tests/aaa.test.mjs tests/bbb.test.mjs');
    const narrow = manifest('node --test tests/aaa.test.mjs');

    const priorId = insertSubmission(db, {
      processRunId: 21, taskId: certTaskId, executionId: 'exec-t1',
      schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA, payload: wide, node: 'cert-1',
    });
    const currentId = insertSubmission(db, {
      processRunId: 21, taskId: certTaskId, executionId: 'exec-t1',
      schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA, payload: narrow, node: 'cert-2',
    });
    insertCandidateSet(db, {
      ref: 'candidate-set/cert-current', workplaceRef: certWp, role: 'author', subject: null,
      member: { schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA, ref: `managed-node-submission:${currentId}`, digest: digestOf(narrow) },
    });

    const provider = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: new SqliteCandidateSetRepository(db),
      git: { read: () => null, ok: () => false }, // no sealed substrate: the
      // declaration itself enumerates the surface (resolveDeclaredTestSurface
      // below proves that derivation is real and pure).
    });

    // The contradiction, decided mechanically before any epoch burns: the
    // narrowed declaration is contract-valid yet UNSAT against the frozen
    // prior of the same source candidate.
    const escalated = decodeResult(provider.run({
      subjectCandidateSetRef: 'candidate-set/cert-current',
      parameters: { processRunId: 21 },
    }));
    LIVE_RESULTS.push({ pair: 'READY-CONTRACT×RATCHET (escalation)', result: escalated });
    assert.equal(escalated.outcome, 'unknown');
    assert.equal(escalated.diagnostics[0].code, 'READINESS_PROFILE_NARROWED');
    assert.match(escalated.diagnostics[0].message, /tests\/bbb\.test\.mjs/);

    // The transition is TYPED in the installed plan, not just implied: the
    // ratchet entry escalates human-required, and the cell routes that to a
    // terminal blocked outcome — the complete-blocked transition. (A singleton
    // cell with no review seats its plan on the authorGate, phase 'final';
    // humanRequiredTransition maps to transitions.humanRequired.)
    const certCell = developmentProcessModule.flow.nodes
      .find(node => node.id === 'certify-product-readiness').cellDefinition;
    const ratchetEntry = certCell.authorGate.checkPlan.entries
      .find(entry => entry.check.providerId === 'development.readiness-profile-monotonicity.v1');
    assert.equal(ratchetEntry.indeterminateDisposition, 'human-required');
    assert.equal(certCell.transitions.humanRequired, 'complete-blocked');

    // SAT arm: an IDENTICAL re-declaration (fresh run, nothing narrowed)
    // passes — the conjunction is satisfiable, the ratchet only forbids
    // shrink/quiet-change.
    const again = manifest('node --test tests/aaa.test.mjs tests/bbb.test.mjs');
    const stableId1 = insertSubmission(db, {
      processRunId: 22, taskId: certTaskId, executionId: 'exec-t1',
      schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA, payload: again, node: 'cert-3',
    });
    const stableId2 = insertSubmission(db, {
      processRunId: 22, taskId: certTaskId, executionId: 'exec-t1',
      schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA, payload: again, node: 'cert-4',
    });
    insertCandidateSet(db, {
      ref: 'candidate-set/cert-stable', workplaceRef: certWp, role: 'author', subject: null,
      member: { schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA, ref: `managed-node-submission:${stableId2}`, digest: digestOf(again) },
    });
    assert.ok(stableId1 !== stableId2, 'two distinct submissions of identical commands');
    const stable = decodeResult(provider.run({
      subjectCandidateSetRef: 'candidate-set/cert-stable',
      parameters: { processRunId: 22 },
    }));
    LIVE_RESULTS.push({ pair: 'READY-CONTRACT×RATCHET (sat)', result: stable });
    assert.equal(stable.outcome, 'passed');

    // The surface derivation the ratchet (and runnability) rely on is real
    // and pure — the narrowing above was decided by THIS tokenizer, both
    // files enumerable from the wide command, one from the narrow one.
    assert.deepEqual(
      resolveDeclaredTestSurface({
        testCommand: 'node --test tests/aaa.test.mjs tests/bbb.test.mjs',
        sealedPackageJsonTestScript: null,
      }).files,
      ['tests/aaa.test.mjs', 'tests/bbb.test.mjs'],
    );
    assert.deepEqual(
      resolveDeclaredTestSurface({
        testCommand: 'node --test tests/aaa.test.mjs',
        sealedPackageJsonTestScript: null,
      }).files,
      ['tests/aaa.test.mjs'],
    );
  } finally {
    db.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 — no pair can livelock. This cannot be proven purely (the trajectory
// predicate is pure and cannot see the dispatch policy), so the STRUCTURAL
// properties that guarantee it are asserted, and the boundary is stated:
//
//   (1) every real provider arm observed above returned a CLOSED 4-valued
//       CheckProviderResult (gate.ts:72) — there is no fifth arm to spin on;
//   (2) a repeated contradiction is always CHARGED by the REAL trajectory
//       budget (finding-trajectory.ts:171-193) — never misread as converging —
//       and a surviving path-outside-authority key is scope-impossible: a
//       re-plan mandate, never another attempt;
//   (3) review finding codes are STRUCTURAL (review-finding:<paths>), so a
//       repeating review demand cannot hide behind the legacy ordinal
//       exclusion;
//   (4) every check-plan entry that can fail carries a typed exit (repair
//       target, escalation disposition, or upstream ownership) — the planner
//       entry's exit is the CELL recovery (maxAttempts 3, onExhausted
//       requeue), both typed transitions, not epoch repeats.
//
// Boundary, honestly: (1)-(4) constrain every arm this matrix can reach. A
// livelock would require a NEW arm outside the closed result type or a
// dispatch policy that ignores exhaustion — both outside any single pair and
// owned by the progress space (tests/matrix/a-progress-space.test.mjs
// classifies repair_wait|exhausted as stalled with the budget executor as
// owner).
// ─────────────────────────────────────────────────────────────────────────────
test('space D — D5: every observed arm is a closed typed outcome; a repeated contradiction is charged, a surviving scope violation mandates re-plan; every failing plan arm has a typed exit', () => {
  // (1) closed arms — every live result from the D3/D4 tests.
  assert.equal(LIVE_RESULTS.length, 7, 'the live tests above must have recorded exactly their seven provider outcomes');
  for (const { pair, result } of LIVE_RESULTS) {
    assert.ok(['passed', 'failed', 'unknown', 'error'].includes(result.outcome),
      `${pair}: outcome ${result.outcome} is not one of the four closed arms`);
  }
  const failedArms = LIVE_RESULTS.filter(({ result }) => result.outcome === 'failed');
  assert.ok(failedArms.length >= 2, 'contradiction arms must actually have been observed failing');
  for (const { result } of failedArms) {
    assert.ok(result.diagnostics.length >= 1 && result.diagnostics[0].code,
      'a failed arm must carry a decodable typed diagnostic');
  }

  // (2) the contradiction signatures of the matrix, repeated across two
  // attempts: the REAL trajectory predicate must charge every one of them.
  const signature = code => findingSet([{ code, severity: 'error', message: 'zzz/thing.txt is outside frozen changeScopes [aaa/]' }]);
  const REPEATED = [
    { code: 'development.implementation-scope.v1:path-outside-authority', scopeImpossible: true, pairs: 'GATE-FENCE×WIDEN-LEDGER, ×REVIEW-GATE, ×IMPL-CONTRACT (scope family)' },
    { code: 'development.implementation-scope.v1:changed-files-mismatch', scopeImpossible: false, pairs: 'IMPL-CONTRACT×GATE-FENCE (exact-set arm)' },
    { code: 'development.implementation-scope.v1:work-item-key-mismatch', scopeImpossible: false, pairs: 'IMPL-CONTRACT×KEY-AUTH, DESK-FENCE×KEY-AUTH' },
    { code: 'factory.review-verdict.v1:review-finding:zzz/thing.txt', scopeImpossible: false, pairs: 'REVIEW-GATE×REVIEW-CONTRACT, ×FENCE (actionable arm)' },
    { code: 'development.task-graph-contract.v1:srs-module-uncovered', scopeImpossible: false, pairs: 'TG-CONTRACT×TG-GATE' },
  ];
  for (const s of REPEATED) {
    const t = trajectory(signature(s.code), signature(s.code));
    assert.ok(t !== 'converging',
      `${s.code} repeated must never read as converging (it would ride free)`);
    if (s.scopeImpossible) {
      assert.equal(t, 'scope-impossible',
        `${s.code} repeated must mandate re-plan (REPLAN-CYCLE-TZ §1), not another attempt`);
    } else {
      assert.equal(t, 'spinning', `${s.code} repeated must be charged as spinning`);
    }
  }
  // The escalation-family pairs never enter a repair loop at all: the ratchet
  // arm is 'unknown' with disposition human-required (asserted live above),
  // and the runnability arm is upstream-owned — asserted by wiring below.
  const certCell = developmentProcessModule.flow.nodes
    .find(node => node.id === 'certify-product-readiness').cellDefinition;
  const runnabilityEntry = certCell.authorGate.checkPlan.entries
    .find(entry => entry.check.providerId === 'factory.local-runnability.v1');
  assert.equal(runnabilityEntry.failureOwnership, 'upstream',
    'a refuted run contract must re-route to the producing workshop, not retry here');

  // (3) structural review codes are comparable; only the LEGACY ordinal shape
  // stays excluded (by design — finding-trajectory.ts:34-44).
  assert.equal(isOrdinalReviewCode('factory.review-verdict.v1:review-finding:zzz/thing.txt'), false);
  assert.equal(isOrdinalReviewCode('factory.review-verdict.v1:review-finding-3'), true);

  // (4) typed exits across the whole installed lifecycle.
  const installed = collectInstalledPlanProviders(developmentProcessModule);
  const plansById = new Map();
  for (const node of developmentProcessModule.flow.nodes) {
    const cell = node.cellDefinition;
    if (!cell) continue;
    if (cell.authorGate?.checkPlan) plansById.set(`${cell.id}:author`, { plan: cell.authorGate.checkPlan, cell });
    if (cell.review?.finalGate?.checkPlan ?? cell.review?.checkPlan) {
      plansById.set(`${cell.id}:final`, { plan: cell.review?.finalGate?.checkPlan ?? cell.review?.checkPlan, cell });
    }
    if (cell.checkPlan) plansById.set(`${cell.id}:plan`, { plan: cell.checkPlan, cell });
  }
  for (const { planName, providerId } of installed) {
    if (providerId === 'factory.product-contract.v1') continue; // validated at
    // seal time by the reconciler; its failure is a submission-time rejection
    // in the same execution (the desk firewall), not a gate arm.
    const { plan, cell } = plansById.get(planName);
    const entry = plan.entries.find(e => e.check.providerId === providerId);
    const hasTypedExit = Boolean(entry.repairTargetRoleOnFailure
      || entry.repairTargetRoleOnIndeterminate
      || entry.indeterminateDisposition
      || entry.failureOwnership);
    if (!hasTypedExit) {
      // The remaining exit is the CELL recovery: a bounded attempt budget
      // whose exhaustion is a typed transition (requeue/terminal), never an
      // epoch repeat. Currently the planner's task-graph entry.
      assert.ok(cell.recovery?.maxAttempts >= 1 || cell.maxAttempts >= 1,
        `${planName}:${providerId} has neither a plan-level typed exit nor cell recovery — an unbounded loop`);
      const onExhausted = cell.recovery?.onExhausted ?? cell.onExhausted;
      assert.ok(['requeue', 'terminal', 'pause'].includes(onExhausted),
        `${planName}:${providerId} exhaustion routes to untyped ${String(onExhausted)}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D7 (brief item added by 4e1fd982) — shared-path contention. Found live in
// stage 15: two cards blocked on the same ROOT-LEVEL file. Root configuration
// belongs to no card and is needed by many. Domain-free case: N cards
// (dir-1/, dir-2/, dir-3/), one shared root path (shared.config), needed
// SEQUENTIALLY, decided by the REAL widening ledger over SCHEMA_SQL.
//
// The property under test: the contention rule never PERMANENTLY refuses a
// path that no LIVE card owns. Refusal may exist only while a live holder
// holds; every release axis (workplace terminal, holder task cancelled) must
// re-open the path to the next card. A refusal with no live holder would be
// FINDING d-3's hard form (stale grant rows acting as permanent claims) —
// the suite would go RED stating it, not silently pass.
// ─────────────────────────────────────────────────────────────────────────────
test('space D — D7: shared-path contention — N cards, one shared root path; refusal exists only while a LIVE holder holds it', () => {
  const db = new Database(':memory:');
  try {
    seedDb(db);
    const SHARED = 'shared.config'; // root-level file, owned by no card's carve
    const cards = [1, 2, 3].map(n => {
      const wp = insertWorkplace(db, 7, `card-${n}`);
      const taskId = insertTask(db, {
        workplaceRef: wp, key: `item-${n}`, changeScopes: [`dir-${n}/`],
      });
      return { n, wp, taskId };
    });
    const ledger = new SqliteScopeWideningLedger(db);
    const requestShared = card => {
      const requestId = ledger.recordRequest({
        workplaceRef: card.wp, taskId: card.taskId, role: 'author',
        source: 'worker-declared', requestedScopes: [SHARED],
      });
      return ledger.decide({ request: { id: requestId, workplace_ref: card.wp } });
    };

    // 1. The first needer is uncontended: the shared path grants (root config
    //    belongs to no card, so nothing contends it until someone holds it).
    let decision = requestShared(cards[0]);
    assert.equal(decision.granted, true);
    assert.deepEqual(decision.grantedScopes, ['dir-1/', 'shared.config']);

    // 2. SIMULTANEOUS need — the stage-15 shape: while card-1 is LIVE, the
    //    same root path is refused to card-2, with the holder named. This is
    //    FINDING d-3's by-design half: serialized access to a shared root,
    //    typed, with a witness (the stage-13 brief's escalate case).
    decision = requestShared(cards[1]);
    assert.equal(decision.granted, false);
    assert.equal(decision.holders.length, 1);
    assert.equal(decision.holders[0].workKey, 'card-1');
    assert.equal(decision.holders[0].scope, SHARED);

    // 3. RELEASE AXIS 1 — card-1 completes (workplace reaches terminal). Its
    //    grant rows are immutable and STILL ON the append-only ledger; they
    //    must not act as a permanent claim. The same path must now grant.
    db.prepare("UPDATE factory_workplaces SET loop_state='terminal' WHERE workplace_ref=?")
      .run(cards[0].wp);
    const survivingGrants = db.prepare(
      "SELECT COUNT(*) AS n FROM factory_scope_widening_events WHERE event_kind='grant'",
    ).get().n;
    assert.ok(survivingGrants >= 1, 'the released holder\'s grant rows remain on the immutable ledger');
    decision = requestShared(cards[1]);
    assert.equal(decision.granted, true,
      'FINDING d-3 (hard form): shared.config was refused with NO live holder — a released card\'s grant still blocks. That is a permanent refusal of a path no card owns');

    // 4. The chain persists while holders are live: card-3 is refused while
    //    card-2 (now the holder) is live — sequencing, not deadlock.
    decision = requestShared(cards[2]);
    assert.equal(decision.granted, false);
    assert.equal(decision.holders[0].workKey, 'card-2');

    // 5. RELEASE AXIS 2 — the holder task is cancelled (the other exclusion
    //    arm of findLiveContentionHolders): the path re-opens the same way.
    db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(cards[1].taskId);
    decision = requestShared(cards[2]);
    assert.equal(decision.granted, true,
      'a cancelled holder task must release the shared path — refusal may never outlive the holder');

    // 6. The completed chain: every card that needed the shared root got it —
    //    sequentially, lawfully, and no path was permanently refused.
    const grantedTo = db.prepare(
      `SELECT DISTINCT w.work_key AS workKey
         FROM factory_scope_widening_events e
         JOIN factory_workplaces w ON w.workplace_ref = e.workplace_ref
        WHERE e.event_kind='grant' AND e.granted_scopes LIKE '%shared.config%'
        ORDER BY workKey`,
    ).all().map(row => row.workKey);
    assert.deepEqual(grantedTo, ['card-1', 'card-2', 'card-3']);
  } finally {
    db.close();
  }
});
