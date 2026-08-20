# Agent brief — saga-mcp, stage 14: close break 2 — stop the candidate declaring itself

Continues `docs/factory-run/stage13/ARCHITECT-STAGE13-REPORT.md`. **All rules from
stages 2–13 still apply.** **Do not launch a new factory run.**

Branch `saga4`.

---

## 0. Where this sits, and why this stage and not another

`docs/architecture/WORKSHOP-CONTROL-TRACKING.md` walked the acceptance chain
backward and found ten sound links and two breaks, both at a crossing between
representations:

| Break | Crossing | State after stage 13 |
|---|---|---|
| **1** | criterion ⟶ artefact classes | unbridged, but the residue is now **lawful** (scope widening) |
| **2a** | artefact ⟶ environment | unbridged — candidate declares (K19, 1 of 6 commits) |
| **2b** | order ⟶ check set | unbridged — candidate declares (anti-gaming step 4 pending) |

Stage 13 made break 1 **survivable**: an insufficient scope no longer livelocks,
it transitions. That was the right first move — a factory that cannot finish is
worse than one that finishes with a wrong label.

**Break 2 is what makes the label lie.** Both halves are the same sentence — *the
candidate declares what it will be judged by* — and both are already specified.
This stage closes both. Nothing else.

After this stage a terminal label means what it says, or we learn precisely why
not. That is the whole point.

---

## TASK 1 — K19 commits 2–6 (break 2a)

`docs/vision/SAGA-CORE-RENEWAL-PLAN.md` §K19 is the specification; ADR-083
(`f05dd37e`) froze the contract in commit 1. Execute the remaining train in
order:

2. isolate readiness in ephemeral environments — no shared mutable state
3. one exact environment per pinned package, image and dependency digests
   persisted
4. post-integration readiness as a Production Cell with immutable CheckReceipts
5–6. per the card

**The property that decides success:** the environment a candidate is certified
in is **derived from the artefact**, is one immutable identity, and is the same
object used for preparation and for certification. The candidate's declaration
becomes additive — it may add, never define.

**The negative test that defines done:** an artefact importing a package its
declaration omits must be caught by derivation, not by luck. This is the GDesign
failure (`pyyaml` imported, not declared, worker's polluted environment hid it) —
reproduce it **domain-free**, exactly as stage 13's RED fixture was built. No
`pyyaml`, no Python specifics.

Release discipline (plan §3): ≤ 25 production files, ≤ 6 per commit, ≤ 1 schema
migration family. If the train does not fit the stage, **stop at a clean boundary
and say where** — a fraction presented as the whole is the one unacceptable
outcome.

## TASK 2 — anti-gaming step 4 (break 2b)

`docs/architecture/CERTIFICATION-GAMING-REMEDY.md`, final rollout step, ratified.
Steps 1–3 landed; the coverage report makes narrowing **visible** but nothing
prevents it.

The executed check set is **derived from the order**. The candidate's manifest is
**additive only** — it may add checks, never remove or replace them.

**The negative test that defines done already exists**: the RED fixture in the
golden corpus replaying the real gaming — a manifest enumerating 7 of 9 test
files, excluding exactly the two failing ones, zero code change. Today it is
report-only and passes. **After this task it must not pass.**

This changes what "certified" means. Land it behind the step-1 report so the
first run shows the delta.

## TASK 3 — the satisfiability rung

`WORKSHOP-CONTROL-TRACKING.md` §3.5 names the missing test class: not "does this
check return the right verdict?" but **"does a state exist satisfying all
simultaneously enforced constraints?"**

Every gate in the stage-12 deadlock was individually correct and individually
tested. The defect lived only in their conjunction, which is nobody's unit.

Add the rung to the §23 ladder and one concrete instance of it: given the check
plans a lifecycle installs, assert a satisfying assignment exists. Start with the
containment property stage 13 made lawful — it is decidable and cheap.

If the general form is undecidable, **deliver the decidable instance and say so**.
A weaker property that holds beats a stronger one that guesses — the same rule
that governed stage 13.

## TASK 4 — the branch sprawl

Execute the cleanup instruction the architect supplied: tag before delete, prove
"merged" per branch with `git log --oneline origin/saga4..<branch>` rather than
trusting the label, release worktrees with `git worktree remove` (**never raw
`rm -rf` — a junction ate `node_modules/.bin` on 2026-08-19**), `-d` and never
`-D`, and a written verdict for anything unmerged.

`repair/snapshot-test-mvp` still needs its three answers before any verdict.

End state: `saga4` alone, every deletion archived under `archive/*`, and
`docs/architecture/BRANCH-CLEANUP-2026-08-20.md` recording it. A branch cleanup
must not move a single test count.

## TASK 5 — the stage-12 run

It is still `paused`, engine alive, no terminal. It was left running to answer one
question: **does the factory reach an honest terminal by itself?**

Record its state. If it has terminated, report the terminal and the reason. If it
is still paused with the engine cycling and no progress, **that is the answer** —
report it as such: the factory did not self-terminate, and F6 did not fire.
Either result is a real finding.

Then stop the engine and snapshot. It has given what it can.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build
node --test "tests/architecture/*.test.mjs"     # was 408 pass
node --test "tests/lifecycle/*.test.mjs"        # was 136 pass
node --test "tests/process-modules/*.test.mjs"  # was 1220 pass
node --test "tests/infrastructure/*.test.mjs"   # was 401 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"   # was 20 pass
node --test tests/factory-contract/golden-path.test.mjs
```

Tasks 1 and 2 change what certification means. **Expect suites asserting the old
declaration semantics to break, and update them in the same commit with the
reason** — that is what those assertions are for. Do not weaken one to pass.

One commit per task; K19 by its own train. Push to `origin saga4`.

---

## Escalate, do not decide

1. **K19 scope overflow** — stop at a boundary, report; never a fraction as the
   whole.
2. **Any case where the order does not determine a check set** — that is break
   1's residue showing up at break 2, and it is a design question.
3. **Any branch whose merge proof is non-empty** but which you believe is
   obsolete.
4. **Starting a new factory run.**

## Report format

Task 1: which K19 commits landed, where you stopped, the domain-free negative
test verbatim.
Task 2: the RED fixture's result before and after.
Task 3: the rung, and whether you delivered the general or the decidable form.
Task 4: the cleanup record.
Task 5: the stage-12 terminal, or the plain statement that it never came.

State what you did not finish.
