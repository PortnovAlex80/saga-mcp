# Formalization Scenario-First Refactoring — Execution Tracker

> **BASE CAVEAT (operator correction, 2026-08-27):** this WP01 was taken at
> `5c158608` — THREE COMMITS ABOVE the qualified EK closure `be0d5948`
> (b218f42b model/rate-limit change + 07b9b1f2 single R1 flash verify +
> 5c158608 front clones). Those commits had NOT passed full re-qualification
> when this baseline was captured. Status: RESEARCH RESULT ONLY. The operator
> directed the coordinator to officially qualify the post-closure commits
> (full EK-11 + EK-12 series on the new kit) and re-take the baseline from
> the advanced canonical saga4 before WP02 starts. The artifacts below are
> valid as inventory/research; the FRF baseline of record will be re-captured
> (the inventory script is committed and regenerable).

Coordinator-owned: only the integration coordinator edits this tracker or
the plan (`docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md`).
One row per bounded work package. Conventions follow the EK tracker
(`docs/refactoring/event-kernel/EXECUTION-TRACKER.md`).

- **Plan:** FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN (the THIRD plan;
  successor to CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE and
  EVENT-PROJECTED-KERNEL-GREENFIELD).
- **Integration branch:** `frf/wp01-baseline` (successor packages branch
  from here per FRF-1).
- **Base SHA:** `5c158608` (= three commits past the EK superseding
  closure `be0d5948`; saga4 == `be0d5948`; both EK identity SHAs are
  ancestors of the base — verification below).

## Prerequisite verification record (Phase FRF-0, FRF-WP01)

Every item verified with executable evidence at base `5c158608` on
2026-08-27:

| # | Requirement | Evidence (command → observed) | Status |
|---|---|---|---|
| P1 | EK plan completion receipt with SUPERSEDING closure exists | `docs/refactoring/event-kernel/FINAL-RECEIPT.md` contains "SUPERSEDING CLOSURE (2026-08-27, audit round 3 repair cycle)"; the closing commit is `be0d5948` ("close(ek13-v2): SUPERSEDING closure — the audit-r3 repair cycle complete") | VERIFIED |
| P2 | qualificationSourceSha `7bc0e67b` | `git merge-base --is-ancestor 7bc0e67b HEAD` → 0; kit record `docs/refactoring/event-kernel/qualification/kits/a39e8c9c….json` → `sourceSha.head = 7bc0e67b731c…` | VERIFIED |
| P3 | Immutable kit `a39e8c9c…` | Kit JSON present with `kitId a39e8c9c3b744d9b…`; re-qualification series on it: `dev-20260826185605` (10/10), `projects-20260826185618` (20/20), `concurrency-20260826185705` (20/20+7/7), `real-20260826185718` (`allGreen: true`, R1/R2/R3 37/37) | VERIFIED |
| P4 | saga4 at the reviewed closure SHA | `git log -1 saga4` → `be0d5948` (the commit containing the superseding section) | VERIFIED |
| P5 | Executable-tree equality closure↔qualification | `git diff --stat 7bc0e67b be0d5948 -- . ':(exclude)docs'` → EMPTY (docs-only diff; executable tree byte-identical) | VERIFIED |
| P6 | Clean worktree | `git status --porcelain` → empty at task start and at commit time | VERIFIED |
| P7 | No live Factory run / worker / watchdog / qualification on this checkout | process scan (`node.exe` command lines referencing `saga-mcp-FRF-WP01`) → none; no `*.sqlite*`/lock/`.factory*` files in the worktree; no tracker/factory node processes | VERIFIED |
| P8 | Predecessor CANONICAL plan receipt | recorded inside the EK FINAL-RECEIPT (completion receipt `docs/factory-run/qualification-adr096/COMPLETION-RECEIPT.md`, closing SHA `bacf4f82`, ADR-053 CLOSED) — inherited via the EK chain | VERIFIED |
| P9 | Successor base frozen | base `5c158608`, branch `frf/wp01-baseline`, clean; this tracker is the FRF-0 record | VERIFIED |

**Plan stop-rule check:** no stop rule fires (see
`INTENTIONAL-DIFFERENCE-LEDGER.md` §Stop-rule check).

## Package table

| Package | Bounded assignment | Depends on | Owner | Status | Commit | Evidence | Residual |
|---|---|---|---|---|---|---|---|
| FRF-WP01 | Post-EK inventory and baseline: prerequisite verification, inventory, baseline commands, graph capture, test classification, deletion manifest, intentional-difference ledger; NO production behavior change | EK superseding closure `be0d5948` | subagent | **DONE** | (this commit) | `baseline/post-ek-inventory.json` (11 src files digested, 68 focused tests, 11 matrix groups, 26 orphaned old-flow fixtures); `baseline/installed-formalization-graph.json` (11 nodes/18 edges/6+2+3, manifestDigest `c6752ac0…`); `baseline/uc-foreign-reproduction.output.json` (UC-FOREIGN `{ok:true}` reproduced); `baseline/acceptance-matrix-base.log`; `TEST-CLASSIFICATION.md`; `DELETION-MANIFEST.md`; `INTENTIONAL-DIFFERENCE-LEDGER.md` | Pre-existing `ek-manifest-guard` red AT BASE (introduced by base commit's own unclassified fronts files — coordinator must classify; EK-owned manifest, not FRF-editable). One load-flaky workflow-kernel test observed once (development scenario idempotency), green on rerun |
| FRF-WP02 | Independent target graphs: forward from source+desk contracts; reverse from handoff+terminal evidence; hashes frozen before either author reads the other | FRF-WP01 | 2 subagents + coordinator | NOT STARTED | — | — | — |
| FRF-WP03 | Minimal semantic contracts: PRD intent-member, UC scenario-member, requirements bundle, AC binding, whole-WHAT baseline schemas; no new artifact type or mutable owner | FRF-WP01, FRF-WP02 | subagent | NOT STARTED | — | — | — |
| FRF-WP04 | Product-intent and UC Cells: protocols, skills, templates, CheckPlans, reviewers, focused tests | FRF-WP03 | subagent | NOT STARTED | — | — | — |
| FRF-WP05 | System-requirements Cell: role contract, skill, bundle, validator, focused tests (note ledger D-7: the desk is INSTALLED; the package lands the coverage sets and any contract deltas) | FRF-WP03 | subagent | NOT STARTED | — | — | — |
| FRF-WP06 | Acceptance and reconciliation: bindings, closure validators, report-only reconciliation, negative fixtures (ledger D-9/A5 tightening) | FRF-WP04, FRF-WP05 | subagent | NOT STARTED | — | — | — |
| FRF-WP07 | WHAT freeze and settlement: baseline sections (ledger D-10), exact-authority ingestion, settlement fences the settler (A2) | FRF-WP03, FRF-WP06 | subagent | NOT STARTED | — | — | — |
| FRF-WP08 | SRS scenario realization: Elite/simple-server kill demonstrations at the handoff boundary | FRF-WP03, FRF-WP06 | subagent | NOT STARTED | — | — | — |
| FRF-WP09 | Development handoff and planning: UC-FOREIGN kill (D-1/A1), handoff consumption (D-2/A3), identity preservation (D-3/A4), AC-complete-but-scenario-incomplete rejection (D-4) | FRF-WP07, FRF-WP08 | subagent | NOT STARTED | — | — | — |
| FRF-WP10 | Scenario, resilience, capsule, project corpus: extend the post-EK engine; regenerate fixtures through public ingress; no second harness | FRF-WP04..09 | subagent | NOT STARTED | — | — | — |
| FRF-WP11 | Package integration, deletion, CI, docs: coordinator-owned shared paths; the deletion patch (DELETION-MANIFEST.md sections A–C); stale-note retirement (D-14) | FRF-WP04..10 | coordinator + subagent | NOT STARTED | — | — | — |
| FRF-WP12 | Independent qualification and closure: immutable kit, fresh DBs/repos, three consecutive real-agent projects, FORMALIZATION-SCENARIO-FIRST-FINAL-RECEIPT.md | FRF-WP11 | subagent + coordinator | NOT STARTED | — | — | — |

## Baseline status (FRF-0)

- `npm run build` GREEN.
- Acceptance matrix at base: workflow-kernel 737/737, project-corpus
  33/33, architecture 67/67, kept-tooling 27/27, ek-admission 1/1,
  ek-removal-guard 10/10, ek-mutation-coverage 2/2, ek-evidence-kit 3/3,
  matrix-coverage 19/19, cc-proof-registry 26/26 — and
  **ek-manifest-guard 5/7 RED, pre-existing at base** (both findings
  introduced by the base commit `5c158608` itself: two unclassified
  fronts README files + one §B.2 count mismatch; verified present on a
  clean stash of FRF-WP01's own files). Full log:
  `baseline/acceptance-matrix-base.log`; command table:
  `baseline/BASELINE-COMMANDS.md`.
- UC-FOREIGN counterexample honestly reproduced (`{ok:true}` with fully
  foreign handoff bindings; sealed contract digest `71d5e0c0…`):
  `baseline/uc-foreign-reproduction.mjs` / `.output.json`.

## Findings ledger (FRF-WP01)

1. **The installed graph already equals the plan's target shape**
   (ledger D-0): EK-8 WP-11F pre-installed the successor's eleven-node /
   eighteen-transition graph name-for-name. FRF's remaining defect is the
   SEMANTIC layer (D-1..D-12), not node order. FRF-2's graph tests pin the
   installed shape from a test-owned fixture.
2. **ek-manifest-guard red at base** — see above; blocks FRF-7+ gates
   until the coordinator classifies the fronts files in the EK document
   manifest.
3. **UC-FOREIGN** (audit round finding) — REQUIRED FRF-09 fix target,
   reproduced with exact output.
4. Development consumes NO scenario/realization bindings (grep-zero,
   `workshops/development/**`) — the one-sided gap D-2/D-17: the handoff
   contract exists and is produced; the consumer does not.
5. 26 orphaned pre-EK formalization evidence fixtures
   (`tests/factory-evidence/formalization/**`) reference the deleted old
   flow and are consumed by nothing — DELETE candidates (manifest B1).
