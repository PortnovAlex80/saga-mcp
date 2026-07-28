# W0-A5 — Characterization: package identity, collision, mutation, replay

**Wave:** 0 · **Lane:** A5 · **Plan ref:** §0.3.6, §13.15, §5.6
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a5`

## Context

- Plan §5 (Process Module Package), §5.6 (current prototype is not final), §13.15.
- Baseline §"Persistence & migrations": there is NO `saga3_process_module_installations` table — installations are an in-memory registry (`process-module-installation-registry.ts`, `modules/installations.ts`). The closest digest-tracking artifact is `sqlite-managed-production-ledger.ts` (`ManagedArtifactProductionRecord` with `contentHash`).

## Architecture rule served

Pin the CURRENT (prototype, incomplete) package-identity behavior so Wave 2 can
correct it (immutable bytes, version-collision rejection, installation pinning)
with the gap made explicit. Plan §5.6: the prototype "must not be accepted as
final until it stores immutable bytes, uses serializable records instead of Map,
enforces version immutability, and makes installation pinning mandatory."

## What you OWN

- `tests/characterization/package-identity-collision-replay.test.mjs` — NEW, single file.

## What to characterize (assert current behavior, including gaps)

1. **In-memory installation registry** (`createBuiltInProcessModuleInstallationRegistry` from `modules/installations.ts`):
   - Returns the 4 production installations (discovery, formalization, development, delivery).
   - Lookup by module ref returns the installation; unknown ref → throws/fails.
   - Coverage check: every declared handler/adapter reference has a factory. Pin the fail-fast behavior.
   - **Gap to pin:** the registry is in-memory only — there is no persisted installation record, no content-addressed bytes, no digest. Assert that two registry instances are independent (no shared persisted state).

2. **Module identity & key** (`processModuleKey` from `domain/process-module.ts`):
   - Pin the key shape (`name@version`).
   - Pin that two modules with same name+version but different content produce the SAME key (i.e. identity does NOT include a digest today — this is the §5.6 gap).

3. **`ManagedProductionLedger`** (`sqlite-managed-production-ledger.ts`):
   - Stamps `ManagedArtifactProductionRecord` with `contentHash`. Pin the record shape and that the same content yields the same hash.
   - Pin that the ledger is keyed by `processRunId/moduleRef/nodeId/intentId/taskId/executionId` — note this is board/task vocab in the key (a Wave 3 cleanup target; flag with comment).

4. **Version collision behavior (current)**:
   - Construct two in-memory installation entries with the same `name@version` but different handler factories. Pin what happens today (does the registry reject? silently overwrite? throw?). Plan §5.5.8 mandates rejection in production mode; today's behavior is the baseline to change.

5. **Resource mutation behavior (current)**:
   - The current prototype hashes source files (per §13.15). If you can locate the hashing path (search for `sha256Hex` usage in `modules/installations.ts` or `*-installation.ts`), pin: after mutating a source file's content, the hash changes. This documents the §13.15 gap (mutable source hashing → not replay-safe).

6. **Replay behavior (current gap)**:
   - Assert there is NO replay-from-immutable-bytes path today. (A test that simply asserts the absence of a `ModulePackageStore` symbol or a content-addressed store directory is valid characterization of the gap.)

## Anti-scope

- Do NOT add a `ModulePackageStore` or installation table (Wave 2's job).
- Do NOT edit production source.
- Do NOT touch other lanes' files.

## Exit criteria

- [ ] Test file passes today.
- [ ] Each of the 6 areas addressed (for area 5/6, a "current behavior is X / gap is Y" assertion is acceptable).
- [ ] Every pinned gap has a `// WAVE 2 WILL FIX` comment.
- [ ] No production source modified.

## Return to integrator

1. Branch name. 2. `git diff --stat`. 3. Passing test summary. 4. Explicit list of the §5.6 gaps you documented (this feeds Wave 2's contract). 5. Confirmation.
