# docs/architecture — inventory

Classification-only inventory (stage 5, 2026-08-18): every top-level
markdown file below is classified under exactly one heading, with one line
on what it is and whether a reader today should act on it. Nothing was
moved or deleted to produce this list — relocation is a separate decision
made after the classification is visible. Companions in this directory:
`decisions/` (the ADR corpus, governed by ADR-076 and
`adr-closure-registry.json`), `legacy-allowlist.json` (the K2 legacy
freeze, enforced by `tests/architecture/legacy-expansion-freeze.test.mjs`),
and `proposals/`.

## Normative — binding today

- **CONVEYOR-MENTAL-MODEL.md** — the arbiter: the architectural compass
  (v5.2) every runtime/persistence/module/testing/replay/recovery/delivery
  change is reviewed against. Act on it: follow. Its content is not to be
  edited outside its own change protocol.
- **FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md** — the normative domain
  appendix: 29 REG-* concept cards and 14 E2E scenarios; every domain-model
  change must cite an existing criterion or amend the registry first. Act on
  it: follow. The most code-cited document here (REG ids appear throughout
  src/).
- **lifecycle-command-event-vocabulary.md** — the frozen (Slice 0)
  lifecycle command/event/effect vocabulary; identifiers must not be
  renamed without an ADR update. Act on it: follow. Known drift: its change
  protocol references `tests/lifecycle/oracle.test.mjs`, which does not
  exist.
- **CONVEYOR-TRANSITION-DIAGNOSTICS.md** — the normative target contract
  for transition diagnostics (universal execution grammar, three-record
  authority model, deterministic explainers). Act on it: follow — as a
  target: its own §7 states the cutover is not yet complete (e.g.
  `CausalContext` is not yet in src).
- **CONVEYOR-TRANSITION-CHECKLIST.md** — the operational appendix to the
  diagnostics contract: acceptance conditions and incident-card fields.
  Act on it: follow. Some listed reason codes are aspirational (ahead of
  implementation).
- **LEGACY-INVENTORY.md** — the K2 legacy inventory and temporary ownership
  map, carrying the binding rule that the legacy surface may only shrink
  (broadening requires a new ADR) and the schema snapshot burn-down. Act on
  it: follow; enforced by the freeze tests and `npm run legacy:report`.

## Historical — a true record of completed work, kept for provenance

- **ADR-053-CUTOVER-TODO.md** — the phased ADR-053 cutover plan (snapshot
  of 2026-08-12, including the reconciliation that flipped seven
  prematurely-checked items). Do not execute its checklist: remaining
  ADR-053 work is owned by the closure registry (ADR-053/073, K6–K13) and
  the renewal plan. Still programmatically consumed by
  `tests/architecture/adr-053-cutover-gates.test.mjs`.
- **ADR-053-QA-REPAIR-PLAN.md** — the QA repair dossier answering the
  static QA of db15b62: 17 defect classes verified, tranches landed the
  same day (C1–C15 fixed; C5 later resolved via the authority head). Do not
  act: its "ACTIVE" banner predates the work closing; read for provenance
  only.

## Stale — describes a superseded or abandoned plan

- **ADR-053-CUTOVER-EXECUTION-TRACKER.md** — the 2026-08-12 triple-
  verification tracker. Superseded as a tracking instrument: its master
  table no longer matches the code (its own B-3 concrete checks now pass in
  src), and remaining ADR-053 work is tracked by the registry, not here.
  Do not act on it.
- **FACTORY-CONTRACT-HARNESS-REFACTORING-PLAN.md** — a one-session
  implementation blueprint (baseline `ded7ebf`, CONVEYOR v4.3) whose
  targets are now in the codebase (WorkplaceProductionSnapshot,
  ScriptedWorkerExecutor, the factory-contract harness). Do not act on it:
  its anchors no longer match reality and nothing cites it.
