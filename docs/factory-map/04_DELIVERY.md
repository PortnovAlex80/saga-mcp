# 04 — Delivery (factory map, Development + Delivery series)

Hypothesis status: this document maps what the repository declares and
executes today, written from code read on branch
`map/development-delivery-2026-08-23`. Docs are hypotheses; code and CI are
evidence. Every claim carries a `path:line` citation. Evidence claims below
keep five statuses strictly distinct:

- **declared** — present in a descriptor/ADR/comment as intent;
- **filed** — an artifact (test/provider/effect) exists in the tree;
- **demonstrated** — a suite executes the behavior (green or red, named);
- **matrix** — the suite is hosted by a blocking acceptance-matrix group;
- **CI** — the group is invoked by `.github/workflows/ci.yml`.

---

## PURPOSE

Delivery is the fourth and final stage of the `product-delivery` lifecycle and
"the only standard process module authorized to create externally-visible
release state. It consumes one verified Development candidate, performs
deterministic preflight, obtains the policy-required human decision, applies
desired-state actions and then observes every required destination before
settlement." (`src/process-modules/modules/delivery/delivery-process-module.ts:22-28`).

Declared identity: `delivery-release` v1.0.0
(`src/process-modules/lifecycles/product-delivery-module-contracts.ts:45-48`),
kind `delivery`, display name "Delivery and Release"
(`src/process-modules/modules/delivery/delivery-process-module.ts:29-36`).

**Delivery declares zero LLM profiles.** Its descriptor ends with
`executionProfiles: []`
(`src/process-modules/modules/delivery/delivery-process-module.ts:325`). No
worker is hired anywhere in the flow: publish/deploy is "Deterministic
external-system calls (git push, deploy), not worker hiring"
(`src/process-modules/modules/delivery/delivery-process-module.ts:95`) and
observation is "Deterministic external-system observation, not worker hiring"
(`src/process-modules/modules/delivery/delivery-process-module.ts:105`). Every
capability is an injected provider port: "No provider is selected here.
Composition must inject every preflight, human-approval, publication/deployment
and observation implementation."
(`src/modules/delivery/domain/delivery-kernel-ports.ts:1-6`). The
registration constructor fail-closes on any missing port
(`PRODUCT_LIFECYCLE_COMPOSITION_INCOMPLETE: delivery.<port>`,
`src/modules/delivery/index.ts:95-105`).

---

## ENTRY CONTRACT

- Stage `delivery-release` maps: runtime `projectId`/`epicId`/`initiatedBy`;
  the Development certificate with literal `decision: 'verified'`; the
  verified-integration-bundle schema/ref/hash; `integratedCandidate` from the
  bundle payload; and the delivery envelope `$.delivery.mode`, `$.delivery.policy`,
  `$.delivery.operatorAuthorization`, `$.delivery.deferredProfile`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:439-467`).
- Route in: Development outcome `verified` routes to `delivery-release`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:429`).
- Entry conditions (declared): "Development outcome is verified" and "Release
  authorization is explicit, or Delivery terminates as approval-required"
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:485-488`).
- The case is one of two variants
  (`src/modules/delivery/domain/delivery-schemas.ts:81-128`):
  - **authorized** — `deliveryMode: 'authorized'`, immutable
    `DeliveryReleasePolicySnapshot` (id/version/contentHash/channel/
    releaseVersion/releaseTag/`humanApprovalRequired`/`requiredPreflightCheckIds`/
    `actions`, `src/modules/delivery/domain/delivery-schemas.ts:62-72`) plus an
    explicit `operatorAuthorization` grant binding `requestedBy`,
    `releasePolicyHash` and a candidate scope of `exact` (one known hash) or
    `lifecycle-output` (the exact candidate handed off by the preceding stage —
    "A complete Lifecycle cannot name the candidate hash before Development
    produces it", `src/modules/delivery/domain/delivery-schemas.ts:93-117`);
  - **deferred** — `deliveryMode: 'deferred'`, no policy, no authorization, a
    `DeliveryDeferredProfile` with reason `authorization-required` and source
    `start-from-idea` or `operator-deferred`
    (`src/modules/delivery/domain/delivery-schemas.ts:74-79,119-124`).
- Release actions are limited to four kinds: `source-tag`, `source-release`,
  `package-publish`, `deployment`
  (`src/modules/delivery/domain/delivery-schemas.ts:47-60`).
- Flow entry node: `preflight-release`
  (`src/process-modules/modules/delivery/delivery-process-module.ts:68`).

---

## PRODUCTION NODE CARDS

Delivery has no production cells (no desks, no CandidateSets, no gates in the
Production-Cell sense). Its nodes are kernel/human/effect/observation
machines; "Control and effect nodes may omit the worker/quality loop, but they
use the same NodeRun cursor, typed outcome, idempotency and transition
journal" (`docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md:27-30`).

### 1. `preflight-release` — kernel

- **id/kind:** kernel, handler `delivery-preflight-policy`
  (`src/modules/delivery/domain/delivery-kernel-ports.ts:29-34`;
  node `src/process-modules/modules/delivery/delivery-process-module.ts:70-79`).
- **Roles:** none (deterministic guard evaluation).
- **Input authority/cardinality:** the exact certified candidate and immutable
  release policy ("Evaluate deterministic release guards for the exact
  certified candidate and immutable release policy",
  `src/process-modules/modules/delivery/delivery-process-module.ts:73-75`).
  Deferred mode short-circuits: the handler returns an
  `authorization-required` preflight manifest and event `blocked`
  (`src/modules/delivery/application/delivery-installation.ts:149-153,724-745`).
- **Tools/protocol:** `DeliveryPreflightStatePort.buildPreflightSnapshot`
  (heartbeat-aware) + `DeliveryPreflightPolicyPort.evaluate`
  (`src/modules/delivery/domain/delivery-kernel-ports.ts:40-49`;
  handler `src/modules/delivery/application/delivery-installation.ts:145-195`).
  The SQLite runtime resolves each declared check through the injected
  `DeliveryPreflightCheckProvider` and a trusted-provider binding
  (`src/modules/delivery/infrastructure/sqlite-delivery-runtime.ts:112-184`,
  provider port `src/modules/delivery/domain/delivery-provider-ports.ts:21-29`).
- **Output authority/schema:** `delivery-preflight`
  (`DELIVERY_PREFLIGHT_SCHEMA`), authority `kernel`, content-addressed by
  `preflightHash` over candidateHash + developmentCertificateHash +
  releasePolicyHash + checks + complete
  (`src/modules/delivery/domain/delivery-schemas.ts:140-148`;
  artifact row `src/process-modules/modules/delivery/delivery-process-module.ts:217-222`).
  A store-side hash/schema mismatch throws and becomes a typed failed
  preflight manifest (`src/modules/delivery/application/delivery-installation.ts:159-170,191-193,747-768`).
- **Gates:** the preflight policy itself (`ReferenceDeliveryPreflightPolicy`,
  `src/modules/delivery/domain/delivery-settlement-policy.ts:268-270`); policy
  `delivery-preflight` v1.0.0 "Requires complete trusted checks for the exact
  certified candidate before human approval"
  (`src/process-modules/modules/delivery/delivery-process-module.ts:259-266`).
- **Repair/retry:** none at node level — outcomes are the typed transitions
  `ready` → approve, `blocked`/`failed` → settle
  (`src/process-modules/modules/delivery/delivery-process-module.ts:130-144`).
- **State/effects:** none external (read-only guards).
- **Forward consumers:** `approve-release` (input schema
  `DELIVERY_PREFLIGHT_SCHEMA`), publication/observation/settlement re-reads.
- **Backward obligations:** invariant `delivery.explicit-operator-authorization`
  and `delivery.candidate-is-immutable`
  (`src/process-modules/modules/delivery/delivery-process-module.ts:275-281,313-317`).
- **Scripted outside participant:** preflight check providers are injected
  doubles in tests; production providers come from the composition root.
- **Tests/CI:** `tests/process-modules/product-delivery-lifecycle-e2e.test.mjs`,
  `product-lifecycle-policies.test.mjs` (glob-hosted in the `process-modules`
  CI group, `tools/run-acceptance-matrix.mjs:83-116`); status:
  declared + demonstrated + matrix + CI.
- **Uncovered:** no CI suite drives a *corrupt* preflight store (the
  hash-mismatch throw path at
  `src/modules/delivery/application/delivery-installation.ts:166-170` is
  exercised only via the failure-manifest unit paths).

### 2. `approve-release` — human

- **id/kind:** `human` node with `interactionContract` =
  `delivery-release-approval` (`DELIVERY_HUMAN_ADAPTER_IDS.approval`)
  (`src/process-modules/modules/delivery/delivery-process-module.ts:81-89`;
  adapter ids `src/modules/delivery/domain/delivery-kernel-ports.ts:36-38`).
- **Roles:** one outside participant — the human operator through the approval
  source; the adapter itself never fabricates a decision ("`pending` is a
  normal resumable result and must not be converted into an approval by the
  adapter", `src/modules/delivery/domain/delivery-provider-ports.ts:37-48`).
- **Input authority/cardinality:** exact preflight product re-read from the
  durable settlement state and re-validated ready before asking
  (`src/modules/delivery/application/delivery-installation.ts:197-217,788-799`).
- **Tools/protocol:** `DeliveryApprovalPort.decide` against the injected
  approval source; default production source is the SQLite approval inbox
  (`SqliteDeliveryApprovalInbox implements DeliveryApprovalSource`,
  `src/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.ts:43,73`;
  wiring `src/modules/delivery/index.ts:117-136,146-149`).
- **Output authority/schema:** `delivery-approval`
  (`DELIVERY_APPROVAL_SCHEMA`), authority `human` — decision status
  `not-required|pending|approved|denied|expired`, bound to candidateHash +
  preflightHash + releasePolicyHash, `approvalHash` content-addressed
  (`src/modules/delivery/domain/delivery-schemas.ts:150-166`;
  artifact row `src/process-modules/modules/delivery/delivery-process-module.ts:223-228`).
  Pending returns `runtimeEvent: 'paused'` carrying the pending status so
  settlement can route `approval-required` later
  (`src/modules/delivery/application/delivery-installation.ts:218-235`).
- **Gates:** `assertApprovalSnapshot` (schema, hash, candidate/preflight/policy
  lineage) and `assertReleaseAuthorized` (admissible status; an `approved`
  status must carry a trusted `authorized_decision` provider with non-empty
  identity, `src/modules/delivery/application/delivery-installation.ts:770-831`).
- **Repair/retry:** expired → domain event `approval-required`; denied →
  settle; approved/not-required → publish
  (`src/process-modules/modules/delivery/delivery-process-module.ts:146-174`;
  status mapping `src/modules/delivery/application/delivery-installation.ts:256-263`).
- **State/effects:** none external (decision recording only).
- **Forward consumers:** `publish-deploy` re-reads and re-asserts the exact
  approval product
  (`src/modules/delivery/application/delivery-installation.ts:281-291`).
- **Backward obligations:** invariants `delivery.approval-binds-exact-input`
  (approval cannot float to a later revision) and
  `delivery.no-default-provider`
  (`src/process-modules/modules/delivery/delivery-process-module.ts:283-293`).
- **Scripted outside participant:** the approval inbox returns `pending` until
  a decision is filed (`src/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.ts:73`);
  tests file decisions directly.
- **Tests/CI:** `tests/process-modules/delivery-approval-inbox.test.mjs`,
  `deferred-delivery.test.mjs` (glob-hosted → matrix + CI);
  `tests/factory-proof/delivery-kernel-unification.test.mjs` (exact-file
  hosted in `factory-proof`, `tools/run-acceptance-matrix.mjs:150`).
- **Uncovered:** no CI suite drives the human adapter through the generic
  human-interaction registry pause/resume cycle against a REAL multi-host
  pause (the pause is `runtimeEvent`-level only).

### 3. `publish-deploy` — kernel (external effect)

- **id/kind:** kernel, handler `delivery-publish-deploy`
  (`src/modules/delivery/domain/delivery-kernel-ports.ts:31-32`;
  node `src/process-modules/modules/delivery/delivery-process-module.ts:91-99`).
- **Roles:** none — deterministic external-system calls, not worker hiring
  (`src/process-modules/modules/delivery/delivery-process-module.ts:95`).
- **Input authority/cardinality:** re-reads exact preflight + approval
  products; `assertReadyPreflight`, `assertApprovalSnapshot`,
  `assertReleaseAuthorized` all re-run before any action
  (`src/modules/delivery/application/delivery-installation.ts:267-298`).
- **Tools/protocol:** `DeliveryPublicationPort.publishAndDeploy`; the runtime
  resolves each action's provider by kind (`providers.actionProviders[kind]`,
  missing → typed failure), opens a durable external-effect ledger row
  (deterministic `actionKey`, request hash, claim fence/lease, execution
  attempts), and — the cross-run idempotency boundary — **observes the
  provider before every execution** ("observe the provider before every...",
  `src/modules/delivery/infrastructure/sqlite-delivery-runtime.ts:466-536`,
  ledger port `src/modules/delivery/domain/delivery-kernel-ports.ts:278-305`).
- **Output authority/schema:** `delivery-publication`
  (`DELIVERY_PUBLICATION_SCHEMA`), authority `kernel` — durable desired-state
  action receipts "including uncertain external responses"
  (`src/modules/delivery/domain/delivery-schemas.ts:182-200`;
  artifact row `src/process-modules/modules/delivery/delivery-process-module.ts:229-236`).
  `assertPublicationSnapshot` re-derives every receipt: actionKey, kind,
  target, payloadHash, desiredStateHash, unique actionIds, four-state status
  `succeeded|failed|blocked|uncertain`
  (`src/modules/delivery/application/delivery-installation.ts:833-874`).
- **Gates:** completeness arithmetic — missing required action receipts or any
  non-succeeded receipt → event `failed` with typed binding status
  `incomplete|uncertain|completed`
  (`src/modules/delivery/application/delivery-installation.ts:311-337`).
- **Repair/retry:** invariant `delivery.observe-before-retry` — "Retries use
  the deterministic action key and authoritative target observation before any
  external action is repeated"
  (`src/process-modules/modules/delivery/delivery-process-module.ts:294-299`).
  Both `completed` and `failed` publications advance to observation
  (`src/process-modules/modules/delivery/delivery-process-module.ts:175-184`) —
  a failed/uncertain response is still observed, never blindly repeated.
- **State/effects:** THE release effect boundary; invariant
  `delivery.no-force-or-bypass` (no force push, no branch-protection,
  registry-immutability or deployment-policy bypass; enforcement `test`,
  `src/process-modules/modules/delivery/delivery-process-module.ts:306-312`).
- **Forward consumers:** `observe-release`.
- **Backward obligations:** exact approval + preflight lineage (above).
- **Scripted outside participant:** none — providers are injected; the
  composition "must never fabricate an external success or a human decision"
  (`src/modules/delivery/index.ts:63-68`).
- **Tests/CI:** `tests/modules/delivery/delivery-effect-contracts.test.mjs`
  (filed; orphan — NOT in any matrix group, see TEST COVERAGE);
  `tests/process-modules/external-effect-ledger.test.mjs`,
  `external-effect-failure-pattern.test.mjs`,
  `acceptance-effect-exactly-once.test.mjs`,
  `c8-effects-settled-one-predicate.test.mjs` (glob-hosted → matrix + CI).
- **Uncovered:** no CI proof that a REAL remote (registry/git host) honours
  the no-force contract; the invariant's `test` enforcement runs against
  adapters/doubles only.

### 4. `observe-release` — kernel (external observation)

- **id/kind:** kernel, handler `delivery-observe-release`
  (`src/modules/delivery/domain/delivery-kernel-ports.ts:32-33`;
  node `src/process-modules/modules/delivery/delivery-process-module.ts:101-109`).
- **Roles:** none — deterministic external-system observation
  (`src/process-modules/modules/delivery/delivery-process-module.ts:105`).
- **Input authority/cardinality:** re-reads preflight + approval + publication
  and re-asserts all three lineages before observing
  (`src/modules/delivery/application/delivery-installation.ts:341-379`).
- **Tools/protocol:** `DeliveryObservationPort.observe` against the injected
  observation surface (`src/modules/delivery/infrastructure/sqlite-delivery-runtime.ts:338-411`);
  per-action provider observation outcomes are
  `matched|mismatched|unknown|error` with observed-state hash and a
  content-addressed observation record
  (`src/modules/delivery/domain/delivery-provider-ports.ts:63-101`).
- **Output authority/schema:** `delivery-observation`
  (`DELIVERY_OBSERVATION_SCHEMA`), authority `kernel` — "Authoritative
  post-action state observations used to settle external effects safely"
  (`src/modules/delivery/domain/delivery-schemas.ts:202-218`;
  artifact row `src/process-modules/modules/delivery/delivery-process-module.ts:237-243`).
  The handler validates schemaVersion, hash, candidate AND
  `currentCandidateHash` (drift check) and publicationHash lineage
  (`src/modules/delivery/application/delivery-installation.ts:386-406`).
- **Gates:** uncertainty arithmetic — incomplete observation or any
  `unknown|error` item → event `failed` / status `uncertain`
  (`src/modules/delivery/application/delivery-installation.ts:407-423`).
- **Repair/retry:** observation retry is "a bounded/durable control operation,
  not a private worker queue or second Production Cell runtime" (CONVEYOR §21,
  `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1021-1036`).
- **State/effects:** read-only over external state; no mutation.
- **Forward consumers:** `settle-delivery` (input schema
  `DELIVERY_OBSERVATION_SCHEMA`), plus settlement's synchronous
  `observeCurrentCandidateHash` re-check
  (`src/modules/delivery/infrastructure/sqlite-delivery-runtime.ts:377,444`;
  port `src/modules/delivery/domain/delivery-provider-ports.ts:109-115` —
  "Synchronous authoritative observation used by settlement immediately after
  the observation node. Null denies release.").
- **Backward obligations:** invariant `delivery.push-is-not-release` — "A
  successful command response alone never establishes release; settlement
  requires matching authoritative observed state"
  (`src/process-modules/modules/delivery/delivery-process-module.ts:300-305`).
- **Scripted outside participant:** observation providers injected by tests.
- **Tests/CI:** covered through `product-delivery-lifecycle-e2e.test.mjs` and
  the `factory-proof` delivery scenario pack (matrix + CI).
- **Uncovered:** no dedicated CI suite for bounded observation RETRY as a
  durable control operation (the "durable retry" arrow of CONVEYOR §21,
  `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1030-1033`) — only the
  first-observation paths are demonstrated.

### 5. `settle-delivery` — kernel (settlement)

- **id/kind:** kernel, handler `delivery-settlement-policy`
  (`src/modules/delivery/domain/delivery-kernel-ports.ts:33-34`;
  node `src/process-modules/modules/delivery/delivery-process-module.ts:111-119`).
- **Roles:** none; `ReferenceDeliverySettlementPolicy` is a pure decision
  (`src/modules/delivery/domain/delivery-settlement-policy.ts:423-430`).
- **Input authority/cardinality:** `buildSettlementInput` re-reads the exact
  durable products; the handler validates the returned case against the
  ProcessRun input byte-for-byte
  (`src/modules/delivery/application/delivery-installation.ts:876-897`;
  port `src/modules/delivery/domain/delivery-kernel-ports.ts:94-99`).
  Short-circuits: authorization-required preflight binding → empty input;
  preflight infrastructure failure → typed `failed/infrastructure-error`
  certificate (`src/modules/delivery/application/delivery-installation.ts:430-462`).
- **Tools/protocol:** pure `settle` over the snapshot; then the settlement
  kernel ITSELF issues the ProcessOutcomeCertificate and emits an explicit
  ModuleCompletion whose `certificateRef` points at the issued row
  (`src/modules/delivery/application/delivery-installation.ts:464-547,596-614`).
- **Output authority/schema:** `delivery-certificate`
  (`DELIVERY_CERTIFICATE_SCHEMA`), authority `kernel` — decision
  (`released|approval-required|blocked|failed`), reasonCodes, rationale,
  inputHash, and the full product-lineage hashes (preflight/approval/
  publication/observation/releaseRecord) in the certificate payload
  (`src/modules/delivery/application/delivery-installation.ts:595-603`;
  payload builder `src/modules/delivery/domain/delivery-settlement-policy.ts:997-1015`).
  On `released` only, a canonical `release-record` (`RELEASE_RECORD_SCHEMA`)
  is persisted through the write-once output repository with re-checked
  record/content hashes, and any other decision exposing a ReleaseRecord
  throws (`src/modules/delivery/application/delivery-installation.ts:549-593`).
- **Gates:** policy `delivery-settlement` v1.0.0 — "Admits a release only when
  authorized desired-state actions are authoritatively observed"
  (`src/process-modules/modules/delivery/delivery-process-module.ts:267-273`);
  the reference policy re-evaluates preflight and constructs the ReleaseRecord
  from observed destinations
  (`src/modules/delivery/domain/delivery-settlement-policy.ts:423-430,509,975-985`).
- **Repair/retry:** none — all four outcomes terminal; failure path issues the
  failure certificate IN THE KERNEL and fails loudly if issuance throws ("a
  swallowed error would silently produce a null certificate, which is data
  loss", `src/modules/delivery/application/delivery-installation.ts:641-699`).
- **State/effects:** none external (settlement only).
- **Forward consumers:** lifecycle `outputMapping` →
  `complete-<decision>` emitters → terminal status
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:468-484`).
- **Backward obligations:** candidate immutability re-checks at every node.
- **Scripted outside participant:** none.
- **Tests/CI:** `tests/process-modules/product-lifecycle-policies.test.mjs`,
  `deferred-delivery.test.mjs`, `product-delivery-lifecycle-e2e.test.mjs`
  (glob-hosted → matrix + CI); `delivery-kernel-unification.test.mjs`
  (factory-proof → matrix + CI).
- **Uncovered:** no CI suite drives certificate-issuage failure (DB throw)
  end-to-end; the loud-fail branch is unit-demonstrated only.

### 6. `complete-released` / `complete-approval-required` / `complete-blocked` / `complete-failed` — kernel emitters

- Generated outcome emitters (`process-outcome-emitter`), one per terminal
  outcome (`src/process-modules/modules/delivery/delivery-process-module.ts:120-127,195-199`).
  Invariant `delivery.module-does-not-route`: "Delivery emits a local outcome
  and does not decide lifecycle routing" (enforcement `static`,
  `src/process-modules/modules/delivery/delivery-process-module.ts:318-323`).

---

## WORKSHOP EXIT CONTRACT

- Terminal outcomes (all terminal): `released` (every required release action
  authoritatively observed at its desired state), `approval-required` (a
  current authorized human decision is required before release effects may
  begin), `blocked` (policy guard, denied decision, unavailable provider or
  inconclusive external state), `failed` (integrity/lineage/external-state
  validation failed)
  (`src/process-modules/modules/delivery/delivery-process-module.ts:39-64`).
- Output contract: `RELEASE_RECORD_SCHEMA`
  (`src/process-modules/modules/delivery/delivery-process-module.ts:38`);
  the output resolver returns a ProcessModuleOutput ONLY for `released` and
  re-reads the exact persisted record
  (`src/modules/delivery/application/delivery-installation.ts:95-123,979-1003`).
- Declared invariants (module list): explicit-operator-authorization;
  approval-binds-exact-input; no-default-provider; observe-before-retry;
  push-is-not-release; no-force-or-bypass; candidate-is-immutable;
  module-does-not-route
  (`src/process-modules/modules/delivery/delivery-process-module.ts:275-324`).
- "`approval-required` is a truthful terminal business outcome, not a paused
  worker state. Later operator authority never rewrites that outcome."
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1514-1519`).

---

## DOWNSTREAM CONTRACT (producer → bridge → consumer)

- Producer: Delivery settlement emits decision + certificate + (on released)
  release record; the stage `outputMapping` copies decision/authority/
  certificate and `releaseRecord.schema/ref/hash/payload` into the order
  state (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:468-478`).
- Bridge: outcome routes — `released` → terminal status `released`;
  `approval-required` → terminal `approval-required`; `blocked` → terminal
  `delivery-blocked`; `failed` → terminal `failed`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:479-484`).
- Consumer: there is no downstream stage inside `product-delivery`; the
  terminal order leaf is the consumer surface. Exit condition (declared):
  "Every required external action has authoritative observed state"
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:489`).
- A ReleaseRecord alone is not a release: "A ReleaseRecord alone is not a
  release... It must be created without force, observed before retry, and
  accepted as replay only when commit and tree match exactly."
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1521-1533`).

---

## SIDE-CAR / CONTINUATION FLOWS

- **Local release continuation (approval boundary):**
  `prepareLocalReleaseContinuation` appends a child LifecycleRun at the
  Delivery boundary. It fail-closes unless the parent is
  `completed/approval-required` and an exact completed
  `delivery-release` boundary row exists
  (`src/app/factory-release-continuation.ts:19-42`); it then resolves the
  single active repository + integration branch head, builds a `saga-local-source-tag`
  release policy + an exact-candidate operator grant, and authorizes a
  continuation whose `resumeStageId` is `delivery-release` with additive
  input mappings sourced from the verified external baseline snapshot —
  never from caller-supplied input
  (`src/app/factory-release-continuation.ts:44-110`).
  "The continuation creates no inherited StageRuns and invokes no inherited
  workers" (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1529-1533`).
- **Deferred delivery (start-from-idea):** ordinary idea-started runs carry a
  deferred profile; preflight terminates `authorization-required` → terminal
  `approval-required` without any effect
  (`src/modules/delivery/application/delivery-installation.ts:149-153,724-745`;
  demonstrated by `tests/process-modules/deferred-delivery.test.mjs`).
- **Deployment as a separate future request:** "Deployment is a future
  `FactoryRequest(release)` consumed by the DevOps workshop... Splitting these
  requests prevents release authority from blocking product manufacture"
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1559-1563`).

---

## DEAD / DECLARATIVE-ONLY STRATA

- `tests/modules/delivery/delivery-effect-contracts.test.mjs` is filed but
  orphaned — no matrix group hosts it (see TEST COVERAGE); its checks are
  therefore declared + filed but NOT demonstrated-in-CI.
- The "DevOps workshop" of the mental model is declarative only
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1559-1563` names it as future;
  no such module exists under `src/process-modules/modules/`).
- The four-outcome emitters are thin; any richer "delivery dashboard/retry"
  semantics sometimes described in run journals do not exist as flow nodes.
- The approval inbox's decision-filing ergonomics (who writes the decision
  row) are outside the module: the port only reads; there is no in-module
  approval UI path (`src/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.ts:43,73`).

---

## TEST COVERAGE

Hosted, blocking (matrix + CI — each group an isolated `node --test` CI step,
`.github/workflows/ci.yml:65-120`, groups `tools/run-acceptance-matrix.mjs:64-163`):

- `process-modules` group (glob `tests/process-modules/*.test.mjs`): includes
  `deferred-delivery.test.mjs`, `delivery-approval-inbox.test.mjs`,
  `delivery-package-contributions.test.mjs`, `delivery-package-manifest.test.mjs`,
  `product-delivery-lifecycle-e2e.test.mjs`,
  `product-lifecycle-composition.test.mjs`, `product-lifecycle-policies.test.mjs`,
  plus the shared effect-ledger/exactly-once suites
  (`tools/run-acceptance-matrix.mjs:83-116`).
- `factory-proof` group (exact files): `delivery-kernel-unification.test.mjs`
  (`tools/run-acceptance-matrix.mjs:150`).

Filed but NOT hosted (orphan class — outside CI):

- `tests/modules/delivery/delivery-effect-contracts.test.mjs` — the
  `tests/modules/**` tree is hosted only by exact-file entries, and this file
  has none (`tools/run-acceptance-matrix.mjs:83-163` lists every exact file;
  it is absent). This matches the audit's structural finding: hosting is
  file-by-file and 219 unmanaged orphan files exist
  (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:95-102`).
- `tests/matrix/f-authority-delivery.test.mjs` — filed; the `tests/matrix/`
  directory is matched by no group
  (`tools/run-acceptance-matrix.mjs:64-163` enumerates every group glob and
  exact file; none covers it), placing it in the audit's structural orphan
  class (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:95-102`).

Delivery appears in NO quarantine row — nothing delivery-specific is excluded
(`tools/run-acceptance-matrix.mjs:176-195`).

---

## UNCOVERED CONDITIONS

- **Effect contracts outside CI:** the module's own effect-contract suite is
  an orphan (above); the no-force/no-bypass invariant's `test` enforcement has
  no blocking host for the delivery-specific contracts file.
- **Approval pause/resume against a live human:** only the inbox `pending`
  path is demonstrated; resumption after a real operator delay (lease expiry,
  process restart) relies on the generic executor's pause semantics without a
  delivery-specific CI scenario.
- **Observation durable retry:** the bounded/durable retry arrow of CONVEYOR
  §21 (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1030-1036`) has no named
  delivery suite; only single-shot observation is demonstrated.
- **Real external providers:** all blocking suites run injected providers; no
  CI integration against a real registry/git host/deployment target exists
  (composition explicitly forbids defaults, `src/modules/delivery/index.ts:63-68,95-105`).
- **Multi-host effect claims:** the external-effect ledger port exposes claim
  fences (`src/modules/delivery/domain/delivery-kernel-ports.ts:257-305`) but
  the single-host read-then-assign caveat of the dispatcher applies factory-
  wide (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1054-1057`); no
  delivery-specific multi-host proof exists.

---

## CONTRADICTIONS

1. **"Zero LLM profiles" vs worker-shaped vocabulary around the flow:** the
   descriptor is unambiguous (`executionProfiles: []`,
   `src/process-modules/modules/delivery/delivery-process-module.ts:325`), but
   several checklists/instructions under
   `src/process-modules/modules/delivery/package/resources/` (e.g.
   `publish-deploy-instructions.md`, `observe-release-instructions.md`) are
   written as worker-facing protocol prose. They are resources for the human
   adapter/operator, not desks; the map records the vocabulary drift without
   treating it as authority.
2. **Deferred envelope vs authorized invariant:** the stage input mapping
   always carries `$.delivery.*` keys
   (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:462-465`),
   while the module invariant demands explicit operator authorization for any
   release effect
   (`src/process-modules/modules/delivery/delivery-process-module.ts:275-281`).
   The reconciliation is the deferred variant + terminal `approval-required`
   (`src/modules/delivery/domain/delivery-schemas.ts:119-124`;
   `src/modules/delivery/application/delivery-installation.ts:149-153`) —
   a reader who stops at the invariant would wrongly conclude Delivery cannot
   run without a policy.
3. **"Released" naming vs `runnable-local`:** in the `product-build` lifecycle
   the Delivery stage is removed entirely and Development's `verified`
   terminates as `runnable-local`
   (`src/process-modules/lifecycles/product-build-lifecycle.ts:30-44`); any doc
   that says "the product is released" after a product-build run contradicts
   `ready-to-run`'s definition ("It never means published, remotely deployed,
   or operationally approved",
   `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1546-1550`).
4. **Kernel-unification proof vs orphan effect-contract proof:** CI hosts the
   scenario-level delivery proof (`delivery-kernel-unification.test.mjs`) but
   not the module-local effect-contract file — the stronger, closer-to-adapter
   claim has the weaker hosting status (declared + filed vs matrix + CI).
