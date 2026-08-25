# FORWARD-GRAPH — WP-02 Forward Transition Graph of the TARGET Protocol (EK-1)

- **Work package:** WP-02 — derive the forward graph from inputs and commands only.
- **Machine graph:** [`forward-graph.json`](./forward-graph.json)
  (`ek.forward-graph.wp02.draft.v1`).
- **Integration base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df`
  (branch `ek1/wp02-forward-graph`, private worktree).
- **PRIVACY DECLARATION:** this derivation is FORWARD-ONLY. No reverse-graph
  material was constructed, read, or searched. The predecessor's
  `docs/factory-map/REVERSE_GRAPH.md`, `reverse-graph.v1.json`,
  `GRAPH_RECONCILIATION.md` and `graph-reconciliation.v1.json` were NOT opened.
  The predecessor's forward map (`FORWARD_GRAPH.md`, `forward-graph.v1.json`,
  frozen at `586871ad`) is same-lane evidence and was used; ADR-097 itself
  cites it as the static forward topology.

## 1. Derivation method

The graph is derived exclusively from **inputs and commands**, per the plan's
"Planning and idea conservation" law ("a forward graph is derived from idea,
scope, unknowns and commands") and the EK-1 transition/claim specification.

Method, step by step:

1. **Target grammar first.** The node vocabulary was built from the plan's
   Target logical model (the 21 relations) and the architecture laws: node set
   = `(aggregate, command)`; every cross-owner edge must be expressible as the
   durable handoff grammar
   `source fact + WorkflowEvent + one durable obligation per target edge`,
   consumed by `target aggregate command with expected revision and exact
   evidence refs`.
2. **Inputs enumerated.** Five input sources: operator idea, content-addressed
   capsule, typed operator commands, the installed immutable workshop manifest
   (CanonicalRoleContract/PromptBudgetProfile), and the planning facts
   (scope/unknowns/claims/seams) carried by accepted upstream products.
3. **Observed lawful edge universe extracted from predecessor evidence** (the
   current system's demonstrated/declared edge set):
   - `tests/factory-proof/obligation-contracts.mjs` — the normative
     check-provider / post-acceptance-effect / transition-handler / payload
     obligation set (`dev.*`, `discovery.*`, `factory.*`, `frm.submission.*`,
     `effect.*`, `handoff.*`, `docs.*`). The `handoff.*` family
     (close-presentation, run-gate, run-effects, record-final-acceptance,
     route-lifecycle) is the direct predecessor of the target
     TransitionObligation kinds.
   - `tests/factory-proof/factory-coverage-universe.mjs` plus the five
     workshop scenario/resilience packs — the declared universe (204 tokens,
     5 workshops, platform fault edges), including gate outcomes,
     transitions, negative-transitions, recovery, restart, idempotency,
     fence, crash, counterfactual and tool-lifecycle classes.
   - `tests/factory-evidence/conformance-report.json` — demonstrated coverage
     (82 PASS bundles) and the honest pending residue; pending tokens are
     included with declared status, never silently dropped.
   - `tests/factory-contract/transition-conformance-scenarios.mjs` — the
     universal repair-loop theorem (candidate → changes_requested → exact
     feedback → candidate → approved).
   - `tests/factory-e2e/w9-happy-handlers.mjs` — the complete workplace
     node/role inventory across workshops.
   - Predecessor forward execution map (`docs/factory-map/forward-graph.v1.json`,
     68 nodes / 93 edges) — the current system's forward walk (entrypoints →
     lifecycle selection → stage graph → intra-module flows → universal
     production-cell loop → terminals).
4. **Each observed lawful edge was mapped to the TARGET grammar.** Current
   mechanism → target owner/command/event/obligation/wait/proof. Examples:
   - `tasks.status` admission/dependency flips → **readiness predicate** over
     exact predecessor `CellFinalAcceptance`/`EffectReceipt` evidence (no
     `blocked -> todo` command; ADR-097 Decision).
   - Engine dispatch/spawn loop → obligation consumer leasing
     `providerSend`/`submitContribution` obligations; worker spawn is the
     replaceable transport behind `cognition.sendProviderRequest`.
   - Operator unpark (direct Workplace write, ADR-097 finding 6) → typed
     command `workplace.resolveHumanResponse`.
   - W9 role desks (`author`/`reviewer` per node) → `workplace.admitWorkIntent`
     with the immutable WorkIntent pinning the CanonicalRoleContract digest;
     attempts copy it and never re-resolve the manifest.
5. **No reverse reasoning.** TerminalProof and EffectReceipt nodes appear only
   as *forward continuations* of committed source facts (e.g.
   `lifecycleRun.routeOutcome(outcome=released)` → `issueTerminalProof`). No
   edge was added because a terminal "requires" evidence — that is WP-03's
   lane.
6. **Validation:** every edge endpoint resolves to a declared node id; node ids
   unique; JSON parses (scripted check run at generation time).

## 2. Node inventory (56 nodes)

| Aggregate | Nodes | Commands |
|---|---:|---|
| Input | 5 | idea, capsule, operatorCommand, workshopManifest, planningFacts |
| FactoryRun | 7 | bootstrap, importCapsule, start, requestStop, resume, observeWatchdog, recordRunTerminalProof |
| LifecycleRun | 5 | create, createContinuation, routeOutcome, issueTerminalProof, cancel |
| StageRun | 3 | create, activate, recordLocalOutcome |
| ProcessRun | 5 | create, enterNode, recordNodeTerminal, settle, settleFailure |
| NodeRun | 8 | create, materializeCell, recordKernelResult, recordCellAcceptance, recordHumanDecision, recordProviderOutcome, settleUnreachable, fail |
| WorkItem | 1 | planGraph (immutable items + dependency edges + explicit deferrals; readiness afterwards is a predicate, not a command) |
| Workplace | 16 | materialize, admitWorkIntent, recordContribution, sealProductionRevision, presentCandidateSet, runAuthorGate, runFinalGate, enterRepairWait, rolloverRepairEpoch, widenAuthorityScope, enterHumanWait, resolveHumanResponse, settleEffect, recordFinalAcceptance, closePresentation, issueWorkplaceTerminalProof |
| ActivityAttempt | 5 | create, admitProviderRequest, recordProviderRefusal, recordOutcome, classifyWorkerLoss |
| CognitionTransport | 1 | sendProviderRequest (replaceable boundary; not an aggregate owner) |

The ADR-053 material chain (WorkplaceProductionRevision → CandidateSet →
GateDecision → EffectReceipt → CellFinalAcceptance) is owned by the Workplace
reducer (one owner, one linearization point); the material facts each command
appends are tagged `materialFact` on the nodes.

## 3. Edge inventory (132 edges)

Per kind (multi-tagged edges counted once per primary kind):

| Kind | Count | Meaning |
|---|---:|---|
| structural | 87 | run/lifecycle/stage/process spine, cell loop, ingress, routing |
| flow | 27 | intra-module node advances (27 = 23 advance + 4 early-failure/short-circuit branches, flow-qualified) |
| repair | 9 | repair_required loops: requeue, epoch rollover/backoff, scope widening, effect-repair |
| settlement | 31 | edges into processRun.settle / lifecycleRun.issueTerminalProof / factoryRun.recordRunTerminalProof |
| carry-forward | 3 | redevelop, release continuation, development continuation (accepted-prefix) |
| effect | 6 | runEffects/git-integration/accept-products/replay-capture/publication edges |
| fan-out | 4 | implement-work-items (workItems), verify-acceptance (verificationItems), resolve→implement, bind→verify |
| fan-in | 2 | freeze-integrated-candidate (all implement cells), settlement completion policy |
| review | 1 | author gate accepted+review → reviewer desk (pinned exact author set) |
| unreachable | 1 | workplace terminal failure → dependants unreachable + runnable settlement |

Lifecycle outcome routing (the `route-lifecycle` obligation) carries 17 edges:
`go|clarify|reject → solution-formalization`; `formalized →
solution-development`; `verified → delivery-release | runnable-local`;
`released | approval-required | delivery-blocked | development-blocked |
formalization-inconsistent | documented | blocked | failed → terminal proof`.
Discovery routing is deliberately permissive (all three proposal outcomes
forward; idea strength recorded, not gated).

## 4. TypedWaits (8) and TerminalProofs (7)

TypedWaits (each with an exact durable wake source; nothing waits on a dead
source): human gate verdict; delivery approval pending; effect human/stasis;
external substrate availability (bounded in-check retry → typed unknown, never
product-failed); operator stop; repair backoff window; dependency readiness
(fan-in; converts to unreachable settlement on predecessor death); external
send/effect uncertainty (never an automatic duplicate).

TerminalProofs: workplace success `terminal(accepted)`; workplace truthful
failure (retry exhaustion/cap/ceiling/scope-refusal/verdict); lifecycle success
(`runnable-local | released | documented`); lifecycle failure
(`approval-required | delivery-blocked | development-blocked |
formalization-inconsistent | blocked | failed`); cancellation (abandon);
unreachable (dependants of a dead predecessor); final run proof.

## 5. Honest gap list (nothing silently dropped)

Full detail in `forward-graph.json#gaps`; summary:

- **G1** Physical command/event/obligation names are proposals; EK-1 freezes
  them (plan: "physical names are frozen by Phase EK-1").
- **G2** Run-level replay-capture sweep placement (cell-level effect certain;
  run-scope owner not derivable from inputs alone).
- **G3** Watchdog target ownership (proposed `factoryRun.observeWatchdog`
  observe-only; needs EK-1 freeze).
- **G4** Documentation workshop loop declared but only 13/23 demonstrated.
- **G5** Development pending tokens (D2 cap emergence, D7 cross-lifecycle
  stale readiness, D8 terminal accounting unknown/human, D10 continuation/
  replan drain): lawful + unit-proven, not causally demonstrated.
- **G6** Prompt/context admission depth is WP-18/EK-1 admission-spec property;
  only the admission boundary edges are derivable here.
- **G7** The exact command that opens an owned obligation per Discovery
  unknown (currently folded into `workItem.planGraph`).
- **G8** Settle nodes: per-module kernel node (current) vs `processRun.settle`
  (target) — naming freeze only, no semantic gap.
- **G9** Continuation capsule ingress mechanics (engine-CLI today) mapped to
  `lifecycleRun.createContinuation`; D10 still pending demonstration.
- **G10** Effect-uncertainty crash windows (K4 git-effect demonstrated;
  delivery crash-after-effect-before-receipt declared pending).

## 6. Explicitly out of scope (with reason)

Kanban projection build/rebuild (projection-only, never authority);
PromptAssemblyReceipt as a command (evidence appended inside
`admitProviderRequest`); workshop semantic content (no kernel transition kind
originates from a workshop); legacy engine machinery as aggregates (launch
tickets, host loop, dispatch drain, worker spawn, MCP tool protocol — replaced
by the obligation consumer + public ingress); legacy `tasks.status` scheduling,
dependency block/unblock commands and direct Workplace SQL writers (mandatory
DELETE class); dead/declarative-only strata (discovery normalizer/diagnosis
advisor skills, root test compositions); the generic obligation-consumer
redrive loop (a mechanism over all edges, not one typed edge).

## 7. Command coverage check (exit criterion)

Every command named in the target model appears as a node or is explicitly
classified: `admitProviderRequest` → `activityAttempt.admitProviderRequest`;
WorkIntent creation → `workplace.admitWorkIntent`; attempt creation →
`activityAttempt.create`; contribution/production-revision/CandidateSet/gate/
effect/CellFinalAcceptance → the six Workplace material commands; planning →
`workItem.planGraph`; Node/Process/Stage/Lifecycle bounded commands → the
respective aggregates; capsule ingress → `factoryRun.importCapsule`; operator
stop/resume → `factoryRun.requestStop/resume`; EK-7 operator actions (claim,
review, stop, resume, retry, human-response) → `uiCommandBindings` mapping each
action to its typed target command; dependency settlement → readiness
predicate + `nodeRun.settleUnreachable` + settlement fan-in (no mutable
dependency command exists by law).

## 8. Provenance

All source documents, tests and evidence files used are listed in
`forward-graph.json#derivedFrom`. The predecessor conformance corpus and the
frozen predecessor forward map ground every observed edge; the plan and
ADR-097 ground every target-grammar mapping. No WP-03 (reverse) material
exists yet and none was searched.
