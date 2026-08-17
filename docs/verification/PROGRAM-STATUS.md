# Saga Core Renewal — Program Status & Resumption Guide

- **Updated:** 2026-08-17, after K9 commits 1-3 (ADR-080 grammar, evidence, bridge)
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

62 program commits total. ADR registry: 6 closed (024/033/034/076/078/079),
1 implemented (077), 4 in-progress. ADR-080 registered (planned, K9).

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

## K9 progress (M2 in flight)

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
  no capsule lane. Tests: evidence 4/4, bridge 3/3, replay regression
  14/14, factory-contract 84/84.

## Next concrete steps (K9 remainder, then close)

4. `test(temporal): inject crashes at bind, invalidate, regenerate, seal` —
   exactly-once convergence. Entry points: the evidence write is inside
   bindReplayToClaim (conflict path) and recordPackageChangedInvalidations;
   crash-injection harness patterns live in
   tests/factory-contract/crash-recovery.test.mjs and the temporal suite's
   scenario-dispatcher infrastructure. Theorem: after a crash at any of the
   four points, re-dispatch converges without duplicate evidence rows
   (idempotency), without capsule mutation, and the lifecycle terminates
   typed (regenerated / refused / terminal) — never an anonymous park.
5. `test(factory-contract): canonical third-lifecycle scenario` —
   N, N+1, N+2 on one epic/workplace family: cold run, replay hit,
   package-changed invalidation + regeneration, from clean AND upgraded
   DBs, no recency selector, no manual repair (exit gate).
6. `test(architecture): ban mismatch-to-anonymous-park` — replay-mismatch
   handling must route to repair_required / regenerate / refuse /
   lifecycle-terminal; parking with an anonymous escalate reason is
   forbidden (ratchet over the mismatch handling paths).
Then: full boundary manifest, registry ADR-080 → closed, PROGRAM-STATUS
advance to Wave 3 (K10 — partition-invariance theorem).

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
