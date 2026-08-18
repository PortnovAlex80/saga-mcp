# Agent brief — saga-mcp, stage 7: close the forged-receipt path

Continues stage 6. **All rules from stages 2–6 still apply** — never spawn a real
LLM worker, never weaken a gate, never write to authority tables from a test
handler, never report success without pasting real test counts.

Branch `saga4`. Base: `32fa937a` or later.

---

## 0. What was decided and why

Your G3 dossier is accepted and its findings are confirmed — both load-bearing
claims were re-verified independently against the source. The architect's verdict
is section 9 of `docs/testing/G3-MERGE-GRANT-CONFLICT.md`. Read it first.

The verdict differs from the dossier's framing in one decisive way: **there are
two independent defects, not one**, and the dossier's question ("remove the grant
or keep it") merged the exploit with the laundering machine.

- **Defect A — the capability grant.** `worker_merge_acquire` /
  `worker_merge_release` in `COMMON_WRITE_TOOLS`.
- **Defect B — the state short-circuit.** `task.integration_state === 'merged' ||`
  in `sqlite-production-cell-integration.ts:293`.

Fixing only A closes today's entrance and leaves the machine armed: any future
writer of that column — a migration, an admin override, a repair path, a restored
checkpoint — reopens the identical hole without touching the grant.

**This stage does B only.** A is scheduled separately, and after B it stops being
urgent: a worker holding the tool can still dirty a column, but can no longer
cause a fraudulent factory receipt.

---

## TASK B1 — delete the state disjunct

`src/infrastructure/workplace/sqlite-production-cell-integration.ts:293`:

```ts
if (task.integration_state === 'merged' || isAncestor(task.local_path, sourceCommit, targetHead)) {
```

becomes:

```ts
if (isAncestor(task.local_path, sourceCommit, targetHead)) {
```

**The semantics you are installing:** `isAncestor` is already the complete
idempotency proof. If the reviewed source is an ancestor of the integration head,
the merge is applied; if it is not, it is not. The state column carries no
information the git test lacks — only permission to skip it.

> The repository is the authority on whether a merge happened. Not a column.

Write that reasoning into a comment at the site. A future reader must not
"restore" the disjunct as an optimisation.

**Check the same file for siblings.** Line ~216 has a comparable query
(`t.execution_mode IN ('git_change','artifact_change')`) — inspect whether any
other branch in this file or in `git-integration-effect.ts` treats
`integration_state` as proof of a git fact rather than as a projection. If you
find one, report it; fix only what is the same defect, and say which.

## TASK B2 — prove the forgery is dead

Add a test that would have caught this. Suggested home:
`tests/infrastructure/` alongside the existing effect suites.

**The negative theorem:** a task whose `integration_state` is `'merged'` but
whose `sourceCommit` is NOT an ancestor of the integration head must NOT produce
`outcome: 'succeeded'`, and must NOT write `integrated_commit`.

Set it up honestly through the real seam:
1. a real git repo fixture with an integration branch;
2. a source commit that was never merged into it;
3. `tasks.integration_state` forced to `'merged'` — simulating the column being
   dirtied by *any* writer, not specifically a worker (this is the point: the
   test must not depend on the grant existing);
4. run the effect;
5. assert it does not report success and does not stamp a receipt.

Add the positive counterpart: a genuinely merged source **does** short-circuit as
`alreadyApplied: true` through the ancestry test alone. Idempotency must survive
this change — that is the property most at risk.

## TASK B3 — check what the change breaks, honestly

Deleting the disjunct means any code path that relied on the column alone now
requires real ancestry. Run the full baseline and investigate every failure
rather than adapting the assertion.

If a suite fails because a fixture sets `integration_state='merged'` without
performing a merge, **that fixture was encoding the defect**. Fix the fixture to
perform a real merge, and say so in the commit. Do not relax the new check to
accommodate a fixture.

If a suite fails for a reason you do not understand, stop and escalate. A
surprising failure here is information, not an obstacle.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 313 pass
node --test "tests/lifecycle/*.test.mjs"        # was 114 pass
node --test "tests/process-modules/*.test.mjs"  # was 1035 pass
node --test "tests/infrastructure/*.test.mjs"   # was 311 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"   # was 15 pass
node --test tests/factory-contract/golden-path.test.mjs
```

One commit. Push to `origin saga4`.

---

## Escalate, do not decide

1. **Do not touch the grant** (`COMMON_WRITE_TOOLS`). That is defect A, scheduled
   separately, and it carries a package version bump and a ripple through pinned
   skills and your own G1 prompt tests.
2. **Do not touch `integrated_commit = targetHead`.** The architect flagged it as
   a possible §9 material-identity defect and deliberately excluded it: a second
   question inside an authority fix is how authority fixes go wrong.
3. **Any other place that treats a persisted column as proof of a physical fact**
   — report it. Do not generalise the fix on your own initiative.
4. Any failure you cannot explain.

## Report format

What changed, exact counts before and after, the negative theorem's assertion
text, and every fixture you corrected with the reason. List anything you
escalated.
