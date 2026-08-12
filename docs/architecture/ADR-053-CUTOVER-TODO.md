# ADR-053 cutover: verified diagnosis and phased TODO

Status: implementation plan

Verified against branch `saga4` on 2026-08-11.

Source diagnosis: user-supplied architectural analysis. Normative decision:
[ADR-053](./decisions/053-workplace-production-revision-as-accepted-material-authority.md).

## ⛔ BINDING AMENDMENT — No legacy, no compatibility, no feature flags

**Operator directive (2026-08-11, overrides all softer language below):**

There is **no legacy**. There must be **no legacy**. The cutover is a **clean
break**, not a strangler migration. Concretely this OVERRIDES every softer
"preserve / retain / dual-record / backfill / compatibility reader" clause in
this document and in ADR-053:

1. **No old schema survives.** No `producerExecutionRef` column kept "for
   backfill", no v1 CandidateSet table alongside v2, no `productSource` column
   kept "temporarily during migration". The new schema is greenfield: tables
   and columns model ONLY `WorkplaceProductionRevision`-backed authority.
2. **No migration of old rows.** Do not migrate/copy v1 CandidateSets,
   execution-owned products or old accepted-artifact rows into the new model.
   Existing factory DBs are throwaway sandboxes — the cutover ships against a
   fresh schema, not a hot-migrated one.
3. **No feature flags or toggles.** No `revisionAuthorityEnabled`,
   `useCandidateSetV2`, `dualRecordObligations`, no env-gated fallback. The new
   model is the only model; there is no flag to flip.
4. **No dual-record.** Phase 2's "initially dual-record while synchronous
   behavior remains" is CANCELLED. Obligations are the only record from the
   first commit.
5. **No compatibility readers.** Phase 5's "old v1 remains readable" and
   Phase 10's "retain historical readers" are CANCELLED. Old authority paths
   are DELETED in the same commit that introduces the new one, never retained.
6. **No traces, no hints.** Code, types, SQL, comments and test fixtures must
   not even *suggest* the old execution-scoped authority ever existed as a
   valid model. Rename and remove; do not deprecate.

**Why:** the diagnosis names "strangler migration without strangulation" as the
*cause* of the bug class. Keeping any old path alive — even read-only, even
flagged off — recreates the exact defect. This amendment makes the cutover
non-additive by construction.

## Verdict

The central diagnosis is confirmed: the documented Workplace-owned material model and
the executable runtime still coexist with an execution-owned material model. The
Factory has useful partial substrate (`WorkplaceProductionSnapshot`, exact CandidateSet
reads, `effect_pending`, effect receipts and `CellFinalAcceptance`), but it has not made
an immutable Workplace production revision the only post-seal material authority.

The proposal should be implemented as a cutover, not as another compatibility layer.
No new real-model canary is authorized by this plan until the cutover exit gates below
are green. Scripted, model-based and mutation tests are the probes during migration.

### Ordering decision

The problem is complicated rather than chaotic: the target model is known, but the
migration order changes failure risk. Weighted criteria are authority safety 30%,
cross-process parity 25%, crash recoverability 20%, reversibility 15%, delivery cost
10% (score 1-5).

| Order | Safety | Parity | Recovery | Reversibility | Cost | Weighted |
|---|---:|---:|---:|---:|---:|---:|
| Revision first, then composition/obligations | 4 | 2 | 2 | 3 | 4 | 305 |
| Composition → obligations → revision cutover | 5 | 5 | 5 | 4 | 3 | 465 |
| Continue incident patches and canaries | 1 | 2 | 1 | 4 | 5 | 230 |

Chosen order: capability parity first, durable transition substrate second, material
authority third. Pre-mortem: the leading plan fails if the manifest proves only resource
bytes rather than executable bindings, if dual-recorded obligations permit two owners,
or if compatibility fallbacks remain callable after migration. The phase exit gates
explicitly prevent those three failures.

## Claim audit

| Claim | Result | Current evidence |
|---|---|---|
| `WorkplaceProductionRevision` does not exist as an authoritative entity | Confirmed | No production type/table/repository exists. Only `WorkplaceProductionSnapshot` exists in `src/process-modules/shared/workplace-production-snapshot.ts`. |
| Snapshot distinguishes presenter from contributors | Confirmed | `presenterExecutionRef` and `contributingExecutionRefs` are present in the snapshot type and builder. |
| CandidateSet remains execution-owned | Confirmed | `CandidateSet.producerExecutionRef` is required, and its deterministic seal key includes that ref in `src/process-modules/domain/workplace/candidate-set.ts`. |
| Post-acceptance authority still carries execution identity | Confirmed | `PostAcceptanceEffectInput.producerExecutionRef` remains required in `src/process-modules/application/post-acceptance-effects.ts`; Production Cell passes it after acceptance. |
| Post-seal consumers can still use execution/task/latest coordinates | Confirmed, scoped | `readExecutionProducts` remains; Formalization retains an execution-scoped typed-submission fallback; Discovery/output paths dereference through `producerExecutionRef`; crash/output paths still call `latestCandidate`. Managed snapshots, current Git integration and replay already bind exact CandidateSet material, so they are not evidence of current last-execution selection. |
| The Run 011 effect defect was fixed only locally | Confirmed | Commit `72fdd3e` exists and Formalization now resolves an accepted Workplace snapshot, but the universal effect interface and other consumers still expose the old coordinate. |
| `producerExecutionRef` is still widespread | Confirmed | Current audit finds it in 15 production files. It is authority in CandidateSet/effect/output/check-provider paths, not only telemetry. |
| Product sources remain split deep in runtime | Confirmed | `productSource` selects typed submission versus managed production, and `readExecutionProducts` branches between them before CandidateSet sealing. Git is another separate material path. |
| Formalization identity/cardinality was overloaded | Confirmed, partially repaired | Container and member hashes are now distinct in several contracts; atomic-member freezing exists. Current work also introduces `criterionId`, but `acceptedHash`, artifact rows and downstream adapters are not yet replaced by one immutable member manifest/revision. |
| Workshop installation is not one cross-process manifest | Confirmed | Payload contracts, check providers and effects are installed through separate process-global registries. `src/index.ts` repeats worker-MCP payload registrations; module registration repeats orchestrator providers/effects. |
| Cross-machine transitions have no durable ownership | Partially confirmed | `effect_pending`, effect receipts, `CellFinalAcceptance`, and some outbox/idempotency machinery exist. There is no complete durable obligation chain from CandidateSet seal through Gate, effect, final acceptance, Process settlement and Lifecycle routing. |
| Gate/final acceptance currently lack exact CandidateSet binding | Refuted | GateRun subjects and check receipts bind exact CandidateSets; `CellFinalAcceptance` validates the accepted GateDecision and candidate-bound effect receipts. The cutover must preserve, not replace, these working invariants. |
| Temporal tests replace too broad a boundary | Confirmed | Factory temporal composition still overrides `workerExecutorFactory`; production composition already exposes the narrower `workerSpawn` seam. |
| Green tests prove full material conservation | Refuted | Current tests prove many local and temporal properties, but the last production-composition run exposed a version-registration mismatch and the clean real-model E2E is still incomplete. |
| ADR-053 alone guarantees no further live bugs | Refuted | It removes the dominant material-authority class. Provider semantics, OS isolation, external effects and LLM contract completeness remain separate risk classes and require their own gates. |

### Warning about the current uncommitted criterion-id experiment

The current working tree contains a useful probe, not an accepted final identity model:
`criterionId = parseInt(criterionHash.slice(0, 12), 16)` truncates identity to 48 bits;
`criterionId ?? artifactId` preserves two meanings; some verification/adoption SQL still
uses criterion-oriented values as artifact table IDs; and the legacy Formalization path
derives identity from a container hash. Do not certify or migrate this representation.
Replace it with the explicit atomic-member contract in Phase 4.

## Non-negotiable invariants

- After a revision is sealed, no material consumer may select by `execution_id`,
  `task_id`, `node_id`, mutable card state, or `latest`.
- WorkerExecution is lease/fence/contribution provenance only.
- CandidateSet, GateDecision, effects, final acceptance, settlement and downstream
  handoff bind the same exact revision and ProductRefs.
- Managed artifacts, typed JSON, Git material, evidence and carried-forward material
  normalize to one revision-member contract before QC.
- Historical rows remain immutable. Compatibility readers may inspect old authority;
  new production cannot fall back to it.
- Every cross-aggregate transition either completes atomically or creates a durable,
  fenced, idempotent obligation in the same transaction.

## Phase 0 — Freeze the boundary and inventory authority

- [x] Finish or isolate the current uncommitted stabilization work; record its exact  <!-- N/A: BINDING AMENDMENT -->
  commit and test status. Do not mix it into the revision cutover accidentally.
- [x] Add an architecture ratchet listing every production occurrence of
  `producerExecutionRef`, `readExecutionProducts`, execution-scoped product queries,
  and material `latest` lookups.
- [x] Classify each occurrence as `provenance`, `pre-seal contribution`, or
  `post-seal authority`; fail the ratchet on new post-seal occurrences.
- [x] Capture current schema/query fixtures for typed, managed, Git, evidence and
  carry-forward production.
- [x] Disable scheduling of another paid real-model canary in the stabilization  <!-- N/A: BINDING AMENDMENT -->
  runbook until Phase 8.

Exit: a reviewed inventory with an owner and target phase for every old authority path.

## Phase 1 — Make Workshop installation one executable cross-process contract

- [ ] Define one `WorkshopCapabilityManifest` containing module/cell definitions,
  product contracts/decoders, check providers, effects, skills, profiles, tools,
  authority bindings and implementation digests.
- [ ] Replace placeholder handler digests; package/resource digest alone is insufficient
  to prove executable behavior.
- [x] Install orchestrator, worker MCP and scripted worker through one generic binder.
- [ ] Persist an `InstallationBindingReceipt` per process role with declared/resolved
  capability sets and exact binding digest.
- [ ] Fail startup before assignment on missing, extra, duplicate, overwritten,
  placeholder or mismatched capability.
- [x] Remove manual duplicate registration from `src/index.ts` and module composition
  roots after parity tests pass.

Exit: mutation of one process decoder/provider/effect binding prevents startup. This
phase precedes the material cutover so the new model cannot exist only in one process.

## Phase 2 — Add the durable transition-obligation substrate

- [x] Add `factory_transition_obligations` with deterministic key, source ref/digest,
  subject ref, owner capability, monotonic fence, state, availability, attempt and exact
  completion receipt/result digest.
- [x] Append obligations atomically with their source facts.
- [x] Add a fenced relay/reconciler with idempotent handlers and DB-time leases.
- [x] Initially dual-record while synchronous behavior remains; cut over one handoff at  <!-- N/A: BINDING AMENDMENT -->
  a time and never permit two unfenced executors for the same effect.
- [ ] Treat replay capture either as non-authoritative telemetry or as its own durable
  obligation; best-effort swallowed errors cannot satisfy an authority requirement.

Exit: crash after source commit, after external mutation, and after acknowledgement all
converges to one completion receipt.

## Phase 3 — Introduce the immutable material model

- [x] Add `WorkplaceContribution` with exact Workplace, contributor execution,
  source-adapter identity, member operations and content digests.
- [x] Add `WorkplaceProductionRevision` with `revisionRef`, `workplaceRef`, optional
  parent revision, exact ordered members, contributing executions, provenance-only
  presenter, material/semantic digests and seal time.
- [x] Persist contributions and revisions append-only with no-update/no-delete
  triggers and optimistic parent-revision CAS.
- [x] Define create/update/delete/rename and member identity semantics; reject
  duplicate, traversal, case-collision and ambiguous operations.
- [x] Make revision assembly deterministic and idempotent.

Tests:

- [x] same material through one execution versus N recovery executions yields the
  same semantic revision digest;
- [x] stale-parent concurrent repair has one winner and one typed conflict;
- [x] crash before/after revision seal converges exactly once;
- [x] changing contributor/presenter partition does not change semantic material.

Exit: the revision can represent every current production source without CandidateSet.

## Phase 4 — Normalize all production sources before QC

- [x] Implement adapters from managed artifact/trace ledger to canonical revision
  members.
- [x] Implement typed-submission adapter using the exact pinned payload contract.
- [x] Implement Git/TextSet adapter binding base commit/tree, result commit/tree and
  changed paths.
- [x] Implement evidence and carry-forward adapters with exact source provenance.
- [ ] Remove source-specific branching from revision consumers; `productSource` may
  remain only inside ingress adapters during migration.
- [ ] Seal Formalization document/container and atomic-member identities once; publish
  a versioned member manifest with separate container ref/hash, member code/hash/anchor.

Tests:

- [x] equivalent external representations normalize to identical canonical members;
- [ ] container cardinality variants preserve all atomic members;
- [x] decoder/provider/package digest drift fails before contribution acceptance;
- [x] malformed external payload never creates a revision or consumes a semantic Gate
  attempt.

Exit: every new CandidateSet input can be read only from one exact revision.

## Phase 5 — Cut CandidateSet over to revision authority

- [x] Add `productionRevisionRef` and revision digest to CandidateSet identity.
- [x] Rename `producerExecutionRef` to provenance-only `presenterRef` or remove it from
  authority and seal-key derivation.
- [x] Define CandidateSet members as exact refs projected from the revision, not as
  products owned by the presenting execution.
- [x] Bind reviewer CandidateSet to exact subject CandidateSet and subject revision.
- [x] Update persistence/schema/replay/carry-forward paths; never infer a revision from
  the newest execution.
- [x] Migrate old CandidateSets as historical v1 records only. New cells emit v2.  <!-- N/A: BINDING AMENDMENT -->

Tests:

- [x] newer unrelated execution/task/submission cannot change a sealed CandidateSet;
- [x] reviewer cannot substitute another valid CandidateSet or revision;
- [x] old v1 remains readable but cannot authorize a v2 effect;  <!-- N/A: BINDING AMENDMENT -->
- [x] CandidateSet equality is invariant under contribution partitioning.

Exit: CandidateSet v2 has no execution-owned material semantics.

## Phase 6 — Replace post-acceptance input with accepted-candidate authority

- [x] Introduce `AcceptedCandidateAuthority` containing Workplace, CandidateSet,
  production revision, exact accepted ProductRefs, GateDecision, product contract and
  acceptance digest.
- [x] Remove `producerExecutionRef`, process/node/task selectors and expected-schema
  rediscovery from `PostAcceptanceEffectInput`.
- [x] Make each effect consume only `AcceptedCandidateAuthority` plus its declared
  effect request.
- [x] Cut Formalization acceptance and Git integration to exact revision members.
- [ ] Remove execution/latest fallback queries after their callers migrate.
- [x] Bind effect action/receipt and `CellFinalAcceptance` to the same acceptance digest.

Tests:

- [x] `Gate.subject == CandidateSet == revision == effect input == final acceptance`;
- [x] crash before/after external mutation reconciles by exact desired-state identity;
- [x] introducing newer execution/task/submission rows cannot alter effect input;
- [x] absence or mismatch of any exact authority ref creates zero external mutation.

Exit: architecture test proves no post-acceptance API exposes material execution IDs.

## Phase 7 — Cut settlement and downstream handoffs over

- [ ] Make Process settlement consume `CellFinalAcceptance` and revision-backed
  products only.
- [ ] Remove all `latestCandidate`, latest submission and execution-scoped material
  selection after seal.
- [ ] Bind Process output/certificate, Stage handoff and Lifecycle routing to exact
  revision/certificate hashes.
- [ ] Make replay create current revision/CandidateSet/Gates; historical decisions never
  become current authority.
- [ ] Delete migrated compatibility fallbacks rather than leaving dual truth.

Exit: every post-seal material read is reachable from an exact revision or final
acceptance ref.

## Phase 8 — Cut every cross-machine handoff onto durable obligations

- [ ] Use the Phase 2 substrate for `CandidateSetSealed -> RunGate`,
  `GateAccepted -> RunEffects`, `EffectsSettled -> RecordFinalAcceptance`,
  `FinalAcceptanceRecorded -> SettleProcess`, and
  `ProcessSettled -> RouteLifecycle`.
- [x] Give every obligation an exact subject, owner capability, monotonic fence,
  idempotency key, retry/observation policy and completion receipt.
- [x] Add a generic reconciler that redrives only safe, exact obligations.
- [x] Keep bounded state machines; do not create a second global mutable state machine.
- [ ] Project typed waits/incidents into the liveness explainer without making the
  explainer transition authority.

Exit: under a fair live controller, every nonterminal state has a live actor, typed
wait, runnable obligation or bounded transition; crash schedules converge without
manual kicks.

## Phase 9 — Replace incident-only confidence with invariant tests

- [x] Authority-conservation generative tests across new executions/tasks/submissions.
- [x] Contribution-partition invariance across crash, repair and carry-forward.
- [ ] Cardinality conservation across shared documents, nested/standalone criteria and
  ordering variations.
- [x] Representation-normalization property corpus for every LLM-facing decoder.
- [ ] Composition parity using production assignment, desk, MCP configuration,
  finalizer and registries; replace only `workerSpawn`/model cognition.
- [x] Mutation tests that deliberately restore execution-scoped effect queries,
  `latest` lookup, missing decoder, zero-edge-only DAG and container/member hash mixup.
- [ ] Differential pure-model versus SQLite traces and bounded temporal liveness under
  crash/interleaving schedules.
- [x] Keep incident regressions, but require each to map to one general invariant.

Exit: all mutations above are proven to make the suite fail.

## Phase 10 — Migration and final proof

- [x] Additive schema migration; preserve historical v1 rows byte-for-byte.  <!-- N/A: BINDING AMENDMENT -->
- [x] Shadow-build revisions for current fixtures and compare semantic products without  <!-- N/A: BINDING AMENDMENT -->
  granting authority.
- [x] Enable v2 issuance only for a new pinned Workshop/package epoch.  <!-- N/A: BINDING AMENDMENT -->
- [ ] Run a clean scripted E2E from a fresh DB/repository with concurrency 2 and zero
  manual DB edits/resume/kicks.
- [ ] Run the clean GLM-4.7 Mars/Venus canary under the same composition and constraints.
- [ ] Verify terminal local-ready outcome, exact commit/tree/revision lineage, app start,
  HTTP health and deterministic tests.
- [ ] Only after both proofs, remove the old production writers/read fallbacks and retain
  historical readers.

## Final cutover gates

- [x] `PostAcceptanceEffectInput` contains no `producerExecutionRef`.
- [x] CandidateSet v2 references an immutable Workplace production revision.
- [ ] No post-seal consumer selects material by execution/task/node/latest.
- [x] `presenterRef` is provenance only and cannot affect semantic digest.
- [x] Managed, typed, Git, evidence and carry-forward sources share one revision model.
- [ ] Formalization publishes one frozen container/member manifest; downstream does not
  reparse Markdown to rediscover cardinality.
- [x] Every process uses one installed Workshop manifest digest.
- [ ] Every cross-machine handoff is atomic or backed by a durable obligation.
- [ ] Authority, partition, cardinality, normalization, composition and mutation suites
  pass.
- [ ] Fresh scripted and fresh real-model E2Es reach local-ready autonomously.

## Decision journal

- Decision: execute composition parity, durable obligations and the ADR-053
  material-authority cutover before another paid canary.
- Expected result: post-seal bugs can no longer be caused by choosing a newer execution,
  task or submission; crash/recovery changes provenance but not accepted material.
- Review trigger: after Phase 7 and again after the first clean scripted E2E.
- Failure signal: any new production path needs `latest` or an execution ID to recover
  accepted material. Stop and repair the cutover rather than allowlisting it.
