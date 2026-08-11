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
| W5 | Production local-readiness authority | in progress | Exact frozen candidate builds/tests/starts/probes and terminates `runnable-local` without human or Delivery |
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
| 2026-08-11 | Run 006 preserved after truthful Development pause | Discovery/Formalization completed; dependency DAG and concurrency=2 worked; LIVE-SCOPE-001 isolated |
| 2026-08-11 | author scope + checkout-independent integration focused suite | build passed; 12 tests passed |
| 2026-08-11 | full Factory Contract after LIVE-SCOPE-001 and scripted-authority parity fix | 75 passed, 0 failed |
| 2026-08-11 | Run 008 real typed changed-file boundary regression | two in-scope Git diffs were falsely rejected; build + focused scope suite passed 7/7 after decoder fix |
| 2026-08-11 | Run 010 Formalization→Development hash-boundary regression | shared-document handoff now preserves provenance `acceptedHash` and atomic `criterionHash`; build + focused suite passed 10/10 |
| 2026-08-11 | Run 011 recovered multi-execution Workplace acceptance regression | network-lost author was autonomously replaced; immutable accepted snapshot spanned both executions; focused effect suite passed 3/3 |
| 2026-08-11 | Run 012 clean cross-workshop transition | Discovery and Formalization completed; recovered production and document/criterion hash fixes passed live; Development planner started automatically |
| 2026-08-11 | Run 012 task-graph diagnostic regression | two invalid planner graphs exposed exact scope overlaps, but recovery discarded the policy errors; build + focused diagnostic/recovery suite passed 5/5 after fix |
| 2026-08-11 | Run 013 reviewer-finding diagnostic regression | SRS reviewer persisted six exact structured findings, but the failed review CheckReceipt had no evidence refs and author recovery saw only a generic failure; build + focused diagnostic/recovery suite passed 10/10 after fix |
| 2026-08-11 | Run 015 clean Discovery→Formalization transition | Discovery settled `go`; the canonical router created Formalization ProcessRun 2 and dispatched its first real GLM-4.7 worker without a restart or operator action; durable concurrency remained <=2 |
| 2026-08-11 | completed-ProcessRun diagnostic regression | live Run 015 exposed a stale pause message on completed Discovery ProcessRun 1; build + production-composition temporal routing regression passed after terminal settlement began clearing the diagnostic |
| 2026-08-11 | Run 015 managed-document capability regression | two real architecture executions repeatedly encoded the SRS as Bash/heredoc programs, producing quoting failures and a duplicated workspace-relative path; Formalization author profiles now expose structured Write/Edit but no general shell; build + focused 56/56 + full Process Modules 950/950 passed |

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
| LIVE-REVIEW-003 | Registered verdict payload decoders were not frozen into reviewer WorkIntents because the universal executor only copied author product contracts; malformed Development verdicts reached storage and exhausted reviewer retries | universal Production Cell reviewer contract projection | `CellReview.payloadContract` is validated and pinned into reviewer authority scope; real executor test asserts the exact durable contract | fixed; clean run 004 required |
| LIVE-REVIEW-004 | Correctly pinned reviewer WorkIntents were rejected with `PRODUCT_PAYLOAD_CONTRACT_REQUIRED` because the separate worker MCP composition installed only the verification decoder | cross-process composition/version conformance | worker MCP root registers generic, Development-review, and verification decoders; architecture ratchet asserts all built-in pinned contracts | fixed; clean run 005 required |
| LIVE-REVIEW-005 | Run 005 reviewers twice copied the adjacent Workplace ref into `subject_candidate_set_ref`; shape validation passed, the final Gate returned `unknown`, and retry exhaustion paused the launch | missing relational authority at LM product submission / compliant-only scripted fixture | subject-versioned reviewer WorkIntent pins an exact generic payload binding; submission rejects mismatch before INSERT; adversarial contract test | fixed in code; clean run required |
| LIVE-SCOPE-001 | Run 006 task 18 changed package/test/config files outside frozen `src/core/` + `src/types/`; reviewer approved the false claim and checkout-based integration was disturbed by untracked canonical-checkout bytes | write-scope authority absent from author Gate; integration coupled to mutable checkout; scripted worker always compliant | Git-derived author scope Gate, nested-scope graph regression, exact desk-cwd runner test, contaminated-checkout object-merge test | fixed in code; clean run 007 required |
| LIVE-SRS-002 | Run 007 paused after five architecture repair cycles: deterministic SRS validation required one D2 row for the AC artifact container while reviewers required its atomic AC headings; Run 008 additionally proved valid AC documents may use standalone `## AC-1` members or dotted `### AC-1.1` children | lossy artifact-to-contract boundary; fixtures assumed one artifact equals one criterion and initially covered only dotted children | leaf-aware level-two/level-three atomic AC parser + frozen baseline members + SRS validator omission regression | fixed in code; clean run after host reload required |
| LIVE-SCOPE-002 | Run 008 produced two source commits whose actual Git paths exactly matched their frozen scopes, but the author Gate rejected both because real workers submitted typed `changedFiles` objects while the provider accepted only `string[]` | boundary decoder / scripted fixture representativeness; authoritative Git validation was incorrectly preceded by one presentation-shape assumption | provider extracts canonical paths from strings or typed `{path,...}` entries; regressions cover both real object variants and malformed objects | fixed in code; clean run after host reload required |
| LIVE-SRS-003 | Run 009 accepted nine atomic AC artifact rows that point to anchors in one shared Markdown document; baseline freeze parsed the full document for every row and failed with duplicate codes before SRS production | artifact identity/document-container cardinality; tests covered one container artifact but not N atomic rows sharing one file | atomic `AC-*` artifacts select only their matching leaf heading while container `AC` artifacts expand all leaves; missing anchors fail closed | fixed in code; clean run after host reload required |
| LIVE-SRS-004 | Run 010 completed Formalization but Development rejected all 11 criteria with `DEVELOPMENT_ACCEPTANCE_BASELINE_MISMATCH`: the Solution Contract placed each atomic section hash in `acceptedHash`, while Development correctly compared that field to the accepted shared-document artifact hash | handoff identity conflated immutable provenance-container acceptance with atomic criterion semantics | shared-document contract regression requires document `acceptedHash` plus distinct atomic `criterionHash` for every criterion | fixed in code; clean run after host reload required |
| LIVE-RECOVERY-001 | Run 011 recovered automatically after the Product Contract author connection died: the retry presented one accepted Workplace snapshot containing brief/PRD from execution A and FR/NFR/RULE from execution B, but the acceptance effect projected only execution B; settlement then returned `prd-missing` despite the accepted CandidateSet containing the PRD | stale execution-scoped post-acceptance effect contradicted the canonical Workplace-scoped product and crash-recovery model | effect resolves and validates the exact accepted CandidateSet's immutable Workplace snapshot, projects all contributing executions atomically, and retains typed-submission compatibility | fixed in code; clean run required |
| LIVE-GRAPH-001 | Run 012 reached Development autonomously, but two planner attempts were rejected for unordered overlapping repository scopes. The policy computed the exact conflicting item pairs, while CheckReceipt/RecoveryIssue reduced them to only `development.task-graph-contract returned failed`; the second planner fixed two pairs but could not see the two remaining pairs and exhausted its budget | check-provider diagnostic evidence was discarded at the Gate-to-Recovery boundary; compliant scripted planners never exercised semantic graph repair | universal content-addressed check diagnostics survive CheckReceipt and become exact RecoveryIssue findings; provider regression asserts exact scope pairs and projection regression asserts worker-visible messages | fixed in code; next clean run required |
| LIVE-REVIEW-006 | Run 013 SRS reviewer submitted `changes_requested` with six exact structured findings. The review payload retained them, but `factory.review-verdict.v1` returned only `failed` with an empty evidence list, so `recovery-feedback.json` told the replacement author only that the review check failed | review check-provider dropped the semantic negative-verdict payload at the CheckReceipt boundary; recovery projection could preserve only evidence it received | review provider v1.1 encodes every finding as a content-addressed diagnostic evidence ref; regression decodes both string and structured findings and the existing recovery projection consumes them generically | fixed in code; Run 013 remains on its already-pinned v1.0 provider |
| LIVE-PROJECTION-001 | Run 015 correctly advanced from Discovery to Formalization, but its completed Discovery ProcessRun retained `ProcessRun 1 paused ...` in `error`, allowing the board to render a stale red warning beside a successful workshop | resumable pause diagnostics were persisted on the ProcessRun and successful GenericFlow settlement did not clear them | terminal GenericFlow update explicitly clears `error`; real-composition temporal routing asserts every completed ProcessRun has no stale diagnostic | fixed in code; affects projection truth only, not Run 015 liveness |
| LIVE-AUTHORING-001 | Run 015 architecture authors repeatedly tried to create a large managed SRS through Bash heredocs/generated scripts, hit shell quoting errors, and one attempt duplicated `docs/requirements/...` after changing directory and then reusing the workspace-relative path | capability surface contradicted the managed-artifact contract: document-only Formalization profiles granted an unrestricted shell alongside structured Write/Edit, while tests asserted product shape but not least-authority authoring mechanics | every Formalization document author is denied Bash and retains Write/Edit; architect skill forbids shell/generated-script writes and explains workspace-relative paths; profile ratchet verifies the capability boundary | fixed in code; current Run 015 remains pinned to its pre-fix package and must recover under the old profile |

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
