# Saga Core Renewal — Program Status & Resumption Guide

- **Updated:** 2026-08-17 late evening, after the saga4-fix merge (merged-tree manifest 8/8 at `a4f79518`)
- **Worktree:** `D:\Development\saga-mcp-kernel`, branch `k0-adr-closure-registry`, base `eb0ace82`
- **Program plan:** `docs/vision/SAGA-CORE-RENEWAL-PLAN.md` (this branch now carries it)
- **Companion plan:** `docs/vision/CONTROLLED-CHANGE-PLANE-PLAN.md` (runs AFTER Core 3.0 GA)

## Hard operating rules (from the operator)

1. **The production factory in the MAIN checkout must never be restarted or
   touched.** All work happens in this worktree against per-run temp DBs.
   Tests use scripted workers — zero network LLM calls, zero rate-limit use.
2. Sequential releases only (K0→K20). One commit = one proof; every release
   boundary = full canonical manifest (`node tools/verification-manifest.mjs
   --run`, ~25-30 min, factory-temporal dominates at ~22 min).
3. `node_modules` is a junction to the main checkout (read-only use).

## Position

| Done | Manifest SHA (8/8 green) |
|---|---|
| K0 (ADR registry) + K1 + K1.1 + K2 (M0, legacy freeze) | `9750531b` |
| K3 (real handler digests) + K4 (ADR-077 fingerprint) | `942bfabf` / `f03fc82c` |
| K5 (M1: restart-required verdicts; ADR-024/033/034 closed) | `bca805a2` |
| K6 (ADR-078: settlement vertical on exact lifecycle reads) | `ae5c7bc5` |
| K7 (trace-gap cutover; effects ratchet; recency classified 9→7; ADR-078 closed) | `dc1dcf39` |
| K8 (ADR-079: exact replay binder; 4 newest-wins cut; readLatest deleted) | `c9903c64` |

78 program commits total. ADR registry: 8 closed (024/033/034/076/078/
079/080/081), 1 implemented, 4 in-progress. 13 of 21 releases done; K13
remains for M3.

RESOLVED: the saga4 mainline fixes (mis-keyed workItemKey — kernel-
authority matching; serialized workplaceRef in the repair-issue
context; regression tests) are MERGED (3dfc07a8) and the merged tree
is boundary-proven: manifest 8/8 at a4f79518 (which also carries the
golden-path de-flake — lease-recovery attempts are durable, not
forbidden; three same-root flakes documented there).

## K8 close summary (evidence map)

- Commit 1 `8469ffaf`: ADR-079 — semantic key decided; sufficiency
  transitivity documented (packageDigest freezes check plan/contract/
  handlers; semanticInputDigest embeds upstream identities;
  subjectProductionDigest binds reviewer subject via authority head).
- Commit 2 `3cda0ff8`: N/N-1/N-2 theorem — alias multiplicity is
  SCHEMA-IMPOSSIBLE (UNIQUE(replay_key,payload_hash); key-derived
  capsule_ref + INSERT OR IGNORE), reviewer subject isolation, conflict
  fail-closed, typed miss.
- Commit 3 `cabdb60b`: four newest-wins cut — assembler guarded readLatest →
  readByExactCursor; protocol active/paused + recovery case picks +
  outcome-certificate reads → fail-closed uniqueness (paused and recovery
  had NO schema protection — real defects).
- Commit 4 `bf187a33`: typed routing pinned — ineligibility is
  workplace-scoped durable evidence downgrading to a miss; binder failures
  release + poison one card.
- Commit 5 `15a66831`: readLatest/readLatestV2 DELETED (ports + SQL, zero
  callers).
- Commit 6 `c9903c64`: model-choice orthogonality — key material is exactly
  nine ADR-79 coordinates; negative-verified interface pin.
- Closing commit (this): registry 079 → closed; this status doc.

## K9 close summary (M2 achieved; evidence map)

- Commit 1 `d734f1c1`: ADR-080 — grammar (closed reason set; states
  valid/invalidated/regenerating/regenerated/refused; regeneration only
  through normal production; anonymous park banned).
- Commit 2 `40a6a292`: factory_replay_capsule_invalidations evidence
  (append-only; UNIQUE(capsule,reason,authority)); conflict path persists
  evidence BEFORE the fail-closed throw; derived invalidity degrades to a
  typed miss on BOTH claim paths; successor binding single-shot.
- Commit 3 `7a837dca`: package-changed bridge — production-install's
  restart-required branch records evidence for old-package capsules
  (json_extract on frozen key material) before refusing; regeneration has
  no capsule lane.
- Commit 4 `07ac7ac1`: crash convergence at bind/invalidate/regenerate/
  seal — exactly-once under fault injection; conflict alarm stays stable.
- Commit 6 `a1e59936`: anonymous-park ban — handler-map set equality, no
  park writes in mismatch handlers, binder write purity
  (negative-verified).
- Commit 5 `3878e51c`: canonical third-lifecycle scenario — N/N+1/N+2
  from CLEAN and UPGRADED databases (exit gate); old capsule
  byte-identical; successor bound; no recency selector; no manual repair.
- Closing commit (this): registry ADR-080 → closed; this status doc.

## K10 close summary (Wave 3 opened)

- Commit `9615455d`: partition-invariance theorem at REVISION level —
  A(X+Y), chained A(X)→B(Y), co-presented A(X)+C(Y) converge to the
  IDENTICAL revisionRef; ProductRef aliasing does not fork; the
  revision-seal/candidate-seal crash window cannot fork; formula pinned.
- Commit `93d68d40`: execution-free identity ban (audit found the train's
  refactor/drop work already delivered by ADR-053 Phase 3-7 — no
  producer_execution_ref column ever existed). Pins: digest/ref functions
  read only material coordinates; interface field sets exact (execution
  only as documented provenance); factory_candidate_sets execution-free;
  seal_receipt_ref write-only provenance. Negative-verified.
- Closing commit (this): ADR-053 annotated with K10 evidence; this doc.

## K11 close summary

- Commit `0a16db95`: negative theorem — operational decoys (newer
  same-task, other-node same-schema, equal-content rows) cannot change
  the effect subject; drifted subject → typed repair, never decoy
  substitution; typed reports are a no-op subject.
- Commit `95c0377c`: ban ratchet — no SQL by task/node/execution/epic
  identity, no ORDER BY/recency/LIMIT 1 in effect files
  (negative-verified); authority assertion precedes all action in every
  effect; registry fail-close order re-pinned. Audit: input surface and
  all three effect implementations were already authority-only.
- Closing commit (this): ADR-053 annotated; this doc.

## K12 close summary

- Commit `21dc7065`: ADR-081 — the AuthorityCommit proof contract.
- Commit `5f33bb40`: RED negatives — five unguarded proof dimensions
  (wrong candidate, non-accepted verdict, non-terminal run, receiptless
  run, unfrozen plan) sailed through; forged-key was already partially
  guarded (GATE_DECISION_HEAD_AUTHORITY_MISMATCH).
- Commit `0f84dcbf`: the CommitAcceptedCandidate service — verifies the
  full persisted proof (decision/verdict/phase/subject/terminality/
  receipts/plan/CAS) then ONE transaction; the coordinator's public
  accepted-truth branch removed (GATE_PROOF_VERIFICATION_REQUIRED);
  executor + all test callers migrated. Phase semantics discovered: a
  no-review cell's author gate is phase FINAL. Drive-by: fixed a
  pre-existing red in factory-cycle (custom check-plan digest missed
  the canonical policy/unknownError fields).
- Commit `e90ba491`: crash cover (zero-or-one commits; typed stale
  retry) + exit-gate ratchet (ONE mutation service; the truth field
  appears only in the rejection declaration + condition).
- Closing commit (this): ADR-081 closed; this doc.

## Next concrete steps

1. Merge the saga4 fixes (see OPERATOR NOTE) + fresh boundary manifest
   over the merged tree.
2. K13 — Exact Accepted Head and Obligation Settlement (M3 close):
   read the K13 train (plan §5) before starting.

## Resumption protocol for a fresh context

Read, in order: this file → `docs/vision/SAGA-CORE-RENEWAL-PLAN.md` §5-6
(the K-release trains) → `git log --oneline eb0ace82..HEAD | head -20` →
`node tools/adr-closure-registry.mjs --report` → `npm run legacy:report`.
Everything above is committed; nothing lives only in conversation memory.

## Live commands

- `npm run verify:check` — boundary validity on current HEAD
- `npm run adr-closure:validate` — registry health
- `npm run legacy:report` — burn-down vs allowlist
- `npm run test:factory:ratchet` — includes script-target integrity
