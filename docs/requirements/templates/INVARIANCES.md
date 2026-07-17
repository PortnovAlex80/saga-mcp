# Invariants — <module name>

<!--
  Copy this template to docs/requirements/REQ-NNN-<slug>/INVARIANCES-<module>.md.
  One file per module. Human-authored, ~10 lines. The SRS §2.3 Invariant
  Registry is the source of truth; this file is the per-module working copy
  referenced by the scaffold (Pattern B) and by the CGAD Step 1 intercept.

  For each invariant declare:
    - Module       — which module protects this invariant
    - Predicate    — formal, testable (e.g. `refund.amount <= charge.amount`)
    - Check type   — L3 property test / L4 benchmark / L0 type constraint
    - AC reference — the AC id(s) that verify this invariant

  If an invariant cannot be tested, it is a wish, not an invariant — remove it
  or reformulate it until it is testable.
-->

| Module | Invariant (predicate) | Check type | AC reference |
|--------|-----------------------|------------|--------------|
| _module_ | _predicate_ | L3 / L4 / L0 | AC-_n_ |

<!-- Notes / enforcement expectations below. -->

## Enforcement

Every invariant SHOULD have a property test (L3) or benchmark (L4) covering it
(R13 flags episodes with zero `verification.ac` tasks; per-invariant
enforcement is future work).

Every invariant MUST be covered by at least one AC (the "AC reference" column
above). An invariant with no AC is a gap the analyst must close before the SRS
can be accepted.

> **Note on R13 (cgad-spec-lint v1.1).** R13 checks that the episode has at
> least one `verification.ac` task — i.e. that independent verification was
> *planned* for the SRS. It does NOT verify that each individual invariant in
> this table has its own property test. Per-invariant property-test enforcement
> requires the `test_layer` field on verification evidence (future REQ-014);
> until then, treat the table above as a human contract, not a machine gate.
