# K1 — Canonical Verification Baseline (Saga Core Renewal)

- **Date:** 2026-08-17
- **Worktree:** `D:\Development\saga-mcp-kernel`, branch `k0-adr-closure-registry`
- **Base SHA:** `eb0ace827baf4f774f0e2b86c5bf0c5058eda26a` (program evidence baseline)
- **K1 tip:** this commit's parent chain (see `git log`)
- **Environment:** node v24.13.1, win32/x64, isolated worktree with junctioned
  read-only `node_modules`; the production factory
  (`mars-venus-e2e-20260811-015`) was running in the main checkout for the
  entire duration and was not touched.
- **Method:** every suite executed in the worktree against its own temp
  databases (verified: no reference to `.factory-testbed` or any live DB).

## Canonical suite status

| Suite | Result | Evidence |
|---|---|---|
| `npm run build` | GREEN | tsc, clean `dist/` |
| `npm run test:factory:ratchet` | GREEN (2) | target restored by K1 commit 1 |
| `npm run test:architecture` | GREEN | full chain incl. dispatcher-race scenarios + new K0/K1 tests |
| `npm run test:factory-contract` | GREEN (83) | incl. crash recovery, stale fencing, P18 durability |
| `npm run test:golden-path` | GREEN (1, ~60s) | Run A fresh + Run B replay, zero scripted calls |
| `npm run test:factory-temporal` | **RED (11/13)** | two failures, see below |
| `npm run test:factory-model` | GREEN (3) | dual-cycle generated fixtures |
| migration smoke (3 files) | GREEN | watchdog/soft-stop migrations + v4 conformance ratchet |

## Root causes found and their disposition

### Repaired in K1 — stale ADR-072 handoff vocabulary

`Foundation: full product-build lifecycle traverses every ADR-053 durable
handoff` failed with observed handoff set of five including
`close-presentation` vs the expected four. Bisect: commit `15ce9814`
(*durably close final typed presentations*, ADR-072) added the
`close-presentation` durable handoff kind without updating the vocabulary
assertion in `tests/factory-temporal/foundation.test.mjs`. Production was
correct; the expectation lagged. Repaired in K1 commit 3; the assertion
remains an exact-vocabulary pin. Green in isolation (70s).

### Handed to K1.1 — worker-boundary 2 convergence stall

`worker-boundary 2: exit-after-product-submission-before-worker-done` times
out at 180s. **Deterministically reproduced in isolation** (solo run, idle
machine, twice full-suite + once solo). This is a real convergence failure
of the orphaned-desk-production recovery path at the program baseline —
the second, independent root cause. Per the K1 split condition it is NOT
bundled into K1's repair commit; it opens release **K1.1** (bisect the
stall, one repair, focused regression).

Preserved diagnostics: `saga-wb-wb2-exit-post-submit-repo-*` fixture dirs
under the OS temp root.

## Historical claims replaced

- The old refactoring status' "red golden path" is obsolete: the golden
  path is green at this baseline (62s). Recorded here as current truth.
- The broken `test:factory:ratchet` script target (missing file) —
  confirmed at baseline and repaired (K1 commit 1, plus removal of the
  dead `test:e2e` script referencing a deleted test file).

## Same-SHA manifest discipline

`tools/verification-manifest.mjs --run` writes
`docs/verification/verification-manifest.json` bound to the exact SHA and
all eight suites. It will be generated on the first tip where
**factory-temporal is fully green** — expected at the end of K1.1. Until
then this document, not a manifest, is the canonical status record.
`--check` is the release-gate command from K1.1 onward.

---

## K1.1 addendum — the green baseline exists

**Status: ALL GREEN.** `verification-manifest.json` records SHA `9750531b`
with every canonical suite passing: build, factory-ratchet 2/2,
architecture 218/218, factory-contract 84/84, golden-path 1/1,
factory-temporal 31/31, factory-model 3/3, migration-smoke 18/18.

Root cause repaired (see `fix(products)` commit): the discovery
proposal-ref product write omitted its instance `productKey`, so any retry
from a new execution with the same content violated
`UNIQUE(process_run_id, product_kind, product_key)` on
`factory_process_products` and rolled back the entire typed submission —
the worker then failed `worker_done` with `PRODUCTION_CELL_PRODUCT_REQUIRED`
and the recovery loop never converged. `productKey: 'proposal:<id>'`
(the documented `artifact:<id>` convention) restores per-instance identity;
content-identical replay still resolves as `replayed: true`.

Test-side consequences, both healed in the same release:

- `worker-boundary 2` (temporal) now converges: attempt 2 re-submits from
  its own execution and completes.
- `crash-recovery T10` (contract) had been passing **because of the bug** —
  its epoch-rollover assertion was satisfied by the non-converging crash
  loop. T10 now asserts the healthy contract (converges, exit 0, zero
  epochs) and its fixture gains the missing integration branch `dev`
  (invisible while the test never reached the development phase). New
  `T10b` (persistent crash) owns the ADR-075 epoch coverage.

The production factory running in the main checkout was not touched: all
runs executed in the `saga-mcp-kernel` worktree against per-run temp
databases.
