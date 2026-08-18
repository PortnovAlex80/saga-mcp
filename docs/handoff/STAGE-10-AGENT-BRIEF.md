# Agent brief — saga-mcp, stage 10: observability, then the first real run

Continues `docs/handoff/STAGE-9-AGENT-BRIEF.md`. **Start only after K13 is closed
by the architect.** Running the factory mid-migration of the authority model is
the worst possible moment: half the rows follow the old model, half the new, and
every failure is indistinguishable from a migration bug.

Branch `saga4`.

---

## 0. The one rule that changed

Stages 2–9 forbade launching a real LLM worker. **That prohibition is lifted for
this stage**, under exactly these conditions:

- workers route through the **opencode / agent-proxy shim to z.ai GLM**, not
  through the operator's interactive Anthropic channel;
- `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1` (or the launcher env pointing at
  agent-proxy) stays set, so `POST /api/model/set` never rewrites
  `~/.claude/settings.json` — see commit `bd81b02b` for why this guard exists
  (the glm-4.5-air "grid" incident);
- GLM-4.7 is capped at **two concurrent workers** by the canonical model profile
  (`CLAUDE.md`). Do not raise `SAGA_FACTORY_CONCURRENCY` above it.

Every other rule stands. In particular: never weaken a gate, never write to
authority tables outside the sanctioned path, never report success without
pasting real counts.

**Observability is built BEFORE the run, not during it.** A run whose failure you
cannot diagnose is the last three months repeated. Tasks 1–3 are prerequisites,
not parallel work.

---

## TASK 1 — run observability

The factory already emits: the operator heartbeat log, per-worker logs, and
`[progress-invariant]` incidents from the engine sweep. What is missing is a
**correlated journal** — the ability to take one failure and walk it back
through every layer that touched it.

Build it as **observation only**. This is the load-bearing constraint:

> A log is a projection. It may never become an authority, a decision input, or
> a recovery trigger. Nothing in the factory may read the journal back.

If your design has anything reading the journal to decide something, it is wrong
— that is a second authority, which §27 forbids and which is exactly the defect
class stages 7–8 just closed.

**Correlation keys**, present on every record: `run_id`, `epic_id`,
`workplace_ref`, `execution_id`, `node_id`, `candidate_set_ref` where applicable.
Without these the journal is prose.

**What must be journalled**, at minimum:
- assignment and fence creation (card claimed, execution reserved);
- worker spawn: the exact argv, the resolved model route, the pinned
  installation digest;
- worker exit: code, duration, whether `worker_done` was received;
- every gate run: check plan digest, per-provider verdict, final decision;
- every effect attempt: the four-valued outcome and its receipt reference;
- every transition obligation: created, claimed, settled;
- every `[progress-invariant]` classification, including the healthy ones.

Choose a durable format that survives a crash mid-write (append-only JSONL is
the obvious answer; justify whatever you pick).

## TASK 2 — the snapshot harness

The operator wants a **complete post-mortem artefact**, not a tail of a log.

Build `tools/capture-run-snapshot.mjs` producing a single timestamped directory
containing:

- a consistent copy of the factory SQLite database (use SQLite's backup API or
  `VACUUM INTO` — never a raw file copy of a live DB);
- the run journal from task 1;
- all worker logs and the heartbeat log;
- the resolved configuration: model route, concurrency, installed package
  digests, schema `user_version`;
- a `MANIFEST.json` naming what was captured, when, at which commit SHA.

It must run **on demand and at run end**, and be safe to invoke while the factory
is live. Verify that last property explicitly — a snapshot that corrupts a live
run is worse than no snapshot.

## TASK 3 — the bug database

A structured record, not prose. One row per observed defect:

- `observed_at`, `run_id`, and the correlation keys from task 1;
- what was expected versus what happened;
- **evidence pointer**: the exact journal record or snapshot path that shows it;
- classification: factory defect / model-compliance failure / environment /
  unknown;
- status: open / explained / fixed.

`unknown` is a legitimate and expected classification. **Do not force a
classification you cannot evidence** — a wrong label is worse than an honest gap,
because it sends the next investigation in the wrong direction.

Keep it in the repository as a file (JSON or markdown table), not only in the
factory DB — it must survive a DB wipe.

---

## TASK 4 — the order under test

The product the factory will build:

- **Elite-style game**, web frontend targeting Chrome;
- **TypeScript backend**;
- **everything containerised in Docker**.

Write the order the way an operator would, not the way a spec would: what the
product is, what "working" means, what must be runnable at the end. The factory's
Discovery workshop exists to sharpen a vague idea — **do not pre-solve its job**
by writing an SRS. A too-detailed order tests nothing about Discovery.

Constraints worth stating in the order because they are checkable:
`docker compose up` brings the stack up; the frontend serves in Chrome; the
backend is TypeScript; there is at least one automated test the readiness
certifier can execute.

Keep the scope small enough that a full four-workshop pass is plausible. A
docking/navigation slice is a better first order than "the game".

## TASK 5 — the run

Pre-flight from `docs/factory-run/CANARY-RUN-PLAYBOOK.md` (your own G5 output),
adapted: the model is z.ai GLM via the shim, so the LM Studio / Jinja steps are
replaced by verifying the shim's model map and the DB route in
`lifecycle_execution_controls`.

Before starting, confirm and paste:
- the resolved model route the first claim will freeze into `execution_context`;
- `SAGA_FACTORY_CONCURRENCY` ≤ 2;
- the guard env is set;
- a snapshot of the clean pre-run DB (task 2) exists.

Then start the factory and **observe**. Your job during the run is not to fix
things — it is to record them.

### Abort conditions — stop the run and snapshot

- an authority-table write you cannot attribute to `AuthorityCommit`;
- a stalled workplace that the progress-invariant sweep classifies
  `inconsistent_state`;
- lease thrashing (workers reaped while genuinely alive);
- the same node failing three times with the same error;
- **any sign the interactive Anthropic channel was touched** — check
  `~/.claude/settings.json` is unchanged. Abort immediately if it is not.

### Do not repair mid-run

If the factory stalls, snapshot first, then let the factory's own recovery act.
Manually editing the database to unstick a run destroys the evidence and proves
nothing about whether the factory can recover — which is the entire question this
run exists to answer.

If a run dies, that is a **result**, not a failure of the stage. Snapshot it,
file the bugs, report.

## TASK 6 — harvest and report

If the run produced accepted material, run `tools/harvest-golden-corpus.mjs`
against the run database. A real corpus from a real run is the highest-value
artefact this stage can produce — it becomes test material for everything after.

Report:
- how far the run got, per stage, with the accepted head at each point;
- the bug database, ordered by severity;
- which of the G1/G2 defect classes (heartbeat compliance, exit without
  `worker_done`, faked completion) actually occurred — you predicted them; say
  whether reality agreed;
- the snapshot path;
- **what you could not explain.**

---

## Escalate, do not decide

1. **Any factory defect found during the run.** File it; do not fix it mid-stage.
   A fix written under run pressure, without a failing test, is how regressions
   enter.
2. **Raising concurrency above 2**, or changing the model route mid-run.
3. **Any manual database edit**, for any reason.
4. **Anything touching the operator's interactive Claude channel.**
5. Closing K13, or any release.

## Report format

Tasks 1–3: what you built, where, and the proof that the journal is
observation-only (name what would fail if something read it back).
Tasks 4–6: the order text, the run trace, the bug database, the snapshot path,
and a plain statement of what you could not explain.

An honest "the run died here and I do not know why, here is the snapshot" is the
correct and useful outcome. A tidy narrative that hides an unexplained failure is
not.
