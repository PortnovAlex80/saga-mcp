# stage11/ document index — which report is current (TASK 3, stage-12 night)

Per the architect's stage-12 brief: one index, delete nothing. Reading order
for a newcomer; each line says what the document IS and whether it is current
or superseded.

| Document | What it is | Status |
|---|---|---|
| `REPORT.md` | The stage-11 brief's own task report (sealed-material fix, identity choice, TASK 1–6) | ✅ current for stage-11 scope |
| `ARCHITECT-HANDOVER-DRAFT.md` | The FINAL integrated handover to the architect (§0.1 state, brief-10/11 reports, terminal result, 13-tree change map, E1–E9 decisions, E9 proposal verbatim) | ✅ **current — the primary handover document** |
| `AGENT-REGISTRY.md` | Anchor file of every dispatched sub-agent (blindsight ×8, investigators Д1–Д3, architects М1–М3, implementers, recycle Р1–Р3) with responsibility splits and held branches | ✅ current (historical registry) |
| `DISORIENTATION-INVESTIGATION.md` | Д1/Д2/Д3 verdicts + the implementer correction (opencode 1.18.18 env.PWD mechanism; `--dir` pin) | ✅ current — root-cause record |
| `PREVENTIVE-HUNT.md` | The proactive defect hunt table (E-L1, C-17 etc., pre-run) | superseded in part: its findings fed the blindsight trees, all now merged; kept as the origin record |
| `FINAL-REPORT-PREP.md` | Working notes assembling the final report | superseded by `ARCHITECT-HANDOVER-DRAFT.md` |

Related material that lives elsewhere: the ratified remedy designs
(`docs/architecture/AC-DRIFT-REMEDY-DESIGN.md`, `CERTIFICATION-GAMING-REMEDY.md`,
`RECYCLE-RUN-DESIGN.md`, `E9-RESERVE.md`), the golden corpora
(`tests/fixtures/golden-corpus/stage11-docking-full` = RED fixture,
`-w12` = clean prefix), and the sealed run record
(`.factory-sandboxes/stage10-db/`, `stage11-db/`, snapshots under
`factory-snapshots/`).
