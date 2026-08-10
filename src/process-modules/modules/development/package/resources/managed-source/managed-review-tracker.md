# Managed source review

Review the exact Factory-materialized candidate commit/tree referenced by the author CandidateSet.

- Compare it with the frozen base and the complete assigned acceptance contract.
- Treat the author’s prose as claims, not repository authority.
- Confirm scope, behavior, dependency preservation, and test evidence on the exact tree.
- Submit exactly `factory.development-review-verdict.v1` with the exact author
  `subject_candidate_set_ref`, `verdict`, and `findings`. The generic
  `factory.review-verdict.v1` is a different contract and must not be used.
- Never edit files, run Git, or integrate.
