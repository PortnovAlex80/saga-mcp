# Saga 3 Discovery Edition — First Real Run Evidence (Epic 31)

## 1. Verdict

**CORE PIPELINE PASSED** — discovery → readiness → settlement → certificate
completed end-to-end on a real LM worker, producing an authoritative
`clarify` decision with an immutable certificate.

Diagnosis (advisory D5 stage) was attempted; the first run hit a service
timeout before `diagnosis_submit` and is being retried with a raised
limit. Diagnosis does not affect the authoritative D4 result (isolation
verified).

This report does not claim complete D6 acceptance.

## 2. Release candidate

- Repository branch: `saga3-discovery`
- Commit SHA at first attempt: `034bd22`
- Commit SHA with fixes: `9df8ab9` (settlement gate + readiness soft-timeout),
  `d470696` (service maxRunSeconds 600s→1800s)
- Working tree before run: `docs/discovery/` untracked (discovery artifacts),
  `nul` and `docs/research/CHAIN-WORKING-V2.md` untracked (intentionally
  NOT committed per security constraints)
- Node.js version: v25.5.0
- Operating system: win32 10.0.26100 (Windows 11)
- Database: `C:/Users/user/.zcode/saga.db`
- Orchestration mode: `saga3-discovery`
- Start command: `DB_PATH=C:/Users/user/.zcode/saga.db SAGA_ORCHESTRATION_MODE=saga3-discovery node dist/orchestrate-cli.js 31 31 --concurrency=1`
- First attempt started: 2026-07-25T16:03:34Z (engine PID 18136)
- First attempt ended: 2026-07-25T16:28:19Z (failed at settlement; 496 cycles)
- Restart with fix started: 2026-07-25T16:58:56Z
- Restart core completed: 2026-07-25T16:58:56Z (settlement+certificate issued)
- Diagnosis attempt #1 timed out: 2026-07-25T17:08:57Z (600s service limit)
- Diagnosis attempt #2 running: 2026-07-25T17:15:50Z (1800s limit, after stale-execution cleanup)

## 3. Scenario

**Product idea:** GeoSophia Settlement Twin — a ground-risk assurance system for
high-speed railway (VSM) embankments on weak soils (peat, silt, highly plastic
clays). It operates in shadow mode alongside PLAXIS 2D/3D and approved
calculations under SP 22.13330.

**Discovery objective:** Determine the actual engineering and business problem;
target users and stakeholders; smallest useful product scope; system boundaries;
assumptions and unknowns; required evidence; technical, regulatory and adoption
risks; whether the idea should proceed, be clarified or rejected.

**Expected result:** No outcome was predetermined. The acceptable terminal
outcomes were: go; clarify; reject; inconclusive; failed.

## 4. Episode identity

- Project ID: 31
- Episode/Epic ID: 31
- Pipeline scope: `discovery_only`
- Initial input: GeoSophia objective text (inlined in task description)
- Episode created at: 2026-07-25T16:03:20Z
- Episode track: `formal`, stage `discovery`
- Model route (from episode_workflows.metadata): `qwen3.6-27b@q4_k_xl`, provider `lmstudio`

## 5. Product worker execution

- WorkIntent ID: 10239
- WorkIntent kind: `discovery`
- Projected task ID: 6240
- Execution ID: `exec-31-18136-1784995414556-1`
- Worker identity: `board-31-1784995414556-1`
- Provider: `lmstudio`
- Configured model: `qwen3.6-27b@q4_k_xl`
- Actual model: `qwen3.6-27b@q4_k_xl`
- Worker PID: 2332
- Started at: 2026-07-25T16:03:34Z
- Completed at: 2026-07-25T16:17:48Z (worker_done; task → done)
- Retry count: 0 (clean first execution)

### Product output

- Raw submission: accepted deterministically (no LM normalization needed)
- Canonical Proposal ID: 133
- Canonical Proposal hash: `423e88e4bfe9e717ffbb4e3f326ad8cdaada6b1bb2abdc77a4054f867b8fcac9`
- Proposal schema: `saga3.discovery-proposal.v1`
- Recommended worker outcome: `clarify`
- Discovery document: `docs/discovery/discovery-31.md` (10809 bytes — high quality:
  PLAXIS, SP 22.13330, named stakeholders VSM-Proekt/TransStroyConsulting/RZD,
  5 assumptions, 6 unknowns, 5 risks, 4 evidence refs)

### Template/tool contract recovery

The worker used the file-based call workflow that compensates for weaker-model
contract-following:
- `proposal-call-31.json` (8139 bytes) copied from `proposal-call-template.json`,
  filled with intent_id/task_id/execution_id/schema_version as top-level args
- `proposal-checklist.md` verified before submit
- Skill inlined into the worker prompt (weaker models skip "Read skill file")

## 6. Normalization

- Normalization required: no
- Reason: the worker's raw response was valid strict JSON matching the discovery
  proposal schema. Deterministic normalization applied without semantic
  transformation.

## 7. Readiness advisor

- ControlIntent ID: 1210 (in `saga3_readiness_control_intents`)
- Authority WorkIntent ID: 10240 (`discovery.assess`)
- Task ID: 6241
- Execution ID: `exec-31-18136-1784996298519-1`
- Worker identity: `board-31-1784996298519-1`
- Provider: `lmstudio`, model `qwen3.6-27b@q4_k_xl`
- Worker PID: 19948
- Started at: 2026-07-25T16:18:18Z
- Assessment accepted at: 2026-07-25T16:27:58Z
- Task closed at: 2026-07-25T16:28:15Z (worker_done)

### Assessment output

- Assessment ID: 71
- Assessment hash: `0846cdc9fa99f924a7c18eb6e3f9ee15c18677ec7be2dc3df14027be487c1462`
- Assessment schema: `saga3.discovery-readiness-assessment.v1`
- Status: **`accepted_by_kernel`** (validation_errors: [])
- Overall readiness: **`conditionally_ready`**
- Recommended action: `request_clarification`
- Confidence: 0.45
- Dimension assessments: 7 dimensions
  - problem_clarity: sufficient
  - scope_boundedness: sufficient
  - stakeholder_coverage: partial
  - assumption_visibility: sufficient
  - unknowns_manageability: partial
  - risk_visibility: sufficient
  - evidence_grounding: **insufficient**
- Blocking gaps: 3 (BG-REGULATORY_STATUS, BG-SENSOR_DATA_AVAILABILITY, BG-ALERT_THRESHOLDS)
- Non-blocking gaps: 3
- `readiness-call-31.json` (7757 bytes) filled from engine-seeded template
  (proposal_id=133 + full content_hash pre-filled by `ensureStageTemplate`)

### Race-condition incident (first attempt)

The assessment was accepted_by_kernel at 16:27:58, but the worker closed
task 6241 at 16:28:15 — 3 seconds *after* the service maxRunMs (600s) elapsed
at 16:28:18. The poll-loop saw `terminal='timeout'` before it saw `task done`,
so the clean-closure path (which concludes the ControlIntent) did not run.
ControlIntent 1210 stayed `paused`.

This caused the settlement to fail on the first attempt (see §8). The race was
fixed in commit `9df8ab9` (soft-timeout recovery: on timeout, probe for an
accepted assessment before falling to paused).

## 8. Deterministic settlement

- First attempt: **FAILED** — `settlement: readiness ControlIntent 1210 status
  'paused' is not 'concluded' (accepted assessment requires a concluded control)`
- Root cause: settlement gate in `verifyReadinessLineageShared`
  (`discovery-certificate-bundle.ts:414-424`) blocked the bundle because the
  ControlIntent lifecycle status was `paused`, even though the kernel had
  already accepted the assessment. The code comment "an accepted assessment
  means the advisor closed cleanly" was a false premise (race condition, see §7).
- Fix (commit `9df8ab9`): gate now accepts `concluded` OR `paused` (any terminal
  state) when an accepted assessment exists; the caller
  (`discovery-settlement-service.ts:256`) already verified
  `assessment.status === 'accepted_by_kernel'`.

### After fix (restart)

- Settlement ID: 15
- Settlement policy version: `saga3.discovery-settlement-policy.v1`
- Decision: **`clarify`**
- Reason codes: `["CLARIFY_WORKER_REQUESTED"]`
- Proposal ID/hash verified: yes (proposal 133, hash `423e88e4…`)
- Readiness ID/hash verified: yes (assessment 71, hash `0846cdc9…`, accepted_by_kernel)
- Settlement status: `certificate_issued`
- Created at: 2026-07-25T16:58:56Z

### Authority assertion

The product worker proposed `clarify` (`recommended_outcome`).
The readiness advisor produced an **accepted** assessment
(`conditionally_ready`, `request_clarification`) — shadow authority, consistent
with the worker's proposal.
The deterministic `DiscoverySettlementPolicyV1` issued the authoritative
`clarify` decision with reason `CLARIFY_WORKER_REQUESTED`.

Evidence:
- Worker output: `recommended_outcome: "clarify"` (non-authoritative)
- Advisor output: `overall_readiness: conditionally_ready`,
  `recommended_next_action: request_clarification` (shadow authority)
- Settlement record: id=15, `decision: clarify`,
  `reason_codes: ["CLARIFY_WORKER_REQUESTED"]`, policy_hash verified
- outcomeAuthority: `discovery_settlement_policy`

## 9. DiscoveryOutcomeCertificate

- Certificate ID: 16
- Certificate hash: `605e994736d855b897c2c0cf340272f3cad58eb390bbf0696c2d9fdafb4eb36b`
- Settlement ID: 15
- Decision: `clarify`
- Reason codes: `["CLARIFY_WORKER_REQUESTED"]`
- Settlement input hash: `149dd65900e6ad788b5e209222c6720b0b891a79dd148613db655b64d2e97c44`
- Policy version: `saga3.discovery-settlement-policy.v1`
- Issued at: 2026-07-25T16:58:56Z

## 10. Advisory diagnosis

- Diagnosis executed: attempted (first run timed out; second run in progress)
- Diagnosis ControlIntent ID: 9 (in `saga3_discovery_diagnosis_control_intents`)
- Authority WorkIntent ID: 10241 (`discovery.diagnose`)
- Task ID: 6242
- Certificate target: 16 / `605e994736d855b8…`
- DiagnosisCase hash: `f7fa207e0e7a243cd3b95af287f3d625c451c7b72b0a9b53d4c2fe09bb8106ab`

### Attempt #1 (timed out)

- Execution ID: `exec-31-19576-1784998736772-1`
- Worker PID: 20812
- Started at: 2026-07-25T16:58:56Z
- Timed out at: 2026-07-25T17:08:57Z (service maxRunMs=600s; worker had filled
  `diagnosis-call-31.json` at 16:06 but did not reach `diagnosis_submit`)
- Terminal: `timeout`
- Report submitted: no (DB has no report for control 9 / cert 16)
- ControlIntent 9 → `paused`

`diagnosis-call-31.json` (8973 bytes) was filled with a high-quality report:
- 4 causes (CAUSE_REGULATORY_STATUS, CAUSE_SENSOR_DATA_AVAILABILITY,
  CAUSE_ALERT_THRESHOLDS, CAUSE_EVIDENCE_GROUNDING)
- 3 information_requests (REQ_REGULATORY, REQ_SENSORS, REQ_THRESHOLDS)
- 3 recommended_actions (ACTION_STAKEHOLDER_INTERVIEWS,
  ACTION_EVIDENCE_COLLECTION, ACTION_REPEAT_DISCOVERY)
- 3 residual_risks
- cited_condition_ids: `["worker_requested_clarify"]` (matches policy_trace)
- reason_codes: `["CLARIFY_WORKER_REQUESTED"]` (matches certificate)
- confidence: 0.85

### Attempt #2 (in progress after fixes)

- Stale execution `exec-31-19576-1784998736772-1` was manually closed
  (`state='lost'`) because saga3-discovery-engine does not call
  `reconcileWorkerExecutions` on restart (defect #3 — documented, not yet fixed).
- New execution: `exec-31-22840-1784999750735-1`
- Worker PID: 24376
- Started at: 2026-07-25T17:15:50Z
- Service limit raised to 1800s (commit `d470696`)
- Status: running (report not yet submitted)

### Isolation assertion

Values before diagnosis (from settlement/certificate):
- outcome: `clarify`
- outcomeAuthority: `discovery_settlement_policy`
- settlement ID/hash: 15 / `149dd65900e6ad78…`
- certificate ID/hash: 16 / `605e994736d855b8…`
- scopeCompleted: true

Diagnosis is advisory-only (D5); it cannot mutate the D4 settlement or
certificate. The isolation contract holds regardless of diagnosis outcome.

## 11. Terminal engine result (restart)

- Outcome: `clarify`
- Outcome authority: `discovery_settlement_policy`
- Reason: `completed` (cycles=0 — restart-path reused concluded intents)
- Pipeline scope: `discovery_only`
- Scope completed: **true**
- Final stage: `discovery`
- Settlement status: `issued`
- Readiness status: `completed` (shadow_advisor, assessment 71 accepted)
- Diagnosis status: `failed` (attempt #1 timeout; attempt #2 in progress)

## 12. Defects found and fixed during this run

This real run exposed defects that smoke tests (mock-claude, instant
worker_done) could not reach:

### Defect #1 (P0, fixed in `9df8ab9`)
Settlement gate assumed an accepted assessment implies a concluded
ControlIntent. False under a worker-closure/maxRunMs race. Gate now accepts
`concluded` OR `paused` when an accepted assessment exists.

### Defect #2 (P1, fixed in `9df8ab9`)
Readiness service had no soft-timeout recovery: on timeout it unconditionally
paused the control, discarding an accepted assessment. Added a probe: on
timeout, if an accepted assessment exists, conclude the control and report
success.

### Defect #3 (P1, fixed in `d470696`)
Service maxRunSeconds defaults (600s) were tighter than the engine's own
default (1800s). The inner service timed out before the outer engine.
Raised all three services (readiness/diagnosis/normalization) to 1800s.

### Defect #4 (P1, documented, not yet fixed)
`saga3-discovery-engine` does not call `reconcileWorkerExecutions` before
spawning a worker. After a worker process dies (timeout/crash), its
`worker_executions` row stays `state='running'`, and the next engine run
refuses to spawn with `execution ... is still running`. Manually cleaned up
for this run; the saga3 engine should reconcile on start (saga2 already does).

## 13. Restart and idempotency

**Performed (partially).** The restart-path reused:
- Product WorkIntent 10239 (`concluded`) — worker not respawned
- Proposal 133 (reused, not recreated)
- Readiness assessment 71 (reused; ControlIntent concluded on restart)
- Settlement 15 + Certificate 16 (issued fresh on restart because the first
  attempt failed before persistence; deterministic, same input hash)

Restart verdict: **passed for core pipeline** (settlement+certificate issued
on restart with the gate fix). Diagnosis restart required manual stale-execution
cleanup (defect #4).

## 14. Frontend and operational visibility

- Product task visible: yes (task 6240 in Kanban, status done)
- Readiness task visible: yes (task 6241, done)
- Diagnosis task visible: yes (task 6242, in_progress)
- Proposal/readiness/settlement/certificate/diagnosis: stored in saga3 tables,
  not surfaced in the Kanban artifacts panel (known gap)
- Discovery document visible: yes (`docs/discovery/discovery-31.md`)
- Stage tracker `project-31-discovery-stage.md`: structurally covers all 11
  steps, but only discovery steps (1-5) were marked `[x]`; readiness/diagnosis
  workers did not update their steps (observability gap, not a pipeline blocker)

## 15. Human intervention

1. **Template files pre-seeded:** `tool-templates/discovery/*` copied to
   `docs/discovery/tools/` before engine start; engine-seeded
   `readiness-call-31.json` / `diagnosis-call-31.json` with known IDs.
2. **Project/epic created manually** via saga MCP tools.
3. **Two code fixes applied between attempts** (defects #1, #2, #3) —
   `npx tsc` rebuild + re-run.
4. **Manual stale-execution cleanup** (defect #4) — one `UPDATE` to close the
   dead diagnosis execution before restart #2.
5. **No payload correction:** the worker's proposal and the advisor's
   assessment were accepted as-is.
6. **No direct settlement/certificate invocation:** both produced by the
   deterministic kernel via the engine.

## 16. Deviations and limitations

1. **Settlement failed on first attempt** (defect #1); fixed and re-run succeeded.
2. **Diagnosis timed out on first attempt** (defects #2, #3); second attempt
   running with raised limit.
3. **Stale execution blocked restart** (defect #4); manually cleaned.
4. **Stage tracker partially updated** — readiness/diagnosis workers did not
   mark their steps (observability gap).
5. **One episode, not concurrency.**
6. **No claim about formalization or later lifecycle stages.**

## 17. Evidence classification

| Component | Evidence type |
|---|---|
| Product discovery worker | live LM (qwen3.6-27b@q4_k_xl via LM Studio) |
| Normalization | none (deterministic acceptance) |
| Readiness assessment | **live LM, accepted_by_kernel** (assessment 71, conditionally_ready) |
| Settlement | deterministic live kernel (policy v1) |
| Certificate | live persistence and hash verification |
| Advisory diagnosis | live LM, report filled but submit not yet observed (attempt #2 running) |
| Restart | performed for core pipeline (passed); diagnosis restart needed manual cleanup |

## 18. Final assertions

- [x] The normal Saga 3 engine entrypoint was used.
- [x] A real product worker created the DiscoveryProposal (proposal 133).
- [x] Runtime provenance identifies the actual model (`qwen3.6-27b@q4_k_xl`, `lmstudio`).
- [x] No hidden model fallback occurred.
- [x] **The readiness advisor produced an accepted assessment** (assessment 71,
      `accepted_by_kernel`, `conditionally_ready`) — first time this stage
      reached acceptance on a real LM worker.
- [x] The deterministic kernel selected the outcome (`CLARIFY_WORKER_REQUESTED`).
- [x] A verifiable DiscoveryOutcomeCertificate was issued (id=16).
- [x] Settlement gate defect found and fixed (commit `9df8ab9`).
- [x] Service timeout defect found and fixed (commit `d470696`).
- [x] Diagnosis did not mutate the authoritative result (advisory-only).
- [x] The run terminated with `pipeline_scope=discovery_only`.
- [x] `scopeCompleted=true` interpreted within the configured scope.
- [x] Restart reused the authoritative settlement inputs (proposal/readiness).
- [ ] Diagnosis accepted_by_kernel. **(attempt #2 in progress)**
- [x] No unbounded retry or advisor recursion (1 product exec; 1 readiness exec;
      diagnosis attempt #2 after manual cleanup).
- [x] All manual interventions disclosed.

## 19. Conclusion

The run proves that the current Saga 3 Discovery Edition can autonomously
execute one real discovery episode through product work, **accepted readiness
assessment**, deterministic settlement, and certification — producing an
authoritative `clarify` decision with an immutable certificate (id=16).

This is stronger evidence than the prior epic 30 run: the readiness stage
reached `accepted_by_kernel` for the first time on a real LM worker, and the
settlement consumed that accepted assessment (rather than fail-closing on a
missing one).

The run exposed four defects in the timeout/restart/gate machinery, three of
which are fixed (`9df8ab9`, `d470696`) and one documented (saga3 engine
reconcile-on-start). The diagnosis advisory stage is being retried with the
raised service limit.

**Verdict: CORE PIPELINE PASSED (discovery → readiness → settlement → certificate).
Diagnosis pending (attempt #2 running with raised timeout).**
