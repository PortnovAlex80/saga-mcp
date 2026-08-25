# Conveyor Transition Diagnostics — from kernel evidence (DRAFT for EK-10 landing)

> **Status: DRAFT** (WP-14, for the EK-10 landing). Diagnostics for the target
> protocol. The governing change from the previous edition: **diagnosis reads
> persisted obligation/wait/proof evidence only — never Kanban or projection
> state, never chronology, never telemetry.** Vocabulary:
> `WORKFLOW-KERNEL.md`; laws: `CONVEYOR-MENTAL-MODEL.md`; frozen machine
> vocabulary: `transition-universe.json`.

## 1. Purpose and universality

The factory needs one answer to one operational question:

> **what exact durable condition prevents this scope from advancing?**

The answer must not depend on whether the current stage is Discovery,
Formalization, Development, Delivery or the thousandth installed workshop. In
the event-projected kernel the question has an exact materialization: for
every nonterminal scope the last committed transition left behind a **runnable
obligation, a typed wait with a durable wake source, or a same-transaction
successor** (the write-time progress invariant). Diagnosis therefore reduces
to inspecting that durable residue.

Workshop names are labels of installed semantic packages, never branches in
the diagnostic engine.

## 2. Three record layers with different authority

| Layer | Purpose | May authorize a transition? | Retention |
|---|---|---|---|
| Aggregate heads, obligations, waits, proofs, evidence | workflow state and its exact receipts | **Yes. This is the source of truth.** | order retention period |
| `WorkflowEvent` journal | immutable receipts emitted by owners; explains and locates authority | No; it replay-verifies heads offline | same as order |
| Runtime telemetry (stdout/stderr, timings, provider details, stack traces) | supporting context only | Never | rotated operational retention |

Rules:

1. A projection row (Kanban card, board column) is at most a hint about where
   to look. It is never evidence of state, readiness, material or terminality.
2. A missing log line cannot annul a committed proof; a present log line
   cannot replace one. Telemetry cannot turn `unknown` or `unmet` into `met`.
3. Current state is read from the exact owning aggregate at its exact
   revision — never by selecting the latest event, latest row or maximum ID.
4. Silence alone never proves a dead worker; lease/liveness/receipt evidence
   does (`activityAttempt.classifyWorkerLoss` is a typed command with durable
   evidence, not a heuristic).

## 3. The diagnostic walk

Open one consistent snapshot. Record an `observedRevisionSet`. Walk the
ownership chain top-down; stop at the earliest landmark whose progress
invariant is unmet; rank root unmet invariants by the declared topology.
Multiple unordered roots yield `INVARIANT_CAUSE_AMBIGUOUS`, never a guessed
cause.

1. **Protocol** — `ProtocolMetadata` exists, is the exact supported protocol
   and fingerprint. Otherwise the failure is
   `FACTORY_DATABASE_PROTOCOL_UNSUPPORTED`: an operator-input problem, not a
   run problem; nothing else in this walk applies.
2. **Run** — `FactoryRun` resolves; pinned build/package/capsule digests match
   the launched kit. A stop is durable evidence (`OperatorStopCommand`),
   not an inference.
3. **Lifecycle / lineage** — the active LifecycleRun for the project (one
   active leaf in continuation lineages; a failed parent is never rewritten
   healthy).
4. **Stage / process / node** — StageRun, its bound installed module, the
   ProcessRun cursor and the exact active NodeRun. Unmet predecessor bindings
   surface here as readiness waits, not as missing rows.
5. **Obligation ledger** (the primary diagnostic surface, §4).
6. **Waits** (§5).
7. **Attempts and context admission** — attempt leases, fences,
   `contextRevision`, `PromptAssemblyReceipt` sequence, `ProviderRoutePin`,
   worker-loss classification.
8. **Material chain** — Workplace revision, production revisions,
   CandidateSets, CheckPlan receipts, GateDecisions, effect receipts,
   `CellFinalAcceptance`.
9. **Terminal proofs** (§6) and settlement.

Compare the result with the `WorkflowEvent` journal for the same snapshot;
divergence between the ledger and the journal is itself a reportable failure
(`INVARIANT_DIAGNOSTIC_DIVERGED`) — the ledger wins for state, the divergence
is a defect to file, not a data problem to patch by SQL.

## 4. The obligation ledger is the primary diagnostic surface

For the scope under diagnosis, list its `TransitionObligation` rows and
classify each:

| Ledger state | Meaning | Next diagnostic step |
|---|---|---|
| runnable, unleased | progress is scheduled; the consumer has not reached it | consumer liveness (stateless scheduler leasing), not a product problem |
| leased, lease live, fence valid | a consumer is inside the target command | the target aggregate's expected revision; watch for typed refusal reasons |
| leased, lease expired / fence lost | a stale consumer | redrive is safe — completion requires the fence; verify no completion receipt exists |
| completed, receipt present | the edge happened exactly once | follow the next obligations it created |
| completed **without** its target fact/evidence | impossible by construction | this is a kernel defect: file with both digests; never repair by hand |
| retryable substrate failure | bounded retry in progress | backoff deadline and retry count |
| refused (typed reason) | stale expected revision, foreign evidence ref, or policy refusal | read the typed reason; the refusal names the exact mismatch |

The ledger answers "why not advanced" structurally: if no runnable obligation,
no live wait and no open command exists for a nonterminal scope, the
write-time progress invariant was violated — that is a blocking kernel bug,
not an operational condition to wait out.

## 5. Wait diagnosis

Each wait names its kind and its exact durable wake source (D5: discharge is
the wake source's obligation-completion receipt).

| Wait | Healthy evidence | Diagnostic when stalled |
|---|---|---|
| `human-input` | pending `WakeDischarge:human-response-command` | an operator decision is genuinely outstanding — surface it; never auto-answer |
| `external-availability` | re-probe obligation with deadline | probe exhaustion yields **typed unknown**, never product-failure; check probe ledger |
| `policy-quota` | `requeueAfterBackoff` deadline or pending `factoryRun.resume` | if `OperatorStopCommand` exists, the run is intentionally stopped; resume is an operator command |
| `readiness` | predecessor `CellFinalAcceptance`/`EffectReceipt` arrival | inspect the predecessor scope; if the predecessor terminally failed, the wait must have been converted to unreachable settlement via `obligation:markDependantsUnreachable` — a readiness wait on a dead predecessor is a blocking defect |
| `effect-uncertainty` | pending operator disposition (D12) | an external non-idempotent send outcome is unknown; reconcile, never blind-retry |

A wait without a resolvable wake source is, by law, unreachable; a wait whose
wake source is durable but never fires converts through settlement — never
through polling.

## 6. Terminal-proof verification

Terminalization claims are checked against their exact evidence closure:

- **success** — e.g. cell scope requires `CellFinalAcceptance` whose embedded
  acceptance digest equals the digest of the referenced closure (D11); run
  scope requires the member dispositions and the run proof recorded by
  `factoryRun.recordRunTerminalProof`.
- **truthful failure** — repair-epoch ledger exhaustion plus
  `RepairTerminalityEvidence` (D6). A scope that is neither terminal nor
  progressing after epoch exhaustion is a hang: file it; do not force it.
- **cancellation** — proofs at lifecycle/run scope name member dispositions
  (`TypedWaitDisposition`, D3).
- **unreachable** — exists at cell/workplace/node scope (D7); run-scope
  refusals are pre-run `TypedRefusalReceipt`.

An empty obligation queue is **never** a terminal proof.

## 7. Effect and send uncertainty

Effect results are seven typed kinds (D2). Diagnosis maps directly:

- `success` / `already-applied` — closed; idempotency held.
- `retryable` — bounded redrive via `effectRedrive` / `resumeEffect`
  obligations; check the retry ledger, not the board.
- `unknown` (also `EffectReceipt:unknown`, `TypedWait:effect-uncertainty`,
  D12) — requires operator disposition. The diagnostic surface names the exact
  idempotency key and the last observed state; an automatic duplicate of a
  non-idempotent send is forbidden.
- `human-wait` / `policy-terminal` / `repair` — take their typed branches.

Provider sends additionally distinguish admission from send: a
`PromptAssemblyReceipt:admitted` is not send evidence. Send/outcome evidence
is `ProviderSendOutcome` pinned to the same obligation and ordinal. A gap
between an admitted receipt and a missing outcome after a crash is resolved by
redriving the same obligation/ordinal — never by issuing a fresh request.

## 8. Incident card

Every stalled or failed scope gets a structured card derived from the walk:

```text
scope refs (run/lifecycle/stage/process/node/workplace)
current landmark; expected-next landmark
root unmet invariant; typed reason code
authority ref (owning aggregate + revision)
obligation ledger excerpt (kind, state, lease/fence, completion receipt ref)
wait kind + wake source + discharge evidence ref (if waiting)
attempt refs: lease, fence, contextRevision, role-contract digest,
  PromptAssemblyReceipt ordinal range, ProviderRoutePin
evidence refs (CandidateSet/GateDecision/EffectReceipt/CellFinalAcceptance...)
observedRevisionSet; diagnosisObservedAt
firstJournalObservationAt?; lastJournalObservationAt?
diagnosticCoverage: complete | partial | unknown
competingInvariantRefs[]
retryClass: wait | safe_retry | repair | human | terminal | reconcile
resumeActionWithExpectedRevision
reusableEvidence[]   // accepted material that must not be regenerated
correlationId
```

Recommended actions are advisory and derived from current policy/evidence;
the real fenced command revalidates them. External effects without a terminal
idempotency receipt always require reconciliation, never a blind safe retry.

## 9. What is not diagnostic evidence

- Kanban columns, card statuses, board filters.
- "Latest" anything: latest event, latest attempt output, latest row id.
- Absence of log output (absence of a heartbeat is lease evidence's job).
- An empty work queue (silence, not proof).
- Prose summaries in activity streams. A message like "review passed" cannot
  replace a `GateDecision`; a missing one cannot annul it.
- Wall-clock age of a row, except where a durable deadline policy says
  otherwise (backoff, probe deadlines).

## 10. Reason-code families

Reason codes remain closed, machine-readable and versioned, with invariant,
severity, retry class, owner and safe rendering template; unknown codes map to
`INFRA_UNREGISTERED_REASON_CODE`. Families in the kernel vocabulary:
`IDENTITY_*`, `INPUT_*`, `PROTOCOL_*` (including
`FACTORY_DATABASE_PROTOCOL_UNSUPPORTED`), `ROUTING_*`, `NODE_*`,
`WORKPLACE_*`, `OBLIGATION_*`, `LEASE_*`, `ATTEMPT_*`, `CONTEXT_*` (prompt
envelope admission), `ROLE_*` (contract binding), `MATERIAL_*` (ADR-053
chain), `GATE_*`, `EFFECT_*`, `SETTLEMENT_*`, `RECOVERY_*`, `INVARIANT_*`,
`INFRA_*`. Workshop-specific checks keep a namespaced provider code; they do
not invent transition state machines.

## 11. Operator interface contract

- The explainer is deterministic: same snapshot, same card.
- It opens one consistent read snapshot and captures the revision set.
- Coverage is reported honestly (`complete|partial|unknown`); partial or
  ambiguous coverage is never rendered as "root cause".
- It does not claim a historical cause where an authoritative receipt never
  existed.
- Watchdog observations (`factoryRun.observeWatchdog`, D9) feed diagnosis as
  durable evidence; watchdogs observe and command, they never repair SQL.
