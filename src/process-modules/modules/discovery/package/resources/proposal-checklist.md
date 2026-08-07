# Discovery Proposal Product Checklist

Before `product_submit`, read the exact proposal call file and verify every item:

- [ ] `schema` is exactly `factory.discovery-proposal.v1`.
- [ ] `content.problem_statement` is a non-empty string.
- [ ] `content.observed_context` is a non-empty string.
- [ ] `content.stakeholders_or_actors` is a JSON array of strings.
- [ ] `content.assumptions` is a JSON array of strings.
- [ ] `content.unknowns` is a JSON array of strings.
- [ ] `content.risks` is a JSON array of strings.
- [ ] `content.candidate_scope` is a non-empty string.
- [ ] `content.evidence_refs` is a JSON array of strings and contains no invented evidence.
- [ ] `content.recommended_outcome` is one of: go, clarify, reject, defer, inconclusive, failed.
- [ ] `content.rationale` is a non-empty string grounded in the inspected context.
- [ ] No `FILL_` placeholder remains.

Machine identity is not part of the product body. The server derives the current
ProcessRun, Workplace, task, intent and execution from the live fence.

If any item fails, repair the same file, re-read it and re-check. Submit only
when all items pass; the Production Cell gate, not the worker, decides whether
the product is accepted.
