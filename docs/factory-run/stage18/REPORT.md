# STAGE-18 REPORT — fix what the run proved, then rebuild cleanly

Date: 2026-08-20. Branch: saga4. Pre-flight HEAD for stage 19:
**aadba7de4a1757e9fa27b8a07a6e89cb2b43b17e** (`aadba7de`).

## The three repairs (each RED-first, non-vacuum proven, one commit each)

| Fix | Commit | What it closes (live evidence from the stage-15 run) |
|---|---|---|
| **R1** — claim-time delivery of the effective write authority | `b9bcb063` | The widening grant at 12:50:54Z never reached the re-staffed worker (12:51:29Z): it self-limited to the stale carve, the author gate accepted the silent surrender; card 1 went TERMINAL with the hole. Now: `findNextClaimable` resolves carve ∪ grants through the SAME ledger reader the fence consults (wired by the adapter), carries it on the card and `AssignedWork`, and the prompt renders the WRITE AUTHORITY section with the values. Delivery-only — the claim gates are untouched. Delivery of a grant is journalled (`authority.grant_delivered`). |
| **R2** — claim-surface monotonicity ratchet | `fc062f77` | Card 1 claimed root.config on sub 14, dropped it on sub 15 — accepted terminal. Card 2 claimed it on 17/18/19, dropped it on 20 — passed the gate. `development.implementation-claim-monotonicity.v1`: the UNION of all prior submissions of the same task is the surface; a path absent without an explicit `snapshot.droppedFiles {path, reason}` disposition fails typed `IMPLEMENTATION_CLAIM_NARROWED` naming the path and teaching the exit. Author plan v3; capability admission 25→26 (ADR-082 same-commit count); payload contract v1.2.0 pins the disposition shape. |
| **R3** — attributed integration diagnostics + the tree-stamp contract | `7a51617b` | sub 22 stamped its COMMIT sha into `snapshot.treeSha`; the payload accepted; the effect failed on the TREE arm but printed the BRANCH arm ("submitted X but branch is X", equal shas) — an uninterpretable repair loop that no re-staffed worker could close. Now: `reviewedSourceMismatchReason` names the arm that failed (vanished commit / tree mismatch with the stamping cause named / branch move), and payload contract v1.3.0 rejects a treeSha equal to the commit sha AT SUBMISSION. |

Non-vacuum evidence: R1 — the runner patch stashed away → 12 pass / 3 fail,
restored → 15/15. R2 — the comparison disabled in dist → live shapes A/B and
the union case flip to pass, bytes restored. R3 — both arms (attribution +
contract rule) disabled in dist → exactly those tests fail, bytes restored.

## The full baseline (TASK 3) — real counts

First full-tree run in weeks: **4169 tests, 4097 pass, 43 fail, 29 skipped.**
All 43 triaged: **zero from R1/R2/R3** — fixture drift behind moved contracts
(K3 handler digests, WorkIntent boundary, NodeRun v2, sticky recovery budget,
deleted 'defer'/'inconclusive'), the operator's same-day OPENCODE executor
guard, and the byte-frozen golden corpus being swept by test discovery.
Repaired cluster by cluster (`aadba7de`); the golden corpus is excluded by a
new canonical full-suite entry (`tools/run-full-suite.mjs`) that enumerates
explicitly and refuses vacuous greens (the programmatic `node:test` run()
API silently executed nothing — caught and replaced with chunked CLI runs +
aggregated-count guards).

**FINAL: 4193 tests, 4164 pass, 0 fail, 29 skipped, 462 files, exit 0.**

Stage-15 bookkeeping closed in the same cycle: TASK 3 answers in
`docs/factory-run/stage15/RUN-TRACKER.md` (`fd4a8273`).

## Stage-19 readiness (the run from development on the rebuilt factory)

- Parent state (verified read-only from `.factory-sandboxes/stage15-db`):
  lifecycle 1 **failed@solution-development** — an EXACT continuation parent;
  discovery 'go', formalization 'formalized' (both completed).
- The workshops-1/2 capsule is durable: the failed dev process run's
  `input_snapshot` holds the complete development entry contract (srs,
  solutionContract, acceptanceCriteria + hashes, formalizationCertificate,
  policy, repositories) — content-frozen at formalization time.
- Product repo: `dev` = c700df8 ("factory: integrate task #19" — card 2's
  round-5 work is integrated); task 18's seven unmerged execution branches
  remain; the formalization base is 224dc22.
- Entry design (verified against the authorize mechanics):
  `continuations.authorize({resumeStageId: 'solution-development',
  stageOverrides: [{moduleRef: <STANDARD development module>,
  additiveInputMapping: <the frozen capsule keys from $.continuation>}]})`
  — additive keys override the stage's normal formalization-sourced mapping
  (verified in sqlite-lifecycle-continuation-repository). NO adoption, NO
  carry-forward: the planner re-carves the graph fresh. Exercise: tag the
  current dev head, reset `dev` to 224dc22 for the clean re-development.
  This exercises R1 (authority delivery at every staffing), R2 (fresh cards,
  any silent narrowing refused) and R3 (tree stamping caught at submission)
  in their intended production path.
- NOT suitable for the goal: the EXISTING `factory continue` path — it
  authorizes the MANAGED recovery module (deterministic single item, textual
  SourceChangeCandidate, empty author plan): a recovery stub that would not
  exercise the standard development path the fixes target.

Stage-17 remains parked last in the queue (liveness measure in stash@{0};
g-world-fidelity green 8/8, held uncommitted for stage 17).
