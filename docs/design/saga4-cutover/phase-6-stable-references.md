# Phase 6 — Stable References (Eliminate Portable SQLite Surrogate IDs)

> Read-only design investigation. NO source changes. Output = this document.
> Branch: `saga4`. Date: 2026-07-30.
> Predecessor: commit `50e065c` "fix(lifecycle): bind portable repository references at runtime".

## 0. Goal & principle

Eliminate portable SQLite surrogate IDs (autoincrement `INTEGER PRIMARY KEY`)
from any contract that **survives across**:

- a module boundary (LifecycleRun input → ProcessRun input → output →
  certificate → next-stage input),
- a session restart (`--resume`),
- a snapshot capture/restore (`saga-snapshot.mjs`),
- an export/import round-trip (`tracker_export`/`tracker_import`).

Numeric IDs remain valid **only inside a fenced runtime execution**: the body
of a worker run, the resolution of a binding at the moment a stage is frozen,
or an in-process cache keyed by `id`. The rule is:

> A portable contract field is **DURABLE** if a different SQLite database (or
> the same DB after `reset-saga-db.mjs` / `VACUUM` / `tracker_import`) would
> assign a different value to it. Such a field MUST carry a stable reference.
> A field that is only ever resolved, read, and discarded within one process
> invocation against one live DB is **RUNTIME-LOCAL** and may stay numeric.

## 1. What commit `50e065c` already changed

`50e065c` is the reference implementation of this phase's pattern. It modified
exactly one durable contract surface and shipped the matching runtime
resolver. Files (see `git show 50e065c`):

- `src/process-modules/lifecycles/product-delivery-lifecycle.ts` — split the
  `development.repositories` element type from
  `DevelopmentRepositoryBinding { projectRepositoryId: number; ... }` into a
  discriminated union:
  - `ProductDeliveryRepositoryBinding` (portable) carrying
    `ProductDeliveryRepositoryRef { repositoryName, role }` — **no** numeric id.
  - `LegacyProductDeliveryRepositoryBinding { projectRepositoryId }` — kept as
    an **input-only compatibility shape**; the doc-comment says explicitly
    "never copied into a durable snapshot."
- `src/app/product-lifecycle-repository-bindings.ts` (NEW) — two resolvers:
  - `canonicalizeProductDeliveryLifecycleInput(db, projectId, input)` runs at
    `engine.resolveInput` time (`product-lifecycle-runtime.ts:566-571`). It
    converts any `LegacyProductDeliveryRepositoryBinding` to a portable one
    *before* the LifecycleRun row is persisted, and fails closed
    (`PRODUCT_LIFECYCLE_LOCAL_REPOSITORY_ID_STALE_OR_FOREIGN`) on a stale or
    foreign id. **The durable snapshot never contains the numeric id.**
  - `resolveProductDeliveryRepositories(db, projectId, refs)` resolves the
    portable ref back to a numeric `projectRepositoryId` by `(name, role)`
    lookup, fail-closed on not-found / ambiguous / branch-mismatch. Called
    twice: once eagerly in `resolveInput` (preflight, before any LM token is
    spent), once in `resolveProductDeliveryStageInput` at the Development stage
    freeze boundary. The numeric id only enters the frozen StageRun — i.e. it
    lives inside the Development execution fence, never in the root
    LifecycleRun input.

**The pattern to generalize in Phase 6:**

```
portable field in durable contract
   └─ canonicalize*():  numeric-input-shape → portable-shape  (write-time)
        └─ resolve*():   portable-shape → numeric-id  (read-time, fenced)
             └─ fail-closed errors on stale/foreign/ambiguous
```

## 2. Inventory of numeric IDs in durable contracts

Sources grepped: `src/process-modules/`, `src/tools/export-import.ts`,
`src/infrastructure/persistence/` (does not exist — persistence lives in
`src/process-modules/persistence/` and `src/saga3/persistence/`).

### 2.1 Lifecycle input contracts

| Field | Location | Class | Notes |
|---|---|---|---|
| `development.repositories[].projectRepositoryId` | `product-delivery-lifecycle.ts:69` (legacy shape) | **DONE** by `50e065c` | Portable `repositoryRef` is canonical; numeric is input-only. |
| `development.repositories[].repositoryRef` | `product-delivery-lifecycle.ts:53` | PORTABLE (stable) | `(repositoryName, role)` — natural key. **Caveat §5.1:** survives reset/import only if `(name,role)` is unique within the project; needs a stable UUID to be fully robust. |
| `initiative`, `policy`, `operatorAuthorization` | `product-delivery-lifecycle.ts:22-46` | content-addressed | `policy.{id,version,contentHash}` is already a `ContentAddressedReference`; `operatorAuthorization.releasePolicyHash` binds to `policy.contentHash`. No numeric id. |

### 2.2 Module output contracts (the durable ProcessOutcome + module payloads)

| Field | Location | Class | Replacement |
|---|---|---|---|
| `FormalizationCase.discoveryEpicId` / `formalizationEpicId` | `formalization-schemas.ts:50-51` | **DURABLE** (numeric) | `epic_id` is passed in the frozen StageRun `input_snapshot` and persisted into `saga3_formalization_*` rows. After reset/import this id changes. → **epic stable key** (§5.3). |
| `FormalizationSolutionContractPayload.processRunId` | `formalization-schemas.ts:99` | **DURABLE** (numeric) | Embedded in the durable output payload. → content-addressed output ref (the `outputRef`/`outputHash` pair already covers identity; `processRunId` is redundant and should be dropped or made opaque). |
| `SolutionContractBundle.{prd,fr,nfr,rule,uc,ac,srs}ArtifactId` | `formalization-schemas.ts:69-76` | **DURABLE** (numeric) | Array of `artifactId` survives in `output_snapshot` / `handoff_snapshot`. After import these point at wrong rows. → **artifact stable key** (§5.2) `(epicKey, type, code)`. |
| `FormalizationSolutionContractPayload.artifactHashes` | `formalization-schemas.ts:104` | content-addressed | `Record<artifactId-as-string, hash>` — the *hashes* are stable, the *keys* are not. → re-key by artifact stable key. |
| `FormalizationSolutionContractPayload.traceIds` | `formalization-schemas.ts:105` | **DURABLE** (numeric) | `artifact_traces.id` list. After import, ids remap. → trace stable key (source-stable-key, target-stable-key, link-type) per TRIZ doc §6.1. |
| `FormalizationSolutionContractPayload.acceptanceCriteria[].artifactId` | `formalization-schemas.ts:120` | **DURABLE** (numeric) | Crosses into Development via `DevelopmentCase.acceptanceCriteria[].artifactId`. → artifact stable key. |
| `AcceptanceBaselineSnapshotPayload.processRunId`, `acArtifactIds` | `formalization-schemas.ts:83,87` | **DURABLE** (numeric) | Same as above. |
| `DevelopmentCase.projectId` / `epicId` | `development-schemas.ts:65-66` | **DURABLE** (numeric) | Frozen into StageRun + persisted into `saga3_development_outputs`. → project/epic stable keys. |
| `DevelopmentCase.acceptanceCriteria[].artifactId` | `development-schemas.ts:46` | **DURABLE** (numeric) | Crossed from Formalization. Same remediation. |
| `DevelopmentCase.repositories[].projectRepositoryId` | `development-schemas.ts:58` | **RUNTIME-LOCAL** at the Development boundary | This is the *resolved* form produced by `resolveProductDeliveryStageInput` (§1). It is fenced to the Development StageRun. OK to keep numeric, but it must never be promoted back to a durable cross-module field. |
| `DevelopmentTaskGraphItem.projectRepositoryId`, `acceptanceCriterionIds` | `development-schemas.ts:89-90` | **DURABLE** (numeric) | Persisted in `DevelopmentTaskGraphSnapshot` (LM-proposal → kernel-frozen → durable). → repository stable ref + artifact stable keys. |
| `CandidateIntegrationTarget.projectRepositoryId` | `development-schemas.ts:96` | **DURABLE** (numeric) | In the TaskGraph snapshot. → repository stable ref. |
| `DevelopmentTaskGraphSnapshot.epicId` | `development-schemas.ts:116` | **DURABLE** (numeric) | → epic stable key. |
| `ImplementationWorkItemResult.taskId` | `development-schemas.ts:136` | **DURABLE** (numeric) | `tasks.id` survives in the workset snapshot. After import this points to a different task. → task stable key (§5.4). |
| `CandidateRepositorySnapshot.projectRepositoryId` | `development-schemas.ts:154` | **DURABLE** (numeric) | In `IntegratedReleaseCandidate.repositories`. → repository stable ref. |
| `CandidateVerificationEvidence.taskId`, `acceptanceCriterionId` | `development-schemas.ts:197,199` | **DURABLE** (numeric) | → task/artifact stable keys. |
| `VerificationProviderBinding.providerId` | `development-schemas.ts:188` | **DURABLE** (numeric) | `saga3_trusted_providers.id`. → provider stable name (already unique per project). |
| `DevelopmentSettlementInput.developmentCase…` | `development-schemas.ts:233` | cascades | All the above propagate through settlement. |

### 2.3 Process-layer persistence (saga3_*)

| Field | Location | Class | Notes |
|---|---|---|---|
| `saga3_process_runs.project_id`, `.epic_id` | `sqlite-process-run-repository.ts:66` (DDL) | **DURABLE** (numeric) | These columns index runs but are also reconstructed from `invocationContext.projectId/epicId` at start. After import the *column* value is stale; the row identity is carried by `module_ref_key + idempotency_key`. |
| `saga3_managed_*_productions.{intent,task,artifact}_id` | `sqlite-managed-production-ledger.ts:19-32, 105-109` | **DURABLE** (numeric) | Provenance audit trail. After import all three ids are stale. This is the core of the TRIZ-doc problem (`TRACEABILITY-TRIZ-RESEARCH.md` §0). → provenance events keyed by stable refs, not by id (see §6 of that doc). |
| `saga3_exact_candidate_acceptance_items.artifact_id` | `saga-snapshot.mjs:745` (DDL mirror) | **DURABLE** (numeric) | Acceptance CAS. Already compares `expected_content_hash`; the `artifact_id` is a redundant locator. → key the CAS by `(artifact stable key, content_hash)`. |
| `saga3_lifecycle_runs.input_snapshot` | `sqlite-lifecycle-run-repository.ts` | **DURABLE** (mixed) | Carries the entire root input JSON. After `50e065c` this is portable for repositories; still numeric for projectId/epicId (those are *also* columns on the row, so the row is self-locating — the JSON value is informational). |

### 2.4 Snapshot (`saga-snapshot.mjs`)

`saga-snapshot.mjs` uses **id preservation** (verbatim INSERT with explicit
`id`), not ref-remapping. This is the explicit design choice documented at
lines 18-26:

> "restore uses id preservation (INSERT with explicit id), NOT ref-remapping.
> This is the simpler, deterministic variant … it is valid only over a
> freshly-reset DB (so the same ids cannot collide), and it makes
> `saga3_process_transitions.handoff_snapshot` (which carries numeric
> artifactIds) valid without patching."

This is a **conscious debt**: it works *only* against an empty target DB. The
consequence named in the comment — "handoff_snapshot carries numeric
artifactIds" — is exactly the Phase 6 hazard. Surfaces persisted as raw ids:

- `snapshot.artifacts[].id` and `parent_artifact_id`, `project_repository_id`
  (lines 592-599)
- `snapshot.traces[].source_id`, `target_id` (line 604)
- `snapshot.formalizationTasks[].id`, `verification_target_artifact_id`,
  `project_repository_id`, `generated_from_task_id` (lines 610-625)
- `snapshot.commandReceipts[].task_id` (line 805)
- `saga3_exact_candidate_acceptance_items.artifact_id` (line 745)
- `saga3_managed_*_productions.{intent,task,artifact,trace,source,target}_id`
  (lines 773-799)
- `snapshot.episodeWorkflow.baseline_artifact_id` (line 815)

All of these are **DURABLE numeric** by the Phase 6 definition (they survive
capture → reset → restore), but they are currently held valid *only* by the
id-preservation invariant. **The day snapshot/restore must target a non-empty
or independently-seeded DB (e.g. two projects merged, or restore-after-import),
every one of these breaks.** Phase 6 makes them robust by replacing the ids
with stable refs in the snapshot body and adding a remap pass on restore (see
§6.3).

### 2.5 Export/Import (`export-import.ts`)

`tracker_export` serializes raw ids into the JSON under `_original_*` keys, and
`tracker_import` rebuilds them via id-remapping `Map`s:

- `epicIdMap`, `taskIdMap`, `repositoryBindingIdMap`, `artifactIdMap`
  (lines 228-231).

This is the **inverse** of snapshot id-preservation: import *does* remap. The
remapping is correct *for the entity rows it touches* (projects, epics, tasks,
repositories, artifacts, notes). The gaps are:

1. **Cross-entity references inside `metadata` JSON are NOT remapped.**
   `tasks.metadata` is copied verbatim (line 349). A worker writes
   `metadata.work_intent_id`, `metadata.control_intent_id`,
   `metadata.source_submission_id` etc. (see `discovery-installation.ts:235-254`
   writing `sourceIntentId`/`sourceTaskId` into managed-production metadata).
   These numeric ids survive import as **dangling references**. → **DURABLE**
   hazard. Migration: metadata must carry stable refs, or the import must walk
   known metadata-id fields and remap them.

2. **`saga3_*` tables are not exported at all.** `tracker_export` covers the
   legacy tracker tables (projects/epics/tasks/artifacts/traces/evidence/notes)
   but not the process-run / lifecycle-run / managed-production layer. So a
   `tracker_import` produces a project whose tracker graph is intact but whose
   saga3 process history is gone — the LifecycleRun cannot be resumed. This is
   consistent with `saga-snapshot.mjs` being the *separate* mechanism for the
   saga3 layer, but it means **two export surfaces with two different
   remapping strategies** coexist. Phase 6 should converge them (§6.4).

3. **`generation_key` is copied verbatim** (line 347). This is the only
   existing stable-key column on `tasks` (schema.ts:135). It already survives
   import correctly — useful precedent for the task stable key (§5.4).

### 2.6 Repository references

There is **no stable repository UUID**. Grepped `repositoryUuid`, `repoRef`,
`stable` against `src/schema.ts` — none. The natural-key candidates are:

- `repositories.name` (line 19) — globally unique by convention, not enforced
  (`UNIQUE` absent).
- `project_repositories.(project_id, repository_id)` (line 41) — unique, but
  both halves are numeric.
- `project_repositories.(project_id, role)` — *not* unique; the resolver in
  `product-lifecycle-repository-bindings.ts:28-42` SELECTs by `(name, role)`
  within a project and fail-closes on ambiguity, so it treats `(name, role)`
  as a soft natural key.

`50e065c`'s `ProductDeliveryRepositoryRef { repositoryName, role }` is the
de-facto stable ref today. It is portable across import **only because import
re-creates `repositories` by `name`** (line 251) and `project_repositories` by
`(project_id, repository_id, role)` (line 257), preserving the name. So the
portability holds for the happy path. The gap: if two source projects both
have a repository named `main`, import into one target DB collides on
`repositories.name` (no UNIQUE → silently duplicated rows). → §5.1.

### 2.7 Artifact references & content-addressing

From `TRACEABILITY-TRIZ-RESEARCH.md` (verified §9):

- `artifacts.content_hash` (schema.ts:264) — SHA-256 of the `.md` body, computed
  by `artifactDiskHash()` in `src/helpers/artifact-file.ts`. **Identity of a
  version**, not of the logical artifact (changes on every edit).
- `artifacts.accepted_hash` (schema.ts:265) — the frozen hash at acceptance.
  Stable until supersede.
- `artifacts.(epic_id, type, code)` — the recommended **logical stable key**
  (TRIZ §6.2). `code` is nullable today; for formalization types (PRD/UC/AC/
  FR/NFR/SRS) it is effectively required.
- `ProductRef { schemaId, ref, digest }` (`production-envelope.ts:179-183`) —
  the *existing*, serializable, content-addressed reference used by the
  process-module production layer. `ref` is opaque/module-owned (e.g.
  `'proposal:141'`), `digest` is SHA-256 over the canonical body. This is the
  proven template for cross-module product references.

So the building blocks for a content-addressed artifact ref exist; what is
missing is using them in the **durable module contracts** (§2.2 still uses
`artifactId`).

### 2.8 Module product references (proposals, certificates, outputs)

Cross-module product linkage is already **content-addressed**, not id-based:

- Stage `outputMapping` carries `certificate.{schema,ref,hash}` and
  `solutionContract.{schema,ref,hash}` / `verifiedBundle.*` / `releaseRecord.*`
  (`product-delivery-lifecycle.ts:223-228, 258-268, 309-319, 360-370`). These
  are `ContentAddressedReference` triples — fully portable.
- `ProcessRunRecord` stores `output_ref`, `output_hash`, `certificate_ref`,
  `certificate_hash` as opaque strings (`sqlite-process-run-repository.ts:66`).
  The ref string is module-owned (e.g. `proposal:141`) and the hash binds the
  bytes. **This surface is already Phase 6-compliant.**
- `LineageRef { kind, ref }` (`production-envelope.ts:189-200`) — durable
  pointer to ancestor production/node-run/receipt. `ref` is opaque and
  module-resolved.

**The one leak:** the *contents* of the product payloads (§2.2) embed numeric
`artifactId`/`processRunId`/`epicId` inside the JSON body that the
content-addressed `ref`+`hash` points at. So the envelope is portable but the
payload is not. Phase 6 must clean the payloads.

### 2.9 Runtime binding resolution & binding receipts

There is **no generic `bindingReceipt` / `resolveReference` mechanism**. Grepped
all three terms across `src/process-modules/` — no hits outside this phase's
vocabulary. What exists is:

- `canonicalize*()` + `resolve*()` pairs, currently only for repositories
  (§1). This *is* the binding-resolution mechanism, just not named or
  generalized.
- `bindingSnapshot` / `binding_hash` in the lifecycle orchestrator
  (`lifecycle-orchestrator.ts:237, 242, 506, 510`): the *StageBinding
  definition* is hashed and frozen into the StageRun row. This is a
  **definition digest**, not a runtime data binding receipt — it does not
  record "portable ref X resolved to numeric id Y at time T."
- `assertDevelopmentScope` (`sqlite-development-runtime.ts:825-878`) —
  fail-closed scope check (epic belongs to project, repository belongs to
  project, AC belongs to epic and is accepted+clean). This is the *validation*
  half; it does not emit a receipt.

**Gap for Phase 6:** there is no durable record that a stable ref was resolved
to a numeric id at freeze time. Today this is reconstructed by re-resolving at
read time. That is acceptable for runtime correctness (re-resolution is
deterministic given the same DB) but it means the *provenance* of a binding
("which numeric id did this portable ref point at when the certificate was
issued?") is not captured. See §6.5.

### 2.10 Preflight validation before worker spawn

There is **no single `preflight` / `validateBeforeSpawn` gate hook**. The
fail-closed validations that exist:

- `engine.resolveInput` in `product-lifecycle-runtime.ts:550-587`: runs
  `assertProductDeliveryLifecycleInput` then `canonicalizeProductDeliveryLifecycleInput`
  then `resolveProductDeliveryRepositories` — **before** the LifecycleRun is
  persisted and before any LM token is spent. This *is* a fail-closed
  preflight, named in the code comment at line 572-573: "Fail before Discovery
  (and before any LM token is spent) when a portable repository reference
  cannot be bound in this runtime."
- `assertDevelopmentScope` (§2.9) — Development-stage scope validation.
- `gateway-guard.ts` — a separate fail-closed pipeline for *tool* authorization,
  not for reference binding.

So the pattern exists for repositories; Phase 6 generalizes it to every
portable ref that crosses into a worker spawn (artifact refs in
`acceptanceCriteria`, repository refs in task graph items, etc.).

## 3. Classification summary

| Class | Rule | Examples found |
|---|---|---|
| **RUNTIME-LOCAL** (keep numeric) | Resolved, used, discarded within one fenced execution against one live DB. | `DevelopmentCase.repositories[].projectRepositoryId` after `resolveProductDeliveryStageInput`; in-process cache keys; `workerContext.{projectId,epicId}` passed to `resolveWorkerContext`. |
| **DURABLE — already portable** (no work) | Carries a stable ref or content-addressed triple. | Stage `outputMapping` certificate/contract triples; `ProductRef`; `LineageRef`; `policy.{id,version,contentHash}`; `repositories.name`-based `repositoryRef`. |
| **DURABLE — numeric, MUST migrate** | Survives module boundary / session / snapshot / import as a numeric id. | All `artifactId`/`taskId`/`epicId`/`projectId`/`processRunId`/`intentId`/`providerId` in module payloads (§2.2), managed-production ledger (§2.3), snapshot body (§2.4), and tracker `metadata` JSON (§2.5). |

## 4. Stable reference catalog (proposed)

For each DURABLE numeric field, the stable replacement:

| Numeric today | Stable ref | Natural key source | Already in schema? |
|---|---|---|---|
| `artifacts.id` | **ArtifactKey** = `(EpicKey, type, code)` + version = `accepted_hash` | `artifacts.(epic_id,type,code)` + `accepted_hash` | Partial — needs EpicKey; `code` nullable today. |
| `epics.id` | **EpicKey** = stable slug (e.g. `REQ-007`) | `epics.name` (parseable) or a new `epic_slug` column | **No** stable column exists. `generation_key` lives on `tasks`, not `epics` (TRIZ §9 Error 1). |
| `projects.id` | **ProjectKey** = stable slug or UUID | `projects.name` (not unique-enforced) | No UUID; name is the de-facto key. |
| `tasks.id` | **TaskKey** = `(EpicKey, generation_key)` or `(EpicKey, task_kind, sort_order)` | `tasks.generation_key` (schema.ts:135, already stable) | `generation_key` exists but is nullable and not unique. |
| `project_repositories.id` | **RepositoryRef** = `(ProjectKey, repositoryName, role)` | already done by `50e065c` | Yes (portable shape exists). |
| `repositories.id` | (rolled into RepositoryRef) | `repositories.name` | name not UNIQUE-enforced. |
| `saga3_work_intents.id` | **IntentKey** = `(EpicKey, kind, generation_key)` | intent rows are scoped to epic+kind | needs stable generation_key propagation. |
| `saga3_trusted_providers.id` | **ProviderKey** = `(ProjectKey|null, name)` | already UNIQUE per `(project_id, name)` | Yes. |
| `processRunId` in payloads | drop; the content-addressed `outputRef`+`outputHash` already identifies the product | — | n/a |

## 5. Resolution sites (where stable ref → numeric id happens at runtime)

Following the `50e065c` pattern, each stable ref gets two functions:

| Stable ref | `canonicalize*()` (write-time, before persist) | `resolve*()` (read-time, fenced, fail-closed) |
|---|---|---|
| ArtifactKey | at Formalization output freeze: replace `artifactId` array with `ArtifactKey` array before writing `output_snapshot` | at Development input freeze + at verification: resolve `(EpicKey,type,code)` → `artifacts.id` via SELECT, fail-closed on missing/duplicate |
| EpicKey | at LifecycleRun persist: store `epicKey` alongside (or instead of, in the JSON) `epicId`; the row column stays numeric for indexing | at every stage freeze that reads epicId from the durable frame |
| TaskKey | at TaskGraph snapshot freeze: emit `(generation_key)` per item instead of `taskId` | at workset result recording: resolve `generation_key` → `tasks.id` within the epic |
| RepositoryRef | **DONE** (`canonicalizeProductDeliveryLifecycleInput`) | **DONE** (`resolveProductDeliveryRepositories`) |
| ProviderKey | at evidence recording: write provider `name` not `id` | at verification provider trust check: resolve by `(project,name)` |

Each `resolve*()` is the fail-closed preflight hook (generalizing §2.10).

## 6. Migration plan (per DURABLE surface)

### 6.1 Module payloads (§2.2) — highest value

1. Add `ArtifactKey`/`EpicKey`/`TaskKey` TS types mirroring
   `ProductDeliveryRepositoryRef`.
2. In each module's output-freeze path (where `output_snapshot` is built),
   `canonicalize*` the numeric ids to stable keys before persistence.
   Follow the exact `50e065c` seam: a `canonicalize<Module>Output(db,
   projectId, payload)` helper called at the resolver site.
3. In each downstream module's input-freeze path, `resolve*` the keys back to
   numeric ids inside the fenced StageRun. The root LifecycleRun input and the
   cross-stage `handoff_snapshot` carry only stable keys.
4. Keep `processRunId` out of payload bodies — it is already redundant with
   `outputRef`+`outputHash`.

**Remap for existing data:** a one-shot migration that, for each existing
durable payload row (`saga3_formalization_solution_contracts.payload`,
`saga3_development_outputs.payload`, `saga3_process_transitions.handoff_snapshot`),
parses the JSON, resolves each numeric id to its stable key against the
*current* DB, and rewrites the row. Run once after Phase 6 code ships; guarded
by a schema version bump in `SCHEMA_VERSION`-style constants.

### 6.2 Managed-production ledger (§2.3) — the TRIZ-doc core

Per `TRACEABILITY-TRIZ-RESEARCH.md` §6: split the single
`artifact_traces` + `saga3_managed_trace_productions` model into:

- a **stable semantic edge** keyed by `(sourceArtifactKey, targetArtifactKey
  | targetTaskKey, link_type)` — survives reset/import;
- an **append-only provenance event log** keyed by edge + execution — volatile,
  re-creatable.

This removes `matchesFenceRelaxed` (the recovery band-aid) and makes the ledger
portable. The migration is the strangler path in TRIZ §7 (Phase 0 schema add
→ Phase 1 dual-write → Phase 2 read switch → Phase 3 legacy drop).

### 6.3 Snapshot (`saga-snapshot.mjs`) — make restore target-agnostic

Today restore works only on an empty DB via id-preservation. To make it robust:

1. **Capture** additional stable-key fields alongside each raw id
   (`artifactKey`, `taskKey`, `epicKey`, `repositoryRef`). Keep the raw ids for
   one version (backward compat) and bump `SCHEMA_VERSION` to `v3`.
2. **Restore** gains an optional remap pass: if the target DB is non-empty or
   if any preserved id collides, fall back to stable-key-based INSERT (resolve
   key → target id, fail-closed on ambiguity). The id-preservation fast path
   remains the default for the empty-DB case.
3. The `handoff_snapshot` numeric `artifactId`s (called out at line 26 of the
   script) become valid *either* way once §6.1 lands (the snapshot will carry
   stable keys; the numeric is just a cache).

### 6.4 Export/Import (`export-import.ts`) — converge with snapshot

1. **Walk `metadata` JSON** on import and remap known id fields
   (`work_intent_id`, `control_intent_id`, `source_submission_id`,
   `source_artifact_id`, `source_task_id`, etc.). Maintain a registry of
   remappable metadata fields alongside the existing `*IdMap`s.
2. **Add a saga3-layer export option** so a full project (tracker + process
   history) round-trips through one mechanism, using the same stable-key
   remap as snapshot restore. This eliminates the two-divergent-strategies
   problem (§2.5 gap 2).
3. `generation_key` already round-trips correctly (§2.5) — use it as the seed
   for TaskKey.

### 6.5 Binding receipts (new, optional but recommended)

Introduce a lightweight `binding_receipts` append-only table recording, at
each `resolve*()` call: `(portableRefJson, resolvedId, resolvedAt,
executionId, resolverKind)`. This closes the §2.9 gap — provenance of a
binding becomes durable without re-resolving at read time. Not required for
correctness (re-resolution is deterministic) but required for forensic audit
after a reset/import where the original numeric id no longer exists.

## 7. Risks

| Risk | Mitigation |
|---|---|
| `code` is nullable on `artifacts` — ArtifactKey is undefined for some rows | Require `code` for formalization types (PRD/UC/AC/FR/NFR/SRS/RULE); auto-generate for `decision`/`OQ`. TRIZ §8 already calls this out. |
| `epics` has no stable slug — EpicKey needs a new column | Add `epic_slug` (or reuse a normalized `name`) with a UNIQUE-within-project constraint. TRIZ §9 Error 1. |
| `(repositoryName, role)` collision across merged projects | Enforce UNIQUE on `repositories.name` OR introduce a `repository_uuid` column; the latter is safer for cross-DB merge. |
| Content-addressed payloads change shape → break running lifecycles | Schema-version the payloads (`saga3.*.v1` → `.v2`); dual-read during transition. |
| Snapshot `v2` → `v3` breaks old checkpoints | Keep `v2` read path; `v3` is opt-in on capture. |
| Metadata-id remap (§6.4) misses a field | Maintain the field registry in code next to the import handler; add a test per known metadata id field. |

## 8. Out of scope for Phase 6

- Numeric ids *inside* `RUNTIME-LOCAL` scopes (Development StageRun
  `projectRepositoryId`, in-process caches, `workerContext`).
- The `gateway-guard.ts` tool-authorization pipeline (orthogonal).
- The wiki-link `.md` extraction (TRIZ Phase 4) — separately tracked.

## 9. Files to touch when this phase is implemented (reference list)

- `src/process-modules/lifecycles/product-delivery-lifecycle.ts` — extend
  portable shapes for ArtifactKey/EpicKey/TaskKey in mappings.
- `src/app/product-lifecycle-repository-bindings.ts` — template; add sibling
  `product-lifecycle-artifact-bindings.ts` etc.
- `src/app/product-lifecycle-runtime.ts:550-587` — extend `resolveInput`
  preflight to canonicalize all durable refs, not just repositories.
- `src/process-modules/modules/formalization/formalization-schemas.ts` —
  replace numeric `*ArtifactId`/`processRunId` with stable keys.
- `src/process-modules/modules/development/development-schemas.ts` — same for
  `DevelopmentCase`/`TaskGraph`/workset/candidate/evidence payloads (keep
  `DevelopmentRepositoryBinding.projectRepositoryId` numeric — it is
  RUNTIME-LOCAL).
- `src/process-modules/persistence/sqlite-managed-production-ledger.ts` —
  TRIZ §6 split.
- `src/process-modules/persistence/sqlite-exact-candidate-acceptance.ts` — key
  CAS by `(ArtifactKey, content_hash)`.
- `src/schema.ts` — add `epic_slug`, make `code` required for formalization
  types, consider `repository_uuid`.
- `tools/saga-snapshot.mjs` — capture stable keys, add remap restore path,
  bump to `v3`.
- `src/tools/export-import.ts` — metadata-id remap; saga3-layer export.
- `src/helpers/artifact-file.ts` — already computes `content_hash`; reuse as
  the version-half of ArtifactKey.

## 10. TL;DR

`50e065c` proved the pattern on one surface (repository refs). Phase 6 repeats
it for **artifact, epic, task, intent, and provider refs** across module
payloads, the managed-production ledger, snapshots, and export/import. The
building blocks all exist (`ProductRef`, `content_hash`/`accepted_hash`,
`generation_key`, the `canonicalize*`/`resolve*` seam, fail-closed preflight).
The work is generalization, not invention. The biggest single gap is the
absence of a stable epic key (TRIZ §9 Error 1) and the metadata-id remap hole
in `tracker_import` (§2.5 gap 1).
