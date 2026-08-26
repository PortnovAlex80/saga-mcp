| WP-13D | 20-project corpus + qualification drivers | WP-08, WP-13A | subagent | **DONE** | merge after f82cb167 | corpus 33/33; --full 20/20 green; kit replay 2/2 (elite-8 truthful-failure, elite-fresh blocked-honest) | tests/project-corpus + tools/project-corpus | 3 kernel findings (dupe-effect scope, human-decision node edge, drain oracle) || WP-13C | CI hosting, removal guards, mutation coverage | WP-13A, WP-13B | subagent | **DONE** | merge after 830082e9 | removal-guard 9/9 + mutation-coverage 2/2 + evidence-kit 3/3; harness 6/6 mutations killed | matrix/ci + ek-* tools | RG3c pinned findings (composition-root/engine-supervisor/claude-runner partial survival) || WP-11V | Development semantic package finalization | WP-08, WP-09, WP-17 | subagent | **DONE** | merge after 0e8ddbbe | development 38/38 + synthetic 20/20; generalization proof (no new kernel kind) | workshops/development + synthetic/** | already-applied-only world cannot reach run-success (EK-8 reconciliation) || WP-13B | Actors, fault scheduler, production-size fixtures | WP-07, WP-18 | subagent | **DONE** | merge after 4fc531ae | 64/64 new suites; 16-point crash matrix identical worlds; Elite-3 436,283-byte fixture | actors/faults/fixtures/dimension-drivers | DUPLICATE_EFFECT on legal human-waited re-settle (WP-05 oracle); hydration dedupe (WP-06) |

Coordinator-owned (EK-0 rule): only the integration coordinator edits this
tracker or the plan. One row per bounded work package.

- **Integration branch:** `integration/event-kernel-ek`
- **Base SHA:** `21ba0816` (= the predecessor's reviewed closing line: receipt
  commit `bacf4f82` + docs post-scripts; pushed, origin/saga4 == saga4)
- **Predecessor:** CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN complete —
  receipt `docs/factory-run/qualification-adr096/COMPLETION-RECEIPT.md`;
  ADR-053 accepted/**closed**; ADR-098 accepted/planned (placement rule
  intact: successor contracts freeze in EK-1, never inferred from legacy
  representations).
- **Predecessor residuals (EK-1 must import as blocking EK-13 criteria):**
  6 structural Development tokens + 2 Delivery + 10 documentation
  fault/recovery families; 9 low authority seams (ratchet-guarded); CC-41
  fault scheduler + CC-42 minimization (refused per §13); CC-U2
  warrant-oracle command authority (ADR-093 reserved); EK-12 pre-send
  transport blocker (the OpenCode shim cannot prove per-turn budget).

| Package | Bounded assignment | Depends on | Owner | Status | Commit | Verifier | Evidence | Residual |
|---|---|---|---|---|---|---|---|---|
| EK-0 | Predecessor gate + immutable baseline | predecessor | coordinator | **DONE** | — | — | BASELINE.md (pending suite) | — |
| WP-01 | Authority reader/writer census | EK-0 | subagent | **DONE** | `eaa07093` | validator PASS (committed tool) | 1802 SQL stmts / 124 tables / 524 writers / 1486 readers, zero unclassified; rebuild sha256 80883186… | file-level attribution; non-SQL surfaces qualitative |
| WP-02 | Forward graph (inputs/commands only; PRIVATE until both frozen) | EK-0 | subagent | **DONE — frozen** | `1ccbf66d` | coordinator (reconciliation pending) | forward-graph.json sha256 a3800721…, 56 nodes / 132 edges / 10 gaps G1-G10 | names pending EK-1 freeze |
| WP-03 | Reverse graph (terminal claims only; PRIVATE) | EK-0 | subagent | **DONE — frozen** | `6e029e08` | coordinator (reconciliation pending) | reverse-graph.json, 88 nodes / 112 edges / 28 proofs (23 closed, 5 gap-flagged) / 8 gaps G1-G8 | names pending EK-1 freeze |
| WP-04 | Legacy + document deletion manifests | EK-0 | subagent | **DONE** | `681a82e7` | coordinator review pending | legacy: 127 tables + 572 src files (504 DELETE; purity-tested ADR-053 set) / docs: 439 entries (177/14/248), zero unclassified | family-level test split deferred to EK-8/9 |
| WP-16 | Freeze + validate the three admission specs | WP-01..04 | 3 spec agents | **DONE** — **16b DONE** (394be77d: schema+manifest b1ef94c2, 4/4 mutations killed); **16c DONE** (1258cec7, 21/21 det., 3 RED); 16a rev3 DONE (b507773a, `ek1/fix-complexity-residual-dims`: 8 census-frozen dims re-bound, budget rev3, vector v3, 8/8 synthetic reds) — coordinator freeze pending | pending | validate:ek-admission-specs + EK-ADMISSION-RECEIPT.json | package.json wiring = coordinator EK-1 exit; open findings: cumulativeAccountants/deps/3x contract.* still latent-red on kernel trees + ACD digest-insensitive (COMPLEXITY-BUDGET.md §7 items 9-10) |
| WP-05 | Pure kernel reducers + model explorer | EK-1, WP-16 | unassigned | NOT STARTED | — | — | src/workflow-kernel/domain/** + test:workflow-model | — |
| WP-06 | Greenfield schema + repositories | WP-05 | unassigned | NOT STARTED | — | — | src/workflow-kernel/persistence/** | — |
| WP-07 | Obligation consumer, waits, fault points | WP-06 | unassigned | NOT STARTED | — | — | src/workflow-kernel/application/** | — |
| WP-17 | CanonicalRoleContract compiler + consumer port | WP-05 | unassigned | NOT STARTED | — | — | role compiler/resolver + fixtures | — |
| WP-18 | Context envelope + receipt protocol | WP-07, WP-17 | unassigned | NOT STARTED | — | — | src/workflow-kernel/context-envelope/** | — |
| WP-08 | Development/material vertical + capsule ingress | WP-07, WP-17, WP-18 | subagent | **DONE** | merge after 047cb2f3 | development 55/55; capsule 9-digest verify; 6 typed refusals; ADR-053 revision authority | development/** + simple-server corpus | reducer gap effect-uncertainty-waited (D12 edge, EK-1 amendment); WP-18 refused-receipt durability (EK-8); frontier shadowing openUnknownObligation (WP-09) |
| WP-09 | Planning, dependency, aggregate settlement | WP-07 | subagent | **DONE** | merge after afa59c17 | planning 42/42; 7 RED kills; topology bindings supplied to WP-07 lanes | planning/** | upstream-repair row discharge (universe lane refinement, EK-7+); multi-process-per-stage = WP-11* |
| WP-10 | Kanban projection + command-only UI adapters | WP-08, WP-09, WP-17 | subagent | **DONE** | merge after 80c7a39e | projection 30/30; 3 mandatory mutations identical-trace; F1/F2/F3 fences | projection/** | retry arms for future EK-8 semantics; receipts reader (WP-12) |
| WP-11D | Discovery semantic package conversion | WP-09, WP-17 | subagent | **DONE** | merge after fbc54b86 | discovery 74/74; ingress via bootstrap+importCapsule; manifest-only identity | workshops/discovery/** | refused-receipt durability + revision payload digest (WP-12 schema deltas) |
| WP-11F | Formalization semantic package conversion | WP-09, WP-17 | subagent | **DONE** | merge after 06cab6f1 | formalization 68/68; full 11-node/18-edge flow to run.success; 7/7 RED kills | workshops/formalization/** | open frontier rows (reference posture); chain rehydration (re-drive convergence only) |
| WP-11V | Development semantic package finalization | WP-08, WP-09, WP-17 | unassigned | NOT STARTED | — | — | Development package paths | — |
| WP-11L | Delivery semantic package conversion | WP-09, WP-17 | subagent | **DONE** | merge after 87d304a1 | delivery 55/55; approval pause = TypedWait + D12 disposition; local-only policy enforced | workshops/delivery/** | re-release already-applied at run scope (EK-8 decision); recordHumanDecision node edge frozen-vocab-only |
| WP-12 | Hard cutover + legacy deletion | WP-10, WP-11*, WP-16..18 | unassigned | NOT STARTED | — | — | entrypoint routing + deletion manifest execution | — |
| WP-13A | Scenario contract/model comparison/minimizer | WP-05 | unassigned | NOT STARTED | — | — | workflow test-engine core | — |
| WP-13B | Actors, fault scheduler, production-size fixtures | WP-07, WP-18 | unassigned | NOT STARTED | — | — | actor/fault test paths | — |
| WP-13C | CI hosting, removal guards, mutation coverage | WP-13A/B | unassigned | NOT STARTED | — | — | test manifests/tools (shared files via coordinator) | — |
| WP-13D | 20-project corpus + qualification drivers | WP-08, WP-13A | unassigned | NOT STARTED | — | — | corpus + drivers | — |
| WP-14 | Canonical docs rewrite + deletion patch | EK-1 | unassigned | NOT STARTED | — | — | documentation paths | — |
| WP-15 | Immutable scripted + real qualification | EK-10, WP-16..18 | unassigned | NOT STARTED | — | — | evidence only | — |

## Baseline status (EK-0)

Suite commands RUNNING (background, `/d/Development/ek0-baseline.log`);
BASELINE.md records counts/durations when complete.

## Observed prompt incidents (recorded per EK-0)

- Elite-3 planner request **436,283 bytes** → opencode/Z.AI pre-tool reject,
  8 shim retries (docs/factory-run/stage20-elite/RUN-TRACKER.md:214).
- Largest preserved Elite-8 request: to be measured from preserved evidence
  during EK-1 (WP-01 census notes).
- `SAGA_PROMPT_MAX_BYTES`: tracker-view/claude-runner.mjs:581
  `Number(process.env.SAGA_PROMPT_MAX_BYTES ?? 0)` — **unset/0 currently
  means UNLIMITED** (baseline fact for the successor's fail-closed envelope;
  the EK-1 law: an unset or zero budget is never unlimited).
- Role-resolution + prompt/context assembly sites: enumerated in the WP-01
  census (EK-1).


## EK-1 exit (2026-08-25)

EK-ADMISSION-RECEIPT signed at d491ce7c. ACD d1d6f857… verified by
independent round-2 verifier (counterexample killed, all 8 tasks green).
All 9 specification digests now inline in the receipt (operator review
round 3 correction).

## New work item: Elite Evidence Kit v1 (operator directive 2026-08-25)

**Status 2026-08-26: EXTRACTION COMPLETE** — merged at c2cc99de (branch ek/evk-extract, HEAD 533555ea). Two corpus entries committed: elite-fresh-20260825 (35 input capsules / 28 actor capsules / 876 normalized events / 13-13 invariants) and elite-8 (41 / 29 / 665 / 13-13, 14 failure witnesses incl. 9 repair_required verdicts). Deterministic extractor tools/elite-evidence-kit/extract.mjs (double-extraction byte-identical). Consumers: WP-08 capsule ingress + WP-13A scenario contract + WP-13B actors + WP-13D corpus. Elite-2 remains parked at its human gate (operator-reserved click).


Convert Elite runs into regression corpus per the operator's proposal:
- **Elite-8** (terminal, failed at development-plan-task-graph) → immutable
  NEGATIVE scenario: expected outcome = honest typed refusal without
  damage to the chain
- **Elite-fresh-20260825** (30/30 tasks, 29/30 gates, terminal
  development-blocked on test-infrastructure failures) → SUCCESS/PARTIAL
  corpus: all 29 certified capsules + full actor programs
- Format: source-manifest.json + input-capsule/ + actor-program/ +
  expected-trace.json + expected-invariants.json + failure-witnesses/
- Greenfield constraint: old SQLite DB is read-only extraction source;
  the new kernel receives a neutral versioned capsule through public
  ingress (never the raw DB)
- Maps to: WP-08 (capsule ingress) + WP-13A (scenario contract) +
  WP-13B (actors) + WP-13D (corpus)
