---
id: retry-inconsistency
symptom: |
  RetryPolicyDefinition declares maxAttempts, retryOn (reason-code list) and
  backoff ('none'|'fixed'|'exponential'), but the runtime only honors
  maxAttempts. retryOn (which reasons should trigger a retry) and backoff
  (delay strategy) are declared by every production module and completely
  ignored by the executor — a module author cannot express, and an operator
  cannot rely on, the retry semantics the contract claims to provide.
root_cause_class: retry-inconsistency
evidence: |
  - src/process-modules/domain/process-module.ts:42-46 declares:
      RetryPolicyDefinition { maxAttempts: number; retryOn: readonly string[]; backoff: 'none'|'fixed'|'exponential' }
  - Production modules declare all three fields, including non-trivial values:
      src/process-modules/modules/discovery/discovery-process-module.ts:244,262,280,298
        retryPolicy: { maxAttempts: 2, retryOn: ['schema-rejected','tool-error'], backoff: 'none' }
      src/process-modules/modules/formalization/formalization-process-module.ts:382
        retryPolicy: { maxAttempts: 2, retryOn: ['trace-gap','baseline-race'], backoff: 'fixed' }
      src/process-modules/modules/development/development-process-module.ts:411
        backoff: 'none'
  - The application/executor layer references ONLY maxAttempts:
      src/process-modules/application/generic-flow-executor.ts:441,641
        `.reduce((total, policy) => total + policy.maxAttempts, 0)` and
        `maxAttempts: policy.maxAttempts`
      src/process-modules/application/node-executors/lm-node-executor.ts:337
        `retryBudget: profile.retryPolicy.maxAttempts`
      src/process-modules/application/process-execution-workspace.ts:138
        `MAX_ATTEMPTS: request.profile.retryPolicy.maxAttempts`
  - Read-only proof (returns nothing for the other two fields):
      grep -rn '\.retryOn' src/ | grep -v 'process-module.ts:' | grep -v '\.test\.'
      grep -rn '\.backoff' src/ | grep -v 'process-module.ts:' | grep -v '\.test\.'
    -> retryOn has zero runtime reads; backoff has zero runtime reads.
  - Plan §13.24 (verbatim): "Several declared retry and recovery fields are
    not fully implemented. Installation must reject unsupported semantics
    until Runtime implements them."
reproduction: |
  Static (conclusive, read-only):
    grep -rn "retryOn\|backoff" src/process-modules/modules/      # declared by all 4 modules
    grep -rn "\.retryOn\|\.backoff" src/process-modules/application/   # zero matches
  Dynamic: a module that declares retryOn:['some-reason'] and backoff:'fixed'
  observes the executor retrying (or not) purely on maxAttempts with no delay
  and no reason filtering — i.e. the declared retryOn/backoff have no effect.
expected_after_fix: |
  Either the runtime fully implements retryOn reason filtering and the
  none/fixed/exponential backoff schedule, or installation (plan §14.3 Wave 2)
  rejects any manifest declaring semantics the runtime does not implement
  (plan §13.24). A declared field with no runtime effect becomes a hard
  install-time error, not a silent no-op.
fixing_waves:
  - "4"
  - "2"
---

# Fixture: retry-inconsistency

Captured from the 2026-07-28 failure taxonomy (plan §2.2). Task file W00-A6
item 9; plan §13.24 is the root-cause statement and names Wave 4 as the
fixing wave (with Wave 2 install-time rejection as the fallback gate).

## Boundary that is unstable

The retry contract is declarative but not enforced. Modules advertise retry
semantics the runtime silently ignores, so the manifest over-promises and the
runtime under-delivers with no signal at install time.

## Why this is a fixture, not a fix

Wave 4 (plan §0.7 / §14.5 protocol & universal recovery) implements the
real retry/recovery semantics, and Wave 2 (§14.3) makes installation reject
unsupported manifest fields per §13.24. This fixture pins the
declared-but-ignored fields so the Wave 4 exit gate can prove every declared
retry field has a runtime effect (or is rejected at install).
