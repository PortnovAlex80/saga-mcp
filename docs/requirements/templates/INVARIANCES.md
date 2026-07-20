# Invariants — <module name>

<!--
  Copy this template to docs/requirements/REQ-NNN-<slug>/INVARIANCES-<module>.md.
  One file per module. Human-authored, ~10 lines. The SRS §2.3 Invariant
  Registry is the source of truth for ENGINEERED invariants (HOW the system
  mechanically enforces a rule); this file is the per-module working copy
  referenced by the scaffold (Pattern B) and by the CGAD Step 1 intercept.

  ⚠ RULE / INV split (ADR-014, pipeline reorder). Two layers, do not conflate:
    - BUSINESS rule  → PRD §RULE, owned by saga-product as a `RULE` artifact.
                       Example RULE-1: "refund.amount must not exceed
                       charge.amount." This is the business intent.
    - ENGINEERED inv → SRS §2.3, owned by saga-architect as an INV-... row in
                       this table. Example INV-PAY-1: predicate
                       `refund.amount <= charge.amount`, enforced by an L3
                       property test on the Refund aggregate. This is HOW the
                       system mechanically guarantees the RULE.

  The INV row REFERENCES the RULE it enforces (RULE-N in the last column);
  it does not restate the business intent. One RULE may map to zero, one, or
  many engineered invariants.

  For each invariant declare:
    - Module       — which module protects this invariant
    - Predicate    — formal, testable (e.g. `refund.amount <= charge.amount`)
    - Check type   — L3 property test / L4 benchmark / L0 type constraint
    - Enforced RULE — the PRD RULE code this invariant mechanically enforces
    - AC reference — the AC id(s) that verify this invariant

  If an invariant cannot be tested, it is a wish, not an invariant — remove it
  or reformulate it until it is testable.
-->

| Module | Invariant (predicate) | Check type | Enforced RULE | AC reference |
|--------|-----------------------|------------|---------------|--------------|
| _module_ | _predicate_ | L3 / L4 / L0 | RULE-_n_ | AC-_n_ |

<!-- Notes / enforcement expectations below. -->

## Enforcement

Every invariant SHOULD have a property test (L3) or benchmark (L4) covering it
(R13 flags episodes with zero `verification.ac` tasks; per-invariant
enforcement is future work).

Every invariant MUST be covered by at least one AC (the "AC reference" column
above). An invariant with no AC is a gap the analyst must close before the SRS
can be accepted.

Every accepted RULE in the PRD SHOULD have at least one engineered invariant
in this table that enforces it. A RULE with zero invariants is business debt
— the rule is declared but nothing in the architecture mechanically guarantees
it. Conversely, an invariant with no RULE (orphan engineering) should be
challenged at review: either find the RULE it enforces, or remove it.

> **Note on R13 (cgad-spec-lint v1.1).** R13 checks that the episode has at
> least one `verification.ac` task — i.e. that independent verification was
> *planned* for the SRS. It does NOT verify that each individual invariant in
> this table has its own property test. Per-invariant property-test enforcement
> requires the `test_layer` field on verification evidence (future REQ-014);
> until then, treat the table above as a human contract, not a machine gate.
>
> **Note on R15 (cgad-spec-lint).** R15 checks that every accepted `RULE`
> artifact has at least one outgoing trace to a UC or AC (the RULE has a
> consumer). It does NOT check the RULE → INV edge — that is the human contract
> above. To make a RULE reviewable downstream: ensure saga-product creates the
> RULE artifact with `derived_from` → PRD, and ensure at least one UC or AC
> traces to it. The INV row in this table adds engineering teeth but is not
> what R15 looks for.
>
> **Source-of-truth split after ADR-014:**
>   - BUSINESS rules (the WHAT): PRD §RULE, saga-product owns.
>   - ENGINEERED invariants (the HOW): SRS §2.3 + this file, saga-architect
>     owns. SRS §2.3 is the canonical registry; this INVARIANCES-<module>.md
>     file is the per-module working copy referenced by scaffold and CGAD Step
>     1.
