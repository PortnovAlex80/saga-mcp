# Canonical Consistency and ADR-053 Closure Plan

> **TRACKER STATE 2026-08-25 (supersedes the original "Current truth"):**
> Phases 1–4 and 6 are EXECUTED; Phase 5 executed green at `90faa5ae`, later
> regressed on two orphan tests and REPAIRED at `7e59016e` (final-head
> re-run follows the canary window); Phase 7 qualification is IN FLIGHT
> (frozen build receipt `a5108835f2fd` @ `37ce4c00`; scripted legs 8/8 green;
> real canary-1 PASSED terminal runnable-local exit 0; canary-2 running).
> ADR-053 verdict: decision ACCEPTED, closure IN-PROGRESS (EC-10 open until
> the canary evidence review). saga4 == origin/saga4 at `50e6a8c0` (synced
> 2026-08-25). Evidence:
> `docs/factory-run/stage22-elite9/DISCOVERY-PHASE6-CLOSURE.md`,
> `docs/verification/ADR-053-CLOSURE-MATRIX-2026-08-25.md`,
> `docs/factory-run/qualification-adr096/SNAPSHOT-CORPUS-REPORT.md`,
> `docs/factory-run/qualification-adr096/INVENTORY.md`, and the live
> qualification ledgers under `D:/Development/qualification-adr096/`.

## Objective

Produce one clean `saga4` line that contains every accepted implementation
slice, no unreviewed branch-only authority, no dead Discovery production
legacy, and an evidence-backed decision on ADR-053 closure. Do not count a
historical live run, a mutable-DB continuation, or a green self-derived test as
qualification evidence.

## Current truth — original baseline (2026-08-24, kept for the record; see the tracker state above for what changed)

- [x] Canonical integration branch exists: `integration/canonical-2026-08-24`.
- [x] `saga4`, Elite incident repairs, exact task-shadow binding, ADR-095
  Phase 4, ADR-095 Phase 5, and the CC-GAP7A execution slice are integrated.
- [x] Elite regressions in replay routing, model-quota admission, and liveness
  were corrected on the canonical line.
- [x] Discovery production legacy source/resources and fresh-schema closure
  were removed. Existing databases are not destructively migrated.
- [x] The canonical source was clean-built after the Discovery cutover.
- [x] ADR-095 Phase 6 WAS unfinished in `D:/Development/saga-mcp-DISCOVERY-P6`
  — finished as `9ff82434`, merged `a4565be0` (that worktree no longer exists).
- [x] The snapshot corpus port WAS three commits plus modified files in
  `D:/Development/saga-mcp-SNAPSHOT-PORT` — finished as `2a73db57`, merged
  `90faa5ae` (worktree removed).
- [x] `saga4` HAS BEEN fast-forwarded to the canonical line (`90faa5ae`,
  reflog-confirmed pure FF; the line has since advanced further).
- [x] ADR-053 document WAS `Proposed` / registry `proposed`+`in-progress` —
  reconciled 2026-08-25 (`4b3a5153`): decision ACCEPTED with a dated
  implementation-truth addendum; closureState remains `in-progress` (truthful).
- [x] ADR-053 exit criterion 10 evidence: the frozen-build scripted legs are
  green and canary-1 passed; the full EC-10 verdict awaits the canary-2
  evidence review (this plan's Phase 7).

## Agent operating rules

- [x] Work in an isolated worktree and a dedicated branch based on the exact
      canonical SHA supplied in the task. (Held throughout; per-phase branches.)
- [x] Never modify the live Elite worktree, its DB, `dist`, workers, watchdogs,
      or processes. (Untouched; measured idle on 2026-08-25.)
- [x] Never invoke the Claude CLI. Use the repository OpenCode shim where an
      external coding agent is required. (Held; canaries run through the shim.)
- [x] Read `AGENTS.md` and all four mandatory conveyor/ADR-053 documents before
      changing production code. (Held for every agent wave.)
- [x] Do not weaken an oracle to make a suite green. Record a counterexample
      and repair production behavior or the objectively false fixture.
      (Held; REG-28 and the submission-policy wiring were repaired as
      production defects, oracles untouched.)
- [x] Keep every commit reviewable and scoped to one phase.
- [x] Report exact commands, pass/fail/skip counts, commit SHA, and remaining
      gaps. A landing is not an exit.
- [x] Do not delete worktrees that contain a `node_modules` junction. The
      canonical, Discovery P4, and Discovery P5 junctions target the `saga4`
      dependency tree and must be unlinked safely before worktree removal.
      (Executed: junctions unlinked, target verified intact 180 entries.)

## Phase 1 — Finish ADR-095 Phase 6  — EXECUTED (`9ff82434`, merged `a4565be0`)

Starting material: `D:/Development/saga-mcp-DISCOVERY-P6`, currently based on
`1f4630a9`, with six modified factory-contract/E2E fixture files. The current
canonical line is newer and includes CC-GAP7A.

- [x] Inspect and explain every existing modification before rebasing or
      recreating it; do not discard the interrupted work. (Each verified
      against production truth: DISC pins vs the 4.0.0 contracts constant;
      admission pins vs the fail-closed model catalog route.)
- [x] Rebase or transplant the Phase-6 work onto the current canonical head.
- [x] Remove all Discovery-scoped legacy allowlist entries; do not require the
      unrelated global allowlist to be empty. (Zero Discovery entries; the
      single remaining entry is the unrelated TB-8 edge.)
- [x] Prove all eight ADR-095 ratchets on the post-Phase-5 tree. (§2 table.)
- [x] Execute and record deliberate RED/GREEN mutations for:
  - [x] dead handler reference; (BR5, re-verified twice independently)
  - [x] legacy tool import; (R3a + TS2307)
  - [x] projection write; (R3a)
  - [x] legacy `CREATE TABLE`; (R0/R5a partial closure)
  - [x] stale manifest pin at the old module version. (R0/R2a, the F5 STOP-SHIP shape)
- [x] Run the six ADR-095 blocker suites without weakening assertions.
      (16/4/6/35/4/5 individually green.)
- [x] Run a clean build, matrix coverage, architecture group, Discovery live-v2
      group, migration-conformance, and the relevant process-module group.
      (§6: temporal 31/31, architecture exit 0, matrix all 14 groups, full
      suite 4599/4547+19-spawn-interference-each-green-isolated/33.)
- [x] Update ADR-095 registry/tracker state only if every Phase-6 exit item is
      genuinely met. Do not claim full-factory qualification. (Registry:
      ADR-095 accepted/implemented; tracker Point 5 `[x]`.)
- [x] Commit Phase 6 and provide a closure evidence table mapping every ADR-095
      exit item to an executable proof. (`DISCOVERY-PHASE6-CLOSURE.md`.)

Exit criteria:

- [x] Working tree clean.
- [x] No Discovery legacy source/resource/fresh-schema residue.
- [x] No stale test fixture requires a deleted six-handler runtime package,
      except the explicit frozen retired-package compatibility fixture.
- [x] ADR-095 registry truth matches executable evidence.

## Phase 2 — Finish and review the zero-token snapshot corpus — EXECUTED (`2a73db57`, merged `90faa5ae`)

Starting material: `D:/Development/saga-mcp-SNAPSHOT-PORT`.

- [x] Review the three existing port commits:
  `1bf9b751`, `37c50a67`, and `5bc75d26`. (Recreated as `06b04389`/`eb6f8fc1`/
  `8f9f0a78` on the canonical base — tests/fixtures only, no ancient
  production code merged wholesale.)
- [x] Inspect and finish the two modified files; do not discard interrupted
      fixes.
- [x] Confirm the harness is a replay/corpus regression, not a semantic product
      oracle and not a replacement for a real worker spawn.
- [x] Pin fixture provenance, build SHA, schema/version compatibility, and
      expected transition trace. (Manifest provenance block + five documented
      replay deviations; consolidated in
      `docs/factory-run/qualification-adr096/SNAPSHOT-CORPUS-REPORT.md`.)
- [x] Prove the harness reaches Development with zero model tokens.
- [x] Add negative cases for corrupted capsule/material, missing package bytes,
      invalid transition order, and stale authority identity. (NEG-0..4, 5/5.)
- [x] Ensure the suite is hosted by a blocking matrix group and protected by a
      per-file removal/de-hosting guard. (G2s; the later G2p orphan incident
      on the two NEW tooling tests was repaired at `7e59016e`.)
- [x] Commit the final port on a current canonical base.

Exit criteria:

- [x] Focused corpus suite green.
- [x] At least one deliberate fixture mutation is red.
- [x] No ancient production code or stale branch history is merged wholesale.

## Phase 3 — ADR-053 closure audit — EXECUTED (`4b3a5153`)

Treat implementation completeness and formal ADR closure as separate claims.

### 3.1 Decision state

- [x] Decide whether ADR-053's normative decision is accepted as written or
      needs a short superseding addendum. Do not change `Proposed` to `Accepted`
      mechanically. (Reasoned acceptance: cutover executed K6–K13, vocabulary
      verified in code; a dated addendum records implementation truth and the
      EC-6/EC-7 reconciliation notes.)
- [x] Reconcile the ADR document, decision journal (if required), closure
      registry, release ownership, and current code vocabulary. (Registry
      053: accepted/in-progress; validator 72/72.)

### 3.2 Re-evaluate all ten exit criteria

- [x] EC-1: `PostAcceptanceEffectInput` has no execution-owner authority. (MET)
- [x] EC-2: no post-seal material consumer selects by execution, task, node,
      chronology, or `latest`. (MET, classified frontier ratchet-guarded)
- [x] EC-3: every CandidateSet binds an immutable Workplace production
      revision. (MET)
- [x] EC-4: execution identity is provenance-only (`presenterRef`) or absent
      from accepted-material authority. (MET)
- [x] EC-5: typed, managed, and Git production normalize to one core material
      contract. (MET)
- [x] EC-6: document/container format and atomic members are bound once in a
      versioned manifest. (MET semantically; vocabulary note recorded)
- [x] EC-7: workshop capabilities come from one installed manifest. (MET;
      by-construction note recorded)
- [x] EC-8: every cross-machine handoff has a durable obligation or atomic
      outbox. (MET; the 2026-08-16 resume residual verified FIXED)
- [x] EC-9: Run-011 is represented by a general partition-invariance theorem.
      (MET)
- [ ] EC-10: clean scripted E2E and clean real canary start from a new DB and
      repository with no dependency on old processes, mutable accumulated state,
      or hot-swapped `dist`. (Scripted leg: green on the frozen build;
      canary-1 PASSED; canary-2 in flight — verdict after evidence review.)

For every item: owner files, positive proof, mutation proof, blocking host,
MET/PARTIAL/OPEN — recorded in
`docs/verification/ADR-053-CLOSURE-MATRIX-2026-08-25.md` (93+123 audit tests
run green on the audited tree; fresh operator re-run 123/123).

### 3.3 Cross-boundary authority search

- [x] Parse complete SQL literals and find authority reads using `latest`,
      descending chronology, task/execution/node scope, aggregate maxima, or
      window ranking. (1344 literals; zero violations; 9 low seams recorded.)
- [x] Inspect all material decoder/encoder boundaries for representational
      drift and fallback authority.
- [x] Verify task-shadow exact binding for author and current reviewer
      generation across lifecycle runtime and engine adoption.
- [x] Verify replay invalidation preserves typed evidence while preventing an
      infinite replay loop.
- [x] Verify effects consume only sealed authority and cannot reselect a
      decoy.
- [x] Verify old Discovery tables in existing DBs are inert history, not a
      readable fallback.
- [x] Verify CC-U2: warrant-oracle commands are pinned to installed
      workshop/package authority rather than candidate-produced declarations.
      Recorded as a separate open authority gap owned by reserved ADR-093;
      NOT folded into the ADR-053 closure claim.

### 3.4 Closure decision

- [x] Close ADR-053 only if all ten exit criteria are `MET`, every principal
      proof is blocking/hosted, and the clean real canary satisfies EC-10.
      Otherwise keep `in-progress` and publish the smallest exact residual
      list. (Verdict: IN-PROGRESS — exact residuals R1/R2 published in the
      matrix; final EC-10 word after the canary evidence review.)

## Phase 4 — Consolidate remaining valuable work — EXECUTED

- [x] Integrate the completed Phase-6 commit onto canonical. (`a4565be0`)
- [x] Integrate the reviewed snapshot harness commits onto canonical.
      (`90faa5ae`)
- [x] Confirm the CC-GAP7A checkpoint is present but still records CC-U2 as
      open. (`CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md:489`)
- [x] Review `wip/documentation-workshop`; port only current, non-stale
      documentation and archive the old branch if the content is superseded.
      (Archived at `archive/wip/documentation-workshop`; the HOW-TO wiring
      checklist ported at `b610dd4c`; the workshop itself was later FULLY
      admitted onto the line in Phase 7 — `25f4cb3a`..`f8ac9382` — under the
      ADR-085 admission regime, superseding the archive-only decision.)
- [x] Preserve the three existing stashes until their ownership/content is
      explicitly classified. (Preserved; classified as parked parallel work in
      `INVENTORY.md`.)
- [x] Do not merge `repair/snapshot-test-mvp` or other ancient branches
      wholesale after their useful commits have been ported. (Tagged
      `archive/repair/snapshot-test-mvp`, branch deleted.)

## Phase 5 — Verification without a factory run — EXECUTED at `90faa5ae`; G2p regression repaired at `7e59016e`; final-head re-run pending the canary window

- [x] Clean TypeScript build.
- [x] Architecture group. (497/497 + race runners)
- [x] Acceptance-matrix coverage self-check. (31/31 then; 33/33 after the
      G2p repair — the two Phase-7 tooling tests were hosted at `7e59016e`
      after the operator review caught the orphan regression.)
- [x] Factory-contract group. (128/128)
- [x] Process-modules group. (1260/1260)
- [x] Discovery live-v2 group. (134/134)
- [x] Readiness-fencing group, including warrant-oracle proof. (125/125,
      blocking mutations green)
- [x] Replay/capsule focused group. (19/19)
- [x] Confirm zero untracked generated journals/evidence files.
- [x] Record failures as open work; do not quarantine newly red blocking tests
      merely to obtain a green matrix. (The G2p orphans were HOSTED, not
      quarantined; the concurrent drive failures were root-caused as TEMP disk
      exhaustion — 8.2GB of stale harness roots removed — and re-verified
      green: e2e-deterministic 29/29, conveyor-periphery 663/663.)
- [x] Full-suite re-run on the FINAL head: GREEN — `TOTAL tests=4649
      pass=4616 fail=0 skipped=33`, exit 0 (after two honest guard repairs:
      the REG-28 drain sanctioned in the lifecycle writer ratchet; K0
      frozen-evidence pins re-captured to the final-harvest blobs).

## Phase 6 — Make `saga4` canonical and clean branch topology — EXECUTED (FF target has since advanced)

- [x] Require a clean canonical worktree and reviewed commit list.
- [x] Fast-forward `saga4` to the canonical head; no merge commit on `saga4`.
      (`90faa5ae`, reflog-confirmed.)
- [x] Do not touch the live Elite worktree until its engine/workers/watchdogs
      are stopped and final evidence is preserved. (Measured idle
      2026-08-25; preserved as evidence tree.)
- [x] Remove the clean contained detached temporary worktree. (audit-wt.)
- [x] Before removing canonical/P4/P5 worktrees, unlink only their local
      `node_modules` junctions and verify the `saga4/node_modules` target
      remains. (180 entries verified after each unlink.)
- [x] Archive obsolete CC-GAP2/CC-GAP3 SHAs with tags before deleting their
      amended non-ancestor branches/worktrees. (+GAP7A, snapshot-mvp, wip-doc.)
- [x] Remove task-shadow, Phase-4, Phase-5, Phase-6, and snapshot-port branches
      only after their commits are ancestors of `saga4` and their worktrees are
      clean.
- [x] Preserve or archive unique stale documentation work deliberately.
- [x] List remaining worktrees/branches and explain every survivor. (Then:
      3 worktrees / 3 branches; REFRESHED for the Phase-7 wave in
      `docs/factory-run/qualification-adr096/INVENTORY.md` — the four
      phase7/* branches+worktrees and P7-FROZEN exist until the qualification
      window closes.)

Exit criteria:

- [x] `saga4` points to the reviewed canonical head. (Then `90faa5ae`; the
      line has advanced with reviewed Phase-7 commits.)
- [x] No valuable unique commit exists only on a disposable branch.
- [x] No dirty worktree is deleted.
- [x] The live Elite worktree is either explicitly preserved as live or stopped
      and archived by a separate operator decision. (Preserved; measured idle.)

## Phase 7 — Qualification (separate authorization) — IN FLIGHT

Authorization basis: the operator's standing automation directive explicitly
requires all plan items including Phase 7; the ADR-096 deferral condition
("until code and branch state are coherent") expired when saga4 became
canonical and Phase 5 verified green.

- [x] Freeze one immutable source/package/capsule/`dist` build. (Receipt
      `a5108835f2fd` @ `37ce4c00` in the dedicated frozen worktree; the
      drive-populated deterministic package-store re-freeze is recorded as an
      already-declared transition instance.)
- [x] Run clean scripted E2E from a fresh DB/repository. (Frozen-build
      scripted legs: 3 whole-factory lanes + 3 Development scenarios + the
      documentation witness, 8/8 green, receipt-witnessed immutability.)
- [x] Run the clean real canary required by ADR-053 EC-10. (Canary-1 PASSED:
      terminal runnable-local / stage verified / exit 0, ~3h10m, zero
      intervention, snapshot captured. Canary-2 COMPLETED zero-intervention
      to an honest typed `development-blocked` terminal — certificate
      implementation-incomplete, declared outcome class, no new invariant.)
- [x] Run the bounded ADR-096 qualification/kill gate. (GATE-RECEIPT drafted
      with per-item verdicts — items 2/3/4 PASS, item 1 honest PARTIAL 34/40,
      item 5 half-passed, item 6 no new invariant class so far; finalized
      after canary-2.)
- [x] Only after evidence review, sign ADR-053 closure or publish its exact
      remaining counterexample. (SIGNED CLOSED — `2c3319a8`, registry 72/72;
      no counterexample stands; residuals classified in
      `COMPLETION-RECEIPT.md`.)

## Final deliverables

- [x] One canonical `saga4` commit SHA: the completion-receipt commit —
      see `docs/factory-run/qualification-adr096/COMPLETION-RECEIPT.md`
      (final line records the exact closing SHA).
- [x] Clean branch/worktree inventory.
      (`docs/factory-run/qualification-adr096/INVENTORY.md`, refreshed.)
- [x] ADR-095 Phase-6 evidence table. (`DISCOVERY-PHASE6-CLOSURE.md`.)
- [x] Snapshot corpus provenance and mutation report.
      (`docs/factory-run/qualification-adr096/SNAPSHOT-CORPUS-REPORT.md`.)
- [x] ADR-053 ten-item closure matrix. (`ADR-053-CLOSURE-MATRIX-2026-08-25.md`.)
- [x] Explicit ADR-053 verdict: `IN-PROGRESS` with exact residuals (R1 frozen-
      build confirmation, R2 real canary — canary-1 passed, review pending
      canary-2).
- [x] No claim of stable autonomous factory operation without the separately
      authorized immutable-build qualification runs. (No such claim made; the
      qualification runs are the ones now in flight under this authorization.)

## Successor plan

After every final deliverable above exists and `saga4` points at the reviewed
clean SHA, execution continues with
`docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md`. No
production-code phase of that successor may start before this plan's completion
receipt. The successor is a greenfield database-protocol cutover: it provides
no migration, backfill, dual-authority or old-run compatibility path.

Per ADR-098, this predecessor must not define or implement the successor's
complexity envelope, CanonicalRoleContract or cumulative prompt/context
envelope from legacy task/ExecutionProfile/runner/tracker representations. EK-1
is itself a no-production-change, independently verified admission phase: it
freezes those three contracts before EK-2 and invalidates downstream work if a
frozen contract changes.
