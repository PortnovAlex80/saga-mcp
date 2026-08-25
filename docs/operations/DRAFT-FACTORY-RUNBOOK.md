# Factory Runbook — event-projected kernel (DRAFT for EK-10 landing)

> **Status: DRAFT** (WP-14, for the EK-10 landing). This is the **sole**
> operator runbook for the target protocol; it folds and replaces the legacy
> `ЗАВОД-ЗАПУСК.md`, `docs/INSTALL.md` and `docs/howto/AGENT-WORKER-MONITOR.md`
> (classified REWRITE in `docs/refactoring/event-kernel/DOCUMENT-DELETION-MANIFEST.md`).
> It describes the protocol that WP-05…WP-18 are building; until the EK-8 hard
> cutover the legacy instructions remain the operating truth for the legacy
> runtime. Architecture: `docs/architecture/WORKFLOW-KERNEL.md`. Diagnostics:
> `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`.

## 0. Operator laws (read first, always)

### OPENCODE ONLY — the claude CLI is retired (operator directive, 2026-08-20)

All factory workers and all agent tooling in this repo run through the
opencode transport. The claude code CLI is NEVER invoked directly, by any
agent, for any reason. The prohibition is enforced fail-closed in code: any
executor resolving to the claude CLI aborts the worker spawn with
`FACTORY_CLAUDE_BACKEND_FORBIDDEN`. There is no silent fallback — forgetting
the environment makes the first worker fail loudly instead of billing
Anthropic.

- ALWAYS set before any factory start/resume:

  ```powershell
  $env:SAGA_REAL_CLAUDE_PATH = "node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"
  $env:SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS = "1"
  ```

  (Git Bash: `export SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"` etc.)
  Never unset `SAGA_REAL_CLAUDE_PATH` — there is no claude fallback.

- NEVER touch, rewrite, patch, "restore" or re-pin `~/.claude/settings.json`.
  It is not ours. Its sha256 is a tripwire only: if it changes during a
  factory run, that is an **ABORT condition** — investigate, never edit it
  back. `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1` keeps model-switch APIs
  from rewriting it.

- In the target protocol every provider request goes through the instrumented
  OpenCode cognition transport whose admission call runs immediately before
  each network send, and every request leaves a `PromptAssemblyReceipt`
  (`admitted`/`refused`). An opaque, unaccounted `opencode run` loop is
  nonconforming. Hook-originated provider calls outside the accounted
  transport are forbidden.

### Qualification runs are immutable

During a qualifying run series: no source edits, no `dist` hot-swap, no
package byte changes, no manual SQL, no database/repository repair. A run
repaired by hand is diagnostic evidence, not a qualifying success. Operator
repair of a *live qualifying* run is forbidden; preservable evidence always
outranks a rescued run.

## 1. Prerequisites

- Node.js and npm per repo `package.json` engines; Windows production lane
  (Linux CI lane also supported by the test engine).
- `npm ci` in the repo root.
- `npm run build` — a clean `dist`; qualification drivers refuse a dirty or
  mismatched build.
- OpenCode installed and authenticated (Z.AI Coding Plan provider; auth at
  `~/.local/share/opencode/auth.json`). Smoke-test exactly the way the
  factory spawns workers before the first real run.
- Verify the three EK admission specifications are green:
  `npm run validate:ek-admission-specs` (blocking before any kernel run).

## 2. Fresh database start

The kernel is **fresh-protocol only**. There is no migration, backfill,
adoption or resume from a pre-cutover database, ever.

1. Choose a **new, empty database path** (e.g. `.factory-runs/<run-id>/factory.sqlite`).
2. Start the engine (UI or CLI path as below). On an empty path the runtime
   bootstraps one declarative schema and records `ProtocolMetadata`: the exact
   protocol identifier + schema fingerprint, immutable after creation.
3. `factoryRun.bootstrap` pins build/package digests;
   `factoryRun.importCapsule` imports a content-addressed Discovery+
   Formalization capsule through public ingress and verifies capsule,
   certificate, requirements, terminal claims, AC set, module package, build
   and base repository digests (`CapsuleIngressReceipt`). Capsules are never
   applied as raw SQLite snapshots and never seed authority rows directly.
4. `factoryRun.start` begins lifecycle progression.

Two start paths:

- **Frontend/board path:** start the tracker UI; the operator issues the start
  action, which translates into the same typed commands.
- **CLI/isolated path:** the qualification drivers
  (`npm run qualify:development`, `qualify:projects:scripted`,
  `qualify:projects:real` with `--kit <kit-manifest>`) provision fresh
  database/repository paths themselves and refuse reused paths.

## 3. Unsupported old databases (fail-closed behavior)

Any non-empty database that does not carry the exact current protocol
identifier and fingerprint fails to open with:

```text
FACTORY_DATABASE_PROTOCOL_UNSUPPORTED
```

together with an operator-facing instruction to choose a fresh database path.
Expected and required behavior:

- The file is **not mutated** (byte-for-byte unchanged after refusal).
- There is no reader, importer or migration path for old databases in
  production code. Do not attempt one; do not file a bug asking for one.
- Old databases may be preserved **offline** as incident evidence; copy them
  out of the run path if needed, and reference them from incident records,
  never from the runtime.
- The runtime never alters an existing schema. If the schema must change, the
  protocol identifier changes and a fresh database is required by design.

## 4. Stop and resume (durable commands)

Stop/resume are commands and evidence, never direct state edits:

- **Stop:** `factoryRun.requestStop` commits an `OperatorStopCommand` receipt;
  affected scopes enter `TypedWait:policy-quota` with the resume wake source.
  From the board, the Stop button issues the same command.
- **Resume:** `factoryRun.resume` discharges the wait. Completed work is not
  re-run: the obligation ledger, waits and proofs are the resume state. A
  stale lease redrives; an idempotent effect never double-applies.
- **Backoff/quota waits** wake on their own deadline obligations; they need no
  operator action unless the run was explicitly stopped.
- A **new intentional start** of the same project creates a new run identity
  (same project, new FactoryRun); it is not a resume.
- A **continuation** starts a new linked run from an exact accepted prefix
  after a terminal failure; the failed parent stays visible and healthy-
  looking parents are never fabricated.

## 5. Monitoring (from kernel evidence, not vibes)

- The board (Kanban) is a projection: useful for orientation, authoritative
  for nothing. If the board and the obligation ledger disagree, the ledger
  wins; rebuild the board.
- For "why is this not advancing", run the diagnostic explainer and read the
  incident card (`CONVEYOR-TRANSITION-DIAGNOSTICS.md`): obligation ledger
  excerpt, wait kind + wake source, attempt refs with role-contract digests
  and prompt-receipt ordinals, evidence refs, retry class, resume action.
- Worker streams/logs remain supporting telemetry: they explain what a model
  was doing; they never authorize or annul anything. Healthy worker = live
  lease + advancing receipts; sick worker = typed refusal/loss
  classification evidence, not prose.
- Watchdog observations (`factoryRun.observeWatchdog`) are durable evidence.
  Watchdogs never repair SQL.

## 6. Evidence and receipts

Where truth lives, in read-only order:

1. Aggregate heads at exact revisions (state).
2. `WorkflowEvent` journal (receipts, replay-verifiable offline).
3. Obligation ledger + completion receipts (progress).
4. Typed waits + wake discharges (outstanding conditions).
5. `PromptAssemblyReceipt`s + `ProviderRoutePin` per attempt (context
   admission and routing provenance).
6. Accepted-material chain: `WorkplaceProductionRevision` → CandidateSet →
   GateDecision → EffectReceipt → `CellFinalAcceptance`.
7. Terminal proofs (scoped, evidence-closed).

Qualification kits freeze: source SHA, clean `dist`, schema fingerprint,
installed package digests, scenario universe, actor version, complexity-budget
digest, role-contract manifest digest, PromptBudgetProfile digest, token
counter version, `admissionContractDigest` and the EK admission-receipt
digest. Raw evidence is stored under a build-addressed evidence root
**outside** the source checkout; a qualification run never dirties its tree.

## 7. Troubleshooting quick table

| Symptom | First check | Lawful fix |
|---|---|---|
| `FACTORY_DATABASE_PROTOCOL_UNSUPPORTED` on open | path pointed at an old/non-empty DB | choose a fresh empty path; preserve old DB offline if evidence-worthy |
| Nothing advancing | obligation ledger for the scope (runnable? leased? refused?) | follow the incident card's retry class; never manual SQL |
| Run stopped and won't wake | `OperatorStopCommand` present? | `factoryRun.resume` (operator command) |
| Provider requests refused | the attempt's `PromptAssemblyReceipt:refused` rows + envelope digest | fix the context source (bounded summary / content-addressed reference); never raise the cap by env var |
| Effect stuck "unknown" | `TypedWait:effect-uncertainty` | operator disposition command (D12); never blind retry |
| Board looks wrong | projection lag/corruption | rebuild the projection; authoritative trace must be unaffected |
| Worker died silently | lease/liveness evidence + `activityAttempt.classifyWorkerLoss` | typed loss handling; redrive is structural |
| Crash mid-run | fault-point semantics | restart the process; every crash window settles (success / typed wait / truthful terminal) |

## 8. What the operator must never do

- Edit factory tables, task states, card statuses or receipts by hand.
- Reuse a database or repository path across qualification runs.
- Bypass capsule ingress (copying rows between databases).
- Re-pin, patch or "restore" `~/.claude/settings.json`; invoke the claude CLI.
- Raise/zero out prompt limits to make a run pass; zero/missing never means
  unlimited.
- Repair a live qualifying run; preserve evidence and restart from a new
  immutable kit instead.
- Turn a blind retry on an uncertain external effect.

## Incident: tracker-view zombie respawn (2026-08-25)

**Симптом:** трекер на порту 4321 показывает старую БД; новые инстансы
умирают мгновенно; браузер мигает вкладками каждые 2-3 секунды.

**Корень:** auto-restart wrapper (`while true; do DB_PATH=<старый_путь>
node tracker-view.mjs; sleep 3; done`) пережил свою задачу и продолжал
респавнить трекер с зашитым старым путём к БД. Трекер имеет EADDRINUSE
handler (строки 534-544) который taskkill'ает держатель порта и
перебиндится — любой новый трекер с правильной БД убивался зомби.

**Правила:**
1. НИКОГДА не используйте while-true wrapper'ы для трекера — мёртвый
   трекер видим, воскрешающий зомби — нет.
2. Для смены БД: убейте процесс на порту, дождитесь освобождения,
   запустите с новым DB_PATH. Проверьте что процесс не respawn'ится.
3. `TRACKER_PORT` — no-op; порт читается из `PORT` (runtime-config:44).
4. Для запрета открытия вкладки браузера: `TRACKER_NO_BROWSER=1`.

**Правильный запуск:**
```bash
# убить старый
netstat -ano | grep ":4321.*LISTEN"  # найти PID
taskkill //F //PID <PID>
# запустить новый (единственный, без wrapper)
cd D:/Development/saga-mcp-SAGA4
TRACKER_NO_BROWSER=1 DB_PATH=D:/Development/<новый-ран>/factory.sqlite \
  PORT=4321 node tracker-view/tracker-view.mjs
```
