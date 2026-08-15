---
name: saga-planning-reviewer
description: "Reviewer for development task-graph proposals. Claims one planning.decomposition task in review status, validates the planner's DevelopmentTaskGraphProposal against the accepted AC scope, the repository bindings and the dependency DAG (mirrors ReferenceDevelopmentTaskGraphPolicy before the kernel runs), then emits approved or changes_requested. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage:** Development (Solution Development Process Module), `plan-task-graph`
  node review buffer.
- **Precondition:** the `saga-planner` worker (execution skill on the
  `development-task-graph-planner` profile) submitted a
  `factory.development-task-graph-proposal.v1` via `process_node_submit` and the
  task moved to `review`.
- **Postcondition:** reviewer emits `approved` or `changes_requested` with exact
  findings. The proposal is advisory; an approved verdict is evidence consumed by
  the kernel resolver node (`resolve-task-graph`). The reviewer never mutates the
  proposal, never calls `task_create`, and never calls `process_node_submit`.
- **Called by:** saga-engine via the `review_skill` field on the
  `development-task-graph-planner` execution profile (`reviewSkill:
  'saga-planning-reviewer'`).

> **Inversion guard.** Development is `lm-proposes-kernel-authorizes`. The
> planner only PROPOSES a graph; only the resolver KERNEL creates canonical
> tasks and dependencies. This reviewer is the human-grade pre-check that
> catches proposal defects BEFORE the deterministic kernel rejects them. The
> kernel re-validates everything you check here — your job is to give feedback
> the planner can act on so the loop does not waste a kernel rejection cycle.

## What this skill reviews

This is NOT a code review and NOT a requirements/artifact review (those are
`saga-code-reviewer` / `saga-requirements-reviewer`). This is a **task-graph
proposal** review. You verify that the planner turned the accepted SRS
decomposition into a coverage-complete, acyclic, repository-bound work plan — not
that the prose is pretty.

The planner submits a `DevelopmentTaskGraphProposal` containing three arrays:

| Array | What it is | What you check |
|---|---|---|
| `implementationItems` | Code-writing work items (`kind:'implementation'`) | Cover every `implementationRequired` AC; each is `git_change` + one bound repo; valid `taskKind`/`executionSkill`/`executionMode` |
| `verificationItems` | Independent verification work items (`kind:'verification'`) | One REQUIRED `verification.ac` + `read_only_evidence` item per EVERY accepted AC (not just `ac_kind=verification` ones — T-014) |
| `integrationTargets` | Per-repository integration intents | Exactly match the development-case repositories (branch + base commit copied verbatim) |

Plus the whole graph: keys unique and closed, dependencies acyclic, no
self-reference, implementation items depend only on implementation items.

## Review procedure

1. **Read the task** via `task_get({id})`. Confirm `task_kind` is
   `planning.decomposition` and `workflow_stage` is `development`. Note the
   `project_id`, `epic_id`, `assigned_to` (your worker id), and the
   `execution_id` (fencing token) — you will need both for `worker_done`.

2. **Read the accepted AC scope** — this is the coverage oracle. Do NOT trust
   the proposal's own `acceptanceCriterionIds`; derive the expected set from the
   accepted baseline:
   ```
   artifact_list({ epic_id, type:'AC', status:'accepted' })
   ```
   Record the set of accepted AC artifact ids `acceptedIds`. Every one of these
   must end up covered (see checks 6 and 7).

3. **Verify repository bindings.** The proposal's `projectRepositoryId` values
   and the integration targets must reference REAL case repositories:
   ```
   repository_list({ project_id })
   ```
   Record the set of valid `projectRepositoryId` values, each repository's
   `integration_branch`, and (if available) the case's `expectedBaseCommit`. The
   planner copies these from the frozen DevelopmentCase; mismatches are a hard
   reject.

4. **Read the submitted proposal.** The planner's
   `DevelopmentTaskGraphProposal` was persisted by `process_node_submit`. Read it
   back from the task tracker / the submission receipt before validating — never
   reconstruct it from memory. Confirm `schemaVersion` is exactly
   `factory.development-task-graph-proposal.v1`. If the schema version differs or
   the proposal is absent from the tracker, emit `changes_requested` with reason
   "planner did not submit a factory.development-task-graph-proposal.v1 proposal".

5. **Structural checks on work items** (mirror the kernel's
   `task-graph-dependency-invalid` branch). Collect `allItems =
   implementationItems ∪ verificationItems` and build `itemKeySet`,
   `implementationKeySet`. For EVERY item, verify:
   - `key` is non-empty AND unique across BOTH arrays (no duplicate keys, no
     key reused between impl and verification).
   - `taskKind`, `executionSkill`, `executionMode` are all non-empty strings.
   - `required` is a boolean.
   - `acceptanceCriterionIds` has no duplicates within the item.
   - `dependsOnKeys` has no duplicates within the item.
   - No item depends on itself (`dependsOnKeys` does not contain its own `key`).
   - Every `dependsOnKeys` entry names a key that EXISTS in `itemKeySet`
     (closed dependency set — no dangling references).
   - **Implementation items depend ONLY on implementation items** — every
     `dependsOnKeys` entry of an implementation item must be in
     `implementationKeySet`. (A code task may not wait on a verification task.)
   - The combined dependency graph over `allItems` is **acyclic**. Detect a
     cycle by DFS: if any node is reachable from itself, fail.

   Any violation → `changes_requested` citing the offending key(s) and which
   rule fired (duplicate key / dangling dependency / impl-depends-on-verification
   / cycle).

6. **Implementation-item shape checks** (mirror
   `task-graph-dependency-invalid` second branch). For EVERY
   `implementationItems` entry:
   - `kind` is exactly `'implementation'`.
   - `executionMode` is exactly `'git_change'`.
   - `projectRepositoryId` is a non-null integer that is in the valid repository
     set from step 3. (Implementation work MUST bind one case repository; null or
     unknown id is a hard reject.)

   Violation → `changes_requested`: "implementation item <key> must be
   git_change with a bound case repository".

7. **Verification-item shape checks** (mirror
   `verification-plan-coverage-gap` first branch). For EVERY
   `verificationItems` entry:
   - `kind` is exactly `'verification'`.
   - `acceptanceCriterionIds` has length EXACTLY 1 (one verifier per AC).
   - `required` is `true` (verification is never optional).
   - `taskKind` is exactly `'verification.ac'`.
   - `executionMode` is exactly `'read_only_evidence'`.

   Violation → `changes_requested` naming the offending key and field.

   > **T-014 (hard rule).** The verification→integration transition needs
   > `outcome` evidence for EVERY accepted AC, regardless of its `ac_kind`.
   > An AC the planner labelled `implementation` in the SRS §D2 is NOT exempt —
   > it still needs an independent verifier. If the proposal creates verification
   > items for only a subset of accepted ACs, fail here with the missing ids.

8. **Implementation coverage check** (mirror
   `implementation-coverage-gap`). Build:
   - `implementationRequiredIds` = the accepted ACs that require implementation.
     In the tracker these come from the frozen DevelopmentCase's
     `acceptanceCriteria[].implementationRequired`; if that field is not visible
     in the tracker, treat ALL accepted ACs as implementation-required (the
     conservative reading — the kernel uses the case field, and over-covering is
     never a kernel reject).
   - `implementationCoveredIds` = union of `acceptanceCriterionIds` over the
     REQUIRED implementation items.

   Two conditions must BOTH hold:
   - Every id in `implementationCoveredIds` is in `acceptedIds` (the planner did
     not invent or reference a non-accepted AC).
   - Every id in `implementationRequiredIds` is in `implementationCoveredIds`
     (no required AC left uncovered).

   Violation → `changes_requested` listing either the foreign ids or the
   uncovered required ids (e.g. "AC-7 is implementationRequired but no
   implementation item covers it").

9. **Verification coverage check** (mirror
   `verification-plan-coverage-gap` second branch). Build
   `verificationCoveredIds` = union of `acceptanceCriterionIds` over the
   verification items (each contributes exactly one). The two conditions:
   - Every id in `verificationCoveredIds` is in `acceptedIds`.
   - `verificationCoveredIds` equals `acceptedIds` AS A SET — i.e. there is
     exactly one verification item for every accepted AC, no more, no less.

   Violation → `changes_requested` listing missing and/or extra AC ids. This is
   the T-014 gate at planning time — catch it here, not at integration.

10. **Repository-binding check** (mirror `task-graph-lineage-mismatch` repo
    branch). Verify:
    - The case repository ids are unique (no duplicate bindings in the input).
    - For every work item, if `projectRepositoryId !== null` then it is in the
      valid repository set from step 3. (Implementation items already enforced
      non-null in step 6; verification items MAY be null.)
    - No item references a `projectRepositoryId` outside the development case.

    Violation → `changes_requested`: "work item <key> references repository
    <id> not in the development case".

11. **Integration-target check** (mirror `task-graph-lineage-mismatch`
    integration branch). For the `integrationTargets` array:
    - `projectRepositoryId` values are unique (one target per repository).
    - The set of target repository ids EQUALS the set of case repository ids
      (every case repository has exactly one integration target).
    - For each target:
      - `targetBranch` equals that repository's `integration_branch` (copied
        verbatim — no planner-invented branch name).
      - `expectedBaseCommit` equals that repository's `expected_base_commit`
        (copied verbatim).
      - `sourceWorkItemKeys` has no duplicates.
      - Every `sourceWorkItemKeys` entry names a REQUIRED implementation item
        that EXISTS in `implementationItems` (verification items are not valid
        integration sources).

    Violation → `changes_requested` citing which target diverges and how
    (missing repository / wrong branch / wrong base commit / non-implementation
    source key).

12. **graphHash note.** The PROPOSAL does not carry `graphHash` — that field is
    computed by the resolver kernel over the canonical `DevelopmentTaskGraph`
    (which adds lineage fields the planner cannot know). Do NOT demand a
    `graphHash` from the planner and do NOT try to compute one. If you see a
    `graphHash` field on the proposal, ignore it (it is not load-bearing at this
    stage). The kernel is the authority on `graphHash`.

13. **Do not accept, edit, or re-submit the proposal.** If every check (5–11)
    passes, leave the proposal bytes unchanged and emit `approved`. The kernel
    resolver (`resolve-task-graph` node) is the only thing that may turn the
    proposal into canonical tasks and dependencies. You are a gate, not an
    editor: never call `task_create`, `trace_add`, `process_node_submit`, or any
    write that mutates the proposal.

14. **Complete the task** via
    `worker_done({task_id, worker_id, verdict, result, execution_id})`:
    - `verdict:'approved'` — all checks passed; the proposal is
      coverage-complete, acyclic, repository-bound, and T-014-satisfying. The
      `result` body MUST cite the evidence: counts (`N implementation items, M
      verification items, K integration targets`), the accepted-AC id set you
      checked against, and a one-line confirmation that coverage = exact match.
    - `verdict:'changes_requested'` — list each specific gap in `result`, naming
      the offending key / AC id / repository id and which check (5–11) fired.
      Be concrete enough that the planner can fix it in one re-run.

## Anti-patterns (do NOT do these)

- **Do not invent work items, edges, or repository bindings.** If coverage is
  incomplete, return `changes_requested` and let the planner fix it. You are a
  reviewer, not an editor — you have NO write tools for the proposal.
- **Do not approve "because the planner said it covers everything."** Derive
  the accepted-AC set yourself (step 2) and check coverage against it (steps 8
  and 9). The planner's self-attestation is not evidence.
- **Do not skip the T-014 verification-coverage check.** The classic failure
  (Sollar A/B): planner created verification items only for `ac_kind:
  verification` ACs and left the `ac_kind: implementation` ACs uncovered. The
  integration gate then failed hours later. Catch it NOW: verification must
  cover EVERY accepted AC, one-for-one.
- **Do not demand a `graphHash` from the planner.** It does not exist on the
  proposal and the planner cannot compute it. Demanding one is a false reject.
- **Do not allow an implementation item to depend on a verification item.**
  Implementation depends only on implementation; verification may depend on
  implementation. Inverting this deadlocks the workset.
- **Do not allow integration `sourceWorkItemKeys` to reference verification
  items.** Only reviewed implementation commits enter an integration intent
  (`review-before-integration` invariant).
- **Do not call `worker_next`, `task_create`, `process_node_submit`, or
  `trace_add`.** You have exactly one review task; your only write is
  `worker_done`.
- **Do not re-run the kernel policy in your head and "fix" the numbers.** Read
  the actual persisted proposal; do not reconstruct it from the SRS §D2.

## Rules

- One task = one launch. Exit after `worker_done`.
- Verdict must be backed by tool output: cite the `artifact_list` (accepted AC
  set) and `repository_list` (valid repository set) results in `result`, plus
  the per-check pass/fail.
- If the submitted proposal is absent or has the wrong `schemaVersion` →
  `changes_requested` with reason "no factory.development-task-graph-proposal.v1
  proposal found in the tracker".
- If a work item references an AC id that is not in the accepted set →
  `changes_requested` (foreign id).
- If an `implementationRequired` AC has no implementation item →
  `changes_requested` listing the uncovered id.
- If the verification items do not exactly cover the accepted AC set →
  `changes_requested` listing missing and extra ids (T-014).
- If any dependency is dangling, self-referential, cross-kind (impl→verification),
  or part of a cycle → `changes_requested` naming the key(s).
- If any integration target's branch / base commit diverges from the case
  repository binding → `changes_requested` naming the repository id and field.
- If you cannot determine the accepted AC set or the repository bindings from
  the tracker (genuinely missing inputs, not a proposal defect), use
  `worker_ask_need` with a precise question — but prefer the 80% rule: assume
  the conservative reading (all accepted ACs require implementation + verification)
  and comment your assumption, since that can only over-cover and never causes a
  kernel reject.
