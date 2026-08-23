# saga4 consolidation during live Elite-8: isolated staging worktree with Git-only invariants and an atomic CAS (ADR-094, Option C)

- **Status:** Accepted (operator-selected before this record; recorded here
  with options, MCDA, pre-mortem, and independent challenge; the CAS has
  executed — see the Post-CAS execution record below)
- **Date:** 2026-08-23
- **Context:** `saga4` @ `611c35e0` carries none of the accepted
  conformance-closure integration truth (`905f5940`), the 2026-08-23
  plan-truth refresh (`58b8656a`), or the Elite-line snapshot (`91af2982`);
  a live Elite-8 factory run and a dirty main checkout forbid normal
  build/test validation; known plan-truth defects must not be canonicalized
  as-is
- **Decision id:** DJ-2026-08-23-SAGA4-CONSOLIDATION
- **Recorded by:** ADR-094
  (`docs/architecture/decisions/094-saga4-consolidation-during-live-elite8.md`)
- **Numbering:** ADR-093 stays reserved for the open CC-GAP-7 warrant
  decision (chosen direction only: A-prime — package-owned warrant catalogs
  with kernel-owned minimum floors; no implementation claimed)

## Context and problem statement

The conformance-closure program landed all of its accepted work on
integration branches (plan §2A records the branch-vs-`saga4` truth). Four
lines diverged: `saga4` @ `611c35e0` (canonical, stale), the accepted
closure base `905f5940`, the plan-truth snapshot `58b8656a`, and the Elite
line snapshot `91af2982`. At the same time:

- a live Elite-8 run is in progress (guardrails: no builds in a live
  checkout — the engine lazily imports `dist/`; quiet-machine gates);
- the main checkout is dirty with user-owned work that must be preserved;
- known plan-truth defects (ADR-091 landing status, the obsolete CC-GAP-7
  "Option A warrant adapters" direction, red-team audit figures, the
  operator rate-limit directive) must be repaired BEFORE canonicalization,
  or `saga4` becomes wrong at the moment it becomes the single truth.

The question: through which surface, with which inputs, and with which
invariants does `saga4` receive the consolidated truth — while Elite-8 is
live?

## Options considered

### Option A — defer consolidation until Elite-8 completes

Wait out the live run; consolidate afterwards in the main checkout with
normal validation and no pre-recorded pin set.

### Option B — consolidate inside the live/dirty main checkout

Merge everything directly where the dirty state and the live-run surface
live; fastest path to a merged tree.

### Option C — isolated staging worktree, pinned inputs, docs repaired first, Git-only invariants, atomic CAS (selected)

A dedicated isolated worktree (`cc/saga4-consolidation-2026-08-23`)
whose entire input set is four exact pins (`611c35e0`, `905f5940`,
`58b8656a`, `91af2982`); doc repairs land in staging first; validation is
Git-only; `saga4` advances by one atomic compare-and-swap from the exact
expected old value `611c35e0`; live and dirty worktrees preserved; no
dist/build/test/factory/network action during the live run.

## MCDA matrix

Weights (sum 100): live isolation 30, provenance completeness 25,
reversibility 20, contamination risk 15, simplicity 10. Scores 1–5
(poor–excellent); weighted = score × weight; total /500.

| Option | Live isolation 30 | Provenance 25 | Reversibility 20 | Contamination 15 | Simplicity 10 | Total /500 |
|---|---:|---:|---:|---:|---:|---:|
| A. defer | 5 | 2 | 5 | 5 | 4 | 415 |
| B. live/dirty checkout | 1 | 3 | 2 | 1 | 3 | 190 |
| C. isolated staging + CAS | 5 | 5 | 4 | 4 | 3 | **445** |

Notes:

- A's "safety" is inaction: without recorded pins the eventual merge
  chronology is post-hoc reconstruction, and the stale `saga4` truth keeps
  misleading readers for the whole live run.
- B pays live isolation and contamination to the floor by construction —
  it is the only option that violates binding guardrails (live-engine
  checkout; preservation of user-owned dirty files).
- C's 4s are honest, not rounding: CAS reversal needs a new explicit ref
  decision (reversibility), and the residual contamination risk is operator
  error outside staging during the CAS (bounded by the expected-old-value
  precondition and the no-push rule).

## Pre-mortem (Option C)

1. **An unpinned head leaked into staging.** Detected by the exit checks:
   staging history must contain exactly the three recorded merges
   (`87b97e11` closure integration through `905f5940`, `37b75b01`
   plan-truth snapshot `58b8656a`, `ab397ff7` Elite line through
   `91af2982`) over base `611c35e0`.
2. **Doc repairs forgotten or done directly on `saga4`.** Repairs are
   staging commits BEFORE the CAS; `saga4` never sees an intermediate
   state.
3. **CAS moved `saga4` under a live consumer.** No push during Elite-8;
   single local ref update; expected old value `611c35e0` (mismatch
   aborts); live Elite-8 does not consume `saga4`; before/after SHAs
   recorded here.
4. **A live or dirty worktree damaged.** Worktree census before/after;
   staging-only file scope; explicit no-touch list.
5. **Staging used for tests "since it's isolated anyway".** The Git-only
   invariant is definitional; heavy validation is a separately authorized
   post-CAS step on a quiet machine.

## Independent challenge (summary of the counter-review)

- **"Defer is strictly safer."** Deferral keeps provenance incomplete and
  leaves stale canonical truth in active service; it scores 415 vs 445 and
  loses on the second-heaviest driver.
- **"Consolidate where the work is — the dirty main checkout."** The dirty
  checkout is exactly the surface the guardrails fence off; B is not a
  cheaper C, it is the only guardrail-violating option.
- **"A CAS is irreversible."** The pre-move commit stays reachable;
  restoration is one new explicit decision. Reversibility 4, recorded.
- **"Canonicalizing during a live run is timing contamination."** One ref
  write against immutable inputs with Git-level checks touches no runtime
  artifact, DB, log, or live process.

## Decision

Choose **Option C** and execute exactly as ADR-094 records: isolated
staging worktree; exact pinned inputs `611c35e0` / `905f5940` / `58b8656a`
/ `91af2982`; doc repairs before canonicalization; Git-only invariants
during live Elite-8 (no dist/build/test/factory/network, no push); atomic
CAS of `saga4` from expected-old `611c35e0` with before/after SHAs recorded
here; live and dirty worktrees preserved. Current staging merge commits:
`87b97e11`, `37b75b01`, `ab397ff7`.

## Check trigger

Any proposal to (a) merge an unpinned head into staging, (b) run build,
tests, factory, or network actions in staging while Elite-8 is live,
(c) touch `saga4` by anything other than the single expected-old-value CAS,
(d) push during the live run, or (e) touch any non-staging worktree or live
process as part of the consolidation — re-run this record's independent
challenge.

## What would change this decision

An operator directive ending the quiet-machine/live-run constraints before
the CAS (then normal isolated-worktree validation becomes available and
this record's Git-only invariant is superseded), or evidence that the live
Elite-8 run consumes `saga4` directly (then the CAS window must be
re-examined).

## Post-CAS execution record (2026-08-23)

Recorded by the separately authorized post-CAS truth-repair follow-up
(branch `docs/post-cas-truth-2026-08-23`, worktree
`D:\Development\saga-mcp-POSTCAS`), fulfilling the ADR-094 record-only
exit check. Facts observed/re-verified on 2026-08-23 with Git-only
checks:

- before (this decision's CAS expected-old value, corroborated by the
  first-parent merge base and by `refs/remotes/origin/saga4`, which
  still resolves to it): `refs/heads/saga4` = `611c35e0`;
- after (observed): `refs/heads/saga4` =
  `586871adfeae77da0ca8af96232ef96d6b0ee7e4`;
- `origin/saga4` remains `611c35e071de9dacfd06c3e73a6ea0301f11f16e` —
  no push occurred and none is claimed;
- staging history shape re-verified post-hoc: the first-parent chain
  `611c35e0..586871ad` is exactly `87b97e11` (closure integration
  through `905f5940`) + `37b75b01` (plan snapshot `58b8656a`) +
  `ab397ff7` (Elite line through `91af2982`) + the staging ADR-094
  docs commit `586871ad` — no other first-parent commits;
- the staging branch ref `refs/heads/cc/saga4-consolidation-2026-08-23`
  no longer exists and the staging worktree is removed
  (`git worktree list` census, 2026-08-23);
- the exact archive
  `D:\Development\saga-mcp-branch-archives\pre-saga4-consolidation-2026-08-23.bundle`
  exists (34,769,506 bytes) and was verified with `git bundle verify`:
  "is okay", complete history, 120 refs.

Deliberately NOT claimed by the CAS or by this record: any remote push,
any build, dist rebuild, test, full-suite, or factory evidence —
post-CAS heavy validation remains a separately authorized quiet-machine
step. Pre-CAS precondition attestation belongs to the CAS execution;
this record attests only the post-state observations listed above.

## References

- `docs/architecture/decisions/094-saga4-consolidation-during-live-elite8.md`
- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §2A
- `docs/architecture/adr-closure-registry.json` (ADR-094 entry)
- `GUARDRAILS.md`
- Staging merges: `87b97e11` (closure integration `905f5940`),
  `37b75b01` (plan snapshot `58b8656a`), `ab397ff7` (Elite line `91af2982`)
