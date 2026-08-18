# Development Implementation Worker Tracker

> External checkpoint for one claimed implementation task. The worker does NOT
> self-hire: it was assigned this task through the shared `worker_next` queue
> (infrastructure), after the `resolve-task-graph` kernel materialized it onto
> the kanban from the validated task graph.

## Machine binding

- process_module_ref: `solution-development@1.4.4`
- task_kind: `implementation.feature`
- execution_mode: `git_change`
- project_id: `{PROJECT_ID}`
- epic_id: `{EPIC_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- project_repository_id: `{PROJECT_REPOSITORY_ID}`
- integration_branch: `{INTEGRATION_BRANCH}`
- work_item_key: `{WORK_ITEM_KEY}`

## Program counter

- current_step: `1`
- attempt: `1`
- checkpoint_status: `ready`

## Steps

- [ ] 1. Read this tracker and the assigned task with `task_get`.
- [ ] 2. Verify the machine binding against immutable task metadata.
- [ ] 3. Read the frozen DevelopmentCase, the validated task graph and the exact AC(s) this task implements.
- [ ] 4. Confirm the repository checkout and base commit match the task graph's integration target.
- [ ] 5. Implement the change on the task-scoped branch; keep commits reviewable.
- [ ] 6. Run the local checks that prove the AC(s) hold before requesting review.
- [ ] 7. On review feedback, fix in place — do NOT widen scope or invent ids.
- [ ] 8. Do NOT merge: the factory's git-integration effect merges the exact reviewed source commit into the integration branch after acceptance — never touch integration refs yourself (the merge tools are not granted to workers).
- [ ] 9. Call `worker_done` and exit. Do NOT claim further tasks in this process.

## Merge checkpoint

- reviewed_source_commit: `{REVIEWED_SOURCE_COMMIT}`
- merged_into: `{MERGED_INTO}`
- integration_state: `{INTEGRATION_STATE}`

The settlement kernel re-reads tracker state (this task + integration_state) to
reconstruct the implementation workset. No external Flow node drives this work.

Rework rules (CGAD P18 — a rework worker arrives at the workplace and must see the feedback):

- If `recovery-feedback.json` exists, READ IT FIRST — it carries the gate/kernel rejection (settlement or task-graph repair feedback).
- If `review-feedback.json` exists, READ IT FIRST — it carries the reviewer's findings (changes_requested).
- If `merge-conflict.json` exists, READ IT FIRST — it carries the conflict detail recorded when factory integration hit a merge conflict (repair_required).
- Never rework blind.
