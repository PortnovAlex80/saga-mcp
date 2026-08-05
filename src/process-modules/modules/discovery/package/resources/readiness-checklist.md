# Readiness Submit Checklist

Read readiness-call-{EPIC_ID}.json and verify EVERY item:

## Top-level fields
- [ ] control_intent_id is an integer (like 10228, NOT "10228" or a string) — from readiness_get metadata
- [ ] execution_id is a string in quotes
- [ ] schema_version is exactly "factory.discovery-readiness-assessment.v1"

## Payload identity binding
- [ ] payload.proposal_id is an integer matching readiness_get canonical proposal id
- [ ] payload.proposal_content_hash is a 64-char lowercase hex SHA-256 matching readiness_get canonical proposal content hash

## overall_readiness + recommended_next_action + confidence + rationale
- [ ] payload.overall_readiness is one of: ready, conditionally_ready, not_ready, inconclusive
- [ ] payload.recommended_next_action is one of: proceed_to_settlement, request_clarification, repeat_discovery, defer, reject, manual_review
- [ ] payload.confidence is a finite number in [0, 1]
- [ ] payload.rationale is a non-empty string

## dimension_assessments (all 7 keys required, NO unknown keys)
- [ ] payload.dimension_assessments.problem_clarity present
- [ ] payload.dimension_assessments.scope_boundedness present
- [ ] payload.dimension_assessments.stakeholder_coverage present
- [ ] payload.dimension_assessments.assumption_visibility present
- [ ] payload.dimension_assessments.unknowns_manageability present
- [ ] payload.dimension_assessments.risk_visibility present
- [ ] payload.dimension_assessments.evidence_grounding present
- [ ] No extra/unknown dimension keys are present (exactly 7)

## Each dimension entry
- [ ] .status is one of: sufficient, partial, insufficient, unknown
- [ ] .rationale is a non-empty string
- [ ] .source_refs is a real array (not a string) with at least one element
- [ ] Every source_ref in .source_refs is in readiness_get allowed_source_refs (NO invented evidence)

## blocking_gaps / non_blocking_gaps
- [ ] payload.blocking_gaps is a real array (not a string)
- [ ] payload.non_blocking_gaps is a real array (not a string)
- [ ] Each gap has code (non-empty), description (non-empty), source_refs (real array with at least one element)
- [ ] Gap codes are unique WITHIN blocking_gaps
- [ ] Gap codes are unique WITHIN non_blocking_gaps
- [ ] No gap code appears in BOTH lists (a code cannot be both blocking and non-blocking)
- [ ] Every source_ref in every gap is in readiness_get allowed_source_refs (NO invented evidence)

## Final
- [ ] NO "FILL_" placeholders remain in the file

If ANY item fails, use Edit to fix the JSON, then re-read and re-check.
Only submit when ALL items pass.
