# CC-IC-2 Waiver authority: v2 waivers are typed-unavailable until an operator-owned channel exists

- **Status:** Accepted (dictatorial, operator-directed)
- **Date:** 2026-08-23
- **Context:** ADR-090 CC-IC-2 (open-question disposition closure)
- **Amends:** ADR-090 Decision 5 wording (implementation truth, not a new
  numbered ADR); `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7A CC-IC-2
- **Decision id:** DJ-2026-08-23-CC-IC2-WAIVER

## Context and problem statement

ADR-090 Decision 5 normatively says every waiver on a new-v2 register entry
requires "TRUSTED OPERATOR ATTRIBUTION (a recorded operator identity on the
per-entry waiver; an author or model may at most propose one)", and that any
author-attributed waiver is a typed red.

The first CC-IC-2 implementation attempt satisfied the letter of that rule
with a typed in-record attribution shape
(`{ kind: 'operator-waiver', operator, reason, provenanceRef }` parsed inside
the brief's `metadata.constraint_dispositions`) and accepted such records as
lawful v2 waivers. Independent review proved this is a hole:

**V2 brief metadata is authored by the worker.** Whatever attribution shape
the validator accepts inside `constraint_dispositions` is, by construction,
worker-authorable. A worker can write a perfectly shaped fake operator
identity — correct `kind`, plausible `operator`/`reason`/`provenanceRef`
strings — and the gate cannot distinguish it from a real operator act,
because no operator-owned channel exists to compare against. The typed shape
is a forgery surface, not an authority channel. The same forgery flows into
`waivedIds` (coverage subtraction) and the settlement warrant (the freeze
would pin a forged waiver into an immutable certificate).

Stated as an invariant: **a trust decision may only be read from a channel
the trusted principal owns.** Today the only carriers of v2 dispositions are
worker-authored brief metadata; therefore no v2 waiver can be trusted at
all, regardless of record shape.

## Options considered

### Option A — reject every v2 `waived` now (fail-closed; selected)

The `waived` state is TYPED UNAVAILABLE on v2 registers at both enforcement
points (the A1 worker_done disposition gate and the settlement disposition
freeze). The v2 grammar is exactly:

- kind `open-question`: `resolved` + evidenceRef, or `deferred` + reason +
  owner + unblockCriterion — nothing else;
- every other kind: `accepted` — nothing else.

A v2 `waived` record — including a perfectly shaped operator-attribution
record — is a typed red (`WAIVER_UNAVAILABLE`), never appears in
`waivedIds`, never subtracts from the coverage reverse diff, and never
reaches the warrant. Workers may PROPOSE waivers in prose (artifact text,
reviewer notes); proposals never subtract obligations. v1 registers keep the
frozen ADR-088 waiver semantics bit-identically (`accepted` |
`waived`+non-empty-reason). When a real operator-owned channel lands (an
operator command writing an append-only waiver ledger the gates read), the
grammar re-opens `waived` for v2 behind that channel.

### Option B — build the operator-owned waiver ledger now

Implement, in this packet, an operator command surface plus an append-only
waiver ledger table; gates resolve v2 waivers only from that ledger; the
brief-metadata `waived` stays red.

### Option C — signed/pinned waiver references

Accept `waived` only when the attribution record carries a signature or a
content-addressed reference into some existing operator-owned record (e.g. a
pinned operator decision artifact), verified by public key or digest.

## MCDA matrix

Weights (1 = low weight, sum 14): correctness 3, alignment 3, isolation 2,
extensibility 2, cost 1, reversibility 1, testability 2. Scores 1–5
(poor–excellent); weighted = score × weight.

| Option | Correctness 3 | Alignment 3 | Isolation 2 | Extensibility 2 | Cost 1 | Reversibility 1 | Testability 2 | Weighted total /70 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Reject all v2 waivers now | 5 | 5 | 5 | 4 | 5 | 4 | 5 | **66** |
| B. Operator-owned ledger now | 5 | 4 | 2 | 5 | 2 | 3 | 4 | 53 |
| C. Signed/pinned waiver ref | 2 | 3 | 3 | 3 | 2 | 3 | 2 | 39 |

Notes:

- A is the only option with zero new authority surface; its correctness is
  fail-closed by construction (the absence of a channel IS the decision).
- B is the correct END state but drags an operator command surface, a new
  ledger table, ownership, migration and its own mutation set into a packet
  whose editable-file scope is the disposition grammar — an isolation
  violation and a scope explosion under the serial CC-IC plan.
- C still trusts worker-carried bytes (a worker can copy a real signed
  record from one entry/run to another — replay); without a ledger there is
  no replay resistance, so its correctness score is the lowest.

## Pre-mortem (Option A)

Assumption: Option A shipped and failed six months later.

1. **An operator genuinely needed to waive a v2 open question and could
   not.** Likelihood: medium. Detection/Response: the failure is loud and
   early (typed red with explicit guidance), the workaround is honest
   (`deferred` with owner + unblock criterion keeps the obligation counted),
   and the escape is architectural: land the operator-owned channel and
   re-open `waived` — the grammar change is one vocabulary entry plus its
   ledger read, deliberately reversible.
2. **Corpora quietly re-introduced waived shapes to make gates green.**
   Likelihood: low. Detection: the focused disposition test carries the
   named counterexamples (perfectly shaped fake operator strings are red and
   never subtract) as blocking REDs; the acceptance matrix and K/W drives
   fail if a corpus regresses.
3. **The v1 legacy path was "fixed" in the same stroke.** Detection: v1
   waiver semantics are pinned bit-identically by focused tests (frozen
   ADR-088 behavior); any v1 drift is a red, and legacy-green corpora are
   part of every run.
4. **Someone re-opens `waived` later by re-enabling the in-record
   attribution parse instead of a ledger.** Detection: this record and the
   amended ADR-090 wording name the invariant (trust decisions are read
   only from operator-owned channels); re-introducing a worker-carried
   attribution shape re-opens the proven hole and must fail review.

## Red Team

1. **"Rejecting all v2 waivers is not conservation, it is bureaucracy — you
   have removed the operator's escape hatch."** No: the escape hatch was
   never real. What existed was a worker-writable field the validator
   decorated with the word "operator". Removing a forgery surface cannot
   remove authority that never existed. The honest operator paths today are
   (a) `deferred` with owner + unblock criterion, and (b) a new register
   revision at Discovery settlement. A real waiver channel is a follow-up
   with a real owner.
2. **"Option B is the end state anyway — build it now and avoid a second
   churn."** Building the ledger inside CC-IC-2 couples the disposition
   grammar repair (blocking, proven-broken) to a new command surface +
   ledger + migrations (unreviewed scope) and breaks the packet's serialized
   editable-file contract. Fail-closed first; build the channel as its own
   reviewed change.
3. **"Workers will smuggle waivers as prose."** They may — as PROPOSALS,
   which is exactly the declared intent: proposals never subtract
   obligations. The reverse diff stays non-empty until the entry is covered
   or a real channel waives it; prose has no arithmetic effect.
4. **"This makes v2 strictly stricter than v1 — is that lawful?"** Yes and
   intended: ADR-090 Decision 5 already reserved waivers for trusted
   operator attribution on v2 while grandfathering v1 frozen semantics.
   This decision records that the trusted channel does not exist yet, so
   the reserved capability is simply unavailable, not worker-attested.

## Decision

Choose **Option A**. Dictatorial pick after options generation and Red Team;
the operator directed the fail-closed minimal repair NOW.

Normative consequences recorded for ADR-090 alignment:

1. v2 `disposition: 'waived'` (any record shape, including perfect
   `operator-waiver` records) is a typed red at the A1 gate and the
   settlement freeze (`WAIVER_UNAVAILABLE` guidance).
2. `waivedIds` is always empty for v2 registers; only v1 keeps the frozen
   reasoned-waiver subtraction.
3. `accepted` is typed-invalid on kind `open-question`; `resolved` and
   `deferred` are typed-invalid on every other kind (exact kind/state
   grammar).
4. Workers may propose waivers in prose only; proposals never subtract
   obligations.
5. Re-opening v2 waivers requires an operator-owned command/append-only
   ledger channel and is deliberately out of scope here.

## Check trigger

Any future proposal to (a) re-enable `waived` on v2 registers, (b) accept
any worker-carried attribution/waiver record, or (c) add an operator waiver
command/ledger — re-run this decision's Red Team against the concrete
channel design.

## What would change my mind

A shipped, reviewed operator-owned waiver channel (append-only, replay-resistant,
gates read-only) — then Option B's end state supersedes this interim
fail-closed rule through a new decision record, not by quietly widening the
brief-metadata grammar.

## References

- `docs/architecture/decisions/090-idea-authority-conservation.md` (Decision
  5, as amended by this record: v2 waiver capability intentionally
  unavailable until a trusted channel lands)
- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7A CC-IC-2 (as amended)
- `src/modules/formalization/domain/formalization-schemas.ts` (the grammar)
- `tests/process-modules/formalization-constraint-disposition.test.mjs`
  (the blocking counterexamples)
