# Legacy Inventory and Temporary Ownership Map

- **Release:** K2 — Legacy Expansion Freeze (Saga Core Renewal)
- **Captured at:** K1.1 green baseline lineage (manifest SHA `9750531b`)
- **Enforcement:** `tests/architecture/legacy-expansion-freeze.test.mjs`
  consumes the machine-readable companion `docs/architecture/legacy-allowlist.json`
- **Rule:** from K2 on, the legacy surface may only SHRINK. The allowlist is
  count/file-decreasing; broadening it requires a new ADR. Every entry names
  the K-release that will physically delete it.

Counts are CODE references (comment-stripped scan via
`tools/legacy-freeze.mjs`). Raw greps see roughly three times more hits —
most legacy vocabulary survives only in comments that explain its
replacement; those are documentation, not callable surface, and leave with
their owning releases.

## Category A — legacy `escalate` recovery vocabulary (owner: K15): 7 files

The old flow-era recovery vocabulary (`escalate`) coexists with the
canonical cell-era vocabulary (`fail` / `pause` / `requeue`). K15 collapses
both into one typed DispatchOutcome/RecoveryAction model and deletes these
code references.

## Category B — recency selectors in authority persistence (owners: K7/K8): 7 files

`ORDER BY <time/id> DESC ... LIMIT 1` selection in persistence layers that
serve accepted-material, replay, adoption, and settlement reads. Chronology
is legal only in explicit observability projections; each file's cutover
(exact-ref lookup) lands in K7 (accepted reads) or K8 (replay capsule
selection), per the renewal plan. The exact per-file split lives in
`legacy-allowlist.json` and is enforced as SET EQUALITY (no growth, no
staleness) by `tests/architecture/authority-recency-classification.test.mjs`.

**K7 classification outcome (2026-08-17):**

- **Cut in K7 (removed from the baseline):**
  - `sqlite-process-module-installation-repository.ts` — `findLatestForModule`
    (newest install wins) deleted; zero live callers; identity resolves by
    `read(id)` / `findByPackageDigest` (ADR-077 package fingerprint).
  - `sqlite-production-cell-projection-persistence.ts` —
    `readProjectedRoleTask` hardened from `ORDER BY id DESC LIMIT 1` to
    fail-closed exact-key reads (`PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_
    UNIQUE` on duplicates of the EXACT key): the author key is the stable
    (workplace, `author`) task; the reviewer key is the exact CURRENT
    generation — (workplace, `reviewer`, `subject_candidate_set_ref` from the
    accepted-author authority head). Role alone is NOT unique for the
    reviewer: generations are minted per accepted author set, so superseded
    rows legally coexist (task-shadow F1). The reader feeds the
    accepted-authority head (ADR-053 C5-02) and the recovery budget.
- **Reclassified — legal run-history boundary traversal, exact-verified
  (chronology selects the failed RUN boundary, never a material subject):**
  - `sqlite-author-candidate-carry-forward.ts` — the boundary stage/node run
    is selected by `attempt DESC` (a repair-cycle ordinal, not wall-clock) and
    must then fail-closed against the exact recorded error/outcome; the
    source CandidateSet resolves via `factory_accepted_authority_head` with
    uniqueness enforced, and all downstream evidence (gate decisions,
    submission, lineage, git identity) matches by exact key.
  - `sqlite-development-verification-adoption.ts` — same boundary-traversal
    shape; `DEVELOPMENT_VERIFICATION_ADOPTION_BOUNDARY_INVALID` fail-closes
    the boundary and material flows through settlement exact product refs.
- **K8-owned (exact replay binder replaces newest-wins run-history
  selection):** `sqlite-lifecycle-continuation-repository.ts`,
  `sqlite-managed-node-submission-repository.ts`,
  `sqlite-node-run-repository.ts`, `sqlite-protocol-run-repository.ts`,
  `sqlite-recovery-case-repository.ts`.

**Epic-scoped material reads (owner K7; 2 files, classified):**
`brief-provisioning-ports.ts` and
`sqlite-formalization-package-adapters.ts` read the accepted **brief** from
the legacy `artifacts` table by `epic_id` + `type='brief'`. The brief is the
discovery-stage INPUT document — a per-epic singleton that exists BEFORE any
lifecycle run, so the lifecycle-scoped ownership chain (ADR-078) does not
apply to it and no lifecycle identity can scope its read. Classified as
lifecycle-independent INPUT provisioning: legal with rationale, frozen
against growth, and destined for the document-authority lane (Controlled
Change Plane) rather than the settlement authority.

## Category C — execution-scoped lookup functions: 0 code refs

`listArtifactsForExecution` / `listTracesForExecution` no longer appear in
code — only in comments. The freeze pins the count at zero: any
reappearance fails the suite. (The formalization settlement epic-scoped
READ cutover itself is K6/K7 scope, tracked by the ADR registry, not by
this symbol.)

## Category D — `latestCandidate` code references: 0

The ADR-053 Phase 7 cutover removed every code reference; the freeze pins
zero.

## Schema surface (owner: K17 deletes; snapshot from K2)

The clean schema snapshot digests 97 tables (table + sorted column names,
SHA-256; see `legacy-allowlist.json` → `schemaSnapshot`; re-baselined
96→97 when `factory_effect_attempts` was added post-K2 — commit `adbed860`,
snapshot updated in the same commit per the rule below). Any schema change
— addition, removal, or column edit — changes the digest and fails the
suite until the snapshot is updated in the SAME commit, deliberately. The
K17 legacy-object deletion list grows out of this snapshot as cutover
waves identify dead objects; nothing appears or disappears silently in
the meantime.

## Burn-down

`npm run legacy:report` prints current category counts against the
allowlist. K20 requires every category at zero and the schema snapshot
reduced by the K17 deletion set.
