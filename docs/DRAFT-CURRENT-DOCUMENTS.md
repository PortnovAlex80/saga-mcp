# Current Documents — the sole active documentation index (DRAFT for EK-10 landing)

> **Status: DRAFT** (WP-14, for the EK-10 landing). After EK-10 this file is
> the **only** active documentation index of the repository. Every retained
> document appears here or on the explicit ADR list; everything else is
> deleted (git history is the archive; there is no `docs/archive`).
> Classification is frozen by
> `docs/refactoring/event-kernel/DOCUMENT-DELETION-MANIFEST.md`
> (439 entries: KEEP 177 / REWRITE 14 / DELETE 248; zero unclassified).
> This index is enforced by the current-document linter
> (`docs/refactoring/event-kernel/CURRENT-DOCUMENT-LINTER-SPEC.md`,
> `npm run test:docs-current`).

## 1. Law

1. One index: this file. A retained document absent from this index (or from
   the ADR registry) is a lint failure.
2. No document may claim to be the primary runbook, status page or live
   tracker other than the ones named here.
3. Obsolete documents are deleted, never archived in-tree.
4. Current documents describe only the current (event-projected) protocol;
   presenting a deleted symbol/table/command as current is a lint failure.
5. Generated graphs carry a fingerprint; a stale fingerprint is a lint
   failure.

## 2. First-time reading order

1. `AGENTS.md` (repo root) — mandatory instructions for any agent.
2. `docs/architecture/WORKFLOW-KERNEL.md` — owners, commands, events,
   obligations, waits, proofs, projection boundary.
3. `docs/architecture/CONVEYOR-MENTAL-MODEL.md` — the three laws in plain
   language (one authority · durable handoff · projection-only Kanban).
4. `docs/operations/FACTORY-RUNBOOK.md` — the sole operator runbook.
5. `docs/testing/WORKFLOW-KERNEL-TEST-STRATEGY.md` — how the protocol is
   proven.
6. Diagnostics when something stalls:
   `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md` (+ the
   `CONVEYOR-TRANSITION-CHECKLIST.md`).

## 3. Canonical current documents

| Document | Role |
|---|---|
| `AGENTS.md` | first-time agent entry: reading order + operator laws (opencode-only, settings tripwire) |
| `docs/architecture/WORKFLOW-KERNEL.md` | protocol reference: owners, vocabularies, projection boundary |
| `docs/architecture/CONVEYOR-MENTAL-MODEL.md` | architectural compass |
| `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md` | "why not advanced" from obligation/wait/proof evidence |
| `docs/architecture/CONVEYOR-TRANSITION-CHECKLIST.md` | transition + fault checklist |
| `docs/operations/FACTORY-RUNBOOK.md` | the sole runbook (fresh DB start, OpenCode setup, stop/resume, evidence, unsupported-old-DB) |
| `docs/testing/WORKFLOW-KERNEL-TEST-STRATEGY.md` | scenario contract, universe, fault matrix, project qualification |
| `docs/CURRENT-DOCUMENTS.md` | this index |

## 4. Fold map (REWRITE sources → canonical successors)

These legacy files are deleted at EK-10 when their rewrite lands; their
durable content lives only in the successor:

| Deleted at landing | Folded into |
|---|---|
| `README.md`, `README.ru.md` | repo entry points at this index + runbook |
| `ARCHITECTURE.md` | `WORKFLOW-KERNEL.md` |
| `CLAUDE.md` | runbook §0 (transport law; `FACTORY_CLAUDE_BACKEND_FORBIDDEN` preserved in intent) |
| `ЗАВОД-ЗАПУСК.md` | `FACTORY-RUNBOOK.md` |
| `docs/INSTALL.md` | `FACTORY-RUNBOOK.md` §1–2 |
| `docs/howto/AGENT-WORKER-MONITOR.md` | `FACTORY-RUNBOOK.md` §5 |
| `docs/architecture/README.md` | this index |
| `docs/architecture/FAILURE-AXES.md` | test strategy §5.1 (failure-axes frame) |
| `docs/design/TESTING-STRATEGY.md` | `WORKFLOW-KERNEL-TEST-STRATEGY.md` |

## 5. Retained reference and gate documents (KEEP)

| Document | Why kept |
|---|---|
| `GUARDRAILS.md` | runtime-agnostic agent guardrails |
| `docs/factory/CI-02-ACCEPTANCE-MATRIX.md` | active gate (acceptance matrix command) |
| `docs/factory/COMPLETION-EVIDENCE-CONTRACT.md` | active tooling contract |
| `docs/verification/ADR-053-CLOSURE-MATRIX-2026-08-25.md` | predecessor closure evidence; residual seam list imported by EK-1 |
| `docs/verification/verification-manifest.json` | active tooling manifest |
| `docs/factory-run/qualification-adr096/*` (COMPLETION-RECEIPT, INVENTORY, GATE-RECEIPT, CANARY-LEDGER, SCRIPTED-LEGS-LEDGER, SNAPSHOT-CORPUS-REPORT + receipts) | predecessor final record pinned by EK-0/EK-13 |
| `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md` | kept through qualification; closure state at EK-13 |
| `docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md` | predecessor plan; deletable only after EK-13 pins its completion SHA + receipt |
| `docs/vision/FROM-SOFTWARE-FACTORY-TO-ENGINEERING-PLANT.md`, `docs/vision/GO-TO-MARKET-RU-THEN-EU.md` | product vision / market strategy (runtime-agnostic) |
| `docs/pitch-deck/*` | product material |
| `tools/agent-proxy/README.md` | documents the surviving opencode transport |
| `docs/requirements/templates/{INVARIANCES,PRD,SRS}.md` | Formalization workshop authoring templates (re-hosted by WP-11F) |
| workshop package-resource documents (`src/process-modules/modules/*/package/resources/**`, `nodes/use-case/resources/**`, `src/modules/documentation/WORKSHOP.md`) | workshop semantics re-hosted in installed manifests by WP-11 |
| `tests/fixtures/golden-corpus/**` (22), `tests/factory-proof/MIGRATION-MAP.md` | immutable qualification evidence |
| repo icons (`icon.png`, `icon.svg`) | repo identity |

## 6. Refactoring records (kept through closure)

Under `docs/refactoring/event-kernel/`: the deletion manifests, frozen specs
(`specs/**` incl. `frozen-inputs/transition-universe.json`,
`PROTOCOL-DECISIONS-FROZEN.md`, `FROZEN-INPUTS.json`), admission receipt,
census and graphs, `EXECUTION-TRACKER.md`, `CURRENT-DOCUMENT-LINTER-SPEC.md`,
and (at EK-13) `FINAL-RECEIPT.md`. Their final disposition after closure is
recorded by FINAL-RECEIPT itself.

## 7. Decision history (KEEP — the explicit ADR list)

- `docs/architecture/decisions/024…098-*.md` — 72 ADRs (ADR-093
  reserved-absent by design), truthfully marked accepted / superseded /
  rejected; ADR-097/098 states updated only at EK-13 with executable
  evidence. Key current entries: ADR-053 (accepted-material authority),
  ADR-097 (event-projected workflow kernel), ADR-098 (frozen successor
  contracts).
- `docs/architecture/decision-journal/2026-08-23-*.md` — 4 registered
  journal entries backing ADR-092/094/095.
- `docs/architecture/adr-closure-registry.json`,
  `docs/architecture/legacy-allowlist.json` — load-bearing registries
  (allowlist shrinks to empty at EK-8).

## 8. Deleted at EK-10/EK-13 (summary; full rows in the manifest)

237 Markdown files + 11 artifacts classified DELETE: stage/night trackers
and handoff briefs, old live-status pages (`REFACTORING-PLAN-AND-STATUS.md`,
`PROGRAM-STATUS.md`, `ЖУРНАЛ-ЗАПУСКОВ.md`, workshop STATUS/JOURNAL/BUGS),
one-time audits and completed plans/designs of the old runtime, the
factory-map static graphs (superseded by generated maps + blocking
reconciliation), old-format fixture/design notes (deleted at EK-9),
agent briefs and old-flow skills, onboarding kits (`DRAGON-PROMPT.md`,
`DRAGON-MAP.md`), abandoned unregistered drafts. Evidence-bearing records are
deleted only after `FINAL-RECEIPT.md` pins their digests (EK-13 ordering).

Nothing on this index may be marked DELETE; nothing marked DELETE may be
added to this index.
