# ADR-033: Durable submission preflight recovery

- Status: accepted
- Date: 2026-08-09
- Decision owner: factory architecture

## Context

The live Saga4 Factory paused in `define-architecture-contract` after two real
model executions. The architect instruction described §D2 as rows and omitted
part of the machine-required field set, while the validator accepted only
line-oriented YAML stanzas. Both workers received transient
`FORMALIZATION_SRS_INCOMPLETE` errors and then exited without an accepted
`worker_done`. Supervision truthfully classified the executions as `lost`, but
the validator findings were not durable, the replacement worker ran blind, and
the physical-attempt budget paused the Workplace.

The produced table was not merely another serialization of the same product.
It contained 31 invented sub-codes (`AC-1.1…AC-8.3`) against a frozen baseline of
eight exact codes (`AC-1…AC-8`) and omitted required fields. Accepting or
automatically aggregating it would invent semantic policy.

## Options

1. Contract-first durable preflight: retain one strict YAML representation,
   align worker instructions, validate exact frozen AC identity, persist every
   rejected preflight, and provide an explicit audited resume command.
2. Dual-format compatibility: parse Markdown tables as well as YAML while
   keeping required fields and baseline checks strict.
3. Gate-native completion: make `worker_done` always terminal, then seal the
   candidate and express every structural rejection as a normal GateDecision.

## Decision matrix

Scores are 1 (poor) to 5 (strong).

| Criterion | Weight | Contract-first | Dual-format | Gate-native |
|---|---:|---:|---:|---:|
| Incident recovery speed | 25 | 4 | 5 | 2 |
| Contract/acceptance safety | 25 | 5 | 3 | 5 |
| Durable diagnostics | 20 | 5 | 2 | 5 |
| Factory architecture alignment | 20 | 4 | 3 | 5 |
| Implementation risk | 10 | 3 | 4 | 1 |
| Weighted result | 100 | 435 | 340 | 385 |

Choose option 1. Add only the guarded operator-resume mechanism from option 2;
do not add permissive table acceptance.

## Decision

- The v2.2 SRS meaning is enforced as one explicit `§D2 AC Map` or
  `§D2 Decomposition` heading with exactly one fenced YAML block.
- Every stanza has all fields from `SRS_CONTRACT`, non-empty values, valid
  enums, a unique AC code, and a one-to-one identity match with the durable
  frozen acceptance baseline.
- `worker_done` is single-terminal, not single-call: a rejected preflight keeps
  the task owner/fence live; exactly one accepted completion receipt terminates
  the execution.
- Rejected preflights are append-only observations containing validator and
  contract identity, structured gaps, exact input/baseline context, observed
  artifact hashes and a recovery envelope. The rejection commits in the same
  transaction before the MCP error is returned.
- A later execution receives the exact rejection snapshot through
  `recovery-feedback.json`. Successful validation clears only the transport
  pointer; immutable rejection history remains.
- Exhausted preflight incidents may be resumed only through an explicit
  operator authorization. The command verifies one current blocked/paused
  Workplace, no active fence/reservation, no accepted completion,
  CandidateSet or GateDecision, and unchanged artifact/database/file hashes.
  It records immutable authorization and consumption facts, then invokes the
  existing Workplace CAS `resumeFromHuman` transition. It never accepts the
  product or edits task status directly.
- The long-term gate-native candidate snapshot design remains follow-up work.
  This incident fix does not claim that mutable shared file bytes are already
  an immutable CandidateSet blob.

## Pre-mortem and red-team constraints

Likely failures were a rejection insert rolled back with the thrown exception,
feedback resolved from mutable “latest” state, a heading collision such as
`D.2 AC-2`, a silent retry-budget bypass, and a crash after requeue but before
host launch.

The adversarial review required the implemented safeguards: transaction
sentinels commit rejection evidence before throwing; feedback carries exact
hashes and expected frozen codes; the parser rejects mixed/duplicate/empty and
non-canonical representations; resume is single-use, revision-checked and
artifact-hash-checked; repeated operator invocation recognizes the already
consumed queued transition so host launch can be retried idempotently.

## Consequences

Weak or mistaken models receive deterministic, durable repair instructions
instead of consuming the next attempt blind. The validator remains fail-closed
and cannot reinterpret sub-criteria as frozen acceptance criteria. Operator
recovery is explicit and auditable, with one extra model execution rather than
an acceptance shortcut.

The strict grammar is intentionally less author-friendly than a general YAML
parser. Changing the representation later requires a versioned contract and a
new validator; it must not be introduced as an unpinned compatibility guess.

## Decision journal

- 2026-08-09: incident classified as complicated after exact DB, worker JSONL,
  package resource, parser and validator inspection.
- Three independent options were evaluated with the matrix above.
- Pre-mortem and adversarial review rejected table auto-aggregation and required
  atomic rejection persistence plus a single-use operator authorization.
- Revisit the Gate-native option when CandidateSets freeze immutable content
  blobs and CheckReceipts can carry validator-owned structured evidence.
