# G3 — Merge-grant conflict dossier: worker_merge tools vs the factory-owned git-integration effect

- **Date:** 2026-08-18. Branch `saga4`.
- **Task:** stage-6 G3 (`docs/handoff/STAGE-6-AGENT-BRIEF.md`). READ-ONLY evidence
  gathering; no code was modified.
- **Purpose:** the architect decides. This dossier prepares the five inputs the
  decision needs. It does not recommend.

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
