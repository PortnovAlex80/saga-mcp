# Gap analysis: scripted seam → real model

- **Date:** 2026-08-18
- **Base:** branch `saga4`
- **Question:** what does a real factory run exercise that the scripted-inference
  seam does not?
- **Method:** code reading only. **No model was launched.**
- **Related:** `docs/handoff/STAGE-2-AGENT-BRIEF.md` §0 (the seam),
  `CLAUDE.md` (LM Studio operational notes)

---

## The one-sentence finding

**The scripted seam proves the factory's physics and proves nothing about the
instructions the factory gives a model.** Assignment, fences, desks, gates,
effects, routing, settlement and persistence are all genuinely exercised. The
~330 lines of prompt assembly that actually drive an LLM are exercised by
nothing, and three of the factory's liveness and completion guarantees currently
rest on the model *choosing to obey a sentence in that prompt*.

---

## F1 — the real spawn path lives outside `src/` and outside the ratchets

`tracker-view/claude-runner.mjs` — **1,332 lines**, untyped `.mjs`, imported by
`src/infrastructure/workers/claude-worker-executor-factory.ts:6`.

It owns everything that happens between "a card was assigned" and "a model is
producing tokens": prompt assembly, pinned-skill resolution, MCP config, tool
grants, spawn argv, stream-json parsing, heartbeat, close handling.

The `dependency-direction` architecture ratchet scans `src/`. This file is
outside it — the same structural blind spot that lets `modules-ext/` exist. For
`modules-ext/` that is a feature. Here it means **the most load-bearing file for
a real run is the least architecturally governed one in the repository.**

Existing coverage: `tests/claude-runner.test.mjs` and one boundary ratchet
(`worker-done-tool-boundary`, which greps the file as text). Neither tests prompt
assembly.

## F2 — what the scripted seam actually replaces

`tests/mock-claude/scripted-executor.mjs` implements the `WorkerExecutor` port
and spawns `dispatcher.mjs` — a script that plays recorded handler responses.
This is architecturally correct: it substitutes inference and nothing else.

But it substitutes inference by **replacing the whole 1,332-line runner**, so
everything the runner does is unexercised:

| Real path does | Scripted path |
|---|---|
| assembles a prompt from protocol / semantic / reviewer skills, workspace block, repository-desk block (~330 lines) | ignores the prompt; plays a script |
| resolves skills from the **pinned installation** (`PINNED_SKILL_NOT_RESOLVED`, `PINNED_SKILL_DIGEST_MISMATCH`) | writes its own MCP config |
| computes `--allowedTools` / `--disallowedTools` (incl. disabling `worker_next`) | not exercised |
| injects `--settings` JSON | not exercised |
| parses `--output-format stream-json` incrementally | reads script output |
| routes `--model` / `--effort` per execution context | not exercised |

The golden corpus closes a *different* gap: it proves the gates accept material a
real model produced. It does **not** prove the current prompts elicit that
material. Corpus material was harvested from a run whose prompts may since have
changed.

## F3 — liveness depends on the model obeying instruction #0 (highest risk)

`tracker-view/claude-runner.mjs:229`:

```js
const modelOwnsHeartbeat = profileAllowedTools === null || profileAllowedTools.has('Bash');
```

When the execution profile grants `Bash`, the operator heartbeat becomes **Hard
rule 0** in the prompt (lines 258–263): the model is told to run a `bash -c echo
… >> ~/.zcode/cli/worker-heartbeat.log` immediately, before any other action.

So: **a worker is "alive" because the model chose to run a shell command it was
asked to run first.** A model that starts reasoning instead of obeying step 0
looks dead to the operator. Whether it is then *reaped* depends on lease
expiry rather than on this log — but the operator's liveness view is
model-compliance-dependent either way, and the two signals can disagree.

The risk is not theoretical for this project's stated direction: the target is a
**local 27B-class model**, and skipping a rote first-step instruction is exactly
the failure mode of a weaker model. No scripted test can catch it, because the
scripted worker always obeys.

Secondary: the heartbeat path is machine-global (`~/.zcode/cli/`), outside the
project and outside the factory database.

## F4 — completion depends on the model obeying too, and the code knows it

Prompt rule 6a (line ~374):

> "Completion requires invoking the actual `mcp__saga__worker_done` tool and
> receiving an accepted `stop:true` receipt. Writing, printing, or reading
> `worker-done-call.json` is NOT a tool call and MUST NOT be followed by process
> exit."

A rule this specific is written after a model did precisely that. The factory's
defence against a worker that fakes its own completion is **a sentence in a
prompt**. The conveyor's own principle is that `worker_done` is not acceptance —
which holds, and is why this is a stall risk rather than a correctness risk. But
it converts into "worker exits without a receipt" → a lost execution → a repair
cycle, on every model weak enough to do it.

## F5 — RESOLVED, and it is reading 2: the worker holds the merge tools

Prompt rule 7, branch `task.execution_mode === 'git_change' && isReview`:

> "…first acquire the repository merge lock, merge into the assigned integration
> branch, call `worker_merge_release`…"

This instructs **the model to perform the merge**. The conveyor model states git
is a fenced factory Effect, never a worker action, and the production-cell path
implements exactly that (`postAcceptanceEffect: 'git-integration'`).

This was left open in the first pass and has now been settled by reading the
live lifecycle module. `src/process-modules/modules/development/development-process-module.ts:76-87`:

```ts
const COMMON_WRITE_TOOLS = [
  ...COMMON_READ_TOOLS,
  'worker_done',
  'worker_merge_acquire', 'worker_merge_release',
  'verification_record',
  'product_submit',
  'Write', 'Edit', 'Bash',
] as const;
```

This is the **development process module** — the production-cell path, not the
legacy board path. So the merge tools are in the profile's declared tool set, and
`worker_merge_acquire` / `worker_merge_release` are live MCP handlers
(`src/tools/dispatcher.ts:1291+`). Effective tools are
`profile.allowedTools ∩ runtime grants`, so whether the model can actually call
them depends on the runtime side of that intersection — but the workshop is
asking for them.

Meanwhile the same module's implementation cell declares
`postAcceptanceEffect: 'git-integration'` — the factory-owned, CAS-ledgered
merge with claim/observation and four-valued outcomes.

**Two merge paths are therefore declared in the same workshop:** one the factory
owns and fences, one the worker is granted and the prompt instructs it to use.
The conveyor model's position is not ambiguous — git is a fenced factory Effect,
never a worker action — so at minimum the grant is obsolete, and at worst two
authorities can touch the same integration branch.

I have **not** proven both fire on the same card; that needs a run trace. What is
proven is that the capability is granted on the live path, which is enough:
under this model, a worker holding a merge tool is a defect regardless of whether
it has fired yet.

**This is an escalation, not a workhorse fix.** Removing the grant changes what a
worker can do mid-run; it must be decided against the git-integration effect's
contract, not by deleting a line from a list.

### Corollary — F3 is confirmed live, not hypothetical

The same list grants `Bash`. Therefore
`modelOwnsHeartbeat = profileAllowedTools.has('Bash')` is **true** for every
development worker, and the heartbeat genuinely is Hard rule 0 in the prompt for
the workshop that does the longest, heaviest work. F3 is not a latent branch — it
is the configured behaviour of the main code-producing workshop.

## F6 — no wall-clock timeout in the runner; lease TTL is tuned for the cloud

The runner has no `setTimeout` guarding worker duration; it kills only on
explicit stop. Liveness is lease-based, reaped by supervision — architecturally
correct (a durable fence beats a local timer).

The practical issue is **calibration**: a local 27B model is materially slower
per token than the cloud model the TTL was tuned against, and it also *retries*
(see F7). If lease TTL < realistic local completion time, supervision reaps live
workers and the factory thrashes — a symptom that looks exactly like
instability. This is arithmetic, checkable on paper before spending a single
token.

## F7 — LM Studio failure modes are silent at the GUI

Already documented in `CLAUDE.md` and worth restating as run risk:

- an unpatched Jinja chat template raises server-side on mid-conversation
  `system` messages → the worker log shows **10× `api_retry … 500`, then exit 1**,
  while the LM Studio GUI shows nothing;
- selecting a local model rewrites `~/.claude/settings.json` machine-wide;
- context length is **load-time only** (`lms load -c …`), not per-request;
- `--effort` must be **absent** for a local model (runner adds it only alongside
  `--model`, line ~1066) — its presence is a reliable sign the worker froze on
  the cloud profile.

## F8 — the first-claim race is a known, documented trap

`CLAUDE.md` records it: on a NEW order both start paths write the cloud profile
and spawn immediately, so the first claim can freeze on the **paid cloud model**
before the local flip lands. Recovery is a plain `factory.mjs resume`.

For a cost-constrained canary this is the single most expensive way to fail, and
it fails *by default* rather than under unusual conditions.

---

## What to do, cheapest first — none of it needs a paid model

**G1. Test the prompt assembler (biggest cheap win).**
Prompt assembly is a pure function of `launchSpec`, task, skills and workspace
projection. 330 load-bearing lines with no test. Extract or call it directly and
assert: heartbeat rule present exactly when `Bash` is granted; `worker_next`
named as forbidden; `execution_id` present in every rule that requires it; the
pinned skill sections resolved from the installation, not the global skill root;
rule 7's merge branch absent for non-`git_change` execution modes. Deterministic,
fast, no spawn.

**G2. A disobedience harness — turn F3/F4 into tests.**
The seam already supports one-node overrides (`w9-03-adversarial-handlers.mjs`).
Add scripted workers that deliberately misbehave: never emit the heartbeat; exit
0 without calling `worker_done`; write `worker-done-call.json` and exit. Then
assert the factory's recorded behaviour — reaped as lost, repair cycle entered,
no false acceptance. This is exactly the class of defect the conveyor is supposed
to survive, and today it is asserted only by prose.

**G3. ~~Settle F5~~ — done; now an architectural decision.** The merge grant is
live on the production-cell path. Decide whether `worker_merge_acquire` /
`worker_merge_release` leave `COMMON_WRITE_TOOLS`, and what prompt rule 7 becomes
once they do. **Not workhorse work** — it changes worker capability mid-run and
must be judged against the `git-integration` effect contract.

**G4. Arithmetic on the lease.** Read the lease TTL and the supervision reap
interval; compare against a measured local-model turn time. On paper. If the
margin is thin, raise the TTL *before* the canary rather than diagnosing thrash
during it.

**G5. Only then, the bounded canary.** With G1–G4 done, the remaining unknowns
are genuinely model-behavioural and cannot be answered any other way. Pre-flight:
patch the model's Jinja template, load with an explicit `-c`, start the tracker,
warm the probe, flip the model route **before** the first claim, and verify the
spawned process is `claude -p --bare --model <local>` with **no** `--effort`.

---

## Ownership

G1, G2 and G4 are mechanical and well-specified — workhorse work.
G3 is a code question but its *answer* may be an architectural escalation.
G5 is the operator's call: it costs real money and real time.
