# CI-03 — Clean-Checkout Deterministic Acceptance Baseline

> Evidence that the CI-02 deterministic acceptance matrix is GREEN on a clean
> checkout (no pre-warmed build artifacts, no upward `node_modules` resolution).

## Hidden dependency found and fixed (CI-03 mandate)

The CI-02 matrix runs `node --test` on `*.mjs` suites that import from `dist/`.
CI-02 had set the CI build step to `npx tsc --noEmit` (type-check only, **no emit**),
so `dist/` was never produced in CI → every matrix step would have failed with
`ERR_MODULE_NOT_FOUND`. It passed only in pre-warmed worktrees where `dist/` had
been built earlier. This is exactly the "clean checkout differs from working
checkout" hidden dependency CI-03 exists to catch.

**Fix (part of CI-03):**
- `.github/workflows/ci.yml`: the build step is now `npm run build` (tsc emit →
  produces `dist/`), not `npx tsc --noEmit`.
- `tools/run-acceptance-matrix.mjs`: `ensureDist()` builds `dist/` on demand if
  absent, so standalone/local invocations are self-contained on a clean checkout.

## Clean-checkout proof (executed on a fresh worktree off the integration tip)

| Step | Command | Result |
|---|---|---|
| Fresh worktree | `git worktree add … 93c5d26` | no `dist/`, no local `node_modules` |
| Clean install | `npm ci` | exit 0 |
| Build (emit) | `npm run build` | exit 0, `dist/` produced |
| Lint gate | `npx eslint src/` | exit 0 |
| Acceptance matrix | `node tools/run-acceptance-matrix.mjs` | **all groups green** (exit 0) |

The matrix (architecture, factory-model, readiness-fencing, factory-contract,
process-modules, matrix-coverage) is green on a clean checkout with a freshly
built `dist/`. The baseline is reproducible — no hidden local dependency remains
before W9.
