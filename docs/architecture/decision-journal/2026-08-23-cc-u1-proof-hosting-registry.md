# CC-U1 proof registration: a separate narrow proof-hosting manifest (ADR-092, Option C)

- **Status:** Accepted (dictatorial after options generation, MCDA, pre-mortem,
  and independent challenge)
- **Date:** 2026-08-23
- **Context:** CC-U1 universal invariant packet — "Register every new blocking
  proof file bidirectionally" (`docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7B);
  CC-GAP-8 orphan-proof incident (`9301e8ff` repair); two still-orphaned
  CC-GAP-2 terminal-projection suites (`cf14e364`)
- **Decision id:** DJ-2026-08-23-CC-U1-PROOF-REGISTRY
- **Recorded by:** ADR-092
  (`docs/architecture/decisions/092-cc-closure-proof-hosting-registry.md`)

## Context and problem statement

The CC-GAP-8 incident proved the failure class: a committed BLOCKING proof
(`development-terminal-exit-accounting.test.mjs`) that no acceptance-matrix
group ran, so CI never executed it — a green-looking file proving nothing.
The repair (`9301e8ff`) hosted the exact file and hardcoded one more
coverage assertion (G2g). But the same audit of the current HEAD
(`906edf84`) shows the class is still open: two CC-GAP-2 terminal-projection
suites committed as "Regressions (blocking)" (`tests/app/
launch-terminal-settlement.test.mjs`, `tests/tracker-view/
engine-status-launch-projection.test.mjs`) match no matrix group and are run
by no CI step. Meanwhile ~230 committed `*.test.mjs` files are hosted
nowhere — blanket registration would be an unverifiable census. The CC-U1
checklist demands bidirectional proof registration; the question is WHERE
that registry lives and WHAT proves it.

Binding constraint from the owning task: `tests/factory-proof/
proof-claims.mjs` (PROOF_CLAIMS) and its exact blocking-group bijection are
preserved byte-for-byte.

## Options considered

### Option A — factory-proof wrapper

Host every CC critical proof as an exact file in the `factory-proof` matrix
group and register it in `PROOF_CLAIMS`, reusing the CC-10A bidirectional
ratchet end to end.

### Option B — widen PROOF_CLAIMS with hosting fields

Keep the proofs where they are; extend the claim schema with
`hosting { group, type, tracker, reason }` and extend `validateProofClaims`
to check the matrix export and CI wiring.

### Option C — separate narrow CC closure proof-hosting manifest (selected)

`tests/infrastructure/cc-proof-hosting-manifest.mjs` as the sole authority
(typed blocking/pending rows, closed scope), `tools/
cc-proof-hosting-registry.mjs` proving both directions against the
`--list-json` machine export and real CI invocations, a blocking proof with
a fail-closed mutation battery in its own exact-file group
(`cc-proof-registry`) and its own CI step.

## MCDA matrix

Weights (sum 100): bidirectional truth 25, fail-closed coverage 20,
preservation of frozen contracts 15, narrowness 15, machine-readable wiring
10, readability 10, implementation scope 5. Scores 1–5 (poor–excellent);
weighted = score × weight.

| Option | Bidirectional 25 | Fail-closed 20 | Preservation 15 | Narrowness 15 | Wiring 10 | Readability 10 | Scope 5 | Total /500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. factory-proof wrapper | 4 | 3 | 1 | 1 | 3 | 3 | 3 | 280 |
| B. widen PROOF_CLAIMS | 4 | 4 | 1 | 2 | 3 | 3 | 3 | 315 |
| C. separate narrow manifest | 5 | 5 | 5 | 5 | 5 | 4 | 4 | **480** |

Notes:

- A and B pay Preservation to zero: the K1-D bijection is a landed frozen
  ratchet and the binding constraint forbids touching it; B additionally
  couples two orthogonal subjects (proof modes vs CI hosting) into one file.
- A's hosting decisions would be made by a registry decision: pulling
  app/tracker-view suites into a proven kernel group without green-in-group
  verification repeats the CI-02 cross-suite-contention mistake.
- C is the only option where the GAP-2 orphans have an HONEST state (typed
  pending + tracker) instead of a lie of omission, and where scope stays a
  closed reviewed list rather than a tree census.

## Pre-mortem (Option C)

Assumption: shipped and failed six months later.

1. **A critical proof hosted but never registered.** Medium likelihood;
   detection is declared, not magic — the manifest cannot see files that
   never enter it; the CC-U1 checklist process gate requires the manifest
   row in the same commit; the registry-group bijection catches widening of
   the registry's own surface. Repair is a manifest-edit commit.
2. **Reclassify blocking → pending to dodge a CI omission.** `PENDING_ABSORBS_HOSTED`
   is red while the file stays hosted; CI omission is independently red.
   Both mutation-proven (m6/m7).
3. **A new matrix group CI never invokes.** G4d derives the required CI set
   from the export (both directions) — group-level orphaning is red.
4. **Pending rows calcify.** The debt is printed in every registry run
   (`pending=2`); conversion requires the reviewed hosting change. Visible
   beats buried.
5. **"Safety" marker scanning creeps in.** Forbidden by ADR-092 exclusions;
   auto-discovery over ~230 unhosted files converts a registry into an
   unverified census.

## Independent challenge (summary of the counter-review)

- **"Two registries is duplication."** Subjects are orthogonal (proof-MODE
  honesty vs CI hosting); merging them is Option B, which scores 315 and
  violates the binding byte-for-byte constraint.
- **"Pending is a loophole."** Pending is the loudest state: tracker +
  reason required, summarized every run, stale-red on hosting, group pin
  forbidden. The loophole was silence.
- **"The validator reads ci.yml text."** It extracts `--group NAME` tokens
  from the wiring file being verified (comments stripped); the GROUP
  registry truth comes only from `--list-json`. The replaced hardcoded
  group list was the real human-text dependency.
- **"One test file gets a whole CI step?"** The step is the anti-orphan
  proof: remove it and the validator itself reports
  `GROUP_NOT_INVOKED_BY_CI` ("a committed proof that proves nothing in CI")
  — verified by a real RED/GREEN cycle in this landing.

## Decision

Choose **Option C** — implemented same-commit as ADR-092: manifest (4
blocking + 2 typed pending rows), validator (pure core + CLI), blocking test
(21 assertions incl. the full in-memory mutation battery m1–m13), matrix
`--list-json` export, `cc-proof-registry` exact-file group, CI step, and the
coverage self-check migrated off the hardcoded group list onto the export.

## Repair addendum (2026-08-23, same-day CC-U1 defense-in-depth review)

Three independently found gaps in the landing, repaired without scope
change (the two GAP-2 pending rows, GAP-8 exact hosting, G2g, and the
frozen PROOF_CLAIMS bijection are untouched):

1. **The pure validator failed OPEN on a mutated `registryGroup`** — an
   unknown group silently skipped the bijection block and validated
   `ok=true`. Now typed fail-closed: `REGISTRY_GROUP_UNKNOWN`,
   `REGISTRY_GROUP_NOT_INVOKED_BY_CI`, `REGISTRY_GROUP_UNANCHORED`
   (battery m14–m16).
2. **Coordinated removal of the `cc-proof-registry` group + its CI step
   left every check green** — the registry's own test was orphaned with
   the group, and G4d's bijection sides shrank consistently. The
   independently hosted matrix-coverage suite now cross-guards the
   manifest-declared `registryGroup` (coverage G5, derived from the
   manifest, exact membership in the real CI invocation set), verified by
   a real RED/GREEN cycle (cycle 3).
3. **Coverage G4d used prefix-colliding substring probes**
   (`ci.includes('--group X')` is satisfied by `--group X-shadow`) — now
   exact membership in the comment-stripped extracted invocation set, both
   directions (battery m18).

Reviewed limitation recorded honestly: G5 cross-guards the registry
bootstrap only; a coordinated removal of the matrix-coverage group and its
own CI step would still pass (a guard cannot host itself). No further
layer was added; the residual is stated in ADR-092 instead of hidden.

## Check trigger

Any proposal to (a) widen the manifest to non-CC proofs, (b) reintroduce a
hardcoded CI group list, (c) parse the human `--list` text in a validator,
(d) convert the GAP-2 pending rows to blocking without the reviewed hosting
change, or (e) edit `proof-claims.mjs` — re-run this record's Red Team.

## What would change this decision

Evidence that the CC critical proof surface cannot stay a closed reviewed
list (sustained growth past review capacity), or an operator directive to
merge proof-mode and hosting registries — then Option B is re-scored with
the frozen-contract constraint lifted by its owner.

## References

- `docs/architecture/decisions/092-cc-closure-proof-hosting-registry.md`
- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7B CC-U1
- `tests/infrastructure/cc-proof-hosting-manifest.mjs`
- `tools/cc-proof-hosting-registry.mjs`
- `tests/infrastructure/cc-proof-hosting.test.mjs`
- `tools/run-acceptance-matrix.mjs` (`--list-json`, `cc-proof-registry` group)
- Commit `9301e8ff` (CC-GAP-8 hosting repair), commit `cf14e364` (CC-GAP-2)
