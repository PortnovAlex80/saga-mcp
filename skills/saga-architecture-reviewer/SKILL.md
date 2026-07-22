---
name: saga-architecture-reviewer
description: "Reviewer for SRS artifacts (runs AFTER AC baseline acceptance). Verifies Complexity Gate compliance, §D Decomposition completeness, Invariant Registry, and derived_from → PRD edge before approving. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage (этап):** Formalization Part 2 review buffer
- **Precondition:** the `formalization.srs` task is `in_progress` or `review`
  (architect drafted the SRS after `baseline_accepted`). Verify before claiming:
  the held task's `task_kind='formalization.srs'`, and the episode's accepted
  AC baseline exists.
- **Postcondition:** SRS either accepted (status='accepted', traces complete,
  §D present and Complexity-Gate-compliant) or returned to architect via
  `verdict:'changes_requested'`.

The SRS no longer contains FR/NFR/RULE (those moved to the PRD, owned by
saga-product). You do NOT check FR/NFR traceability — that is now
saga-requirements-reviewer's job on the PRD. You check the architectural
contract: Complexity Gate compliance, Module Manifest, Invariant Registry,
Port Registry (if applicable), and the new §D Decomposition.

## What this skill reviews

The SRS is the architectural contract — it must be traceable to the PRD, must
follow the Complexity Gate inputs from the brief, and must declare a complete
§D Decomposition the planner can copy verbatim.

| Check | How |
|---|---|
| SRS has `derived_from` → PRD edge | `trace_list({source_id:<SRS id>, link_type:'derived_from'})` |
| SRS declares architectural style per Complexity Gate table | Read brief metadata + SRS §2.1; cross-check against Step 3 table |
| SRS §D2 exists with one row per accepted AC | Read SRS §D, compare AC codes to `artifact_list({type:'AC', status:'accepted'})` |
| Every §D2 row has valid `ac_kind` | Each row's `ac_kind` ∈ {`implementation`,`verification`,`spike`,`merge_with`} |
| Every §D2 row has valid `criticality` (v2.2) | Each row's `criticality` ∈ {`blocker`,`degradable`,`nice-to-have`} |
| SRS §D1 File Tree non-empty and consistent with §2.2 Module Manifest | Read §D1, compare file paths to §2.2 module surfaces |
| SRS §D4 contains pattern selection per module cluster | Read §D4, verify each cluster has Pattern A or B + reason |
| SRS §2.3 Invariant Registry present (if algorithmic logic) | Read the .md file, grep for "Invariant Registry" or equivalent |
| Each invariant has a checkable predicate + check type | Cross-check invariant names against §D2 `invariants:` fields |
| SRS §9 stack entries are runnable commands (v2.2 E4) | Each `test_framework` / `linter` / `formatter` / `type_checker` / `build_tool` is a shell-invocable CLI, not a bare tool name |
| SRS §10 Supporting Systems present for L/XL | For L/XL: all 8 ГОСТ видов present (described or `n/a`+reason). For S/M: optional |
| SRS §11 External Landscape present or `n/a` | Section present; if episode has external I/O, every endpoint has a row |
| SRS §12 Decision Log present (ALL sizes, min 3) | ≥3 entries, all 5 columns (#, Decision, Alternatives, Rationale, Date) non-empty |
| SRS declares security controls per OWASP:2025 / ASVS / agentic-AI axes | Run the "Security review" phase (step 12); per-axis verdicts `pass`/`fail`/`N/A` from `security-axes.md` |

## Review procedure

1. **Read the task** via `task_get({id})`. Confirm `task_kind='formalization.srs'`.

2. **List the SRS artifact:**
   ```
   artifact_list({ epic_id, type: 'SRS' })
   ```
   Do NOT list FR/NFR — those are in the PRD now and reviewed by
   saga-requirements-reviewer, not you.

3. **Verify the SRS → PRD traceability edge:**
   ```
   trace_list({ source_id: <SRS id>, link_type: 'derived_from' })
   ```
   Must include ≥1 trace to a `PRD` artifact. If missing → `changes_requested`
   with reason: "SRS missing derived_from → PRD. Call trace_add(SRS → PRD)."

4. **Verify Complexity Gate compliance (NEW — KEY CHECK):**
   ```
   brief = artifact_list({ epic_id, type: 'brief' })
   artifact_get({ id: <brief id> })   // read metadata.brief_payload
   ```
   Extract `complexity.tshirt`, `topology_hint`, `shared_mutation_risk`. Read
   SRS §2.1 declared style. Cross-check against the saga-architect Step 3
   table:

   | complexity.tshirt | topology_hint | shared_mutation_risk | Allowed Architectural Style |
   |---|---|---|---|
   | XS | sequence | false | KISS (single file) |
   | S | sequence | false | KISS / Module |
   | M | sequence | false | Modular Monolith |
   | M | scaffold-then-parallel | true | Modular Monolith + Ports |
   | L | scaffold-then-parallel | true | Hexagonal / Ports |
   | XL | scaffold-then-parallel | true | Hexagonal / Clean Architecture |
   | L/XL | sequence | false | Layered / Pipeline |
   | research | (any) | (any) | Spike-first |

   **REJECT** if:
   - complexity S/M AND topology_hint=sequence AND architect chose Hexagonal
     → reason "architecture violates Complexity Gate contract — Hexagonal is
     forbidden for S/M-size sequential work (see saga-architect Step 3
     anti-overengineering rule)".
   - The §2.1 declaration does NOT cite the Complexity Gate inputs as
     justification → reason "§2.1 must cite the brief's complexity.tshirt,
     topology_hint, shared_mutation_risk values that justified the choice".
   - Inputs don't match a row exactly AND the architect chose the MORE
     COMPLEX row instead of the more conservative one → reason "ambiguous
     Complexity Gate inputs — architect must choose the more conservative row".

5. **Verify §D Decomposition (NEW — KEY CHECK):**
   Read the SRS document at `artifact.path`. The §D section MUST contain four
   subsections: §D1, §D2, §D3, §D4.

   **§D2 AC → Implementation Map** — verify:
   - List accepted ACs: `artifact_list({ epic_id, type: 'AC', status: 'accepted' })`
   - For each accepted AC code, there is exactly one YAML row in §D2. Missing
     rows → `changes_requested` listing missing AC codes. Extra rows →
     `changes_requested` (architect created rows for non-accepted ACs).
   - Each row has `ac_kind` field, value ∈ {`implementation`, `verification`,
     `spike`, `merge_with`}. Invalid/missing → `changes_requested`.
   - Each `implementation` row has non-empty `files:` and `functions:` (or
     `types:`). Empty → `changes_requested`.
   - Each `verification` row has `test_layers:` including L4 or L2 (it's a
     check, not code) and a `depends_on:` referencing an `implementation` AC.
   - Each `merge_with` row has a `merge_with:` field naming another AC.
   - Each Pattern B row references a `scaffold:<module>` in `depends_on:` — and
     that scaffold row exists as its own §D2 row.

   **§D1 File Tree** — verify:
   - Non-empty. Lists every file referenced in §D2 `files:` fields.
   - File paths are consistent with §2.2 Module Manifest (file under the
     declared module's directory). Mismatch → `changes_requested`.
   - Every file has an owning AC comment (`# AC-N: ...`) or is marked
     scaffold-owned/shared.

   **§D3 Priority Rationale** — verify present (priority drives task creation
   order). If missing → `changes_requested`.

   **§D4 Pattern Selection per Module Cluster** — verify:
   - For each module cluster with >1 AC, a Pattern A or B choice is declared
     with a reason.
   - Pattern B clusters reference a scaffold task (must exist in §D2).
   - If missing or incomplete → `changes_requested`.

6. **Verify §2.3 Invariant Registry (if algorithmic logic):**
   - §2.3 present when the episode has any algorithmic FR (calculations,
     formulas, state transitions) — check the PRD's FR section.
   - Each invariant has a name, predicate/formula, and check type (L3/L4/L0).
   - Cross-check: every `invariants:` entry in §D2 rows exists in §2.3.
     Missing invariants → `changes_requested`.

7. **Verify every §D2 row carries `criticality` (v2.2 T-010 принцип 6):**
   - For each row in §D2 AC → Implementation Map, the `criticality` field
     MUST be present and ∈ {`blocker`, `degradable`, `nice-to-have`}.
   - Missing or invalid value → `changes_requested` listing the AC code and
     the bad/missing value. This field drives the integration readiness
     gate (blocker ACs must pass; degradable may be unknown; nice-to-have
     may be skipped). Default when architect is unsure is `blocker`.

8. **Verify SRS §9 stack entries are runnable commands (v2.2 Поток E4):**
   - For each of `test_framework`, `property_test_framework`, `linter`,
     `formatter`, `type_checker`, `build_tool`: the value MUST be a
     shell-invocable CLI, not a bare tool name.
   - Examples of WRONG: `jest`, `tsc`, `npm`, `eslint`, `prettier`,
     `pytest` (when the project has no pytest script), `hypothesis`.
   - Examples of RIGHT: `npm test`, `tsc --noEmit`, `npm run build`,
     `npx eslint .`, `npx prettier --check .`, `pytest` (when there IS
     a pytest entry point).
   - Heuristic: if the value has no space AND no flag, it's almost
     certainly a bare tool name — `changes_requested`.

9. **Verify SRS §10 Supporting Systems (v2.2 ГОСТ 34.602-89; L/XL only):**
   - Read the brief's `complexity.tshirt`.
   - **For L/XL:** §10 MUST be present with all 8 subsections (§10.1
     Informational, §10.2 Software, §10.3 Hardware, §10.4 Linguistic,
     §10.5 Organizational, §10.6 Methodical, §10.7 Legal, §10.8 Ergonomic).
     Each subsection MUST be either:
     - described (status `planned` or `in_place`) with a concrete artifact
       reference (workflow path, runbook path, license name, WCAG version),
       OR
     - marked `n/a` with a one-line justification.
     Missing subsections, empty descriptions, or `n/a` without a reason →
     `changes_requested` listing which of the 8 видов is incomplete.
   - **For S/M/XS:** §10 is OPTIONAL — its absence is not a failure. But if
     the architect DID include it, each filled subsection must still follow
     the same rules.

10. **Verify SRS §11 External Integration Landscape (v2.2 ГОСТ G2):**
    - §11 MUST be present (even if it's a single `(none)` row).
    - If the episode consumes or exposes any external contract (HTTP API,
      GraphQL, gRPC, webhook, message bus, third-party SDK), each
      endpoint/integration MUST have a row with all 5 columns (Endpoint,
      Protocol, Auth, SLA, Contract) non-empty.
    - Cross-check: every AC in §D2 that touches an external contract MUST
      list the endpoint in its `external_protocols:` field (or document
      why not). Missing endpoints in either place → `changes_requested`.
    - For episodes with no external I/O: §11 marked `n/a` with reason is
      acceptable; complete absence is `changes_requested`.

11. **Verify SRS §12 Decision Log (v2.2 ГОСТ G3; ALL sizes, min 3):**
    - §12 MUST be present for EVERY episode (XS through XL).
    - MUST have ≥3 entries.
    - Each entry MUST have all 5 columns non-empty: `#`, `Decision`,
      `Alternatives considered`, `Rationale`, `Date`.
    - Cross-check: every non-trivial §9 stack choice (language, framework,
      build tool, deployment target, major dependency) SHOULD have a
      corresponding §12 entry. Stack choices without a Decision Log entry
      → `changes_requested` with reason "§9 choice <X> has no Decision
      Log entry — add §12 row with alternatives + rationale".
    - Date format MUST be ISO (`YYYY-MM-DD`).

12. **Security review phase (OWASP:2025 + ASVS 5.0 + agentic-AI):**
    Apply every axis in `security-axes.md` (sibling file in this skill dir) to
    the SRS under review. The phase produces a per-axis verdict table. Each
    axis line is `pass` / `fail` / `N/A` (N/A requires a one-line justification
    in the verdict body).

    Procedure:
    - **OWASP Top 10:2025** — for each A01–A10, determine whether the episode's
      surface activates the category (read §2.2 Module Manifest, §11 External
      Landscape, the brief's `complexity.tshirt`, and the PRD's FR section for
      security-sensitive surfaces). For every activated category, ask the
      reviewer question in the table; emit `pass` (SRS declares a control),
      `fail` (SRS silent / contradictory / under-specified), or `N/A` (episode
      has no surface for it, with justification).
    - **ASVS 5.0** — first pick the target level (L1/L2/L3) using the
      episode-signal table in `security-axes.md` §2.1 (brief + PRD). Then run
      the per-chapter coverage check in §2.2 for every chapter the episode's
      surface activates at the chosen level. Emit a verdict per activated
      chapter.
    - **Agentic-AI threats** — apply ONLY if the episode produces or governs an
      LLM/agent component (declared in §2.1/§2.2: agent loop, tool-calling,
      RAG, or model invocation). Otherwise the whole axis is `N/A` with
      justification "episode has no agentic surface".

    <!-- source: EXT-5 https://github.com/agamm/claude-code-owasp -->
    Tie security findings to the Invariant Registry — a security failure is an
    invariant violation, NOT a freeform note:
    - Any `fail` that concerns a **checkable architectural predicate** (e.g.
      "tool output is treated as untrusted data", "agent action set is an
      allowlist", "authz is enforced at module boundary X") MUST be recorded as
      a missing invariant in SRS §2.3. The architect must add the §2.3
      invariant (name + predicate + check type) before the SRS can be
      re-submitted. Listing it only as prose in the verdict does NOT satisfy
      this — the Invariant Registry is the canonical home for checkable
      properties the verifier will later assert.
    - Blocker categories (OWASP A01/A04/A05/A06/A10 on security-sensitive
      episodes; ASVS V1/V4/V5/V8/V11/V14 at L1; agentic prompt-injection /
      excessive-agency / sensitive-info-disclosure when an agentic surface is
      present) → the phase returns `changes_requested`; each blocker is both an
      Invariant Registry violation AND an entry in the `result` gap list.
    - The agentic **excessive agency** check is also a CGAD no-self-authorization
      guard (R5): if the SRS lets an agent authorize its own completion, retry,
      or degradation, emit a hard `fail` regardless of other passes — the
      architect must rework the agency boundary so authorization stays with the
      controller/verifier. The reviewer NEVER self-authorizes either; this
      phase only informs the `worker_done` verdict.

    Emit the verdict table in the `result` body (one line per axis). All
    `pass`/`N/A` (with justifications) → this phase passes. Any `fail` → this
    phase returns `changes_requested` and the SRS is NOT accepted, even if every
    other check in steps 3–11 passed.

13. **Accept the SRS if all checks pass (including the Security review phase):**
    ```
    artifact_update({ id:<SRS id>, status: 'accepted' })
    ```

14. **Complete the task** via `worker_done`:
    - `verdict:'approved'` — SRS traceable, Complexity-Gate-compliant, §D
      complete with `criticality` per row, §9 runnable, §10/§11/§12
      complete per size rules, AND the Security review phase passed (every
      axis `pass` or `N/A` with justification). The `result` body MUST include
      the per-axis security verdict table from step 12.
    - `verdict:'changes_requested'` — list each gap with file:line and which
      check failed. For security failures, name the axis (OWASP A0X / ASVS VX /
      agentic threat) and, for every checkable-predicate failure, state which
      §2.3 invariant the architect must add.

## Anti-patterns

- ❌ **Do not invent edges.** If `derived_from` is missing, return
  `changes_requested`.
- ❌ **Do not approve "because parent_artifact_id is set."** Same trap as
  requirements-reviewer — column ≠ trace edge.
- ❌ **Do not skip the Complexity Gate check.** This is the primary defense
  against over-engineering (Cannon REQ-001 postmortem). If you approve
  Hexagonal for an M-size sequential episode, the planner will create 15+
  tasks where 5 suffice.
- ❌ **Do not skip the §D check.** Without §D2, the planner cannot generate
  tasks (it is a dumb copier). Without §D1, the scaffold cannot create the
  file tree.
- ❌ **Do not skip the §D2 `criticality` check** (v2.2). Every row must have
  a valid `criticality` value — it is the input the integration readiness
  gate reads to decide whether the episode can complete with degradable
  `unknown` ACs.
- ❌ **Do not accept bare tool names in §9** (v2.2 E4). `jest` is not a
  command the build-gate can run; `npm test` is. Approving a bare name
  guarantees the build-gate fails on every downstream task.
- ❌ **Do not skip §10 for L/XL episodes** (v2.2 ГОСТ G1). The 8 видов
  обеспечения surface infrastructure (CI/CD, observability, runbooks,
  licensing, accessibility) that classical SRSs forget; skipping them
  ships episodes with infra gaps the verifier cannot close.
- ❌ **Do not skip §12 Decision Log for ANY episode size.** ≥3 entries are
  the audit trail that makes future architecture review possible.
- ❌ **Do not check FR/NFR/RULE.** Those moved to the PRD. Their traceability
  is verified by saga-requirements-reviewer against the PRD. Checking them
  here would either miss them (correctly — they're not in the SRS) or invent
  false failures.
- ❌ **Do not treat a security failure as a freeform note.** A failed OWASP /
  ASVS / agentic-AI check that concerns a checkable architectural predicate
  becomes a §2.3 Invariant Registry violation — the SRS is returned
  `changes_requested` until the architect adds the named invariant. Recording
  the gap only as prose in the verdict lets the verifier miss it.
- ❌ **Do not let the agentic-AI axis smuggle in self-authorization.** The
  excessive-agency check must fail if the SRS lets an agent authorize its own
  completion/retry/degradation — but the REVIEWER likewise never
  self-authorizes. This phase only informs the `worker_done` verdict; it does
  not grant an alternate approval path.
- ❌ **Do not skip the Security review phase because the episode "looks simple".**
  Even a pure-computation episode must emit the verdict table (most axes will
  be `N/A` with justification — that is the evidence the phase ran). Skipping
  the phase silently is the same as approving without checking.
- ❌ **Do not call `worker_next`.**

## Rules

- One task = one launch.
- Verdict must cite `trace_list` / `artifact_list` / `artifact_get` evidence
  in `result`, plus the specific Complexity Gate inputs and the §D subsections
  checked.
- If the SRS document is missing on disk → `changes_requested`.
- If the architect did not declare any invariants but the episode has
  algorithmic logic (formulas, calculations — check the PRD FR section) →
  `changes_requested` with reason "§2.3 Invariant Registry missing —
  saga-architect must declare invariants for algorithmic FRs".
- If §D2 is missing OR has fewer rows than accepted ACs → `changes_requested`.
- If any §D2 row lacks `criticality` or has an invalid value (v2.2 T-010
  принцип 6) → `changes_requested`.
- If §D1 is empty OR contradicts §2.2 Module Manifest → `changes_requested`.
- If §9 has any bare tool name (no flag, no space, no script alias) (v2.2
  E4) → `changes_requested`.
- If §10 is missing or incomplete for L/XL episodes (v2.2 ГОСТ G1) →
  `changes_requested`.
- If §11 is missing or incomplete for episodes with external contracts
  (v2.2 ГОСТ G2) → `changes_requested`.
- If §12 has fewer than 3 entries OR any entry has an empty column (v2.2
  ГОСТ G3) → `changes_requested`.
- If the architect chose Hexagonal for S/M-size sequential work →
  `changes_requested` (anti-overengineering rule violation).
- If the Security review phase (step 12) emits any `fail` on a blocker axis
  (OWASP A01/A04/A05/A06/A10 on security-sensitive episodes; ASVS
  V1/V4/V5/V8/V11/V14 at L1; agentic prompt-injection / excessive-agency /
  sensitive-info-disclosure) → `changes_requested`. The gap list MUST name the
  axis and the §2.3 invariant the architect must add.
- If a non-blocker security axis fails but concerns a checkable architectural
  predicate → still `changes_requested` with the missing invariant named (it
  is an Invariant Registry violation, not a note).
- The agentic excessive-agency check is a hard `fail` if the SRS lets an agent
  authorize its own completion/retry/degradation, regardless of other passes
  (CGAD R5 no-self-authorization).
