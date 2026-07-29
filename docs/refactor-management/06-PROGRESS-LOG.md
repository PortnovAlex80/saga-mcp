# 06 — Progress Log (append-only)

Chronological journal of the refactor. Newest at the bottom. One entry per
meaningful integrator action: wave staging, checkpoint publish, cherry-pick,
gate run, risk surfaced, decision taken.

Format:
```
## YYYY-MM-DD HH:MM — <action>
- Wave: WXX
- What: ...
- Gate: <command + PASS/FAIL or "n/a">
- Commit: <sha or "none">
- Next: ...
```

---

## 2026-07-28 — Refactor HQ bootstrapped
- Wave: (pre-Wave-0)
- What: Read full plan (1336 lines). Ran two read-only reconnaissance subagents (process-modules source map; tests/runner/gateway/persistence map). Created `docs/refactor-management/` with README, baseline (01), checklist (02), wave roadmap (03), this log (06), decisions (07), risk register (08), and per-wave/per-subagent dirs. No production code touched.
- Gate: n/a
- Commit: none yet (uncommitted under `docs/refactor-management/`)
- Next: publish Wave 0 frozen checkpoint + dispatch W0-A1…W0-A8.

## 2026-07-28 — Wave 0 frozen checkpoint published
- Wave: W0
- What: Committed refactor HQ as the Wave 0 frozen input commit. 8 self-contained subagent task files written under `05-subagent-tasks/W00-A1..A8`. Ownership lanes are disjoint (W0-A1 architecture test + scanner; A2/A3/A4/A5 four characterization suites; A6 failure fixtures; A7 synthetic module+scenario fixtures; A8 ADRs + compatibility inventory + test-runner regen + gitignore). No production semantics changed.
- Gate: n/a (checkpoint commit only)
- Commit: `fd26fd1` — `refactor(hq): bootstrap refactor management HQ + Wave 0 frozen checkpoint`
- Next: dispatch W0-A1…W0-A8 in parallel (8 subagents); then integrate serially in the order: A1 → A8 → A7 → A6 → A2/A3/A4/A5.

## 2026-07-28 — Wave 0 executed (8/8 lanes done) and integrated
- Wave: W0
- What: All 8 subagents completed in isolated worktrees off `fd26fd1`. Cherry-picked serially onto `agent/saga3-process-modules` in dependency order A1→A8→A7→A6→A4→A5→A3→A2 — zero conflicts (disjoint path ownership held). 8 focused commits, 44 files, 8641 insertions, **0 production source lines changed** (tests/fixtures/docs/tools only).
- Lane commits (pre-pick): A1=`61122f9`, A2=`baa7a6f`, A3=`fff6960`, A4=`3f84a59`, A5=`614ce8c`, A6=`04882ee`, A7=`0a0f706`, A8=`03b0c95`.
- Key artifacts produced:
  - W0-A1: `tests/architecture/dependency-direction.test.mjs` + `tools/dep-graph-scanner.mjs`. **73 KNOWN_VIOLATIONS** allowlisted (R1=1 module→module, R2=28 module→infra/cross-tree, R3=9 lifecycle→module-impl, R4=1 catalog coupling, R6=34 composition root). Ratchet: fails on new violation or stale allowlist entry.
  - W0-A2: 40/40 characterization of execution-profile-resolver (prefix heuristic; delivery module INVISIBLE — executionProfiles:[]), process-execution-workspace, claude-runner (§13.18 reviewer-skill-overwrite + §13.17 always-granted builtins CONFIRMED), tracker-reminder.
  - W0-A3: 21/21. **90 MCP tools pinned** as Wave 6 compat surface (cross-checked = A8's inventory). Authority deny/allow + identity guard + actionableError shape + hard-coded Discovery workflow string + friendlyError normalization.
  - W0-A4: 41/41. 6 lifecycle smells pinned for Wave 7 (resolver-first, hash-drops-body, defineProperty dodge, cumulative-frame). **Refined finding:** `definitionHash` includes `routeResolver: undefined` for enumerable functions — dodge only fully erases via `Object.defineProperty({enumerable:false})`.
  - W0-A5: 15/15. 7 §5.6 gaps documented for Wave 2 (no immutable store, no installation table, no digest in identity, no version immutability, mutable-source hashing, no replay path).
  - W0-A6: 11/11. All 9 plan §2.2 failure classes located with concrete evidence (commits `3110770`, `fd52982`, `9229f14` + line numbers). Fixing-wave mapping recorded.
  - W0-A7: 14/14. 4 synthetic modules (lm-marketing, kernel-analytics, human-director-approval, external-seo) + campaign scenario (5 stages, external-seo reused, proves §6.8). No routeResolver (§6.4). Wave 1/7/10 proof target.
  - W0-A8: 7 ADRs (015–021) + COMPATIBILITY-INVENTORY.md (90 tools, 10 migrations — found `migrateVerificationExecution` not in baseline, 37 tables, composition seam, hard-coded Discovery strings, routeResolver, built-in catalog). `tools/run-process-module-tests.mjs` regenerated to directory scan (35/35 coverage, was stale 29/41). `.gitignore` hygiene appended (tmp DB files already untracked — `git rm --cached` moot).
- Gate: `npm run build` PASS · Wave 0 gate (7 new test files) **146/146 PASS** · regression `tests/architecture/saga2-boundaries.test.mjs` 20/20 PASS · regression `tests/characterization/saga2-runtime-contracts.test.mjs` 11/11 PASS · `node tools/run-process-module-tests.mjs --list` coverage 35/35.
- Commit: `b0746cd` — `refactor(wave-0): checkpoint — baseline + architecture rules complete`
- Next: stage Wave 1 (Pure SPI) frozen checkpoint off `b0746cd`, dispatch W1-A1…W1-A8.
- Worktrees `.worktrees/w0-aN` removed (branches `refactor/w0-aN` preserved for audit).

## 2026-07-28 — Wave 1 executed (8/8 lanes done) and integrated
- Wave: W1
- What: All 8 SPI lanes completed in isolated worktrees off `4eb5733`. Cherry-picked serially onto `agent/saga3-process-modules` in DAG order A1→A5→A6→A2→A4→A3→A7→A8 — zero cherry-pick conflicts (disjoint path ownership). **6 post-cherry-pick integration fixes** by integrator (expected cross-lane reconciliation, plan §0.1.6):
  1. `node-protocol.ts`: split `AgentAssistanceDefinition` import from `agent-assistance.js` (was wrongly in `tool-contribution.js` per A4 isolation assumption).
  2. `index.ts` barrel: explicit named re-exports to resolve `ValidationResult`/`ValidationError` collisions (4 lanes each defined their own structurally-identical copy; canonical from `production-envelope.ts`).
  3. `round-trip-conformance.test.mjs`: 5 validator calls made `async`+`await` (A6 validators are async due to dynamic-import canonical resolver; A2/A3/A4 are sync — isolation divergence).
  4. `round-trip-conformance.test.mjs`: `NodeProductionEnvelope` fixture updated to A6's real shape (NodeProduction mirror fields `schema`/`artifactRef`/`contentHash`/`bindings` + envelope fields).
  5. `legacy-adapter.ts`: wrap `assertCanonicalSerializable` throw into `LegacyManifestAdapterError` (A2 validator throws canonical errors before returning ValidationResult; A7 test expected single error surface).
  6. `legacy-adapter.test.mjs`: correct expected module names to real identity.name values (`delivery-release`/`product-discovery`/`solution-development`/`solution-formalization`, not short names).
- Lane commits (pre-pick): A1=`0d84110`, A2=`b655e2a`, A3=`002e1ee`, A4=`838f541`, A5=`9adc5c5`, A6=`5f6fcfd`, A7=`fd0faa5`, A8=`da80a05`.
- **Decision D-20260728-02** recorded: `canonicalJson` frozen primitive does NOT drop `undefined` object values (emits invalid token `undefined`); manifest fields must be ABSENT-not-UNDEFINED. WAVE1-PURE-SPI-SPEC §1 row 1 + §4 amended. Frozen primitive NOT modified (preserves all lineage hashes).
- Artifacts: 15 new pure-data files under `src/process-modules/domain/spi/` (canonical-serialization, contract-ref, contract-schema-registry, resource-index, module-manifest, scenario-manifest, node-protocol, execution-envelope, production-envelope, module-completion, recovery-definitions, tool-contribution, agent-assistance, execution-receipt, legacy-adapter, index barrel) + 12 test files under `tests/spi/`. **Zero existing production source modified.**
- Gate: `npm run build` PASS · Wave 1 SPI gate **238/238 PASS** · ratchet W0-A1 4/4 PASS (KNOWN_VIOLATIONS unchanged at 73 — SPI layer added ZERO new violations) · Wave 0 regression 31/31 PASS.
- Commit: `6a349a2` — `refactor(wave-1): pure SPI checkpoint — 15 domain/spi files + 238 tests`
- Next: stage Wave 2 (Immutable Installation) frozen checkpoint off `6a349a2`.
- Worktrees `.worktrees/w1-aN` removed (branches `refactor/w1-aN` preserved for audit).

## 2026-07-29 — Wave 2 full integration (R-07 resolved)
- Wave: W2
- What: R-07 root cause found and fixed — resource digest MUST use raw-bytes `crypto.createHash('sha256').update(bytes).digest('hex')`, NOT `sha256Hex(bytes)` which canonical-JSON-serializes a Uint8Array first. Reconciled 6 cross-lane mismatches across W2-A1/A3/A8.
- Gate: build PASS · installation **140/140** · ratchet 4/4 · Wave 1 SPI 238/238.
- Commit: `a415939` — `refactor(wave-2): R-07 resolved — full integration checkpoint (140/140 tests)`

## 2026-07-29 — Wave 3 parallel lanes executed + integrated
- Wave: W3
- What: 5 parallel lanes (A4,A5,A6,A7,A8) dispatched off `f0367d1`, all completed and cherry-picked serially onto main (zero conflicts). Serial chain A1→A2→A3 staged next. Parallel integration base = `55bf0a8`.
- Lane commits (pre-pick): A4=`c5f9626`, A5=`42e52b4`, A6=`8c71c03`, A7=`eb41488`, A8=`c5cd14c`.
- Gate (parallel): build PASS · 67/67 parallel tests PASS · ratchet 4/4 (73 unchanged).
- Commit: `55bf0a8` — `refactor(wave-3): integrate 5 parallel lanes (A4,A5,A6,A7,A8) — 67 tests pass`
- Next: serial chain A1 (core executor) → A2 (LM executor) → A3 (AgentLaunchSpec). A1 launched off `55bf0a8`.

## 2026-07-28 — Wave 2 executed (8/8 lanes done) and PARTIALLY integrated
- Wave: W2
- What: All 8 installation lanes completed in isolated worktrees off `2dd386c`. Cherry-picked serially in DAG order A2→A1→A3→A5→A6→A4→A7→A8 — zero cherry-pick conflicts. **Multiple post-cherry-pick integration fixes** by integrator:
  1. `installer.ts`: replaced 5 local structural type aliases (ResourceBlob/StoredModulePackage/ModulePackageStore/ModuleInstallationRecord/ModuleInstallationRepository/ModuleInstallationStatus) with `import type` from canonical sibling sources (A1/A2).
  2. `installer.ts`: added standalone `installPackage(...)` helper wrapping `new PackageInstaller().installPackage(...)` (A3 made it a class method; A8 barrel expected a function).
  3. `installer.ts`: fixed `repo.markCorrupt(...).catch()` — A2's port returns `ModuleInstallationRecord` synchronously, not a Promise. Wrapped in try/catch.
  4. `index.ts` barrel: explicit `installPackage` + `PackageInstaller` re-exports.
  5. `installer.ts`: added version-collision PRE-CHECK via `repo.getActiveByNameVersion` before `insert` (A2 UNIQUE-on-active index only enforces at `activate`, surfacing wrong error code `MODULE_INSTALLATION_ACTIVATE_FAILED` instead of `MODULE_INSTALLATION_VERSION_COLLISION`).
  6. `installer.ts`: added Step 3.5 — STAMP resourceIndex digests with real sha256(bytes) before store (placeholder `'pending@wave-2'` digests broke replay verification).
  7. `package-store.ts`: applied Decision D-20260728-03 — changed `computePackageDigest` from double-canonicalization `sha256Hex(canonicalJson(...))` to single `sha256Hex(...)`.
  8. `round-trip-replay-conformance.test.mjs`: fixed `saga3_process_runs` INSERT (added required NOT NULL columns + projects FK); fixed resourceIndex export name (`complianceCheckResourceIndex` not `resourceIndex`).
- **Decision D-20260728-03** recorded: packageDigest formula standardized on single canonicalization.
- **Risk R-07** recorded: W2-A8 conformance still has 6 failing tests. Root cause: `store.verify` returns false immediately after install (replay verification fails). The resource-stamping fix (6) and single-canonicalization fix (7) did NOT resolve it — deeper investigation needed into how `read` reconstructs the manifest vs how `store` writes it (possible: manifest.json round-trip through canonicalJson+JSON.parse alters the object shape enough to change the digest). The 7 individual lane test suites (132/132) all PASS — the store/repo/installer/registries work correctly in isolation. The end-to-end conformance needs the verify-mismatch debugged.
- Gate: `npm run build` PASS · 7 lane suites **132/132 PASS** · A8 conformance **2/8 PASS, 6 FAIL** (R-07) · ratchet 4/4 PASS (73 unchanged) · Wave 1 regression 238/238 PASS.
- Commit: (pending — partial-integration checkpoint below)
- Next: checkpoint Wave 2 as partial-integration (build green, lane tests green, A8 conformance deferred to R-07 follow-up). Wave 3 may proceed building on the working lane-level installation surface, but MUST resolve R-07 before depending on end-to-end install+verify.

## 2026-07-29 — Skills-stream increment: Ponytail minimalism ladder (EXT-17)
- Wave: (parallel skills-stream — NOT a structural wave; does not enter Wave 0-13 src/ scope)
- What: Absorbed the Ponytail anti-overengineering ladder (DietrichGebert/ponytail,
  Habr coverage) into the skills layer. The ladder forces the Builder to take the
  smallest sufficient step before generating code (YAGNI → reuse → stdlib → native →
  installed dep → one line → minimum) and NEVER cuts validation/error-handling/
  security/accessibility. Two skill edits, both carrying `<!-- source: EXT-17 -->`:
  1. `skills/saga-worker/SKILL.md` — new step 3 "MINIMALISM GATE" in the
     `skill: saga-developer` section, run after reading code (step 2) and before
     Implement (step 4). The chosen rung is recorded in a `comment_add` so the
     reviewer can audit it. Critically injected via the dispatcher-loaded SKILL
     (not as an opt-in skill) — the Habr/JetBrains finding that the model ignores
     a merely-installed SKILL.md informed this placement.
  2. `skills/saga-code-reviewer/SKILL.md` — reviewer-side mirror: Step 12.5
     "MINIMALISM audit" checks the Builder's rung comment against the diff; a new
     dependency/module where a lower rung held is a maintainability fail
     (`[maint M-ponytail]`). Maintainability axis description updated to name it.
- EXT-17 registered in the source inventory of `docs/plans/SKILLS-AUGMENTATION-SUBAGENTS.md`.
- Gate: n/a (skills content only — no `src/` touched, no build/test impact).
- Commit: (this commit) — follows the skills-augmentation convention
  `skills(<skill>): augment with <EXT-N>`, NOT `refactor(wave-N)` — this work is
  outside the structural Wave 0-13 scope (which owns `src/` process-modules).
- Next: no follow-up required. The ladder activates for the next `development.code`
  task any worker claims. Track empirically whether workers emit the rung comment;
  if not, consider reinforcing via an AGENTS.md note.

## 2026-07-29 — Skills-stream increment: diagnosing-bugs + tdd + wayfinder (EXT-18/19/20)
- Wave: (parallel skills-stream — NOT a structural wave; no src/ touched)
- What: Three absorptions from mattpocock/skills (reviewed via issue #663 +
  recent commits: grilling/batch-grill-me dual-mode, wayfinder decision-tickets,
  tdd anti-patterns, diagnosing-bugs feedback loop). Scope decision logged below.
  1. EXT-18 diagnosing-bugs → NEW skill `skills/saga-bug-diagnostician/`. Fills
     the gap that `saga-diagnostician` (T-011 engine-loop analysis) leaves: a
     disciplined loop for a concrete PRODUCT bug/regression/flakiness. Phase 1
     "build a tight red-capable feedback loop" is the core; 10 loop-construction
     tactics, minimisation, 3-5 ranked falsifiable hypotheses, `[DEBUG-xxxx]`
     tagged instrumentation, correct-seam regression test. CGAD-adapted: one
     diagnosis per launch, NO self-authorised production fix (hands root cause to
     a worker/recovery task against the frozen AC).
  2. EXT-19 tdd anti-patterns → `skills/saga-worker/SKILL.md` Build-gate section:
     tautological test (assertion recomputes expected the way code does — must use
     AC etalon as independent truth), wrong seam (test boundary doesn't replicate
     the real call path), horizontal slicing (all-tests-then-all-impl). Reinforces
     the existing AC-assertion check.
  3. EXT-20 wayfinder → `skills/saga-architect/SKILL.md` §D2 (frontier/fog-of-war/
     ticket-vs-fog lens for the depends_on DAG) PLUS mirrored into the production
     package-local `modules/development/.../planning-semantic-skill.md` (frontier
     + ticket-vs-fog for dependsOnKeys). NOTE: saga-planner is a "dumb copier" of
     §D2 — it does not own the DAG, so wayfinder landed in the architect (who
     writes §D) and the package planner skill (who proposes the task graph), not
     in skills/saga-planner.
- Scope note (two skill worlds): production LM-nodes (formalization/development
  planning+verification) resolve skills from pinned packages
  (`modules/*/package/.../skills/*.md`, enforced by workspace-projection Step 6);
  dev/reviewer/dispatch still resolve from root `skills/`. EXT-19 (worker) is
  legacy-path only (no package analog exists — development.code is not an LM
  node). EXT-20 was mirrored into BOTH paths. EXT-18 is a new standalone skill.
- Gate: n/a (skills + package-resource markdown only; no src/, no build impact).
- Commit: (this commit) — `skills(...): augment with EXT-18/19/20`, skills-stream.
- Next: bug-diagnostician activates when a worker/reviewer reports a product bug
  with unknown cause. Empirically check whether workers emit tautological tests
  despite the new guidance; if so, consider a `[correctness C-tautology]` axis
  check in saga-code-reviewer.
