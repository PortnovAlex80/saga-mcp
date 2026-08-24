# ADR-095 Phase 6 — empty allowlist, mutation proofs, full validation (2026-08-24)

- **Branch/worktree:** `phase6/finish-discovery-legacy-closure`
  (`saga-mcp-DISCOVERY-P6`), base = canonical
  `integration/canonical-2026-08-24` head `57468bb6` (contains ADR-095
  Phases 1-5 + CC-GAP7A). The interrupted six-file Phase-6 start found in
  the worktree was transplanted onto the new branch, not discarded; every
  modification was verified against production truth before acceptance
  (see §1).
- **Scope:** ADR-095 Phase 6 — the dependency-direction Discovery-legacy
  allowlist entries reach zero; every deliberate mutation RED/GREEN cycle
  is executed and recorded against the REAL post-Phase-5 tree; the six
  blocker suites, clean build, acceptance matrix, architecture group,
  discovery-live-v2 group, migration-conformance and the process-module
  group are green; the registry/tracker state is updated to the executable
  truth. One same-class production repair (the stale
  `wire-submission-validation.ts` policy key) and one same-class stale
  fixture sweep landed with it (§5). NOT claimed: full-factory
  qualification (ADR-096 Phase 7, separately authorized).

## 1. Transplanted interrupted work — each modification verified

| File | Interrupted modification | Production-truth verification |
|---|---|---|
| `tests/factory-contract/crash-scenarios.mjs` | `DISC` 3.0.2 → 4.0.0 | `src/process-modules/lifecycles/product-delivery-module-contracts.ts:30-33` pins `DISCOVERY_PROCESS_MODULE_REF.version = '4.0.0'`; the manifest (`package/manifest.ts`) derives its module key from the same constant |
| `tests/factory-contract/golden-path-scenarios.mjs` | `DISC` 3.0.2 → 4.0.0 | same |
| `tests/factory-e2e/w9-04-outcome-edge-handlers.mjs` | `DISC` 3.0.2 → 4.0.0 | same |
| `tests/factory-e2e/w9-happy-handlers.mjs` | `DISC` 3.0.2 → 4.0.0 | same |
| `tests/factory-contract/crash-recovery.test.mjs` | `lifecycle_execution_controls` insert gains `model_provider='zai', model_name='glm-4.7', model_effort='high', model_concurrency_limit=2` | admission is fail-closed: `sqlite-factory-runtime-repositories.ts` throws `MODEL_CONCURRENCY_POLICY_INVALID … requires exact provider/model identity` on NULL model fields; the catalog (`runtime/factory-model-profiles.ts`) pins `glm-4.7` → provider `zai`, effort `high`, limit `2` — the fixture pins exactly a legal catalog route |
| `tests/factory-contract/k13-crash-after-accepted-head.test.mjs` | same admission pin | same |

Backup of the interrupted diff (pre-transplant):
`/d/Development/phase6-interrupted-work-backup.patch` (93 lines, six files).

## 2. Ratchet table — all eight GREEN on this tree

Command form: `node --test <owner file>` from the repo root on the
clean-built tree (`npm run build` first: removes `dist/`, then `tsc`;
exit 0).

| # | ADR-095 ratchet | Executable proof (owner test) | Result |
|---|---|---|---|
| 1 | Shrinking allowlist (zero Discovery-legacy entries) | `tests/architecture/dependency-direction.test.mjs` (4 tests: non-trivial graph, zero unallowlisted, zero stale, `KNOWN_VIOLATIONS.length <= ALLOWLIST_BASELINE=1`) + `tests/architecture/adr-095-ratchet-suite.test.mjs` R1a/R1b (ceiling 1; ZERO Discovery-scoped edges in both allowlist shapes; mutation negatives) | GREEN — `KNOWN_VIOLATIONS: 1` (R1=1, the unrelated TB-8 development→formalization parser edge; zero Discovery-scoped edges); ratchet suite 25/25 |
| 2 | Exact one-handler manifest/digest | `adr-095-ratchet-suite` R2a (exactly `discovery-settlement-policy`, digest = sha256 of executed `dist/…/discovery-production-cell-installation.js` bytes, handler version bumped) + blocker `tests/architecture/handler-digest-runtime-consistency.test.mjs` | GREEN (R2a in 25/25; blocker 4/4) |
| 3 | Full src symbol/table absence | `adr-095-ratchet-suite` R3a over `inventory.removalSymbols` (comment-stripped src scan); retired-ID fan-out: bridge BR5 (`tests/architecture/adr-095-phase2-bridge-ratchets.test.mjs`, allowed set emptied this phase) | GREEN (R3a in 25/25; bridge 21/21) |
| 4 | Dist-aware clean-build absence | `adr-095-ratchet-suite` R4a/R4b (zero emitted dead modules after clean `tsc`; stale/absent dist fails closed) | GREEN (in 25/25) |
| 5 | Fresh DB lacks the full closure | `adr-095-ratchet-suite` R5a-R5d (REAL fresh DB through `dist/db.js getDb`; partial closure, F2 ordering, kept-table guards) | GREEN (in 25/25) |
| 6 | Live v2 behavior | matrix group `discovery-live-v2` — exactly the eight inventory live-v2 suites (R6a pins the exact-file list, no glob widening), run via `node tools/run-acceptance-matrix.mjs --group discovery-live-v2` and inside the full matrix | GREEN (see §6 counts) |
| 7 | Existing-DB boot with retired old installation | `tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs` (spawned install host boots with retired 3.0.2 installation, rehydrates the pinned run's exact package; F5 drift oracle `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT`; R7a anti-guts the owner) | GREEN 4/4 |
| 8 | Deliberate mutation RED/GREEN (non-vacuity) | the five REAL-TREE cycles in §3 below (machine negatives R1b/R2b-e/R3b-f/R4b/R5b-d additionally run in-suite on the same checker code paths) | GREEN — 5/5 cycles RED-then-GREEN |

## 3. Deliberate mutation RED/GREEN cycles (real tree, 2026-08-24)

Each cycle: apply the minimal mutation → rebuild ONLY when the pinning
suite reads dist ((d)/(e)) → run the specific pinning suite → capture the
RED naming the exact regression → revert → rebuild if needed → re-run
GREEN. No assertion was weakened at any point.

| Class | Mutation (exact) | RED output (excerpt, pinning suite) | GREEN confirmation |
|---|---|---|---|
| (a) dead handler reference | append to `src/modules/discovery/index.ts`: `export const LEGACY_DISCOVERY_HANDLER_ID = 'discovery-resolve-proposal-submission';` | bridge BR5: `retired ADR-095 handler IDs fanned out beyond the exact known legacy files (allowed: ): src/modules/discovery/index.ts: discovery-resolve-proposal-submission` (1 fail/21) | revert → BR5 ✔, 21/21 |
| (b) legacy tool import | append to `src/modules/discovery/index.ts`: `import { createDiscoveryProposalHandlers } from './application/discovery-proposal-tools.js';` (module deleted in Phase 4) | `tsc`: `error TS2307: Cannot find module './application/discovery-proposal-tools.js'`; ratchet R3a: `dead module import (/discovery-proposal-tools) referenced OUTSIDE its allowed sites in src file: src/modules/discovery/index.ts (post-cutover: allowed sites are EMPTY — reintroduction is forbidden)` (2 fail/25) | revert → R3a+R8 ✔, 25/25 |
| (c) projection write (`product_submit`→`factory_proposals`) | re-insert into the `product_submit` transaction in `src/tools/products.ts` (at the exact Phase-3.1 removal site): `getDb().prepare('INSERT INTO factory_proposals (epic_id, proposal_json) VALUES (?, ?)').run(1, content);` | ratchet R3a: `dead table (factory_proposals) referenced OUTSIDE its allowed sites in src file: src/tools/products.ts (post-cutover: allowed sites are EMPTY — reintroduction is forbidden)` (2 fail/25) | revert → R3a+R8 ✔, 25/25 |
| (d) legacy `CREATE TABLE` (one of the ten removed tables) | add to `SCHEMA_SQL` in `src/schema.ts` after `factory_work_intents`: `CREATE TABLE IF NOT EXISTS factory_discovery_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, process_run_id TEXT NOT NULL, decision TEXT NOT NULL);` + `npm run build` | R0: `the fresh schema no longer creates any member of the legacy closure`; R5a: `PARTIAL legacy closure in the fresh DB — present: [factory_discovery_settlements / no indexes]; … The closure is removed ATOMICALLY (one commit) or not at all` (4 fail/25) | revert + rebuild → 25/25 |
| (e) stale manifest pin at the OLD module version | `product-delivery-module-contracts.ts` `'4.0.0'` → `'3.0.2'` + `npm run build` (src=dist coherent) | R0: `the cutover version must be above 3.0.2 (got 3.0.2)`; R2a: `pre-cutover manifest drifted from the censused six-handler baseline … at version 3.0.2 the six stale pins are the recorded truth; the ONLY legal change is the atomic phase-4 version-bump cutover (ADR-095 Decision 4 / F5 STOP-SHIP)` (5 fail/25) | revert + rebuild → 25/25 |

Raw transcripts: `/d/Development/phase6-mutations/{a,b,c,d,e}-{red,green}.txt`
(plus `b-red` TS2307 line, `d-red-migration.txt`, `e-red-digest.txt`).
Re-verification (resumed session, 2026-08-24, post-reboot clean rebuild):
cycles (a) and (c) were independently re-executed against the real tree —
(a) re-produced BR5 RED exactly (`retired ADR-095 handler IDs fanned out
beyond the exact known legacy files (allowed: ):
src/modules/discovery/index.ts: discovery-resolve-proposal-submission`,
1 fail/21) and GREEN after revert (21/21); (c) re-produced R3a+R8 RED
(`dead table (factory_proposals) referenced OUTSIDE its allowed sites in
src file: src/tools/products.ts (post-cutover: allowed sites are EMPTY —
reintroduction is forbidden)`, 2 fail/25) and GREEN after revert (25/25).
Transcripts of the re-run:
`/d/Development/phase6-mutations/reverify-{a,c}-{red,green}.txt`.

Scope notes recorded honestly: `migration-conformance` stayed green under
mutation (d) — its ADR-095 dimensions pin source-file absence and
module-graph conformance, not fresh-DB closure; the fresh-DB closure
oracle is the ratchet suite (R5a), which RED-named the table.
`handler-digest-runtime-consistency` stayed green under mutation (e) —
its digest pin binds manifest digest to dist bytes (unchanged by a
version-only flip); the version-boundary oracle is R0/R2a, which
RED-named the F5 shape.

## 4. Six blocker suites (individually, no weakening)

| Suite | Command | Result |
|---|---|---|
| v4-target-conformance-ratchet | `node --test tests/architecture/v4-target-conformance-ratchet.test.mjs` | 16/16 |
| handler-digest-runtime-consistency | `node --test tests/architecture/handler-digest-runtime-consistency.test.mjs` | 4/4 |
| kernel-admission-distance | `node --test tests/architecture/kernel-admission-distance.test.mjs` | 6/6 |
| migration-conformance | `node --test tests/execution/migration-conformance.test.mjs` | 35/35 |
| dependency-direction | `node --test tests/architecture/dependency-direction.test.mjs` | 4/4 (allowlist = 1 unrelated TB-8 edge, zero Discovery entries) |
| discovery-package-contributions | `node --test tests/process-modules/discovery-package-contributions.test.mjs` | 5/5 |

## 5. Phase-6 production repair + stale-fixture sweep (same class, one root cause)

**Root cause (production):** the ADR-095 Phase-4 atomic version bump
(3.0.2 → 4.0.0) left `src/process-modules/application/wire-submission-validation.ts`
registering the Discovery node submission policies (`produce-proposal`,
`assess-readiness`) under the stale key `product-discovery@3.0.2`. Every
live Discovery `worker_done` then failed fail-closed with
`SUBMISSION_VALIDATION_POLICY_MISSING: product-discovery@4.0.0/produce-proposal`
— killing the AC-28/T10 crash-recovery test, the K13 crash suite, and all
W9 scripted E2E drives. **Fix:** the live key is now DERIVED from
`DISCOVERY_PROCESS_MODULE_REF` (the canonical contracts constant — the
next bump cannot leave this file stale again), and the legacy `3.0.2` key
is RETAINED for nonterminal runs pinned to the retired six-handler
installation (they rehydrate that exact package per ADR-034/ADR-095 and
resolve policies under the pinned identity) — the same multi-version
enumeration `DEVELOPMENT_MODULE_REFS` already uses.

**Stale-fixture sweep (tests/):** all remaining
`product-discovery@3.0.2` scripted-route keys and bare
`lifecycle_execution_controls` inserts that drive the real lifecycle were
fixed the same way as the transplanted six:
`tests/factory-contract/golden-path.test.mjs` (insert now pins the full
admission route), `tests/factory-contract/parallel-git-desk.test.mjs`
(insert was left as broken SQL `(epic_id,concurrency) VALUES (1,2,2)` by
commit `18662636`'s partial fixture edit; now pins the full route at
concurrency 2 = the glm-4.7 catalog quota), `tests/factory-proof/w1-4-two-lifecycles-drive.mjs`
(`DIS` route key → 4.0.0), `tests/factory-temporal/scenarios/worker-boundary-crash-scenarios.mjs`
(`DISC` route key → 4.0.0). Deliberately NOT changed: synthetic-ref unit
fixtures that never consult the installed lifecycle identity
(`02-first-cell`, `k0-baseline`, `replay-capture-trace-revision`,
`managed-completion-product-freeze`, `run-snapshot-tool` — the latter
builds its own minimal table; all re-run green), the
`frozen-limit-admission`/`sqlite-concurrency-admission`/`model-selector`
policy tests (they exercise the admission boundary itself, including
invalid variants), and the frozen retired-package compat fixture (§7).

**Sweep completion (2026-08-24, resumed session after the machine
reboot):** the interrupted session's post-repair matrix run
(`acceptance-matrix-full-2.log`, 22:44Z-local) still exited 1. Re-running
its failures standalone separated TWO causes:

1. *Real stale fixtures (same class, fixed):*
   `tests/process-modules/process-module-validation.test.mjs` and
   `tests/process-modules/process-module-tools.test.mjs` pinned the
   built-in registry/catalog at `product-discovery@3.0.2` (expected-list
   `deepEqual` + a `process_module_get` version lookup). Both now DERIVE
   the expectation from the module identity itself
   (`discoveryProcessModule.identity.version` /
   `DISCOVERY_PROCESS_MODULE_REF.version`), so a future bump cannot leave
   them stale; 28/28 and 5/5 green.
2. *Machine-reboot cascade (NOT fixtures):* the twelve 3-4 ms failures in
   that log (`lifecycle-orchestrator`, `lifecycle-routing`, `gateway-guard`,
   `managed-node-submission`, `pinned-workspace-*`, etc.) all carry
   `Error: spawn UNKNOWN (errno -4094)` — the node test runner could not
   spawn child processes while the host was dying. Every one of them is
   green standalone (and in the resumed full matrix) on this tree.
   `product-delivery-lifecycle-e2e` (15 s timeout fail in that log) is
   likewise 2/2 green standalone now.

The interrupted session also left one uncommitted fixture repair:
`tests/process-modules/settlement-debug.test.mjs` — after the Phase-5
fresh-schema removal, fresh DBs no longer create
`factory_discovery_settlements`, so the "legacy settlement query absent"
test now recreates the table in its own fixture DDL exactly as an
EXISTING pre-cutover database carries it (inert history the tool must
still never read). 4/4 green.

**Pre-existing-at-canonical truth repair (cc-proof-registry, exposed by
the Phase-6 full matrix):** the CC proof-hosting manifest (ADR-092) typed
the two GAP-2 terminal-projection proofs `pending` while the reviewed
CI-invoked `conveyor-app` / `conveyor-periphery` groups already hosted
them (`PENDING_ABSORBS_HOSTED`, R1 red; R3 still asserted "hosted
nowhere"). Fixed by executing the conversion the rows' own tracker
protocol prescribed: both rows retyped `blocking` with their hosting
groups pinned, R3 re-pointed at the new truth (blocking + hosted in the
pinned group + CI-invoked), R1 repinned 4/2 → 6/0, and the m7b/m8
mutation negatives rebased onto synthetic pending rows (zero real
pending rows remain — non-vacuity preserved in both directions).
`cc-proof-registry` 26/26, `matrix-coverage` (G5 cross-guard) re-green
30/30. Also observed once, recorded honestly: one process-modules group
run failed mid-loop and did not reproduce (the immediately repeated
full-group run is 1482/1482 green); the failing test name was not
captured by the loop's tail filter.

Verification after the repair (all standalone, post-rebuild):
`w9-02-happy-path` 3/3, `w9-03-adversarial` 6/6, `golden-path` 1/1,
`crash-recovery` + `k13` 3/3, `parallel-git-desk` 1/1,
`02-first-cell` + `k0-baseline` 13/13.

## 6. Full validation

| Gate | Command | Result |
|---|---|---|
| Clean build | `npm run build` (rm dist + tsc) | exit 0 |
| Acceptance matrix (ALL groups) | `npm run test:acceptance-matrix` | see FINAL-VALIDATION below |
| Architecture group (incl. dispatcher-race extras) | `npm run test:architecture` | see FINAL-VALIDATION below |
| Discovery live-v2 group (ratchet 6) | inside the full matrix (`--group discovery-live-v2`) | see FINAL-VALIDATION below |
| Process-modules group | `npm run test:process-modules` | see FINAL-VALIDATION below |
| Factory-temporal (scenario pack touched by the sweep) | `npm run test:factory-temporal` | see FINAL-VALIDATION below |
| Full suite (`npm test`, >4000 tests incl. quarantined-from-matrix files) | `npm test` | see FINAL-VALIDATION below |

FINAL-VALIDATION (2026-08-24, this tree, post all repairs — every group run
against the clean-built dist):

| Gate | Result |
|---|---|
| Clean build (`npm run build`) | exit 0 |
| Acceptance matrix — all 14 groups green (architecture 494; factory-model 3; readiness-fencing 125; factory-contract 120; process-modules 1482; discovery-live-v2 62 across its 8 files; desk-coverage 748+10 skip; e2e-deterministic 192-class incl. W9 drives; conveyor-app 373; conveyor-infra 774+10 skip; conveyor-periphery 658+17 skip; matrix-coverage 30; cc-proof-registry 26; factory-proof 112) | green (groups run individually after in-flight repairs; each exit 0) |
| `npm run test:architecture` (incl. dispatcher-race extras) | exit 0 |
| `npm run test:factory-temporal` | 31/31, exit 0 |
| Named E2E: `w9-02-happy-path` 3/3, `w9-03-adversarial` 6/6, `golden-path` 1/1 | green standalone AND inside their matrix groups |
| `npm test` full suite (512 files) | 4599 tests / 4547 pass / 19 fail / 33 skip, exit 1 — the 19 fails are ALL spawn-heavy suites colliding under the full-suite's 100-file batch concurrency (the blanket runner cannot isolate them; this is exactly why the acceptance matrix exists as isolated `concurrency: 1` groups, per its header). Every failing suite is green standalone on this tree (w9-02/03/04 re-run together 14/14; w9-05 + capture-child + seam-compose + k2-strict re-run together 30/30) and green inside its isolated matrix group. Residual class: blanket-runner infrastructure, pre-existing at canonical (where the same suites were additionally red for the stale-version reasons); NOT a Phase-6 regression and NOT hidden — the blocking CI surface is the matrix, which is fully green. |

One process-modules group loop run failed once mid-session and did not
reproduce (the immediately repeated full-group run is 1482/1482); the
failing test name was not captured by that loop's tail filter — recorded
honestly rather than silently dropped.

## 7. Exit-criteria verification (the ADR-095 checkbox list)

| ADR-095 exit item | Proof | Status |
|---|---|---|
| Phases 1-6 each landed as a separate reviewable commit-train in order, per-phase gates green | Phase records in `PRE-ELITE9-TRACKER.md` Point 5 (1: census `DISCOVERY-PHASE1-CENSUS.md` + boot baseline; 2A/2B/2C: `DISCOVERY-PHASE2C-RATCHETS.md`; 3.1/3.2/3.3 + EXIT gate; 4: atomic cutover `eaa98e34`; 5: `f585ff80` + `1f4630a9`; 6: this document) | MET |
| All eight ratchets green, incl. dist-aware + fresh-DB absence + existing-DB boot regression | §2 table (ratchet suite 25/25; boot regression 4/4) | MET |
| All six named blocker suites updated and green (no weakening) | §4 table | MET |
| Deliberate mutation RED/GREEN executed and recorded for every removed surface class | §3 table (5/5 classes, real-tree) | MET |
| Phase-1 census recorded: zero nonterminal legacy-pinned runs lacking a retained installation row | `DISCOVERY-PHASE1-CENSUS.md` (19-DB read-only census) + boot-regression rehydration proof | MET |
| Full acceptance matrix green on the clean-built dist; empty discovery-legacy allowlist | §6 + §2 ratchet 1 | MET (see §6 for the exact run) |
| Registry entry updated with the closure evidence bundle | `docs/architecture/adr-closure-registry.json` adr 095: `closureState: implemented`, notes carry the phase record + the §5 repair, evidence[] carries the Phase-6 pointers; `npm run adr-closure:validate` green (70/70) | MET |

Residual honest boundaries (not exit items, recorded for the reader):
- Full-factory qualification is NOT claimed — that is ADR-096 Phase 7,
  separately authorized (immutable build, clean scripted E2E + real
  canary from a fresh DB/repository).
- Comment-only historical mentions of removed names remain in four live
  files (`actionable-tool-error.ts`, `workplace-product-port.ts`,
  `projects.ts`, `sqlite-process-outcome-certificate-repository.ts`) —
  prose, not executable residue; the ratchet's comment-stripped scan
  (R3) mechanically proves no code reference exists.
- `settlement_explain` keeps its non-Discovery trace (ADR-095 Neutral).

## 8. Run logs (operator evidence)

Kept outside the repo (session artifacts):
`/d/Development/phase6-mutations/` — `a..e-{red,green}.txt`,
`acceptance-matrix-full.log` (the pre-repair run that EXPOSED the
§5 production defect: factory-contract 2 fail with
`SUBMISSION_VALIDATION_POLICY_MISSING`), `acceptance-matrix-full-2.log`
(post-repair), `w9-02.txt`, `w9-03.txt`, `golden-path.txt`,
`crash-k13.txt`, `parallel-git-desk.txt`.
