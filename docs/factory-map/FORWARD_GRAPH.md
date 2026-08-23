# FORWARD_GRAPH — Independent Forward Production Map (saga-mcp)

- **Map type:** FORWARD-ONLY. Derived exclusively by walking production code in
  execution direction from real entrypoints and configuration selection. No
  reverse graph, terminal-prerequisite graph, or reverse-map output was
  constructed or read.
- **Machine graph:** [`forward-graph.v1.json`](./forward-graph.v1.json)
  (`factory.execution-map.forward.v1`).
- **Source commit:** `586871adfeae77da0ca8af96232ef96d6b0ee7e4`
- **Authority rule:** production code is authoritative; the four mandatory
  factory docs (CONVEYOR-MENTAL-MODEL, CONVEYOR-TRANSITION-DIAGNOSTICS,
  CONVEYOR-TRANSITION-CHECKLIST, ADR-053) were read fully and treated as
  hypotheses to check against code, never as map edges.
- **Scope guard:** production reachability only. Test/evidence-status coverage
  is out of scope here and owned by a separate map.

---

## 1. Entrypoints and entry selection (where execution starts)

| Entrypoint | Operator surface | What it does (forward) | Evidence |
|---|---|---|---|
| `POST /api/factory/start` | tracker panel | new project from `idea_url`, or `new_start` for an existing project; provisions project/repo/epic + git bootstrap; assembles deferred delivery input; persists launch ticket; spawns engine host | `tracker-view/tracker-view.mjs:343`, `tracker-view/admin-endpoints.mjs:590`, `tracker-view/admin-endpoints.mjs:735` |
| Engine resume | panel `/api/factory/start` on an epic with a resumable run | finds the single resumable `LifecycleRun`, creates a `mode:'resume'` launch, spawns `orchestrate-cli --launch-ref` | `src/infrastructure/engine/engine-administration.ts:103`, `:515` |
| `scripts/factory.mjs <cmd>` | operator CLI | `start \| resume \| continue \| redevelop \| stop \| unpark \| abandon \| rerun`; `continue` drives release/development continuations | `scripts/factory.mjs:91`, `:235`, `:284`, `:291`, `:561` |
| Engine watchdog | panel supervisor | heartbeat-age freeze detection → durable `freeze_detected`/`restart_attempted` → soft-stop + resume restart; budget exhaustion → `failed_watchdog` | `tracker-view/engine-supervisor.mjs:208`, `:213`, `:232` |
| `orchestrate-cli.ts` | engine host (spawned) | claims the launch controller fence, runs boot revision (adoption/burial), starts worker supervision, then cycles `runEpisode` ↔ dispatch until terminal/paused | `src/orchestrate-cli.ts:132`, `:280`, `:299`, `:334` |
| MCP server (`dist/index.js`) | worker protocol surface | tools consumed by spawned workers during a cell attempt (`task_get`, `product_read/submit`, `candidate_read`, `worker_done`, …) | `src/index.ts:91`, `:168`, `:195` |

A start-from-idea **never** carries release authority: the assembler records
`delivery.mode='deferred'` with a content-addressed deferred profile
(`src/app/start-product-lifecycle-from-idea.ts:301`). Therefore an idea start
that reaches Delivery can only settle `approval-required` there — it cannot
reach `released` in the same run. `released` requires a later authorized input
(continuation, §5).

## 2. Composition/configuration condition selecting the lifecycle

Two lifecycles are installed side by side and a **single selection seam**
decides which one a run drives:

```text
runEpisode(command)
  → LifecycleOrchestrationEngineAdapter.run            (adapter)
     → resolveDefinition(command, input)               (selection seam)
        1. pinned row: factory_lifecycle_runs.definition_snapshot
           matched by (project_id, idempotency_key)     [per-invocation truth]
        2. else options.lifecycleDefinition             [composition override]
        3. else productBuildLifecycle                    [production default]
```

- `product-build` (`…/product-build-lifecycle.ts:21`): 3 stages; the
  `solution-development` `verified` outcome is rerouted to terminal
  **`runnable-local`** and the `delivery-release` stage is filtered out
  (`:31`, `:38`).
- `product-delivery` (`…/product-delivery-lifecycle.ts:279`): 4 stages
  including `delivery-release`; `verified` forwards to `delivery-release`
  (`:429`).
- In production `src/`, nothing passes `lifecycleDefinition`:
  `composition-root.ts:299` constructs the runtime without it, so the default
  base is `product-build` (`product-lifecycle-runtime.ts:991`, `:1008`).
  Hosts that pass `productDeliveryLifecycle` exist today only in the
  factory-proof drivers (`tests/factory-proof/delivery-scenario-drive.mjs:200`).
  See uncertainty u1 in the JSON.

A second, **independent** condition shapes the Delivery stage once it is
reachable — the lifecycle input's `delivery` member:

| `delivery.mode` | Assembled by | Delivery-stage forward behavior |
|---|---|---|
| `deferred` (+ hashed profile) | start-from-idea (`start-product-lifecycle-from-idea.ts:301`); operator-deferred | preflight/settlement path may run, but settlement deterministically returns `approval-required` (`delivery-settlement-policy.ts:450-465`) |
| `authorized` (+ policy + operatorAuthorization) | release continuation override (`factory-release-continuation.ts:86-109`) | preflight → human approval → publish/deploy → observe → settle may reach `released` |

The installed composition module (`SAGA_PRODUCT_LIFECYCLE_COMPOSITION`,
mandatory — `orchestrate-cli.ts:841-848`) selects the Delivery **providers**:
`tracker-view/product-delivery-composition.mjs` (local-dry-run: publication
throws `delivery-provider-not-configured`, fail-closed) or
`tracker-view/product-delivery-local-release-composition.mjs` (real local git
source-tag provider). This is provider selection, not lifecycle selection.

## 3. Forward stage graph (both lifecycles)

Stage-level routing is the declarative `outcomeRoutes` table; every stage binds
one installed process module (`product-delivery-module-contracts.ts:30-48`).

```text
                     ┌────────────────────────────────────────────────┐
                     │ product-build (default)                        │
                     │                                                │
 initial-discovery ──┼─ go|clarify|reject → solution-formalization    │
   (product-discovery@3.0.2)                                          │
   failed ────────────────→ terminal failed                           │
 solution-formalization ─┼─ formalized → solution-development          │
   (solution-formalization@1.0.0)                                     │
   inconsistent ──────────→ terminal formalization-inconsistent       │
   failed ────────────────→ terminal failed                           │
 solution-development ────┼─ verified → terminal runnable-local  ◄─────┘
   (solution-development@1.4.4)          (product-build only)
   blocked → terminal development-blocked
   failed   → terminal failed
 ── product-delivery only: verified → delivery-release ──
 delivery-release (delivery-release@1.0.0)
   released          → terminal released
   approval-required → terminal approval-required   (deferred mode lands here)
   blocked           → terminal delivery-blocked
   failed            → terminal failed
```

- Discovery outcome routing is deliberately permissive: `go`, `clarify` AND
  `reject` all forward to Formalization (idea strength is recorded, not gated);
  only runtime `failed` terminates (`product-delivery-lifecycle.ts:326-338`).
- Terminal statuses are stamped on the run by the repository on every terminal
  path; exit code 0 means "engine reached a terminal", never product success
  (`launch-terminal-settlement.ts:52`, `:85`).

### Intra-module flows (map resolution: node list in the JSON)

| Module | Production cells (worker desks) | Kernel nodes | Local outcomes |
|---|---|---|---|
| Discovery | `produce-proposal`, `assess-readiness` | `settle` | go / clarify / reject / failed |
| Formalization | `define-product-contract`, `model-use-cases`, `define-acceptance-contract`, `reconcile-what`, `define-architecture-contract` (all reviewed cells) | `freeze-acceptance-baseline`, `settle-formalization` | formalized / inconsistent / failed |
| Development | `plan-task-graph` (singleton), `implement-work-items` (fan-out N), `certify-product-readiness`, `verify-acceptance` (fan-out N) | `resolve-task-graph`, `freeze-integrated-candidate`, `bind-runnable-candidate`, `settle-development` | verified / blocked / failed |
| Delivery | — (no production cell) | `preflight-release` (kernel), `approve-release` (**human node**), `publish-deploy` (kernel effect), `observe-release` (kernel observation), `settle-delivery` | released / approval-required / blocked / failed |

Per-node/per-edge path:line references are in the JSON (`nodes[]`,
`edges[] e09–e53`).

## 4. Universal Production-Cell loop (shared runtime, walked forward)

Every `production-cell` node (and the legacy `lm` kind alias,
`product-lifecycle-runtime.ts:821`) enters the same forward loop
(`production-cell-node-executor.ts`):

```text
materialize Workplace(s)                 :477,588
  → idle: dependency gate → admitWork    :696-714
  → queued: role task projection; runEpisode returns paused(worker_active) :934,984
      → engine dispatch drain (assignTask CAS + spawn worker process)      dispatch-loop.ts:292-347
      → worker executes (MCP protocol; opencode shim backend, claude CLI fail-closed)
                                                           claude-runner.mjs:865-875
  → verifying: read frozen contribution products → seal CandidateSet       :1027,1042
      → RunGate obligation (durable handoff)                               :1066
      → author gate (check plan → GateDecision)                            :1137
          | accepted + review declared → reviewer desk (pinned exact author set) :1034,1184
          | accepted, no review → authority commit (isFinal)               :1151
          | repair_required → repair_wait                                   :1176
          | human_required → paused(human) park                             :785,2577
      → reviewer seals verdict set → final gate                             :1188
          | accepted + effect declared → effect_pending                     :1199-1213
          | accepted, no effect → CellFinalAcceptance                       :1254
  → effect_pending: settle acceptance effect                               :1270
      | git-integration (development implementation)                       :1326; git-integration-effect.ts:57
      | formalization-accept-products (formalization cells)                formalization-process-module.ts:119
      | replay-capture (certification; also lazy sweep at exit)            product-lifecycle-runtime.ts:374
      | outcome repair_required → immutable effect-repair RecoveryIssue    :1393
      | outcome human_required / attempt stasis → human park               :1371,1407
      | receipt recorded → CellFinalAcceptance → replay capture            :1420,1445
  → repair_wait (ADR-075 recovery):                                        :718
      | below epoch budget → requeue                                       :929
      | epoch exhausted (onExhausted=requeue) → rollover + backoff          :790,887
      | total cap / diagnosis-repeat / convergence-ceiling → terminal failed :804,856,828
      | scope insufficiency → scope-widening carve (grant→re-staff, refuse→failed) :741,752,766
  → human park → runEpisode paused(human_required) → engine stops paused    :545; orchestrate-cli.ts:559
```

Cross-machine durability: sealing, gate acceptance, effect settlement, final
acceptance and lifecycle routing each write a transition obligation re-driven
by the fenced reconciler inside every `runEpisode`
(`product-lifecycle-runtime.ts:1088`, `:1245`). The engine's outer loop adds
worker supervision (orphan reap → requeue), on-demand supervision on empty
dispatch, the ADR-087 terminal drain, and the replay certification sweep before
launch settlement (`orchestrate-cli.ts:299`, `:511`, `:633`, `:704`, `:758`).

## 5. Human, pause, retry, repair and effect routes (explicit)

| Route | Trigger (forward) | Next | Evidence |
|---|---|---|---|
| Human pause (park) | gate `human_required`, runnability `warrant-blocked-environment`, effect `human_required`/stasis, budget `onExhausted:'pause'` | engine exits paused(2); explicit resume required | `production-cell-node-executor.ts:545`, `:783`, `:1407`; `orchestrate-cli.ts:563` |
| Repair loop | any `repair_required` verdict (author or reviewer target role) | same Workplace re-staffed with exact RecoveryIssue feedback | `:1176`, `:929` |
| Recovery epochs | epoch budget exhaustion with `onExhausted:'requeue'` | rollover row + exponential backoff (1–15 min), total-attempt cap → honest terminal failed | `:790-916` |
| Convergence waiver | strict-subset finding-key trajectory (work, not spin) | requeue without burning epoch budget | `:818-915` |
| Scope widening | same path-outside-authority key twice | granted → widened frozen scope, same workplace; refused (contention) → terminal failed | `:741-770` |
| Git integration effect | implementation cell final acceptance | fenced merge/receipt; conflict → typed effect-repair issue; blocked observation → human | `git-integration-effect.ts:36-161` |
| Replay capture | terminal(accepted) | capsule certified for cross-run reuse; crash fallback sweep at engine exit | `product-lifecycle-runtime.ts:374`; `orchestrate-cli.ts:704` |
| Approval pause (Delivery) | `approve-release` with `decided.status='pending'` | run paused; settles via `approval-required` route | `delivery-installation.ts:218-234` |
| Release continuation | operator `continue` after `approval-required` terminal | child LifecycleRun re-enters only `delivery-release` with authorized policy + operator grant (local git tag) | `factory-release-continuation.ts:19-121` |
| Development continuation / redevelopment | operator `continue` / `redevelop` after blocked/failed | accepted-prefix child run / new FactoryOrder in the same project | `factory-continuation.ts:47`; `factory-redevelopment.ts:121` |

## 6. Terminals (complete list at map resolution)

Lifecycle business terminals: `runnable-local` (build only), `released`,
`approval-required`, `delivery-blocked` (delivery only), `development-blocked`,
`formalization-inconsistent`, `failed` (all stages; incl. transition-budget
overrun, `lifecycle-orchestrator.ts:254`). Workplace-level:
`terminal(accepted)` (CellFinalAcceptance), `terminal(failed)` (budget/cap/
scope-refusal/final-verdict), `paused(human_required)`. Launch/engine level:
exit 0 (operational terminal, any verdict), exit 1 (failed / terminal-drain
failure), exit 2 (paused), `failed_watchdog` (supervisor budget exhausted).
Full definitions with refs: JSON `terminals[]`.

## 7. Dead / declarative-only strata (excluded from the forward graph)

1. Root `product-lifecycle-composition.mjs` — test composition whose Delivery
   ports throw `PRODUCT_LIFECYCLE_TEST_*_NOT_REACHED`; superseded by the
   tracker-view compositions.
2. `src/factory-e2e/fresh-harness.ts` — E2E test harness.
3. `product-delivery-scenario-package.ts` permissive/strict variants —
   conformance-proof scenario packages, not production selection.
4. Discovery `normalizer` / `diagnosis-advisor` skills — declared package
   resources with **no flow node** in the standard discovery flow (exactly two
   cells exist); `factory.discovery-diagnosis.v1` has no standard producer.
5. Root diagnostic scripts/inputs (`run-hex-lifecycle-diagnostic.mjs`,
   `*-lifecycle-input.json`).
6. `src/tools/process-modules.ts:141` — MCP inspection registry of
   `productDeliveryLifecycle`; display/validation only.

## 8. Validation performed on this map

- JSON parses (`node -e JSON.parse`) and every `nodes[]`/`edges[]` entry has a
  non-empty `sourceRefs` array (scripted check, both files committed together).
- Every `edges[].from`/`to` resolves to a declared node id or terminal id
  (scripted check).
- Spot re-verification of cited line numbers for the selection seam, all four
  module flows, the workplace loop branches, and the terminal settlement chain.

## 9. Unresolved contradictions

Recorded verbatim in the JSON `uncertainties[]`; the two most consequential:

- **u1** — doc-comment vs code: the runtime comment claims the panel's
  product-delivery composition passes the product-delivery lifecycle; the panel
  file does not export `lifecycleDefinition`. Production default is
  product-build; only factory-proof drivers pass product-delivery today.
- **u2** — consequently the `approval-required → release continuation` arc is
  reachable only for runs pinned to a delivery-containing definition; a
  product-build run ends at `runnable-local` and release is a separate request
  (as the mental model's appendix prescribes, but the selection seam makes it
  an environment decision, not a code invariant).
