# W0-A8 — ADRs, compatibility inventory, test-runner config, gitignore

**Wave:** 0 · **Lane:** A8 · **Plan ref:** §0.3.9, §14.1.2, §14.1.5
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a8`

## Context

- Plan §14.1.2: "Add architecture decision records for package identity, scenario identity, dependency direction, execution envelopes, protocol state, tool ownership, and compatibility policy."
- Plan §14.1.5: "Freeze current public tool names and persistence migrations that require compatibility."
- Baseline §"Process-module tests": `tools/run-process-module-tests.mjs` groups a/b cover only 29 of 41 files (stale). Baseline §"Hygiene flags": checked-in `tests/planner-ac9/.tmp-ac9-pipeline.db*` + repo-root logs.

## Architecture rule served

Capture decisions and compatibility surface in durable form so later waves do
not re-litigate them, and so the integrator can freeze migrations and tool names
as a compatibility boundary (plan §16 migration policy).

## What you OWN

- `docs/architecture/decisions/015-package-identity.md`
- `docs/architecture/decisions/016-scenario-identity.md`
- `docs/architecture/decisions/017-dependency-direction.md`
- `docs/architecture/decisions/018-execution-envelopes.md`
- `docs/architecture/decisions/019-protocol-state.md`
- `docs/architecture/decisions/020-tool-ownership.md`
- `docs/architecture/decisions/021-compatibility-policy.md`
- `docs/architecture/COMPATIBILITY-INVENTORY.md`
- `tools/run-process-module-tests.mjs` (REGENERATE the a/b groups from a directory scan)
- `.gitignore` (APPEND only — do not remove existing entries)

## ADR content (each ~50–150 lines)

Use the existing ADR format (see `docs/architecture/decisions/005-*.md`…`014-*.md` for house style). Each ADR has: Status, Context, Decision, Consequences, References (to plan sections).

- **015 Package Identity** — Decision: a Process Module Package is identified by `name@semver` PLUS a content digest of its canonical manifest + resource index; released name+version is immutable (§3.11, §5.5.8). Consequence: Wave 2 adds content-addressed store + version-collision rejection.
- **016 Scenario Identity** — Decision: a Lifecycle Scenario is a first-class versioned package; LifecycleRun pins exact scenario installation + complete module lock at start (§3.12, §6.6–6.7).
- **017 Dependency Direction** — Decision: the dependency graph enforced by W0-A1's test — modules depend only on ports; scenarios reference module contracts only; Runtime core has no module vocabulary (§3.3, §3.7, §3.8, §3.16). Reference W0-A1's `KNOWN_VIOLATIONS`.
- **018 Execution Envelopes** — Decision: ExecutionContextEnvelope is the durable unit; receipt and production are separate; no latest-execution/process-scope fallback (§7.7, §9.6, §9.11).
- **019 Protocol State** — Decision: ProtocolRun/ProtocolStepRun state lives in Runtime persistence; module code never updates protocol persistence directly; evidence is verified before step advance (§8.3, §8.4, §9.7).
- **020 Tool Ownership** — Decision: MCP transport/gateway/authority/audit are platform; shared capabilities are versioned Capability Packages; domain tools are module contributions (§11.1–11.3). Gateway guards authoritative; CLI PreToolUse is optimization only (§11.7).
- **021 Compatibility Policy** — Decision: additive DB migrations until cutover; one compatibility seam per old subsystem deleted immediately after owning module migrates; rollback selects previous installation, never edits immutable bytes (§3.13, §16).

## Compatibility inventory (`COMPATIBILITY-INVENTORY.md`)

Tabulate the surfaces Wave 13 must remove only after cutover:
- **Public MCP tool names** — the pinned sorted list (you will obtain it from W0-A3's return; if W0-A3 hasn't landed yet, derive it yourself by importing `ALL_TOOLS` from `src/index.ts`).
- **Persistence migrations requiring compatibility** — list every migration function in `src/db.ts` (`migrateArtifactTypes`, `migrateTracesLinkType`, `migrateVerificationOutcome`, `migrateRiskClass`, `migrateEpisodeTrack`, `backfillWorkItemShadow`, `migrateReviewInProgress`, `migrateVerificationTargets`, `migrateExecutionModeArtifactChange`) with one-line description of what each adapts.
- **Tables to preserve during migration** — from baseline §"`src/schema.ts` tables (37)".
- **Composition root seam** — `composition/product-lifecycle-runtime.ts` (Wave 11 cutover).
- **Hard-coded Discovery workflow strings** — `src/tools/saga3-args.ts:223`, `src/tools/saga3-proposals.ts:176` (Wave 6).
- **`routeResolver` + cumulative-frame** — `product-delivery-lifecycle.ts`, `lifecycle-orchestrator.ts` (Wave 7).
- **Built-in catalog + prefix resolver** — `execution-profile-resolver.ts`, `modules/catalog.ts` (Wave 3).

## Test runner regeneration (`tools/run-process-module-tests.mjs`)

- Replace the hard-coded a/b file lists with a directory scan of `tests/process-modules/**/*.test.mjs`.
- Keep the `a`/`b`/`all` interface. Split the scanned files into two balanced groups (e.g. even/odd by sorted name, or by size) so neither group is unreasonably large.
- Add a `--list` mode that prints the groups without running, so the integrator can verify coverage = 100% of the directory.
- Preserve sequential `--test-concurrency=1` execution and `cwd: root`.

## .gitignore additions (APPEND only)

- `tests/planner-ac9/.tmp-*.db*`
- `*.tmp.db*`
- `epic*-run.log`
- `orchestrate-*.log`
- (Do NOT ignore `docs/`, `dist/` is already ignored — verify before adding.)

## Anti-scope

- Do NOT delete the checked-in `tests/planner-ac9/.tmp-ac9-pipeline.db*` files yourself — `.gitignore` additions alone do not untrack them; note in your return that the integrator should `git rm --cached` them at checkpoint.
- Do NOT edit production source.
- Do NOT remove existing `.gitignore` entries.
- Do NOT touch other lanes' files.

## Exit criteria

- [ ] 7 ADRs exist with the house format.
- [ ] `COMPATIBILITY-INVENTORY.md` exists and tabulates the 7 surfaces.
- [ ] `tools/run-process-module-tests.mjs` regenerated; `--list` shows 100% coverage of `tests/process-modules/**/*.test.mjs`.
- [ ] `.gitignore` appended with the hygiene patterns.
- [ ] A smoke test `node tools/run-process-module-tests.mjs --list` runs without error (do NOT run the full suite — too slow for this lane; the integrator runs it at the gate).
- [ ] No production source modified.

## Return to integrator

1. Branch name. 2. `git diff --stat`. 3. `--list` output showing the regenerated groups + coverage count. 4. The compatibility inventory's tool-name list (cross-check with W0-A3). 5. Note that `git rm --cached` of the tmp DB files is pending at checkpoint. 6. Confirmation.
