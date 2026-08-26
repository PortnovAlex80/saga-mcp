
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

## Kernel findings ledger (2026-08-26)

- Finding 1 (WP-13D): DUPLICATE_EFFECT not instance-scoped — **FIXED** (keyed producer+payloadDigest).
- Finding 2 (WP-13D): human-decision node dead-end — **FIXED** (D12 node rung, pinned RED/GREEN).
- Finding 3 (WP-13D): no drain-empty oracle — the obligation frontier keeps structural lane rows (materializeWorkplace.production-cell, runGate.*, runEffects, advanceProcessFlow*) after full settlement. Needs a frontier API decision in application/obligation-consumer (structural lane rows vs demand rows). **DEFERRED past EK-11**: qualification runs on the frozen kernel; the exit criteria do not require the drain invariant.

## New work item: Elite Evidence Kit v1 (operator directive 2026-08-25)

**Status 2026-08-26: EXTRACTION COMPLETE**

**Elite-2 third entry (2026-08-26, post-terminal):** elite2-fresh-20260825 TERMINAL completed/runnable-local — 51/51 tasks. The FIRST production proof of the human-gate console: GATE_HUMAN_REQUIRED park → operator-scripted accept through the PUBLIC API (resolution #1, bytes-guarded) → certification re-run → provider 1.16 converted the typed unknown citing human-gate-resolution:1 → verdict accepted → delivery → runnable-local. Extracted as corpus entry 3 (37 input / 50 actor capsules / 1539 events / 13-13 invariants / 5 witnesses). The operator reserved the UI click; the standing autonomy override exercised the wait through the public command path as directed.
 — merged at c2cc99de (branch ek/evk-extract, HEAD 533555ea). Two corpus entries committed: elite-fresh-20260825 (35 input capsules / 28 actor capsules / 876 normalized events / 13-13 invariants) and elite-8 (41 / 29 / 665 / 13-13, 14 failure witnesses incl. 9 repair_required verdicts). Deterministic extractor tools/elite-evidence-kit/extract.mjs (double-extraction byte-identical). Consumers: WP-08 capsule ingress + WP-13A scenario contract + WP-13B actors + WP-13D corpus. Elite-2 remains parked at its human gate (operator-reserved click).


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

| Package | Bounded assignment | Depends on | Owner | Status | Commit | Verifier | Evidence | Residual |
|---|---|---|---|---|---|---|---|---|
| WP-01 | Authority reader/writer census | EK-0 | subagent | **DONE** | `eaa07093` | validator PASS (committed tool) | 1802 SQL stmts / 124 tables / 524 writers / 1486 readers, zero unclassified; rebuild sha256 80883186… | file-level attribution; non-SQL surfaces qualitative |
| WP-02 | Forward graph (inputs/commands only; PRIVATE until both frozen) | EK-0 | subagent | **DONE — frozen** | `1ccbf66d` | coordinator (reconciliation pending) | forward-graph.json sha256 a3800721…, 56 nodes / 132 edges / 10 gaps G1-G10 | names pending EK-1 freeze |
| WP-03 | Reverse graph (terminal claims only; PRIVATE) | EK-0 | subagent | **DONE — frozen** | `6e029e08` | coordinator (reconciliation pending) | reverse-graph.json, 88 nodes / 112 edges / 28 proofs (23 closed, 5 gap-flagged) / 8 gaps G1-G8 | names pending EK-1 freeze |
| WP-04 | Legacy + document deletion manifests | EK-0 | subagent | **DONE** | `681a82e7` | coordinator review pending | legacy: 127 tables + 572 src files (504 DELETE; purity-tested ADR-053 set) / docs: 439 entries (177/14/248), zero unclassified | family-level test split deferred to EK-8/9 |
| WP-05 | Pure kernel reducers + model explorer | EK-1, WP-16 | subagent | **DONE** | merge 7394cf92 | model 69/69 (now 71/71 with rung pins), 12 mutations killed | domain/** | —
| WP-06 | Greenfield schema + repositories | WP-05 | subagent | **DONE** | merge 5b6f5dbd | 36/36 persistence; sole-writer ratchets | persistence/** | loadContextCounters cross-boundary (owner-noted)
| WP-07 | Obligation consumer, waits, fault points | WP-06 | subagent | **DONE** | merge e4d661e0 | 32/32; crash matrix 16x identical worlds | application/** | —
| WP-08 | Development/material vertical + capsule ingress | WP-07, WP-17, WP-18 | subagent | **DONE** | merge after 047cb2f3 | development 55/55; capsule 9-digest ingress; 6 typed refusals | development/** + simple-server corpus | refused-receipt durability (EK-8 pinned); frontier shadowing (WP-09 resolved)
| WP-09 | Planning, dependency, aggregate settlement | WP-07 | subagent | **DONE** | merge after afa59c17 | planning 42/42; 7 RED kills; topology bindings | planning/** | upstream-repair lane refinement (post-EK-11 backlog)
| WP-10 | Kanban projection + command-only UI adapters | WP-08, WP-09, WP-17 | subagent | **DONE** | merge after 80c7a39e | projection 30/30; 3 mandatory mutations | projection/** | —
| WP-11D | Discovery semantic package conversion | WP-09, WP-17 | subagent | **DONE** | merge after fbc54b86 | discovery 74/74 | workshops/discovery/** | —
| WP-11F | Formalization semantic package conversion | WP-09, WP-17 | subagent | **DONE** | merge after 06cab6f1 | formalization 68/68 | workshops/formalization/** | open frontier rows (reference posture)
| WP-11L | Delivery semantic package conversion | WP-09, WP-17 | subagent | **DONE** | merge after 87d304a1 | delivery 55/55 | workshops/delivery/** | recordHumanDecision edge resolved (D12 node rung)
| WP-11V | Development semantic package finalization | WP-08, WP-09, WP-17 | subagent | **DONE** | merge after 0e8ddbbe | development 38/38 + synthetic 20/20 | workshops/development + synthetic/** | already-applied-only world run-success edge (EK-8 reconciled)
| WP-12 | Hard cutover + legacy deletion | WP-10, WP-11*, WP-16..18 | subagent + coordinator | **DONE — EK-8 COMPLETE** | merge after 674f5c25 | legacy-zero --strict 5/5; purge 1428 files; ONE composition; kernel 735/735; corpus 20/20 + kit 2/2; arch 67/67 post-cutover | entrypoint + transport + guards | agent crashed at report (context overflow) — work verified by coordinator gates |
| WP-13A | Scenario contract/model comparison/minimizer | WP-05 | subagent | **DONE** | merge 98af7971 | 47/47 engine core | engine/** | — |
| WP-13B | Actors, fault scheduler, production-size fixtures | WP-07, WP-18 | subagent | **DONE** | merge after 4fc531ae | 64/64 new suites; 16-point crash matrix identical worlds; Elite-3 436,283-byte fixture | actors/faults/fixtures/dimension-drivers | DUPLICATE_EFFECT on legal human-waited re-settle (WP-05 oracle); hydration dedupe (WP-06) |
| WP-13C | CI hosting, removal guards, mutation coverage | WP-13A, WP-13B | subagent | **DONE** | merge after 830082e9 | removal-guard 9/9 + mutation-coverage 2/2 + evidence-kit 3/3; harness 6/6 mutations killed | matrix/ci + ek-* tools | RG3c pinned findings (composition-root/engine-supervisor/claude-runner partial survival)
| WP-13D | 20-project corpus + qualification drivers | WP-08, WP-13A | subagent | **DONE** | merge after f82cb167 | corpus 33/33; --full 20/20; kit replay 2/2 | tests/project-corpus + tools/project-corpus | findings 1+2 fixed; 3 deferred (ledger) |
| WP-14 | Canonical docs rewrite + deletion patch | EK-1 | subagent | **DONE** | merge cd909744 | 8 docs + linter spec | documentation paths | post-cutover pass rides EK-13 |
| WP-15 | Immutable scripted + real qualification | EK-10, WP-16..18 | subagent + coordinator | **DONE — EK-11 + EK-12 GREEN on ONE immutable kit `123504a4`** (commit 0cfc0069) | merge after cd6ca460 | EK-11 FINAL: dev 10/10 traces identical + corpus 20/20 + concurrency Proof A 20/20 / Proof B 7/7; EK-12 real series R1/R2/R3 37/37 each (sealed 2026-08-26T14:29Z); NODE_UNDECLARED work-item:1 fixed (474995a2, 00261a0d) | tools/qualify/** + series/*.json | — |
| WP-16 | Freeze + validate the three admission specs | WP-01..04 | 3 spec agents | **DONE** — **16b DONE** (394be77d: schema+manifest b1ef94c2, 4/4 mutations killed); **16c DONE** (1258cec7, 21/21 det., 3 RED); 16a rev3 DONE (b507773a, `ek1/fix-complexity-residual-dims`: 8 census-frozen dims re-bound, budget rev3, vector v3, 8/8 synthetic reds) — coordinator freeze pending | pending | validate:ek-admission-specs + EK-ADMISSION-RECEIPT.json | package.json wiring = coordinator EK-1 exit; open findings: cumulativeAccountants/deps/3x contract.* still latent-red on kernel trees + ACD digest-insensitive (COMPLEXITY-BUDGET.md §7 items 9-10) |
| WP-17 | CanonicalRoleContract compiler + consumer port | WP-05 | subagent | **DONE** | merge 322d6dc2 | 37/37, one path, zero fallback | roles/** | —
| WP-18 | Context envelope + receipt protocol | WP-07, WP-17 | subagent | **DONE** | merge 7d0c2dd0 | 55/55; pre-send admission; D12 transport | context-envelope/** | RUNNING_COUNTER_IDENTITY pinned at EK-8
