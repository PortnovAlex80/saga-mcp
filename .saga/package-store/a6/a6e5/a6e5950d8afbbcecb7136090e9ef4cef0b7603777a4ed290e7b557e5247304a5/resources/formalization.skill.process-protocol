---
name: saga-process-module-worker-protocol
description: "Reusable physical execution protocol for one Process Module LM node: machine binding, tracker hooks, materialized MCP calls, authority enforcement, checkpoints, recovery and single-use completion. Combine with one semantic role skill."
---

# saga-process-module-worker-protocol

This skill defines **execution physics**, not domain content.
It must be combined with exactly one semantic Process Module skill.

## Single-use execution contract

- Execute one WorkIntent for one Flow node.
- Work only on the machine-bound task and execution.
- Never call `worker_next`.
- Never select or start the next Process Module.
- Never call a lifecycle transition unless this node is an explicitly authorized Kernel/Human node; LM workers are not.
- The current **Stage Binding** belongs to the Lifecycle: it maps inputs and routes the module's local outcome. The LM worker must not edit, bypass or reinterpret it.
- After one truthful `worker_done`, exit permanently.

## Startup hook

Before domain work:

1. Read the machine-provisioned external tracker.
2. **Read `recovery-feedback.json` or `review-feedback.json` FIRST when either is present** beside the tracker — they contain the exact fields a gate or reviewer rejected. Resume from the rejection, not from scratch.
3. Verify process module, process run, Stage Binding, stage, node, WorkIntent, task, execution and worker bindings against `task_get`.
4. Verify input snapshot ref/hash, output schema, allowed tools and retry budget.
5. Record startup/checkpoint state in the tracker.
6. Read the semantic role skill supplied by the execution profile.

If a binding differs, stop and report a fenced-context error. Do not repair machine-filled values yourself.

## Structured assistance

An `agent-assistance.json` may be materialized beside the tracker. When present,
the platform injects its structured context blocks (goal, current-step,
next-action, completion-criteria) after each tool call. Treat these blocks as
authoritative guidance for the current Flow node — they tell you WHAT step you
are on and WHAT completion looks like. They do NOT override the tracker (which
remains the precise inner-step program counter) or the allowed-tools gate.

## External memory rule

The tracker is the program counter and recovery frame.

- Read it before every consequential action.
- Update it after every completed step.
- Record artifacts, traces, materialized calls, errors and resume points.
- Never recreate an existing tracker on restart.
- Never depend on conversation memory for ids, hashes, schema versions or current step.

## Machine-filled rule

The Runtime owns:

- process/lifecycle/Stage Binding/stage/node run ids;
- WorkIntent/task/execution/worker ids;
- project/epic/repository bindings;
- schema versions;
- immutable artifact ids/hashes;
- input snapshot and authority scope;
- allowed MCP tools.

Do not infer or rewrite them. Produce only irreducibly semantic payload.

## Capability rule

Use only the execution profile's frozen `allowed_tools`.

If any MCP call returns `AUTHORITY_DENIED`:

1. record the tool and error in the tracker;
2. do not call that tool again;
3. continue only if the semantic skill has a valid route using allowed tools;
4. otherwise fail/pause according to recovery policy.

Prompt instructions are advisory; the MCP gateway is authoritative.

## Materialized MCP call protocol

For every consequential write:

1. Copy the canonical call template into the execution workspace.
2. Keep machine-filled values unchanged.
3. Fill semantic payload fields only.
4. Read the call JSON back.
5. Apply the referenced checklist.
6. Verify no `FILL_` placeholders remain.
7. Verify types, enums, nullability, tool name and exact parameter names.
8. Invoke the MCP tool using the verified values.
9. Record result/id/hash in the tracker.
10. Read persisted state back before the next step.

Do not construct a high-risk MCP call directly from memory.

## Error hook

On rejection, tool error, timeout warning or inconsistent persisted state:

1. record exact error/code and step;
2. record durable state already accepted;
3. choose the resume step from the profile recovery policy;
4. reuse accepted artifacts, WorkIntent and task;
5. do not create duplicates before querying existing state;
6. consume one attempt only when the policy says the error is retryable.

Never convert missing evidence, unknown state or infrastructure error into success.

## Restart hook

On restart:

- reuse the existing WorkIntent and task projection;
- inspect the last execution attempt;
- reuse accepted output and materialized calls;
- resume from the last verified tracker checkpoint;
- do not repeat an authoritative side effect whose exact replay already succeeded;
- stop/pause/escalate when the retry budget is exhausted.

## Pre-completion hook

Before `worker_done`:

1. re-read tracker;
2. verify every required artifact and trace from MCP state;
3. verify all materialized calls are settled;
4. verify no unresolved errors/placeholders remain;
5. materialize and checklist the completion call;
6. call `worker_done` exactly once with a truthful summary;
7. mark tracker completed and exit.

The semantic skill defines what constitutes correct domain output. This protocol defines how that output is produced reliably.


## CRITICAL: Write file to disk BEFORE artifact_create

The kernel gate REQUIRES a non-null `content_hash` on every artifact.
`artifact_create` auto-computes SHA-256 from the file on disk — but ONLY if
the file physically exists at the given `path` under the repository root
BEFORE the call. If the file is missing, `content_hash` is NULL, the gate
fails with "ledger artifact does not match its canonical row", and the entire
Formalization pipeline terminates as `failed`.

For EVERY artifact you create:
1. `Write({ file_path: "<workspace_root>/<artifact_path>", content: "<full artifact text>" })` — write the file FIRST.
2. THEN `artifact_create({ path, project_repository_id, type, ... })` — the tool reads the file and stamps `content_hash`.
3. Verify via `artifact_list` that `content_hash` is NOT null before proceeding.
