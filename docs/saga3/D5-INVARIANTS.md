# D5 — Advisory Discovery Diagnosis: Invariants

> **Roadmap D5, §1.** These invariants are the immutable contract every line of
> D5 code is checked against. The adversarial reviewer (Stage 5) and the evidence
> auditor (Stage 7) read THIS file plus the public interfaces plus the DB schema —
> never the implementer's narrative about "what was already fixed".
>
> **Hard rule:** the implementer may NOT rewrite an invariant below to make an
> existing implementation "correct". A defect is fixed by fixing the code, never
> by editing this file. If an invariant itself is wrong, that is a scope change
> requiring an explicit decision (§22).

---

## I1 — D4 remains the ONLY authority

D5 is **forbidden** from changing any of these top-level fields of
`OrchestrationRunResult`:

- `outcome`
- `outcomeAuthority`
- `settlement`
- `settlement.*` (settlementId, certificateId, certificateHash, decision, reasonCodes, status, error)
- `scopeCompleted`
- `reason`
- `finalStage`

After a **successful** D5 run, the only change to those fields is: nothing.

| field              | before D5                         | after successful D5               |
|--------------------|-----------------------------------|-----------------------------------|
| `outcome`          | the D4 decision                   | unchanged                         |
| `outcomeAuthority` | `discovery_settlement_policy`     | unchanged                         |
| `finalStage`       | `discovery`                       | unchanged (`discovery`)           |
| `reason`           | `completed`                       | unchanged                         |
| `scopeCompleted`   | `true`                            | unchanged                         |
| `settlement.status`| `issued`                          | unchanged                         |

The ONLY new top-level surface D5 adds is the advisory `diagnosis` section.
That section carries `authority: 'advisory_diagnosis'` — never `kernel_policy`,
never `discovery_settlement_policy`.

---

## I2 — Diagnosis authority is advisory only

Permitted value of `diagnosis.authority`:

- `'advisory_diagnosis'` — a diagnosis report was accepted by the kernel.
- `'none'` — no diagnosis ran / failed / not_run.

**Forbidden** values (the diagnosis must never claim kernel authority):

- `'kernel_policy'`
- `'discovery_settlement_policy'`

The certificate's `authority` stays `'kernel_policy'` (set by D4). D5 never
copies or borrows that authority.

---

## I3 — The certificate is the immutable diagnosis target

Every diagnosis report row and every diagnosis result MUST be bound to an EXACT
certificate target. The target is a tuple of fields lifted verbatim from the
`DiscoveryOutcomeCertificate`:

- `certificate_id` (exact integer match)
- `certificate_hash` (exact 64-char hex match)
- `settlement_id`
- `settlement_input_hash`
- `policy_version`
- `policy_hash`
- `decision`

A diagnosis MUST NOT be made against "the epic's latest result" or "the latest
certificate". If the certificate for an epic changed (new settlement → new
certificate), that is a NEW diagnosis target with a NEW ControlIntent and a NEW
report. The old report is immutable and stays.

---

## I4 — No invented evidence

Every diagnostic object that makes a claim (a cause, an information request, a
recommended action, a residual risk) MUST cite source refs, and every cited
source ref MUST be in the `allowed_source_refs` set the kernel built for THAT
diagnosis case.

Allowed source-ref families (mirroring D3/D4 `collectDiscoverySourceRefs` plus
diagnosis-specific anchors):

- `certificate:<id>` — the immutable certificate being diagnosed.
- `settlement:<id>` — the settlement that issued the certificate.
- `$.<field>` / `$.evidence_refs[<i>]` / literal — the canonical Proposal.
- `proposal:<id>` — the Proposal lineage id.
- `assessment:<id>` / `$.<field>` — the accepted readiness assessment (when present).
- `raw:<id>` / `normalization:<id>` — raw/normalization lineage.
- `policy_condition:<condition_id>` — a predicate the kernel decomposed from the
  settlement decision (the `failed_condition_id` reference).
- `reason_code:<CODE>` — a settlement reason code carried by the certificate.

Empty source-ref arrays are REJECTED for any cause, action, request, or risk. A
claim with no grounding is treated as invented evidence.

---

## I5 — Diagnosis failure is isolated (advisory-only)

D5 is an advisory layer. If any of the following occurs, the D4 result stays
COMPLETE and UNCHANGED:

| failure                         | D4 result             | diagnosis.status | diagnosis.authority |
|---------------------------------|-----------------------|------------------|---------------------|
| worker timeout                  | unchanged             | `failed`         | `none`              |
| worker process crash            | unchanged             | `failed`         | `none`              |
| payload rejected (invalid)      | unchanged             | `failed`         | `none`              |
| source refs invalid             | unchanged             | `failed`         | `none`              |
| recovery/resume failed          | unchanged             | `failed`         | `none`              |
| persistence error               | unchanged             | `failed`         | `none`              |
| no D4 certificate               | unchanged             | `not_run`        | `none`              |
| restart with accepted report    | unchanged             | `completed`      | `advisory_diagnosis`|

The ONLY fields D5 failure may mutate are inside the `diagnosis` section:

- `diagnosis.status` → `failed`
- `diagnosis.error` → the failure reason
- `diagnosis.authority` → `none`

It MUST NOT set top-level `reason='failed'`, `scopeCompleted=false`, or
`outcomeAuthority='none'` when a D4 certificate was already issued. This is the
decisive difference from D4: D4 failure IS the authoritative boundary (run
fails); D5 failure is advisory (run still completed authoritatively).

---

## I6 — No automatic repair

D5 recommended actions may PROPOSE, never DO. Permitted action verbs:

- `collect_information`
- `resolve_conflict`
- `revise_scope`
- `repeat_discovery`
- `request_human_decision`
- `proceed_with_monitoring`

D5 MUST NOT:

- change a Proposal (no UPDATE on `saga3_proposals`);
- create a new Proposal (no INSERT into `saga3_proposals`);
- change a readiness assessment (no UPDATE/INSERT on
  `saga3_readiness_assessments`);
- launch a new discovery episode (no new discovery WorkIntent / ControlIntent /
  projected task for the product work);
- change a settlement or certificate (no UPDATE on
  `saga3_discovery_settlements` / `saga3_discovery_outcome_certificates`);
- advance the stage (no `episode_transition`, no `finalStage` mutation);
- create tasks from its recommendations (no `task_create` available to the
  diagnosis worker);
- auto-transition to formalization.

D5's only writes are the two diagnosis tables
(`saga3_discovery_diagnosis_control_intents`,
`saga3_discovery_diagnosis_reports`) plus its own WorkIntent/task lifecycle.

---

## I7 — Restart is idempotent

One certificate target + one diagnosis policy version ⇒ one accepted diagnosis
report.

- Restarting the same epic after an accepted report returns the SAME
  `reportId` and `reportHash`.
- A new execution does NOT create a new accepted report for the same target.
- Resubmitting the byte-identical report payload (same content hash) under a new
  execution returns the existing accepted row (idempotent insert; execution_id
  is NOT part of the uniqueness key).
- A CORRECTED report payload (different content hash) creates a NEW report row
  (only accepted-by-kernel reports are "the answer"; the rejected ones stay
  durable for audit).
- A NEW certificate hash is a NEW target ⇒ NEW ControlIntent ⇒ NEW report. The
  old report is not touched.

---

## I8 — The implementer does not close the gate

The agent implementing D5 is **forbidden** from writing, in any file, commit
message, or chat:

- "D5 complete"
- "all gates passed"
- "ready to merge"
- "D5 готов"
- any verdict that the exit gate (§24) is satisfied.

The implementer may ONLY write:

> "implementation finished; ready for independent review".

The final verdict is given by an independent reviewer (Stage 5 adversarial
review + Stage 7 evidence audit + the human reviewer who authorizes the
squash-merge). This matches the D4 close-out pattern: the implementer finished,
six review rounds closed defects, and only the human's final verdict accepted
the code.

---

## What these invariants forbid — quick index for the adversarial reviewer

| #  | invariant | what to attack |
|----|-----------|----------------|
| I1 | D4 sole authority | does D5 mutate `outcome`/`outcomeAuthority`/`finalStage`/`scopeCompleted`/`reason`? |
| I2 | advisory only | does `diagnosis.authority` ever equal `kernel_policy` or `discovery_settlement_policy`? |
| I3 | exact cert target | can a diagnosis target "latest result" instead of an exact certificate? can two certificates share one report? |
| I4 | no invented evidence | is there any cause/action/risk with an empty or non-allowlisted source ref? |
| I5 | failure isolated | does a D5 failure flip `reason='failed'` or `scopeCompleted=false`? |
| I6 | no auto repair | does D5 write to proposals/readiness/settlement/certificate/episode? does the diagnosis worker have write tools? |
| I7 | restart idempotent | does restart return a different reportId/reportHash for the same target? does a second execution duplicate the report? |
| I8 | implementer doesn't close | did the implementer write a verdict anywhere? |
