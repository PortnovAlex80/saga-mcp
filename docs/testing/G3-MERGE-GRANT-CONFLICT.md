# G3 — Merge-grant conflict dossier: worker_merge tools vs the factory-owned git-integration effect

- **Date:** 2026-08-18. Branch `saga4`.
- **Task:** stage-6 G3 (`docs/handoff/STAGE-6-AGENT-BRIEF.md`). READ-ONLY evidence
  gathering; no code was modified.
- **Purpose:** the architect decides. This dossier prepares the inputs the
  decision needs. It does not recommend.
- **Deep dive (2026-08-18, operator-requested):** sections 6–8 deepen the base
  dossier (§1–5) from three orthogonal perspectives — the normative audit
  (what the governing documents require, in their own words), the runtime
  physics (what actually happens in every interleaving, per the code), and the
  surgery map (exactly what a removal touches, and what keeping the grant
  costs). Every load-bearing claim was independently spot-checked in source
  before inclusion.

---

## 1. What the code does today — the grant is live on the lifecycle path

`worker_merge_acquire` and `worker_merge_release` are granted to the development
workshop's workers through `COMMON_WRITE_TOOLS`
(`src/process-modules/modules/development/development-process-module.ts:80-87`),
which is the `allowedTools` of four execution profiles in the same module:

- `development-implementation-worker` (`:483`, `executionMode: 'git_change'`)
- `development-implementation-reviewer` (`:503`)
- `development-readiness-certifier` (`:523`)
- `development-verification-worker` (`:543`)

This is NOT legacy board code. The consumption chain is the live lifecycle:
the module is registered at `src/modules/development/index.ts:234`, consumed by
the runtime's `ProcessModuleRegistry` (`src/app/product-lifecycle-runtime.ts:406`),
resolved through `execution-profile-resolver.ts:27,43`, flows into the launch
spec's `allowedToolIds` (`agent-launch-spec.ts:254`) and the effective set is
the least-privilege intersection (`capability-enforcement.ts:235-266`). Runtime
proof: the golden run's `agent-assistance.json` shows the literal
`allowed-tools` string `… worker_done, worker_merge_acquire, worker_merge_release,
verification_record, product_submit, Write, Edit, Bash` delivered to each
`implement-work-items` worker
(`tests/golden-runs/production-run-001-20260812/artifacts/development/projects/1/executions/node-implement-work-items/…/agent-assistance.json`).

The platform layer grants them independently of the module profile:
`capability-packages.ts:424-432` contributes `platform.worker_merge_acquire`
(IDEMPOTENT_WRITE) and `platform.worker_merge_release` (WRITE), and the package
description (`:448`) advertises "the merge-lock protocol
(worker_merge_acquire/release)". The lifecycle command service maps both
(`src/lifecycle/application-service.ts:231-232`), and the MCP tools are
registered and implemented in `src/tools/dispatcher.ts:1762-1803`
(handlers at `:2124-2125`).

What the tools actually do (neither performs a git merge itself — the worker
merges via its granted `Bash`; the tools serialize and record):

- `handleWorkerMergeAcquire` (`dispatcher.ts:1326-1425`): requires
  `task.status === 'done'`, execution fence, non-voided execution; writes an
  advisory lock `{task_id, worker_id, acquired_at}` into
  `project_repositories.metadata.merge_lock` (or `projects.metadata`, legacy);
  reclaimable after 10 min only if the holder's PID is dead; contended →
  `{granted: false, retry_after_ms}`.
- `handleWorkerMergeRelease` (`dispatcher.ts:1427-1542`): validates
  `result ∈ {merged, conflict}`; rejects release-without-acquire and
  non-holder release; on `merged` sets `tasks.integration_state='merged'`,
  `integrated_commit`, worktree metadata; on `conflict` sets
  `integration_state='conflict'` + `needs-human` tag.

The lock has no schema enforcement: it lives in JSON metadata
(`src/schema.ts` has no merge_lock table), and the same profile grants `Bash`
against a worktree whose object store is shared with the canonical repository
(ADR-039:22-23).

## 2. What the factory also does — git-integration is a fenced factory effect

The same module, same cell, also declares the factory-owned path.
`development-process-module.ts:263` (inside `implement-work-items`):
`postAcceptanceEffect: 'git-integration'`.

The effect (`src/infrastructure/workplace/git-integration-effect.ts`, registered
at `product-lifecycle-runtime.ts:344-349`) is fenced exactly as the conveyor
model requires:

- material coordinates come ONLY from the authority (ADR-053 B-4, `:27`);
- runs inside the `ExternalEffectLedger` CAS state machine
  (`external-effect-ledger.ts:11-18`:
  `new|executing|succeeded|failed|unknown|retry-authorized|blocked`) with
  claim (`:145-152`) and claimObservation (`:158-165`), leases of 60 s;
- returns the four-valued outcome union
  (`post-acceptance-effects.ts:129-149`: `succeeded | pending | repair_required
  | human_required`); the executor re-queues on `pending`, repairs on
  `repair_required`, parks on `human_required`
  (`production-cell-node-executor.ts:923-1030`), and appends an immutable
  `EffectAttempt` per invocation (`:987-997`);
- performs the merge ITSELF through Git's object database — never the shared
  working tree: `merge-tree --write-tree` → `commit-tree` → `update-ref` CAS,
  then writes the same `tasks.integration_state='merged'` / `integrated_commit`
  columns (`sqlite-production-cell-integration.ts:354-421`; "the ref advance
  below (update-ref CAS) is the authoritative integration"). Conflicts return
  `repair_required` with `PRODUCTION_CELL_INTEGRATION_CONFLICT`.

## 3. Whether both fire on the same card

**No code-level call site and no recorded co-firing found.** Facts:

- The handlers are reachable only via MCP tool calls or the lifecycle command
  service; `handleLifecycleCommand` has no runtime caller in `src/` (only a
  unit test, `tests/lifecycle/application-service.test.mjs:96`). Direct
  handler drives exist only in the legacy board test
  (`tests/dispatcher-race/worktree-isolation.mjs:109-136`).
- The golden run `production-run-001-20260812` contains **zero** occurrences of
  `worker_merge` in worker logs, zero `mcp__saga__worker_merge` strings
  anywhere under the run directory, and **zero** `merge_lock` entries in
  `golden.sqlite` (a successful acquire always writes `meta.merge_lock` + an
  activity row — so no acquire ever happened). The 12 `worker_merge_release`
  strings in the DB are template text from materialized trackers/checklists.
- The worker-facing instructions are nonetheless LIVE and contradictory within
  the same package:
  - prompt rule 7 instructs the merge for git_change review tasks
    (`tracker-view/claude-runner.mjs:374-375`) and rule 8a names both tools
    (`:378`);
  - the pinned tracker template instructs step 8 "Acquire the merge lock with
    worker_merge_acquire, merge into the integration branch, then call
    worker_merge_release" (`implementation-task-tracker.md:36,52`);
  - the pinned checklist requires the same (`implementation-worker-checklist.md:17-19`);
  - the pinned worker skill in the SAME package says the opposite:
    "Call worker_done and stop. The runtime-owned post-acceptance provider
    merges the exact reviewed source commit; an LM must not mutate the
    integration branch or manufacture an integration receipt"
    (`package/resources/skills/saga-worker/SKILL.md:98-100`);
  - repo skills repeat both sides (`saga-dispatch/SKILL.md:110,124` and
    `saga-tracker/SKILL.md:84` describe the merge protocol;
    `saga-code-reviewer/SKILL.md:653-654` forbids the tools for reviewers).
- Design docs already classify the worker path as legacy:
  `tests/factory-contract/design/03-development-scenario-design.md:703-705` —
  "The worker does NOT call worker_merge_acquire/worker_merge_release. Those
  are for the legacy direct-dispatch path; under the Production Cell flow the
  git-integration post-acceptance effect handles merging."
- If both were to fire: the worker path runs after `worker_done(approved)`
  sets `integration_state='pending'` (`dispatcher.ts:866-883`) and before
  exit; the factory effect runs after final-gate acceptance. Both write the
  same `tasks.integration_state` / `integrated_commit` columns and advance the
  same `refs/heads/<integration_branch>`.
- One golden-run tracker shows step 8 CHECKED (`[x] 8. Acquire the merge
  lock…` in worker-execution_0502ed50's tracker) with no recorded handler
  execution — the checkbox is model-prose, not evidence of a call.

## 4. What ADR-039 / K11 require

ADR-039 (`docs/architecture/decisions/039-model-produces-text-factory-owns-git.md`,
status **Proposed**, 2026-08-09):

- The problem statement names this exact state (`:17-25`): "the worker profile
  grants Bash, Write, Edit and the legacy worker_merge_acquire /
  worker_merge_release tools … one tracker still instructs the worker to
  merge, while the current worker skill says only the runtime provider may
  merge".
- Option D (LM owns merge, "possibly using the existing merge-lock tools") is
  rejected (`:87-92`) — "makes fallible model behavior the authority for
  shared external state".
- Decision: Option B (`:221-230`) — the LM "cannot select the authoritative
  base, write Git refs, merge, push or manufacture an integration receipt".
- Follow-up (`:257-258`): "remove `worker_merge_*` from LM profiles and delete
  contradictory merge steps from pinned workspace resources in the new package
  version".
- Expectation (`:278`): "In 30 days: no new Development execution profile
  grants LM merge tools." Check trigger (`:288`): "any proposal to restore
  raw Bash, shared Git worktrees or LM merge tools."

K11 (renewal plan §K11, `docs/vision/SAGA-CORE-RENEWAL-PLAN.md:563`), commit 4
(`:576-577`):

> `refactor(git): consume accepted ProductRefs and factory-owned repository
> effects` — no worker-selected merge authority.

Stage-5 note: ADR-039 remains `decisionStatus: proposed` and was left planned
in the registry reconciliation — its merge-tool removal follow-up is one of
the named missing-evidence items (the 30-day expectation has lapsed with the
grant still live).

## 5. The open question (for the architect)

Is the grant obsolete — and if both paths can fire on the same card, is this
the program's top named risk ("Hidden dual authority", LEGACY-INVENTORY
recency-selector class framing) in a new place?

Framing facts, without recommendation:

1. Two merge authorities are declared in the SAME workshop, same cell: a
   worker-facing protocol (merge-lock tools + Bash + prompt rule 7 + tracker
   step 8) and a fenced factory effect (CAS ledger + authority-only
   coordinates). They write the same columns and the same refs.
2. Only the factory path has recorded firings; the worker path's instructions
   are live in prompts and pinned resources delivered to every
   `implement-work-items` reviewer with `Bash`.
3. The instructions the model receives are self-contradictory (§3), and a
   weaker local model is MORE likely to follow the explicit tracker step 8
   than the skill's prohibition — the exact model-compliance dependence
   stage 6 exists to remove.
4. Removing the grant touches: `COMMON_WRITE_TOOLS`
   (development-process-module.ts:83), prompt rule 7/8a
   (claude-runner.mjs:374-378, pinned by the new G1 test), the pinned
   tracker/checklist resources, the capability-package contributions
   (capability-packages.ts:424-432), the lifecycle command mapping
   (application-service.ts:231-232) — and the ADR-072 typed-submission close
   path is unaffected either way.
5. Keeping it with an updated contract would need: what the merge lock is FOR
   once the effect owns integration (serialization between concurrent worker
   merges that no longer exist on the production-cell path?), and which
  legacy direct-dispatch consumers still rely on it
  (`tests/dispatcher-race/worktree-isolation.mjs` proves the handler pair
  works, but no production caller was found).

---

## 6. Deep dive I — the normative audit (what the governing documents require, in their own words)

Per-document verdicts, each with the deciding quote:

| Document | Verdict | Deciding quote |
|---|---|---|
| CONVEYOR-MENTAL-MODEL.md | **requires removal** | §18 :847-848: "Only a fenced Factory effect may create/update canonical refs, merge, push or issue an integration receipt."; §27 :1305-1306: "CI should mechanically reject at least: … LM profiles that can mutate canonical Git refs, merge or issue integration authority" — a demanded CI ratchet that does not exist today |
| ADR-053 | **silent** on merge authority | B-4 constrains effect INPUTS (material selection), not effect exclusivity or tool grants; the word "merge" appears once, as incident history (:146) |
| ADR-039 | **requires removal, by name** — but Status: Proposed | :257-258: "remove `worker_merge_*` from LM profiles…"; the merge-lock tools appear exactly once — inside the REJECTED Option D (:87-92); the blessed serialization is the Factory CAS queue (:122-123, :215-217) |
| SAGA-CORE-RENEWAL-PLAN.md | **requires removal** (K11 commit 4 :575-577: "no worker-selected merge authority"); §3.3 :123-128 prohibits "Dual writes" during migration | but the top risk "Hidden dual authority" as DEFINED (:1138) is a read-selector problem — the grant fits §3.3's dual-write prohibition better than the risk-table definition |
| LEGACY-INVENTORY.md | **silent — unclassified legacy** | ADR-039 itself labels the tools "legacy" (:19-20), yet no legacy category and no K-release deletion list names them |
| FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md | **partial** | REG-23 :610 puts merge in the effect-only class ("commit/merge/tag/push/publish/deploy — effects"), but REG-08's worker prohibition (:312-315) covers only НЕЗАЯВЛЕННЫЙ (undeclared) effects — worker_merge is a declared preset, lawful under the registry's letter |
| ADR-040 / ADR-032 | **require removal** | ADR-040 :127-128: "Effect correctness and exclusive canonical Git authority are hard release gates"; :188-189 six-month expectation: no profile regains model-owned merge authority. ADR-032 :78-79: "provider-owned CAS merges with monotonic fence tokens and immutable integration receipts" |
| CONVEYOR-TRANSITION-DIAGNOSTICS / -CHECKLIST | silent on integration authority | generic effect-only rules apply |

**The strongest sentence FOR removal** (normative weight + mechanical demand):

> "Only a fenced Factory effect may create/update canonical refs, merge, push or
> issue an integration receipt." — CONVEYOR-MENTAL-MODEL.md:847-848, reinforced
> by §27's demand that CI mechanically reject such profiles (:1305-1306).

**The strongest sentence AGAINST removal** (the letter of the domain registry):

> "Инструменты протокола: … плюс centrally authorized capability preset. —
> НЕ ИМЕЕТ ПРАВА: … выполнять **незаявленный** внешний effect…" —
> FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md REG-08 :312-315: the only worker-side
> external-action prohibition covers UNDECLARED effects; worker_merge is a
> declared, centrally mapped preset.

**Named contradictions between documents:**

1. **PROGRAM-STATUS vs the closure registry.** K11 is recorded closed
   (PROGRAM-STATUS.md:100-108: "input surface and all three effect
   implementations were already authority-only") on an exit gate that covers
   effect READS only (plan :595-596) — while the registry's ADR-039 entry
   (reconciled 2026-08-18 against K11-closed) records the named
   "remove worker_merge_* from LM profiles" follow-up as OUTSTANDING. The
   closure claim and the planned state rest on different criteria.
2. **Registry vs mental model.** A declared merge preset is lawful under
   REG-08's letter and unlawful under CONVEYOR-MENTAL-MODEL §18/§27.
3. **LEGACY-INVENTORY vs ADR-039.** The tools are labeled legacy by the ADR
   that owns them, but appear in no legacy category — outside the only-shrink
   ledger every K-release deletion list is built from.

## 7. Deep dive II — runtime physics: the interleavings (per the code)

Cross-authority isolation is total: the effect has ZERO merge_lock awareness
(grep in sqlite-production-cell-integration.ts and
production-cell-node-executor.ts: no hits), and the release handler never
invokes git at all — `commit_sha` is read as a raw argument (dispatcher.ts:1439)
and written verbatim into `tasks.integrated_commit` (:1503-1508). Neither side
re-validates the other's write. Both facts spot-checked in source.

| Interleaving | Reachable? | Outcome (winning write on integrated_commit) |
|---|---|---|
| **A worker-only** (author done → acquire → Bash merge → release) | YES — the `pending` flip fires at the AUTHOR's own worker_done on the production cell (dispatcher.ts:873-891; live branch, not legacy-only); the window opens BEFORE the factory effect's authority begins and nothing ever closes it (the effect never takes the lock) | worker string, verbatim, zero validation; downstream unblocked on it (claim gating reads only integration_state, work-assignment-core.ts:495-500) |
| **B worker-then-effect** | yes | the effect's short-circuit (integration.ts:293) takes `integration_state==='merged'` ON FAITH — left disjunct before the ancestry check — and OVERWRITES integrated_commit with the OBSERVED head (:294-308), returning succeeded/alreadyApplied with a full receipt; no second merge commit |
| **C effect-then-worker** | yes — acquire needs only status=done + free lock | release overwrites the factory sha UNCONDITIONALLY; no guard compares; drift surfaces only downstream (carry-forward AUTHOR_CARRY_FORWARD_FINAL_EFFECT_DRIFT :309-314; desk-base assertAncestor :272-274) |
| **D concurrent** | yes | git's ref lock serializes; a worker merge mid-effect makes the CAS throw PRODUCTION_CELL_INTEGRATION_TARGET_ADVANCED → ledger unknown → pending → later observation re-stamps the observed head; a worker merge landing between the effect's rev-parse (:354) and CAS (:397) yields a redundant semantically-empty merge commit; on the task row the LAST SQLite writer wins, verbatim |
| **E forgery** — release('merged', 'deadbeef'), no merge | **YES — mechanically possible today** (spot-checked) | 'deadbeef' persists; dependents' desk-base fails hard (EFFECTIVE_DESK_BASE_DEPENDENCY_NOT_IN_HEAD); then the effect LAUNDERS it: the :293 state-check short-circuit writes integrated_commit=<un-advanced branch head> and returns succeeded with a valid durable factory receipt — over a merge that never happened. The source commit is never verified as contained. This is ADR-039's "manufacture an integration receipt", live |
| **F routing check** | reviewer card is tracker_only → `not_required` (dispatcher.ts:892-895); the pending branch belongs to the author's git_change card — the two-writer window is on the LIVE lifecycle | requireProductionCellSubmission is ingress-only (:2098-2101) |

Two further facts frame the decision: `worker_done(approved)` and
`promoteTaskToDone` (work-assignment-core.ts:676-697) are themselves two
independent writers of `integration_state='pending'`; and the only thing
standing between a granted worker and interleaving A/E today is prompt
compliance — the exact dependence stage 6 exists to remove.

## 8. Deep dive III — the removal surgery map, and the cost of keeping

### 8.1 Same-commit work order (removal; groups ordered by coherence)

**Group A — the minimal coherent cut (ungrant, no handler deletion):**

1. development-process-module.ts:83 — delete the two entries from
   COMMON_WRITE_TOOLS (the only live grant; effective tools are the
   profile × authority × driver intersection, capability-enforcement.ts:235-266;
   no test pins the list's contents).
2. capability-packages.ts:424-432 — delete both platform contributions; rewrite
   the three doc strings (:38, :445-451, :511-515).
   **PINS (same commit): tests/process-modules/capability-packages.test.mjs:194-209**
   (deepEqual of the 6 platform tool ids).
3. claude-runner.mjs:378-382 — collapse rule 7 to the plain exit variant; drop
   the two names from rule 8a.
   **PINS (same commit): tests/worker-prompt-assembly.test.mjs:124 (rule-8a
   string) and :182-215 (G1.5 merge-instruction branch)** — that suite exists
   to stop exactly this drift.

**Group B — pinned resources + version (content-addressed, atomic):**

4-5. implementation-task-tracker.md:36,52 and
   implementation-worker-checklist.md:17,19 — delete/reword the merge steps
   (and the stale merge-conflict.json note — the file has no producer in src).
6. product-delivery-module-contracts.ts:42 — bump solution-development
   1.4.3 → 1.4.4.
7. Same commit: add 'solution-development@1.4.4' to the three historical
   literal ladders — composition-root.ts:415-424 (workspace template
   preparers), replay-authority-rebinder.ts:5-12,
   wire-submission-validation.ts:30-37.

**Group C — descriptor/comment hygiene** (dispatcher descriptions/comments,
activity.ts, ids.ts, worker-executor.ts, manifest.json:92-93, MOCK-CLAUDE.md).

**Group D — the deeper cut (handler deletion, only if chosen over ungrant):**
dispatcher.ts handlers/descriptors/map (:1326-1542, :1762-1803, :2124-2125)
and application-service.ts command kinds (:77-78, :132-135, :231-232,
:273-286; no production caller).
**PINS: tests/characterization/mcp-catalog-authority-errors.test.mjs:239-240,
tests/dispatcher-race/worktree-isolation.mjs:109-136,
tests/lifecycle/application-service.test.mjs:96-97.**

**Group E — skills/docs coherence:** agents/saga-worker.md, skills/saga-tracker,
saga-dispatch, saga-explorer (reword to "the factory merges"); saga-code-reviewer
already forbids — keep; mark the ADR-039 follow-up delivered + registry entry.

Not touched by any of this: the 23 frozen capabilities of the
kernel-admission-distance ratchet (platform tool packages are not executable
capabilities — verified against workshop-capability-manifest.ts:196-225); the
development-managed-continuation module already EXCLUDES the tools and is
negative-pinned for it (development-managed-continuation.test.mjs:25-29).

### 8.2 Replay / content-addressing ripple

With the Group B version bump: new installation row under
solution-development@1.4.4; old 1.4.3 installs and capsules resolve against
their pinned immutable bytes; handler digests untouched (resource files are
not handler modules) → **no restart-required storm, no capsule invalidations**
(resume-compatibility-policy.ts:183-239: resource-byte drift with identical
contract surface is `compatible`; only handler-digest drift is
`restart-required`). Golden fixtures are static recorded snapshots — nothing
recomputes their digests, nothing breaks.

### 8.3 Data residue

`merge_lock` lives only in project/project_repositories JSON, read/written only
by the two handlers — inert after ungrant/deletion, no migration needed.
`integration_state='pending'` written by worker_done on the direct-dispatch
path is resolved by the factory effect on the production-cell path. Existing
operator DBs and content-addressed stores keep their historical merge text —
a faithful record, not breakage.

### 8.4 The keep cost (if the grant stays)

1. The in-package contradiction must STILL be fixed with the same
   content-addressed version bump (tracker step 8 + prompt rule 7 vs the
   pinned saga-worker skill :98-100) — the keep path does not avoid Group B.
2. The question "what does the lock serialize once the effect owns
   integration?" has no current answer — the effect ignores the lock entirely.
3. The sync surface (capability advertisement, lifecycle mapping, MCP
   descriptors, manifest.json, rule-8a pin) must be kept coherent forever.
4. A cheap fence short of removal — `git rev-parse --verify <sha>^{commit}`
   inside the release transaction — proves the sha EXISTS, not that the worker
   merged the reviewed content. The effect's accepted-candidate binding
   (authority-only coordinates, exact source commit) is the real anti-forgery
   property; §7-E shows the current state check actively launders a forgery.
   That asymmetry is the strongest single mechanical argument for removal.

---

## 9. Architect's decision (2026-08-18)

Both load-bearing claims re-verified independently against the source before
deciding: the short-circuit at
`src/infrastructure/workplace/sqlite-production-cell-integration.ts:293`, and the
zero-git-verification write in `worker_merge_release`
(`src/tools/dispatcher.ts:1499-1507`), which stamps
`integration_state='merged', integrated_commit=?` from the tool argument with no
`rev-parse`, no ancestry test, and no proof the sha exists.

### The dossier frames one defect. There are two.

The question was posed as "remove the grant, or keep it with an updated
contract". That frame merges the *exploit* with the *laundering machine*. They
are independent and must be decided separately.

**Defect A — the capability grant.** `worker_merge_acquire` /
`worker_merge_release` in `COMMON_WRITE_TOOLS`
(`development-process-module.ts:76-87`). ADR-039 and K11 commit 4 ("no
worker-selected merge authority") are unambiguous, and §18:847-848 states only a
fenced Factory effect may merge or issue an integration receipt. **Remove.**

**Defect B — the state short-circuit.** `task.integration_state === 'merged' ||`
makes a *persisted column* stand as proof of a *physical git fact*, and
short-circuits past the only real proof. **Remove independently.**

### Why B is the load-bearing fix, not A

Fixing only A closes today's exploit and leaves the laundering machine armed.
Any future writer of that column — a migration, an admin override, a repair
path, a restored checkpoint, a operator hotfix — reopens the identical hole
without touching the grant. The receipt would again be manufactured over a merge
that never happened, and `freeze-integrated-candidate` consumes exactly that
receipt.

That is the "fix the symptom, not the cause" failure this whole audit exists to
end. The grant is how the hole is reachable *today*; the short-circuit is why the
hole exists *at all*.

### The replacement semantics

`isAncestor(sourceCommit, targetHead)` is already the correct and complete
idempotency proof: if the reviewed source is an ancestor of the integration
head, the merge is applied; if it is not, it is not. The state disjunct carries
no information the git test lacks — it carries only permission to skip the test.

**The repository is the authority on whether a merge happened. Not a column.**

Delete the left disjunct. Keep ancestry as the sole gate. `alreadyApplied: true`
then means what it says.

### Order of work

**B first, then A.** B is one line and makes the invariant mechanical. A is a
capability removal carrying a package version bump (1.4.3 → 1.4.4), three
historical ladders, and a ripple through pinned skills and the G1 prompt tests
(rule 8a, rule 7) — all enumerated in §8.

With B landed, A stops being urgent: a worker holding the tool can still dirty a
column, but it can no longer cause a fraudulent factory receipt. That converts A
from an incident fix into ordinary scheduled work under its owning release.

### Add the missing ratchet

§27:1305-1306 requires a CI ratchet rejecting execution profiles that grant
fenced-effect tools. It does not exist — which is why the grant survived K11.
Removing the grant without the ratchet means it can return in the next module
someone writes. **The ratchet is part of A, not a follow-up.**

### Flagged, explicitly NOT decided here

The success path writes `integrated_commit = targetHead` — the branch head
observed at effect time, not the merge commit that carried the reviewed source.
Under §9 material identity that may be the wrong coordinate to persist. It needs
the replay/identity lens and its own evidence. **Do not fold it into this
change**; a second question inside an authority fix is how authority fixes go
wrong.

### Program consequence

This reopens K11's exit gate: "no post-acceptance effect reads material through
… execution identity" is not satisfied while the effect accepts a worker-written
state column as merge proof. PROGRAM-STATUS records K11 closed; the registry
records its ADR-039 as `planned`. **The registry is right and the status is
wrong.** K11 cannot be closed while the failure class its own ADR is named after
is live and reachable on the main path.

This is a direct input to the STAGE-5 reconciliation, and it is the first
concrete case proving that reconciliation was necessary rather than tidy-up.
