# REVERSE_GRAPH — Independent Reverse Proof Map for terminal `released`

- **Schema:** `factory.execution-map.reverse.v1` (machine graph: `reverse-graph.v1.json`)
- **Source commit:** `586871adfeae77da0ca8af96232ef96d6b0ee7e4` (branch `map/reverse-2026-08-23`)
- **Method:** strictly backward from a single starting claim. No forward walk, no
  start-from-idea derivation, no comparison with any other map. Production code is
  the only authority; the four mandatory conveyor docs were read as required
  context (`CONVEYOR-MENTAL-MODEL.md`, `CONVEYOR-TRANSITION-DIAGNOSTICS.md`,
  `CONVEYOR-TRANSITION-CHECKLIST.md`, ADR-053).

## Starting claim

> A product-delivery lifecycle has truthfully persisted/emitted terminal success
> `released`.

The word *truthfully* is load-bearing: the map below only includes producers,
validators, receipts and bindings that the production code actually enforces on
the path to `released`. Anything the code blocks (drift, untrusted providers,
pending approvals, missing receipts, unmatched observations) is excluded from the
prerequisite spine by construction.

## Layer 0 — where `released` becomes a durable fact

| Fact | Authority | Producer (exact) |
|---|---|---|
| `factory_lifecycle_runs.terminal_status = 'released'` (status `completed`) | declarative `outcomeRoutes` of the `delivery-release` stage | `SqliteLifecycleRunRepository.completeStage` lease-CAS update (`sqlite-lifecycle-run-repository.ts:1073-1138`) |
| `run.terminal` journal event with `terminal_status`/`product_outcome` channels | durable `claimRunTerminalEvent` exactly-once gate | `LifecycleOrchestrationEngineAdapter` (`lifecycle-orchestration-engine-adapter.ts:137-162`) |
| Launch settlement carries the verdict verbatim; exit 0 ≠ product success | lifecycle terminal record only — engine has no success classifier | `orchestrate-cli.ts:740-774` |

Reverse predecessors of the terminal stamp (all enforced in one transaction):

1. `routeProcessOutcome` found `outcomeRoutes['released'] = {terminal, 'released'}`
   (`lifecycle-router.ts:23-32`; table at `product-delivery-lifecycle.ts:479-484`);
2. the ADR-053 fenced transition obligation was `in_progress`
   (`lifecycle-orchestrator.ts:387-400`);
3. the Delivery ProcessRun had settled with `localOutcome='released'`,
   `authority='delivery_settlement_policy'`, write-once
   (`generic-flow-executor.ts:325-408`; `process-run.ts:144-183`).

## Layer 1 — Delivery module spine (walked backward from `complete-released`)

```text
complete-released (process-outcome-emitter, outcome 'released')
  <- settle-delivery kernel (decision 'released' + ReleaseRecord + certificate)
     <- DeliverySettlementInput { case, preflight, approval, publication,
                                  observation, productReferences, currentCandidateHash }
        <- observation: every required action 'matched' at desiredStateHash,
           currentCandidateHash === certified candidate, complete
        <- publication: every required action receipt w/ exact actionKey,
           trusted authoritative_state provider
        <- approval: approved (trusted authorized_decision) | not-required
        <- preflight: 'ready', all required checks, trusted providers
        <- DeliveryReleaseCase v2 (authorized mode, grant bound to policy hash)
```

Key enforcement points (each is a claim + dependency in the JSON):

- **Settlement decision** — `ReferenceDeliverySettlementPolicy.settle` returns
  `'released'` **only** at the end of the full branch chain
  (`delivery-settlement-policy.ts:430-986`); every gap returns a typed
  `blocked` / `failed` / `approval-required`.
- **ReleaseRecord** — built from the four validated durable references plus
  lineage (`:943-978`), persisted write-once and re-read exactly by the output
  resolver (`delivery-installation.ts:549-593`, `:95-123`, `:979-1022`). A
  `released` decision without a record throws; a non-released decision must not
  expose one.
- **Certificate** — issued in the kernel (`authority: delivery_settlement_policy`)
  and surfaced through the mandatory `ModuleCompletion.certificateRef`
  (`delivery-installation.ts:464-547`; `generic-flow-executor.ts:336-381`).
- **Flow walk** — `factory.delivery.standard` transitions under a ProcessRun
  lease with durable NodeRun crash-resume, crash-window accounting and a seeded
  step budget (`delivery-process-module.ts:65-207`;
  `generic-flow-executor.ts:286-323`, `:603-679`, `:958-972`).
- **Action identity** — `deliveryActionKey` is cross-run stable and
  ProcessRun-free (`delivery-settlement-policy.ts:124-144`); the effect ledger +
  observe-before-execute make each external change effectively-once
  (`sqlite-delivery-runtime.ts:455-608`, esp. `:533-570`).
- **Human approval** — the immutable approval inbox
  (`sqlite-delivery-approval-inbox.ts`) fed by the `delivery_approval_decide`
  MCP tool (`tools/delivery-approvals.ts:58-78`); pending pauses the run
  truthfully (`delivery-installation.ts:218-264`).
- **Provider trust** — active `trusted_providers` rows matched on
  id+name+category+version; unmatched ⇒ untrusted ⇒ blocked
  (`sqlite-delivery-runtime.ts:687-718`).

## Layer 2 — composition boundary (who may truthfully release)

- The **default** composition (`SAGA_PRODUCT_LIFECYCLE_COMPOSITION` →
  `tracker-view/product-delivery-composition.mjs`, `local-dry-run`) **fails
  closed**: `publishAndDeploy` throws `delivery-provider-not-configured`; the
  port's return type admits only success shapes, so it can **never** produce
  `released`.
- The only in-repo production composition capable of `released` is
  `tracker-view/product-delivery-local-release-composition.mjs` →
  `createLocalGitReleaseProviders` (`local-git-tag-delivery-provider.ts`):
  a `source-tag` effect executed as a compare-and-set `git update-ref` against
  the zero OID (no force), observed before retry, with a `candidate-integrity`
  preflight and `observeCurrentCandidateHash` drift watch.
- `registerDelivery` fail-closes on any missing port — no fallback provider may
  perform release effects (`modules/delivery/index.ts:95-169`;
  `composition-root.ts:281-308`).

## Layer 3 — where the authorized delivery input comes from

Two lawful producers (both in the graph):

1. **Caller-supplied launch input** — an authorized `delivery` block validated by
   `assertProductDeliveryLifecycleInput` at `resolveInput`
   (`product-delivery-lifecycle.ts:128-260`;
   `product-lifecycle-runtime.ts:1011-1080`). Note `start-from-idea` **always**
   assembles `deferred` (`start-product-lifecycle-from-idea.ts:260-313`) and can
   therefore never itself yield `released`.
2. **Local release continuation** — `prepareLocalReleaseContinuation`
   (`factory-release-continuation.ts:19-121`): from a truthful
   `approval-required` terminal parent it reads the exact delivery boundary
   StageRun input, mints the `saga-local-source-tag` policy and an
   `factory.delivery-operator-authorization.v1` grant scoped
   `exact(candidateHash)`, and authorizes an append-only child LifecycleRun that
   executes only the delivery suffix.

The engine is launched through a CAS-fenced single-use launch reference
(`product-lifecycle-run-starter.ts:79-184`;
`sqlite-factory-launch-repository.ts:289-322`), acknowledged only by the durable
lifecycle start receipt.

## Layer 4 — Development prerequisite (`verified`)

`released` requires a `factory.development-certificate.v1` with decision
`'verified'` plus the verified bundle refs and the integrated candidate mapped
into the DeliveryReleaseCase (`product-delivery-lifecycle.ts:443-467`;
`delivery-settlement-policy.ts:188-212`).

`'verified'` itself requires (`development-settlement-policy.ts:1000-1381`):

- a **complete implementation workset** with no blocking/incomplete items;
- a **frozen integrated candidate** whose hash, lineage
  (`taskGraphHash`, `implementationWorksetHash`), repository commit/tree
  snapshots, build products and integration intents all match the
  DevelopmentCase, with the observed hash unchanged after freeze;
- an **acceptance-verification workset** that exactly covers the required
  verification items with trusted `deterministic_evidence` providers, no
  failed/unknown/error evidence;
- **zero open human gates**; and
- a **passed local-readiness receipt** bound to the exact frozen candidate
  (`:1303-1336`; `sqlite-development-settlement-state.ts:565-575`).

**Bridge relation (not direct schema inclusion):** the settlement input is
reconstructed by `SqliteDevelopmentSettlementState.buildSettlementInput`
**from accepted sealed CandidateSets / cell products by exact refs and hashes**
(`sqlite-development-settlement-state.ts:474-545`; port contract at
`development-kernel-ports.ts:180-209`). Execution ids are provenance only; the
Kanban `tasks` projection is never settlement authority. Upstream of that bridge
stands the production-cell loop — CandidateSet seal → GateRun → typed effect
receipts → `CellFinalAcceptance`
(`production-cell-node-executor.ts:649-674`, `:1420-1503`, `:1967`, `:2156-2157`).

## Layer 5 — upstream stages to the external inputs

- `solution-formalization` outcome `formalized` routes to Development with a
  content-addressed Solution Contract (SRS, acceptance criteria, baseline hash)
  (`product-delivery-lifecycle.ts:343-416`).
- `initial-discovery` outcomes `go|clarify|reject` all forward (idea-strength is
  recorded, not a build gate); `failed` is runtime-terminal
  (`:289-342`).
- Terminal external inputs (the reverse walk's termini by design):
  `initiative.{subject,context,evidence,constraints}`, repository bindings with
  the real git HEAD (`REPOSITORY_HEAD_UNRESOLVABLE` fails closed), a hash-verified
  development policy, and the release policy + operator grant.

## Homeless claim

**HOMELESS-REAL-PUBLISH-DEPLOY-PROVIDERS** — settlement requires a trusted
`authoritative_state` receipt *and* observation for **every** required action of
the declared policy, but the repository ships exactly one production provider
kind (`source-tag`). For `source-release`, `package-publish` and `deployment`
actions there is **no in-repo producer** of the required effect/observation
evidence — the default composition documents this as a deployment-specific
override that does not exist yet. This is a **missing product obligation, not
missing test evidence** (conformance doubles exist under `tests/factory-proof/`).

## Safety / liveness / audit siblings

- **Safety** (12 entries): candidate immutability and drift; snapshot hash
  integrity; provider-trust fail-closure; observe-before-execute + effect-ledger
  idempotency; no-force/no-bypass; approval binding + immutability; grant scope
  binding; write-once terminals; dry-run can never release; module-does-not-route;
  launch CAS fence; development authority conservation.
- **Liveness** (5 entries): human approval pause→resume cycle with the
  approval-required terminal + continuation as the lawful suffix; obligation
  re-drive; exactly-once terminal journal; delivery crash-resume; leases and
  budgets.
- **Audit** (5 entries): transition ledger rows; certificate rows; separated
  `run.terminal` channels; ReleaseRecord destinations; effect-ledger trail.

## Validation of this map

- `reverse-graph.v1.json` parses as strict JSON (PowerShell
  `ConvertFrom-Json`).
- Every `claims[]`, `dependencies[]`, `homelessClaims[]`, `safetyClaims[]`,
  `livenessClaims[]`, `auditClaims[]` entry carries at least one `path:line`
  sourceRef into production code (checked programmatically; no test-only
  authorities).
- No forward-map/workshop-map document was read while producing this artifact.

## Known limits

See `uncertainties[]` in the JSON: the operator-grant minting surface for fresh
authorized launches is external by design; observation completeness trusts
`observeCurrentCandidateHash` provider discipline; Discovery/Formalization
internals were not independently expanded (only their outcome contracts are
prerequisites of `released`); a corroborating full `released` run exists as
recorded evidence in
`tests/factory-evidence/delivery/delivery_happy-released-authorized.json` (used
as existence evidence only — no live DB was inspected).
