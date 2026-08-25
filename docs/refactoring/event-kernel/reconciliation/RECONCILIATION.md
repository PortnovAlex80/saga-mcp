# RECONCILIATION — EK-1 Forward/Reverse Transition-Graph Reconciliation (unified transition universe)

- **Work package:** EK-1 coordinator reconciliation of WP-02 (forward) + WP-03 (reverse).
- **Machine artifact:** [`transition-universe.json`](./transition-universe.json)
  (`ek.transition-universe.ek1-reconciliation.v1`), validated by
  [`validate-transition-universe.mjs`](./validate-transition-universe.mjs) (analysis
  tooling only — no production `src/` changes).
- **Integration base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df`
  (branch `ek1/graph-reconciliation`, created from the base; WP-03's commit was
  not amended).
- **Frozen inputs (copied read-only into this directory, never edited):**
  - FORWARD: `forward-graph.json` + `FORWARD-GRAPH.md` — from `ek1/wp02-forward-graph` @ `1ccbf66d` (56 nodes, 132 edges, 8 waits, 7 coarse proofs, 10 gaps).
  - REVERSE: `reverse-graph.json` + `REVERSE-GRAPH.md` — from `ek1/wp03-reverse-graph` @ `6e029e08` (88 nodes, 112 edges, 28 proofs, 8 gaps).
  - Grounding: `authority-census.json` — from `ek1/wp01-census` @ `eaa07093`.

## 1. Method

Both inputs were frozen before this reconciliation opened either file (per the plan's
law: "Neither derivation may read the other's output before both are frozen"). The
reconciliation is typed at the protocol level, not narrative:

1. **Bridge grammar.** Forward nodes are `(aggregate, command)`; reverse nodes are
   typed evidence kinds and terminal proofs. The bridge is the durable-handoff
   grammar: a forward command commits facts/evidence + its `WorkflowEvent` +
   obligations; a reverse closure requires exactly such facts. Comparison units:
   - every forward-produced evidence kind must be required-or-consumed by some
     reverse closure;
   - every reverse-required fact must be forward-producible;
   - every obligation emitted forward must have a completion consumer (a target
     command or terminal proof);
   - every TypedWait forward must have a discharge evidence path reverse.
2. **Per-aggregate walk.** Both graphs were walked aggregate by aggregate
   (FactoryRun, LifecycleRun, StageRun, ProcessRun, NodeRun, WorkItem/Planning,
   Workplace incl. the ADR-053 material chain, ActivityAttempt, transport), then
   cross-aggregate (proof scope ladder, waits, obligations, planning coverage).
3. **Gap merge.** The 18 gaps (10 forward + 8 reverse) were deduplicated into the
   same table and classified: (a) resolvable NOW from plan text / census / the
   frozen inputs' own conventions — resolved in the universe with the exact
   citation; or (b) a protocol decision — framed as a precise either/or for the
   coordinator, with a recommendation, never a silent choice.
4. **Zero silent acceptance.** Every non-empty difference is a reconciliation[]
   entry: 20 resolved-with-citation + 12 protocol decisions framed. The validator
   enforces this mechanically (a `RESOLVED` entry without a citation, or an entry
   with neither marker, is invalid).

## 2. Difference table

Kind legend: `MFP` missing-forward-producer · `MRC` missing-reverse-consumer ·
`ORPH` orphan-obligation · `UDW` undischarged-wait · `GM` gap-merge ·
`MC` mapping-convention.

### 2.1 Resolved with citation (20)

| id | kind | difference | resolution (citation) |
|---|---|---|---|
| R1 | MFP | Reverse requires gate verdicts `upstream-repair` and `terminal-reject`; forward gates emit only accepted/repair_required/human_required | Adopt the plan-frozen gate-result universe {accept, repair, upstream repair, human wait, terminal reject} for both gate commands; upstream-repair creates `obligation:routeUpstreamRepair` (re-typing forward F105). PLAN:EK9-dimensions |
| R2 | MFP | Reverse requires EffectReceipt kinds already-applied / retryable / policy-terminal; forward settleEffect has only success/repair_required/human_required/unknown | Adopt the plan-frozen effect-result universe for workplace.settleEffect. PLAN:EK9-dimensions; PLAN:EK3 (idempotency); PLAN:EK4 (policy terminal) |
| R3 | MFP | `AcceptedCandidateAuthority` has no forward producer command | Commits in the gate-accept transaction of runAuthorGate/runFinalGate — forward F066/F071 already note "authority commit isFinal"; consumed by settleEffect + recordFinalAcceptance. FWD:F066/F071; ADR053:authority; ADR053:conservation |
| R4 | UDW | Forward W7 readiness wait has no reverse node or discharge path | `TypedWait:readiness` enters the universe; wake = predecessor CellFinalAcceptance/EffectReceipt arrival; dead predecessor converts to unreachable settlement. ADR097:decision; FWD:F052/W7; PLAN:durable-handoff |
| R5 | MFP | `ProductVerificationEvidence`/`Failure` required by run proofs; no forward producer | Independent verifier actor through public ingress (no new aggregate); required evidence of TerminalProof:run.success/failure. PLAN:EK12 exit; PLAN:EK11 |
| R6 | MFP | `ContextEnvelopeComplianceEvidence` required by run.success; no producer | Settlement-time predicate over the PromptAssemblyReceipt sequence + role-digest pins — not a new linearization point. PLAN:EK11-kit; PLAN:context-envelope |
| R7 | MFP | `ForwardReverseReconciliationReceipt` required by run.success; no producer | Settlement-time observed-graph comparison command (EK-6/EK-12). PLAN:EK6; PLAN:EK12 |
| R8 | GM | Forward gaps G4/G5 + G9/G10 demonstration parts (documentation 13/23, D2/D7/D8/D10, K4 windows) are demonstration debt, not protocol gaps | Edges lawful-declared in the universe; causal demonstration is a blocking EK-9 corpus obligation under declared-equals-demonstrated. PLAN:EK9 |
| R9 | GM | Forward G6 (prompt/context admission depth) | Already owned elsewhere: EK-1 admission specs + WP-18; the universe carries only the admission boundary. PLAN:EK1 (admission specifications); WP-18 row |
| R10 | GM | Reverse G7 (settlement fan-in membership unfrozen; reverse assumed plural processes per stage) | Membership frozen: workplaces-per-node N (F050/F051), nodes-per-process N per declared flow (F106-F132), **processes-per-stage exactly 1** (F042 binds THE installed module; census stage family), stages-per-lifecycle N per routing. FWD:F042/F050/F051; CENSUS:stage; CENSUS:process |
| R11 | MRC | Forward carry-forward edges (redevelop/continuation/accepted-prefix) absent from reverse | Continuations are ingress-class: accepted prefix binds as InputEvidenceRefs/CapsuleIngressReceipt evidence; the continuation's own proofs close over its own scope. REV:InputEvidenceRefs (note); FWD:F005/F006/F011-F014; FWD:G9 |
| R12 | MRC | Reverse types EffectReceipt:human-wait as external-availability wait; forward types it human-input (F076/F088) | Forward typing adopted (human wait is its own effect result; reverse edge re-typed — derivation slip). FWD:F076/F088; predecessor e70; PLAN:EK9-dimensions |
| R13 | MRC | Forward has two EffectReceipt producers (settleEffect + recordProviderOutcome); census/reverse declare one writer | Single-writer re-typing: workplace.settleEffect is the sole EffectReceipt writer; recordProviderOutcome submits provider outcome evidence into the owning Workplace effect transaction. PLAN:target-model; ADR053:chain; CENSUS:effect; PLAN:one-authority |
| R14 | MRC | Forward `ProcessOutcomeCertificate` (settle transaction) has no reverse node | It IS the TerminalProof:process.success evidence committed by processRun.settle, and the route-lifecycle obligation evidence. FWD:F045/F046; CENSUS:process |
| R15 | MC | Reverse requires CheckPlan as gate evidence; forward scopes CheckPlans out | CheckPlans are InstalledWorkshopManifest content (input `in.manifest`); gates reference them as exact evidence refs. FWD:outOfScope[2]; REV:CheckPlan; PLAN:target-model |
| R16 | MC | Reverse WorkflowEvent co-requisite vs forward per-command emits | Reconcile by convention (no edge duplication): each command's WorkflowEvent is a co-requisite fact of the same transaction. REV:conventions.eventCoRequisite; PLAN:durable-handoff |
| R17 | MC | 27 forward module-flow edges vs no reverse module-flow nodes | Module flows are installed process-module manifest content; the typed protocol edge is `obligation:advanceProcessFlow`. FWD grammar; PLAN:EK8; FWD:outOfScope[2] |
| R18 | MRC | Forward `RecoveryIssue` (repair feedback) unnamed in the reverse repair closure | Enters the evidence registry; consumed by `obligation:requeueRepair` (repair WorkIntent binds exact RecoveryIssue refs). FWD:F067/F075/F078; transition-conformance repair-loop theorem |
| R19 | MFP | Reverse declares distinct TerminalProof:cell.success; forward has only CellFinalAcceptance | Cell success proof commits in the workplace.recordFinalAcceptance transaction ("cell success is exactly the recorded final acceptance"). REV:TerminalProof:cell.success (note); FWD:recordFinalAcceptance; PLAN:target-model |
| R20 | MC | Reverse accepted-gate edges read as requiring reviewer presentations for all gates | Role-conditioned: author gates over CandidateSet:author; final gates over CandidateSet:reviewer (binding its subject author set). REV:GateDecision:accepted notes; FWD:F064/F069 |

### 2.2 Protocol decisions framed for the coordinator (12) — recommended, not silently decided

| id | kind | question (either/or) | recommendation | blocks |
|---|---|---|---|---|
| D1 | GM | Physical vocabulary: adopt this universe's names as frozen (incl. settle = `processRun.settle`) vs named renames | adopt as-is | WP-05, WP-16 |
| D2 | MRC | Effect-level repair: extend effect-result vocabulary with `repair` (7 kinds) vs re-type to gate-level repair only | extend (7 kinds) — F075 git-conflict + repair-loop theorem | effect contracts, EK-9 |
| D3 | MFP | Cancellation shape: proofs at {lifecycle, run} naming member dispositions + new `activityAttempt.cancel` + `TypedWaitDisposition` vs per-scope proofs at all 7 scopes | {lifecycle, run} naming dispositions | EK-4, EK-6 |
| D4 | MFP | Verifier receipt: `lifecycleRun.verifyTerminalClaims` (manifest verifier contracts, LifecycleRun-owned) vs certifier-profile Workplace | LifecycleRun command | lifecycle.success closure, EK-6 |
| D5 | UDW | Wake discharge for external-availability / policy-quota: obligation-completion receipts of the named wake sources vs dedicated external event receipt kinds | obligation-completion receipts | EK-4 |
| D6 | GM | Truthful-failure terminality: repair-epoch ledger exhaustion / scope-refusal receipt (`RepairTerminalityEvidence`) vs gate-emitted terminality fact | repair-epoch ledger + scope-refusal receipt | failure proofs, EK-6 |
| D7 | GM | Unreachable scope set: {cell, workplace, node} (dependency-graph scopes; run.unreachable deleted, TypedRefusalReceipt stays pre-run) vs all 7 scopes | {cell, workplace, node} | settlement vocabulary, EK-6 |
| D8 | ORPH | Run-scope replay-capture sweep owner: certification Workplace (one effect writer) vs FactoryRun settleRunEffect (second writer) | certification Workplace | effect contracts, replay token |
| D9 | GM | Watchdog: `factoryRun.observeWatchdog` aggregate command (durable evidence, observe-only) vs stateless observer (WorkflowEvent evidence only) | factoryRun.observeWatchdog | EK-4 |
| D10 | GM | Discovery-unknown obligations: workItem.planGraph clause (+ `obligation:openUnknownObligation`) vs separate ingress-time command | planGraph clause | planning contract, EK-6 |
| D11 | GM | CellFinalAcceptance fields: embed acceptanceDigest + digest equality vs refs-only | embed digests (authority conservation executable on the fact) | WP-06 schema |
| D12 | UDW | Effect/send-uncertainty resolution: operator disposition command receipt vs automated idempotency-probe receipt vs both | operator disposition now | EK-4, K4 tokens |

Every pending item in `transition-universe.json` (3 commands, 5 obligations, 3
waits, 14 proofs, 15 evidence kinds) is machine-tagged `pendingProtocolDecision: Dxx`
and the validator refuses any tag that does not reference a framed decision.

## 3. Unified counts

| dimension | count | of which pending a decision |
|---|---:|---:|
| owner aggregates | 9 (+4 non-aggregate authorities) | — |
| commands (incl. 1 transport) | 53 | 3 |
| obligation kinds | 49 | 5 |
| TypedWait kinds | 5 | 3 |
| terminal proofs (7 scopes × 4 kinds) | 28 | 14 |
| evidence kinds | 67 | 15 |
| reconciliation entries | **32** | — |
| — resolved with citation | **20** | — |
| — protocol decisions framed | **12** | — |
| silently accepted differences | **0** | — |

Input gap merge: 10 forward + 8 reverse gaps → every gap appears in ≥1 entry above
(G1f→D1, G2f→D8, G3f→D9, G4f→R8, G5f→R8, G6f→R9, G7f→D10, G8f→D1, G9f→R11+R8,
G10f→R8+D12; G1r→D6, G2r→D7, G3r→D5, G4r→D12, G5r→D11, G6r→D3, G7r→R10+D7,
G8r→D4).

## 4. Validation

```
node docs/refactoring/event-kernel/reconciliation/validate-transition-universe.mjs
# VALID transition universe: 53 commands, 49 obligations, 5 waits, 28 proofs,
#   67 evidence kinds; 32 reconciliation entries = 20 resolved-with-citation +
#   12 decisions framed; 0 silently accepted.
```

Checks (V1–V13): structure; id uniqueness; aggregates; two-way obligation
creation/consumption (no orphans); obligation sources/targets resolve to commands
or proofs; wait kinds two-way; proof issuing commands resolve unless explicitly
decision-pending; evidence closures reference only existing kinds/proofs; command
proof refs resolve; pending-decision tags reference framed decisions; every
reconciliation entry is RESOLVED-with-citation or PROTOCOL DECISION (zero silent);
declared counts equal actual.

## 5. Residual risks

- The 12 decisions must be frozen by the coordinator before WP-05; until then the
  40 pending-tagged entities are explicit placeholders, not accepted semantics.
- D7 recommendation deletes 4 reverse-derived unreachable proofs; if the
  coordinator chooses all-7-scopes instead, the in-run trigger set must be
  enumerated (reverse G2 shows the plan text does not provide it).
- R10 freezes 1 process per stage from forward structural evidence (F042) — a
  contrary reading of the plan text would need a coordinator override.
- Demonstration debt (R8) is routed to EK-9; if the corpus cannot demonstrate a
  declared edge, that edge reopens as a protocol difference, not a test skip.
