# W3-A4 — ProcessProductRepository v2 (exact-by-ProductRef)

**Wave:** 3 · **Lane:** A4 · **Spec:** §7 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a4` · **Worktree:** `.worktrees/w3-a4`

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §7.
2. `src/process-modules/persistence/sqlite-process-product-repository.ts` (existing — keyed by `(runId, productKind)`, no exact-by-ProductRef).
3. Wave 1 SPI: `ProductRef`, `NodeProductionEnvelope` from `domain/spi/index.ts`.

## Own
- `src/process-modules/persistence/process-product-repository-v2.ts` (NEW port).
- `src/process-modules/persistence/sqlite-process-product-repository-v2.ts` (NEW adapter).
- `tests/installation/process-product-repository-v2.test.mjs` (NEW).

## Build (spec §7)
- Port: `getByProductRef(ref: ProductRef): ProcessProductRecord | null` (exact `(schemaId, ref, digest)`), `getByArtifactRef(artifactRef)`, `recordProduct(envelope: NodeProductionEnvelope, processRunId, nodeId)`.
- Reuse `saga3_process_products` table; add index on `(schema, ref, hash)` — **coordinate with W3-A6 (SQL owner)**: if you need a CREATE INDEX, ask A6 to add it, OR add it idempotently in your adapter's ensure…Schema (document which).
- This replaces the `listArtifactsForNodeInEpic` fallback (§9.11). Callers query by exact `ProductRef`.

## Verify
`npm run build && node --test tests/installation/process-product-repository-v2.test.mjs && node --test tests/architecture/dependency-direction.test.mjs`

## Commit
`feat(execution): W3-A4 ProcessProductRepository v2 (exact-by-ProductRef, replaces epic-scope fallback)`

## Return
Branch+sha, diff --stat, test tail+ratchet, exported symbols (A5 consumes), confirmation.
