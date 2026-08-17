# Saga Core Renewal — Program Status & Resumption Guide

- **Updated:** 2026-08-17, after K7 CLOSE (boundary manifest 8/8 at `dc1dcf39`)
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
| K0 (ADR registry 53/53) + K1 + K1.1 (retry-path productKey bug fixed) + K2 (M0, legacy freeze) | `9750531b` |
| K3 (real handler digests; caught 5 pending refs in continuation manifests) + K4 (ADR-077 fingerprint) | `942bfabf` / `f03fc82c` |
| K5 (M1: restart-required verdicts; ADR-024/033/034 closed) | `bca805a2` |
| K6 (ADR-078: settlement vertical on exact lifecycle reads; epic readers deleted) | `ae5c7bc5` |
| K7 (trace-gap cutover; effects ratchet; recency classified 9→7; ADR-078 CLOSED) | `dc1dcf39` |

53 program commits total. ADR registry: 5 closed (024/033/034/076/078),
1 implemented (077), 4 in-progress.

## K7 close summary (evidence map)

- Commit 1 `d1d853e5`: freeze category epic-scoped-material-read (inventory).
- Commit 2 `7ca8a130`: traceability consumer → lifecycle scope.
- Commit 4 `13e00cb2`: epic-scoped trace-gap reader DELETED.
- Commit 3 `acd073f1`: effects audit — exact-refs migration ALREADY complete
  (ADR-053 Phase 6/7); pinned by `effect-input-exact-refs.test.mjs`
  (authority-only input; digest fail-closed before invocation; zero direct
  SQL in the invoker).
- Commit 5 `dc1dcf39`: recency classification — `findLatestForModule` DELETED
  (zero callers), `readProjectedRoleTask` fail-closed unique, carry-forward +
  verification-adoption reclassified (run-history boundary traversal,
  exact-verified), 5 files K8-owned; ratchet =
  `authority-recency-classification.test.mjs` (set equality scan ↔ map ↔
  allowlist). Epic pair (brief provisioning) classified legal INPUT
  provisioning.
- Commit 6 (this): registry 078 → closed (053/073 annotated), this status doc.

## Next concrete steps (K8 — Exact Replay Capsule Binder)

Entry map (scouted at K7 close):
- Newest-wins sites live in node-run-repo `readLatest`/`readLatestV2`/
  `readLastCompleted`(/V2) (ORDER BY id DESC LIMIT 1); an exact
  `(processRunId, nodeId, attempt)` reader already exists beside them.
- ~16 DESC-LIMIT-1 sites across lifecycle-continuation / node-run /
  protocol-run / recovery-case repos (managed-node-submission matched by the
  freeze regex only via multi-line SQL).
- The replay capsule repository itself is already exact-key
  (gate-decision subject); the K8 binder work is in dispatch routing +
  run-history repos.
- Commit train per plan §5 K8: ADR (semantic key: package fingerprint
  ADR-077 + check plan + product contract + baseline + source authority) →
  failing theorem (N-2 newest-wins selection) → exact key lookup → dispatch
  routing → delete newest-wins SQL (same release) → model-choice
  orthogonality proof.
- Then **K9** (invalidation grammar + third-lifecycle theorem, M2).

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
