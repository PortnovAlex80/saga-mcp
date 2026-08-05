# Appendix: transition acceptance and incident checklist

Use this checklist top-down, but evaluate all applicable conditions at the
current landmark in one consistent snapshot. Rank the earliest root unmet
invariant; do not run downstream checks whose prerequisites are unknown. Every
condition may be `met`, `unmet`, `unknown` or `not_applicable`. Record identifiers
and hashes, never only prose.

## A. Factory and workshop boundary

- [ ] Project resolves to exactly one FactoryOrder and one resumable
  LifecycleRun. Ambiguity fails closed.
- [ ] Start mode is explicit; a project number resumes, while a frozen product
  idea creates a new order.
- [ ] Current StageRun is unique and points to the intended `moduleRef`.
- [ ] Stage input has an immutable source/predecessor reference and digest.
- [ ] ProcessRun is reused idempotently and pins package/version/definition.
- [ ] Previous stage has a terminal outcome certificate and exact output map.
- [ ] The lifecycle transition has one idempotency key and one winner.

If this block fails, inspect FactoryOrder/LifecycleRun, StageRun,
ProcessOutcomeCertificate and process-transition evidence. Do not launch a new
worker or copy upstream documents to hide a routing failure.

## B. Flow and production cell

- [ ] NodeRun cursor identifies one node attempt and exact predecessors.
- [ ] All required input bindings point to accepted immutable products.
- [ ] Transition/recovery budgets are not exhausted.
- [ ] A production node resolves a declared cell/profile without switching on
  one of the four workshop names.
- [ ] WorkplaceRef and workKey are deterministic; replay creates no duplicate.
- [ ] Kanban phase and machine loop state form a legal pair.
- [ ] Card is a projection of Workplace state, not transition authority.

Typical causes: `NODE_DEPENDENCY_UNMET`, `INPUT_BINDING_MISSING`,
`WORKPLACE_IDENTITY_CONFLICT`, `INVARIANT_ILLEGAL_STATE_PAIR`.

## C. Desk, worker and provenance

- [ ] The desk path is derived from WorkplaceRef and survives worker replacement.
- [ ] Instructions, allowed tools, exact read set and current role are captured.
- [ ] On repair, RecoveryIssue contains failing receipt/findings and rejected
  candidate references and is visible on the same desk.
- [ ] Reservation and WorkerExecution were committed before launch.
- [ ] Fence, Workplace revision and lease match on every mutation.
- [ ] Liveness, progress and terminal receipt are distinguished.
- [ ] Products are immutable/content-addressed and identify producer execution,
  input hash, fence and source/adoption checkpoint.
- [ ] Imported prior products pass official checkpoint adoption; raw copied
  Markdown and manually edited statuses never count as accepted output.

Typical causes: `RESERVATION_MISSING`, `EXECUTION_LEASE_EXPIRED`,
`EXECUTION_STALE_FENCE`, `PRODUCT_HASH_MISMATCH`, `PRODUCT_LINEAGE_MISSING`.

## D. Review and quality gate

- [ ] CandidateSet is sealed and names the exact product revisions.
- [ ] GateRun subject is the exact Workplace revision/CandidateSet.
- [ ] CheckPlan declares mechanical, semantic/review and policy checks.
- [ ] Every required CheckReceipt is terminal, typed and evidence-backed.
- [ ] Reviewer, when required, receives exact author output and produces an
  independent execution/receipt plus actionable feedback.
- [ ] Exactly one GateDecision applies to this subject and revision.
- [ ] Only `accepted` advances; `repair_required`, `human_required` and `failed`
  take their explicit branches.
- [ ] In test mode, expensive production may be adopted, but semantic review,
  feedback delivery, receipts, decision applicability and state transitions
  remain real unless the test case explicitly declares and labels a fake check
  provider.

Typical causes: `CHECK_REQUIRED_RECEIPT_MISSING`, `CHECK_PROVIDER_ERROR`,
`REVIEW_FEEDBACK_MISSING`, `GATE_DECISION_STALE`, `GATE_NOT_ACCEPTED`.

## E. Settlement, next workshop and effects

- [ ] Terminal node has a typed completion/outcome and matching digest.
- [ ] Settlement references only accepted outputs.
- [ ] Next-stage mapper validates the declared input schema.
- [ ] Stage transition and next ProcessRun creation are atomic/idempotent.
- [ ] External effects have prior authorization, stable idempotency key and an
  observed EffectReceipt; unknown outcomes enter reconciliation.
- [ ] Checkpoint/resume restores the same order, ProcessRun, cursor, Workplace,
  products, quality evidence and outbox position.

Typical causes: `SETTLEMENT_OUTPUT_MISSING`, `SETTLEMENT_HASH_MISMATCH`,
`ROUTING_SCHEMA_MISMATCH`, `EFFECT_OUTCOME_UNKNOWN`,
`CHECKPOINT_INCOMPATIBLE`.

## F. Required incident card

For every stalled/failed order attach:

- [ ] project/order/lifecycle/stage/process/node/Workplace identifiers;
- [ ] current and expected-next landmark;
- [ ] first unmet invariant and stable reason code;
- [ ] authoritative row/receipt/decision references and correlation id;
- [ ] timestamps for first/last observation and lease/liveness evidence;
- [ ] retry classification and safe resume action;
- [ ] reusable accepted/adoptable products so completed LM work is not repeated;
- [ ] redacted telemetry excerpt only as supporting context;
- [ ] confirmation that retry did not create a second active run or Workplace.
- [ ] consistent snapshot and observed revision/digest set;
- [ ] diagnostic coverage (`complete|partial|unknown`) and any competing or
  contradictory invariant refs;
- [ ] recommended action's expected revision and preconditions; the real command
  will revalidate them.

## G. Conformance scenario for every new workshop

Run the same scenario without changing the factory engine:

1. Start an epic and materialize its module StageRun/ProcessRun.
2. Produce a candidate, reject it in review, and verify exact feedback on the
   same Workplace desk.
3. Crash after each durable boundary: product, CandidateSet, receipt, decision,
   settlement and lifecycle transition.
4. Resume by project number and prove no completed LM production repeats.
5. Accept the repaired candidate and route its exact outputs to the next stage.
6. Rebuild projections and obtain the same incident/execution history.
7. Repeat with an adopted checkpoint and with a fake producer in test mode;
   quality and transition invariants must remain unchanged.
8. Prove the module required no module-name branch in lifecycle, dispatcher,
   Workplace coordinator, quality gate or diagnostic explainer.
9. Exercise concurrent advance during diagnosis, absent journal with intact
   authority, duplicate outbox delivery, rollback before outbox, database
   unavailability, unknown reason code and event redaction.
10. Make a legacy migration adapter return `unknown` when evidence is unavailable;
    it must never translate absence into pass.
