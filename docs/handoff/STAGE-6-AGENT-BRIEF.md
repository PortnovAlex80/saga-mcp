# Agent brief — saga-mcp, stage 6: harden the real-worker path

Continues `docs/handoff/STAGE-5-AGENT-BRIEF.md`. **All rules from stages 2–5 still
apply** — never spawn a real LLM worker, never weaken a gate, never write to
authority tables from a test handler, never report success without pasting real
test counts.

Branch `saga4`.

---

## 0. Why this stage exists

The scripted-inference seam (`tests/mock-claude/scripted-executor.mjs`) proves the
factory's physics and **proves nothing about the instructions the factory gives
to a model**. Assignment, fences, desks, gates, effects, routing, settlement —
all genuinely exercised. But the ~330 lines of prompt assembly in
`tracker-view/claude-runner.mjs` (the real spawn path) are exercised by nothing.

Three of the factory's liveness and completion guarantees currently rest on a
model *choosing to obey a sentence in that prompt*. A weaker model (like a local
27B) can fail at exactly those points — with no test catching it. This is why
the factory has not reached a green run end-to-end in three months.

The evidence: `docs/research/2026-08-18-real-run-gap-analysis.md`.

Your work is to make those guarantees **mechanically enforced**, not model-
compliance-dependent, and to settle the arithmetic that makes a canary run
possible at all.

---

## TASK G1 — prove the prompt assembler does what it claims

`tracker-view/claude-runner.mjs` lines ~50–383 construct the worker prompt.
This is a pure function of `launchSpec`, task, skills and workspace projection
— no spawn, no model, 330 load-bearing lines with **no test**.

Add `tests/worker-prompt-assembly.test.mjs` and assert the following:

**1. Heartbeat rule presence.**
When the execution profile grants `Bash`, the prompt must include Hard rule 0
verbatim:

```
0. IMMEDIATELY on startup, before any other action, run this heartbeat command exactly once (it marks you as alive for the operator):
   bash -c 'echo "$(date -u +%FT%TZ) pid=$$ worker=${workerId} project=${project.id} task=${task.id} CLAIMED started" >> ~/.zcode/cli/worker-heartbeat.log'
```

When `Bash` is NOT granted, the prompt must include: `Runtime owns the
operator heartbeat. Do not invoke Bash or another undeclared native tool for
heartbeat.`

**2. Forbidden tools are named.**
The prompt must explicitly state: `Never call worker_next; it is explicitly
disabled for this process.`

**3. execution_id appears where required.**
Every rule that mentions `execution_id` in the real prompt must actually include
the rendered `${assignment.execution_id}` value. Check: `worker_done`,
`verification_record`, `worker_ask_need`, `worker_ask_done`,
`worker_merge_acquire`, `worker_merge_release`.

**4. Pinned skills come from the installation, not the global root.**
The prompt builder must resolve skills via `launchSpec.resolveSkill`, not from
`SAGA_SKILL_ROOT`. Assert that the skill path injected into the prompt for a
pinned installation points at that installation's store, not at the global
skill directory.

**5. Merge instruction absent for non-git-change modes.**
Prompt rule 7 instructs: `first acquire the repository merge lock, merge into
the assigned integration branch, call worker_merge_release`. This instruction
must only appear when `task.execution_mode === 'git_change'`. For
`tracker_only`, `read_only_evidence`, `artifact_change` — assert the merge
instruction is NOT in the prompt.

**How to test without importing .mjs directly.**
The runner is ESM-only. Use a child process to invoke a minimal harness that
calls the builder function and prints the prompt to stdout, then parse and
assert in Node test. Or import the dist if the builder is re-exported; do not
add side-effects to the runner itself.

**Acceptance:** all five assertions pass, deterministic, green on `npm run
build`.

---

## TASK G2 — turn model-compliance assumptions into negative tests

Today the factory assumes: "the model will emit heartbeat; the model will call
worker_done; the model will not fake its own completion." That is hope, not
proof. Build a disobedience harness that proves the factory survives a worker
that disobeys.

### G2.1 — a worker that never emits heartbeat

Extend `tests/mock-claude/` with a new scripted handler: a "silent" worker that
ignores rule 0, produces no heartbeat log line, and otherwise completes the
task normally.

Then assert:
- supervision marks the worker execution as `stale` (lease expiry without
  heartbeat);
- the factory enters a repair cycle;
- the card returns to the queue;
- the accepted head did NOT advance through the fake completion.

**What this proves:** the factory's liveness tracking is mechanical, not
model-dependent.

### G2.2 — a worker that exits without calling worker_done

Add another scripted handler: it completes its work, prints a summary, and exits
0 — but never calls `mcp__saga__worker_done`.

Then assert:
- the worker execution is terminal but NOT marked `completed`;
- `worker_done` receipt is absent;
- the factory classifies it as a lost execution (not an accepted one);
- the card returns to the queue or enters repair;
- no new downstream work was created from the fake completion.

**What this proves:** rule 6a is not merely a suggestion; the factory enforces
it.

### G2.3 — a worker that fakes worker-done-call.json

Add a handler that writes `worker-done-call.json` to disk and exits 0, without
invoking the actual MCP tool.

Then assert:
- the file is not recognized as a completion;
- the factory does NOT accept it;
- the execution is classified as incomplete or lost.

**What this proves:** writing a file is not a tool call; the factory knows the
difference.

**Follow the w9-03 pattern.** `tests/factory-e2e/w9-03-adversarial-handlers.mjs`
shows how to override exactly one node while the rest of the happy path runs.
Import `W9_HAPPY_HANDLERS` and override only the node that performs the model's
work, keeping gates, routing, and settlement genuine.

---

## TASK G3 — resolve the merge-grant question (read-only, then report)

This one you do NOT decide. Your job is to gather the evidence so the architect
can.

### G3.1 — confirm the grant is live

You already have the file path from the gap analysis:
`src/process-modules/modules/development/development-process-module.ts:76-87`.

Read it and confirm: `worker_merge_acquire` and `worker_merge_release` are in
`COMMON_WRITE_TOOLS`, which is granted to the development workshop's
production cells. This is NOT legacy board code — it is the live lifecycle
path.

### G3.2 — confirm the factory also owns git integration

Read `src/infrastructure/workplace/sqlite-production-cell-integration.ts` and
`src/infrastructure/workers/git-integration-effect.ts` (or wherever it lives
now). Confirm:
- the development package declares `postAcceptanceEffect: 'git-integration'`;
- the effect runs inside a fenced factory CAS ledger with claim/observation
  protocol and four-valued outcomes (`succeeded`, `pending`, `repair_required`,
  `human_required`).

### G3.3 — check whether both fire on the same card

Search the codebase for evidence that `worker_merge_acquire` /
`worker_merge_release` are actually called from a lifecycle run (not from the
legacy board path). If you find a call site, note whether it runs before or
after `git-integration`. If you find NO call site, say so.

### G3.4 — read ADR-039 and K11's stated intent

Read `docs/architecture/decisions/039-model-produces-text-factory-owns-git.md`
and `docs/vision/SAGA-CORE-RENEWAL-PLAN.md` §K11 commit 4:

```
refactor(git): consume accepted ProductRefs and factory-owned repository effects
— no worker-selected merge authority.
```

### G3.5 — write the conflict dossier

Create `docs/testing/G3-MERGE-GRANT-CONFLICT.md` with five sections:

1. **What the code does today** — the grant exists on the live path.
2. **What the factory also does** — `git-integration` is a fenced factory
   effect with a CAS ledger.
3. **Whether both fire on the same card** — what you found in G3.3.
4. **What ADR-039/K11 require** — "no worker-selected merge authority".
5. **The open question** — is the grant obsolete? If both fire, is this the
  program's top named risk ("Hidden dual authority") in a new place?

**Do NOT edit code.** This is read-only evidence gathering. The decision — to
remove the grant, or to keep it with an updated contract — belongs to the
architect and must be made against the `git-integration` effect's semantics.

---

## TASK G4 — arithmetic on lease and realistic completion time

The factory's liveness is lease-based. A local 27B model is materially slower
per turn than a cloud model. If lease TTL < realistic completion time, supervision
reaps live workers and the factory thrashes — a symptom that looks exactly like
instability. This arithmetic can be done on paper before spending a single token.

### G4.1 — read the lease TTL

Find the lease configuration. Likely in:
- `src/schema.ts` (worker_executions table definition);
- `src/lifecycle/` or `src/infrastructure/workers/` (lease creation logic);
- `src/app/dispatch-loop.ts` or similar (supervision reap interval).

Report the exact values: `lease_expires_at` relative to claim, supervision reap
frequency, any grace periods.

### G4.2 — measure local-model turn time

You are NOT launching a real model. Use these proxies:
- Read `CLAUDE.md` — it notes LM Studio models and typical token throughput.
- Estimate: 27B model → X tokens/second.
- A full worker task (read context → reason → produce → verify → worker_done)
  consumes roughly Y tokens (use golden-run corpus evidence from
  `tests/fixtures/golden-corpus/manifest.json` if available).

Calculate: expected wall-clock time for one realistic turn.

### G4.3 — calculate the margin

`margin = lease_ttl - (expected_turn_time + reap_interval + safety_buffer)`

If margin < 30 seconds for a 27B model, report: **"lease is tight for local
models; thrashing is likely before the worker completes."**

### G4.4 — recommend

If the margin is thin, recommend raising the lease TTL (or the safety buffer)
**before** the first canary run. Say exactly what value would give a 2× margin.

**Do NOT change code.** Report the arithmetic and the recommendation. The
operator decides the TTL.

---

## TASK G5 — bounded canary run preparation (pre-flight checklist only)

You do NOT execute the canary. You prepare so the architect can, without wasting
tokens on avoidable failures.

### G5.1 — confirm the model is patched

The LM Studio Qwen 3.6 chat template must be patched per `CLAUDE.md`:

- Find `~/.lmstudio/hub/models/qwen/qwen3.6-27b/model.yaml` (or the model the
  operator will use).
- Confirm the Jinja exception `System message must be at the beginning` is
  patched to allow mid-conversation system messages.
- If NOT patched, write: **"CANARY BLOCKED: model not patched — will fail on
  first tool call."**

### G5.2 — confirm context length is loaded

LM Studio context length is set at load time with `-c`. The default may be too
small for a full worker task.

Check: `lms show <model>` and report the configured context length. If < 120K
tokens, write: **"CANARY AT RISK: context length may be insufficient for a full
development turn."**

### G5.3 — verify the tracker and LM Studio are running

The factory requires:
- The tracker started (`node dist/index.js tracker …`).
- LM Studio server running (`lms show …` reports the model as loaded).

If either is not running, write: **"CANARY BLOCKED: missing infrastructure"**.

### G5.4 — confirm the flip-timing

The first-claim race (documented in `CLAUDE.md`): both start paths write the
cloud profile and spawn immediately, so the first claim can freeze on the paid
cloud model before the local flip lands.

Report: the exact procedure to avoid this (start tracker → warm probe → start
factory → flip `POST /api/model/set`).

### G5.5 — verify worker spawn command will be local

When the model flip lands, the spawned worker process must be:
`claude -p --bare --model <local-model>` with **no** `--effort`.

Confirm the runner code (`tracker-view/claude-runner.mjs` around line ~1066)
adds `--effort` ONLY alongside `--model`, so a null model means no `--effort`.

### G5.6 — write the canary playbook

Create `docs/factory-run/CANARY-RUN-PLAYBOOK.md` with:

1. **Prerequisites** — G5.1 through G5.5 all satisfied.
2. **Step-by-step procedure** — tracker, LM Studio, factory start, model flip,
   first claim observation.
3. **Success criteria** — one green run from `initial-discovery` through
   `delivery`; 0 manual DB edits; 0 stalled workplaces; accepted head advanced
   through all 4 stages.
4. **Abort conditions** — lease thrashing, worker stall, heartbeat missing, or
   any `failed` transition that is NOT understood.
5. **Recovery** — if the first claim freezes on cloud, the exact `factory.mjs
  resume` command to reap and re-claim.

**Do NOT execute.** This is the checklist the operator follows.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 305 pass, 0 fail
node --test "tests/lifecycle/*.test.mjs"
node --test "tests/process-modules/*.test.mjs"
node --test "tests/infrastructure/*.test.mjs"
node --test "tests/mock-claude/*.test.mjs"       # if G2 adds files here
node --test "tests/factory-e2e/w9-*.test.mjs"    # if G2 adds adversarial handlers
```

G1 adds a test file. G2 adds test files and handlers. G3 and G4 add only
documentation. G5 adds documentation. Only architecture/test counts should move.

One commit per task. Push to `origin saga4`.

---

## Escalate, do not decide

1. **Editing the development tool grant list** (`COMMON_WRITE_TOOLS`). This is
   G3's output — a dossier, not a deletion. The grant removal decision belongs
   to the architect and must be judged against ADR-039/K11 and the
   `git-integration` effect contract.
2. **Changing lease TTL** — arithmetic first, then a decision.
3. **Launching a real model** — strictly prohibited.
4. **Modifying `tracker-view/claude-runner.mjs`** in any way other than what a
   test explicitly requires (and even then, prefer reading output to editing).

## Report format

Per task: what you added, where, and the exact test counts before and after.

For G3: paste the content of the conflict dossier.

For G4: paste the lease TTL, your arithmetic, and the margin calculation.

For G5: paste the canary playbook checklist.

State plainly what you did not finish. An honest gap is more useful than a green
number that hides one.
