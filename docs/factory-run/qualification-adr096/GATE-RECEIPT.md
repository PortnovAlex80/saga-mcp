# ADR-096 Qualification Gate Receipt — saga4 frozen build

**Frozen build:** receipt `a5108835f2fd` — head `37ce4c00` (saga4), dist 1530
files (tree `abd53015e240`), package.json `18992fe472a3`, package-lock
`80b732d65374`, package-store 7 deterministic packages (hash `0e44b6995153`).
Freeze provenance: initial freeze `03e9af1df388` over empty store; re-frozen
after the orchestrator ruling that the drive-populated deterministic
content-addressed store is an already-declared transition instance (same 7
digests after 1 and after 3 runs — determinism proven; the re-frozen receipt
keeps full drift detection: any digest change or store addition fails
--check). Receipt checks: 5/5 MATCH across the scripted legs; settings
tripwire `2d6176e8…` unchanged before/after every leg and canary.

## Gate item verdicts

| # | Gate item (ADR-096) | Verdict | Evidence |
|---|---|---|---|
| 1 | Development obligations 100% demonstrated (incl. production-sized satisfiability, no fallback SRS scopes) | **PARTIAL — 34/40 demonstrated; 6 structural residues** (each with precise harness-substrate justification, none a production defect) | conformance harvest 82/82 pass on the frozen head (`tests/factory-evidence/`, commit `37ce4c00`); production-sized task-graph satisfiability demonstrated at Elite-9 scale (59 card classes: SAT decided 59/59; cycle-UNSAT typed witness; SRS-identity UNSAT honest terminal); no-fallback-SRS ratchets green (`no-fallback-reconstruction`, `exact-product-query`) |
| 2 | K4 crash/fault edges + non-zero mutation kill floor blocking | **PASS** | commit `246532e4`: 4 ADR-048 worker-boundary suites de-quarantined into blocking group `k4-fault-edges` (4/4, CI-invoked); mutation-kill floor 21/21 deterministic mutants killed on real dist seams (ratio 1.0, floor + per-class minimums pinned, blocking in `factory-proof`) |
| 3 | 3 fresh Development + 3 fresh whole-factory runs, one immutable build, different deterministic seeds, no mutation between runs | **PASS** | SCRIPTED-LEGS-LEDGER.md: A1C/A2C/A3C (seeds 0/1/5 across w9-02/03/04 lanes — golden, cross-execution-durability, dev-blocked honest terminal) + B1/B2/B3 (happy-verified; production-scale SAT; restart-idempotency) all exit 0, deterministic terminal shapes, fresh mkdtemp root per run; receipt MATCH before/after every batch; store stable at exactly 7 packages |
| 4 | One non-game synthetic workshop completes without core runtime name branch or new dispatcher | **PASS** | documentation (PDF docs) workshop admitted on the canonical line (commits `25f4cb3a`, `9a8c532f`, `f8ac9382`); witness C1/C2 in scripted legs: happy-documented renders 3 real PDFs (sha256-verified on disk == oracle receipts) through the EXISTING conveyor; missing-engine settles honest typed blocked; v4 ratchet needed no re-pinning (no runtime name branch); dependency-direction/workshop-manifest-parity guards green |
| 5 | Two real-model canaries complete without intervention; deviations use declared transitions | **PASS** — canary-1: terminal `runnable-local`/verified, exit 0, ~3h10m, zero intervention (the manufacture-SUCCESS shape). canary-2: terminal `development-blocked`, exit 0, ~3h53m, zero intervention — certificate `implementation-incomplete` on 7 work items; an honest TYPED declared-outcome class (w9-04 shape), valid factory outcome per ADR-096, not counted as successful manufacture. Both completed via already-declared transitions | CANARY-LEDGER.md; snapshots: canary-1 5,341,184 B / canary-2 5,341,184 B, integrity=ok both; tripwire unchanged; frozen-tree receipt MATCH after the full window |
| 6 | No run reveals a genuinely new invariant class | **PASS — none observed across the entire qualification window** (scripted legs + both canaries): every deviation is an already-declared transition instance (package-store declared-transition ruling; canary-2 blocked = declared outcome; the 6 cancelled tasks = the REG-28 settlement drain working as designed — the defect itself was found and fixed PRE-freeze with regression 4/4; spawn-interference blanket-runner class known and disk-exhaustion root-caused+cleaned, neither a runtime invariant) | ledgers above; kill-gate material: none |

## Honest residuals (inherited by the successor plan as blocking criteria)

1. Gate item 1 exact residues (development pending universe, 6 tokens):
   `D2:fanout-scheduling:concurrency-cap-limits-parallel-runnable` (strong
   form — requires strict spawn channel not hosted in the in-process lane),
   `D7:bind:stale-readiness-hash-failed` (cross-lifecycle continuation seam),
   `D8:verification:terminal-accounting-unknown` / `-human-required`
   (ADR-089 diagnostic substrate / human-park accounting seams not hosted by
   a lawful base-module drive), `D10:continuation:managed-source-author-no-git-authority`
   / `D10:replan:superseded-tasks-not-claimable` (engine-CLI redevelop entry
   outside the fresh-harness lane). Plus delivery 2 (`K4:crash-after-effect-before-receipt`,
   `restart:delivery:idempotent-settlement` — the latter unblocked now) and
   documentation 10 fault/recovery families (declared-not-driven).
2. CC-41 named fault scheduler + CC-42 deterministic minimization not landed
   (kept refused per §13 protocol).
3. CC-U2 warrant-oracle command authority — separate open gap, owned by
   reserved ADR-093 (never part of ADR-053/gate scope).
4. dejavu-fonts-ttf + pdfkit declared — documentation render now
   self-contained; the SAGA_DOCS_FONT system-font override path remains as
   documented fallback.

## Canary-2 — TERMINAL (2026-08-25 09:07:55Z)

Completed without intervention; terminal `development-blocked` (honest typed
outcome, certificate `implementation-incomplete`, 7 work items); full record
in CANARY-LEDGER.md. Frozen-tree receipt MATCH after the whole window.

## Gate verdict

ADR-096 gate items 1–6: **1 PARTIAL (34/40, structural residues inherited by
the successor), 2 PASS, 3 PASS, 4 PASS, 5 PASS (canary-1 success-shape;
canary-2 honest typed), 6 PASS — no kill-gate trigger.** The bounded
qualification is complete; the terminate/reduce decision is NOT triggered.
