---
id: verification-protocol-skill
kind: instruction
node: verify-acceptance-workset
module: solution-development@1.0.0
---

# Verification Node Execution Protocol — Package-Local Instruction

> Wave 9 pinned package resource (W9-A3). The reusable physical execution
> protocol for the `verify-acceptance-workset` development node: tracker,
> materialized MCP calls, completion, and recovery. Pinned here so the node
> does not depend on a global protocol-skill lookup (exit gate §0.12.12).

This instruction governs the *physical* execution of the Verification node —
orthogonal to the semantic skill. Follow it alongside
`verification-node-checklist.md` before every evidence record or completion
write.

## Tracker is the frame of truth

- Read the stage tracker immediately before every action; update it after every
  recorded verdict, denied outcome, retry, pause, or recovery.
- Machine-filled binding (`process_module_ref`, run/node/work-intent/task/
  execution ids, candidate ref/hash, AC id/hash, provider identity) comes from
  the runtime — never infer or remember an id, hash, or candidate hash.
- On `AUTHORITY_DENIED`, record the error and do not call that tool again.

## Materialized MCP calls

- Copy each call from the canonical package-local template
  (`verification-evidence-record-call.json`,
  `verification-worker-done-call.json`).
- Replace EVERY `FILL_` placeholder. Integer fields are integers; hashes are
  full sha256Hex strings read back from Saga or the frozen candidate.
- The `outcome` is exactly one of `passed`, `failed`, `unknown`, `error`.
- Read the JSON file back after editing, then execute.

## Read-only authority

- Verification is `read_only_evidence`. It reads the frozen candidate and the
  frozen AC contract, generates evidence, records 4-valued verdicts, and
  completes.
- It must NOT mutate source, mutate the candidate, run mutating CI, or
  transition the AC artifact to accepted. Settlement owns final authorization.

## Read-back before completion

- Query/read back each `verification_record` row you created. Confirm every
  `artifactId`, `acceptedHash`, `candidateHash`, `outcome`, and provider
  identity was persisted, not remembered.

## Completion

- Call `worker_done` exactly once, only after all evidence was read back and
  the completion assertions pass. Summarize the verified AC id, the pinned
  candidate hash, and the outcome per AC truthfully (including any
  unknown/error denial).
- After `worker_done`, the single-use worker exits and claims no other task.

## Recovery

- Recovery re-enters at `confirm-candidate-immutability`: re-observe the
  candidate hash before re-running. Candidate drift invalidates all prior
  evidence and requires a new verification workset (invariant
  `development.no-post-verification-mutation`).
- `unknown`/`error` are denials, not silent passes — record them truthfully and
  let settlement deny the verified bundle (invariant
  `development.unknown-denies`).
- On exhaustion the node pauses; it does not start a downstream Process Module
  (invariant `development.module-does-not-route`).
