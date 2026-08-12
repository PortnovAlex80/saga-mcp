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
| C1 | current author chosen by `ORDER BY candidate_set_ref DESC` (`sets[0]`) | **CONFIRMED → FIXED in tranche 1b** | new `factory_accepted_authority_head` table (PK workplace_ref) written ATOMICALLY with the author-gate-accept CAS transition (`ProductionCellCoordinator.applyAcceptanceEvent` wraps `applyTransitionInTx` + head UPSERT in one IMMEDIATE txn); `acceptedAuthorCandidate` reads the exact pointer; `listForWorkplace` is now diagnostics-only (`ASC`) |
| C2 | reviewer seal key omits `subjectCandidateSetRef` → collision | **CONFIRMED → FIXED in tranche 2** | `candidate-set.ts` `candidateSetSealKey` now appends `subjectCandidateSetRef` for reviewer (author key unchanged); executor reviewer digest binds subject; schema replaced combined `UNIQUE(workplace,revision,role)` with partial uniques `(workplace,revision) WHERE author` + `(workplace,revision,subject) WHERE reviewer` |
| C3 | replay returns the new in-memory object, not the persisted row | **CONFIRMED → FIXED in tranche 3** | `seal()` replay branch now reads the persisted row, compares immutable material (revision/role/subject/members) and returns it (not the new input); `assertPersistedMaterialMatches` fails closed on drift |
| C4 | `SqliteCellFinalAcceptance.readAcceptedDecision` uses `ORDER BY decided_at DESC` | **CONFIRMED → FIXED in tranche 3** | reads by EXACT `(workplace, subject, verdict='accepted', gate_phase='final')` with a uniqueness assertion; no recency — `gate_phase='final'` disambiguates the author-phase from the final-phase acceptance for the same subject |
| C5 | git integration `ORDER BY t.id DESC` and `ORDER BY gd.decided_at DESC` | **CONFIRMED → PARTIAL in tranche 3** | review-decision recency removed (the query was already exact on `workplace+subject+gate_phase='final'+verdict='accepted'`, so `ORDER BY gd.decided_at DESC LIMIT 1` was a pure-recency tiebreaker, now dropped); task selection `ORDER BY t.id DESC` STILL PRESENT — binding the task exactly needs the managed-submission↔task linkage investigation (deferred) |
| C6 | obligation carries fabricated `gate-final:<workplace>` | **CONFIRMED → FIXED in tranche 1a** | now `decision.decisionKey`/`decisionDigest` |
| C7 | obligations only for author path; `fence:1` hardcoded | **CONFIRMED → PARTIAL in tranche 3** | reviewer + carry-forward seals now append the `run-gate` obligation atomically (was author-only); `fence: 1` still hardcoded (real CAS-derivation is C6/C7 remaining) |
| C8 | replay-capture suppressed; terminal crash loses FinalAcceptance | **CONFIRMED → FIXED in tranche 1a+3** | suppression removed (1a); terminal(accepted) reconcile now idempotently re-records FinalAcceptance + replay-capture when the row is absent (3) |
| C9 | GateRun identity lacks `installationDigest` + `expectedWorkplaceRevision` | **CONFIRMED → FIXED in tranche 3** | `gateRunIdentity` now includes `installationDigest` + `expectedWorkplaceRevision`, so a handler/package swap or a newer Workplace revision can't reuse a stale GateRun/Decision |
| C10 | CheckProvider implementation digest not actually verified | **CONFIRMED** | driver checks version only — needs `providerDigest` added to the CheckProvider interface + all providers (wide; deferred to a focused tranche) |
| C11 | CheckReceipt identity collides for repeated provider entries | **CONFIRMED → FIXED in tranche 3** | receipt ref now includes the entry ORDINAL: `receipt:${gateRunRef}:${index}:${providerId}` |
| C12 | GateRun replay re-runs providers, regresses terminal→checking | **CONFIRMED** | needs repo read methods + early-return of the persisted terminal decision (deferred) |
| C13 | GateDecision digest not over the full canonical body | **CONFIRMED → FIXED in tranche 3** | `decisionDigest` now hashes the full canonical decision body (workplace/phase/subject/assessment/plan/policy/installation/receipts/bindings/recovery), not just key+verdict+repair+receiptRefs |
| C14 | revision assembled from `parent:null` + single execution's products (not cumulative) | **CONFIRMED** | `assembleRevision({parent:null,…})` in executor |
| C15 | `(workplace_ref,semantic_digest)` not UNIQUE; `INSERT OR IGNORE` can mask | **CONFIRMED → FIXED in tranche 3** | `idx_workplace_revisions_semantic` is now UNIQUE; `appendRevision` returns the persisted/semantic-equivalent row; convergence transaction runs `BEGIN IMMEDIATE` |
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

### Tranche 1b — durable current-authority pointer (DONE)
- **C1 (fixed):** new `factory_accepted_authority_head` table (PK workplace_ref)
  holding the exact accepted author CandidateSet + its GateDecision key.
  `ProductionCellCoordinator.applyAcceptanceEvent` writes it ATOMICALLY with the
  author-gate-accept CAS transition (wraps `applyTransitionInTx` + head UPSERT in
  one IMMEDIATE transaction — the pointer is durable iff the acceptance
  committed). `acceptedAuthorCandidate` reads the exact pointer instead of
  `sets[0]` by `candidate_set_ref DESC`. `listForWorkplace` is demoted to
  diagnostics-only (`ASC`). Regression test: authority head recorded on author
  acceptance with the exact accepted set + final gate decision.
- **C4 (already fixed in tranche 3)** and **C5 review-decision (already fixed)**;
  C5 task-binding (`ORDER BY t.id DESC`) still TODO.

### Tranche 2 — bind reviewer subject into identity (DONE)
- **C2 (fixed):** `candidateSetSealKey` appends `subjectCandidateSetRef` for
  reviewer (author key unchanged → no author-fixture cascade); rejects reviewer
  without subject / author with subject (REG-12-AC-04). Executor reviewer
  `candidateSetDigest` binds the subject. Schema replaced
  `UNIQUE(workplace,revision,role)` with partial uniques
  `(workplace,revision) WHERE role='author'` and
  `(workplace,revision,subject) WHERE role='reviewer'`.
- Tests: REG-12 block in `workplace-domain.test.mjs` rewritten to the
  productionRevisionRef contract + 3 new C2 domain tests; `candidate-set-seal.test.mjs`
  rewritten (was a broken stale file) into repo-level C2 tests proving two
  reviewer sets over different subjects coexist. Full suite 75 → ~66/67 failures
  (8 previously-red REG-12/seal tests fixed; ±1 temporal flake), zero new
  regressions.
- **C3 (still TODO in this tranche):** replay returns the persisted
  CandidateSet (and persisted GateDecision), comparing immutable fields,
  fail-closed on drift.

### Tranche 3 — Gate identity, replay, obligations, terminal recovery (PARTIAL)
- **C3 (fixed):** CandidateSet replay returns the persisted immutable authority,
  not a fresh object from the new input; immutable material compared, fail-closed
  on drift.
- **C7 (partial):** reviewer seal + carry-forward seal now append the `run-gate`
  obligation atomically (was author-only). `fence: 1` still hardcoded — deriving
  it from the CAS revision remains (part of C6/C7).
- **C15 (fixed):** `idx_workplace_revisions_semantic` is UNIQUE;
  `appendRevision` returns the persisted/semantic-equivalent revision; the
  convergence transaction uses `BEGIN IMMEDIATE`.
- **C8 (fixed):** terminal(accepted) reconcile now idempotently re-records
  FinalAcceptance + replay-capture when the row is absent (crash between
  gate-accept and recordFinalAcceptanceAndCapture). Net effect of C7+C8: the
  full-suite failure count dropped 66 → ~47/48 (many lifecycle/crash-recovery
  tests unblocked).
- **Still TODO:** C9–C13 (GateRun identity + provider digest + one-shot replay +
  full decision digest).
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
