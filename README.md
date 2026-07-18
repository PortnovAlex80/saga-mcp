**[English](README.md)** | **[Русский](README.ru.md)**

# saga-mcp

## Quick Start (3 commands)

```bash
git clone https://github.com/PortnovAlex80/saga-mcp.git
cd saga-mcp && npm install && npm run build
cp -r skills/* ~/.zcode/skills/
```

Register in `~/.zcode/cli/config.json`:
```json
{
  "mcp": {
    "servers": {
      "saga": {
        "type": "stdio",
        "command": "node",
        "args": ["<path-to>/saga-mcp/dist/index.js"],
        "env": { "DB_PATH": "<path-to>/.zcode/saga.db" }
      }
    }
  }
}
```

Restart ZCode. Then from any empty folder:
```
Skill("saga-start")
```

**That's it.** Saga asks for your idea, runs Discovery (3 assessors), classifies complexity, produces PRD with hypothesis → SRS with invariants → AC with property tests → plans parallel development → verifies independently → integrates → observes runtime metrics → hit/kill decision.

Full install guide: [docs/INSTALL.md](docs/INSTALL.md)

## Kanban Board (auto-started)

saga-mcp bundles a read-only web kanban (`tracker-view/`) that auto-starts when
the MCP server launches. It reads the **same** saga DB and shows:

- All projects as switchable boards (Backlog / In Progress / Review / Done / Blocked)
- Per-card assignee, age, epic, task type, live heartbeat
- Coverage matrix: which ACs are implemented vs verified
- Acceptance registry: verification status per episode
- Clickable cards → task detail view
- Activity feed with heartbeat pulse (green/yellow/red)

Open **http://localhost:4321** after starting saga-mcp (or run `npm run tracker` manually).

---

## What is saga-mcp

A governance platform for parallel LLM coding agents. SQLite-backed, MCP-native, with contract-governed episode lifecycle, enforcement layer, and product discovery cycle.

**Not a Jira clone.** saga-mcp does not just track tasks — it governs the full lifecycle: from business hypothesis through architecture, requirements, parallel development, independent verification, to runtime observation and product decision (hit/kill).

**Goal:** make it impossible to pass an invalid action as a valid transition.

### What saga does for you

| Stage | What happens | Who |
|---|---|---|
| **Discovery** | Idea → measurable hypothesis (metric, target, kill criteria) | saga-kickstart |
| **Complexity Gate** | thin / modular / regulated / research → artifact set | senior-analyst |
| **Formalization** | PRD (hypothesis) → SRS (style, invariants, ports) → UC/AC (contract-as-data) | product / architect / analyst |
| **Planning** | Pattern B scaffold, conflict keys, verification routing | saga-planner |
| **Development** | Parallel workers in worktrees, merge-lock, RiskClass | saga-worker |
| **Verification** | Independent L3 property tests from frozen AC (NOT Builder's tests) | saga-verifier |
| **Integration** | Hard gate: every AC has passing evidence | episode_transition |
| **Observation** | Runtime metrics → hit/kill decision | observation_record |

### What saga prevents

- Development without accepted ACs (hard gate)
- "Done" without passing evidence (deny-by-default)
- Mid-work contract changes (drift detection)
- Workers breaking each other (semantic conflict keys at planning time)
- Agent lowering risk to skip gates (P15 monotonicity)
- UNKNOWN/ERROR treated as PASS (4-valued verdict)
- Hypothesis without measurement (R16: observation required)

---

> ## Fork origin
>
> Forked from [spranab/saga-mcp](https://github.com/spranab/saga-mcp) (v1.6.0). The upstream is a Jira-like MCP tracker. This fork adds:
> - **Dispatcher** (worker_next/worker_done/merge-lock) for parallel agent orchestration
> - **Episode state machine** (7 stages with hard gates: discovery→formalization→planning→development→verification→integration→completed)
> - **CGAD enforcement layer** (Contract-Governed Agentic Development): 18 lint rules, 4-valued verdict, RiskClass computation, semantic conflict detection, runtime observations
> - **13 skills** (saga-start, saga-kickstart, saga-product, saga-architect, saga-analyst, saga-planner, saga-worker, saga-verifier, saga-orchestrator, saga-dispatch, saga-tracker, saga-release, senior-analyst)
> - **14 artifact types**, **7 trace link types**, **trusted provider registry**
> - **Product discovery cycle**: hypothesis → metric → observation → hit/kill
>
> Full history: [docs/saga-mcp-history.md](docs/saga-mcp-history.md)

---

## What saga-mcp does

### Problem it solves

When multiple LLM agents work in parallel on the same project, they break each other:
- Two workers independently invent incompatible scaffolds → merge conflicts at architecture level
- Agent declares "done" prematurely — tests green but don't cover the AC
- Nobody tracks which hypothesis we're testing or whether the metric was measured
- Worker changes a frozen contract mid-work → downstream breaks silently

saga-mcp prevents all four through **mechanisms, not discipline**.

### How it works

```
IDEA (one phrase)
   │
   ▼
1. DISCOVERY (saga-kickstart: 3 assessors, completeness-gate, decision-fork)
   │ → brief artifact, decision ∈ {go, fast-track, clarify, reject}
   │ → Complexity Gate (senior-analyst: thin/modular/regulated/research → artifact set)
   ▼
2. FORMALIZATION (saga-product → saga-architect → saga-analyst)
   │ → PRD (with Hypotheses: metric, baseline, target, kill criteria)
   │ → SRS (Architectural Style, Module Manifest, Invariant Registry, Port Registry, NFR Targets)
   │ → UC + AC (properties blocks: YAML contract-as-data for L3 property tests)
   │ → RULE (business logic, enforced-by trace) + SPEC (implementation mechanism)
   │ → Frozen Contract Snapshot (accepted_hash, drift detection)
   ▼
3. PLANNING (saga-planner)
   │ → Pattern B scaffold (frozen contract materialized as stubs)
   │ → conflict_keys_set + conflict_check (planning-time semantic collision detection)
   │ → dev tasks (implements AC) + verification.ac tasks (saga-verifier)
   ▼
4. DEVELOPMENT (saga-worker fleet, parallel in worktrees)
   │ → Each worker: claim → worktree → code + L2 tests → merge-lock → done
   │ → RiskClass = max(declared, derived, policy) — agent cannot self-lower (P15)
   ▼
5. VERIFICATION (saga-verifier: independent L3 property tests)
   │ → Reads frozen AC contract (NOT Builder's tests)
   │ → Generates Hypothesis/QuickCheck property tests from YAML properties block
   │ → verification_record({outcome: passed/failed/unknown/error, provider, test_layer})
   ▼
6. INTEGRATION (merge-lock, post-merge build check)
   │ → assertVerificationPassed: every AC must have passing evidence matching hash
   │ → Deny by default (P14): missing evidence = no transition
   ▼
7. COMPLETED → post-launch observation
   │ → observation_record (benchmark/canary/incident/runtime_metric)
   │ → R16 lint: hypothesis must have observation (product cycle closed)
   │ → hit/kill decision based on metric vs target
```

### Enforcement layer (cgad-spec-lint v1.3.0)

16 deterministic rules, covering 12 of 25 CGAD forbidden constructs:

| Rule | What it catches |
|---|---|
| R1 | Deny-by-default: evidence without provider, UNKNOWN/ERROR treated as PASS |
| R2 | P15 risk floor: final_risk < max(declared, derived, policy) |
| R3 | AC with implements but no verified_by evidence |
| R4 | Greenfield episode without scaffold (Pattern B enforcement) |
| R5 | Semantic collision: ≥2 tasks sharing conflict key |
| R6 | Agent self-set state without activity_log |
| R7 | Non-atomic episode transition |
| R8 | Frozen contract edited in place (drift_state='drifted') |
| R9 | Self-approval: verifier == builder |
| R10 | Work package self-decomposition |
| R11 | Hidden exception without owner |
| R12 | Human approval as proof of correctness |
| R13 | Accepted SRS without verification.ac tasks (invariant enforcement gap) |
| R14 | FR contains forbidden implementation detail (endpoints, DB, algorithms) |
| R15 | RULE artifact without enforced-by trace |
| R16 | Hypothesis without runtime observation (product cycle gap) |

### Key primitives

| Primitive | Purpose |
|---|---|
| Episode state machine | 7 stages with hard gates, no skipping |
| Frozen Contract Snapshot | accepted_hash + drift_state — no mid-work contract changes |
| 4-valued guard verdict | passed / failed / unknown / error (deny-by-default) |
| RiskClass | max(declared, derived, policy) — agent cannot self-lower |
| Semantic conflict keys | file_path / schema / public_protocol / integration_branch |
| Runtime observations | Append-only, immutable, 3rd truth axis (Declared / Implemented / Observed) |
| Trusted Provider Registry | Deterministic Evidence / Authoritative State / Authorized Decision |
| Artifact types (14) | PRD, SRS, UC, AC, FR, NFR, RULE, SPEC, decision, brief, theme, OQ, hypothesis, business_metric |
| Trace link types (7) | covers, implements, implements_spec, derived_from, depends_on, verified_by, superseded_by |

---

## Architecture

saga-mcp does NOT replace classical architecture (SRP, Clean, Hexagonal, DDD).
It builds an **enforcement layer** above it: what human teams do through code
review and conversation, saga does through deterministic guards and hard gates.

### Classical principles that survive (validated through 6 adversarial critics)

- Small cohesive files (150-500 LOC)
- SRP (Parnas change-propagation, not Miller 7±2)
- Hexagonal / Ports & Adapters
- Composition over inheritance
- Explicit imports, no dynamic metaprogramming

### What changes for agent-runtime

| Human team enforcement | saga-mcp enforcement |
|---|---|
| Code review catches invariant violations | INVARIANTS.md + property tests (L3) + R13 lint |
| "I remember where things are" | Artifact graph (saga DB), queryable, drift-detected |
| Standup coordination | Frozen contract snapshot + conflict_keys (planning-time) |
| "Tests green = works" | Independent Verifier: L3 property tests from frozen AC |
| "Seems fine" | 4-valued verdict + deny-by-default |

See [Research Charter](docs/research/00-research-charter-v1-final.md) for the full
thesis (7 research reports + 6 adversarial critics).

---

## Install

### Prerequisites

- Node.js 18+ (for better-sqlite3 native build)
- npm
- Git
- ZCode (or any MCP-capable client)

### Step 1 — clone & build

```bash
git clone https://github.com/PortnovAlex80/saga-mcp.git
cd saga-mcp
npm install
npm run build
```

Verify:
```bash
DB_PATH=./smoke.db node dist/index.js
# Should print: Tracker MCP Server running on stdio
```

### Step 2 — register in ZCode

Edit `~/.zcode/cli/config.json`:

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

Restart ZCode.

### Step 3 — install skills

```bash
cp -r skills/* ~/.zcode/skills/
```

Restart ZCode again.

### Step 4 — smoke test

From any project folder:
```
Skill("saga-start")
```

Or manually:
```
mcp__saga__project_resolve_by_name({ name: "test-project" })
mcp__saga__worker_next({ worker_id: "smoke", project_id: 1 })
```

---

## Skills

| Skill | Role | When |
|---|---|---|
| **saga-start** | Bootstrap project + repository binding | First launch in a workspace |
| **saga-kickstart** | Discovery: idea → brief → decision | Complexity gate, 3 assessors, completeness-gate |
| **saga-product** | PRD with hypotheses | Formalization (product episodes) |
| **saga-architect** | SRS with Invariant Registry, Port Registry, conflict-key surface | Formalization |
| **saga-analyst** | UC + AC with properties blocks (contract-as-data) | Formalization |
| **saga-planner** | Pattern B scaffold, dev tasks, conflict_keys, verification.ac routing | Planning |
| **saga-worker** | Code + L2 example tests, merge-lock | Development |
| **saga-verifier** | Independent L3 property tests from frozen AC contract | Verification |
| **saga-orchestrator** | Drives full episode flow, Complexity Gate (Stage 1.5) | Main context |
| **saga-dispatch** | Dispatch loop (orchestrator helper) | Development fleet |
| **saga-tracker** | Bootstrap + worker queue rules | Entry point |
| **senior-analyst** | Requirements engineering reference (BABOK/Wiegers distilled) | Loaded by orchestrator at Complexity Gate |

---

## Testing

```bash
npm test                    # 163 tests (tsc + node --test)
npm run cgad-lint -- <db>   # Run cgad-spec-lint v1.3.0 (16 rules)
```

---

## Documentation

- [History](docs/saga-mcp-history.md) — full evolution from fork to CGAD convergence
- [CGAD spec](docs/architecture/cgad-v2-spec.md) — 1619-line target-state reference
- [Research Charter](docs/research/00-research-charter-v1-final.md) — agent-oriented SE thesis
- [Blog post](docs/research/blog-post-agent-oriented-se.md) — popularized research
- [ADRs](docs/architecture/decisions/) — 005 (CGAD adoption), 006 (Pattern B), 007 (convergence retrospective)
- [GUARDRAILS](GUARDRAILS.md) — Signs 001-009 (informal constitution)
- [cgad-spec-lint](tools/cgad-spec-lint.mjs) — 16 deterministic enforcement rules
- [SRS template](docs/requirements/templates/SRS.md) — 8 required sections
- [AC template](docs/requirements/templates/acceptance-criteria.md) — contract-as-data format
- [INVARIANTS template](docs/requirements/templates/INVARIANTS.md) — per-module invariant declaration

---

## License

MIT
