# ADR-006: REQ-013 — Pattern B default for greenfield multi-task episodes

## Status
Accepted (2026-07-17)

## Context

**User pain (verbatim):** «Параллельные агенты ломают друг друга».

**Root cause (from `cgad-audit.md` §6):** `decideTopology(brief)` in `saga-mcp/src/planner/topology.ts:77` supports Pattern B (scaffold-then-parallel) — the only known cure for add/add merge conflicts on greenfield episodes per GUARDRAILS Sign 002 — but only when the brief explicitly sets `topology_hint='scaffold-then-parallel'`. If a brief omits the hint, workers fan out with no scaffold and git becomes the only conflict detector, which is exactly CGAD forbidden construct §34.

Sign 002's data is unambiguous: REQ-001 had 3/4 tasks in conflict (no scaffold), REQ-003 had 3/11; REQ-002 had 0/3 and REQ-004 had 0/9 once Pattern B was used.

ADR-005 Roadmap lists REQ-010 (semantic conflict model, ~28h) as the full fix, blocked by REQ-008 → REQ-009. REQ-013 is an interim, smaller fix that closes ~70% of the pain without waiting for the full conflict model.

## Decision Drivers

- AGENTS.md: "Cross-subsystem communication via well-defined public APIs only" — `decideTopology` is a public API covered by 4 tests; minimise signature change.
- ADR-005: "additive-only, backward-compatible. Legacy callers work."
- GUARDRAILS Sign 002: scaffold-then-parallel is the only empirically-validated cure for add/add.
- `topology.ts:68-71` invariant: "a topology decision must come from the brief, never from a fallback" — exists because silent mis-planning is the failure mode we are avoiding. **REQ-013 must not weaken this invariant in topology.ts itself.**

## Considered Options

### Option (a): `decideTopology` infers Pattern B itself
Modify the function so that a missing `topology_hint` together with N≥2 tasks produces Pattern B.
- **Pros:** single change site.
- **Cons:** breaks the documented no-fallback invariant; `decideTopology` does not receive episode task count, so the signature must change; breaks 4 existing tests.
- **Score:** 66/126 (rejected).

### Option (b): new `'auto'` literal in `topology_hint` enum
Add `topology_hint='auto'` to BriefPayload + validator + decideTopology switch; resolver picks Pattern B.
- **Pros:** explicit in the brief schema.
- **Cons:** briefs are authored by humans or discovery skill who do not know to set `'auto'` — that is the exact failure mode being fixed. Blast radius: BriefPayload, validator, switch, all callers.
- **Score:** 95/126 (rejected — does not solve the actual failure mode).

### Option (c): planner/cascade infers the hint when context allows ✅ ACCEPTED
Keep `decideTopology` pure. Move the default into the planner layer (`planner/cascade.ts` or wherever episode context is visible). Rule:
```
if brief.topology_hint is unset AND episode is greenfield
   AND count(body tasks) ≥ 2 AND brief.scaffold_artifacts is non-empty:
     set brief.topology_hint = 'scaffold-then-parallel'
```
- **Pros:** preserves topology.ts invariant (no fallback inside the pure switch); planner has episode context; backward-compatible (only acts when hint is unset); fully reversible (delete the inference block).
- **Cons:** logic lives at the planner, not in one obvious place — must be documented.
- **Score:** 126/126.

### Option (d): lint rule R4 only (detection, no prevention)
Add cgad-spec-lint R4: episodes entering `development` with >1 git_change task and no scaffold_task dependency must be flagged.
- **Pros:** zero code change in saga-mcp; pure observability.
- **Cons:** detection without prevention does not close the pain; human must act on every lint finding.
- **Score:** 117/126.

## Decision

**Option (c) + (d) combined, with a scope correction after Three-Truths reconciliation.**

### Three-Truths finding (recorded before implementation)

The initial ADR draft assumed `decideTopology` was called from a planner code layer. Reading the code revealed:
- **Declared (this ADR v1):** "planner/cascade.ts infers the hint"
- **Implemented (saga-mcp code):** `decideTopology` has **no runtime call site** in saga-mcp — it is a pure function invoked only from tests and from the saga-planner SKILL prompt (which lives outside saga-mcp). `BriefPayload.topology_hint` is a **required** field (`brief.ts:47`), so "missing hint" is not actually a failure mode — the validator rejects it.
- **Observed (cgad-spec-lint):** the real failure mode is **planner picks the wrong hint** (e.g. `parallel-independent` for greenfield multi-task), not "hint missing". Sign 002's data confirms this — briefs had topology_hint set, just to the wrong value.

**Corrected scope:** REQ-013 delivers a deterministic guard, not an inference block. Two parts:

1. **`cgad-spec-lint` rule CGAD-R4** (detection): flag episodes entering `development` with >1 `git_change` task that has no `SCAFFOLD:`-titled task in its `depends_on` transitive closure, when the episode is greenfield (no prior merged tasks in the repo) and at least one task pair shares a `source_ref` prefix (module overlap proxy).
2. **Optional `topology_check` MCP tool** (prevention, future): given a brief + planned task list, return whether Pattern B is required. Out of scope for REQ-013 v1 — R4 detection is the minimum viable fix, because it forces the planner to re-plan when caught.

The combination closes the two failure modes identified in the pre-mortem:
- *Scaffold forced where unneeded* — mitigated by the greenfield + module-overlap preconditions in R4.
- *Planner picks wrong hint* — R4 catches it at the integration gate; planner must either re-plan with Pattern B or justify (via `tags: ['cgad-r4-waived', reason: '...']`).

## MCDA matrix (Weighted Sum, weights in parentheses)

| Criterion | (a) | (b) | (c) | (d) |
|---|---|---|---|---|
| Closes pain (5) | 4 | 4 | **5** | 2 |
| Preserves topology.ts invariant (4) | 1 | 3 | **5** | **5** |
| Backward compat (5) | 2 | 4 | **5** | **5** |
| Reversibility (4) | 2 | 4 | **5** | **5** |
| Cost low (3) | 2 | 2 | 4 | **5** |
| Detectability (3) | 3 | 3 | 4 | **5** |
| Testability (3) | 3 | 4 | 4 | 4 |
| **Total** | 66 | 95 | **126** | 117 |

## Pre-mortem on (c)

Assume (c) shipped and failed six months later. Failure modes:
1. **Scaffold forced on episodes that do not need it** (single-task, established codebase). Mitigation in the design: the inference fires only when episode is greenfield AND ≥2 body tasks AND `scaffold_artifacts` is non-empty. A single-task episode is unaffected.
2. **A caller bypasses the planner.** Mitigation in the design: lint rule R4 (CGAD-R4) catches it at `development` entry — any episode that reaches development with >1 git_change task and no scaffold dependency is flagged error.
3. **The scaffold task is created but depends_on wiring is lost.** Mitigation: keep `saga-planner` skill responsible for emitting the scaffold task with body-task depends_on (already does this for explicit Pattern B); add a planner test that asserts the wiring when inference fires.

## Red Team rebuttal

*Red Team argument:* "(b) is better because the default lives in the brief schema, which is the canonical source of intent."

*Rebuttal:* The failure mode being fixed is that the brief **fails to declare intent**. Putting a new `'auto'` literal in the schema does not change this — briefs that omit `topology_hint` today will omit `'auto'` tomorrow. The default must live at the layer that can read episode context (the planner), because the planner can see the task count and greenfield flag that the brief cannot.

## Consequences

- **Code:** `saga-mcp/src/planner/cascade.ts` (or equivalent call site of `decideTopology`) gains a ~10-line inference block guarded by the three preconditions. `topology.ts` is untouched.
- **Tests:** new planner test for the inference rule; topology.ts tests unchanged.
- **Lint:** new `cgad-spec-lint` rule **CGAD-R4** — episode_workflows entering `development` with >1 git_change task lacking a `SCAFFOLD:` task dependency is an error.
- **Skills:** `saga-planner` SKILL.md updated to document that the inference fires when the three preconditions hold; brief authors are still encouraged to set `topology_hint` explicitly.
- **Reversibility:** fully reversible — remove the inference block + R4 rule. Cost ≈ 0.
- **Future:** REQ-010 (semantic conflict model) supersedes the heuristic with typed conflict keys; REQ-013's lint rule R4 stays (it catches bypass even after REQ-010).

## Decision Journal (ex ante expectations)

- **Date:** 2026-07-17
- **Decision:** Pattern B inference at the planner layer + R4 lint detection.
- **Ex ante (30 days):** Zero greenfield multi-task episodes enter `development` without a scaffold task dependency. cgad-spec-lint R4 finding count = 0 on saga.db going forward.
- **Ex ante (90 days):** Sign 002's add/add conflict class disappears from new episodes. REQ-010 either supersedes the heuristic (replaces the inference with conflict-key computation) or the heuristic stays as a fast-path fallback.
- **Check trigger:** next greenfield multi-task episode after merge; monthly lint baseline review.

## Related

- Spec: [cgad-v2-spec.md](../cgad-v2-spec.md) §22 forbidden construct §34 ("Git conflict as only conflict detector")
- Audit: [cgad-audit.md](../cgad-audit.md) §6 pain analysis
- GUARDRAILS Sign 002 (scaffold-conflict) and Sign 008 (CGAD legitimacy-wash)
- Implements: REQ-013 (not in ADR-005 Roadmap; this ADR adds it)
- Will be superseded partially by: REQ-010 (semantic conflict model)
