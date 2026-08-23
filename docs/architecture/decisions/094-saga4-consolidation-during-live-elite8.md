# ADR-094: Consolidate saga4 through an isolated staging worktree during live Elite-8

- **Status:** Accepted (CAS executed 2026-08-23: local `saga4` advanced
  `611c35e0` → `586871ad`; `origin/saga4` remains `611c35e0`)
- **Date:** 2026-08-23
- **Decision-maker:** operator consolidation directive 2026-08-23 (Codex orchestration)
- **Numbering note:** ADR-093 remains RESERVED for the still-open CC-GAP-7
  warrant decision (current chosen direction only: A-prime — package-owned
  warrant catalogs with kernel-owned minimum floors; no implementation
  claimed). This consolidation decision therefore takes number 094.
- **Builds on:** ADR-076 (closure registry protocol),
  `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §2A (branch truth),
  `GUARDRAILS.md`, ADR-092 (same-day precedent for narrow, fail-closed
  operational decisions with MCDA + journal)
- **Decision journal:**
  `docs/architecture/decision-journal/2026-08-23-saga4-consolidation-during-live-elite8.md`

## Context

Four lines of truth have diverged while the conformance-closure program ran
exclusively on integration branches:

| Line | Exact pin (2026-08-23) | Content |
|---|---|---|
| `saga4` | `611c35e0` (pre-CAS pin; see the post-CAS note below) | canonical integration branch of record — carried NONE of the CC-00B/CC-00C/CC-IC/CC-U/K19 work at decision time (plan §2A) |
| Accepted closure base | `905f5940` (`cc/CC-00B-terminal-integrity-integration`) | CC-GAP-2..6, 8, 9, 10, ADR-091 residual, CC-IC-1/2, CC-U1/ADR-092, K19 bounded slice, Space E maintenance |
| Plan snapshot | `58b8656a` | the 2026-08-23 plan-truth refresh line |
| Elite line snapshot | `91af2982` | the Elite-7/8 line carrying the 2026-08-23 red-team audit and the six-suite hosting commit `5d020f9f` |

Post-CAS update (2026-08-23, follow-up branch
`docs/post-cas-truth-2026-08-23`): the compare-and-swap EXECUTED.
Local `saga4` now resolves to `586871ad`, whose first-parent chain over
base `611c35e0` was re-verified as exactly the three recorded merges
(`87b97e11`, `37b75b01`, `ab397ff7`) plus the staging ADR-094 docs
commit. `origin/saga4` REMAINS `611c35e0` — no push occurred and none
is claimed. The staging branch `cc/saga4-consolidation-2026-08-23` and
its worktree are removed post-consolidation; the pre-cleanup ref state
is archived at
`D:\Development\saga-mcp-branch-archives\pre-saga4-consolidation-2026-08-23.bundle`
(120 refs, complete history), which exists and passes `git bundle
verify`. Heavy validation and the dist rebuild remain deliberately
deferred; this update claims no build, test, full-suite, or
remote-push evidence.

Constraints that shape the decision:

1. **A live Elite-8 factory run is in progress.** The repo guardrails
   forbid building in a checkout used by a live engine (the engine lazily
   imports `dist/`), forbid heavy validation during live runs, and the
   operator's quiet-machine directive is in force.
2. **The main checkout is dirty with user-owned work** (temporal-test and
   other unrelated files). It must be preserved untouched.
3. **Known plan-truth defects exist** (stale ADR-091 landing status,
   obsolete CC-GAP-7 "Option A warrant adapters" direction, red-team figure
   errors, stale rate-limit directive). Canonicalizing the stale wording to
   `saga4` would make `saga4` wrong at the moment it becomes the single
   truth — so docs are repaired BEFORE canonicalization.

## Considered options

### Option A — defer consolidation until Elite-8 completes

Wait for the live run to end, then consolidate in the main checkout with
normal build/test validation.

Pros: zero new moving parts during the live run; full validation possible
afterward.

Cons: no pinned input set is recorded, so provenance of the eventual
consolidation is whatever the refs happen to be that day; the plan-truth
defects stay uncorrected for the whole Elite-8 duration; the consolidation
scheduling becomes coupled to an unpredictable live-run end.

### Option B — consolidate inside the live/dirty main checkout

Perform the merges directly in the main checkout that also hosts live-run
and user-owned dirty state.

Pros: no additional worktree; one tree to reason about.

Cons: directly violates the standing guardrails (never build/merge in a
checkout used by a live engine; preserve pre-existing modified and
untracked files); merges would interleave with user-owned dirty state,
making both the consolidation and the user's work unrecoverable separately;
contamination and rollback risk are the worst of the three options.

### Option C — isolated staging worktree, pinned inputs, docs first, Git-only invariants, atomic CAS (selected)

Consolidate in a dedicated isolated worktree whose entire input set is the
four exact pins above; repair the known doc defects in that staging
worktree BEFORE any canonicalization; validate with Git-only invariants
(status/diff/log, `rg`, JSON parse of edited registries, content
inspection — no build, no tests, no factory, no network); finally advance
`saga4` with a single atomic compare-and-swap from the exact expected old
value `611c35e0`.

## Decision drivers and MCDA

Weights (sum 100): live isolation 30, provenance completeness 25,
reversibility 20, contamination risk 15 (5 = lowest risk), simplicity 10.
Scores 1 (poor) – 5 (excellent); weighted = score × weight; total /500.

| Option | Live isolation 30 | Provenance 25 | Reversibility 20 | Contamination 15 | Simplicity 10 | Total /500 |
|---|---:|---:|---:|---:|---:|---:|
| A. defer until live run ends | 5 | 2 | 5 | 5 | 4 | 415 |
| B. live/dirty main checkout | 1 | 3 | 2 | 1 | 3 | 190 |
| C. isolated staging worktree + CAS | 5 | 5 | 4 | 4 | 3 | **445** |

Notes:

- A scores high on isolation only by doing nothing: it pays provenance to
  near zero — without recorded pins the eventual merge chronology is
  post-hoc reconstruction, exactly what §2A branch truth exists to prevent.
- B is the only option that actively violates binding guardrails; it pays
  live isolation and contamination to the floor.
- C's reversibility 4 (not 5): a completed CAS is undone only by a new
  explicit ref decision (the pre-move `saga4` commit stays reachable); this
  is recorded operator-visible reversibility, not automatic.
- C's contamination 4 (not 5): the residual risk is operator error OUTSIDE
  the staging worktree during the CAS; mitigated by the single-ref,
  expected-old-value precondition and the no-push rule.

## Pre-mortem on Option C

Assumption: the consolidation completed and failed a month later.

1. **An unpinned head leaked into staging.** A merge was taken from
   "whatever is currently checked out" instead of an exact pin. Detection:
   the pin set is part of this decision; the CAS precondition re-verifies
   that staging history contains exactly the recorded merges of the four
   pins; an unpinned merge fails the exit checks below.
2. **Doc repairs were forgotten or done directly on `saga4`.** Detection:
   repairs are committed in staging FIRST (this package); the CAS carries
   them atomically with the merges; `saga4` never receives an intermediate
   state.
3. **The CAS moved `saga4` under a live consumer.** Detection/controls: no
   push during Elite-8; the CAS is a single local ref update whose expected
   old value is `611c35e0` (a mismatch aborts); the live Elite-8 run does
   not consume `saga4`; before/after SHAs are recorded in the decision
   journal.
4. **A live or dirty worktree was damaged.** Detection: worktree census
   before/after; the staging-only file scope; the explicit no-touch list
   (live processes, DBs, logs, other worktrees, refs besides the single
   CAS, external systems).
5. **The staging worktree became a place to "just run tests since it's
   isolated".** Detection: the Git-only invariant is definitional — any
   build/test/factory/network action in staging during the live Elite-8 is
   out of scope for this decision and must not occur; heavy validation is a
   separately authorized post-CAS step.

## Independent challenge

1. **"Defer is strictly safer" (Option A, 415 vs 445).** Deferral does not
   reduce the live risk to zero either — it merely delays the same
   decision while the provenance rots (no pins, drifting chronology) and
   `saga4` keeps serving stale plan truth that operators are actively
   reading during Elite-8.
2. **"The dirty main checkout is the real tree; consolidate where the work
   is" (Option B).** The dirty checkout is precisely what the guardrails
   forbid using: user-owned changes must be preserved, and a live engine
   lazily imports `dist/`. B is not a cheaper version of C; it is a
   different decision with the worst contamination score.
3. **"A CAS of `saga4` is irreversible."** No ref update destroys history:
   the pre-move commit `611c35e0` remains reachable; restoring it is one
   new explicit decision. C records this honestly as reversibility 4.
4. **"You are canonicalizing during a live run — timing contamination."**
   The CAS reads and writes one ref, against immutable inputs, with
   Git-level checks only. No runtime artifact, DB, log, or live process is
   read or written. The timing risk is operator error, which the
   expected-old-value precondition bounds.

## Decision

Choose **Option C**. Normative contract:

1. **Isolated staging worktree.** Branch
   `cc/saga4-consolidation-2026-08-23`, worktree
   `D:\Development\saga-mcp-SAGA4-CONSOLIDATION`, is the sole consolidation
   surface. No other worktree is written.
2. **Exact pinned inputs — no unpinned heads.** `saga4` @ `611c35e0`
   (canonical base and CAS expected-old value), accepted closure base
   `905f5940`, plan snapshot `58b8656a`, Elite line snapshot `91af2982`.
   Current staging merge commits (2026-08-23):
   - `87b97e11` — merge: accepted Conformance Closure integration through
     `905f5940`;
   - `37b75b01` — merge: plan-truth snapshot `58b8656a` pending canonical
     corrections;
   - `ab397ff7` — merge: Elite line snapshot through `91af2982`.
3. **Repair docs before canonicalization.** The known plan-truth defects
   (ADR-091 landing truth in plan and registry, the CC-GAP-7 direction
   rewrite to A-prime, the red-team audit figure corrections, the operator
   rate-limit directive) land as commits in staging BEFORE any `saga4` CAS,
   so the canonical branch never carries the stale wording.
4. **Git-only invariants during live Elite-8.** Validation is limited to
   `git status`/`git diff`/`git log`, `rg`, `JSON.parse` of edited JSON
   registries, and markdown/content inspection. No `dist`, no build, no
   tests, no factory runs, no network, no DB access, no push.
5. **Atomic compare-and-swap of `saga4`.** One ref update from the exact
   expected old value `611c35e0` to the staging result; a mismatched old
   value aborts without side effects; before/after SHAs are recorded in the
   decision journal; no merge, force-move, or update of any other ref.
6. **Preserve live and dirty worktrees.** Live Elite-8 processes, all other
   checkouts (dirty and clean), DBs, logs, and external systems are
   untouched; pre-existing modified and untracked files are preserved
   everywhere.

## Consequences

Positive:

- `saga4` receives corrected, complete canonical truth in one atomic,
  attributable step;
- provenance is complete and mechanical: four exact pins + three recorded
  merge commits + recorded before/after ref SHAs;
- zero interference with the live Elite-8 run and zero exposure of
  user-owned dirty state;
- the consolidation is reversible by recorded ref arithmetic, not by
  archaeology.

Negative:

- the corrected docs (including the staging-only operator rate-limit
  directive) existed only on the staging branch until the CAS executed
  (post-CAS: they are carried by local `saga4` at `586871ad`);
- no test or build evidence accompanies the consolidation during the live
  run — post-CAS heavy validation is a separately authorized step on a
  quiet machine, and this ADR explicitly does not claim it;
- one more branch/worktree to keep honest until the CAS (post-CAS: the
  staging branch and worktree are removed; their commits live on local
  `saga4`, and the pre-cleanup refs are archived in the verified
  bundle).

Neutral:

- ADR-093 stays reserved for the CC-GAP-7 warrant decision (A-prime
  direction; honestly open, unimplemented);
- the pre-CAS `saga4` pin `611c35e0` remains the rollback target for the
  CAS specifically, not for the doc repairs.

## Exit checks

Before the CAS may be executed (all must hold) — historical
preconditions; the CAS has executed (see the post-CAS update above).
Attestation of these preconditions at CAS time belongs to the CAS
execution record; the 2026-08-23 post-CAS follow-up re-verified only
the staging history shape (second item: first-parent
`611c35e0..586871ad` = exactly `87b97e11` + `37b75b01` + `ab397ff7` +
the staging ADR-094 docs commit) and did not re-attest the others:

- [ ] `git status` in staging shows only the intended, explicitly staged
      files; the working tree is otherwise clean.
- [ ] Staging history contains exactly the three recorded merges
      (`87b97e11`, `37b75b01`, `ab397ff7`) over base `611c35e0`; the
      merge inputs match the pins `905f5940`, `58b8656a`, `91af2982`.
- [ ] Doc repairs verify mechanically: `rg` finds no obsolete
      "Option A (warrant adapters)" direction; the edited registry parses
      via `JSON.parse`; the red-team corrections named in this package are
      present.
- [ ] Worktree census is unchanged for every non-staging worktree; no live
      process, DB, log, or external system was touched; no push occurred.
- [ ] `saga4` still resolves to `611c35e0` immediately before the CAS.

After the CAS (record-only, no further action authorized by this ADR):

- [x] Before/after `saga4` SHAs are recorded in the decision journal
      (expected before: `611c35e0`; observed after: `586871ad`; recorded
      in the journal's "Post-CAS execution record" by the 2026-08-23
      follow-up `docs/post-cas-truth-2026-08-23`).
- [ ] The post-CAS branch-vs-`saga4` truth is restated in the plan §2A and
      the CC-00B/CC-00C records by a separate, explicitly authorized
      follow-up — not silently by this ADR. (2026-08-23 progress: the
      plan header + §2A restatement landed with
      `docs/post-cas-truth-2026-08-23`; the CC-00B/CC-00C factory-run
      record restatements remain owed.)

## References

- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §2A (branch truth this
  consolidation canonicalizes)
- `docs/architecture/adr-closure-registry.json` — ADR-094 entry (same
  commit as this file, per the ADR-076 registry protocol)
- `docs/architecture/decision-journal/2026-08-23-saga4-consolidation-during-live-elite8.md`
- `GUARDRAILS.md` (quiet-machine, live-checkout, and preservation rules)
- ADR-092 (same-day precedent: narrow operational decision with MCDA,
  pre-mortem, independent challenge, and journal)
