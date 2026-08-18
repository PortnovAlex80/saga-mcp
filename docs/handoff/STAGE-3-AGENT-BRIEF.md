# Agent brief — saga-mcp, stage 3: finish the purge, delete the dead outcome vocabulary

Continues `docs/handoff/STAGE-2-AGENT-BRIEF.md`. **All rules there still apply** —
especially: never spawn a real LLM worker, never weaken a gate, never write to
authority tables from a test handler.

Branch `saga4`. Your stage-2 work is reviewed and accepted: the corpus wiring
and the five new outcome traces are good, and escalating the unreachable edges
instead of deciding them was the correct call. The evidence dossier
`docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md` is accurate — spot-checked
independently at `src/modules/discovery/domain/discovery-settlement-policy.ts:65`,
where the decision union is closed to `'go' | 'clarify' | 'reject'`.

The architect has now made the decision your dossier requested.

---

## Decision: delete the dead outcomes

A declared route with no producer is worse than no route: it creates false
confidence and untested code paths that first execute in production. The
operator chose to shrink the vocabulary to what the factory can actually emit.
Richer semantics can return later, when a real need appears and a producer is
built with it.

Keep: `go`, `clarify`, `reject`, `formalized`, `inconsistent`, `verified`,
`blocked`, and the `failed` edges you can prove a runtime producer for (see
Task 2, step 0).

---

## TASK 1 — finish the legacy purge (in progress in your working tree)

One suite is red: `C7-02: a migrated (lease_fence=NULL) obligation becomes
usable on its next lease`. It exercises a *migrated* row — a shape that stops
existing once the migration ladder is gone. Per the purge rule, a test that
exists only to describe legacy data is deleted **with** the code it described.

- delete that test (and any sibling asserting migrated-row behaviour);
- confirm `db.ts` fails closed on an unsupported `user_version` rather than
  silently opening an old database;
- full baseline green (counts below), then commit and push.

State explicitly in the commit message that existing operator databases will no
longer open — that is the intended consequence of a pre-production purge, and
the operator must not discover it by surprise.

---

## TASK 2 — delete the dead outcome vocabulary

### Step 0 — verify before deleting (do not skip)

`initial-discovery:failed`, `solution-formalization:failed` and
`solution-development:failed` are **not** in the same class as the others. A
settlement policy may never emit them while the RUNTIME still produces a failed
stage outcome on a process/kernel failure (an exception, a terminal ProcessRun,
an infrastructure fault). Prove for each `failed` edge whether a runtime
producer exists.

- If a runtime producer exists → the edge is **reachable**, keep the route, and
  move it to `TRACED` only when a scenario drives it (a crash/fault scenario,
  not a worker recommendation). If you cannot drive it, leave it `PENDING` with
  the evidence and say so.
- If none exists → delete it with the rest.

Never delete a `failed` route on the strength of "the settlement policy does not
emit it". That is the wrong question for this edge.

### Step 1 — delete on BOTH sides (the part that matters)

This is the architectural constraint of this task, and it is easy to get half
right:

> After the purge, a worker MUST NOT be able to recommend an outcome the factory
> cannot emit.

Removing a route from the lifecycle table alone leaves the producer side able to
recommend `defer` — the recommendation is then silently rewritten to `clarify`
(`CLARIFY_POLICY_FALLBACK`), which is exactly the falsified record your dossier
found. Deleting only the route hides that defect instead of fixing it.

So for every deleted outcome, remove it from **all** of:

1. the lifecycle route table (`product-delivery-lifecycle.ts`, and anything
   `product-build-lifecycle.ts` overrides);
2. the module's declared outcomes and its flow terminal node + the transition
   that targets it (`*-process-module.ts`);
3. the domain decision unions (e.g. `FormalizationDecision`) — a closed union is
   the mechanical proof that the value cannot occur;
4. the package outcome contracts (`package/contributions/output-contracts.ts`);
5. **the worker-facing grammar**: prompts, skills, checklists, JSON schemas and
   any `recommended_outcome` / `recommended_next_action` enum that offers the
   value to a model;
6. dead node-protocol data files that only list the removed event (your dossier
   names `architecture-resolver-node-protocol.ts` as one).

If after your change a worker can still *say* a deleted word, the task is not
done.

### Step 2 — the fallback must stop being a silent rewrite

Once the vocabulary is narrowed, `CLARIFY_POLICY_FALLBACK` should only fire for
genuinely indeterminate input, never as a translation of a valid-but-unsupported
recommendation. Verify with a scripted drive that a worker emitting a *deleted*
word is rejected as invalid input (fail-closed), not quietly settled as
`clarify`.

A rejection is honest; a rewrite is not.

---

## TASK 3 — replace the prose dossier with a mechanical proof

CONVEYOR §27 requires "a real-runtime trace **or an explicit mechanically
checked unreachable proof**". A markdown dossier is neither, and it rots.

Add a ratchet asserting that every outcome code declared in the lifecycle route
table is a member of the corresponding module's closed decision union / declared
outcome set. Then a route whose producer disappears fails CI at once, instead of
being discovered by an audit months later.

Keep the dossier file, but mark it RESOLVED at the top with the commit that
acted on it — it is a good record of how the gap was found.

---

## TASK 4 — close the registry

`tests/architecture/lifecycle-outcome-edge-coverage.test.mjs`:

- delete the `PENDING` entries for every removed edge;
- the surviving edges should be `TRACED`, or `PENDING` with real evidence (only
  the `failed` edges may legitimately remain, per Task 2 step 0);
- the printed ratio should read `N/N` for the surviving vocabulary. Say the
  number in your report.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 301 pass
node --test "tests/lifecycle/*.test.mjs"        # was 114 pass
node --test "tests/process-modules/*.test.mjs"  # was 1035 pass
node --test "tests/infrastructure/*.test.mjs"   # was 311 pass / 2 fail / 12 skip → must reach 0 fail
node --test tests/factory-e2e/w9-02-happy-path.test.mjs   # 3 pass
node --test tests/factory-contract/golden-path.test.mjs   # 1 pass
```

Deleting outcomes will break tests that assert the old vocabulary. Those are
expected: update them **in the same commit** as the deletion, with a comment
saying which outcome was removed and why. Do not weaken an unrelated assertion
to make a suite pass.

---

## Escalate, do not decide

Unchanged from stage 2, plus:

- any `failed` edge that turns out to HAVE a runtime producer — report it, do
  not delete it;
- any deletion that would force a change to material authority, replay identity,
  gate semantics or effect handling;
- the workshop-uniformity audit (whether `development` grew its own mechanics)
  remains reserved for architectural review — do not refactor workshops.
