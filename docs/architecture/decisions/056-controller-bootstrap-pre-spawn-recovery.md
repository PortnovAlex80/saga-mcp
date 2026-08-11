# ADR-056: Controller-bootstrap recovery for superseded pre-spawn failures

Status: Accepted

## Context

Run 015 paused after a replacement author execution failed during RepositoryDesk
provisioning. The Claude OS process never started, but the runner represented
every exception before `launch()` returned as `spawn_failed`. Runtime policy
then treated it as a missing executable and immediately requested a human.

After ADR-055 removed task-scoped desk reuse, the recorded
`REPOSITORY_DESK_BASE_MISMATCH` is mechanically superseded. The terminal
WorkerExecution and earlier rejected CandidateSet must remain immutable, while
ordinary resume must be able to create a fresh execution without an operator
recovery flag or database edit.

## Decision

The epoch-fenced orchestration controller runs a bootstrap reconciler after
worker supervision and before its first lifecycle cycle. A closed, versioned
policy may recognize a pre-cutover provisioning failure only when relational
evidence proves that the failed execution never started and produced no
submission, `worker_done`, or CandidateSet. It appends an immutable receipt and
uses the existing Workplace reducer to transition the exact paused author desk
to a fresh queued attempt.

Future pre-spawn failures are classified at their source. Retryable
Factory-provisioning failures enter normal crash repair; permanent process-spawn
failures such as an unavailable executable remain human-paused.

The first policy resolves only `REPOSITORY_DESK_BASE_MISMATCH`, whose substrate
was replaced by ADR-055. Unknown strings fail closed.

## Options and scoring

Criteria: liveness 30%, authority safety 25%, production-entry consistency 20%,
implementation readiness 15%, reversibility 10%.

| Option | Score / 500 | Decision |
| --- | ---: | --- |
| Runtime bootstrap reconciler + typed future taxonomy | 465 | Selected |
| Change future spawn taxonomy only | 330 | Cannot recover historical paused runs |
| Resume-CLI-only recovery flag | 285 | Frontend-specific and still an operator kick |

## Pre-mortem and Red Team controls

- No controller exists after a pause: ordinary CLI and Engine Administration
  both launch the same orchestrate host; reconciliation lives inside that host.
- The same deterministic error loops: the receipt is unique per failed
  execution and recovery is enabled only after ADR-055's fresh desk substrate.
- Error text is spoofed: text selects a decoder candidate, while execution
  state, PID/start facts, fences, production rows, Workplace revision, and
  lifecycle lineage authorize the transition.
- Old accepted material is laundered: recovery only queues a new author
  execution; it never creates acceptance or reuses a review.
- Two controllers race: controller terms fence hosts; the recovery transaction
  uses `BEGIN IMMEDIATE`, an execution-unique receipt, and Workplace revision
  CAS.
- A real executable failure spins: it is absent from the policy and remains
  paused.

## Consequences

Plain resume can lawfully recover the historical Run 015 failure with no manual
state mutation. Recovery requires an explicit future policy update for every
new resolved failure class, preventing an open-ended retry loop. The legacy
decoder is intentionally narrow and can be retired after pre-cutover runs age
out; immutable receipts remain audit evidence.
