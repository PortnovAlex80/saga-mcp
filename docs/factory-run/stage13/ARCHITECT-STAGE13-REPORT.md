# ARCHITECT STAGE-13 REPORT — 2026-08-20

Report per `docs/handoff/STAGE-13-AGENT-BRIEF.md`. Headline: **TASK 1 and
TASK 2 are delivered as one mechanism (TASK 1 subsumed TASK 2, as the brief
allowed — details below), TASK 4 and TASK 5 are delivered, TASK 3 (K19)
executed its commit train in order and stopped at commit 1, a clean
boundary, with commits 2–6 honestly not started.** The whole tree is green
on one HEAD, including the pre-existing stage-11 sanctioned-writers red,
now resolved.

Commits on `origin/saga4` (this stage): `3fbe3dbd` (TASK 5 merge),
`5b0c3385` (TASK 1+2), `07c560ea` (TASK 4), `f05dd37e` (TASK 3
commit 1 of 6).

## Task 1 — the lawful transition, as built

**The domain-free RED reproduction** (committed evidence:
`docs/factory-run/stage13/RED-evidence-{grant,declared}.txt`; fixture:
`tests/factory-e2e/w9-06-*`). The fixture invents its own artefact world —
the criterion's companion artefact is `atlas/registry-map.json` — and names
NO path from the stage-12 run. Two scenarios, both honestly red on the
pre-stage-13 tree:

- **grant scenario RED**: discovery + formalization pass cleanly (12-gate
  class), then the honest worker's atlas file is rejected twice by the
  scope fence; the trajectory machinery parks the card `REPLAN_MANDATED`;
  lifecycle ends `paused / terminal_status=null`. Ordinary progress
  converted into a livelock, exactly the stage-12 deadlock in miniature.
- **declared scenario RED**: the typed conclusion did not exist —
  `worker_done` refused the declaration (`PRODUCTION_CELL_PRODUCT_REQUIRED`),
  the worker burned executions as `lost`, a recovery epoch engaged, the
  lifecycle stalled paused. The category error's second face.

**The outcome/transition added** (one mechanism, `§27`-shaped):

1. `worker_done` gains the typed conclusion `outcome: 'scope-insufficient'`
   with `requested_scopes` — a **successful conclusion of an attempt**: no
   product sealed, no recovery budget charged; the request is recorded
   append-only; the release outcome `declared` moves the workplace
   `running → repair_wait` via the new `scope-declared` reducer event and
   the card returns to the claimable queue.
2. The second entry is the cell's own gate evidence: the surviving
   `path-outside-authority` trajectory (the same finding key surviving two
   consecutive rejections) now records the SAME widening request
   (`source: cell-trajectory`) — the offending paths ARE the need
   statement. The re-plan-mandate park this site used to mint is deleted.
3. The kernel decides on the next drive, **before any budget arithmetic**
   (proven: zero recovery-epoch rows in both unit and e2e green runs).

**The contention rule as implemented**
(`src/infrastructure/workplace/sqlite-scope-widening-ledger.ts`): a request
is granted iff no other **live** workplace's frozen write authority
(original carve ∪ its own grants) overlaps any requested scope; live =
nonterminal workplace with a non-cancelled card; the requester itself is
excluded. **Necessity is never evaluated** — the ledger's API has no
method that could answer it. A grant re-freezes a **new scope revision**:
the grant row carries the FULL frozen set (monotonic superset by
construction) in the append-only `factory_scope_widening_events` ledger
(no-update/no-delete triggers); both fences (the implementation-scope
check provider via an injected port, and the managed source-change desk)
read the CURRENT effective authority. A refusal is terminal and honest:
`scope-widening-refused → terminal(failed)`, the refusal row naming each
holder (`workplaceRef (workKey) holds [scope]`). Schema: one additive
append-only table, deliberately NOT a version bump (documented no-bump
precedent) — this also keeps the live stage-12 run database openable by
current code while its engine runs.

**Green proof, end to end** (`w9-06`, both scenarios complete
`runnable-local`): fence receipts `[passed, failed, failed, passed]`,
request+grant rows with revision 1 covering the needed path, **zero
mandates, zero parks, zero stranded executions**; the declared variant
completes in 67 cycles with 3 receipts (reject → declare → retry passes).
Unit suite `scope-widening-routing.test.mjs` 4/4: grant re-freezes and
requeues budget-free; a LIVE holder refuses terminally with the holder
named; a pending worker-declared request is decided before budget
arithmetic; a resolved violation stays ordinary budget flow (no false
widening).

## Task 2 — why the dispatcher ignored the carve, and the subsumption

**Why (established from code, three independent causes):** (1) cycle-2
workplaces are minted `todo/idle` but the claim query only matches
`loop_state='queued'` — the only idle→queued admission lives inside the
node executor's drive of THAT run's implement cell, and nothing re-drives
cycle 2; (2) `REPLAN_MANDATED` parks are classified as human judgment by
the transition-obligation reconciler — there is no automatic cycle-2
start; (3) `buildReplanCase` has **no production caller** — the designed
cycle-2 case never reaches a planner. A designed remedy that is not wired
is worse than none.

**Task 1 subsumed it.** The lawful widening transition operates on the
LIVE workplace (same task, same workplace, re-staffed through the standard
queued/claim machinery) — no second workplace is minted, so the adoption
defect cannot arise for this event. The re-plan carve's scope trigger is
removed (one event, one mechanism); the mandate park is deleted from the
executor; the supersede/case-builder/cycle-policy library is retained as a
tested, dormant capability, and `replan-supersede.ts` is sanctioned as the
designed cycle-2 drain (this also turns the pre-existing stage-11
sanctioned-writers red green — lifecycle 136/136 for the first time since
stage 11). We did NOT end with two mechanisms.

## Task 3 — K19: commit 1 landed, clean boundary at 1 of 6

**Landed:** `docs(architecture): freeze capability and readiness fingerprint
contract` — **ADR-083** (registered in the closure registry, owner K19).
It freezes: one immutable `DerivedExecutionEnvironment` identity (base
image digest, tool claims with implementation digests, dependency lock
digest, filesystem layout, network policy) **derived from the artefact and
the pinned package** — the candidate's declaration is additive, never
definitive, and a contradicting declaration fails closed at freeze time
(`ENVIRONMENT_DECLARATION_CONTRADICTS_DERIVATION`); preparation and
certification bind the same digest; the ADR-077 fingerprint gains one
keyed `toolchainDigests` component (resume-incompatible on change);
certification is an ordinary Production Cell with exact-subject receipts;
preparation is ephemeral.

**Where I stopped and what remains:** commits 2–6 (ephemeral Python
environments; one exact OCI environment per pinned package; certification
cell; environment-drift incompatibility tests; ADR cohort closure) are
**not started** — the boundary is stated inside the ADR itself (§5). A
fraction is not presented as the whole; no sufficiency-report interim was
substituted, per the brief's explicit no-interim rule.

## Task 4 — the invariants as written

`docs/architecture/CONVEYOR-MENTAL-MODEL.md` v5.2 → v5.3, new **§30**
(after §29, existing numbering untouched), four numbered invariants in the
document's own voice:

1. **A frozen prediction is not an authority.** … derive from fact, or
   make revising it a first-class transition; "predict better" is not a
   third option.
2. **Acceptance criteria are derived from the order, never from the
   candidate.**
3. **Obligations the factory issues from different authorities must be
   jointly satisfiable, and the factory owns proving it — or owns a lawful
   path out of the contradiction.**
4. **A fence decides contention, never necessity.**

Formulation test honored: no run-specific path, domain term, or eyewitness
reference appears in the rules; the intro explicitly warns that a rule
only an eyewitness understands is a diary entry.

## Task 5 — merged, with the resolution documented

`repair/blindsight-reconciliation` merged under wave-B discipline
(`3fbe3dbd`): three conflicts, all feature unions (feedbackHistory/
priorAttempts desk validations ∪ previousAttempt validation; the loud-
feedback prompt blocks ∪ the previous-attempt prompt block in both the
test file and `claude-runner.mjs`). Branch's own suites 33/33 on the
merged tree.

## Verification baseline (measured on the final tree, `npm run build` first)

- architecture **408/408** (K7 classification added for the widening
  ledger's monotonic revision frontier; allowlist regenerated via
  `legacy-freeze --snapshot`, 101 tables, digest `5ca5339e`; dependency
  ratchet clean — the provider takes `readEffectiveChangeScopes` as an
  injected port)
- process-modules **1220/1220** (+4 widening tests, −3 superseded
  mandate-routing tests)
- lifecycle **136/136** (pre-existing stage-11 red resolved)
- infrastructure **401 pass / 0 fail / 12 skip**
- golden-path **1/1**, w9 e2e **20/20** (18 prior + 2 new)

Base quoted from: the merged-tree baseline measured in this report's own
runs; stage-12's final counts (arch 408, pm 1219, infra 401/0/12, w9 18)
for the deltas.

## The stage-12 run — no terminal yet

Per §0.4 it was left untouched. As of the end of this stage: lifecycle run
1 `paused / terminal_status=null` (last update 06:42Z), engine alive and
cycling, workplaces 8 accepted / 6 idle (the un-adopted re-carve) /
1 queued. It has not reached a terminal; it also never burned another
recovery epoch after 08:02.

## What was not finished

- **K19 commits 2–6** — not started, boundary above.
- **`repair/snapshot-test-mvp`** — stays held per the brief (awaiting your
  call on the stage-12 answers).
- **The stage-12 run** — still paused, not terminal; the §0.4 decision
  (let it run) remains in force with the engine alive.
- **Satisfiability rung in the testing ladder** (WORKSHOP-CONTROL-TRACKING
  §4.4) — proposed there, not ratified by you; not started.
