# Wave 5 — Workspace, Tracker, Call Instances, Agent Assistance Frozen Spec

> Frozen by the integrator on `e87809b` (Wave 4 checkpoint). Plan §0.8 / Phase 6.

## 0. Key findings
- `process-execution-workspace.ts` materializes tracker/templates from board/task concepts (epicId/taskId baked into paths). Wave 5 adds pinned-package resource resolution.
- `tracker-reminder.mjs` parses Markdown checkboxes via regex (C027 violation). Wave 5 replaces with structured hook reading `agent-assistance.json`.
- `claude-runner.mjs` grants hardcoded builtins, doesn't resolve reviewer skill separately (§13.17/§13.18). Wave 5 fixes.
- No CallInstance table exists. Wave 5 creates it.
- `AgentAssistanceDefinition` exists (Wave 1) but no renderer/snapshot. Wave 5 adds it.
- ProtocolRun (Wave 4) is the authoritative read model for tracker/assistance.

## 1. Lanes (8) — serial order: A2→A1→A3→A4→A5→A6→A7→A8

| Lane | Owns | Serial? |
|---|---|---|
| **W5-A1** | `application/workspace-projection.ts` (NEW: pinned package resource resolution + WorkspaceProjection from installation) | parallel |
| **W5-A2** (SQL OWNER) | `persistence/call-instance.ts` + `sqlite-call-instance-repository.ts` (NEW: saga3_call_instances table) + EDIT db.ts | parallel (SQL owner) |
| **W5-A3** | `application/tracker-renderer.ts` (NEW: deterministic TrackerRenderer from ProtocolRun state — replaces mutable templates, C027) | parallel |
| **W5-A4** | `application/agent-assistance-renderer.ts` (NEW: AgentAssistanceSnapshot from ProtocolRun + definition; modes/budgets/escaping/dedup, C031/C033) | parallel |
| **W5-A5** | `tracker-view/structured-context-hook.mjs` (NEW: replaces tracker-reminder.mjs; reads agent-assistance.json, C032/C033) | parallel |
| **W5-A6** | EDIT `tracker-view/claude-runner.mjs` (AgentLaunchSpec integration, reviewer skill resolution, package resources) | parallel |
| **W5-A7** | `application/capability-enforcement.ts` (NEW: separate agent builtins from MCP grants, C067) | parallel |
| **W5-A8** | Tests: workspace/call-crash/tracker-regen/hook-security/context-budget/weak-model | parallel (test-only) |

## 2. Schema (SQL owner = W5-A2)
```sql
CREATE TABLE IF NOT EXISTS saga3_call_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_run_id INTEGER NOT NULL REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
  protocol_run_id INTEGER REFERENCES saga3_protocol_runs(id) ON DELETE CASCADE,
  step_id TEXT,
  tool_contract_ref TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  workspace_path TEXT,
  draft_content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'materialized' CHECK (status IN ('materialized','edited','validated','submitted','succeeded','failed','sealed','abandoned')),
  last_error_json TEXT,
  successful_receipt_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sealed_at TEXT
);
```
Dual-placement in db.ts (mirror Wave 2-4 pattern).

## 3. Exit gate (§0.8.12)
1. Build green. 2. Tracker regenerates from ProtocolRun state (C027). 3. agent-assistance.json from authoritative state (C031). 4. CallInstance: materialize→edited→validated→submitted→succeeded→sealed; failed drafts preserved (C028-C030). 5. Context hook reads structured file, bounded+deduped (C032/C033). 6. Reviewer skill resolved separately (§13.18). 7. Builtins separated from MCP grants (C067). 8. Ratchet green. 9. Wave 0-4 regression green.

## 4. Anti-scope
- No ProtocolRun changes (Wave 4 owns).
- No module migration (Wave 8/9).
- Legacy tracker-reminder.mjs stays as fallback until Wave 5 gate passes.
