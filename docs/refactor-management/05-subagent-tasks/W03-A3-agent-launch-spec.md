# W3-A3 — AgentLaunchSpec activation (SERIAL 3rd, after A2)

**Wave:** 3 · **Lane:** A3 · **Spec:** §6 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a3` · **Worktree:** `.worktrees/w3-a3`

## SERIAL: builds on W3-A1 + W3-A2. Integrator cherry-picks A1, A2 before you.

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §6.
2. `src/process-modules/persistence/process-run.ts` (ProcessRunRecord — lacks installationId/packageDigest) + `sqlite-process-run-repository.ts` (rowToRecord, ProcessRunRow, StartProcessModuleCommand).
3. Wave 2 `installation/index.ts` (PackageRegistry, describeInstallation).

## Own
- EDIT `src/process-modules/persistence/process-run.ts` (add `installationId`/`packageDigest` to ProcessRunRecord + StartProcessModuleCommand).
- EDIT `src/process-modules/persistence/sqlite-process-run-repository.ts` (rowToRecord reads the columns; startProcessRun writes them).
- NEW `src/process-modules/application/agent-launch-spec.ts` (the AgentLaunchSpec type + resolver).
- `tests/installation/agent-launch-spec.test.mjs` (NEW).

## Build (spec §6)
- Surface `installationId: number | null` + `packageDigest: string | null` on ProcessRunRecord + StartProcessModuleCommand + ProcessRunRow + rowToRecord (the Wave 2 unfinished thread).
- `AgentLaunchSpec` type: `{ installationId, packageDigest, nodeId, executionProfileId, nodeProtocolId, resolvedResourceDigests, effectiveCapabilitySet, authorOrReviewerRole, driverConfig }`.
- Resolver: `resolveAgentLaunchSpec(processRun, node, installationRegistry): AgentLaunchSpec` — reads `processRun.installationId` → resolves pinned package resources via Wave 2 `PackageRegistry`/`describeInstallation` (NOT catalog). If null → legacy catalog fallback (§14.3.7).
- No NOT NULL (Wave 11).

## Verify
`npm run build && node --test tests/installation/agent-launch-spec.test.mjs && node --test tests/architecture/dependency-direction.test.mjs`

## Commit
`feat(execution): W3-A3 AgentLaunchSpec + ProcessRunRecord installation surfacing (Wave 2 thread closed)`

## Return
Branch+sha, diff --stat, test tail+ratchet, confirmation.
