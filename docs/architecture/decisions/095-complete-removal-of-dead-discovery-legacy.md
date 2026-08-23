# ADR-095: Complete removal of the dead Discovery ControlIntent/tools/handlers legacy

- **Status:** Accepted
- **Date:** 2026-08-23
- **Decision-maker:** operator removal directive 2026-08-23 (Codex orchestration),
  decided through the autonomous-decision loop (Cynefin triage, options, MCDA,
  pre-mortem, adversarial red-team review with ACCEPT-WITH-CORRECTIONS,
  dictatorial pick with recorded rationale)
- **Numbering note:** ADR-095 verified free before this record (no `093-*` or
  `095-*` file exists; `094-*` is the highest). ADR-093 remains RESERVED for
  the still-open CC-GAP-7 warrant decision (chosen direction only: A-prime;
  no implementation claimed), per ADR-094's numbering note.
- **Builds on:** ADR-053 (one authority per handler id; delete legacy paths,
  do not retain them as fallback), ADR-076/registry protocol,
  ADR-077/K3-K5 (real handler digests, resume compatibility,
  restart-required semantics), ADR-034 (rehydrate exact persisted package
  pins), `docs/factory-map/01_DISCOVERY.md` (DEAD/DECLARATIVE-ONLY STRATA
  1-7, CONTRADICTIONS 1-2), `docs/factory-map/GRAPH_RECONCILIATION.md`
  (dead-candidate classification), GUARDRAILS.md, ADR-094 (same-day
  precedent for dictatorial operational decisions with MCDA + journal)
- **Decision journal:**
  `docs/architecture/decision-journal/2026-08-23-discovery-legacy-complete-removal.md`
- **Implementation truth at acceptance:** NONE. This is a docs-only decision
  record. No production code, test, dist, DB, process, remote, or `saga4`
  ref was touched by this ADR. Implementation is owned by the six phases
  below (pre-Elite-9 tracker Point 5).

## Context

The 2026-08-23 factory maps proved a complete dead legacy stratum inside and
around the Discovery module:

1. **Dead six-handler factory.** `createDiscoveryKernelHandlers`
   (`src/modules/discovery/application/discovery-installation.ts:122-141`)
   registers six ControlIntent-era kernel handlers
   (`discovery-resolve-proposal-submission`, `-prepare-normalization`,
   `-resolve-normalized-proposal`, `-prepare-readiness`,
   `-resolve-readiness`, `discovery-settlement-policy`). The live composition
   registers ONLY the production-cell settlement handler
   (`src/modules/discovery/index.ts:48-58`, bytes from
   `discovery-production-cell-installation.ts:143-145`); the dead factory's
   only caller is the never-invoked package adapter
   `package/contributions/handler-adapter.ts:241`.
2. **Dead MCP tools.** `src/tools/discovery-proposal-tools.ts`,
   `discovery-normalization-tools.ts`, `discovery-readiness-tools.ts`
   (helpers in `discovery-tool-args.ts`) are imported by no MCP composition
   (`src/index.ts:14-52` imports none); live cells submit via
   `product_submit` and `process_node_submit`.
3. **Dead settlement service + repositories.**
   `FactoryDiscoverySettlementService`
   (`discovery-settlement-service.ts:158-159`) has no production construction
   site; the D2-D5 repositories (`discovery-normalization-repository.ts`,
   `discovery-readiness-repository.ts`, `discovery-settlement-repository.ts`,
   `discovery-proposal-repository.ts`, `sqlite-discovery-runtime.ts`) back
   only dead paths, and several lazily `CREATE TABLE IF NOT EXISTS` their
   legacy tables on construction.
4. **Stale manifest pins.** `DISCOVERY_HANDLER_IDS`/`DISCOVERY_HANDLER_REFS`
   pin six handler ids, every ref carrying the sha256 of the DEAD
   `discovery-installation.js` dist bytes
   (`src/process-modules/modules/discovery/package/manifest.ts:97-104,360-388`),
   while the live `discovery-settlement-policy` bytes come from
   `discovery-production-cell-installation.js`. Two modules define a handler
   under the same id with different signatures and certificate payloads
   (CONTRADICTION 1); five pinned ids have no kernel node (CONTRADICTION 2).
5. **One LIVE write-side effect.** `product_submit` projects every Discovery
   proposal submission into a `factory_proposals` row inside its submission
   transaction (`src/tools/products.ts:68-93` →
   `discovery-proposal-projection.ts`), also emitting a
   `PROPOSAL_REF_SCHEMA` product via `proposal-ref-bridge.ts` and a
   `discovery_proposal_id` response field (`products.ts:122`). The
   `settlement_explain` tool carries a legacy Discovery query over
   `factory_discovery_settlements` (`src/tools/settlement-debug.ts:117-139`).
6. **Legacy schema closure.** The fresh-DB `SCHEMA_SQL` still creates the
   Discovery-legacy family: `factory_proposals` (D3) plus its nine-table FK
   closure — `factory_raw_submissions`, `factory_control_intents`,
   `factory_normalization_proposals` (D2), `factory_readiness_control_intents`,
   `factory_readiness_assessments` (D3 shadow),
   `factory_discovery_settlements`, `factory_discovery_outcome_certificates`
   (D4), `factory_discovery_diagnosis_control_intents`,
   `factory_discovery_diagnosis_reports` (D5) — with their indexes
   (`src/schema.ts:876-1125`).
   `factory_work_intents` is NOT part of this closure: it is a live shared
   protocol entity (dispatcher, work-assignment-core, atomic-release,
   author-carry-forward, `factory_execution_completion_products`) and stays.

The operator directive is explicit and binding on the decision scope:

> COMPLETE removal of the dead Discovery ControlIntent/tools/handlers
> implementation. Deletion of legacy-only tests is approved. Historical
> design/evidence docs are append-only/superseded, never rewritten.

## Cynefin triage

**Complicated.** The deadness of every removal target is already knowable
from the independent forward/reverse maps and the reconciliation (those maps
were the probe-sense pass that moved this from Complex to Complicated); the
residual difficulty is expert analysis of resume/DB compatibility seams
(pinned installations, fresh vs existing schema, dist digests), which is
knowable and was probed by the red team. Full decision loop, Weighted Sum
MCDA, pre-mortem, and adversarial review were therefore proportionate.

## Considered options

### Option A — one atomic removal commit

Delete everything (handlers, tools, services, repos, domain residue,
contributions, resources, manifest pins, schema closure, legacy tests) in a
single big-bang commit.

Pros: the manifest/schema/code truth flips in one step; no intermediate
state where code and pins disagree.
Cons: no ratchet exists before the deletion to prove absence afterwards; a
failure inside the huge diff is hard to bisect; resume/DB compatibility is
validated only at the end.

### Option B — ratchet-first shrinkage

First install the removal ratchets and mutation proofs, then remove the
legacy surface in small, individually green steps, shrinking the
dependency-direction allowlist entry by entry.

Pros: every step is independently verifiable and reversible; the ratchets
prove non-vacuity before the deletion lands.
Cons: slowest to the end state; intermediate states keep the dead factory
partially alive for weeks; the manifest/schema cutover is not atomic, so
intermediate pins can disagree with the installed flow.

### Option V — vertical slices with retained read model (initial MCDA leader)

Deliver the removal as user-visible vertical slices, keeping
`factory_proposals` as a "deterministic compatibility/read-model spine"
(its own header comment) while live paths migrate slice by slice.

Pros: each slice ships observable value; live v2 E2E comes first;
diagnosability is excellent.
Cons: **violates the operator's complete-removal requirement** — retaining
`factory_proposals` retains the legacy authority spine ADR-053 forbids
("old execution-scoped material lookups are deleted, not retained as
permanent fallback"). This constraint violation invalidated V's initial
MCDA lead regardless of its score.

### Option H — corrected hybrid: ratchet-first + vertical slices + atomic versioned manifest boundary (SELECTED)

Ratchets and mutation proofs are authored first (B's spine); each phase is
an independently verifiable vertical slice with live v2 behavior proven
before any deletion (V's spine); and the manifest/digest cutover is ONE
atomic module-version bump with the code deletion in the same commit (A's
spine), incorporating every red-team correction.

## Decision drivers and MCDA

Weights (sum 100), derived from the project's stated quality attributes
(ADR-053 authority conservation, ADR-076 proof protocol, CONVEYOR §2/§27
exact-authority and fitness-function rules, ADR-034 resume safety):
sole-authority correctness 30, proof/testability 25,
production-resume/DB safety 20, diagnosability/reversibility 15,
simplicity 10. Scores 1 (poor) – 5 (excellent); weighted total /500.

| Option | Sole-authority 30 | Proof 25 | Resume/DB 20 | Diagnosability 15 | Simplicity 10 | Total /500 |
|---|---:|---:|---:|---:|---:|---:|
| A. atomic removal | 5 | 3 | 3 | 4 | 4 | 385 (3.85) |
| B. ratchet-first | 4 | 5 | 4 | 5 | 3 | 430 (4.30) |
| V. vertical slices + retained read model | 4 | 5 | 5 | 5 | 3 | 450 (4.50) — INVALID |
| H. corrected hybrid (selected) | 5 | 5 | 5 | 5 | 3 | **480 (4.80)** |

Arithmetic (score × weight summed):

- A: 5·30 + 3·25 + 3·20 + 4·15 + 4·10 = 150+75+60+60+40 = **385**
- B: 4·30 + 5·25 + 4·20 + 5·15 + 3·10 = 120+125+80+75+30 = **430**
- V (as briefed): 4·30 + 5·25 + 5·20 + 5·15 + 3·10 = 120+125+100+75+30 = **450**
- H (corrected): 5·30 + 5·25 + 5·20 + 5·15 + 3·10 = 150+125+100+75+30 = **480**

Notes:

- V's 450 was computed on the option AS BRIEFED. The red team exposed that
  the as-briefed V retains `factory_proposals` as a permanent read-model
  spine — a constraint violation of the operator's complete-removal
  directive (and of ADR-053's no-permanent-fallback rule), not a scoring
  error. A binding constraint overrides the matrix: V was invalidated, not
  outscored. Its sole-authority 4 was optimistic precisely because the
  retained spine keeps a second material authority alive.
- H restores sole-authority to 5 (complete removal, empty allowlist end
  state), keeps proof 5 (ratchets-first, per-phase gates, mutation
  RED/GREEN), diagnosability/reversibility 5 (phase-scoped commit reverts,
  no DROP, inert old tables), and earns resume/DB safety 5 only AFTER the
  red-team stop-ship correction (atomic module-version bump, retained old
  installations, census, existing-DB boot regression) — the as-briefed
  hybrid would have scored 3 there (see F5).
- Simplicity stays 3 for B/V/H: six phases and a versioned cutover are more
  moving parts than one commit; that price is accepted deliberately.
- Per the decision protocol, the matrix did not decide this: the dictatorial
  pick is H because it is the only option that satisfies the operator's
  binding complete-removal constraint AND survives the red-team stop-ship
  correction. The matrix records why.

## Pre-mortem (on the leading hybrid)

Assumption: the removal completed and failed a month later.

1. **F1 — hidden reader of `factory_proposals`.** REFUTED by the maps: no
   production reader exists outside the projection itself
   (`GRAPH_RECONCILIATION` F∩B classification; `01_DISCOVERY` DEAD stratum
   4). BUT the same investigation exposed that `product_submit` is a LIVE
   WRITER (products.ts:68-93). The real F1 risk is therefore a hidden
   writer: deleting the table while the projection still writes would fail
   live runs. Control: Phase 3 removes the write side effect FIRST, while
   tables still exist; Phase 5 removes the schema only after the
   src-absence ratchet is green.
2. **F2 — incomplete FK/lazy recreation closure.** The D2-D5 repositories
   lazily `CREATE TABLE IF NOT EXISTS` their tables; `sqlite-discovery-
   runtime.ts` rebuilds `factory_work_intents` compatibility columns;
   `ensure-discovery-workspace.ts` provisions legacy workspace state.
   Removing the tables from `SCHEMA_SQL` while any of these constructors
   still runs would silently REGROW the closure on a fresh DB. Control:
   Phase 3 removes the `runtimePersistence` construction
   (`product-lifecycle-runtime.ts:349-350`), the `ModuleSharedDeps.
   runtimePersistence` field, and every ensure*/lazy-recreate site BEFORE
   Phase 5 touches the schema; the fresh-DB absence ratchet catches any
   survivor.
3. **F3 — wrong digest pinned.** Repinning `DISCOVERY_HANDLER_REFS` to the
   digest of the dead `discovery-installation.js` (or to a stale dist)
   while the live handler bytes come from `discovery-production-cell-
   installation.js` would enshrine CONTRADICTION 1 forever. Control: the
   manifest repin digest is the sha256 of the EXECUTED dist bytes of
   `discovery-production-cell-installation.js` (K3 canonical digester,
   runtime-consistency ratchet extended to the new pin).
4. **F4 — dishonest evidence rewrite.** Editing the historical
   design/evidence docs (map strata, run records, prior ADRs) to make the
   legacy "never have existed" would corrupt the audit trail. Control:
   historical docs are append-only; this ADR and the tracker supersede, they
   never rewrite. The map documents keep their dead-candidate
   classification with a superseded marker at most.
5. **F5 — half migration at the same module version (STOP-SHIP, red team).**
   Deleting the six-handler factory and flipping the manifest to one handler
   ref while keeping `product-discovery@3.0.2` means an existing DB with an
   ACTIVE 3.0.2 installation (old packageDigest) hits the installer's drift
   path: same name@version + different digest + changed handler logical-id
   set → `classifyResumeCompatibility` returns `incompatible` →
   `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT`
   (`src/process-modules/installation/domain/installer.ts:355-378`) — not
   caught by production-install on a FRESH DB, and fatal at host boot on an
   EXISTING DB (exit 1). Control (all mandatory): the manifest cutover MUST
   atomically bump the `product-discovery` module identity version (today
   `3.0.2` in `product-delivery-module-contracts.ts:30-33`) to a new,
   strictly higher version in the SAME commit as the handler-set change, so
   `getActiveByNameVersion` finds no existing active row at the new version
   and no drift classification can fire; repin the digest to
   `discovery-production-cell-installation.js`; RETAIN the retired old
   installations in the store so pre-bump pinned runs rehydrate their exact
   persisted package (ADR-034); and prove it with the Phase-1 census of
   nonterminal runs pinned to the pre-bump (legacy) installation plus the
   Phase-4 existing-DB boot regression.
6. **F6 — ratchet scope too narrow.** Ratchets that scan only `src/` miss
   emitted `dist/` files and fresh-schema DDL. Control: the absence ratchet
   is dist-aware (after a clean build) and the fresh-DB ratchet asserts the
   closure is absent from a newly created database, not merely from
   `SCHEMA_SQL` text.
7. **F7 — nonexistent pause vocabulary.** Any record claiming the legacy is
   "paused", "quarantined", or "soft-retained" invents a mechanism no code
   implements; the legacy state is binary (present with a live write path,
   or deleted). Control: this ADR's vocabulary is binary; the intermediate
   phases are described as ordered REMOVAL steps, never as a retention
   state.

## Independent red-team review (adversarial reviewer role, not a command)

Verdict: **ACCEPT-WITH-CORRECTIONS.** The reviewer challenged the hybrid's
cutover seam and the completeness claim:

1. **Stop-ship correction (adopted, F5 above):** the six-to-one handler-ref
   change at the same module version causes
   `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT`, uncaught by production-install
   and fatal (host boot exit 1) on existing DBs. Therefore the manifest
   cutover MUST atomically bump the `product-discovery` module version,
   repin the digest to `discovery-production-cell-installation.js`, retain
   old installations for pinned runs, and include the phase-1 census of
   nonterminal pre-bump pinned runs plus an existing-DB boot regression.
2. **"Complete removal will break a hidden consumer."** Rebutted with map
   evidence (F1) — with the correction that the burden of proof moves to
   the writer: the projection removal (Phase 3) lands before the schema
   removal (Phase 5), pinned by absence ratchets.
3. **"Vertical slices score highest; pick V."** Rejected as a constraint
   violation: retaining `factory_proposals` contradicts the operator's
   complete-removal requirement and ADR-053's no-permanent-fallback rule.
   A binding constraint overrides the matrix.
4. **"The census and boot regression are over-engineering."** Rejected: they
   are the only mechanical proof that retained old installations actually
   satisfy pinned runs after the cutover; without them F5's fix is
   unverified.

## Decision

Choose **Option H — corrected hybrid: ratchet-first + vertical slices +
atomic versioned manifest boundary.** Normative contract:

1. **"Complete" is defined exactly as follows.** Remove:
   - the `product_submit` → `factory_proposals` projection
     (`discovery-proposal-projection.ts`, the products.ts:68-93 projection
     block), `proposal-ref-bridge.ts` and its `PROPOSAL_REF_SCHEMA` product
     emission, the `discovery_proposal_id` response field, and the
     settlement-debug legacy Discovery query (`settlement-debug.ts:117-139`,
     the tool itself stays for non-Discovery traces);
   - the dead six-handler factory (`discovery-installation.ts`), the dead
     MCP tools (`discovery-proposal-tools.ts`,
     `discovery-normalization-tools.ts`, `discovery-readiness-tools.ts`,
     `discovery-tool-args.ts`), the legacy settlement service
     (`discovery-settlement-service.ts`), the D2-D5 repositories and
     runtime (`discovery-normalization-repository.ts`,
     `discovery-readiness-repository.ts`,
     `discovery-settlement-repository.ts`,
     `discovery-proposal-repository.ts`, `sqlite-discovery-runtime.ts`,
     `discovery-runtime-port.ts`), the dead package adapter
     (`package/contributions/handler-adapter.ts`), dead-lane package
     resources (normalizer/diagnosis skills, trackers, call-templates,
     checklists with their `pending@wave-2` digests), and the legacy domain
     residue (files used exclusively by the above, enumerated by the
     Phase-1 inventory: e.g. `proposal.ts`, `proposal-ref-bridge.ts`,
     `discovery-normalization*.ts`, `discovery-outcome-certificate.ts`,
     `discovery-outcome-certificate-projection.ts`,
     `discovery-readiness-records.ts`, `discovery-certificate-bundle.ts`,
     `ensure-discovery-workspace.ts`);
   - `factory_proposals` and the full nine-table legacy FK closure
     (`factory_raw_submissions`, `factory_control_intents`,
     `factory_normalization_proposals`, `factory_readiness_control_intents`,
     `factory_readiness_assessments`, `factory_discovery_settlements`,
     `factory_discovery_outcome_certificates`,
     `factory_discovery_diagnosis_control_intents`,
     `factory_discovery_diagnosis_reports`) plus their indexes from the
     fresh `SCHEMA_SQL`. `factory_work_intents` STAYS (live shared protocol
     entity).
2. **Never DROP or rewrite existing user tables.** Existing databases keep
   every legacy table as inert history. There is no migration that drops,
   renames, or rewrites them; readers are removed first, so the tables
   simply stop being written and read.
3. **Remove the runtime construction before the schema.** The
   `runtimePersistence` construction (`product-lifecycle-runtime.ts:349-350`),
   the `ModuleSharedDeps.runtimePersistence` field, and every ensure*/lazy
   `CREATE TABLE IF NOT EXISTS` recreation site are deleted in Phase 3,
   BEFORE the Phase-5 fresh-schema closure removal (F2 ordering invariant).
4. **Atomic versioned manifest boundary.** In ONE commit: bump the
   `product-discovery` module identity version to a strictly higher version;
   reduce `DISCOVERY_HANDLER_IDS`/`DISCOVERY_HANDLER_REFS` to exactly the
   live `discovery-settlement-policy` ref; repin the digest to the executed
   dist bytes of `discovery-production-cell-installation.js`; bump the
   handler version; delete the dead code/resources (scope in item 1);
   retain old installations in the store; and land the existing-DB boot
   regression proving a DB with a retired old installation boots and a
   nonterminal pinned run rehydrates its exact persisted package.
5. **Preserve the live v2 surface.** `src/modules/discovery/index.ts`,
   `discovery-production-cell-installation.ts`,
   `discovery-check-providers.ts`, the live domain files
   (`discovery-proposal.ts`, `discovery-readiness-assessment.ts`,
   `discovery-settlement-policy.ts`, `discovery-settlement-input.ts`,
   `discovery-settlement-records.ts`, and the live constants of
   `discovery-domain-contracts.ts`), the two live check providers, and the
   live E2E/constraint/output suites (discovery scenario/resilience packs,
   discovery-output-handoff, e-constraint-loss,
   order-constraint-register, d7-settlement-lifecycle-classification,
   discovery-check-providers) are preserved untouched.
6. **Historical docs are append-only.** Map strata, run records, and prior
   ADRs are superseded by this decision where applicable; they are never
   rewritten to hide the legacy (F4).
7. **Legacy-only tests may be deleted under explicit operator authority.**
   The operator directive of 2026-08-23 approves deletion of tests that
   exercise ONLY removed surfaces (satisfying the GUARDRAILS "never delete
   test files without explicit human approval" rule for this scope). A test
   that also covers live v2 behavior must be migrated/re-pointed to the
   live surface FIRST, never deleted. The Phase-1 inventory enumerates every
   deletion candidate with its exclusive-legacy justification before any
   deletion executes.

### Phases (each a separate reviewable commit-train; order is normative)

1. **Phase 1 — ADR/inventory/census.** This ADR + journal + registry +
   tracker refinement; a complete inventory classifying every
   discovery-related file/test/symbol as live-v2 / dead-legacy / shared,
   with the legacy-only test deletion list; the census of nonterminal runs
   pinned to the pre-bump (six-handler) discovery installation; the
   existing-DB boot baseline capture.
2. **Phase 2 — ratchets first.** Author the eight ratchets below and the
   mutation proofs; demonstrate each removal-pinning ratchet RED against
   the legacy-present tree (evidence recorded on the working branch); no
   consolidated tip ever carries a red suite (ratchets land green in the
   same commit-train as the removal they pin).
3. **Phase 3 — live side effects removed + v2 E2E.** Remove the
   `product_submit` projection, proposal-ref product, `discovery_proposal_id`
   field, settlement-debug legacy query, `runtimePersistence` construction,
   `ModuleSharedDeps.runtimePersistence`, and the ensure*/lazy-recreate
   sites; live v2 E2E and the live suites green on the still-existing
   schema (writes stop; nothing reads).
4. **Phase 4 — atomic version bump + manifest repin + code/resources
   deletion + existing-DB boot test.** The single-commit cutover of
   decision item 4.
5. **Phase 5 — atomic fresh-schema closure removal (no DROP) + absence
   test.** One commit removes `factory_proposals` + the nine-table closure
   + their indexes from `SCHEMA_SQL`; fresh-DB boot ratchet proves absence;
   existing DBs untouched (inert history).
6. **Phase 6 — empty allowlist + mutation proofs + full validation.** The
   dependency-direction legacy allowlist entries reach zero; every
   deliberate mutation RED/GREEN cycle is executed and recorded; full
   acceptance matrix + clean dist build green. Then the rest of tracker
   Points 5/6 proceeds.

### Ratchets (all eight green before the removal is called complete)

1. **Shrinking allowlist first** — the dependency-direction
   `KNOWN_VIOLATIONS` allowlist shrinks monotonically as legacy files die
   and contains zero discovery-legacy entries at Phase 6.
2. **Exact one-handler manifest/digest** — the manifest declares exactly one
   handler ref (`discovery-settlement-policy`) whose digest equals the
   sha256 of the executed `dist/.../discovery-production-cell-installation.js`
   bytes (handler-digest-runtime-consistency repinned).
3. **Full src symbol/table absence** — no removed symbol or table name from
   the Phase-1 inventory appears anywhere under `src/`.
4. **Dist-aware clean-build absence** — after a clean `tsc` build, `dist/`
   contains no emitted file of any removed module.
5. **Fresh DB lacks the full closure** — a newly created database contains
   none of the ten removed tables (or their indexes).
6. **Live v2 behavior** — the Discovery E2E (proposal → readiness →
   settlement certificate via `product_submit`/kernel settlement) is green
   and byte-stable at the durable boundaries.
7. **Existing DB boot with retired old installation** — a DB carrying a
   retired pre-bump installation (and a nonterminal pinned run) boots
   exit 0 with no `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT` /
   `MODULE_INSTALLATION_RESTART_REQUIRED`; the pinned run rehydrates its
   exact persisted package.
8. **Deliberate mutation RED/GREEN** — reintroducing one instance of each
   removed surface class (a dead handler ref, a legacy tool import, a
   projection write, a legacy CREATE TABLE, a stale manifest pin at the old
   version) turns the pinning suite RED naming the exact regression;
   removing it restores GREEN.

### Six existing blocker suites to UPDATE (never weaken)

- `tests/architecture/v4-target-conformance-ratchet.test.mjs` — re-pin the
  target surface set to the post-removal module graph.
- `tests/architecture/handler-digest-runtime-consistency.test.mjs` —
  re-pin from the six-handler legacy digest to the exact one-handler
  production-cell digest (ratchet 2).
- `tests/architecture/kernel-admission-distance.test.mjs` — recompute with
  the dead handler registrations gone.
- `tests/execution/migration-conformance.test.mjs` — update the migration
  dimensions for the removed closure (fresh DBs must never create it).
- `tests/architecture/dependency-direction.test.mjs` — the shrinking
  allowlist (ratchet 1); deleted files remove their violations and their
  allowlist entries in the same commit.
- `tests/process-modules/discovery-package-contributions.test.mjs` — pin
  the live one-handler package contributions (dead adapter gone).

## Consequences

Positive:

- one handler id resolves to exactly one implementation (CONTRADICTION 1
  closed); the manifest declares exactly the installed handler surface
  (CONTRADICTION 2 closed; map-equality defect D-3 resolved);
- `product_submit` loses a hidden write-side effect — one write path
  (managed node submissions) instead of two;
- the fresh-install schema shrinks by ten tables plus indexes; the legacy
  allowlist reaches zero; ADR-053's "delete, do not retain" rule is finally
  executed on the Discovery stratum;
- existing DBs boot safely with retired installations; pinned runs keep
  their exact packages (ADR-034 semantics preserved by construction).

Negative:

- legacy-only tests are deleted (operator-approved); their historical
  coverage intent survives only through this record and the inventory;
- pre-bump pinned runs can resume ONLY against their retained old
  installations — a DB whose store lost them fails closed (typed, by
  design);
- six phases and a versioned cutover cost more commits and review surface
  than a big-bang (simplicity 3, accepted).

Neutral:

- `factory_work_intents` and its triggers stay (shared live protocol
  entity);
- `settlement_explain` keeps its non-Discovery trace; the Discovery
  settlement snapshot block disappears with the table;
- ADR-093 stays reserved (CC-GAP-7, A-prime direction, unimplemented).

## Rollback boundaries

- Each phase is one commit-train: `git revert` of that commit rolls the
  phase back; no phase depends on un-committed state.
- Code rollback (any phase) never touches data: existing DB tables are
  never dropped or rewritten, so reverting code restores readers/writers
  against still-present inert tables.
- The module-version bump rolls back by reverting the Phase-4 commit (the
  manifest returns to the pre-bump version); installations already retired
  in a DB stay retired as recorded history — restoring an ACTIVE old
  installation is a new explicit decision, not an automatic effect
  (mirrors ADR-094's recorded-ref-arithmetic rule).
- The only forward-irreversible surface is NONE by construction: no DROP,
  no user-table rewrite, no push. Fresh-schema removal is reversible by
  re-adding DDL; existing DBs are untouched throughout.

## Exit criteria

All of the following before the removal is called complete (and before this
ADR's registry closureState may leave `planned`):

- [ ] Phases 1-6 each landed as a separate reviewable commit-train in
      order, with per-phase gates green.
- [ ] All eight ratchets green, including the dist-aware and fresh-DB
      absence ratchets and the existing-DB boot regression.
- [ ] All six named blocker suites updated and green (pinned to the
      post-removal truth, no assertion weakened).
- [ ] Deliberate mutation RED/GREEN cycles executed and recorded for every
      removed surface class (non-vacuity proof).
- [ ] Phase-1 census recorded: zero nonterminal runs pinned to the legacy
      installation that lack a retained installation row.
- [ ] Full acceptance matrix green on the clean-built dist; empty
      discovery-legacy allowlist.
- [ ] Registry entry updated with the closure evidence bundle.

## References

- `docs/factory-map/01_DISCOVERY.md` — DEAD/DECLARATIVE-ONLY STRATA 1-7,
  CONTRADICTIONS 1-2 (the proven-dead evidence)
- `docs/factory-map/GRAPH_RECONCILIATION.md` — dead-candidate classification
- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
- `docs/architecture/decisions/034-rehydrate-nonterminal-package-pins.md`,
  `077-canonical-runtime-package-fingerprint-and-resume-compatibility.md`
- `docs/architecture/CONVEYOR-MENTAL-MODEL.md` §2, §27 (exact-authority and
  fitness-function rules)
- `docs/factory-run/stage22-elite9/PRE-ELITE9-TRACKER.md` — Point 5 phases
- `docs/architecture/adr-closure-registry.json` — ADR-095 entry (same
  commit, per the ADR-076 registry protocol)
- `docs/architecture/decision-journal/2026-08-23-discovery-legacy-complete-removal.md`
- `GUARDRAILS.md` (test-deletion approval rule satisfied by the operator
  directive recorded here)
