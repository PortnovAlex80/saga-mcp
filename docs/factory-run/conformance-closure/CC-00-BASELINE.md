# CC-00 — Immutable Baseline and Gate Ledger (2026-08-22)

Package: `CC-00` of `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` (first package on the
critical path). Owner: integration owner. Machine-readable ledger:
`CC-00-baseline-ledger.json` (same directory).

## Base and isolation

- **Base SHA: `6ddcb107`** — `origin/saga4` == local `saga4` at CC-00 start.
  One commit above the historical draft base `53cf7c81` (operator temporal-test
  commit `6ddcb107`, already pushed).
- Worktree: `D:/Development/saga-mcp-CC-00`, branch `cc/CC-00-immutable-baseline`,
  created from the base SHA, clean tree before edits.
- **Live engines at CC-00 start:** Elite-6 LIVE (engine pid 30076, tracker pid
  22632, opencode worker active; launch `launch-c1fce464`). Home checkout
  `D:/Development/saga-mcp` = **no-build zone**; every CC-00 build/test ran in
  the isolated worktree. Operator-directed parallel full suite in
  `D:/Development/saga-mcp-w02` (separate clone) — untouched.
- Dirty/untracked files in the main checkout, preserved and NOT committed:
  `DRAGON-MAP.md` (modified, foreign), `tests/factory-evidence/conformance-report.json`
  (modified; timestamp-only regen 09:56→10:58Z, semantically identical to
  committed), `.tmp-saga4-final.txt`, `.tmp-saga4-suite.txt`, `docs/pitch-deck/**`.

## Commands, exits, counts, wall time

All commands run in the isolated worktree unless noted.

| Command | Exit | Result | Wall |
|---|---|---|---|
| `npm ci` | 0 | dependencies installed | — |
| `npm run build` | 0 | `dist/` produced (worktree-local) | — |
| `node tools/run-acceptance-matrix.mjs --group factory-proof` | 0 | **53 tests, 53 pass, 0 fail, 0 skipped** (11 files) | 147 s |
| `node tools/run-acceptance-matrix.mjs --group matrix-coverage` | 0 | **17 tests, 17 pass, 0 fail** | 1 s |
| `npm run conformance:v1` | 0 | committed-snapshot report; semantic diff from committed snapshot: **none** (rewrites `generatedAt` only) | 1 s |
| `npm run coverage:factory` | 0 | 176 universe tokens, 19 pending; Discovery CLOSED 47/47, Formalization CLOSED 70/70, Development SPINE 18/35, Delivery SPINE 17/19 | <1 s |
| `npm test` (full suite) | 1 | **4336 tests, 4292 pass, 11 fail, 33 skipped** (492 files, 5 batches) | 1293 s |
| `npm run conformance:harvest` | **DEFERRED** | machine kept quiet for the Elite-6 product release (operator directive 2026-08-22); the stale-note removal happens through regeneration as the first step of CC-10A or a CC-00b micro-package once the run reaches terminal | — |

Committed evidence digests at base SHA:

- `tests/factory-evidence/conformance-report.json` sha256 (raw git blob at `37ce4c00`)
  `0c4ee70e53c5cd7db808381678f8156ee00ee68cce4e825ef9c3818be8561818`
- `tests/factory-evidence/harvest-manifest.json` sha256 (raw git blob at `37ce4c00`)
  `faaebf5dec4941463c0a45a610884c1106208f4e610f5dd3f3ead8efbc67dabd`

> **Pin re-capture (2026-08-25, qualification closure):** the conformance
> report was legitimately superseded by the final pre-freeze harvest
> (commit `37ce4c00`, 82/82 pass across five workshops incl. the
> documentation admission and the W2 Development universe). Pin and
> ledger baseSha re-captured to that blob; the harvest-manifest pin was
> re-captured with it (the same harvest rewrote both files).

> **Pin re-capture (2026-08-24, BM-5 correction follow-up):** the
> conformance-report pin was superseded when `e64b1a34` legitimately
> regenerated the snapshot (universe 176 → 178, ADR-095 phase-2
> terminal-accounting tokens) WITHOUT repinning this ledger — K0-E was red
> on a clean checkout of that commit (HEAD blob `5c83feec` vs pin
> `79a64f22`). The pin and the ledger base SHA are re-captured at
> `e64b1a34` per the ledger's own supersession discipline; see
> `supersededValues` in CC-00-baseline-ledger.json. The harvest-manifest
> blob is unchanged and keeps its original pin.
>
> **Pin re-capture (2026-08-24, canonical BM-5 integration):** the BM-5
> series was cherry-picked onto canonical saga4 `27a81403` with
> byte-identical evidence blobs (raw committed blob hashes recomputed at
> the integrated tree: conformance-report `5c83feec`, harvest-manifest
> `3ae2c03c`). The pins above are UNCHANGED; only the ledger base SHA
> advances to the canonical integration head `087f1a65` so the
> evidence-freeze commit is reachable from the saga4 lineage itself. See
> the baseSha-only entry in `supersededValues`.

### Digest domain and method (K0 baseline-identity repair, 2026-08-23)

**Domain:** the authority for every committed-evidence digest is the raw byte
sequence of the committed git blob for the path at the recorded base SHA
(`git cat-file blob 6ddcb107:<path>`). The pinned blobs are byte-identical at
the CC-00B integration head `aef699b4` (git blob oids `79a64f22` for the
report, `3ae2c03c` for the harvest manifest, recorded in the ledger).

**Method:** SHA-256 over those raw blob bytes only — no EOL normalization, no
working-tree or checkout bytes. Windows checkouts materialize CRLF
(`core.autocrlf`) and PowerShell pipelines re-encode LF to CRLF, so hashes
taken over checkout bytes or piped `git show` output belong to a different
digest domain and are never the authority. Machine-checked by
`tests/factory-proof/k0-baseline.test.mjs` (K0-E), which reads the exact
committed blob through `git cat-file` and fails on any pin mismatch, a missing
pin, or a non-64-hex pin; where full history is present it re-verifies at the
base SHA itself.

Correction provenance (both originally recorded pins were checkout-domain
values; the values remain recorded in `committedEvidenceDigests.supersededValues`
in the ledger): the report pin `666e0567…` was a working-tree capture matching
no committed-blob variant; the harvest pin `bcc97746…` is the sha256 of the
CRLF working-tree checkout (19085 bytes = the 18534-byte LF blob with 551
LF→CRLF conversions). A repair-input candidate `66480ccd…` was identified as
the sha256 of the report blob after LF→CRLF conversion and rejected for the
same reason — it is a checkout-domain value, not raw blob bytes.

## Red baseline classification (11 failures at `6ddcb107`, run under 3-way load)

Suite ran concurrently with (a) the LIVE Elite-6 factory (engine + opencode
worker, git + SQLite activity) and (b) the operator-directed parallel full suite
in `saga-mcp-w02` — three heavy Node workloads on one host. Failure profile:

- **10 of 11 are long temporal/contract E2E with wall-clock budgets**
  (runtimes 131–255 s): golden-path (stage settled `blocked` with healthy
  children), parallel-git-desk (never reached `runnable-local`), foundation,
  candidate-gate, dispatch-concurrency, package-replay-drift, and all four
  worker-boundary files failing at **183.5–183.8 s against the 180 s host
  budget** — the exact contention signature documented in base commit
  `6ddcb107` itself (boundary-1 converges at ~191 s under live Elite-6; passes
  with `SAGA_WB_HOST_BUDGET_MS=300000`; "contention, not regression").
- **1 of 11 is anomalous and NOT budget-shaped**:
  `tests/infrastructure/local-runnability-seam-compose.test.mjs:348`
  "serve crash emits seam serve-start" — 9.8 s, assertion inverted
  (`actual 'passed' !== expected 'failed'`): an injected serve crash did NOT
  fail the compose seam within the check window.

Reproduction protocol: after the suite finished (and the w02 suite exited,
leaving Elite-6 as the only ambient load), all 11 files are re-run solo,
sequential. Result: PENDING (recorded below when the battery completes).

| Solo re-run | Verdict |
|---|---|
| `local-runnability-seam-compose` | **PASS** (19 s; crash injection behaves correctly without load — load-shifted assertion window) |
| `worker-boundary-1-exit-pre-submit` | **PASS** (174 s < 180 s budget) |
| `worker-boundary-2-exit-post-submit` | **PASS** (176 s) |
| `worker-boundary-3-receipt-authoritative` | **PASS** (174 s) |
| `worker-boundary-4-stale-host` | **PASS** (175 s) |
| `golden-path.test.mjs:297` | **FAIL — identical shape** (stage `blocked` vs `verified`; 183 s solo) |
| `parallel-git-desk.test.mjs:184` | **FAIL — identical shape** (never reached `runnable-local`; 111 s solo) |
| `foundation.test.mjs:95` | **FAIL — identical shape** (`blocked` vs `verified` at :186; 178 s solo) |
| `candidate-gate.test.mjs:488` | **FAIL — new facet** ("repair_required decision but no subsequent accepted decision — repair loop did not converge"; 532 s solo) |
| `dispatch-concurrency.test.mjs:519` | **FAIL — new facet** ("done task 20 has no final-accepted GateDecision — task reached done without gate acceptance"; 630 s solo) |
| `package-replay-drift.test.mjs:338` | **FAIL — new facet** ("Advisory assessment provider metadata must not displace local-runnability authority; got 'blocked'"; 533 s solo) |

### Final classification

- **Contention flakes (5):** seam-compose + all four worker-boundary files. The
  boundary quartet fails at 183.5–183.8 s only under extra machine load and
  passes solo at 174–176 s — precisely the signature documented in base commit
  `6ddcb107` ("contention, not regression"; env-tunable budget exists).
- **Deterministic red baseline — `CC-GAP-1` (6):** golden-path,
  parallel-git-desk, foundation, candidate-gate, dispatch-concurrency,
  package-replay-drift all fail SOLO with reproducible assertions across one
  subsystem: **Development acceptance / gate / repair convergence**. Shapes:
  stage settles `blocked` instead of `verified`; repair loops never converge
  (`repair_required` with no subsequent `accepted`); a task reaches `done`
  without a final-accepted GateDecision; advisory assessment metadata displaces
  local-runnability authority into `blocked`. Healthy children throughout
  (`child closed: code=0, semantic=true, blocked=(none)`).
- **Bisect result (endpoint pinning, manual):** pre-merge saga4 tip `6a1e3651`
  = golden-path **PASS**; wave tip `191e647e` = **FAIL**. The regression enters
  inside the **w0-waves merge window (21 commits, merged by `303a482a`)**.
  Commit-level pinning is deferred to the CC-GAP-1 investigation package —
  stopped to keep the machine quiet for the Elite-6 product release (operator
  directive 2026-08-22). Suspect order by commit-message analysis:
  `f13181e0` (criterion-identity separation across the Development contract:
  per-criterion verification cards, settlement arithmetic on key sets),
  `1dac22af` (composite `(artifactId, code)` uniqueness), `1a6fc2a5` (replay
  capsule cell identity = TASK), and the repair re-seal recovery-budget
  charging fix named in `a8183ed5`.
- **Working hypothesis (for CC-GAP-1 adjudication):** the wave intentionally
  tightened Development acceptance identity; the six failing E2E use SCRIPTED
  scenarios whose repair material may now be unlawful under the stricter
  contract → repair loops never converge → `blocked`. Live counter-evidence:
  Elite-6 (same code, REAL glm-4.6 material) is progressing toward a product
  release through the same production path. Final decision — stale-test-update
  vs production defect — belongs to the CC-GAP-1 package, not CC-00.
- **Elite-6 exposure:** the live run executes dist built from `303a482a` (the
  merge window). Operator reports the product release is imminent. Per
  protocol the run was never touched; all CC-00 verification ran in the
  isolated worktree, and remaining heavy steps were paused for the release.

Classification rules applied: solo-pass ⇒ contention flake (documented, not
hidden); solo-fail ⇒ real defect recorded as `CC-GAP-N` with repro, handed to
the defect owner (CC-00 non-goals forbid production fixes inside this package).

## Semantic ignore-list audit (K0-E2): PASS

`tests/factory-proof/k0-baseline.mjs:62-72` (`TRACE_SEMANTIC_IGNORE`):
timestamp fields (`observedAt`, `updated_at`, `decided_at`, `sealed_at`,
`started_at`, `created_at`, `accepted_at`), a path transform stripping `file://`
and repo-root prefixes (both `saga-mcp` and `saga-mcp-w02`) to `<repo>/`, and
row-ID fields (`id`, `task_id`, `process_run_id`, `artifact_id`). Only the four
allowed categories (generated IDs, timestamps, absolute paths, DB row IDs). No
change required.

## Cross-tree import metrics (named and reproducible)

Commands recorded in the ledger. Results at `6ddcb107`:

- **Strict workshop-subtree metric:** 25 direct importer files (13
  `src/process-modules/modules/**` → `src/modules/**`, 12 reverse), 43 directed
  import edges (29 + 14).
- **Any-process-modules metric:** 55 importer files (13 + 42), 157 edges
  (29 + 128).
- ADR-085 recorded "at least 32 files" on the 2026-08-21 population — it falls
  between the two named current metrics. Each metric is named and reproducible;
  neither number silently replaces the other. Tree sizes: 53 TS files under
  `src/process-modules/modules`, 91 under `src/modules`.

## Stale harvest-note disposition (no hand edits)

`tests/factory-evidence/harvest-manifest.json:548` (hand-inserted by commit
`a8183ed5`, not emitted by any generator): the `captureGitRecipe` race diagnosis
is **superseded** — root-caused and fixed by `1a6fc2a5` (capsule cell identity =
TASK); post-mortem in
`docs/factory-run/stage20-elite/RUN-TRACKER.md` §"PROD FIX — packaging flake
root-caused and killed" (stability 6/6; regression
`tests/infrastructure/replay-foreign-submission-cell.test.mjs` 4/4). Removed by
regeneration (`npm run conformance:harvest`); the generator emits no `note`
field, so regenerating restores generator-authored evidence only. Diagnosis
authority = RUN-TRACKER post-mortem + fix commit.

`harvest-manifest.json:451` carried a second non-generator annotation, preserved
here verbatim before regeneration removes it:

> re-driven after token rename/multi-phase accounting (operator completion order)

## K0–K5 gate ledger

24 criterion rows (K0-E1…K5-E4) with status/blocker/proof mode/evidence/command
live in `CC-00-baseline-ledger.json`. Summary at base SHA:

- **PASS (7):** K0-E1, K0-E2, K1-E2, K1-E4, K2-E1, plus deterministic green
  blocking group and report consistency (recorded in `baselineRuns`).
- **PARTIAL (14):** with named blocking packages — K1-E1 (CC-22), K1-E3
  (CC-22/24), K2-E2/E3/E4 (CC-24), K3-E1…E4 (CC-30/31/32), K4-E1/E2/E4/E5
  (CC-44), K5-E1 (CC-10A), K5-E2 (CC-10B), K5-E4 (CC-10A/10B), K0-E3 (CC-82).
- **NOT IMPLEMENTED (2):** K4-E3 minimizer (CC-42), K5-E3 vacuous-pack mutant
  (CC-10B).

Proof-claim ownership: all 11 existing claims mapped to owner packages and
post-cutover replacement destinations in the ledger (`claimOwnership`).

Report correction debt (owned by CC-31): the committed report
(`conformance-report.json:144-147`) describes mutation kills as K4-owned;
mutation identity and kill closure are K3 responsibilities, K4 owns fault
schedules.

## Exit checklist status

- [x] Exact base SHA and baseline counts reproduce from an isolated worktree
      (suite, groups, report digests recorded above).
- [x] Every K0-K5 criterion has a ledger row and evidence owner.
- [x] Any red baseline is classified and reproduced before implementation:
      11 failures → 5 contention flakes (documented signature) +
      `CC-GAP-1` deterministic red (6 tests, solo-reproduced, bisect window
      pinned to the w0-waves merge; commit-level pinning and adjudication
      owned by the CC-GAP-1 package).
- [ ] Evidence regeneration (harvest) — DEFERRED: machine kept quiet for the
      Elite-6 product release (operator directive 2026-08-22). First step of
      CC-10A or a CC-00b micro-package.

## Next package

`CC-10A` — provisional v1 CI ratchet (add 12 v1 files to the blocking group +
claims, bidirectional exactness, three fresh-environment runs). Base for CC-10A:
the merged CC-00 branch. CC-10A does not depend on CC-GAP-1 (none of the six
red tests are in the factory-proof group), but the full-suite green needed by
later gates (CC-82) does.
