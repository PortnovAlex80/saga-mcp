# Critic 6: OCaml/ML Module Type Theorist

> **Verdict:** "Proposal has syntax of module system without semantics. 'Face as type' should be re-read as 'Face as spec' — useful but different thing."

## Seven critiques

1. **Faces are declared, not checked — specifications, not types.** ML signature IS typing judgment with decision procedure. Face is markdown/YAML. R19 is lint (name-presence matching), not type relation. Face is JML-style annotation, not Java-style type.

2. **"Resolved in saga DB" hides absence of resolver.** Haskell typeclasses resolved by constraint resolution + coherence. Rust traits by trait solver + orphan rule. saga DB records claims, cannot verify IMPLEMENTS relation.

3. **Functors absent — generic patterns cannot be expressed.** No `Face Repository(E: EntityFace)`. Cannot write generic Repository once, instantiate at User/Order/Invoice.

4. **Abstract types absent — no opacity knob.** No `type t` (abstract). No representation independence. Bodies cannot be refactored independently if types exposed.

5. **Generativity vs applicativity unaddressed.** Two Bodies implementing same Face — are types same? saga records both as `implements F`, indistinguishable. Sound system must specify.

6. **"Protects" is property, not type — lives at L3, not L0.** Real type systems encode via phantom types, GADTs, refinement types, dependent types. Face's "protects" is string in YAML. Cannot prevent bad program from type-checking.

7. **First-class modules absent — composition structurally limited.** Modules are top-level artifacts, not values. Class B patterns need first-class packaging; proposal forces closed-world composition root.

## What proposal SHOULD adopt

**A. Real signature language with abstract types + checking algorithm** — WIT + per-language checker invoked at task completion as hard gate (not warning). Addresses critiques 1, 2, 4.

**B. Refinement types for "protects" axis** — Liquid Haskell/F* heritage. SMT-discharged checker. `{ r:Money | r <= amount }`. Promotes protects from L3 (property-tested) to L0 (compile-time). Addresses critique 6.

**C. Functors with first-class packaging** — `Face Repository(E: EntityFace)`. `instantiates` trace edge. Open-world composition. Addresses critiques 3, 5, 7.

## Bottom line

Until three features in place, "Face as type" = "Face as spec." Valuable, important, but different thing. Don't claim OCaml lineage without OCaml's teeth.
