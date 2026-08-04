# Skills Augmentation — Subagent Work Order

Date: 2026-07-22
Status: READY FOR DISPATCH
Branch target: create `skills-augmentation` off `saga-3-0` (do NOT work on master/saga-3-0 directly)

## Mission

Improve 13 of our skills (`skills/*/SKILL.md`) by selectively absorbing proven patterns
from existing external "Claude Code skills". Every change is to a `SKILL.md` (or a sibling
file shipped under the same skill dir). **Do NOT touch `src/` — this is a skill-content task,
not a saga-mcp code change.**

## Source inventory (already vetted)

External skills worth borrowing from. Each is a real, existing, ready-to-read skill — read
the linked SKILL.md before editing ours.

| Ref | External skill | Source URL |
|---|---|---|
| EXT-1 | obra/superpowers | https://github.com/obra/superpowers |
| EXT-2 | affaan-m/everything-claude-code | https://github.com/affaan-m/everything-claude-code |
| EXT-3 | awesome-skills/code-review-skill | https://github.com/awesome-skills/code-review-skill |
| EXT-4 | TheBoscoClub/claude-test-skill | https://github.com/TheBoscoClub/claude-test-skill |
| EXT-5 | agamm/claude-code-owasp | https://github.com/agamm/claude-code-owasp |
| EXT-6 | VoltAgent/awesome-agent-skills | https://github.com/VoltAgent/awesome-agent-skills |
| EXT-7 | levnikolaevich/claude-code-skills | https://github.com/levnikolaevich/claude-code-skills |
| EXT-8 | mcpmarket root-cause-analysis-8 | https://mcpmarket.com/tools/skills/root-cause-analysis-8 |
| EXT-9 | oh-my-skills performance-optimization | https://claudemarketplaces.com/skills/akillness/oh-my-skills/performance-optimization |
| EXT-10 | mcpmarket performance-profiler-3 | https://mcpmarket.com/tools/skills/performance-profiler-3 |
| EXT-11 | OrchestKit requirements-engineering | https://mcpmarket.com/tools/skills/requirements-engineering-3 |
| EXT-12 | rsmdt codebase-exploration | https://skillsdirectory.com/skills/rsmdt-codebase-exploration |
| EXT-13 | github/awesome-copilot conventional-commit | https://claudemarketplaces.com/skills/github/awesome-copilot/conventional-commit |
| EXT-14 | mcpmarket github-actions-manager | https://mcpmarket.com/tools/skills/github-actions-manager |
| EXT-15 | mcpmarket best-practices-audit | https://mcpmarket.com/tools/skills/best-practices-audit |
| EXT-16 | levnikolaevich safe-repo-publishing | https://github.com/levnikolaevich/claude-code-skills |

## How to read an external skill before editing ours

1. Fetch the external SKILL.md (WebFetch / web reader) — do NOT guess its contents.
2. Identify the concrete, portable sections: checklists, prompt scaffolds, decision trees,
   axes of review, file templates.
3. Map each borrowed element to an insertion point in our SKILL.md (which section).
4. Quote the source in a comment line (`<!-- source: EXT-N -->`) next to borrowed material.
5. Reconcile terminology with CGAD (we say "AC", "baseline", "episode", "scope condition";
   external skills say "task", "ticket", "stage"). Keep CGAD terms in our skill.
6. Preserve our governance invariants: LM-proposes/controller-authorizes/evidence-decides.
   External "autonomous" patterns must NOT smuggle in self-authorization.

## Hard rules for every work item below

- R1. One PR per work item. Title format: `skills(<skill>): augment with <EXT-N>`.
- R2. Each PR touches exactly ONE `skills/<skill>/` directory (plus optionally the shared
      reference doc below). No cross-skill mixing in one PR.
- R3. Every borrowed element is marked `<!-- source: EXT-N <url> -->` inline.
- R4. CGAD terminology wins. Never rename AC/episode/baseline/scope-condition.
- R5. Do not weaken the no-self-authorization invariant. If an external pattern implies the
      worker can authorize its own retry/completion/degradation, DROP that part.
- R6. Keep each SKILL.md under its current length budget. Prefer adding a sibling file
      (e.g. `axes.md`, `checklist.md`) under the skill dir over bloating SKILL.md.
- R7. Skill edits are markdown-only and CANNOT affect build/tests. Do NOT run `npm
      install`, `npm run build`, or `npm test` — it wastes time and tokens, and a
      pre-existing flaky test once tempted a prior subagent into `git stash`, which
      broke parallel-agent isolation. Instead, run ONE command to confirm you didn't
      accidentally touch code: `git status --short -- src/` must output NOTHING
      (empty = you stayed in skills/ = OK). That's the entire guard.
- R8. Reference this work order in each PR body: "Work order: docs/plans/SKILLS-AUGMENTATION-SUBAGENTS.md item #N".

## Work items (13)

Each item is independently dispatchable to a subagent. Ordered by leverage (highest first).

---

### #1 saga-architecture-reviewer ← claude-code-owasp (EXT-5) + security-audit-4

**Skill:** `skills/saga-architecture-reviewer/SKILL.md`
**Why:** Our SRS review lacks OWASP/ASVS security depth. agamm's skill ships OWASP Top
10:2025, ASVS 5.0, and Agentic-AI-specific threats across 20+ languages.
**Do:**
1. Read EXT-5 SKILL.md. Extract: (a) the OWASP:2025 category list, (b) ASVS 5.0 verification
   levels, (c) the agentic-AI threat list (prompt injection, tool abuse, excessive agency).
2. Create `skills/saga-architecture-reviewer/security-axes.md` with three sections:
   OWASP:2025 checklist, ASVS checklist (levels L1/L2/L3), agentic-AI threats.
3. Edit SKILL.md: add a "Security review" phase that references the new axes file and
   requires the reviewer to produce a per-axis verdict (pass/fail/N/A) for every SRS.
4. Tie security findings to the existing Invariant Registry: a failed OWASP check becomes
   an invariant violation, not a freeform note.
**Acceptance:**
- New `security-axes.md` exists with all three sections populated from EXT-5.
- SKILL.md has a "Security review" phase that emits per-axis verdicts.
- No `src/` changes. Build + tests green.

---

### #2 saga-code-reviewer ← code-review-skill (EXT-3) + multi-agent PR review

**Skill:** `skills/saga-code-reviewer/SKILL.md`
**Why:** External skill is framework-aware (React 19, Vue 3, Rust, TypeScript, TanStack
Query v5) with explicit security/performance/maintainability/correctness axes. Ours is
generic. We want framework awareness + explicit axes.
**Do:**
1. Read EXT-3 SKILL.md. Extract: (a) the four review axes and their sub-checks, (b) the
   framework-specific rule sets, (c) the verdict format.
2. Create `skills/saga-code-reviewer/axes.md` with the four axes and their sub-checks,
   ported to CGAD terms (review verdict → review_in_progress→done transition evidence).
3. Create `skills/saga-code-reviewer/frameworks.md` with the framework-specific rules,
   adapted: keep React/Vue/Rust/TS; note that saga product repos are TS-first.
4. Edit SKILL.md: replace the generic review section with an axis-driven review that picks
   a framework profile from `frameworks.md` and applies every axis from `axes.md`.
5. Keep our governance hook: the reviewer's verdict still routes through worker_done
   (verdict=approved|changes_requested) — do not add an external "approve" shortcut.
**Acceptance:**
- `axes.md` + `frameworks.md` exist and are referenced from SKILL.md.
- SKILL.md review is axis-driven and framework-profiled.
- No `src/` changes. Build + tests green.

---

### #3 saga-verifier ← claude-test-skill (EXT-4) + superpowers verification phase

**Skill:** `skills/saga-verifier/SKILL.md`
**Why:** Our independent verification generates L3 property tests from the frozen AC
contract. The external test-skill contributes an autonomous coverage-audit step (find
missing coverage, then generate) that runs BEFORE test authoring.
**Do:**
1. Read EXT-4 SKILL.md. Extract: the coverage-audit procedure (inputs, what it scans, how
   it reports gaps) and the test-generation scaffold.
2. Read EXT-1 (superpowers) verification phase. Extract: the independent-verification
   discipline (verifier must not read the builder's tests as the oracle; build from the AC).
3. Edit SKILL.md: insert a "Phase 0 — Coverage audit" before the existing test-authoring
   phase. Phase 0 produces a gap list (which AC sub-properties have no test). Phase 1
   (existing) then generates tests to close those gaps.
4. Reinforce the anti-self-certification rule: the verifier may NOT use builder-authored
   tests as evidence — only AC-derived property tests count (already in our skill; make it
   a prominent callout referencing the borrowed discipline).
**Acceptance:**
- SKILL.md has a Phase 0 coverage audit producing a gap list.
- Anti-self-certification rule is prominent.
- No `src/` changes. Build + tests green.

---

### #4 saga-orchestrator ← obra/superpowers (EXT-1)

**Skill:** `skills/saga-orchestrator/SKILL.md`
**Why:** superpowers is the closest methodological peer to CGAD. We do NOT replace our
orchestrator — we study superpowers for two patterns to optionally adopt: (a) the
brainstorm→plan→implement→verify phase decomposition, (b) the subagent-delegation
contract (delegate with a result-return obligation).
**Do:**
1. Read EXT-1 SKILL.md thoroughly. Note where its phase names map to our episode stages
   (discovery→formalization→planning→development→verification→integration) and where they
   diverge.
2. Create `skills/saga-orchestrator/delegation-contract.md`: a one-page spec of how the
   orchestrator delegates one task to one subagent and what the result-return obligation
   is. Anchor it to our worker_next/worker_done protocol — do not invent a parallel one.
3. Edit SKILL.md: add a short "Delegation discipline" section that references the contract
   file. Do NOT rename our stages. Do NOT remove CGAD gates.
4. In the PR body, list 3 concrete differences between superpowers and CGAD (what we keep,
   what we reject, what we might adopt later). This is research output, not code.
**Acceptance:**
- `delegation-contract.md` exists and is wired to worker_next/worker_done.
- SKILL.md references it without renaming stages or removing gates.
- PR body contains the 3-differences analysis.
- No `src/` changes. Build + tests green.

---

### #5 saga-dispatch ← superpowers subagent-delegation (EXT-1)

**Skill:** `skills/saga-dispatch/SKILL.md`
**Why:** Our dispatch loop claims workers until the queue is empty. superpowers formalizes
the delegation result-return contract — worth aligning our dispatch exit criteria with it.
**Do:**
1. Read EXT-1 delegation material. Extract: what "result returned" means, what happens on
   timeout/no-progress, how a delegation is considered complete.
2. Edit SKILL.md: add a "Completion contract" section defining, for one dispatched task:
   what constitutes a returned result (worker_done with verdict), what constitutes a
   terminal non-result (worker_ask_need / crash), and how dispatch treats each.
3. Reconcile with our reality: a worker that calls worker_ask_need TERMINATES (per Slice 3
   ADR-011). State this explicitly so dispatch doesn't wait for a result that never comes.
**Acceptance:**
- SKILL.md has a Completion contract section.
- Terminal-via-ask_need behavior is documented (no silent wait).
- No `src/` changes. Build + tests green.

---

### #6 saga-explorer ← codebase-onboarding (EXT-2) + codebase-exploration (EXT-12)

**Skill:** `skills/saga-explorer/SKILL.md`
**Why:** Our explorer gathers context. External skills produce a structured architecture
map (modules, dependencies, entry points, design decisions) — a stronger artifact.
**Do:**
1. Read EXT-2 codebase-onboarding SKILL.md AND EXT-12 (rsmdt). Extract: the architecture-map
   template (sections: overview, module map, dependency graph, entry points, conventions,
   gotchas) and the reverse-engineering procedure.
2. Create `skills/saga-explorer/architecture-map-template.md` with the section template.
3. Edit SKILL.md: make the explorer's output a filled-in architecture map (not freeform
   notes). Add a procedure section that follows EXT-12's reverse-engineering steps.
**Acceptance:**
- `architecture-map-template.md` exists.
- SKILL.md output spec is the filled-in map template.
- No `src/` changes. Build + tests green.

---

### #7 saga-patrol ← codebase-exploration (EXT-12)

**Skill:** `skills/saga-patrol/SKILL.md`
**Why:** Patrol takes an express snapshot. Borrow the reverse-engineering procedure so the
snapshot includes a quick architecture read, not just task/worker state.
**Do:**
1. Read EXT-12. Extract: the lightweight architecture-read procedure (what to look at in
   <5 min: entry points, top-level modules, obvious smells).
2. Edit SKILL.md: add an "Architecture express read" subsection to the existing snapshot
   procedure. Keep it bounded — patrol is express, not deep.
3. Do NOT change patrol's read-only invariant (it never writes).
**Acceptance:**
- SKILL.md has a bounded architecture-read subsection.
- Read-only invariant preserved.
- No `src/` changes. Build + tests green.

---

### #8 saga-diagnostician ← root-cause-analysis-8 (EXT-8) + autonomous-debugging (EXT-2)

**Skill:** `skills/saga-diagnostician/SKILL.md`
**Why:** External RCA skill builds an evidence chain from logs/CloudWatch with explicit
correlation. Our diagnostician should produce an evidence chain artifact, not freeform prose.
**Do:**
1. Read EXT-8. Extract: the evidence-chain format (observation → source → correlation →
   hypothesis → discriminating probe).
2. Read EXT-2 autonomous-debugging. Extract: the research-first loop (form hypothesis,
   gather evidence, decide — never edit on a guess).
3. Edit SKILL.md: make the diagnostician's output an evidence chain (structured), and
   adopt the research-first discipline (no fix attempts until the hypothesis is backed by
   a discriminating probe).
4. Tie to our incidents: the evidence chain is suitable input to the v3 IncidentAuthority
   (saga-3-0 Gate 6). Note this connection but do not implement it.
**Acceptance:**
- SKILL.md output spec is a structured evidence chain.
- Research-first discipline (probe-before-fix) is explicit.
- No `src/` changes. Build + tests green.

---

### #9 saga-perf-tuner ← performance-optimization (EXT-9) + performance-profiler-3 (EXT-10)

**Skill:** `skills/saga-perf-tuner/SKILL.md`
**Why:** External skills bring "scientific debugging" applied to performance + concrete
profiler usage (flame graphs, JFR, Linux perf). Our perf-tuner should be measure-first.
**Do:**
1. Read EXT-9. Extract: the measure-first loop (hypothesis → profile → interpret → change
   → re-profile), and the anti-premature-optimization checklist.
2. Read EXT-10. Extract: the profiler command catalog (flame graphs, JFR, perf events) and
   when to use each.
3. Create `skills/saga-perf-tuner/profiler-catalog.md` with the command catalog, adapted
   to our TS/Node stack (note: Node profiler commands, not just JVM).
4. Edit SKILL.md: make the perf-tuner measure-first (no changes without a profile showing
   the bottleneck) and reference the profiler catalog.
**Acceptance:**
- `profiler-catalog.md` exists with Node-relevant commands.
- SKILL.md enforces measure-first.
- No `src/` changes. Build + tests green.

---

### #10 saga-worker ← git-workflow (EXT-2) + conventional-commit (EXT-13)

**Skill:** `skills/saga-worker/SKILL.md`
**Why:** Our worker implements, reviews, and merges. External skills bring disciplined
branch/merge/conflict handling and Conventional Commits. Our merge protocol exists but is
thin on branch hygiene and commit format.
**Do:**
1. Read EXT-2 git-workflow SKILL.md. Extract: branching rules, merge-vs-rebase guidance,
   conflict-resolution procedure.
2. Read EXT-13. Extract: Conventional Commits format and scope rules.
3. Edit SKILL.md: add a "Branch & commit hygiene" section covering branch naming
   (`task/<id>` — already our convention; state it), Conventional Commit prefixes for the
   worker's commits, and the conflict-resolution procedure (already partly in our merge
   protocol — reconcile, don't duplicate).
4. Keep our merge gate: worker_merge_acquire/worker_merge_release is authoritative. The
   borrowed hygiene is advisory context around it.
**Acceptance:**
- SKILL.md has branch/commit hygiene + Conventional Commits.
- Merge gate (worker_merge_acquire/release) remains authoritative.
- No `src/` changes. Build + tests green.

---

### #11 saga-kickstart ← product-discovery + spec-driven-development pattern

**Skill:** `skills/saga-kickstart/SKILL.md`
**Why:** Our kickstart does discovery triage (3 assessors) + brief→decision. Borrow the
spec-driven-development pattern (spec→plan→tasks→execute) to sharpen the brief's downstream
contract.
**Do:**
1. Read EXT-7 product-discovery AND the heeki spec-driven-development pattern (search).
   Extract: what a "spec" minimally contains to be actionable downstream.
2. Edit SKILL.md: add a "Downstream actionability check" to the brief validation — the
   brief must be specific enough that formalization can produce PRD/UC/AC without
   re-asking. List the minimal fields (users, capabilities, mandatory outcomes, evidence
   hints).
3. Do NOT change the decision fork (go/fast-track/clarify/reject) — that's our governance.
**Acceptance:**
- SKILL.md has a downstream-actionability check with explicit minimal fields.
- Decision fork unchanged.
- No `src/` changes. Build + tests green.

---

### #12 saga-product + saga-analyst ← requirements-engineering OrchestKit (EXT-11)

**Skill:** `skills/saga-product/SKILL.md` AND `skills/saga-analyst/SKILL.md`
**Why:** External skill generates structured user stories + Gherkin BDD scenarios. Gherkin
maps cleanly to our AC (Given/When/Then → acceptance criterion). Stronger structure for
both PRD (user stories) and AC (BDD).
**Do:**
1. Read EXT-11. Extract: the user-story template and the Gherkin scenario template.
2. Edit `skills/saga-product/SKILL.md`: recommend the user-story format for capability
   descriptions in the PRD (As a <role>, I want <capability>, so that <benefit>).
3. Edit `skills/saga-analyst/SKILL.md`: recommend Gherkin (Given/When/Then) as the
   preferred AC format when the AC is behavior-driven. Keep our existing AC structure as
   the wrapper; Gherkin goes inside the "acceptance criterion" body.
4. Note: this is ONE work item touching TWO skills because they share the source and the
   pattern (user stories upstream → Gherkin downstream). Put both edits in one PR with a
   clear split in the diff. This is the ONLY exception to R2.
**Acceptance:**
- saga-product recommends user-story format for capabilities.
- saga-analyst recommends Gherkin inside AC bodies.
- One PR, two files, clearly split diff.
- No `src/` changes. Build + tests green.

---

### #13 saga-release + saga-readiness-checker ← safe-repo-publishing + best-practices-audit + github-actions-manager

**Skill:** `skills/saga-release/SKILL.md` AND `skills/saga-readiness-checker/SKILL.md`
**Why:** Release + readiness are adjacent gates. External skills bring pre-publish safety,
structural validation, and CI management. Bundle the CI/publish borrowings here.
**Do:**
1. Read EXT-16 (safe-repo-publishing), EXT-15 (best-practices-audit), EXT-14
   (github-actions-manager). Extract: pre-publish safety checklist, structural-validation
   axes, CI-management procedure (read logs, trigger reruns, manage workflows).
2. Edit `skills/saga-release/SKILL.md`: merge the pre-publish safety checklist into the
   existing release checklist (dedupe with our existing items). Add a CI step that uses
   the CI-management procedure.
3. Edit `skills/saga-readiness-checker/SKILL.md`: add the structural-validation axes
   (best-practices-audit) to the readiness check. Keep our existing axes; the external ones
   supplement, not replace.
4. Like #12, this touches TWO skills in ONE PR (shared CI/publish theme). Clear split diff.
**Acceptance:**
- saga-release has the merged pre-publish + CI checklist.
- saga-readiness-checker has the supplemental structural-validation axes.
- One PR, two files, clearly split diff.
- No `src/` changes. Build + tests green.

---

## Dispatch model

- 13 independent work items. Items #12 and #13 each touch two skills but are atomic
  (shared source/theme). Net: 13 PRs.
- Each PR is a separate subagent launch. Subagents may run in parallel — they touch
  disjoint `skills/<name>/` directories (the only overlaps, #12 and #13, are intentionally
  single-PR).
- Order does not matter for correctness; the numbering reflects leverage, not dependency.
- A subagent completes its item end-to-end: read external → edit our skill(s) → build+test
  → open PR referencing this work order item #N.

## Out of scope (do NOT do)

- No `src/` edits. This is skill content only.
- No changes to the 6 Saga-unique skills: saga-architect, senior-analyst, saga-reconciler,
  saga-tracker, saga-start, autonomous-recovery. These have no external analog; leave them.
- No new dependencies (npm packages). Skills are markdown + procedure, not code.
- No removal of CGAD governance (gates, baseline, evidence, no-self-authorization).
- No renaming of our terminology (AC, episode, baseline, scope condition).

## Reference: why each external skill was chosen

| EXT | Chosen because |
|---|---|
| EXT-1 superpowers | Closest methodological peer to CGAD; phase decomposition + delegation contract |
| EXT-2 everything-claude-code | Broadest single-repo haul: onboarding, git-workflow, debugging, research-first |
| EXT-3 code-review-skill | Framework-aware multi-axis review |
| EXT-4 claude-test-skill | Autonomous coverage audit + generation |
| EXT-5 claude-code-owasp | OWASP:2025 + ASVS 5.0 + agentic-AI threats, 20+ languages |
| EXT-7 levnikolaevich | Hand-picked standalone skills (discovery, publishing, audit, optimization) |
| EXT-8 root-cause-analysis-8 | Evidence-chain RCA with log/CloudWatch correlation |
| EXT-9 performance-optimization | "Scientific debugging" applied to perf |
| EXT-10 performance-profiler-3 | Concrete profiler commands (flame, JFR, perf events) |
| EXT-11 requirements-engineering | Structured user stories + Gherkin BDD |
| EXT-12 codebase-exploration | Architecture reverse-engineering procedure |
| EXT-13 conventional-commit | Conventional Commits format + scope |
| EXT-14 github-actions-manager | CI workflow management |
| EXT-15 best-practices-audit | Structural validation axes |
| EXT-16 safe-repo-publishing | Pre-publish safety gate |
