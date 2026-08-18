# W9-04 — Unreachable lifecycle outcome edges: evidence dossier

> **RESOLVED — acted on in the stage-3 commit that added this header.**
> The architect's decision: delete the dead outcomes on BOTH sides (route
> table AND worker-facing grammar; deleted words are now invalid input at the
> gate, never translated to clarify), keep the three `failed` routes (runtime
> producers exist at the kernel-failure seams), and replace this prose with
> the mechanical ratchet `tests/architecture/lifecycle-outcome-vocabulary.test.mjs`.
> The claims below are the historical record of HOW the gap was found; the
> surviving vocabulary is go / clarify / reject / formalized / inconsistent /
> verified / blocked / failed.

Date: 2026-08-18. Method: read-only source audit of `src/` at current HEAD.
Consumer: architect escalation per `tests/architecture/lifecycle-outcome-edge-coverage.test.mjs`
(PENDING entries, lines 53-62: five terminal edges with no runtime trace).

Legenda: all paths are `file:line` from repo root; quotes are verbatim.

---

## Claim 1 — `solution-formalization:infeasible` has no runtime producer

**VERDICT: CONFIRMED.**

1. `src/modules/formalization/domain/formalization-schemas.ts:107-113` — the decision type
   declares it: `| 'infeasible'` (union member of `FormalizationDecision`). Declaration only.
2. `src/process-modules/modules/formalization/formalization-process-module.ts:276` — the flow's
   ONLY incoming edge of the terminal node:
   `{ from: 'settle-formalization', to: 'complete-infeasible', on: 'domain.infeasible' }`.
   No other node routes to `complete-infeasible` (nodes list lines 249-257, terminalNodeIds 279-282).
3. `src/modules/formalization/infrastructure/sqlite-formalization-kernel.ts:490-499` — the
   settlement decision mapper returns only three values:
   `if (reasonCodes.includes('infrastructure-error')) return 'failed';` /
   `return 'clarification-required';` / `return 'inconsistent';` — plus `'formalized'` at
   line 474. `mapReasonsToDecision` can never return `'infeasible'`.
4. `src/modules/formalization/infrastructure/sqlite-formalization-kernel.ts:368-371` — the code
   itself admits the gap: "'infeasible' is reserved … The pump may emit 'infeasible' from the
   architect node directly (it knows the SRS)." No such pump exists: the architect node is a
   production-cell (`formalization-process-module.ts:223-238`), not a resolver.
5. `src/modules/formalization/application/formalization-production-cell-installation.ts:194,248` —
   the settle handler maps the decision verbatim: `const decision =
   deps.settlementPolicy.settle(...)` then `return { event: decision.decision, ... }`.
   Since the policy never decides `'infeasible'`, the event `domain.infeasible` is never emitted.
6. Grep `grep -rn "infeasible" src --include=*.ts` (types/comments excluded) — every hit is a
   declaration or comment: schemas type (above), lifecycle route table
   (`product-delivery-lifecycle.ts:368`), outcome contract list
   (`package/contributions/output-contracts.ts:226`), module declarations
   (`formalization-process-module.ts:144,249,276,281`), and the legacy node-protocol data file
   `package/nodes/architecture/architecture-resolver-node-protocol.ts:14,137` whose prompt string
   lists `domain.infeasible` for a `resolve-architecture-contract` kernel node that does not exist
   in the installed flow. No runtime emitter anywhere.

**Architect decision requested:** delete `infeasible` from `FormalizationDecision`, the flow and
the lifecycle route table, or add a real producer (e.g. an SRS-constraint feasibility check whose
failure maps to `domain.infeasible`).

---

## Claim 2 — `solution-formalization:clarification-required` is unreachable in a fresh run

**VERDICT: CONFIRMED** (sub-point (c) nuanced, see item 4).

1. Policy triggers read only lifecycle-scoped ACCEPTED material.
   `src/modules/formalization/infrastructure/sqlite-formalization-kernel.ts:428-431` —
   `if (artifacts.prd === null) { return fail(inputHash, ['prd-missing'], ...)`; same for
   `acceptance-empty` (432-435) and `srs-missing` (449-452); these are the only reasons mapping
   to `'clarification-required'` (line 494-496). The read itself:
   `readAcceptedArtifactsForLifecycle` lines 129-138 —
   `WHERE a.epic_id=? AND a.status='accepted' AND sr.lifecycle_run_id=?`.
2. Every production cell re-accepts its own sealed material. All five formalization cells are
   built by `reviewedCell` with `postAcceptanceEffect: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID`
   (`formalization-process-module.ts:105`). The effect
   (`src/modules/formalization/application/formalization-accept-products-effect.ts:123-148`)
   unconditionally runs
   `UPDATE artifacts SET status='accepted', accepted_hash=?, drift_state='clean' ... WHERE id=?`
   for every artifact of the sealed production snapshot. A worker-reopened draft artifact is
   re-accepted by its own cell; if content drifted, the effect returns `repair_required`
   (lines 110-120) — an in-cell repair loop, never a settlement clarification.
3. Worker_done validators force the artifacts to exist before a cell can complete.
   `src/modules/formalization/application/formalization-check-providers.ts:39-60` registers one
   submission-validator check provider per node. Enforcement lives in
   `formalization-contract-analysis.ts` `findContractGap`: exactly one PRD —
   `if (categories.prd.length !== 1) return 'contract must contain exactly one PRD'` (line 98);
   at least one AC — `if (categories.acs.length === 0) return 'contract must contain at least
   one AC'` (line 123); exactly one SRS — `if (categories.srs.length !== 1) ...` (line 166).
   SRS presence is fail-closed at worker_done:
   `srs-contract-validator.ts:137-155` — `code: 'FORMALIZATION_SRS_MISSING'` reject.
4. NUANCE on (c): the acceptance node itself early-accepts a zero-AC submission
   (`acceptance-contract-validator.ts:169-171`: "If the worker created no AC artifacts, the
   resolver will catch it … Accept here"). The gap is closed one node later: `reconcile-what`'s
   validator runs `{ product: true, useCases: true, acceptance: true }`
   (`formalization-check-providers.ts:32-37`), so ≥1 AC is enforced at reconcile-what's
   worker_done, and the freeze kernel fails on zero accepted ACs
   (`formalization-production-cell-installation.ts:89-91`) — routing to `complete-failed`,
   not clarification.
5. The cell-level `humanRequiredTransition` is dead code. Declared at
   `formalization-process-module.ts:117`: `humanRequiredTransition: 'complete-clarification-required'`.
   The FULL formalization flow transitions array (lines 259-278) is:
   define-product-contract→model-use-cases/complete-failed (domain.accepted/failed);
   model-use-cases→define-acceptance-contract/complete-failed;
   define-acceptance-contract→reconcile-what/complete-failed;
   reconcile-what→freeze-acceptance-baseline/complete-failed;
   freeze-acceptance-baseline→define-architecture-contract/complete-inconsistent/complete-failed
   (domain.frozen/drift-detected/failed);
   define-architecture-contract→settle-formalization/complete-failed;
   settle-formalization→complete-{formalized,clarification-required,inconsistent,infeasible,failed}.
   NO edge consumes any human-required event from a production cell; the only route to
   `complete-clarification-required` is settle's `domain.clarification-required`.
6. Runtime cannot synthesize the event either. Cell `transitions.{accepted,humanRequired,failed}`
   are only VALIDATED, never consumed by any executor
   (`src/process-modules/domain/workplace/production-cell-definition.ts:236-238`). The node
   executor maps a human park to a runtime pause, not a domain event:
   `production-cell-node-executor.ts:379-388` — `return { runtimeEvent: 'paused', pause:
   { kind: 'human_required', ... } }`; a grep over the executors shows production cells can emit
   ONLY `domainEvent: 'failed'` (line 403) or `domainEvent: 'accepted'` (line 421). The flow
   executor turns `runtimeEvent === 'paused'` into `ProcessRunPausedError`
   (`generic-flow-executor.ts:857-861`) — no transition is matched.

**Architect decision requested:** either wire human parks to the declared
`humanRequiredTransition` (add `domain.human-required` flow edges + a cell-side event) or drop
the `clarification-required` outcome from Formalization — the accept-effect plus the
worker_done validators remove all three settlement triggers.

---

## Claim 3 — `solution-development:rework-required` is unreachable through normal production

**VERDICT: CONFIRMED.**

1. Only two producers in settlement.
   `src/modules/development/domain/development-settlement-policy.ts:822-831` — `implementation-failed`
   fires iff a required workset item has `status === 'failed'`; lines 1095-1102 —
   `verification-failed` fires iff `evidence.outcome === 'failed'`. No other branch returns
   `'rework-required'`. The settle handler maps the decision verbatim
   (`development-installation.ts:628`: `event: settled.decision`).
2. Item status is copied from the product's `terminalStatus`, but a non-complete product can
   never be an ACCEPTED cell product. Mapping:
   `src/modules/development/infrastructure/sqlite-development-settlement-state.ts:593-595` —
   `status: product.payload.terminalStatus === 'complete' ? 'succeeded' as const
   : product.payload.terminalStatus`. But the git post-acceptance integration effect hard-gates
   the value: `src/infrastructure/workplace/sqlite-production-cell-integration.ts:122-138` —
   `if (payload.terminalStatus !== 'complete' || ...) return { outcome: 'blocked', reason:
   'PRODUCTION_CELL_INTEGRATION_SOURCE_COMMIT_MISSING: task ...' }`, and
   `src/infrastructure/workplace/git-integration-effect.ts:82-85,131-135` maps that blocked
   observation to `'repair_required'` — the workplace returns to repair until a worker reports
   `complete`. Settlement reads only accepted workplaces: `settlement-state.ts:840-841` —
   `AND w.loop_state='terminal' AND w.terminal_reason='accepted'`. Hence every accepted
   implementation product carries `terminalStatus === 'complete'` → item `'succeeded'`;
   `implementation-failed` is dead.
3. Verification evidence outcome is hardcoded `'passed'`.
   `settlement-state.ts:696-785` `readTrustedVerificationReceipt`: the SQL itself filters
   `AND cr.outcome='passed'` (line 729); the return type is `outcome: 'passed'` (lines 700, 745,
   771); a non-passed receipt makes `admissible.length !== 1` → `null` (line 768) and the item
   silently drops out of the evidence set. Injection point lines 657-673 with the comment
   (768-769): "Outcome and authority come from the immutable executable provider receipt, never
   from the LM assessment payload". Therefore `evidence.outcome === 'failed'` can never be true
   and the `verification-failed` branch is dead.

**Architect decision requested:** `rework-required` has no honest producer today. Either let the
receipt reader admit failed receipts (trusted executable acceptance verification that can fail),
or delete the outcome from Development and the lifecycle table.

---

## Claim 4 — `solution-development:clarification-required` is unreachable through normal production

**VERDICT: CONFIRMED** (with one theoretical-divergence nuance, item 5).

1. Flow routing: `development-process-module.ts:393` —
   `{ from: 'resolve-task-graph', to: 'settle-development', on: 'domain.clarification-required' }`
   (then settle → complete-clarification-required, lines 412-417).
2. Resolver's clarification paths (`src/modules/development/application/development-installation.ts`,
   `createTaskGraphResolver` lines 267-444): missing execution id (293-303), missing submission
   (306-318), wrong submission schema (319-330), proposal decode failure (331-343), and policy
   validation failure without integrity reason codes (361-375: `integrityFailure ? 'failed' :
   'clarification-required'`, integrity = invalid-input-contract / task-graph-hash-invalid /
   task-graph-lineage-mismatch).
3. The planner cell gate is a strict superset of the resolver.
   `src/modules/development/application/development-check-providers.ts:443-556`
   (`createDevelopmentTaskGraphCheckProvider`): it requires the CandidateSet member to be an
   exact `DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA` managed-node-submission with matching
   content_hash (lines 476-494), decodes with the same `decodeDevelopmentTaskGraphProposal`
   (495-507), builds with the same `buildCanonicalDevelopmentTaskGraph` (515-523), validates
   with the same policy (line 524; line 457 defaults to
   `new ReferenceDevelopmentTaskGraphPolicy()` — the identical class injected into the resolver),
   PLUS the SRS §2.2 module-manifest coverage assessment (531-535,
   `assessSrsModuleManifestCoverage` 757-816). The gate passes only when
   `validation.valid && manifestAssessment.failure === null` (line 536). Nothing can pass the
   cell gate but fail the resolver's validate.
4. Missing-submission paths are prevented by the cell's own contract: the planner cell declares
   `cardinality: '1'` with the proposal schema and payload contract
   (`development-process-module.ts:187-192`); the only edge into resolve is
   `plan-task-graph → resolve-task-graph on domain.accepted` (line 390), which requires an
   accepted workplace — i.e. a gate-accepted exact proposal submission. The executor asserts
   the product contract (production-cell-node-executor.ts:1660-1668).
5. NUANCE: the gate reads the DevelopmentCase from `factory_process_runs.input_snapshot`
   (check provider lines 508-514) while the resolver reads `ctx.frame.runInput`. In normal
   production these are the same row; only an operator/infrastructure divergence between the two
   could make validation outcomes differ. The resolver's catch path (435-441) yields `'failed'`,
   not clarification.

**Architect decision requested:** keep `clarification-required` only if the resolver is meant to
double-check the gate (defense in depth); otherwise collapse it — the planner cell gate makes it
dead in normal production.

---

## Claim 5 — `solution-development:failed` is unreachable through normal production

**VERDICT: CONFIRMED for normal production** — with two explicit non-normal producers that
remain: infrastructure exceptions and the recovery total-attempt cap (item 4, bounded but long).

1. Routing: `complete-failed` incoming edges (development flow, lines 389-418) are
   `domain.failed` from `plan-task-graph` (391), `implement-work-items` (396),
   `certify-product-readiness` (400), and `settle-development → complete-failed` (412-417);
   `verify-acceptance` failure routes to settle (411), not to complete-failed.
2. A cell gate verdict `'failed'` (terminal) has exactly one producer:
   `src/process-modules/application/gate-run-driver.ts:271-273` —
   `if (entry.failureOwnership === 'upstream') { return { verdict: 'failed', repairTargetRole:
   null }; }`. Grep `grep -rn "failureOwnership" src --include=*.ts` returns ONLY: the type
   (`domain/workplace/gate.ts:123`), the builder option
   (`application/standard-check-providers.ts:94,128-129`), and THREE COMMENTS claiming it is in
   use — `src/app/factory-continuation.ts:107`,
   `development-process-module.ts:405` ("FROZEN integrated candidate
   (failureOwnership:'upstream')"), and
   `development-verification-continuation-process-module.ts:51` ("local-runnability with
   failureOwnership:'upstream'"). NO check plan declares the field:
   `VERIFICATION_FINAL_PLAN` (development-process-module.ts:126-134) carries only the
   verification-product provider (+repair role); `READINESS_CERTIFICATION_PLAN` (135-151) carries
   local-runnability but NO `failureOwnership` — despite its own comment (141-146) claiming
   deterministic failure "escalate[s] to 'failed'". The continuation comment (lines 48-55) even
   asserts VERIFICATION_FINAL_PLAN contains local-runnability — it does not. The comments
   describe a mechanism that was never wired.
3. Remaining producers of terminal `failed` workplaces / kernel `failed` events:
   the coordinator maps verdict `failed` → event `gate-failed` → `terminal(state, 'failed')`
   (`production-cell-coordinator.ts:201-203`;
   `domain/workplace/production-cell-reducer.ts:286-288`). Verdict `failed` from the executor is
   issued only at the recovery total-cap
   (`production-cell-node-executor.ts:600-613`) or `onExhausted === 'fail'` (640-644) — and NO
   formalization/development cell declares `onExhausted: 'fail'` (all use `'requeue'`:
   formalization-process-module.ts:103; development-process-module.ts:194,264,301,358).
   Settlement-side `'failed'` reasons (invalid-input-contract, `*-hash-invalid`,
   `*-lineage-mismatch`, infrastructure-error — policy lines 709-715, 747-753, 773-787,
   815-821, 855-861, 898-915, 968-974, 995-1013, 1054-1060, 1075-1081, 1164-1170) are
   hash/lineage checks over kernel-built snapshots: the workset hash is computed at settlement
   over the body the same function just built (settlement-state.ts:612-622 — self-consistent by
   construction), the candidate is kernel-frozen, the verification workset is kernel-built
   (625-694); workers reach settlement only through content-addressed sealed CandidateSet
   members. The resolver's `'failed'` (integrity codes / catch, development-installation.ts:
   357-363, 435-441) is equally infrastructure-only, because the cell gate already ran the same
   validate on the same content-pinned submission (Claim 4).
4. NUANCE (budget path is real but slow): the total-cap breaker IS a genuine runtime producer of
   `domain.failed` → `complete-failed`. `DEFAULT_RECOVERY_TOTAL_ATTEMPTS = 30`
   (`production-cell-definition.ts:86`) with inter-epoch backoff
   `Math.min(60_000 * 2 ** Math.max(0, epoch - 1), 15 * 60_000)` (lines 96-99). Development
   cells allow 3 attempts/epoch (194, 264, 301, 358) → ~10 epochs → ≥ ~90 minutes of pure
   backoff plus worker execution before the cap trips. This matches the empirical observation
   that a failing local-runnability receipt looped the readiness author in repair (receipt
   'failed' without failureOwnership maps to `repair_required`, driver line 274) and never
   terminal-failed in bounded time.

**Architect decision requested:** make the comments true or delete them: either declare
`failureOwnership: 'upstream'` on the local-runnability / verification plan entries (restoring an
honest terminal-failed route for producer-defect candidates), or accept `'failed'` as an
infrastructure-only outcome (with the 30-attempt cap as the sole in-flow breaker) and classify
the edge accordingly in the coverage registry.

---

## Cross-cutting observation

The same dead-declaration pattern repeats: `humanRequiredTransition: 'complete-blocked'` in the
development module (development-process-module.ts:198,305,361) has no consuming edge in the
standard flow either — only the verification-continuation flow declares
`on: 'domain.human-required'` (development-verification-continuation-process-module.ts:82), and
no executor can emit that domain event at all (only `accepted`/`failed`,
production-cell-node-executor.ts:403,421). Cell-level `transitions` maps are validated but never
consumed (production-cell-definition.ts:236-238). The declarative surface has drifted from the
executable surface; that drift is the common cause of all five unreachable edges.


---

## CLAIM 6 — `initial-discovery:defer` and `initial-discovery:inconclusive` have no runtime producer

**Verdict: CONFIRMED (empirical + code).**

Evidence:

1. `src/modules/discovery/domain/discovery-settlement-policy.ts` — `DiscoverySettlementPolicyV1.evaluate()` emits exactly three decisions: `go` (§6.1 path), `reject` (§6.2 path) and `clarify` (every other branch via the `fallback_decision: 'clarify'` manifest field and the `clarify()` helper). There is no branch constructing a `defer` or `inconclusive` decision.
2. The flow declares the routes anyway: `src/process-modules/modules/discovery/discovery-process-module.ts` lines 139-140 route `settle → complete-defer on 'domain.defer'` and `settle → complete-inconclusive on 'domain.inconclusive'` — transitions no settle event can satisfy.
3. Empirical (W9-04 drives): a corpus proposal with `recommended_outcome: 'defer'` (and separately `'inconclusive'`, `'failed'`) settled `clarify` with reason `CLARIFY_POLICY_FALLBACK` ("Indeterminate state; policy fell back to clarify") and the lifecycle continued through Formalization to `verified` — the worker-facing recommendation is not the emitted outcome.

**Architect decision requested:** either delete the two routes (and their outcome declarations) or define the producer (e.g. advisor `recommended_next_action: 'defer'` mapping) — today they are declared-but-dead.

## CLAIM 7 — `initial-discovery:failed` has no fast runtime producer through normal production

**Verdict: CONFIRMED for normal production (two non-normal producers acknowledged).**

Evidence:

1. A worker honestly recommending `failed` does NOT produce it: empirically the same corpus proposal with `recommended_outcome: 'failed'` settles `clarify` (`CLARIFY_POLICY_FALLBACK`) — the policy treats a worker failure-recommendation as indeterminate input, not as a process outcome.
2. The settlement policy (`discovery-settlement-policy.ts`) has no `failed` branch at all; the outcome code is reserved for process failure.
3. The reachable `complete-failed` edges are `produce-proposal/assess-readiness → complete-failed on 'domain.failed'` (discovery-process-module.ts lines 133-135): a cell gate verdict `failed` — per CLAIM 5's analysis, only `failureOwnership === 'upstream'` checks or the recovery total-cap produce that verdict terminally, and no discovery check plan declares upstream ownership; the total-cap requires ~30 attempts across wall-clock backoff epochs.

**Architect decision requested:** if `failed` is meant to be reachable in bounded time (infrastructure failure of a discovery cell), the same failureOwnership/budget question as CLAIM 5 applies; otherwise the route is a declaration without a producer.

## Cross-cutting addendum — discovery edges

The three discovery routes above, the five formalization/development routes, and the dead `humanRequiredTransition` targets share one root cause established in this dossier: **the declarative surface (outcome routes, outcome definitions, cell transition maps) has drifted from the executable surface (settlement policies, check plans, flow transitions)**. Routes are declared for outcomes no policy emits. This is the mechanical unreachability class CONVEYOR §23 L3 item 7 anticipated; each needs either a producer or a deletion decision.
