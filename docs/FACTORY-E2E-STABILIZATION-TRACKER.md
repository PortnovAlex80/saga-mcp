# Factory E2E Stabilization Tracker

Date started: 2026-08-10
Owner: Codex autonomous run
Status: active

## Objective

Prove and harden the Factory as one autonomous production system:

1. Scripted workers replace only LM inference while using the same contracts, tools, persistence, gates, routing, and effects as production.
2. A real order moves through every configured workshop without manual database edits, artificial dispatch kicks, or human approval.
3. The Kanban card cycle and the engine/Workplace cycle remain mutually consistent across authoring, review, repair, effects, completion, pause, and terminal routing.
4. A clean GLM-4.7 run with concurrency at most two builds and locally starts the educational “Mars or Venus” ballistic mission calculator.
5. Human involvement begins only after the locally running product is ready for acceptance. Deployment/DevOps is outside this MVP lifecycle.

## Non-negotiable constraints

- Preserve existing user changes and dirty-worktree evidence.
- No direct mutation of live Factory authority tables to make a run progress.
- No manual task-state transitions or artificial resume loops during the final E2E.
- No human approval gate before local product readiness.
- No deployment/release stage in the MVP product-build path.
- GLM-4.7 effective concurrency <= 2.
- No more than two concurrent worker/browser sessions.
- Every discovered defect gets a reproducible regression test and an entry in the unified bug report.
- Architectural decisions require an ADR and Decision Journal entry.

## Work plan

| ID | Workstream | State | Exit evidence |
|---|---|---|---|
| W1 | Audit current temporal suite and paused-launch fix | completed | Build + focused tests + full temporal result recorded |
| W2 | Decide production-faithful test architecture | completed | ADR-049 with MCDA, pre-mortem, Red Team |
| W3 | Scripted-LM contract-equivalence coverage | completed | Same WorkIntent/tools/submissions/gates; only inference port replaced |
| W4 | Cross-workshop movement coverage | completed | Real composition traverses all product-build stages and terminalizes |
| W5 | Dual Kanban/engine state conformance | completed | Transition matrix + cross-product invariants + generated traces |
| W6 | Liveness/fault temporal coverage | completed | No silent nonterminal state; crash/retry/effect/routing scenarios pass |
| W7 | Fix production defects exposed by W3-W6 | completed | Regression tests and full relevant suites green |
| W8 | Update conveyor mental model and testing strategy | completed | Normative state/temporal contracts documented |
| W9 | Clean scripted full E2E | pending | Fresh DB/repo reaches local-ready without authority hacks |
| W10 | Clean real GLM-4.7 project | pending | New project reaches locally running acceptance-ready state autonomously |
| W11 | Monitor final run and inspect product | pending | Logs, DB timeline, worker cap, local launch, and terminal proof captured |
| W12 | Commit and handoff | pending | Intentional commits, final report, remaining risks |

## Current findings

- The paused-launch false-green fix is present: launch and order can finish as `paused`, and the CLI exits non-zero instead of recording `completed`.
- TypeScript build and the focused launch/architecture suite pass (34/34 on 2026-08-10).
- The serialized full temporal suite passes 31/31 in 578.5 seconds.
- The dependency scenario emits zero dependency edges and logs that fact while passing. This is a known non-vacuity gap and is not accepted as dependency-liveness proof.
- TEST-GAP-001 is now closed: the scripted planner emits a deterministic dependency chain and the focused real-composition test proves one durable edge plus reservation-after-integration ordering.
- The v4→v5 paused-launch migration now preserves all three indexes and refuses to stamp unknown/future schema versions as current.
- ADR-049 chooses production-wired temporal conformance plus a shadow three-machine differential model; a durable obligation ledger is the escalation if a future real stall passes both layers.
- The working tree already contains user/subagent changes. They must be reviewed and preserved, not reset.
- A routing diagnostic initially appeared to expose a live factory stall, but the factory stdout and authoritative DB proved completion. The synthetic test had copied only the SQLite main file and omitted committed WAL pages. It now uses the SQLite backup API and refuses to synthesize from a nonterminal source snapshot.

## Evidence log

| Time (Europe/Moscow) | Evidence | Result |
|---|---|---|
| 2026-08-10 | `npm run build` | passed |
| 2026-08-10 | factory launch + temporal ratchet focused tests | 34 passed, 0 failed |
| 2026-08-10 | `npm run test:factory-temporal` | 31 passed, 0 failed; 578.5s; non-empty dependency DAG still missing |
| 2026-08-10 | focused non-empty dependency temporal test | passed; 1 durable edge; dependent reservation followed prerequisite integration |
| 2026-08-10 | `npm run test:factory-model` initial generated suite | 3 passed, 0 failed |
| 2026-08-10 | v4/v5 migration + launch tests | 16 passed, 0 failed |
| 2026-08-10 | full Factory Contract suite after DAG/fixture changes | 75 passed, 0 failed |
| 2026-08-10 | focused terminal-routing/WAL-safe snapshot regression | passed; canonical lifecycle completed and synthetic routing fault starts from a consistent backup |
| 2026-08-11 | `npm run test:factory-temporal` after all fixture/storage fixes | 31 passed, 0 failed; 593.7s |
| 2026-08-11 | clean real E2E run 002 through first Development review wave | Discovery and Formalization completed; sealed five-item/4-edge DAG admitted two independent roots; two authors then two reviewers; concurrency remained 2 |
| 2026-08-11 | Development review payload-contract regression | build passed; 12 focused submission/gate tests passed |

## Incident and defect log

| Bug | Symptom | Root layer | Regression test | Fix state |
|---|---|---|---|---|
| TEST-GAP-001 | Dependency temporal scenario passed with zero dependency edges | test architecture / fixture fidelity | deterministic non-empty DAG + claim-after-integration assertion | fixed |
| MIGRATION-001 | DB open stamped any unknown mismatched user_version as v5 | schema migration | future-version fail-closed child-process test | fixed |
| TEST-FIXTURE-001 | crash recovery test depended on absent `.button-color-replay-e2e/factory.sqlite` only to copy project metadata | test isolation | self-contained project fixture | fixed |
| TEST-SNAPSHOT-001 | temporal routing test copied only the SQLite main file, losing committed WAL pages and fabricating an inconsistent running lifecycle | test storage boundary / SQLite snapshot semantics | backup-API source snapshot + terminal-transition precondition | fixed |
| LIVE-SRS-001 | Real SRS worker exhausted five retries because rejection named a generic missing section and supplied only §D2 repair instructions when the actual defect was an invalid §12 Decision Log representation | validator/worker recovery contract | rejection message asserts exact Decision Log representation, columns and canonical example | fixed; clean E2E rerun required |
| LIVE-REVIEW-001 | Two real reviewers submitted `approved` Development verdicts without `subject_candidate_set_ref`/`findings`; storage accepted them, the final gate returned `unknown` twice, and the autonomous launch truthfully paused | executable product-contract registration / production-composition test non-vacuity | registered pinned review payload contract rejects malformed verdict before storage; focused submit/gate tests | fixed; new clean E2E required |
| LIVE-REVIEW-002 | A Formalization reviewer submitted a valid `changes_requested` verdict with structured findings, but the generic gate accepted only string findings and retried the reviewer instead of routing repair to the author | canonical review schema ambiguity / negative-path fixture gap | gate accepts bounded structured findings; regression asserts structured negative verdict maps to `failed`/author repair | fixed; run 003 recovered autonomously on a later valid review |

## Final E2E acceptance contract

The final real run is accepted only when all statements are true:

- A brand-new project/order/database/repository was created through the normal public start path.
- The selected model is GLM-4.7 and durable active executions never exceed two.
- Discovery, Formalization, and Development execute through the canonical product-build composition.
- The run does not create a DevOps/deployment approval dependency.
- No direct SQL authority mutation, manual card movement, artificial host kick, or bespoke incident-only route was used.
- The produced web application has a backend, starts locally using its documented command, and is reachable in a browser.
- The Factory terminal state truthfully means locally runnable and ready for human acceptance.
- Durable timeline evidence shows every workshop transition and every Kanban/engine state correspondence.

## Notes

This tracker records operational progress. Normative architecture belongs in `docs/architecture/CONVEYOR-MENTAL-MODEL.md`, the testing contract belongs in `docs/design/TESTING-STRATEGY.md`, and architectural choices belong in numbered ADRs.
