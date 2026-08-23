# 01 — Discovery Stratum Map

- **Status:** hypothesis over commit `586871ad` (branch `map/discovery-formalization-2026-08-23`)
- **Shared contract:** `docs/factory-map/00_FACTORY_CONTRACT.md` (card schema §7, evidence labels §5)
- **Prohibited sources:** no forward/reverse graph file was read or written (contract §1/§9).
- Module identity: `product-discovery@3.0.2`
  (`src/process-modules/lifecycles/product-delivery-module-contracts.ts:30-33`).
- Live surface assertion: the production composition registers Discovery exactly through
  `registerDiscovery` (`src/modules/discovery/index.ts:34-80`, called at
  `src/app/product-lifecycle-runtime.ts:871`). Everything else in
  `src/modules/discovery/**` and `src/tools/discovery-*` is strata (§6).

## PURPOSE

Discovery converts one bounded product initiative into an immutable, certificate-backed
discovery outcome: a grounded Proposal (cognitive cell 1), an independent readiness
assessment bound to the exact accepted proposal content (cognitive cell 2), and a
deterministic settlement that issues the authoritative outcome certificate
(`src/process-modules/modules/discovery/discovery-process-module.ts:41-48`,
`src/process-modules/modules/discovery/discovery-process-module.ts:49-64`). There are exactly two cognitive desks; both are normal Production Cells on
the universal runtime — "The old normalization/readiness ControlIntent
mini-orchestrators do not exist in this Flow" (`src/process-modules/modules/discovery/discovery-process-module.ts:46-48`).

## ENTRY CONTRACT

- Stage `initial-discovery` maps the lifecycle root input into the module input:
  `projectId/epicId` runtime refs plus `objective/subject/context/evidence/constraints`
  from `$.initiative.*` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:293-302`).
- Module input contract: `factory.discovery-case.v1`
  (`src/process-modules/modules/discovery/discovery-process-module.ts:57`); entry condition declared: `initiative.subject exists`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:340`).
- The stage's module pin is `DISCOVERY_PROCESS_MODULE_REF` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:292`),
  version `3.0.2` (`src/process-modules/lifecycles/product-delivery-module-contracts.ts:30-33`) — `declared`.
- Package install: the discovery package manifest is installed once per CLI composition
  via `installProductionModules([... discoveryPackageManifest ...])`
  (`src/orchestrate-cli.ts:885-897`) — `declared` + `CI-executed` via the architecture
  group digest check (§7).
- The proposal worker also consumes ADR-090 constraint context: settlement reads the
  pinned lifecycle definition classification and the digest-pinned obligation injection
  table only through the injected reader/declarations
  (`src/app/product-lifecycle-runtime.ts:879-896`;
  `src/modules/discovery/index.ts:88-94` fail-closed, no ambient default) — `declared`.

## LIVE PRODUCTION NODE / DESK CARDS

### Card D-1 — `produce-proposal` (Production Cell `discovery-proposal`)

| Field | Content |
|---|---|
| 1. id / kind | node `produce-proposal`, kind `production-cell`, cell `discovery-proposal`, flow entry node (`src/process-modules/modules/discovery/discovery-process-module.ts:68`, `src/process-modules/modules/discovery/discovery-process-module.ts:71-87`) |
| 2. roles | author only (no review desk): execution profile `discovery-proposal-worker`, skill `saga-discovery-worker`, protocol skill `saga-process-module-worker-protocol`, `executionMode: tracker_only`, `artifactAcceptanceAuthority: kernel-gate` (`src/process-modules/modules/discovery/discovery-process-module.ts:163-187`) |
| 3. input authority / cardinality | one DiscoveryCase per run (stage inputMapping, `src/process-modules/lifecycles/product-delivery-lifecycle.ts:293-302`); desk reads: `task_get`, `repository_checkout_list`, `artifact_list`, `note_list` (allowedTools, `src/process-modules/modules/discovery/discovery-process-module.ts:173-176`); cardinality of input binding: 1 (flow entry) |
| 4. tools / protocol | allowedTools: `task_get, repository_checkout_list, artifact_list, note_list, product_submit, worker_done, Write, Read, Edit, Bash, Glob, Grep` (`src/process-modules/modules/discovery/discovery-process-module.ts:173-176`); submission via `product_submit` MCP tool (`src/tools/products.ts:285`, handler map `src/tools/products.ts:326`); completion via `worker_done`; tracker `proposal-stage-tracker.md`, templates `discovery-doc-template.md`, `proposal-call-template.json`, checklist `proposal-checklist.md` (`src/process-modules/modules/discovery/discovery-process-module.ts:177-183`) |
| 5. output authority / schema | exactly one `factory.discovery-proposal.v1` payload (`DISCOVERY_PROPOSAL_SCHEMA`, `src/modules/discovery/domain/discovery-domain-contracts.ts:24`; product contract cardinality `'1'`, `src/process-modules/modules/discovery/discovery-process-module.ts:81`); authority sealed by the cell gate into a CandidateSet member `managed-node-submission:<id>` resolved by exact digest (`src/modules/discovery/application/discovery-check-providers.ts:212-237`) |
| 6. gates | author gate = final gate (no reviewer): gateId `discovery-proposal.author`→phase `final` via `singletonProductionCell` (`src/process-modules/application/standard-production-cell.ts:41`, `src/process-modules/application/standard-production-cell.ts:57-63`); check plan `discovery.proposal.final` over provider `discovery.proposal-contract.v1@1.0.0` digest sha256({providerId,version,invariant}) (`src/process-modules/modules/discovery/discovery-process-module.ts:30-34`; provider ids/digests `src/modules/discovery/application/discovery-check-providers.ts:18-25`); provider validates payload against `validateDiscoveryProposal` reading the exact CandidateSet member (`src/modules/discovery/application/discovery-check-providers.ts:47-77`) |
| 7. repair / retry | `maxAttempts: 2`, `onExhausted: 'requeue'` at cell level (`src/process-modules/modules/discovery/discovery-process-module.ts:82-83`); profile retry `{maxAttempts:2, retryOn:['gate-repair'], backoff:'none'}`, recovery `{resumeFromCheckpoint, reuseWorkIntent, reuseAcceptedOutput, onExhausted:'pause'}` (`src/process-modules/modules/discovery/discovery-process-module.ts:185-186`); requeue rollover/total-cap accounting in the executor (`src/process-modules/application/node-executors/production-cell-node-executor.ts:783-880`) |
| 8. state / effects | durable: WorkIntent + projected task (`factory.work-intent.discovery.v1`, kind `discovery`, `src/modules/discovery/domain/discovery-domain-contracts.ts:60-63`), fenced WorkerExecution, immutable managed-node-submission row, Workplace/CandidateSet/GateRun rows (runtime-owned, `src/app/product-lifecycle-runtime.ts:823-857` shared deps); no post-acceptance effect declared (no `postAcceptanceEffect` in cell options, `src/process-modules/modules/discovery/discovery-process-module.ts:77-87`); failure branch → `complete-failed` (`src/process-modules/modules/discovery/discovery-process-module.ts:131`) |
| 9. forward consumers | (a) `assess-readiness` cell, inputSchema `factory.discovery-proposal.v1` (`src/process-modules/modules/discovery/discovery-process-module.ts:95`); (b) readiness check provider binding by content hash (`src/modules/discovery/application/discovery-check-providers.ts:119-158`); (c) settlement handler reads the exact accepted proposal member (`src/modules/discovery/application/discovery-production-cell-installation.ts:154-180`); (d) lifecycle proposal output mapping (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:309-312`) |
| 10. backward obligations | stage entry mapping resolved; Workplace materialized/admitted by runtime; execution fence valid; the submission validator + gate provider verify schema/digest before acceptance (`src/modules/discovery/application/discovery-check-providers.ts:57-75`) |
| 11. scripted outside participant | `discovery/proposal-*` scenario scripts: scripted worker drives the real MCP `product_submit`/`worker_done` surface (`tests/factory-contract/golden-path-scenarios.mjs:1-13`; corpus ids in `tests/factory-evidence/discovery/discovery_proposal-*.json`) |
| 12. tests / CI | scenario corpus `matrix-hosted`/`demonstrated`: `tests/factory-evidence/discovery/discovery_proposal-feedback-exact.json`, `..._duplicate-submit.json`, `..._worker-crash.json`, `..._stale-execution-fence.json`, `..._late-tool-call.json`; provider unit tests `file-exists` (NOT CI-hosted): `tests/modules/discovery/discovery-check-providers.test.mjs`; CI-hosted pack validation: `tests/factory-proof/discovery-scenario-pack.test.mjs`, `discovery-resilience-pack.test.mjs` (group `factory-proof`, `tools/run-acceptance-matrix.mjs:131-160`, run at `.github/workflows/ci.yml:123-124`) — `CI-executed` |
| 13. uncovered | author-desk behavior under concurrent duplicate executions of the SAME task beyond duplicate-submit corpus; proposal payload `order_constraints` deep-schema drift (validator is field-shape only, `src/modules/discovery/application/discovery-check-providers.ts:63-75`); no reviewer desk (by design) |

### Card D-2 — `assess-readiness` (Production Cell `discovery-readiness`)

| Field | Content |
|---|---|
| 1. id / kind | node `assess-readiness`, kind `production-cell`, cell `discovery-readiness` (`src/process-modules/modules/discovery/discovery-process-module.ts:89-108`) |
| 2. roles | author only: profile `discovery-readiness-advisor`, skill `saga-discovery-readiness-advisor`, `tracker_only`, `kernel-gate` acceptance authority (`src/process-modules/modules/discovery/discovery-process-module.ts:188-208`) |
| 3. input authority / cardinality | reads the EXACT accepted Proposal product: node `inputSchema: factory.discovery-proposal.v1` (`src/process-modules/modules/discovery/discovery-process-module.ts:95`); desk tools `task_get, product_read, product_submit, worker_done, Read, Edit` (`src/process-modules/modules/discovery/discovery-process-module.ts:198-200`); binding is by content hash inside the run, never by row id (`src/modules/discovery/application/discovery-check-providers.ts:119-133`) |
| 4. tools / protocol | as above; tracker `readiness-stage-tracker.md`, template `readiness-call-template.json`, checklist `readiness-checklist.md` (`src/process-modules/modules/discovery/discovery-process-module.ts:201-204`) |
| 5. output authority / schema | exactly one `factory.discovery-readiness-assessment.v2` (`src/modules/discovery/domain/discovery-domain-contracts.ts:28-29`; cardinality `'1'`, `src/process-modules/modules/discovery/discovery-process-module.ts:102`); the payload must carry `proposal_content_hash` binding it to the exact proposal version (`src/modules/discovery/application/discovery-check-providers.ts:111-118`) |
| 6. gates | final gate `discovery-readiness.final` (author gate phase = final, `src/process-modules/application/standard-production-cell.ts:41`); provider `discovery.readiness-contract.v1@1.1.0` (`src/process-modules/modules/discovery/discovery-process-module.ts:35-39`; `src/modules/discovery/application/discovery-check-providers.ts:27-35`); invariant: "readiness-binds-accepted-proposal-by-content-hash-and-cites-only-allowed-sources"; source citation restricted to `allowedProposalSourceRefs` (`src/modules/discovery/application/discovery-check-providers.ts:180-190`); foreign-but-well-formed hash is a typed failed binding with decodable diagnostics (`src/modules/discovery/application/discovery-check-providers.ts:134-158`, `src/modules/discovery/application/discovery-check-providers.ts:198-210`) |
| 7. repair / retry | `maxAttempts: 2`, `onExhausted: 'requeue'` (`src/process-modules/modules/discovery/discovery-process-module.ts:103-104`); profile retry/recovery identical shape to D-1 (`src/process-modules/modules/discovery/discovery-process-module.ts:206-207`) |
| 8. state / effects | durable: readiness assessment managed submission + CandidateSet/GateRun; no post-acceptance effect; failure branch → `complete-failed` (`src/process-modules/modules/discovery/discovery-process-module.ts:133`) |
| 9. forward consumers | settlement handler reads the exact accepted readiness member (`src/modules/discovery/application/discovery-production-cell-installation.ts:160-180`); lifecycle certificate mapping carries readiness authority via settlement snapshot only |
| 10. backward obligations | `produce-proposal` must have reached cell acceptance first (transition `domain.accepted`, `src/process-modules/modules/discovery/discovery-process-module.ts:130`); the readiness provider re-resolves the proposal row inside the same run by content hash (`src/modules/discovery/application/discovery-check-providers.ts:124-133`) |
| 11. scripted outside participant | `discovery/readiness-*` scripts: `discovery_readiness-*.json` corpus (wrong-proposal-hash, invented-source-ref, missing-dimension, duplicate-submit, feedback-exact, stale-execution-fence, worker-crash, late-tool-call) |
| 12. tests / CI | corpus `matrix-hosted`/`demonstrated` (`tests/factory-evidence/discovery/discovery_readiness-*.json`; universe rows `tests/factory-proof/workshop-inventory.baseline.json:5-21`); CI-hosted: factory-proof discovery packs (`.github/workflows/ci.yml:123-124`); provider tests `tests/modules/discovery/discovery-check-providers.test.mjs` are `file-exists` only (no group hosts `tests/modules/discovery/**`, `tools/run-acceptance-matrix.mjs:83-117`) |
| 13. uncovered | advisor-desk review desk absent (by design); no scenario exercises a readiness payload citing an allowed ref with forged content (grounding is ref-citation only, `src/modules/discovery/application/discovery-check-providers.ts:180-190`) |

### Card D-3 — `settle` (kernel node, handler `discovery-settlement-policy`)

| Field | Content |
|---|---|
| 1. id / kind | node `settle`, kind `kernel`, handler id `discovery-settlement-policy` (`src/process-modules/modules/discovery/discovery-process-module.ts:109-118`) |
| 2. roles | kernel (deterministic; no LM) — handler created by `createDiscoveryProductionCellKernelHandlers`, which registers ONLY this handler (`src/modules/discovery/application/discovery-production-cell-installation.ts:131-146`; registered at `src/modules/discovery/index.ts:48-58`) |
| 3. input authority / cardinality | exactly one accepted proposal cell item (`ctx.frame.productions['produce-proposal']` → `requireAcceptedSingletonCellItem(..., 'discovery-settlement/proposal')`) and exactly one accepted readiness cell item (`ctx.input` → `'discovery-settlement/readiness'`) (`src/modules/discovery/application/discovery-production-cell-installation.ts:154-168`); both resolved by exact ProductRef alias `managed-node-submission:<id>` + schema + content digest (`src/modules/discovery/application/discovery-production-cell-installation.ts:462-495`); ProcessRun row for `input_hash`/`started_at` (`src/modules/discovery/application/discovery-production-cell-installation.ts:181-184`) |
| 4. tools / protocol | none (kernel); reads DB via `SqlDatabasePort`, certificate repository, injected pinned lifecycle-definition reader + digest-pinned injection declarations (`src/modules/discovery/application/discovery-production-cell-installation.ts:101-116`; wiring `src/app/product-lifecycle-runtime.ts:879-896`) |
| 5. output authority / schema | `factory.discovery-outcome-certificate.v1` (`src/modules/discovery/application/discovery-production-cell-installation.ts:47-48`; node outputSchema `src/process-modules/modules/discovery/discovery-process-module.ts:117`); certificate issued via `ProcessOutcomeCertificateRepository.issue` with `certificateHash = sha256(payload)` (`src/modules/discovery/application/discovery-production-cell-installation.ts:282-296`); ModuleCompletion carries certificateRef (`src/modules/discovery/application/discovery-production-cell-installation.ts:343-353`) |
| 6. gates | no GateRun (kernel node); the settlement policy itself is versioned + content-hashed (`policy.version`, `policy.contentHash` into snapshot, `src/modules/discovery/application/discovery-production-cell-installation.ts:203-206`; policy contract `src/modules/discovery/domain/discovery-settlement-policy.ts:135-145`) |
| 7. repair / retry | not a Workplace — idempotent by construction: byte-identical settlement input per ProcessRun (`captured_at = run.started_at`, `src/modules/discovery/application/discovery-production-cell-installation.ts:207-210`); input-key idempotency of settlement rows is a legacy-service property now reached only through strata (§6); typed `failed` event on any error (`src/modules/discovery/application/discovery-production-cell-installation.ts:310-321`) |
| 8. state / effects | durable writes: outcome certificate row; settlement payload freezes decision, reasonCodes, inputHash, constraint register V2 or typed no-obligations attestation, lifecycleBinding citing pinned definitionHash + consumed injection table digests (`src/modules/discovery/application/discovery-production-cell-installation.ts:244-281`); no external effects |
| 9. forward consumers | (a) node transitions to `complete-go/clarify/reject/failed` on `domain.go/clarify/reject/failed` (`src/process-modules/modules/discovery/discovery-process-module.ts:134-137`); (b) lifecycle `$.stages.initial-discovery.certificate.ref/hash` consumed by Formalization entry mapping (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:351-352`); (c) proposal payload relay via `proposalPayload` mapping (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:312`) resolved by `createDiscoveryLifecycleOutputPayloadResolver` (`src/modules/discovery/application/discovery-production-cell-installation.ts:404-412`, wired `src/app/product-lifecycle-runtime.ts:910-914`); (d) Formalization settlement re-reads the certificate by exact ref + hash to resolve the constraint register (`src/modules/formalization/application/formalization-production-cell-installation.ts:659-690`) |
| 10. backward obligations | both cells' final acceptance; `assertOrderConstraintUnknownsLifted` — every proposal unknown must appear as an open-question register entry (m1 red) (`src/modules/discovery/application/discovery-production-cell-installation.ts:236-239`); pinned lifecycle read must exist (fail-closed, `src/modules/discovery/application/discovery-production-cell-installation.ts:523`); a required classification (e.g. `runnable-local`) without its declared injection table is a typed red (m4, `src/modules/discovery/application/discovery-production-cell-installation.ts:550-562`); duplicate table refs rejected (`src/modules/discovery/application/discovery-production-cell-installation.ts:531-549`); digest pin verified (`src/modules/discovery/application/discovery-production-cell-installation.ts:563-575`) |
| 11. scripted outside participant | none needed for the kernel (inputs come from the two scripted cells); lifecycle classification/injection behavior exercised by `tests/discovery/d7-settlement-lifecycle-classification.test.mjs` (`file-exists`) and by golden-path constraint-register scripts (`tests/factory-contract/golden-path-scenarios.mjs:25-78`, FLAKY-quarantined host) |
| 12. tests / CI | policy/atomicity/persistence/recovery suites `file-exists` (not CI-hosted): `tests/discovery/d4-settlement-policy.test.mjs`, `d4-settlement-atomicity.test.mjs`, `d4-settlement-persistence.test.mjs`, `d4-settlement-recovery.test.mjs`, `d7-settlement-lifecycle-classification.test.mjs`; handoff proof `matrix-hosted`+`CI-executed`: `tests/process-modules/discovery-output-handoff.test.mjs` (group `process-modules`, `tools/run-acceptance-matrix.mjs:83-117`, step `.github/workflows/ci.yml:77-78`); scenario evidence `demonstrated`: `tests/factory-evidence/discovery/discovery_happy-{go,clarify,reject}.json`, `discovery_restart-idempotency.json` |
| 13. uncovered | third-lifecycle-run capsule-binder/baseline behavior flagged by the conformance status (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1599-1608`) touches Discovery replay selection, not settlement — no CI-hosted proof; settlement-under-DB-failure (crash between certificate insert and NodeRun completion) is only in quarantined/FLAKY hosts |

### Card D-4 — `complete-go` / `complete-clarify` / `complete-reject` / `complete-failed` (kernel terminals)

| Field | Content |
|---|---|
| 1. id / kind | four terminal nodes, kind `kernel`, handler `process-outcome-emitter`, one per outcome code (`src/process-modules/modules/discovery/discovery-process-module.ts:119-127`, terminalNodeIds `src/process-modules/modules/discovery/discovery-process-module.ts:139-141`) |
| 2. roles | runtime-owned generic handler (registered by runtime, not the module; exclusion note `src/process-modules/modules/discovery/package/manifest.ts:89-96`) |
| 3. input authority / cardinality | one inbound transition each from `settle` (go/clarify/reject/failed) or from cells (failed) (`src/process-modules/modules/discovery/discovery-process-module.ts:129-137`) |
| 4. tools / protocol | none |
| 5. output authority / schema | local ProcessOutcome with the outcome code; module outcome contract is the certificate (`src/process-modules/modules/discovery/discovery-process-module.ts:58`); terminal outcomes declared terminal (`src/process-modules/modules/discovery/discovery-process-module.ts:59-64`) |
| 6. gates | none (emitters) |
| 7. repair / retry | none; terminal monotonicity owned by runtime |
| 8. state / effects | ProcessRun terminal + settlement/routing obligation (runtime-owned); `failed` route is lifecycle-terminal `failed` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:329-338`) |
| 9. forward consumers | lifecycle `outcomeRoutes`: `go/clarify/reject` → stage `solution-formalization`; `failed` → terminal status `failed` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:314-339`; product-build variant inherits, `src/process-modules/lifecycles/product-build-lifecycle.ts:30-45`) |
| 10. backward obligations | settlement/cell completion with matching event; output mapping requires `certificate.*` and `proposal.*` keys present for non-failed outcomes (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:303-313`; failed-run step-aside `src/modules/discovery/application/discovery-production-cell-installation.ts:376-383`) |
| 11. scripted outside participant | outcome-edge handlers exercised by W9 harness `tests/factory-e2e/w9-04-outcome-edge-handlers.mjs` (`file-exists`) and corpus `discovery_proposal-*` retry-exhaustion analogues |
| 12. tests / CI | outcome routing `matrix-hosted`+`CI-executed`: `tests/factory-contract/lifecycle-outcome-routes.test.mjs` (group `factory-contract`, `tools/run-acceptance-matrix.mjs:79-82`, step `.github/workflows/ci.yml:74-75`); unreachable-edge honesty documented at `docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md` (referenced from `src/modules/discovery/domain/discovery-domain-contracts.ts:88-91`) — `file-exists` |
| 13. uncovered | concurrent duplicate terminal emission racing obligation re-drive is covered only at runtime-layer tests outside this stratum |

## WORKSHOP EXIT CONTRACT

- Exit condition (declared): "Discovery has an immutable local outcome and certificate
  lineage" (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:341`).
- Exit artifacts: terminal outcome code + content-addressed certificate
  (`ref = certificate:<id>`, `digest = certificateHash`,
  `src/modules/discovery/application/discovery-production-cell-installation.ts:292-296`) and the accepted proposal product
  projection (`src/modules/discovery/application/discovery-production-cell-installation.ts:364-401`; exact-digest selection
  after repair rounds `src/modules/discovery/application/discovery-production-cell-installation.ts:426-434`).
- Output mapping keys: `decision`, `authority`, `certificate.schema/ref/hash`,
  `proposal.schema/ref/hash`, `proposalPayload` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:303-313`).
- A `failed` Discovery produces NO certificate/proposal keys by construction and routes
  lifecycle-terminal (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:329-338`) — the mapping tolerates
  its absence via the resolver step-aside
  (`src/modules/discovery/application/discovery-production-cell-installation.ts:376-383`).

## DOWNSTREAM CONTRACT (producer → bridge → consumer)

Edge E1: Discovery cells → certificate (intra-workshop):
`settle` kernel → bridge: certificate repository + output mapping
(`src/process-modules/lifecycles/product-delivery-lifecycle.ts:303-313`) → consumer: Formalization stage input mapping.

Edge E2 (the cross-workshop edge proof):

- **producer:** Discovery `complete-go|clarify|reject` terminal with certificate +
  accepted proposal payload (`src/modules/discovery/application/discovery-production-cell-installation.ts:282-309`).
- **bridge_e:** the lifecycle output/input mapping pair plus two installed resolvers:
  `createDiscoveryOutputResolver` (ProcessRun output = exact accepted proposal product,
  schema+digest matched, `src/modules/discovery/application/discovery-production-cell-installation.ts:364-401`) and
  `createDiscoveryLifecycleOutputPayloadResolver` (exact payload dereference,
  `src/modules/discovery/application/discovery-production-cell-installation.ts:404-412`), wired in composition (`src/app/product-lifecycle-runtime.ts:910-914`);
  stage mapping `discoveryCertificateRef/Hash`, `discoveryProposalRef/Hash`,
  `discoveryProposalPayload` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:351-356`).
- **consumer:** Formalization `FormalizationCase`
  (`src/process-modules/lifecycles/product-delivery-module-contracts.ts:62`;
  shape `src/modules/formalization/domain/formalization-schemas.ts:44-57`), whose
  settlement re-verifies the certificate by exact ref AND hash before trusting the
  constraint register (`src/modules/formalization/application/formalization-production-cell-installation.ts:659-690`).
- **binding preservation:** all selection is by exact ref + content digest; no
  latest/recency anywhere on the path (`src/modules/discovery/application/discovery-production-cell-installation.ts:426-434`,
  `src/modules/discovery/application/discovery-production-cell-installation.ts:462-495`). Edge proof status: **PROVEN (declared + matrix-hosted)** —
  `tests/process-modules/discovery-output-handoff.test.mjs`.

Edge E3: proposal unknowns → constraint register → Formalization warrant:
producer: proposal payload `unknowns`/`order_constraints`
(`src/modules/discovery/domain/discovery-domain-contracts.ts:97-108`); bridge: settlement register build V2 + m1
conservation assertion (`src/modules/discovery/application/discovery-production-cell-installation.ts:230-239`) frozen into
the certificate with digest-pinned injection tables (`src/modules/discovery/application/discovery-production-cell-installation.ts:244-271`; table
`src/process-modules/lifecycles/product-build-lifecycle.ts:64-92`); consumer: Formalization settlement warrantRef +
cross-bind (`src/modules/formalization/application/formalization-production-cell-installation.ts:267-322`). Status:
**PROVEN (declared + matrix-hosted)** via
`tests/process-modules/formalization-warrant-ref.test.mjs` and
`tests/matrix/e-constraint-loss.test.mjs` (group `process-modules`).

## DEAD / DECLARATIVE-ONLY STRATA

1. **Legacy ControlIntent mini-orchestrator handlers (dead in live composition).**
   `createDiscoveryKernelHandlers` registers six handlers
   (`discovery-resolve-proposal-submission`, `-prepare-normalization`,
   `-resolve-normalized-proposal`, `-prepare-readiness`, `-resolve-readiness`,
   `discovery-settlement-policy`)
   (`src/modules/discovery/application/discovery-installation.ts:122-141`). The live
   composition registers ONLY the production-cell settlement handler
   (`src/modules/discovery/index.ts:48-58`); no production call site invokes
   `createDiscoveryKernelHandlers` (its only caller is the package adapter
   `src/process-modules/modules/discovery/package/contributions/handler-adapter.ts:241`,
   itself never invoked by composition). Evidence: `declared` + absence of call site.
2. **Legacy settlement service (dead).** `FactoryDiscoverySettlementService` is defined
   (`src/modules/discovery/application/discovery-settlement-service.ts:158-159`) but has
   no production construction site; the live settlement handler embeds the policy
   directly (`src/modules/discovery/application/discovery-production-cell-installation.ts:151-212`). `declared`.
3. **Legacy MCP discovery tools (dead surface).** `src/tools/discovery-proposal-tools.ts`,
   `src/tools/discovery-normalization-tools.ts`, `src/tools/discovery-readiness-tools.ts`
   (tool arg helpers in `src/tools/discovery-tool-args.ts`) are not imported by the MCP
   server composition (`src/index.ts:14-52` imports none of them); live cells submit via
   `product_submit` (`src/tools/products.ts:285`) and `process_node_submit`
   (`src/tools/process-node-submissions.ts:85`). They remain referenced by
   `tests/discovery/*` suites. `file-exists` + `declared`.
4. **Legacy discovery runtime persistence (shared substrate, not a Discovery flow
   element).** `SqliteFactoryDiscoveryRuntime` is still constructed as shared
   `runtimePersistence` (`src/app/product-lifecycle-runtime.ts:349-350`) for
   workplace/task projection, but the D1/D2/D3 ControlIntent methods it backs are
   reachable only from the dead handlers (§6.1). `declared`.
5. **Diagnosis lane (deleted from flow; resources declarative-only).** Diagnosis flow
   node and domain files were removed
   (`src/modules/discovery/domain/discovery-domain-contracts.ts:700-702`); the package manifest still pins
   `discovery.skill.diagnosis-advisor`, diagnosis call/tracker/checklist resources with
   `pending@wave-2` digests (`src/process-modules/modules/discovery/package/manifest.ts:196-199`,
   `src/process-modules/modules/discovery/package/manifest.ts:307-325`), and normalizer resources for a lane no live profile references
   (`src/process-modules/modules/discovery/package/manifest.ts:188-191`, `src/process-modules/modules/discovery/package/manifest.ts:269-287`). `declared`.
6. **Package manifest handler pins (stale vs live).** `DISCOVERY_HANDLER_IDS` +
   `DISCOVERY_HANDLER_REFS` pin six handler ids and the digest of
   `discovery-installation.ts` (`src/process-modules/modules/discovery/package/manifest.ts:97-104`, `src/process-modules/modules/discovery/package/manifest.ts:360-388`), while the live
   `discovery-settlement-policy` handler bytes come from
   `discovery-production-cell-installation.ts` (`src/modules/discovery/index.ts:48-58`).
   The architecture suite enshrines the legacy pin
   (`tests/architecture/handler-digest-runtime-consistency.test.mjs:25-30`). `declared` +
   `CI-executed` (for the pin itself, not for live-handler equivalence).
7. **Pending contract digests.** Input/output ContractRefs carry
   `CONTRACT_REF_PENDING_DIGEST` placeholders (`src/process-modules/modules/discovery/package/manifest.ts:399-420`). `declared`.

## TEST COVERAGE

- `CI-executed` (blocking, `.github/workflows/ci.yml`):
  - `factory-proof` group (`.github/workflows/ci.yml:123-124`; group def
    `tools/run-acceptance-matrix.mjs:131-160`): discovery scenario pack validation
    (`tests/factory-proof/discovery-scenario-pack.test.mjs` — 8 scenarios validate against
    the unified KernelScenario contract, header `tests/factory-proof/discovery-scenario-pack.test.mjs:1-6`), discovery resilience pack,
    workshop inventory non-vacuity (`tests/factory-proof/workshop-inventory.test.mjs:17-45`).
  - `process-modules` group (`.github/workflows/ci.yml:77-78`): Discovery→Formalization output handoff
    (`tests/process-modules/discovery-output-handoff.test.mjs`).
  - `factory-contract` group (`.github/workflows/ci.yml:74-75`): production-cell transitions, outcome
    routes, recovery feedback trajectory suites.
  - `architecture` group (`.github/workflows/ci.yml:65-66`): ADR-053 material-authority ratchet
    (`tests/architecture/adr-053-material-authority-ratchet.test.mjs`), handler digest
    pins (`tests/architecture/handler-digest-runtime-consistency.test.mjs`).
- `matrix-hosted` (group-hosted or corpus): scenario evidence bundles
  `tests/factory-evidence/discovery/*.json` (schema
  `factory.proof.scenario-evidence-bundle.v1`, seen in
  `tests/factory-evidence/discovery/discovery_happy-go.json:1-30`; inventory rows
  `tests/factory-proof/workshop-inventory.baseline.json:4-22`).
- `demonstrated` (committed artifacts, no CI host): W9 harness outcome-edge handlers
  (`tests/factory-e2e/w9-04-outcome-edge-handlers.mjs`).
- `file-exists` only (local, not CI-hosted): `tests/discovery/*.test.mjs` (20 files, incl.
  all d1–d7 suites) and `tests/modules/discovery/*.test.mjs` — no matrix group globs
  them (`tools/run-acceptance-matrix.mjs:64-163`).
- Quarantined hosts: `tests/factory-contract/golden-path.test.mjs` is FLAKY-quarantined
  (`tools/run-acceptance-matrix.mjs:175-181`) — its scenarios are `file-exists` /
  `demonstrated`, never `CI-executed`.

## UNCOVERED CONDITIONS

1. No CI-hosted suite drives the two live cells end-to-end through a REAL model or
   scripted worker with current composition (golden path FLAKY-quarantined; W9 harness
   out of matrix scope by design, `ci.yml` CI-02 commentary lines 39-54).
2. Repair-after-reject proposal selection (two immutable rows, exact-digest match) is
   covered by resolver code + unit tests only (`src/modules/discovery/application/discovery-production-cell-installation.ts:426-434`);
   no CI-hosted scenario exercises a THIRD proposal row.
3. Settlement crash-window (certificate issued, NodeRun not completed) — only
   quarantined/FLAKY hosts.
4. Concurrent `clarify`-then-restart of the same epic on lifecycle v2 injections: no
   CI-hosted scenario.
5. The readiness advisor's allowed-source grounding is ref-citation only; no check proves
   cited evidence content authenticity (`src/modules/discovery/application/discovery-check-providers.ts:180-190`).

## CONTRADICTIONS

1. **Handler identity collision (two modules, one handler id).** Both
   `src/modules/discovery/application/discovery-installation.ts:139` (dead) and
   `src/modules/discovery/application/discovery-production-cell-installation.ts:144` (live) define a handler registered
   under `discovery-settlement-policy` with different signatures and different
   certificate payloads. Normative model: one authority per id
   (`docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md:229-233`). Live resolution is safe only because the dead
   factory is never registered; the package manifest + architecture suite still pin the
   dead module's digest (`src/process-modules/modules/discovery/package/manifest.ts:360-364`;
   `tests/architecture/handler-digest-runtime-consistency.test.mjs:26`). Recorded as a
   map-equality defect (mapped live card D-3 ≠ manifest-declared handler surface).
2. **Manifest declares six handlers; the installed flow declares one kernel node.** The
   manifest comment claims each pinned id "matches the `handler:` field on the
   corresponding kernel node in discovery-process-module.ts"
   (`src/process-modules/modules/discovery/package/manifest.ts:89-96`), but the flow has exactly one module-owned kernel node
   (`src/process-modules/modules/discovery/discovery-process-module.ts:109-118`). Five pinned ids have no node. Contradicts
   the map equality target (contract §6).
3. **Resource index pins skills/tracker/checklists for lanes the live flow does not
   reference** (normalizer, diagnosis; `src/process-modules/modules/discovery/package/manifest.ts:269-287`, `src/process-modules/modules/discovery/package/manifest.ts:307-325`) while the two
   live profiles' resources are pinned only partially (no `discovery.tracker.*` entries
   for proposal-stage tracker pinning differences vs `src/process-modules/modules/discovery/discovery-process-module.ts:24-27`).
   Declarative surface ≠ installed surface.
4. **Dangling spec/provenance references.** The package manifest cites its governing
   spec `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`
   (`src/process-modules/modules/discovery/package/manifest.ts:4-5`), but no `docs/refactor-management/` directory exists in the tree
   (`file-exists` absence). Likewise the dead installation module still documents its
   content as living in `src/saga3/` (`src/modules/discovery/application/discovery-installation.ts:11`, `src/modules/discovery/application/discovery-installation.ts:40`) — a
   directory that no longer exists. The declarations cannot be audited against their
   cited sources at this commit.
