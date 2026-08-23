# PRE-ELITE9-TRACKER — Stage 22 preparation ledger

- **Authoring base:** `12d46037e0e3d19033386102addc98cabc32461f`
  (`map/integration-2026-08-23` merged into `map/reconciliation-2026-08-23`).
- **Purpose:** freeze the exact pre-Elite-9 program as SEVEN top-level points.
  Nothing is marked complete without commit/evidence. Elite-9 does NOT launch
  until points 1-6 exit green; when point 7 launches Elite-9, all work STOPS
  immediately (no mid-run repairs, no builds, escalate-only — the stage-20/21
  protocol discipline).
- **Live Elite-8 status at authoring:** launched 15:15:56Z 2026-08-23 on
  `a990157d` (worktree `D:/Development/saga-mcp-ELITE7`, branch
  `cc/elite7-run`), engine pid 34836, controls 8/8, watchdog live; red-team
  audit (91af2982) analyzed live Elite-6/7/8 DBs and preserved the P0
  task-shadow diagnosis; after unpark+fix task 7 approved 17:52:21Z, task 14
  working (`docs/factory-run/stage21-elite7/RUN-TRACKER.md:116-125`;
  `docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:78-93`). Per ADR-094
  guardrails: NO dist/build/test/factory/network action while Elite-8 lives;
  saga4 CAS has NOT executed — canonical `origin/saga4` still `611c35e0`
  (verified in this worktree: `git rev-parse origin/saga4`).

---

## Point 1 — Freeze/consolidate branch truth WITHOUT dist rebuild

**Status:** IN PROGRESS (staging merges landed; CAS pending by design).

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
- [ ] ADR-094 exit checks pass (Git-only invariants; no dist rebuild while
      Elite-8 is live).
- [ ] saga4 compare-and-swap executed atomically with expected old value
      `611c35e0` (mismatch aborts) — only AFTER exit checks pass.
- [ ] Post-CAS heavy validation run as a SEPARATELY AUTHORIZED quiet-machine
      step (not part of this freeze).

**Commit/evidence:** staging merges above; `origin/saga4=611c35e0` (verified
this worktree); ADR-094 registry notes record "the saga4 compare-and-swap has
NOT yet executed". Note: the map-integration clone's LOCAL `saga4` pointer
sits at `586871ad` — it is NOT canonical until the CAS; treat `origin/saga4`
as truth.

**Blockers:** ADR-094 exit checks unexecuted; Elite-8 liveness forbids builds.

**Exit criteria:** ADR-094 exit checks green → CAS lands with before/after
SHAs recorded → `origin/saga4` == consolidated tip → zero interference with
the live run → heavy validation separately authorized and scheduled.

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

**Blockers:** Elite-8 liveness forbids builds/tests; ADR-094 ordering puts the
CAS before heavy validation.

**Exit criteria:** scenario green twice consecutively on the consolidated tip;
matrix-hosted blocking with removal guard; S1 subordinate scenario green;
no behavioral edit to production physics (composition unchanged).

## Point 5 — Close proven defects and build the Elite-8-scale corpus

**Status:** PENDING (defects proven and recorded; fixes NOT written here).

- [ ] **Task-shadow binding (P0, SM-14/MM-3):** fix `readTaskForWorkplace`
      newest-wins selection (`src/app/product-lifecycle-runtime.ts:587-593`)
      + integration test on a REAL multi-task singleton workplace (R3;
      every current unit stubs the port).
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
- [ ] **FULL Discovery legacy ControlIntent/tools/handlers removal WITH ADR +
      removal guard:** delete the dead six-handler factory
      (`src/modules/discovery/application/discovery-installation.ts:122-141`),
      dead MCP discovery tools (`src/tools/discovery-proposal-tools.ts`,
      `discovery-normalization-tools.ts`, `discovery-readiness-tools.ts`,
      `discovery-tool-args.ts`), legacy settlement service
      (`discovery-settlement-service.ts:158-159`), stale manifest pins
      (DISCOVERY_HANDLER_IDS/REFS + six-handler digest pin,
      `src/process-modules/modules/discovery/package/manifest.ts:97-104,360-388`)
      — resolving contradictions 01 §6.1-6.3/§CONTRADICTIONS 1-2; ADR records
      the removal; guard = architecture test pinning handler-map set equality
      (live handler set ONLY) + matrix row so reintroduction reddens CI;
      tests referencing dead surfaces migrate to the live
      `product_submit`/`process_node_submit` path first.
- [ ] Quarantine re-validation executed (R2): both PRE-EXISTING-RED rows
      re-run standalone; honest re-admission or fresh typed reasons.

**Commit/evidence:** defects proven in `docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md`
(91af2982) + `docs/factory-map/03_DEVELOPMENT.md:580-601` +
`BRIDGE_MATRIX.md:§4`; no fix commits yet.

**Blockers:** Elite-8 liveness (no builds); ADR-094 CAS ordering; corpus work
needs the Point-4 regression harness as its deterministic substrate.

**Exit criteria:** each fix lands with RED/GREEN regression; corpus actors
parameterized and hosted; Discovery legacy removal merged with ADR + guard
green; task-shadow integration test green on real multi-task singleton
workplace; no orphan left by the new suites (R1 check).

## Point 6 — Clean preflight, safe parallelism/operational envelope, current-config readiness

**Status:** PENDING (Elite-8 still live; preflight is a launch-day gate).

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
