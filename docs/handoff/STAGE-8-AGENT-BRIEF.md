# Agent brief — saga-mcp, stage 8: remove the merge grant and install the missing ratchet

Continues `docs/handoff/STAGE-7-AGENT-BRIEF.md`. **All rules from stages 2–7 still
apply** — never spawn a real LLM worker, never weaken a gate, never write to
authority tables from a test handler, never report success without pasting real
test counts.

Branch `saga4`. **Start only after stage 7 is merged and green.**

---

## 0. Where this sits

Stage 7 closed **defect B** — the laundering short-circuit. A dirtied
`integration_state` column can no longer produce a fraudulent factory receipt,
because ancestry is now the sole proof.

This stage closes **defect A** — the capability grant itself. After stage 7 this
is no longer an incident; it is ordinary scheduled work. Do it carefully rather
than quickly.

Read first:
- `docs/testing/G3-MERGE-GRANT-CONFLICT.md` §8 (your own surgery map — it is
  accurate and this brief does not restate it) and §9 (the architect's verdict).
- The K11 reopen record: `docs/architecture/adr-closure-registry.json`,
  `releases.K11.reopenReason`.

**Governing requirement**, ADR-039 and K11 commit 4: *no worker-selected merge
authority*. CONVEYOR §18:847-848: only a fenced Factory effect may create or
update canonical refs, merge, push, or issue an integration receipt.

---

## TASK A1 — remove the grant everywhere it is declared

Your own reconciliation note on ADR-039 already enumerated the sites. Remove
`worker_merge_acquire` / `worker_merge_release` from:

1. `src/process-modules/modules/development/development-process-module.ts:76-87`
   — `COMMON_WRITE_TOOLS`;
2. `src/process-modules/application/capability-packages.ts:423-432` — the
   capability advertisement;
3. `src/lifecycle/application-service.ts:231-232` — the mapping.

Follow §8's five-group ordering. It exists precisely so the tree never sits in a
state where a profile advertises a capability the runtime no longer maps, or the
reverse.

**Do not delete the MCP handlers** in `src/tools/dispatcher.ts`. Removing a
worker's *grant* is this stage. Deleting the tools is a larger question (they may
still serve an operator/admin path), and it is not asked for here. If you
conclude the handlers are now unreachable, **report that** — do not act on it.

## TASK A2 — the package version bump

Per §8: `1.4.3 → 1.4.4`, with the three historical ladders updated. Handler
digests are untouched, so there is no `restart-required` storm — confirm that
holds rather than assuming it.

State in the commit message that pinned installations of 1.4.3 keep their
declared grant by design: content-addressing means old installations are old
material, not a bug to retro-patch.

## TASK A3 — the prompt must stop instructing the merge

Prompt rule 7 in `tracker-view/claude-runner.mjs` currently reads, for
`execution_mode === 'git_change' && isReview`:

> "…first acquire the repository merge lock, merge into the assigned integration
> branch, call `worker_merge_release`…"

With the grant gone, this instructs a model to call a tool it does not have —
which produces a confused worker and a wasted turn, not a safe failure.

Replace it with the honest statement: the factory owns integration; after
`worker_done` returns `stop:true`, the worker finishes and exits.

**This will break your own G1 tests** (`tests/worker-prompt-assembly.test.mjs`) —
specifically the rule-8a pin and the merge-instruction assertion. That is
correct and expected. Update them **in the same commit**, with a comment naming
the removal. Do not delete the assertions; invert them: assert the merge
instruction is now absent for *every* execution mode, and that rule 8a no longer
names the merge tools.

Also check the pinned `saga-worker` skill (§8 cites lines 98-100) for the same
instruction.

## TASK A4 — install the §27 ratchet (the point of this stage)

CONVEYOR §27:1305-1306 requires a CI ratchet rejecting execution profiles that
grant fenced-effect tools. **It does not exist. That is why the grant survived
K11 and why this defect reached the main path at all.**

Removing the grant without the ratchet means it returns in the next module
someone writes. **The ratchet is the deliverable; the removal is its first
customer.**

Add `tests/architecture/no-worker-fenced-effect-grants.test.mjs`:

- enumerate every execution profile / declared tool set across all modules
  (`src/process-modules/modules/**`, and `modules-ext/**` if reachable);
- assert none grants a tool that performs a fenced factory effect — at minimum
  `worker_merge_acquire`, `worker_merge_release`;
- make the forbidden set a **named, documented constant** with the reason and
  the ADR reference, so extending it later is a deliberate act;
- write the header so a future reader understands the failure it prevents: a
  worker holding a merge tool, a state column dirtied, a manufactured receipt.

Prefer asserting against imported module definitions over grepping source text.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 313 pass (+ your new suite)
node --test "tests/lifecycle/*.test.mjs"        # was 114 pass
node --test "tests/process-modules/*.test.mjs"  # was 1035 pass
node --test "tests/infrastructure/*.test.mjs"   # was 311 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"   # was 15 pass
node --test tests/worker-prompt-assembly.test.mjs
node --test tests/factory-contract/golden-path.test.mjs
```

Expect movement in: architecture (new suite), worker-prompt-assembly (inverted
assertions), and any suite pinning the capability advertisement. Every other
count must hold.

Commits per §8's grouping — do not collapse the five groups into one.
Push to `origin saga4`.

---

## Escalate, do not decide

1. **Deleting the `worker_merge_*` MCP handlers.** Out of scope; report if you
   believe they are unreachable.
2. **`integrated_commit = targetHead`** — still the architect's open §9
   material-identity question. Untouched.
3. **Re-closing K11.** You produce the evidence; the architect signs the exit
   gate and flips `releases.K11.state`. Never a bookkeeping edit.
4. **Any other profile granting a fenced-effect tool** that your new ratchet
   catches. Report it before removing — it may be load-bearing somewhere you
   cannot see.

## Report format

Per group: what changed, exact counts before and after, and the ratchet's
forbidden set with its rationale. Name every assertion you inverted and why.

State plainly what you did not finish.
