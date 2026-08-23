# DISCOVERY-PHASE1-CENSUS — ADR-095 Phase 1: 19-DB local factory census

- **Date:** 2026-08-23 (pass 1 `generatedAt` 2026-08-23T21:01:02Z; pass 2 written
  immediately after in the same session)
- **Authority:** ADR-095 Phase 1 ("census of nonterminal runs pinned to the
  pre-bump (six-handler) discovery installation; the existing-DB boot baseline
  capture") and exit criterion "zero nonterminal runs pinned to the legacy
  installation that lack a retained installation row".
- **Status:** EXECUTED. Findings transcribed below from the recovered evidence
  artifacts; no fact in this file is inferred beyond them.

## Method (strictly read-only)

Originals were never opened. For every database, `db`+`-wal`+`-shm` were
copied to a temp workspace, the COPY was opened with better-sqlite3
**12.6.2** (verified: the exact module version used by both passes), the copy
was set `PRAGMA query_only = ON`, and only `SELECT`s / `sqlite_master` /
`PRAGMA table_info` were issued. Two passes ran over fresh copies each:

- pass 1 (`census.js`): table/column presence, installation rows, run pins;
- pass 2 (`census-pass2.js`): normalized labels + the pinned-run/installation/
  store-snapshot detail recorded here.

Recovered evidence (temporary location, transcribed here for durability):
`C:\Users\user\AppData\Local\Temp\opencode\saga-census\` — `census.js`,
`census-pass2.js`, `census-result.json`, `census-pass2.json`, `copies\`.

## Scope: 19 local factory databases, normalized labels

16 in `D:/Development/saga-mcp/.factory-sandboxes/` (`elite-db`,
`elite-db-failed1`, `elite6-db`, `stage10-db`, `stage11-db`, `stage12-db`,
`stage15-db`, `opencode-val-db`, `opencode-val2-db`, `mars-venus-r8`,
`mars-venus-r9`, `rtk-dual-r1`, `rtk-dual-r2`, `golden-mv-ts-r1`
[= `golden/mars-venus-ts-r1-success-20260813`], `golden-mv-formalized`
[= `golden/mars-venus-formalized-20260813`], `golden-rtk-turbo`
[= `golden/rtk-dual-r1-turbo-20260814`]); 2 in
`D:/Development/saga-mcp-ELITE7/.factory-sandboxes/` (`elite7-db`,
`elite8-db`); 1 in `D:/Development/saga-mcp-gdesign-run/.factory-sandboxes/`
(`gdesign-formal-db`). This census covers the machine's local factory DBs;
the DISCOVERY-P1 worktree itself hosts none.

## Findings

1. **P-PM-1 pinned table absent everywhere.** `factory_process_module_
   installations` does not exist in any of the 19 databases (19/19 `ABSENT`).

2. **Uniform legacy Discovery installation.** Every one of the 19 databases
   carries EXACTLY ONE `product-discovery` installation row: version
   `3.0.2`, status `active`, and its persisted handler logical IDs equal the
   current six-handler ControlIntent-era baseline
   (`discovery-prepare-normalization`, `discovery-prepare-readiness`,
   `discovery-resolve-normalized-proposal`,
   `discovery-resolve-proposal-submission`, `discovery-resolve-readiness`,
   `discovery-settlement-policy`) — `handlerIdsMatchCurrent: true` in 19/19.
   No database carries a second, retired, or staged discovery installation.

3. **Nonterminal pinned runs: 10 databases, one pin each.** A pin = a row in
   `factory_process_runs` with `package_digest IS NOT NULL` and status not in
   (`completed`,`failed`,`cancelled`). Distribution:

   | DB | run# | module@version | status | pkg (16-hex prefix) | installation row | store snapshot |
   |---|---|---|---|---|---|---|
   | elite6-db | 1 | product-discovery@3.0.2 | paused | `aaf79dbc840028a5` | id=1 active | present (verified) |
   | elite-db | 3 | solution-development@1.4.4 | paused | `7de79b326f9f8c3b` | id=3 active | present |
   | stage12-db | 3 | solution-development@1.4.4 | paused | `6807e0a4508e8ff2` | id=3 active | present |
   | opencode-val-db | 3 | solution-development@1.4.3 | paused | `c26182d50ffec1d3` | id=3 active | present |
   | opencode-val2-db | 2 | solution-formalization@1.0.0 | paused | `bb0e45b6198c8da0` | id=2 active | present |
   | rtk-dual-r1 | 3 | solution-development@1.3.0 | running | `770359aeb9442825` | id=3 active | present |
   | rtk-dual-r2 | 3 | solution-development@1.3.0 | paused | `770359aeb9442825` | id=3 active | present |
   | golden-mv-ts-r1 | 3 | solution-development@1.2.0 | running | `4a7f64eb8106863d` | id=3 active | **ABSENT** |
   | golden-mv-formalized | 6 | solution-development@1.2.0 | paused | `6ea076281d57f892` | id=7 active | **ABSENT** |
   | golden-rtk-turbo | 3 | solution-development@1.3.0 | paused | `770359aeb9442825` | id=3 active | present |

   Store-snapshot "present" means the installation row's `store_location`
   path existed on disk at census time (existence check only; the pass did
   not re-hash bytes).

4. **Exactly ONE nonterminal Discovery-pinned run on the machine:
   elite6-db run#1.** `product-discovery@3.0.2`, status `paused`, pinned to
   installation id=1 (`active`) with package digest prefix
   `aaf79dbc840028a5`, store snapshot present. Pause record: `ProcessRun 1
   paused at node 'produce-proposal' and can be resumed (human_required)`;
   node `produce-proposal` (production-cell) attempt 1 completed
   2026-08-22 10:41:17 → 10:43:13. This is the only ProcessRun anywhere that
   an ADR-095 cutover must keep rehydratable.

5. **Out-of-scope honest caveat (non-Discovery).** The two golden
   solution-development pins (`golden-mv-ts-r1` run#3 running,
   `golden-mv-formalized` run#6 paused) have NO store snapshot on disk while
   their installation rows exist. They are NOT Discovery pins and are outside
   ADR-095's cutover scope, but any future boot of those two DBs would hit
   the installer's fail-closed `PINNED_PACKAGE_SNAPSHOT_MISSING`. Recorded
   here so the fact is not lost; no action taken.

## Phase-1 exit criterion check

ADR-095: "zero nonterminal runs pinned to the legacy installation that lack a
retained installation row." **SATISFIED:** the machine's only nonterminal
Discovery pin (elite6-db run#1) has a retained `active` installation row
(id=1) whose store snapshot is present. All other nonterminal pins are
non-Discovery modules and out of this criterion's scope (caveat in finding 5).

## Existing-DB boot baseline capture

The Phase-1 boot baseline is machine-checked by
`tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs`
(hosted blocking in the matrix `process-modules` group; removal guard G2h in
`tests/infrastructure/acceptance-matrix-coverage.test.mjs`). Its fixture
reproduces the censused elite6-db run#1 shape (active 3.0.2 six-handler
installation + one `paused` pinned run) against the REAL engine install
chain (`installProductionModules`), proving: same-version six-to-one handler
drift = typed `MODULE_INSTALLATION_INCOMPATIBLE_DRIFT` refusal with the
existing DB truth untouched; the atomic module-version bump installs the
one-handler package while the legacy row stays retained and the pinned run
rehydrates its EXACT persisted legacy digest/snapshot from the
content-addressed store; and the drift guard stays armed at the bumped
version. Scope honesty: this is the in-process install-chain seam. The
spawned-engine exit-0 boot smoke on a real retired-installation DB remains
OPEN as the Phase-4 (ratchet 7) STOP-SHIP proof, not claimed here.

## Provenance note

The census scripts and JSON evidence live in a TEMPORARY directory and may
be reclaimed; this document is the durable transcription. Regeneration is
deterministic from the scripts above against the same 19 sources (read-only
copies). No numbers in this file were hand-entered from memory.
