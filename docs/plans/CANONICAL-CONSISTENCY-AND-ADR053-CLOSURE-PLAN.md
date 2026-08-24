# Canonical Consistency and ADR-053 Closure Plan

## Objective

Produce one clean `saga4` line that contains every accepted implementation
slice, no unreviewed branch-only authority, no dead Discovery production
legacy, and an evidence-backed decision on ADR-053 closure. Do not count a
historical live run, a mutable-DB continuation, or a green self-derived test as
qualification evidence.

## Current truth

- [x] Canonical integration branch exists: `integration/canonical-2026-08-24`.
- [x] `saga4`, Elite incident repairs, exact task-shadow binding, ADR-095
  Phase 4, ADR-095 Phase 5, and the CC-GAP7A execution slice are integrated.
- [x] Elite regressions in replay routing, model-quota admission, and liveness
  were corrected on the canonical line.
- [x] Discovery production legacy source/resources and fresh-schema closure
  were removed. Existing databases are not destructively migrated.
- [x] The canonical source was clean-built after the Discovery cutover.
- [ ] ADR-095 Phase 6 is unfinished in
  `D:/Development/saga-mcp-DISCOVERY-P6` and has six modified fixture files.
- [ ] The snapshot corpus port has three commits plus two modified files in
  `D:/Development/saga-mcp-SNAPSHOT-PORT`.
- [ ] `saga4` has not yet been fast-forwarded to the canonical line.
- [ ] ADR-053 is not closed: its document says `Status: Proposed`; the closure
  registry says `decisionStatus: proposed`, `closureState: in-progress`.
- [ ] ADR-053 exit criterion 10 (clean scripted E2E and clean real canary from
  a fresh DB and repository, without old-process/reload dependence) has no
  accepted evidence.

## Agent operating rules

- [ ] Work in an isolated worktree and a dedicated branch based on the exact
  canonical SHA supplied in the task.
- [ ] Never modify the live Elite worktree, its DB, `dist`, workers, watchdogs,
  or processes.
- [ ] Never invoke the Claude CLI. Use the repository OpenCode shim where an
  external coding agent is required.
- [ ] Read `AGENTS.md` and all four mandatory conveyor/ADR-053 documents before
  changing production code.
- [ ] Do not weaken an oracle to make a suite green. Record a counterexample
  and repair production behavior or the objectively false fixture.
- [ ] Keep every commit reviewable and scoped to one phase.
- [ ] Report exact commands, pass/fail/skip counts, commit SHA, and remaining
  gaps. A landing is not an exit.
- [ ] Do not delete worktrees that contain a `node_modules` junction. The
  canonical, Discovery P4, and Discovery P5 junctions target the `saga4`
  dependency tree and must be unlinked safely before worktree removal.

## Phase 1 — Finish ADR-095 Phase 6

Starting material: `D:/Development/saga-mcp-DISCOVERY-P6`, currently based on
`1f4630a9`, with six modified factory-contract/E2E fixture files. The current
canonical line is newer and includes CC-GAP7A.

- [ ] Inspect and explain every existing modification before rebasing or
  recreating it; do not discard the interrupted work.
- [ ] Rebase or transplant the Phase-6 work onto the current canonical head.
- [ ] Remove all Discovery-scoped legacy allowlist entries; do not require the
  unrelated global allowlist to be empty.
- [ ] Prove all eight ADR-095 ratchets on the post-Phase-5 tree.
- [ ] Execute and record deliberate RED/GREEN mutations for:
  - [ ] dead handler reference;
  - [ ] legacy tool import;
  - [ ] projection write;
  - [ ] legacy `CREATE TABLE`;
  - [ ] stale manifest pin at the old module version.
- [ ] Run the six ADR-095 blocker suites without weakening assertions.
- [ ] Run a clean build, matrix coverage, architecture group, Discovery live-v2
  group, migration-conformance, and the relevant process-module group.
- [ ] Update ADR-095 registry/tracker state only if every Phase-6 exit item is
  genuinely met. Do not claim full-factory qualification.
- [ ] Commit Phase 6 and provide a closure evidence table mapping every ADR-095
  exit item to an executable proof.

Exit criteria:

- [ ] Working tree clean.
- [ ] No Discovery legacy source/resource/fresh-schema residue.
- [ ] No stale test fixture requires a deleted six-handler runtime package,
  except the explicit frozen retired-package compatibility fixture.
- [ ] ADR-095 registry truth matches executable evidence.

## Phase 2 — Finish and review the zero-token snapshot corpus

Starting material: `D:/Development/saga-mcp-SNAPSHOT-PORT`.

- [ ] Review the three existing port commits:
  `1bf9b751`, `37c50a67`, and `5bc75d26`.
- [ ] Inspect and finish the two modified files; do not discard interrupted
  fixes.
- [ ] Confirm the harness is a replay/corpus regression, not a semantic product
  oracle and not a replacement for a real worker spawn.
- [ ] Pin fixture provenance, build SHA, schema/version compatibility, and
  expected transition trace.
- [ ] Prove the harness reaches Development with zero model tokens.
- [ ] Add negative cases for corrupted capsule/material, missing package bytes,
  invalid transition order, and stale authority identity.
- [ ] Ensure the suite is hosted by a blocking matrix group and protected by a
  per-file removal/de-hosting guard.
- [ ] Commit the final port on a current canonical base.

Exit criteria:

- [ ] Focused corpus suite green.
- [ ] At least one deliberate fixture mutation is red.
- [ ] No ancient production code or stale branch history is merged wholesale.

## Phase 3 — ADR-053 closure audit

Treat implementation completeness and formal ADR closure as separate claims.

### 3.1 Decision state

- [ ] Decide whether ADR-053's normative decision is accepted as written or
  needs a short superseding addendum. Do not change `Proposed` to `Accepted`
  mechanically.
- [ ] Reconcile the ADR document, decision journal (if required), closure
  registry, release ownership, and current code vocabulary.

### 3.2 Re-evaluate all ten exit criteria

- [ ] EC-1: `PostAcceptanceEffectInput` has no execution-owner authority.
- [ ] EC-2: no post-seal material consumer selects by execution, task, node,
  chronology, or `latest`.
- [ ] EC-3: every CandidateSet binds an immutable Workplace production
  revision.
- [ ] EC-4: execution identity is provenance-only (`presenterRef`) or absent
  from accepted-material authority.
- [ ] EC-5: typed, managed, and Git production normalize to one core material
  contract.
- [ ] EC-6: document/container format and atomic members are bound once in a
  versioned manifest.
- [ ] EC-7: workshop capabilities come from one installed manifest.
- [ ] EC-8: every cross-machine handoff has a durable obligation or atomic
  outbox.
- [ ] EC-9: Run-011 is represented by a general partition-invariance theorem.
- [ ] EC-10: clean scripted E2E and clean real canary start from a new DB and
  repository with no dependency on old processes, mutable accumulated state,
  or hot-swapped `dist`.

For every item:

- [ ] Name the production owner file(s).
- [ ] Name the positive proof.
- [ ] Name a deliberate mutation that must fail.
- [ ] State whether the proof is blocking and CI-hosted.
- [ ] Mark `MET`, `PARTIAL`, or `OPEN`; never infer closure from aggregate test
  counts.

### 3.3 Cross-boundary authority search

- [ ] Parse complete SQL literals and find authority reads using `latest`,
  descending chronology, task/execution/node scope, aggregate maxima, or
  window ranking.
- [ ] Inspect all material decoder/encoder boundaries for representational
  drift and fallback authority.
- [ ] Verify task-shadow exact binding for author and current reviewer
  generation across lifecycle runtime and engine adoption.
- [ ] Verify replay invalidation preserves typed evidence while preventing an
  infinite replay loop.
- [ ] Verify effects consume only sealed authority and cannot reselect a
  decoy.
- [ ] Verify old Discovery tables in existing DBs are inert history, not a
  readable fallback.
- [ ] Verify CC-U2: warrant-oracle commands are pinned to installed
  workshop/package authority rather than candidate-produced declarations.
  Record this as a separate open authority gap if it is not part of ADR-053's
  original scope; do not silently fold it into a closure claim.

### 3.4 Closure decision

- [ ] Close ADR-053 only if all ten exit criteria are `MET`, every principal
  proof is blocking/hosted, and the clean real canary satisfies EC-10.
- [ ] Otherwise keep `in-progress` and publish the smallest exact residual
  list. Do not use `implemented in mass` as a synonym for closed.

## Phase 4 — Consolidate remaining valuable work

- [ ] Integrate the completed Phase-6 commit onto canonical.
- [ ] Integrate the reviewed snapshot harness commits onto canonical.
- [ ] Confirm the CC-GAP7A checkpoint is present but still records CC-U2 as
  open.
- [ ] Review `wip/documentation-workshop`; port only current, non-stale
  documentation and archive the old branch if the content is superseded.
- [ ] Preserve the three existing stashes until their ownership/content is
  explicitly classified.
- [ ] Do not merge `repair/snapshot-test-mvp` or other ancient branches
  wholesale after their useful commits have been ported.

## Phase 5 — Verification without a factory run

- [ ] Clean TypeScript build.
- [ ] Architecture group.
- [ ] Acceptance-matrix coverage self-check.
- [ ] Factory-contract group.
- [ ] Process-modules group.
- [ ] Discovery live-v2 group.
- [ ] Readiness-fencing group, including warrant-oracle proof.
- [ ] Replay/capsule focused group.
- [ ] Confirm zero untracked generated journals/evidence files.
- [ ] Record failures as open work; do not quarantine newly red blocking tests
  merely to obtain a green matrix.

## Phase 6 — Make `saga4` canonical and clean branch topology

- [ ] Require a clean canonical worktree and reviewed commit list.
- [ ] Fast-forward `saga4` to the canonical head; no merge commit on `saga4`.
- [ ] Do not touch the live Elite worktree until its engine/workers/watchdogs
  are stopped and final evidence is preserved.
- [ ] Remove the clean contained detached temporary worktree.
- [ ] Before removing canonical/P4/P5 worktrees, unlink only their local
  `node_modules` junctions and verify the `saga4/node_modules` target remains.
- [ ] Archive obsolete CC-GAP2/CC-GAP3 SHAs with tags before deleting their
  amended non-ancestor branches/worktrees.
- [ ] Remove task-shadow, Phase-4, Phase-5, Phase-6, and snapshot-port branches
  only after their commits are ancestors of `saga4` and their worktrees are
  clean.
- [ ] Preserve or archive unique stale documentation work deliberately.
- [ ] List remaining worktrees/branches and explain every survivor.

Exit criteria:

- [ ] `saga4` points to the reviewed canonical head.
- [ ] No valuable unique commit exists only on a disposable branch.
- [ ] No dirty worktree is deleted.
- [ ] The live Elite worktree is either explicitly preserved as live or stopped
  and archived by a separate operator decision.

## Phase 7 — Qualification (separate authorization)

Do not execute this phase as part of code/branch consolidation.

- [ ] Freeze one immutable source/package/capsule/`dist` build.
- [ ] Run clean scripted E2E from a fresh DB/repository.
- [ ] Run the clean real canary required by ADR-053 EC-10.
- [ ] Run the bounded ADR-096 qualification/kill gate.
- [ ] Only after evidence review, sign ADR-053 closure or publish its exact
  remaining counterexample.

## Final deliverables

- [ ] One canonical `saga4` commit SHA.
- [ ] Clean branch/worktree inventory.
- [ ] ADR-095 Phase-6 evidence table.
- [ ] Snapshot corpus provenance and mutation report.
- [ ] ADR-053 ten-item closure matrix.
- [ ] Explicit ADR-053 verdict: `CLOSED` or `IN-PROGRESS` with exact residuals.
- [ ] No claim of stable autonomous factory operation without the separately
  authorized immutable-build qualification runs.
