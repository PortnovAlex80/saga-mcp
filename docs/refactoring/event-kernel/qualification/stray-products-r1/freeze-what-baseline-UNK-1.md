# Unknown 1: Baseline Freeze Scope

**Unknown ID:** UNK-1  
**Digest:** f7acf9d19953686e3042a10755a867a8f80a7fdb3963bd8e78e725962c792276

## Question

What is the precise scope of material that should be frozen in the freeze-what-baseline desk? Should the baseline include only direct desk artifacts, or should it also include transitive dependencies and referenced external material?

## Context

The freeze-what-baseline desk operates with 0 accepted upstream revisions traveling by content address. This suggests a clean slate, but the scope of what constitutes "baseline material" needs clarification:

1. **Direct Artifacts**: Source claims, constraints, unknowns, terminal claims
2. **Transitive Dependencies**: ADR-053, CONVEYOR-MENTAL-MODEL.md references
3. **External References**: Architectural decisions, mental models, other docs
4. **Workspace State**: Current desk state, execution history, provenance data

## Analysis Options

**Option A - Minimal Scope**: Only freeze the direct artifacts (SC-1, SC-2, SC-3, CON-1, UNK-1, TC-1, TC-2). Pros: Clean, focused, minimal. Cons: May miss important context.

**Option B - Extended Scope**: Freeze direct artifacts plus transitive dependencies referenced in the formalization. Pros: Complete context, self-contained. Cons: Larger baseline, potential duplication.

**Option C - Comprehensive Scope**: Freeze all material that could influence baseline interpretation, including external documents. Pros: Maximum completeness. Cons: Very large, potential over-inclusion.

## Resolution Approach

The terminal claims (TC-1, TC-2) will define the proper scope based on the foundational principles established in the source claims and constraints.

## Status

Pending resolution through terminal claim derivation.