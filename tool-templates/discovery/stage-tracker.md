# Discovery Stage Tracker — Project {PROJECT_ID}

## Collected Values (fill from task_get)
- task_id: {TASK_ID}
- execution_id: "{EXECUTION_ID}"
- intent_id: <fill from task_get metadata.work_intent_id>
- epic_id: {EPIC_ID}
- worker_id: "{WORKER_ID}"

## Step Progress (mark [x] after each step)
- [ ] 1. task_get({ id: {TASK_ID} }) — get intent_id, fill it above
- [ ] 2. Investigate context: repository_checkout_list, artifact_list, Read/Glob/Grep (3-4 calls MAX)
- [ ] 3. Copy discovery-doc-template.md → docs/discovery/discovery-{EPIC_ID}.md, fill it in
- [ ] 4a. Copy proposal-call-template.json → docs/discovery/proposal-call-{EPIC_ID}.json, fill it in
- [ ] 4b. Read proposal-call-{EPIC_ID}.json back, verify ALL fields (see checklist in the file)
- [ ] 4c. proposal_submit — submit using the verified values from your JSON file
- [ ] 5. worker_done({ task_id, worker_id, execution_id, result }) — close task

## Current Step: 1
## Errors: (none)
