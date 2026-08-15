# Diagnosis Submit Checklist

Read diagnosis-call-{EPIC_ID}.json and verify EVERY item:

## Top-level fields
- [ ] control_intent_id is an integer (like 10228, NOT "10228" or a string) — from diagnosis_get metadata
- [ ] execution_id is a string in quotes
- [ ] schema_version is exactly "factory.discovery-diagnosis.v1"

## target (must match diagnosis_case.certificate EXACTLY)
- [ ] payload.target.certificate_id is an integer matching diagnosis_case.certificate.id
- [ ] payload.target.certificate_hash is a 64-char lowercase hex matching diagnosis_case.certificate.hash
- [ ] payload.target.settlement_input_hash is a 64-char lowercase hex matching diagnosis_case.certificate.settlement_input_hash
- [ ] payload.target.decision is one of: go, clarify, reject — and matches diagnosis_case.certificate.decision

## executive_summary
- [ ] payload.executive_summary is a non-empty string

## cause_analysis items
- [ ] Each item has cause_id (non-empty string), category, description (non-empty string), severity, reason_codes, cited_condition_ids, source_refs
- [ ] Each cause_id is UNIQUE across the cause_analysis array
- [ ] category is one of: missing_evidence, blocking_gap, conflicting_assessment, low_confidence, scope_problem, unresolved_unknown, policy_condition, residual_risk
- [ ] severity is one of: blocking, material, informational
- [ ] reason_codes is a real array (not a string)
- [ ] cited_condition_ids is a real array (not a string)
- [ ] source_refs is a real array with at least one element
- [ ] Every source_ref is in diagnosis_get allowed_source_refs (NO invented evidence)

## Decision-specific cause rules (check the one that matches target.decision)
- [ ] If decision == clarify: at least one cause is present, and every reason code emitted by the certificate is covered by some cause's reason_codes
- [ ] If decision == go: NO cause has severity == blocking (a GO has no blocking cause)
- [ ] If decision == reject: at least one cause has severity == blocking (the blocking cause that drove the REJECT)

## cited_condition_ids + reason_codes cross-check
- [ ] Every cited_condition_id exists in diagnosis_case.policy_trace
- [ ] Every cited_condition_id has contributed_to_decision === true in policy_trace (no alternative-branch or short-circuited predicates)
- [ ] Every reason_code in a cause matches a reason code in the emitted_reason_codes of at least one cited condition

## information_requests items
- [ ] Each item has request_id (non-empty string, unique), question (non-empty string), resolves_cause_ids, source_refs (real array)
- [ ] Every cause id in resolves_cause_ids exists in cause_analysis

## recommended_actions items
- [ ] Each item has action_id (non-empty string, unique), action, description (non-empty string), resolves_cause_ids, source_refs (real array)
- [ ] action is one of: collect_information, resolve_conflict, revise_scope, repeat_discovery, request_human_decision, proceed_with_monitoring
- [ ] Every cause id in resolves_cause_ids exists in cause_analysis

## residual_risks items
- [ ] Each item has risk (non-empty string), source_refs (real array with at least one element)
- [ ] Every source_ref is in diagnosis_get allowed_source_refs (NO invented evidence)

## confidence
- [ ] payload.confidence is a finite number in [0, 1]

## Forbidden fields (advisory layer must NEVER carry authority-shaped fields)
- [ ] NO field named "new_outcome"
- [ ] NO field named "override_decision"
- [ ] NO field named "approved"
- [ ] NO field named "settled"
- [ ] NO field named "transition_stage"
- [ ] NO field named "new_certificate"

## Final
- [ ] NO "FILL_" placeholders remain in the file

If ANY item fails, use Edit to fix the JSON, then re-read and re-check.
Only submit when ALL items pass.
