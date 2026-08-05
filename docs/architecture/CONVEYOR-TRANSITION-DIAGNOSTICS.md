# Appendix: universal transition diagnostics and logging

**Status:** normative target contract  
**Applies to:** every lifecycle and every installed process module

## 1. Purpose and universality

The factory needs one answer to one operational question: **what exact durable
condition prevents this order from advancing?** The answer must not depend on
whether the current module is Discovery, Formalization, Development, Delivery,
or module number 1000.

The universal execution grammar is:

```text
FactoryOrder / LifecycleRun
  -> StageRun(moduleRef)
  -> ProcessRun(packageRef, definitionDigest)
  -> NodeRun(flow cursor)
  -> Workplace(production cell instance)
  -> WorkerExecution -> CandidateSet -> GateRun
  -> CheckReceipt[] -> GateDecision
  -> ProcessOutcomeCertificate
  -> lifecycle transition -> next StageRun
```

Control and effect nodes may omit the worker/quality loop, but they use the same
NodeRun cursor, typed outcome, idempotency and transition journal. Workshop
names are labels and package selectors, never branches in the diagnostic
engine.

## 2. Three records with different authority

| Layer | Purpose | May authorize a transition? | Retention |
| --- | --- | --- | --- |
| Domain state and evidence | Workplaces, executions, products, CandidateSets, receipts, decisions, outcomes and transitions | **Yes. This is the source of truth.** | at least the order retention period |
| Causal event journal | durable, non-authoritative diagnostic history linked to authoritative evidence | No; it explains and locates authority | same as the order; only its derived views are rebuildable |
| Runtime telemetry | stdout/stderr, timings, model/provider details, stack traces and metrics | Never | rotated operational retention |

`activity_log` remains a useful human audit projection, but its current
entity/action/summary shape is not a causal transition ledger. A message such as
“review passed” cannot replace a `CheckReceipt` or `GateDecision`. Likewise, a
missing log line cannot annul a committed decision.

## 3. Universal causal envelope

Every application command carries an immutable, entry-point-validated
`CausalContext`. User commands create roots; timers, supervisors, checkpoint
adoption and outbox retries declare their synthetic origin. Children inherit
correlation and use a typed causation ref (`command|event|launch|execution`).

The common header below is combined with a versioned discriminated payload
(`mutation.committed`, `command.rejected`, `command.conflict`,
`runtime.exception`). Each family declares mandatory authority/evidence refs;
invalid envelopes are rejected at the instrumentation boundary.

```text
schemaVersion, eventId, eventKind, occurredAt, severity
factoryOrderRef, projectRef, lifecycleRunRef, stageRunRef
processRunRef, moduleRef, nodeRunRef, workplaceRef
workerExecutionRef, reservationRef, fence
candidateSetRef, gateRunRef, checkReceiptRefs, gateDecisionRef
correlationId, typedCausationRef, commandId, idempotencyKeyDigest
authorityType, authorityRef, revisionBefore, revisionAfter
sourceSequence, commitDisposition, outcome, reasonCode
evidenceRefs[], payloadDigest, allowlistedSafeDetails, coverage
```

Rules:

1. `correlationId` is stable for the user operation; `causationId` points to the
   preceding event/command; references form the path across workshops.
2. A newly cut-over mutation and its minimal outbox obligation commit in the
   **same database transaction**, or both roll back. Journal materialization is
   eventual and idempotent. Rejected/conflicted/exception observations are
   written after rollback in a separate best-effort transaction with an exact
   disposition; if the database itself is unavailable, only emergency telemetry
   may survive and the diagnostic gap must be reported.
3. Payloads are content-addressed; prompts, secrets and full artifact contents
   are referenced and redacted by default, not copied into logs.
4. `reasonCode` is closed and machine-readable. Free text is explanatory only.
5. Projections may be rebuilt. Domain evidence is immutable or revision-fenced.
6. Per-source sequence, uniqueness by source revision/event kind, payload digest
   and immutable rows make duplicate outbox delivery one effective event.
7. A governance-relevant rejection requires an authoritative command, check,
   gate or effect receipt. A diagnostic observation alone is never proof.

Reason-code families are universal: `IDENTITY_*`, `INPUT_*`, `ROUTING_*`,
`NODE_*`, `WORKPLACE_*`, `RESERVATION_*`, `EXECUTION_*`, `PRODUCT_*`,
`REVIEW_*`, `CHECK_*`, `GATE_*`, `SETTLEMENT_*`, `EFFECT_*`, `RECOVERY_*`,
`CHECKPOINT_*`, `INFRA_*`, and `INVARIANT_*`. Codes live in a versioned registry
with invariant, severity, retry class, owner and safe rendering template. An
unknown code maps to `INFRA_UNREGISTERED_REASON_CODE`. Module-specific checks keep a
namespaced provider code inside `CHECK_*`; they do not invent a new transition
state machine.

## 4. Conditions of transition

| Boundary | Required durable proof | If absent or rejected |
| --- | --- | --- |
| order -> current stage | exactly one resumable order/run, current StageRun and frozen input | identity/input diagnostic; fail closed |
| stage -> ProcessRun | installed/pinned module package, definition digest and mapped input | `INPUT_*` or `ROUTING_*`; no new run |
| ProcessRun -> node | exact cursor, completed predecessor bindings, transition budget | `NODE_DEPENDENCY_UNMET` or budget/invariant failure |
| node -> Workplace | deterministic WorkplaceRef/workKey, declared cell/profile and admitted revision | wait if dependency is incomplete; fail on conflicting identity |
| Workplace -> worker | eligible loop state/role, atomic reservation, live lease and new fence | wait/reap/requeue; stale fence can never submit |
| worker -> candidate | terminal execution receipt, immutable products with hashes/provenance, sealed exact CandidateSet | repair/retry; copying files is not completion |
| candidate -> gate | declared CheckPlan, exact subject/revision and all required CheckReceipts | wait, technical retry or fail closed |
| gate -> next node | one applicable typed GateDecision; `accepted` only for progress | repair, human pause or terminal failure according to verdict |
| terminal node -> next workshop | settled typed outcome/certificate, exact output mapping, idempotent lifecycle transition | settlement/routing diagnostic; do not recreate upstream work |
| effect -> observed result | authorization, stable idempotency key and EffectReceipt | reconcile unknown result; never blindly repeat |

`accepted` means semantic/mechanical quality evidence satisfied the declared
policy. A test-mode flag may replace an expensive producer with adopted
provenance-preserving candidates, but it must not fabricate receipts, bypass
the gate decision, skip transition CAS/fences, or weaken exact identity and
lineage. This is what keeps the test useful for instructions, tools, review
feedback, logging and desk-to-desk routing.

## 5. Deterministic “why not advanced?” explainer

The explainer opens one consistent read snapshot, captures an
`observedRevisionSet`, identifies the current landmark and evaluates its
versioned invariant DAG. Every applicable invariant yields
`met|unmet|unknown|not_applicable`; it then ranks root unmet invariants by the
declared topology. Multiple unordered roots become `INVARIANT_CAUSE_AMBIGUOUS`,
never a guessed cause. The scope is inspected in this order:

1. Resolve the exact FactoryOrder and LifecycleRun for the project.
2. Locate current StageRun and its bound ProcessRun.
3. Locate the exact active NodeRun/cursor and unmet predecessor binding.
4. For a production cell, inspect Workplace revision, loop state, next role,
   reservation, fence, execution lease/liveness and terminal receipt.
5. Inspect immutable products, CandidateSet, GateRun, required CheckReceipts and
   applicable GateDecision.
6. For a completed node, inspect settlement/certificate, output mapping and the
   idempotent lifecycle transition.
7. Compare the result with the journal; divergence becomes
   `INVARIANT_DIAGNOSTIC_DIVERGED`. Only after diagnosis attach telemetry as
   supporting context; telemetry cannot turn `unknown` or `unmet` into `met`.

It returns a structured incident card:

```text
scope; currentLandmark; expectedNextLandmark; blockingInvariant;
reasonCode; authorityRef; evidenceRefs; diagnosisObservedAt;
firstJournalObservationAt?; lastJournalObservationAt?;
observedRevisionSet; diagnosticCoverage; competingInvariantRefs[];
retryClass (wait|safe_retry|repair|human|terminal|reconcile);
resumeActionWithExpectedRevision; reusableProducts[]; correlationId
```

The headline status is one of `working`, `waiting_worker`, `waiting_review`,
`repair_required`, `human_required`, `technical_retry`, `reconcile_effect`,
`terminal_failed`, `completed`, or `inconsistent_state`. Silence alone never
proves a dead worker; lease/liveness/receipt evidence does.
Recommended actions are advisory, derived from current domain policy/evidence,
and revalidated by the real fenced command. External effects without a terminal
idempotency receipt always require reconciliation, never a blind safe retry.

This layer does not claim cryptographic audit proof or a deterministic
historical cause where an authoritative receipt/outbox obligation never existed.
Coverage is reported as `complete|partial|unknown`; partial or ambiguous coverage
must not be rendered as “root cause”.

## 6. Modelled epic passage

For an epic with N stages, the lifecycle materializes stage 1 and pins its
module/input. The generic flow executor completes control nodes and
materializes one or many Workplaces for production cells. A reserved worker
sees the same durable desk, exact instructions/tools/read set and, after a
rejection, the exact RecoveryIssue. It submits immutable products; the cell
seals a CandidateSet; declared checks emit receipts; the gate records one typed
decision.

On `repair_required`, the same Workplace/card/desk survives and a new fenced
execution receives the rejected candidate and feedback. On `accepted`, the
node advances. When the flow is terminal, settlement emits a certificate and
the lifecycle maps it into stage 2 without regenerating stage 1. The algorithm
repeats unchanged to stage N. Crash recovery reopens the same durable order,
cursor and Workplace; checkpoint adoption may restore missing storage, but it
does not create a parallel run.

## 7. Current implementation truth and migration

The repository already has the universal structural spine: LifecycleRun and
StageRun, ProcessRun and NodeRun, Workplace and fenced reservations, immutable
candidate/gate evidence, recovery, settlement and lifecycle transitions. The
four workshops already converge on those concepts.

The cutover is not yet complete: evidence is spread across several repositories,
`activity_log` has no shared causal context, and some module handlers still own
bespoke product/quality persistence. Therefore “1000 workshops use one
mechanism” is the enforced target, not a claim that every old path has already
been removed. Migration order:

1. introduce `CausalContext` and append-only committed/rejected event ports;
2. instrument universal application use cases and transaction/outbox writers;
3. implement the explainer projection and incident-card API/CLI;
4. migrate remaining module-local persistence to universal product/gate ports;
5. add an architecture ratchet: a new module must pass the same conformance
   suite without adding a module-name switch to lifecycle, workplace or gate.

Operational health exposes required/instrumented transition-kind coverage,
missing-context count, pending/dead outbox counts and last projection success.
