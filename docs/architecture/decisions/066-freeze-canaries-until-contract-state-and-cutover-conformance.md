# ADR-066: Freeze real-model canaries until contract, state, and cutover conformance

Status: Accepted

Date: 2026-08-13

## Context

The Mars/Venus r8 recovery was attributed to GLM-5-turbo being unable to emit a
multi-file, whole-content `factory.source-change-candidate.v1`. The live evidence
refutes that as the dominant incident cause.

Task 62 made 61 `product_submit` calls, including 30 multi-file calls. One call
contained complete `MessageService.kt`, `Application.kt`, and `gradlew.bat` bodies and
the intended Spring wiring repair. The Factory rejected it with
`SOURCE_CHANGE_PATH_INVALID: gradle/`.

The materializer validates every `changeScope` as a repository file path before
removing a trailing slash. `validatePath('gradle/')` therefore fails. Because the
check is inside `scopes.some(...)`, only the first exact scope, `build.gradle.kts`, can
short-circuit successfully; every other candidate path reaches the invalid second
scope. This explains why all persisted repair candidates changed only
`build.gradle.kts`. The existing materializer test uses only `['app.js']` and never
crosses the TaskGraph directory-scope contract.

The run then exposed a second defect class at recovery exhaustion. LifecycleRun 8 is
terminal failed with `REG-28-AC-01: in_progress + paused`. Its persisted ProcessRun 10
projection is also divergent: the Workplace is `todo/idle` at revision 26 while the
latest reviewer task is `review_in_progress` without an execution. Neither state is a
lawful account of the terminal run. Current source contains more than one semantic
path from reviewer completion to Workplace movement, but the exact live writer cannot
be proven because executable composition was not frozen and no immutable Workplace
revision journal records the mutation. The incident must therefore be classified as
durable state corruption/composition uncertainty, not assigned to one writer without
additional proof.

ADR-053's own cutover tracker says the substrate is partial and forbids another
real-model canary until its exit gates are green. The r8 database contains 142
transition obligations and all are still pending. The reconciler exists in tests but
is not wired into production composition; synchronous transitions continue beside
shadow obligations. Workshop handler digests remain `pending@wave-2`, and WorkIntent
62 does not pin a payload/materializer contract. Five source commits also landed while
the active r8 launch was running, so the exact executable composition used by every
process is not provable.

Finally, the author Gate admitted three one-file workaround candidates using only the
generic product-contract check. It had no deterministic build/start/task-semantic
check, so infrastructure rejection was converted into repeated paid reviewer cycles.

## Decision drivers

- Exact material and transition authority.
- Reproducible cross-process composition.
- Autonomous liveness without manual resume or database edits.
- Tests that conserve contracts across component boundaries.
- Reversibility and preservation of r8 as incident evidence.

## Considered options

1. Accept the model-capacity diagnosis and implement patch v2 immediately.
2. Trim the trailing slash in v1 and resume the existing r8 lineage.
3. Introduce a Workplace-owned managed-source scratchpad immediately.
4. Freeze canaries, repair the proven boundary defects, complete the ADR-053 cutover
   gates, prove a fresh scripted run, and only then run a fresh real-model canary.
5. Restore raw `git_change` or use a stronger model.

Weighted MCDA (authority correctness 30%, incident fit 25%, temporal liveness 20%,
composition parity 15%, delivery/reversibility 10%; scores 1-5):

| Option | Authority | Incident fit | Liveness | Parity | Delivery | Weighted |
|---|---:|---:|---:|---:|---:|---:|
| Patch v2 now | 4 | 2 | 2 | 2 | 4 | 280 |
| v1 slash hotfix + resume r8 | 4 | 5 | 2 | 1 | 5 | 350 |
| Scratchpad now | 5 | 3 | 3 | 3 | 2 | 350 |
| Staged conformance cutover | 5 | 5 | 5 | 5 | 3 | **480** |
| Raw Git / stronger model | 2 | 1 | 2 | 1 | 5 | 190 |

## Decision

Choose option 4. Preserve r8 as immutable incident evidence and do not resume it.

The release-blocking order is:

1. Replace stringly duplicated scope logic with one typed, shared repository-scope
   parser and containment relation (`ExactFilePath | DirectoryPrefix`). Use it in the
   TaskGraph, managed materializer, reviewer jurisdiction, scheduler overlap, and Git
   authorization. Add order/permutation, trailing-slash, case, traversal, and the exact
   r8 multi-file fixture as property and mutation tests.
2. Remove semantic reviewer decisions from worker protocol completion. `worker_done`
   may persist the exact product and completion receipt; the current GateDecision is
   the sole semantic transition authority. Reproduce third-review rejection and
   exhaustion through the canonical production composition and prove
   `blocked/paused` plus a consistent task projection at every durable prefix.
3. Require per-process installation binding receipts with non-placeholder handler,
   skill, payload-contract, materializer, provider, binary, and package digests.
   Startup fails on missing/extra/drifted bindings. No source/dist mutation is allowed
   during a canary epoch.
4. Cut transition obligations over as the sole cross-machine handoff owners. Delete or
   disable the corresponding synchronous dual paths; prove bounded fair drain and no
   stale ownerless obligations rather than requiring momentary zero pending rows.
5. Add a deterministic candidate build/start check before LLM review. Comment-only,
   placeholder, or non-runnable candidates cannot consume reviewer cycles.
6. Finish the remaining ADR-053 post-seal authority gates. No material consumer may
   select by execution, task, node, or latest row.
7. Run a fresh scripted E2E from a new database and repository through the exact
   production composition. Only after it passes without kicks, resumes, or DB edits may
   one fresh real-model canary run.

SourceChangeCandidate v2 remains a useful ergonomic follow-up. It must be a versioned,
exact-base Factory materializer whose complete resulting revision is sealed and whose
payload/materializer identities are pinned. A Workplace-owned scratchpad is the longer
term editing surface. Neither is the root-cause fix for r8, and neither may bypass the
cutover gates.

## Red Team and pre-mortem

The Red Team confirmed the scope bug and model counterexample, but rejected two
overclaims:

- Pending shadow obligations did not cause the scope rejection; they prove an
  uncompleted handoff cutover and future crash/liveness risk.
- Commit timestamps and placeholder digests make executable composition unknowable;
  they do not prove which exact process loaded which commit.

Assume this decision failed:

- A one-line slash trim leaves divergent path/case/root/symlink semantics. Mitigation:
  one typed scope kernel plus cross-consumer property and mutation tests.
- Wiring the reconciler while retaining synchronous handlers causes duplicate Gates or
  effects. Mitigation: one owner per handoff and cutover tests that kill either path.
- A scripted E2E passes under a test-only composition. Mitigation: compare exact
  process binding receipts and replace only model cognition.
- State corruption recurs but no writer can be identified. Mitigation: append immutable
  Workplace transition evidence with revision-before/after, command, causation, and
  state hashes at the authoritative repository boundary.
- Candidate scope is fixed but prose-only code reaches review again. Mitigation:
  deterministic build/start admission before reviewer scheduling.
- The failed r8 lineage is silently reinterpreted under new code. Mitigation: never
  resume it; use a new DB/repository and pinned package epoch for proof.

## Consequences

This delays another paid canary, but converts the next run into a controlled experiment
instead of continued incident discovery. r8 remains queryable evidence. Stronger models
cannot mask deterministic Factory failures. Patch/scratchpad work is sequenced after
authority and liveness correctness rather than used as a substitute for them.

## Decision journal

- **Date:** 2026-08-13
- **Decision:** Freeze real-model canaries and complete the staged contract/state/
  composition/obligation cutover before a fresh run.
- **30-day expectation:** one shared scope implementation is used by every consumer;
  canonical exhaustion tests cannot produce an invalid phase/loop pair; process binding
  receipts contain no placeholder implementation digest.
- **90-day expectation:** fresh scripted and real-model runs reach their truthful local
  terminal through the same composition with no manual kick, and no due transition
  obligation remains ownerless past its bounded drain policy.
- **Check trigger:** the first proposal to authorize a new real-model canary, then the
  first post-cutover incident review.
