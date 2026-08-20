# ARCHITECT NIGHT REPORT — stage-12 night shift, 2026-08-20 (00:30–08:30)

Report per your brief's format. Headline: **TASK 1, TASK 2 (steps 1–3),
TASK 3, TASK 4, TASK 5 delivered; step 4 not reached (as the brief allowed);
the operator-override run launched, ran 4.5 hours, and was aborted on the
monitoring tripwire — having exposed two real defects that are yours to
arbitrate.** All state: `origin/saga4`, tracker
`docs/factory-run/stage12/NIGHT-TRACKER.md` (timestamped log, append-only).

## Task 1 — the merges, as executed

All **13 trees landed on one HEAD**; `npm run build` exit 0 throughout; one
commit per merge; pushed per merge. Waves stopped five times on conflicts —
each confined and hand-resolved by main with the resolution documented in
the merge commit and the tracker:

- **Wave A** (4/4): es1 `b8b50c04` clean; provider-retry `f3600d07` (shim ×
  es1 overlap: retry ladder composed with the stream-json translator per
  provider-retry's own base comment — capture→translate→forward, translator
  per attempt); worker-disorientation `42f58586` (third shim overlap: `--dir`
  pin + PWD override over the ladder; `argsPrefix` unification); worker-names
  `2af953e6` clean.
- **Wave B** (7/7): worker-prompt `f6042bd9`, gate-delivery `a53eebad` clean
  (by agent); lifecycle `ae2e634b` (test append-union); persistence
  `bf9f66a5` — **schema 99→100, the night's only schema move**; the
  `legacy-allowlist.json` conflict was semantic (neither digest valid for the
  union) and was resolved by regenerating from the merged tree
  (`legacy-freeze.mjs --snapshot`, 100 tables, `--check` OK); phantom-bridges
  `fb2ece90`; integration-verify `f27b02aa` (deepest resolution: the branch's
  local `decodeFindingsForDecision` was a pre-extraction duplicate — dropped,
  and its **SEAM L2 mapping ported into the shared decoder**); reconciliation
  `62b9339e` (two-file union).
- **Wave C**: ac-drift-remedy `2a0c21d7` — **zero conflicts**, 32 files
  +3101/−26. **E9 reserve header intact** (`constraint-register.ts:2`).
  Schema budget respected (100 tables before AND after, same digest — no
  second migration).

**Full regression after C exposed three red suites — none the merge's own
defect, all root-caused and fixed by main (commit `56e43449`):**

1. Bisect (17eec614..5d01b711, oracle = golden-path) → first bad
   `1df043d2` = blindsight C6 **inside the gate-delivery tree**:
   `readReviewerRoundHistory` selected `s.created_at` — a column that never
   existed (real DDL: `submitted_at`; the branch's own fixture hand-rolled
   the lie and production SQL copied it — the M2 disease, again).
2. With (1) fixed, ac-drift's acceptance validator surfaced a second break:
   **declared validatorVersion 1.1.0 but the receipt-stamp literal still
   1.0.0** — member-key lookups could never find their proofs
   (`SUBMISSION_VALIDATION_RECEIPT_REQUIRED` loop). Fixed to one shared
   constant (the sibling validators' pattern).
3. Lifecycle's single red (`no direct lifecycle UPDATE outside sanctioned
   writers` on `replan-supersede.ts`) is **pre-existing stage-11**
   (`e9ea5aa7`, red at the night's baseline too) — **escalated to you,
   untouched.**

Final counts (one HEAD, `56e43449`): architecture **408/408**,
process-modules **1209/1209**, infrastructure **394 pass / 0 fail / 12
skip**, golden-path **1/1**, w9 e2e **18/18**, discovery register suite
12/12.

**Count reconciliation** (your demand): the tree's own "521 pm / 345 arch /
52 units" were stale branch-point numbers; merged reality = +40 pm (its five
constraint test files) + 12 discovery-suite tests = exactly the claimed 52.
Baseline drift across the night: arch 329→408, pm 1098→1209 — every delta
attributed to a named merge in the tracker log.

## Task 2 — the anti-gaming core

Steps 1–3 landed, one commit each, **tests first**; step 4 **not reached** —
landed nowhere, per your ordering:

1. `a9011b58` — **M2-2 additive coverage report**: the canonical test-file
   universe derived from the exact sealed tree; executed set from the
   declaration; `readiness-test-coverage` diagnostic rides every outcome.
   Provider 1.6.0→1.7.0.
2. `3d814347` — **M1-a monotonicity ratchet + D2 declaration-diff
   escalation**: new deterministic provider
   `development.readiness-profile-monotonicity.v1` BEFORE runnability in
   `development.readiness-certification.final.v2`; typed
   `READINESS_PROFILE_NARROWED` / `READINESS_DECLARATION_CHANGED` →
   `human_required` (complete-blocked), never silent retry. Also fixed a real
   tokenizer bug (bare `test`/`tests` tokens are not directories).
3. `7c29c6d6` — **D1 sourceCandidate-keyed receipt invariant**: receipts
   carry `local-readiness-subject:<candidateHash>:<commitSha>:<treeHash>`;
   persisted lookup keyed by bytes; failed-on-same-bytes REPLAYS;
   failed+passed on same bytes → typed `READINESS_RECEIPT_CANDIDATE_CONFLICT`,
   failed. Provider 1.7.0→1.8.0.

**The negative test that defines done — verbatim result** (`b4ca0748`,
`tests/process-modules/readiness-gaming-red-replay.test.mjs`, the ACTUAL
golden v1.1+v1.2 gaming bytes through the REAL certify plan): round 1
(`npm test`, 9 files, 2 red) → `failed`; **round 4 (gaming manifest, same
sourceCandidate, zero code change) → `human_required` with
`READINESS_PROFILE_NARROWED` naming both excluded files
(`tests/renderer.test.js`, `tests/websocket-server.test.js`), and the
runnability receipt is the round-1 FAILED receipt REPLAYED (evidenceRefs
deepEqual — the gaming command never executed).** Honest boundary kept in
the test's own comments: on never-before-checked bytes a narrowed FIRST
declaration still executes with the gap reported — closing that is exactly
step 4 (derived-canonical), which remains undone.

Final counts: arch **408/408**, pm **1219/1219**, infra **401/0/12**,
golden-path 1/1, w9 18/18.

## Task 3 — hygiene, bounded

- **Moved** (not deleted — all four are operator battle-tested incident
  tools): `_ke.ps1`→`tools/incident/kill-frozen-engines.ps1`,
  `_kill-frozen.ps1`→`…-alt.ps1`, `_eng-stop.ps1`→`stop-engine-and-workers.ps1`,
  `_rec.ps1`→`restart-panel-and-reap-orphans.ps1`, each with a one-line
  purpose header (the restart script's header warns its DB_PATH is pinned to
  the workshop-testing DB).
- **Indexed**: `docs/factory-run/stage11/INDEX.md` names the current
  document (ARCHITECT-HANDOVER-DRAFT) and what each of the six is; nothing
  deleted.
- **Oversized functions (>150 lines) in files the night touched — named,
  not refactored**: `claude-shim.mjs main()` 176; projection-persistence
  `createSqliteProductionCellProjectionPersistence` 292 and
  `readCurrentProductionCellRecoveryFeedback` 201;
  `local-runnability-check-provider runLocalReadiness` 194.

## Task 4 — the three answers, plainly

(`docs/factory-run/stage12/SNAPSHOT-MVP-ANSWERS.md`, evidence with
file:line.)

1. **Captured, but truncated** — real stage-11 accepted material through
   `plan-task-graph` (41 products, all hashes cross-check); synthesized
   deterministic tail beyond it, honestly documented in the scenario file.
2. **More than the worker seam** — real orchestrate-cli, real MCP gateway,
   production gates/settlement/lifecycle routing inside the boundary;
   GateDecisions asserted directly (incl. the captured 3-round repair loop);
   NOT asserted: EffectReceipt rows; the verifier-independence check is
   substituted test-only.
3. **No to both — and that is the finding**: the tape itself benignly games
   the readiness gate (`testCommand: node -e "process.exit(0)"` — the
   provider's command authority IS the candidate's declaration), and the AC
   drift is FROZEN INTO the corpus as ground truth (the hash oracle fires on
   a corrected AC as readily as a corrupted one). The independent authorities
   both live elsewhere now: TASK 2 (declaration independence) and Wave C
   (order-derived constraint register). Branch stays HELD for your call; we
   recommend not blocking the merge on oracle duties it was never mandated
   to carry.

## Task 5 — E2 migration note

`docs/architecture/E2-MIGRATION-NOTE.md` — one page: the artifact side is
the entire delta (traces already content-addressed); the ceremony is
freeze→inventory→re-derive→bless(`identity-regime: content-v2`)→verify
against the stage-11 corpora; without it: silent divergence, fake freshness,
forensic loss. Recommendation: E2 as its own stage, ceremony as its TASK 1.

## Task 6 (operator override) — the run

Launched 03:26 per the override (glm-4.6, concurrency 2, OPENCODE shim,
guard env, docking-slice order; pre-flight in the tracker; settings.json
tripwire `1d0aac5e…` held for the whole run). Crossed discovery +
formalization with **12 gates, 12 accepted, zero repairs** — the cleanest
formalization passage to date. Development accepted ~20 more cards with
substantive review loops. **Aborted 08:02 on the operator's tripwire**
(4× `path-outside-authority` post-re-carve; snapshots
`stage12-path-outside-authority-x4` and
`stage12-abort-path-outside-authority-postrecarve`). Two defects for your
arbitration:

1. **The re-plan carve minted a workplace the dispatcher never adopted** —
   fresh workplace idle at revision 0 while the engine ground the original
   to revision 93 across 6 recovery epochs. The designed structural-feedback
   actuator is broken in the last mile.
2. **Scope-vs-AC structural conflict**: AC-14 demands "all required services
   (backend, frontend…)" while the frozen changeScopes contain no
   `frontend/` prefix — the worker is rejected for creating exactly what the
   card's review demands. (Alternative reading to settle from the snapshot:
   frontend belongs to one of the 6 never-run todo cards and the reviewer
   misattributed AC-14 — the freeze-time coverage check would catch either
   form.) Fix options ranked in the tracker conversation: re-carve adoption
   fix (smallest, highest leverage) → freeze-time AC-coverage check (uses the
   landed constraint-register pattern) → bounded widen-on-rejection →
   worker scope-negotiation tool (contract change, yours alone).

Per the override's own rule the run's failure cancelled the conditional E9
recycle — the reserve is untouched and `E9-RESERVE.md` still governs.

## What was not finished

- **Step 4 (derived-canonical testCommand)** — by design of the night's
  budget, honestly not reached.
- **snapshot-test-mvp merge** — held pending your read of Task 4.
- **The lifecycle sanctioned-writer violation** (`replan-supersede.ts`) —
  pre-existing, escalated, untouched.
- Two unreproduced test flakes recorded with context (names not captured
  in-flight; both four-times-green on rerun).

— main agent, stage-12 night shift. The tracker's append-only log is the
minute-level record; this report is the integration.
