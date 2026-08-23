# CC-00B — Elite-6 Terminal Integrity: Clean Termination, Failed Product Outcome, Terminal-Projection Defects (2026-08-22)

Package: `CC-00B` of `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` (critical path:
`CC-00 -> CC-00B -> CC-00C -> CC-10A`). Owner: integration owner; gap owners
named per CC-GAP-2..5 below. This record is documentation only: **the runtime
is not fixed by it** (see the final section).

## Classification

- **Clean operational engine termination.** The Elite-6 engine terminated
  cleanly at 2026-08-22T14:19:30Z with exit code 0. This is **not a crash,
  not engine death, and not a watchdog kill**.
- **Failed product outcome.** The product outcome of the run is failed, and
  the durable records say so truthfully: lifecycle `terminal_status=failed`,
  Development stage/process `local_outcome=failed`,
  `processOutcome.code=failed`, and the final development-readiness gate
  verdict is `failed` because `factory.local-runnability.v1` failed.
  Correction (CC-00C cross-check): that local-runnability failure was
  substrate unavailability — `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`, Docker
  unavailable before install/test/serve — so it never exercised the product
  and never proved or disproved browser runnability. The failed outcome
  stands, but its observed cause is infrastructure unavailability, not a
  product test result; the missing browser frontend is a separately proven
  latent product defect (see CC-00C).
- **Terminal-projection defects (CC-GAP-2..5).** Status surfaces expose
  operational completion without the product failure (false green), one
  durable WorkerExecution is left `running` after its OS process died and its
  `worker_done` was accepted, a terminal journal event is duplicated, and the
  external watchdog failed at startup due to CLI flag drift.
- **Expected early end, not an incident.** Delivery was configured with
  `delivery.mode=deferred`; ending at Development is the expected shape of
  this run and is not part of the defect.

Summary classification: **a clean operational engine termination with a
failed product outcome and terminal-projection defects — not a crash, not a
death.** The Elite-6 experiment is complete and immutable; product
qualification failed. The observed readiness failure was substrate
unavailability (Docker unavailable), not a product test verdict.

## Facts vs interpretation

Accepted facts (architect-verified before this record; CC-00B adds no
forensics, no DB/log access, no hashing):

| # | Fact |
|---|---|
| F1 | Engine terminated cleanly at 2026-08-22T14:19:30Z, exit 0. |
| F2 | Lifecycle `status=completed` but `terminal_status=failed`. |
| F3 | Development stage/process `local_outcome=failed`; `processOutcome.code=failed`. |
| F4 | Final development-readiness gate verdict `failed` because `factory.local-runnability.v1` failed (see Correction below: the cause was substrate unavailability, not a product test). |
| F5 | `delivery.mode=deferred` was configured; ending at Development is expected and is not the incident. |
| F6 | Journal `run.terminal` and the tracker/launch projection expose `completed` without the product failure. |
| F7 | Final task 37 has an accepted `worker_done` and a dead OS pid, but the durable WorkerExecution remains `running` and lacks `worker.exit`. |
| F8 | Duplicate `run.terminal` events exist 3 ms apart. |
| F9 | The external watchdog failed at startup because `--interval` was used while the CLI requires `--interval-seconds`; the built-in tracker supervisor remained active. |

Correction (2026-08-22, CC-00C cross-check): F4's cause is substrate
unavailability, not a product test result. The final readiness manifest
declared node:20-alpine Docker; local-runnability failed before
install/test/serve with `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`. It therefore
never proved or disproved browser runnability. Code inspection separately
proves a latent product defect — the product has client
renderer/hud/effects modules but no index.html, no DOM/canvas use, no static
serving route, and no npm start; the server exposes only healthz and 404 —
but that defect was not observed by the readiness gate. The full fact set,
the served-oracle limitation (start plus loopback HTTP plus stop only), and
gaps CC-GAP-6..10 are recorded in
`CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md` (same directory).

Interpretation (judgment, owned and to be confirmed by the named gap work —
not facts):

- I1 (from F2/F3/F4 vs F6): the false green is a **projection-layer**
  defect. The durable outcome rows are already truthful; the exposure
  surfaces drop the failure. Remedy is in projection/journal payloads, not in
  rewriting durable outcomes.
- I2 (from F7): CC-GAP-3 violates the normative synchronization edge "OS
  worker exits → terminalize the exact WorkerExecution"
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md` §23). Host status is
  observation only; assignment completion is read from the exact durable
  WorkerExecution.
- I3 (from F8): duplicate terminal emission 3 ms apart indicates a
  non-idempotent or racing terminal-event path; the exact emitter is to be
  identified by CC-GAP-4 work, not asserted here.
- I4 (from F9): watchdog CLI drift is a silent-coverage loss: the launch
  failed, nothing treated that as fatal because the built-in tracker
  supervisor stayed active. Defense-in-depth was reduced without an alarm.

## Exact timeline and identifiers

Anchors recorded at CC-00 start in `CC-00-BASELINE.md` (same directory):
launch `launch-c1fce464`, engine pid 30076, tracker pid 22632, engine dist
built from merge commit `303a482a`, model `glm-4.6`.

| When (UTC) | Record | Value / state |
|---|---|---|
| 2026-08-22, CC-00 start | Elite-6 launch identities | `launch-c1fce464`; engine pid 30076; tracker pid 22632 |
| During run | Final task | Task 37: accepted `worker_done`; OS pid dead; durable WorkerExecution `running`; no `worker.exit` (F7) |
| During run | Journal `run.terminal` | Two events 3 ms apart (F8) |
| Run end | Lifecycle | `status=completed`; `terminal_status=failed` (F2) |
| Run end | Development stage/process | `local_outcome=failed`; `processOutcome.code=failed` (F3) |
| Run end | Final development-readiness gate | verdict `failed`; cause `factory.local-runnability.v1` failed (F4) |
| Run end | Delivery disposition | `delivery.mode=deferred`; run ends at Development by design (F5) |
| Startup | External watchdog | Failed to start: `--interval` given, CLI requires `--interval-seconds`; built-in tracker supervisor remained active (F9) |
| 2026-08-22T14:19:30Z | Engine process | Clean termination, exit 0 (F1) |

Exact row/event identifiers for the duplicate `run.terminal` pair, the
task 37 WorkerExecution, and the watchdog startup error are deliberately not
asserted here; they are captured by the CC-00B copy-only evidence freeze.

## Expected vs observed

Normative expectation per the terminal-integrity guardrail (plan §3.1) and
CONVEYOR-MENTAL-MODEL §23.

| Surface / invariant | Expected | Observed | Verdict |
|---|---|---|---|
| Engine process termination | Clean exit 0 when work is done | Exit 0 at 14:19:30Z, clean | OK — operational only |
| Lifecycle outcome exposure | `terminal_status` visible wherever `status=completed` is shown | Journal `run.terminal` and tracker/launch projection expose `completed` without product failure | **CC-GAP-2** |
| Stage/process outcome exposure | `local_outcome=failed` / `processOutcome.code=failed` surfaced with completion | Durable values failed; surfaces do not carry them | **CC-GAP-2** |
| Final gate verdict | A `failed` development-readiness verdict can never present product success | Verdict failed (truthful); surfaces omit it | **CC-GAP-2** |
| Readiness failure cause | Substrate unavailability is classified separately from product failure and is never reported as having tested the product | `factory.local-runnability.v1` failed on `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE` (Docker unavailable, before install/test/serve); browser runnability was neither proved nor disproved | **CC-GAP-9** (CC-00C) |
| WorkerExecution terminalization | Accepted `worker_done` + dead OS pid ⇒ WorkerExecution terminal with `worker.exit` | Task 37 WorkerExecution still `running`, no `worker.exit` | **CC-GAP-3** |
| Terminal-event uniqueness | At most one effective `run.terminal` per terminalized scope (durable terminal claim is authority; journal honestly 0..1 under append failure) | Two `run.terminal` events 3 ms apart | **CC-GAP-4** |
| External watchdog | Starts and supervises | Startup failure (`--interval` vs `--interval-seconds`); built-in tracker supervisor active | **CC-GAP-5** |
| Delivery disposition | `delivery.mode=deferred` labeled as expected early end | Run ended at Development as configured; labeling missing/misclassifiable | Not a defect; explicit labeling required |

## Stable gaps and owners

- **CC-GAP-2 — terminal projection false-green.** Owner: trace/evidence
  owner. Journal `run.terminal` payloads and tracker/launch projections must
  carry `terminal_status`, stage/process local outcome, and the final gate
  verdict alongside operational completion. Blocking regression proof: a
  failed final gate cannot render product success.
- **CC-GAP-3 — stale `running` WorkerExecution / missing `worker.exit`.**
  Owner: execution-kernel owner. Terminalize the exact WorkerExecution when
  `worker_done` is accepted and the OS pid is dead; emit `worker.exit`.
  Blocking regression proof: a terminal run leaves zero `running`
  WorkerExecutions.
- **CC-GAP-4 — duplicate terminal event.** Owner: trace/evidence owner.
  Terminal-event emission must be idempotent and unique per terminalized
  scope. Blocking regression proof: duplicate emission is impossible or
  collapses to one effective event. The durable terminal claim is the
  authority; the journal projection is honestly 0..1 under append failure —
  exactly one is never guaranteed. Proof must also cover that a failed append
  after a durable terminal claim leaves an honest zero-event projection.
- **CC-GAP-5 — watchdog CLI drift.** Owner: integration owner. Launch flags
  must match the real CLI (`--interval-seconds`, not `--interval`); the
  watchdog launch must be smoke-tested against the real CLI; the built-in
  tracker supervisor stays explicitly classified in coverage records.

Product-claim integrity gaps CC-GAP-6..10 (semantic claim-to-work coverage,
deliverable-aware end-to-end oracle, verification reachability/accounting,
substrate failure classification/recovery, role projection clarity) are
recorded and owned by CC-00C in
`docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
and wired into K0, K2, K4, K5, K8, CC-80/81/82, and
`QUALIFICATION_GREEN`.

## Critical-path impact

- `CC-00 -> CC-00B -> CC-00C -> CC-10A` is the critical path. CC-10A code may
  remain landed, but the CC-10A exit checklist and its deferred heavy
  validation (the deferred CC-00 harvest regeneration and the three
  fresh-environment runs) cannot close before CC-00B and CC-00C exit.
- K0, K2, K4, and K5 exit evidence is incomplete while any CC-GAP-2..5 is
  open (plan §2 stage table and §3.1 wiring); K0, K2, K4, K5, and K8 exit
  evidence is incomplete while any CC-GAP-6..10 is open (plan §3.2 wiring).
- CC-81 must record each open CC-GAP-2..5 and each open CC-GAP-6..10 and stay
  RED; CC-82 cannot emit `QUALIFICATION_GREEN` with any of them open; the
  Qualification-ready definition of done requires CC-00B and CC-00C closed.

## Safe next actions

- Freeze the Elite-6 terminal evidence copy-only (both duplicate
  `run.terminal` events, lifecycle/stage/process rows, the final gate
  verdict and its cause, the task 37 WorkerExecution row, the watchdog
  startup failure record), with recorded paths and digests; keep frozen
  sources immutable.
- Implement CC-GAP-2..5 remediation in isolated worktrees under the named
  owners, each with its blocking regression proof.
- Smoke-test the external watchdog launch against the real CLI after the
  flag fix.
- Release the deferred CC-00 harvest regeneration and the deferred CC-10A
  heavy validation runs only after every CC-00B exit criterion passes.
- Label `delivery.mode=deferred` explicitly in every status surface.

## Unsafe next actions

- Do not report or record this run as a successful full factory run: exit 0,
  launch `completed`, and lifecycle `status=completed` never prove product
  success.
- Do not restart, replay, or re-open the terminal Elite-6 run to "fix"
  projections.
- Do not hand-edit SQLite, journal events, or generated evidence; do not
  delete one of the duplicate events or flip the stale WorkerExecution to
  terminal by hand — capture copy-only and fix the code paths.
- Do not misclassify the deferred Delivery disposition as product failure or
  as Delivery success.
- Do not describe the local-runnability failure as having tested the product:
  it failed on Docker unavailability (`LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`)
  before install/test/serve, so browser runnability was neither proved nor
  disproved by it. Do not present the missing frontend as the observed
  readiness failure — it is a separately proven latent product defect owned
  by CC-00C.
- Do not treat CC-GAP-5 as optional because the built-in tracker supervisor
  remained active; the external watchdog layer silently did not exist.

## The runtime is not fixed by this record

This document records classification, facts, and gaps only. Remediation
ownership belongs to the named gap owners under the plan's CC-00B
checklists and exit criteria; nothing here repairs the runtime or
reopens the run.

### Integration status (2026-08-23 refresh — branch truth, not closure)

Remediation commits have landed on the integration branch
`cc/CC-00B-terminal-integrity-integration` (HEAD `1f397348`):

| Gap | Landing |
|---|---|
| CC-GAP-2 (terminal projection false-green) | `97dbc635` |
| CC-GAP-3 (stale `running` WorkerExecution) | `9c2253e2` (receipt-authoritative terminal drain) + `f460ae84` (journal-payload strictness) |
| CC-GAP-4 (duplicate `run.terminal`) | `dd89b40c` |
| CC-GAP-5 (watchdog CLI drift) | `9205d9f5` |
| Related CC-00C-scope landings on the same branch | CC-GAP-6 `50824c6a`, CC-GAP-8 base patch `8819e360` (exit REJECTED — terminal `unknown`/`human_required` projection/CI repair in progress on `cc/CC-GAP8-TERMINAL-ACCOUNTING`), CC-GAP-10 `184b2c77`, proof-subset token-direction repair `3be7393d`, CC-GAP-1 test alignment `3ec49b6f`, CC-GAP-9 `830bce80` + post-REJECT repair `64c5fb81`, ADR-091 residual `61fccda7` + post-audit repair `417749f7` (provider `1.12.0`), CC-GLOB-SURFACE `66d04178` (source `5f3201c4`, accepted by two reviewers; two report-only residuals open: mixed literal/glob presentation and suffix-overclaim), CC-IC-1 `4c67f1d1` + `1f397348` (source `d1912c67` + `a03b5bf9`, accepted; focused integration build and focused suite 75/75) |
| K19 (ADR-083 environment identity) | NOT integrated — no K19 commit is in `1f397348`; the bounded image/dependency identity slice (`2fbf0b9f`) stays on the K19 branches and the `1.14.0` repair `f3a58a30` is REJECTED (corrupted 65-character `1.3.1`–`1.11.0` trusted-provider baseline values; circular tests hid the corruption); a separate digest repair is in progress on `cc/CC-K19-DIGEST-REPAIR`; K19 remains incomplete beyond its bounded identity slice |
| CC-GAP-7 (CC-00C scope) | open — no warrant-execution landing |

Landing is not closure, and this update marks nothing merged: none of
these commits is merged to `saga4`, the CC-00B exit checklist (evidence
freeze, blocking regression proofs, deferred-run release) has not been
re-audited, and neither this record, CC-00C, nor the plan is merged.
The durable Elite-6 states described above remain exactly as frozen;
CC-81/CC-82 must still verify each exit item before any gate passes. No
production factory run is authorized while the K19 digest repair and the
CC-GAP-8 exit repair are open (plan section 7C).

The Elite-6 experiment is complete and immutable, and product
qualification failed. Product-claim integrity remediation (CC-GAP-6..10)
belongs to CC-00C; nothing in either record repairs the runtime or
reopens the run.
