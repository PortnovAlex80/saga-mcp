# Discovery Stage Tracker — Project 43

## Collected Values (fill from task_get)
- task_id: 6285
- execution_id: "exec-43-29860-1785076984323-1"
- intent_id: 10265
- epic_id: 43
- worker_id: "board-43-1785076984323-1"

## Step Progress (mark [x] after each step)

### Discovery worker — proposal (Steps 1-5)
- [ ] 1. task_get({ id: 6285 }) — get intent_id, fill it above
- [ ] 2. Investigate context: repository_checkout_list, artifact_list, Read/Glob/Grep (3-4 calls MAX)
- [ ] 3. Copy discovery-doc-template.md → docs/discovery/projects/43/discovery-43.md, fill it in
- [ ] 4a. Copy proposal-call-template.json → docs/discovery/projects/43/proposal-call-43.json, fill it in
- [ ] 4b. Read proposal-call-43.json back, verify ALL fields (see proposal-checklist.md)
- [ ] 4c. proposal_submit — submit using the verified values from your JSON file
- [ ] 5. worker_done({ task_id, worker_id, execution_id, result }) — close task

### Readiness advisor — shadow assessment (Steps 6-8)
- [ ] 6. readiness_get({ control_intent_id, execution_id }) — read canonical Proposal + allowed_source_refs + assessment output schema
- [ ] 7a. Copy readiness-call-template.json → docs/discovery/projects/43/readiness-call-43.json, fill it in using ONLY proposal_id / proposal_content_hash from readiness_get, and source_refs from allowed_source_refs
- [ ] 7b. Read readiness-call-43.json back, verify ALL fields (see readiness-checklist.md)
- [ ] 8. readiness_submit({ control_intent_id, execution_id, schema_version, payload }) — submit the verified readiness assessment

### Diagnosis advisor — explain the issued certificate (Steps 9-11)
- [ ] 9. diagnosis_get({ control_intent_id, execution_id }) — read immutable DiagnosisCase (certificate, proposal, readiness, policy_trace, allowed_source_refs) + report output schema
- [ ] 10a. Copy diagnosis-call-template.json → docs/discovery/projects/43/diagnosis-call-43.json, fill it in using certificate id/hash/settlement_input_hash/decision VERBATIM from diagnosis_case.certificate; cite ONLY policy_trace conditions with contributed_to_decision === true
- [ ] 10b. Read diagnosis-call-43.json back, verify ALL fields (see diagnosis-checklist.md), including the decision-specific rules and the forbidden-fields check
- [ ] 11. diagnosis_submit({ control_intent_id, execution_id, schema_version, payload }) — submit the verified diagnosis report

## Current Step: 1
## Errors: (none)
