# ADR-058: Local runnability is the autonomous Product Build boundary

Status: Accepted

Date: 2026-08-11

## Context

The production Development verification gate deliberately returns `unknown`
for an LM-authored assessment, even when its schema and lineage are valid. This
is correct authority behavior: model prose cannot prove that a candidate
satisfies an acceptance criterion. Run015 exposed the resulting product-level
contradiction. The default Product Build promised an autonomous local product,
but its only terminal path required evidence that the installed production
composition could never issue. Scripted temporal tests stayed green because
they replaced that provider.

The MVP operating model is now explicit: the Factory must produce and start a
locally runnable program without asking a person. A person evaluates the
running program afterwards; findings become a new Change Request. Deployment
is a separate DevOps lifecycle.

This is a complicated architectural fork: the cause is knowable, but readiness,
semantic verification, provider authority, and lifecycle naming must remain
separate.

## Decision drivers

- truthful authority and terminal names;
- autonomous local completion without an approval gate;
- exact frozen-candidate lineage;
- production-composition test fidelity;
- bounded, reversible implementation;
- future extension to executable criterion providers.

## Considered options

### A. Per-criterion sandboxed executable providers

Keep the verification fan-out and require an independent executable receipt for
every criterion. This preserves semantic verification but requires a typed
method plan and provider coverage that the current Formalization output does not
contain. Manual or missing methods still stop the line.

### B. Candidate-wide local-readiness receipt

Run factory-owned dependency, test, start, probe, and shutdown checks against
the exact frozen candidate. End the MVP lifecycle at `runnable-local`. Keep
per-criterion LM assessments advisory and never describe the result as semantic
acceptance.

### C. Verification-method-plan provider DAG

Preserve every atomic verification method in Formalization, compile it into a
provider DAG, and aggregate exact clause receipts. This is the long-term
semantic-verification architecture, but is substantially larger and still
requires a human provider for irreducibly subjective clauses.

## MCDA

Scores are 1 (poor) to 5 (strong).

| Criterion | Weight | A | B | C |
|---|---:|---:|---:|---:|
| Authority truthfulness | 30 | 5 | 5 | 5 |
| Fits autonomous MVP intent | 25 | 3 | 5 | 3 |
| Time to production-safe E2E | 20 | 3 | 4 | 1 |
| Testability/observability | 15 | 4 | 5 | 4 |
| Reversibility | 10 | 4 | 5 | 4 |
| Weighted total / 500 | 100 | 390 | 470 | 350 |

## Decision

Choose option B, with the Red Team's naming and authority vetoes incorporated.

The Product Build terminal is `runnable-local`, not `verified`, `accepted`, or
`released`. A versioned, immutable LocalReadinessReceipt binds the exact
candidate commits and trees, readiness-plan digest, provider/runtime digest,
commands, bounded logs, start probe, and clean shutdown observation.

Candidate-authored scripts are test subjects, not Factory authority. The
Factory owns command allow-listing, isolation, timeouts, process cleanup,
candidate/tree verification, probe execution, and the receipt. Missing required
commands or checks fail closed. The worker or LM cannot declare readiness.

Per-criterion model assessments may be retained as advisory products, but they
cannot emit trusted evidence, influence local readiness, or block the Product
Build terminal. Exact executable criterion providers can later be layered on
top through the method-plan architecture in option C.

Test compositions may replace inference only. They must not replace lifecycle
routing, gate policy, readiness providers, package installations, or settlement
semantics. A canonical composition fingerprint makes such drift visible.

## Consequences

- A locally runnable product can complete without Delivery or human approval.
- The Factory no longer claims that build/start health proves semantic
  correctness.
- Human findings naturally enter a new Change Request against the exact product
  revision.
- Products without an executable local-run contract are returned for rework.
- Product Build policy contributes required repository write scopes for its
  bootstrap contract. The task-graph gate must assign the package manifest and
  test tree to implementation work before any author is admitted; downstream
  scope enforcement must never be weakened to compensate for an incomplete
  plan.
- Semantic verification remains available as a stricter optional policy once
  its method/provider coverage is complete.

## Pre-mortem

Assume this failed after six months:

1. Hollow applications returned HTTP 200. Mitigation: require a typed probe
   contract plus deterministic tests and preserve the narrow `runnable-local`
   claim.
2. Candidate scripts escaped the workspace. Mitigation: no shell strings,
   allow-listed executable/argv, isolated exact checkout, bounded environment,
   and process-tree cleanup.
3. Missing tests were treated as success. Mitigation: the readiness policy
   declares mandatory phases; absence is a deterministic failure.
4. Child servers leaked and later E2Es became flaky. Mitigation: allocate a
   private port, record the process tree, enforce shutdown, and test cleanup.
5. Scripted CI diverged from production again. Mitigation: the temporal harness
   imports the canonical composition and permits only an inference adapter.

## Red Team resolution

The Red Team correctly rejected using local readiness as semantic acceptance:
a wrong product can build and answer a probe. The objection does not defeat the
selected MVP boundary because the terminal and certificate are explicitly
`runnable-local`; semantic acceptance is not claimed. If any implementation
continues to emit `verified-local` from readiness alone, this ADR is violated.

## Decision journal

- Decision: make exact candidate local runnability the autonomous MVP terminal.
- 30-day expectation: canonical Product Build E2Es finish with no human request,
  no Delivery run, and one exact readiness receipt; malformed or non-runnable
  candidates fail before the terminal.
- 90-day expectation: Change Requests reference an immutable runnable product
  revision, while semantic provider coverage can grow without changing the
  readiness contract.
- Check trigger: the next clean real-model E2E and every production-composition
  temporal run.
- 2026-08-11 / Run016: the planner omitted `package.json` and `tests/` from all
  write scopes. The source-authority gate correctly rejected the out-of-scope
  files; after repair, the reviewer correctly rejected their absence. This
  exposed a planning-contract gap, not a Git or reviewer defect. Product Build
  policy v1.1 now carries `requiredChangeScopes`, and deterministic graph
  validation rejects the omission before implementation.
