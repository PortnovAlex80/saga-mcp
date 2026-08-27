# DOCUMENT-DELETION-MANIFEST — Event-Projected Kernel (EK-1 / WP-04)

- **Base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df`
- **Author:** WP-04 implementer (classification only — nothing is deleted by this document)
- **Plan:** `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md` — EK-1 "Deletion manifests" + EK-10 "Canonical documentation rewrite and purge" ("Documentation policy: obsolete documents are deleted, not moved to an archive directory. Git history is the archive.")
- **Enumeration:** `git ls-files '*.md'` (417 files) plus the non-Markdown documentation artifacts under `docs/` (graph JSONs, registries, ledgers, demo assets). Every enumerated file appears on exactly one row; rows group files only when they share disposition and reason.

## Classification rules (fixed for EK-10)

- **KEEP** — survives the purge: registered ADR/decision history, the predecessor's final-record evidence, active gate/tooling contracts, product vision, this plan (through qualification).
- **REWRITE** — the document continues to exist only as (or inside) one of the eight EK-10 canonical documents: `docs/architecture/WORKFLOW-KERNEL.md`, rewritten `CONVEYOR-MENTAL-MODEL.md` / `CONVEYOR-TRANSITION-DIAGNOSTICS.md` / `CONVEYOR-TRANSITION-CHECKLIST.md`, `docs/operations/FACTORY-RUNBOOK.md`, `docs/testing/WORKFLOW-KERNEL-TEST-STRATEGY.md`, `docs/CURRENT-DOCUMENTS.md`, updated `AGENTS.md`. The old file itself is deleted when its rewrite lands (delete, do not archive).
- **DELETE** — obsolete. Stage trackers, night briefs, handoffs, old live-status pages, one-time audits, old-runtime design notes: deleted at EK-10 after their durable information (final-receipt digests, ADR registry entries, EK-1 specs) is pinned in the final record. Git history is the archive; no `docs/archive` is created.
- Deletion of evidence-bearing records happens **after** `docs/refactoring/event-kernel/FINAL-RECEIPT.md` pins their SHAs/digests (EK-13 ordering).

## A. Repository root (12)

| File | Verdict | Reason / successor |
|---|---|---|
| `AGENTS.md` | REWRITE | EK-10 explicit: a first-time agent must read the new kernel, runbook and test strategy; the claude-CLI prohibition and settings tripwire law stays |
| `README.md` / `README.ru.md` | REWRITE | repo entry docs must describe the new protocol; fold into `docs/CURRENT-DOCUMENTS.md` + `FACTORY-RUNBOOK.md` |
| `ARCHITECTURE.md` | REWRITE | one-page architecture summary pointing at the rewritten mental model; fold into `WORKFLOW-KERNEL.md` |
| `CLAUDE.md` | REWRITE | transport/backend session notes; rewrite to the WP-18 instrumented OpenCode transport; the `FACTORY_CLAUDE_BACKEND_FORBIDDEN` law is preserved verbatim in intent |
| `GUARDRAILS.md` | KEEP | runtime-agnostic agent guardrails; test-deletion rule was satisfied for ADR-095 by operator directive and for EK by the plan itself |
| `DRAGON-PROMPT.md` / `DRAGON-MAP.md` | DELETE | onboarding kit for the deleted factory; successor is the rewritten `AGENTS.md` + `WORKFLOW-KERNEL.md` |
| `ЗАВОД-ЗАПУСК.md` | REWRITE | canonical factory-start instruction; folds into `docs/operations/FACTORY-RUNBOOK.md` |
| `ЖУРНАЛ-ЗАПУСКОВ.md` | DELETE | old launch journal (live-status log); FINAL-RECEIPT + run receipts succeed |
| `.claude/skills/saga-mcp/SKILL.md` | DELETE | points at the removed MCP tool surface; new tool surface documented under the runbook |
| `icon.png` / `icon.svg` (repo icons) | KEEP | repo identity assets |

## B. `docs/` root (5)

| File | Verdict | Reason |
|---|---|---|
| `DOCUMENT-STRUCTURE-REVIEW-2026-08-20.md` | DELETE | one-time structure review; `docs/CURRENT-DOCUMENTS.md` + linter succeed |
| `INSTALL.md` | REWRITE | folds into `FACTORY-RUNBOOK.md` (fresh-DB start, OpenCode setup) |
| `REFACTORING-PLAN-AND-STATUS.md` | DELETE | old live-status page (plan rule: delete old live-status pages) |
| `SYSTEM-ACCEPTANCE-CRITERIA.md` | DELETE | top-level acceptance criteria of the old system; EK-13 FINAL-RECEIPT + EK-9 blocking suites are the successor truth |
| `WEAK-MODEL-CONTROL-CHECKLIST.md` | DELETE | checklist for the old process-module worker frame; bounded-execution semantics are re-frozen by the role/context contracts (EK-1) |

## C. `docs/architecture/` (26 + proposals 1 + decision-journal 4 + decisions 72)

### C.1 Prose (26 + 1 proposal)

| File | Verdict | Reason |
|---|---|---|
| `CONVEYOR-MENTAL-MODEL.md` | REWRITE | EK-10 explicit rewrite to the new protocol |
| `CONVEYOR-TRANSITION-DIAGNOSTICS.md` | REWRITE | EK-10 explicit: diagnose from persisted obligation/wait/proof evidence only |
| `CONVEYOR-TRANSITION-CHECKLIST.md` | REWRITE | EK-10 explicit: new transition and fault checklist |
| `README.md` | REWRITE | section index folds into `docs/CURRENT-DOCUMENTS.md` (the sole active index) |
| `FAILURE-AXES.md` | REWRITE | failure-axis taxonomy feeds the EK-9 fault matrix inside `WORKFLOW-KERNEL-TEST-STRATEGY.md` |
| `AC-DRIFT-REMEDY-DESIGN.md` | DELETE | completed remedy design for the old runtime |
| `ADR-053-CUTOVER-TODO.md` | DELETE | completed; the closure matrix + registry are the record |
| `ADR-053-QA-REPAIR-PLAN.md` | DELETE | completed repair plan |
| `BRANCH-CLEANUP-2026-08-20.md` | DELETE | one-time ops record; INVENTORY/receipts pin the topology |
| `CERTIFICATION-GAMING-REMEDY.md` | DELETE | old-runtime anti-gaming remedy; surviving invariants become EK-9 mutations |
| `E2-MIGRATION-NOTE.md` | DELETE | migration note for a completed stage |
| `E9-RESERVE.md` | DELETE | Elite-9 reserve op note; final record pins the evidence-tree decision |
| `FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md` | DELETE | acceptance registry of the old domain; `WORKFLOW-KERNEL.md` + EK-1 transition universe succeed |
| `FINDING-TRAJECTORY-BUDGET.md` | DELETE | old finding-budget mechanism; gate budget re-frozen by EK-1 |
| `LEGACY-INVENTORY.md` | DELETE | superseded by `docs/refactoring/event-kernel/LEGACY-DELETION-MANIFEST.md` (git history preserves it) |
| `lifecycle-command-event-vocabulary.md` | DELETE | old vocabulary; the EK-1 transition universe + `WORKFLOW-KERNEL.md` are the successor |
| `NEW-WORKSHOP-DESIGN-AUTHORING-GUIDE.md` | DELETE | authoring guide for the removed package format; the new workshop interface is frozen in EK-1 |
| `PAUSE-DESIGN.md` | DELETE | old pause design; `TypedWait` + operator commands succeed |
| `PROCESS-MODULE-ARCHITECTURAL-REFACTORING-GUIDE.md` | DELETE | guide for the deleted process-module stratum |
| `PROVIDER-RETRY-DESIGN.md` | DELETE | retry re-specified by EK-4 fault semantics |
| `RECYCLE-RUN-DESIGN.md` | DELETE | old recycle-run design |
| `REPAIR-CODE-PRESERVATION.md` | DELETE | old repair-code scheme; typed repair obligations succeed |
| `REPLAN-CYCLE-TZ.md` | DELETE | old replan-cycle design; EK-6 settlement succeeds |
| `SEAM-ARCHITECT-DESIGN.md` | DELETE | old seam-architect design |
| `WORKER-NAMES-DESIGN.md` | DELETE | documents the deleted `worker-names` module |
| `WORKSHOP-CONTROL-TRACKING.md` | DELETE | old workshop control tracking |
| `proposals/worker-exit-consistency-protocol.md` | DELETE | abandoned unregistered draft (plan rule: delete abandoned unregistered drafts) |

### C.2 Decision history (76 files) — all KEEP

| Group | Files | Verdict | Reason |
|---|---|---|---|
| ADRs | `decisions/024-…098-*.md` (72; ADR-093 remains reserved-absent by design) | KEEP | registered decision history, truthfully marked accepted/superseded/rejected (plan EK-10 rule); ADR-097/098 states updated only at EK-13 with executable evidence |
| Decision journal | `decision-journal/2026-08-23-*.md` (4) | KEEP | registered decision journal backing ADR-092/094/095 |
| Registry | `adr-closure-registry.json`, `legacy-allowlist.json` | KEEP | load-bearing for `npm run adr-closure:validate` (EK-0/EK-13 blocking); allowlist shrinks to empty at EK-8 |

## D. `docs/design/` (6)

| File | Verdict | Reason |
|---|---|---|
| `TESTING-STRATEGY.md` | REWRITE | folds into `docs/testing/WORKFLOW-KERNEL-TEST-STRATEGY.md` |
| `EXECUTION-ROUTE-ARCHITECTURE.md` | DELETE | old routing architecture; `executorRoutePolicyRef` (EK-1) succeeds |
| `FACTORY-CHECKPOINT-AND-TEST-PROFILES.md` | DELETE | checkpoints are deleted (obligation recovery succeeds) |
| `FACTORY-CORE-VIEW.md` | DELETE | old core-view experiment (its tree dies with it) |
| `FACTORY-TEMPORAL-TESTING.md` | DELETE | temporal/restart dimension is an explicit EK-9 required dimension in the new strategy doc |
| `PARTIAL-RESET-AND-RESUME.md` | DELETE | old resume design; fresh-protocol-only + obligation redrive succeed |

## E. `docs/factory-map/` (12 md + 3 json) — all DELETE

`00_FACTORY_CONTRACT.md`, `01_DISCOVERY.md`, `02_FORMALIZATION.md`, `03_DEVELOPMENT.md`, `04_DELIVERY.md`, `ARTIFACT_LINEAGE.md`, `BRIDGE_MATRIX.md`, `FORWARD_GRAPH.md`, `REVERSE_GRAPH.md`, `GRAPH_RECONCILIATION.md`, `STATE_MATRIX.md`, `TEST_COVERAGE.md`, `forward-graph.v1.json`, `reverse-graph.v1.json`, `graph-reconciliation.v1.json` — DELETE at EK-10: static maps and authority prose of the deleted runtime; the plan requires deleting old static forward/reverse maps once the new generated maps + reconciliation command are blocking (EK-9). ADR-095/096 cite them as evidence; git history (and the digests pinned by the registry) preserve that chain. No archive directory.

## F. `docs/factory-run/` (43 md + evidence artifacts)

| Group | Files | Verdict | Reason |
|---|---|---|---|
| Predecessor final record | `qualification-adr096/COMPLETION-RECEIPT.md`, `INVENTORY.md`, `GATE-RECEIPT.md`, `CANARY-LEDGER.md`, `SCRIPTED-LEGS-LEDGER.md`, `SNAPSHOT-CORPUS-REPORT.md` (+ `receipts/*.json`, build receipts) | KEEP | the predecessor completion receipt and ledgers that EK-0 verifies and EK-13 FINAL-RECEIPT pins; deleting them before closure would orphan the successor gate |
| Conformance closure | `conformance-closure/CC-00-BASELINE.md`, `CC-00B-ELITE6-TERMINAL-INTEGRITY.md`, `CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md` (+ `CC-00-baseline-ledger.json`) | DELETE | predecessor conformance evidence; EK-9 `WORKFLOW_OBLIGATION_UNIVERSE` succeeds it; digests pinned in FINAL-RECEIPT |
| Stage trackers/reports | `stage10/ORDER.md`; `stage11/` (6); `stage12/` (3); `stage13/`, `stage14/`, `stage16/`, `stage18/` (reports); `stage15/`, `stage19/`, `stage20-elite/` (run trackers); `stage21-elite7/` (2); `stage22-elite9/` (4 incl. DISCOVERY-PHASE1-CENSUS, PHASE2C-RATCHETS, PHASE6-CLOSURE, PRE-ELITE9-TRACKER); `stage23-devtest/TRACKER.md` (+ `stage10/BUG-DATABASE.json`, `stage13/RED-evidence-*.txt`, `stage20-elite/task13-evidence/*.jsonl`) | DELETE | completed stage trackers, night trackers, reports and evidence drops; their durable information (ADR-095 closure, receipts, residuals) is pinned by the ADR registry, the completion receipt and FINAL-RECEIPT |

## G. `docs/factory/` (9)

| File | Verdict | Reason |
|---|---|---|
| `CI-02-ACCEPTANCE-MATRIX.md` | KEEP | active gate: the acceptance matrix remains a canonical EK-9 blocking command |
| `COMPLETION-EVIDENCE-CONTRACT.md` | KEEP | active gate: contract of `tools/validate-completion-evidence.mjs` (kept tooling) |
| `CI-01-LEGACY-LINT-BACKLOG.md` | DELETE | consumed backlog; legacy-zero ratchet succeeds |
| `CI-03-CLEAN-BASELINE.md` | DELETE | stage baseline record |
| `C7-TEMPORAL-FENCING-CLOSED.md` | DELETE | closed stage evidence |
| `COMPLETION-BASELINE.md` / `COMPLETION-LEDGER.md` | DELETE | old completion-stage records |
| `DEVELOPMENT-WORKSHOP-CONTRACT.md` | DELETE | contract of the old Development workshop binding; the EK-1 workshop interface succeeds |
| `W9-SCRIPTED-E2E-EVIDENCE.md` | DELETE | stage evidence; EK-11 scripted corpus succeeds |

## H. `docs/handoff/` (25) — all DELETE

`STAGE-2-…STAGE-18-AGENT-BRIEF.md` (17), `STAGE-9-ADDENDUM.md`, `2026-08-21-*.md` (6), `2026-08-22-morning-briefing.md` — completed handoff briefs; the plan deletes handoff briefs after their information lands in the final record (EK-10).

## I. `docs/howto/` (1)

| File | Verdict | Reason |
|---|---|---|
| `AGENT-WORKER-MONITOR.md` | REWRITE | operator monitoring procedure folds into `FACTORY-RUNBOOK.md` |

## J. `docs/ideas/` (5) — all DELETE

`P01-counter.md`, `P02-stopwatch.md`, `P03-tips.md`, `P21-foodlog.md`, `P22-trackplan.md` — old testbed idea inputs; the EK-11 20-project corpus with versioned capsules succeeds.

## K. `docs/pitch-deck/` (1 md + demo assets) — KEEP

Product/marketing material, runtime-agnostic.

## L. `docs/plans/` (9)

| File | Verdict | Reason |
|---|---|---|
| `EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md` | KEEP | kept through qualification per the plan's own rule; its closure state updates at EK-13 |
| `CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md` | KEEP | predecessor plan: deletable only after EK-13 pins its completion SHA + receipt in FINAL-RECEIPT (plan rule); until then it is the gate document |
| `CONFORMANCE-CLOSURE-PLAN.md` | DELETE | completed plan |
| `DEVELOPMENT-CAPSULE-QUALIFICATION-PLAN.md` | DELETE | superseded by the EK-11 immutable kit |
| `KERNEL-CONFORMANCE-WAVE-SCHEDULE.md` | DELETE | completed wave schedule |
| `PROCESS-MODULE-PACKAGE-SPI.md` | DELETE | SPI of the deleted package format; the EK-1 workshop interface succeeds |
| `PROJECT-STRUCTURAL-CLEANUP-PLAN.md` | DELETE | completed plan |
| `SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md` | DELETE | superseded by the EK-9 universal test engine |
| `WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md` | DELETE | completed plan |

## M. `docs/requirements/templates/` (3) — KEEP (path moves)

`INVARIANCES.md`, `PRD.md`, `SRS.md` — product authoring templates consumed by the Formalization workshop skill (`saga-analyst`); kept as workshop semantics, re-hosted inside the formalization package resources by WP-11F (cross-ref: legacy manifest §B.12).

## N. `docs/research/` (6) — all DELETE

`2026-08-18-ees-admission-judgment.md`, `2026-08-18-kernel-surface-evidence-development-chain.md`, `2026-08-18-real-run-gap-analysis.md`, `ARCHITECTURE-RESEARCH-2026-08-18.md`, `CONVEYOR-TRANSITION-AUDIT-2026-08-18.md`, `WORKER-FEEDBACK-LOOP-MAP.md` — one-time audits of the old runtime; their durable findings live in ADRs and the factory maps already deleted with E.

## O. `docs/testing/` (19 md + `projects.json`)

| File | Verdict | Reason |
|---|---|---|
| `WORKSHOP-TEST-PLAN.md`, `WORKSHOP-STATUS.md`, `WORKSHOP-JOURNAL.md`, `WORKSHOP-BUGS.md` | DELETE | plan-explicit: delete the old workshop test plan/status/journal once the new strategy + machine evidence replace them |
| `WORKSHOP-CONFORMANCE-COVERAGE-AGENT-GUIDE.md`, `WORKSHOP-CONFORMANCE-PACK-AUTHORING-GUIDE.md` | DELETE | old conformance-pack authoring; the EK-9 scenario contract + corpus succeed |
| `CAUSAL-PROOF-IMPLEMENTATION-BRIEFS.md` | DELETE | old causal-proof briefs; EK-9 engine requirements succeed |
| `CONFORMANCE-ENGINE-V1-REFRACTORING-INVENTORY.md` | DELETE | completed inventory |
| `DELIVERY-KERNEL-REPAIR-PLAN.md` | DELETE | completed plan |
| `G3-MERGE-GRANT-CONFLICT.md`, `G4-LEASE-ARITHMETIC.md` | DELETE | old-runtime analyses; invariants re-hosted as EK-9 mutations |
| `GRAPH-TEST-STRATEGY.md` | DELETE | superseded by `WORKFLOW-KERNEL-TEST-STRATEGY.md` |
| `SNAPSHOT-TEST-DESIGN.md` | DELETE | snapshot mechanism is deleted |
| `TASK-C-PREVERIFICATION.md` | DELETE | completed task record |
| `W1-BLIND-REVIEW.md`, `W2-SPEED-AND-RECOVERY-ARCHITECTURE-ANALYSIS.md`, `W9-04-UNREACHABLE-EDGE-EVIDENCE.md`, `WORKSHOP-W1-W2-ANALYSIS-REPORT.md`, `WORKSHOP-W1-W2-INDEPENDENT-VERIFICATION.md` | DELETE | workshop wave records |
| `projects.json` | DELETE | old workshop test project list; EK-11 corpus (P01–P20) succeeds |

## P. `docs/verification/` (5 md + manifest)

| File | Verdict | Reason |
|---|---|---|
| `ADR-053-CLOSURE-MATRIX-2026-08-25.md` | KEEP | predecessor closure evidence; carries the residual seam list imported by EK-1 (blocking EK-13 criteria) |
| `verification-manifest.json` | KEEP | active tooling manifest of `tools/verification-manifest.mjs` |
| `CANONICAL-BASELINE-K1.md`, `K13-AUTHORITY-CLOSURE-PROOF.md`, `LEGACY-BURNDOWN-K2.md` | DELETE | predecessor K-stage records; digests pinned in receipts/FINAL-RECEIPT; EK-13 re-runs census/legacy-zero |
| `PROGRAM-STATUS.md` | DELETE | old live-status page |

## Q. `docs/vision/` (4)

| File | Verdict | Reason |
|---|---|---|
| `FROM-SOFTWARE-FACTORY-TO-ENGINEERING-PLANT.md` | KEEP | product vision, runtime-agnostic |
| `GO-TO-MARKET-RU-THEN-EU.md` | KEEP | market strategy, runtime-agnostic |
| `SAGA-CORE-RENEWAL-PLAN.md` | DELETE | superseded renewal plan (executed or abandoned; ADR-097 line succeeds) |
| `CONTROLLED-CHANGE-PLANE-PLAN.md` | DELETE | incremental C0–C13 ladder over the old runtime; the event-projected kernel replaces the change-plane mechanism |

## R. `docs/workshops/` (2) — all DELETE

`HOW-TO-BUILD-A-WORKSHOP.md` (old package-format guide; EK-1 workshop interface succeeds), `DOCUMENTATION-RELEASE-DESIGN.md` (old documentation-workshop design; WP-11 conversion succeeds).

## S. Documentation embedded outside `docs/`

| Group | Files | Verdict | Reason |
|---|---|---|---|
| Agent briefs | `agents/*.md` (6) | DELETE | old product-board briefs; role contracts + launch profiles succeed |
| Agent skills | `skills/**` (28 md) | DELETE | old-flow skills; cognition content re-hosted as pinned manifest skills (legacy manifest §F) |
| Synthetic workshops/scenarios | `modules-ext/**` (11 md), `scenarios-ext/**` (2 md) | DELETE at EK-8 | old-format synthetic workshops; re-expressed as one new-interface synthetic workshop (EK-8 requirement) |
| Idea notes | `ideas/**` (2 md) | DELETE | old testbed inputs |
| Experiment/designer trees | `core-view/**` (2), `workshop-designer/README.md`, `tool-templates/process-modules/module-stage-tracker.md` | DELETE | old-format tooling/templates |
| Authoring kits | `tools/module-authoring-kit/**` (3 md), `tools/scenario-authoring-kit/**` (2 md) | DELETE | authoring kits of the deleted formats (legacy manifest §D) |
| Transport doc | `tools/agent-proxy/README.md` | KEEP | documents the surviving opencode transport (WP-18 instruments it) |
| Qualification product fixture doc | `tools/qualify/fixtures/md-site/content.md` | KEEP | the markdown INPUT of the EK-11 md-site product fixture (WP-15): the generator's own source material, verified by the qualification product smoke — not documentation (amendment 2026-08-26) |
| Docs-graph | `tracker-view/docs-graph/README.md` | DELETE | dies with the docs-graph tool (WP-10 decision) |
| Package resources .md | `src/process-modules/modules/*/package/resources/**` (45 md) + `nodes/use-case/resources/**` (2 md) + `src/modules/documentation/WORKSHOP.md` (1) = 48 | DELETE (content re-hosted — amendment 2026-08-26, same as legacy §B.12) | workshop semantics re-hosted in installed manifests by WP-11 (landed); the old paths were deleted at the EK-8 cutover |
| Requirements templates | `docs/requirements/templates/**` (3) | KEEP (path moves) | see §M |
| Test-fixture documents | `tests/fixtures/golden-corpus/**` (22 md across the corpora) | KEEP | immutable qualification evidence (legacy manifest §E) |
| Test-fixture documents (other) | `tests/characterization/fixtures/2026-07-28-failures/**` (8), `tests/factory-contract/design/**` (11), `tests/fixtures/synthetic-{modules,scenarios}/**` (4), `tests/installation/fixtures/**` (2), `tests/matrix/` (1), `tests/MOCK-CLAUDE.md` (1) | DELETE at EK-9 | fixtures/design notes of deleted old-format suites (legacy manifest §E split rule) |
| Evidence note | `tests/factory-proof/MIGRATION-MAP.md` | DELETE (amendment 2026-08-26) | the note mapped the old factory-proof suites onto the EK waves; its consumers were deleted at the EK-8 cutover (historical copy stays in git) |

## T. Counts (verified against `git ls-files` on the base SHA)

- Enumerated: **417** tracked `.md` files + **22** non-Markdown documentation artifacts (3 factory-map graph JSONs, 2 architecture registries, 2 qualification build receipts, verification-manifest.json, CC-00 baseline ledger, stage10 BUG-DATABASE.json, 2 RED-evidence files, 3 stage20 task13 evidence JSONLs, testing/projects.json, 4 pitch-deck demo assets, 2 repo icons) = **439 entries**.
- **Markdown: KEEP 166 / REWRITE 14 / DELETE 237** (sum 417; zero unclassified).
  - KEEP 166 = 76 decision history (72 ADRs + 4 journal) + 6 qualification-adr096 final record + 1 ADR-053 closure matrix + 1 CI-02 acceptance matrix + 1 completion-evidence contract + 2 vision + 1 pitch-deck + 2 plans (this EK plan + predecessor plan until EK-13 pins its receipt) + 1 GUARDRAILS + 1 agent-proxy README + 3 requirement templates (path moves, §M) + 48 workshop package-resource documents (path moves, §S) + 23 test-evidence documents (22 golden-corpus + MIGRATION-MAP).
  - REWRITE 14 = AGENTS.md, README.md, README.ru.md, ARCHITECTURE.md, CLAUDE.md, ЗАВОД-ЗАПУСК.md, INSTALL.md, architecture README.md, FAILURE-AXES.md, the three conveyor docs, design/TESTING-STRATEGY.md, howto/AGENT-WORKER-MONITOR.md.
  - DELETE 237 = root 3 (DRAGON-PROMPT, DRAGON-MAP, ЖУРНАЛ-ЗАПУСКОВ) + .claude 1 + docs-root 4 + architecture prose 22 (incl. the unregistered proposal) + design 5 + factory-map 12 + factory-run 27 (stages + conformance-closure) + factory 7 + handoff 25 + ideas(docs) 5 + plans 7 + research 6 + testing 19 + verification 4 + vision 2 + workshops 2 + agents 6 + skills 28 + modules-ext 11 + scenarios-ext 2 + ideas(root) 2 + core-view 2 + workshop-designer 1 + tool-templates 1 + tools 5 + tracker-view/docs-graph 1 + old-format test-fixture documents 29 (characterization 8, factory-contract/design 11, synthetic 4, installation 2, matrix 1, MOCK-CLAUDE 1).
- **Artifacts: KEEP 11 / DELETE 11.** Grand totals: **KEEP 177 / REWRITE 14 / DELETE 248**.
- Zero unclassified; nothing both KEEP and DELETE; every DELETE with evidence value is ordered after FINAL-RECEIPT pinning.
## U. EK-wave additions (14) — classified 2026-08-26

Files that joined the document scope during the EK waves (successor plan,
human-gate console design record, per-package cutover notes, a committed
test fixture, and the pre-existing DRAFT-* supersession set surfaced by the
no-rot sweep).

| Group | Files | Verdict | Reason |
|---|---|---|---|
| DRAFT supersession set | `DRAFT-AGENTS.md`, `docs/DRAFT-CURRENT-DOCUMENTS.md`, `docs/architecture/DRAFT-CONVEYOR-MENTAL-MODEL.md`, `docs/architecture/DRAFT-CONVEYOR-TRANSITION-CHECKLIST.md`, `docs/architecture/DRAFT-CONVEYOR-TRANSITION-DIAGNOSTICS.md`, `docs/architecture/DRAFT-WORKFLOW-KERNEL.md`, `docs/operations/DRAFT-FACTORY-RUNBOOK.md`, `docs/testing/DRAFT-WORKFLOW-KERNEL-TEST-STRATEGY.md` | DELETE | drafts superseded by their living counterparts; EK-10 rewrites the living docs, never the drafts |
| Human-gate law | `docs/architecture/HUMAN-GATE-CONSOLE.md` | REWRITE | the human-boundary law (operator disposition, append-only audit, bytes guard) folds into the EK-10 runbook + kernel docs; the saga4-specific console implementation dies with the old runtime |
| Successor plan | `docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md` | KEEP | plan of record (executes after EK-13) |
| Cutover artifacts | `src/workflow-kernel/development/EK8-DELETION-SET.md`, `src/workflow-kernel/workshops/delivery/EK8-DELETION-SET.md`, `src/workflow-kernel/workshops/discovery/EK8-CUTOVER-NOTES.md`, `src/workflow-kernel/workshops/formalization/EK8-DELETION-SET.md` (added 2026-08-26 — the WP-11F file was missed by the original sweep; classified in the same commit as the WP-12 cutover it stages) | KEEP | live refactoring artifacts consumed by WP-12's cutover |
| Test fixture | `tests/infrastructure/ek-fixtures/elite-smoke/product/docs/srs.md` | KEEP | committed determinism fixture content (WP-13C) |
| New-kernel front clones (2026-08-27, operator directive) | `core-view-ek/README.md`, `tracker-view-ek/README.md` | KEEP | the read-only observer and command kanban fronts for the event kernel — permanent tools (code files classified in the legacy manifest §D kept-tooling) |

## V. FRF-wave additions — classified 2026-08-27 (FRF-WP11)

The Formalization Scenario-First Refactoring docs (the successor plan of
record; its tree arrived after the EK-10 purge, wave by wave FRF-WP01..11).
All KEEP: the plan executes through FRF-WP12 qualification.

| Group | Files | Verdict | Reason |
|---|---|---|---|
| FRF plan-of-record docs | `docs/refactoring/formalization-frf/**` — the tracker, DELETION-MANIFEST, TEST-CLASSIFICATION, INTENTIONAL-DIFFERENCE-LEDGER, baseline/ captures with their regenerable inventory scripts, and the frozen WP03 contract snapshots under contracts/ (validators, schemas, the green/red fixture corpus, the coverage-check and run-proof tools) | KEEP | the successor plan's execution evidence through FRF-WP12; since the FRF-WP11 cutover the contracts/ tree is the FROZEN SNAPSHOT of the canonical in-package contracts (src/workflow-kernel/workshops/formalization/contracts/) — the FRF removal guard asserts byte-equality per file |
| Installed FRF cell docs | `src/workflow-kernel/workshops/formalization/cells/acceptance/README.md`, `src/workflow-kernel/workshops/formalization/cells/product-intent/README.md`, `src/workflow-kernel/workshops/formalization/cells/use-cases/README.md`, `src/workflow-kernel/workshops/formalization/cells/what-freeze/README.md`, `src/workflow-kernel/workshops/formalization/cells/system-requirements/SEAM.md` | KEEP | the installed FRF cells' documented seams (the FRF-WP11 cutover made the cells the installed desk authority; the prose documents the same laws the blocking suites pin) |
