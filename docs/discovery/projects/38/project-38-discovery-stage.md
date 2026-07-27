# Discovery Stage Tracker — Project 38

## Collected Values (fill from task_get)
- task_id: 6261
- execution_id: "exec-38-17520-1785056600414-1"
- intent_id: 10258
- epic_id: 38
- worker_id: "board-38-1785056600414-1"

## Step Progress (mark [x] after each step)

### Discovery worker — proposal (Steps 1-5)
- [x] 1. task_get({ id: 6261 }) — get intent_id, fill it above
- [x] 2. Investigate context: repository_checkout_list, artifact_list, Read/Glob/Grep (3-4 calls MAX)
- [x] 3. Copy discovery-doc-template.md → docs/discovery/projects/38/discovery-38.md, fill it in
- [x] 4a. Copy proposal-call-template.json → docs/discovery/projects/38/proposal-call-38.json, fill it in
- [x] 4b. Read proposal-call-38.json back, verify ALL fields (see proposal-checklist.md)
- [x] 4c. proposal_submit — submit using the verified values from your JSON file
- [x] 5. worker_done({ task_id, worker_id, execution_id, result }) — close task

### Readiness advisor — shadow assessment (Steps 6-8)
- [x] 6. readiness_get({ control_intent_id, execution_id }) — read canonical Proposal + allowed_source_refs + assessment output schema
- [x] 7a. Copy readiness-call-template.json → docs/discovery/projects/38/readiness-call-38.json, fill it in using ONLY proposal_id / proposal_content_hash from readiness_get, and source_refs from allowed_source_refs
- [x] 7b. Read readiness-call-38.json back, verify ALL fields (see readiness-checklist.md)
- [x] 8. readiness_submit({ control_intent_id, execution_id, schema_version, payload }) — submit the verified readiness assessment

### Diagnosis advisor — explain the issued certificate (Steps 9-11)
- [x] 9. diagnosis_get({ control_intent_id, execution_id }) — read immutable DiagnosisCase (certificate, proposal, readiness, policy_trace, allowed_source_refs) + report output schema
- [x] 10a. Copy diagnosis-call-template.json → docs/discovery/projects/38/diagnosis-call-38.json, fill it in using certificate id/hash/settlement_input_hash/decision VERBATIM from diagnosis_case.certificate; cite ONLY policy_trace conditions with contributed_to_decision === true
- [x] 10b. Read diagnosis-call-38.json back, verify ALL fields (see diagnosis-checklist.md), including the decision-specific rules and the forbidden-fields check
- [x] 11. diagnosis_submit({ control_intent_id, execution_id, schema_version, payload }) — submit the verified diagnosis report

## Current Step: done
## Submitted: proposal_id=139, content_hash=59565874e7242601e537005510b05678516b89d857a6d589c4170de284e5e7a1, recommended_outcome=clarify
## Readiness: assessment_id=79, overall_readiness=conditionally_ready, recommended_next_action=request_clarification, status=accepted_by_kernel
## Diagnosis: report_id=21, certificate_id=22, decision=clarify, status=accepted_by_kernel, content_hash=a55a7778d196c3a346c88a2e5582ea8d1849c3ad73648ae13004e9aedcc7a11b
## Errors: (none)
