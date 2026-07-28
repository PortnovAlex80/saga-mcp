# SAGA 3 Clean Modular Runtime Refactor — Management HQ

This folder is the integrator's command post for executing
`docs/plans/SAGA3-CLEAN-MODULAR-RUNTIME-REFACTOR-PLAN.txt`. It is the single
source of truth for **progress tracking, wave ownership, frozen checkpoints,
and subagent task dispatch** during the refactor.

The primary agent (integrator) owns this folder. Subagents read their lane's
task file from `05-subagent-tasks/`, return one architecture-focused commit, and
never edit anything here.

## Folder map

| Path | Purpose |
|---|---|
| `README.md` | This file — orientation map. |
| `00-PLAN.md` | Verbatim frozen copy of the master plan (canonical reference). |
| `01-CODEBASE-BASELINE.md` | Reconnaissance snapshot of the pre-refactor codebase. The "before" picture every wave builds on. |
| `02-CHECKLIST.md` | Master execution checklist C001–C090 with live status. |
| `03-WAVE-ROADMAP.md` | One-page index of all 14 waves (Wave 0–Wave 13), owners, gates, status. |
| `04-waves/WXX-*.md` | Per-wave file: preconditions, ownership lanes, frozen input commit, integration order, exit gate, status. |
| `05-subagent-tasks/WXX-AY-*.md` | One self-contained task file per subagent lane. The exact contract a worker executes. |
| `06-PROGRESS-LOG.md` | Append-only chronological journal: checkpoints, cherry-picks, gate results, risks. |
| `07-DECISIONS.md` | Cross-cutting architecture decisions taken during execution (resolutions of frozen-contract changes, scope calls). |
| `08-RISK-REGISTER.md` | Open risks surfaced by workers, with owner and mitigation. |
| `09-contracts/*.md` | Frozen contract definitions published by the integrator before each wave (manifest shapes, identity rules, digest rules). |
| `10-adr/*.md` | Architecture Decision Records produced by Wave 0 ADR lane and later. |

## Operating model (condensed from plan §0.1)

1. **Integrator (this agent)** is the architecture and integration owner. It
   publishes frozen input commits, owns all hot files between waves, reviews
   worker commits, cherry-picks serially in dependency order, runs the wave
   gate after every pick, and creates one checkpoint commit before the next
   wave.
2. **Workers (subagents)** run in waves of up to 8. Each works an isolated
   ownership lane: disjoint file paths, one writer per file per wave, no edits
   to another lane, shared barrels, composition roots, generated snapshots, or
   migration bootstrap.
3. **Frozen contracts are immutable within a wave.** A worker that needs a
   contract change STOPS and escalates (`07-DECISIONS.md`); it never patches
   around a missing contract with metadata, fallback, alias, or module-specific
   Runtime logic.
4. **One persistence owner per wave** controls all SQL migration numbering and
   shared schema bootstrap changes.
5. **Test agents report failures against the owning lane.** They never
   opportunistically edit another lane's production files.
6. **An unused worker slot is safer than manufacturing cross-ownership work.**

## Current state

- **Active wave:** Wave 1 (Pure SPI Validation & Proof) — being staged next.
- **Last completed:** Wave 0 (Baseline & Executable Architecture Rules) — 8/8 lanes done, 146/146 gate tests pass, 0 production lines changed. Checkpoint commit created.
- **Frozen input commit history:** `eb35510` (pre-HQ baseline) → `fd26fd1` (HQ + Wave 0 frozen input) → Wave 0 checkpoint.
- **Next integrator action:** stage Wave 1 frozen checkpoint (pure SPI: manifests, ContractRef, envelopes, ModuleCompletion, NodeProtocol, recovery, tools, assistance, identities), then dispatch W1-A1…W1-A8.

## How to resume after context loss

1. Read this `README.md`, then `03-WAVE-ROADMAP.md` for current wave status.
2. Read `04-waves/<current>.md` for that wave's ownership and gate.
3. Read `06-PROGRESS-LOG.md` tail for what has been cherry-picked and what is pending.
4. Read `02-CHECKLIST.md` for the live C001–C090 status.
5. Continue from the next integrator action listed above.
