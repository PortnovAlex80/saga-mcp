# Wave 4 — Protocol & Universal Recovery Frozen Contract Spec

> Frozen by the integrator (serial precondition, plan §0.7.2) on `a46d3ea` (Wave 3 checkpoint).

## 0. Reconnaissance (HEAD `a46d3ea`)

- **RecoveryCase system EXISTS**: `sqlite-recovery-case-repository.ts` (recordIssue/resolveActive/readActive), `RecoveryCaseRecord`/`RecoveryAttemptRecord` with UNIQUE indexes. `generic-flow-executor.ts` recovery loop (`reconcileRecoveryCheckpoint` :822-909) already wires issues→cases→feedback. Wave 4 BUILDS ON this, doesn't replace it.
- **`RecoveryAction` union** (7 values, §8.10) defined in `domain/spi/recovery-definitions.ts` but NOT wired — executor uses `RecoveryDisposition` + `onExhausted` instead. Wave 4 connects `RecoveryAction` to the routing.
- **ProtocolRun/ProtocolStepRun tables ABSENT** — Wave 4 creates them.
- **NodeProtocolDefinition** types exist (Wave 1) — Wave 4 consumes them at runtime.
- **exact-candidate-acceptance** (§13.23) already bridges to recovery via `result.recoveryIssue` — Wave 4 preserves this.
- **Ratchet**: `application/` → `persistence/` ports allowed; `application/` → `domain/spi/` allowed; no friction for new ProtocolRun files.

## 1. Ownership lanes (8)

| Lane | Owns | Serial? |
|---|---|---|
| **W4-A1** (SQL OWNER) | `persistence/protocol-run.ts` (port+types) + `persistence/sqlite-protocol-run-repository.ts` (adapter: `saga3_protocol_runs` + `saga3_protocol_step_runs` tables) + EDIT `db.ts` | parallel (SQL owner) |
| **W4-A2** | `application/protocol-runtime.ts` (NEW: pure transition state machine — step start, evidence check, completion, retry, pause, resume, recovery transitions) | parallel |
| **W4-A3** | `application/protocol-evidence.ts` (NEW: standard evidence categories, package verifier binding, before-complete gates, `verifyStepEvidence()`) | parallel |
| **W4-A4** | `application/recovery-engine.ts` (NEW: generic RecoveryIssue→RecoveryAction→RecoveryFeedback mapper; uses `RecoveryAction` union from Wave 1 SPI; wires to existing RecoveryCaseRepository) | parallel |
| **W4-A5** | `application/protocol-checkpoint-service.ts` (NEW: generic protocol checkpoint application service + tool contribution for step completion) | parallel |
| **W4-A6** | `application/protocol-authority.ts` (NEW: per-step authority intersection + stale-state rejection) | parallel |
| **W4-A7** | NEW tests: branch/repeat/retry/pause/resume/illegal-transition/crash protocol tests | parallel (test-only) |
| **W4-A8** | NEW tests: recovery conformance across two unrelated modules (producer reentry, human action, escalation, exhaustion, restart) | parallel (test-only) |

## 2. Schema changes (single SQL owner = W4-A1)

NEW tables (ADDITIVE, idempotent `ensure…Schema`):
```sql
CREATE TABLE IF NOT EXISTS saga3_protocol_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_run_id INTEGER NOT NULL REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
  node_run_id INTEGER REFERENCES saga3_node_runs(id) ON DELETE CASCADE,
  node_protocol_id TEXT NOT NULL,
  node_protocol_version TEXT NOT NULL,
  entry_step TEXT NOT NULL,
  current_step TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','failed','abandoned')),
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE UNIQUE INDEX idx_saga3_protocol_runs_active ON saga3_protocol_runs(process_run_id, node_protocol_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS saga3_protocol_step_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol_run_id INTEGER NOT NULL REFERENCES saga3_protocol_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','skipped','failed')),
  evidence_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(protocol_run_id, step_id, attempt)
);
```
Dual-placement in `db.ts` (guarded `tableExists`) + `ensureSaga3ProtocolRunSchema(db)` — mirror Wave 2/3 pattern.

## 3. Exit gate (plan §0.7.11)
1. Build green.
2. ProtocolRun/ProtocolStepRun persist; step transitions (start→in_progress→completed) work.
3. Evidence verified before step advance (§8.4/C026).
4. RecoveryIssue→RecoveryAction→RecoveryFeedback mapping works for all 7 actions.
5. Crash-resume: protocol resumes at exact last incomplete step (§0.7.11).
6. Required evidence CANNOT be skipped.
7. One recovery engine repairs two unrelated synthetic modules (§0.7.11).
8. Ratchet green. Wave 0-3 regression green.

## 4. Anti-scope
- No CallInstance (Wave 5).
- No tracker/hook changes (Wave 5).
- No module migration (Wave 8/9).
- No removal of existing RecoveryCase system (Wave 4 adds ProtocolRun on top; existing recovery loop preserved).
- `generic-flow-executor.ts` MAY be edited to wire ProtocolRuntime into the node execution path — but ONLY additively (feature-detect, dual-path, legacy fallback).
