# EK-8 deletion set — legacy Delivery / release authority paths

WP-11L deliverable (plan phase EK-8): identify the EXACT legacy files and
wiring the EK-8 atomic cutover deletes once
`src/workflow-kernel/workshops/delivery/**` becomes the production Delivery
authority. The new workshop package is reachable only from
`tests/workflow-kernel/workshops/delivery/**` until then; nothing in this
list may be deleted before the cutover (they still own the legacy
production path).

## 1. Legacy Delivery module (release/preflight/approval surface)

- `src/modules/delivery/**` — the whole legacy module:
  - `domain/delivery-schemas.ts` (replaced by the content-addressed
    verified Development bundle + the declared release policy +
    product contracts in `manifest.ts` / `bundle.ts`)
  - `domain/delivery-provider-ports.ts`, `domain/delivery-kernel-ports.ts`
    (provider port indirection replaced by the declared deterministic
    check providers + the declared authorized-decision provider set;
    no trusted_providers table read)
  - `domain/delivery-settlement-policy.ts` (replaced by the preflight
    semantic gates + the typed effect-outcome settlement:
    success / already-applied / policy-terminal; D2)
  - `application/delivery-installation.ts` (module installation replaced
    by the installed workshop manifest DATA + the WP-07 obligation driver)
  - `infrastructure/sqlite-delivery-approval-inbox.ts` (the legacy approval
    bridge: replaced by TypedWait:human-input + the D12 operator
    disposition command path + the immutable decision evidence in
    `approval.ts`; the pause semantics are preserved, the inbox tables are
    not — the wait row, the wake discharge and the command evidence are the
    durable facts)
  - `infrastructure/sqlite-delivery-runtime.ts`,
    `infrastructure/delivery-persistence.ts` (the private Delivery state
    tables: `factory_delivery_approval_requests`,
    `factory_delivery_approval_decisions` and the delivery run state are
    deleted — no workshop owns a private scheduler/state table)
- `src/process-modules/lifecycles/product-delivery-lifecycle.ts` and the
  delivery lifecycle contracts it owns
  (`DELIVERY_RELEASE_CASE_SCHEMA`, `DELIVERY_DEFERRED_PROFILE_SCHEMA`,
  `PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA`) — flow ownership moves to
  lifecycleRun.routeOutcome(stageRoute delivery-release) +
  obligation:enterStage.delivery-release; the release case becomes the
  verified Development bundle ingress
- `src/process-modules/modules/delivery/**` — the legacy Delivery process
  modules and their package wiring (R17: module flows are installed
  process-module manifest content; the typed protocol edge is
  obligation:advanceProcessFlow)

## 2. Legacy release-effect / provider wiring

- `trusted_providers` reads of category `authorized_decision` /
  `deterministic_evidence` / `authoritative_state` from the delivery path
  (replaced by the declared provider sets in the installed manifest; a
  foreign/anonymous identity is refused typed, never resolved from a table)
- External deployment action kinds (`source-tag`, `source-release`,
  `package-publish`, `deployment` targets) — the new workshop qualifies
  LOCAL packaging only (`externalDeployment: false`, `credentials: none`);
  any policy declaring otherwise is refused typed at preflight
  (POLICY_NOT_LOCAL)
- Legacy delivery-effect guards that re-checked mutable board/run state at
  publication time (replaced by the immutable candidate/preflight/policy
  triple bound at the approval request, D12)

## NOT deleted (preserved set)

- `src/workflow-kernel/development/**` — the Development vertical this
  package imports for the ONE role-contract runtime, the scripted actor
  port and the durable admission store (shared kernel facilities, not
  Delivery-owned)
- `src/workflow-kernel/planning/bindings.ts` — the WP-09 topology bindings
  this package reuses for its cross-aggregate edges
- `tests/workflow-kernel/development/fixtures/simple-server/**` — the
  canonical product fixture whose packaging input the local release
  package assembles (shared corpus fixture)
- The opencode cognition transport (`tools/agent-proxy/claude-shim.mjs`)
  — rebound behind CognitionTransportContract at EK-8, not deleted by
  this workshop's cutover
