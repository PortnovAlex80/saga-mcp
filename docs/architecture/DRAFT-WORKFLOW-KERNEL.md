# Workflow Kernel — Reference (DRAFT for EK-10 landing)

> **Status: DRAFT.** This document is prepared by WP-14 for the EK-10
> canonical-documentation landing. It describes the **target protocol** being
> built by WP-05…WP-18. Until EK-8 performs the hard cutover, the production
> entrypoint still selects the legacy runtime, and this document is
> normative-for-review, not a description of running code.
>
> **Authority chain:** this reference is derived from, and must stay consistent
> with, these frozen artifacts (in case of conflict, the machine artifacts win):
>
> 1. `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md`
>    (target logical model, architecture laws, phase gates) — ADR-097/ADR-098.
> 2. `docs/refactoring/event-kernel/specs/frozen-inputs/transition-universe.json`
>    — the frozen unified transition universe: 9 aggregates (+4 authorities),
>    53 commands, 49 obligation kinds, 5 wait kinds, 28 terminal proofs,
>    67 evidence kinds.
> 3. `docs/refactoring/event-kernel/specs/frozen-inputs/PROTOCOL-DECISIONS-FROZEN.md`
>    — decisions D1–D12; a semantic change reopens EK-1.
> 4. `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
>    — the accepted-material chain preserved inside Workplace transactions.
>
> A new release of this document is required whenever the transition universe,
> the complexity budget, the role-contract schema or the prompt-budget schema
> changes (all EK-1-reopening events).

---

## 1. What the kernel is

The workflow kernel is the single production orchestration authority of the
factory. It owns **who may change which fact, in which transaction, with which
proof**. Everything else in the system is either:

- an **immutable input** (operator idea, capsule, installed workshop manifest),
- a **semantic package** (workshop: schemas, checks, prompts, effects), or
- a **projection** (Kanban cards, UI, reports).

Three laws define it (full plain-language treatment in
`CONVEYOR-MENTAL-MODEL.md`):

1. **One authority** — every mutable fact has exactly one owning aggregate
   repository; only that repository may compare-and-set its revision.
2. **Durable handoff** — every cross-owner edge is one atomic
   `event + obligation` grammar committed by the source owner; a replaceable
   stateless consumer leases obligations and invokes the target command.
3. **Projection-only Kanban** — workflow state lives in aggregate heads,
   events, obligations, waits and proofs; cards are disposable read models.

## 2. Aggregates and sole writers

Nine aggregates own all mutable workflow state (frozen universe
`aggregates[]`; physical names frozen by decision D1):

| Aggregate | Sole writer | CAS discipline | Owns |
|---|---|---|---|
| `FactoryRun` | FactoryRun repository | run revision | run identity, pinned build/package/capsule digests, final run proof |
| `LifecycleRun` | LifecycleRun repository | lifecycle revision | lifecycle state; continuation parent lineage as immutable evidence |
| `StageRun` | StageRun repository | stage revision | stage state; one installed process module bound per stage |
| `ProcessRun` | ProcessRun repository | process revision | declared module flow cursor |
| `NodeRun` | NodeRun repository | node revision | kernel / production-cell / human / provider node instances |
| `Workplace` | Workplace repository | workplace revision | author/reviewer/repair loop **and** the ADR-053 accepted-material chain (`WorkplaceProductionRevision`, `CandidateSet`, `GateDecision`, `EffectReceipt`, `CellFinalAcceptance` commit in Workplace transactions) |
| `ActivityAttempt` | ActivityAttempt repository | attempt lease CAS + CAS-fenced `contextRevision` | attempt lease/provenance and context-admission counters; **never accepted-material authority** |
| `WorkItem` | planning repository (creation only) | immutable after creation | WorkItem + WorkItemDependency + planning-claim coverage facts |
| `CognitionTransport` | none — stateless replaceable boundary | none | instrumented provider transport; admission linearization immediately before final serialization/network send |

Four **non-aggregate authorities** complete the ownership map:

| Authority | Role |
|---|---|
| `Planning` | single immutable creation command authority for WorkItem/WorkItemDependency/planning-claim facts (`workItem.planGraph`) |
| `InstalledWorkshopManifest` | immutable content-addressed workshop semantics: CheckPlans, `CanonicalRoleContract`, `PromptBudgetProfile`, effect contracts |
| `TargetOwnerCapability` | the stateless obligation consumer acting for the exact target aggregate named by an obligation; obligation-ledger rows complete only in the target fact's transaction |
| `Input` | external inputs: operator idea, capsule, typed operator commands, manifest, planning facts |

Rules that hold for every aggregate:

- A projector, UI, worker, reconciler, watchdog or recovery tool may issue a
  typed command but may never write aggregate state directly.
- No decision may select authority using `latest`, descending chronology,
  maximum IDs, task status, execution status, node status or a lossy projection.
- A `WorkflowEvent` is the immutable receipt emitted by the owning aggregate in
  the same transaction; it is not a second writer, and current state is never
  discovered by selecting the "latest" event.
- There is no run-wide supervisor authority. A scheduler may lease obligations;
  it is stateless and replaceable.

## 3. Relation model

The schema contains exactly the logical relations of the plan's target model
plus the catalog/authentication relations justified by the authority census:

`ProtocolMetadata`, `FactoryRun`, `LifecycleRun`, `StageRun`, `ProcessRun`,
`NodeRun`, `WorkItem`, `WorkItemDependency`, `Workplace`, `WorkIntent`,
`ActivityAttempt`, `PromptAssemblyReceipt`, `WorkplaceProductionRevision`,
`CandidateSet`, `GateDecision`, `EffectReceipt`, `CellFinalAcceptance`,
`WorkflowEvent`, `TransitionObligation`, `TypedWait`, `TerminalProof`,
`KanbanCard`.

`CanonicalRoleContract` and `PromptBudgetProfile` are immutable
content-addressed values in the installed workshop manifest — not mutable
relations. Do not add a generic mutable "current state" table (second owner)
or a run-wide supervisor.

## 4. Command vocabulary (53, frozen)

Commands are the only way any state changes. Every command names its owner
aggregate, takes exact evidence references and an expected revision, and
commits its facts, `WorkflowEvent`, next obligations/waits/proofs in one
transaction. Grouped by owner:

**FactoryRun (7):** `factoryRun.bootstrap` · `factoryRun.importCapsule` ·
`factoryRun.start` · `factoryRun.requestStop` · `factoryRun.resume` ·
`factoryRun.observeWatchdog` (D9: observe-only, durable evidence, never repair
SQL) · `factoryRun.recordRunTerminalProof`

**LifecycleRun (6):** `lifecycleRun.create` · `lifecycleRun.createContinuation`
· `lifecycleRun.routeOutcome` · `lifecycleRun.issueTerminalProof` ·
`lifecycleRun.cancel` (D3: proofs at {lifecycle, run} scope name member
dispositions; cells/workplaces/nodes/attempts get dispositions, not 7-scope
proof explosions) · `lifecycleRun.verifyTerminalClaims` (D4: verifier receipt
is LifecycleRun-owned; verifier is not an author/reviewer kernel role)

**StageRun (3):** `stageRun.create` · `stageRun.activate` ·
`stageRun.recordLocalOutcome`

**ProcessRun (5):** `processRun.create` · `processRun.enterNode` ·
`processRun.recordNodeTerminal` · `processRun.settle` (D1: the name is
frozen) · `processRun.settleFailure`

**NodeRun (8):** `nodeRun.create` · `nodeRun.materializeCell` ·
`nodeRun.recordKernelResult` · `nodeRun.recordCellAcceptance` ·
`nodeRun.recordHumanDecision` · `nodeRun.recordProviderOutcome` (re-typed
per reconciliation R13: the EffectReceipt fact commits in the owning Workplace
transaction via `workplace.settleEffect`; this command submits provider
outcome evidence) ·
`nodeRun.settleUnreachable` · `nodeRun.fail`

**WorkItem (1):** `workItem.planGraph` (D10: carries the
`obligation:openUnknownObligation` clause — Discovery unknowns cannot
disappear at a workshop boundary)

**Workplace (16):** `workplace.materialize` · `workplace.admitWorkIntent` ·
`workplace.recordContribution` · `workplace.sealProductionRevision` ·
`workplace.presentCandidateSet` · `workplace.runAuthorGate` ·
`workplace.runFinalGate` · `workplace.enterRepairWait` ·
`workplace.rolloverRepairEpoch` · `workplace.widenAuthorityScope` ·
`workplace.enterHumanWait` · `workplace.resolveHumanResponse` ·
`workplace.settleEffect` · `workplace.recordFinalAcceptance` ·
`workplace.closePresentation` · `workplace.issueWorkplaceTerminalProof`

**ActivityAttempt (6):** `activityAttempt.create` (copies
`roleContractRef`+`roleContractDigest` from the exact WorkIntent; atomically
verifies equality, installed-package digest, protocolRole and current
Workplace transition) · `activityAttempt.admitProviderRequest` (the cumulative
context accountant; see §8) · `activityAttempt.recordProviderRefusal` ·
`activityAttempt.recordOutcome` · `activityAttempt.classifyWorkerLoss` ·
`activityAttempt.cancel` (D3)

**CognitionTransport (1):** `cognition.sendProviderRequest` — replaceable
transport, not an aggregate owner; enforces
`maxOutputTokens <= reservedOutputTokens` or refuses the provider/model.

## 5. WorkflowEvent grammar

Every command commit appends immutable `WorkflowEvent` receipts:

```text
WorkflowEvent {
  sourceOwner        // the owning aggregate that emitted it (sole writer)
  sourceRevision     // exact revision after the commit
  transitionKind     // e.g. workplace.workIntentAdmitted
  evidenceRefs[]     // exact references to facts/evidence committed with it
}
```

Events are receipts, not authority. Ordinary commands read the exact owner at
the expected revision. An offline replay may verify an aggregate head against
its ordered stream, but production code never discovers current state by
selecting the latest event.

## 6. Durable handoff and the obligation ledger (49 kinds)

The source command of every cross-owner edge commits this grammar in one
transaction:

```text
source fact or immutable evidence
  + exact WorkflowEvent
  + one durable TransitionObligation per target-owner edge
```

A `TransitionObligation` names: target command, expected target revision,
capability, evidence references, lease/fence and completion receipt. The
replaceable consumer then:

```text
lease one exact obligation by CAS and fence
  -> load the target aggregate at the expected revision
  -> invoke the target aggregate command with exact evidence references
  -> atomically commit:
       target fact/evidence
       obligation completion receipt
       next obligations, or typed wait, or terminal proof
```

Consumer rules: the consumer owns no run-wide truth; retrying the same
obligation is idempotent; a stale lease, stale expected revision or foreign
evidence reference is refused with a typed reason; fan-out creates explicit
obligations; fan-in checks exact predecessor final-acceptance/effect evidence;
a terminally failed predecessor makes dependants explicitly unreachable
(`obligation:markDependantsUnreachable`) and creates runnable settlement work —
nothing waits on a dead wake source.

Frozen obligation kinds (49):

`ingestCapsuleFacts`, `bootstrapLifecycleRun`,
`enterStage.initial-discovery`, `enterStage.solution-formalization`,
`enterStage.solution-development`, `enterStage.delivery-release`,
`enterStage.continuation`, `routeLifecycle`, `replayCaptureSweep` (D8: owned by
the Certification Workplace — the single effect writer),
`bindProcessModule`, `enterFirstNode`,
`materializeWorkplace.production-cell`, `materializeWorkplace.workItems-fanout`,
`materializeWorkplace.verificationItems-fanout`, `instantiateDependantWorkplaces`,
`openUnknownObligation` (D10), `launchAdmission`, `providerSend`,
`submitContribution`, `sealRevision`, `presentCandidates`, `runGate.author`,
`runGate.final`, `openReviewerDesk`, `runEffects`, `routeUpstreamRepair`,
`requeueRepair`, `requeueAfterBackoff`, `requeueWidened`,
`requeueAfterHumanResolution`, `resumeEffect`, `effectRedrive`,
`completeCellNode`, `closePresentation`, `propagateCellFailure`,
`markDependantsUnreachable`, `propagateNodeFailure`, `recordStageOutcome`,
`recordStageOutcome.failed`, `advanceProcessFlow`, `advanceProcessFlow.settle`,
`freezeCandidate`, `retryAttempt`, `publishRelease`, `observeRelease`,
`watchdogRestart`, `watchdogBudgetExhausted`, `verifyTerminalClaims`,
`runSettlement`.

(All with the `obligation:` prefix in the universe artifact.)

## 7. Typed waits (5 kinds, frozen)

Every nonterminal scope must have a runnable obligation, a typed wait with a
**durable wake source**, or a transition committed in the same transaction.
Frozen wait kinds:

| Kind | Wake source | Discharge evidence |
|---|---|---|
| `TypedWait:human-input` | operator human-response command (`workplace.resolveHumanResponse`) or approval-decision command (`nodeRun.recordHumanDecision`) | `WakeDischarge:human-response-command` |
| `TypedWait:external-availability` | substrate re-probe obligation with deadline (bounded in-check retry; typed unknown on exhaustion — never product-failed) | `WakeDischarge:external-availability-event` (D5) |
| `TypedWait:policy-quota` | backoff deadline obligation (`requeueAfterBackoff`) or operator resume (`factoryRun.resume`) after `requestStop` | `WakeDischarge:policy-quota-release` (D5) |
| `TypedWait:readiness` | predecessor `CellFinalAcceptance`/`EffectReceipt` arrival (predecessor obligation completion); a terminally failed predecessor converts this wait into unreachable settlement via `obligation:markDependantsUnreachable` — never a dead wake source | obligation-completion receipts of the named wake sources (D5) |
| `TypedWait:effect-uncertainty` | operator resolution command — never an automatic duplicate of a non-idempotent external send/effect (D12) | operator disposition command receipt |

Wake discharge is always the obligation-completion receipt of the named wake
source (D5): no new receipt kinds, no busy-spin polling loops.

## 8. Context admission (ActivityAttempt-owned)

`ActivityAttempt` is the sole mutable owner of context admission: it stores
CAS-fenced `contextRevision`, `nextRequestOrdinal` and
`cumulativeInputTokens`. `activityAttempt.admitProviderRequest(
expectedContextRevision, envelope)`:

- runs **once** before every provider request at the linearization point
  immediately before final request serialization/network send (after system
  prompts, skills, tool schemas, hook `additionalContext`, retained
  assistant/tool results and recovery injections);
- enforces the pinned `PromptBudgetProfile`: per-request window and
  cumulative session budget, request ordinal, output bound;
- on admission: advances ordinal/cumulative counters, appends an immutable
  **admitted** `PromptAssemblyReceipt`, creates the exact idempotent
  provider-send obligation — all in one transaction;
- on refusal: appends a **refused** receipt, persists the rejected-envelope
  digest and typed result, and consumes neither context nor worker-retry
  budget; the identical request is never reissued.

Receipts record `admitted|refused`, never `sent`; send/outcome evidence is
separate (`ProviderSendOutcome`). A crash before send redrives the same
provider-send obligation and ordinal. Zero, missing or unsupported limits fail
closed — never "unlimited". The accountant never derives authority by
selecting a latest receipt or summing receipt rows.

## 9. Terminal proofs (28, frozen)

Terminalization has an exact proof; **an empty queue is never a proof**.
Kinds × scopes (D7: unreachable proofs exist only at {cell, workplace, node};
run-scope refusals stay pre-run `TypedRefusalReceipt`):

| Scope | success | truthful-failure | cancellation | unreachable |
|---|---|---|---|---|
| cell | `workplace.recordFinalAcceptance` | `workplace.runAuthorGate` / `runFinalGate` / `settleEffect` | `lifecycleRun.cancel` | `workplace.issueWorkplaceTerminalProof` |
| workplace | `workplace.issueWorkplaceTerminalProof` | `workplace.rolloverRepairEpoch` / `widenAuthorityScope` | `lifecycleRun.cancel` | `workplace.issueWorkplaceTerminalProof` |
| node | `nodeRun.recordCellAcceptance` / `recordKernelResult` | `nodeRun.fail` | `lifecycleRun.cancel` | `nodeRun.settleUnreachable` |
| process | `processRun.settle` | `processRun.settleFailure` | `lifecycleRun.cancel` | — (D7) |
| stage | `stageRun.recordLocalOutcome` | `stageRun.recordLocalOutcome` | `lifecycleRun.cancel` | — (D7) |
| lifecycle | `lifecycleRun.issueTerminalProof` | `lifecycleRun.issueTerminalProof` | `lifecycleRun.cancel` | — (D7) |
| run | `factoryRun.recordRunTerminalProof` | `factoryRun.recordRunTerminalProof` | `factoryRun.recordRunTerminalProof` | — (D7) |

Truthful failure at cell scope follows the repair-epoch ledger: repair-epoch
exhaustion plus a scope-refusal receipt (`RepairTerminalityEvidence`, D6) —
an honest terminal, not a hang. Cancellation proofs at {lifecycle, run} scope
name member dispositions (`TypedWaitDisposition`, D3).

The universe artifact contains one row per (scope × kind) — 28 rows total —
but the four `unreachable` rows outside {cell, workplace, node} carry
`issuingCommand: "unresolved - unreachable scope set frozen by D7"` and are
D7 placeholders, not demonstrable transitions: run-scope refusals stay
pre-run `TypedRefusalReceipt`. A "declared equals demonstrated" check must
read them accordingly.

## 10. Evidence kinds (67, frozen)

Evidence families (full list in the universe artifact): accepted-material
chain (`CellFinalAcceptance` [D11: embeds acceptanceDigest + digest equality],
`GateDecision:{accepted,repair,upstream-repair,human-wait,terminal-reject}`,
`CheckPlan`, `CandidateSet:{author,reviewer}`, `WorkplaceProductionRevision`,
`AcceptedCandidateAuthority`); attempts and contracts
(`ActivityAttemptContribution`, `ActivityAttempt:{completed,failed-typed,cancelled}`,
`WorkIntent`, `CanonicalRoleContractBinding`, `PromptAssemblyReceipt:{admitted,refused}`,
`ProviderSendOutcome`, `ProviderRoutePin`); the kernel ledger
(`TransitionObligation`, `ObligationCompletionReceipt`,
`SettlementWorkObligation`, all `TypedWait:*`, `WakeDischarge:*`,
`TypedWaitDisposition`, `OperatorStopCommand`, `WorkflowEvent`); planning
(`WorkItem`, `WorkItemDependency`, `WorkItemObligationMapping`,
`EpicScopeCoverage`, `DeferredScopeEntry`, `DiscoveryUnknownObligation` [D10],
`QualitativeRequirementDisposition`, `TerminalLifecycleClaim`,
`TerminalClaimCoverage`, `ConstructionSurface`, `ExecutableVerifierResult` [D4],
`SeamOwnership`); effects (`EffectReceipt:{success,already-applied,retryable,
unknown,human-wait,policy-terminal,repair}` [D2: seven kinds],
`EffectPolicyRefusal`); ingress and routing (`CapsuleIngressReceipt`,
`ProductVerificationEvidence`, `ProductVerificationFailure`,
`ContextEnvelopeComplianceEvidence`, `ForwardReverseReconciliationReceipt`,
`TypedRefusalReceipt` [D7], `InputEvidenceRefs`, `LifecycleRoutingReceipt`,
`ProcessOutcomeCertificate`, `RecoveryIssue`, `RepairTerminalityEvidence` [D6],
`WatchdogObservation` [D9]).

## 11. Projection boundary

`KanbanCard` is a rebuildable operator projection only:

- The projector derives cards from WorkItems, current aggregate evidence,
  obligations, waits and terminal proofs.
- TODO / in-progress / review / repair / waiting / terminal columns are human
  views, never workflow inputs.
- Operator actions (claim, review, stop, resume, retry, human response)
  translate into typed domain commands; there is no API that directly sets a
  production card status.
- Deleting all Kanban rows and rebuilding them is a normal supported operation
  with no production consequence (three mandatory mutations at EK-9 prove it).
- A repository-wide ratchet finds no production scheduling, dependency,
  material, effect or terminal decision based on projection rows.
- The tracker displays pinned role-contract and prompt-receipt references for
  diagnosis; it may not select a role, skill, tool set, completion command or
  prompt budget.

## 12. Fresh protocol identity

- A new database bootstraps from one declarative schema carrying an exact
  protocol identifier and schema fingerprint (`ProtocolMetadata`, immutable
  after creation).
- An empty path creates the new protocol; a database with the exact new
  identifier and fingerprint opens; **any other non-empty database fails
  closed** with `FACTORY_DATABASE_PROTOCOL_UNSUPPORTED` and an
  operator-facing instruction to choose a fresh database path — no file
  mutation, no migration, no adoption, no dual read/write.
- Old databases may be preserved offline as incident evidence; production code
  contains no reader, importer or migration path for them.
- Capsules are content-addressed external input bundles imported through
  public new-protocol ingress into a fresh database; they never seed authority
  rows directly.

## 13. Immutable protocol values

Two content-addressed value families live in the installed workshop manifest
(see the frozen specs under
`docs/refactoring/event-kernel/specs/`):

- **`CanonicalRoleContract`** — protocol role (`author|reviewer`), semantic
  profile, pinned skills/executor route policy/capabilities/tools, product
  contracts, evidence obligations, completion command schema, tracker
  projection profile, prompt-budget profile — each with digests, plus a
  `contractDigest`. `executorRoutePolicyRef` is the sole provider/model
  selection authority (finite declarative eligibility table; no task/status/
  workshop inference). No fallback to task status, tags, execution status,
  assignment skill, tracker state or global skill roots.
- **`PromptBudgetProfile`** — provider/model limit table reference, context
  window, token counter reference+version, per-request/static/dynamic/
  recovery/tool-result/total/cumulative token caps, reserved output tokens,
  provider overhead reserve, safety margin, prompt byte cap. Every profile has
  a positive finite limit.

## 14. Change discipline

- Adding a command, obligation kind, wait kind, proof scope, evidence kind,
  relation or contract field **reopens EK-1** and invalidates downstream
  qualification evidence.
- A newly discovered incident may add a minimized scenario; it may not add a
  state, relation, mutable owner, orchestration path or policy layer until an
  independent verifier approves a measured complexity delta before code is
  written.
- The current structure must satisfy every finite cap of
  `complexity-budget.json` (conjunctive envelope; no waivers).
- Stop if you cannot name the owner, command, event, obligation and proof for
  a changed transition.
