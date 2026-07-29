---
name: saga-bug-diagnostician
description: "Disciplined diagnosis loop for hard bugs, performance regressions, and flaky failures in a saga product. Builds a tight red-capable feedback loop, minimises the repro, forms falsifiable hypotheses, instruments with tagged probes, then hands a documented root cause to the worker/recovery pipeline. One diagnosis = one launch. Distinct from saga-diagnostician (which analyses the engine's own looping-worker state, T-011)."
---

# saga-bug-diagnostician — disciplined bug diagnosis for a saga product

<!-- source: EXT-18 mattpocock/skills — engineering/diagnosing-bugs/SKILL.md (Phase 1-6 loop, feedback-loop construction, minimisation, ranked falsifiable hypotheses, tagged instrumentation, correct-seam regression test). Adapted to CGAD: one launch = one diagnosis claim (not a loop); it does NOT self-authorise a production fix — it produces a documented root cause that a worker/recovery task acts on, consistent with the no-self-authorization invariant. Terminology reconciled (AC/episode/baseline/worktree). -->

## Why this skill exists

`saga-diagnostician` analyses the **engine's** stuck state (a worker burnt
`MAX_ATTEMPTS` looping on the same task — T-011). It never looks at a concrete
*bug* in product code. This skill fills that gap: when the report is
"something is broken / throwing / slow / flaky / regressed" in a **product**
under a saga episode, this is the disciplined diagnosis loop that runs.

It is **not** a fix-it loop. CGAD keeps LM-proposes / controller-authorises /
evidence-decides separated. This skill produces a **documented root cause +
a regression-test recommendation**; the actual production fix happens either
inside a normal `saga-worker` dev task (typical) or a recovery task, against
the frozen AC. Never self-authorise the fix.

## When to use

- A worker, reviewer, or human reports a product bug/regression/flakiness and
  the cause is unknown.
- An AC's behaviour is correct in the etalon but the implementation diverges
  intermittently (flaky) or under specific conditions.
- A performance regression against an NFR baseline.
- NOT for engine-loop diagnosis — use `saga-diagnostician` (T-011).
- NOT for healing gate failures / broken traces / missing merges — use
  `autonomous-recovery`.

## Product-board contract

Same as every worker skill: resolve `project_id` from `.saga/project.json`
(or the runner assignment). Work inside the relevant repository's worktree.
Read the AC/SRS to anchor "correct behaviour"; never diagnose against vibes.

## One diagnosis per launch

You take ONE reported symptom, run the diagnosis loop below, and exit with a
documented root-cause claim (plus evidence + a regression-test recommendation).
You do NOT loop across multiple bugs in one launch; the orchestrator spawns you
again for the next. If you discover a *different* bug mid-diagnosis, log it
(`note_save` or `comment_add`) and stay on the original symptom.

## The loop — skip phases only when explicitly justified

### Phase 1 — Build a feedback loop (THIS is the skill)

Everything else is mechanical. If you have a **tight** pass/fail signal that goes
red on *this* bug, you will find the cause. Without one, no amount of staring at
code saves you. **Spend disproportionate effort here. Be aggressive. Be creative.
Refuse to give up.**

Ways to construct one — try in roughly this order:

1. **Failing test** at whatever seam reaches the bug (unit / integration / e2e).
2. **HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network.
5. **Replay a captured trace** (saved request / payload / event log) through the code path in isolation.
6. **Throwaway harness** — minimal subset (one function, mocked deps) exercising the bug path.
7. **Property / fuzz loop** — if the bug is "sometimes wrong output", 1000 random inputs and look for the failure mode.
8. **Bisection harness** — if the bug appeared between two known states, automate "boot at state X, check, repeat" for `git bisect run`.
9. **Differential loop** — run the same input old-vs-new (or two configs) and diff outputs.
10. **HITL bash script** — last resort, if a human must click; drive them with a structured script so the loop is still structured.

> Reuse the project's Build-gate commands from the SRS §9 stack declaration
> where they overlap — a failing `npm test` filter is often the cheapest start.

**Tighten the loop** (treat it as a product): make it faster (cache setup, skip
unrelated init, narrow scope); sharper (assert the *specific* symptom, not
"didn't crash"); more deterministic (pin time, seed RNG, isolate FS, freeze
network). A 30s flaky loop is barely better than none; a 2s deterministic one is
a debugging superpower.

**Non-deterministic bugs:** the goal is a **higher reproduction rate**, not a
clean repro. Loop the trigger 100×, parallelise, add stress, narrow timing
windows, inject sleeps. A 50%-flake is debuggable; 1% is not — keep raising the
rate until it is.

**When you genuinely cannot build a loop:** stop and say so explicitly. List
what you tried. Use the ASK flow (one targeted question) or request a captured
artifact (HAR, log dump, core dump, timestamped recording) / permission for
temporary production instrumentation. **Do NOT proceed to hypothesise without a
loop** — jumping to a theory before a red-capable command exists is the exact
failure this skill prevents.

**Completion criterion — a tight, red-capable loop.** Phase 1 is done when you
can name **one command** (script path, test invocation, curl) that you have
**already run at least once** (paste the invocation and its output), and that is:

- [ ] **Red-capable** — drives the actual bug code path and asserts the **user's
  exact symptom**, so it can go red on *this* bug and green once fixed. Not
  "runs without erroring" — it must be able to *catch this specific bug*.
- [ ] **Deterministic** — same verdict every run (flaky bugs: a pinned, high
  reproduction rate).
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended.

No red-capable command, no Phase 2.

### Phase 2 — Reproduce + minimise

Run the loop. Watch it go red. Confirm:

- [ ] The loop produces the failure the **reporter** described — not a different
  nearby failure. Wrong bug = wrong fix.
- [ ] Reproducible across runs (or at a high enough rate for flaky bugs).
- [ ] You captured the exact symptom (error message, wrong output, slow timing)
  so later phases can verify the fix addresses *it*.

**Minimise:** shrink the repro to the smallest scenario that still goes red.
Cut inputs, callers, config, data, steps **one at a time**, re-running after
each cut — keep only what is load-bearing for the failure. A minimal repro
shrinks the hypothesis space and becomes the clean regression test in Phase 5.
Done when **every remaining element is load-bearing** (removing any one goes green).

### Phase 3 — Hypothesise (ranked, falsifiable)

Generate **3–5 ranked hypotheses BEFORE testing any.** Single-hypothesis
generation anchors on the first plausible idea. Each must be **falsifiable**:

> Format: "If \<X\> is the cause, then \<changing Y\> will make the bug disappear
> / \<changing Z\> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen.

Record the ranked list in a `comment_add` so the worker/recovery task inherits
it. Do not block on human input here unless you are genuinely out of hypotheses.

### Phase 4 — Instrument

Each probe maps to a specific prediction from Phase 3. **Change one variable at a
time.** Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log with a unique prefix**, e.g. `[DEBUG-a4f2]`. Cleanup at the
end is a single grep. Untagged logs survive; tagged logs die. Remove all probes
before exit (see Phase 6) — never leave instrumentation in a worktree that may
merge.

**Perf branch:** for performance regressions, logs are usually wrong. Establish a
baseline measurement (timing harness, `performance.now()`, profiler, query plan),
then bisect. Measure first, fix second.

### Phase 5 — Root cause + regression-test recommendation

Identify the winning hypothesis. Then recommend a regression test — **but only
if there is a correct seam**.

A correct seam is one where the test exercises the **real bug pattern** as it
occurs at the call site. If the only available seam is too shallow (single-caller
test when the bug needs multiple callers; unit test that can't replicate the
chain that triggered it), a regression test there gives false confidence.
**If no correct seam exists, that itself is the finding** — note it; the codebase
architecture is preventing the bug from being locked down, and that belongs in
the handoff (consider an architecture task).

If a correct seam exists, recommend: turn the minimised repro into a failing test
at that seam, watch it fail, then (in the *worker* task, not here) apply the fix
and watch it pass; re-run the Phase 1 loop against the original un-minimised
scenario.

> Anchor "correct behaviour" to the **AC / baseline / RULE / NFR** — not to the
> current implementation. If the bug is that the code matches the AC but the AC
> is wrong, that is a formalization gap (open a note, do not silently "fix" code
> against an unstated expectation).

### Phase 6 — Cleanup + handoff

Required before declaring done:

- [ ] Original repro no longer reproduces — re-run the Phase 1 loop and confirm
  it STILL goes red (you did not accidentally fix it by instrumentation). The
  fix is the worker's job; your exit state is "loop is red, root cause known".
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix in the
  worktree; confirm zero matches).
- [ ] Throwaway prototypes/harnesses deleted or moved to a clearly-marked debug
  location OUTSIDE the merge path.
- [ ] The winning hypothesis + the minimal repro + the recommended regression
  seam are written into a `comment_add` / `note_save` so the worker or recovery
  task inherits the full chain.
- [ ] State what would have prevented this bug. If the answer is architectural
  (no good test seam, tangled callers, hidden coupling), say so — that is a
  candidate for a separate architecture task, raised AFTER the fix, not before.

## Output (the exit claim)

Exit via the normal completion path for how you were launched
(`worker_done` if you held a task; otherwise a final note + summary). The claim
must contain:

- **Symptom** (as reported, verbatim) + the **one red-capable command** with its
  actual output pasted.
- **Minimal repro** (the load-bearing elements only).
- **Root cause** (the winning hypothesis, stated as the cause).
- **Rejected hypotheses** (one line each, with the prediction that falsified them).
- **Regression-test recommendation** (seam + shape), OR the explicit finding that
  no correct seam exists + why.
- **Prevention note** (architectural change that would stop the class of bug).

## Anti-patterns (do NOT do these)

- **Do not jump to a hypothesis before a red-capable loop exists.** This is the
  #1 failure the loop prevents.
- **Do not log everything and grep.** Targeted probes mapped to predictions only.
- **Do not leave `[DEBUG-...]` probes in the worktree.** One grep, zero matches.
- **Do not self-authorise a production fix.** You diagnose; a worker/recovery
  task fixes against the AC. (CGAD no-self-authorization invariant.)
- **Do not "fix" code to match an unstated expectation.** If the AC is the
  problem, raise a formalization note.
- **Do not diagnose a different bug than the one reported.** Log it; stay on scope.
- **Do not treat a flaky-green run as "fixed".** Confirm the loop still goes red
  at the exit state.

## Rules

- One diagnosis per launch. Exit after handing off the documented root cause.
- The AC / baseline / RULE / NFR is the arbiter of "correct", never the current
  implementation or a vibe.
- Honest output: if you could not build a loop, say so and stop — do not paper
  over it with a plausible-sounding theory.
- Respect worktree isolation: all probes live in your worktree and are removed
  before exit; never touch the shared checkout.
