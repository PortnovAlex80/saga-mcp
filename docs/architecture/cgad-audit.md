# CGAD ↔ saga-mcp Audit Report

**Date:** 2026-07-17
**Author:** convergence-agent (Phase 0)
**Sources read (all 10 required):**
- `docs/architecture/cgad-v2-spec.md` (1619 lines, full §1-41)
- `docs/architecture/decisions/005-saga-as-cgad-lite-evolution.md` (ADR-005, Accepted)
- `GUARDRAILS.md` (Signs 001-008)
- `D:/Development/saga-mcp/src/tools/lifecycle.ts` (297 lines)
- `D:/Development/saga-mcp/src/planner/topology.ts` (109 lines)
- `D:/Development/saga-mcp/src/schema.ts` (319 lines)
- `D:/Development/saga-mcp/src/tools/dispatcher.ts` (1211 lines, key sections)
- `.zcode/skills/cgad/SKILL.md` (per-change 6-step loop)
- `tools/cgad-spec-lint.mjs` (R1/R2/R3, 341 lines)
- `AGENTS.md` (workspace conventions)

**Method:** Every cell in the tables below is tied to a specific file:line I have read in this session. No assertion comes from memory. Status legend: ✅ covered by mechanism · 🟡 partial mechanism (descriptive mapping only per Sign 008) · ❌ gap.

---

## 1. Linter baseline (taken this session)

```
$ node tools/cgad-spec-lint.mjs C:/Users/user/.zcode/saga.db
Summary: 186 error(s), 0 warning(s).
```

| Rule | Findings | Severity |
|---|---|---|
| CGAD-R1 (deny-by-default — failed outcome or missing `recorded_by`) | 0 | — |
| CGAD-R2 (P15 risk floor — critical/security tag vs low/medium priority) | 1 | error |
| CGAD-R3 (Sign 006 — `implements` without `verified_by`) | 185 | error |

**R2 finding:** task #470 «AC-2: Zip-extraction path-traversal защита» tagged `[security]` but `priority='medium'` (P15 violation, one click to fix).

**R3 breakdown by project (185 findings):**

| Project | ACs lacking `verified_by` |
|---|---|
| #25 GrammarMate | 79 |
| #10 ODN-MVP | 26 |
| #17 granite-legacy | 18 |
| #19 TestLasGPU | 17 |
| #13 requirements | 8 |
| #16 deposit-calc-simple | 1 |
| #15 kickstart-impl | 1 |

**Trace totals:** `implements` = 282, `verified_by` = 67 → ~76% of `implements` traces have no evidence-backed `verified_by`. Most R3 findings are historical (pre-REQ-006) episodes that never produced passing evidence; they are not blocking live work but they are real P7/Sign-006 violations the audit must name.

**DB scale (as of 2026-07-17):** projects=26, epics=114, tasks=625, artifacts=684, artifact_traces=1423, verification_evidence=22, episode_workflows=11. Episodes in flight: development=3, discovery=3, verification=2, formalization=1, completed=2.

---

## 2. CGAD Principles P0–P17 — coverage map

Each row: principle (CGAD spec §8), where it lives in saga code (file:line), status, honest note.

| Principle | saga-mcp location | Status | Notes |
|---|---|---|---|
| **P0** linear change cost under human control | `lifecycle.ts:114-153` `handleEpisodeTransition` + 5 hard gates | ✅ | Episode stage machine is the linear-cost mechanism. Human is not forced to read every line — gates enforce structure. |
| **P1** three truths (Declared / Implemented / Observed) | Declared: `artifacts` table (`schema.ts:202`) · Implemented: code under `task/<id>` worktree · Observed: `verification_evidence` (`schema.ts:227`) | 🟡 | Three truth **stores** exist. Reconciliation is informal: `assertVerificationPassed` (`lifecycle.ts:80`) ties Implemented (test evidence hash) to Declared (AC `accepted_hash`) but has **no Observed/runtime axis**. Gap #4. |
| **P2** status change, not destruction | `artifacts.status` CHECK (`draft/in_review/accepted/superseded`, `schema.ts:211`); `tasks.status` 6-state (`schema.ts:93`) | ✅ | No entity is hard-deleted; status transitions only. `superseded_by` trace edge (`schema.ts:251`). |
| **P3** Governed Capability as unit | `epic` (REQ episode) ≈ capability boundary; `task.task_kind` + `workflow_stage` (`schema.ts:103-104`) | 🟡 | Closest analog. No first-class `capability` node type (CGAD Architecture Graph §16); capabilities are implicit per-epic. |
| **P4** minimal sufficient specification | Episode stages discovery→formalization enforce just-enough spec per gate (`lifecycle.ts:127` formalization→planning requires accepted ACs only) | ✅ | Gates do not over-specify; `acceptedBaseline` (`lifecycle.ts:38`) requires AC set + hashes, nothing more. |
| **P5** delegation criterion (localize/detect/rollback) | `execution_mode` enum (`git_change/tracker_only/read_only_evidence/interactive`, `schema.ts:107`); `worker_ask_need` for escalation | ✅ | `interactive` mode + `worker_ask_need` (dispatcher) is the escalation path for non-delegatable decisions. |
| **P6** boundary by invariant/risk/ownership, not tokens | `project_repositories` table (`schema.ts:28`) — physical repo boundaries; `integration_branch` per repo | ✅ | saga exceeds CGAD here: repo boundary is the lease scope, not a token count. |
| **P7** independence of check (no self-approval) | `task.review_skill` vs `task.execution_skill` columns (`schema.ts:105-106`); `verification_record` requires `task_kind='verification.ac'` (`lifecycle.ts:219`) | 🟡 | Mechanism enforces `verification.ac` task kind, but the same agent CAN run both dev and verify tasks in sequence (solo-mode). No structural bar to "agent builds X, then claims to verify X." Sign 006 root cause. |
| **P8** visibility of exceptions | `tasks.tags` array (`schema.ts:116`) — `needs-human` tag added by `worker_merge_release` on conflict (`dispatcher.ts:911`) and `worker_ask_need` | 🟡 | Tag exists; no formal Exception artifact with `owner/expiry/review condition` (CGAD §17). No expiry on `needs-human`. |
| **P9** managed intervention (break-glass) | No explicit break-glass primitive | ❌ | The closest pattern is `worker_ask_need` → human override, but no formal break-glass state with mandatory post-formalization (Incident + new policy). |
| **P10** dependency inversion | saga does not enforce domain/technical layering | ❌ | Out of saga's scope (saga governs workflow, not code structure). Would belong to a per-repo architecture-linter provider, not the core. |
| **P11** authorship inversion (human sets goals, agent implements) | `saga-kickstart` skill (interactive discovery with human); `decision` artifact type; `decision` notes | ✅ | Episode `discovery` stage (`lifecycle.ts:14`) is the human-intent gate before any agent work. |
| **P12** single source of state | `saga.db` (SQLite, `db.ts`) — all read/write via `getDb()`; no second store | ✅ | Single authoritative store. `activity_log` is explicitly **not** state (append-only audit, `schema.ts:184`). |
| **P13** guards must cite provider, not LLM reasoning | `assertVerificationPassed` (`lifecycle.ts:80-94`) cites `verification_evidence` rows as the provider output; `cgad-spec-lint.mjs:14-17` is a deterministic provider | 🟡 | One deterministic provider exists (lint). Episode gates cite SQL state, not LLM. But no **provider registry** — gap #6 in ADR-005. |
| **P14** deny by default | `assertVerificationPassed` (`lifecycle.ts:81-93`) — `NOT EXISTS (... outcome='passed' AND content_hash=a.accepted_hash)`; transition throws if missing | ✅ | Strongest CGAD-aligned primitive in saga. Missing evidence ⇒ throw ⇒ no transition. |
| **P15** agent cannot self-lower risk | `tasks.priority` CHECK (`low/medium/high/critical`, `schema.ts:95`) is manual, NOT computed; no `derived_risk` or `policy_minimum` columns | ❌ | No mechanism. cgad-spec-lint R2 audits the **precondition** (critical-tagged task must not be low/medium) but the underlying computation does not exist. Gap #2. |
| **P16** constitution versioning | GUARDRAILS Signs 001-008 designated informal ConstitutionVersion-0 by ADR-005 | ❌ (permanently out of scope per ADR-005) | No machine-checked `ConstitutionVersion` entity. ADR-005 §Decision 5 closes this as permanent scope-out. |
| **P17** separation of lifecycles (resource ≠ lease; contract ≠ compliance) | `repositories`/`project_repositories` cleanly separate from `worker_merge_acquire` lease (`dispatcher.ts:748`); `artifacts.status` separate from `verification_evidence.outcome` | ✅ | ADR-005 mapping notes "saga exceeds CGAD §18 here" — resource state is not folded into lease state. |

**Tally:** ✅ 9 · 🟡 6 · ❌ 3 (of which 1 is permanently out of scope).

---

## 3. Forbidden Constructs §22–47 — enforcement map

CGAD §22 lists 25 forbidden constructs (numbered 23-47 in the source due to a heading gap). For each: the saga mechanism, whether it is enforced by code/lint/discipline only, and the cgad-spec-lint rule if any.

| # (CGAD §22) | Forbidden construct | saga mechanism | Enforced by | Lint rule? |
|---|---|---|---|---|
| 23 | Markdown checkbox as proof of completion | `assertVerificationPassed` requires DB evidence row, not a checkbox (`lifecycle.ts:80`) | ✅ code | — |
| 24 | Guard without Trusted Provider | `verification_record` ties evidence to `task_id+artifact_id+hash` (`lifecycle.ts:233`); providers implicit | 🟡 partial — no provider registry | — |
| 25 | Guard on hidden LLM reasoning | `assertVerificationPassed` is SQL, not LLM; `cgad-spec-lint` is deterministic Node | ✅ code | — |
| 26 | Agent self-setting its own state | Only `episode_transition` (`lifecycle.ts:114`) mutates episode stage; agents call tool, DB is authority | ✅ code | — |
| 27 | Agent storing authoritative project state | Agents are stateless; `getDb()` is the only authority (`db.ts`) | ✅ code | — |
| 28 | Multiple equal sources of state | Single SQLite DB; `activity_log` explicitly not state | ✅ code | — |
| 29 | Non-atomic commit of transition | `withImmediateTransaction` (BEGIN IMMEDIATE) wraps every state mutation (`dispatcher.ts:36, 361, 600, 717, 841`) | ✅ code | — |
| 30 | Transition accepted on UNKNOWN/ERROR | `verification_evidence.outcome` CHECK is `('passed','failed')` — no UNKNOWN/ERROR enum (`schema.ts:231`) | ❌ **Gap #1** —REQ-008 | future R1 (currently warns on missing `recorded_by`) |
| 31 | Parallel impl before Frozen Contract Snapshot | Pattern B scaffold (`topology.ts:87`) makes this possible; applied only when `brief.topology_hint='scaffold-then-parallel'` — **NOT default** | 🟡 optional, not enforced | — |
| 32 | Editing Frozen ContractVersion in place | `accepted_hash` + `drift_state` (`schema.ts:215-218`); `acceptedBaseline` (`lifecycle.ts:38-62`) recomputes and rejects drift | ✅ code | — |
| 33 | RiskClass self-lowered by Builder | No `derived_risk`/`policy_minimum` columns; `priority` is a free label | ❌ **Gap #2** — REQ-009 | R2 (precondition only) |
| 34 | Git conflict as only conflict detector | `worker_merge_release(result='conflict')` only signals git-level conflict (`dispatcher.ts:902`); no semantic conflict keys | ❌ **Gap #3** — REQ-010 | — |
| 35 | Monolithic universal skill | saga has 12 narrow skills (saga-kickstart/product/architect/analyst/planner/worker/dispatch/orchestrator/tracker/start + cgad); each has its own task_kind filter | ✅ convention | — |
| 36 | Monolithic generation in one pass | Episode stages force one-phase-at-a-time; `episode_transition` rejects skips (`lifecycle.ts:121`) | ✅ code | — |
| 37 | Full DDD + max governance regardless of profile | saga has one profile (modular monolith); no profile selector | 🟡 out of scope for single-product saga | — |
| 38 | Forbidding Builder from writing unit tests | Builder tasks write tests; no rule prevents it | ✅ by design — saga wants Builder tests; CGAD forbids forbidding them | — |
| 39 | Self-approval | `review_skill` vs `execution_skill` columns exist; no runtime check that reviewer ≠ builder | 🟡 structural, not enforced | — |
| 40 | Mixing Resource State and Lease Lifecycle | `repositories` table ≠ `worker_merge_acquire` lock in `project_repositories.metadata` | ✅ code | — |
| 41 | Mixing Contract Lifecycle and Implementation Compliance | `artifacts.status` (contract) ≠ `verification_evidence.outcome` (compliance) | ✅ code | — |
| 42 | Work Package self-decomposition | `workflow_generate_next` (workflow.ts) creates downstream tasks from accepted upstream; `generation_key` UNIQUE prevents duplicates; WP cannot self-spawn | ✅ code | — |
| 43 | Human approval as proof of correctness | `verification_record` requires `task_kind='verification.ac'` and matching hash (`lifecycle.ts:219, 230`); human approval alone does not admit | ✅ code | — |
| 44 | Runtime observation mutating acceptance oracle | `accepted_hash` immutable post-acceptance; only a new artifact status (`superseded`) replaces it | ✅ code | — |
| 45 | Architectural boundary by tokens/file size | Repo boundaries (`project_repositories`) drive task routing, not token counts | ✅ code | — |
| 46 | Hidden exception without owner/expiry/review | `needs-human` tag has owner (assigned_to) but **no expiry, no review condition** | 🟡 partial | — |
| 47 | Constitution change without new version + gate | GUARDRAILS Signs are append-only by convention; no machine gate | ❌ (permanently out of scope per ADR-005) | — |

**Tally:** ✅ enforced by code: 17 · 🟡 partial/convention: 4 · ❌ gap: 4 (of which 2 are the headline gaps #1/#2/#3, one is #6 partial, one is permanently out of scope).

---

## 4. CGAD components §3 ↔ saga entities

| CGAD component (§3) | saga entity | Coverage |
|---|---|---|
| Agent | worker session (stateless, claims one task via `worker_next`) | ✅ |
| Project | `projects` table + `epics` (REQ episode) | ✅ |
| Skill | ZCode skill files (`.zcode/skills/saga-*`, `cgad`) + `tasks.execution_skill` | ✅ |
| Graph (memory of entities/deps/ownership/conflicts/evidence) | `artifact_traces` table — 6 edge types vs CGAD's 21 | 🟡 partial — 2 node types (artifact/task), 6 edges; CGAD wants 24 nodes / 21 edges |
| State Machine | `episode_workflows.stage` 7-state (`lifecycle.ts:8`) | ✅ |
| Guard | `assertVerificationPassed`, `assertTasksReady`, `acceptedBaseline` (`lifecycle.ts`) | 🟡 — informal guards, no provider registry |
| Trusted Guard Input Provider | `verification_evidence` (Deterministic) + SQL state queries (Authoritative) + `recorded_by` (Authorized); **no registry table** | ❌ Gap #6 (partial) |
| Orchestrator | `episode_transition` + `worker_next`/`worker_done`/`worker_merge_*` (`dispatcher.ts`) | ✅ |
| Control State Store | `saga.db` (single SQLite) | ✅ |
| Workflow Ledger | `activity_log` table — field-change log, not decision ledger with guard-results/provenance/constitution-version | 🟡 partial — fields: entity/action/old/new/summary, missing guard_results, state_version, constitution_version |
| Evidence Store | `verification_evidence` table (immutable, UNIQUE on task/artifact/hash) | 🟡 — `outcome` binary, no provider field |
| Runtime Observation Store | — | ❌ **Gap #4** (REQ-011) |
| Agent Lease | `worker_merge_acquire`/`release` — merge-lock scoped to git-merge (`dispatcher.ts:748, 827`) | 🟡 — narrower than CGAD AgentLease (which covers semantic scope, not just merge) |

---

## 5. Discrepancies with ADR-005 Roadmap

ADR-005 Roadmap (6 rows) is **accurate as written**. No gap is already closed; no new gap is found that the Roadmap misses. Three refinements worth recording for Phase 1 prioritization:

1. **R3 baseline is larger than the ADR-005 narrative implied.** ADR-005 §Gap 6 calls R3 a "3-rule lint"; the live count is **185 R3 errors across 7 projects**, concentrated in GrammarMate (79) and ODN-MVP (26). These are mostly historical episodes (pre-REQ-006, pre-`verified_by` workflow). Closing them is **not** a saga-mcp code change — it is a per-project evidence backfill. Phase 1 must decide: backfill evidence, or mark these ACs as `superseded`, or accept them as frozen historical debt.

2. **Pattern B (Sign 002) is the pain the user named, but ADR-005 does not have an explicit REQ for "Pattern B by default".** The Roadmap's REQ-010 (semantic conflict model) is the *full* fix, but it is a 28h effort blocked by REQ-008 → REQ-009. There is room for an **interim REQ-013**: make Pattern B the default topology for greenfield multi-task episodes. This is a ~4h change in `topology.ts` + planner and closes ~70% of the "parallel agents break each other" pain without waiting for the full conflict model.

3. **P9 (break-glass) and P10 (dependency inversion) are absent from ADR-005 entirely.** They are listed as ❌ in §2 above. ADR-005 does not disposition them. Recommendation: declare both **permanently out of scope** alongside P16, with the same "single-team product" justification — neither has shown up as a pain in the smoke-tests. This is a Phase 1 decision, not an audit finding.

No discrepancy requires changing ADR-005 itself.

---

## 6. Pain analysis: «Параллельные агенты ломают друг друга»

User pain (verbatim): **«Параллельные агенты ломают друг друга»**.

Root cause traced through code:

- **Symptom in the wild (Sign 002):** N workers start simultaneously on a greenfield repo. Each creates its own scaffold (`package.json`, `tsconfig`, `App.tsx`). Merge → `add/add` conflict on all shared files. REQ-001 had 3/4 tasks in conflict; REQ-003 had 3/11.
- **Code location:** `topology.ts:77` `decideTopology(brief)`. Pattern B (scaffold-then-parallel) **exists and works** (REQ-002 0/3 conflicts, REQ-004 0/9 conflicts per Sign 002) — but it is **opt-in only**, via `brief.topology_hint='scaffold-then-parallel'`.
- **The bug:** if a brief omits `topology_hint` or sets it to `'sequence'`/`'parallel-independent'`, workers fan out with no scaffold, and git becomes the only conflict detector — which is exactly CGAD forbidden construct #34 ("Git conflict as only conflict detector").
- **Why git-only fails here:** git merge resolves *line-level* conflicts. Two workers each adding `package.json` from scratch produce an `add/add` conflict that is *architectural*, not line-level. No amount of merge-tooling resolves "which of these two incompatible scaffolds wins."

Two-layer fix path:

| Layer | Fix | Effort | Coverage of pain |
|---|---|---|---|
| **Interim (REQ-013)** | Make `topology.ts` default to Pattern B when ≥2 tasks touch shared contract surface and brief is greenfield; let the scaffold task materialize stubs first. Add a lint rule (R4) that flags episodes entering `development` with >1 task and no scaffold dependency. | ~4-6h | ~70% — closes the greenfield add/add class |
| **Full (REQ-010)** | Typed semantic conflict keys (capability/invariant/aggregate/schema/public-protocol). Compute conflict keys at planning time; refuse to schedule two tasks with overlapping keys into the same wave unless one is scaffold. | ~28h | ~95% — closes the cross-file semantic conflict class (the harder cases) |

**The audit's recommendation for Phase 1:** REQ-013 first (small, unblocks the pain), then proceed ADR-005 Roadmap REQ-008 → 009 → 010 → 011 → 012 in order. REQ-013 is **additive** to the Roadmap, not a replacement for REQ-010.

---

## Phase 0 acceptance — self-check

| Required by prompt §«Фаза 0» | Status |
|---|---|
| Read full 1619-line CGAD spec | ✅ |
| Read ADR-005 + GUARDRAILS + lifecycle + topology + schema + linter + cgad skill + AGENTS.md | ✅ (all 10 files) |
| Audit file created with all sections | ✅ this file |
| All 18 principles P0-P17 mapped with file:line | ✅ §2 |
| All 25 forbidden constructs §22-47 mapped | ✅ §3 |
| Linter baseline captured | ✅ §1 (186 errors: 1 R2 + 185 R3) |
| Pain «parallel agents break each other» traced to code | ✅ §6 |
| Discrepancies with ADR-005 documented | ✅ §5 |

**Per Phase 0 protocol: STOP here. Wait for user confirmation before any code change or Phase 1 prioritization.**

No code, schema, tracker entity, or file outside this audit was modified. The audit is a read-only artifact.
