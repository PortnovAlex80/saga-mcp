# Factory Completion — Atomic Task & Evidence Contract (P0-02)

> The contract every completion task (card) must satisfy. The integrator rejects any
> evidence record that violates it. Source plan: *Saga Factory Completion Execution Plan*.

## 1. Atomicity — one card is atomic iff ALL hold

- **one invariant / outcome** — the card's single stated goal;
- **≤ 5 production files changed** (test, fixture, and doc files do **not** count toward
  the 5);
- **exactly one commit**, with the **prescribed subject** from `COMPLETION-LEDGER.md`;
- **exactly one push** to `origin/finish/<id>-<slug>`;
- integrates **one-for-one** onto `finish/factory-completion` (cherry-pick or ff).

If a card cannot meet atomicity → the agent returns **`SPLIT_REQUIRED`** *before
editing*, and the split consumes **one DFX slot**.

## 2. Forbidden — any of these invalidates the evidence

- fallback to **recency / latest task / newest product**;
- deriving task identity from **`submission.task_id`**;
- **manual SQL** that fabricates authority state a production API cannot create;
- **weakening a test** to obtain green;
- `continue-on-error` / silent retry to hide a failure;
- editing **outside the card's write scope**;
- touching `saga4` / `origin/saga4` (active factory lives there).

## 3. Evidence record — the T3 form (returned by every task)

```
Task:           <ID — title>
Starting SHA:   <integration tip at branch cut>
Branch:         finish/<id>-<slug>
Changed files:  <complete list>
Tests:          <exact commands + results>
Commit:         <prescribed subject + SHA>
Push:           origin/finish/<id>-<slug>
Residual risk:  none | <one precise item>      ; no generic "may need more testing"
Integrator note: SAFE_TO_CHERRY_PICK | SPLIT_REQUIRED | BLOCKED <reason>
```

The integrator pastes one row into `COMPLETION-LEDGER.md` (Status → `done`, Evidence →
file/test refs) only after the record is accepted.

## 4. Manifest validation

Run:

```
node tools/validate-completion-evidence.mjs
```

It parses `docs/factory/COMPLETION-LEDGER.md` and checks:

1. every `done`/`dfx` row has **non-empty Evidence**;
2. **no row is `done` while any of its dependencies is not** `done`/`dfx`;
3. **DFX consumed ≤ 3**.

Exit `0` = OK, `1` = violation. **CI-02** wires this into the acceptance matrix; until
then it is the integrator's pre-push self-check.
