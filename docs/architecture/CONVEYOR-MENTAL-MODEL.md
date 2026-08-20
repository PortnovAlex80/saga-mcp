# Conveyor Mental Model — Saga4 (Version 5.3)

This document is the architectural compass for the Saga conveyor. It is the
plain-language interpretation of the formal CGAD invariants and must be used to
review runtime, persistence, module, testing, replay, recovery and delivery
changes.

Current implementation-vs-model state after the antifreeze series and
ADR-074/075: see the dated section «Статус конформности (2026-08-16)» at the
end of this document. The model below remains normative and unchanged.

The governing rule is:

> **one production interface, one material, one desk, one factory runtime**

A workshop is a declarative arrangement of Production Cells. It is not a
private engine, queue, state machine, product store, submit protocol, testing
runtime or recovery runtime.

---

## 1. One production interface

Saga does not fundamentally care whether a worker is backed by GLM, Claude,
Qwen, LM Studio or deterministic replay.

The factory sees one contract:

```text
WorkerExecution
  -> receives one immutable execution context
  -> reads exact authorized inputs
  -> produces text / canonical JSON / TextSet / patch products
  -> submits through the normal worker protocol
  -> seals one immutable CandidateSet
```

The physical worker implementation is replaceable. Production physics are not.

The material crossing the worker boundary is text or content-addressed textual
material. Proposal, PRD, SRS, source code, reviewer verdict and verification
report differ by schema, not by runtime mechanism.

External state changes are different. Compilation, tests, Git integration,
publish and deploy are performed by deterministic kernel/provider capabilities.
A worker may describe desired state, but text does not grant effect or
transition authority.

---

## 2. One logical desk

All workers use one Workplace-scoped production surface:

```text
product_read(exact ProductRef)
product_submit(schemaRef, content)
execution_complete(...)
```

`ProductRef` is exact product identity. Consumers use exact refs/digests or
accepted output bindings, never “latest worker output”.

Schema determines product meaning. It must not select another persistence,
submit or lifecycle mechanism.

---

## 3. LEGO principle

Workshop packages declare WHAT:

- Flow / Production Cells;
- skills and execution profiles;
- product contracts;
- CheckPlans;
- decision/recovery policy;
- optional effects.

Factory runtime owns HOW:

- dispatch and concurrency;
- worker selection and launch;
- Workplace and desk identity;
- fencing/supervision;
- product persistence;
- CandidateSet sealing;
- GateRun/GateDecision;
- review;
- replay lookup;
- recovery;
- lifecycle progression.

Adding a normal workshop must not add another dispatcher, worker runner,
lifecycle engine, submit/read protocol or acceptance state machine.

The first and the thousandth workshop use the same transition grammar,
diagnostic evidence and runtime authorities; only declarative package content
changes.

Core runtime must not branch on workshop name or worker profession.

---

## 4. Production Cell is the universal worker-quality loop

```text
exact semantic inputs
  -> fenced author WorkerExecution
  -> author CandidateSet
  -> author GateRun
       | accepted(final) -> final acceptance
       | accepted(author) -> reviewer
       | repair_required -> repair_wait
       | human_required -> paused
       | failed -> terminal(failed)

optional reviewer
  -> reviewer WorkerExecution pinned to exact author CandidateSet
  -> reviewer CandidateSet
  -> final GateRun
       | accepted -> final acceptance
       | repair_required -> author/reviewer repair
       | human_required -> paused
       | failed -> terminal(failed)
```

WorkerExecution, reviewer execution and GateRun are attempts inside the cell,
not hidden Flow nodes.

A cell definition may materialize many Workplaces. Stable instance identity is:

```text
WorkplaceRef {
  processRunId
  moduleRef
  productionCellId
  workKey
}
```

`workKey` is semantic/stable inside the run and never contains worker-attempt
identity.

---

## 5. CandidateSet is the QC handoff

Worker completion seals exact products:

```text
CandidateSet {
  candidateSetRef
  workplaceRef
  productionRevisionRef
  role                    // author | reviewer
  subjectCandidateSetRef? // reviewer only
  members[] { productRef, origin, sourceCandidateSetRef? }
  candidateSetDigest
  sealedAt
}
```

An execution contribution means only:

> this execution stopped and left material on the Workplace desk.

It does not mean acceptance.

CandidateSet authority identity never includes execution provenance. Its key
and digest bind the immutable Workplace production revision (plus role and the
exact author subject for a review). Presenter/contributor executions live only
in the revision audit envelope.

> **⚠️ Architectural diagnosis (ADR-053):** Run 011 stabilization chain
> proved that treating an execution ref as material authority (rather
> than provenance) is a systemic defect. When material is produced across
> multiple executions (recovery, carry-forward, repair), a post-acceptance
> effect that reads only the latest execution loses parts of the accepted
> desk. The fix is an explicit immutable
> **`WorkplaceProductionRevision`** between the mutable desk and the
> CandidateSet; execution becomes provenance only. The clean-break cutover is
> the normative runtime model below.
> See
> [ADR-053: Accepted material is a sealed Workplace production revision](decisions/053-workplace-production-revision-as-accepted-material-authority.md)
> — **обязательно прочитать перед следующим Factory-стабилизационным
> коммитом или real-model прогоном.**

---

## 6. GateDecision and CellFinalAcceptance

GateRun emits one append-only GateDecision over exact CandidateSets.

These are distinct facts:

```text
check/gate computation says accepted
!=
GateDecision is persisted
!=
GateDecision is applied to expected Workplace revision
!=
required acceptance EffectReceipt is persisted
!=
Workplace reaches terminal(accepted)
```

The effect line applies only when the Cell declares an authoritative effect as
part of producing its accepted output. A GateDecision may therefore leave the
Workplace in `effect_pending`; it must not make effectful work terminal merely
so that the adapter can run afterward. Only the last condition is cell-final
acceptance.

Code should expose one typed proof/value, conceptually:

```text
CellFinalAcceptance {
  workplaceRef
  finalGateDecisionRef
  subjectCandidateSetRef
  assessmentCandidateSetRefs[]
  requiredEffectReceiptRefs[]
}
```

It is constructible only after proving:

```text
final GateDecision.verdict = accepted
AND decision applied to expected Workplace revision
AND every declared required acceptance effect has a successful exact receipt
AND Workplace.loopState = terminal
AND Workplace.terminalReason = accepted
```

Replay certification consumes `CellFinalAcceptance`, not a raw `accepted`
verdict. Required effects run before final acceptance; replay archive capture
runs after final acceptance and never substitutes for an effect receipt.

---

## 7. Project, Factory Start, Resume and Continuation are different identities

### Project

Project is stable product scope and the normal replay namespace.

### New Factory Start

An intentional new Factory Start creates a **new run identity** for the same
Project and starts lifecycle progression from the beginning using current code.

```text
Project P
  -> Factory Run A
  -> Factory Run B
  -> Factory Run C
```

The new run gets new ProcessRun/LifecycleRun/Workplace/WorkerExecution identities
but may reuse semantically compatible capsules belonging to Project P.

### Resume

Resume continues the same interrupted run and its existing Workplaces. It does
not intentionally re-run completed cells from the beginning.

Resume rehydrates the exact persisted package/check-plan snapshots required by
every nonterminal Workplace. It must not silently replace them with whichever
package version happens to be installed now. Missing or incompatible pinned
packages fail closed and surface an explicit recovery action.

### Continuation from an accepted prefix

A terminal failed LifecycleRun, StageRun or ProcessRun is never changed back to
running. When recovery must restart a whole downstream workshop, Factory creates
an append-only continuation in the same business-order lineage. It starts from
an exact accepted stage-prefix certificate and creates new lifecycle/stage/
process identities only for the remaining route.

```text
parent run: Discovery ✓ -> Formalization ✓ -> Development ✗
                                      |
                                      +-> continuation: Development -> Delivery
```

Inherited stages are not executed and are not represented as newly completed
StageRuns. Their product refs, certificate refs, handoff hashes and definition/
input hashes form an immutable prefix authorization. The order projection shows
the failed parent and active continuation together and derives state from one
active leaf; it never hides the parent failure or silently repoints authority.

The child definition carries immutable inherited-stage descriptors. They are
legal `$.stages.<id>` mapping sources and pipeline labels, but never executable
stages or route targets. Runtime values for those descriptors come only from a
hash-verified continuation repository, never from caller-supplied lifecycle
input. A pinned resume also preserves the original invocation actor and other
idempotency context; it must not invent a new `initiatedBy` value.

`FactoryOrder.lifecycle_run_id` remains the immutable root pointer. Operational
state follows the one active leaf in the append-only OrderRunChain; launching a
child must not repoint the root FK and hide its failed parent.

Partially valid downstream production crosses this boundary only through a new
adoption decision. Old CandidateSets and GateDecisions remain evidence, not
current authority. Changed Git bases require fresh candidates, review and gates.

```text
new start = new run identity, same project
resume    = same run identity
continuation = new linked run identity, same business order, accepted prefix
```

Persistence must not collapse Project identity into “one lifetime Factory Run”.
A legacy schema that permits only one order/lifecycle per Project is a migration
constraint, not Saga4 architecture.

Idempotency deduplicates the **same start command**. It must not prohibit a later
intentional new start of the same Project with the same source bytes.

---

## 8. Replay-first is normal execution

There is no production mode, mock mode, hybrid mode or replay mode.

Every worker assignment follows one algorithm:

```text
materialize Workplace
  -> claim + fence WorkerExecution
  -> freeze replay semantic identity
  -> resolve capsule eligibility
       | HIT  -> deterministic replay worker
       | MISS -> normally selected model
  -> same MCP/product surface
  -> NEW CandidateSet
  -> CURRENT GateRun
  -> CURRENT GateDecision
  -> CURRENT Workplace/lifecycle transition
```

Replay substitutes only worker production.

Replay never restores:

- CandidateSet from another run as current QC state;
- GateDecision;
- Workplace state;
- task/Kanban status;
- lifecycle cursor;
- settlement/certificate;
- external-effect completion.

Current factory code always performs those steps again.

---

## 9. Replay identity must be semantic and cross-run stable

This is a critical invariant.

A replay key identifies **the semantic worker invocation**, not its current
runtime envelope.

Conceptually:

```text
ReplayKeyMaterial {
  projectId
  moduleRef
  nodeId
  productionCellId
  workKey
  role
  packageContractDigest
  semanticInputDigest
  subjectProductionDigest? // reviewer
  repositoryBaseDigest?    // when not already inside semanticInputDigest
}
```

### `semanticInputDigest`

`semanticInputDigest` is computed from the information that may materially
change worker output, for example:

- exact input product schema + content digest;
- stable business/initiative values;
- stable fan-out item identity/content;
- exact RecoveryIssue semantic content when relevant;
- immutable external observation products;
- repository base commit/tree for code-changing work.

It MUST exclude runtime/provenance identities that naturally differ between
Factory Runs:

- ProcessRun/LifecycleRun ids;
- WorkplaceRef;
- WorkerExecution id;
- task/intent row ids;
- CandidateSetRef;
- presenter/contributor execution refs;
- timestamps;
- transient filesystem paths.

A raw `nodeInputHash` may remain useful for current-run authority/audit, but it
must not be used as ReplayKey input unless its canonicalization is explicitly
proven to exclude all run-specific envelope fields.

### Production manifests must separate semantics from provenance

A Production Cell output manifest may contain both:

```text
semantic products/digests
AND
current-run provenance refs
```

Its audit `contentHash` is not automatically a replay semantic digest.
Downstream replay identity must derive from accepted product content, not from a
manifest hash that includes Workplace/CandidateSet/execution/task identities.

---

## 10. Reviewer replay uses semantic author production identity

Reviewer execution is authoritatively pinned to the **exact current-run author
CandidateSetRef**. That remains required for QC.

But cross-run replay identity cannot use a current-run CandidateSet digest,
because that digest intentionally includes WorkplaceRef.

Reviewer ReplayKey therefore uses a semantic digest such as:

```text
subjectProductionDigest = hash(
  ordered/multiset of accepted author product { schemaId, contentDigest }
  + contract-relevant semantic metadata
)
```

Do not use current-run CandidateSetRef or run-scoped CandidateSet digest as the
cross-run reviewer replay key.

This preserves both requirements:

```text
QC authority       -> exact current CandidateSetRef
Replay equivalence -> stable semantic author-production digest
```

---

## 11. Closed-world replay input rule

Replay safety depends on a closed input surface, not on hashing alone.

A replayable WorkerExecution may consume only:

1. exact ProductRefs in its frozen read set;
2. exact Workplace/CandidateSet/RecoveryIssue material authorized for the
   attempt;
3. external observations first materialized as immutable content-addressed
   input products.

An unpinned live read from web/search/API/mutable DB/filesystem makes the
invocation non-replayable unless that observation is first captured into the
semantic input set.

---

## 12. ReplayCapsule is certified worker production

```text
ReplayCapsule {
  replayKey
  keyMaterial
  sourceCandidateSetRef   // audit provenance
  sourceExecutionRef      // audit provenance
  payloadHash
  typedProducts[]
  artifacts[]
  traces[]
  gitRecipe?
}
```

Old DB ids are never replay authority.

Artifacts/traces use semantic selectors or replay-local mappings. Git recipe
pins exact repository base and verifies resulting tree.

### Certification

Only `CellFinalAcceptance` can certify reusable capsules.

No-review cell:

```text
final accepted decision -> exact author CandidateSet -> author capsule
```

Reviewed cell:

```text
final accepted decision
  -> exact subject author CandidateSet
  -> exact assessment reviewer CandidateSet(s)
  -> author + reviewer capsules
```

Never scan every historical CandidateSet of a terminal Workplace. Rejected
repair/reviewer attempts remain durable audit history but are not certified.

### Direct capture and lazy reconstruction

Normal path:

```text
CellFinalAcceptance -> capture capsule(s)
```

Crash fallback:

```text
durable final acceptance exists
capsule archive missing
  -> later certification sweep reconstructs it
```

Direct capture is normal. Lazy reconstruction is recovery for missed archive
materialization. No second capture state machine is needed.

---

## 13. Replay worker is ordinary at the production boundary

Hit and miss use the same WorkerExecution protocol, authority, Product Desk,
RepositoryDesk, completion command, CandidateSet and current gates.

Replay worker cannot mutate Workplace, create GateDecision, advance lifecycle or
expand tool authority.

Provenance must remain truthful:

```text
inference execution -> real provider/model provenance
replay execution    -> deterministic executor + exact capsule ref
```

Replay does not rewrite project/workshop model settings.

---

## 14. Model selection remains orthogonal

Normal model inheritance remains operational/cost policy:

```text
factory default
  -> workshop default
  -> cell/role override
  -> frontend/run selection
```

Replay key deliberately excludes model identity. Capsule proves accepted
production for semantic inputs, not allegiance to a model vendor/version.

A future explicit “Regenerate” command may bypass replay for one invocation. It
is not another runtime mode.

---

## 15. Rejected replay cannot loop forever

If current QC rejects replayed production, the same capsule must not be selected
again for the next recovery attempt of that Workplace.

Forbidden:

```text
capsule C -> replay -> reject
repair -> capsule C -> replay -> reject
...
```

Eligibility is derived from durable existing evidence:

```text
WorkerExecution.replay.capsuleRef
  -> produced CandidateSet
  -> rejecting GateDecision / RecoveryIssue
  -> WorkplaceRef
```

The next recovery WorkerExecution treats that capsule as ineligible and normally
falls through to the selected model.

A corrupt capsule hit also fails closed. It does not silently call a paid model
inside the same execution. Recovery creates a new execution and resolves again.

### Cycle is not spinning (reading repair iterations)

A repair iteration is WORK, not failure. The author → gate → repair arc exists
to eliminate a defect chain: each iteration must consume the previous rejection
and remove a DIFFERENT link of that chain. Revision growth measures work
performed; iteration count alone is never an alarm and must never be taxed
against a panic budget — that would punish the convergence mechanism the
conveyor exists to perform.

Spinning is defined by REASON IDENTITY, not by count or duration:

- the same rejection cause returns after the material changed (the fix
  touched a symptom, not the cause);
- the material changes only cosmetically while the worker repeats the same
  actions (feedback not consumed);
- the gate rejects on a criterion the submission satisfies (unfalsifiable or
  contradictory gate — a factory defect, not an author defect).

Consequences:

- abort rules key on identical-error repetition ("the same node failing three
  times with the same error"), never on iteration number;
- budgets (review budget, recovery `totalAttempts`) are escape valves for TRUE
  spinning, not a tax on convergence;
- operator views must not render iteration count as a warning by itself; the
  reason sequence is the signal (distinct reasons converging = healthy cycle,
  same reason recurring = spin).

### Budget must count spin, not work (separation mechanism)

Today the factory does NOT distinguish: the review budget counts rounds
(`managed_review_rejections` + historical `changes_requested` receipts,
dispatcher worker_done branch) and recovery epochs count attempts
(`totalAttempts`, ADR-075) — both are reason-blind. The reason IS persisted
(`managed_review_last_feedback`, gate `recovery_issue_ref`) but never
compared. To make budgets charge spin only:

1. each rejection records a `reason_key`: a TYPED reason code (check id +
   violation class, the fail-closed vocabulary style) over the affected
   targets, excluding volatile parts (timestamps, run digests, execution
   ids). Prose feedback stays for humans/models; the key is the identity.
2. the card carries an append-only reason chain (a table — not task
   metadata, which already bloats);
3. the panic budget (review budget) decrements ONLY when the new key already
   appears in the chain (reason repetition = spin). A new key = another link
   of the defect chain removed = work, charged to a separate, generous chain
   cap;
4. the hard cap stays absolute — even converging chains must terminate;
5. caveat: a rephrased prose reason can pass as a false "new" key. Typed
   reason codes at the gate are the robust form; string identity is only the
   minimal start;
6. operator projection renders the reason chain (converging vs repeating) —
   never the bare iteration count.

---

## 16. Test projects and production projects use the same runtime

Factory must not branch on project name, `isTest`, mock mode or hybrid mode.

### Fixture/conformance project

A service test project may be seeded with certified fixture capsules and then
invoke normal Factory Start. The test asserts current CandidateSets, gates,
transitions and terminal outcome.

### Canonical two-pass integration proof

```text
Run A — same Project, no capsules
  -> selected model workers
  -> current gates
  -> final accepted cells
  -> capsules captured

Run B — intentional NEW Factory Start for same Project
  -> new run/workplace/execution identities
  -> same semantic replay keys
  -> capsule hits
  -> NEW CandidateSets
  -> CURRENT gates/lifecycle execute again
```

The persistence model must support this directly.

A canonical E2E must NOT:

- copy capsules between two databases;
- change Project id to manufacture a hit;
- reset lifecycle/process/workplace tables;
- route every stage to a simulator;
- implement a private lifecycle harness.

Those techniques can test serialization/adapters, but they do not prove the
accepted replay-first factory architecture.

---

## 17. Recovery and checkpoint remain separate semantics

Recovery brings a new WorkerExecution to the same Workplace/desk with exact
RecoveryIssue/rejected products. Replay may satisfy it only if an eligible
capsule exists.

Checkpoint restores operational state of the same interrupted run.

Replay reconstructs certified worker production while running current factory
transitions again.

```text
Recovery   = repair same Workplace
Checkpoint = restore same run machine state
Replay     = reuse semantic worker production across compatible invocations
```

An infrastructure/control-plane failure after CandidateSet sealing does not
invalidate or re-run worker production. Recovery may replay inspection against
the exact sealed CandidateSet only when immutable authorization proves its
lineage, content hashes, producer fence, unfinished GateDecision state and a
compatible passed-receipt prefix. The failed GateRun remains append-only audit
evidence; the replacement CheckPlan creates a new GateRun identity. Provider
versions are exact contract identities—legacy aliases must not be invented to
make an incompatible plan appear valid.

### Cross-terminal partial production is explicit carry-forward

A terminal child can fail after the author produced and passed its author gate
but before reviewer/final/effect authority exists. That product is not a
ReplayCapsule and its old CandidateSet is never current in another run. If the
failure is an exactly classified downstream infrastructure/contract failure,
an immutable single-use authorization may present the exact member into a new
child:

```text
old author CandidateSet + accepted author gate + exact failure boundary
  -> immutable carry-forward authorization
  -> NEW child author CandidateSet(origin=carried-forward, sourceSetRef=old)
  -> CURRENT author gate
  -> NEW reviewer CandidateSet
  -> CURRENT final gate/effects/CellFinalAcceptance
```

The same grammar has a second, stricter failure boundary: a cell may already
have a final accepted GateDecision, successful EffectReceipt and
CellFinalAcceptance while its enclosing node fails to project the output
manifest. Recovery may carry that exact material only if all three authorities
bind the same CandidateSet, the external desired state is still observed, and
the new effect settles as `already-applied`. It still creates current gates;
it never copies the old decision as the child's decision.

Eligibility binds the source ProductRef/digest, source-set/gate digests,
WorkIntent output schema, stable semantic item, repository/base/source
commit/tree/ref and unchanged external baseline. Any later reviewer set, final
decision or final acceptance makes the *pre-review* rule inapplicable; only the
separately classified post-effect projection rule above may consume fully
accepted material. A semantic author/reviewer rejection is never carryable. If
compatibility is not exact, hire a new author.

The child `semantic_input_digest` may legitimately differ because its
continuation/adoption provenance is new. Carry compatibility therefore uses an
explicit stable material contract (item + output schema + verified prefix/base),
not equality of run-envelope identity and not an informal module-name rule.

Submission validation is fail-fast at `product_submit` and again at
`worker_done`: the exact frozen WorkIntent output schema/cardinality must be
satisfied. A wrong immutable schema must remain rejection evidence; it must
not become a CandidateSet merely because the worker declared completion.

A schema identifier is not a runtime type proof. Every authoritative typed
product contract must have an executable, versioned payload validator. Its
canonical contract definition digest is frozen in the WorkIntent together
with the package installation identity; an ambient process registry is only a
lookup mechanism and must fail closed when that durable pin is absent or
different. The same validator governs inference, replay and repair before
immutable storage; the current Gate independently revalidates the sealed
ProductRef against its WorkIntent and exact upstream lineage. A check provider
that returns `passed` without reading the CandidateSet is a placeholder, not
QC authority.

One WorkIntent that permits exactly one output cannot require that output to
contain a ProductRef to a second product the worker has no authority to create.
The outer immutable ProductRef is itself a lawful evidence reference. Nested
evidence references are allowed only when a declared tool/provider creates and
returns them before submission.

Worker JSON and mutable task metadata never establish provider trust. The
authoritative outcome comes from an immutable CheckReceipt issued by the exact
installed provider and bound to the GateRun, subject CandidateSet, method plan,
environment and evidence refs. LM production may explain or assess those
receipts but cannot create their trust or verdict. Verification must preserve
the four-valued outcome (`passed|failed|unknown|error`): missing execution
capability or a required environment produces `unknown`, not a model-authored
deterministic pass. `unknown/error` caused by missing provider authority stops
the line without consuming worker repair budget. Verification methods required
by accepted criteria must survive Formalization -> Development mapping and be
backed by declared executable check capabilities before the plan is admitted.
Compound methods are `allOf` obligations unless the accepted contract carries
an explicit substitution policy. A sandbox/browser receipt cannot silently
replace visual, keyboard or screen-reader observation. Those methods require a
separate `authorized_decision` receipt bound to the same candidate, method-plan
digest and criterion. Absence is an honest `human_required` boundary.

When production and integration are already finally accepted but verification
authority fails, an append-only verification continuation may adopt the exact
task graph, implementation workset and integrated candidate as a read-only
subject. Adoption proves identity and lineage only; it grants no verification
verdict. The suffix contains no planner, implementation, review, candidate
freeze or integration effect. It creates current verification Workplaces,
CheckReceipts, settlement and certificate, then routes through ordinary
Delivery. Historical verifier products and GateDecisions remain ineligible.

`CandidateSet` has no execution-owner field. Its identity and digest bind the
exact `WorkplaceProductionRevision`; ProductRef row aliases and presentation
origin remain provenance only. A normal worker presenter has a resolvable
WorkerExecution receipt; a kernel carry-forward presenter does not and must not
be represented by a fabricated worker. Replay may retain presenter/contributor
refs only in its audit recipe and never use them as accepted material identity.

---

## 18. RepositoryDesk is factory-owned

Factory provisions worktree/branch/base before code worker launch.

For a planned dependency graph, materialization resolves every semantic entry
in `dependsOnKeys` to an exact task/Workplace edge. Unknown, missing or duplicate
edges fail the projection; an empty dependency table must never be accepted as
the projection of a non-empty graph.

Fan-out uses four ordered phases:

```text
1. materialize the complete sealed Workplace set in idle
2. project every stable workKey -> task/Workplace identity
3. validate and persist the complete dependency DAG atomically
4. admit roots only; admit dependents after their durable prerequisites settle
```

Fan-out is optional topology, not a utilization target. The planning Cell must
explain why each split is independently reviewable/recoverable and safe to
author from its declared base. Prompt guidance supplies semantic judgement but
is not topology authority: a deterministic graph-fitness provider validates
width, closure, scope overlap and integration-boundary cost, while an
adversarial reviewer challenges fictional independence and impossible scopes.
A small same-repository width-one graph with heavy overlap should normally be
one coherent production item. Independent disjoint antichain items may author
in parallel; their canonical effects are still serialized per repository and
target.

Admission must not happen inside per-item materialization. Dependency binding
must not be computed from “currently queued” cards, because running/terminal
predecessors disappear from that transient view. Reconciliation compares the
stored sealed graph with the expected graph; it never delete-replaces durable
edges with a reduced set inferred from current Kanban states.

A dependent Git Workplace is not claimable until every dependency has final QC
acceptance and successful integration. Its desk base is the resulting
post-dependency integration commit, and submission verifies that lineage. A
worker assertion that dependencies are “satisfied” is never authority.

Declared repository change scopes are strict write authority, not scheduling
hints. Before reviewer admission, a deterministic Gate derives the actual Git
diff from the Factory-issued effective base to the submitted source commit,
requires the submitted file manifest to match it exactly, and proves every
changed path is within the frozen scopes. Directory scopes contain descendant
files; this same containment relation defines scope overlap for graph ordering.
Planner prompts may help choose conservative scopes, but reviewer prose cannot
authorize an undeclared file and runtime never widens a scope implicitly.

Reviewer desks and required effects resolve the exact current author
CandidateSet member. They never search for a task-local “latest submission”:
carried-forward material can lawfully originate in another process, while its
current QC/effect authority belongs to the new set. A managed candidate ref may
be a full provider ref such as `refs/saga/candidates/...`; adapters must not
silently reinterpret it as `refs/heads/...`.

`DevelopmentCase.expectedBaseCommit` is the stage lineage anchor, not the
execution base of every fan-out item. Root work may use it directly. For a
dependent item, Factory persists an **effective desk-base receipt** only after
all dependency integrations complete. The receipt pins dependency integration
commits, observed target-branch head, repository binding and Workplace/task
identity. Worktree creation CAS-checks that head; drift fails before worker
launch. The effective base is frozen into execution context and Git ReplayKey.

Model/replay worker does not invent or switch arbitrary worktrees.

Repository integration computes its candidate merge from immutable Git objects,
not from bytes in a shared checkout. It advances the target ref with an exact
before-head compare-and-swap. Untracked checkout files cannot enter or block the
merge; dirty tracked state fails closed, and a coherent checkout is synchronized
only after the ref transition succeeds.

The ability to invoke a Git command is not Git authority. A linked worktree
shares refs and is not a security boundary. Worker production must be confined
to a provider-managed textual candidate or a genuinely isolated staging
environment. Only a fenced Factory effect may create/update canonical refs,
merge, push or issue an integration receipt. A normal dependency wait remains
non-admitted readiness; an accepted candidate waiting for its effect is
`effect_pending`/`awaiting_integration`. Neither is a human `blocked` state.

Tool policy must be physically enforced by the runner. A prompt, skill,
`allowedTools` declaration or MCP authority check is not sufficient when the
host also enables a permission-bypass mode. For a pinned execution profile the
runner auto-allows exactly the declared tools, explicitly denies every known
undeclared native tool, and uses unattended fail-closed permissions. A managed
text worker has no Bash/Edit/Write/Git mutation surface. Runtime, not the model,
owns heartbeat and supervision.

`worker_done` is not proof that production exists. Before accepting completion
of an exact Production Cell execution, the dispatcher requires the declared
typed product submission for that execution. Likewise, cryptographic identity
is Factory authority: the model supplies material bytes; Factory computes the
canonical digest. A model-provided digest may only be checked as a redundant
consistency assertion.

Git replay requires exact base compatibility, applies recorded patch/content to
factory-provisioned desk and verifies resulting tree before submitting current
implementation product.

Old commit SHA alone is not replay proof.

---

## 19. Two-channel state and repair projection

Kanban and Workplace loop state remain separate.

Explicit repair mapping:

```text
repairTargetRole = author
  -> Kanban in_progress

repairTargetRole = reviewer
  -> Kanban review_in_progress
```

Projection never guesses from prose/module name.

Worker crash/replay miss/replacement does not reset domain work to `todo`.

Controller state and factory activity are separate projection inputs. A
controller may be durably `paused` because it yielded to Production Cells while
workers remain active. Operator views must present this as active factory work
(for example, “workers working”), while `paused` with zero workers remains an
actual pause. Presentation must not rewrite the durable controller state.

Artifact navigation is a projection over an authoritative artifact forest.
Parent edges must stay within one project/episode, must reference an existing
artifact, and must be acyclic and non-self-referential. A defensive reader
surfaces unreachable/corrupt rows explicitly; it never hides ledger rows merely
because root traversal cannot reach them.

---

## 20. Checks, effects and compensation

Checks inspect immutable candidates and cannot change authoritative/external
state.

Effects perform authorized external changes with exact desired-state identity,
idempotency key, durable EffectAttempt and EffectReceipt.

```text
lint/build/test            = check
Git merge/push             = effect
publish/deploy             = effect
```

Replay never substitutes old external-effect completion.

When a Cell declares an effect as required for acceptance, its universal
ordering is:

```text
accepted GateDecision
  -> effect_pending
  -> durable EffectAttempt
       | successful exact EffectReceipt -> CellFinalAcceptance
       | recoverable outcome             -> RecoveryIssue / retry / repair
       | human-required outcome          -> pause
       | policy-terminal outcome         -> failed
  -> replay certification
```

This grammar is capability-neutral. Core runtime knows the declared effect
identity, policy and typed receipt; only the provider adapter knows Git,
publishing, deployment or another external system.

A Git integration conflict is a typed Effect outcome with source commit/tree,
target head, conflict paths and attempted strategy. It does not erase accepted
worker evidence and must not be flattened into an unattributed factory failure.
Recovery either repairs the nonterminal effect under its policy or creates an
accepted-prefix continuation after terminalization; it never marks a changed
tree accepted under the old review.

### No implicit rollback

Effect recovery policy is explicit:

```text
retry-idempotently
compensate-explicitly
roll-forward
human-required
```

Default without a proven compensator is roll-forward or human-required.

A compensating action is itself an authorized Effect with its own identity,
attempt and receipt.

---

## 21. Observation is a control/provider operation

Delivery observation does not create another worker engine.

```text
Deploy Effect
  -> EffectReceipt
  -> ObservationProvider
  -> Observation Product/Receipt
  -> deterministic policy
       | healthy
       | degraded
       | failed
       | not-ready -> durable retry
```

Observation retry is a bounded/durable control operation, not a private worker
queue or second Production Cell runtime.

---

## 22. One dispatch authority and one execution authority

Infrastructure selects eligible queued Workplaces, records reservation/fence,
builds immutable execution context, resolves replay eligibility and launches the
physical worker.

Worker admission uses one durable live policy. Effective concurrency is
`min(operator concurrency, exact model quota)`, read immediately before each
assignment together with all durable `reserved`, `running` and
`cancel_requested` executions. Missing or malformed policy fails closed. A
downshift suppresses replacement workers and lets existing workers drain; it
does not kill them. Launch-ticket concurrency is immutable audit input, not the
live authority.

The current bounded single-host implementation reads then assigns. Before
multi-host or provider-account-global operation, quota validation and capacity
reservation must move into the same atomic assignment transaction and return
typed `assigned | at_capacity | queue_empty | policy_invalid` outcomes.

A review-complete cohort barrier for releasing additional `todo` author work is
a deferred policy proposal, not a current invariant. It must be evaluated after
one complete end-to-end Product Delivery run and must not replace explicit
dependency-graph enforcement.

Worker never chooses work. Workshop never launches workers.

All managed tools validate execution authority fail-closed. Replay workers get
no broader capability set than corresponding inference workers.

---

## 23. Composed state machines and temporal progress

The Conveyor is a composition of authoritative state machines. It is not one
global status enum, and no projection is allowed to impersonate one.

| Machine / value object | Authoritative state or transition owner |
|---|---|
| LaunchRequest | launch repository: `requested -> claimed -> running -> paused | completed | failed` (`paused` settles only this host launch, never claims lifecycle convergence) |
| LifecycleRun / StageRun | lifecycle repository and exact stage-transition journal |
| ProcessRun | ProcessRun repository: `created -> preparing -> running -> paused | settling -> terminal` |
| NodeRun | generic flow cursor and NodeRun repository: `running -> completed | failed` |
| Workplace | Production Cell reducer over Kanban phase, loop state, role and revision |
| ExecutionReservation / WorkerExecution | atomic assignment, fence, lease and execution repository |
| CandidateSet | immutable `absent -> sealed` QC handoff |
| GateRun / GateDecision | gate driver and immutable decision ledger |
| ExternalEffect | effect ledger and provider observation protocol |

`tasks.status`, board columns, controller labels, process-host snapshots and log
activity are projections or telemetry. They may explain authority, but they
never authorize a transition.

### Local transition graphs are necessary but insufficient

Every mutable aggregate has a closed local transition graph. Its reducer or
repository must reject an unknown edge, preserve terminal monotonicity and use
revision/fence CAS. Unit tests enumerate every legal edge and representative
illegal edges.

The production failure class that local transition tests cannot prove is a
missing **synchronization edge**: machine A reaches a legal state but the real
host never invokes the command that advances machine B. Therefore the
following cross-machine hand-offs are normative parts of the Conveyor graph:

| Durable source landmark | Required next obligation |
|---|---|
| Launch claimed | create or resume the exact LifecycleRun, then mark launch running |
| Lifecycle stage selected | create/bind one exact StageRun and ProcessRun |
| Flow reaches a Production Cell | materialize/seal its Workplace graph before admission |
| Workplace queued and eligible | atomically create Reservation + WorkerExecution and move Workplace to leased |
| Worker produces and calls completion | validate exact products and move Workplace to verifying |
| OS worker exits | terminalize the exact WorkerExecution; host status is observation only |
| Workplace verifying | seal the current CandidateSet and drive its declared GateRun |
| Gate accepts with required effect | create/drive exact EffectAttempt; remain effect_pending |
| Gate/effect finalizes the cell | create CellFinalAcceptance and terminalize Workplace |
| all cell obligations complete | complete NodeRun and advance the exact flow cursor |
| terminal ProcessRun result exists | settle StageRun and route the exact lifecycle outcome |
| terminal LifecycleRun exists | settle LaunchRequest and FactoryOrder leaf projection |

No hand-off may be justified by a project-scoped host status when an exact
execution, candidate, gate, effect, node or run identity exists. In particular,
assignment completion is read from the exact durable `WorkerExecution`; a
process-host snapshot can trigger reconciliation but cannot keep an already
terminal execution logically active.

### The progress-obligation invariant

For one consistent durable snapshot, every nonterminal Factory scope must have
at least one and only truthfully classified progress explanation:

```text
live owner       = a valid unexpired lease/fence owns the next mutation
runnable command = a durable precondition enables an idempotent kernel command
typed wait       = dependency/provider/backoff/human wait with a wake source
transition due   = a committed child result/outbox obligation awaits routing
```

If none applies, the scope is `stalled`. If several contradict one another,
the scope is `inconsistent_state`. A nonterminal scope may not remain merely
`running` or `paused` without one of these proofs.

Liveness is conditional, not magical. Every temporal property declares its
fairness boundary: scheduler cycles continue, SQLite is writable, a required
provider eventually responds, or a human action is explicitly required. Under
those assumptions the invariant is:

> Every enabled internal transition eventually commits, loses a fenced race
> to an equivalent transition, or produces a typed durable wait/terminal
> incident within its declared cycle budget.

External providers and humans are not assumed fair. Their absence must become
a truthful typed wait or bounded escalation, never an infinite anonymous
pause.

### Mandatory testing ladder

The layers test different theorems and none substitutes for the next:

| Layer | Theorem | Typical mechanism |
|---|---|---|
| L0 Contract | states/events/schemas are closed and versioned | TypeScript/schema/architecture ratchets |
| L1 Local machine | each legal edge works; illegal edges fail | pure reducers and transition-table tests |
| L2 Durable aggregate | CAS, atomic writes, idempotency and terminal immutability hold | real SQLite repository/concurrency tests |
| L3 Temporal composition | the **canonical production composition** schedules every required synchronization edge | scripted workers, real orchestrator/dispatcher/gates, durable temporal trace |
| L4 Fault schedule | every crash/interleaving converges to progress, typed wait or terminal incident | process kill and fault injection before/after durable boundaries |
| L5 Product E2E | a new Project traverses the installed lifecycle and produces the intended product | zero-token scripted run, then optional monitored real-model canary |

The historically missing layer was L3/L4. Existing fake executors often changed
host status and durable execution state simultaneously, eliminating the real
interleaving. A conforming temporal harness replaces only the inference port
and explicitly declared deterministic check provider. It imports the canonical
lifecycle, packages, repositories, routing, dispatcher, gates and effects; it
must not restate them in a private test composition.

At minimum L3/L4 prove:

1. after exact `WorkerExecution` termination, `verifying` reaches CandidateSet
   and GateRun or a typed incident within a bounded host-cycle budget;
2. a terminal ProcessRun is routed to Stage/Lifecycle settlement;
3. `repair_wait` below budget is requeued; `paused` remains explicit human wait;
4. crash before/after product, CandidateSet, GateDecision, effect and stage
   routing creates no duplicate authority and no silent idle state;
5. an eligible queue with no engine, an ownerless pending gate, an expired
   reservation and an unrouted terminal child are all diagnosed distinctly;
6. package/provider/lifecycle composition fingerprints match the canonical
   installed production definition;
7. every installed lifecycle outcome edge has a real-runtime trace or an
   explicit mechanically checked unreachable proof;
8. dependency scenarios are non-vacuous: at least one durable Workplace/task
   edge exists, the dependent is not reserved before predecessor final
   acceptance/effect settlement, and its effective input/base binds the
   post-dependency product;
9. scripted production enters through the production runner's inference spawn
   seam. It may replace model cognition, but not assignment, workspace/desk,
   MCP/tool authority, product submission, process finalization, gates,
   effects, routing or persistence;
10. the Product Build terminal is `runnable-local` with no Delivery/DevOps
    ProcessRun and no human approval dependency. Factory-owned tests plus an
    isolated start/probe/shutdown receipt bind the exact frozen commit/tree.
    This proves local runnability, not semantic acceptance. Human acceptance
    starts only after that product is run; findings become a new Change
    Request against the immutable product revision.

The test substitution boundary is equally strict: a scripted worker may replace
model inference, but a production-conformance suite must use the installed
lifecycle, package, Gate plans, CheckProviders, effects, persistence, and
settlement unchanged. Replacing an acceptance provider turns the scenario into
a component test and must not be reported as production E2E.

Temporal assertions use durable transitions or host-cycle budgets, not quiet
logs or arbitrary wall-clock sleeps. On failure the harness emits the last
durable landmarks, exact authority refs and the unmet progress obligation.

A bounded statechart explorer is an L1/L2 amplifier, never a second runtime
authority and never a substitute for L3. It models three orthogonal machines:

```text
Workshop: Kanban phase + Workplace loop/role/revision + Candidate/Gate/Effect
Engine:   admission policy + Reservation/WorkerExecution/fence/lease
Pipeline: Process/Stage/Lifecycle cursor + exact product/certificate lineage
```

Generated traces may contain an arbitrary fault prefix, but liveness is judged
only after a declared fair-drain suffix. Minimized traces are replayed against
production reducers/SQLite and selected counterexamples against the canonical
temporal composition. This prevents an abstract model from assuming scheduler
fairness and thereby assuming away the production wiring failure it is meant
to detect.

---

## 24. DDD and dependency direction

Key conceptual ownership:

- **Project** — stable product/replay scope; multiple intentional Factory Runs.
- **ProcessRun/LifecycleRun** — one lifecycle execution; Resume preserves it.
- **Workplace** — one materialized cell in one run.
- **WorkerExecution** — one fenced attempt.
- **CandidateSet** — exact QC handoff in the current run.
- **GateDecision** — append-only QC authority.
- **ReplayCapsule** — derived reusable worker-production archive.
- **EffectAttempt** — idempotent external-effect attempt.

Dependency direction:

```text
CLI / MCP / UI / scheduler
        -> application use cases
        -> domain contracts/policies
        <- ports
        <- SQLite / filesystem / model / replay / Git adapters
```

Domain/application code must not depend directly on simulator scripts or SQLite
replay adapters.

---

## 25. Mandatory replay fitness tests

At minimum prove:

1. Miss preserves selected provider/model/effort.
2. Exact semantic hit uses replay and leaves model settings unchanged.
3. New ProcessRun/Workplace/execution refs do not change ReplayKey by
   themselves.
4. Meaningful product input/package/contract change causes miss.
5. Reviewer key is stable across runs when author product content is identical.
6. Reviewer key changes when author product content changes.
7. Repository base mismatch prevents Git replay.
8. Replay creates NEW current CandidateSet and CURRENT GateRun.
9. GateDecision/Workplace/lifecycle from old run are never replayed.
10. Capsule certification requires CellFinalAcceptance.
11. Reviewed cell certifies only exact final author+reviewer sets.
12. Rejected historical repair attempts never become capsules.
13. Crash after final acceptance but before archive capture can lazily rebuild
    capsule.
14. Replay tool calls use the same authority gateway.
15. Corrupt hit fails closed without hidden LLM fallback.
16. Capsule rejected by current gate is ineligible on next recovery attempt.
17. Unpinned live external read is non-replayable.
18. Same Project supports Run A model production followed by Run B replay from
    beginning in the same persistence system, with no table reset/capsule copy.
19. Fixture project completes through normal Factory Start without mock/hybrid
    routing.

---

## 26. Mandatory effect fitness tests

Prove:

1. Crash after external change but before receipt consumption does not duplicate
   the effect.
2. Duplicate idempotency identity creates one effective external change.
3. Retry observes external state before repeating.
4. Unsupported compensation never happens implicitly.
5. Explicit compensation is its own authorized Effect.
6. Observation retry does not create a second runtime/queue.

---

## 27. Architecture fitness functions

CI should mechanically reject at least:

- module-name/task-kind branches in universal runtime physics;
- module-specific submit/read protocols;
- mock/hybrid factory modes;
- replay code mutating GateDecision/Workplace/lifecycle;
- certification from raw `verdict === accepted`;
- ReplayKey derived from run-specific envelope refs;
- reviewer ReplayKey derived from run-scoped CandidateSet identity;
- repeated same-capsule replay after current rejection;
- replayable workers with unpinned live-read authority;
- canonical E2E using DB reset/cross-DB capsule copy to fake a new Factory Run;
- one-run-per-project persistence constraints treated as target architecture.
- changing a terminal LifecycleRun, StageRun or ProcessRun back to running;
- a continuation that invokes an inherited completed stage;
- inherited stage mappings sourced from raw lifecycle input rather than the
  verified continuation prefix;
- pinned replay that changes the persisted invocation actor/context;
- copied upstream GateDecisions presented as current continuation authority;
- silent FactoryOrder lifecycle-FK repointing that hides a failed parent;
- resume replacing persisted package/check-plan pins with current defaults;
- re-running a worker solely because inspection infrastructure failed after an
  unchanged CandidateSet was sealed;
- cross-terminal author reuse without an immutable single-use authorization,
  a new current CandidateSet and current gates;
- treating an old author gate, reviewer verdict or CandidateSet as a child
  run's current acceptance authority;
- accepting `worker_done` when the exact frozen WorkIntent output contract is
  missing or has the wrong schema/cardinality;
- treating a schema-id string or TypeScript interface as runtime payload
  validation;
- a Product Contract check provider that passes without resolving and checking
  the exact CandidateSet members;
- accepting worker-authored `trusted=true` or `deterministic_evidence` as
  provider authority;
- treating mutable task/provider metadata as an immutable verification receipt;
- accepting an LM-authored `outcome=passed` without an independent exact
  CheckReceipt and content-addressed evidence;
- allowing an ambient payload-validator registry to reinterpret a WorkIntent
  whose exact contract id/version/definition digest was not frozen;
- requiring a nested evidence ProductRef that no allowed worker/provider tool
  can create;
- dropping accepted verification-method requirements before Development task
  materialization;
- reviewer desks or effects selecting “latest task submission” instead of the
  exact current author CandidateSet member;
- non-empty planned dependency graphs materialized without exact task edges;
- fan-out admission occurring before the complete dependency DAG is persisted;
- dependency reconciliation derived from transient queued/running task sets;
- delete-replacement of sealed dependency edges with a reduced status-derived
  graph;
- dependent Git desks based before their dependencies were integrated;
- use of the stage lineage `expectedBaseCommit` as every dependent task's
  effective execution base;
- LM profiles that can mutate canonical Git refs, merge or issue integration
  authority;
- linked Git worktrees described as hard isolation without an OS-enforced
  boundary;
- fan-out accepted merely to consume concurrency, without split rationale and
  deterministic topology fitness;
- dependency/effect waiting overloaded onto a human-required `blocked` state;
- changed Git trees integrated under CandidateSet/review authority for an older
  source commit;
- terminal acceptance or replay certification before every declared required
  acceptance effect has a successful exact EffectReceipt;
- effect-provider failures flattened into unattributed lifecycle exceptions
  instead of typed outcomes and RecoveryIssues;
- artifact parent self-links, cross-scope links or cycles;
- UI treating a yielded controller as a stopped factory while durable workers
  are active;
- model quotas duplicated outside the canonical model-cap policy;
- dispatch using immutable launch concurrency as its live admission ceiling;
- missing concurrency/model policy falling back to a permissive default.
- waiting for an exact assigned execution solely through project-scoped or
  process-local host status;
- a nonterminal scope with no live owner, runnable command, typed wait or
  pending transition obligation;
- canonical temporal E2E tests that replace lifecycle routing, settlement,
  package/provider registration, gates or effects instead of only replacing
  declared external production/check ports;
- claims of liveness based only on local reducer reachability or assumed
  scheduler fairness;

Markdown is an architectural source of truth; executable fitness functions are
its enforcement.

---

## 28. Canonical glossary

| Human term | Machine meaning |
|---|---|
| Project / product | stable product scope and replay namespace |
| Factory Start | intentional creation of a new Factory Run |
| Factory Run | one ProcessRun/LifecycleRun execution |
| Resume | continuation of the same Factory Run |
| Continuation | append-only downstream run linked to an accepted stage prefix |
| Workshop | Process Module package |
| Production Cell | worker/check/review/gate loop |
| Workplace | materialized cell instance in one run |
| Worker | one WorkerExecution |
| Replay worker | deterministic WorkerExecution using capsule recipe |
| Desk | Workplace-scoped workspace/product surface |
| Candidate batch | current-run CandidateSet |
| QC act | GateDecision |
| Final QC acceptance | CellFinalAcceptance proof/value |
| Defect sheet | RecoveryIssue |
| Replay capsule | certified reconstruction recipe for worker production |
| Effect | authorized external state change |
| Observation | retryable provider/control read of external state |

Replay is not another factory. Observation is not another worker engine.

---

## 29. Architectural rule of thumb

Two questions catch most design drift.

> **After worker products are submitted, can the rest of the factory execute
> identically without knowing whether the bytes came from GLM, Claude, Qwen or
> replay?**

And:

> **Can the same Project intentionally start a new Factory Run, reuse only
> semantically compatible capsules, and still execute all current QC/lifecycle
> code without resetting production state?**

If either answer is no, worker/run implementation details have leaked into
factory physics.

---

## 30. Frozen predictions, satisfiability, and fences (stage-13 invariants)

Four invariants govern every authority the factory freezes and every fence
it enforces. They are deliberately stated domain-free: a reader who has
never seen this system's runs must be able to apply them to a plant that
builds anything at all. A rule that only makes sense to an eyewitness is a
diary entry, not a rule.

1. **A frozen prediction is not an authority.** Anything frozen before the
   fact and enforced afterward — a scope of paths, a declared environment,
   a declared check set — is a guess about work not yet performed, and a
   guess cannot obligate reality. For every frozen prediction the factory
   does exactly one of two things: it derives the freeze from fact (from
   the order, from the artefact, from observation), or it makes revising
   the freeze a first-class transition with its own recorded authority.
   "Predict better" is not a third option: a better guess is still a guess
   and fails the same way, later.

2. **Acceptance criteria are derived from the order, never from the
   candidate.** The standard that judges work must come from what was
   ordered. The moment any part of acceptance is supplied by the thing
   being judged, judge and judged are the same party and every downstream
   verdict is negotiable.

3. **Obligations the factory issues from different authorities must be
   jointly satisfiable, and the factory owns proving it — or owns a lawful
   path out of the contradiction.** Two individually correct obligations
   can still describe an impossible world: "produce this artefact" and
   "never touch the place this artefact lives" are each defensible and
   together unsatisfiable. A conveyor of individually-correct gates that
   admits no possible world is the factory's defect, not the worker's;
   neither the satisfiability proof nor the lawful exit can be delegated
   to the worker.

4. **A fence decides contention, never necessity.** A fence may answer
   "is this resource claimed by another live worker?" — a question that is
   decidable, always, in any domain. A fence may not answer "does this
   work truly need this resource?" — a question that has no answer before
   the work exists. A fence asked the second question will eventually
   block exactly the progress it exists to protect.

Any newly proposed mechanism, gate, or frozen declaration is tested
against these four before any run exercises it.

---

## Operational appendices

- [Universal transition diagnostics and logging](CONVEYOR-TRANSITION-DIAGNOSTICS.md)
- [Transition acceptance and incident checklist](CONVEYOR-TRANSITION-CHECKLIST.md)
- [Factory Domain Acceptance Registry](FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md)
- [ADR-033: durable submission preflight recovery](decisions/033-durable-submission-preflight-recovery.md)
- [ADR-034: rehydrate nonterminal package pins](decisions/034-rehydrate-nonterminal-package-pins.md)
- [ADR-035: replay sealed candidate after provider-plan failure](decisions/035-replay-sealed-candidate-after-provider-plan-failure.md)
- [ADR-036: durable live concurrency admission](decisions/036-durable-live-concurrency-admission.md)
- [ADR-038: continue from an accepted stage prefix](decisions/038-continue-from-accepted-stage-prefix.md)

Workshops are configuration instances of this protocol, not separate lifecycle
engines. Replay is a standard optimization of worker production inside the same
protocol, never another mode of the factory.

## Appendix: terminal approval and local release continuation

`approval-required` is a truthful terminal business outcome, not a paused
worker state. Later operator authority never rewrites that outcome. The factory
appends a child LifecycleRun at the Delivery boundary, verifies the inherited
prefix, and executes only the suffix.

Approval, effect, observation, and settlement are four different facts:

1. an exact operator grant authorizes a policy and candidate;
2. an effect provider attempts one content-addressed desired state;
3. an authoritative observer proves the external state matches;
4. settlement may then issue a ReleaseRecord and certificate.

A ReleaseRecord alone is not a release. For local source releases the observable
effect may be an immutable Git tag. It must be created without force, observed
before retry, and accepted as replay only when commit and tree match exactly.
The continuation creates no inherited StageRuns and invokes no inherited
workers; the UI must show the terminal parent and active/successful child as one
visible order lineage.

## Product construction, change, and deployment are different requests

The default MVP conveyor constructs a product revision; it does not deploy it:

```text
FactoryRequest(new-product)
  -> Discovery -> Formalization -> Development
  -> verified local commit/tree + RunReceipt
  -> ProductRevision -> ready-to-run
```

`ready-to-run` means that the exact content-addressed revision is committed,
verified against its accepted contract, and machine-observed through its typed
RunContract. It never means published, remotely deployed, or operationally
approved. Ordinary product construction therefore creates no Delivery
StageRun, approval request, ReleaseRecord, or deployment effect.

Human evaluation happens after this terminal. Feedback is a new
`FactoryRequest(change)` and a new FactoryOrder in the same Project. It binds an
exact baseline ProductRevision, preserves all prior artifacts and decisions as
immutable evidence, and creates current gates for changed/regression scope. A
Change Request is not a continuation: continuation repairs the same order;
change expresses a new business intent.

Deployment is a future `FactoryRequest(release)` consumed by the DevOps
workshop. It references one exact ProductRevision and owns environment policy,
approval, external effects and observation. Splitting these requests prevents
release authority from blocking product manufacture while preserving the
universal conveyor grammar.
# Atomic members at managed-document boundaries

A managed artifact may be a provenance container for several domain contract
members. Cardinality of downstream typed inputs MUST come from a deterministic,
versioned projection frozen with the accepted container; it MUST NOT be inferred
independently by workers, reviewers, or later stages. For acceptance documents,
the baseline binds every atomic criterion code and section hash to its immutable
artifact container. Gates, reviewers, and downstream planning consume that same
member set. This prevents a locally valid state machine from entering an
unsatisfiable repair cycle because machine and semantic authorities disagree on
the subject's cardinality.

---

## Статус конформности (2026-08-16)

Аудит сверки модели с кодом после антифриз-серии (`681ca660` слой A+B1,
`3b177ac3` слой C supervisor, `6bfb0ecf` слои B2+B3, `9d5b51da` слой B4,
`9ff3b760` supervision PID-guard) и ADR-074/075. Сама модель не
переписывается — этот раздел фиксирует, какие её требования теперь выдержаны
реализацией, а какие ещё расходятся. Формат: требование (раздел модели) →
что его закрыло → где свидетельство в коде/схеме.

### Выдержано полностью

| Требование модели | Чем закрыто | Свидетельство |
|---|---|---|
| §23 «never an infinite anonymous pause» в цикле качества | ADR-075: recovery-эпохи + суммарный потолок попыток (без человека в цикле качества) | `onExhausted='requeue'` → append-only `factory_workplace_recovery_epochs` (базовая линия счётчиков + экспоненциальный беккофф 1–15 мин), `totalAttempts` (по умолчанию 30) → честный `terminal failed`; строки `[recovery-budget] ROLLOVER / TOTAL-CAP` в `production-cell-node-executor.ts`. Delivery/инфраструктурные human-границы остаются explicit `human_required`-парками — truthful typed wait, не анонимная пауза |
| §23 bounded escalation при исчезновении/фризе движка-хоста | Слой C: engine supervisor в панели (`tracker-view/engine-supervisor.mjs`, schema v14) | heartbeat-маркеры ≤5 с (`$SAGA_ENGINE_LOG.heartbeat`, `.phase`); sweep 30 с; фриз = живой pid + heartbeat старше 120 с; durable-события `freeze_detected`/`restart_attempted` в `factory_engine_watchdog_events` пишутся ДО остановки; лечение — операторский soft-stop тормоз + рестарт штатным resume-кодом; backoff 1→5→15 мин, бюджет 5/2 ч; исчерпание → `engine_state='failed_watchdog'` + `last_error`, видно в `/api/factory/status` (поля `engine_state`/`engine_error`/`watchdog`) — никогда не тихий стоп; дубли движков блокируются `sweepBeforeSpawn` |
| §22/§23 типизированные исходы диспетчеризации и типизированные ожидания | План п.19 (`DispatchOutcome`) + слой B3 (`withBusyRetry`) | `startOne()` возвращает `assigned \| card_error \| queue_empty \| capacity_blocked`; per-card клапан `card_error` для provably-card-local семейств (REPLAY_*/FROZEN_*/spawn-errno) — одна сломанная карточка не убивает движок; типизированная `ENGINE_DB_BUSY` (3 попытки / окно 250 мс / backoff 50–100 мс / бюджет) → card_error-клапан или defer sweep, а не вечный busy-spin; `[obligation-reconciler] DEFER/FAIL/sweep/defer-only streak` — типизированные durable-ожидания переходов в логе движка |
| §23 наблюдаемость хода (liveness conditional, диагностика) | Слой A+B1 + B2 | движок пишет лог ТОЛЬКО в `$SAGA_ENGINE_LOG` (stdout-пайп устранён как класс фризов stdout-backpressure; stdio `['ignore','ignore','pipe']`, stderr → тот же файл); B2: readonly durable-state probe (одно readonly-соединение, 250 мс) для цикла ожидания — wait-poll/shouldYieldToKernel не спорят с главным соединением; ошибки probe fail-closed (false/−1), никогда throw |
| §17 checkpoint ≠ worker-производство; чекпойнт не блокирует цикл | Слой B4 + ретенция | захват чекпойнта вынесен в одноразовый дочерний процесс (watchdog 120 с, `SAGA_CHECKPOINT_CHILD=0` — старый путь; stdio без труб): same-process взаимоблокировка соединений структурно невозможна; ретенция 10 новейших манифестов на (project, epic) — автономные recovery-ретраи ADR-075 не переполняют диск |
| §14 модель-выбор ортогонален; §22 concurrency = min(оператор, квота модели), fail-closed | Единый модельный каталог | `FACTORY_CLOUD_MODELS` (`glm-4.7` limit 2 / `glm-5-turbo` 5 / `glm-5.2` 10 / `glm-5.3` effort=max limit 6; effort low..max); `effectiveFactoryConcurrency = min(requested, modelLimit)`, некорректная политика падает fail-closed; replay-ключ идентичность модели не включает; смена модели действует с момента claim — работающие воркеры доигрывают |
| §20 typed effect-repair feedback (конфликт Git-интеграции — типизированный исход, не стёртое accepted-свидетельство) | ADR-074 | immutable effect-repair `RecoveryIssue`, привязанный к exact `AcceptedCandidateAuthority` и точному переходу ревизии; Gate head выбирает его без chronology; финальный GateDecision честно остаётся `accepted` |

### Всё ещё расходится

| Расхождение | Где в коде | Какое требование модели нарушается |
|---|---|---|
| ADR-053 cutover не завершён (ADR-073 принят, швы остались): выбор материала по накоплению/recency | `readAcceptedArtifacts` / baseline / traceability формализационного сэттлмента — epic-scoped, не lifecycle-scoped (TB-11 закрыл только `areTasksReady(epicId, lifecycleRunId)`); эпик-накопление принятого материала сертифицирует baseline нового рана, замешанный на материале мёртвых ранов | §2 «exact refs, never latest»; §5 warning box (ADR-053); §7 continuation «never hides the parent failure or silently repoints authority» |
| Newest-wins капсульный биндер | диспетчеризация replay-капсул: на третьем lifecycle-ране того же Workplace биндер может выбрать капсулу рана N−2 против baseline, замороженного по рану N−1 → `FINAL_PRESENTATION_FENCE_MISMATCH`-класс паркинга без пути invalidate/Regenerate | §9 replay identity (семантический ключ, не «новейшая капсула»); §15 «rejected replay cannot loop forever» (здесь — обратная грань: неверно выбранная капсула без выхода) |
| `classifyResumeCompatibility` сравнивает только `handlerLogicalIds` | `resume-compatibility-policy.ts`: contract surface = identity + input/output schemas + `handlerLogicalIds`; implementation-дайджесты хендлеров (реальные sha256 после плана п.15) в вердикте не участвуют → полностью переписанный settlement-хендлер между ранами классифицируется `compatible` | §7 Resume: rehydrate exact persisted package/check-plan snapshots; «must not silently replace them with whichever package version happens to be installed now» |
| Delivery human-границы — вне scope ADR-075 | approval релиза, заблокированные post-acceptance эффекты (например git-integration), поломка спавна воркеров | Не нарушение, а остаточная человеческая зависимость: §23 прямо допускает explicit human wait. Оператору важно знать, что это ЕДИНСТВЕННЫЕ оставшиеся места, где завод ждёт человека |
| Остаточные точки busy-риска (TB-2 residue) | `worker-executions.ts` открывает отдельное соединение на каждый вызов (`openRuntimeDb`-per-call, busy_timeout 5000); одиночные записи runEpisode-цикла (boot revision, certify sweep, markFactoryLaunchRunning) остаются на 5-с окне `getDb()` | §23 cycle budget: B2/B3/B4 закрыли цикл ожидания, checkpoint и supervision-записи, но не каждую точку; watchdog слоя C делает остаточные фризы наблюдаемыми и лечимыми (fallback — B5, если фриз повторится с живым heartbeat) |

### Вердикт

Модель выдержана **не полностью**. Liveness-ядро §23 — «нет вечных анонимных
пауз», bounded escalation, типизированные ожидания, наблюдаемость — после
антифриз-серии и ADR-074/075 фактически закрыто на уровне движка, диспетчера
и цикла качества. Главное оставшееся расхождение — материальный авторитет
(ADR-053/073): сэттлментные швы формализации всё ещё выбирают материал по
эпик-накоплению, а не по точной ревизии текущего рана; newest-wins капсульный
биндер и resume-совместимость без implementation-дайджестов — прямые
следствия того же дефекта. Следующая ожидаемая граница слома без cutover —
 третий lifecycle-ран на одном эпике (биндер/baseline) и любой
post-acceptance эффект, читающий накопленный материал эпика.
