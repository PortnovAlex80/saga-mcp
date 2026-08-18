# Saga Core Renewal — Implementation Plan (K0–K20)

Working breakdown of the "Saga Core Renewal Program" v0.1 (2026-08-17) into
an executable ladder of releases. The program migrates the mixed Saga4 runtime
to one legacy-free correctness kernel through small, independently testable
releases, and closes the ADR implementation registry. It refines and replaces
the broad core-remediation scope previously placed in C0 of the Controlled
Change Plane roadmap (see `CONTROLLED-CHANGE-PLANE-PLAN.md`, §13 interface).

- **Date:** 2026-08-17
- **Source:** "Saga Core Renewal Program. Legacy-Free Kernel Migration and
  ADR Closure Roadmap", v0.1.
- **Repository baseline:** `PortnovAlex80/saga-mcp`, branch `saga4`,
  commit `eb0ace827baf4f774f0e2b86c5bf0c5058eda26a`. Later code changes must
  update the closure registry before release scope changes.
- **Repo facts verified this session:** the broken
  `test:factory:ratchet` script (package.json:40 → missing
  `tests/architecture/factory-only-ratchet.test.mjs`) is K1 scope;
  `accepted-authority-head.ts` and `factory_cell_final_acceptances` are the
  K12–K13 substrate; ADR-053/073 divergence (epic-scoped readers, newest-wins
  binder, resume without digests) is K6–K9 scope.
- **Status:** normative core path. No new domain factories and no Controlled
  Change Plane layering until the Core Readiness Gate (M6 / K20).

---

## 1. Thesis and end state

Saga4 already contains the target architecture (Factory, Workshop, Production
Cell, Workplace, CandidateSet, Gate, accepted authority, post-acceptance
effects, checkpoint/resume, replay, bounded recovery). The risk is not the
absence of the new model — it is the continued presence of older
execution-scoped, epic-scoped, recency-based, and compatibility-based paths
beside it. ADR-053 named this failure mode: **strangler migration without
strangulation**.

End-state execution flow:

```
FactoryStartGateway
  -> PinnedRuntimePackage
  -> ProductionGraph / ProductionCell
  -> WorkplaceStateMachine
  -> WorkplaceProductionRevision
  -> CandidateSet
  -> CheckPlan + CheckReceipts
  -> GateDecision
  -> AuthorityCommit
  -> AcceptedAuthorityHead
  -> EffectOutbox / EffectReceipt
  -> FinalAcceptance
```

Final core objective:

> Saga Core 3.0 is a closed correctness kernel in which one pinned runtime
> package drives one Production Cell execution model over exact Workplace
> material revisions; one Gate-proven AuthorityCommit creates one monotonic
> accepted head; replay, resume, recovery, effects, checkpoints, and release
> all reference that same identity; and no legacy runtime, schema, public
> API, or compatibility path remains callable.

**Governing rule:** no release may make the architecture look cleaner while
retaining an alternative authority path. A component is migrated only when
its old authority path is removed in the same release. Rollback = previous
binary + pre-migration database snapshot — never a runtime compatibility
switch.

**Physical removal, not deprecation:** a legacy path is removed only when
production code, schema, public API, tests, scripts, and operational
documentation no longer contain a callable version of it. Unused, hidden
behind a flag, deprecated, or excluded by convention does not count.

## 2. Measurable definition of legacy-free (K20 exit criteria)

- No execution-scoped field participates in material identity or
  accepted-material selection.
- No epic-scoped or latest-row query is reachable from an authority read path.
- No logical handler ID can establish resume compatibility without its
  implementation digest.
- No accepted state can be written outside the single AuthorityCommit service.
- No LM, flow, node, dispatcher, effect, or presentation adapter can publish
  accepted material directly.
- No runtime feature flag, compatibility reader, dual writer, or dual store
  preserves the old authority model.
- No clean-install schema contains legacy authority tables or columns.
- No public API exports deprecated authority types or aliases.
- Historical upgrade code lives in an offline migration tool, not imported by
  the runtime.
- All ADRs in the closure registry are Closed, Superseded with a verified
  successor, or Rejected with explicit rationale.

## 3. Delivery and commit discipline

### 3.1 Release unit

A K-release is the smallest independently deployable correctness increment:
one new invariant, one authority boundary migration, or one coherent legacy
path deletion. Never two unrelated architecture problems in one release.

| Constraint | Rule |
|---|---|
| Primary concern | Exactly one load-bearing correctness property |
| Production files | Target ≤ 25 per release; ≤ 6 per commit |
| Persistence | ≤ 1 schema migration family per release |
| New durable entities | ≤ 1 table (or one tightly coupled pair) |
| Net code size | Target < 1,500 non-generated lines; split when exceeded |
| Agent context | One release brief, one base SHA, one canonical failing theorem, one exit gate |
| Rollback | Previous binary + pre-migration DB snapshot; never an in-process legacy switch |

### 3.2 Standard commit order

1. Decision or amendment — freeze semantics before editing runtime behavior.
2. Failing theorem — the test proving the missing invariant.
3. Pure domain change — types, digests, policies, reducers, unwired.
4. Persistence change — migration + repository behavior, if required.
5. Runtime cutover — move the production path to the new boundary.
6. Legacy deletion — remove the old reader/writer/type/query/adapter **in
   the same release**.
7. Ratchet and closure proof — prohibit reintroduction; update the ADR
   closure registry on the exact verified SHA.

### 3.3 No dual authority during migration

Temporary duplication is permitted only for non-authoritative observation
(shadow reads may compare, never decide; removed when the cutover closes).
Dual writes, compatibility fallbacks, newest-wins fallbacks, and
feature-flag authority switching are prohibited.

### 3.4 Risk-tiered verification

| Tier | Applies to | Evidence |
|---|---|---|
| 1 — local refactor | No authority/persistence semantic change | Suite + 1 independent review |
| 2 — persistence/resume | Durable identity, package pins, migration, recovery | Suite + migration rehearsal + replay/fault test + 2 reviews |
| 3 — authority boundary | Accepted reads, CandidateSet identity, Gate, AuthorityCommit, effects, runtime path deletion | Suite + clean/upgrade/fault matrix + 3 reviews on one SHA |
| 4 — GA certification | Declares the core legacy-free | Full proof bundle + 3 reviews + operator sign-off + clean and upgrade canaries |

### 3.5 Branch policy

One K-release per branch/PR. No release branch starts until the previous
release has a closure manifest on its merge SHA. No production run from an
unclosed release branch. No formatting/renaming/dependency upgrades inside
an authority migration release.

## 4. Roadmap at a glance

| Wave | Release | Name | Primary result | Milestone |
|---|---|---|---|---|
| 0 | K0 | ADR Closure Registry | Machine-checkable implementation truth | |
| 0 | K1 | Canonical Green Baseline | Executable ratchets + same-SHA test proof | |
| 0 | K2 | Legacy Expansion Freeze | Legacy surface can only shrink | **M0** |
| 1 | K3 | Real Handler Digests | Reproducible implementation evidence | |
| 1 | K4 | Runtime Package Fingerprint | Immutable package identity | |
| 1 | K5 | Resume Compatibility Cutover | Exact-pin resume/adoption | **M1** |
| 2 | K6 | Lifecycle-Scoped Accepted Read API | First exact-read vertical | |
| 2 | K7 | Baseline & Traceability Read Cutover | One accepted-read model | |
| 2 | K8 | Exact Replay Capsule Binder | Semantic replay selection | |
| 2 | K9 | Invalidation & Third-Lifecycle Theorem | Certified N/N-1/N-2 behavior | **M2** |
| 3 | K10 | Remove Execution Material Ownership | Workplace-only material owner | |
| 3 | K11 | Authority-Only Effects | No effect re-selection | |
| 3 | K12 | Gate-Proven Atomic Acceptance | Provable acceptance commit | |
| 3 | K13 | Accepted Head & Exact Settlement | Complete authority model | **M3** |
| 4 | K14 | Single Production Authority Gateway | One authority ingress | |
| 4 | K15 | Unified Dispatch & Recovery Vocabulary | One liveness model | |
| 4 | K16 | Delete Legacy Runtime Code | One runtime in the binary | **M4** |
| 5 | K17 | Delete Legacy Schema & Public API | Legacy-free product surface | |
| 5 | K18 | Persistence & Checkpoint Discipline | Operationally hardened kernel | |
| 5 | K19 | Readiness & Toolchain Identity | Reproducible environment | **M5** |
| 6 | K20 | Legacy-Free Certification & GA | Full proof matrix + registry closed | **M6 / Core 3.0 GA** |

## 5. Detailed release cards

Format is uniform. Each card: objective, commit train (ordered, one proof per
commit), hard invariants, required tests, non-goals, exit gate. Exit gates are
copied verbatim into the implementing agent's task brief.

---

### K0 — ADR Closure Registry and Evidence Model

**Objective:** one machine-checkable implementation-closure ledger for every
ADR before further architecture work. No runtime changes.

Commit train:

1. `docs(core): define ADR implementation closure protocol` — DecisionStatus,
   ImplementationStatus, closure evidence, supersession, legacy-zero rules.
2. `feat(tooling): add ADR closure registry validator` — parse decisions and
   registry; detect missing, duplicate, orphaned entries.
3. `docs(core): populate closure registry for ADR-024..075` — assign every
   ADR to a closure release with current evidence or recorded uncertainty.
4. `test(architecture): require closure ownership for every accepted ADR` —
   fail on missing target release, evidence owner, or successor.

Invariants: Accepted ≠ implemented ≠ closed; every ADR has exactly one
current closure state and one owning release; a superseded ADR must point to
a verified successor and cannot disappear from the ledger.

Tests: registry parser units; directory↔registry completeness for all 50 ADR
files; negative fixtures (duplicate number, missing successor, unowned
accepted decision).

Non-goals: no production code changes; no certifying existing ADRs from
prose alone.

**Exit gate:** the generated registry is complete, deterministic, committed,
and enforced by the architecture test suite.

---

### K1 — Canonical Green Verification Baseline

**Objective:** establish the exact current truth of build, architecture,
factory-contract, temporal, model, and migration tests on one commit. Later
releases never start from red or unknown.

Commit train:

1. `test(architecture): restore factory-only ratchet target` — create or
   deliberately replace the missing script target referenced by
   `package.json` (verified broken at baseline).
2. `test(factory-contract): isolate the canonical golden-path theorem` — pin
   deterministic fixtures, diagnostics, exit assertions; no production
   semantic change.
3. `fix(core): repair the first bisected deterministic root cause` — one
   verified root cause only, with focused regression test.
4. `ci(core): require all canonical suites on the same SHA` — publish build +
   suite results as one verification manifest.
5. `docs(core): record the green baseline proof` — commands, environment,
   duration, exact SHA into the closure registry.

Invariants: no later release starts from red/unknown canonical suites; no
package script references a missing file; test proof attaches to the exact
reviewed commit.

Required runs: `npm run build`; `test:factory:ratchet`;
`test:architecture`; `test:factory-contract`; `test:factory-temporal`
(concurrency 1); `test:factory-model` + migration smoke.

Non-goals: no authority refactor; no opportunistic cleanup that is not the
verified root cause.

**Split condition:** if bisect reveals more than one independent root cause,
stop after the first repair and create K1.1, K1.2, … Never hide multiple
repairs in one commit.

**Exit gate:** all canonical suites pass from a clean checkout and the
same-SHA verification manifest is stored.

---

### K2 — Legacy Expansion Freeze

**Objective:** prevent new code from importing, calling, persisting, or
documenting known legacy authority paths. The surface may only shrink.

Commit train:

1. `docs(core): publish legacy inventory and temporary ownership map` —
   legacy symbols, SQL patterns, stores, public exports, scripts, each with
   its named future removal release.
2. `test(architecture): add forbidden dependency and symbol ratchets` —
   block new imports/references outside the explicit temporary owner list.
3. `test(schema): add clean-schema legacy snapshot ratchet` — legacy tables
   and columns must decline monotonically.
4. `chore(core): remove dead aliases and stale scripts` — delete paths with
   no production caller; fix package scripts.
5. `docs(core): publish legacy burn-down baseline` — counts and the zero
   target for K20.

Invariants: no new legacy reference may be added; every remaining legacy
reference has one named removal release; the allowlist is count-decreasing
and cannot broaden without a new ADR.

Tests: AST/import boundary tests; SQL pattern scan for latest/recency
selectors in authority packages; public export snapshot; clean-schema
banned-object snapshot.

Non-goals: no broad runtime cutover; no renaming of new concepts.

**Exit gate:** the inventory is complete enough that every future removal can
prove a monotonic decrease.

---

### K3 — Real Handler Implementation Digests

**Objective:** replace placeholder handler references with reproducible
content digests for every installed runtime handler (four manifest
references were recorded as pending at baseline).

Commit train:

1. `test(package): reject placeholder handler references` — pending,
   unknown, or logical-ID-only references fail package installation.
2. `feat(package): compute normalized handler source digests` — hash the
   executable source bundle with stable path normalization.
3. `refactor(manifests): stamp exact digests in all runtime packages` —
   replace the four pending references; centralize construction.
4. `test(package): prove digest reproducibility and sensitivity` — same
   content → same digest; semantic change → different digest.
5. `docs(core): record package identity evidence`.

Invariants: every executable handler has an implementation digest; digest
generation is independent of checkout root and file timestamp; placeholder
references are impossible in production packages.

Tests: cross-directory reproducibility; one-byte source change; manifest
install rejection; clean build uses the same digest as runtime.

Non-goals: resume compatibility behavior unchanged until K5; no toolchain/OCI
fingerprint yet.

**Exit gate:** all installed handler references are real digests; no pending
marker remains outside historical documents.

---

### K4 — Immutable Runtime Package Fingerprint

**Objective:** one canonical digest for the full executable contract of a
lifecycle package.

Commit train:

1. `docs(architecture): decide runtime package fingerprint fields` — freeze
   included identities; explicitly exclude observational data.
2. `feat(package): add RuntimePackageFingerprint` — handler digests,
   input/output schemas, check-plan digest, recovery policy, authority
   policy, config, tool references.
3. `refactor(persistence): persist fingerprint with package pins` — store
   and rehydrate the immutable fingerprint, not a reconstructed current
   package.
4. `test(package): prove canonical serialization` — order, whitespace, host
   path do not affect the digest.
5. `test(architecture): forbid ad hoc compatibility surfaces` — all
   compatibility decisions must consume canonical fingerprint components.

Invariants: one fingerprint = the exact executable contract; immutable after
lifecycle start; no resume caller constructs a private subset of package
identity.

Tests: canonical serialization property tests; schema/policy/check-plan/
handler mutation matrix; persistence and checkpoint round trips.

Non-goals: the incompatible-run policy (restart vs refuse) belongs to K5.

**Exit gate:** every new lifecycle persists one full runtime package
fingerprint and rehydrates it byte-for-byte.

---

### K5 — Resume and Adoption Compatibility Cutover

**Objective:** resume/adoption compatibility depends on the exact persisted
runtime package fingerprint and explicit policy. **Milestone M1.**

Commit train:

1. `test(resume): prove same logical ID with changed code is incompatible` —
   the missing high-risk negative theorem.
2. `refactor(resume): classify exact fingerprint deltas` — typed
   compatible / restart-required / forbidden outcomes with reasons.
3. `refactor(checkpoint): rehydrate persisted package pins before current
   installation` — no silent substitution by whatever is installed now.
4. `feat(lifecycle): route incompatibility to explicit new lifecycle or
   refusal` — terminal and accepted history stay immutable.
5. `test(architecture): remove logical-ID-only compatibility path` — delete
   and ratchet the old classifier surface.
6. `docs(core): close resume ADR cohort` — attach the proof manifest.

Invariants: changed implementation cannot be compatible merely because the
logical ID is unchanged; resume uses persisted pins (current installation is
only a candidate for an explicit compatibility decision); incompatibility
never mutates an existing terminal or accepted lifecycle.

Tests: handler change with same logical ID; schema/policy/check-plan/config/
tool digest delta matrix; crash/checkpoint/resume on an unchanged package;
explicit continuation after incompatibility.

Non-goals: no accepted-material read cutover; no replay capsule change.

**Exit gate:** all resume/adoption paths consume the canonical fingerprint;
no logical-ID-only compatibility call remains.

---

### K6 — Lifecycle-Scoped Accepted Material Query

**Objective:** cut the Formalization settlement vertical from epic-scoped
accumulation to exact lifecycle/workplace production revision references.

Commit train:

1. `docs(architecture): freeze exact accepted material query contract` —
   lifecycle, workplace, production revision, accepted head, expected
   baseline.
2. `test(authority): reproduce cross-lifecycle material contamination` —
   two lifecycles under one epic; prove the old query can mix them.
3. `feat(authority): add exact AcceptedMaterialQuery repository` — immutable
   refs only; reject missing or mismatched scope.
4. `refactor(formalization): cut settlement baseline to exact query` — one
   complete vertical, no fallback retained.
5. `test(authority): add wrong-lifecycle and stale-head negatives`.
6. `chore(authority): delete migrated vertical legacy queries`.

Invariants: the migrated vertical cannot read by epic alone; missing exact
authority is an error, not a request to choose latest; one consumer never
has two accepted-read paths.

Tests: two-lifecycle contamination; wrong workplace/revision, stale head,
missing baseline; crash/retry after exact query before settlement commit.

Non-goals: other read consumers wait for K7 (but are unusable by the migrated
vertical); no replay binder change.

**Exit gate:** Formalization settlement, baseline, and trace data for the
selected vertical derive exclusively from exact lifecycle-scoped authority.

---

### K7 — Baseline and Traceability Accepted-Read Cutover

**Objective:** migrate every remaining accepted-material authority reader and
physically remove epic-scoped and recency-based alternatives.

Commit train:

1. `test(authority): enumerate all accepted-read consumers` — failing
   inventory of remaining authority readers.
2. `refactor(authority): migrate baseline and traceability consumers` —
   exact AcceptedMaterialQuery and accepted heads.
3. `refactor(effects): migrate accepted-material reads before effect
   invocation` — pass exact refs forward; no re-query by task/node/execution.
4. `chore(authority): delete epic-scoped accepted reader APIs and SQL` —
   methods, queries, compatibility adapters.
5. `test(architecture): ban authority ORDER BY time/latest selectors` —
   chronology only in explicit observability projections.
6. `docs(core): close accepted-read cutover evidence`.

Invariants: all accepted-material authority reads require exact lifecycle/
workplace/revision/head identity; chronology cannot select a material
subject; clean code search finds no legacy accepted reader reachable from
runtime authority packages.

Tests: all consumer contract tests; clean vs upgraded DB parity; N/N-1
lifecycle isolation across every stage; negative AST/SQL ratchet.

Non-goals: replay capsule selection is K8; CandidateSet execution ownership
is K10.

**Exit gate:** old reader interfaces and SQL are **deleted, not
deprecated**, and all authority read tests pass.

---

### K8 — Exact Replay Capsule Binder

**Objective:** replace newest-wins capsule selection with exact semantic
replay identity.

Commit train:

1. `docs(architecture): decide replay capsule semantic key` — package
   fingerprint, check plan, workplace product contract, baseline, exact
   source authority.
2. `test(replay): reproduce newest-wins N-2 selection` — three lifecycle
   histories; freeze the failing theorem.
3. `feat(replay): implement exact capsule key and lookup` — zero, one, or
   invariant-violation; never choose by row order.
4. `refactor(dispatch): route replay claims through exact binder` — typed
   ineligible/incompatible outcomes, not engine death.
5. `chore(replay): delete newest-wins binder and recency SQL` — same
   release.
6. `test(replay): prove model choice is not material identity` — routing
   orthogonality preserved.

Invariants: replay selection is semantic, not chronological; more than one
exact capsule = invariant violation; zero exact capsules = typed non-replay
outcome, never permission to select a nearby row.

Tests: N/N-1/N-2 capsule matrix; duplicate exact key; changed package/
check-plan/baseline; concurrent claim and stale lease.

Non-goals: automatic invalidation/regeneration is K9; no CandidateSet schema
change.

**Exit gate:** no replay authority lookup orders candidate capsules by time,
row ID, or newest status.

---

### K9 — Deterministic Invalidation and Third-Lifecycle Theorem

**Objective:** convert replay mismatch into explicit invalidation and
regeneration; certify repeated lifecycle operation. **Milestone M2.**

Commit train:

1. `docs(architecture): define capsule invalidation and regeneration
   grammar` — typed reasons, state transitions, idempotency.
2. `feat(replay): persist immutable invalidation evidence` — bind mismatch
   to exact capsule, package, baseline, lifecycle.
3. `refactor(dispatch): regenerate through normal production path` — never
   mutate the old capsule or inherit its acceptance.
4. `test(temporal): inject crashes at bind, invalidate, regenerate, seal` —
   exactly-once convergence.
5. `test(factory-contract): add canonical third-lifecycle scenario` —
   N, N+1, N+2 on one epic/workplace family.
6. `test(architecture): ban mismatch-to-anonymous-park` — require typed
   repair, regenerate, refuse, or terminal outcome.

Invariants: incompatible replay cannot loop forever or sit in an unowned
park; invalidation is append-only and exact; regenerated production creates
new candidate and gate authority — never edits old accepted history.

Tests: third-lifecycle cold/replay/mismatch matrix; crash after invalidation
before dispatch; crash after regenerated seal before gate; restart from
checkpoint with exact package pins.

**Exit gate:** the third-lifecycle canonical scenario passes from clean and
upgraded databases with no recency selector and no manual repair.

---

### K10 — Remove Execution-Scoped Material Ownership

**Objective:** WorkplaceProductionRevision is the only material owner;
producer execution identity leaves CandidateSet authority.

Commit train:

1. `test(authority): freeze partition-invariance theorem` — A(X+Y) and
   A(X)+B(Y) converge to the same material revision.
2. `refactor(domain): remove producerExecutionRef from material identity` —
   contributor/presenter references survive only as provenance.
3. `refactor(candidate): derive CandidateSet seal key from workplace and
   production revision`.
4. `migrate(schema): drop producer_execution_ref authority column` — one-way
   migration with exact preconditions and backup requirement.
5. `refactor(repositories): remove compatibility readers and writers` — no
   dual schema support in runtime.
6. `test(architecture): ban execution authority fields in material
   packages` — provenance types only.

Invariants: material identity is independent of which worker presented or
contributed it; CandidateSet authority points to one persisted
WorkplaceProductionRevision; execution references cannot enter accepted
material digests.

Tests: partition invariance; multiple contributors + one presenter; crash
between revision seal and CandidateSet seal; upgrade migration and
clean-install schema parity.

Non-goals: effect API cutover is K11; gate-proven acceptance is K12.

**Exit gate:** source, schema, and public domain types contain no
execution-scoped material authority field.

---

### K11 — Authority-Only Post-Acceptance Effects

**Objective:** every post-acceptance effect consumes exact
AcceptedCandidateAuthority and durable effect obligations only.

Commit train:

1. `docs(architecture): freeze authority-only effect contract` — separate
   material decision fields from operational observability fields.
2. `test(effects): prove process/node/task selectors can change the
   subject` — capture the legacy failure class as a negative test.
3. `refactor(effects): replace PostAcceptanceEffectInput` — accepted
   authority, effect identity, expected head, exact operational context.
4. `refactor(git): consume accepted ProductRefs and factory-owned
   repository effects` — no worker-selected merge authority.
5. `refactor(formalization): remove task/execution/latest material
   lookups` — exact accepted refs from the handoff.
6. `test(architecture): ban material re-selection inside effects` — AST and
   SQL ratchets.

Invariants: an effect cannot choose material — it acts on accepted
authority; effect failure cannot revoke or rewrite the accepted Gate
decision; effect repair evidence is exact, immutable, idempotent.

Tests: wrong task/node/execution fields cannot alter the effect subject;
crash before/after provider invocation with exact receipt postcondition; git
conflict produces one recovery issue and no duplicate effect call after
durable settlement.

Non-goals: accepted head hardening is K13; no runtime gateway unification
yet.

**Exit gate:** no post-acceptance effect reads material through process,
task, node, schema, latest submission, or execution identity.

---

### K12 — Gate-Proven Atomic Acceptance Commit

**Objective:** replace payload-driven attempt closure with one proof-backed
acceptance command.

Commit train:

1. `docs(architecture): decide AuthorityCommit proof contract` — exact
   subjects, expected revisions, receipts, transaction boundary.
2. `test(acceptance): add forged and mismatched proof negatives` — wrong
   candidate, gate, check plan, receipt, or expected revision fails without
   mutation.
3. `feat(authority): implement CommitAcceptedCandidate service` — load and
   verify persisted facts; callers pass references, not accepted payload
   truth.
4. `refactor(cell): route final Production Cell acceptance through the
   service` — remove direct accepted-transition capability from the
   executor.
5. `migrate(persistence): atomically commit acceptance facts and
   obligations` — one transaction/outbox boundary.
6. `chore(authority): delete CloseAttempt accepted-payload path` — old
   command and public API removed.
7. `test(temporal): cover every crash point in commit` — zero or one
   authority commit.

Invariants: only a persisted final GateDecision can authorize acceptance;
all required CheckReceipts address the exact CandidateSet and frozen
CheckPlan; acceptance is atomic and idempotent under crash/retry.

Tests: forged gate reference; gate for another CandidateSet; missing
mandatory receipt; stale expected workplace revision; crash before
transaction / during outbox / after commit before acknowledgement.

Non-goals: AcceptedAuthorityHead shape and final settlement identity are
K13.

**Exit gate:** a code search finds one acceptance mutation service and no
caller can supply accepted material truth directly.

---

### K13 — Exact Accepted Head and Obligation Settlement

**Objective:** complete the authority model — one monotonic accepted head,
exact FinalAcceptance identity, exact obligation postconditions.
**Milestone M3 (Authority-Correct Beta).**

Commit train:

1. `test(authority): add same-revision different-refs invariant` — a
   revision number cannot be reused with different accepted identity.
2. `refactor(authority): extend AcceptedAuthorityHead` — acceptance ID,
   GateDecision, CandidateSet, production revision, ProductRefs, check-plan
   digest, package fingerprint, baseline.
3. `refactor(final-acceptance): use persisted row identity` — replace
   fabricated final-acceptance aliases with cell-final-acceptance row
   digests.
4. `refactor(obligations): settle by exact source and postcondition` — no
   generic status change can prove effect or routing completion.
5. `test(effects): re-certify ADR-074 repair feedback` — no duplicate
   provider call after exact durable repair receipt.
6. `test(architecture): enforce one accepted head writer` — direct table
   writes outside AuthorityCommit banned.
7. `docs(core): publish authority-correct beta proof` — close the
   material-authority ADR cohort in the registry.

Invariants: same accepted revision ⇒ byte-identical authority identity;
accepted head movement is monotonic and CAS-fenced; FinalAcceptance cites
the exact effect receipt or exact no-effect outcome; generic Workplace
status cannot settle an obligation.

Tests: concurrent acceptance race; duplicate acknowledgement; crash after
accepted head before effect scheduling; effect repair and later candidate
staleness; clean and upgraded schema parity.

Non-goals: old runtime dispatchers remain until Wave 4 but cannot write
accepted authority after this release.

**Exit gate:** the authority closure suite passes and every accepted write
is attributable to one Gate-proven AuthorityCommit.

---

### K14 — Single Production Cell Authority Gateway

**Objective:** every authoritative start, execution, transition, and
acceptance path routes through one Production Cell application gateway.

Commit train:

1. `docs(architecture): freeze single authority gateway boundary` — allowed
   callers and worker-provider interfaces.
2. `feat(application): add ProductionAuthorityGateway` — start, resume,
   dispatch command routing, AuthorityCommit access.
3. `refactor(start): route all factory starts through the gateway` — remove
   direct start variants and hidden boot paths.
4. `refactor(modules): compile module definitions into Production Cells` —
   LM/flow/profile mechanisms become capability implementations only.
5. `test(architecture): enforce accepted writer call graph` — only the
   gateway and AuthorityCommit package reach authority repositories.
6. `chore(runtime): delete bypass adapters migrated in this release` — no
   compatibility dispatch route remains.

Invariants: one production authority ingress; worker strategy cannot publish
CandidateSet, Gate, or accepted head outside the cell protocol; all starts
pin the same package, graph, policies, and lifecycle identity.

Tests: each module family through the same gateway; direct repository write
from a legacy adapter fails the architecture test; start/resume/continuation
parity.

Non-goals: unreachable old runtime code may remain until K16; recovery
vocabulary unification is K15.

**Exit gate:** all production entry points use ProductionAuthorityGateway
and no alternate accepted writer is reachable.

---

### K15 — Unified Dispatch, Recovery, and Controller Vocabulary

**Objective:** collapse old and new controller, dispatch, pause, repair,
requeue, fail, and epoch semantics into one typed model.

Commit train:

1. `docs(architecture): freeze canonical dispatch and recovery vocabulary` —
   DispatchOutcome, RecoveryAction, WaitReason, terminal states, ownership.
2. `refactor(dispatch): return one DispatchOutcome union everywhere` —
   eliminate throw-for-card-local and private outcome enums.
3. `refactor(recovery): use fail, pause, requeue consistently` — remove
   legacy `escalate` and module-specific interpretations.
4. `refactor(controller): unify epoch fencing, bootstrap, pump, watchdog
   terms` — one controller state projection, one heartbeat truth.
5. `refactor(quiescence): make pump completion obligation-aware` — exact
   worker completion and durable obligations dominate process drain.
6. `test(temporal): run empty queue, capacity, busy, crash, epoch, total-cap
   matrix` — bounded autonomy and honest terminals preserved.
7. `chore(runtime): delete old recovery drivers and adapters` — duplicate
   state machines removed in the same release.

Invariants: one typed dispatch outcome vocabulary; one recovery action
vocabulary; no anonymous infinite wait or module-name branching; terminal
monotonicity and bounded recovery intact.

Tests: empty queue vs blocked capacity; card-local vs engine failure;
recovery epoch backoff and total cap; supervisor restart and
duplicate-engine prevention; exact worker completion and pending-obligation
quiescence.

Non-goals: physical deletion of unreachable legacy runtime files is K16.

**Exit gate:** only the canonical vocabulary appears in runtime types, logs,
API projections, and operator documentation.

---

### K16 — Delete Legacy Runtime Code

**Objective:** physically remove alternate flow state machines, direct
dispatcher mutations, legacy stores, and authority-capable adapters.
**Milestone M4 (Legacy-Free Runtime RC).**

Commit train:

1. `test(architecture): freeze zero-reachability proof for legacy runtime` —
   exact files, symbols, and call edges scheduled for deletion.
2. `chore(runtime): delete old transition machines and direct dispatcher
   writes` — production code, not only exports.
3. `chore(runtime): delete dual stores and compatibility application
   services` — offline migration code retained only where K17 requires it.
4. `refactor(composition): remove legacy composition branches and feature
   flags` — one production composition root.
5. `test(factory-contract): rerun all module families through canonical
   runtime` — behavior proven after physical deletion.
6. `test(architecture): set runtime legacy allowlist to zero`.
7. `docs(core): publish legacy-free runtime RC evidence` — deleted surfaces
   and remaining schema/API debt for K17.

Invariants: the production binary contains one state machine and one
authority composition; no feature flag restores old runtime behavior;
offline migration code is not imported by runtime packages.

Tests: full factory-contract and temporal suites after deletion; bundle/
import graph scan; no legacy environment variable changes runtime authority
behavior; cold start, resume, replay, repair, release smoke.

Non-goals: legacy DB objects and public exports are K17; performance tuning
is K18.

**Exit gate:** runtime legacy count is zero and the canonical suites pass
without deleted files, aliases, or flags.

---

### K17 — Delete Legacy Schema, Public API, and Operational Surface

**Objective:** remove old authority tables, columns, exports, CLI verbs,
environment flags, scripts, and misleading product metadata.

Commit train:

1. `feat(migration): add one supported offline upgrade path` — validate
   source schema, backup, migrate exact data, verify counts and digests,
   drop legacy objects.
2. `migrate(schema): remove legacy tables, columns, triggers, indexes` —
   clean and upgraded schema converge structurally.
3. `chore(api): remove deprecated exports, aliases, compatibility types` —
   publish the new major-version surface only.
4. `chore(cli): remove legacy flags, scripts, operator commands`.
5. `docs(product): align README, package metadata, diagrams, terminology` —
   one Production Cell kernel, not coding-agent legacy history.
6. `test(migration): prove clean-install and upgrade parity` — data lineage
   and rollback rehearsal.
7. `test(architecture): set schema and public legacy allowlists to zero`.

Invariants: runtime schema contains no legacy authority object; public API
contains no deprecated authority alias; upgrade code is offline,
version-bounded, absent from the runtime dependency graph.

Tests: supported old→new schema migration; interrupted migration restore;
clean vs upgraded structural and semantic parity; public API snapshot and
CLI help snapshot.

**Exit gate:** source, schema, API, CLI, scripts, configuration, and
documentation all pass zero-legacy ratchets.

---

### K18 — Persistence, Connection, and Checkpoint Discipline

**Objective:** remove residual database busy-risk (per-call connections,
five-second busy windows outside the hardened loop) and reduce checkpoint
work to meaningful state changes.

Commit train:

1. `test(persistence): reproduce residual per-call connection contention` —
   worker execution writes and controller loop single writes.
2. `refactor(persistence): centralize runtime connection and transaction
   policy` — bounded busy handling, explicit readonly probes.
3. `refactor(checkpoint): capture on durable state change, not every loop` —
   retention and crash guarantees preserved.
4. `refactor(outbox): standardize transaction/outbox convergence helpers` —
   remove one-off settlement transaction code.
5. `test(load): concurrent controller, worker, checkpoint, observer stress` —
   measure stalls, retries, recovery.
6. `docs(operations): publish connection and checkpoint SLOs`.

Invariants: every runtime DB access follows one connection/busy policy;
checkpoint creation cannot block the engine loop in-process; no unchanged
loop iteration creates a new full checkpoint.

Tests: contention and busy-budget; checkpoint crash and retention;
controller restart under concurrent observer load; long autonomous recovery
disk-growth.

Non-goals: no new domain functionality; no material authority semantic
change.

**Exit gate:** stress tests show bounded waits, state-change checkpointing,
and no silent engine freeze attributable to database connection policy.

---

### K19 — Readiness and Toolchain Package Identity

**Objective:** bind execution environment preparation and post-integration
certification to the same immutable runtime package model.
**Milestone M5 (Legacy-Free Product RC).**

Commit train:

1. `docs(architecture): freeze capability and readiness fingerprint
   contract` — tool, container, environment, license, validator evidence.
2. `refactor(readiness): isolate Python readiness in ephemeral
   environments` — no shared mutable venv authority.
3. `refactor(environment): prepare one exact OCI environment per pinned
   package` — persist image and dependency digests.
4. `refactor(certification): make post-integration readiness a Production
   Cell` — immutable CheckReceipts against exact accepted subjects.
5. `test(readiness): prove environment drift invalidates compatibility` —
   same logical tool name with changed image/dependency digest is
   incompatible.
6. `docs(core): close readiness ADR cohort`.

Invariants: toolchain implementation is part of package identity; readiness
checks address exact candidates and accepted revisions; environment
preparation is isolated and reproducible.

Tests: ephemeral venv isolation; OCI image digest change; validator version
drift; post-integration certification replay and crash recovery.

Non-goals: no general Domain Pack SDK — that belongs to the Controlled
Change Plane / domain roadmap.

**Exit gate:** the same pinned package reproduces handler, tool,
environment, and readiness evidence across clean hosts.

---

### K20 — Legacy-Free Kernel Certification and General Availability

**Objective:** prove the complete kernel on clean install, supported
upgrade, replay, resume, recovery, effect, and concurrency matrices; close
the ADR registry. **Milestone M6 — Core 3.0 GA.**

Commit train:

1. `test(certification): add legacy-zero source/schema/API/bundle proof` —
   all allowlists zero; historical migration code isolated.
2. `test(certification): run canonical clean and upgrade scenario matrix` —
   cold, resume, replay, third lifecycle, repair, acceptance, effects,
   release, restart.
3. `test(certification): run authority fault-injection matrix` — crash
   every durable boundary; prove zero-or-one convergence.
4. `test(certification): run concurrency and watchdog endurance matrix` —
   multiple workplaces, capacity, busy, recovery epochs, freeze, restart.
5. `docs(core): close or supersede every ADR entry` — exact test commands,
   artifacts, reviewer verdicts.
6. `chore(release): publish Core 3.0 migration and rollback package` —
   version, release notes, support boundary, runbook.
7. `docs(architecture): declare the legacy-free kernel baseline` — the new
   starting point for Controlled Change Plane C0.

Invariants: all 50 existing ADRs (plus program closure ADRs) reach a
terminal closure state with evidence; legacy counts zero across runtime,
schema, API, CLI, scripts, docs; clean and upgraded systems produce the
same authority semantics; no certification claim rests on an unverified
model statement.

Required scenarios: canonical reject-repair-accept; third and fifth
lifecycle; same logical ID with changed handler/tool implementation;
cross-lifecycle contamination negatives; crash matrix around revision,
candidate, gate, acceptance, effect, final acceptance, checkpoint,
migration; long endurance and disk retention.

Non-goals: no Change Intent, impact graph, NL Change Desk, or engineering
domain pack is implemented here.

**Exit gate:** Tier 4 verification passes on one release-candidate SHA, the
operator accepts the proof bundle, and Core 3.0 is tagged.

## 6. ADR implementation closure program

### 6.1 Closure states

Unassessed → Planned → In Progress → Implemented → Closed; plus Superseded
(verified successor) and Rejected (rationale + replacement path).

> **Closure theorem:** an ADR is Closed only when the system would fail a
> deterministic test or architecture ratchet if the prohibited old behavior
> were reintroduced. Prose alignment is evidence but never sufficient.

### 6.2 Required closure evidence

Exact decision file (+ amendments/successors); implementation commit or
bounded commit train; positive unit/property test; negative test or ratchet
for the prohibited legacy behavior; replay/temporal/migration/fault test
when durability is affected; clean-install + upgrade proof when persistence
changes; public API/operator docs proof when the surface changes;
independent reviewer verdicts per risk tier, all on the same SHA.

### 6.3 Closure matrix (ADR → owning releases → principal proof)

| ADR | Topic | Releases | Principal proof |
|---|---|---|---|
| 024 | Factory checkpoint, resume, adoption | K5, re-cert K18 | Exact package rehydrate, compatibility matrix, checkpoint stress |
| 025 | Single factory start gateway | K14 | One gateway call graph; start/resume parity |
| 028 | Atomic WorkIntent/Workplace settlement | K12–K13 | Atomic AuthorityCommit; exact obligation postconditions |
| 029 | Production Cell runtime cutover | K14–K16 | Canonical gateway then physical legacy runtime deletion |
| 030 | Workplace-native Production Cell execution | K14–K16 | All module families via Workplace/Cell execution only |
| 031 | Target-only factory runtime | K16–K17 | Zero runtime, schema, API, CLI legacy surface |
| 032 | Development integrated candidate | K10–K13 | Workplace revision CandidateSet; Gate-proven acceptance |
| 033 | Durable submission preflight recovery | K5 | Pinned package rehydrate; explicit incompatibility |
| 034 | Rehydrate nonterminal package pins | K5 | Persisted fingerprint used before current install |
| 035 | Replay sealed candidate after provider-plan failure | K8–K9 | Exact capsule identity; crash-safe regeneration |
| 036 | Durable live concurrency admission | K15, re-cert K18 | Unified outcomes; controller fencing; persistence stress |
| 037 | Recover terminal development in place | K15 | Canonical continuation/recovery vocabulary; terminal monotonicity |
| 038 | Continue from accepted stage prefix | K8–K9 | Exact accepted prefix; repeated lifecycle theorem |
| 039 | Model produces text; Factory owns Git | K11 | Authority-only Git effect; exact ProductRefs |
| 040 | Recovery as one authority-complete vertical | K12–K13 | One Gate-proven commit; exact effects/final acceptance |
| 041 | Carry author production across terminal continuations | K8–K10 | Exact replay + Workplace-only material identity |
| 042 | Provider-led candidate verification | K10–K13 | Exact candidate, CheckReceipts, Gate proof |
| 043 | Verification-only continuation | K8–K9 | Exact capsule/accepted-prefix under continuation |
| 044 | Append-only local release continuation | K8–K9 | Append-only invalidation/regeneration; immutable history |
| 045 | Product revisions, change requests, DevOps split | K11–K13 | Product authority separated from effects and release |
| 046 | Empty queue streak vs Workplace recovery | K15 | One dispatch and wait vocabulary |
| 047 | Workplace recovery driver and pause boundary | K15 | Canonical pause/requeue/fail ownership |
| 048 | Temporal conformance over canonical composition | K9, final K20 | Third-lifecycle and full crash matrix on canonical composition |
| 049 | Production-wired temporal and dual-cycle model | K9, K15–K16 | Exact replay; removal of dual runtime cycles |
| 050 | Bind review products to exact candidate authority | K12–K13 | Gate proof addresses exact CandidateSet and revision |
| 051 | Enforce source scope before review | K12–K13 | Exact source refs; negative mismatch tests |
| 052 | Freeze atomic acceptance criteria | K12–K13 | Frozen CheckPlan and receipt identity in AuthorityCommit |
| 053 | Workplace production revision as accepted authority | K6–K13 | Exact reads, replay, ownership, effects, Gate commit, accepted head |
| 054 | Epoch-fenced factory controller terms | K15, re-cert K18 | Unified controller/epoch state; persistence stress |
| 055 | Execution-scoped author repository desks | K10 | Execution out of material authority; provenance remains |
| 056 | Controller bootstrap pre-spawn recovery | K15, re-cert K18 | Canonical bootstrap/watchdog; contention tests |
| 057 | Reviewer subject boundary | K12–K13 | Exact Gate/Candidate subject proof |
| 058 | Local runnability before human acceptance | K11, final K19 | Factory-owned effects; readiness certification receipts |
| 059 | Current repair production must be explicit | K15 | Typed recovery issue/action; no implicit current repair |
| 060 | Lifecycle handoffs conserve semantic products | K8–K13 | Exact replay, Workplace revision, accepted head continuity |
| 061 | Exact worker completion dominates process drain | K15, re-cert K18 | Obligation-aware quiescence; stress proof |
| 062 | Scope-aware increment review | K12–K13 | Exact subject/scope receipts; Gate proof |
| 063 | Bounded planner repair covers complete graph | K15 | Unified bounded recovery; honest terminal |
| 064 | Cell and profile repair ceilings agree | K15 | Single recovery policy model |
| 065 | Shift-left planning contract, atomic criterion identity | K12–K13 | Frozen check-plan member identity |
| 066 | Freeze canaries until contract state and cutover conformance | K20 | Tier 4 proof before GA canary |
| 067 | Single ProductRef ingress before revision | K10–K13 | Workplace revision; one authority commit path |
| 068 | Isolate Python readiness with ephemeral venv | K19 | Reproducible isolated readiness environment |
| 069 | Readiness profile is implementation submission contract | K4, final K19 | Package fingerprint + readiness evidence |
| 070 | Post-integration readiness certification cell | K19 | Canonical Production Cell; CheckReceipts |
| 071 | Readiness prepares one OCI environment | K19 | Exact environment image and dependency digests |
| 072 | Durable final presentation commitment | K12–K13 | Exact FinalAcceptance row identity; durable commitment |
| 073 | Finish ADR-053 with exact presentation cutover | K6–K13 | Complete exact read, replay, effect, acceptance, head cutover |
| 074 | Post-acceptance effect repair feedback | K11–K13 | Authority-only effect; exact repair receipt; exact obligation settlement |
| 075 | No-human quality loop recovery epochs | K15, final K18/K20 | Unified vocabulary; bounded epochs; endurance proof |

### 6.4 New closure ADRs to create at implementation time

Numbers are allocated when committed, not preallocated here:

1. Implementation closure protocol and legacy-zero certification.
2. Canonical runtime package fingerprint and resume compatibility.
3. Lifecycle-scoped accepted material query contract.
4. Exact replay capsule identity, invalidation, and regeneration.
5. Gate-proven AuthorityCommit and monotonic AcceptedAuthorityHead.
6. Single Production Cell authority gateway.
7. Offline legacy schema migration and runtime compatibility prohibition.

## 7. Verification architecture

### 7.1 Canonical scenario suite

| ID | Scenario | Theorem |
|---|---|---|
| S1 | Clean reject-repair-accept | Author candidate, reviewer rejection, repair, approval, Gate, acceptance, effects, final acceptance |
| S2 | Compatible resume | Crash, checkpoint, same package; no repeated model work where sealed production is reusable |
| S3 | Incompatible resume | Same logical IDs, changed implementation/check plan/tool → explicit new lifecycle or refusal |
| S4 | Third lifecycle | N, N+1, N+2 under one epic; exact baseline and capsule identity |
| S5 | Cross-lifecycle isolation | No accepted material from failed/superseded lifecycle enters current settlement |
| S6 | Effect repair | Accepted Gate stays accepted; exact issue reaches repair worker; no duplicate provider call after durable receipt |
| S7 | Authority race | Concurrent Gate/acceptance attempts converge to one accepted head |
| S8 | Controller endurance | Capacity, empty queue, DB busy, worker crash, recovery epochs, freeze, watchdog restart |
| S9 | Upgrade parity | Supported saga4 schema migrates to the same authority semantics as clean install |
| S10 | Legacy-zero | Source, bundle, schema, API, CLI, scripts, docs contain no callable legacy path |

### 7.2 Fault-injection boundaries

After WorkplaceProductionRevision append before CandidateSet seal; after
CandidateSet seal before check execution; after CheckReceipt persistence
before GateDecision; after GateDecision before AuthorityCommit; inside the
AuthorityCommit transaction and after commit before acknowledgement; before
and after external effect invocation; after EffectReceipt or repair issue
before obligation acknowledgement; after FinalAcceptance before lifecycle
routing acknowledgement; during checkpoint capture, migration, controller
restart, and replay invalidation.

### 7.3 Negative architecture ratchets

- Forbidden import graph from legacy runtime packages.
- Forbidden authority SQL using `ORDER BY` chronology, `LIMIT 1`, task-only,
  node-only, execution-only, or epic-only selection.
- Forbidden direct writes to accepted authority tables.
- Forbidden execution fields in material identity types.
- Forbidden logical-ID-only resume classifier.
- Forbidden missing implementation digest or placeholder manifest reference.
- Forbidden legacy schema object and public export.
- Forbidden package script referencing a missing target.

## 8. Migration, release, and rollback

**Forward-only cutover:** a release may add new-model data before deleting
the old object, but the runtime has exactly one authority path after the
release closes. Migrations are deterministic, version-bounded, and verified
before the old object drops.

**Rollback model:** stop via canonical operator path → capture and verify
DB + repository checkpoint → deploy release and run migration → run the
release smoke theorem before admitting new work → on failure, stop the new
binary, restore the pre-release checkpoint, deploy the previous binary.
**Never** roll back by enabling a legacy authority flag inside the new
binary.

**Supported upgrade boundary:** K17 supports one explicit source family —
the last certified saga4 schema immediately before legacy schema deletion.
Older installations upgrade to that family first.

**Production admission:** each K-release deploys after its own exit gate but
only processes work within guarantees already introduced. New domain
factories remain prohibited until M6. Real-model canaries for
authority-boundary releases require the prior deterministic suite and
risk-tier review.

## 9. Work packaging for coding agents

### 9.1 Standard agent brief

Exact base commit and clean-worktree requirement; one release ID and one
primary invariant; files in scope and explicitly out of scope; existing ADRs
and the new/amended decision to read first; one canonical failing theorem or
negative ratchet; ordered commit train with a stop after every commit;
commands that must pass and evidence to capture; explicit non-goals and
split conditions.

### 9.2 Execution rule — one commit, one proof

After every commit the agent runs the narrow tests for that commit and
summarizes the changed invariant. Broad suites run at the release boundary.
Never continue after a failed proof by accumulating speculative fixes.

### 9.3 Agent stop conditions

- The task requires changing a second authority model not named in the
  release.
- A migration needs a compatibility reader or dual writer to pass tests.
- The failing theorem has more than one independent root cause.
- The change requires more than one new durable entity family.
- A public API change was not included in the release decision.
- The agent cannot explain which old path will be physically deleted.
- The narrow test is nondeterministic or depends on a live external model.

## 10. Production milestones

| Milestone | Release | Meaning | Allowed production use |
|---|---|---|---|
| M0 — Safe Remediation Base | K2 | Green current truth; registry + legacy freeze active | Architecture work continues under ratchets |
| M1 — Deterministic Resume | K5 | Exact handler/package fingerprint; explicit compatibility | Production resume/adoption with certified package identity |
| M2 — Exact Material Selection | K9 | Lifecycle-scoped reads; exact replay through third lifecycle | Repeated lifecycle operation production-admissible |
| M3 — Authority-Correct Beta | K13 | Workplace-only authority; authority-only effects; Gate-proven acceptance; exact head | Limited production beta on the existing software factory |
| M4 — Legacy-Free Runtime RC | K16 | One runtime, one recovery vocabulary in the binary | Release candidate; no new domain packs |
| M5 — Legacy-Free Product RC | K19 | Schema/API legacy removed; persistence and environment hardened | Clean and upgraded staging canaries |
| M6 — Core 3.0 GA | K20 | Full certification; ADR closure registry complete | Controlled Change Plane implementation may begin |

## 11. Risks and program-level stop conditions

| Risk | Failure mode | Containment |
|---|---|---|
| Hidden dual authority | A removed caller is replaced by another latest/epic/task selector | Authority SQL ratchet; one accepted-read package |
| Oversized release | One agent closes an ADR family plus unrelated cleanup together | File/LOC/entity limits; mandatory split condition |
| Migration safety | Old data cannot be mapped exactly to new identity | Fail migration before mutation; backup + explicit quarantine report |
| Test illusion | New architecture passes isolated tests while production composition uses the old path | Call-graph ratchet; full factory-contract scenarios |
| Resume illusion | Logical IDs stable while implementation changes | Implementation/tool digests; negative compatibility matrix |
| Replay loop | Mismatch parked or retried without ownership | Typed invalidation/regeneration; total attempt ceiling |
| Legacy by documentation | Code clean but operators still use old verbs and flags | K17 CLI/docs/public surface zero ratchet |
| Token explosion | Multiple deep agents repeatedly audit the whole repository | Risk-tier verification; bounded release briefs |

**Program-level stop conditions:** canonical suites not green on the current
release base; a release cannot identify the exact old path it will delete;
the cutover needs simultaneous changes to more than one unrelated authority
boundary; clean-install and upgrade semantics diverge; a new feature or
domain requirement is introduced to justify a core refactor; an ADR closure
claim lacks a negative regression or ratchet.

## 12. Interface with the Controlled Change Plane

This program refines and decomposes C0 — Authority Ratchet from the
Controlled Change Plane roadmap. **K0–K20 are the normative core path.**
Change Plane work begins after M6 (Core 3.0 GA); its C0 then becomes a short
integration acceptance release consuming the certified Baseline/Authority
APIs and proving no Change Plane component bypasses them:

```
Saga Core Renewal K0–K20
  -> Core 3.0 legacy-free certification
    -> Controlled Change Plane C0 integration acceptance
      -> C1+ baseline, change, traceability, impact, domain releases
```

New domain workshops are deliberately postponed: each new domain would
otherwise multiply the same unresolved authority and replay seams and make
their later removal more expensive.

## 13. First step

K0 — the ADR closure registry. No runtime change, no risk, and it creates
the evidence machine every later release depends on. K1 immediately after
it restores the broken ratchet target and pins the same-SHA green baseline
that all cutover work will stand on.

---

## Appendix A. Legacy-zero certification checklist

- Runtime import graph contains no legacy state machine, dispatcher,
  accepted writer, or compatibility composition.
- Authority SQL contains no latest/newest/recency selection and no epic-only,
  task-only, node-only, or execution-only subject selection.
- Material domain types contain no producer execution authority.
- Resume compatibility includes exact handler and tool implementation
  digests.
- CandidateSet always points to a persisted WorkplaceProductionRevision.
- Only AuthorityCommit writes accepted authority and AcceptedAuthorityHead.
- Effects consume exact AcceptedCandidateAuthority and settle through exact
  receipts.
- Replay uses exact capsule identity and deterministic
  invalidation/regeneration.
- Recovery uses one vocabulary and bounded epochs.
- Clean schema contains no legacy authority table, column, trigger, or index.
- Public API, CLI, package scripts, environment flags, README, and diagrams
  contain no supported legacy mode.
- Offline upgrade code is excluded from runtime bundles and dependency
  graph.
- All canonical clean, upgrade, fault, replay, resume, concurrency, and
  endurance scenarios pass.
- All ADR registry entries have a terminal closure state and exact evidence.

## Appendix B. Standard release packet

| Field | Content |
|---|---|
| Release ID | Kx + human-readable name |
| Base SHA | Exact starting commit |
| Primary invariant | One sentence — the newly guaranteed property |
| ADR scope | Decisions closed/re-certified; new/amended decision |
| Legacy removed | Exact symbols, SQL, schema, API, files deleted |
| Commit train | Ordered commits, each with narrow proof |
| Migration | Preconditions, backup, forward migration, restore procedure |
| Tests | Narrow tests, broad suites, fault cases, negative ratchets |
| Evidence manifest | Commands, environment, results, exact SHA, reviewer verdicts |
| Non-goals | Explicitly deferred work |
| Exit gate | Binary condition for merge and production admission |
