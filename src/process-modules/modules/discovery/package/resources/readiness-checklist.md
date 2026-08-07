# Discovery Readiness Product Checklist

Before `product_submit`, verify the exact accepted Proposal ProductRef from
`task.metadata.process_node_input`, call `product_read` with that exact
`schema_id/ref/digest`, and then check every item below.

## Product envelope
- [ ] `schema` is exactly `factory.discovery-readiness-assessment.v1`.
- [ ] `content.proposal_id` equals `product_read.submission_id` for the accepted Proposal.
- [ ] `content.proposal_content_hash` equals the Proposal ProductRef `digest` exactly.

## Decision fields
- [ ] `overall_readiness` is one of: ready, conditionally_ready, not_ready, inconclusive.
- [ ] `recommended_next_action` is one of: proceed_to_settlement, request_clarification, repeat_discovery, defer, reject, manual_review.
- [ ] `confidence` is finite and in [0,1].
- [ ] `rationale` is non-empty and grounded in the Proposal.

## Seven required dimensions
- [ ] problem_clarity
- [ ] scope_boundedness
- [ ] stakeholder_coverage
- [ ] assumption_visibility
- [ ] unknowns_manageability
- [ ] risk_visibility
- [ ] evidence_grounding
- [ ] No additional dimension key exists.

For every dimension:
- [ ] status is sufficient | partial | insufficient | unknown.
- [ ] rationale is non-empty.
- [ ] source_refs is a non-empty array.
- [ ] every source_ref is either an exact Proposal JSON path (`$.<field>`) or an evidence ref literally present in `Proposal.evidence_refs`.

For blocking_gaps and non_blocking_gaps:
- [ ] both are arrays.
- [ ] every gap has a unique non-empty code, non-empty description and non-empty source_refs.
- [ ] no code appears in both arrays.
- [ ] no source ref is invented.

## Final
- [ ] No `FILL_` placeholder remains.
- [ ] The Proposal was read by exact ProductRef, never by task id, latest lookup or a Discovery-specific control tool.

If any check fails, repair the same file and re-read it. The Production Cell
gate performs the authoritative validation after submission.
