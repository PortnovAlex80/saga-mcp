# Event-Kernel Refactoring — Execution Tracker

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
| EK-0 | Predecessor gate + immutable baseline | predecessor | coordinator | **DONE** | `23ef562d` | rerun proof (3 fails unreproducible) | BASELINE.md: 10/10 cmds, durations, classification | — |
| WP-01 | Authority reader/writer census | EK-0 | subagent | **DONE** | `eaa07093` | validator PASS (committed tool) | 1802 SQL stmts / 124 tables / 524 writers / 1486 readers, zero unclassified; rebuild sha256 80883186… | file-level attribution; non-SQL surfaces qualitative |
| WP-02 | Forward graph (inputs/commands only; PRIVATE until both frozen) | EK-0 | subagent | **DONE — frozen** | `1ccbf66d` | coordinator (reconciliation pending) | forward-graph.json sha256 a3800721…, 56 nodes / 132 edges / 10 gaps G1-G10 | names pending EK-1 freeze |
| WP-03 | Reverse graph (terminal claims only; PRIVATE) | EK-0 | subagent | **DONE — frozen** | `6e029e08` | coordinator (reconciliation pending) | reverse-graph.json, 88 nodes / 112 edges / 28 proofs (23 closed, 5 gap-flagged) / 8 gaps G1-G8 | names pending EK-1 freeze |
| WP-04 | Legacy + document deletion manifests | EK-0 | subagent | **DONE** | `681a82e7` | coordinator review pending | legacy: 127 tables + 572 src files (504 DELETE; purity-tested ADR-053 set) / docs: 439 entries (177/14/248), zero unclassified | family-level test split deferred to EK-8/9 |
| WP-16 | Freeze + validate the three admission specs | WP-01..04 | 3 spec agents | **ALL THREE DONE** — 16a `5ac40951` (36 dims, det., fail-loudly); 16b `394be77d` (4/4 mut.); 16c `1258cec7` (21/21, 3 RED); unified validator `validate:ek-admission-specs` green+det., admissionContractDigest 5b1be70a… | | pending | validate:ek-admission-specs + EK-ADMISSION-RECEIPT.json | package.json wiring = coordinator EK-1 exit |
| WP-05 | Pure kernel reducers + model explorer | EK-1, WP-16 | unassigned | NOT STARTED | — | — | src/workflow-kernel/domain/** + test:workflow-model | — |
| WP-06 | Greenfield schema + repositories | WP-05 | unassigned | NOT STARTED | — | — | src/workflow-kernel/persistence/** | — |
| WP-07 | Obligation consumer, waits, fault points | WP-06 | unassigned | NOT STARTED | — | — | src/workflow-kernel/application/** | — |
| WP-17 | CanonicalRoleContract compiler + consumer port | WP-05 | unassigned | NOT STARTED | — | — | role compiler/resolver + fixtures | — |
| WP-18 | Context envelope + receipt protocol | WP-07, WP-17 | unassigned | NOT STARTED | — | — | src/workflow-kernel/context-envelope/** | — |
| WP-08 | Development/material vertical + capsule ingress | WP-07, WP-17, WP-18 | unassigned | NOT STARTED | — | — | Development adapter + simple-server corpus | — |
| WP-09 | Planning, dependency, aggregate settlement | WP-07 | unassigned | NOT STARTED | — | — | WorkItem/aggregate composition | — |
| WP-10 | Kanban projection + command-only UI adapters | WP-08, WP-09, WP-17 | unassigned | NOT STARTED | — | — | projector/read API/UI | — |
| WP-11D | Discovery semantic package conversion | WP-09, WP-17 | unassigned | NOT STARTED | — | — | Discovery package paths | — |
| WP-11F | Formalization semantic package conversion | WP-09, WP-17 | unassigned | NOT STARTED | — | — | Formalization package paths | — |
| WP-11V | Development semantic package finalization | WP-08, WP-09, WP-17 | unassigned | NOT STARTED | — | — | Development package paths | — |
| WP-11L | Delivery semantic package conversion | WP-09, WP-17 | unassigned | NOT STARTED | — | — | Delivery package paths | — |
| WP-12 | Hard cutover + legacy deletion | WP-10, WP-11*, WP-16..18 | unassigned | NOT STARTED | — | — | entrypoint routing + deletion manifest execution | — |
| WP-13A | Scenario contract/model comparison/minimizer | WP-05 | unassigned | NOT STARTED | — | — | workflow test-engine core | — |
| WP-13B | Actors, fault scheduler, production-size fixtures | WP-07, WP-18 | unassigned | NOT STARTED | — | — | actor/fault test paths | — |
| WP-13C | CI hosting, removal guards, mutation coverage | WP-13A/B | unassigned | NOT STARTED | — | — | test manifests/tools (shared files via coordinator) | — |
| WP-13D | 20-project corpus + qualification drivers | WP-08, WP-13A | unassigned | NOT STARTED | — | — | corpus + drivers | — |
| WP-14 | Canonical docs rewrite + deletion patch | EK-1 | unassigned | NOT STARTED | — | — | documentation paths | — |
| WP-15 | Immutable scripted + real qualification | EK-10, WP-16..18 | unassigned | NOT STARTED | — | — | evidence only | — |

## Status notes (2026-08-25, operator stop-gate review)

- Reconciliation's 12 framed protocol decisions are **FROZEN** — see
  `PROTOCOL-DECISIONS-FROZEN.md` (commit 33bf1976); the reconciliation doc's
  "pending decisions" wording is historical narrative, superseded by the freeze.
- Operator stop-gate before WP-05 (9 items) IN EXECUTION: unified validator
  wired; independent verifier RUNNING; complexity-metric fixes (exact→max,
  repository/bypass split) agent RUNNING; non-SQL census formalization agent
  RUNNING; deletion-manifest validator+guard agent RUNNING; residuals mapping
  (this commit); tracker synced (this commit); admission-vector contract
  decided (generated output, gitignored, digest into the receipt).

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
