# Proposal Submit Checklist

Read proposal-call-{EPIC_ID}.json and verify EVERY item:

- [ ] intent_id is an integer (like 10228, NOT "10228" or a string)
- [ ] task_id is an integer
- [ ] execution_id is a string in quotes
- [ ] kind is exactly "discovery"
- [ ] schema_version is exactly "saga3.discovery-proposal.v1"
- [ ] payload.problem_statement is a non-empty string
- [ ] payload.observed_context is a non-empty string
- [ ] payload.stakeholders_or_actors is a real array: ["a", "b"] (not a string!)
- [ ] payload.assumptions is a real array
- [ ] payload.unknowns is a real array
- [ ] payload.risks is a real array
- [ ] payload.candidate_scope is a non-empty string
- [ ] payload.evidence_refs is a real array
- [ ] payload.recommended_outcome is one of: go, clarify, reject, defer, inconclusive, failed
- [ ] payload.rationale is a non-empty string
- [ ] NO "FILL_" placeholders remain in the file

If ANY item fails, use Edit to fix the JSON, then re-read and re-check.
Only submit when ALL items pass.
