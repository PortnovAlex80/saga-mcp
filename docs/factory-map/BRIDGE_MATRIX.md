# BRIDGE_MATRIX — Producer → bridge_e → Consumer proofs (reconciliation phase)

- **Base:** `12d46037` (graphs + strata authored at `586871ad`; no production
  bytes changed between — see GRAPH_RECONCILIATION § header).
- **Edge-proof rule (00 contract §2, restated):** an edge is proven ONLY by a
  concrete bridge installed in production composition such that
  `bridge_e(PostProducer)` satisfies `PreConsumer` AND preserves exact
  authority/identity/provenance bindings (selection by immutable
  ref+content-digest, never recency/latest/task/execution id), AND the
  conjunction of all obligations the consumer enforces is JOINTLY SATISFIABLE
  (CONVEYOR §30 invariant 3, `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1477-1486`;
  testing-ladder S rung, `:1166-1179`).
- **Status vocabulary (closed):** `PROVEN` (bridge installed + matrix-hosted or
  CI-executed proof), `PROVEN-DECLARED` (bridge installed, declared-only
  proof), `FAILED` (counterexample exists), `OPEN` (no in-repo producer),
  `PARTIAL` (proven for a subset of the consumed variants).

## 1. Matrix

| id | Producer | bridge_e (installed) | Consumer | Identity / provenance / authority / cardinality | Joint satisfiability | Status |
|---|---|---|---|---|---|---|
| BM-1 | lifecycle input `$.initiative.*` | stage input mapping `factory.product-delivery-lifecycle-input.v2` → `factory.discovery-case.v1` (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:293-302`; executor `src/process-modules/application/lifecycle-orchestrator.ts:360`) | Discovery `produce-proposal` cell | initiative fields verbatim; entry guard `initiative.subject exists` (`:340`); cardinality 1 case/run | DECIDABLE, holds (subject guard) | PROVEN-DECLARED |
| BM-2 | `produce-proposal` (exact 1 `factory.discovery-proposal.v1`) | readiness provider binding by content hash (`src/modules/discovery/application/discovery-check-providers.ts:119-158`); settlement `requireAcceptedSingletonCellItem` (`src/modules/discovery/application/discovery-production-cell-installation.ts:154-168`) | `assess-readiness` + `settle` | selection by exact ProductRef alias `managed-node-submission:<id>` + schema + content digest (`:462-495`); cardinality exactly 1+1; readiness payload carries `proposal_content_hash` | holds; uncovered: forged-content-at-allowed-ref not scenario-pinned (`01_DISCOVERY.md:80`) | PROVEN (corpus matrix-hosted) |
| BM-3 | Discovery `complete-go/clarify/reject` + certificate | lifecycle output mapping (`product-delivery-lifecycle.ts:303-313,351-356`) + `createDiscoveryOutputResolver` / `createDiscoveryLifecycleOutputPayloadResolver` (`discovery-production-cell-installation.ts:364-412`, wired `product-lifecycle-runtime.ts:910-914`) | `FormalizationCase` (`factory.formalization-case.v1`) | consumer re-verifies certificate by exact ref AND hash before trusting the register (`formalization-production-cell-installation.ts:659-690`); `failed` produces no keys and a resolver step-aside exists (`:376-383`) | holds; `failed` route excluded by mapping absence, no adversarial forcing test (`02_FORMALIZATION.md:199`) | PROVEN (matrix-hosted `discovery-output-handoff`) |
| BM-4 | Formalization cells (5 reviewed) → accepted artifacts | `freeze-acceptance-baseline` (lifecycle-scoped accepted AC set, ADR-078 K6; drift→`complete-inconsistent`, `formalization-production-cell-installation.ts:119-209`) → architecture cell → settlement (§D2 decomposition, `:529-540`) | Solution Contract `factory.solution-contract-certificate.v1` + persisted record (`:336-376`) | baseline freezes AC ids/hashes/atomic criteria + `baselineHash`; semanticDigest over stable codes+hashes only (`:741-759`); settlement reads lifecycle-scoped accepted material with exact hashes (`:717-733`) | holds for frozen inputs; residual: epic-accumulation seam untested adversarially (`02_FORMALIZATION.md:181`) | PROVEN (matrix-hosted hashes/warrant suites) |
| BM-5 | Formalization `complete-formalized` (Solution Contract whole payload incl. SRS + §2.2 + §D2) | output mapping `solutionContract.*` + `solutionContractPayload` (`product-delivery-lifecycle.ts:366-369,383-412`) + `createFormalizationLifecycleOutputPayloadResolver` exact-match verification (`formalization-production-cell-installation.ts:583-605`, wired `:915-920`) | `DevelopmentCase` (`factory.development-case.v1`) → planner gate `development.task-graph-contract.v1` | hash chain intact end-to-end (matrix-proven: `development-constraint-relay`, `formalization-solution-contract-hashes`); criterion relay kernel-derived, unforgeable from planner output (`development-schemas.ts:381-396`) | **REPAIRED 2026-08-24 (Elite-8 counterexample, see §4.5 + §4.6)**: gate v1.4.0 resolves §2.2 tokens against the canonical §D2/§D1 surface (`srs-file-identity.ts`, segment-aligned) before coverage; ambiguous tokens fail typed `srs-file-identity-conflict` pre-worker with code-scoped UPSTREAM routing (no planner repair budget burned); RED/GREEN hosted (`srs-file-identity-satisfiability.test.mjs` + `srs-identity-upstream-routing.test.mjs`) — status stays PARTIAL until the three clean runs | PARTIAL (hash identity PROVEN; path identity repaired; pending clean-run proof) |
| BM-6 | planner proposal (typed worker product) | `resolve-task-graph` kernel canonicalization + `materializeValidatedTaskGraph` (write-once, byte-equality replay: `sqlite-development-settlement-state.ts:115-160`; authorization: `development-installation.ts:355-395`) | canonical `factory.development-task-graph.v1` (fan-out selectors) | advisory proposal CANNOT persist before authorization (`development-kernel-ports.ts:138-151`); kernel stamps provenance + constraint relay; verification ledger opens in the SAME transaction (CC-GAP-8, `:142-152`) | holds; planner-decode trims forgeable fields (structural) — no runtime adversarial test (`03_DEVELOPMENT.md:166-169`) | PROVEN (glob-hosted authorization suite) |
| BM-7 | implementation cells (fan-out N) | `postAcceptanceEffect: 'git-integration'` (`development-process-module.ts:337-339`): fenced merge/receipt, observe-before-retry, typed conflict (`src/infrastructure/workplace/git-integration-effect.ts:11-27,57-182`) → `freeze-integrated-candidate` kernel (exactly 1 receipt per accepted product: `sqlite-development-settlement-state.ts:246-273`) | `integrated-source-candidate` (content-addressed `sourceHash`, frozen) | effective desk-base receipts immutable by trigger (`src/schema.ts:1486-1523`); lineage check vs `expectedBaseCommit` (`:274-286`); cell identity = TASK for capsule purposes (1a6fc2a5 fix; `03_DEVELOPMENT.md` git-integration details) | holds; concurrent freeze from two hosts untested (single-host caveat) | PROVEN (glob-hosted scope/monotonicity suites) |
| BM-8 | `certify-product-readiness` manifest | local-runnability provider v1.14.0 (subject = FROZEN candidate, not the probe; `failureOwnership: 'upstream'`; K19 identity; `development-process-module.ts:158-225`) + `bind-runnable-candidate` receipt validation (LR-06 durable store `factory_check_receipts`, `sqlite-development-settlement-state.ts:566-591`) | `integrated-release-candidate` | receipt keyed by accepted presentation ref+digest; deterministic `local-readiness:<digest>` fence; identity failures are product `failed`, never substrate unknown (ADR-083 §6 split) | holds; substrate TIMING on the real seam is quarantined-FLAKY (predicted next death #2, `RED-TEAM-AUDIT.md:126-131`) | PARTIAL (semantics proven; real-process timing outside CI) |
| BM-9 | `verify-acceptance` evidence products (fan-out N, 1 criterion/item) | settlement-state seam builds acceptance-verification workset from sealed CandidateSets — "no epic-wide 'latest' lookup" (`development-kernel-ports.ts:180-192`); trusted-receipt reader fail-closed (`src/modules/development/index.ts:166-191`) | Development settlement verification clause | evidence pins `acceptedCriterionHash` + frozen `candidateHash`; default provider returns `unknown` for LM-authored assessments by design (`index.ts:72-84`) | holds structurally; "AC coverage ≠ AC satisfaction" remains an open semantic boundary (GUARDRAILS Sign 006, `GUARDRAILS.md:65-71`) | PROVEN (exact-file verification-ledger suite) |
| BM-10 | `settle-development` | settlement policy pure decision + write-once verified-integration-bundle repository (`development-kernel-ports.ts:213-238`; certificate hashes every lineage coordinate, `development-settlement-policy.ts:1429-1451`) | `factory.development-certificate.v1` decision `verified` + bundle | input reconstructed from accepted sealed cell products by exact refs/hashes (reverse `BRIDGE-DEVELOPMENT-SETTLEMENT-STATE`, dep-22/23; `sqlite-development-settlement-state.ts:474-545`) | holds; terminal-route accounting never discharges obligations (CC-GAP-8) | PROVEN (matrix-hosted settlement suites) |
| BM-11 | Development `complete-verified` (certificate + bundle) | lifecycle outputMapping (`product-delivery-lifecycle.ts:417-427`) + delivery stage input mapping binding decision literal `'verified'` + `integratedCandidate` from bundle payload (`:443-467`) | Delivery `DeliveryReleaseCase` v2 (authorized) or deferred profile | exact refs; candidate scope `exact(hash)` or `lifecycle-output` ("A complete Lifecycle cannot name the candidate hash before Development produces it", `delivery-schemas.ts:93-117`) | satisfiable ONLY under delivery-containing definition + authorized input — composition-conditional (GRAPH_RECONCILIATION §2) | PROVEN (delivery lifecycle e2e, product-delivery lifecycle only) |
| BM-12 | preflight → approval → publication → observation | Delivery kernel nodes with re-read + re-assert of every upstream product before each step (`delivery-installation.ts:267-298,341-379`); effect ledger + observe-before-execute (`sqlite-delivery-runtime.ts:466-536`); deterministic `deliveryActionKey` (`delivery-settlement-policy.ts:124-144`) | `settle-delivery` settlement input | approval bound to candidate+preflight+policy hashes, immutable inbox; publication receipts four-state; observation `matched` at `desiredStateHash` + `currentCandidateHash` drift watch; provider trust fail-closed on id+name+category+version (`sqlite-delivery-runtime.ts:687-718`) | jointly satisfiable ONLY for `source-tag` actions (one provider kind exists); for `source-release`/`package-publish`/`deployment` NO in-repo producer exists → conjunction unsatisfiable by construction today | PARTIAL (source-tag PROVEN; other kinds OPEN — reverse homeless claim confirmed) |
| BM-13 | `settle-delivery` decision `released` | `routeProcessOutcome` + lease-CAS `completeStage` write-once terminal stamp (`lifecycle-router.ts:23-32`; `sqlite-lifecycle-run-repository.ts:1073-1138`); exactly-once `run.terminal` journal (CC-GAP-4) | `factory_lifecycle_runs.terminal_status='released'` + launch settlement | fenced transition obligation `in_progress`; write-once; exit 0 stays operational (no success classifier in engine, `orchestrate-cli.ts:740-774`) | holds | PROVEN (reverse Layer 0; dep-01..04; matrix-hosted terminal suites) |
| BM-14 | cell CandidateSet seal | RunGate obligation → author gate → reviewer desk (pinned exact author set) → final gate → effect → `CellFinalAcceptance` (`production-cell-node-executor.ts:1027-1503` summary in FORWARD_GRAPH §4) | node completion / settlement inputs | ADR-053 material authority: selection by exact ref+digest; execution ids provenance only; `CellFinalAcceptance` constructible only after verdict+revision+effects+terminal proof (CONVEYOR §6, `CONVEYOR-MENTAL-MODEL.md:215-239`) | holds at the seam; task-shadow port (STATE_MATRIX SM-14) corrupts the BUDGET accounting path, not the acceptance path | PROVEN (factory-contract group) |
| BM-15 | launch ticket | CAS-fenced single-use launch reference (`product-lifecycle-run-starter.ts:79-184`; `sqlite-factory-launch-repository.ts:289-322`) + terminal settlement projection | engine host loop / order leaf | durable lifecycle start receipt; one resumable run enforced | holds; multi-host claim fence caveat OPEN-CONCURRENCY | PROVEN |

## 2. Bridges absent by design (no row above)

- **Deferred settlement short-circuit:** deferred mode preflight returns
  `authorization-required` and settlement routes terminal `approval-required`
  WITHOUT effects (`delivery-installation.ts:149-153,724-745`) — a lawful
  non-bridge: the edge to `released` does not exist for deferred runs
  (BM-11 composition condition).
- **Replay capture is not a bridge:** capsules substitute worker production
  only (CONVEYOR §8); they never restore gates/settlement (BM-14 unaffected).

## 3. Recency-hazard bridges (explicitly NOT present)

ADR-053 (`docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md:229-233`)
forbids recency selection. The following hazards remain open and are mapped in
STATE_MATRIX/ARTIFACT_LINEAGE: epic-scoped `readAcceptedArtifacts`
(Formalization settlement), newest-wins capsule binder (3rd lifecycle),
`readTaskForWorkplace` newest-task shadow (SM-14).

## 4. The Elite-8 joint-satisfiability counterexample (BM-5)

The standing proof that per-edge hash correctness does NOT imply bridge
satisfiability:

1. **The handoff preserved identity exactly.** Formalization → Development
   relay is hash-verified end-to-end (BM-5 identity column; matrix-hosted
   `formalization-solution-contract-hashes` + `development-constraint-relay`).
   The SRS artifact byte-matched its registered content hash — the drift guard
   (`srs-artifact-drifted`) did not and could not fire.
2. **Each consumer obligation was individually defensible:**
   - the §2.2 manifest assessor requires EVERY declared §2.2 file to lie inside
     some implementation item's changeScopes
     (`src/modules/development/application/development-check-providers.ts:998-1099`;
     evaluator `src/modules/development/domain/srs-module-manifest.ts:214-248`)
     and, under a register-bearing corpus, a missing/file-less manifest is a
     typed RED (`srs-module-manifest-missing`, ADR-088);
   - the §2.2 parser extracts file-like tokens VERBATIM from the manifest
     cells — a bare filename (`smoke.test.js`, `index.html`) is a lawful token
     (`srs-module-manifest.ts:68` FILE_LIKE, `:176-185` extractFileTokens);
   - requiredChangeScopes are derived from §D2/§D1 (and §2.5/§3
     package.json mentions) — deliberately NOT from §2.2, because §2.2
     "Owned Surfaces" can be module-relative (`data/categories.js` for a module
     whose file is `js/data/categories.js` — real workshop evidence recorded in
     `src/modules/development/domain/srs-derived-change-scopes.ts:22-31`);
   - scope containment is EXACT-STRING path semantics: scope `e2e/` contains
     `e2e/smoke.test.js` but NOT bare `smoke.test.js`
     (`src/shared/repository-scope.ts` `repositoryScopeContainsPath`).
3. **The conjunction was unsatisfiable.** Elite-8's accepted SRS declared §2.2
   with bare filenames while §D2/§D1 declared the same files as full paths.
   Any plan scoping the REAL (full-path) files leaves the bare §2.2 tokens
   uncovered → `srs-module-uncovered`; the SRS was already frozen upstream
   (post-baseline AC/SRS immutability, `formalization.baseline-before-how`,
   `02_FORMALIZATION.md:153`), and v2 waivers are typed-unavailable
   (CC-IC-2, `906edf84`), so the planner could not repair by waiver and could
   not edit the frozen SRS. No satisfying plan existed — the run could only
   burn budget. This is the CONVEYOR §30 invariant-3 failure mode ("two
   individually correct obligations … together unsatisfiable") and the exact
   residual trap class the red team flagged: `srs-module-manifest-missing`
   "велящий ПЛАНЕРУ дописать §2.2 в замороженный SRS — форма ловушки Elite-7 в
   остаточном пути" (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:65-68`).
4. **Why no test caught it:** fixtures emit canonical §2.2 shapes (full paths)
   — the producer-diversity lesson from Elite-4 ("handoff contracts need
   adversarial producer-diversity fixtures",
   `docs/factory-run/stage20-elite/RUN-TRACKER.md:314-318`) repeats here at the
   document-section level.
5. **Classification:** BM-5 identity/provenance/cardinality = PROVEN;
   BM-5 joint satisfiability = PARTIAL with a live counterexample. The fix
   direction (normalization of §2.2 tokens against the §D2/§D1 file surface at
   the decoder boundary, or a satisfiability check over the frozen SRS BEFORE
   Development admission) belongs to PRE-ELITE9-TRACKER point 5 corpus work —
   no code change is made in this reconciliation phase.

## 4.5 The repair (2026-08-24, BM-5/MM-4)

Point 5's first half landed as the smallest authority-conserving cutover:

- ONE canonical normalized file-identity manifest —
  `src/modules/development/domain/srs-file-identity.ts`. It owns the §D2/§D1
  file-surface extraction (moved out of `srs-derived-change-scopes.ts`; no
  consumer re-parses those sections) and resolves every §2.2 token against
  that surface: `exact` / `module-relative` (segment-aligned suffix —
  "Owned Surfaces", workshop P08; renamed from the v1.3.0
  `basename-unique` when resolution became segment-aligned, §4.6) /
  `ambiguous` / `not-on-surface`. The manifest is a pure
  function of the frozen SRS content hash — "frozen upstream" without a
  schema move (the SRS IS the frozen artifact; this module is its one
  canonical interpretation).
- Gate `development.task-graph-contract.v1` v1.3.0: ambiguous basenames fail
  TYPED `srs-file-identity-conflict` with the candidate paths as witnesses,
  plan-independently, before any implementation worker is spawned (decided
  from the frozen SRS alone on the first gate run); resolved tokens evaluate
  coverage at their canonical path, so the Elite-8 shape is satisfied by the
  plan scoping the REAL files; off-surface tokens keep as-declared semantics.
- No invented fallback: `DEFAULT_REQUIRED_CHANGE_SCOPES`
  (`['package.json','tests/']`) is deleted;
  `buildReferenceDevelopmentPolicy` keeps scopes EMPTY when nothing is
  derivable (fresh projects) — the case SRS governs at the plan gate.
- RED/GREEN pinned and hosted blocking (acceptance-matrix process-modules
  group): `tests/modules/development/srs-file-identity-satisfiability.test.mjs`
  (Elite-8 counterexample, ambiguous conflict + plan-independence, P08
  module-relative, ordinary-product pass/gap, no-fallback policy) plus the
  now-hosted `srs-derived-change-scopes.test.mjs`. SAT-rung classification
  updated in the same commit (gate-conjunction-satisfiability.test.mjs).
- Status stays PARTIAL until the three clean runs re-prove the conveyor end
  to end on a real model.

## 4.6 The Red-Team correction follow-up (2026-08-24, gate v1.4.0)

An independent conformance review ACCEPTED the core identity algorithm and
required five corrections; all landed in the same follow-up:

1. **Code-scoped upstream routing — no planner budget on plan-independent
   frozen-SRS defects.** `srs-file-identity-conflict`,
   `srs-artifact-drifted` and `srs-module-manifest-missing` are decided from
   the frozen SRS (+ register) ALONE; the v1.3.0 red still reduced to
   `repair_required` targeting the planner, which could only burn attempts.
   `CheckPlanEntry.upstreamOwnedFailureCodes` (new, beside the blanket
   `failureOwnership`) lets the planner plans declare exactly these typed
   codes; the gate reducer escalates ONLY receipts carrying them to the
   producer-defect verdict `failed` (existing upstream-ownership semantics),
   while genuine plan errors from the same provider keep planner repair.
   Proof: `tests/factory-contract/srs-identity-upstream-routing.test.mjs`
   (plan wiring incl. the re-plan continuation plan, reducer discrimination,
   the real provider through the installed plan, and the
   `readParentDefectEvidence` continuation seam decoding the typed cause for
   the upstream repair boundary).
2. **Registerless grandfather resolved deliberately.** The ADR-088
   registerless grandfather (typed skip for a missing/file-less §2.2) does
   NOT extend to identity conflicts: an ambiguous token fails closed in
   BOTH register states (documented compatibility reversal), and the
   conflict message no longer advertises the impossible constraint-register
   waiver — register waivers subtract constraints, they cannot decide file
   identity. The sole lawful exit is repairing the SRS §2.2 declaration
   upstream; the message says so and is register-conditional.
3. **Segment-aligned token resolution (masking closed).** A multi-segment
   §2.2 token resolves only against a surface path whose directory
   structure it extends (single-segment = the Elite-8 bare-filename case);
   `admin/index.html` vs surface `frontend/index.html` is NOT re-identified
   by basename coincidence (typed coverage gap, as-declared semantics), and
   `s/engine.js` never suffix-matches `js/engine.js`.
4. **Directory-shaped surface tokens (`js/`) are scope vocabulary, never
   file identity** — deterministically excluded from the §D2/§D1 file
   surface (mirroring the §2.2 FILE_LIKE filter) with a regression; no
   scope authority is invented from them (non-broadening).
 5. **Per-file removal guards**: coverage guard G2m pins BOTH BM-5 suites
    (`srs-file-identity-satisfiability` + `srs-derived-change-scopes`) in a
    blocking run-set — deletion or de-hosting now reddens the matrix.
    (Guard-ID note, canonical integration 2026-08-24: authored as G2k on the
    stage22/bm5-file-identity branch whose base predated ADR-095 Phase-2C/3;
    canonical saga4 had already assigned G2k to the ADR-095 eight-ratchet
    suite and G2l to the conveyor v4.3 focused-invariants oracle, so the
    BM-5 guard took the next genuinely free ID G2m. Semantics unchanged.)
   Truth-updated evidence: TEST_COVERAGE §2/TC-5/TC-7/TC-10, the §D2/§D1
   section-reference typos fixed across the factory-map set, obligation
   contract `dev.task-graph` repinned 1.3.0 → 1.4.0.

## 5. Bridge ↔ graph cross-references

BM-1..BM-15 ids are referenced from `graph-reconciliation.v1.json`
(`.bridges[].id`), GRAPH_RECONCILIATION §4, and PRE-ELITE9-TRACKER evidence
fields. Reverse-map analogues: BM-3 ≈ dep-25/26 boundary, BM-5 ≈ dep-24 handoff
half, BM-10 ≈ dep-21/22, BM-12 ≈ dep-05..dep-17, BM-13 ≈ dep-01..04,
BM-14 ≈ dep-22/23, BM-15 ≈ dep-19/20 launch/continuation producers.
