# Agent brief — saga-mcp, stage 18: repair what the run proved, then rebuild clean

Continues the stage-15 run. **All rules from stages 2–17 still apply.**
**Do not launch a factory run** — stage 19 does that, on this build.

Branch `saga4`.

**Sequencing note.** You hold two unexecuted briefs (16, the matrix; 17, the
axes). Both build tests. **This stage comes first**, because the stage-15 run
already proved two defects with data, and constructing a matrix to re-discover
them would spend a night proving what we know. Build the matrix after this, to
catch the *next* class.

---

## 0. What the run proved

Verified by the architect directly in `.factory-sandboxes/stage15-db`, submit by
submit:

```
task 19:  sub 14  tsconfig:Y  → scope fence rejects
          sub 15  tsconfig:-  → ACCEPTED → terminal, forever
task 18:  sub 17  tsconfig:Y  → rejects
          sub 18  tsconfig:Y  → rejects
          sub 19  tsconfig:Y  → rejects + widening GRANT (rev 1)
          sub 20  tsconfig:-  physics/index:-  → author gate ACCEPTED
```

Both cards needed the same root file. Both eventually surrendered it. One was
caught only because that card's reviewer happened to run a build; the other's did
not, and it reached terminal with the hole. **Same defect, different outcome, by
luck.**

The widening mechanism worked — a grant was recorded in the ledger at 12:50:54.
**The worker was never told.** It re-staffed, self-limited to the original carve,
and dropped both files.

### The two defects, and why they are two and not three

**R1 — the authority is computed and not delivered.**
`tracker-view/claude-runner.mjs` contains **zero** occurrences of `changeScopes`;
`src/lifecycle/work-assignment-core.ts` contains **zero** occurrences of
`widening`. The worker is never told its scope — original or widened. It learns
the fence only by violating it and reading the rejection.

**R2 — a card may silently narrow its own claimed surface.**
Sub 19 claimed `tsconfig.json`; sub 20 did not; the author gate accepted. Nothing
compares a card's claim across its own attempts.

**The shared-root-file problem (D7) is not a third defect.** The grant *was*
issued for `tsconfig.json` — the machinery handled it correctly. What failed was
delivery. Fix R1 and the shared file arrives through the widening path that
already exists. The residual question — two cards contending for it
simultaneously — is real but rare, and is **not this stage's work**.

**Cost of these two:** five author rounds and a review cycle to rediscover what
one delivered sentence would have prevented.

---

## TASK 1 — deliver effective scopes to the worker (R1)

The single highest-value change available in this project right now.

**RED first.** A test proving the worker's assembled prompt does not state its
change scopes. You have the harness: `tests/worker-prompt-assembly.test.mjs`
already calls the exported `buildPrompt` and asserts on its text.

Then deliver:

- [ ] T1.1. The worker's prompt states its **effective** scopes — the frozen
      carve **plus every granted widening** — read through the same
      effective-scope path the check provider already uses. Do not re-derive it;
      one reader, one truth.
- [ ] T1.2. Freshness: a worker staffed **after** a grant sees the widened set. A
      worker staffed before it does not silently keep a stale set into a new
      attempt — the value is resolved at staffing, and staffing happens per
      attempt.
- [ ] T1.3. State it as an authority, not a hint. The worker must be able to tell
      "these paths are yours" from "these paths are suggestions".
- [ ] T1.4. Keep the teaching suffix in the rejection. It stops being the only
      channel; it stays useful as a reminder.
- [ ] T1.5. Extend the prompt-assembly suite: scopes present, widened scopes
      present after a grant, and the negative — **assert the prompt is not empty
      of scope**, so this can never silently regress to zero again.
- [ ] T1.6. Non-vacuity: remove the delivery, confirm the new assertions go RED,
      restore, quote the RED verbatim.

**Do not change what the fence enforces.** This task changes what the worker
*knows*, not what it is *allowed*. If you find yourself editing a check provider,
you have left the task.

## TASK 2 — claim-surface monotonicity (R2)

**RED first**, from the real shape: a card claims a file in attempt N and does not
claim it in attempt N+1, with no disposition. Assert acceptance is refused.

The rule:

> **A card may not silently narrow its own claimed surface between attempts.**
> Dropping a previously-claimed file is either an explicit disposition or a
> regression.

- [ ] T2.1. Copy the shape from the mechanism that already exists:
      `development.readiness-profile-monotonicity.v1` forbids the declared
      verification surface from shrinking. Same shape, second object — read it
      before designing anything.
- [ ] T2.2. Compare a card's claimed surface across its own attempt history. This
      needs **no semantics and no knowledge of what the criteria require** —
      that dependency is break 1 and it is unbridged. Durable submit history is
      sufficient and it is already there.
- [ ] T2.3. A narrowing is not automatically a failure: it is legal **with a
      disposition** ("no longer needed, because…"). Without one it is refused,
      with a typed diagnostic naming the dropped paths.
- [ ] T2.4. Escalation path, not a wall: a card that must narrow and cannot say
      why reaches a named terminal, never a loop. Stage 13's lawful-transition
      discipline applies.
- [ ] T2.5. Non-vacuity: disable the comparison, confirm RED, restore, quote it.

**Verify against the run's real data.** Your test must fail on the sub-19 → sub-20
shape and on the sub-14 → sub-15 shape. Reproduce them **domain-free** — no
`tsconfig.json`, no TypeScript, no path from this run.

## TASK 3 — rebuild clean and prove the baseline

The factory executes `dist/`, and stage 19 runs on this build.

- [ ] T3.1. `npm run build` — exit 0. Remember it deletes `dist/` first; nothing
      may be running.
- [ ] T3.2. Full baseline, every suite, real counts. Reconcile any count that
      moved against the task that moved it. Task 1 and task 2 both add
      assertions; nothing else should shift.
- [ ] T3.3. Confirm the tree is clean and paste `git rev-parse HEAD`. Stage 19's
      pre-flight requires a build attributable to a commit.
- [ ] T3.4. Report the exact numbers as the stage-19 baseline.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build
node --test "tests/architecture/*.test.mjs"
node --test "tests/lifecycle/*.test.mjs"
node --test "tests/process-modules/*.test.mjs"
node --test "tests/infrastructure/*.test.mjs"
node --test "tests/factory-e2e/w9-*.test.mjs"
node --test tests/worker-prompt-assembly.test.mjs
node --test tests/factory-contract/golden-path.test.mjs
```

One commit per task. Push to `origin saga4`.

---

## Escalate, do not decide

1. **Anything that widens what the fence permits.** Task 1 changes knowledge, not
   permission.
2. **Two cards contending for the same root path simultaneously** — the residual
   of D7. Report if you meet it; do not design for it here.
3. **Any narrowing case where a disposition cannot be expressed** — that is a
   grammar gap and an architect decision.
4. **Starting a factory run.**

## Report format

Task 1: the prompt excerpt showing delivered scopes, before and after a grant,
and the non-vacuity RED verbatim.
Task 2: the two domain-free reproductions and their RED messages.
Task 3: the full baseline and the HEAD SHA for stage 19.

State what you did not finish.
