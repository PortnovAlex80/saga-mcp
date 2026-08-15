# ADR-065: Shift-left planning contract and atomic criterion identity

Status: Accepted

Date: 2026-08-11

## Context

Run 028 exhausted all three Development planning attempts before any implementation
work began. The three immutable proposals contained intrinsic representation errors:
a non-boolean `required`, invalid graph semantics, and string criterion hashes in an
integer array. The managed submission boundary checked only the schema name, so each
known-undecodable payload was persisted, sealed into a CandidateSet, and charged as a
semantic Production Cell attempt before the Gate reported the error.

The run also exposed a second contract error. Several accepted atomic criteria can
belong to one artifact/document container. Development used `artifactId` as the
criterion identity and required it to be unique. That loses atomic cardinality and can
make a valid Formalization handoff impossible to plan.

ADR-053 requires external representation to be normalized once at ingress and forbids
new execution/task/latest material fallbacks. This decision is a release-blocking
contract correction on that path; it does not claim the WorkplaceProductionRevision
cutover is complete.

## Options

1. Keep validation only in the Gate and increase planner attempts.
2. Pin the existing decoder at `product_submit`, keep contextual semantics in the Gate,
   and introduce an atomic criterion identity distinct from artifact provenance.
3. Replace the planner payload with a fully kernel-assembled graph immediately.

Weighted MCDA (authority correctness 30%, liveness 25%, compatibility 20%, testability
15%, delivery cost 10%; scores 1-5):

| Option | Authority | Liveness | Compatibility | Testability | Cost | Weighted |
|---|---:|---:|---:|---:|---:|---:|
| Gate only | 3 | 1 | 4 | 3 | 5 | 290 |
| Pinned ingress + atomic identity | 5 | 5 | 4 | 5 | 4 | 470 |
| Kernel graph assembly | 5 | 5 | 2 | 4 | 1 | 385 |

## Decision

Choose option 2.

- A package-pinned `ProductPayloadContract` delegates to the same pure task-graph
  decoder used by the Gate. Intrinsic shape/type/enum failures are rejected before the
  managed submission INSERT. The same fenced worker may correct the tool call; no
  CandidateSet, GateRun, or semantic attempt is consumed.
- The Gate remains the sole authority for facts requiring the frozen DevelopmentCase:
  reference membership, complete coverage, repositories, dependency closure/cycles,
  scope ordering, and integration targets.
- Payload contracts resolve by exact `(schema, contractId, version, digest)`. Unpinned
  historical WorkIntents are not reinterpreted by ambient registrations. Multiple
  contract versions may coexist.
- The Development package becomes `solution-development@1.2.0`. Its task-graph Gate
  provider digest includes the payload-contract digest.
- Formalization supplies a stable numeric `criterionId` derived from the atomic
  criterion content hash. `artifactId` remains provenance and may repeat. Development
  graph coverage and verification bind `criterionId`.
- Invalid criticality is rejected; it is not silently coerced to `blocker`.

## Red Team and pre-mortem

The initial proposal was vetoed because the registry was keyed only by schema and would
silently reinterpret old WorkIntents or reject coexistence. Exact-identity resolution
and no implicit validation for unpinned intents are therefore release blockers.

Additional failure modes:

- decoder code changes without identity change: package and provider versions/digests
  must change, and duplicate exact registrations with a different executable validator
  are rejected in-process;
- boundary accepts what Gate cannot decode: differential corpus tests require
  boundary/Gate decoder parity;
- criterion hash collision: Formalization/Development contract validation requires
  unique positive `criterionId` values and fails closed;
- semantic errors get accidentally accepted at submission: cyclic, incomplete, foreign
  reference and overlap fixtures must pass shape admission and still fail the Gate;
- scripted composition differs from worker MCP composition: both registration roots
  install the exact same contract identity.

## Consequences

Malformed JSON becomes an in-execution correction rather than an immutable semantic
repair. Atomic acceptance cardinality survives shared documents. The Gate remains
auditable and authoritative for planning decisions. Old unpinned runs retain their
historical behavior; Run 028 is not silently resumed under the new contract.

This adds a versioned identity field across the Formalization-to-Development handoff and
does not remove the ADR-053 cutover requirement. The next clean canary must still prove
that accepted material and post-acceptance effects no longer fall back to the latest
execution/task/submission.
