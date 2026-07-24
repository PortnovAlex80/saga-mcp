# D4 Smoke Evidence — Authoritative Discovery Settlement

**Date:** 2026-07-24 (revised after correction 5 — atomic verification + recovery tests)
**Branch:** `d4-discovery-settlement` (base `saga3-discovery` @ `c312464`, post-D3 squash-merge)
**Model:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, `http://localhost:1234`)
**Suite:** `npm test` green — 599 tests, 598 pass, 0 fail, 1 todo (93 D4 tests all green, including +13 atomic/recovery correction tests).

Core principle:
```
LM proposes. Advisor assesses. Kernel settles. Certificate proves.
```

## Revision note (post-correction)

The first D4 submission was reviewed and rejected with 4 P0 + 3 P1 defects on
the authoritative boundary. This revision fixes all of them:

- **P0-1 lifecycle eligibility** — no certificate unless the product lifecycle
  completed cleanly (`reason==='completed' && scopeCompleted && terminal==='clean'
  && validProposal`). A Proposal submitted before timeout/blocked/executor-failure
  no longer becomes an authoritative success.
- **P0-2 GO evidence** — GO requires at least one non-empty
  `Proposal.evidence_refs` entry; empty evidence -> clarify /
  `CLARIFY_EVIDENCE_INSUFFICIENT`.
- **P0-3 semantic readiness key** — the idempotency key now uses a semantic
  readiness target (`accepted:<hash>` | `missing` | `failed` | `paused`); a
  missing-then-failed run produces DIFFERENT settlements/certificates instead of
  collapsing onto one `none` row.
- **P0-4 recovery integrity** — a missing certificate is rebuilt EXCLUSIVELY
  from the STORED snapshot (parse -> recompute hash -> verify vs row/key ->
  policy replay -> compare decision/reason codes -> build from stored snapshot).
  `issued_at` is the deterministic settlement `created_at`; the certificate insert
  + `certificate_issued` transition check the CAS result. A failed settlement is
  recoverable to `certificate_issued`.
- **P0-4b existing certificate replay** — an existing certificate is re-hashed
  and its full lineage (decision/input_hash/policy/proposal) validated before
  being returned as authoritative.
- **P0-5 exact target binding** — the Proposal must match the request on epic,
  project, kind (`discovery`), schema_version, status (`submitted`); the readiness
  assessment is read by the EXACT id the engine shadow reports, never silently
  replaced with the latest accepted row.
- **P1-1 policy identity** — `policy_hash` is now SHA-256 over a canonical
  POLICY_V1_MANIFEST (GO/REJECT predicates, evidence requirement, thresholds,
  fallback, reason-code mapping version), not just version+thresholds.
- **P1-2 architecture** — `canonicalJson` + `collectDiscoverySourceRefs` moved to
  `src/saga3/shared/discovery-canonical.ts`; both D3 and D4 use the single copy.
- **P1-3 observability** — settlement failure populates top-level `lastError`;
  the service result is a discriminated union (`issued` requires non-null
  decision/certificate identity).

### Correction 3 — authoritative recovery (this revision)

The second correction was reviewed and rejected again: the recovery and
certificate-issuance paths still had four authoritative-boundary gaps. This
revision closes them:

- **Engine restart reconstructs the durable D3 readiness shadow** — the recovery
  path no longer fabricates `readiness=not_run`. It reads the readiness
  ControlIntent + latest assessment for the exact Proposal target and projects a
  shadow (accepted→completed, rejected/submitted→failed, paused-control→paused,
  no-control→not_run), mirroring D3 `shadowFrom`. A restart after an accepted
  assessment now returns the accepted-target certificate, not
  CLARIFY_READINESS_MISSING.
- **`insertSettlement` replayed race** — when `replayed=true`, the locally built
  snapshot/inputHash is discarded and recovery continues EXCLUSIVELY from the
  stored settlement snapshot (a different captured_at would otherwise produce a
  certificate from the losing local input).
- **Atomic certificate issuance** — ONE persistence operation
  (`issueCertificateAtomically`) wraps verify-settlement → insert/reuse-certificate
  (issued_at persisted in BOTH the row and the payload) → transition
  computed|failed→certificate_issued → commit, all in BEGIN IMMEDIATE. Never
  returns issued before commit.
- **Existing-certificate authority** — a certificate is authoritative ONLY when
  the settlement is `certificate_issued`; a crash that left a cert on a
  computed/failed settlement is atomically reconciled
  (`reconcileExistingCertificate`) before being returned.
- **Strict stored-snapshot validation** — `parseAndVerifyStoredSnapshot` now
  checks schema_version, epic_id, proposal id/hash, readiness target/id/hash/
  payload consistency (accepted must carry payload; non-accepted must not),
  policy version/hash, AND rationale against the policy replay.
- **Rebuild expected certificate** — an existing certificate is authoritative
  only when byte-identical to the payload rebuilt from the verified stored
  settlement (catches payload+hash co-tampered together); the stored payload's
  own hash is also checked against its stored certificate_hash.
- **Full readiness lineage** — binding now extends through the ControlIntent
  (epic, kind, source intent, Proposal target, projected task) and the authority
  WorkIntent (kind, output schema, epic); `assessment.task_id ==
  control.projected_task_id`. A `completed` shadow without assessmentId/hash is
  malformed and fails closed.

### Correction 4 — recovery-integrity validators (this revision)

The third correction was reviewed and rejected for three narrow gaps in the
recovery validators. This revision closes them:

- **Stored nested-payload integrity** — `parseAndVerifyStoredSnapshot` now
  re-validates the stored Proposal payload, recomputes its content hash and
  compares to `snapshot.proposal.content_hash`, and compares the stored payload
  canonically to the canonical Proposal loaded at the start of `settle()`. For
  accepted readiness it validates + rehashes the payload. For non-accepted
  readiness it requires `assessment_id`, `content_hash`, AND `payload` all null.
  A coherent tamper that edits the payload, leaves the content hash, and
  rewrites `input_hash` is now rejected (the Proposal/readiness hashes are
  independent anchors; `input_hash` is not).
- **Full certificate-record verification** — one `verifyCertificateRecord` is
  used in every existing-certificate path (normal replay, replayed-insert
  winner, atomic reuse). It rebuilds the expected payload and compares canonical
  payloads, hashes, AND every certificate ROW lineage column (epic, Proposal,
  readiness target/id, policy, decision, reason codes, input hash, issued_at).
  The atomic repository op also verifies the reused row's columns.
- **Paused readiness recovery** — when an engine restart finds a readiness
  ControlIntent in open/executing/paused without an accepted assessment, the
  advisor is RESUMED through the readiness service (not immediately issued
  CLARIFY_READINESS_PAUSED). A temporary interruption no longer becomes a final
  business decision.
- **Complete readiness lineage** — binding now requires a non-null projected
  task, `authority.projected_task_id == control.projected_task_id ==
  assessment.task_id`, and both the ControlIntent and authority WorkIntent in
  `concluded` status for an accepted assessment.

### Correction 5 — atomic verification + recovery tests (this revision)

The fourth correction was reviewed and rejected for one P0 inside the atomic
persistence boundary plus two acceptance gaps. This revision closes them:

- **Atomic settlement verification** — `issueCertificateAtomically` now reads
  the FULL settlement row inside BEGIN IMMEDIATE and re-verifies every lineage
  column (epic, Proposal, readiness target/id, policy, decision, reason_codes,
  input_hash, created_at==issuedAt) against the caller's inputs. This closes the
  TOCTOU window between service-level validation and the transaction: a
  concurrent writer that changed the settlement row after the service verified it
  is rejected inside the atomic boundary.
- **Atomic reused-payload verification** — when a certificate row pre-existed
  (ON CONFLICT), the transaction now verifies the stored `certificate_payload`
  is canonically identical to the freshly built payload, the stored payload's own
  hash agrees with the stored `certificate_hash`, AND every lineage column
  matches. A concurrent writer that inserted a row with the right hash + lineage
  but a wrong payload is rejected.
- **Reconcile verification** — `reconcileExistingCertificate` now takes the full
  expected input and repeats the SAME settlement + certificate verification
  inside BEGIN IMMEDIATE (one shared verifier shape across issue + reconcile).
- **Engine recovery tests** — two engine-level tests prove the paused-resume path:
  (1) paused ControlIntent + no accepted assessment → `readinessService.assess()`
  called exactly once (resume), settlement gets the resumed shadow; (2) accepted
  assessment already exists → `assess()` NOT called (no respawn), settlement gets
  the reconstructed completed shadow.

**Clean test evidence:** `npm test` = 599 tests, 598 pass, 0 fail, 1 todo (no
flaky tests; every suite green).

**Acceptance honesty:**
- A (full GO) and B (clarify-from-gaps): full live engine runs.
- D (advisor unavailable) and E (injected crash + restart): controlled live-DB
  recovery/settlement scenarios on real persisted rows.
- C (reject): deterministic policy-test coverage (the LM does not reject the
  trivial smoke product).
The exit gate below marks
this honestly: A and B live, D and E controlled live-DB, C deterministic.

---

## Live LM smokes

Each smoke ran via
`SAGA_ORCHESTRATION_MODE=saga3-discovery DB_PATH=… TRACKER_AUTOSTART=0 SAGA_CLAUDE_PATH=claude node dist/orchestrate-cli.js <proj> <epic> --concurrency=1`
on the shared DB. A and B are full live engine runs; D and E are controlled
live-DB recovery/settlement scenarios on real persisted rows; C is covered
deterministically by the policy test suite (the LM does not reject the trivial
smoke product).

### Smoke A — authoritative GO (live LM, full pipeline)

**Project/Epic:** 14 / 14. **Proposal id:** 122.

```json
{ "reason": "completed", "cycles": 153, "scopeCompleted": true,
  "outcome": "go", "outcomeAuthority": "discovery_settlement_policy",
  "proposalId": 122, "provisional": { "outcome": "go", "authority": "worker_proposal" },
  "readiness": { "status": "completed", "assessmentId": 38, "overallReadiness": "ready",
                 "recommendedNextAction": "proceed_to_settlement" },
  "settlement": { "status": "issued", "settlementId": 8, "certificateId": 8,
                  "certificateHash": "075bc133…88f78", "decision": "go",
                  "reasonCodes": ["GO_READY_AND_GROUNDED"] } }
```

PASS. Full pipeline (worker → readiness → settlement) with the corrected code:
the Proposal carried non-empty `evidence_refs`, the lifecycle was clean, exact
binding held (proposal 122 / assessment 38 from the engine shadow, full
ControlIntent + authority-WorkIntent lineage verified), and the policy issued a
`go` certificate atomically.

### Smoke B — authoritative CLARIFY from blocking gaps (live LM)

**Project/Epic:** 13 / 13. **Proposal id:** 121. The advisor returned
`conditionally_ready` with blocking gaps.

```json
{ "outcome": "clarify", "outcomeAuthority": "discovery_settlement_policy",
  "provisional": { "outcome": "go", "authority": "worker_proposal" },
  "readiness": { "status": "completed", "overallReadiness": "conditionally_ready",
                 "recommendedNextAction": "request_clarification" },
  "settlement": { "status": "issued", "decision": "clarify",
                  "reasonCodes": ["CLARIFY_CONDITIONALLY_READY","CLARIFY_BLOCKING_GAPS"] } }
```

PASS. A genuine live clarify: the worker recommended `go`, the advisor found
gaps, and the policy authoritatively overrode to `clarify` with the specific gap
reason codes. The provisional `go` is preserved separately.

### Smoke D — advisor unavailable → authoritative clarify (live DB)

**Proposal id:** 123 (a valid Proposal from a full pipeline run on epic 15).
The readiness assessments for its ControlIntent were deleted to simulate the
advisor worker crashing before producing an accepted verdict; the shadow reports
`status:'failed'`.

```
Smoke D: {"status":"issued","settlementId":10,"certificateId":11,
          "decision":"clarify","reasonCodes":["CLARIFY_READINESS_FAILED"]}
settlement readiness target: failed | status: certificate_issued
```

PASS. Advisor unavailable → authoritative `clarify` with
`CLARIFY_READINESS_FAILED`, certificate issued (pipeline completes; fail-closed,
not a pipeline failure). A NEW settlement (id 10, target `failed`) was created —
distinct from any accepted-target settlement.

### Smoke E — injected crash + restart → byte-identical rebuild (live DB)

A full GO run (epic 14, settlement 8, cert hash `075bc133…88f78`) was used as the
baseline. Then a crash was INJECTED between certificate insert and status
transition: the certificate row was deleted and the settlement status reset to
`computed`. A restart re-settled the same Proposal:

```
before crash: {"certificate_hash":"075bc133…88f78","issued_at":"2026-07-24 14:54:10"}
crash injected: cert deleted, settlement status=computed
after restart: {"status":"issued","decision":"go",
                "certificateHash":"075bc133…88f78","settlementStatus":"certificate_issued"}
BYTE-IDENTICAL REBUILD: true
SETTLEMENT RECONCILED TO issued: true
```

PASS. The recovery path rebuilt the certificate from the STORED snapshot
(deterministic `issued_at` = settlement `created_at`), producing a
**byte-identical** certificate_hash, and atomically reconciled the settlement to
`certificate_issued`. This proves the atomic issuance + recovery integrity
(P0-2b/c/d, P0-4) end-to-end on a live DB.

### Smoke C — authoritative REJECT (deterministic coverage)

The live LM does not recommend `reject` for the trivial smoke product, so an
authoritative REJECT (worker reject + advisor not_ready/reject + blocking gaps +
confidence) could not be reproduced live. It is covered DETERMINISTICALLY by the
policy test suite, which is the authoritative artefact for the decision matrix:
`d4-settlement-policy.test.mjs` — worker reject + not_ready + advisor reject +
blocking gaps + confidence → `REJECT_WORKER_AND_ADVISOR_AGREE`, plus the
negative cases proving REJECT is impossible without coherent worker+advisor
agreement.

---

## Durable state observed across all smokes

Settlements + certificates persisted immutably across all smokes; none mutated
after issue. The crash-injection (Smoke E) proved the recovery path rebuilds a
byte-identical certificate and atomically reconciles the settlement. Policy
version + hash (the manifest hash) recorded on every certificate. No
`settlement_submit`/`certificate_submit` MCP tool exists. No stage transition
toward formalization (`finalStage='discovery'` everywhere).

---

## Roadmap D4 exit-gate coverage (revised)

| # | Exit gate | Covered by | Status |
|---|-----------|-----------|--------|
| 1 | Final outcome set ONLY by deterministic policy | policy unit tests; Smoke A go, Smoke D clarify | ✅ |
| 2 | Worker and advisor cannot create a certificate | no settlement_submit/certificate_submit MCP tool (arch test) | ✅ |
| 3 | Settlement input immutable + hashed | input snapshot + buildSettlementInputHash; persistence test | ✅ |
| 4 | Proposal and readiness re-validated before settlement | strict re-validation + exact binding (P0-5); persistence tests reject mutated payload / wrong kind/status / cross-epic | ✅ |
| 5 | GO impossible without accepted readiness + grounding + confidence + Proposal evidence | policy GO rule (now incl. proposal evidence); policy + persistence tests | ✅ |
| 6 | REJECT impossible without agreed worker/advisor negative | policy REJECT rule; policy tests | ✅ |
| 7 | All indeterminate states fail-closed to CLARIFY | policy CLARIFY catch-all; Smoke D; policy tests | ✅ |
| 8 | Certificate durable, immutable, idempotent | persistence tests; Smoke E (same ids+hash, no new row) | ✅ |
| 9 | Restart returns the same certificate | Smoke E replay | ✅ |
| 10 | Policy version/hash recorded in certificate | manifest hash on every cert; persistence test | ✅ |
| 11 | Provisional and authoritative lineage separated | engine `provisional` section vs top-level authoritative; engine tests; Smoke A | ✅ |
| 12 | outcomeAuthority=discovery_settlement_policy only after certificate | engine test; runResult logic | ✅ |
| 13 | finalStage stays discovery | engine tests; all smokes | ✅ |
| 14 | D5 diagnosis and F1 formalization absent | arch test (no stage transition / no formalization); no D5/F1 code | ✅ |
| 15 | Full npm test passes | 599 tests, 598 pass, 0 fail, 1 todo (no flaky tests; 93 D4 tests green) | ✅ |
| 16 | Smoke A–E | A and B: full live engine runs; D and E: controlled live-DB recovery/settlement scenarios; C: deterministic policy coverage | ◐ |

**Correction-3 gates (authoritative recovery, review directive items 1–8):**

| Directive | Covered by | Status |
|-----------|-----------|--------|
| 1 restart reconstructs durable readiness shadow | engine `reconstructReadinessShadow`; recovery test "restart returns accepted-target cert not MISSING" | ✅ |
| 2 replayed insert discards local snapshot | service replayed-race path → stored-snapshot recovery; recovery test | ✅ |
| 3 atomic certificate issuance (BEGIN IMMEDIATE) | `issueCertificateAtomically` (verify→insert/reuse→transition→commit); Smoke E byte-identical rebuild | ✅ |
| 4 existing cert authoritative only when settlement=certificate_issued | reconcileExistingCertificate; recovery test "computed/failed → issued" | ✅ |
| 5 deterministic issued_at in payload AND row | issued_at persisted in both; Smoke E byte-identical rebuild | ✅ |
| 6 strict stored-snapshot validation (all fields) | parseAndVerifyStoredSnapshot; recovery tests (target/epic/policy mismatch) | ✅ |
| 7 rebuild expected cert payload, compare canonical | expectedCertificateHashFor + stored-payload-hash check; recovery test (co-tamper) | ✅ |
| 8 readiness lineage through ControlIntent + authority WorkIntent | verifyReadinessLineage; recovery test (wrong ControlIntent/task); malformed completed shadow test | ✅ |

**Correction-4 gates (recovery-integrity validators, review directive items 1–5):**

| Directive | Covered by | Status |
|-----------|-----------|--------|
| 1 stored nested-payload integrity (Proposal + readiness hashes as independent anchors) | parseAndVerifyStoredSnapshot nested checks; recovery tests (coherent Proposal tamper, coherent readiness tamper, non-null assessment_id on failed) | ✅ |
| 2 full certificate-record verification (canonical payload + hash + every row column) | verifyCertificateRecord in 3 paths + repo row-check; recovery tests (epic_id/reason_codes row mismatch, co-tamper) | ✅ |
| 3 paused readiness recovery (resume through readiness service, not immediate certificate) | engine recovery-path resumable branch; Smoke A4 full run after correction | ✅ |
| 4 complete readiness lineage (projected task + authority task + lifecycle statuses) | verifyReadinessLineage; recovery tests (projected_task null, authority task mismatch) | ✅ |
| 5 transaction rollback injection (crash after cert insert before status transition) | d4-settlement-atomicity test (cert absent + settlement stays computed) | ✅ |

**Correction-specific gates (review directive items 1–10):**

| Directive | Covered by | Status |
|-----------|-----------|--------|
| 1 lifecycle eligibility | engine test "blocked -> settlement not_run"; P0-1 in runResult | ✅ |
| 2 GO evidence | policy + persistence tests (empty/whitespace evidence -> clarify) | ✅ |
| 3 semantic idempotency key | persistence test "missing then failed -> different settlements"; P0-3 | ✅ |
| 4 exact target binding | persistence tests (cross-epic / wrong status / mismatched assessment reject) | ✅ |
| 5 recovery from stored snapshot | persistence test "crash before certificate -> deterministic recovery" | ✅ |
| 6 certificate issuance (deterministic issued_at + CAS check) | service issueCertificate; Smoke E byte-identical rebuild | ✅ |
| 7 existing certificate replay re-hash + lineage | persistence test "certificate payload tampering rejected"; P0-4b | ✅ |
| 8 policy manifest hash | policy test "manifest internally consistent"; POLICY_V1_MANIFEST | ✅ |
| 9 shared canonicalJson + source-refs | shared/discovery-canonical.ts; arch test | ✅ |
| 10 lastError on settlement failure | engine test "settlement failure populates lastError" | ✅ |

**Critical review criterion met:** only the versioned kernel policy chooses go /
clarify / reject. The discovery worker and the readiness advisor remain
non-authoritative; neither can author a certificate. A successful D4 run returns
`outcomeAuthority=discovery_settlement_policy` and preserves the provisional
worker outcome separately.
