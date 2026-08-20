# Branch cleanup record — 2026-08-20

Goal: `saga4` is the only living development line. Every deletion below was
preceded by (1) an `archive/<branch>` tag pushed to origin (Rule 0 — every
commit stays reachable forever), and (2) an individual merge proof
(`git log --oneline origin/saga4..<branch>` EMPTY — every commit reachable
from `origin/saga4` — plus an empty three-dot diff). `git branch -d` (never
`-D`) succeeded on every deleted branch; its own unmerged-refusal safety net
never fired.

## Deleted — 20 branches, all proven fully merged

Step-1 evidence, identical shape for each (measured before any deletion):
`git log --oneline origin/saga4..<branch>` → **empty**; `git diff --stat
origin/saga4...<branch>` → **empty**. Tip shas as deleted:

| Branch | Tip | Archive tag |
|---|---|---|
| repair/ac-drift-remedy | be0690e1 | archive/repair/ac-drift-remedy |
| repair/b004-cluster | 4c33c17f | archive/repair/b004-cluster |
| repair/blindsight-gate-delivery | 8511c967 | archive/repair/blindsight-gate-delivery |
| repair/blindsight-integration-verify | d3b81c7f | archive/repair/blindsight-integration-verify |
| repair/blindsight-lifecycle | 8250d9f5 | archive/repair/blindsight-lifecycle |
| repair/blindsight-persistence | 5c290c9e | archive/repair/blindsight-persistence |
| repair/blindsight-phantom-bridges | 743b5886 | archive/repair/blindsight-phantom-bridges |
| repair/blindsight-reconciliation | e38ba18e | archive/repair/blindsight-reconciliation |
| repair/blindsight-worker-prompt | af557542 | archive/repair/blindsight-worker-prompt |
| repair/c145-route-freeze | eb8bf622 | archive/repair/c145-route-freeze |
| repair/ep1-engine-spawn | 0a3e3ad3 | archive/repair/ep1-engine-spawn |
| repair/es1-loop-detector | 9e38679d | archive/repair/es1-loop-detector |
| repair/finding-trajectory | 86dc0fcc | archive/repair/finding-trajectory |
| repair/graceful-drain-pause | 5b93be9f | archive/repair/graceful-drain-pause |
| repair/provider-retry | f41702be | archive/repair/provider-retry |
| repair/replan-cycle | e9ea5aa7 | archive/repair/replan-cycle |
| repair/rs-replay-robustness | 814e9ee3 | archive/repair/rs-replay-robustness |
| repair/worker-disorientation | 7cc09ff8 | archive/repair/worker-disorientation |
| repair/worker-names | 40a79ac0 | archive/repair/worker-names |
| repair/x65-integration | fd6a6236 | archive/repair/x65-integration |

All 20 archive tags pushed to origin (`git ls-remote --tags origin
"refs/tags/archive/*"` = 20). Ten of these also had remote counterparts;
the remotes were deleted FIRST (`git push origin --delete …`), then the
locals with `-d`.

## Worktrees — 21 released, hazard-checked first

Every worktree was checked for junctions/symlinks (`dir /AL /S` from inside
each): **zero junctions found in all 21** — the 2026-08-19 `node_modules/.bin`
hazard did not exist in any of them. Five worktrees carried one untracked
file each (`tests/dispatcher-race/factory-run-journal.jsonl`, a generated
test-run journal, not work); the file was removed individually, then
`git worktree remove` ran for every worktree — never a raw `rm -rf` on a
live worktree. `git worktree list` now shows only the main checkout.

Filesystem note: 11 directory remnants were left behind by Windows
"Invalid argument" errors inside `git worktree remove` (git's own recursive
delete; the worktree registrations were already consumed and no `.git`
remained). The remnants — plain ex-checkout directories with junctions
already excluded — were then deleted; ten fully. `D:/Development/saga-mcp-traj`
is a completely EMPTY directory still held busy by a live process handle
(0 files); `rmdir` it after that process exits. No other `saga-*` stray
directories belong to this cleanup (gdesign-run / wt-migration / audit-* are
not worktrees and untouched).

### INCIDENT — the junction hazard fired despite the check (recovered same hour)

The pre-removal junction scan (`cmd //c "dir /AL /S <path>"` per worktree)
returned zero junctions for all 21 worktrees — **false negatives**: under
Git Bash, MSYS path mangling can make `cmd dir` misparse the forward-slash
path and print nothing, which the `grep -c` counted as zero. At least one
removed worktree's `node_modules/.bin` was in fact a junction into the main
checkout (the same shape as the 2026-08-19 incident), and the worktree
removal stripped the MAIN tree's `node_modules/.bin` — first symptom:
`tsc` not found, arch/pm suites collapsed to 199/49 and 4/120 against a
half-built `dist`.

Blast radius verified immediately: `git status` clean (every tracked file
intact); all irreplaceable untracked directories intact and untouched —
`.factory-sandboxes/stage12-db` (the LIVE stage-12 run DB with its WAL),
`stage12-logs`, `factory-snapshots`, `.factory-testbed`. The damage was
confined to `node_modules/.bin`, a deterministic build artifact.

Recovery: `npm install` (restores `.bin` from the lockfile), rebuild, full
baseline re-run — counts identical to the stage-13 report (below). No
source, evidence, or run state was lost.

Lesson recorded for the next operator: the junction check must run from a
native shell against a backslash path (`cmd /c "dir /AL /S D:\\path"`) and
must FAIL CLOSED when `dir` prints nothing; a zero line-count is not proof
of zero junctions.

## The three unmerged branches — verdicts

### repair/blindsight-reconciliation — MERGED (wave-B discipline), then deleted

The branch the stage-12 report presented as landed but never was. It WAS
merged in stage-13 TASK 5, commit `3fbe3dbd`, under wave-B discipline:
three conflicts resolved as documented feature unions; `npm run build`
clean; branch's own suites 33/33; full baseline on the merged tree
(arch 408/408, pm 1219/1219, infra 401/0/12, golden-path 1/1, w9 18/18)
pasted in the merge commit and the stage-13 report. The reconciliation-desk
concern (previous-attempt patch delivery + orphan-seam ledger) is live in
`saga4`. Step-1 re-proof at cleanup time: ahead=0, empty diff. Tagged, then
deleted.

### repair/snapshot-test-mvp — KEPT (held; the three questions answered)

Not deleted — a zero-token deterministic re-run is the highest-leverage
asset this project can own. The three stage-12 questions are answered with
evidence in `docs/factory-run/stage12/SNAPSHOT-MVP-ANSWERS.md`:

1. **Corpus:** captured-but-truncated — real stage-11 accepted material
   through `plan-task-graph` (41 products, all hashes cross-check), plus a
   synthesized deterministic tail, honestly documented in the scenario file.
2. **Boundary:** more than the worker seam — real orchestrate-cli, real MCP
   gateway, production gates/settlement/lifecycle routing inside the
   boundary, GateDecisions asserted directly (including a captured 3-round
   repair loop). NOT asserted: EffectReceipt rows; the
   verifier-independence check is substituted test-only.
3. **Would it have caught the gaming and the AC drift?** No to both — and
   that is the finding: the tape itself benignly games the readiness gate
   (the provider's command authority IS the candidate's declaration), and
   the AC drift is frozen into the corpus as ground truth. The independent
   authorities live elsewhere now (stage-12 TASK 2 anti-gaming and the
   order-derived constraint register).

**Recommendation:** merge — as a deterministic replay harness, not as an
oracle; do not block it on duties it was never mandated to carry. The merge
is a separate change with its own verification (this cleanup must not move
a single test count, so it was NOT merged here). Branch and its remote
stay; its worktree was released (the branch itself is untouched).

### wip/documentation-workshop — KEPT (unique work; escalated)

One unique commit (`a05bc223`, +3445/−8 over 33 files) not present in
`saga4`: a COMPLETE documentation workshop — process module, kernel ports,
schemas, installation, check providers, a pdfkit document-render provider,
a `product-documentation-lifecycle`, writer/reviewer checklists and skills,
three design docs, and tests. Provenance: preserved by the stage-12 night
agent as "parallel-session documentation workshop found uncommitted at
night-shift start" (operator's parallel session, 2026-08-20 00:27).
Nothing of it exists in `saga4`; nothing solves its problem there.
Per the escalation rule this is **kept, not deleted, and escalated to the
operator**: the branch is the preserved work itself; merging or extracting
it is the operator's call.

## Alive, and why

| Branch | Why alive |
|---|---|
| `saga4` | the only living development line |
| `master` | fully contained in `saga4` (step-1: ahead=0) but it is `origin/HEAD` — the repo's default branch. Retiring it is a repo-configuration decision (re-point the default, then delete), not a cleanup action. Escalated. |
| `repair/snapshot-test-mvp` | verdict above (held asset; answers + merge recommendation delivered) |
| `wip/documentation-workshop` | verdict above (unique operator work; escalated) |

## Baseline after cleanup

A branch cleanup must not move a single test count. Measured after all
deletions AND after the incident recovery (built first): architecture
408/408, process-modules 1220/1220, lifecycle 136/136, infrastructure
401 pass / 0 fail / 12 skip, golden-path 1/1 + w9 e2e 20/20 — identical to
the stage-13 report's counts. The transient red during the incident (tsc
missing → suites ran against a half-built dist) was an environment
artifact, not a code change: no commit on `saga4` changed between the
green stage-13 baseline and this one.
