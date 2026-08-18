# Agent brief — saga-mcp, stage 9: K13 — exact accepted head and obligation settlement (M3)

Continues `docs/handoff/STAGE-8-AGENT-BRIEF.md`. **All rules from stages 2–8 still
apply.**

Branch `saga4`. Start from `d62bb644` or later.

---

## 0. What this is

This is the first brief in this series that executes a **K-release**, not a
repair. K13 is the last release before **milestone M3 — Authority-Correct Beta**,
whose allowed production use is literally "Limited production beta on the
existing software factory". The operator intends to run the factory on a real
project immediately after this closes.

The release card is `docs/vision/SAGA-CORE-RENEWAL-PLAN.md` §K13. **It is the
specification; this brief does not restate it.** Read the card, then read
`docs/architecture/adr-closure-registry.json` for the entries owned by K13
(ADR-028, 040, 042, 045, 050, 051, 052, 057, 060, 062, 065, 067, 072) — each
carries a `principalProof` naming what must be proven.

**Release discipline applies** (plan §3): ≤ 25 production files, ≤ 6 per commit,
≤ 1 schema migration family, one commit per numbered step in the card's commit
train, never two unrelated architecture problems in one release.

---

## TASK — execute the K13 commit train

Seven numbered commits, in the card's order. Do not collapse or reorder them.

1. `test(authority): add same-revision different-refs invariant`
2. `refactor(authority): extend AcceptedAuthorityHead`
3. `refactor(final-acceptance): use persisted row identity`
4. `refactor(obligations): settle by exact source and postcondition`
5. `test(effects): re-certify ADR-074 repair feedback`
6. `test(architecture): enforce one accepted head writer`
7. `docs(core): publish authority-correct beta proof`

**Commit 1 is a failing test first.** The card names it as the canonical failing
theorem: a revision number cannot be reused with different accepted identity.
Write it, watch it fail for the right reason, then make it pass in commit 2. If
it passes before commit 2, you have written the wrong test.

**Commit 6 is the ratchet that keeps the release closed** — direct writes to the
accepted head outside `AuthorityCommit` must be banned mechanically. Build it the
way stage 8's §27 ratchet was built: enumerate from imported definitions, name
the forbidden set as a documented constant, and **negatively validate it** by
temporarily reintroducing a violation and confirming it goes red.

### The invariants you are installing

From the card, restated because they are what the tests must assert:

- same accepted revision ⇒ **byte-identical** authority identity;
- accepted head movement is monotonic and CAS-fenced;
- FinalAcceptance cites the exact effect receipt **or** the exact no-effect
  outcome — never a generic success;
- a generic Workplace status change **cannot** settle an obligation.

The last one is the same defect class as the G3 finding you just closed: a
persisted status standing in for a proof. Watch for it everywhere in this
release, and say so if you find another instance.

### Required test scenarios (from the card)

Concurrent acceptance race; duplicate acknowledgement; crash after accepted head
before effect scheduling; effect repair and later candidate staleness; clean and
upgraded schema parity.

**Crash injection must be real**, not simulated by calling the recovery path
directly. The existing temporal suites show the pattern.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 314 pass
node --test "tests/lifecycle/*.test.mjs"        # was 114 pass
node --test "tests/process-modules/*.test.mjs"  # was 1035 pass
node --test "tests/infrastructure/*.test.mjs"   # was 314 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"   # was 18 pass
node --test tests/worker-prompt-assembly.test.mjs   # 6 pass
node --test tests/factory-contract/golden-path.test.mjs
```

Plus the authority closure suite named in the exit gate.

Push each commit to `origin saga4`.

---

## Exit gate — what you produce, what the architect signs

The card's gate: **the authority closure suite passes and every accepted write is
attributable to one Gate-proven AuthorityCommit.**

You produce the evidence bundle: boundary manifest SHA, per-suite counts, the
negative theorems with the exact error each fails closed with, and the ratchet's
forbidden set.

**You do not close K13.** Signing an exit gate is the architect's act — and stage
8 showed exactly why: K11 was closed against an ADR nobody had signed, and the
failure class it named went live on the main path. Record the evidence, state
what you could not prove, and stop.

Update the K13-owned registry entries with real evidence, exactly as stage 5
established: an entry you cannot prove stays `planned` **with a note naming the
missing evidence**. Do not flip a state to make a number look better.

---

## Escalate, do not decide

1. **Closing K13 or setting `releases.K13.state`.** Architect only.
2. **`integrated_commit = targetHead`** — still the open §9 material-identity
   question. If K13's work touches it, report; do not fold it in.
3. **Any second instance of "a persisted status proves a fact"** that you find
   while working. Report it; do not generalise a fix on your own initiative.
4. **Any schema migration beyond one family**, or any change that would exceed
   the release's file budget. Split and say so.

## Report format

Per commit: what changed, files touched (count them — the budget is real), exact
test counts before and after. Then the evidence bundle for the exit gate, and a
plain list of anything you could not prove.
