# 02 — Formalization Stratum Map

- **Status:** hypothesis over commit `586871ad` (branch `map/discovery-formalization-2026-08-23`)
- **Shared contract:** `docs/factory-map/00_FACTORY_CONTRACT.md` (card schema §7, evidence labels §5)
- **Prohibited sources:** no forward/reverse graph file was read or written (contract §1/§9).
- Module identity: `solution-formalization@1.0.0`
  (`src/process-modules/lifecycles/product-delivery-module-contracts.ts:35-38`).
- Live surface assertion: the production composition registers Formalization exactly
  through `registerFormalization` (`src/modules/formalization/index.ts:41-101`, called at
  `src/app/product-lifecycle-runtime.ts:898`): five reviewed production cells, two kernel
  handlers, six workshop check providers, one post-acceptance effect. Everything else in
  `src/modules/formalization/**` and `src/process-modules/modules/formalization/package/nodes/**`
  is strata (§6).

## PURPOSE

Formalization converts the accepted discovery subject into a frozen, traceable,
implementable Solution Contract: product contract (PRD/FR/NFR/RULE), use cases,
acceptance criteria, an explicit WHAT reconciliation, a frozen acceptance baseline, an
SRS/HOW architecture contract, and a deterministic settlement certificate
(`src/process-modules/modules/formalization/formalization-process-module.ts:135-157`).
Every cognitive desk is a universal reviewed Production Cell; structural/domain
validation is a package CheckProvider inside the author gate; independent semantic
review is a reviewer desk whose immutable verdict the final gate consumes — "There are
no LM/resolver pairs and no FlowRecovery machine" (`src/process-modules/modules/formalization/formalization-process-module.ts:135-142`).

## ENTRY CONTRACT

- Stage `solution-formalization` input mapping builds the `FormalizationCase`:
  `schemaVersion` literal `factory.formalization-case.v1`, runtime epic ids,
  `discoveryCertificateRef/Hash` and `discoveryProposalRef/Hash` and
  `discoveryProposalPayload` from `$.stages.initial-discovery.*`, `initiativeSubject`,
  `initiatedBy` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:347-359`).
- Entry condition (declared): "Discovery certificate ref and hash exist"
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:376`).
- Case shape: `discoveryEpicId`, `formalizationEpicId`, `discoveryCertificateRef/Hash`,
  `discoveryOutcome`, `discoveryProposalRef/Hash/Payload`, `initiativeSubject`,
  `initiatedBy`, optional constraint-register binding
  (`src/modules/formalization/domain/formalization-schemas.ts:44-63`).
- The case's register authority is re-derived at settlement from the discovery
  CERTIFICATE by exact ref + hash — never from worker-rebuilt data
  (`src/modules/formalization/application/formalization-production-cell-installation.ts:650-690`).
- Package install: `formalizationPackageManifest` installed by
  `installProductionModules` (`src/orchestrate-cli.ts:885-897`) — `declared`.

## LIVE PRODUCTION NODE / DESK CARDS

Shared cell shape (applies to F-1..F-4, F-6): all five desks are `reviewedCell`s —
author gate = `<cell>.author` phase, final gate = `<cell>.final` with review verdict
provider; `maxAttempts = FORMALIZATION_RECOVERY_MAX_ATTEMPTS = 5`, `onExhausted:
'requeue'`; post-acceptance effect `formalization.accept-exact-products.v1` on every
cell (`src/process-modules/modules/formalization/formalization-process-module.ts:52-56`, `src/process-modules/modules/formalization/formalization-process-module.ts:94-133`). Reviewer verdict payload
contract is digest-pinned (`src/process-modules/modules/formalization/formalization-process-module.ts:120-128`). The final review
plan routes failure→`repairTargetRole: author` and indeterminate→`reviewer`
(`src/process-modules/modules/formalization/formalization-process-module.ts:83-92`).

### Card F-1 — `define-product-contract` (reviewed cell `formalization-product-contract`)

| Field | Content |
|---|---|
| 1. id / kind | node `define-product-contract`, kind `production-cell`, cell `formalization-product-contract` (`src/process-modules/modules/formalization/formalization-process-module.ts:162-177`) |
| 2. roles | author profile `formalization-product` (skill `saga-product`); reviewer profile `formalization-requirements-reviewer` (skill `saga-requirements-reviewer`) (`src/process-modules/modules/formalization/formalization-process-module.ts:169-176`, `src/process-modules/modules/formalization/formalization-process-module.ts:324`, `src/process-modules/modules/formalization/formalization-process-module.ts:337`) |
| 3. input authority / cardinality | FormalizationCase (stage mapping); author desk reads artifacts/traces/notes via `COMMON_READ_TOOLS` (`src/process-modules/modules/formalization/formalization-process-module.ts:58-61`); output cardinality `'1'` (`src/process-modules/modules/formalization/formalization-process-module.ts:112`) |
| 4. tools / protocol | author allowedTools `COMMON_WRITE_TOOLS` = read tools + `artifact_create, artifact_update, trace_add, trace_delete, worker_done, Write, Edit` (shell deliberately excluded, `src/process-modules/modules/formalization/formalization-process-module.ts:62-70`); reviewer `REVIEW_TOOLS` = read tools + `candidate_read, product_read, product_submit, worker_done` (`src/process-modules/modules/formalization/formalization-process-module.ts:71-74`); protocol skill `saga-process-module-worker-protocol` (`src/process-modules/modules/formalization/formalization-process-module.ts:51`); tracker/checklist/call templates (`src/process-modules/modules/formalization/formalization-process-module.ts:42-49`, `src/process-modules/modules/formalization/formalization-process-module.ts:362-364`) |
| 5. output authority / schema | exactly one `factory.formalization-product-bundle.v1` (`src/modules/formalization/domain/formalization-schemas.ts:20`; bundle schema pinned `src/process-modules/modules/formalization/formalization-process-module.ts:173`); bundle carries PRD+FR/NFR/RULE artifacts and root lineage (`src/process-modules/modules/formalization/formalization-process-module.ts:167`) |
| 6. gates | author gate check = submission-validator provider `formalization.product-contract.v1@1.1.0` over node `define-product-contract`, `requireManagedProduction: true` (`src/modules/formalization/application/formalization-check-providers.ts:19-24`, `src/modules/formalization/application/formalization-check-providers.ts:40`; refs `src/modules/formalization/application/formalization-check-refs.ts:20-25`); final gate = `factory.review-verdict.v1` provider (`src/process-modules/modules/formalization/formalization-process-module.ts:83-92`; provider ids `src/process-modules/application/review-verdict-check-provider.ts:17-26`) |
| 7. repair / retry | cell `maxAttempts: 5`, `onExhausted: 'requeue'` (`src/process-modules/modules/formalization/formalization-process-module.ts:113-114`); rationale: author-gate repair + reviewer-driven revision bounded (`src/process-modules/modules/formalization/formalization-process-module.ts:52-56`); profile retry `{maxAttempts:5, retryOn:['gate-repair']}` (`src/process-modules/modules/formalization/formalization-process-module.ts:366`) |
| 8. state / effects | durable: artifacts/traces rows, managed submissions, CandidateSets, GateDecisions; post-acceptance effect accepts exact artifacts (hash CAS) into `accepted/clean` (`src/modules/formalization/application/formalization-accept-products-effect.ts:69-171`); drift pre-pass returns typed `repair_required` (`src/modules/formalization/application/formalization-accept-products-effect.ts:95-128`); failure branch → `complete-failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:280`) |
| 9. forward consumers | `model-use-cases` cell (transition `domain.accepted`, `src/process-modules/modules/formalization/formalization-process-module.ts:279`); settlement bundle reads accepted prd/frs/nfrs/rules (`src/modules/formalization/application/formalization-production-cell-installation.ts:409-427`); baseline/settlement read lifecycle-scoped accepted artifacts (`src/modules/formalization/application/formalization-production-cell-installation.ts:237`) |
| 10. backward obligations | discovery certificate + proposal hash-verified (entry mapping `src/process-modules/lifecycles/product-delivery-lifecycle.ts:351-356`); PRD must carry a non-product root `derived_from` trace (brief lineage; corpus scenario `formalization_product-missing-brief-lineage-repair`) |
| 11. scripted outside participant | `formalization/product-*` scripts in the corpus: worker-crash, retry-exhaustion, stale-execution-fence, missing-brief-lineage-repair (`tests/factory-evidence/formalization/formalization_product-*.json`); deterministic author/reviewer scripts drive real MCP boundaries (`tests/factory-contract/golden-path-scenarios.mjs:1-13`) |
| 12. tests / CI | corpus `matrix-hosted`/`demonstrated` (`tests/factory-evidence/formalization/formalization_product-*.json`); CI-hosted: constraint relay `tests/process-modules/formalization-constraint-coverage.test.mjs`, hashes `formalization-solution-contract-hashes.test.mjs`, manifest `formalization-package-manifest.test.mjs`, warrant `formalization-warrant-ref.test.mjs` (group `process-modules`, `tools/run-acceptance-matrix.mjs:83-117`, step `.github/workflows/ci.yml:77-78`); resilience pack CI-hosted (`tests/factory-proof/formalization-resilience-pack.test.mjs`, step `.github/workflows/ci.yml:123-124`) — `CI-executed` |
| 13. uncovered | author-desk concurrent duplicate artifacts; validator version drift between `FORMALIZATION_SUBMISSION_VALIDATOR_VERSION` and per-validator stamps is guarded only by comment contract (`src/modules/formalization/application/formalization-check-refs.ts:6-16`) |

### Card F-2 — `model-use-cases` (reviewed cell `formalization-use-cases`)

| Field | Content |
|---|---|
| 1. id / kind | node `model-use-cases`, kind `production-cell`, cell `formalization-use-cases` (`src/process-modules/modules/formalization/formalization-process-module.ts:178-192`) |
| 2. roles | author `formalization-use-cases` (skill `saga-analyst`); reviewer `formalization-requirements-reviewer` (`src/process-modules/modules/formalization/formalization-process-module.ts:184-191`, `src/process-modules/modules/formalization/formalization-process-module.ts:325`, `src/process-modules/modules/formalization/formalization-process-module.ts:337`) |
| 3. input authority / cardinality | accepted product-contract artifacts (transition `domain.accepted` from F-1, `src/process-modules/modules/formalization/formalization-process-module.ts:279`); read via `COMMON_READ_TOOLS`; output cardinality `'1'` |
| 4. tools / protocol | same shared author/reviewer tool surfaces as F-1 (`src/process-modules/modules/formalization/formalization-process-module.ts:58-74`, `src/process-modules/modules/formalization/formalization-process-module.ts:360-364`, `src/process-modules/modules/formalization/formalization-process-module.ts:386-391`) |
| 5. output authority / schema | exactly one `factory.formalization-use-case-bundle.v1` (`src/modules/formalization/domain/formalization-schemas.ts:21`) covering the product requirements (`src/process-modules/modules/formalization/formalization-process-module.ts:182`) |
| 6. gates | author gate provider `formalization.use-cases.v1@1.1.0` (`src/modules/formalization/application/formalization-check-providers.ts:25-30`, `src/modules/formalization/application/formalization-check-providers.ts:41`); final review-verdict gate (shared) |
| 7. repair / retry | shared reviewed-cell budgets (5 / requeue) |
| 8. state / effects | artifacts (UC) + traces; shared accept-products effect; failure → `complete-failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:282`) |
| 9. forward consumers | `define-acceptance-contract` (`src/process-modules/modules/formalization/formalization-process-module.ts:281`); settlement bundle `ucArtifactIds` (`src/modules/formalization/application/formalization-production-cell-installation.ts:421`) |
| 10. backward obligations | F-1 acceptance; UC→FR coverage enforced by validator options `{product: true, useCases: true}` (`src/modules/formalization/application/formalization-check-providers.ts:25-30`); corpus scenario `use-cases-missing-fr-coverage-repair` |
| 11. scripted outside participant | `formalization_useCases-*` and `formalization_use-cases-*` corpus scripts (`tests/factory-evidence/formalization/`) |
| 12. tests / CI | corpus `matrix-hosted`/`demonstrated`; node-protocol data test `tests/process-modules/formalization-use-case-node-protocol.test.mjs` (`CI-executed`, group `process-modules`) — but the protocol itself is strata (§6.4) |
| 13. uncovered | UC cardinality vs AC derivation beyond validator shape checks; heading-resolution drift for UC docs (covered for AC only, `tests/modules/formalization/acceptance-heading-resolution.test.mjs`, `file-exists`) |

### Card F-3 — `define-acceptance-contract` (reviewed cell `formalization-acceptance-contract`)

| Field | Content |
|---|---|
| 1. id / kind | node `define-acceptance-contract`, kind `production-cell`, cell `formalization-acceptance-contract` (`src/process-modules/modules/formalization/formalization-process-module.ts:193-207`) |
| 2. roles | author `formalization-acceptance` (skill `saga-analyst`); reviewer `formalization-requirements-reviewer` (`src/process-modules/modules/formalization/formalization-process-module.ts:199-206`, `src/process-modules/modules/formalization/formalization-process-module.ts:326`, `src/process-modules/modules/formalization/formalization-process-module.ts:337`) |
| 3. input authority / cardinality | accepted UC + product artifacts; output cardinality `'1'` |
| 4. tools / protocol | shared author/reviewer surfaces (`src/process-modules/modules/formalization/formalization-process-module.ts:58-74`) |
| 5. output authority / schema | exactly one `factory.formalization-acceptance-bundle.v1` (`src/modules/formalization/domain/formalization-schemas.ts:22`) — AC derived from UC/FR/NFR (`src/process-modules/modules/formalization/formalization-process-module.ts:196`) |
| 6. gates | author gate provider `formalization.acceptance-contract.v1` at the ACCEPTANCE validator version (heading-resolution gate 1.2.0, `src/modules/formalization/application/formalization-check-refs.ts:10-15`, `src/modules/formalization/application/formalization-check-refs.ts:32-37`); provider registered with `createAcceptanceContractValidator` (`src/modules/formalization/application/formalization-check-providers.ts:31`, `src/modules/formalization/application/formalization-check-providers.ts:42`) |
| 7. repair / retry | shared reviewed-cell budgets (5 / requeue) |
| 8. state / effects | AC artifacts + traces; shared accept-products effect (coverage metadata `covered_constraint_ids` frozen later by the baseline, Card F-5); failure → `complete-failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:284`) |
| 9. forward consumers | `reconcile-what` (`src/process-modules/modules/formalization/formalization-process-module.ts:283`); baseline freezer (lifecycle-scoped accepted ACs, `src/modules/formalization/application/formalization-production-cell-installation.ts:124-143`); settlement bundle `acArtifactIds` (`src/modules/formalization/application/formalization-production-cell-installation.ts:422`) |
| 10. backward obligations | F-1/F-2 acceptance; AC heading resolution unique codes (freezer enforces uniqueness, `src/modules/formalization/application/formalization-production-cell-installation.ts:159-161`) |
| 11. scripted outside participant | `formalization_acceptance-*` corpus: worker-crash, retry-exhaustion, missing-trace-repair, heading-mismatch-repair |
| 12. tests / CI | corpus `matrix-hosted`/`demonstrated`; heading resolution unit suite `tests/modules/formalization/acceptance-heading-resolution.test.mjs` is `file-exists` only |
| 13. uncovered | dotted-children/standalone level-two AC edge variants are enforced by freezer code but have no CI-hosted scenario |

### Card F-4 — `reconcile-what` (reviewed cell `formalization-reconciliation`)

| Field | Content |
|---|---|
| 1. id / kind | node `reconcile-what`, kind `production-cell`, cell `formalization-reconciliation` (`src/process-modules/modules/formalization/formalization-process-module.ts:208-231`) |
| 2. roles | author `formalization-reconciler` (skill `saga-reconciler`); reviewer `formalization-requirements-reviewer` (`src/process-modules/modules/formalization/formalization-process-module.ts:215-230`, `src/process-modules/modules/formalization/formalization-process-module.ts:327-332`) |
| 3. input authority / cardinality | accepted WHAT graph (product/UC/AC); output cardinality `'1'`; a no-op report is a lawful output (`src/process-modules/modules/formalization/formalization-process-module.ts:210-213`) |
| 4. tools / protocol | author tools = `COMMON_WRITE_TOOLS` + `product_submit` (typed report channel, `src/process-modules/modules/formalization/formalization-process-module.ts:328-331`); templates incl. `reconciliation-product-call-template.json` |
| 5. output authority / schema | exactly one `factory.formalization-reconciliation-report.v1` (`src/modules/formalization/domain/formalization-schemas.ts:23`) with payload contract pinned at the `product_submit` intake: `FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_ID/VERSION/DIGEST` (`src/process-modules/modules/formalization/formalization-process-module.ts:222-230`; digest `src/modules/formalization/application/reconciliation-payload-contract.ts:33-47`) |
| 6. gates | author gate provider `formalization.reconciliation.v1@1.1.0`, `requireManagedProduction: false` (typed report, not managed artifacts — `src/modules/formalization/application/formalization-check-providers.ts:32-37`, `src/modules/formalization/application/formalization-check-providers.ts:43`; `src/modules/formalization/application/formalization-check-refs.ts:38-43`); final review-verdict gate (shared) |
| 7. repair / retry | shared reviewed-cell budgets (5 / requeue) |
| 8. state / effects | the accept-products effect SKIPS reconciliation products (typed report has no artifacts to accept, `src/modules/formalization/application/formalization-accept-products-effect.ts:88-91`); failure → `complete-failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:286`) |
| 9. forward consumers | `freeze-acceptance-baseline` reads the exact reconciliation production (`src/modules/formalization/application/formalization-production-cell-installation.ts:181-187` requires `sourceReconciliationRef/Hash`); transition `domain.accepted` (`src/process-modules/modules/formalization/formalization-process-module.ts:285`) |
| 10. backward obligations | F-3 acceptance; the report must be the cell's declared output — payload shape rejected at intake before authority (`src/process-modules/modules/formalization/formalization-process-module.ts:222-229`) |
| 11. scripted outside participant | `formalization_reconciliation-*` corpus: worker-crash, retry-exhaustion, duplicate-submit, malformed-report-rejected, late-tool-call |
| 12. tests / CI | corpus `matrix-hosted`/`demonstrated`; payload-contract intake covered by corpus + CI resilience pack |
| 13. uncovered | reconciliation repairing AC while a parallel baseline re-freeze runs (idempotent-freeze replay covered; concurrent race not CI-hosted, replayed flag `src/modules/formalization/application/formalization-production-cell-installation.ts:207`) |

### Card F-5 — `freeze-acceptance-baseline` (kernel node, handler `formalization-baseline-freezer`)

| Field | Content |
|---|---|
| 1. id / kind | node `freeze-acceptance-baseline`, kind `kernel`, handler `FORMALIZATION_KERNEL_HANDLER_IDS.freezeBaseline` (`src/process-modules/modules/formalization/formalization-process-module.ts:232-240`; ids `src/modules/formalization/application/formalization-production-cell-installation.ts:90-93`) |
| 2. roles | kernel (deterministic); registered live at `src/modules/formalization/index.ts:71-80` |
| 3. input authority / cardinality | exactly one accepted reconciliation production (`requireProduction(ctx.input, 'reconcile-what')`, `src/modules/formalization/application/formalization-production-cell-installation.ts:181-187`); lifecycle-scoped accepted AC set for THIS run (`readAcceptedArtifactsForLifecycle`, ADR-078 K6 scoping, `src/modules/formalization/application/formalization-production-cell-installation.ts:119-124`); ≥1 accepted AC required (`src/modules/formalization/application/formalization-production-cell-installation.ts:125-127`) |
| 4. tools / protocol | none (kernel); reads via `FormalizationArtifactGraphPort`, baseline repository, exact artifact content reader (`src/modules/formalization/application/formalization-production-cell-installation.ts:95-103`; registration `src/modules/formalization/index.ts:71-80`) |
| 5. output authority / schema | `factory.acceptance-baseline-snapshot.v1` (`src/modules/formalization/domain/formalization-schemas.ts:25`; node outputSchema `src/process-modules/modules/formalization/formalization-process-module.ts:239`); payload freezes AC ids/hashes, atomic criteria (code/title/contentHash), optional `coveredConstraints`, `baselineHash` (`src/modules/formalization/application/formalization-production-cell-installation.ts:138-193`); cross-run `semanticDigest` over stable codes+hashes only (`src/modules/formalization/application/formalization-production-cell-installation.ts:180`, `src/modules/formalization/application/formalization-production-cell-installation.ts:741-759`) |
| 6. gates | no GateRun; guard = baseline drift check: any dirty accepted artifact → typed event `drift-detected` (`src/modules/formalization/application/formalization-production-cell-installation.ts:128-137`); accepted artifacts must be `accepted+clean` with `acceptedHash == contentHash` (`src/modules/formalization/application/formalization-production-cell-installation.ts:717-733`) |
| 7. repair / retry | idempotent freeze (`frozen.replayed` binding, `src/modules/formalization/application/formalization-production-cell-installation.ts:194-209`); failure branch → `complete-failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:289`) |
| 8. state / effects | durable baseline snapshot row; transitions: `frozen` → `define-architecture-contract`, `drift-detected` → `complete-inconsistent`, failure → `complete-failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:287-289`) |
| 9. forward consumers | `define-architecture-contract` (inputSchema = baseline snapshot, `src/process-modules/modules/formalization/formalization-process-module.ts:247`); settlement reads the frozen baseline (`src/modules/formalization/application/formalization-production-cell-installation.ts:234-236`, `src/modules/formalization/application/formalization-production-cell-installation.ts:491-501`) and freezes its ref/hash into the Solution Contract (`src/modules/formalization/application/formalization-production-cell-installation.ts:519-520`) |
| 10. backward obligations | F-4 acceptance with exact production ref/hash; AC codes unique across accepted artifacts (`src/modules/formalization/application/formalization-production-cell-installation.ts:159-161`) |
| 11. scripted outside participant | platform fault edges `transition:freeze-acceptance-baseline->complete-inconsistent|failed` and drift fault `effect-fault:formalization-accept-products:post-gate-pre-effect-drift` (`tests/factory-proof/workshop-inventory.baseline.json:48-54`) |
| 12. tests / CI | inventory rows `matrix-hosted`; kernel behavior suites `file-exists` (`tests/process-modules/formalization-*.test.mjs` are CI-hosted via the process-modules group — `formalization-constraint-coverage`, `formalization-solution-contract-hashes`, `formalization-warrant-ref`); drift/D2 repair `demonstrated` via corpus `formalization_architecture-invalid-d2-repair.json` |
| 13. uncovered | baseline freeze with an accepted AC whose content parses to zero criteria AND lacks a stable code (typed throw `src/modules/formalization/application/formalization-production-cell-installation.ts:151-157`) — no CI-hosted scenario |

### Card F-6 — `define-architecture-contract` (reviewed cell `formalization-architecture-contract`)

| Field | Content |
|---|---|
| 1. id / kind | node `define-architecture-contract`, kind `production-cell`, cell `formalization-architecture-contract` (`src/process-modules/modules/formalization/formalization-process-module.ts:241-257`) |
| 2. roles | author `formalization-architect` (skill `saga-architect`, SRS contract pinned `src/process-modules/modules/formalization/formalization-process-module.ts:333-336`; ref `src/modules/formalization/domain/srs-contract.ts:97`); reviewer `formalization-architecture-reviewer` (skill `saga-architecture-reviewer`, `src/process-modules/modules/formalization/formalization-process-module.ts:338`) |
| 3. input authority / cardinality | the FROZEN baseline snapshot (inputSchema `factory.acceptance-baseline-snapshot.v1`, `src/process-modules/modules/formalization/formalization-process-module.ts:247`) — SRS owns decomposition metadata; frozen AC artifacts are never mutated (invariant `formalization.baseline-before-how` / `ac-immutable-after-baseline`, `src/process-modules/modules/formalization/formalization-process-module.ts:319-320`) |
| 4. tools / protocol | shared author/reviewer surfaces; architect profile adds `contractRef: SRS_CONTRACT_REF` (`src/process-modules/modules/formalization/formalization-process-module.ts:333-336`) |
| 5. output authority / schema | exactly one `factory.formalization-architecture-bundle.v1` (`src/modules/formalization/domain/formalization-schemas.ts:24`) containing the SRS/HOW contract (`factory.srs.v1`, `src/modules/formalization/domain/formalization-schemas.ts:26`) |
| 6. gates | author gate provider `formalization.srs-contract.v1` at `SRS_CONTRACT_VALIDATOR_VERSION`, `contractRef: SRS_CONTRACT_REF`, `requireManagedProduction: true` (`src/modules/formalization/application/formalization-check-providers.ts:53-60`; `src/modules/formalization/application/formalization-check-refs.ts:44-50`); final review-verdict gate (shared) |
| 7. repair / retry | shared reviewed-cell budgets (5 / requeue) |
| 8. state / effects | SRS artifact + traces; shared accept-products effect; failure → `complete-failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:291`) |
| 9. forward consumers | `settle-formalization` (`src/process-modules/modules/formalization/formalization-process-module.ts:290`); settlement parses §D2 stanzas and denies downstream binding for any AC §D2 does not decompose (`src/modules/formalization/application/formalization-production-cell-installation.ts:473-478`, `src/modules/formalization/application/formalization-production-cell-installation.ts:529-540`) |
| 10. backward obligations | F-5 `frozen` event (transition `domain.frozen`, `src/process-modules/modules/formalization/formalization-process-module.ts:287`); §D2 required fields, enum validity (`ac_kind ∈ {implementation, verification}`), SRS→PRD trace enforced by the validator (`src/modules/formalization/application/srs-contract-validator.ts`, parser `srs-d2-parser.ts`) |
| 11. scripted outside participant | `formalization_architecture-*` corpus: worker-crash, retry-exhaustion, invalid-d2-repair; reviewer corpus `formalization_reviewer-*.json` (foreign-subject, feedback exact/stale/absent/corrupted) |
| 12. tests / CI | corpus `matrix-hosted`/`demonstrated`; `tests/factory-contract/srs-d2-parser.test.mjs` CI-hosted (group `factory-contract`, step `.github/workflows/ci.yml:74-75`) — `CI-executed` |
| 13. uncovered | §D2 `criticality` fallback to `'blocker'` when stanza omits it (`src/modules/formalization/application/formalization-production-cell-installation.ts:552`) — no scenario pins the default |

### Card F-7 — `settle-formalization` (kernel node, handler `formalization-settlement-policy`)

| Field | Content |
|---|---|
| 1. id / kind | node `settle-formalization`, kind `kernel`, handler `FORMALIZATION_KERNEL_HANDLER_IDS.settle` (`src/process-modules/modules/formalization/formalization-process-module.ts:258-267`) |
| 2. roles | kernel; policy = `ReferenceFormalizationSettlementPolicy` injected at registration (`src/modules/formalization/index.ts:71-80`) |
| 3. input authority / cardinality | FormalizationCase from run input (epic match enforced, `src/modules/formalization/application/formalization-production-cell-installation.ts:230-233`); frozen baseline for THIS run (`src/modules/formalization/application/formalization-production-cell-installation.ts:234-236`); lifecycle-scoped accepted artifacts (`src/modules/formalization/application/formalization-production-cell-installation.ts:237`, TB-11 scoping `src/modules/formalization/application/formalization-production-cell-installation.ts:222-229`, `src/modules/formalization/application/formalization-production-cell-installation.ts:699-715`); architecture bundle input (node inputSchema, `src/process-modules/modules/formalization/formalization-process-module.ts:265`) |
| 4. tools / protocol | none (kernel); graph port + repositories + certificate repo + exact content reader (`src/modules/formalization/application/formalization-production-cell-installation.ts:95-103`) |
| 5. output authority / schema | `factory.solution-contract-certificate.v1` (`src/modules/formalization/domain/formalization-schemas.ts:18`) certificate (schemaVersion `factory.solution-contract-certificate.generic.v1`, `src/modules/formalization/domain/formalization-schemas.ts:27-28`) AND, on `formalized`, the persisted Solution Contract record with exact ref/hash (`src/modules/formalization/application/formalization-production-cell-installation.ts:336-361`) |
| 6. gates | no GateRun; internal guards: disposition freeze validation for v2 registers (`FORMALIZATION_DISPOSITION_FREEZE_INVALID`, `src/modules/formalization/application/formalization-production-cell-installation.ts:283-296`); warrant cross-bind to discovery certificate hash + case identity digest (`verifyWarrantCrossBind`/`verifyWarrantDispositionsBinding`, `src/modules/formalization/application/formalization-production-cell-installation.ts:314-322`); §D2 decomposition + ac_kind validation per criterion (`src/modules/formalization/application/formalization-production-cell-installation.ts:529-540`); register authority resolved from the discovery certificate by exact ref AND hash (`src/modules/formalization/application/formalization-production-cell-installation.ts:659-690`) |
| 7. repair / retry | idempotent persistence (`persisted.replayed`, `src/modules/formalization/application/formalization-production-cell-installation.ts:352-360`); any typed error → `failed` event with error digest (`src/modules/formalization/application/formalization-production-cell-installation.ts:392-405`) |
| 8. state / effects | durable: solution-contract row, outcome certificate, warrantRef {constraintRegisterRef/Digest, dispositionsDigest, cross-bind} (`src/modules/formalization/application/formalization-production-cell-installation.ts:297-334`); no external effects |
| 9. forward consumers | `complete-formalized|inconsistent|failed` (`src/process-modules/modules/formalization/formalization-process-module.ts:292-294`); lifecycle solutionContract mapping (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:360-370`) → Development input mapping (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:383-412`) via `createFormalizationLifecycleOutputPayloadResolver` with exact output verification (`src/modules/formalization/application/formalization-production-cell-installation.ts:583-605`; wired `src/app/product-lifecycle-runtime.ts:915-920`) |
| 10. backward obligations | all five cells' final acceptance; F-5 frozen baseline; discovery certificate resolvable + hash-matched (else typed red, `src/modules/formalization/application/formalization-production-cell-installation.ts:663-685`) |
| 11. scripted outside participant | `formalization_happy-formalized.json`, `formalization_restart-idempotency.json`; fault edges `transition:settle-formalization->complete-inconsistent|failed` (`tests/factory-proof/workshop-inventory.baseline.json:23-54`) |
| 12. tests / CI | `matrix-hosted`+`CI-executed`: `tests/process-modules/formalization-solution-contract-hashes.test.mjs`, `formalization-warrant-ref.test.mjs`, `formalization-constraint-coverage.test.mjs`, `tests/matrix/e-constraint-loss.test.mjs` (groups `process-modules`; steps `.github/workflows/ci.yml:77-78`); corpus `demonstrated` |
| 13. uncovered | settlement reading an epic with accepted material from TWO terminal lifecycle runs of the same epic (the conformance-status residual, `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1599-1608`) — TB-11/ADR-078 scoped reads, but no CI-hosted adversarial scenario for the epic-accumulation seam |

### Card F-8 — `complete-formalized` / `complete-inconsistent` / `complete-failed` (kernel terminals)

| Field | Content |
|---|---|
| 1. id / kind | three terminal nodes, kind `kernel`, handler `process-outcome-emitter` (`src/process-modules/modules/formalization/formalization-process-module.ts:268-276`, terminalNodeIds `src/process-modules/modules/formalization/formalization-process-module.ts:296-298`) |
| 2. roles | runtime-owned generic emitter |
| 3. input authority / cardinality | one inbound transition each (`src/process-modules/modules/formalization/formalization-process-module.ts:292-295`) |
| 4. tools / protocol | none |
| 5. output authority / schema | local ProcessOutcome; module output contract is the Solution Contract certificate (`src/process-modules/modules/formalization/formalization-process-module.ts:152`) |
| 6. gates | none |
| 7. repair / retry | none; terminal monotonicity runtime-owned |
| 8. state / effects | ProcessRun terminal + routing obligation |
| 9. forward consumers | lifecycle routes: `formalized` → stage `solution-development`; `inconsistent` → terminal `formalization-inconsistent`; `failed` → terminal `failed` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:371-375`); product-build variant ends at `runnable-local` downstream (`src/process-modules/lifecycles/product-build-lifecycle.ts:30-45`) |
| 10. backward obligations | settlement event matching the route; output mapping requires certificate + solutionContract keys for `formalized` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:360-370`) |
| 11. scripted outside participant | outcome-edge harness `tests/factory-e2e/w9-04-outcome-edge-handlers.mjs` (`file-exists`) |
| 12. tests / CI | routes CI-hosted: `tests/factory-contract/lifecycle-outcome-routes.test.mjs` (group `factory-contract`) |
| 13. uncovered | `inconsistent` and `failed` produce no Solution Contract — Development entry for them is impossible by mapping absence; no adversarial test tries to force the mapping |

## WORKSHOP EXIT CONTRACT

- Exit condition (declared): "Formalization has a frozen content-addressed Solution
  Contract" (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:377`).
- Exit artifacts (on `formalized`): outcome certificate (`certificate:*` ref + hash),
  Solution Contract record (`outputSchema/outputRef/outputHash` mapping keys,
  `src/process-modules/lifecycles/product-delivery-lifecycle.ts:360-370`), whose payload carries the bundle, artifact
  hashes, trace digest, baseline ref/hash, SRS ref, per-criterion bindings
  (§D2-derived `implementationRequired`, `criticality`, optional `coveredConstraintIds`),
  optional `constraintRegisterCoverage`, and the case identity digest
  (`src/modules/formalization/application/formalization-production-cell-installation.ts:503-560`).
- The output resolver refuses a `formalized` claim without a durable Solution Contract
  (`src/modules/formalization/application/formalization-production-cell-installation.ts:571-581`) and the lifecycle payload resolver re-verifies ref/hash/schema/payload
  hash before handing payload downstream (`src/modules/formalization/application/formalization-production-cell-installation.ts:583-605`).

## DOWNSTREAM CONTRACT (producer → bridge → consumer)

Edge E1 (intra-workshop, structural spine): cells → baseline → architecture → settle —
each transition is a flow edge gated by `domain.accepted`/`domain.frozen` events
(`src/process-modules/modules/formalization/formalization-process-module.ts:278-295`); binding preservation: the baseline freezer
and settlement read lifecycle-scoped accepted material with exact hashes
(`src/modules/formalization/application/formalization-production-cell-installation.ts:119-124`, `src/modules/formalization/application/formalization-production-cell-installation.ts:717-733`).

Edge E2 (cross-workshop, Formalization → Development):

- **producer:** `complete-formalized` with certificate + Solution Contract
  (`src/modules/formalization/application/formalization-production-cell-installation.ts:336-376`).
- **bridge_e:** output mapping `solutionContract.schema/ref/hash` + `solutionContractPayload`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:366-369`) + installed resolver
  `createFormalizationLifecycleOutputPayloadResolver` (exact-match verification,
  `src/modules/formalization/application/formalization-production-cell-installation.ts:583-605`; wired
  `src/app/product-lifecycle-runtime.ts:915-920`) + Development stage input mapping
  consuming `formalizationCertificate.*`, `solutionContract.*`, `solutionContractPayload.*`
  (baseline hash, srs, acceptanceCriteria) (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:383-412`).
- **consumer:** `DevelopmentCase` (`factory.development-case.v1`,
  `src/process-modules/lifecycles/product-delivery-module-contracts.ts:61`) built from those keys, including per-AC
  `implementationRequired`/`criticality`/`coveredConstraintIds` relayed from §D2
  (`src/modules/formalization/application/formalization-production-cell-installation.ts:527-559`).
- **binding preservation:** every selection is exact ref+digest; the warrant consumer
  boundary freezes the expected discovery certificate hash + case identity digest at the
  SOURCE (`src/modules/formalization/application/formalization-production-cell-installation.ts:509-514`). Edge proof status: **PROVEN (declared + matrix-hosted)** via
  `tests/process-modules/development-constraint-relay.test.mjs` and
  `tests/matrix/e-constraint-loss.test.mjs` (group `process-modules`).

Edge E3 (upstream, Discovery → Formalization): see `01_DISCOVERY.md` DOWNSTREAM E2; the
consumer-side verification (`src/modules/formalization/application/formalization-production-cell-installation.ts:659-690`) is
the Formalization half of that edge proof.

## DEAD / DECLARATIVE-ONLY STRATA

1. **Declarative W8 package metadata with placeholder digests.** The W8 manifest is
   installed and digest-pinned as a package, but its resource entries carry the
   documented `'pending@wave-2'` placeholder digests
   (`src/process-modules/modules/formalization/package/manifest.ts:160-263` — every
   `digest: PENDING_DIGEST`) and its input/output ContractRefs carry
   `CONTRACT_REF_PENDING_DIGEST` (`src/process-modules/modules/formalization/package/manifest.ts:336-342`). Real content addressing exists only for
   handler refs (`src/process-modules/modules/formalization/package/manifest.ts:297-320`). Evidence: `declared`.
2. **W8 spec provenance dangling.** The manifest header cites
   `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md` and task
   `docs/refactor-management/05-subagent-tasks/W08-a1.md` (`src/process-modules/modules/formalization/package/manifest.ts:4-5`) — no
   `docs/refactor-management/` directory exists at this commit. The same dangling class
   is pinned by the use-case resources ("Wave 8 pinned resource (W8-A3)",
   `src/process-modules/modules/formalization/package/nodes/use-case/resources/use-case-skill.md:4`).
   Evidence: `declared` + `file-exists` absence.
3. **SRS structural CheckProvider — placeholder digest, never registered.**
   `SRS_STRUCTURAL_CHECK_PROVIDER_DIGEST = 'srs-structural-v1-digest'` is a literal
   placeholder, not a sha256
   (`src/modules/formalization/application/srs-structural-check-provider.ts:44-46`), and
   `registerFormalizationCheckProviders` registers submission-validator providers only —
   the structural provider has no registration site
   (`src/modules/formalization/application/formalization-check-providers.ts:39-60`;
   live registration `src/modules/formalization/index.ts:54-63`). Evidence: `declared`.
4. **`architecture-check-plan.ts` — declarative-only plan.** Builds
   `formalization.architecture-check-plan.v1` over the never-registered structural
   provider (`src/modules/formalization/application/architecture-check-plan.ts:46-70`);
   nothing imports it (only self-reference at `src/modules/formalization/application/architecture-check-plan.ts:58`). The LIVE architecture gate is the
   SRS submission-validator ref (`src/modules/formalization/application/formalization-check-refs.ts:44-50`). Evidence:
   `declared`.
5. **`package/nodes/**` node protocols — declarative-only strata.**
   `nodes/use-case/use-case-node-protocol.ts` and
   `nodes/architecture/{srs,architecture-resolver,architecture-recovery}-node-protocol.ts`
   (+ resources) are not referenced by the live flow definition — flow nodes declare
   only `cellDefinition`/`handler` (`src/process-modules/modules/formalization/formalization-process-module.ts:162-277`), and the
   manifest ships no handler refs for them (`src/process-modules/modules/formalization/package/manifest.ts:317-320` lists exactly
   freezeBaseline + settle). Only their own test hosts the use-case protocol as data
   (`tests/process-modules/formalization-use-case-node-protocol.test.mjs`). Evidence:
   `declared` (+ `CI-executed` for the data-shape test only).
6. **Stale manifest commentary.** The manifest claims "the seven kernel handlers
   declared in `formalization-installation.ts`" (`src/process-modules/modules/formalization/package/manifest.ts:27-29`) — no such file
   exists; the live installation module declares exactly two handlers
   (`src/modules/formalization/application/formalization-production-cell-installation.ts:90-93`). Evidence: `declared` +
   `file-exists` absence.
7. **Brief-provisioning port adapters unwired.** `SqliteFormalizationBriefProvisioning`
   (`src/infrastructure/process-modules/brief-provisioning-ports.ts:46-96`) has no
   construction site; live kernel handlers take no brief-provisioning dependency
   (`src/modules/formalization/application/formalization-production-cell-installation.ts:95-103`). Brief lineage is enforced
   instead by the product validator (corpus scenario
   `formalization_product-missing-brief-lineage-repair`). Evidence: `declared`.

## TEST COVERAGE

- `CI-executed` (blocking):
  - `process-modules` group (`.github/workflows/ci.yml:77-78`;
    `tools/run-acceptance-matrix.mjs:83-117`): `formalization-constraint-coverage`,
    `formalization-package-manifest`, `formalization-solution-contract-hashes`,
    `formalization-warrant-ref`, `formalization-use-case-node-protocol`,
    `development-constraint-relay` (downstream edge), `e-constraint-loss`
    (`tests/matrix/`), `discovery-output-handoff` (upstream edge).
  - `factory-contract` group (`.github/workflows/ci.yml:74-75`): `srs-d2-parser.test.mjs`,
    production-cell transitions/gate invariants, reviewer round history, recovery
    feedback trajectory.
  - `factory-proof` group (`.github/workflows/ci.yml:123-124`): `formalization-resilience-pack.test.mjs`,
    scenario-evidence/workshop-inventory closure (`tests/factory-proof/workshop-inventory.test.mjs:17-45`).
  - `architecture` group (`.github/workflows/ci.yml:65-66`): manifest↔dist handler digest consistency for
    the LIVE formalization installation module
    (`tests/architecture/handler-digest-runtime-consistency.test.mjs:27`).
- `matrix-hosted` (corpus): `tests/factory-evidence/formalization/*.json` (31 bundles;
  inventory rows `tests/factory-proof/workshop-inventory.baseline.json:23-55`, incl. five
  cells and platform fault edges).
- `file-exists` only (NOT CI-hosted): `tests/modules/formalization/*.test.mjs`
  (acceptance-heading-resolution, artifact-ref-bridge) — no group globs
  `tests/modules/formalization/**` (`tools/run-acceptance-matrix.mjs:64-163`).
- Quarantined: golden-path host FLAKY (`tools/run-acceptance-matrix.mjs:175-181`) —
  `formalization_happy-formalized.json` corpus remains `demonstrated`, not CI-proven.

## UNCOVERED CONDITIONS

1. Reviewer-desk authority: reviewer verdicts are check-provider validated, but no
   CI-hosted scenario pins a reviewer submitting a verdict for a FOREIGN cell beyond the
   corpus (`formalization_reviewer-foreign-subject.json` is `demonstrated`).
2. Five-attempt repair ladder end-to-end (author-gate repair → reviewer feedback repair →
   …→ rollover/total-cap) is exercised only through retry-exhaustion corpus scenarios;
   the ROLLOVER/TOTAL-CAP engine paths (`src/process-modules/application/node-executors/production-cell-node-executor.ts:783-880`) have
   no CI-hosted formalization-specific proof.
3. Baseline drift-detected → `complete-inconsistent` platform edge is inventory-declared
   (`tests/factory-proof/workshop-inventory.baseline.json:48-52`) with a fault edge but no committed
   evidence bundle at this cut.
4. Concurrent duplicate settlement for one ProcessRun (idempotent persist) — replayed
   flags exist (`src/modules/formalization/application/formalization-production-cell-installation.ts:352-361`) but no
   CI-hosted concurrent scenario.
5. `criticality` fallback default (`src/modules/formalization/application/formalization-production-cell-installation.ts:552`) and zero-criteria AC throw (`src/modules/formalization/application/formalization-production-cell-installation.ts:151-157`) —
   code paths without scenario pins.

## CONTRADICTIONS

1. **Declarative digest placeholders vs content-addressed package claims.** The manifest
   presents the package as content-addressed and validated
   (`src/process-modules/modules/formalization/package/manifest.ts:36-49`), yet resource and contract digests are placeholders
   (`src/process-modules/modules/formalization/package/manifest.ts:160-263`, `src/process-modules/modules/formalization/package/manifest.ts:336-342`), and the governing W8 spec is absent from the
   tree (`src/process-modules/modules/formalization/package/manifest.ts:4-5`). The map equality target (contract §6) is met for HANDLERS
   only; resources/contracts are strata with pending identity.
2. **Dead architecture-gate plan contradicts the live gate.** `architecture-check-plan.ts`
   declares the architecture gate as the SRS structural provider with a placeholder
   digest (`src/modules/formalization/application/architecture-check-plan.ts:46-70`;
   `src/modules/formalization/application/srs-structural-check-provider.ts:44-46`), while the installed gate is the SRS
   submission-validator provider with a real version/digest
   (`src/modules/formalization/application/formalization-check-refs.ts:44-50`). Two different "architecture gate" definitions
   coexist; only one is installed. Normative model: a check provider that returns passed
   without reading the CandidateSet is a placeholder, not QC authority
   (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:779-783`) — here the placeholder never runs at all, which
   is safer but leaves a stale declared surface.
3. **Manifest prose vs installed handler set.** "Seven kernel handlers" in
   `formalization-installation.ts` (`src/process-modules/modules/formalization/package/manifest.ts:27-29`) vs two installed handlers
   (`src/modules/formalization/application/formalization-production-cell-installation.ts:90-93`): the declarative surface
   overstates the kernel by five handlers that do not exist anywhere.
4. **Node-protocol strata vs flow reality.** `package/nodes/**` encodes an older
   per-node protocol model (resolver/recovery nodes) that the live flow replaced with
   reviewed cells + two kernel nodes; the files remain and one is CI-hosted as data
   shape, creating a false impression of an installed surface (map-equality defect,
   contract §6).
5. **Acceptance-validator version split.** `FORMALIZATION_SUBMISSION_VALIDATOR_VERSION`
   stays `1.1.0` for product/use-cases/reconciliation while acceptance moved to `1.2.0`
   (`src/modules/formalization/application/formalization-check-refs.ts:11-16`): the manifest binds providers by digest per
   ref, so the split is lawful, but the shared version constant no longer names a single
   validator generation — an audit trap recorded here for the reverse map.
