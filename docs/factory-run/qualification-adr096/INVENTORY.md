# Branch / Worktree Inventory — 2026-08-25 (post-Phase-7 consolidation)

Refreshed deliverable of `CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`
(supersedes the Phase-6-time inventory; Phase-7 worktrees appeared after it).

## Worktrees (8)

| Worktree | Commit / branch | State & survivor reason |
|---|---|---|
| `D:/Development/saga-mcp` | bare | The repository. |
| `D:/Development/saga-mcp-SAGA4` | `7e59016e` ← `saga4` | The canonical dev checkout (node_modules owner). |
| `D:/Development/saga-mcp-P7-FROZEN` | `37ce4c00` (detached) | **KEEP until the qualification window closes**: the immutable frozen build (receipt `a5108835f2fd`); canary-2's engine runs FROM this tree. Remove after the gate verdict + receipt archival. DIRTY (verified, by design): two untracked receipt JSONs — `build-receipt-03e9af1df388.json` (superseded, store-empty freeze) and `build-receipt-a5108835f2fd.json` (active); receipts are intentionally untracked in the frozen tree, both hashed in the qualification ledgers; they get archived with the gate verdict. |
| `D:/Development/saga-mcp-P7-DOCS` | `f8ac9382` ← `phase7/docs-work` | Merged into saga4 (ancestor). Disposable after Phase-7 cleanup; junction-linked. |
| `D:/Development/saga-mcp-P7-DEVUNI` | `2b7ad4b7` ← `phase7/devuni-work` | Merged (ancestor). Disposable; junction-linked. |
| `D:/Development/saga-mcp-P7-K4` | `246532e4` ← `phase7/k4-work` | Merged (ancestor). Disposable; junction-linked. |
| `D:/Development/saga-mcp-P7-TOOLS` | `64b56a88` ← `phase7/tools-work` | Merged (ancestor). Disposable; junction-linked. |
| `D:/Development/saga-mcp-ELITE9` | `6556a59f` ← `stage22/elite9-run` | **Measured 2026-08-25 09:2x: IDLE, not running** (0 elite9 processes, heartbeat silence since 00:10Z). Preserved as the last Elite-9 evidence tree (Elite-10 incident corpus) until an explicit operator stop-and-archive decision. Untouched by this plan's agents. DIRTY (verified 2026-08-25 ~11:00): `tests/factory-evidence/conformance-report.json` modified Aug 24 20:48 — uncommitted residue of the parallel operator session's last activity window, not new factory output; left as-is (not ours to commit or revert). |

## Local branches (7)

| Branch | Commit | Verdict |
|---|---|---|
| `saga4` | advancing (`50e6a8c0` at the last refresh) | The canonical line. **Synced: local == `origin/saga4` at `50e6a8c0` (0/0 divergence)** — pushed 2026-08-25 after the operator sync item; later commits ride with the completion receipt. |
| `integration/canonical-2026-08-24` | `90faa5ae` | Kept as the integration-wave record (tip is an ancestor of saga4; the phases 1–6 consolidation head). |
| `phase7/docs-work` | `f8ac9382` | Ancestor of saga4 → deletable at Phase-7 cleanup. |
| `phase7/devuni-work` | `2b7ad4b7` | Ancestor → deletable. |
| `phase7/k4-work` | `246532e4` | Ancestor → deletable. |
| `phase7/tools-work` | `64b56a88` | Ancestor → deletable. |
| `stage22/elite9-run` | `6556a59f` | Bound to the preserved ELITE9 worktree. |

## Stashes (3, preserved per plan)

`stash@{0}` pre-reconcile docs/graph-maps work · `stash@{1}` stage17-T1
liveness measure (parked) · `stash@{2}` adr053-cutover envelope note.
Ownership classification (2026-08-24): all three are parked parallel-session
work, none needed for this plan; retained untouched.

## Archive tags (27 total; the five created by this plan)

`archive/cc-gap-2-terminal-projection` (`cf14e364`) ·
`archive/cc-gap-3-worker-terminalization` (`f00fd8c4`) ·
`archive/cc-gap7a-warrant-adapters` (`18b7e444`) ·
`archive/repair/snapshot-test-mvp` (`fc24da7a`) ·
`archive/wip/documentation-workshop` (`a05bc223`) — plus the 22 pre-existing
`archive/repair/*` tags. Every deleted non-ancestor branch is recoverable
from its tag.

## Remote

`origin/saga4` == local `saga4` at `50e6a8c0` (pushed 2026-08-25; required
`http.postBuffer` 500MB for the pack). No other remote refs were written.
