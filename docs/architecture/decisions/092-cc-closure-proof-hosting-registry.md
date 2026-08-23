# ADR-092: CC closure proof-hosting registry — a separate narrow manifest with bidirectional matrix/CI closure

- **Status:** Accepted
- **Date:** 2026-08-23
- **Builds on:** ADR-076 (closure registry protocol), the CI-02 acceptance
  matrix (`tools/run-acceptance-matrix.mjs`), the K1-D proof-claim contract
  (`tests/factory-proof/proof-claims.mjs`, CC-10A bidirectional ratchet), the
  CC-GAP-8 proof-hosting repair (`9301e8ff` + coverage G2g)
- **Closes:** the CC-U1 checklist item "Register every new blocking proof file
  bidirectionally: it must appear in the actual blocking group and floor that
  CI invokes AND in the recorded proof-claims set — a file missing in either
  direction … is RED" for the CC critical proof surface
  (`docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7B CC-U1)
- **Implementation:** `tests/infrastructure/cc-proof-hosting-manifest.mjs`
  (the manifest — sole authority), `tools/cc-proof-hosting-registry.mjs`
  (validator + CLI), `tests/infrastructure/cc-proof-hosting.test.mjs`
  (blocking proof + mutation battery, matrix group `cc-proof-registry`),
  `--list-json` machine export in `tools/run-acceptance-matrix.mjs`

## Context

Two incidents define the problem class:

1. **CC-GAP-8 (repaired at `9301e8ff`).**
   `tests/modules/development/development-terminal-exit-accounting.test.mjs`
   was committed at `f2f48426` as a BLOCKING proof but was not a `GROUPS`
   entry in `tools/run-acceptance-matrix.mjs` — no CI step ever executed it.
   A committed proof that proved nothing in CI. The micro-fix hosted the
   exact file in the `process-modules` group and added the coverage self-check
   `G2g`, which pins that one file to a blocking run-set.

2. **CC-GAP-2 (two orphans still open).** The terminal-projection repair
   `cf14e364` committed three regression suites as "Regressions (blocking)".
   Only `tests/process-modules/run-terminal-journal-projection.test.mjs` is
   hosted (via the `tests/process-modules/*.test.mjs` glob).
   `tests/app/launch-terminal-settlement.test.mjs` and
   `tests/tracker-view/engine-status-launch-projection.test.mjs` match no
   group glob — no matrix group, no CI step, green in isolation, invisible in
   CI. The exact GAP-8 orphan class, still unfixed.

The G2g lesson is that per-file hardcoded checks do not scale and can lag:
the coverage test's `G4d` also hardcodes the required CI group list, so a
renamed or newly added group is only protected by memory, not by structure.
And the general tree makes blanket registration impossible honestly: about
230 committed `*.test.mjs` files are neither in a matrix run-set nor
quarantined — most are legacy/out-of-matrix surfaces. "Register all proofs"
would be a ratchet nobody could verify.

Meanwhile the K1-D proof-claim contract
(`tests/factory-proof/proof-claims.mjs`) already enforces an exact bijection
between its `PROOF_CLAIMS` registry and the `factory-proof` matrix GROUP —
but its subject is proof-MODE honesty (Contract/Durable/CanonicalFast/…),
not CI hosting, and it deliberately covers only the factory-proof kernel
surface.

The decision fork: where does the CC critical proof-hosting truth live, and
what proves it in both directions?

## Decision drivers

| Driver | Weight | Reason |
|---|---:|---|
| Bidirectional truth | 25 | A registry that can drift one way (registered but unhosted) or the other (hosted but unregistered) is prose, not a registry — both GAP-8 and GAP-2 incidents were one-directional lies |
| Fail-closed coverage of every drift class | 20 | Missing file, duplicate, group rename, run-set drop, quarantine reclassification, CI omission, stale pending — each must be a typed red, not a silent green |
| Preservation of frozen contracts | 15 | PROOF_CLAIMS + its exact bijection are a landed, reviewed CC-10A ratchet; byte-for-byte preservation beats schema surgery on a frozen surface |
| Narrowness (no scope explosion) | 15 | ~230 unhosted general tests exist; the registry must cover the identified CC critical proofs, not the tree |
| Machine-readable wiring truth | 10 | Group knowledge derived from a structured export, not hardcoded lists or regex over human prose |
| Agent readability | 10 | One manifest file a worker can read in one screen; typed rows instead of convention |
| Implementation scope | 5 | Bounded: one manifest, one validator, one test, one CI step |

Scores use 1 as poor and 5 as excellent.

## Considered options

### Option A: factory-proof wrapper — host every CC critical proof inside the `factory-proof` group and register it in `PROOF_CLAIMS`

Move/add the CC proofs as exact files in the `factory-proof` matrix GROUP so
the existing CC-10A bijection does all the work.

Pros:

- reuses a proven bidirectional ratchet end to end;
- no new vocabulary — modes and claims already exist.

Cons:

- drags development/tracker-view/app suites into a group whose isolation and
  green-in-group status was proven for the kernel surface only (the matrix
  runs each group as ONE `node --test` process; cross-suite contention is a
  recorded CI-02 failure mode) — hosting decisions become collateral of a
  registry decision;
- the K1-D contract governs proof-MODE honesty, not CI hosting: a GAP-2
  orphan would need a fabricated mode claim to live there, corrupting the
  honesty vocabulary it exists to protect;
- `PROOF_CLAIMS` is frozen by the task and by review continuity — widening
  the group widens the frozen bijection, the exact churn ADR-076 discipline
  exists to prevent.

### Option B: widen `PROOF_CLAIMS` with hosting fields

Keep the files where they are; extend the claim schema with
`{ hosting: { group, type, tracker, reason } }` rows and extend
`validateProofClaims` to check the matrix export and CI.

Pros:

- one registry file for everything;
- the validator seam already exists.

Cons:

- mutates the frozen K1-D surface: the registry's subject (proof modes)
  absorbs a second, orthogonal subject (CI hosting), so every future
  factory-proof claim edit reviews CC hosting rows too — coupling two
  release cadences into one file;
- still says nothing about proofs that are NOT factory-proof files (GAP-8
  lives in `tests/modules/development/`, GAP-2 in three directories) — the
  fields would sit mostly on rows that do not want them, and the orphans
  still need a place to be honestly pending;
- the byte-for-byte preservation requirement makes this a non-starter by
  construction.

### Option C: a separate narrow CC closure proof-hosting manifest with its own validator, matrix group, and CI step (selected)

`tests/infrastructure/cc-proof-hosting-manifest.mjs` is the SOLE authority
for the CC critical proof-hosting surface. Rows are typed `blocking` or
`pending`. `tools/cc-proof-hosting-registry.mjs` proves both directions
against the machine-readable matrix export and the real CI invocations; the
blocking proof `tests/infrastructure/cc-proof-hosting.test.mjs` runs it
against live repo facts plus an in-memory fail-closed mutation battery, in
its own exact-file matrix group `cc-proof-registry`, wired as its own CI
step.

Pros:

- the frozen K1-D contract is untouched (byte-for-byte); two authorities,
  two subjects, zero coupling;
- narrow by construction: scope is a closed row list — the ~230 general
  unhosted files are simply not in it, and the ADR forbids auto-discovery
  (no marker scanning, no source annotations);
- typed pending rows give the GAP-2 orphans an honest, tracked state instead
  of a lie of omission — "critical, unhosted, owned by tracker X" is a
  first-class fact;
- the machine-readable `--list-json` export kills the hardcoded-group-list
  class (G4d now derives its required set from the export, both directions);
- every drift class is a typed red with a mutation proving the detector.

Cons:

- one more registry to maintain (bounded: six rows today);
- the manifest cannot detect a critical proof that never enters it — the
  ADR states this boundary openly: scope changes are reviewed manifest edits,
  and new CC proofs join scope by that edit (the CC-U1 checklist item is the
  forcing function);
- one more CI step.

## MCDA matrix

| Option | Bidirectional 25 | Fail-closed 20 | Preservation 15 | Narrowness 15 | Machine wiring 10 | Readability 10 | Scope 5 | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. factory-proof wrapper | 4 | 3 | 1 | 1 | 3 | 3 | 3 | 280 |
| B. widen PROOF_CLAIMS | 4 | 4 | 1 | 2 | 3 | 3 | 3 | 315 |
| C. separate narrow manifest | 5 | 5 | 5 | 5 | 5 | 4 | 4 | **480** |

Option C leads the nearest alternative by more than ten percent. A and B pay
the preservation driver to zero (the frozen bijection cannot absorb them),
and both do worse on narrowness: A widens a proven blocking group; B widens
a frozen schema. Only C makes the GAP-2 orphan state honest (typed pending
with tracker) without touching any frozen surface.

## Pre-mortem on Option C

Assumption: Option C shipped and failed six months later.

1. **A critical CC proof was hosted in a group but never added to the
   manifest, and nothing caught it.** Likelihood: medium — the manifest
   cannot see files that never enter it. Detection: this boundary is
   declared, not hidden: the CC-U1 checklist item ("register every new
   blocking proof file bidirectionally") is the process gate, the registry
   group bijection catches widening of the registry's own surface, and
   review convention requires new CC blocking proofs to carry their manifest
   row in the same commit. Response: a missed proof is a review miss to
   repair by a manifest-edit commit — never by weakening the validator.
2. **Someone reclassified a blocking proof to pending to make a CI omission
   go away.** Likelihood: medium. Detection: `PENDING_ABSORBS_HOSTED` — a
   pending row whose file IS in any CI-invoked run-set is red; CI omission
   of the pinned group is independently red. Response: both directions stay
   mutation-proven (m6, m7).
3. **The matrix gained a group that CI never invoked (a new orphan factory
   for whole groups).** Likelihood: low. Detection: G4d derives the required
   CI set from the export — every matrix group must be invoked; the reverse
   direction (`CI_INVOKES_UNKNOWN_GROUP`) catches stale wiring after a
   rename. Response: both directions are blocking in `matrix-coverage`.
4. **The GAP-2 pending rows calcified — orphans forever, honestly labeled.**
   Likelihood: medium (that is the risk of an honest label). Detection: each
   pending row names its tracker (the CC-U1 checklist follow-up) and reason;
   converting a row to blocking requires the reviewed hosting change.
   Response: the label is designed to be visible in every registry run's
   summary (`blocking=…, pending=2`), so the debt is printed, not buried.
5. **Somebody "extended" the manifest with marker scanning or auto-discovery
   to feel safer.** Likelihood: low. Detection: this ADR's exclusions forbid
   it; the manifest stays a closed reviewed list. Response: auto-discovery
   over ~230 unhosted files would convert a registry into a census nobody
   verified — rejected.

Net effect: every drift the registry OWNS is a typed, mutation-proven red;
the one boundary it cannot own (proofs that never enter scope) is declared
and process-gated rather than pretended away.

## Red Team

1. **"A second registry beside PROOF_CLAIMS is duplication."** No — the
   subjects are orthogonal: K1-D governs proof-MODE honesty for the
   factory-proof kernel group; ADR-092 governs CI HOSTING for CC critical
   proofs that live in other groups. Merging them is Option B, which pays
   the frozen-contract driver to zero and still cannot host the GAP-2
   orphans honestly.
2. **"Pending rows are a loophole — anything inconvenient becomes pending."**
   A pending row is the LOUDEST state in the registry: it requires tracker
   and reason, is summarized in every run, goes stale-red the moment its
   file is actually hosted, and cannot carry a `group` pin. The loophole
   would be silence — the current state of the GAP-2 orphans.
3. **"Hardcode six rows today, sixty rows next quarter — scope creep."** The
   ADR pins the scope rule: only already-identified CC critical proofs, added
   by reviewed manifest edits; whole-tree coverage is an explicit exclusion.
   The registry-group bijection prevents the registry's own surface from
   widening silently.
4. **"The validator parses ci.yml — that is parsing human text."** It
   extracts machine tokens (`--group NAME` flags) from the wiring file
   itself — the thing being verified; comment text is stripped first. The
   GROUP REGISTRY knowledge comes from `--list-json`, never from the human
   `--list` prose.
5. **"Why a whole CI step for one test?"** The step IS the point: a registry
   proof that is itself orphaned (CI omission) fails closed via its own
   blocking group — `GROUP_NOT_INVOKED_BY_CI` names exactly that failure
   ("a committed proof that proves nothing in CI"), verified by a real
   RED/GREEN cycle in this landing.

All five objections are answered inside Option C; objections 2 and 5 shaped
the pending grammar and the dedicated CI step.

## Decision

Choose Option C. Normative contract:

1. **Sole authority.** `tests/infrastructure/cc-proof-hosting-manifest.mjs`
   is the only registry for the CC critical proof-hosting surface. No marker
   scanning, no source annotations, no auto-discovery. Scope changes are
   reviewed manifest edits in the same commit as the proof they register.
2. **Typed rows.** Every row is `blocking` (hosted: pinned to a named
   acceptance-matrix group) or `pending` (not hosted). Pending requires
   non-empty `tracker` + `reason` (a tracker naming a repo path must point
   at an existing file) and MUST NOT pin a group.
3. **Both directions, fail closed.** A blocking row's file must exist, be in
   the pinned group's expanded run-set, the group must exist and be invoked
   by CI, and the file must not be quarantined. The registry group
   (`cc-proof-registry`) run-set must equal the blocking rows pinned to it
   (no silent widening). CI invoking an unknown group is red. Missing file,
   duplicate row, group rename, run-set drop, quarantine reclassification,
   CI omission, stale pending, malformed manifest — each a typed violation.
4. **Machine-readable matrix truth.** The export
   `node tools/run-acceptance-matrix.mjs --list-json` is the only supported
   machine surface for group/run-set/quarantine facts; validators and tests
   must not parse the human `--list` text. CI-wiring checks extract
   `--group` tokens from comment-stripped ci.yml.
5. **Pending cannot absorb blocking.** A hosted proof typed pending is red
   (`PENDING_ABSORBS_HOSTED`); converting a blocking row to pending while it
   stays hosted cannot make any CI omission disappear.
6. **K1-D preservation.** `tests/factory-proof/proof-claims.mjs`,
   `proof-claims.test.mjs`, the `factory-proof` group, and coverage G2g are
   preserved byte-for-byte / behaviorally; CC manifest rows may not sit on
   the factory-proof surface.
7. **Hosting is its own reviewed change.** Converting the GAP-2 pending rows
   to blocking requires choosing a group, adding the exact files, proving
   green-in-group, and the manifest edit — never a registry-commit smuggle.

### Explicit exclusions

- No whole-tree coverage: ~230 unhosted general `*.test.mjs` files stay out
  of scope; blanket registration is unverifiable prose.
- No edit — byte-for-byte — to `tests/factory-proof/proof-claims.mjs` or
  `proof-claims.test.mjs`; no change to the QUARANTINE table; no change to
  the GAP-8 exact hosting entries or the G2g assertion.
- No marker scanning, filename-convention inference, or source annotation as
  a registry mechanism.
- No auto-promotion of pending rows: conversion is a reviewed manifest edit
  tied to the hosting change.
- No new proof-mode vocabulary; the manifest records hosting truth only.

### Exit tests (blocking mutations)

The battery in `tests/infrastructure/cc-proof-hosting.test.mjs` kills each
drift IN MEMORY (the validation core is pure over injected facts), plus two
real repo-level RED/GREEN cycles verified in this landing:

- (m1) file deleted from disk → `ROW_FILE_MISSING`;
- (m2) duplicate row → `ROW_FILE_DUPLICATE`;
- (m3) group rename → `GROUP_UNKNOWN` (+ `CI_INVOKES_UNKNOWN_GROUP` on the
  stale CI side);
- (m4) run-set drop → `PROOF_NOT_HOSTED`;
- (m5) quarantine reclassification → `PROOF_QUARANTINED` (+ not hosted);
- (m6) CI omission → `GROUP_NOT_INVOKED_BY_CI`;
- (m7) hosted proof typed pending → `PENDING_ABSORBS_HOSTED`;
- (m7b) a pending file later hosted goes stale-red;
- (m8) pending without tracker/reason (or with a dangling tracker path) →
  `PENDING_TRACKER_MISSING` / `PENDING_REASON_MISSING` /
  `PENDING_TRACKER_PATH_MISSING`;
- (m9) unregistered file joins the registry group → `REGISTRY_GROUP_WIDENED`;
- (m10) CI invokes an undefined group → `CI_INVOKES_UNKNOWN_GROUP`;
- (m11) registry-group row not hosted → `REGISTRY_GROUP_ROW_NOT_HOSTED`;
- (m12) emptied/malformed manifest → `MANIFEST_MALFORMED`;
- (m13) invalid row type / missing proof statement → typed red;
- real cycle 1: removing the GAP-8 exact entry from `process-modules` fails
  both the `cc-proof-registry` group and coverage G2g;
- real cycle 2: removing the CI step fails the validator with
  `GROUP_NOT_INVOKED_BY_CI` for the registry's own test file.

## Consequences

Positive:

- the GAP-8 orphan class is now structurally impossible for every registered
  proof: hosting, group identity, quarantine status, and CI invocation are
  each independently pinned and mutation-proven;
- the two GAP-2 orphans are finally VISIBLE — typed pending with tracker and
  reason, printed in every registry run, instead of green-in-isolation files
  CI has never executed;
- hardcoded CI group knowledge is gone: G4d derives both directions from the
  `--list-json` export, so renames, removals, and new groups fail closed
  automatically;
- the frozen K1-D proof-claim contract is untouched.

Negative:

- one more manifest, validator, group, and CI step to maintain;
- the registry cannot detect critical proofs that never enter it — a
  declared boundary guarded by the CC-U1 checklist process, not by magic;
- pending rows persist until a reviewed hosting change converts them.

Neutral:

- the manifest's human `proof`/`reason` prose is descriptive, not
  machine-checked beyond non-emptiness — the machine truth is the typed
  hosting closure;
- the `--list` human output is unchanged for interactive use.

## Decision Journal

Date: 2026-08-23. See
`docs/architecture/decision-journal/2026-08-23-cc-u1-proof-hosting-registry.md`
for the journal record (options A/B/C, MCDA 280/315/480, pre-mortem,
independent challenge; Option C selected).

## References

- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7B CC-U1 (the bidirectional
  proof-registration checklist item this closes for the CC surface)
- `tools/run-acceptance-matrix.mjs` — `--list-json` export, the
  `cc-proof-registry` group, and the preserved GAP-8 exact hosting
- `tests/infrastructure/cc-proof-hosting-manifest.mjs` — the manifest
- `tools/cc-proof-hosting-registry.mjs` — validator + CLI
- `tests/infrastructure/cc-proof-hosting.test.mjs` — blocking proof + battery
- `tests/infrastructure/acceptance-matrix-coverage.test.mjs` — G2g (GAP-8
  hosting pin) and the export-derived G4d
- `tests/factory-proof/proof-claims.mjs` — the frozen K1-D contract
  (untouched; the reason Option C exists)
- Commit `9301e8ff` (CC-GAP-8 proof hosting), commit `cf14e364` (CC-GAP-2
  terminal projection, whose two orphan suites are the typed pending rows)
