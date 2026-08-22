# ADR-087: Receipt-authoritative terminal drain

- Status: Accepted
- Date: 2026-08-22
- Builds on: ADR-053, ADR-061, ADR-075, ADR-084
- Decision-maker: autonomous-decision skill

## Context

Elite-6 reached a terminal LifecycleRun while one receipt-backed
`WorkerExecution` was still durably `running`. Its process heartbeat was recent,
but the engine exited before the runner close callback terminalized the row.
Commit `d8b67ffd` added a terminal-boundary supervision sweep and correctly
converges the dead-PID form. It does not converge the observed alive-PID form:
the stuck policy lawfully keeps a live receipt-backed closer, after which a
terminal epic has no future engine to run another sweep.

The decision fork is what the terminal boundary should do after a short natural
drain when an accepted `worker_done` or `presentation_close` receipt exists but
the OS process is still alive:

1. retain and stop an in-process runner, waiting for physical close;
2. settle the execution through the existing receipt-authoritative fenced CAS
   without killing the process;
3. refuse launch completion and create a restartable terminalization
   obligation.

This is an authority decision, not merely a timeout choice. ADR-061 already
defines the accepted receipt as semantic completion authority and states that
post-completion process drain grants no domain mutation authority. ADR-053
demotes `WorkerExecution` to execution provenance rather than material
authority. Conversely, GUARDRAILS Signs 010 and 015 require physical liveness to
remain truthful and every nonterminal scope to retain a real wake source.

## Decision drivers

Scores use 1 as poor and 5 as excellent.

| Driver | Weight | Why it matters here |
|---|---:|---|
| Authority and state truth | 3 | Neither product/material completion nor physical liveness may be fabricated |
| Deterministic terminal convergence | 3 | A completed epic normally has no later engine sweep |
| Existing-boundary alignment | 2 | Reuse the receipt check, fenced CAS and single terminal writer |
| Observability | 1 | Physical tail state and late exit evidence must remain visible |
| Reversibility | 1 | The change must be removable without schema or fact rewrites |

## Considered options

### Option A: Runner-owned physical drain

Keep a registry of undisposed executors, wait briefly, request runner stop and
await the normal close/finalize path. A residual remains active and is reported
if close or verified termination cannot be observed.

Pros:

- preserves a real close code when the callback arrives;
- reuses runner `stop`, `status` and finalize behavior;
- can clean up the OS process tree.

Cons:

- an in-process registry cannot cover previous-engine, concurrent-engine,
  remote-host or replay executions;
- Windows inherited pipes can prevent `close` indefinitely, while the fallback
  timer lives in the engine process that is exiting;
- a residual `running` row has no wake source after terminal engine exit;
- stopping a receipt-complete closer repeats the destructive Run022 pattern.

### Option B: Receipt-authoritative settlement

Allow a short bounded natural-close courtesy window. Then re-check the accepted
receipt inside the existing atomic release transaction and settle the exact
execution to semantic `exited` without killing the live process. Record that
the PID was alive, keep `exit_code` null, and allow the existing late-exit
backfill to add the physical result. The CAS winner alone emits `worker.exit`.

Pros:

- deterministic in one existing fenced transaction;
- matches ADR-061 and the central receipt-first terminal classifier;
- no new schema, writer, registry or obligation kind;
- avoids killing successful closers and preserves late exit backfill;
- runner/sweep races remain idempotent through the existing terminal-write
  winner contract.

Cons:

- the name `exited` is semantic execution completion, not proof that the PID
  has already died;
- a live, authority-dead process can consume host resources until natural or
  operator cleanup;
- physical exit evidence may remain `exit_code=null` if the engine dies before
  the late callback.

### Option C: Fail-closed launch plus terminalization obligation

After a bounded drain, settle the host launch as paused/exit 2 and append a new
`settle-worker-execution` transition obligation that retries or parks at a
human-required boundary.

Pros:

- never kills a closer and never semantically closes an alive execution;
- gives the residual an explicit durable wake source;
- maximizes operator visibility.

Cons:

- contradicts ADR-061 by allowing physical tail state to veto a receipt-complete
  run;
- adds a new obligation kind where the worker-exit consistency protocol says
  terminal classification is a deterministic projection, not an obligation;
- creates a terminal-lifecycle/paused-launch combination and depends on another
  engine start for an otherwise completed epic;
- adds the most routing and recovery surface.

## MCDA matrix

| Option | Truth (3) | Convergence (3) | Boundaries (2) | Observability (1) | Reversibility (1) | Total / 50 |
|---|---:|---:|---:|---:|---:|---:|
| A. Runner-owned drain | 5 | 4 | 4 | 4 | 4 | 43 |
| B. Receipt-authoritative settlement | 3 | 5 | 3 | 3 | 5 | 38 |
| C. Refusal plus obligation | 5 | 2 | 3 | 5 | 3 | 35 |

The initial matrix favored A. Red Team evidence invalidated three of its scores:
the residual is not truthful progress because it has no wake source; convergence
depends on Windows close delivery and a dying event loop; and the new executor
registry duplicates durable execution identity while remaining structurally
incomplete. On repository evidence, A falls below B. The decision therefore
does not follow the initial numeric leader.

## Pre-mortem on Option A

Assumption: runner-owned drain was implemented and failed six months later.

1. **Registry misses an execution from a prior or concurrent engine** —
   likelihood: high; detectable by active durable rows without a registered
   handle; mitigation: none within an in-process registry.
2. **Stop kills legitimate post-receipt cleanup** — likelihood: medium;
   detectable by truncated logs/capture and null exit observations; mitigation:
   natural grace reduces but does not remove the destructive action.
3. **Windows process or inherited pipe survives stop** — likelihood: high;
   detectable by a live birth-token-matched PID after the deadline; mitigation:
   a residual merely recreates the no-wake-source defect.
4. **Terminal drain delays watchdog-visible exit** — likelihood: medium;
   detectable by drain duration and heartbeat metrics; mitigation: hard deadline.
5. **Registry entries leak or point at a later run** — likelihood: medium;
   detectable by scope/identity mismatch; mitigation: unregister and fencing
   tests, but not coverage of foreign handles.

Net effect: Option A is replaced. Its harmless short natural-close courtesy is
retained without its executor registry, stop path or residual policy.

## Red Team

The strongest objection was that A waits for an observation whose delivery path
is destroyed by terminal engine exit. The repository already documents that
Windows `close` may never fire when descendants inherit pipes, and the five
second force-finalize timer helps only while the engine event loop remains
alive. An in-process registry is blind to previous/concurrent engines, remote
rows and replay. Every miss leaves the exact permanent `running` phantom that
CC-GAP-3 exists to remove.

The Red Team also established that Option B is existing policy rather than a
new semantic invention: `releaseExecutionAtomically` re-verifies accepted
completion receipts in-transaction and converges receipt-backed terminal
classifications to `exited`; in-process replay already records semantic
`exited` without an OS close event. A late runner callback loses the terminal
CAS and can only backfill exit evidence, preventing duplicate `worker.exit`.

Response: accepted. Switch from A to B. Keep a short natural-close courtesy
window because it improves physical evidence cheaply, but never make receipt
completion depend on close delivery and never introduce a runner registry.

## Decision

Choose Option B: receipt-authoritative terminal settlement after a short bounded
natural drain.

This operation is legal only at the terminal-run boundary after the dispatch
loop has stopped; it must not be reused by a live dispatch loop whose executor
disposal could kill a still-running closer. The engine first gives existing
in-process callbacks at most five seconds to terminalize naturally. Correctness
does not depend on this courtesy: settlement proceeds unconditionally when the
bound expires. It then performs the ordinary
supervision reconcile. Any remaining active execution in the launch scope with
an accepted completion receipt is re-verified inside the existing fenced atomic
release and settled to semantic `exited` without killing its PID at this
terminal boundary. Existing in-engine receipt-close grace and janitorial-kill
policy is unchanged. The settlement
reason and `worker.exit` observation must state whether the PID was still alive;
`exit_code` remains null until the existing late-exit backfill observes a real
code. Only the durable terminal-write winner emits the event.

The terminal boundary must finally re-count active executions. A remaining
execution without an accepted receipt, an unverifiable database result, or a
failed fenced write is not silently ignored and does not receive fabricated
completion: it raises a typed operational settlement failure, so the launch and
engine exit cannot be presented as clean operational success. The launch is
durably settled as `failed`, never `paused`, the typed reason is recorded in the
launch row and run journal, and the engine exits non-zero. Any no-receipt row
remains active and therefore visible to existing soft-stop/live-worker handling.
Any new typed code follows the frozen-vocabulary change protocol. This
fail-closed branch is not a new domain recovery mechanism.

## Consequences

Positive:

- terminal receipt-backed executions converge even when the PID remains alive;
- successful closers are not killed by terminal-run settlement;
- the implementation reuses one receipt authority, one CAS and one event-owner
  rule;
- physical tail state and semantic completion remain separately observable;
- no future engine start is required for the Elite-6 shape.

Negative:

- an authority-dead process can briefly outlive the engine and consume host
  resources;
- `WorkerExecution.state='exited'` must be read as protocol completion; physical
  death requires `exit_code`, liveness probe or the explicit observation fields;
- the terminal exit path gains a bounded wait and one additional durable scan.

Required companion observability:

- the worker-status API must expose local rows with semantic `state='exited'`,
  `exit_code IS NULL`, and a still-live PID (or expose them through an adjacent
  endpoint); board `blindLive` and admin drain counts must include that physical
  tail so Play/drain surfaces cannot claim an empty host;
- tracker text must distinguish semantic `exited` from physical process death.

Neutral follow-ups:

- operator-triggered orphan-process cleanup remains a separate, explicitly
  authorized package; it is not part of automatic settlement;
- add mutation tests that remove receipt re-verification, winner gating or final
  active-row accounting.

## Decision Journal

Date: 2026-08-22

Decision: settle receipt-complete terminal executions through the existing
fenced receipt-authoritative writer after an at-most-five-second natural-drain
courtesy; at the terminal boundary, never kill them solely because their PID
remains alive. Existing in-engine janitorial policy remains unchanged.

Ex-ante expectations:

- At merge, the alive-PID Elite-6 counterexample leaves zero receipt-backed
  active executions, exactly one `worker.exit`, and no kill invocation.
- At merge, no-receipt residuals make terminal launch settlement fail closed.
- Within 30 days, no terminal run leaves a receipt-backed `running` execution
  and no duplicate `worker.exit` is observed for runner/sweep races.
- Within 90 days, any long-lived post-receipt process is discoverable by its
  settlement reason, PID/birth identity and null-or-backfilled exit code.

Check trigger: the next full production-style factory run, any terminal launch
with active executions, or any orphan process observed after engine exit.

What would change this decision: evidence that a post-receipt process retains a
sanctioned material mutation capability, or that semantic `exited` is consumed
as proof of physical death in a safety-critical path that cannot be corrected.

## References

- `AGENTS.md`
- `GUARDRAILS.md` Signs 010 and 015
- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
- `docs/architecture/decisions/061-exact-worker-completion-dominates-process-drain.md`
- `docs/architecture/decisions/075-no-human-quality-loop-recovery-epochs.md`
- `docs/architecture/proposals/worker-exit-consistency-protocol.md`
- `docs/architecture/CONVEYOR-MENTAL-MODEL.md` section 23
- `src/lifecycle/atomic-release.ts`
- `src/infrastructure/work/worker-supervision-service.ts`
- `tracker-view/claude-runner.mjs`
