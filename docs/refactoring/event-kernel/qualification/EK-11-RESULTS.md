# EK-11 Scripted Fresh-Project Qualification — WP-15 Results

Status: **EXECUTED 2026-08-26 (WP-15 run operator)** — development reliability
10/10 GREEN, scripted product diversity 20/20 GREEN, concurrency Proof A
GREEN / Proof B **RED with a recorded kernel finding** (per the EK-11 law:
findings are recorded with evidence, never hacked around; the coordinator
repairs and re-runs).

## The immutable kit

| | |
|---|---|
| kitId | `ae7c306977977cd47b1bf353831573b000a4cf71612e5fae2fc7e24e21203893` |
| manifest | `docs/refactoring/event-kernel/qualification/kits/ae7c306977977cd47b1bf353831573b000a4cf71612e5fae2fc7e24e21203893.json` |
| source HEAD | `732e59cc60eaeceb72197e0c226fa7f514e9c228` |
| dist | 390 files, tree `26b954e32c91…` |
| schema fingerprint | `c53efa8f284c…` (protocol `ek.factory.workflow-kernel`, schema v1) |
| universe digest | `92751dedf814…` (53 commands) |
| actor version | `0563af342f32…` |
| complexity-budget / role-contract-manifest / PromptBudgetProfile / token-counter digests | in the kit manifest (all verified per driver start) |
| admissionContractDigest | `d1f9272c330f…` (recomputed, formula-identical to `npm run validate:ek-admission-specs`) |
| EK admission-receipt digest | `7635a4bdc0f9…` (preserved file digest of `EK-ADMISSION-RECEIPT.json`) |
| installed packages | `better-sqlite3` (per-package digests in the kit) |
| seed | 20260826 |
| environment | Windows (win32 x64), Node v24.13.1, npm 11.8.0 (full block in the kit) |

The kit is content-addressed (`kitId = sha256(canonical(core))`); every
driver start re-verifies every digest and refuses with a typed drift list
(git-head / dist / schema / universe / actor / budget / counter / admission /
packages / capsule / scenario-universe / kit-id). Kit manifests under
`qualification/kits/` are the only untracked artefacts the clean-tree fence
tolerates (the build-receipt rule).

## Development reliability series — 10/10 GREEN

Command: `npm run qualify:development -- --kit <kit> --series dev-ek11-final`

Ten runs of the canonical simple served product: ten FRESH database paths +
ten FRESH product repositories, one immutable build + one capsule (digest
pinned to the kit), import through the PUBLIC ingress, scripted actor (the
WP-08 material chain), the WP-08 acceptance layer (build + real server start
+ `GET /healthz` + `GET /api/message` + the browser smoke hook) executed in
each run's own product repository, no manual stop/resume/SQL/patch.

| run | result | checks | trace |
|---|---|---|---|
| run-01..run-10 | GREEN | 9/9 each | identical |

- 10/10 terminal successes (`TerminalProof:run.success`).
- IDENTICAL normalized authority traces: one fingerprint
  `da16236f3704…` across all ten runs.
- Receipt-completeness law green in every run: every WorkIntent (each
  ActivityAttempt's owner) carries its pinned role-contract digest; admitted
  PromptAssemblyReceipts cover the provider-sent attempts; exactly one run
  terminal.

Evidence: `D:/Development/ek-qual-evidence/ae7c3069…/dev-ek11-final/`
(journal, receipts, normalized trace, checks, product repository + kernel DB
per run; per-run `run.json`).
**Series evidence manifest digest: `c9df4a3177683b1b182e11b6d02d35f22b8f6de959087639f133d6ac3493dc24`.**

## Twenty-project scripted corpus — 20/20 GREEN

Command: `npm run qualify:projects:scripted -- --kit <kit> --all --series projects-ek11-final`

Every project ran from fresh paths through the production composition +
scripted cognition actor (the EK-9 corpus engines, wrapped), with ACTUAL
PRODUCT OUTPUT verification per plan kind in a fresh product repository
(build/test/start evidence per kind; browser smoke for browser products;
API/CLI smoke otherwise; local Delivery/package effect receipts), plus the
receipt-completeness law (kind-aware: the honest-refusal / pending-
disposition / human-decision oracles legitimately carry no run terminal).

| plan | corpus project | kind | product evidence | kernel checks | result |
|---|---|---|---|---|---|
| P01 | p01-served-happy | served hello (frontend/API) | build+test+api+browser-smoke+package+determinism (+WP-08 acceptance layer) | 8/8 | GREEN |
| P02 | p02-static-product | static browser counter | build+browser-smoke+package+determinism | 7/7 | GREEN |
| P03 | p03-served-repair | CLI text statistics | build+cli-smoke+package+determinism | 11/11 | GREEN |
| P04 | p04-batch-pipeline | validation library | build+test+cli-smoke+package | 8/8 | GREEN |
| P05 | p05-scheduled-independent | todo CRUD web app | build+test+api+browser-smoke+package+persistence | 8/8 | GREEN |
| P06 | p06-autonomous-ladder | CSV→JSON CLI | build+cli-smoke+package+determinism | 11/11 | GREEN |
| P07 | p07-autonomous-worker-loss | webhook receiver | build+api-smoke+package+persistence | 10/10 | GREEN |
| P08 | p08-cross-module-seams | markdown doc site | build+browser-smoke+package+determinism | 7/7 | GREEN |
| P09 | p09-chain-topology | file-backed notes HTTP service | build+test+api+browser-smoke+package+persistence | 5/5 | GREEN |
| P10 | p10-diamond-topology | job-queue simulator | build+cli-smoke+package+determinism | 7/7 | GREEN |
| P11 | p11-fan-in-topology | read-only metrics dashboard | build+api+browser-smoke+package | 7/7 | GREEN |
| P12 | p12-fan-out-topology | JSON-Schema validator package | build+test+cli-smoke+package | 6/6 | GREEN |
| P13 | p13-independent-topology | SQLite inventory app (node:sqlite) | build+test+api-smoke+package+persistence | 8/8 | GREEN |
| P14 | p14-honest-refusal | multi-module event processor | build+test+cli-smoke+package+determinism | 8/8 | GREEN |
| P15 | p15-failed-predecessor | REST service + operator frontend | build+api+browser-smoke+package | 7/7 | GREEN |
| P16 | p16-human-wait-operator | local release packager (idempotent receipt) | build+cli-smoke+package | 11/11 | GREEN |
| P17 | p17-effect-uncertainty | config linter (machine-readable) | build+cli-smoke+package | 9/9 | GREEN |
| P18 | p18-restart-matrix | import/export with recovery | build+api-smoke+package+persistence+recovery | 11/11 | GREEN |
| P19 | p19-projection-faults | canvas game (keyboard, browser) | build+test+browser-smoke+package | 11/11 | GREEN |
| P20 | p20-idempotent-replay | full-stack expense tracker | build+test+api+browser-smoke+package+persistence | 13/13 | GREEN |

Evidence: `D:/Development/ek-qual-evidence/ae7c3069…/projects-ek11-final/`
(per project: journal, normalized trace, receipts, checks, product-steps,
delivery receipt, the run's fresh product repository).
**Series evidence manifest digest: `f615cd45071048339bfc7f2a30ea95e5a7454fedbe6209a82c00b307ad66b8a2`.**

## Concurrency proofs — Proof A GREEN, Proof B RED (kernel finding)

Command: `npm run qualify:concurrency -- --kit <kit> --series concurrency-ek11-final`

### Proof A — four independent projects concurrently: 20/20 checks GREEN

p01 (development-vertical + real served product), p09 (conveyor), p16
(durable + operator disposition), p19 (durable + fault scheduler) ran as
four REAL concurrent child processes with isolated per-child temp roots
(every fresh database under its own run's tree):

- all four green in their own processes (four distinct pids);
- every concurrent normalized world EQUALS its serial reference world
  (determinism under real parallelism — and the no-leak oracle: a foreign
  identity/material row would change the world);
- isolated, pairwise-disjoint database roots; no sibling identity in any
  world;
- recorded (not assumed): evidence refs are per-database local ids
  (numbered from #1 in every fresh database), so the leak oracle is world
  equality + isolated roots.

### Proof B — within-project diamond at cap 2, deterministic barrier: 5/7 GREEN, RED overall

GREEN (world state, no timing assertions):

- `diamond-barrier-peak-2`: at the deterministic barrier (b via the flow
  lane + c via the public `instantiateDependantWorkplaces` lane, both
  materialized, neither desk run) the open-workplace count is exactly 2.
- `diamond-peak-equals-cap`: the observed open-workplace peak over the whole
  drive is exactly 2.
- `diamond-desks-from-barrier`: BOTH successor desks completed from the
  barrier state — the material chains of two concurrently-open workplaces
  both ran to accepted gates.
- `diamond-settle-first-successor`: the flow-lane successor settled its cell.
- `diamond-sequential-cap1-green`: the same topology driven cell-by-cell
  (cap 1) settles fully green — the finding isolates exactly the cap-2
  settlement, not the topology.

RED — **KERNEL FINDING `EK11-CONCURRENCY-DIAMOND-SETTLEMENT`**:

> The ProcessRun lifecycle admits only one in-flight node settlement. After
> the first successor's node terminal, `processRun.recordNodeTerminal` has
> no legal edge from status `node-terminal-recorded`, so the concurrently
> materialized dependant cell cannot complete its cell settlement through
> public commands, and the run success terminal is unreachable from the
> concurrent barrier state. The stock conveyor drive therefore linearizes
> every topology (the diamond — and even the independent topology whose
> declared cap is 2 — run cell-by-cell; the corpus p10 diamond descriptor
> declares concurrencyCap 1, p13 independent declares 2 but the drive is
> sequential).

Full finding record with the typed refusal, the open-cell series and the
repair hint: `…/concurrency-ek11-final/proof-b.json` (`finding`).
Per the EK-11 law this proof STOPPED at the finding; the kernel owner
(coordinator) repairs and re-runs this one proof.

Evidence root: `D:/Development/ek-qual-evidence/ae7c3069…/concurrency-ek11-final/`
**Series evidence manifest digest: `683ad14e8993aa5c6b592a511713dee855715430d768a5fb7ed68700589c2f3c`.**

## RED/GREEN fence proofs (npm run qualify:proof — 32/32 GREEN)

- dirty-tree fence: clean sandbox GREEN; untracked qualification docs stay
  ignorable; a modified tracked file / a foreign untracked file REFUSE
  (`QUALIFY_DIRTY_TREE`).
- dist fence: identical tree GREEN; mutated/added/removed dist files REFUSE
  with the named drift (`QUALIFY_DIST_MISMATCH`).
- fresh-path fence: new path GREEN; a reused path REFUSES
  (`QUALIFY_PATH_NOT_FRESH`).
- kit fence: the kitId is the content address (any edit breaks it); a live
  frozen kit verifies green only against its own tree, and a stale kit
  REFUSED live during the series (`QUALIFY_KIT_DRIFT [git-head]` — observed
  and recorded in the session log).
- evidence seal: the manifest hashes every evidence file, never its own
  bytes.
- plan-table alignment: the twenty corpus projects map 1:1 onto P01..P20;
  every fixture exists with build/smoke/packaging surfaces; browser kinds
  demand browser smoke, non-browser kinds demand api/cli smoke.
- product families: every distinct (fixture, profile) pair used by the
  twenty kinds verifies green in a fresh staged repository.

## EK-12 real-series prewire — PREWIRED, fences GREEN, NOT executed

Command: `npm run qualify:projects:real -- --kit <kit> --series R1,R2,R3`

Fences verified green: route pin (zai/glm-4.7 via the opencode shim,
catalog-2026-08-24) present in the frozen provider-model limit table; the
PromptBudgetProfile for that exact model positive-finite on every bound
(runtime digest `5648ae361d8c…`); the transport pre-send receipt surface
(`createAdmittingTransport` + `exposesMidLoopRequests` — initial-stdin/
postflight-only observability would refuse); `SAGA_REAL_CLAUDE_PATH` pinned
to the opencode shim (the claude CLI is never invoked);
`SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`; the `~/.claude/settings.json`
tripwire recorded read-only (sha256 `2d6176e8d138…` — verified, never
edited). R1/R2/R3 descriptors (served API / CLI-library with tests /
full-stack CRUD + persistence + browser smoke) and their fresh DB+repo
paths are pre-provisioned per run; evidence is preserved on failure. The
driver refuses to execute without `--execute` (the coordinator owns EK-12
execution).

Prewire evidence:
`D:/Development/ek-qual-evidence/ae7c3069…/real-20260826034604/prewire.json`.

## Honest history

Earlier kits recorded during bring-up (each superseded by a new immutable
kit after driver fixes, per the immutability law): `1320097b…` (first
freeze; dev series 10/10 RED on the pin check reading
`roleContractDigest`), `034ae797…` (dev 10/10 GREEN; projects series 8/20 —
driver-side fixes recorded in the series records), `eaa86b08…` (dev 10/10 +
projects 20/20 GREEN; concurrency driver fix). All series records and
evidence roots are preserved under their own kit directories in
`D:/Development/ek-qual-evidence/`.
