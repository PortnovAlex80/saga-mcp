# Discovery legacy complete removal: ratchet-first hybrid with an atomic versioned manifest cutover (ADR-095, Option H)

- **Status:** Accepted (dictatorial pick after the autonomous-decision loop;
  recorded here with Cynefin triage, options, MCDA arithmetic, pre-mortem,
  and the red-team corrections that changed the option)
- **Date:** 2026-08-23
- **Context:** the 2026-08-23 factory maps proved a fully dead Discovery
  ControlIntent/tools/handlers stratum (six-handler factory, MCP tools,
  settlement service, D2-D5 repositories, stale manifest pins, a ten-table
  legacy schema closure) plus ONE live write-side effect
  (`product_submit` → `factory_proposals` projection); the operator
  explicitly requires COMPLETE removal and approves deleting legacy-only
  tests
- **Decision id:** DJ-2026-08-23-DISCOVERY-LEGACY-REMOVAL
- **Recorded by:** ADR-095
  (`docs/architecture/decisions/095-complete-removal-of-dead-discovery-legacy.md`)
- **Numbering:** ADR-095 verified free; ADR-093 stays reserved for the open
  CC-GAP-7 warrant decision

## Cynefin triage

**Complicated** — deadness is knowable from the already-run independent
maps; the residual expert work is the resume/DB seam analysis, which the
red team probed. Full loop (options, Weighted Sum MCDA, pre-mortem,
adversarial review) was proportionate.

## Options considered

- **A — one atomic removal commit:** everything deleted at once; no
  pre-existing ratchets; huge diff; compatibility validated last.
- **B — ratchet-first shrinkage:** ratchets and mutation proofs first, then
  small individually-green removal steps; slowest; manifest/schema cutover
  not atomic.
- **V — vertical slices with a retained `factory_proposals` read-model
  spine:** each slice ships value; live v2 E2E first; but retention violates
  the operator's complete-removal directive and ADR-053's
  no-permanent-fallback rule.
- **H — corrected hybrid (selected):** ratchets-first spine + per-phase
  vertical slices + ONE atomic module-version-bumped manifest cutover,
  carrying every red-team correction.

## MCDA matrix

Weights (sum 100): sole-authority correctness 30, proof/testability 25,
production-resume/DB safety 20, diagnosability/reversibility 15, simplicity
10. Scores 1-5; weighted = score × weight; total /500.

| Option | Sole-authority 30 | Proof 25 | Resume/DB 20 | Diagnosability 15 | Simplicity 10 | Total /500 |
|---|---:|---:|---:|---:|---:|---:|
| A. atomic | 5 | 3 | 3 | 4 | 4 | 385 (3.85) |
| B. ratchet-first | 4 | 5 | 4 | 5 | 3 | 430 (4.30) |
| V. vertical + retained spine | 4 | 5 | 5 | 5 | 3 | 450 (4.50) — INVALID |
| **H. corrected hybrid** | 5 | 5 | 5 | 5 | 3 | **480 (4.80)** |

Arithmetic: A 150+75+60+60+40=385; B 120+125+80+75+30=430;
V 120+125+100+75+30=450; H 150+125+100+75+30=480.

- V's initial lead (4.50) was a score on the option AS BRIEFED; the red
  team showed the briefed V retains `factory_proposals` — a binding
  constraint violation, so V is invalidated rather than outscored.
- H's resume/DB 5 exists only AFTER the stop-ship correction (atomic
  version bump + retained installations + census + boot regression); the
  uncorrected hybrid would have scored 3 there.

## Pre-mortem (summary — full text in ADR-095)

- **F1 hidden reader** — refuted (no production reader); but the same
  investigation exposed the LIVE `product_submit` writer → writer removed
  (Phase 3) before the table removal (Phase 5).
- **F2 incomplete FK/lazy recreation** — repositories lazily re-CREATE
  tables; runtimePersistence/ModuleSharedDeps/ensure* must go BEFORE schema
  removal, pinned by the fresh-DB absence ratchet.
- **F3 wrong digest** — repin must target the executed
  `discovery-production-cell-installation.js` dist bytes.
- **F4 dishonest evidence rewrite** — historical docs append-only;
  superseded, never rewritten.
- **F5 half migration (STOP-SHIP)** — six-to-one handler refs at the same
  module version cause `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT`
  (uncaught by production-install; host boot exit 1 on existing DBs) →
  atomic version bump mandatory.
- **F6 ratchet scope** — ratchets must be dist-aware and fresh-DB-aware,
  not src-only.
- **F7 nonexistent pause** — no "paused/retained" legacy state exists;
  vocabulary is binary (present/removed).

## Red-team verdict

**ACCEPT-WITH-CORRECTIONS.** Adopted: the atomic product-discovery module
version bump; digest repin to `discovery-production-cell-installation.js`;
retained old installations for pinned runs; Phase-1 census of nonterminal
pre-bump pinned runs; existing-DB boot regression. Rebutted: "hidden
consumer breaks" (map evidence; burden moved to the writer), "pick V, it
scores highest" (constraint overrides matrix), "census/boot regression are
over-engineering" (they are the only mechanical proof of the F5 fix).

## Decision

Execute ADR-095 Option H: six ordered phases (1 ADR/inventory/census;
2 ratchets; 3 live side effects removed + v2 E2E; 4 atomic version bump +
manifest repin + code/resources deletion + existing-DB boot test; 5 atomic
fresh-schema closure removal, never DROP; 6 empty allowlist + mutation
proofs + full validation), eight ratchets, six existing blocker suites
updated (v4-target, handler-digest-runtime-consistency,
kernel-admission-distance, migration-conformance, dependency-direction,
discovery-package-contributions), live v2 files/tests preserved,
`factory_work_intents` preserved, historical docs append-only. Legacy-only
test deletion is authorized by the operator directive, scoped to tests that
exercise exclusively removed surfaces; mixed tests migrate first.

## Ex ante expectations

IF this decision is right, then within 30 days: the dependency-direction
allowlist contains zero discovery-legacy entries; `src/` and a clean-built
`dist/` contain none of the removed symbols/files; a fresh DB creates none
of the ten removed tables; an existing DB with a retired old discovery
installation boots exit 0 and rehydrates pinned runs from the retained
installation. Within 90 days: no new `factory_proposals` row appears in any
production DB after the Phase-3 commit; no `MODULE_INSTALLATION_*` boot
failure occurs on any DB carrying the retired installation; the discovery
manifest declares exactly one handler whose digest matches the executed
production-cell dist bytes.

## Check trigger

Any proposal to (a) reintroduce a Discovery ControlIntent handler, MCP
tool, or legacy repository; (b) keep or re-add any of the ten legacy tables
in fresh `SCHEMA_SQL`; (c) change the discovery handler set or manifest
digest WITHOUT a strictly-higher module version in the same commit; (d)
DROP or rewrite legacy tables in an existing DB; or (e) delete a test that
also covers live v2 surfaces — re-runs this record's red-team challenge.

## What would change this decision

Evidence of a genuine production READER of `factory_proposals` outside the
product_submit projection (F1 was refuted on current map evidence; a real
reader would force a compatibility-read phase before removal); or an
operator directive to preserve the legacy MCP discovery tools (would
contradict the complete-removal premise this record stands on); or a
discovery-module consumer that requires the six-handler contract surface
(would reopen CONTRADICTION 1 rather than close it).

## References

- `docs/architecture/decisions/095-complete-removal-of-dead-discovery-legacy.md`
- `docs/architecture/adr-closure-registry.json` (ADR-095 entry)
- `docs/factory-map/01_DISCOVERY.md` (DEAD strata + CONTRADICTIONS 1-2)
- `docs/factory-run/stage22-elite9/PRE-ELITE9-TRACKER.md` (Point 5 phases)
- ADR-053, ADR-034, ADR-077, ADR-094 (precedents and seam owners)
