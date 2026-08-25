# EK-1 Protocol Decisions — FROZEN

**Frozen by:** integration coordinator, 2026-08-25.
**Input:** reconciliation commit `d41cebe0` (branch `ek1/graph-reconciliation`)
— 32 differences: 20 resolved-with-citation, 12 framed protocol decisions;
validator `VALID ... 0 silently accepted`.
**Effect (per plan EK-1):** any later semantic change to these decisions
REOPENS EK-1 and invalidates downstream qualification evidence.

All twelve decisions are **ADOPTED AS RECOMMENDED** by the reconciliation
(each recommendation was checked against the architecture laws before
adoption — citations inline):

| # | Decision | Frozen value | Law anchor |
|---|---|---|---|
| D1 | Physical vocabulary | Adopt the universe's names as frozen (incl. `processRun.settle`) | plan EK-1 name-freeze |
| D2 | Effect-level repair | Extend effect-result vocabulary to 7 kinds (incl. `repair`) | ADR-074 typed effect-repair; repair-loop theorem |
| D3 | Cancellation shape | Proofs at {lifecycle, run} naming member dispositions + `activityAttempt.cancel` + `TypedWaitDisposition` | one-writer; avoids 7-scope proof explosion |
| D4 | Verifier receipt | `lifecycleRun.verifyTerminalClaims` (LifecycleRun-owned command) | verifier is not an author/reviewer kernel role (plan role universe) |
| D5 | Wake discharge | Obligation-completion receipts of the named wake sources | durable-handoff grammar; no new receipt kinds |
| D6 | Truthful-failure terminality | Repair-epoch ledger exhaustion + scope-refusal receipt (`RepairTerminalityEvidence`) | ADR-075 recovery epochs; honest terminal |
| D7 | Unreachable scope set | {cell, workplace, node}; run-scope refusals stay pre-run `TypedRefusalReceipt` | dependency-graph scopes own unreachability |
| D8 | Replay-capture sweep owner | Certification Workplace (single effect writer) | one-writer law (D8 conflicts resolved by re-typing) |
| D9 | Watchdog | `factoryRun.observeWatchdog` aggregate command — durable evidence, observe-only | watchdogs observe and command, never repair SQL |
| D10 | Discovery-unknown obligations | `workItem.planGraph` clause (+ `obligation:openUnknownObligation`) | idea conservation; unknowns cannot disappear |
| D11 | CellFinalAcceptance fields | Embed acceptanceDigest + digest equality (not refs-only) | authority conservation executable on the fact |
| D12 | Effect/send uncertainty | Operator disposition command receipt (now); automated probe may be a later extension | no-implicit-rollback; CONVEYOR §20 |

**Unified universe (frozen with these decisions):** 9 aggregates (+4
authorities), 53 commands, 49 obligation kinds, 5 wait kinds, 28 terminal
proofs (post-D7), 67 evidence kinds — `transition-universe.json` @
`d41cebe0` is the authoritative machine artifact.

WP-05/WP-16 may now pin against this universe.
