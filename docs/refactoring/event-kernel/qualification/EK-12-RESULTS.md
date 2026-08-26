# EK-12 — Real OpenCode Full-Conveyor Qualification — RESULTS

**Status: GREEN.** Three consecutive real-model runs on ONE immutable kit.

| Item | Value |
|---|---|
| Kit | `123504a46b312b467cf39ea9df4e562099653ebc8a7e83e47ba4b35d0c208b28` |
| Source HEAD | `00261a0d` (tree byte-identical at run time — kits/series are fence-ignorable untracked) |
| Series record | `series/real-20260826094711.json` (allGreen: true) |
| Evidence | 142 files under `D:/Development/ek-qual-evidence/123504a4…/real-20260826094711`, manifest digest `3b965061…` |
| Transport | opencode shim (`SAGA_REAL_CLAUDE_PATH`), claude-CLI fail-closed, settings tripwire read-only (sha256 2d6176e8 recorded) |

## The three consecutive runs (37/37 checks each)

| Run | Product | Result | Elapsed |
|---|---|---|---|
| R1 | Simple served Node/browser API product | **GREEN 37/37** | 81 min |
| R2 | Command-line/library product with tests | **GREEN 37/37** | 65 min |
| R3 | Full-stack CRUD with persistence + browser smoke | **GREEN 37/37** | 136 min |

Each run: fresh empty database + fresh repository, public capsule ingress only,
complete idea → Discovery → Formalization → Development → Delivery path,
forward/reverse reconciliation, per-request pre-send PromptAssemblyReceipt
completeness (the WP-18 admitting transport), independent product verification
(install/build/test/start + API/CLI/browser smoke + local delivery receipt).

## Honest bring-up history (superseded iterations)

The path to green found and fixed, with regressions committed:
- `NODE_UNDECLARED work-item:1` — the first real Discovery run surfaced a
  declared-vs-observed planning graph divergence (scripted actors never
  produced the shape); fixed and pinned.
- Model "served instead of answering" — real cognition round task summaries
  reworked (`00261a0d`).
- Earlier superseded kits/evidence roots document the iteration honestly
  (36 evidence roots; only the runs above are qualifying).

The run operator agent died of context exhaustion after sealing the series
record but before writing this receipt — the coordinator verified the sealed
record (allGreen, kit binding, HEAD equality, evidence manifest) and authored
this document from the records.
