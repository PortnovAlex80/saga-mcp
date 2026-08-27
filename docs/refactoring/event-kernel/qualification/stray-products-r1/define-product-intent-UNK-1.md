# Unknown 1: Product Intent Granularity

**Unknown ID:** UNK-1  
**Digest:** f7acf9d19953686e3042a10755a867a8f80a7fdb3963bd8e78e725962c792276

## Question

What is the precise granularity for atomic intent members in the PRD container? Should each intent member be individually content-addressed, or should the entire PRD container be addressed as a single unit?

## Context

The define-product-intent desk must produce PRD containers with stable atomic intent members for:
- System boundary
- Actors and affected stakeholders
- Stakeholder, user, operator, or mission outcomes
- Scope and exclusions
- Lifecycle terminal claims
- Constraints
- Assumptions and unknowns
- Required dispositions

The granularity question impacts:
1. **Content Addressing Strategy**: Individual member digests vs. container digest
2. **Trace Granularity**: Can downstream cells reference specific intent members?
3. **Revision Semantics**: Does changing one intent member create a new PRD revision?
4. **Verification Scope**: Can individual intent members be independently verified?

## Analysis Options

**Option A - Container-Level Granularity**: Address entire PRD container as one content digest. Pros: Simple, atomic, coherent. Cons: Cannot reference individual intent members, larger revision units.

**Option B - Member-Level Granularity**: Address each atomic intent member individually. Pros: Fine-grained references, precise tracing, incremental updates. Cons: More complex, potential consistency challenges.

**Option C - Hybrid Granularity**: Address container for overall authority, members for detailed references. Pros: Best of both worlds. Cons: More complex synchronization.

## Resolution Approach

The terminal claims (TC-1, TC-2) will define the proper granularity based on the foundational principles established in the source claims and constraints, considering downstream needs for use case modeling and requirements formalization.

## Status

Pending resolution through terminal claim derivation.

## Product Intent Context

This unknown directly impacts:
- How model-use-cases Cell references actor definitions from PRD
- How formalization cells trace requirements to intent members
- How intent revisions are managed and verified
- How content address transport operates for intent artifacts