# FRF-WP02 — Forward Graph (independent derivation, forward half)

Artifact: `forward-graph.json` — the FORWARD derivation of the installed
Formalization process-transition graph, authored per FRF-WP02 / plan phase
FRF-1 ("Author the forward transition and semantic graph from the exact
Discovery handoff, desk contracts, and public commands only").

- Derived at base `a79cc24d` (the FRF-WP01 baseline of record), branch
  `frf/frf-wp02f`, worktree `D:/Development/saga-mcp-FRF-WP02F`.
- Content digest of the graph body: see `graphDigest` inside the JSON
  (`sha256:` over the canonical — recursively key-sorted, compact — JSON of
  the `graph` value; same rule as the kernel's `domain/digest.ts`).
- Validator: `validate.mjs` (deterministic, self-contained, re-derives
  nothing from production source):
  - `node docs/refactoring/formalization-frf/graphs/forward/validate.mjs`
  - `node --test docs/refactoring/formalization-frf/graphs/forward/validate.mjs`

## Independence statement

The derivation walked, by hand, the plan text (`docs/plans/
FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md` — §Target process graph
and §Desk contracts) and the ACTUAL TypeScript source (`src/workflow-kernel/
workshops/formalization/**` plus `src/workflow-kernel/domain/universe.ts`).
It did NOT copy `baseline/installed-formalization-graph.json` (the WP01
machine capture is a reconciliation TARGET, not an input) and did NOT read
any reverse-graph work (`graphs/reverse/**` is owned by a different agent
and was never opened). Every node, edge, obligation and evidence claim in
the JSON carries its own `file:line` or `plan#section` citation.

## Result summary

- 11 nodes: 6 Production Cells (`define-product-intent`, `model-use-cases`,
  `derive-system-requirements`, `define-acceptance-contract`,
  `reconcile-what`, `define-architecture-contract`), 2 kernel desks
  (`freeze-what-baseline`, `settle-formalization` — both operator-staffed
  manifest data), 3 terminals (`complete-formalized`,
  `complete-inconsistent`, `complete-failed`).
- 18 edges over the closed event vocabulary `domain.{accepted, failed,
  frozen, drift-detected, formalized, inconsistent}` — the plan's expected
  transition universe, declared one-for-one at
  `manifest.ts:139-158`.
- The forward derivation EQUALS the plan's normative target shape (eleven
  nodes / eighteen transitions), which independently corroborates the
  WP01 ledger's D-0 headline from the forward direction.
- The semantic layer is where the real deltas live: findings F-1…F-11
  below (recorded machine-readably in `graph.structuralFindings`).

## Schema (frf.forward-graph.v1)

Top level (key-sorted as written; the whole file is deterministic — no
timestamps anywhere, so the digest is stable):

```text
artifactId    : "frf-wp02-forward-graph"
schemaVersion : "frf.forward-graph.v1"
graphDigest   : "sha256:<hex>" over canonical JSON of `graph`
graph         : the derivation body (below)
```

`graph` body:

```text
baseSha                    : base commit of the derivation (provenance only)
counts                     : { nodes, edges, productionCells, kernelNodes, terminalNodes }
derivation                 : { direction, inputs[], notDerivedFrom[] } — each input is a citation
edgeEventVocabulary       : the closed 6-event vocabulary (sorted)
edges[]                    : one per declared transition, sorted by (from, on):
  citations[]              : >=1 citation proving the edge
  from / on / to           : the transition
  obligationsCreated[]     : obligations the committing kernel command creates (see A-2)
entry                      : "define-product-intent"
nodes{}                    : keyed by node id (canonical order is automatic):
  kind                     : production-cell | kernel | terminal
  label                    : installed display label
  desk?                    : { outputProductKind, checkProviderId, validator,
                             effectId, operatorStaffed } (cells + kernel desks)
  emitsOutcome?            : terminals only (formalized | inconsistent | failed)
  obligationsCreated?      : terminals (the settlement obligations they trigger)
  consumes                 : { acceptedMaterial[], requiredInfo[] } — the
                             accepted-material entries the desk's validator
                             requires (products.ts) + the envelope required-info
                             manifest (envelope.ts:28-39)
  produces                 : { acceptedMaterial[], artifactTypes[], memberIdField?,
                             vocabulary?, exactInputs?, revisionPins?,
                             canonicalDigestField?, handoffFields?, sections?, chain? }
  evidenceKinds[]          : the desk's own evidence kinds (CheckPlan,
                             ProductVerificationEvidence)
  sharedEvidenceKinds      : true — the desk also produces every kind in
                             sharedDeskPath.deskEvidenceKinds
  semanticFences[]         : { rule, refusal, citations[] } — the desk
                             contract's typed refusal points
  citations[]              : >=1 citation proving the node
postFlowSettlementLadder   : the process/stage/lifecycle/run commands the
                             driver runs AFTER the flow graph terminates
                             (graph-external epilogue, not flow nodes)
preFlowShellDesk           : the import-discovery-handoff shell desk
                             (stage 1) — a NINTH desk outside the 11-node
                             graph; the accepted capsule IS its material
primaryPath[]              : the plan's primary path; a real walk over
                             declared edges ending at a terminal
sharedDeskPath             : the FULL public command path every desk runs
                             (commands[] with createsObligations per
                             universe.ts), deskEvidenceKinds[],
                             repairEvidenceKinds[], verdictOfReason{}
structuralFindings[]       : F-1..F-11 (each with citations)
terminals[]                : the three terminal ids
vocabularies               : closed sets referenced by the checks above
```

Citation grammar (validated by V10):

- `path/to/file.ts:START-END` or `path/to/file.ts:LINE` — the file must
  exist in the repo and have at least END lines;
- `path/to/file.md#Section>Subsection` — the file must exist and every
  `>`-separated segment must appear as a markdown heading.

## Ambiguities resolved (derivation decisions)

| # | Ambiguity | Resolution |
|---|---|---|
| A-1 | Node listing order | The JSON lists nodes id-sorted (canonical determinism); the plan's authored order is preserved separately in `primaryPath`. |
| A-2 | "obligations each transition creates" | Flow edges are installed-manifest DATA, not commands; the committing kernel command is `processRun.recordNodeTerminal` (success-class, universe.ts:530-537 -> the advance trio) or the failure-settlement pair `nodeRun.fail`/`processRun.settleFailure` (universe.ts:546-617). The formalized->terminal edge additionally carries `obligation:recordStageOutcome` (`processRun.settle`, universe.ts:538-545). Each edge cites the command descriptor it derives from. |
| A-3 | Failure-edge semantics | No driver step traverses `domain.failed`/`drift-detected`/`inconsistent` edges (refusals stop the run as `blockedAt`, driver.ts:730-740; DRIFT_DETECTED routes to a typed human-input wait, gates.ts:120 + driver.ts:848-876). The graph records the lawful kernel mechanics that reach those terminals, and flags the demonstration gap as finding F-4 (the plan's "declared equals demonstrated" test layer owes the demonstrations). |
| A-4 | Edge normativity source | Every edge cites BOTH the plan's §"Expected transition universe" (normative) and the installed `manifest.ts` line (declared). Where the two disagree the citations would expose it; they do not (all 18 agree). |
| A-5 | Scope of "commands each node consumes" | All eight desks run the SAME public command path (driver.ts staffs cells and kernel desks identically), so the path is recorded once in `sharedDeskPath` and every desk references it via `sharedEvidenceKinds: true`; per-node specificity lives in `desk` (provider/validator/effect), `consumes`, `produces` and `semanticFences`. |
| A-6 | Evidence kinds per desk | Node-level `evidenceKinds` lists the desk-specific kinds (CheckPlan — one per declared provider, gates.ts:184-198; ProductVerificationEvidence — gates.ts:200-212); the shared per-desk set (CandidateSet:author/:reviewer, WorkplaceProductionRevision, ActivityAttemptContribution, GateDecision:accepted, CellFinalAcceptance, EffectReceipt:success/already-applied, TerminalProof kinds, …) is recorded once in `sharedDeskPath.deskEvidenceKinds`, with the repair/wait variants in `repairEvidenceKinds`. |
| A-7 | The shell desk and the settlement ladder | `import-discovery-handoff` (driver.ts:747-769) and the post-flow lifecycle ladder (driver.ts:828-836) are REAL driver behavior but are NOT flow-graph nodes; they are recorded as `preFlowShellDesk` / `postFlowSettlementLadder` context so the graph keeps the normative 11-node shape without hiding the mechanics. |
| A-8 | One derived expectation, clearly marked | The settle-formalization fence "handoff bindings must resolve against accepted id sets" is NOT installed (products.ts:768-791 never checks it); the fence entry is kept but its rule text is prefixed `DERIVED EXPECTATION (not installed)` with finding F-6 as the honest source-grounded record. |

## Structural findings vs source (F-1..F-11)

Machine-readable in `graph.structuralFindings`; summary:

- F-1 plan's 8 PRD intent categories = 7 member kinds + separate
  dispositions array (products.ts:119-137).
- F-2 the reconciliation fold HARDCODES verdict `consistent`
  (contribution.ts:99-100) — an accepted `gaps` report still folds as
  consistent; the baseline consumes only the revision digest.
- F-3 the driver walks desks in authored node-array order
  (driver.ts:781), not by traversing the edge table; edges are data +
  fail-closed `edgeTarget` lookup (manifest.ts:184-189).
- F-4 failure-class edges are declared but not traversed by any driver
  step (stops at `blockedAt`); demonstrating all 18 is owed by the
  plan's declared==demonstrated layer.
- F-5 the solution contract has NO AcceptedMaterial fold
  (contribution.ts:82-107 default no-op) — settlement is the chain
  terminator; its product exits only via the Development handoff.
- F-6 `validateSolutionContract` is binding-blind: foreign handoff
  bindings validate ok (observed directly in source).
- F-7 no consumer of `solutionContract`/`developmentHandoff` exists
  outside the formalization package (source-wide search).
- F-8 plan's §freeze-what-baseline enumerates dispositions and
  evidence-method bindings as distinct baseline sections; installed
  folds them into `memberDigests` + `acceptedTraceDigest` (which carries
  the capsule ref, driver.ts:484).
- F-9 the driver runs NINE desks: the shell import desk + the eight flow
  desks; the shell is outside the 11-node graph.
- F-10 kernel desks are operator-staffed by manifest data only; the
  driver staffs them identically to cells through the same
  author/reviewer launch kinds (manifest.ts:55-66, driver.ts:498-502).
- F-11 lifecycle terminal-claim verification is a post-flow ladder, not
  a graph node — the flow graph terminates before the lifecycle
  handoff.

## Residuals

- The artifact intentionally does NOT encode the plan's semantic TRACE
  grammar (§"Target semantic trace grammar") beyond the fences each
  validator installs — that grammar is FRF-1's separately frozen
  specification; the forward graph records its enforcement points per
  desk (`semanticFences`) with citations.
- V9's obligation classes (advance trio / failure pair) are the
  artifact's own internal model of the kernel mechanics; if the
  coordinator's reconciliation prefers per-command tables only, the
  `sharedDeskPath.commands[].createsObligations` entries are the raw
  cited data.
- Cross-checking this derivation against the installed manifest capture
  and the reverse graph is the COORDINATOR's reconciliation step
  (FRF-1); this package deliberately does not perform it.
