# Discovery Stage Tracker — Project 39

## Collected Values (fill from task_get)
- task_id: 6291
- execution_id: "exec-39-29780-1785102951701-1"
- intent_id: 10271
- epic_id: 39
- worker_id: "board-39-1785102951701-1"

## Step Progress (mark [x] after each step)

### Discovery worker — proposal (Steps 1-5)
- [x] 1. task_get({ id: 6291 }) — get intent_id, fill it above
- [x] 2. Investigate context: repository_checkout_list, artifact_list, Read/Glob/Grep (3-4 calls MAX)
- [x] 3. Copy discovery-doc-template.md → docs/discovery/projects/39/discovery-39.md, fill it in
- [x] 4a. Copy proposal-call-template.json → docs/discovery/projects/39/proposal-call-39.json, fill it in
- [x] 4b. Read proposal-call-39.json back, verify ALL fields (see proposal-checklist.md)
- [~] 4c. proposal_submit — BLOCKED: "intent output_schema mismatch" (see Errors). Escalated via worker_ask_need.
- [ ] 5. worker_done({ task_id, worker_id, execution_id, result }) — close task

### Readiness advisor — shadow assessment (Steps 6-8)
- [ ] 6. readiness_get({ control_intent_id, execution_id }) — read canonical Proposal + allowed_source_refs + assessment output schema
- [ ] 7a. Copy readiness-call-template.json → docs/discovery/projects/39/readiness-call-39.json, fill it in using ONLY proposal_id / proposal_content_hash from readiness_get, and source_refs from allowed_source_refs
- [ ] 7b. Read readiness-call-39.json back, verify ALL fields (see readiness-checklist.md)
- [ ] 8. readiness_submit({ control_intent_id, execution_id, schema_version, payload }) — submit the verified readiness assessment

### Diagnosis advisor — explain the issued certificate (Steps 9-11)
- [ ] 9. diagnosis_get({ control_intent_id, execution_id }) — read immutable DiagnosisCase (certificate, proposal, readiness, policy_trace, allowed_source_refs) + report output schema
- [ ] 10a. Copy diagnosis-call-template.json → docs/discovery/projects/39/diagnosis-call-39.json, fill it in using certificate id/hash/settlement_input_hash/decision VERBATIM from diagnosis_case.certificate; cite ONLY policy_trace conditions with contributed_to_decision === true
- [ ] 10b. Read diagnosis-call-39.json back, verify ALL fields (see diagnosis-checklist.md), including the decision-specific rules and the forbidden-fields check
- [ ] 11. diagnosis_submit({ control_intent_id, execution_id, schema_version, payload }) — submit the verified diagnosis report

## Current Step: 4c (BLOCKED — escalated to human via worker_ask_need)
## Errors:
- proposal_submit (attempt 1 of 2) threw: `proposal_submit: intent output_schema mismatch`.
- Root cause (CONFIRMED in source + DB): the Process Module LM executor writes the
  WRONG schema into the WorkIntent row.
  - `src/process-modules/application/node-executors/lm-node-executor.ts:248` passes
    `outputSchema: profile.outputSchema.id` when creating the intent.
  - `profile.outputSchema.id` = `saga3.discovery-proposal.v1` (the PROPOSAL payload schema).
  - But `proposal_submit` (`src/tools/saga3-proposals.ts:70`) requires the intent row's
    `output_schema` to equal `DISCOVERY_WORK_INTENT_SCHEMA` =
    `saga3.work-intent.discovery.v1` (the WORK-INTENT schema = `profile.workIntentSchema.id`).
  - DB check (read-only): `saga3_work_intents.id=10271` has
    `output_schema='saga3.discovery-proposal.v1'`, `kind='discovery'`,
    `projected_task_id=6291`, `status='executing'`. kind/task/execution all pass; only
    output_schema is wrong.
- This is a deterministic, payload-independent runtime bug. No edit to proposal-call-39.json
  can make proposal_submit pass. The intent row is reused idempotently (ensureExecutionPlan),
  so it will NOT self-correct. A 2nd submit attempt would fail identically — deliberately NOT
  retried to avoid wasting the retry budget on a proven-futile call.
- Required fix (runtime/kernel side — outside this worker's authority):
  1. Source: in `lm-node-executor.ts:248` use `profile.workIntentSchema.id` instead of
     `profile.outputSchema.id` (one-line fix).
  2. DB: correct existing affected intent rows, e.g.
     `UPDATE saga3_work_intents SET output_schema='saga3.work-intent.discovery.v1'
      WHERE id=10271;` (and any other process-module-spawned discovery intents).
  3. Rebuild + restart the saga MCP server, then re-answer this task so it re-queues.
- Artifacts produced and retained (ready to submit once unblocked):
  - docs/discovery/projects/39/discovery-39.md (discovery document)
  - docs/discovery/projects/39/proposal-call-39.json (verified proposal-call JSON, checklist-passing)
- Per protocol (Machine-filled rule / Startup hook), this worker must NOT rewrite the
  runtime-owned `output_schema` value itself; reporting the fenced-context error instead.
