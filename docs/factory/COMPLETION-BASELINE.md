# Factory Completion — Baseline & Finish Line (P0-01)

> Status: **pinned**. Changed only by an explicit baseline-repin commit.
> Owner: integrator. Source plan: *Saga Factory Completion Execution Plan* (34 cards).

## Baseline

| Field | Value |
|---|---|
| Repository | `PortnovAlex80/saga-mcp` |
| Execution branch | `finish/factory-completion` |
| **Pinned baseline SHA** | `2d955826b88a605082873bde7e13c6583974843f` (`saga4` HEAD at plan start) |
| Plan-stated baseline | `3c5decc90789558c8db9e6201bcd8469057f7fda` — **superseded**, see drift recon below |
| Baseline date | 2026-08-12 |

## Drift reconciliation — why baseline moved from `3c5decc` to `2d95582`

The plan was authored against `saga4@3c5decc`. At execution start, `saga4` HEAD had
advanced by two commits. Both are relevant background but **neither completes a plan
card** (no prescribed commit subject + proof), so **zero of the 34 cards are credited**.

| SHA | Subject | Plan relevance | Card credited |
|---|---|---|---|
| `cb3e944` | `feat(verification): polyglot local-runnability gate (gradle/maven/npm)` | Touches only `local-runnability-check-provider.ts`. Background for LR-03/LR-04; does not satisfy either card (no deterministic command-policy/profiling commit with the prescribed subject and proof). | none |
| `2d95582` | `fix(contract): unify acceptance-criterion identity — criterionId = artifactId` | AC-identity unification. Background for the evidence contract (P0-02) and C5-04 fixtures; does not satisfy a card. | none |

**Decision:** re-pin to `2d95582`. Real work is not rolled back. These two commits are
inherited by every task branch (all branches cut from `2d95582`).

## Finish line (primary)

Fresh scripted E2E **and** fresh real GLM-4.7 E2E reach **durable runnable-local** with
**no authority hacks** — i.e. no `submission.task_id` fallback, no recency/latest-task
fallback, no manual-SQL authority fabrication.

## Open work at baseline (reconciliation with stated open-work list)

- **C5** (task-authority binding): **OPEN**. The current task must bind via the
  accepted-authority **head**, not `submission.task_id`. ADR-053 C5-task analysis
  (commit `3c5decc`) confirms `submission.task_id` breaks carry-forward.
- **C7** (monotonic lease fencing): **PARTIAL**. Fencing incomplete; stale lease
  holders can still complete/fail newer work.
- **W5** (Development settlement → exact local-ready proof): **NOT CLOSED**.
- **W9–W12**: **PENDING** (scripted E2E, real-model run, inspection, final declaration).
- **C14** (cumulative `WorkplaceProductionRevision`, X+Y ≡ X then Y): **DONE**
  (commits `f64a22d` and prior gate cluster).

## Execution model

- **Max parallel:** 2 coding agents + 1 non-coding integrator (integrator does not edit
  production code while a task is active).
- **One card = one commit = one push.** Task branch `finish/<id>-<slug>`; the integrator
  cherry-picks one-for-one onto `finish/factory-completion` and pushes it.
- **Push mode:** every accepted step is pushed to `origin`
  (`origin/finish/<id>-<slug>` + `origin/finish/factory-completion`).
- **Direct parallel push to `saga4` is forbidden.** `saga4` / `origin/saga4` stay
  untouched for the duration of the plan (active factory `mars-venus-e2e-20260811-015`
  runs there and must not be disturbed).

## Budget & stop rule

- 34 planned commits + up to **3 reserved DFX** (defect/split) slots. Hard max: **37**.
- A live defect consumes one DFX slot (regression test + fix), then returns to the failed
  acceptance task. It does **not** open a new workstream.
- If 3 DFX slots are consumed and W9/W10/W11 still fail → **W12-03 becomes a documented
  no-go**. The plan is not expanded in place.

## Gates (integrator stops for the human)

1. **End of C5** — `C5-05` ratchet green; proceed to C7-closure / LR.
2. **CI-03** — clean-checkout baseline == working checkout (no hidden local dependency).
3. **W10-02** — real GLM-4.7 run (needs operator + endpoint + DFX budget watch).
4. **W12-03** — final go/no-go sign-off + tag.

## Lane map

| Lane | Cards | Role |
|---|---|---|
| Integrator | P0-01, P0-02, C5-05, LR-07, CI-03, W9-04, W10-01, W10-02 (co), W12-01/02/03 | integrator (this agent) |
| Authority A | C5-01, C5-02, C5-03 | coding agent (serial) |
| Verification V | C5-04, C7-07, W11-01 | coding agent |
| Fencing B | C7-01…C7-06 | coding agent (serial) |
| Readiness C | LR-01…LR-06 | coding agent (serial) |
| Quality Q | CI-01, CI-02 | coding agent (serial) |
| E2E E | W9-01, W9-02, W9-03 | coding agent (serial) |
