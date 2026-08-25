# EK-0 Baseline — immutable baseline record

**Frozen base SHA:** `21ba0816` (branch `integration/event-kernel-ek`;
saga4 == origin/saga4 at freeze; worktree clean; `npm ci` clean install).
**Machine:** Windows, node v24.13.1. **Log:** `/d/Development/ek0-baseline.log`
(+ rerun `/d/Development/ek0-baseline-npmtest-rerun.log`).
**Caveat recorded honestly:** the per-command `EXIT=` values in the loop log
captured the pipe's tail exit, not the command's; the pass/fail summary lines
and the rerun's explicit exit code below are the authoritative signals.

## Command results (duration; verdict from captured summary)

| Command | Duration | Verdict |
|---|---|---|
| `npm ci` | 9s | clean install OK |
| `npm run build` | 11s | tsc clean |
| `npm run adr-closure:validate` | 1s | 72 files / 72 entries, unassessed=0 |
| `npm run test:architecture` | 34s | green (runner verdict line) |
| `npm run test:factory-model` | 9s | 3/3 pass, 0 fail |
| `npm run test:factory-temporal` | 1612s | green |
| `npm run test:factory-contract` | 216s | green |
| `npm run test:process-modules` | 76s | 664/664 pass, 0 fail |
| `npm run test:acceptance-matrix` | 1173s | `[acceptance-matrix] all groups green` (14/14) |
| `npm test` | 865s (1st) / rerun below | TOTAL 4649 tests / 4613 pass / **3 fail** / 33 skip → classified below |

## The 3 baseline fails — classification

The first `npm test` pass (peak concurrent load: the live elite factory
engine + its opencode workers + three EK-1 spec agents + tracker-view)
reported 3 fails whose names were cut by the log tail. A FULL-LOG rerun
immediately after (still under the same live load):

`TOTAL tests=4649 pass=4616 fail=0 skipped=33 — RERUN_EXIT=0`

Zero reproduction under identical surroundings → the known
spawn-interference class documented in the predecessor's Phase-6 validation
(the blanket runner's child-spawn flakiness; every historical instance
re-ran green isolated). No fix, no quarantine, no skip — recorded as
load-timing interference with the rerun as proof.

## Prompt-incident and env facts (EK-0 mandate)

- Elite-3 planner request **436,283 bytes** → opencode/Z.AI pre-tool
  rejection, 8 shim retries (`docs/factory-run/stage20-elite/RUN-TRACKER.md:214`).
- Largest preserved Elite-8 request: measured during EK-1/WP-18 fixture
  work (preserved evidence lives in the Elite worktree; not opened at EK-0).
- `SAGA_PROMPT_MAX_BYTES`: `Number(env ?? 0)` — **unset/0 = UNLIMITED today**
  (`tracker-view/claude-runner.mjs:581`); successor law forbids unlimited.
- Role-resolution sites (12) and prompt/context assembly sites (10):
  enumerated in the WP-01 census (`ek1/wp01-census` @ `eaa07093`).

## EK-0 exit status

Predecessor complete (receipt `bacf4f82`); base reproducible (rerun green);
branch clean; no `src/workflow-kernel/**` exists; no WP-05/WP-17/WP-18
production work started (EK-1 analysis/spec artifacts live on separate
branches by design). EK-0 exit criteria MET.
