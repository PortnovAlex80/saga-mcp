# 03 — Wave Roadmap (one-page index)

> One row per wave. Detail lives in `04-waves/WXX-*.md`. Update `Status` and
> `Checkpoint` as the integrator advances. Serial preconditions are stated in
> each wave file and in plan §0.x.

| Wave | Title | Plan § | Lanes | Status | Precondition owner | Checkpoint commit | Exit gate |
|---|---|---|---|---|---|---|---|
| **0** | Baseline & Executable Architecture Rules | 0.3, 13, 15, 16 | 8 | ✅ DONE (8/8 lanes, 146 tests) | integrator | `fd26fd1` → checkpoint | terminology, dep direction, known-debt allowlist, current failure fixtures, synthetic fixture boundaries frozen; no production behavior change |
| **1** | Pure SPI Validation & Proof | 0.4 (Phase 1) | 8 | ✅ DONE (8/8 lanes, 238 tests) | integrator (pure SPI checkpoint) | `4eb5733` → checkpoint | all manifests round-trip through canonical JSON; functions/Maps/Sets/undefined/non-enumerable/ignored conditions/unsupported retry fail installation |
| **2** | Immutable Installation & Registries | 0.5 (Phases 2,3 excl. live LM driver) | 8 | 🟡 PARTIAL (8/8 lanes, 132 lane tests pass; A8 conformance 6/8 fail — R-07) | integrator + 1 SQL owner | `2dd386c` → partial checkpoint | installed bytes replay after source mutation; released version digest immutable; pinned installation not nullifiable; 3rd module installs without catalog edit |
| **3** | Durable Execution Primitives | 0.6 (Phase 4) | 8 | ⬜ | integrator | — | crash after worker completion resumes from exact receipt+product; no latest-execution/process-scope/task-metadata/magic-binding reconstruction |
| **4** | Protocol & Universal Recovery | 0.7 (Phase 5) | 8 | ⬜ | integrator | — | exact protocol resume works; required evidence cannot be skipped; one recovery engine repairs two unrelated modules without Runtime semantics |
| **5** | Workspace, Tracker, Call Instances, Agent Assistance | 0.8 (Phase 6) | 8 | ⬜ | integrator | — | tracker+assistance regenerate from durable state; failed drafts stay repairable; successful drafts seal; weak model gets exact bounded guidance from pinned resources |
| **6** | MCP Contributions, Guards, Structured Errors | 0.9 (Phase 7) | 8 | ⬜ | integrator (one gateway owner) | — | synthetic module contributes tool/template/checklist/guard/repair hint without gateway source changes; structured errors survive transport |
| **7** | Lifecycle Scenario Package & Runtime | 0.10 (Phase 8) | 8 | ⬜ | integrator (one lifecycle owner) | — | scenario reorders+reuses modules, pins complete lock at start, survives upgrades, stores each public output once, no hidden executable routing |
| **8** | Formalization Vertical-Slice Pilot | 0.11 (Phase 9) | 8 | ⬜ | W8-A1 (manifest) | — | Formalization runs through pinned package resources + standard interfaces; no fallback context, global lookup, or direct infra dependency |
| **9** | Remaining Production Module Migrations | 0.12 (Phases 10,11) | 8 | ⬜ | per-module manifest owner | — | Discovery, Development, Delivery independently pass same conformance kit as Formalization |
| **10** | Arbitrary Extensibility Proof & Authoring Kits | 0.13 (Phase 12) | 8 | ⬜ | integrator | — | Marketing, SEO/Analytics, Director Approval, Campaign install+execute without Runtime/runner/gateway/catalog/existing-module change |
| **11** | Product Scenario Cutover Preparation | 0.14 (Phase 13 prep) | 8 | ⬜ | integrator (one cutover commit) | — | all new Product Delivery + Campaign runs use installed scenarios; old pinned runs still replay via explicit adapters |
| **12** | End-to-End & Fault-Injection Hardening | 0.15 (Phase 14) | 8 (test-only) | ⬜ | integrator | — | both scenarios complete repeatedly across injected failures; no manual DB/metadata/tracker/workspace/artifact repair |
| **13** | Final Legacy Removal | 0.16 (Phase 13 final + 15) | 8 | ⬜ | integrator (cherry-pick per cleanup) | — | no new-core architecture exceptions, hidden fallbacks, global module resources, hard-coded module composition, or unsupported legacy path remain |

## Wave ordering rules (plan §0.2)

- **Safe in parallel after contracts frozen:** new adapters behind separate ports, separate repositories, isolated validators, package resources, module-local protocols, independent fixtures, architecture tests, conformance tests, docs.
- **Conditionally parallel:** persistence + application services, Runtime services + their tests, module manifest + module subtrees — need frozen interfaces, disjoint paths, one integration owner.
- **Serial by design:** public SPI shape, canonical identity rules, package digest rules, migration ordering, edits to core executor hot files, lifecycle orchestrator adoption, MCP gateway adoption, composition cutover, final legacy deletion.
- **Single-writer hot files (per plan §0.2.4):** `process-module.ts`, `generic-flow-executor.ts`, `lm-node-executor.ts`, `lifecycle-orchestrator.ts`, `lifecycle-router.ts`, `lifecycle-mapper.ts`, `tracker-view/claude-runner.mjs`, `src/index.ts`, `composition-root.ts` (= `product-lifecycle-runtime.ts` here), `orchestrate-cli.ts`, shared SQLite migration files.

## Critical path dependencies (plan §0.2.5–0.2.10)

1. Protocol persistence (Wave 4) **must exist before** tracker and hook conversion (Wave 5).
2. CallInstance identity (Wave 5) **must exist before** MCP error-to-draft correlation (Wave 6).
3. Immutable package resolution + AgentLaunchSpec (Waves 2, 3) **must exist before** moving production skills and templates (Waves 8, 9).
4. Explicit ModuleCompletion + exact products (Wave 3) **must exist before** new Lifecycle Scenario Runtime (Wave 7).
5. Formalization (Wave 8) **must pass full vertical-slice gate** before remaining production modules migrate in parallel (Wave 9).
6. All production modules **must pass same conformance kit** before Product Delivery cutover (Wave 11).
