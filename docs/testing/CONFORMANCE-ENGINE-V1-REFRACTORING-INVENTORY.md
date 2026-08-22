# Conformance Engine v1 — Refactoring Plan Inventory (2026-08-22)

The v1 iteration ends with a trustworthy measurement instrument (see
`tests/factory-proof/conformance-engine.mjs` + `tests/factory-evidence/`).
The refactoring plans below are INVENTORY ONLY in this iteration — the
operator directive was explicit: build the instrument, do not chase
percentages and do not start structural moves inside it.

## Plans found in the Aug 21–22 commits

| Plan | Path | Gate | Status |
|---|---|---|---|
| Workshop modularization | `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md` | Structural Refactor Qualification Gate | planning input only — gate partially green (below) |
| Process-module refactoring guide (R0–R…) | `docs/architecture/PROCESS-MODULE-ARCHITECTURAL-REFACTORING-GUIDE.md` | same gate; R-phases after | untouched this iteration; guide is the execution manual |
| Project structural cleanup | `docs/plans/PROJECT-STRUCTURAL-CLEANUP-PLAN.md` | defines the gate | gate checklist re-evaluated below |
| Kernel conformance engine (K0–K8) | `docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md` | — | EXECUTED this iteration (K0–K5 substance; K3 mutation algebra + K4 fault scheduler remain) |
| Kernel wave schedule | `docs/plans/KERNEL-CONFORMANCE-WAVE-SCHEDULE.md` | — | waves consumed through the 4-workshop unification |
| Process-module package SPI | `docs/plans/PROCESS-MODULE-PACKAGE-SPI.md` | modularization gate | untouched |
| Workshop co-location cutover (ADR-085/086) | `docs/architecture/decisions/` | gate + WP-00 evidence freeze | untouched |

## Structural Refactor Qualification Gate — honest re-evaluation (2026-08-22)

- [x] K0 baseline, normalized trace vocabulary, non-vacuity floors
- [x] K1 one truthful canonical proof composition and fingerprint
- [~] K2 strict L3 through the production `workerSpawn` seam — the strict
      spawn drive exists (`k2-strict-formalization-drive.mjs`); full-workshop
      strict coverage is not claimed
- [ ] K3 independent obligation contracts + **mutation algebra** — mutation
      kill rate is honestly "not measured" in the v1 report
- [~] K4 read-only observer + scenario DSL + evidence bundle — landed; the
      **fault scheduler is NOT landed** (the runner refuses FaultSchedule
      modes by design)
- [x] K5 non-empty blocking `factory-proof` group with coverage self-tests
- [x] blocking group contains full-lifecycle happy scenarios (all 4 workshops)
- [x] blocking group contains feedback-driven same-Workplace repair scenarios
      (discovery/formalization feedback families, 100% demonstrated)

**Verdict: the gate is NOT yet green.** The blocking items are K3's mutation
algebra and K4's fault scheduler — exactly the two capabilities the v1 report
lists as "not measured". They are the first work items of the next iteration
(Conformance Closure), after which the modularization plan may consume the
committed evidence snapshot (WP-00) and begin moving workshop ownership.

## What v1 hands to the next iteration

1. The committed evidence snapshot (`tests/factory-evidence/`) — 67 PASS
   bundles, reproducible via `npm run conformance:v1`, regenerable via
   `npm run conformance:harvest`.
2. The monotonic universe (147 tokens) with blocked obligations as data.
3. The honest baseline numbers: Discovery 100%, Formalization 100%,
   Development 20%, Delivery 60% demonstrated.
4. The F-A completion debt (prompt BYTES vs UTF-16 length + hard caps) —
   deferred until the live Elite-4 factory run terminates, because
   `tracker-view/claude-runner.mjs` is the running factory's spawn path.
