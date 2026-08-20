# Agent brief — saga-mcp, stage 15: the run that tests the repairs

Continues `docs/factory-run/stage14/ARCHITECT-STAGE14-REPORT.md`. **All rules from
stages 2–14 still apply**, except that this stage **does** launch a factory run,
under §0.3.

Branch `saga4`.

---

## 0. Why a run and not more code

Both halves of break 2 are closed and **verified by the architect's own hand**,
not accepted from the report: the derived-canonical enforcement was disabled via a
temporary probe, rebuilt, and the 7-of-9 gaming manifest then read
`actual: 'passed', expected: 'failed'`; restored, it fails. The mechanism fires
and the negative test is not vacuous. Break 2a fails closed with
`ENVIRONMENT_DERIVATION_UNDECLARED_NEED` before any process starts.

Break 1 is not bridged and is **deliberately not this stage's work** (see §0.4).
Stage 13 made its residue lawful, which is what makes a run worth doing at all.

**Blind repair has stopped paying.** Three properties are now implemented and
none has ever met a real model:

1. **Does the scope-widening transition work under load?** Proven on a domain-free
   fixture, never against an LLM that improvises.
2. **Does the factory self-terminate?** The stage-12 run sat `paused` for over a
   day, F6 never fired, and the engine finally **died around 09:42 rather than
   concluding**. The answer today is *no*. This is the single most important open
   question in the project.
3. **Is the terminal label now true?** GDesign failed honestly; nothing has yet
   *succeeded* honestly.

Only a run answers these. That is the whole stage.

### 0.3 Run conditions

Unchanged from stage 10 and non-negotiable: workers route through the
opencode/agent-proxy shim to z.ai GLM; `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`
or the launcher env pointing at agent-proxy stays set; concurrency ≤ 2 per the
canonical profile; `~/.claude/settings.json` is hash-baselined before start and
re-checked every cycle, and **any change to it aborts immediately**.

Task 0 build discipline from `STAGE-10-AGENT-BRIEF.md` applies in full: the
factory executes `dist/`, `npm run build` deletes `dist/` before `tsc`, and
rebuilding under live workers removes the MCP server out from under them. Paste
build exit code, `dist/index.js` mtime, HEAD SHA and a clean tree before starting.

### 0.4 What this stage is NOT

Do not bridge break 1. Do not start an artefact-class vocabulary. The architect's
position, for the record so nobody re-derives it:

> A criterion **does** determine the artefact *class* it requires; it does not
> determine the *path*, and the path is correctly the implementer's decision. The
> fix is therefore scope expressed in classes rather than paths — which needs an
> artefact-class ontology, which is C12's `MaterialAdapter`, which is gated behind
> M6. The interim is to carry the order-constraint register one level down so a
> criterion names its required classes. And the lawful transition from stage 13 is
> **permanent regardless** — even a perfect ontology cannot predict a need the
> criterion did not imply. The ontology shrinks how often the transition fires; it
> never removes it.

That work is stage 16 and it is better decided with this run's evidence than
without it.

---

## TASK 1 — instrument for the three questions before starting

The stage-10 journal recorded 241 events and not one failure; the stage-12 engine
died and we learned it afterwards. Do not repeat either.

Before launch, ensure the run will produce direct evidence for each question:

- **Scope widening:** every declaration, contention decision, grant and refusal
  journalled with its correlation keys and the resulting scope revision. If zero
  widenings occur, that is also an answer — record it explicitly rather than
  leaving silence.
- **Self-termination:** a watchdog that samples the lifecycle run's `status`,
  `terminal_status` and workplace `revision` on a fixed interval and writes each
  sample. **Stagnation is a result, not a reason to wait longer.** Define the
  threshold before you start, write it in the report, and honour it.
- **Label truth:** on terminal, whatever it is, independently verify the claim.
  If the terminal says `runnable-local`, check it actually runs, from a clean
  checkout, by the derived canonical set. Stage 11's terminal was a lie that took
  a separate investigation to expose; this time the check is part of the run.

The journal must carry failure and terminal event kinds (stage-11 task 5). If it
still cannot express "the engine died", fix that first — it is a twenty-minute
job and it is the difference between evidence and a shrug.

## TASK 2 — the run

**Use the same order as stage 12.** Not a new one. It is the only order where we
have seen the deadlock, and comparability is the point. A different order tests
a different thing and answers none of the three questions.

Pre-flight: fresh DB, fresh sandbox, fresh logs, clean pre-run snapshot, resolved
model route pasted, and every §0.3 condition confirmed in writing.

Then start it and **observe**. The discipline from stages 10–11 holds absolutely:

- **Do not repair mid-run.** Snapshot first, then let the factory's own recovery
  act. Editing the database to unstick a run destroys the evidence and proves
  nothing about whether the factory can recover — which is question 2.
- **Do not raise concurrency or change the route mid-run.**
- **A dead run is a result.** Snapshot it, file the findings, report.

### Abort conditions — stop and snapshot

- an authority write you cannot attribute to `AuthorityCommit`;
- a workplace the progress sweep classifies `inconsistent_state`;
- the settings-hash baseline moving;
- the watchdog's stagnation threshold reached;
- **the engine process disappearing** — snapshot immediately, this is exactly
  what went unobserved in stage 12.

## TASK 3 — harvest and report

If accepted material exists, harvest the corpus — a real corpus from a run with
the repairs in place is worth more than the stage-11 one.

Report, in this order, because it is the order of importance:

1. **Did the factory terminate by itself?** Yes/no, the terminal, and the
   watchdog trace. If no — where it stopped and what the last progress was.
2. **Is the terminal label true?** The independent verification, with its
   command and output.
3. **Did scope widening fire?** How often, granted or refused, and whether any
   card still livelocked.
4. Everything else: bugs by severity, snapshots, corpus path.
5. **What you could not explain.**

---

## Verification baseline before launch (paste real counts)

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 411 pass
node --test "tests/lifecycle/*.test.mjs"        # was 136 pass
node --test "tests/process-modules/*.test.mjs"  # was 1220 pass
node --test "tests/infrastructure/*.test.mjs"   # was 407 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"   # was 20 pass
node --test tests/factory-contract/golden-path.test.mjs
```

A run started from red or from a dirty tree is not evidence.

---

## Escalate, do not decide

1. **Any factory defect found during the run** — file it, do not fix it.
2. **Any manual database edit**, for any reason.
3. **Anything touching the operator's interactive Claude channel.**
4. **Bridging break 1**, or starting an artefact-class vocabulary — stage 16.
5. Extending the run past the watchdog threshold because it "might still
   finish". That decision was made in advance for a reason.

## Report format

Per §TASK 3, in that order. State plainly what you could not explain.

An honest "it stopped here and I do not know why, here is the snapshot" is the
correct outcome. A narrative that smooths over an unexplained stop is not.
