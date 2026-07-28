# W0-A1 — Repository-wide dependency-direction architecture test

**Wave:** 0 · **Lane:** A1 · **Plan ref:** §0.3.2, §13.14, §14.1.3, C047
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a1` (off the frozen commit)

## Context (read first, do not re-reconnoiter)

- Full plan: `docs/refactor-management/00-PLAN.md`.
- Codebase baseline: `docs/refactor-management/01-CODEBASE-BASELINE.md`.
- Current architecture test `tests/architecture/saga2-boundaries.test.mjs` scans a handpicked list of 21 files and **predates** `src/process-modules/**`, `src/saga3/**`, `src/lifecycle/**`. There is NO repository-wide dependency enforcement today (baseline §"Architecture / boundary tests", risk R-04).

## Architecture rule this serves

Plan §3 (Non-negotiable Architecture Rules), especially:
- §3.7 A module never imports Runtime adapters, Runtime persistence implementations, another module implementation, or a Lifecycle Scenario implementation.
- §3.8 A Lifecycle Scenario references module contracts and installed package identities, never module implementation classes.
- §3.16 Module domain and application code depend only on ports.
- §3.14 The architecture is enforced by dependency tests, not only documentation.

## What you OWN (only you may create/edit these this wave)

1. `tools/dep-graph-scanner.mjs` — NEW helper. Scans `src/**/*.ts` (and optionally `tracker-view/**/*.mjs`) and produces, for each source file, the list of **relative import targets** it depends on. Use the TypeScript compiler API or a regex over `import ... from '...'` / `export ... from '...'` statements resolving relative paths (ignore bare specifiers like `node:fs`, `@modelcontextprotocol/sdk`). Output: a JSON map `{ sourcePath: [resolvedTargetPaths...] }`.
2. `tests/architecture/dependency-direction.test.mjs` — NEW test. Uses the scanner. Asserts the **intended** dependency direction below. Current violations are captured in an explicit `KNOWN_VIOLATIONS` allowlist constant (array of `[source, target, reason]`); the test FAILS if (a) a NEW forbidden edge appears that is not allowlisted, or (b) an allowlisted edge is removed without the violation actually being fixed (i.e. allowlist shrinkage requires the underlying import to be gone).

## Intended dependency direction (the rules to enforce)

Enforce these forbidden edges (target = resolved absolute path under `src/`):

1. **No module imports another module implementation.** A file under `src/process-modules/modules/<X>/` may NOT import from `src/process-modules/modules/<Y>/` where X≠Y. (Cross-module contract type imports — e.g. a shared schema id string — are also forbidden at the implementation level for now; flag them in the allowlist if they exist today.)
2. **No module imports Runtime persistence adapters.** A file under `src/process-modules/modules/<X>/` may NOT import from `src/process-modules/persistence/sqlite-*.ts` or `src/infrastructure/**` or `src/db.ts` or `src/schema.ts`. (Ports under `src/process-modules/persistence/*-repository.ts` are allowed; concrete `sqlite-*` adapters are not.)
3. **No lifecycle scenario imports a module implementation.** A file under `src/process-modules/lifecycles/` may NOT import from `src/process-modules/modules/<X>/*` (neither implementation nor module-local schemas/policies). It may reference module *contracts* only — but since today `product-delivery-lifecycle.ts` imports concrete schemas (baseline §"Lifecycles"), those imports MUST appear in `KNOWN_VIOLATIONS` with reason `"Phase 8/9 will replace with contract refs"`.
4. **Runtime core must not switch on module names/kinds.** Source-string scan of `src/process-modules/domain/`, `src/process-modules/application/node-executor.ts`, `generic-flow-executor.ts` for the literals `discovery`, `formalization`, `development`, `delivery`, `saga-product`, `saga-analyst`, `saga-planner`, `saga-discovery-` as evidence of module-kind switching. List current occurrences in `KNOWN_VIOLATIONS`.
5. **Domain layer is pure.** Files under `src/process-modules/domain/` may NOT import from `src/process-modules/application/`, `src/process-modules/persistence/`, `src/process-modules/composition/`, `src/process-modules/modules/`, or `src/infrastructure/`.

## How to seed KNOWN_VIOLATIONS

Run your scanner, compute violations against rules 1–5, and put EVERY current
violation into `KNOWN_VIOLATIONS` with a one-line reason referencing the plan
phase that will fix it. The test then passes today (zero unallowlisted
violations) and becomes a ratchet: future waves must either keep an allowlisted
violation or remove it from the allowlist AND fix the import.

You DO NOT need to be exhaustive about every micro-violation on day one — but
the four big smells from the baseline MUST be represented:
- `product-delivery-lifecycle.ts` → concrete module schemas/policies/refs (rule 3).
- `execution-profile-resolver.ts` → `modules/catalog.ts` built-in registry (a form of module-name switching, rule 4).
- `composition/product-lifecycle-runtime.ts` → every concrete module + every sqlite repo (rule 2/3 periphery — composition root is a special case; allowlist it explicitly with reason `"Wave 11 cutover replaces composition root"`).
- `modules/discovery/discovery-process-module.ts` → `src/saga3/domain/discovery-proposal.js` (rule 2/3 — cross-tree leak; allowlist with reason `"Wave 9 makes discovery self-contained"`).

## Anti-scope (do NOT do)

- Do NOT edit any production source file. This lane is tests + one tool only.
- Do NOT edit `tests/architecture/saga2-boundaries.test.mjs` (different lane's territory is untouched; yours is additive).
- Do NOT fix any violation you find — that is later waves' job. You only codify the ratchet.
- Do NOT touch `package.json` or `tsconfig.json` (integrator owns at checkpoint).

## Exit criteria (your commit must satisfy)

- [ ] `tools/dep-graph-scanner.mjs` exists, is plain Node ESM, exports a function that returns the dependency map.
- [ ] `tests/architecture/dependency-direction.test.mjs` exists, imports the scanner, enforces rules 1–5, and **PASSES** today with the seeded `KNOWN_VIOLATIONS`.
- [ ] `KNOWN_VIOLATIONS` is a named, documented constant; each entry has a `reason` field naming the fixing wave/phase.
- [ ] Test prints the count of allowlisted violations on run, so shrinkage is visible.
- [ ] No production source file is modified (`git diff --stat` shows only the two new files).

## Return to integrator

Reply with:
1. Branch name (`refactor/w0-a1`).
2. `git diff --stat` output.
3. The passing test summary (paste the `node --test` tail).
4. The `KNOWN_VIOLATIONS` count and the list of (source → target, reason) tuples.
5. Any unresolved risks or scope questions (do NOT resolve them by editing production code).
6. Confirmation: "I changed no frozen contract and no production source semantics."
