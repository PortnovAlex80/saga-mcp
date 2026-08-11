# ADR-057: Reviewer subject identity is execution authority

Status: Accepted

## Context

Run 015's visualization reviewer repeatedly copied an adjacent or abbreviated
reference and used camelCase `subjectCandidateSetRef`. Static validation safely
rejected every product, but returned only a shape error. The worker then guessed
until it exited without a product. Its process also started in the canonical
checkout because reviewer desk provisioning queried the latest author set
instead of the exact set frozen into the review WorkIntent.

Scripted workers always copied the correct field, so prior traversal tests did
not exercise this production-language mutation.

## Decision

The reviewer WorkIntent's `subject_candidate_set_ref` binding is authoritative.
Submission evaluates that contextual binding before static schema validation so
an invalid attempt receives the exact required field and value. The Factory
never auto-corrects reviewer testimony.

RepositoryDesk provisioning resolves the source commit from that exact
CandidateSet ref and Workplace. Missing or mismatched authority fails before
worker spawn; it never falls back to the canonical checkout or a moving latest
candidate. Reviewer worktrees remain detached at the exact commit.

## Consequences

Reviewer repair is actionable without weakening evidence semantics. A changed
author CandidateSet necessarily creates a new review subject. Tests include
wrong CandidateSet, WorkplaceRef, and camelCase-field mutations. Production and
scripted workers continue through the same submission and desk boundaries.
