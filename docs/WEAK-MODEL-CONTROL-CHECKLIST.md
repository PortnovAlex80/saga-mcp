# Weak-Model Control Checklist

Purpose: verify that a process-module worker receives a bounded, deterministic execution frame and can recover from mistakes without guessing.

## 1. Package ownership

- [ ] The process module ships its semantic skills, tracker definition, workspace templates, MCP call templates, checklists, schemas, error guidance, and assistance events.
- [ ] Every shipped resource is present in the package manifest and content-addressed installation.
- [ ] A running ProcessRun is pinned to one immutable package version and digest.
- [ ] No package skill refers to a global mutable `docs/<stage>/tools` directory or reconstructs a workspace path by convention.
- [ ] The shared physical worker protocol remains platform-owned and is pinned by the module package.

## 2. Execution identity and context

- [ ] The controller creates the WorkIntent, task, execution fence, authority snapshot, and model route.
- [ ] `task_get` returns exact server-owned identifiers; the worker never invents IDs, hashes, schema versions, or paths.
- [ ] Subject bindings survive retries and module transitions in durable storage.
- [ ] A resumed execution receives the previous accepted work plus structured recovery feedback.
- [ ] Stale execution IDs, package pins, authority hashes, and cross-attempt artifacts fail closed.

## 3. Tracker and protocol state

- [ ] The module declares the ordered NodeProtocol steps.
- [ ] The platform creates the ProtocolRun and ProtocolStepRun records.
- [ ] The platform renders the tracker from durable ProtocolRun state.
- [ ] The tracker contains no model-owned Markdown checkboxes.
- [ ] The worker is instructed that the tracker is read-only.
- [ ] Only ProtocolRuntime can advance the current step.
- [ ] The tracker is regenerated after every durable protocol transition.
- [ ] A restart resumes from the persisted current step rather than from model memory.

## 4. External working memory

- [ ] The platform creates a task/execution-scoped workspace inside the product repository.
- [ ] Machine-owned envelope fields are prefilled in every materialized MCP call file.
- [ ] The worker edits the existing call file in place and never recreates it from memory.
- [ ] The worker reads the call file back before submission.
- [ ] The worker applies the exact materialized checklist before submission.
- [ ] Retry materialization refreshes only machine-owned fields and preserves semantic work.
- [ ] Concurrent attempts cannot overwrite one another.

## 5. Skills and prompt frame

- [ ] The physical protocol skill is delivered first.
- [ ] The node-specific semantic skill is delivered second.
- [ ] Both skills come from the exact pinned package installation.
- [ ] The prompt contains the exact tracker, workspace file, call file, checklist, and recovery-feedback paths.
- [ ] Exact machine-provided paths explicitly override examples, and package skills contain no conflicting legacy examples.
- [ ] The prompt states the single task, node, completion criteria, execution fence, and stop condition.

## 6. Tool control

- [ ] The module profile declares the minimum required tools for the node.
- [ ] The immutable execution authority contains the effective Saga tool set.
- [ ] MCP `tools/list` exposes only Saga tools allowed by that execution authority.
- [ ] Claude built-in tools are narrowed to the profile's declared built-ins.
- [ ] Every MCP call is independently checked by the authority gateway.
- [ ] An unauthorized call returns `AUTHORITY_DENIED` with allowed tools and recovery guidance.
- [ ] The worker cannot expand its own authority.
- [ ] Invalid or missing managed-execution context exposes no Saga tools and fails closed.

## 7. Actionable MCP feedback

- [ ] Tool descriptions contain the exact call shape.
- [ ] Validation errors identify the invalid field, expected shape, authoritative source, and received value.
- [ ] Error workflow guidance points to paths returned by `task_get`, never a reconstructed legacy path.
- [ ] Rejected calls preserve the materialized call file for progressive repair.
- [ ] Retry limits and escalation behavior are explicit.

## 8. Structured hooks

- [ ] The module declares bounded assistance for step entry, success, failure, resume, and recovery where applicable.
- [ ] The runtime writes one execution-scoped `agent-assistance.json`.
- [ ] Hook delivery is fenced by execution ID.
- [ ] `PostToolUse` and `PostToolUseFailure` deliver bounded structured context.
- [ ] Hook output is deduplicated by state version and tool event.
- [ ] Hook invocation, result, and failure are observable in the worker log without exposing secrets.
- [ ] A fresh end-to-end smoke proves the hook fired after the first tool.
- [ ] User-level Claude plugins and hooks cannot silently override or flood the Saga worker frame.

## 9. Product document publication

- [ ] Draft documents remain isolated by task and execution.
- [ ] Kernel acceptance identifies the exact accepted document hash and source execution.
- [ ] Only a module-declared promotion rule publishes a stable project-level canonical document.
- [ ] Promotion is atomic, idempotent, and refuses hash drift.
- [ ] Recovery attempts never overwrite the accepted canonical document unless a new kernel decision accepts the replacement.

## 10. Runtime mode and launch

- [ ] The UI displays the orchestration mode that will actually be launched.
- [ ] Start refuses an incompatible or ambiguous mode.
- [ ] New modular lifecycle runs use the package runtime, not the legacy Saga 2 engine.
- [ ] Discovery-only smoke runs use `saga3-discovery-generic`.
- [ ] Full product lifecycle runs use `saga3-lifecycle` with an explicit composition.
- [ ] Model, effort, concurrency, project, epic, and claim scope shown in the UI match the spawned process.

## 11. Acceptance evidence

- [ ] Unit tests cover package closure, workspace materialization, tracker rendering, hook rendering, authority filtering, and actionable errors.
- [ ] Integration tests cover task metadata, exact paths, execution fencing, retry preservation, and canonical promotion.
- [ ] A weak-model smoke trace proves: tracker read, `task_get`, template edit, checklist read-back, valid submit, `worker_done`, hook delivery, and restricted `tools/list`.
- [ ] The trace contains no unauthorized call, guessed path, reconstructed ID, mutable tracker corruption, or hidden fallback to global resources.
