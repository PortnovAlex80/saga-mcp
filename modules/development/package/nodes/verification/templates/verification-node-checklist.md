# Verification Node Pre-Completion Checklist

> Wave 9 package-local checklist for the `verify-acceptance-workset` development
> node (W9-A3). Run before each `verification_record` and before `worker_done`.

## Execution binding

- [ ] Tracker was read immediately before this check.
- [ ] `process_module_ref` is `solution-development@1.0.0`.
- [ ] `node_id` is `verify-acceptance-workset`.
- [ ] Process run, node, WorkIntent, task, execution and worker ids match `task_get`.
- [ ] Candidate ref + candidateHash read from the frozen integrated-release-candidate.
- [ ] AC artifactId + acceptedHash read from Saga, not remembered.
- [ ] Trusted provider identity is `deterministic_evidence` + `trusted: true`.
- [ ] No machine-filled id, hash, or candidate hash was inferred by the LM.

## Independence and oracle

- [ ] Property tests generated from the FROZEN AC contract (acceptedHash), not the builder's tests.
- [ ] Every generated check pins the exact AC accepted hash.
- [ ] The verifier is not the implementation author of this AC.

## Candidate immutability

- [ ] Re-observed candidate hash equals the frozen `candidateHash`.
- [ ] No post-freeze mutation detected (invariant development.no-post-verification-mutation).
- [ ] If drift was found, evidence was NOT recorded against the stale candidate.

## Evidence pins both hashes

- [ ] Every record carries the AC `artifactId` + `acceptedHash` (content_hash).
- [ ] Every record carries the exact frozen `candidate_hash`.
- [ ] `outcome` is exactly one of `passed`, `failed`, `unknown`, `error`.
- [ ] `unknown` and `error` are recorded as denials, not silent passes (invariant development.unknown-denies).
- [ ] Evidence content-addressed reference is attached.

## Authority and scope

- [ ] The call uses only tools from the frozen verification allowed list (read_only_evidence).
- [ ] No source mutation, candidate mutation, or mutating CI was attempted.
- [ ] The AC artifact was NOT transitioned to accepted (settlement owns authorization).
- [ ] No downstream Process Module is started or selected.

## Materialized MCP call

- [ ] The call was copied from the package-local template.
- [ ] Every `FILL_` placeholder was replaced.
- [ ] Integer fields are integers and hashes are full sha256Hex strings.
- [ ] Tool name and parameter names match the MCP contract exactly.
- [ ] The JSON file was read back after editing.

## Read-back and completion

- [ ] Every `verification_record` row was read back before `worker_done`.
- [ ] Completion summary names the verified AC id, candidate hash, and outcome per AC truthfully.
- [ ] Any `unknown`/`error` denial is reported in the summary.
- [ ] `worker_done` is called once, only after all evidence was read back.
- [ ] After `worker_done`, the single-use worker exits and claims no other task.
