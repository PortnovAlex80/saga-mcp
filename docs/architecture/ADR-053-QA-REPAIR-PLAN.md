# ADR-053 — QA repair plan (response to static QA of `db15b62`)

Date: 2026-08-12
Status: **ACTIVE — clean cutover NOT complete.** This document retracts the
"COMPLETE" claim made in commit `db15b62` and records the real remaining work.

---

## 0. Retraction

Commit `db15b62` (`docs(adr-053): cutover COMPLETE …`) declared the
WorkplaceProductionRevision cutover complete. A static QA of that commit
identified 17 defect classes (C1–C17). After verifying each against the actual
source (not just the report), the QA is **architecturally correct**: the
cutover introduced the authority *substrate* but left the production path
selecting material by recency / hash order and carrying fabricated gate keys.
**The "COMPLETE" declaration was premature and is withdrawn.**

Honest status: *authority model introduced; clean cutover not accepted.*

---

## 1. QA claim verification (what is actually true in the code)

| ID | Defect | Verdict | Evidence |
|----|--------|---------|----------|
| C1 | current author chosen by `ORDER BY candidate_set_ref DESC` (`sets[0]`) | **CONFIRMED** | `sqlite-candidate-set-repository.ts:189`; `acceptedAuthorCandidate()` |
| C2 | reviewer seal key omits `subjectCandidateSetRef` → collision | **CONFIRMED** | `candidate-set.ts` `candidateSetSealKey` = (workplace, revision, role); schema `UNIQUE(workplace_ref,production_revision_ref,role)` |
| C3 | replay returns the new in-memory object, not the persisted row | **CONFIRMED** | `sqlite-candidate-set-repository.ts` `seal()` replay branch returns `set` built from input |
| C4 | `SqliteCellFinalAcceptance.readAcceptedDecision` uses `ORDER BY decided_at DESC` | **CONFIRMED** | `sqlite-cell-final-acceptance.ts:175-180` |
| C5 | git integration `ORDER BY t.id DESC` and `ORDER BY gd.decided_at DESC` | **CONFIRMED** | `sqlite-production-cell-integration.ts:70,162,269` (+ 11 more recency sites in replay/) |
| C6 | obligation carries fabricated `gate-final:<workplace>` | **CONFIRMED → FIXED in tranche 1a** | now `decision.decisionKey`/`decisionDigest` |
| C7 | obligations only for author path; `fence:1` hardcoded | **CONFIRMED** | reviewer/carry-forward seal paths; all `fence: 1` |
| C8 | replay-capture suppressed; terminal crash loses FinalAcceptance | **CONFIRMED → partially FIXED in tranche 1a** | suppression removed; terminal idempotent re-record still TODO |
| C9 | GateRun identity lacks `installationDigest` + `expectedWorkplaceRevision` | **CONFIRMED** | `gate.ts` identity; `factory_gate_runs` has no installation_digest |
| C10 | CheckProvider implementation digest not actually verified | **CONFIRMED** | driver checks version only |
| C11 | CheckReceipt identity collides for repeated provider entries | **CONFIRMED** | `receipt:${gateRunRef}:${providerId}` |
| C12 | GateRun replay re-runs providers, regresses terminal→checking | **CONFIRMED** | `gate-run-driver.ts` replay path |
| C13 | GateDecision digest not over the full canonical body | **CONFIRMED** | `hashDecision(…)` partial |
| C14 | revision assembled from `parent:null` + single execution's products (not cumulative) | **CONFIRMED** | `assembleRevision({parent:null,…})` in executor |
| C15 | `(workplace_ref,semantic_digest)` not UNIQUE; `INSERT OR IGNORE` can mask | **CONFIRMED** | schema; revision repo |
| C16 | NUL validation matches two chars `\\0` not NUL byte | **FALSE POSITIVE** | source already has correct `key.includes('\0')` |
| C17 | empty/fabricated `gateDecisionKey` accepted (`?? ''`) | **CONFIRMED → FIXED in tranche 1a** | `getAcceptedGateDecisionKey` now `string`; `assertAuthorityBound` validates + recomputes digest |

**Also corrected (QA read a stale snapshot):** `factory_failed_gate_recovery_authorizations.producer_execution_ref`
column is already deleted; the remaining `producer_execution_ref` tokens are
local SQL *aliases* over `revision.presenter_ref`, not legacy columns.

---

## 2. Tranches

### Tranche 1a — exact authority key + fail-closed effect input (DONE)
- C6: real `GateDecision` key/digest in both `onGateAccepted` obligations.
- C17: `getAcceptedGateDecisionKey` returns `string` (fail-closed); registry
  `assertAuthorityBound` rejects empty revision/candidate/gate/products and
  recomputes `acceptanceDigest` requiring exact match.
- C8 (partial): replay-capture no longer suppressed; `onFinalAcceptanceRecorded`
  carries the real acceptance digest.
- Tests: `production-cell-node-executor.test.mjs` (C6 obligation == decision_key),
  `post-acceptance-authority-validation.test.mjs` (7× C17). tsc clean; full
  suite 2941/75 (identical baseline, zero regressions, +8 new passing).

### Tranche 1b — stop false authority selection (TODO)
Introduce a **durable current-authority pointer** (exact accepted author
CandidateSet + its GateDecision + final acceptance, keyed by workplace). Then:
- C1: `acceptedAuthorCandidate()` reads the pointer, not `sets[0]`.
- C4: `recordEffectReceipt` / `recordFinalAcceptance` take the exact
  `gateDecisionKey` from the caller (threaded from `runGate`), validate it
  exists + matches; delete `ORDER BY decided_at DESC`.
- C5: git integration binds to the accepted submission `task_id` and the exact
  final gate key; delete `ORDER BY t.id DESC` / `ORDER BY gd.decided_at DESC`.
- Touch: candidate-set repo, cell-final-acceptance, git-integration-effect,
  sqlite-production-cell-integration, executor, schema (authority-head table).

### Tranche 2 — bind reviewer subject into identity (TODO)
- C2: `candidateSetSealKey` + digest include `subjectCandidateSetRef` for
  reviewer; schema partial UNIQUE indexes
  `(workplace,production_revision) WHERE role='author'` and
  `(workplace,production_revision,subject) WHERE role='reviewer'`; FKs for
  subject/source member refs.
- C3: replay returns the **persisted** CandidateSet (and persisted
  GateDecision), comparing immutable fields, fail-closed on drift.

### Tranche 3 — Gate identity, replay, obligations, terminal recovery (TODO)
- C7: reviewer seal + carry-forward seal append `run-gate` obligation
  atomically; `fence` derived from CAS revision, not `1`.
- C8 (finish): terminal-accepted reconciliation idempotently ensures effect
  receipts + FinalAcceptance + obligation + ReplayCapture before returning.
- C9/C10/C11: GateRun identity += `installationDigest` + `expectedWorkplaceRevision`;
  verify provider implementation digest; CheckReceipt key includes ordinal +
  parameters + environment.
- C12/C13: GateRun replay returns persisted decision/receipts, never re-runs
  providers, never regresses terminal→checking; decision digest over full body.
- C15: `UNIQUE(workplace_ref,semantic_digest)` + `BEGIN IMMEDIATE`; revision
  repo returns persisted exact/semantic-equivalent revision.

### Tranche 4 — real cumulative ProductionRevision (TODO)
- C14: source adapters emit delta/full-state operations; assembler applies to
  the exact current parent revision head (CAS-updated with the seal); prove
  `X+Y` ≡ `X` then `Y` converge to one semantic material identity (no recency
  for parent selection).

---

## 3. Required regression tests (from QA §5, to be added with the relevant tranche)

1. Two author sets; accepted pointer cites the lexicographically *smaller* ref — reviewer must pick it (not `sets[0]`).
2. Same reviewer payload for subject A and B → two distinct refs (C2).
3. CandidateSet replay returns persisted subject/receipt/time; mutated subject/members rejected (C3).
4. GateDecision replay returns persisted object; drift of any immutable field rejected.
5. GateRun identity changes when installation digest / expected revision / parameters / assessment set change.
6. Terminal GateRun replay does not re-run any provider.
7. Two entries of one provider → distinct receipt refs.
8. FinalAcceptance rejected on wrong gateDecisionKey even if a newer accepted decision exists.
9. Git integration selects `tasks.id = acceptedSubmission.task_id` even if a newer task exists.
10. Git integration uses the exact final gate key even if a later accepted decision exists.
11. Crash after accepted transition, before FinalAcceptance → recovers exact final acceptance + replay capture (C8).
12. Reviewer seal creates `run-gate` obligation atomic-with-seal (C7).
13. Carry-forward seal creates `run-gate` obligation atomic-with-seal (C7).
14. Gate transition + authority head + obligation roll back together on CAS miss.
15. Effect receipt + obligation roll back together.
16. FinalAcceptance + obligation roll back together.
17. `X+Y` (one execution) ≡ `X` then `Y` (two executions) converge to one semantic material authority (C14).
18. NUL byte in member key rejected.
19. PostAcceptance registry rejects empty gate key and a wrong acceptance digest. *(added in 1a)*
20. Architecture ratchet forbids in post-seal files: `ORDER BY candidate_set_ref DESC`, `ORDER BY t.id DESC`, `ORDER BY gd.decided_at DESC`, `gateDecisionKey ?? ''`, suppressed replay-capture errors.

---

## 4. Acceptance gate for the real "complete"

A future commit may declare ADR-053 complete ONLY when ALL hold simultaneously:
tsc strict green; eslint green; full `npm test` green (the 75 pre-existing
failures — mostly B-3-final fixture lag in `candidate-set-seal`/REG-12 and
temporal/lifecycle suites — resolved or explicitly triaged); C1–C15 fixed with
their regression tests green; the architecture ratchet (#20) green; clean
fresh-DB scripted E2E; temporal crash suite.
