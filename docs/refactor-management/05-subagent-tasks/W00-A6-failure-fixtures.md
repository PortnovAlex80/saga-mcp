# W0-A6 — Fixtures reproducing the 2026-07-28 failures

**Wave:** 0 · **Lane:** A6 · **Plan ref:** §0.3.7, §2.2, §14.1.1
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a6`

## Context

- Plan §2.2: "The failures reported on 2026-07-28 are not independent defects. Missing brief production, incomplete provenance, execution-scoped reads, lost receipts, no-op ports, mutable tracker state, null content hashes, skill drift, and retry inconsistencies are manifestations of unstable boundaries."
- Plan §14.1.1: "Record the current pipeline stop points and known failures as explicit test fixtures."
- Baseline: scan `docs/discovery/projects/*/` and recent commits (`git log --oneline -30`) for evidence of the 2026-07-28 failures.

## Architecture rule served

Plan §2: the root problem is unstable boundaries. Fixtures make the failures
reproducible so each later wave can prove its boundary fix actually resolves
them. A fixture is a frozen input + the observed wrong/fragile output, NOT a
passing test.

## What you OWN

- `tests/characterization/fixtures/2026-07-28-failures/` — NEW directory.
- One `.md` manifest per failure + any supporting `.json`/`.txt` data files.
- `tests/characterization/2026-07-28-failures.test.mjs` — NEW test that loads each fixture manifest and asserts it is well-formed (schema check), and where possible asserts the CURRENT (buggy) behavior reproduces. Where reproduction requires a full pipeline run, document the reproduction command instead of running it.

## Failures to capture (from plan §2.2 — find concrete evidence for each)

For each, produce a fixture manifest with: `id`, `symptom`, `root_cause_class`
(one of: missing-production, incomplete-provenance, execution-scoped-read,
lost-receipt, no-op-port, mutable-tracker, null-content-hash, skill-drift,
retry-inconsistency), `evidence` (commit/file/issue link), `reproduction`
(command or steps), `expected_after_fix` (what the post-refactor behavior
should be), `fixing_waves` (which waves resolve this boundary).

1. **Missing brief production** — Discovery brief not emitted as an explicit declared product. Search `docs/discovery/projects/` and `src/saga3/` for where the brief should be produced. (Plan §14.11.3 fixes this in Wave 9.)
2. **Incomplete provenance** — a worker production whose lineage (processRun/node/attempt) is partially absent. Look at `sqlite-managed-production-ledger.ts` usage and recent `fix(development): stamp full provenance` commit (`fd52982`).
3. **Execution-scoped reads** — a resolver that falls back from execution scope to process scope. Recent `fix(formalization): retry/recovery fallback for execution-scoped artifact reads` commit (`9229f14`) is direct evidence.
4. **Lost receipts** — a NodeRun whose receipt is not durable across restart. Look at `generic-flow-executor.ts` mutable frame reconstruction.
5. **No-op ports** — a declared port with a default no-op implementation in production composition. Search `composition/product-lifecycle-runtime.ts` for ports wired to `() => {}` or `Promise.resolve()`.
6. **Mutable tracker state** — tracker Markdown the model is expected to maintain. `process-execution-workspace.ts` + `tracker-reminder.mjs`.
7. **Null content hashes** — a production record persisted with null/empty content hash. Search `sqlite-*-runtime.ts` for `content_hash` inserts that can be null.
8. **Skill drift** — semantic skill resolved differently from what the profile declares (e.g. reviewer overwritten by author skill). `claude-runner.mjs` `effectiveSemanticSkill` logic.
9. **Retry inconsistencies** — declared retry/recovery fields not fully implemented (plan §13.24). Search `domain/process-module.ts` retry policy types vs `generic-flow-executor.ts` actual retry behavior.

## How to find evidence

- `git log --oneline --since=2026-07-20` for fix commits that name these symptoms.
- `grep -rl "execution-scoped\|fallback\|lost receipt\|null.*hash\|skill drift" src/ docs/` (read-only).
- `ls docs/discovery/projects/` — recent project dirs (46–60) likely contain tracker stage files showing where production went wrong.

If a failure cannot be concretely located, still create the fixture manifest
with `evidence: "not located — see plan §2.2"` and `reproduction: "unknown"`.
Honest gaps are better than invented evidence.

## Anti-scope

- Do NOT fix any failure (that is later waves' job).
- Do NOT edit production source.
- Do NOT invent evidence. Mark unknowns as unknown.
- Do NOT touch other lanes' files.

## Exit criteria

- [ ] `tests/characterization/fixtures/2026-07-28-failures/` exists with ≥9 fixture manifests (one per failure class).
- [ ] Each manifest has all required fields.
- [ ] `tests/characterization/2026-07-28-failures.test.mjs` passes (validates manifest schema; reproduces where feasible).
- [ ] No production source modified.

## Return to integrator

1. Branch name. 2. `git diff --stat`. 3. Passing test summary. 4. The list of fixture ids with their `root_cause_class` and `fixing_waves` (this feeds the wave exit-gate mapping). 5. Any failure class you could NOT locate evidence for. 6. Confirmation.
