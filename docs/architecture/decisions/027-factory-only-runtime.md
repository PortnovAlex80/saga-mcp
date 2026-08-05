# ADR-027: Factory-only runtime and destructive cutover

**Status:** Accepted  
**Date:** 2026-08-06  
**Supersedes:** ADR-021 and ADR-023

## Decision

The repository ships one runtime: the universal Factory engine. Compatibility
selectors, shadow reads/writes, unfenced recovery, unpinned package execution,
alternate start endpoints, manual acceptance shortcuts, and historical operator
instructions are removed. Existing production evidence enters the engine only
through the verified checkpoint `restore-clone` and `adopt` protocol.

The four current workshops (Discovery, Formalization, Development, Delivery)
remain module packages over the same workplace/candidate/gate mechanism. Their
count is not encoded in the kernel; adding a fifth or a thousandth workshop does
not create another orchestration path.

Worker completion seals a candidate and moves the workplace to `verifying`.
Only a durable GateRun bound to the exact candidate, input digest, execution
fence, package pin, policy and review evidence may accept it. A worker, tracker
editor or test fixture cannot set `accepted` or `done` directly.

Production starts only at `/api/factory/start`:

- `project_id` resumes the single durable order from its last committed cursor;
- `idea_url` creates a new order from immutable HTTPS source bytes.

Test replay and warm start are explicit non-production profiles. They may skip
model generation or expensive checks, but never provenance, fencing, exact
candidate identity, transition legality, review-decision integrity, audit logs,
or the `productionEligible=false` boundary.

## Cynefin classification

This is a **complicated** architecture decision: the desired invariant is clear,
but reachability, persistence and recovery consequences require expert analysis.

## Options and MCDA

Scores are 1 (worst) to 5 (best). Weighted total is `score * weight`.

| Criterion | Weight | A: staged compatibility | B: reachable hard cutover | C: clean-room kernel |
|---|---:|---:|---:|---:|
| Runtime correctness | 3 | 3 | 4 | 5 |
| Preserve four-workshop semantics | 3 | 5 | 5 | 2 |
| Clarity for coding agents | 3 | 1 | 5 | 5 |
| Recovery and provenance safety | 3 | 4 | 5 | 3 |
| Delivery/test risk | 2 | 4 | 3 | 1 |
| Reversibility | 2 | 5 | 3 | 4 |
| **Weighted total** |  | **57** | **70** | **55** |

Option B wins. Git history and tag `pre-v4-legacy-purge-20260806` provide
reversibility without keeping compatibility code inside the product.

## Pre-mortem and controls

| Failure | Early signal | Control |
|---|---|---|
| A rename hides an old authority path | worker completion reaches terminal | forbidden-surface and gate-transition tests |
| Dynamic imports keep a bypass alive | packaged files exceed the runtime allowlist | clean build plus package/source ratchet |
| A fresh schema silently consumes an old DB | unexpected columns or missing provenance | distinct schema identity; import only through checkpoint verification |
| Cleanup damages workshop semantics | one of four module conformance suites fails | preserve module contracts and run module tests |
| Test mode leaks into production | adopted evidence becomes production eligible | immutable profile and eligibility checks |
| Another start path appears | public API/CLI accepts project+epic directly | single-start architecture test |

## Red Team result

The main risk is cosmetic cleanup: neutral names with unchanged old semantics.
Therefore acceptance is behavioral. The cutover is incomplete if any direct
acceptance, unfenced mutation, nullable package pin, best-effort product write,
alternate start route, or production-eligible test evidence remains reachable.

## Decision Journal

- Chosen by: primary implementation agent after three independent option reviews
  and an adversarial review.
- Expected benefit: one explainable engine and exact restart from durable state.
- Expected cost: old databases and callers are deliberately incompatible.
- Rollback: restore from the safety tag; do not reintroduce compatibility seams
  into the Factory branch.
- Revisit only if a required workshop semantic cannot be expressed by the
  universal workplace/candidate/gate contracts.

