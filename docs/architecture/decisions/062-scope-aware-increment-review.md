# 062 — Scope-aware review for implementation increments

Date: 2026-08-11

## Context

Run024 stopped after the reviewer of `impl-mission-config` requested
`package.json` with `npm test` and `npm start`. The item was authorized to
change only mission configuration and two UI components; the accepted graph
assigned `package.json` and product-wide tests to the downstream
`impl-product-build` item. The requested repair was therefore impossible:
complying violated the immutable write scope, while refusing exhausted the
author loop.

## Decision drivers

- Preserve strict write authority and graph ownership.
- Keep independent implementation items reviewable before final assembly.
- Make product-wide local runnability a final-candidate obligation.
- Avoid Development-specific behavior in the universal conveyor runtime.
- Prefer an additive, testable package correction during E2E stabilization.

## Options

| Option | Correctness 30% | Conveyor fit 25% | Regression resistance 20% | Cost 15% | Reversibility 10% | Weighted / 5 |
|---|---:|---:|---:|---:|---:|---:|
| Widen every item to global build files | 1 | 1 | 1 | 3 | 2 | 1.45 |
| Prompt-only wording in the generic worker skill | 3 | 4 | 2 | 5 | 5 | 3.55 |
| Dedicated scope-aware reviewer package contract | 5 | 5 | 4 | 3 | 4 | 4.40 |

## Decision

Implementation reviewers use the package-owned
`saga-development-code-reviewer` skill rather than the generic author skill.
A blocking finding must be repairable within the subject item's frozen
`changeScopes` and owned acceptance criteria. Missing files or commands owned
by a future graph item are deferred observations and cannot produce
`changes_requested`. A regression introduced against material already present
at the effective base remains blocking. Product-wide `npm test`, `npm start`,
and local health are owned by the integration product and final local
runnability check.

The current slice pins and tests the dedicated reviewer resource. Structured,
machine-validated remediation paths remain a follow-up hardening step; the
universal runtime is not taught to interpret Development prose.

## Consequences

- Intermediate candidates no longer need to be globally runnable.
- Strict scope enforcement remains authoritative.
- A future reviewer can still make a semantically wrong statement, but the
  package instruction and wiring no longer systematically cause it.
- Final assembly and local-runnability gates retain responsibility for global
  product commands.

## Pre-mortem

- Reviewer ignores the instruction: add structured finding paths and a
  scope-aware provider if a production trace repeats the defect.
- Planner omits a global-file owner: graph authorization already requires
  policy bootstrap scopes and must fail before implementation.
- A candidate breaks an existing build command: the effective-base regression
  exception keeps that defect in review jurisdiction.
- Package identity drifts: installation content digests and the resource
  pinning regression test expose the change.

## Red-team response

The strongest objection was that prose alone is not authority. It is valid;
therefore this decision does not weaken the deterministic scope gate or claim
that prose proves jurisdiction. It corrects the demonstrated package wiring
and establishes a production trace trigger for the structured-verdict follow-up.

## Decision journal

Expectation: in the next clean real-model Product Build, an intermediate item
whose graph assigns `package.json` downstream is not rejected solely because
that file is absent; the downstream integration item supplies it and final
local runnability passes. Check trigger: completion or failure of Run025.

Run025 follow-up: the author scope Gate correctly rejected a directory-summary
`changedFiles` claim and then exact out-of-scope convenience files. Because the
second attempt made measurable progress but exhausted the two-attempt budget,
the implementation author budget is now three and the repair instruction
requires exact file enumeration plus removal of every unauthorized convenience
file. The budget remains bounded; acceptance authority is unchanged.
