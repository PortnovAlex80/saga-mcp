# SCRIPTED-LEGS-LEDGER — ADR-096 Phase 7 qualification, scripted legs

- **Date:** 2026-08-24 (session) / frozen build of 2026-08-25 receipt timestamp
- **Operator task:** ADR-096 gate item 3 (three whole-factory runs + three
  Development runs, one immutable build, different deterministic seeds, no
  mutation between runs) + documentation witness + interleaving immutability
  check.
- **Frozen worktree:** `D:/Development/saga-mcp-P7-FROZEN` — git HEAD
  `37ce4c00d46a0198ba272198f80f86d4876d0190` (= saga4 head, "test(factory-evidence):
  final pre-freeze conformance harvest — 82/82 pass across five workshops").
  Working tree clean except ONE pre-existing untracked file:
  `docs/verification/build-receipt-03e9af1df388.json` (the receipt itself —
  the tool's `--freeze` explicitly tolerates untracked receipts; recorded here
  as PRE-EXISTING state, re-verified unchanged at every receipt check).
- **Evidence root:** `D:/Development/qualification-adr096/` (outside both repos;
  nothing committed to git in this task).
- **Node:** v24.13.1. Shell: Git Bash on Windows.

## Governing documents read before any run

1. `AGENTS.md` (workspace instructions; claude CLI prohibition, opencode shim).
2. `docs/architecture/decisions/096-consolidate-before-bounded-qualification-or-stop.md`
   — gate item 3 verbatim: "Three fresh Development runs and three fresh
   whole-factory runs use one immutable build, different deterministic
   perturbation seeds, and no source, package, capsule, DB, or dist mutation
   between runs." Deviations must use already-declared transitions; a genuinely
   NEW invariant class is kill-gate material.
3. `docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md` Phase 7
   (qualification under separate authorization; this task = the scripted legs).
4. `tests/factory-e2e/perturbation-tapes.mjs` + `perturbation-tapes.v1.json`
   (14 tapes; seed n → tapes[n mod 14]; selection-only, no random faults).

## Lane mapping (verified against frozen tape table before running)

| Tape index | Name | Drive entrypoint | In-lane scenario |
|---|---|---|---|
| 0 | golden-full-lifecycle (default) | w9-02-single-drive.mjs | golden (scenario null = built-in) |
| 1 | cross-execution-durability | w9-03-adversarial-drive.mjs | cross-execution-durability |
| 5 | dev-blocked | w9-04-outcome-edge-drive.mjs | dev-blocked |

Note: there is NO `w9-03-single-drive.mjs` / `w9-04-single-drive.mjs`; the lane
entrypoints are `w9-03-adversarial-drive.mjs` and `w9-04-outcome-edge-drive.mjs`
(as declared in the tape table's `drive` fields — the table itself is the
authority on entrypoint names). Each drive resolves its tape via
`resolveDriveTapeSelection({ driveFile: <its own filename> })`, so seed 1 on
w9-03 and seed 5 on w9-04 are IN-LANE selections (applied=true), and seed 0 on
w9-02 is the default/golden tape.

## Fresh-root mechanism (structural confirmation, applies to every run)

`dist/factory-e2e/fresh-harness.js` line ~137:
`const dir = opts.tempDir ?? mkdtempSync(path.join(os.tmpdir(), 'saga-fresh-harness-'))`
— every drive process creates its own fresh temp harness root (DB + repo +
package store inside it) and `bootstrap.cleanup()` removes it. `PROOF_KEEP_DIR`
is NOT set in any run below. No shared state between runs is possible short of
OS tmp reuse after cleanup. Documentation drive additionally makes its own
`saga-documentation-proof-*` output root.

## Receipt checks

| # | When | Result | Exit |
|---|---|---|---|
| R0 | Before any run (04:14) | `BUILD RECEIPT MATCH 03e9af1df388` — head 37ce4c00, dist 1530 files (tree abd53015e240), package-store 0 | 0 |
| R1 | After batch A (3 runs) | **DRIFT** — 8× `package-store-added` (7 digests, see below) + `receipt-id recomputed a5108835f2fd ≠ frozen 03e9af1df388`; NO source/dist/git drift | 1 |
| R2 | After forensic store removal | MATCH 03e9af1df388 (proves batch A's only mutation was the gitignored store) | 0 |
| R3 | After isolated re-derivation A1R | **DRIFT** — same 7 digests, same recomputed id a5108835f2fd (deterministic) | 1 |
| R4 | Final, after store removal + my temp-root cleanup (04:21) | MATCH 03e9af1df388; `git status --porcelain` = pre-existing untracked receipt JSON only | 0 |

Receipt-JSON pinned identity (quoted from `docs/verification/build-receipt-03e9af1df388.json`):
`git.head=37ce4c00d46a0198ba272198f80f86d4876d0190`, `packageStore={present:false, packageCount:0, packagesHash: sha256-empty}`, `dist 1530 files treeHash abd53015e240…`, frozenAt `2026-08-25T01:11:50.782Z`, root = this worktree.

The 7 deterministic store digests (identical after 1 run and after 3 runs):
`343ebb12…, 6e77401e…, 9b59b103…, a5e72f81…, c72e81d7…, df7e8ba3…, e579e5d4…` (full values in `logs/store-digests-after-batchA.txt`).

## Runs

### A1 — whole-factory, golden lane (gate item 3, run 1/3)

- **Command (exact):** `W9_PERTURBATION_SEED=0 W9_DRIVE_LABEL=A1-golden node tests/factory-e2e/w9-02-single-drive.mjs` (cwd = frozen worktree root)
- **Exit code:** 0
- **Wall time:** 4810 ms
- **Receipt before batch A:** R0 MATCH (see table above)
- **Tape selected:** seed 0 → `golden-full-lifecycle` (default tape; w9-02 in-lane; `perturbationTapeApplied=false` is correct semantics — the golden tape's scenario is null so the drive runs its built-in golden path; tape name recorded in evidence)
- **Fresh root:** own `mkdtemp` harness root (created + cleaned by bootstrap; no `PROOF_KEEP_DIR`)
- **Key evidence (stdout bundle, log `logs/A1-w9-02-seed0.out`, sha256 below):**
  `reachedRunnableLocal=true, devStatus=completed, devOutcome=verified, lrReceiptOutcome=passed, candidateFrozen=true, readinessKind=static, cycles=63, terminalReason=completed, scriptedInvocationCount=20, strandedActiveExecutions=0, effectiveConcurrency=2, maxObservedConcurrency=1, invariantsDeclared=[no-authority-hacks, authority-conservation, contribution-partition-invariance, cardinality-conservation, no-stranded-executions]`
- **Stderr:** normal `replay-certification` sweep log only (`considered=12, certified=1, failed=0, skipped(already-certified)=18`); no diagnostics, no errors.
- **Digest:** see MANIFEST.mjson (updated at end of each batch)

### A2 — whole-factory, adversarial/crash lane (gate item 3, run 2/3)

- **Command (exact):** `W9_PERTURBATION_SEED=1 W9_DRIVE_LABEL=A2-cross-exec-durability node tests/factory-e2e/w9-03-adversarial-drive.mjs` (cwd = frozen worktree root)
- **Exit code:** 0
- **Wall time:** 4993 ms
- **Tape selected:** seed 1 → `cross-execution-durability` (w9-03 in-lane, `perturbationTapeApplied=true`; scenario = named crash point `author-lost-after-first-contribution`)
- **Fresh root:** own `mkdtemp` harness root (no `PROOF_KEEP_DIR`)
- **Key evidence (stdout bundle, log `logs/A2-w9-03-seed1.out`):**
  `reachedRunnableLocal=true, devStatus=completed, devOutcome=verified, lrReceiptOutcome=passed, cycles=64, terminalReason=completed, lostExecutionCount=1, crashWorkplaceRef=workplace/2/solution-formalization@1.0.0/formalization-product-contract/singleton, crashRecoveryConverged=true, partitionInvarianceHolds=true, authorCandidateSetCount=1, strandedActiveExecutions=0, scriptedInvocationCount=21, invariantsDeclared=[no-authority-hacks, authority-conservation, contribution-partition-invariance, cardinality-conservation, no-stranded-executions]`
- **Stderr:** 206 lines of normal sweep/certification logs, no errors.
- **Interpretation:** the crash tape exercised its declared transition — first author execution lost mid-production (exit-without-done), crash repair reassigned the SAME workplace, both contributions landed in one accepted revision, lifecycle still reached runnable-local. Declared-scenario behavior, no deviation.

### A3 — whole-factory, outcome-edge lane (gate item 3, run 3/3)

- **Command (exact):** `W9_PERTURBATION_SEED=5 W9_DRIVE_LABEL=A3-dev-blocked node tests/factory-e2e/w9-04-outcome-edge-drive.mjs` (cwd = frozen worktree root)
- **Exit code:** 0
- **Wall time:** 5087 ms
- **Tape selected:** seed 5 → `dev-blocked` (w9-04 in-lane, `perturbationTapeApplied=true`)
- **Fresh root:** own `mkdtemp` harness root — later forensically identified as `/tmp/saga-fresh-harness-mT3tt9` (label `A3-dev-blocked` found inside its DB), one root per run confirmed.
- **Key evidence (stdout bundle, log `logs/A3-w9-04-seed5.out`):**
  `edgeKey=solution-development:blocked, stageOutcomeRecorded=true, stageRunOutcome=blocked, lifecycleStatus=completed, lifecycleTerminalStatus=development-blocked, certificateDecision=blocked, certificateReasonCodes=["candidate-drifted-after-freeze"], stoppedByCycleBound=false, cycles=63, strandedActiveExecutions=0, scriptedInvocationCount=20, invariantsDeclared=[no-authority-hacks, authority-conservation, contribution-partition-invariance, cardinality-conservation, no-stranded-executions]`
- **Stderr:** 203 lines of normal sweep/certification logs, no errors.
- **Interpretation:** declared outcome-edge terminal reached with exact deterministic shape (honest typed Development `blocked` via `candidate-drifted-after-freeze`), no stranded executions. This is an ADR-096 "honest terminal failure" instance — a valid declared outcome, not a deviation.

### Batch A receipt check — **DRIFT (ABORT condition)**

- **Command:** `node tools/build-receipt.mjs --check` → **EXIT 1**
- **Output (verbatim, abbreviated):**
  `BUILD RECEIPT DRIFT: ... does NOT match the current build (9 drift item(s))`
  `BUILD_RECEIPT_DRIFT[package-store-added] a package store appeared where the receipt covered none`
  `BUILD_RECEIPT_DRIFT[package-store-added] package added: 343ebb12…7539` (+6 more)
  `BUILD_RECEIPT_DRIFT[receipt-id] recomputed receipt id a5108835f2fd ≠ frozen 03e9af1df388`
- **NO drift items for:** git head, source (package.json/package-lock), dist (1530 files, tree abd53015e240 — never wavered at any point in this session).

## INCIDENT REPORT — package-store population by the drive entrypoints

### Mechanism (code-level, all paths in the frozen build)

1. Every whole-factory/Development/documentation drive calls
   `bootstrapFreshHarness({ repoRoot: <cwd>, ... })` with **no `packageStoreDir`**.
2. `dist/factory-e2e/fresh-harness.js` (~line 205) then calls
   `installProductionModules(db, opts.repoRoot, [7 module manifests], opts.packageStoreDir)`.
3. `dist/process-modules/installation/production-install.js:120`:
   `new FilesystemModulePackageStore(storeRoot ?? path.join(repoRoot, '.saga', 'package-store'))`
   → with cwd = frozen worktree root, the store lands AT
   `D:\Development\saga-mcp-P7-FROZEN\.saga\package-store`.
4. The drive entrypoints plumb no env override; only `dist/orchestrate-cli.js:756`
   honors `SAGA_PACKAGE_STORE_DIR`, which the drives do not use.
5. The frozen receipt pins `identity.packageStore = {present:false, packageCount:0, packagesHash: sha256("")}`.
   Therefore **any** drive run from this worktree makes `--check` fail — a receipt
   MATCH after runs is structurally impossible as-invoked.

### Facts established

- The store is **gitignored** (`.gitignore:55 .saga/package-store/`) — `git status` stays clean; only the receipt's store recomputation catches it (the receipt is strictly stronger than git — working as designed).
- Exactly **7 content-addressed packages** appear (the 7 workshop manifests: discovery, formalization, development, development-continuation, development-verification-continuation, delivery, documentation).
- The installer is declared idempotent with digest replay verification (typed `PACKAGE_STORE_DIGEST_MISMATCH`); same manifests → same digests → runs 2..N add nothing.
- **Isolated re-derivation (A1R):** store removed → `--check` MATCH (exit 0) → ONE drive run (`W9_PERTURBATION_SEED=0 W9_DRIVE_LABEL=A1R-rederivation node tests/factory-e2e/w9-02-single-drive.mjs`, exit 0, 4824 ms, bundle identical to A1 modulo label — byte-compared) → store again contains EXACTLY the same 7 digests (set-diff vs batch A = empty; both digest-list files sha256 `0e44b699…`) → `--check` fails again with recomputed id `a5108835f2fd` (identical to batch-A drift). The drift is a **deterministic function of the build**, not run state.
- Store archive: `logs/package-store-after-batchA.tar.gz` (725 KB unpacked, sha256 `a3df44f1…`).
- Worktree restored to receipt-covered state after forensics: store removed (twice, after batch A and after A1R), `--check` MATCH both times; final `git status --porcelain` = only the pre-existing untracked receipt JSON.

### Classification (against ADR-096)

- **NOT a genuinely new invariant class.** The write path is the declared,
  typed, content-addressed production module installer (already-declared
  transition; ADR-096: "an already declared scenario instance does not by
  itself trigger termination"). All three batch-A runs hit their declared
  terminals with declared shapes; zero unexpected behavior.
- **It DOES defeat gate item 3's machine witness as-invoked:** the receipt as
  frozen (0 packages) can never match after runs, so "no source, package,
  capsule, DB, or dist mutation between runs" cannot be certified by this
  receipt without a qualifier decision. Literal reading: run A1 populated the
  store "between runs" (A2/A3 then ran with it present — replay-verified, not
  rewritten, but present).
- **Root cause class:** qualification-infrastructure composition defect — the
  frozen receipt and the drive entrypoints' default store location are
  mutually incompatible. Candidate remedies (qualifier's call, NOT executed
  here): (a) re-freeze the receipt over the populated deterministic store
  (store bytes are build-derived, so this preserves immutability semantics);
  (b) plumb `packageStoreDir`/`SAGA_PACKAGE_STORE_DIR` through the harness
  bootstrap in a future build; (c) have the qualifier explicitly accept the
  deterministic store population as a declared transition with this evidence.
- **Action taken:** per the task brief's unconditional clause ("any drift =
  ABORT and report"), legs B and C were **NOT executed** after the drift was
  confirmed deterministic. Nothing was rebuilt; no source/dist edit ever
  occurred (proven by MATCH after store removal).

### Environment caveat — concurrent third-party saga activity

Temp-dir forensics found saga drive activity on this machine NOT from this
session: `/tmp/saga-documentation-proof-*` dirs at 03:55:13/03:56:16/04:10:54/04:11:10
and `/tmp/saga-fresh-harness-T7CaTt` (04:11:11, DB with open -shm/-wal, no W9
label — likely an interrupted or live foreign run). My four runs' roots were
all label-attributed (A1=JAZP80, A2=JpKhWu, A3=mT3tt9, A1R=674ZYS) and each
contained its own DB+repo (fresh-root-per-run proven); my four roots were
removed post-forensics; foreign dirs were left untouched. If a foreign process
ever runs from this same worktree root it will repopulate the store — the
final MATCH below is timestamped 2026-08-25 04:21 local.

### Residual observation — harness cleanup is best-effort on Windows

`bootstrap.cleanup()` = `rmSync(dir,{recursive,force})` inside a swallowed
try/catch; on Windows (open WAL/shm handles) it leaves the temp root behind —
all four of my runs' roots persisted after exit (~3.3 MB each) until manually
removed. No cross-run state risk (each run mkdtemps a NEW root), but temp
accumulation is real on this platform.

## Per-gate-item verdicts

| Gate item (ADR-096 #3 legs) | Verdict | Detail |
|---|---|---|
| Three fresh whole-factory runs (one build, different seeds, no mutation between) | **RUNS GREEN / GATE NOT CERTIFIABLE as-invoked** | A1 (w9-02, seed 0, golden), A2 (w9-03, seed 1, cross-execution-durability), A3 (w9-04, seed 5, dev-blocked) — all exit 0, deterministic declared terminals, 0 stranded, fresh mkdtemp root each, one build (source/dist identity receipt-verified at every boundary). BUT the receipt-as-frozen cannot witness "no package mutation between runs": every drive deterministically populates `<root>/.saga/package-store` (7 digests). Certifying item 3 requires a qualifier decision (see incident remedies). |
| Three fresh Development runs | **NOT EXECUTED — aborted** | Per the brief's unconditional drift clause, legs B and C stopped after R1 drift was confirmed deterministic (R3). Commands were ready: `DEVELOPMENT_SCENARIO=development/happy-verified|development/task-graph-production-scale-satisfiable|development/restart-idempotency node tests/factory-proof/development-scenario-drive.mjs`. |
| Documentation witness | **NOT EXECUTED — aborted** | Same abort. Engines verified present beforehand (pdfkit + dejavu-fonts-ttf resolve; Arial fallback exists), so both `documentation/happy-documented` and `documentation/missing-engine-blocked` were drivable. The `saga-documentation-proof-*` temp dirs found on this machine at 03:55–04:11 are THIRD-PARTY activity, not evidence from this session. |
| Immutability (interleaving check D) | **PASS for source/dist/package.json/git-head; FAIL overall receipt MATCH** | R4 (final): MATCH after store removal — the frozen build itself was never mutated at any point. As left in place after runs, the receipt reports DRIFT solely for the deterministic gitignored package store. |

## Deviations and classification

1. **Package-store population between freeze and runs** — the only deviation
   observed. Classified: **already-declared transition instance** (the typed,
   idempotent, content-addressed production module installer), NOT a new
   invariant class → not kill-gate material per ADR-096. It is, however, a
   blocking qualification-infrastructure defect for gate item 3's receipt
   witness as frozen.
2. **No genuinely new invariant class observed** in any run behavior: three
   lanes reached exactly their declared terminal shapes; every bundle carried
   the declared invariant list; zero stranded executions; crash repair and
   honest-blocked settlements behaved as declared.
3. Run-failure deviations: none (no run failed; the only failure was the
   R1/R3 receipt check, handled above).

## Residuals

- R1: legs B (3 Development runs) and C (documentation witness) unexecuted —
  cheap to run (~seconds each) once the qualifier rules on the store question.
- R2: receipt 03e9af1df388 ↔ drive entrypoints incompatibility needs one of:
  re-freeze over populated store / plumb store override / accept as declared
  transition.
- R3: `bootstrap.cleanup()` leaves temp roots on Windows (best-effort rmSync);
  foreign saga processes active on this machine (03:55–04:11) — a foreign run
  from this worktree root would repopulate the store after the final MATCH.
- R4: my four harness temp roots were removed post-forensics; foreign ones
  untouched.

## Evidence manifest (all under D:/Development/qualification-adr096/)

| File | sha256 |
|---|---|
| logs/A1-w9-02-seed0.out | 90b0591755d216d72945369759f8c3efbb7267c33486d108a463fd04d7df68a0 |
| logs/A2-w9-03-seed1.out | defba2fccb51147a7db0ed327dde5c42b69c531fba1a980952e500d3acae1e46 |
| logs/A3-w9-04-seed5.out | 94cc967249652a2ce9b000d8d1893ad2ed4ebc12db4a671257e34d63ad568a8e |
| logs/A1R-w9-02-seed0-rederivation.out | 58bd84cbfc21e8a57c24d03773fc4e6387fa5e324c8587ad4f6f5145cda1f918 |
| logs/store-digests-after-batchA.txt | 0e44b6995153421b6dea9e0988cbb38b4f576d38a18b973634a89c1f95d102c5 |
| logs/store-digests-after-A1R.txt | 0e44b6995153421b6dea9e0988cbb38b4f576d38a18b973634a89c1f95d102c5 (identical file hash = identical digest sets) |
| logs/package-store-after-batchA.tar.gz | a3df44f1464a2845b09ef1d223315b265580cf411540a8c4d493ab136acde920 |
| logs/SHA256SUMS.txt | (self) |

Stderr logs: `logs/A1-w9-02-seed0.err`, `logs/A2-w9-03-seed1.err`,
`logs/A3-w9-04-seed5.err`, `logs/A1R-w9-02-seed0-rederivation.err` — all
contain only normal sweep/replay-certification logs; no diagnostics, no
errors (the w9-diagnostic block is emitted only on failure and never was).

— END OF LEDGER (session 2026-08-25 04:14–04:25 local; aborted after batch A
per drift clause; worktree left at receipt-verified frozen state 03e9af1df388) —

---

# CONTINUATION + RE-FREEZE RULING (2026-08-25, session 04:25–04:33 local)

## Ruling (operator/orchestrator, recorded — not my decision)

The batch-A receipt drift reported above is **RESOLVED BY ORCHESTRATOR
RULING**: the receipt has been **RE-FROZEN over the populated deterministic
package store** (remedy (a) of the incident report). Nothing in the frozen
build changed: same head, same dist tree, same 7 store digests — the new
receipt simply pins what the drives deterministically derive.

- **New receipt:** `docs/verification/build-receipt-a5108835f2fd.json`
  (untracked; file sha256 `d1902f9609398319cc20600d57b5a0d037e9e18e7083ec71703616cf5f45644c`),
  frozenAt `2026-08-25T01:25:15.610Z` (= 04:25:15 local, UTC+3), identity:
  head `37ce4c00d46a0198ba272198f80f86d4876d0190`, dist 1530 files
  (tree `abd53015e240…`), packageStore `{present:true, packageCount:7,
  packagesHash 0e44b6995153421b6dea9e0988cbb38b4f576d38a18b973634a89c1f95d102c5}`.
- The receipt JSON lists all **7 digests individually, each
  `selfConsistent:true`**, and the set is exactly the incident report's
  deterministic set (`343ebb12…, 6e77401e…, 9b59b103…, a5e72f81…, c72e81d7…,
  df7e8ba3…, e579e5d4…`); packagesHash equals the sha256 of
  `logs/store-digests-after-batchA.txt` — cross-verified against this
  session's store listing.
- **Re-freeze population run identified:** harness temp root
  `/tmp/saga-fresh-harness-frgCFH` (mtime 04:25:15, unlabeled — none of my
  labels inside) coincides to the second with the new frozenAt; it is the
  orchestrator's store-population/verification drive, before my session's
  first command. Left untouched.
- **Old receipt** `build-receipt-03e9af1df388.json` remains on disk untracked
  (sha256 `5af492d278c5cb1cc8c4a46759484a9119fda5dc0f0955c099d69fe154898fed`)
  — the predecessor's abort record above stands unchanged; the ruling
  supersedes its remedy question, not its facts.
- **Standing rule for this session:** runs must keep MATCHING `a5108835f2fd`;
  any digest drift or store addition beyond the pinned 7 remains an abort
  condition.

## Receipt checks (continuation session)

| # | When | Result | Exit |
|---|---|---|---|
| R0C | After re-freeze, before any run | MATCH a5108835f2fd (head 37ce4c00, dist 1530/abd53015e240, store 7) | 0 |
| R1C | After re-witnessed batch A (3 runs) | MATCH a5108835f2fd | 0 |
| R2C | After batch B (3 Development runs) | MATCH a5108835f2fd | 0 |
| R3C | After batch C (2 documentation runs) | MATCH a5108835f2fd | 0 |
| R4C | Final (04:33:33 local) + `git status --short` | MATCH a5108835f2fd; git: only the 2 untracked receipt JSONs; `git diff HEAD --name-only` = 0 lines (tracked files unchanged) | 0 |

The store never wavered: exactly 7 packages at every check (the receipt
recomputes and compares all digests + packagesHash; any 8th package or byte
change would have failed the check).

## Re-witnessed batch A (same lanes/seeds as predecessor — new labels A*C)

| Run | Command (cwd = frozen worktree root) | Exit | Wall | Terminal shape (identical to predecessor's A1/A2/A3) | Log (sha256) |
|---|---|---|---|---|---|
| A1C | `W9_PERTURBATION_SEED=0 W9_DRIVE_LABEL=A1C-golden node tests/factory-e2e/w9-02-single-drive.mjs` | 0 | 4844 ms | golden-full-lifecycle tape (applied=false, correct semantics), reachedRunnableLocal=true, devStatus=completed, devOutcome=verified, lrReceiptOutcome=passed, candidateFrozen=true, readinessKind=static, cycles=63, terminalReason=completed, scriptedInvocationCount=20, stranded=0, all 5 invariants declared | `logs/A1C-w9-02-seed0.out` ebe3c875511038e2a1132ad49bbaf22629fadbc5a17566cdf7d6743b00f2ad21 |
| A2C | `W9_PERTURBATION_SEED=1 W9_DRIVE_LABEL=A2C-cross-exec-durability node tests/factory-e2e/w9-03-adversarial-drive.mjs` | 0 | 4768 ms | cross-execution-durability tape (applied=true), cycles=64, completed, lostExecutionCount=1, crashWorkplaceRef=`workplace/2/solution-formalization@1.0.0/formalization-product-contract/singleton`, crashRecoveryConverged=true, partitionInvarianceHolds=true, authorCandidateSetCount=1, stranded=0 | `logs/A2C-w9-03-seed1.out` 3a5941ccca54b3a8691a70031bfe0b5762b6704e3daf90110f3329ae36b0e8f0 |
| A3C | `W9_PERTURBATION_SEED=5 W9_DRIVE_LABEL=A3C-dev-blocked node tests/factory-e2e/w9-04-outcome-edge-drive.mjs` | 0 | 5301 ms | dev-blocked tape (applied=true), edgeKey=solution-development:blocked, stageRunOutcome=blocked, lifecycleTerminalStatus=development-blocked, certificateDecision=blocked, reasonCodes=[candidate-drifted-after-freeze], stoppedByCycleBound=false, cycles=63, stranded=0 | `logs/A3C-w9-04-seed5.out` b4870a3d48601a7977abc0868709d9a1925f14290e2d0f152eed1887b5fdd595 |

All three deterministic terminal shapes reproduced byte-for-byte in their key
fields vs the predecessor's runs (only the label differs). Stderr logs: sweep
logs only, zero error/diagnostic pattern hits.

## Batch B — three fresh Development runs (gate item 3, Development legs)

Note: the drive requires canonical `development/`-prefixed scenario ids
(`buildDevelopmentRuntimeCase` looks them up by full id; the brief's
unprefixed shorthand would throw `DEVELOPMENT_SCENARIO_UNKNOWN`). Exit code is
driven by `evidence.verdict === 'pass'`.

| Run | DEVELOPMENT_SCENARIO | Exit | Wall | Verdict / key evidence | bundleDigest |
|---|---|---|---|---|---|
| B1 | `development/happy-verified` | 0 | 4955 ms | pass; 9/9 oracles — stage-outcome verified, exact formalization handoff (handoffHash c05476dd…), plan-task-graph/implementation(2)/readiness/verification(2) cells all accepted, certificate verified, post-drain progress 13/13 typed-terminal, terminal completed cycles=63 stranded=0; faultJournal 0, counterexample null | 2ecf775d0785804bff3d71983ef6401875e9f8e0e3d1740c0eb493664025bdd4 |
| B2 | `development/task-graph-production-scale-satisfiable` | 0 | 83289 ms | pass; 5/5 oracles — production-scale graph decided+materialized: 59 work-item cards (43 implementation + 16 verification), allAccepted=true, first-proposal-accepted (1 acceptance, 0 repairs), stage-outcome verified, stranded=0; terminal completed cycles=337 (not cycle-bound), scriptedInvocationCount=116, 68/68 progress rows typed-terminal, 0 stalls | b0653ae7ae4d936b5b16a9b168b87071d83dfdc95df9f4446d7f79457403d7aa |
| B3 | `development/restart-idempotency` | 0 | 10866 ms | pass (specialDrive multi-start restart proof); 8/8 oracles — three distinct lifecycles A=runnable-local (devOutcome verified) / B,C=failed; every start typed-terminal (drive terminals A=completed, B=paused, C=paused — declared multi-start shape); NO duplicate git integration (2 merge commits / 2 accepted impl workplaces of 6 total); change-desk replay typed 6× at merge-base discipline; frozen candidate content-addressed (1 distinct hash 7ff885a07d5b); stranded A=0,B=0,C=0; composite terminal cycles=185 | 44e9ebae189d2d6433f98c4ce840d485b04621e484425950f0a2f7c874f4f19d |

Logs: `logs/B1-dev-happy-verified.out` (8e61e28d…),
`logs/B2-dev-taskgraph-scale.out` (587c497b…),
`logs/B3-dev-restart-idempotency.out` (0341f9fd…). B3's "paused" composite
terminalReason is the declared semantics of the multi-start proof (B and C
settle typed `failed` lifecycle terminals; the restart oracle asserts exactly
this) — not a deviation.

## Batch C — documentation witness (both scenarios)

The drive runs ONE scenario per invocation and auto-picks happy when the
engine probes available (pdfkit + dejavu-fonts-ttf resolve here — production
font resolution, no SAGA_DOCS_FONT override needed; stderr records
`scenario=documentation/happy-documented font=dejavu-fonts-ttf`). The blocked
spine was driven explicitly to satisfy "both scenarios pass".

| Run | Command | Exit | Wall | Verdict / key evidence | bundleDigest |
|---|---|---|---|---|---|
| C1 | `node tests/factory-proof/documentation-scenario-drive.mjs` (auto → happy-documented) | 0 | 5748 ms | pass; 10/10 oracles — lifecycle terminal runnable-local, stage-outcome documented, author gate 3/3 accepted, final gate 3/3 accepted, completeness receipts 3/3 passed, certificate documented, exact verified→documented handoff (handoffHash 6b79a7ad…), **rendered-pdfs-on-disk: 3 real PDFs, each sha256-verified in-flight against its persisted render receipt**, stranded=0; terminal completed cycles=77 | 8f1c35865e2d350a255e80f52b7fed6be521f42e97b47d9fe70d574a304f33f1 |
| C2 | `DOCUMENTATION_SCENARIO=documentation/missing-engine-blocked node tests/factory-proof/documentation-scenario-drive.mjs` | 0 | 5921 ms | pass; 10/10 oracles — the capability-absent spine: lifecycle terminal documentation-blocked, stage-outcome blocked, gates still 3/3 accepted both phases, certificate blocked reasonCode=render-not-available (honest typed-blocked, not a crash), zero render bundles persisted, stranded=0; terminal completed cycles=77 | 7025dd4870a89bc239a3903945f6a879e68133d2f16b7e83cd0b082fc231032c |

**The 3 rendered PDFs (C1) — hashes captured from output AND independently
re-verified on disk (archived to `logs/C1-pdfs/`):**

| Document | Bytes | sha256 (full) | Oracle evidenceRef prefix |
|---|---|---|---|
| user-manual.pdf | 17327 | be22e3940399460c5653631d0fa39fe24ccafe16fbe2845e1273b2c28ba4ca9c | pdf:user-manual:be22e3940399460c ✓ |
| programmer-manual.pdf | 17840 | 190d8c6064c3a9f2c1c2248cdce9c206b16e4f119a290333e401c62bd4976cd2 | pdf:programmer-manual:190d8c6064c3a9f2 ✓ |
| acceptance-report.pdf | 17829 | 044d7a7209af08e5350a4feb071cc1225b376deab940a0521fcd4eeba8f05452 | pdf:acceptance-report:044d7a7209af08e5 ✓ |

On-disk sha256s match the in-flight oracle receipts byte-for-byte at the
16-hex-prefix the bundle carries; sizes match exactly. Logs:
`logs/C1-docs-happy-documented.out` (65f68b57…),
`logs/C2-docs-missing-engine-blocked.out` (ce128951…).

## Per-gate-item verdicts (continuation — final)

| Gate item (ADR-096 #3 legs) | Verdict | Detail |
|---|---|---|
| Three fresh whole-factory runs (one build, different seeds, no mutation between) | **PASS** | Re-witnessed A1C/A2C/A3C (seeds 0/1/5, three lanes) all exit 0 with predecessor-identical deterministic terminal shapes; receipt MATCH at R0C→R1C→R4C proves source/dist/store identity held across all runs — with the re-frozen receipt, "no mutation between runs" is now machine-witnessed (the store is pinned, digest-verified, and replay-idempotent). |
| Three fresh Development runs | **PASS** | B1 happy-verified, B2 task-graph-production-scale-satisfiable (59 cards), B3 restart-idempotency (multi-start, no duplicate git integration) — all exit 0, verdict pass, all oracles green, stranded 0. |
| Documentation witness | **PASS** | Both scenarios: happy-documented renders 3 real PDFs (sha256-verified in-flight and on disk) and missing-engine-blocked settles the honest typed-blocked spine with zero bundles. |
| Immutability (interleaving receipt checks) | **PASS** | R0C/R1C/R2C/R3C/R4C all MATCH a5108835f2fd; final `git status --short` = 2 untracked receipt JSONs only; `git diff HEAD` = 0 lines. One build (head 37ce4c00 + dist tree abd53015e240) across all 8 runs. |

## Deviations and classification (continuation)

1. **Scenario-id shorthand in the brief** (`DEVELOPMENT_SCENARIO=happy-verified`
   etc.) vs the drive's canonical `development/`-prefixed ids — invocation
   naming, resolved by reading the pack's id map; NOT a build deviation.
2. **Blocked documentation spine needed explicit selection** — the drive
   auto-picks happy when the engine is present; driving
   `documentation/missing-engine-blocked` explicitly is the drive's documented
   path for the capability-absent witness. NOT a deviation.
3. **B3 composite terminalReason=paused** — declared multi-start restart-proof
   semantics (asserted by the `every-start-typed-terminal` oracle: A completed,
   B/C paused at typed `failed` lifecycle terminals). Already-declared
   transition, not a new invariant class.
4. **No genuinely new invariant class observed** in any of the 8 runs; zero
   digest drift; store never grew beyond the pinned 7; zero stranded
   executions anywhere; no kill-gate material.

## Residuals (continuation)

- R1': Windows best-effort temp cleanup persists (predecessor's R3): all 8 of
  my harness roots + 2 documentation-proof roots survived their processes;
  label-attributed via DB contents (CWpST1=A1C, diG72W=A2C, 6gmsMB=A3C,
  zPn887=B1, 0SgOqj=B2, NUWDEG=B3, MAcRNi=C1, NBRUMX=C2, kw9aCr/KcCHw9=docs
  roots) and REMOVED post-forensics. Untouched: frgCFH (orchestrator
  re-freeze run) and all pre-session foreign roots (T7CaTt, ItVMxe, 9j56tH,
  3HNgiv, 03:55/03:56 batch, …).
- R2': two receipt JSONs now untracked in the frozen worktree (03e9af1df388 +
  a5108835f2fd) — expected artifact of freeze-over-store; both hashed above.
- R3': foreign-run caveat still stands — a foreign drive launched from this
  worktree root would still be caught by the receipt (store additions beyond
  the pinned 7 = drift), but the final MATCH is timestamped 04:33:33 local.

## Evidence manifest — continuation additions (all under D:/Development/qualification-adr096/)

| File | sha256 |
|---|---|
| logs/A1C-w9-02-seed0.out | ebe3c875511038e2a1132ad49bbaf22629fadbc5a17566cdf7d6743b00f2ad21 |
| logs/A2C-w9-03-seed1.out | 3a5941ccca54b3a8691a70031bfe0b5762b6704e3daf90110f3329ae36b0e8f0 |
| logs/A3C-w9-04-seed5.out | b4870a3d48601a7977abc0868709d9a1925f14290e2d0f152eed1887b5fdd595 |
| logs/B1-dev-happy-verified.out | 8e61e28d9e86595cf4fb34ce5994a860988f87d51d6afd0ee5b26ec2a868d7bf |
| logs/B2-dev-taskgraph-scale.out | 587c497b56c9cc31389a2c605ce807e40d4eeaf5fd5f2a1f809bb63e270a6269 |
| logs/B3-dev-restart-idempotency.out | 0341f9fd5acae079b826afc11c0ff14f0f361b52c6c369d2a526bea17fdffbca |
| logs/C1-docs-happy-documented.out | 65f68b57f689fc3add59d228c85a4470c4a0cc4c96f46ab9a776dd30f3f6d65c |
| logs/C2-docs-missing-engine-blocked.out | ce12895149cf8b41ca78970874b319683a44256b1bb710ef8816e6db251c5958 |
| logs/C1-pdfs/user-manual.pdf | be22e3940399460c5653631d0fa39fe24ccafe16fbe2845e1273b2c28ba4ca9c |
| logs/C1-pdfs/programmer-manual.pdf | 190d8c6064c3a9f2c1c2248cdce9c206b16e4f119a290333e401c62bd4976cd2 |
| logs/C1-pdfs/acceptance-report.pdf | 044d7a7209af08e5350a4feb071cc1225b376deab940a0521fcd4eeba8f05452 |

Stderr logs (same basenames, `.err`): all contain only normal
sweep/replay-certification/start logs; grep for
error/fatal/unhandled/warn/w9-diagnostic = 0 hits in every file.
Worktree receipt files: build-receipt-03e9af1df388.json =
5af492d278c5cb1cc8c4a46759484a9119fda5dc0f0955c099d69fe154898fed,
build-receipt-a5108835f2fd.json =
d1902f9609398319cc20600d57b5a0d037e9e18e7083ec71703616cf5f45644c.

— END OF CONTINUATION (session 2026-08-25 04:25–04:33 local; A re-witnessed,
B and C executed; all receipt checks MATCH a5108835f2fd; gate items
3-whole-factory / 3-Development / documentation-witness / immutability all
PASS; frozen worktree left untouched: head 37ce4c00, 0 tracked diffs, 2
untracked receipt JSONs) —
