---
id: product-protocol-skill
kind: instruction
node: define-product-contract
module: solution-formalization@1.0.0
---

# Product (PRD) Node Execution Protocol — Package-Local Instruction

> Wave 8 pinned package resource (W8-A2). The reusable physical execution
> protocol for the `define-product-contract` formalization node: tracker,
> materialized MCP calls, completion, and recovery. Pinned here so the node
> does not depend on a global protocol-skill lookup (exit gate §0.11.11).

This instruction governs the *physical* execution of the PRD node — orthogonal
to the semantic skill. Follow it alongside `product-node-checklist.md` before
every artifact, trace, or completion write.

## Tracker is the frame of truth

- Read the stage tracker immediately before every action; update it after every
  completed step, rejected submission, retry, pause, or recovery.
- Machine-filled binding (`process_module_ref`, run/node/work-intent/task/
  execution ids, input snapshot ref/hash, output schema) comes from the runtime
  — never infer or remember an id, hash, or schema version.
- On `AUTHORITY_DENIED`, record the error and do not call that tool again.

## Materialized MCP calls

- Copy each call from the canonical package-local template
  (`product-artifact-create-call.json`, `product-trace-add-call.json`,
  `product-worker-done-call.json`).
- Replace EVERY `FILL_` placeholder. Integer fields are integers; nullable
  fields are explicit `null` when required.
- Attach process/node/work-intent/task/execution provenance to artifact and
  trace calls. Do not include fields the kernel owns.
- Read the JSON file back after editing, then execute.

## Read-back before completion

- Query `artifact_list` for the rows you created. Confirm every id and hash was
  read back from Saga, not remembered.
- Required traces (`derived_from` from PRD to the discovery decision/brief, and
  FR/NFR/RULE → PRD) are read back before `worker_done`.

## Completion

- Call `worker_done` exactly once, only after all outputs were read back and
  the completion assertions pass. Summarize created artifact ids + trace refs
  truthfully.
- After `worker_done`, the single-use worker exits and claims no other task.

## Recovery

- Retry count must stay within the `formalization-product` profile budget
  (`maxAttempts: 2`, `backoff: none`). Accepted artifacts are reused after
  restart — never create a duplicate.
- Recovery re-enters at `verify-what-side-lineage`; if WHAT-side lineage is
  incomplete, return to drafting rather than completing.
- On exhaustion the node pauses (`onExhausted: 'pause'`); it does not start a
  downstream Process Module.
