# Idea Traceability Post-Mortem — Elite-6 evidence copy

Source: `D:/Development/elite6-game/docs/IDEA-TRACEABILITY-POSTMORTEM.md`, copied unchanged in substance for read-only cross-repository analysis.

## Diagnosis

The epic ordered an Elite-style trading and combat browser game with a rich canvas frontend, dynamic per-system prices, arcade laser combat, a complete gameplay loop, 60fps, offline operation, zero build steps, a browser smoke test asserting the canvas renders, and `/healthz`. Discovery recorded the exact pricing algorithm as an Unknown.

Formalization produced 22 atomic acceptance criteria, but the post-mortem claims four things vanished: the dynamic pricing algorithm, arcade dynamics, the ordered browser smoke test, and an assembled-runnable-whole integration criterion. Qualitative experience terms also lacked measurable translation.

The proposed root cause is that the epic is treated as input rather than authority: local artifact validation does not prove conservation across the Discovery-to-Formalization translation.

## Proposed package A-G

A. Epic-as-authority trace gate: every epic/discovery scope clause maps to an AC or typed deferred/waived disposition; residue fails Formalization.

B. Requirements archaeologist: a second model sees only epic plus AC set and reports uncovered clauses; non-empty output triggers repair.

C. Unknowns are obligations: every Discovery Unknown becomes OPEN with an owner; Formalization cannot complete until resolved or explicitly deferred.

D. Mechanics/dynamics are first-class: algorithmic requirements belong in a mechanics-spec artifact referenced by ACs.

E. Runnable lifecycle auto-requires an integration AC and the ordered smoke-test AC.

F. Qualitative adjectives require numeric interpretation or explicit deferral.

G. Add conformance obligations: `formalization:trace:epic-clause-coverage`, `formalization:unknowns-owned`, `formalization:mechanics-spec-required`, `formalization:integration-ac-for-runnable-lifecycle`, `formalization:qualitative-quantified`.

## Product evidence asserted by the source

The front integration restored deterministic per-system economy, arcade cockpit combat, piloting, assembly and smoke-equivalent headless tests around the existing domain. The post-mortem concludes the loss occurred in translation above the domain.
