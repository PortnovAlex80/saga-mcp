# D1.1 Smoke Evidence — runtime authority enforcement acceptance record

**Date:** 2026-07-24
**Branch:** `saga3-discovery` @ `304e66d`
**Head commit:** `304e66d feat(saga3-d1-1): immutable execution authority + MCP gateway enforcement`

D1.1 acceptance smoke. The same immutable execution-context snapshot, frozen at
claim, is the single source of truth for (1) worker launch model/provider/effort,
(2) Saga MCP tool authorization, (3) Proposal provenance. Saga 3 is fail-closed;
legacy Saga 2 is compatibility-allowed.

Project `d11-smoke-csv2json` (id 31), epic 32, intent 5, task 179.
Model: `qwen3.6-35b-a3b@q4_k_xl` via LM Studio (set on epic 32 before the
review-execution claim).

---

## Positive path — discovery worker completes under enforcement='runtime'

Build-execution (exec #1) → proposal #5 → worker_done → review. Then
review-execution (exec #4) → worker_done → done. The runtime gateway let every
allowed call through; the worker never hit AUTHORITY_DENIED on its legitimate
tool surface.

| exec | role | route frozen in snapshot | terminal | evidence |
|------|------|--------------------------|----------|---------|
| #1 `exec-31-18400-...526-1` | developer (build) | `zai/opus`¹ | exited, code 0, 21:16:23 | proposal #5 submitted 21:16:12, worker_done approved → review 21:16:18 |
| #4 `exec-31-22760-...579-1` | reviewer | `qwen3.6-35b-a3b@q4_k_xl @ lmstudio` | exited, code 0, 21:23:37 | worker_done approved → done; heartbeat `CLOSED exit=0 completed status=done` |

¹ Build-exec was claimed BEFORE the model was set on epic 32, so its snapshot
correctly froze the pre-model route (zai/opus). This is the single-snapshot rule
working as designed: each execution freezes the route live at its claim instant,
no retroactive change. The review-exec, claimed AFTER model/set, froze LM Studio.
Proposal #5 provenance carries the build-exec route (model:null/provider:zai) —
honest provenance for the execution that produced it.

### Final state (post-smoke, pre-purge)

- task 179: `done`, unassigned, `current_execution_id` cleared
- intent 5: `concluded` (CAS executing → concluded on clean closure)
- engine saga3-discovery: exited on its own (task done + process gone → `terminal=clean`)
- snapshot fields verified on exec #4: `policy_version=saga3.execution.v1`,
  `authority.enforcement=runtime`, `allowed_saga_tools=[task_get,
  repository_checkout_list, artifact_list, note_list, proposal_submit,
  worker_done]`, `model_route={qwen3.6-35b-a3b@q4_k_xl, lmstudio, effort:null}`,
  `execution_context_hash=c235e091...`

## Negative path — AUTHORITY_DENIED blocks a disallowed tool before the handler

Called `authorizeSagaToolCall` directly against exec #4's frozen snapshot (the
gateway logic is identical whether invoked in-process by src/index.ts or here):

```
task_get      → { allow: true, executionId: 'exec-31-22760-...579-1' }
task_create   → { allow: false, code: 'AUTHORITY_DENIED',
                  details: { execution_id: 'exec-31-22760-...579-1',
                             work_intent_id: 5,
                             requested_tool: 'task_create',
                             allowed_tools: [task_get, repository_checkout_list,
                                              artifact_list, note_list,
                                              proposal_submit, worker_done],
                             policy_version: 'saga3.execution.v1',
                             recovery: 'The controller must issue a new WorkIntent
                                        with the required authority. The worker
                                        cannot expand its own authority.' } }
auth-test tasks created: 0   (handler never ran — no state change)
```

The denial is actionable (names execution, intent, requested tool, allowed list,
policy version, recovery). The worker cannot expand its own authority — only a
new WorkIntent can.

---

## Completion criteria (from spec) — met

1. ✅ Discovery worker sees only the allowed Saga MCP set under runtime enforcement.
2. ✅ Creates a typed Proposal (`saga3.discovery-proposal.v1`).
3. ✅ Calls `worker_done` (build → review → done), both accepted.
4. ✅ `scopeCompleted=true`, engine exited clean on its own.
5. ✅ Negative: same execution calling a disallowed tool → AUTHORITY_DENIED,
   handler not invoked, task/episode state unchanged.
6. ✅ claim model == spawn model == proposal provenance (single frozen snapshot
   per execution; verified by the route field on exec #4 == the route the
   claude process started under == nothing re-read).

**D1.1 is accepted.** Next per roadmap: D2 deterministic normalization.

## Incident note — duplicate intent/task during smoke

While verifying, I (the operator) called `/api/engine/stop` mid-review, which
made the saga3-discovery engine CAS intent 5 → `concluded` while task 179 was
still in `review_in_progress`. On restart the engine did not find an open intent
and projected a second intent 6 + task 180. I cleaned the duplicate (intent 6
cancelled, task 180 deleted, task 179 reset to `review`, intent 5 reopened) and
re-ran the review-execution cleanly. This is an operator-induced artifact of the
single-shot discovery model under manual engine stop, not a D1.1 regression —
but it is worth tracking as a follow-up: the engine should resume a task left in
`review_in_progress` on restart rather than conclude its intent.
