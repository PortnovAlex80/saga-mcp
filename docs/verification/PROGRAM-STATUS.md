# Saga Core Renewal — Program Status & Resumption Guide

- **Updated:** 2026-08-17, after K7 commit 4/6 (SHA `13e00cb2`)
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
| K7 commits 1,2,4 (inventory category; trace-gap lifecycle-scoped; epic variant deleted) | boundary pending after 5-6 |

48 program commits total. ADR registry: 4 closed, 2 implemented, 41 planned.

## Next concrete steps (K7 remainder)

1. **K7 commit 3** — `refactor(effects): migrate accepted-material read
   before effect invocation`: audit effect inputs for task/node/latest
   re-queries; pass exact refs forward (ADR-053 Step 3 direction; full
   authority-only effects are K11 — K7 only removes material RE-SELECTION
   reads if any exist on live paths; if none, record that finding).
2. **K7 commit 5** — `test(architecture): ban authority ORDER BY time/latest`:
   classify the 9 recency-selector files from
   `docs/architecture/legacy-allowlist.json` (category
   `recency-selector-authority-persistence`): K7-owned subset
   (carry-forward, projection-persistence, verification-adoption,
   process-module-installation-repo) gets cut to exact refs or reclassified
   as explicit observability with rationale; brief reads
   (brief-provisioning-ports, formalization-package-adapters) are
   lifecycle-independent INPUT provisioning — classify + document, likely
   legal-with-rationale. Then the ratchet: chronology legal ONLY in
   allowlisted observability files.
3. **K7 commit 6** — registry annotations (053/073/078) + full boundary
   manifest + closing commit (`verify:check` must pass: docs-only diff rule).
4. Then **K8** (exact replay binder; the 4 K8-owned recency files:
   lifecycle-continuation, node-run, protocol-run, recovery-case repos) →
   **K9** (invalidation grammar + third-lifecycle theorem, M2).

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
