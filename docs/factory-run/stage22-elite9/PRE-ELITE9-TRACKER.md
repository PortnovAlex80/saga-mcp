# PRE-ELITE9-TRACKER — Stage 22 preparation ledger

- **Authoring base:** `12d46037e0e3d19033386102addc98cabc32461f`
  (`map/integration-2026-08-23` merged into `map/reconciliation-2026-08-23`).
- **Purpose:** freeze the exact pre-Elite-9 program as SEVEN top-level points.
  Nothing is marked complete without commit/evidence. Elite-9 does NOT launch
  until points 1-6 exit green; when point 7 launches Elite-9, all work STOPS
  immediately (no mid-run repairs, no builds, escalate-only — the stage-20/21
  protocol discipline).
- **Elite-8 status — TERMINAL (failed), NOT live. Corrected 2026-08-23.**
  Historical launch facts (true at authoring): launched 15:15:56Z 2026-08-23
  on `a990157d` (worktree `D:/Development/saga-mcp-ELITE7`, branch
  `cc/elite7-run`), engine pid 34836, controls 8/8; red-team audit (91af2982)
  analyzed live Elite-6/7/8 DBs and preserved the P0 task-shadow diagnosis;
  after unpark+fix task 7 approved 17:52:21Z
  (`docs/factory-run/stage21-elite7/RUN-TRACKER.md:116-125`;
  `docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:78-93`).
- **Terminal evidence (supersedes every earlier "Elite-8 live / task 14
  working / watchdog live" statement, here and in the points below):** the
  watchdog observed engine 34836 dead at 16:45:39Z and a replacement engine
  pid 52300 alive from 17:34:39Z (pid change mid-run; the run continued and
  terminalized under 52300); the
  `development-plan-task-graph` gate receipts FAILED (19:10:52Z and
  19:17:24Z, `development.task-graph-contract.v1`); `run.terminal` at
  19:17:27.415Z recorded terminal_status=failed / stage_outcome=failed /
  product_outcome=failed / final_stage=solution-development (cycles 3);
  `engine.exit` code 0 at 19:17:33Z; the last watchdog sample (20:15:43Z)
  shows engine dead, launch_state completed, 16 tasks done, and
  `workplace/3/solution-development@1.4.4/development-plan-task-graph/singleton`
  terminal/failed (revision 25). No engine process is alive now (pids
  34836/52300 absent). Evidence:
  `D:/Development/saga-mcp-ELITE7/.factory-sandboxes/elite8-db/factory-run-journal.jsonl`
  (`run.terminal`, `engine.exit`) and
  `D:/Development/saga-mcp-ELITE7/.factory-sandboxes/elite8-logs/watchdog.jsonl`.
  The ADR-094 "NO dist/build/test/factory/network action while Elite-8
  lives" freeze is therefore ENDED; what remains is ADR-094's separately
  authorized post-CAS heavy-validation step (still not run).
- **saga4 CAS truth (corrected):** the LOCAL saga4 compare-and-swap EXECUTED
  (`611c35e0` → `586871ad`; verified in this worktree: `git rev-parse saga4`
  = `586871adfeae77da0ca8af96232ef96d6b0ee7e4`), recorded by `92253c5b` on
  branch `docs/post-cas-truth-2026-08-23` (ADR-094 decision/exit
  checks/registry + decision journal updated post-CAS; archive bundle passes
  `git bundle verify`; heavy validation and dist rebuild explicitly
  deferred). Canonical `origin/saga4` REMAINS `611c35e0` (verified in this
  worktree: `git rev-parse origin/saga4`) — no push occurred and none is
  claimed. **Refreshed 2026-08-24 (ADR-095 Phase-1 work):** LOCAL `saga4`
  has since advanced from `586871ad` through the pre-Elite-9 docs line
  (ADR-095 docs `2879c384`, post-CAS-truth merge `f29e570e`, reconciliation
  merge `f696d31d`) and now reads
  `f696d31d0c8492e2e1bd446b82b0adb433531c29` (verified in this worktree:
  `git rev-parse saga4`); `origin/saga4` remains `611c35e0` — the no-push
  rule still holds.

---

## Point 1 — Freeze/consolidate branch truth WITHOUT dist rebuild

**Status:** CAS EXECUTED locally with ADR-094 exit checks recorded
(`92253c5b`, branch `docs/post-cas-truth-2026-08-23` — not yet merged here);
post-CAS heavy validation still deferred (separately authorized step).

- [x] Elite-8 line snapshot merged into staging: `ab397ff7` (through `91af2982`
      red-team audit).
- [x] Accepted Conformance Closure integration merged: `87b97e11` (through
      `905f5940`).
- [x] Plan-truth snapshot merged: `37b75b01` (through `58b8656a`).
- [x] ADR-094 accepted with pins, MCDA, pre-mortem, exit checks
      (`docs/architecture/decisions/094-saga4-consolidation-during-live-elite8.md`;
      journal `docs/architecture/decision-journal/2026-08-23-saga4-consolidation-during-live-elite8.md`;
      registry entry `docs/architecture/adr-closure-registry.json:1302-1314`).
- [x] Map integration branch truth frozen at `12d46037` (docs-only delta from
      `586871ad`; verified `git diff --stat 586871ad 12d46037`).
- [x] ADR-094 exit checks pass — Git-only invariants executed and recorded
      post-CAS by `92253c5b` (staging first-parent chain over base `611c35e0`
      re-verified: `87b97e11` + `37b75b01` + `ab397ff7` + the staging ADR-094
      docs commit; registry/`JSON.parse` and bundle verify recorded). The
      "no dist rebuild while Elite-8 is live" clause is moot: Elite-8 is
      TERMINAL (failed 19:17:27Z, engine dead — see header).
- [x] saga4 compare-and-swap executed with expected old value `611c35e0`
      (mismatch aborts): LOCAL `saga4` now `586871ad` (verified in this
      worktree: `git rev-parse saga4`); before/after SHAs recorded by
      `92253c5b`. `origin/saga4` remains `611c35e0` — the no-push rule held
      (push is a separate explicit operator decision, never claimed here).
- [ ] Post-CAS heavy validation run as a SEPARATELY AUTHORIZED quiet-machine
      step (not part of this freeze).

**Commit/evidence:** staging merges above; CAS truth `92253c5b` (branch
`docs/post-cas-truth-2026-08-23`); verified in this worktree: local `saga4` =
`586871ad`, `origin/saga4` = `611c35e0` (no push). Superseded wording on this
branch ("CAS has NOT yet executed", registry notes) predates `92253c5b` and is
corrected by this tracker entry; the authoritative post-CAS records live in
`92253c5b` until that branch is merged.

**Blockers:** post-CAS heavy validation (dist rebuild + suites) not yet
authorized/run — the only remaining blocker. The previous blockers are stale:
ADR-094 exit checks ARE executed/recorded, and Elite-8 is terminal, so its
build freeze no longer applies.

**Exit criteria:** exit checks green (done, `92253c5b`) → CAS landed with
before/after SHAs recorded (done, local `611c35e0` → `586871ad`) → zero
interference with the Elite-8 run (verified: the run terminalized on its own
gate failure at 19:17:27Z, engine exit 0; the CAS touched one local ref) →
`origin/saga4` push remains an explicit future operator decision (no-push rule
held) → heavy validation separately authorized and scheduled (open).

## Point 2 — Independent maps

**Status:** DONE (verified by commits and file content).

- [x] Strata contract + four workshop strata authored at `586871ad`
      (`map/discovery-formalization-2026-08-23`: `db9f3355`;
      `map/development-delivery-2026-08-23`: `87dd5003`) with prohibited-
      sources discipline declared (`docs/factory-map/00_FACTORY_CONTRACT.md:6-9`).
- [x] Forward graph derived independently (`map/forward-2026-08-23`,
      commit `1263095a`; 68 nodes/93 edges/13 terminals; forward-only walk,
      `docs/factory-map/FORWARD_GRAPH.md:3-9`).
- [x] Reverse graph derived independently from the single `released` claim
      (`map/reverse-2026-08-23`, commit `961f4d03`; 45 claims/28 deps;
      `docs/factory-map/REVERSE_GRAPH.md:3-9`).
- [x] Both graphs parse as strict JSON with non-empty sourceRefs (authors'
      scripted checks + re-verified by the reconciler at `12d46037`).

**Commit/evidence:** `586871ad`, `1263095a`, `961f4d03`, `db9f3355`,
`87dd5003`, merge `12d46037`.

**Blockers:** none.

**Exit criteria:** met (independence declarations + parse + sourceRef checks
re-verified). No further map authoring before Elite-9.

## Point 3 — Reconciliation + corrected English plan

**Status:** RECONCILIATION DONE (this commit); plan-truth correction landed
previously; no open editing work.

- [x] Independent production-installed inventory re-derived at `12d46037`
      (six packages, four registrations, lifecycle default product-build,
      mandatory composition env, matrix registry) —
      `docs/factory-map/GRAPH_RECONCILIATION.md:§2`.
- [x] F∩B / F\B / B\F partition authored WITHOUT forcing equality; forward-only
      classified (support/alternate/recovery/audit/dead-candidate); reverse-only
      classified (missing production path / wrong root / lawful open boundary).
- [x] Root set corrected to five roots (runnable-local, released, safety,
      liveness, auditability) with the recorded fact: start-from-idea defaults
      to product-build/runnable-local; released requires product-delivery +
      authorized continuation (`GRAPH_RECONCILIATION.md:§3`, INV-3/INV-7).
- [x] Bridge matrix with joint-satisfiability column; Elite-8 counterexample
      recorded with the full code chain (`BRIDGE_MATRIX.md:§4`, BM-5).
- [x] STATE_MATRIX / ARTIFACT_LINEAGE / TEST_COVERAGE +
      `graph-reconciliation.v1.json` (parse + sourceRefs + cross-file ids
      validated).
- [x] English plan truth refreshed earlier on the consolidated line:
      `58b8656a` (CC-PLAN-TRUTH: GAP8 terminal repair, CC-IC-2, CC-U1/ADR-092,
      Space E maintenance) — merged via `37b75b01`.

**Commit/evidence:** this commit (branch `map/reconciliation-2026-08-23`,
files `docs/factory-map/{GRAPH_RECONCILIATION,BRIDGE_MATRIX,STATE_MATRIX,
ARTIFACT_LINEAGE,TEST_COVERAGE}.md`, `docs/factory-map/graph-reconciliation.v1.json`,
this tracker); plan truth `58b8656a`.

**Blockers:** none.

**Exit criteria:** met for the reconciliation phase (validation §9 of
GRAPH_RECONCILIATION). Follow-ups are owned by points 5-6, not here.

## Point 4 — Deterministic simple client/server first-line regression

**Status:** PENDING (design agreed; no code yet).

- [ ] Scenario authored: a MINIMAL deterministic client/server product (echo
      server + client check, no model cognition — scripted worker drives the
      real MCP seam) traversing discovery → formalization → development →
      `runnable-local` on the CANONICAL production composition (no private
      harness; the L3/L5 discipline of CONVEYOR §23 — replace only the
      inference port).
- [ ] Determinism proven: two consecutive fresh-DB runs byte-stable at every
      durable boundary (capsule semantic keys, digests, terminal statuses).
- [ ] Hosted in a BLOCKING matrix group with a per-file removal guard (the G2g
      pattern — avoids the orphan class, TEST_COVERAGE §4.3).
- [ ] Red-team seam S1 covered as a subordinate scenario: delivery
      continuation grant (currently ZERO tests — kills a run at the cheapest
      stage after full development payment).

**Commit/evidence:** none yet (this is the first code item of the pre-Elite-9
program).

**Blockers:** the previous "Elite-8 liveness forbids builds/tests" blocker is
STALE — Elite-8 is terminal (failed 19:17:27Z, engine dead; see header), so
there is no live run to protect, and the saga4 CAS has executed. Remaining
gate: the separately authorized post-CAS heavy-validation/dist-rebuild step
(`92253c5b` defers it deliberately); this scenario is also the deterministic
substrate for Point 5's corpus (ordering, not a liveness blocker).

**Exit criteria:** scenario green twice consecutively on the consolidated tip;
matrix-hosted blocking with removal guard; S1 subordinate scenario green;
no behavioral edit to production physics (composition unchanged).

## Point 5 — Close proven defects and build the Elite-8-scale corpus

**Status:** PENDING (defects proven and recorded; fixes NOT written here).
Discovery legacy removal is DECIDED — ADR-095 accepted (docs-only:
decision + journal + registry + this refinement; no implementation
claimed); its phases 2-6 and the open half of phase 1 (inventory/census/
boot baseline) are executed under this point.

- [x] **Task-shadow binding (P0, SM-14/MM-3):** fix `readTaskForWorkplace`
      newest-wins selection (`src/app/product-lifecycle-runtime.ts:587-593`)
      + integration test on a REAL multi-task singleton workplace (R3;
      every current unit stubs the port).
      **CLOSED 2026-08-24 on branch `stage22/task-shadow-exact`:** the
      newest-wins port is DELETED (ADR-053-style removal, not a fallback):
      both consumers — `rawAttemptCounters` (recovery-budget crash counting)
      and `resolveScopeWidening` (widening request binding) — now resolve the
      role task through the existing K7 exact-key read
      `readProjectedRoleTask` (`tasks.metadata $.role` binding + workplace
      ref, fail-closed `PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE` on
      ambiguity, exact null on a missing binding — never recency). The
      production composition root already provides the K7 read via the
      projection-persistence spread, so the fix removes the divergent second
      predicate (B-004/W-1) instead of adding one. Integration regression
      `tests/process-modules/task-shadow-binding-integration.test.mjs`
      (blocking, matrix `process-modules` glob): S1 drives a REAL multi-task
      singleton workplace (real `ensureExecutionPlan` +
      `activateProductionCellRoleTask` projections) through author-accept →
      reviewer desk → final-gate rejection, then 2 REAL terminal
      `worker_executions` on the author task: the budget ENGAGES (ADR-075
      rollover row exists, `baseline_terminal_executions=2`) while the
      retired `ORDER BY id DESC LIMIT 1` SQL is probed side-by-side and
      provably resolves the reviewer row whose count is 0 (the Elite-8
      signature); S2 negative — a duplicate role row throws the K7 fence
      through the executor budget path; S3 negative — reviewer-only/empty
      desks resolve exact null, never a newest-row fallback. The two
      port-stubbing units (`finding-trajectory-budget`,
      `scope-widening-routing`) now wire the REAL K7 read + REAL
      `countTerminalExecutionsForTask`. Verified: build exit 0; acceptance
      matrix process-modules `tests 1464 / pass 1464 / fail 0 / skipped 0`;
      architecture `455 / 455 / 0 / 0`; full matrix "all groups green".
- [ ] **§2.2 × §D2/§3 joint satisfiability (MM-4/BM-5):** normalize §2.2
      tokens against the §D2/§D1 file surface at the decoder boundary OR add
      a pre-Development satisfiability check over the frozen SRS; negative
      test = Elite-8 counterexample (bare-filename §2.2 vs full-path §D2/§3)
      must FAIL the unfixed gate and PASS the fixed one (RED/GREEN pinned).
- [ ] **Prompt-size gate (R4):** `SAGA_PROMPT_MAX_BYTES` default-on + a test
      on the fail-closed spawn gate (currently default-off, decision without
      a test).
- [ ] **Provider-abort class (Elite-8 killer):** typed fast-fail before first
      tool call with a corpus actor.
- [ ] **Elite-8-scale producer-diversity corpus (R6):** parameterized "bad
      model" actors — monolithic-document (N rows→1 file→1 hash), multi-
      finding KB verdicts with evolution, trace_delete storms, double
      worker_done; multi-round feedback evolution (fixtures today never loop
      more than once); 15-22 AC 15-20 KB document shapes (Team-1's measured
      gaps).
- [ ] **FULL Discovery legacy ControlIntent/tools/handlers removal — decided
      by ADR-095 (docs recorded; implementation PENDING):** complete removal
      of the dead six-handler factory
      (`src/modules/discovery/application/discovery-installation.ts:122-141`),
      dead MCP discovery tools (`src/tools/discovery-proposal-tools.ts`,
      `discovery-normalization-tools.ts`, `discovery-readiness-tools.ts`,
      `discovery-tool-args.ts`), legacy settlement service
      (`discovery-settlement-service.ts:158-159`), legacy
      repositories/runtime/domain residue/contributions/dead-lane resources,
      the LIVE `product_submit`→`factory_proposals` projection +
      `proposal-ref-bridge` + `discovery_proposal_id` +
      settlement-debug legacy query, the stale manifest pins
      (DISCOVERY_HANDLER_IDS/REFS + six-handler digest pin,
      `src/process-modules/modules/discovery/package/manifest.ts:97-104,360-388`),
      and `factory_proposals` + its full nine-table legacy FK closure +
      indexes from fresh SCHEMA_SQL (never DROP existing tables; old DB
      tables remain inert history; `factory_work_intents` stays — live
      shared protocol entity) — resolving contradictions 01 §6.1-6.3/
      §CONTRADICTIONS 1-2. Decision: ADR-095 corrected hybrid
      (ratchet-first + vertical slices + atomic versioned manifest
      boundary; MCDA 480/500 after Red Team ACCEPT-WITH-CORRECTIONS). The
      STOP-SHIP correction is binding: the manifest cutover MUST atomically
      bump the `product-discovery` module version, repin the digest to
      `discovery-production-cell-installation.js`, retain old installations
      for pinned runs, and prove an existing-DB boot regression. Six phases
      in order:
  1. ADR/inventory/census — ADR-095 + journal + registry + this refinement
     (DONE in the ADR-095 docs commit); **census of nonterminal pre-bump
     pinned runs DONE 2026-08-24** (19-DB strictly-read-only census:
     `docs/factory-run/stage22-elite9/DISCOVERY-PHASE1-CENSUS.md` — every
     DB carries exactly one active product-discovery@3.0.2 six-handler
     installation; the machine's only nonterminal Discovery pin is
     elite6-db run#1, paused, active installation row, store snapshot
     present; Phase-1 exit criterion satisfied); **existing-DB boot
     baseline DONE** as an in-process regression on the REAL engine install
     chain
     (`tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs`,
     blocking in the matrix `process-modules` group + removal guard G2h in
     `tests/infrastructure/acceptance-matrix-coverage.test.mjs`):
     same-version six-to-one handler flip = typed
     `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT` refusal leaving DB truth
     untouched; the atomic module-version bump installs the one-handler
     package while the legacy row stays retained and the pinned run
     rehydrates its EXACT persisted legacy digest/snapshot. Red-team
     correction applied: the proof binds to `installProductionModules`
     (the engine boot entry), NOT the partial-lifecycle
     `installModulePackages` — an earlier draft overclaimed and was
      rejected. The spawned-engine exit-0 boot smoke on a real
      retired-installation DB stays OPEN as the Phase-4 (ratchet 7)
      STOP-SHIP proof, not claimed here. STILL OPEN: the full
      live-v2/dead-legacy/shared inventory + legacy-only test deletion
       list. **CLOSED by Phase-2B (2026-08-24):** the inventory is now a
       COMPLETE machine partition (schemaVersion 2 — see the Phase-2B
       record under phase 2 below): `unresolved` empty, every scoped
       src/test/resource/skill file classified in exactly one bucket, the
       legacy-only test list exact per-file, completeness proven by the
       bidirectional scoped partition scan with mutation negatives.
       **Phase-2A inventory step (2026-08-24, this commit):** the
       EXACT machine-consumed CLASSIFIED BASELINE now exists as
       `tests/infrastructure/adr-095-removal-inventory.mjs` (self-validating:
       uniqueness, dead∩kept=∅, all present-today paths resolve, the exact
       ten-table + nineteen-index phase-5 closure checked against
       `src/schema.ts`, retired-handler set = six-handler baseline minus the
       live `discovery-settlement-policy`; consumed blocking by
       `tests/architecture/adr-095-phase2-bridge-ratchets.test.mjs`). It is
       the exact CLASSIFIED baseline, NOT a complete inventory while
       `unresolved` is non-empty. 35 dead paths (26 phase-4 files + 9
       dead-lane resources; phase 3 contributes code-blocks only) + the
       phase-3 live-write blocks + the phase-5 schema closure are classified
       with per-entry same-commit obligations (including every
       BLOCKING-hosted test that imports a dead surface); the kept baseline
       is exact too (20 fully-kept production files + 4 partial-live
       containers + 10 live resources + 9 live test files = 43). Honest
       boundary: the package `contributions/{tool-contributions,
       output-contracts,acceptance-capabilities,reviewer-skills}.ts` data
       files are KEPT AS CONTAINERS (modeled as
       `keptLive.partialLiveFilesWithUnresolvedRows`) — row-level
       repoint/removal inside them is allowed while whole-file deletion is
       forbidden until their row classification closes — and the per-file
       migrate-vs-delete decisions of the legacy-only test list are open;
       both are recorded as `unresolved` entries at the exact MONOTONE
       baseline of 5 (may only shrink; growth is rejected by the
       validator) behind the `phase4BlockedByUnresolved` machine gate:
       Phase 4 cannot land until `unresolved` is empty AND the flag is
       cleared atomically in the same commit. The Phase-1 "full inventory"
       item stays OPEN until `unresolved` is empty.
       `factory_work_intents` is classified KEPT (live shared protocol
       entity) with its indexes and trigger.
   2. Ratchets first — author the eight ratchets + mutation proofs;
      demonstrate RED on the legacy-present tree (no red consolidated tip).
      **Phase-2 blockers (red-team discoveries 2026-08-24):** (a) four
      LIVE Discovery suites are CI orphans —
      `tests/discovery/d7-settlement-lifecycle-classification.test.mjs`,
      `tests/discovery/order-constraint-register.test.mjs`,
      `tests/matrix/e-constraint-loss.test.mjs`, and
      `tests/modules/discovery/discovery-check-providers.test.mjs` are in
      NO blocking run-set and NO quarantine (matrix `--list-json` verified),
      so ratchet 6 ("live v2 behavior") currently has no hosted executor;
      hosting them is a Phase-2 precondition, not a nicety. (b)
       `tests/execution/migration-conformance.test.mjs` is unhosted AND
       hard-pins legacy Discovery surfaces — the dist imports of the dead
       `discovery-settlement-repository.js` (restart lane) and
       `discovery-outcome-certificate-projection.js` (exact-output lane)
       plus the fresh-DB `factory_proposals` INSERT seed. It does NOT
       assert the six-handler count/IDs (its package-isolation lane
       validates `discoveryPackageManifest` structurally only — handler
       shape is owned by `handler-digest-runtime-consistency` + the
       Phase-4 hard ratchet), so hosting it before the Phase-4 cutover
       pins CI to those legacy surfaces, while migrating it unhosted
       proves nothing — its hosting + its re-pinning to the post-removal
       surface must land ATOMICALLY with the ADR-095 phase that changes
       the surface it observes.
       **Phase-2A DONE 2026-08-24 (this commit, branch
       `stage22/discovery-phase2`) — blockers (a)/(b) RESOLVED, ratchet
       authoring continues:**
       - (a) resolved: new narrowly justified exact-file matrix group
         `discovery-live-v2` (four suites, no directory globs) + its CI step
         in `.github/workflows/ci.yml`; all four re-run green in isolation
         first (15/39/13/5), then green as the group (72 tests). Per-file
         removal guards G2i in
         `tests/infrastructure/acceptance-matrix-coverage.test.mjs` make
         deletion or de-hosting fail the coverage suite; nothing was
         quarantined or weakened.
        - (b) resolved by hosting GREEN on the current legacy baseline
          WITHOUT repinning (the production surface has NOT changed; the
          suite truthfully pins the legacy surfaces it observes — the dead
          settlement-repository + certificate-projection dist imports and
          the `factory_proposals` seed, NOT any six-handler count/ID):
          migration-conformance re-run green in isolation (35/35) and inside
          the `process-modules` group (exact-file entry, group green 1461
          tests); removal guard G2j added. Its MANDATORY same-commit Phase-4
          migration is recorded machine-readably in
          `tests/infrastructure/adr-095-removal-inventory.mjs`
          (`mandatoryPhase4Repins`): at the cutover commit the imports of
          the dead `discovery-settlement-repository.js` /
          `discovery-outcome-certificate-projection.js` migrate or delete
          per the legacy-only list (the `discoveryPackageManifest` pin needs
          no handler-shape edit — its lane validates the manifest
          structurally and stays green across the one-handler repin, whose
          truth is enforced by `handler-digest-runtime-consistency` + the
          Phase-4 hard ratchet); at Phase 5 its fresh-DB `factory_proposals`
          INSERT follows the schema closure removal.
       - Phase-2A bridge ratchets (additive, green-today, non-vacuous;
         hosted BLOCKING in the architecture group):
          `tests/architecture/adr-095-phase2-bridge-ratchets.test.mjs` —
          BR1 inventory self-validation with EXACT pinned counts (dead 35 =
          26 phase-4 files + 9 dead-lane resources; kept 43 = 20 + 4
          partial-live containers + 10 + 9); BR2 unresolved monotonicity +
          Phase-4 atomic gate (exact baseline 5, growth rejected;
          `phase4BlockedByUnresolved` true exactly while `unresolved` is
          non-empty — decoupled mutated clones fail validation, and the
          bidirectional dead-file presence counter stays deferred until
          closure: no counter over an unproven baseline); BR3
          dependency-direction allowlist DENIES any ADR-095 dead-file edge
          (bounded to the KNOWN_VIOLATIONS array block + its discoveryLeaks
          append site; zero such entries today); BR4 live
          composition registers EXACTLY one settlement handler
          (`createDiscoveryProductionCellKernelHandlers` returns exactly
          `discovery-settlement-policy`; `src/modules/discovery/index.ts`
          never touches the dead six-handler factory; fail-closed reader
          contract intact); BR5 the five retired handler IDs cannot fan out
          beyond the exact known legacy files (discovery-installation.ts,
          handler-adapter.ts, manifest.ts — machine-verified across src/).
          NOT duplicated: the same-version six→one drift negative stays
          owned by the Phase-1 boot-regression suite (G2h). The eight-ratchet
          set + mutation proofs (Phase 2 proper) remain OPEN.
       **Phase-2B DONE 2026-08-24 (inventory closure + hosting, same
       Phase-2 commit-train; two independent audit corrections verified
       independently before any edit — none trusted on faith):**
       - **C1 (contributions):** verified the four contribution data files
         have ZERO production consumers except the unconsumed barrel
         (`manifest.ts` imports no contributions file; nothing outside
         `package/contributions/` imports the barrel; the W9-A2 doc-claim
         "the manifest spreads these" is unrealized in code).
         `tool-contributions.ts` reclassified WHOLLY DEAD (all 9 rows are
         ControlIntent-era tool lanes) → deadPhase4Files (26→27). The other
         three stay partial-live with rows EXHAUSTIVELY classified:
         output-contracts dead rows = normalization/diagnosis/brief bundle
         contracts (+aggregate); acceptance-capabilities dead rows =
         runtime-persistence + settlement-policy-repository +
         diagnosis-advisory (+aggregates); reviewer-skills dead rows =
         normalizer + diagnosis-advisor pins (+aggregates). The barrel
         itself is partial-live (its tool-contributions + handler-adapter
         re-export blocks die with their sources).
       - **C2 (domain contracts):** `discovery-domain-contracts.ts` is NOT
         fully-kept — its only live src importer is
         `discovery-process-module.ts` (exactly 5 constants); everything
         else is consumed only by dead files or nobody. Reclassified
         partial-live with all rows classified: 5 live constants + 56
         legacy-only rows (incl. the entire DiscoveryRuntimePersistencePort
         and DiscoverySettlementPort surfaces and the mirror constants whose
         live definitions live in the live domain files).
       - **C3 (exact test partition):** the d1-d7 wildcard is gone. Four
         LIVE unhosted suites hosted BLOCKING in `discovery-live-v2`
         (d1-1-authority, d1-1-binding, d3-readiness-domain,
         d4-settlement-policy — zero dead-surface imports, 62/62 green in
         isolation; G2i extended to 8 files). Five MIXED suites carry
         migrate-preserving-live-assertions actions (d3/d4
         architecture-boundary; d4-settlement-recovery — the m6a ADR-090
         continuation-register block is preserved, its 18 legacy
         service/repo lanes die; mcp-catalog-authority-errors — live
         catalog/authority/error-normalization assertions stay, the pinned
         tool-name set drops the dead tools; conveyor-v4.3-focused-
         invariants — 10 of 11 live invariants stay, invariant 5 migrates
         with the phase-3 projection removal). Twelve legacy-only tests +
         `_conveyor-fakes.mjs` (helper of two delete-classified suites) have
         exact delete actions with exclusive-legacy justifications.
       - **C4 (kickstart):** `skills/saga-kickstart/SKILL.md` classified
         KEPT (live resource, pinned by DISCOVERY_KICKSTART_REVIEWER_SKILL).
       - **C5 (hosted dead importers):** machine-recorded same-commit
         actions for EVERY hosted importer/pinner of a dead surface —
         kernel-admission-distance (sqlite-discovery-runtime.ts:413 linkType
         copy pin, settlement-debug DRIFT anchor + drift count 16→15),
         v4-target-conformance (REG-11 proposal-ref-bridge existence),
         work-intent-contract-immutability (dist runtime import re-point at
         the KEPT factory_work_intents schema), handler-digest-runtime-
         consistency, discovery-package-contributions, migration-conformance,
         discovery-outcome-certificate-projection.test.mjs, and the hosted
         factory-proof workshop-inventory baseline (pins dead projection +
         handler-adapter dependency edges).
       - **C6 (completeness PROVEN, not claimed):** the inventory
         (schemaVersion 2) closes: `unresolved` EMPTY,
         `phase4BlockedByUnresolved` false, and the BIDIRECTIONAL dead-file
         presence counter LIVE (36 = 27 files + 9 resources; fails on early
         deletion AND unreviewed growth). Completeness is enforced by a
         BIDIRECTIONAL SCOPED PARTITION SCAN over 97 scoped files (all of
         src/modules/discovery, src/process-modules/modules/discovery,
         tests/discovery, tests/modules/discovery + the four dead tool files
         + every out-of-tree test/fixture touching a dead surface + the six
         relevant skills): every scoped file in EXACTLY ONE bucket
         (dead 36 | kept 47 = 18 production + 5 partial-live + 11 resources
         + 13 live tests | legacy-test 18 | hosted-importer 7), both
         directions. BR6 mutation negatives prove the scan non-vacuous
         (unclassified file / ghost classification / double classification
         each fail by exact path). Phase 4 is UNBLOCKED by inventory truth.
       - Phase-2B touched NO production legacy code and NO checked-in dist;
         build + blocking groups green (below, commit message). Bridge suite
         now 16 tests (BR1a-e, BR2a-b, BR3, BR4a-c, BR5, BR6a-d). The
         eight-ratchet set + mutation proofs (Phase 2 proper) remain OPEN.
  3. Live side effects removed + v2 E2E — projection/proposal-ref/
     `discovery_proposal_id`/settlement-debug legacy query gone;
     runtimePersistence construction + `ModuleSharedDeps.runtimePersistence`
     + ensure*/lazy CREATE TABLE recreation removed BEFORE schema work;
     live v2 E2E green on the still-existing schema.
  4. Atomic version bump + manifest repin (one-handler, digest =
     production-cell installation bytes) + code/resources deletion +
     existing-DB boot test (retired old installation rehydrates pinned
     runs; no `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT`).
  5. Atomic fresh-schema closure removal (no DROP) + fresh-DB absence
     test.
  6. Empty legacy allowlist + deliberate mutation RED/GREEN proofs + full
     validation. Guards: eight ratchets (shrinking allowlist first; exact
     one-handler manifest/digest; full src symbol/table absence;
     dist-aware clean-build absence; fresh DB lacks the full closure; live
     v2 behavior; existing-DB boot with retired old installation;
     deliberate mutation RED/GREEN) + six existing blocker suites UPDATED,
     not weakened (v4-target, handler-digest-runtime-consistency,
     kernel-admission-distance, migration-conformance,
     dependency-direction, discovery-package-contributions). Live v2
     files/tests preserved (index, production-cell installation, check
     providers, proposal/readiness/settlement policy/input/records, live
     constants, live E2E/constraint/output suites). Legacy-only test
     deletion is operator-approved (ADR-095 §7); tests also covering live
     surfaces migrate FIRST.
- [ ] Quarantine re-validation executed (R2): both PRE-EXISTING-RED rows
      re-run standalone; honest re-admission or fresh typed reasons.

**Commit/evidence:** defects proven in `docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md`
(91af2982) + `docs/factory-map/03_DEVELOPMENT.md:580-601` +
`BRIDGE_MATRIX.md:§4`; Discovery removal decided by ADR-095
(`docs/architecture/decisions/095-complete-removal-of-dead-discovery-legacy.md`;
journal `docs/architecture/decision-journal/2026-08-23-discovery-legacy-complete-removal.md`;
registry entry in `docs/architecture/adr-closure-registry.json`); Phase-1
census + boot baseline `58d7ce4d`; Phase-2A (branch
`stage22/discovery-phase2`): inventory module + live-v2/migration-conformance
hosting + bridge ratchets; Phase-2B (this commit, worktree
`saga-mcp-DISCOVERY-P2B`): audit-corrected complete partition (inventory
schemaVersion 2), four more live suites hosted blocking, bidirectional
partition scan + presence counter, hosted-dead-importer obligations. No
production legacy was deleted; no oracle quarantined or weakened.

**Blockers:** the previous "Elite-8 liveness (no builds)" blocker is STALE —
Elite-8 is terminal (failed 19:17:27Z; the terminal gate receipts of the
`development-plan-task-graph` cell are preserved in the Elite-8 DB/logs cited
in the header); the saga4 CAS has executed. Remaining gates: the separately
authorized post-CAS heavy-validation step, and corpus work still needs the
Point-4 regression harness as its deterministic substrate. The ADR-095
removal additionally carries its own ordering gates (ratchets before
deletion; live side effects before schema; atomic version bump before
manifest repin) — these are sequence constraints, not external blockers.

**Exit criteria:** each fix lands with RED/GREEN regression; corpus actors
parameterized and hosted; Discovery legacy removal merged per ADR-095 —
all six phases landed in order, all eight ratchets green (including
dist-aware clean-build absence, fresh-DB closure absence, and the
existing-DB boot regression with a retired old installation), all six
named blocker suites updated and green, empty discovery-legacy allowlist,
mutation RED/GREEN proofs recorded; task-shadow integration test green on
real multi-task singleton workplace; no orphan left by the new suites
(R1 check).

## Point 6 — Clean preflight, safe parallelism/operational envelope, current-config readiness

**Status:** PENDING (preflight is a launch-day gate; Elite-8 is TERMINAL —
failed 19:17:27Z, engine dead — so no live run constrains scheduling).

- [ ] Dedicated worktree + branch for Elite-9 at the consolidated tip (the
      w02/Elite-7 lesson: never share a worktree whose dist a live engine
      lazily imports).
- [ ] Build exit 0 (tsc clean; FIRST build after ADR-094 CAS, on a quiet
      machine, as the separately authorized step).
- [ ] Full acceptance matrix green on the fresh dist (all 8 groups; matrix
      self-check + cc-proof-registry last).
- [ ] Fresh `elite9-db/` + `elite9/` + `elite9-logs/`; nothing reused.
- [ ] `~/.claude/settings.json` sha256 anchored
      (`2d6176e8d1382fe1a05791892840aa3a4f023ab87157ecaa13d1bc3a5545c6d0`,
      unchanged since stage-19); NEVER touched; drift = abort.
- [ ] Executor env INLINE on the launch command (the Elite-6 harness lesson:
      prefix assignments are dropped):
      `SAGA_REAL_CLAUDE_PATH="node <repo>/tools/agent-proxy/claude-shim.mjs"`,
      same `SAGA_CLAUDE_PATH`, `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`.
- [ ] Parallelism envelope: model glm-4.6, controls raised to the operator
      rate-limit immediately after start AND re-applied after any resume/rerun
      (resume re-stamps the catalog limit); current operator limit: 8
      concurrent OpenCode workers (tracked channel
      `codexArchExecutorRateLimit`); quota exhaustion = 30-min pause + retry,
      max five, never busy-loop.
- [ ] Watchdog armed (60 s samples / 45 min stagnation / 12 h max / settings
      tripwire, FULL sha); pre-launch DB snapshot taken.
- [ ] No builds in the Elite-9 home worktree while the engine lives; merge
      queue frozen until terminal.

**Commit/evidence:** protocol precedents
`docs/factory-run/stage21-elite7/RUN-TRACKER.md:29-72`; rate-limit channel
file `codexArchExecutorRateLimit` (8).

**Blockers:** depends on points 1 (CAS + build), 4, 5.

**Exit criteria:** every checkbox above green at launch time; deviations
escalated, never self-repaired.

## Point 7 — Launch Elite-9, then STOP IMMEDIATELY

**Status:** PENDING (blocked by points 1-6).

- [ ] All points 1-6 exit green (no partial launches; no "just one small
      fix after launch").
- [ ] Launch command executed inline-env on the dedicated worktree; same idea
      lineage (Elite-3..8 verbatim `elite-idea.txt`); launch id + engine pid +
      settings sha recorded in the stage-22 run tracker.
- [ ] First-card claim verified (worker backend marker `agent-proxy`; NO
      `FACTORY_CLAUDE_BACKEND_FORBIDDEN`; prompt-budget telemetry live).
- [ ] **STOP IMMEDIATELY after launch verification:** no mid-run repairs, no
      builds, no dist swaps, no matrix runs in the shared tree, no merges, no
      saga4 moves; observation only (watchdog + 20-min automation checks
      BATCH progress, not factory liveness decisions); escalate on anomaly.

**Commit/evidence:** will be the stage-22 launch entry (this directory).

**Blockers:** points 1-6.

**Exit criteria:** Elite-9 running unattended with truthful observation; the
next human/agent action is the terminal post-mortem (the Elite-3..8
discipline: typed honest terminal or watchdog stop condition), NOT any
mid-run intervention.

---

*Preserved exactly seven top-level points. Amendments append inside a point;
no point may be removed or renumbered.*
