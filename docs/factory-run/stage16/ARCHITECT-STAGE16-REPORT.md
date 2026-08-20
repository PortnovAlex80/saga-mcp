# ARCHITECT STAGE-16 REPORT — the defect-shape matrix

Per `docs/handoff/STAGE-16-AGENT-BRIEF.md` (incl. the live addenda D7/E7,
commit `4e1fd982`). All five spaces built + both addenda. One commit per
space: A `0e1c295c`, B `c6c366ed`, E `b209bdc6`, C `bc84e74d`,
E7 `9bea1194`, D+D7 `97ea7468`. **No production code changed.**

## How it was built (protocol note)

Four spaces were built by parallel subagents (B, C, D, E), one file each,
no src/ edits, no npm (a live factory run was using dist/ the whole time —
no build ever ran under it), no git. Main integrated each serially:
independent suite run, an independent serial re-proof of non-vacuity
(patching dist minimally, capturing RED, restoring byte-exact), then the
commit. Spaces A and E7 were built by main directly.

## Baseline (verbatim, after everything)

```
node --test "tests/matrix/*.test.mjs"           → tests 48 / pass 48 / fail 0  (~12.6 s)
node --test "tests/architecture/*.test.mjs"     → tests 411 / pass 411 / fail 0
node --test "tests/lifecycle/*.test.mjs"        → tests 136 / pass 136 / fail 0
node --test "tests/process-modules/*.test.mjs"  → tests 1220 / pass 1220 / fail 0
node --test "tests/infrastructure/*.test.mjs"   → tests 419 / pass 407 / fail 0 / skipped 12
node --test "tests/factory-e2e/w9-*.test.mjs"   → tests 20 / pass 20 / fail 0
```

One transient pm flake on the FIRST post-stage run, named this time:
`call-instance-persistence.test.mjs:74` — `EPERM` on `rmSync` of a Windows
temp dir (cleanup race, not code); clean on rerun. No pre-existing count
moved.

## Per space (TODO → checked; table; RED verbatim; runtime)

### SPACE A — progress space (`a-progress-space.test.mjs`)

A1–A6 all checked. Dimensions extracted FROM CODE (schema CHECK constraints
sliced per table — a file-wide regex grabs the wrong `outcome` column;
asserted against now). Full product **4536 cells**, 40 behavior rows:
25 reachable-healthy, 14 reachable-defect (the KNOWN_UNHEALTHY registry,
each naming the owning mechanism), 1 unreachable-defensive
(terminal|no-reason — the reducer's `terminal()` always sets a reason,
production-cell-reducer.ts:375). Unread axes proven unread (a hidden read
fails the sweep). Granularity fact recorded: the four settled effect
outcomes share one class; WHICH outcome lives in the reason string.

RED (dist patched: verifying|none lies `typed_wait`):
```
verifying|none → expected stalled, got typed_wait (hidden read of a not-read dimension, or classifier drift)
```
Runtime <100 ms.

### SPACE B — material re-identification (`b-material-reidentification.test.mjs`)

B1–B6 checked. 13 kinds enumerated from the capsule certification chain.
Content-identity kinds survive (sealed product, trace — the stage-11 fix,
candidate set, git commit); fenced kinds cannot be deleted at all; **two
row-id kinds break** → B-F1, B-F2; error naming gap → B-F3.

RED (main's serial re-proof; content resolver's WHERE poisoned):
```
✖ space B — B3 kind: trace (content-tuple) resolves after delete + identical re-creation
```
Runtime ~1.6 s.

### SPACE C — self-declaration narrowing (`c-declaration-narrowing.test.mjs`)

C1–C6 checked. **20 surfaces** (11 derived / 9 declared) with file:line
reading sites. Derived surfaces: narrowing BLOCKED (incl. real-execution
testCommand and installCommand fail-closed) and additive stays legal
(floor surfaces; exact-identity surfaces honestly asserted as non-floors).
Six declared-taken surfaces are findings F-C1..F-C6.

RED (main's serial re-proof; early-return lie in enforceDerivedCanonicalTestSet):
```
✖ S01 (C3, real execution): a testCommand declaring fewer files than the canonical sealed-tree universe MUST NOT PASS — the excluded red file runs
```
Runtime ~12 s (real execution).

### SPACE D — cross-authority contradiction (`d-authority-contradiction.test.mjs`)

D1–D7 checked. 14 constraints × 4 cards (provider-id ratchet enforces the
enumeration); **26 pairs: 16 potentially contradictory, 10 independent**
with reasons. Every contradiction pair carries satisfiability or a lawful
transition — **no pair lacks both; there is no finding of that class.**
Live proofs through the real fence/desk/ledger/review/ratchet: the fence
rejects → the ledger grants rev 1 → the same byte-identical submission
passes. D4 beyond scope-vs-AC: ADR-062 deferral and readiness ratchet,
both RED-grade. D5 honestly bounded (structural guarantees asserted; the
residual space belongs to space A). **D7**: three cards, one shared root
path, sequential — refusal exists only while a live holder holds it; both
release axes (terminal workplace, cancelled task) re-grant. Findings
d-1, d-2, d-3.

RED (main's serial re-proof; ledger release axes killed — released
holders still counting):
```
✖ space D — D7: shared-path contention — N cards, one shared root path; refusal exists only while a LIVE holder holds it
  FINDING d-3 (hard form): shared.config was refused with NO live holder — a released card's grant still blocks
```
Runtime ~3.9 s.

### SPACE E — constraint loss (`e-constraint-loss.test.mjs`, incl. E7)

E1–E7 checked. Five boundaries from the process modules; the carrying
table (now 6 rows — B5 has TWO loss channels). Detection confirmed on
proposal→PRD, PRD→AC (register ids), AC→task-graph, card→verification.
Four findings: E-F1, E-F2, E-F3, **E-F4 (the E7 silent surrender — found
live in stage 15**, verified from its DB: fence at 11:44:26 → author
accepted 12:01:07 on a candidate that stopped touching the needed paths →
final accepted 12:04:58; widening ledger 0 rows). Domain-free: attempt 1
fails `path-outside-authority` with the teaching suffix; attempt 2 (same
card, zzz/ silently dropped) → **passed**.

RED (main's serial re-proof; provider's pass verdict lied to 'failed'):
```
✖ space E — E7 silent surrender: a card whose criteria require an artefact it stopped touching is ACCEPTED (finding E-F4, honest current behavior)
```
Runtime ~250 ms (whole E file).

## Consolidated findings — ordered by how badly they hurt a real run

1. **E-F4 (high)** silent surrender — accepted-incomplete work looks like
   success; beat the lawful widening exit TWICE in the live stage-15 run.
   Home: a coverage obligation on the accepted implementation result
   (development-check-providers.ts:887-917) — produced or typed waiver.
2. **E-F2 (high)** the reconciliation orphan detector EXISTS
   (findContractGap({reconciliation:true})) and NO call site passes the
   flag — a requirement can vanish from every AC/UC across three gates.
3. **B-F1 (high)** artifacts sealed by ROWID — identical re-creation kills
   every capsule over the snapshot (the stage-10 trace death, one table
   over); latent since stage-11.
4. **E-F1 (high)** order→proposal extraction is ungated — the entire
   closed register network inherits an LM omission at birth.
5. **F-C1 (high)** readiness.kind is declaration-taken — serve/loopback/
   shutdown verification removable by declaring 'static'.
6. **E-F3 (high)** no constraint echo on implementation results — the
   structural precondition of E-F4.
7. **d-1 (medium)** ADR-062 deferral reads the ORIGINAL carve, not the
   widened authority — the gate fails open on work inside a granted scope.
8. **F-C2 (high-med)** compose is opt-in — omitting readiness.compose
   passes with zero compose steps.
9. **F-C6 (medium)** the SRS §2.2 manifest is its own canonical — dropping
   a row shrinks required coverage to nothing.
10. **B-F2 (medium)** trace task target by rowid where a content key
    exists; failure surfaces one boundary late.
11. **d-3 (medium, by design)** shared-path serialization — N cards queue
    on shared root config (the stage-15 cost; lawful, witness-named).
12. **F-C5 (medium)** review deferral keys on reviewer-DECLARED paths.
13. **F-C4 (low-med)** source.branch optional — same off-branch commit
    fails when declared, passes when omitted.
14. **B-F3 (low)** artifact miss error is counts-only — no content naming.
15. **F-C3 (low)** warrantRef absent legal, present shape-checked only.
16. **d-2 (low)** desk accepts any workItemKey; equality only at the gate.

## Not built / honest boundaries

All five spaces and both addenda were built. Boundaries stated in-file:
D5's livelock impossibility is structural, not exhaustive; C's S01/S02 use
real execution (~12 s — the brief's one sanctioned exception); the
runnability pairs in D are proven by plan wiring, not container execution.

## What I could not explain

Nothing unexplained remains from the matrix work. The stage-15 live run
contributed three facts the matrix then confirmed mechanically (the
fence fires with the teaching suffix; the ledger is sound; the cheap
third exit wins) — the sharpest of these (E-F4) was found by the
architect reading the run's DB, not by me watching the panels; that
miss is recorded in the stage-15 tracker and is the reason E7 exists.
