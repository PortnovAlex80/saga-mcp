# ADR-053 Closure Matrix — 2026-08-25 audit

**Audited tree:** `integration/canonical-2026-08-24` @ `57468bb6` (ten-EC audit
and cross-boundary authority scan), with the scripted-E2E residual re-audited
on the merged canonical head `a4565be0` (Phase-6 commit `9ff82434` merged).
**Method:** every verdict is backed by a named executable positive proof that
was actually run green on the audited tree; no verdict is inferred from
aggregate test counts. This is the Phase 3 deliverable of
`docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`.

## Summary matrix

| EC | Criterion | Verdict | Principal proof (ran green) | Blocking host |
|----|-----------|---------|------------------------------|---------------|
| EC-1 | `PostAcceptanceEffectInput` has no execution-owner authority | **MET** | `tests/architecture/effect-input-exact-refs.test.mjs` (4/4) | architecture group + full suite |
| EC-2 | No post-seal consumer selects by execution/task/node/chronology/`latest` | **MET** (classified frontier remains, ratchet-guarded) | `adr-053-material-authority-ratchet` + `effects-no-material-reselection` + `authority-recency-classification` + `lifecycle-scoped-accepted-material` + `authority-only-effects-theorem` | architecture + process-modules + full suite |
| EC-3 | Every CandidateSet binds an immutable Workplace production revision | **MET** | `material-identity-execution-free` + `adr-053-g-points` G-2 + `partition-invariance-theorem` | architecture group + full suite |
| EC-4 | Execution identity is provenance-only (`presenterRef`) or absent | **MET** | `material-identity-execution-free.test.mjs` (9/9) | architecture group + full suite |
| EC-5 | Typed/managed/Git production normalize to one core material contract | **MET** | `adr-053-cutover-gates` Gate 5 + `tests/process-modules/production-source-adapters.test.mjs` | architecture + process-modules + full suite |
| EC-6 | Document/container format and atomic members bound once in a versioned manifest | **MET** (semantically; ADR literal field names not used — see note N3) | `tests/architecture/srs-contract-validation.test.mjs` (17 tests incl. fail-closed negatives) | architecture group + full suite |
| EC-7 | Workshop capabilities from one installed manifest | **MET** (see note N1) | `workshop-manifest-parity.test.mjs` (7/7) | architecture group + full suite |
| EC-8 | Every cross-machine handoff has durable obligation or atomic outbox | **MET** | `adr-053-cutover-gates` Gate 8 + `progress-obligation-invariant` + `resume-compatibility` K5 theorem | architecture group + full suite |
| EC-9 | Run-011 represented by a general partition-invariance theorem | **MET** | `tests/architecture/partition-invariance-theorem.test.mjs` (5/5) | architecture group + full suite |
| EC-10 | Clean scripted E2E + clean real canary from fresh DB/repo | **OPEN** (see residuals) | scripted leg: green at `a4565be0` after the Phase-6 production repair (10/10 w9-02/03 + golden-path); real canary: no accepted evidence (deferred, ADR-096 Phase 7) | full suite hosts the scripted leg |

## Per-EC owners and mutation proofs (condensed)

- **EC-1** — owner `src/process-modules/application/post-acceptance-effects.ts:26-54`
  (`PostAcceptanceEffectInput` = exactly `{ authority: AcceptedCandidateAuthority }`;
  `grep producerExecutionRef src` → 0). Encoded mutation: adding any member to
  either interface fails Theorem A/B exact-member-set ratchets.
- **EC-2** — owners: `sqlite-formalization-kernel.ts:129`
  (`readAcceptedArtifactsForLifecycle`; epic-scoped `readAcceptedArtifacts`
  deleted), `sqlite-production-cell-projection-persistence.ts:184`
  (`readProjectedRoleTask` fail-closed exact-key; exact-key duplicates throw),
  `replay-capsule-selection.ts` (semantic key; divergent payloads → typed
  `conflict`, never newest-wins). Encoded mutations: `latestCandidate` /
  `ORDER BY sealed_at DESC` reintroduction → ratchet red; task/node/execution
  SQL predicate in an effect file → K11 ban red; unclassified newest-wins
  selector → `authority-recency-classification` red (frozen 12-file
  classified allowlist in `legacy-allowlist.json`, growth and staleness both
  fail).
- **EC-3** — owner `candidate-set.ts:111-202` (`productionRevisionRef`
  REQUIRED, seal key/digest throw without it; schema FK G-2). Mutation:
  optional revision or execution fallback → seal-key guards + K10 ban red.
- **EC-4** — owner `workplace-production-revision.ts` (execution refs only in
  the audit envelope; digests read material coordinates only;
  `seal_receipt_ref` write-only). Mutation: execution field in CandidateSet or
  digest input → set-equality/function-source bans red.
- **EC-5** — owner `production-source-adapters.ts`
  (`canonicalProductsToContribution` sole adapter; `productSource` vocabulary
  deleted from src; ingress selected pre-boundary from frozen WorkIntent).
  Mutation: per-source adapter reintroduction → Gate 5 regex bans red.
- **EC-6** — owner `formalization-production-cell-installation.ts:174-196`
  (schema-versioned frozen baseline manifest: per-AC `{artifactId, code,
  contentHash}`, `acArtifactIds/Hashes`, `baselineHash`; Markdown parsed once
  at acceptance; Development consumes the frozen contract, never re-parses).
  Mutation: downstream divergence from the frozen member set →
  `srs-contract-validation` fail-closed negatives red.
- **EC-7** — owner `workshop-capability-manifest.ts` (one declarative
  manifest, deterministic digest, `installWorkshopPayloadContracts` used by
  BOTH process roots; fail-closed `WORKSHOP_*_MISMATCH`; immutable binding
  receipts, schema `src/schema.ts:1567-1591`). Mutation: mutated executable
  binding → fail-closed throw (asserted test).
- **EC-8** — owners `sqlite-transition-obligation-ledger.ts` (fenced atomic
  append), `transition-obligation-integrator.ts` (all five handoffs; run-gate
  obligation appended inside the seal transaction), and the FIXED 2026-08-16
  residual `resume-compatibility-policy.ts:54,72-74,217-239`
  (`handlerDigests` compared; implementation drift → `restart-required`,
  never `compatible`).
- **EC-9** — owner `workplace-production-revision.ts` (content-addressed
  provenance-free `revisionRef`). Theorem covers A(X+Y) ≡ chained A(X)→B(Y) ≡
  co-presented A(X)+C(Y) → identical `revisionRef`, aliasing cannot fork,
  negative control, crash-window seal, formula pin.
- **EC-10** — witness `src/factory-e2e/fresh-harness.ts` + w9-02/w9-03. At
  `57468bb6` the scripted leg was RED (0/10) with two root causes, both
  repaired on the Phase-6 line and green at `a4565be0`:
  `SUBMISSION_VALIDATION_POLICY_MISSING@product-discovery@4.0.0`
  (production wiring seam — fixed in `wire-submission-validation.ts`) and
  stale admission fixtures (`MODEL_CONCURRENCY_POLICY_INVALID`).

## Cross-boundary authority scan (1344 SQL literals, complete statements)

Zero confirmed violations of the sealed-authority path. Verified clean:
task-shadow exact binding (author stable key; reviewer exact current
generation via `factory_accepted_authority_head`, engine adoption included);
replay capsule selection/invalidation (semantic key, typed conflict,
gate-rejection ineligibility, no eternal loop, typed evidence preserved);
effects (authority-only input, acceptance-digest fail-closed before
invocation, zero material SQL in the invoker, decoy-resistance theorem); the
ten retired Discovery tables (zero readers/writers, no fresh DDL — inert
history); `factory_work_intents` single DDL owner.

Nine residual seams recorded (all low, none post-seal authority selection):
pre-seal SRS validator `ORDER BY a.id DESC LIMIT 1`
(`srs-contract-validator.ts:131-139`); run-scoped newest brief metadata reads
(`constraint-coverage.ts:194-199`, `formalization-contract-validator.ts:211-217`,
digest-pin mitigated); newest accepted SRS policy hint at lifecycle start
(`start-product-lifecycle-from-idea.ts:195-208`, fails safe); task-local
newest rejected-attempt VIEW (`claude-worker-executor-factory.ts:930-959`,
documented non-authority); dormant `listArtifactsForNodeInEpic`
(`sqlite-managed-production-ledger.ts:529-543`, zero production callers,
guarded by `no-fallback-reconstruction` + `exact-product-query`); unpinned
legacy WorkIntents skip payload-contract validation
(`sqlite-managed-node-submission-repository.ts:134-138`); in-run
latest-row-wins reprojection (`sqlite-process-product-repository-v2.ts:280-290`);
latest-order launch fallback (`engine-administration.ts:529-537`);
`'pending@wave-2'` placeholder ContractRef digests (enforcement at the
payload-contract layer).

**CC-U2 — separate open authority gap (NOT folded into ADR-053):** warrant
register/waiver authority is factory-owned (certificate cross-bind, digest and
waiver-set equality), but the executed oracle `evidenceCommand` strings are
candidate-produced declarations from the readiness manifest
(`local-runnability-check-provider.ts:1276-1284` executes them verbatim).
Pinning them to installed workshop/package authority is the reserved ADR-093
A-prime direction; recorded honestly in
`docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md:489`.

## Residual list (smallest exact)

- **R1 — scripted E2E from fresh DB/repo (was blocking-red at audit base):**
  REPAIRED on the canonical line — production wiring fix + admission fixture
  pins in `9ff82434` (merged `a4565be0`); w9-02/w9-03/golden-path 10/10 green,
  independently re-verified. Remaining: the frozen immutable-build re-run is
  owned by Phase 7.
- **R2 — clean real canary from a fresh DB/repository on a frozen build:** no
  accepted evidence exists; owned by Phase 7 under ADR-096 (historical live
  runs do not count per plan rules).

## Non-blocking notes (recorded for the closure decision)

- **N1 (EC-7):** cross-process digest equality is by construction (both
  processes compute the digest from the same compiled manifest) and durably
  recorded per role; no runtime reader compares orchestrator vs worker
  receipts at work-issuance. Within-process declared≠resolved fails closed.
- **N2 (EC-2):** the 12-file classified recency-frontier allowlist (K8-owned
  run-history cursors, epoch/scope chains, exact-key tiebreaks) is frozen in
  `legacy-allowlist.json`; any addition or staleness fails the ratchet.
- **N3 (EC-6 vocabulary):** the ADR's literal entities
  (`DocumentContainer`, `containerAcceptedHash`, `memberSemanticHash`,
  `memberAnchor`) were not introduced; the implemented contract fulfills the
  criterion's substance through the schema-versioned frozen baseline
  manifest. Treated as documentation reconciliation (ADR addendum), not
  missing behavior.

## Verdict

**ADR-053: IN-PROGRESS — do not close.** EC-1..EC-9 are MET with blocking,
executable proofs; EC-10 is OPEN (R1 repaired on canonical, its frozen-build
confirmation and R2 real canary are Phase-7 evidence). Closure signature is
deferred to Phase 7 evidence review per plan §3.4. The registry's
`closureState: in-progress` remains truthful; `decisionStatus` moves to
`accepted` with this audit as the reasoned basis (cutover executed through
releases K6–K13; see the ADR-053 addendum of 2026-08-25).

## Evidence commands (all run on the audited tree, 2026-08-24/25)

| Command | Result |
|---|---|
| `node --test tests/architecture/adr-053-material-authority-ratchet.test.mjs tests/architecture/effect-input-exact-refs.test.mjs tests/architecture/material-identity-execution-free.test.mjs tests/architecture/effects-no-material-reselection.test.mjs tests/architecture/no-execution-scoped-lookup.test.mjs tests/architecture/partition-invariance-theorem.test.mjs` | 34 pass / 0 fail |
| `node --test tests/architecture/adr-053-cutover-gates.test.mjs tests/architecture/adr-053-invariants.test.mjs tests/architecture/adr-053-g-points.test.mjs tests/architecture/authority-recency-classification.test.mjs tests/architecture/workshop-manifest-parity.test.mjs tests/architecture/resume-compatibility.test.mjs tests/architecture/handler-digest-runtime-consistency.test.mjs tests/architecture/progress-obligation-invariant.test.mjs` | 59 pass / 0 fail |
| `node --test tests/process-modules/lifecycle-scoped-accepted-material.test.mjs tests/process-modules/production-source-adapters.test.mjs tests/process-modules/authority-only-effects-theorem.test.mjs tests/architecture/srs-contract-validation.test.mjs` | 27 pass / 0 fail |
| `node --test tests/infrastructure/replay-capsule-selection.test.mjs` | 3 pass / 0 fail |
| `node --test tests/factory-e2e/w9-02-happy-path.test.mjs tests/factory-e2e/w9-03-adversarial.test.mjs tests/factory-contract/golden-path.test.mjs` (at `57468bb6`) | 0 pass / 10 fail (R1, then diagnosed) |
| same three suites at `a4565be0` (Phase-6 verification, independently re-run) | 10 pass / 0 fail (R1 repaired) |
| `grep -rn producerExecutionRef src` → 0 hits; `readAcceptedArtifacts` unscoped → deleted; `findLatestForModule` → deleted | confirmed |
