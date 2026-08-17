# Saga Core Renewal — Program Status & Resumption Guide

- **Updated:** 2026-08-17, after K8 CLOSE (boundary manifest 8/8 at `c9903c64`)
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

59 program commits total. ADR registry: 6 closed (024/033/034/076/078/079),
1 implemented (077), 4 in-progress.

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

## Next concrete steps (K9 — Deterministic Invalidation and Third-Lifecycle
Theorem, M2)

Commit train per plan §5 K9:
1. `docs(architecture): define capsule invalidation and regeneration
   grammar` — typed reasons, state transitions, idempotency.
2. `feat(replay): persist immutable invalidation evidence` — bind mismatch
   to exact capsule, package, baseline, lifecycle.
3. `refactor(dispatch): regenerate through normal production path`.
4. `test(temporal): inject crashes at bind, invalidate, regenerate, seal`.
5. `test(factory-contract): canonical third-lifecycle scenario`
   (N, N+1, N+2 on one epic/workplace family).
6. `test(architecture): ban mismatch-to-anonymous-park`.
Exit gate: the third-lifecycle canonical scenario passes from clean AND
upgraded DBs with no recency selector and no manual repair.

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
