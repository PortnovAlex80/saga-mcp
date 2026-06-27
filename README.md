# saga-mcp

[![IdeaCred](https://ideacred.com/api/badge/spranab/saga-mcp)](https://ideacred.com/profile/spranab/saga-mcp)

A Jira-like project tracker MCP server for AI agents. SQLite-backed, per-project scoped, with full hierarchy and activity logging — so LLMs never lose track.

**No more scattered markdown files.** saga-mcp gives your AI assistant a structured database to track projects, epics, tasks, subtasks, notes, and decisions across sessions.

---

> ## 🍴 This is a fork
>
> Fork of [spranab/saga-mcp](https://github.com/spranab/saga-mcp) at **`PortnovAlex80/saga-mcp`**. The base 31 tools are **unchanged**. This fork adds a **dispatcher** — two extra MCP tools (`worker_next`, `worker_done`) that let saga itself **hand out tasks to AI agents** instead of an agent polling. It ships with three ZCode skills that teach agents how to work the queue.
>
> **If you just want vanilla saga-mcp**, use [the upstream](https://github.com/spranab/saga-mcp) (`npx -y saga-mcp`). Everything below the line is upstream docs.

---

## Features

- **Full hierarchy**: Projects > Epics > Tasks > Subtasks
- **Task dependencies**: Express sequencing with auto-block/unblock when deps are met
- **Comments**: Threaded discussions on tasks — leave breadcrumbs across sessions
- **Templates**: Reusable task sets with `{variable}` substitution
- **Dashboard**: One tool call gives full overview with natural language summary
- **SQLite**: Self-contained `.tracker.db` file per project — zero setup, no external database
- **Activity log**: Every mutation is automatically tracked with old/new values
- **Notes system**: Decisions, context, meeting notes, blockers — all searchable
- **Batch operations**: Create multiple subtasks or update multiple tasks in one call
- **31 focused tools**: With MCP safety annotations on every tool
- **Import/export**: Full project backup and migration as JSON (with dependencies and comments)
- **Source references**: Link tasks to specific code locations
- **Auto time tracking**: Hours computed automatically from activity log
- **Cross-platform**: Works on macOS, Windows, and Linux

## 🚀 Fork: install from scratch (new machine)

This fork runs **from a local build** (not via `npx`), so your edits to `src/` take effect on the next `npm run build` + restart. Total setup ≈ 5 minutes.

### Prerequisites

- **Node.js 18+** (for `better-sqlite3` native build) and **npm**
- **Git**
- **ZCode** (or any MCP-capable client) — for the skills to apply, you'll be running agents in it

### Step 1 — clone & build

```bash
git clone https://github.com/PortnovAlex80/saga-mcp.git
cd saga-mcp
npm install        # builds better-sqlite3 native module
npm run build      # tsc -> dist/
```

Verify the build:
```bash
ls dist/index.js dist/tools/dispatcher.js    # both must exist
DB_PATH=./smoke.db node dist/index.js        # should print: Tracker MCP Server running on stdio
```
(Ctrl-C to stop; delete `smoke.db*` after.)

### Step 2 — register in ZCode

Edit `~/.zcode/cli/config.json` and point the `saga` server at the **local build** (not `npx`):

```json
{
  "mcp": {
    "servers": {
      "saga": {
        "type": "stdio",
        "command": "node",
        "args": ["D:/Development/saga-mcp/dist/index.js"],
        "env": { "DB_PATH": "C:/Users/<you>/.zcode/saga.db" }
      }
    }
  }
}
```

> **Path note:** use your real clone path in `args`. `DB_PATH` is the SQLite file — pick **one** location and keep it; all projects live in this single DB (see "Multi-project" in the tracker skill). The file + schema auto-create on first run.

Restart ZCode. After restart, `worker_next` / `worker_done` appear alongside the 31 base tools.

### Step 3 — install the skills

Copy the three skills from this repo into ZCode's skills directory so agents pick them up:

```bash
# Windows / Git Bash
cp -r skills/* ~/.zcode/skills/

# macOS / Linux
cp -r skills/* ~/.zcode/skills/
```

The skills:
| Skill | When the agent uses it |
|---|---|
| **saga-tracker** | Working with tasks/projects/epics directly (planning, triage, resuming). The base skill for any saga work. |
| **saga-developer** | The dispatcher returned `skill: "saga-developer"` — agent is the **implementer** on a task taken from `todo`. |
| **saga-reviewer** | The dispatcher returned `skill: "saga-reviewer"` — agent is the **reviewer** on a task taken from `review`. |

Restart ZCode again so it sees the new skills.

### Step 4 — smoke test the dispatcher

The dispatcher scopes work by **project**. Each project folder carries its identity in a `projectname.txt` file at its root (one line = the exact saga project name). The worker resolves that name to a `project_id` once, then uses it on every call.

In any ZCode window, from a folder that has a `projectname.txt`:
```
mcp__saga__project_resolve_by_name({ name: "<contents of ./projectname.txt>" })
  # → { project_id: 2, created: false, project: {...} }

mcp__saga__worker_next({ worker_id: "smoke", project_id: 2 })
  # → returns a task (or {task: null} if the project queue is empty) + skill
```
To undo the claim (don't leave a smoke task assigned):
```
mcp__saga__task_update({ id: <returned id>, status: "todo", assigned_to: "" })
```

If you got a task back, you're done. ✅

### `projectname.txt` (project identity convention)

Because one shared saga DB holds many projects, a worker must know which project is "its" — without relying on agent memory. The convention:

- Create `./projectname.txt` in each project root, containing one line: the exact saga project name.
- Agents read it once, resolve via `project_resolve_by_name`, and pass the resulting `project_id` to `worker_next`.
- Multiple agents in the same folder read the same file → same project. Restarts and context loss don't matter.
- `worker_next` requires `project_id` (with existence validation) — a worker literally cannot be handed another project's task.
- **Low-priority tasks are not dispatched.** `worker_next` only returns `critical`/`high`/`medium`. A `low` task sits in `todo` until a human raises its priority (then it enters the queue) or it's picked up manually. This keeps the worker fleet on work that matters.

### Running the worker fleet (the actual use case)

Open **N agent windows** in ZCode (e.g. 3) — all in the same project folder — and give each the same prompt with its own id:

```
You are a saga worker. Your worker_id is "agent-1".
Project identity lives in ./projectname.txt — do not trust your memory for the project.
1. Read ./projectname.txt, then call
   mcp__saga__project_resolve_by_name({ name: "<contents>" })  →  note project_id.
2. Loop:
   a. mcp__saga__worker_next({ worker_id: "agent-1", project_id: <from step 1> }).
   b. If task is null → say "queue empty" and stop.
   c. Otherwise: apply the skill named in the response (saga-developer or saga-reviewer),
      do the work, then call
      mcp__saga__worker_done({ task_id, worker_id: "agent-1", result: "..." }).
   d. The response carries the next task — repeat from 2b.
```

Watch the board (your `saga.db` via any viewer) from your phone. The dispatcher guarantees no two agents grab the same task (see `tests/dispatcher-race/`), and `project_id` scoping guarantees they only touch this project.

### Updating the fork later

```bash
cd saga-mcp
git pull
npm install        # if deps changed
npm run build
# restart ZCode
```

---



### With Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "saga": {
      "command": "npx",
      "args": ["-y", "saga-mcp"],
      "env": {
        "DB_PATH": "/absolute/path/to/your/project/.tracker.db"
      }
    }
  }
}
```

### With Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "saga": {
      "command": "npx",
      "args": ["-y", "saga-mcp"],
      "env": {
        "DB_PATH": "/absolute/path/to/your/project/.tracker.db"
      }
    }
  }
}
```

### Manual install

```bash
npm install -g saga-mcp
DB_PATH=./my-project/.tracker.db saga-mcp
```

## Configuration

saga-mcp requires a single environment variable:

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | Yes | Absolute path to the `.tracker.db` SQLite file. The file and schema are auto-created on first use. |

No API keys, no accounts, no external services. Everything is stored locally in the SQLite file you specify.

## Tools

### Getting Started

| Tool | Description | Annotations |
|------|-------------|-------------|
| `tracker_init` | Initialize tracker and create first project | `readOnly: false`, `idempotent: true` |
| `tracker_dashboard` | Full project overview with natural language summary | `readOnly: true` |

### Projects

| Tool | Description | Annotations |
|------|-------------|-------------|
| `project_create` | Create a new project | `readOnly: false` |
| `project_list` | List projects with completion stats | `readOnly: true` |
| `project_update` | Update project (archive to soft-delete) | `readOnly: false`, `idempotent: true` |

### Epics

| Tool | Description | Annotations |
|------|-------------|-------------|
| `epic_create` | Create an epic within a project | `readOnly: false` |
| `epic_list` | List epics with task counts | `readOnly: true` |
| `epic_update` | Update an epic | `readOnly: false`, `idempotent: true` |

### Tasks

| Tool | Description | Annotations |
|------|-------------|-------------|
| `task_create` | Create a task with optional dependencies | `readOnly: false` |
| `task_list` | List/filter tasks with dependency info | `readOnly: true` |
| `task_get` | Get task with subtasks, notes, comments, and dependencies | `readOnly: true` |
| `task_update` | Update task (auto-logs, auto-blocks/unblocks) | `readOnly: false`, `idempotent: true` |
| `task_batch_update` | Update multiple tasks at once | `readOnly: false`, `idempotent: true` |

### Subtasks

| Tool | Description | Annotations |
|------|-------------|-------------|
| `subtask_create` | Create subtask(s) — supports batch | `readOnly: false` |
| `subtask_update` | Update subtask title/status | `readOnly: false`, `idempotent: true` |
| `subtask_delete` | Delete subtask(s) — supports batch | `destructive: true`, `idempotent: true` |

### Comments

| Tool | Description | Annotations |
|------|-------------|-------------|
| `comment_add` | Add a comment to a task (threaded discussion) | `readOnly: false` |
| `comment_list` | List all comments on a task | `readOnly: true` |

### Templates

| Tool | Description | Annotations |
|------|-------------|-------------|
| `template_create` | Create a reusable task template with `{variable}` placeholders | `readOnly: false` |
| `template_list` | List available templates | `readOnly: true` |
| `template_apply` | Apply template to create tasks with variable substitution | `readOnly: false` |
| `template_delete` | Delete a template | `destructive: true`, `idempotent: true` |

### Notes

| Tool | Description | Annotations |
|------|-------------|-------------|
| `note_save` | Create or update a note (upsert) | `readOnly: false` |
| `note_list` | List notes with filters | `readOnly: true` |
| `note_search` | Full-text search across notes | `readOnly: true` |
| `note_delete` | Delete a note | `destructive: true`, `idempotent: true` |

### Intelligence

| Tool | Description | Annotations |
|------|-------------|-------------|
| `tracker_search` | Cross-entity search (projects, epics, tasks, notes) | `readOnly: true` |
| `activity_log` | View change history with filters | `readOnly: true` |
| `tracker_session_diff` | Show what changed since a given timestamp — call at session start | `readOnly: true` |

### Dispatcher (fork only)

| Tool | Description | Annotations |
|------|-------------|-------------|
| `worker_next` | Claim the next free task (`todo` or `review`, unassigned, deps met, **priority medium+**) atomically; returns the task + the skill the agent should use. **Low-priority tasks are NOT handed out** — raise their priority to medium+ to make them claimable | `readOnly: false` |
| `worker_done` | Complete the held task (`in_progress`→`review`, `review`→`done`, frees the assignment, records `result` as a comment, auto-unblocks downstream on `done`) and return the next task | `readOnly: false` |

**How the dispatcher hands out work** (fork only):

```
worker_next({worker_id})          →  { task, skill: "saga-developer" | "saga-reviewer" }   (or { task: null })
worker_done({task_id, worker_id, result})  →  { completed, completed_new_status, next_task, next_skill }
```

- `assigned_to` (native saga field) is the occupancy flag — a task is in the queue only if `status IN ('todo','review') AND assigned_to IS NULL`.
- The **review cycle never enters `in_progress`**: a task taken from `review` keeps its status and only gets `assigned_to` set, so `worker_done` knows which cycle it's in by the current status.
- Race-safety: each call runs under an explicit `BEGIN IMMEDIATE` transaction plus a conditional `UPDATE ... WHERE status=? AND assigned_to IS NULL` checked via `info.changes === 1`. Multi-process stress test in `tests/dispatcher-race/`.

### Import / Export

| Tool | Description | Annotations |
|------|-------------|-------------|
| `tracker_export` | Export full project as nested JSON (includes dependencies and comments) | `readOnly: true` |
| `tracker_import` | Import project from JSON (matching export format) | `readOnly: false` |

## Usage Examples

### Example 1: Starting a project with dependencies

**User prompt:** "Set up tracking for my new e-commerce API project"

**Tool calls:**
```
tracker_init({ project_name: "E-Commerce API", project_description: "REST API for online store" })
epic_create({ project_id: 1, name: "Authentication", priority: "high" })
task_create({ epic_id: 1, title: "Design auth schema", priority: "critical" })
task_create({ epic_id: 1, title: "Implement JWT auth", priority: "high", depends_on: [1] })
task_create({ epic_id: 1, title: "Add OAuth2 Google login", priority: "medium", depends_on: [2] })
```

**Result:** Task 2 and 3 are auto-blocked because their dependencies aren't done yet. When task 1 is marked done, task 2 auto-unblocks.

### Example 2: Resuming work with dashboard summary

**Tool calls:**
```
tracker_dashboard({})
```

**Response includes a natural language summary:**
```
"E-Commerce API: 5 tasks across 2 epics. 40% complete. Active: Authentication (2/3 done). Next up: Product Catalog (2 tasks). 1 blocked task(s)."
```

Plus the full structured data (stats, epics, blocked tasks, overdue tasks, activity, notes).

### Example 3: Using templates for repeated workflows

**Create a template:**
```
template_create({
  name: "feature_workflow",
  description: "Standard feature implementation",
  tasks: [
    { "title": "Design {feature} API", "priority": "critical", "estimated_hours": 2 },
    { "title": "Implement {feature}", "priority": "high", "estimated_hours": 8 },
    { "title": "Write tests for {feature}", "priority": "high", "estimated_hours": 4 },
    { "title": "Document {feature}", "priority": "medium", "estimated_hours": 1 }
  ]
})
```

**Apply it:**
```
template_apply({ template_id: 1, epic_id: 2, variables: { "feature": "user auth" } })
```

Creates 4 tasks: "Design user auth API", "Implement user auth", "Write tests for user auth", "Document user auth".

### Example 4: Task comments as decision trail

```
comment_add({ task_id: 5, content: "Investigated root cause: CORS headers missing on preflight" })
comment_add({ task_id: 5, content: "Fixed by adding OPTIONS handler. Tested with curl." })
task_update({ id: 5, status: "done" })
```

Comments persist across sessions — next time an agent calls `task_get(5)`, it sees the full discussion thread.

## How It Works

saga-mcp stores everything in a single SQLite file (`.tracker.db`) per project. The database is auto-created on first use with all tables and indexes — no migration step needed.

### Hierarchy

```
Project
  └── Epic (feature/workstream)
        └── Task (unit of work)
              ├── Subtask (checklist item)
              ├── Comment (discussion thread)
              └── Dependencies (blocked by other tasks)
```

### Task Dependencies

Tasks can depend on other tasks. When you set `depends_on: [2, 3]` on a task:
- The task is auto-blocked if any dependency isn't `done`
- When a dependency is marked `done`, downstream tasks are re-evaluated
- If all dependencies are met, the blocked task auto-unblocks to `todo`

### Note Types

Notes replace scattered markdown files. Each note has a type:

| Type | Use case |
|------|----------|
| `general` | Free-form notes |
| `decision` | Architecture/design decisions |
| `context` | Conversation context for future sessions |
| `meeting` | Meeting notes |
| `technical` | Technical details, specs |
| `blocker` | Blockers and issues |
| `progress` | Progress updates |
| `release` | Release notes |

### Activity Log

Every create, update, and delete is automatically recorded:

```json
{
  "summary": "Task 'Fix CORS issue' status: blocked -> done",
  "action": "status_changed",
  "entity_type": "task",
  "entity_id": 15,
  "field_name": "status",
  "old_value": "blocked",
  "new_value": "done",
  "created_at": "2026-02-21T18:30:00"
}
```

## Privacy Policy

saga-mcp is a fully local, offline tool. It does **not**:

- Collect any user data
- Send any data to external servers
- Require internet access after installation
- Use analytics, telemetry, or tracking of any kind

All data is stored exclusively in the local SQLite file specified by `DB_PATH`. You own your data completely. Uninstalling saga-mcp and deleting the `.tracker.db` file removes all traces.

For questions about privacy, open an issue at https://github.com/spranab/saga-mcp/issues.

## Development

```bash
git clone https://github.com/spranab/saga-mcp.git
cd saga-mcp
npm install
npm run build
DB_PATH=./test.db npm start
```

## Support

- **Issues**: https://github.com/spranab/saga-mcp/issues
- **Repository**: https://github.com/spranab/saga-mcp

## License

MIT
