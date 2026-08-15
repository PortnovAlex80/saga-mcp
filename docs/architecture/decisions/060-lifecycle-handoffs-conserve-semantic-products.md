# 060. Lifecycle handoffs conserve semantic products

- **Status:** Accepted
- **Date:** 2026-08-11
- **Decision-maker:** autonomous-decision skill (Cynefin: Clear)

## Context

Clean real Run020 completed Discovery for the requested Mars/Venus ballistic
calculator, but Formalization began specifying an unrelated communication
bridge. The state transition and certificate lineage were valid. The
`FormalizationCase`, however, carried only the Discovery certificate identity
and outcome; it omitted both the accepted Discovery Proposal and the original
initiative subject. A certificate proves that a decision occurred. It is not
the semantic product on which the next workshop must work.

The existing scripted lifecycle test also represented Discovery with
`output: null`, so it positively encoded the information loss while proving
that the route completed.

## Decision

Every cross-workshop lifecycle handoff that affects downstream semantics must
carry two independently hash-checked values:

1. the outcome certificate, which proves authority and the decision; and
2. the exact immutable output product, which preserves the accepted WHAT.

Discovery therefore exposes its accepted `factory.discovery-proposal.v1` as
the ProcessRun output. The lifecycle dereferences that exact ref/hash and maps
the proposal payload, proposal identity, and original initiative subject into
the FormalizationCase. Formalization fails closed when any of those values is
missing or when the proposal payload does not match its hash.

The generic orchestrator remains ignorant of Discovery and Formalization
semantics. Module-owned output resolvers and declarative stage mappings own the
typed handoff.

## Consequences

- A legally routed lifecycle can no longer silently discard the request's
  semantic subject at the Discovery→Formalization boundary.
- Certificates and semantic products keep distinct authority roles.
- Canonical lifecycle tests must assert information conservation, not only
  route reachability and terminal status.
- Old pinned runs remain immutable evidence; Run020 is not resumed because it
  already formalized the wrong subject.

## Decision journal

Expected result: Run021 Formalization receives the exact ballistic-calculator
proposal and initiative subject, and no future canonical lifecycle fixture may
model an accepted Discovery stage with a null output. Review at the next clean
cross-workshop run and whenever a new stage mapping is introduced.

