# 040. Ship recovery as one authority-complete vertical

- **Status:** Accepted
- **Date:** 2026-08-09
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

The stopped Product Delivery run cannot be resumed lawfully: its LifecycleRun,
Development StageRun and ProcessRun are terminal failed after a Git integration
conflict. Discovery and Formalization are completed and content-addressed, and
the product repository already contains the accepted task-15 merge. Starting a
new full lifecycle would repeat accepted workshops; reopening terminal rows
would corrupt their single-outcome meaning.

ADR-038 selected an append-only continuation from the accepted Formalization
prefix. ADR-039 selected managed TextSet production with Factory-owned Git.
Implementation still had a deployment fork: ship the entire authority boundary,
ship the universal substrate first, or use a bounded child run while deferring
TextSet and durable effects.

The repository guardrails make correctness and evidence preservation release
constraints, not optional refinements. Sign 012 requires durable non-terminal
recovery evidence; Sign 014 binds dependency edges and effective desk bases as
one admission invariant. Current code violates both relevant boundaries:

- fan-out Workplaces are admitted before the dependency graph is sealed;
- dependency edges are rebuilt from transient task status and can shrink;
- every author desk receives the original Development base;
- the final GateDecision terminalizes the Workplace before Git integration;
- Git integration is a `void` callback without a durable intent/receipt;
- LM workers retain shared-worktree Git authority.

Cynefin classification: **Complex**. The change introduces new authority and
recovery contracts across lifecycle, Production Cell and external-effect
boundaries. The live run remains stopped as the stabilization action; the
implementation and incident-shaped E2E are the probe.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Preserve production and terminal purity | 25 | Earlier workshops and the failed parent must remain immutable. |
| Prevent recurrence | 20 | A continuation must not traverse the same broken DAG/base path. |
| Time to a safe restart | 20 | The factory is stopped, but an unsafe restart is worse than delay. |
| Authority and effect correctness | 15 | Model claims and crash windows cannot manufacture Git truth. |
| Testability and observability | 10 | Scripted workers must exercise the real state and effect boundaries. |
| Reversibility | 10 | New authority must be additive and disableable before consumption. |

Scores use 1 (poor) through 5 (strong).

## Considered options

### Option A — Authority-complete incident vertical

Implement the accepted-prefix continuation, exact task-15 adoption, managed
TextSet production, immutable Workplace DAG/effective-base receipts and durable
effect-before-final-acceptance. Prove the generic substrate with a synthetic
non-Development fixture and prove the whole vertical with the live-shaped
Product Delivery continuation. This has the largest implementation cost, but
closes every demonstrated authority gap before launch.

### Option B — Universal platform substrate first

Build generic OrderRunChain, inherited-stage frame, immutable Workplace DAG,
`effect_pending`, EffectReceipt and CellFinalAcceptance machinery before any
Development-specific vertical. This is the purest platform shape and highly
testable, but it can leave a complete generic substrate without a runnable
recovery path or the TextSet cutover that removes shared-Git authority.

### Option C — Bounded Development child with synchronous integration

Create a Development/Delivery child from the Formalization prefix and current
Git baseline, rerun Development on the corrected generic DAG/base path, and run
Factory integration synchronously before terminal acceptance. Defer managed
TextSet and OS isolation. This appeared fastest and retained good
reversibility, but lacked a lawful crash boundary and retained model access to
shared Git refs.

## MCDA matrix

| Option | Preservation (25) | Recurrence (20) | Restart time (20) | Authority (15) | Testability (10) | Reversibility (10) | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Complete vertical | 5 | 5 | 1 | 5 | 4 | 4 | 400 |
| B. Universal substrate | 5 | 5 | 1 | 5 | 5 | 3 | 400 |
| C. Bounded child | 4 | 5 | 4 | 3 | 5 | 5 | **425** |

**Sanity check:** C leads numerically because restart time has a high weight.
That result is not dispositive: an unclosed effect or Git-authority boundary is
a release veto and cannot be averaged away by speed.

## Pre-mortem

Assumption: Option C was implemented and failed six months later.

1. **Git moved but the Workplace never terminalized** — likelihood M;
   detectable by DB/Git reconciliation; mitigation requires a pre-existing
   action identity, fenced attempt, observation and immutable receipt.
2. **A worker mutated shared refs directly** — likelihood M; detectable only
   after damage through ref audit; mitigation requires removing shared Git
   authority through TextSet or a proven OS boundary.
3. **Task-15 behavior was duplicated or laundered as baseline** — likelihood H;
   detectable by coverage/adoption checks; mitigation requires an exact new
   adoption decision.
4. **The child repeated the transient DAG erosion** — likelihood M; detectable
   by multi-turn SQLite tests; mitigation requires immutable Workplace topology,
   not a task-status projection repair.
5. **Parent failure disappeared behind a successful child** — likelihood M;
   detectable by lineage projection tests; mitigation requires an append-only
   OrderRunChain with one visible active leaf.

**Net effect:** C is replaced. Its required mitigations absorb the core of A,
so retaining C's favorable restart-time score would be false accounting.

## Red Team

**Strongest argument against the leading option:** synchronously moving the
current `void` Git callback before terminalization creates an external mutation
without a durable desired-effect identity. A crash between Git and Workplace
CAS cannot prove that an observed commit is the accepted effect. C also leaves
LM workers with `Bash`, merge tools and a linked worktree sharing canonical
refs, so Factory-owned integration is only a normal-path convention.

**Source in repo:**
`production-cell-node-executor.ts`, `post-acceptance-effects.ts`,
`sqlite-production-cell-integration.ts`, `development-process-module.ts`,
`repository-desk-provisioner.ts`, GUARDRAILS Signs 012 and 014.

**Response:** accepted. Switch from C to A. Effect correctness and exclusive
canonical Git authority are hard release gates. Option A includes B's necessary
universal substrate and must prove it outside Development, while also delivering
the incident vertical.

## Decision

Chose: **Option A — authority-complete incident vertical**.

The parent remains terminal and byte-identical. One append-only child consumes
an exact accepted Formalization prefix and an exact task-15 adoption decision.
New code production uses managed TextSet material; only a durable Factory effect
may create/integrate Git state. The universal Production Cell seals its complete
dependency graph before admitting roots, derives effective inputs from settled
predecessors, and constructs final acceptance only after required EffectReceipts.
No continuation launch is permitted until the complete vertical and
incident-shaped E2E pass.

## Consequences

**Positive:**

- completed workshops are preserved without forged StageRuns;
- task 15 is adopted through current authority rather than duplicated;
- DAG, base propagation, Git ownership and crash recovery are fixed together;
- the same graph/effect primitives serve non-Development workshops;
- the operator gets one auditable parent→child production lineage.

**Negative:**

- the factory remains stopped longer;
- the migration spans lifecycle, Workplace, effect and Development contracts;
- text-only v1 must fail closed for unsupported repository material;
- old commit-based Development packages remain historical and require readers.

**Neutral / follow-ups:**

- keep all new tables additive and immutable after insertion;
- add architecture ratchets forbidding module-name branches in generic code;
- exercise crash points before and after Git mutation;
- commit this record with the implementation, not as an implementation claim by
  itself.

## Decision Journal

**Date:** 2026-08-09

**Decision (one line):** recover through one authority-complete
accepted-prefix/TextSet vertical, never through a partial child launch.

**Ex-ante expectations — IF this decision was right, I expect:**

- In 30 days: the live child has zero Discovery/Formalization worker executions,
  every dependency edge remains stable across reconciliation, and canonical Git
  moves only beside an immutable EffectReceipt.
- In 90 days: another terminal downstream incident can create an auditable
  accepted-prefix continuation without module-name branching or terminal-row
  reopening.
- In 6 months: no Development execution profile has regained model-owned merge
  authority, and TextSet/effect fixtures remain provider-independent.

**Check trigger:** first continuation authorization, first Git-effect crash
reconciliation, and any proposal to restore shared-worktree `Bash` authority.

**What would change my mind:** repeatable E2E evidence that a genuinely
OS-isolated staging-Git model is materially more reliable and less costly than
managed TextSet while preserving the same exclusive effect authority.

## References

- [ADR-032: Development integrated candidate](032-development-integrated-candidate.md)
- [ADR-038: Continue from an accepted stage prefix](038-continue-from-accepted-stage-prefix.md)
- [ADR-039: Model produces text; Factory owns canonical Git](039-model-produces-text-factory-owns-git.md)
- [Conveyor Mental Model](../CONVEYOR-MENTAL-MODEL.md)
- `GUARDRAILS.md`, Signs 012 and 014
