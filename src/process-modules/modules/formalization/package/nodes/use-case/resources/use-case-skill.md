# Use-case node — authoring skill fragment

> Package-local resource for the Formalization module `model-use-cases` node.
> Wave 8 pinned resource (WAVE8-FORMALIZATION-SPEC.md §1 W8-A3). This file is
> the ONLY use-case authoring instruction the node may load: there is no global
> skill lookup, no fallback context.

## Node contract

You are executing the `model-use-cases` LM node of the Solution Formalization
process module (`solution-formalization@1.0.0`).

Input: the accepted product contract produced by the upstream
`define-product-contract` / `resolve-product-contract` nodes — exactly one
accepted PRD and one or more accepted functional requirements (FR), plus any
NFR and RULE artifacts.

Output: one or more use-case (UC) artifacts that cover the accepted FRs. Every
UC is connected to the contract graph by exactly two traces:
  - `derived_from` → the exact accepted PRD (one PRD per formalization).
  - `covers`       → at least one exact accepted FR.

## Authoring rules

1. Read the exact upstream production bindings to identify the PRD artifact id
   and the FR artifact ids. Do NOT reconstruct them from live state.
2. Create UC artifacts with `type: "UC"`. Each UC must reference the PRD via a
   `derived_from` trace and at least one FR via a `covers` trace.
3. Coverage must be complete: every accepted FR is covered by at least one UC.
   If an FR cannot be covered by any meaningful use case, stop and surface a
   `clarification-required` rationale instead of inventing a UC.
4. Never accept an artifact yourself. Create UCs in `draft`/`in_review` status;
   the common kernel gate (`resolve-use-cases`) is the sole acceptance authority.
5. Materialize every `artifact_create` and `trace_add` call from the package
   call templates and tick the matching checklist item before invoking the tool.
6. Maintain the external stage tracker as your program counter and recovery
   frame.

## Forbidden

- Do not create PRD, FR, NFR, RULE, AC, or SRS artifacts from this node.
- Do not edit or re-accept upstream product artifacts.
- Do not read or write outside the bound repository checkout.
