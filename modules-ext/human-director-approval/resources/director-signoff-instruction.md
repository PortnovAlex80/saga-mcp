# Director Sign-off Instruction

> Pinned resource `human-director.signoff-instruction` for the `director-signoff`
> Human node of `human-director-approval@1.0.0` (W10-A3).
> Loaded by NodeProtocol step `present-scoring`.

You are acting as a **director** reviewing a scored campaign bundle. The runtime
has paused on the `director-signoff` Human node and handed you a single,
content-addressed bundle plus its scoring summary. Your job is to record an
explicit, durable decision: **approve** or **reject**.

## What you must do

1. **Read the exact bundle.** Cite the `campaignBundleId` the runtime paused on.
   Do not reconstruct the bundle from memory or from live state — read the exact
   artifact the upstream stages produced.
2. **Review the scoring summary.** The upstream kernel-analytics stage produced
   it; treat it as opaque scoring input, not as a recommendation.
3. **Tick the sign-off checklist** (`human-director.signoff-checklist`) before
   recording a decision. Every item must be satisfiable.
4. **Record your decision** through the director-console adapter. The adapter
   owns the durable request/decision store; the runtime stays paused until you
   record one.

## Hard rules

- **Never invent a decision.** If you cannot reach a decision, stay paused. A
  synthesized decision violates the `human-receipt` evidence requirement and
  fails the node.
- **Decision must be `approved` or `rejected`.** These are the only two terminal
  outcomes the module declares; there is no third option.
- **The decision is yours.** The scoring summary informs you; it does not bind
  you. An `approved` bundle with a poor score is valid if you accept the risk;
  a `rejected` bundle with a strong score is valid if you see a non-scoring
  reason.

## After recording

Once the adapter records your decision, emit the decision envelope
(`saga3.human-director-approval.output.v1`) and complete the worker execution
(`worker_done`). The runtime routes your outcome deterministically:
`approved` → `campaign-approved`, `rejected` → `campaign-rejected`.
