# ADR-095 Phase-2C — the eight-ratchet set + non-vacuity proofs (2026-08-24)

- **Branch/worktree:** `stage22/discovery-phase2c` (`saga-mcp-DISCOVERY-P2C`), base
  `b7500e67` (Phase-2B tip).
- **Scope:** ADR-095 Phase 2 proper — "ratchets first": author the COMPLETE
  eight-ratchet set plus the machine-executed mutation proofs, hosted
  BLOCKING, GREEN on the legacy-present tree, with every removal-pinning
  post-arm demonstrated RED against today's tree (recorded below). No
  production legacy deletion, no schema change, no checked-in dist, no
  weakening/quarantine.
- **New machine surface:**
  - `tests/infrastructure/adr-095-removal-inventory.mjs` — schemaVersion 3:
    the `removalSymbols` section (25 collision-free dead-module path tokens,
    42 named dead symbols, 8 dead-lane manifest logicalIds, table/index
    allowed-site pins) + validator rules (allowed sites must be classified
    on-disk paths; collision tokens stay excluded; logicalIds present in the
    manifest today).
  - `tests/infrastructure/adr-095-phase2c-ratchet-checks.mjs` — the PURE
    ratchet checkers (R1-R5) + state readers. Phase markers are DERIVED, not
    flags: `phase4Landed` = product-discovery version strictly > 3.0.2 with
    src==dist coherence (the atomic Decision-4 bump is the phase boundary —
    it cannot be flipped by reintroducing one file); `closureInSchema` =
    the dist SCHEMA_SQL still creates a closure table (phase-5 boundary).
  - `tests/architecture/adr-095-ratchet-suite.test.mjs` — 22 tests, hosted
    BLOCKING in the architecture group; removal guard **G2k** in
    `tests/infrastructure/acceptance-matrix-coverage.test.mjs`.

## Ratchet mapping 1..8 → exact owners

| # | ADR-095 ratchet | Exact owner(s) | State today |
|---|---|---|---|
| 1 | Shrinking allowlist | `adr-095-ratchet-suite` R1a/R1b (baseline ceiling 1; ZERO Discovery-scoped edges in both allowlist shapes) + bridge BR3 (dead-file edge denial) + dependency-direction's own `<= ALLOWLIST_BASELINE` test | GREEN (real tree) + RED (mutation) |
| 2 | Exact one-handler manifest/digest | `adr-095-ratchet-suite` R2a-R2e (pre-arm: censused six-ref/dead-dist-digest baseline at 3.0.2; post-arm: exactly `discovery-settlement-policy` at the production-cell dist digest, handler version bumped) + `handler-digest-runtime-consistency` (generic digest==dist, repins at Phase 4) | GREEN (pre-arm) + RED (4 mutations) + RED (post-arm vs legacy tree) |
| 3 | Full src symbol/table absence | `adr-095-ratchet-suite` R3a-R3e over `inventory.removalSymbols`; retired-ID fan-out owned by bridge BR5 (not duplicated) | GREEN (pre-arm) + RED (4 mutations) + RED (post-arm: 156 findings vs legacy tree) |
| 4 | Dist-aware clean-build absence | `adr-095-ratchet-suite` R4a/R4b (pre-arm build faithfulness; post-arm zero emitted dead modules; stale dist fail-closed) | GREEN (pre-arm) + RED (mutation) + RED (post-arm: 27 emitted files vs legacy dist) |
| 5 | Fresh DB lacks the closure | `adr-095-ratchet-suite` R5a-R5d over a REAL fresh DB created through `dist/db.js getDb` (never a SCHEMA_SQL text scan) | GREEN (pre-arm complete closure) + RED (3 mutations) |
| 6 | Live v2 behavior | hosted `discovery-live-v2` group (8 suites; hosting pinned by G2i) + factory-proof discovery packs + discovery-output-handoff; R6a adds the missing pin: the group is EXACTLY the eight files (no glob widening) | GREEN |
| 7 | Existing-DB boot, retired old installation | `discovery-legacy-removal-boot-regression` (in-process `installProductionModules` proof; hosting G2h); R7a anti-guts the owner (F5 drift oracle text must stay); spawned-engine exit-0 smoke lands with Phase 4 | GREEN (Phase-1 form) |
| 8 | Deliberate mutation RED/GREEN | R1b, R2b-R2e, R3b-R3e, R4b, R5b-R5d — every ADR-095 removed-surface mutation class is machine-executed on the SAME checker code path the real tree takes; Phase-6 re-executes the cycle on the removed tree | GREEN (non-vacuity proven) |

## Mutation classes → RED evidence (machine-executed, blocking)

| ADR-095 ratchet-8 class | Test | Exact RED message (fragment) |
|---|---|---|
| dead handler ref (six stale refs post-bump) | R2b | `EXACTLY ONE handler ref (got 6 …)` + `retired handler ids still declared` |
| stale manifest pin at the old version (one-ref reduction at 3.0.2 = the F5 shape) | R2c | `six-handler baseline` drift refusal |
| wrong digest pinned (F3) | R2d | `!= sha256 of the executed production-cell dist bytes` |
| handler version not bumped (Decision 4) | R2e | `bumped above the legacy 1.0.0` |
| legacy tool import | R3b | `dead module import (/discovery-proposal-tools) … src/modules/discovery/index.ts` (RED in BOTH arms) |
| projection write reintroduced | R3c | `dead symbol (projectDiscoveryProposal) … src/tools/products.ts` post-cutover |
| symbol in a wrong live host (per-symbol allowed sites) | R3d | `… src/modules/module-registration.ts` pre-cutover |
| legacy CREATE TABLE (one instance, post-phase-5) | R5b | `PARTIAL legacy closure … present: [factory_proposals …]` + all 9 missing tables/19 indexes named |
| schema closure removed before the cutover (F2) | R5c | `removed only AFTER the code deletion and version bump` |
| kept table lost | R5d | `factory_work_intents … never part of the removal` |
| allowlist grandfathering / baseline growth | R1b | `Discovery-scoped edges` / `ALLOWLIST_BASELINE grew` |
| stale dist (emitted dead module post-cutover; absent dist) | R4b | `clean rebuild` (both directions) |

## Removal-pinning post-arms vs TODAY's legacy-present tree (RED demonstration)

One-off capture on the 2026-08-24 clean build (dead-dist digest prefix
`a0f5f5f7ed8f…`, production-cell prefix `bc39da865e3f…`; prefixes only — the
full values are recomputed per build by the checkers):

- **R2 post-cutover arm:** RED — `EXACTLY ONE handler ref (got 6 …)`, wrong
  logicalIds, dead digest != production-cell bytes.
- **R3 post-cutover arm:** RED — 156 findings naming the still-live legacy
  references (product-lifecycle-runtime, brief-provisioning-ports, …);
  phase-5 table arm RED — all ten closure tables named in `src/schema.ts`.
- **R4 post-cutover arm:** RED — 27 emitted dead modules in dist (e.g.
  `dist/modules/discovery/application/discovery-installation.js`).
- **R5:** the F2-ordering arm and the partial-closure arm RED via the
  recorded virtual-state runs (a real post-phase-5 fresh DB cannot exist on
  this tree by construction).

The consolidated tip stays GREEN because the suite selects arms by the TRUE
markers (version still 3.0.2 → pre-arms), exactly the ADR Phase-2 rule
("no consolidated tip ever carries a red suite").

## Honest boundary of the two-armed design

A full re-addition of ALL ten closure CREATEs post-phase-5 maps to the
legitimate phase-4→5 intermediate state and is GREEN by design: re-adding
the DDL is the ADR-095 rollback boundary for Phase 5 ("fresh-schema removal
is reversible by re-adding DDL"). The ratchet-8 mutation class is ONE
reintroduced instance, which is RED in every arm. Same-verison-integrity of
the intermediate states is enforced by the completeness assertions (partial
closures are RED in both directions).

## Validation (this commit)

- Clean build: `npm run build` exit 0 (dist NOT checked in).
- `architecture` group: 477/477 (includes the new 22-test ratchet suite,
  the 16-test bridge suite, dependency-direction, handler-digest,
  kernel-admission, v4-target).
- `process-modules` group: 1461/1461 (boot regression, migration-conformance,
  discovery-package-contributions).
- `discovery-live-v2`: 134/134. `matrix-coverage`: 23/23 (G2k live).

## Phase-3 gate status (honest)

NOT green — by design and by ADR ordering: Phase 3 (live side-effect
removal) has not executed; no production code changed in Phase-2C. What
Phase-2C establishes is the Phase-3 ENTRY gate: ratchets armed and green on
the legacy-present tree, inventory complete (Phase-2B), every same-commit
obligation machine-recorded, and the removal-pinning arms proven non-vacuous
and RED-ready. The Phase-3 EXIT gate (projection/proposal-ref/
`discovery_proposal_id`/settlement-debug legacy query gone;
`runtimePersistence` construction + field + ensure*/lazy-recreate sites
gone; live v2 green on the still-existing schema) is enforced, after the
phase-3 commit, by R3's empty post-phase-3 host expectations + the existing
hosted suites — no new oracle needed.
