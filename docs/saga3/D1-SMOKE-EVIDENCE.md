# D1 Smoke Evidence — accepted closure record

**Date:** 2026-07-23
**Branch:** `saga3-discovery` @ `9d6ab79`
**Head commit:** `9d6ab79 fix(saga3-d1): blocked is not a clean worker_done; runFailed checked before clean`

This document is the durable evidence record for the D1 acceptance smoke run.
It separates three evidence tiers because the post-run DB purge (cascade via
`project_delete`) removed the saga3 rows while leaving the immutable audit
trail intact.

| Tier | Source | Survives purge? | Authority |
|------|--------|-----------------|-----------|
| A | `command_receipts` (idempotency ledger) | **Yes** — append-only | Highest |
| A | `activity_log` (audit trail) | **Yes** | Highest |
| B | Live engine heartbeat (`PROPOSAL_VALID ...`) observed during the run | No — process memory | Medium (recorded in session log) |
| C | `saga3_work_intents`, `saga3_proposals`, `worker_executions`, `episode_workflows` | **No** — cascade-deleted | n/a |

---

## Tier A — immutable audit trail (post-purge query)

### Project + task lifecycle

Source: `activity_log` rows 18886–18890.

| id | ts | entity | action | summary |
|----|----|--------|--------|---------|
| 18886 | 20:29:56 | project:30 | created | Создан проект «d1-smoke3» через веб-форму idea → engine |
| 18887 | 20:29:56 | task:178 | status_changed | `todo → in_progress` — claimed by `board-30-1784838596578-1` |
| 18888 | 20:31:07 | task:178 | status_changed | `in_progress → review` — worker_done (build execution) |
| 18889 | 20:31:10 | task:178 | status_changed | `review → review_in_progress` — claimed by `board-30-1784838670698-2` |
| 18890 | 20:32:11 | task:178 | status_changed | `review_in_progress → done` — worker_done (review execution) |

**Project:** id 30, name `d1-smoke3`.
**Task:** id 178, title *«Discovery: CLI tool to convert CSV files to JSON with type inference»*.
**Episode:** inferred from task 178 (row cascade-purged; episode id not recoverable post-purge).

### Worker_done protocol receipts

Source: `command_receipts` (immutable idempotency ledger).

| command_id | task | result_json | accepted_at |
|-----------|------|-------------|-------------|
| `exec-30-9372-1784838596578-1:worker-done:approved` | 178 | `completed_new_status: "review"` | 20:31:07 |
| `exec-30-9372-1784838670698-2:worker-done:approved` | 178 | `completed_new_status: "done"` | 20:32:11 |

Both receipts carry `accepted: 1`, `rejection_code: null` — the dispatcher
accepted both worker_done commands cleanly. Two executions (build + review)
match the standard two-step worker_done contract (build advances to review;
review advances to done).

---

## Tier B — live-observed during the run

Observed via the engine heartbeat printed to the tracker-view console during
the run. Not durable; recorded here from the session log.

- **WorkIntent:** saga3_work_intents row for epic of project 30, kind `discovery`, status reached `concluded`.
- **Proposal:** saga3_proposals row **#4**, `outcome: "go"`, `kind: "discovery"`, schema `saga3.discovery-proposal.v1`.
- **Proposal hash:** recorded in the proposal row at submit time (content_hash, SHA-256 of canonical JSON). Specific hex value was visible in the heartbeat line `PROPOSAL_VALID id=4 outcome=go terminal=clean` but not captured to a durable store before purge.
- **Engine terminal:** `terminal=clean` → `reason=completed`, `scopeCompleted=true`. Engine exited on its own (no manual stop).
- **Model route:** `qwen3.6-35b-a3b@q4_k_xl:2` via LM Studio (provider `lmstudio`). At D1 this was read at claim time into the launch snapshot; the known claim↔model/set race (claim may read before model is fully resolved) is a deferred non-blocker — fixed properly in D1.1 by the single-snapshot rule.
- **No `discovery.kickstart` task, no subsequent stage:** project 30 was created via the saga3-discovery bootstrap path (`handleProjectCreateFromIdea` skips the legacy kickstart INSERT when `isSaga3DiscoveryMode(mode)`), so only project + repo + epic + episode_workflows were seeded; the discovery task was projected by the engine from the WorkIntent. No `formalization`/`planning`/`development` tasks were created — the discovery-only pipeline held at the single `discovery` stage as designed.

---

## Verdict

D1 acceptance criteria met:

1. ✅ Discovery worker saw only the allowed Saga MCP tool set (skill contract).
2. ✅ Created a typed Proposal (`saga3.discovery-proposal.v1`, outcome `go`).
3. ✅ Called `worker_done` (twice: build→review, review→done) — both accepted.
4. ✅ `scopeCompleted=true`, engine exited `clean` on its own.
5. ✅ No legacy kickstart, no stage advancement beyond `discovery`.

**D1 is accepted.** The next slice is **D1.1 — runtime authority enforcement**
(separate commit), not D2.

---

## Known non-blockers carried into D1.1

- **Claim↔model/set race:** model route read at claim may differ from the route
  used at spawn. D1.1 eliminates this by reading the route **once**, freezing it
  into the immutable execution snapshot, and using that single snapshot for
  claim metadata, spawn args, and Proposal provenance.
- **Authority is advisory:** `WorkIntent.authority_scope.enforcement === 'advisory'`.
  The skill lists the allowed tools but nothing rejects a disallowed call before
  the handler runs. D1.1 adds the MCP gateway with default-deny for Saga 3.
