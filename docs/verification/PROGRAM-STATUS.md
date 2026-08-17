# Saga Core Renewal — Program Status & Resumption Guide

- **Updated:** 2026-08-17, after K10 CLOSE (manifest 8/8 at `93d68d40`)
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

71 program commits total. ADR registry: 7 closed (024/033/034/076/078/079/080),
1 implemented (077), 4 in-progress (ADR-053 carries K10 evidence).

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

## Next concrete steps (K11 — Authority-Only Post-Acceptance Effects)

Per plan §5 K11: every post-acceptance effect consumes exact
accepted-material authority only; full authority-only effect cutover
(the K7 commit-3 ratchet already pins the input surface — K11 owns the
REMAINING effect-side consumers and the deletion of any non-authority
effect inputs). Read the K11 train in
docs/vision/SAGA-CORE-RENEWAL-PLAN.md §5 before starting. Then K12
(gate-proven acceptance) and K13 (M3 close).

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
