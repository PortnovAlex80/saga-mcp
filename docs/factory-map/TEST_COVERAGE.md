# TEST_COVERAGE — reconciled evidence labels and the coverage universe (as of `6a983c47`)

- **Sources of truth (machine):** `tools/run-acceptance-matrix.mjs` (9 groups,
  6 quarantine rows, `--list-json` export is the ONLY supported machine
  surface per ADR-092) and `.github/workflows/ci.yml` (each group an isolated
  blocking step, ubuntu-only, branches `dev|main|saga2-refactoring|saga4`).
- **Sources of truth (corpus):** `tests/factory-evidence/**` bundles +
  `tests/factory-proof/workshop-inventory.baseline.json` rows.
- This file RECONCILES the strata coverage sections (01–04) with the registry
  and the red-team census; it does not replace them. Labels stay DISTINCT —
  never merged into one "covered" bit (00 contract §5).

## 1. The closed label set (vocabulary of this reconciliation)

| Label | Meaning (exact) | Minimal justification |
|---|---|---|
| `declared` | the fact exists as a declaration in source/manifest/descriptor | `path:line` of the declaration |
| `test-file-exists` | a test file exercising the claim exists on disk at the cited commit (renames the 00-contract `file-exists` for tests; NOT evidence of execution) | `path` existence |
| `demonstrated` | a committed run artifact or green standalone execution shows the behavior, but NO blocking host proves it | artifact `path` (+ scenario id) or standalone-run record |
| `matrix-hosted` | the suite is enumerated by an acceptance-matrix group (run-set member per `--list-json`) | group + exact file |
| `CI-executed` | the group is invoked by a ci.yml step (matrix-hosted AND a ci step exists) | step name + `ci.yml:line` |
| `CI-blocking` | a red result fails CI with no `|| true`, no continue-on-error, no retry (CI-02 exit rule; additionally pinned by a per-file removal guard where noted) | step + guard citation |
| `pending` | a proof is owed and does not exist yet (declared obligation without a file) | owning plan/tracker row |
  | `quarantine` | file is deliberately EXCLUDED from blocking CI with a documented FLAKY / PRE-EXISTING-RED reason (at most `test-file-exists`/`demonstrated`; never CI-executed) | `run-acceptance-matrix.mjs:246-265` row |
| `platform/fault-edge` | claim proven only on a platform arm CI does not execute (win32), or only as an injected fault-edge in a workshop inventory row | arm/row citation |

Label lattice: `CI-blocking ⊂ CI-executed ⊂ matrix-hosted`; `quarantine` and
`matrix-hosted` are disjoint; `platform/fault-edge` is orthogonal provenance
metadata, not a strength grade.

## 2. Registry facts (reconciler-verified, not narrated)

- 9 groups: `architecture`, `factory-model`, `readiness-fencing`,
  `factory-contract`, `process-modules` (concurrency=1; THIRTEEN exact-file
  adoptions at `tools/run-acceptance-matrix.mjs:89-153`: the CC-GAP-8 pair
  [verification-ledger, terminal-exit-accounting], the Elite-8
  worker-prompt-assembly file, the six desk-coverage adoptions from
  5d020f9f [task-graph-register-conditional-coverage,
  task-graph-gate-srs-manifest, local-runnability-substrate-retry,
  local-runnability-toctou-reprobe, environment-identity,
  local-runnability-seam-compose], the ADR-095 Phase-2
  migration-conformance file, the TWO BM-5 file-identity files
  [srs-file-identity-satisfiability, srs-derived-change-scopes — the latter
  closed its TC-7 orphan row on 2026-08-24], and the ADR-095 Phase-3.1
  conveyor v4.3 focused-invariants file added by the canonical line
  [TRUTH UPDATE, canonical BM-5 integration 2026-08-24: the BM-5 branch
  counted TWELVE at `:89-139` because its base predated the canonical
  Phase-3.1 hosting; re-derived from the `--list-json` export at `6a983c47`
  — process-modules 138 files, factory-contract 22, factory-proof 23,
  architecture 78, discovery-live-v2 8, readiness-fencing 12,
  factory-model 1, matrix-coverage 1, cc-proof-registry 1]),
  `discovery-live-v2` (8 exact files, ADR-095 Phase-2A/2B),
  `matrix-coverage` (self-check),
  `cc-proof-registry` (bidirectional manifest↔matrix↔CI closure, ADR-092),
  `factory-proof` (23 exact files: W0 kernel, W1 verticals, CC-10A measuring
  surface).
- 6 quarantine rows: golden-path (FLAKY), parallel-git-desk (FLAKY),
  factory-temporal/* (FLAKY), development-task-graph-diagnostics
  (PRE-EXISTING-RED), submission-validator-diagnostics (PRE-EXISTING-RED),
  local-runnability-check-provider (FLAKY) (`:246-265`).
- CI additionally runs non-matrix blocking gates: dispatcher-race scripts,
  cgad-spec-lint unit suite, completion-evidence validation
  (`ci.yml:80-106`).

## 3. Per-stratum reconciled coverage (TC rows; cited by the tracker)

| id | Subject | Strongest label | Evidence |
|---|---|---|---|
| TC-1 | Discovery cells + settlement + handoff (BM-2/BM-3) | CI-blocking (pack validation, handoff); corpus matrix-hosted | `tests/factory-proof/discovery-scenario-pack.test.mjs`, `discovery-resilience-pack.test.mjs` (group factory-proof, `ci.yml:123-124`); `tests/process-modules/discovery-output-handoff.test.mjs` (`ci.yml:77-78`); corpus `tests/factory-evidence/discovery/*.json` |
| TC-2 | `tests/discovery/**` (20 files incl. d1–d7) + `tests/modules/discovery/**` | test-file-exists (orphans) | no group globs them (`run-acceptance-matrix.mjs:64-233`); incl. two ADR-090 proof files (`RED-TEAM-AUDIT.md:103-106`) |
| TC-3 | Formalization spine + constraint relay + warrant (BM-4/BM-5 identity half) | CI-blocking | `formalization-constraint-coverage`, `-package-manifest`, `-solution-contract-hashes`, `-warrant-ref`, `e-constraint-loss`, `srs-d2-parser` (groups process-modules/factory-contract) |
| TC-4 | Formalization module-local suites (`tests/modules/formalization/**`) | test-file-exists (orphans) | heading-resolution, artifact-ref-bridge (`02_FORMALIZATION.md:320-322`) |
| TC-5 | Development planner gates: register-conditional coverage + §2.2 manifest (BM-5 satisfiability half) | CI-executed (exact-file); per-file removal guard for the TC-5 pair still ABSENT (G2g covers only terminal-exit-accounting; G2m covers the BM-5 pair) | `task-graph-register-conditional-coverage.test.mjs`, `task-graph-gate-srs-manifest.test.mjs` (`run-acceptance-matrix.mjs:108-109`); guard gap: deleting either TC-5 file does not redden the matrix (`RED-TEAM-AUDIT.md:106-115`) |
| TC-6 | Development implementation/verification/readiness substrate | CI-executed (glob + 4 exact substrate files) | `run-acceptance-matrix.mjs:83-122`; readiness real-process file quarantined FLAKY (`:262-264`) → substrate TIMING = platform/fault-edge |
| TC-7 | `tests/modules/development/**` 15 files | 6 hosted (verification-ledger, terminal-exit-accounting, TC-5 pair, BM-5 pair) — NINE orphans | orphan list: text-set-manifest, srs-module-manifest, settlement-placeholder-verdict, readiness-test-surface, implementation-workset-item-key, implementation-scope-workitemkey, implementation-scope-ancestry, factory-managed-repository-paths, development-verification-check-provider (`03_DEVELOPMENT.md:754-760`); TRUTH UPDATE 2026-08-24: srs-derived-change-scopes + srs-file-identity-satisfiability left this orphan set when BM-5 §4.5 hosted them (guard G2m) |
| TC-8 | Delivery kernel + effect ledger + approval inbox (BM-12/BM-13) | CI-blocking | `deferred-delivery`, `delivery-approval-inbox`, `product-delivery-lifecycle-e2e`, `product-lifecycle-policies`, effect-ledger/exactly-once suites, `delivery-kernel-unification.test.mjs` (factory-proof) |
| TC-9 | Task-shadow port (SM-14) on a REAL multi-task singleton workplace | **pending** (R3) — no test exists; every unit stubs the port | `RED-TEAM-AUDIT.md:80-86,139-140` |
| TC-10 | §2.2 × §D2/§D1 cross-section satisfiability (Elite-8 counterexample, BM-5 §4) | CI-blocking (exact-file, RED/GREEN pinned, G2m removal guard) since 2026-08-24 | `srs-file-identity-satisfiability.test.mjs` hosted in process-modules (`BRIDGE_MATRIX.md` §4.5); RED proven on the unfixed tree (correct plan rejected `srs-module-uncovered`); Red-Team correction follow-up same day: masking/directory/registerless/boundary regressions + code-scoped upstream routing proof (`srs-identity-upstream-routing.test.mjs`, factory-contract group) |
| TC-11 | `worker-prompt-assembly` (Elite-8 G1.9 recovery_feedback bound) | CI-executed (exact-file, adopted 6e383a10) | `run-acceptance-matrix.mjs:98-103` |
| TC-12 | Windows host arms (taskkill fallback, 5s exit-without-close, win32 docker readiness) | platform/fault-edge (CI ubuntu-only) | `RED-TEAM-AUDIT.md:70-76`; `ci.yml:11` |
| TC-13 | Delivery effect contracts (`tests/modules/delivery/delivery-effect-contracts.test.mjs`) + `tests/matrix/f-authority-delivery.test.mjs` | test-file-exists (orphans) | no group hosts them (`04_DELIVERY.md:477-489`) |
| TC-14 | `released` full-run existence evidence | demonstrated (existence only) | `tests/factory-evidence/delivery/delivery_happy-released-authorized.json` (reverse-map usage discipline) |
| TC-15 | Matrix self-closure | CI-blocking | `matrix-coverage` + `cc-proof-registry` groups (`ci.yml:108-126`) |

## 4. Production-derived universe gaps (census)

Census authority: 9-team red-team audit on `cc/elite7-run` 5d020f9f + live
Elite-6/7/8 DBs (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md`,
commit 91af2982, merged into this line via ab397ff7):

1. **234/503 test files (47%) outside any CI path** = 219 unmanaged orphans +
   15 quarantined. Structural cause: hosting is file-by-file; NO omnibus
   "every *.test.mjs is [run] or [quarantine]" invariant exists (remedy R1).
2. **Stale quarantine:** 16/16 autonomous runs of quarantined files green;
   BOTH PRE-EXISTING-RED reasons falsified standalone on the current tree
   (self-check checks reason TEXT, not truth; re-admission is a deliberate
   two-file edit nobody did after the fixes) (`RED-TEAM-AUDIT.md:52-61`).
3. **Per-file removal guards:** of the nine exact-file adoptions in
   process-modules only terminal-exit-accounting is pinned; deleting any other
   does not redden the matrix (`RED-TEAM-AUDIT.md:106-115`).
4. **Orphan-hosting death class is recurring** (×3; structural) — predicted
   next-death #1 (`RED-TEAM-AUDIT.md:126-127`).
5. **Fixture-scale gap:** fixtures 1–2 AC (52–117 B) vs production 15–22 AC
   15–20 KB docs; 15 artifacts in ONE file with ONE shared content_hash
   (Elite-8); 17 findings × 10.7 KB evolving; recovery_feedback 168 KB;
   6 planner attempts vs max 3. Remaining gap: multi-round feedback
   evolution, corpus cardinality, monolithic-document shape (`:21-32`).
6. **Untestable-seam census (10 envelopes):** S1 delivery continuation grant
   — ZERO tests (kills a run at the cheapest stage after full development
   payment); S2 formalization settlement envelope (Elite-7 shape); S3 delivery
   restart idempotency (double-deploy visible escape); same Elite-7
   first-node-blindness class still in 4 development/replay readers
   (`:34-39`).
7. **Corpus vs live model (11 unsimulated classes):** provider-abort before
   first tool (the Elite-8 killer), monolithic fragment documents, multi-
   finding KB verdicts with evolution, trace_delete storms, double
   worker_done, persistent disobedience under evolving feedback, feedback
   growth to prompt death, approve-over-live-defect, scale, nonconvergent
   end (park with live execution) (`:42-51`).
8. **Teaching vs enforcement (A:18 / B:10):** mandatory SRS sections declared
   but read by NO validator; 10 refusal codes the model cannot foresee —
   incl. `srs-module-manifest-missing` ordering the PLANNER to add §2.2 to a
   FROZEN SRS (`:62-68`).
9. **Deaths→tests matrix:** covered fixture-shape 2/2, enforcement-gap 2/3;
   open: orphan-hosting, prompt-size (half: one channel bundled, gate
   default-off without a test — R4), substrate-timing; three classes with NO
   test genre at all (GAP-7 browser oracle, B-drain replay, F-A gate); the
   death census itself is incomplete (Elite-2, Elite-5 unrecorded)
   (`:117-123`).

## 5. Replay / external / human boundaries (label discipline)

- Replay: capsule machinery proofs are unit/demonstrated; W9 two-pass replay
  E2E is out-of-matrix by design (CI-02 commentary); the 3rd-lifecycle binder
  hazard has NO test (STATE_MATRIX §5.3) — `pending`.
- External: no CI against real registries/git hosts/deployment targets;
  no-force/no-bypass runs against doubles — `platform/fault-edge` for the
  doubles, `pending` for real-remote proofs.
- Human: approval-inbox pending demonstrated; live operator-delay resume
  (lease expiry, process restart) `pending`.

## 6. What would change the labels (owned by PRE-ELITE9-TRACKER)

- R1 omnibus matrix invariant → converts the orphan class from invisible to
  CI-blocking-by-absence (label flips test-file-exists → quarantine-typed or
  matrix-hosted).
- R2 quarantine re-validation schedule + self-check truth runs → stale
  PRE-EXISTING-RED rows flip to matrix-hosted or gain fresh honest reasons.
- R3 task-shadow integration test → TC-9 pending → CI-executed.
- R4 `SAGA_PROMPT_MAX_BYTES` default-on + gate test → prompt-size half-open
  closes.
- R5 win32 CI arm or platform-probe contract tests → TC-12 platform/fault-edge
  → CI-executed.
- Elite-8-scale producer-diversity corpus (incl. §2.2 bare-filename vs §D2
  full-path joint-satisfiability negative test, TC-10) → BM-5 PARTIAL →
  PROVEN or honestly FAILED-with-guard. UPDATE 2026-08-24: the TC-10 core
  (identity half) landed hosted RED/GREEN (BM-5 §4.5); the wider
  producer-diversity corpus (R6 shapes: monolithic docs, multi-finding
  verdicts, trace_delete storms, 15–22 AC documents) remains open.
