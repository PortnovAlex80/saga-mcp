# GRAPH_RECONCILIATION — Independent Forward × Reverse Map Reconciliation

- **Schema doc:** this file + machine artifact [`graph-reconciliation.v1.json`](./graph-reconciliation.v1.json)
  (`factory.execution-map.reconciliation.v1`).
- **Reconciliation base:** commit `12d46037e0e3d19033386102addc98cabc32461f`
  (branch `map/integration-2026-08-23`, merged into this worktree's branch
  `map/reconciliation-2026-08-23`).
- **Graph inputs and their independent authorship:**
  - Forward: [`forward-graph.v1.json`](./forward-graph.v1.json)
    (`factory.execution-map.forward.v1`, 68 nodes / 93 edges / 13 terminals),
    authored at `586871ad` on `map/forward-2026-08-23` (commit `1263095a`) by a
    forward-only walk; its doc declares no reverse file was read
    (`docs/factory-map/FORWARD_GRAPH.md:3-9`).
  - Reverse: [`reverse-graph.v1.json`](./reverse-graph.v1.json)
    (`factory.execution-map.reverse.v1`, 45 claims / 28 dependencies / 1
    homeless claim / 12 safety + 5 liveness + 5 audit claims), authored at
    `586871ad` on `map/reverse-2026-08-23` (commit `961f4d03`) from the single
    starting claim "terminal `released`"; its doc declares no forward walk and
    no other map was read (`docs/factory-map/REVERSE_GRAPH.md:3-9`).
  - Strata: `00_FACTORY_CONTRACT.md`, `01_DISCOVERY.md`, `02_FORMALIZATION.md`,
    `03_DEVELOPMENT.md`, `04_DELIVERY.md` (authored at `586871ad` on
    `map/discovery-formalization-2026-08-23` and
    `map/development-delivery-2026-08-23`; the contract §4.3 declares
    forward/reverse independence and reconciliation as a later explicit phase —
    this document is that phase).
- **Authority rule (unchanged):** production code is the authority; no graph,
  stratum doc, or run narrative is. Where the two graphs disagree, the tie is
  broken ONLY by an independent production-installed inventory
  (§2), never by preferring either author.
- **Verification delta:** `586871ad..12d46037` touches only `docs/factory-map/**`
  (9 files, insertions only — `git diff --stat 586871ad 12d46037`); no
  `src/`, `tests/`, `dist/`, or tooling bytes changed between the graph base
  and this reconciliation base, so every `586871ad`-frozen citation remains
  line-valid at `12d46037`.

---

## 1. Method

Reconciliation compares the two graphs WITHOUT forcing edge-set equality. The
00 contract §4.2 forbids minimization against a single accepting path, and the
two graphs were built with different resolutions and different rooting, so
equality of node sets is not the target. The target is a typed partition:

```text
F∩B  = edges/claims both directions need        → NECESSARY (each still needs
                                                    its own bridge proof, §4)
F\B  = forward-only elements                    → classify:
                                                    support | alternate |
                                                    recovery | audit |
                                                    dead-candidate
B\F  = reverse-only obligations                 → classify:
                                                    missing production path |
                                                    wrong root |
                                                    (or already-present under
                                                     a different node id)
```

Both classifications are grounded in an **independent production-installed
inventory** (§2) performed at `12d46037` by this reconciler — not in either
graph's word. An element is "installed" iff the composition root actually
registers it (00 contract §6): package installation + module registration +
lifecycle selection.

No mathematical closure is claimed outside the declared decidable fragment
(§8): everything else stays in the open-boundary ledger (§7).

## 2. Independent production-installed inventory (the tie-breaker)

Re-derived at `12d46037` by direct code inspection (this reconciler, not
copied from either graph):

1. **Packages installed once per CLI composition** — exactly six:
   `discoveryPackageManifest`, `formalizationPackageManifest`,
   `developmentPackageManifest`, `developmentContinuationPackageManifest`,
   `developmentVerificationContinuationPackageManifest`,
   `deliveryPackageManifest`
   (`src/orchestrate-cli.ts:885-897`). No other package manifest is installed
   by the production CLI.
2. **Module registration** — exactly four workshop registrations in the
   runtime: `registerDiscovery` (`src/app/product-lifecycle-runtime.ts:871`),
   `registerFormalization` (`:898`), `registerDevelopment` (`:899`),
   `registerDelivery` (`:904`); payload contracts installed once from
   `WORKSHOP_PAYLOAD_CONTRACTS` (`:865-869`).
3. **Lifecycle selection seam** — `definition: options.lifecycleDefinition ??
   productBuildLifecycle` (`src/app/product-lifecycle-runtime.ts:991`) with the
   per-invocation pinned-snapshot override (`:1006-1009`); the production
   composition root passes NO `lifecycleDefinition`
   (`src/app/composition-root.ts:299-307`). Therefore the production default
   lifecycle is **product-build** (3 stages, `delivery-release` filtered,
   `verified` → terminal `runnable-local`,
   `src/process-modules/lifecycles/product-build-lifecycle.ts:30-45`).
   In production `src/` nothing passes `productDeliveryLifecycle`; the only
   in-repo passers are factory-proof drivers
   (`tests/factory-proof/delivery-scenario-drive.mjs:200`). (Matches forward
   u1; independently re-verified here.)
4. **Delivery provider composition is mandatory and environment-selected**
   (`SAGA_PRODUCT_LIFECYCLE_COMPOSITION`, fail-closed,
   `src/orchestrate-cli.ts:841-848`): default panel composition is
   local-dry-run (publish throws `delivery-provider-not-configured`,
   `tracker-view/product-delivery-composition.mjs:64`); the only in-repo
   composition capable of a truthful `released` is
   `tracker-view/product-delivery-local-release-composition.mjs`
   (source-tag provider; `local-git-tag-delivery-provider.ts`).
5. **Acceptance-matrix registry** — 8 groups, 6 quarantine rows
   (`tools/run-acceptance-matrix.mjs:64-195`), every group an isolated
   blocking `node --test` CI step (`.github/workflows/ci.yml:65-126`,
   ubuntu-only, branches `dev|main|saga2-refactoring|saga4`).
6. **Start-from-idea delivery mode is always deferred** —
   `delivery.mode='deferred'` with hashed profile
   (`src/app/start-product-lifecycle-from-idea.ts:301`); deferred settlement
   deterministically returns `approval-required`
   (`src/modules/delivery/domain/delivery-settlement-policy.ts` deferred
   branch; `src/modules/delivery/application/delivery-installation.ts:724-745`).

From this inventory the **decisive composition fact** for rooting (§3):

> A start-from-idea run on the production default composition settles, at best,
> `runnable-local` (product-build) — never `released`. `released` requires (a)
> a delivery-containing lifecycle definition (product-delivery), and (b) an
> authorized `delivery` input, whose only in-repo producer is
> `prepareLocalReleaseContinuation` from a truthful `approval-required`
> terminal parent (`src/app/factory-release-continuation.ts:19-121`) or a
> caller-supplied authorized launch input (external operator boundary).

## 3. Goal roots (corrected superset)

The reverse graph rooted itself at ONE claim: `R-RELEASED-TERMINAL`
(`released`). The 00 contract §4.1 defines the rooted goals as a set of at
least four: **product success, safety, liveness, auditability** — and product
success itself splits by lifecycle because the code splits it (§2 item 3).
The reconciled root set is therefore:

| Root id | Meaning | Production grounding | Covered by |
|---|---|---|---|
| `ROOT-RUNNABLE-LOCAL` | product-build terminal `runnable-local`, externally true (product starts, suite passes) | `product-build-lifecycle.ts:30-45`; stage-19 amendment lesson (external truth ≠ internal truth, `docs/factory-run/stage20-elite/RUN-TRACKER.md:43-49`) | Forward fully (`terminal.runnable-local`, e39); reverse only as outcome-contract boundary (`OUTC-FORMALIZATION-FORMALIZED` prerequisite chain) |
| `ROOT-RELEASED` | product-delivery terminal `released`, truthful | `product-delivery-lifecycle.ts:479-484`; reverse Layer 0-1 | Reverse fully; forward as `terminal.released` (e50) reachable only under composition conditions (§2) |
| `ROOT-SAFETY` | no illegal transition, no authority leak, no unproven acceptance | reverse `safetyClaims[]` (12); CONVEYOR §27 fitness catalog (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1317-1401` — fitness-function catalog) | Reverse named 12; forward encodes the same invariants as guards inside nodes/edges |
| `ROOT-LIVENESS` | every nonterminal scope has live owner / runnable command / typed wait / pending transition obligation | progress-obligation invariant (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1125-1152`) | Forward machinery (`factory.supervision`, `factory.obligation-reconciler`, repair/epochs); reverse named 5 |
| `ROOT-AUDITABILITY` | every durable transition has citable evidence/receipts | causal-envelope contract (`docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md:34-44,45-96`) | Reverse named 5; forward `factory.terminal-settlement`, ledger/effect rows |

**Recorded explicitly (task requirement):** current start-from-idea defaults to
**product-build / runnable-local**; `released` requires
**product-delivery / authorized continuation** (or an external authorized
launch input). The reverse graph's single `released` root is therefore a
correct but PARTIAL root set: it under-covers `ROOT-RUNNABLE-LOCAL` internals
(its own uncertainty 3 admits Discovery/Formalization internals were not
expanded — `reverse-graph.v1.json` uncertainties[2]) and its Dependency spine
silently assumes the delivery-containing definition is installed. This is a
rooting asymmetry, not an error in either graph: B's spine is sound FOR
`released`; F's topology is sound FOR what is installed. The reconciliation
records both and refuses to collapse them.

## 4. F∩B — necessary spine (both directions require it)

Each row is required by forward reachability AND by the reverse dependency
spine; the bridge column points into BRIDGE_MATRIX.md where the full
producer→bridge_e→consumer proof (including joint satisfiability) lives.

| # | Spine element | Forward id(s) | Reverse id(s) | Bridge |
|---|---|---|---|---|
| 1 | initiative → Discovery case | e09 | dep-26, `EXT-INITIATIVE-REPOSITORY-POLICY`, `INPUT-LIFECYCLE-CONTRACT` | BM-1 |
| 2 | Discovery cells → certificate/settlement | `disc.produce-proposal`, `disc.assess-readiness`, `disc.settle`, e10-e14 | `OUTC-DISCOVERY-FORWARD` | BM-2 |
| 3 | Discovery → Formalization handoff (exact cert ref+hash) | e15 | dep-25, `OUTC-FORMALIZATION-FORMALIZED` prerequisite | BM-3 |
| 4 | Formalization spine → frozen Solution Contract | `form.*`, e17-e28 | `OUTC-FORMALIZATION-FORMALIZED` | BM-4 |
| 5 | Formalization → Development case relay | e29 stage mapping | dep-24, `STAGE-HANDOFF-DELIVERY` upstream analogue | BM-5 |
| 6 | Development plan → canonical graph → worksets | `dev.plan-task-graph`→`dev.resolve-task-graph`, e30-e31 | `BRIDGE-DEVELOPMENT-SETTLEMENT-STATE` inputs | BM-6 |
| 7 | Implementation cells → git-integration effect → integrated candidate | e32, `cell.git-integration-effect` | `PROD-INTEGRATED-CANDIDATE` | BM-7 |
| 8 | Readiness certification → deterministic receipt → bind | e33-e34 | `RECEIPT-LOCAL-READINESS` | BM-8 |
| 9 | Verification fan-out → evidence products | e35 | dep-22 verification clause | BM-9 |
| 10 | Development settlement → certificate + verified bundle (`verified`) | e36-e37 | `DECIDE-DEVELOPMENT-VERIFIED`, `CERT-DEVELOPMENT-VERIFIED`, `PROD-VERIFIED-INTEGRATION-BUNDLE` | BM-10 |
| 11 | `verified` → (delivery lifecycle only) delivery-release stage | e38 | dep-18, dep-10 | BM-11 |
| 12 | Delivery preflight → approval → publish → observe → settle | e42-e49 | dep-05..dep-17 | BM-12 |
| 13 | `released` terminal stamp (write-once, lease-CAS) | e50 | `R-RELEASED-TERMINAL`, dep-01..dep-04 | BM-13 |
| 14 | Cell loop: seal → gates → effects → CellFinalAcceptance | `cell.*` e54-e79 | `STATE-CELL-FINAL-ACCEPTANCE`, dep-22/23 | BM-14 |
| 15 | Launch claim fence + terminal settlement | `launch.ticket`, `factory.terminal-settlement` | `STATE-LAUNCH-CLAIM`, `PROJ-LAUNCH-SETTLEMENT` | BM-15 |

All fifteen are NECESSARY under both roots `ROOT-RELEASED` and
`ROOT-RUNNABLE-LOCAL` (rows 11-13 necessary only under `ROOT-RELEASED`).

## 5. F\B — forward-only elements, classified

Classification vocabulary (closed): `support` (runtime machinery both goals
need but the reverse walk abstracts), `alternate` (lawful alternate route),
`recovery` (repair/retry/continuation machinery), `audit` (evidence surface
only), `dead-candidate` (installed-tree element that no goal root needs as
live surface — candidate for removal, never silently deleted).

| Forward id | Class | Why it is absent from B | Evidence |
|---|---|---|---|
| `cell.repair-wait`, `cell.recovery-epoch-rollover`, `cell.scope-widening` (e61, e69, e72-e78) | **recovery** | B's spine excludes anything "the code blocks… by construction" — repair topology is orthogonal to the `released` proof; but it is REQUIRED for liveness under `ROOT-LIVENESS` (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1125-1152`; ADR-075 epochs, `production-cell-node-executor.ts:783-916`) | `docs/factory-map/FORWARD_GRAPH.md:158-163` |
| `cell.human-park` (e62, e70, e80) | **recovery** (typed human wait) | B models the human ONLY as `HUMAN-APPROVAL-DECISION` inside Delivery; the generic `paused(human_required)` park is broader (warrant-blocked-environment, effect stasis) | `production-cell-node-executor.ts:545,783,1407` |
| `factory.dispatch-drain`, `factory.supervision`, `factory.engine-supervisor` (e55, e81-e83) | **support** | B assumes a live engine (`LIVE-LEASES-HEARTBEATS` names the lease/heartbeat invariant but not the dispatch loop machinery); the watchdog freeze→restart arc is engine-host support | `tracker-view/engine-supervisor.mjs:208-232`; `src/app/dispatch-loop.ts` |
| `factory.replay-certification-sweep`, `cell.replay-capture-effect` (e68, e85) | **support + audit** | Replay capsules are cross-run optimization, not a `released` prerequisite; B correctly excludes them (CONVEYOR §8: replay substitutes only worker production) | `product-lifecycle-runtime.ts:374`; `orchestrate-cli.ts:704` |
| `cont.release-continuation` (u2/e-continuation) | **alternate** (the ONLY in-repo authorized-release producer) | B has it as `SOURCE-AUTHORIZED-DELIVERY` (dep-20) — so this is actually F∩B under different ids; listed here because F models it as a node while B models it as an input-producer claim | `src/app/factory-release-continuation.ts:19-121` |
| `cont.development-continuation`, `cont.development-redevelopment` | **recovery** (accepted-prefix continuation / new order) | not on the `released` spine; required for liveness after terminal failed/blocked | `src/app/factory-continuation.ts:47`; `src/app/factory-redevelopment.ts:121` |
| `entry.operator-soft-stop`, `entry.factory-cli` commands beyond start/resume | **support** | operator surface; B treats operator as external boundary | `scripts/factory.mjs:91,235,284,291,561` |
| Forward excluded strata (root test composition, fresh-harness, scenario packages, diagnosis/normalizer skills, root diagnostic scripts, `src/tools/process-modules.ts:141` display registry) | **dead-candidate** | F §7 already segregates them; B never sees them; no goal root needs them; removal candidates WITH ADR + guard (the Discovery legacy ControlIntent/tools cluster is already owned by PRE-ELITE9-TRACKER point 5) | `docs/factory-map/FORWARD_GRAPH.md:201-215`; `docs/factory-map/01_DISCOVERY.md:172-217` |

## 6. B\F — reverse-only elements, classified

| Reverse id(s) | Class | Production-grounded disposition |
|---|---|---|
| `HOMELESS-REAL-PUBLISH-DEPLOY-PROVIDERS` | **missing production path** | CONFIRMED by inventory §2 item 4: exactly one release provider kind exists (`source-tag`); `source-release`/`package-publish`/`deployment` actions have NO in-repo trusted provider, so a policy declaring them can never truthfully settle `released` (`tracker-view/product-delivery-composition.mjs:64`; reverse homelessClaims). Missing PRODUCT obligation, not missing test evidence. |
| `R-RELEASED-TERMINAL` as the single root | **wrong root (partial)** | Correct for `released`; wrong as the ONLY root — the installed default lifecycle is product-build (`src/app/product-lifecycle-runtime.ts:991`; `src/app/composition-root.ts:299`). Root set corrected to the five roots in §3. The `released` spine additionally requires an authorized input whose fresh-launch producer is EXTERNAL (operator boundary; reverse uncertainty 1). |
| `EXT-COMPOSITION-PROVIDERS`, `EXT-RELEASE-POLICY-AND-GRANT`, `EXT-INITIATIVE-REPOSITORY-POLICY` | **open boundary (lawful)** | external by design; recorded in the open-boundary ledger §7, not as missing paths |
| `PROVIDER-DRY-RUN-FAIL-CLOSED` | **support** (negative invariant) | present in F as the default composition behavior (u5); B names it as a claim because for B it is a safety property ("dry-run can never release", `SAFE-DRY-RUN-CANNOT-RELEASE`) |
| safety/liveness/audit claim families (12+5+5) | **audit/safety/liveness lenses over F∩B nodes** | not new nodes: each maps onto forward nodes/edges (mapping in `graph-reconciliation.v1.json` `.safetyLens`, `.livenessLens`, `.auditLens`); they are the ROOT-SAFETY/LIVENESS/AUDITABILITY content F carries only implicitly |
| `STATE-PROCESSRUN-PINNED-REPLAY`, `AUDIT-NODERUN-V2-DURABLE`, `AUDIT-STAGE-TRANSITION-ROW` | **audit** | durable-walk guarantees inside `factory.terminal-settlement`/flow executor; F has the machinery, B names the audit obligation (dep-27, dep-02) |
| Reverse uncertainty 3 (Discovery/Formalization internals not expanded) | **coverage gap in B, closed by F** | the strata 01/02 provide the internals; reconciliation adopts them (BM-2..BM-5) rather than re-walking |

## 7. Open-boundary ledger (no closure claimed)

The reconciliation claims NO mathematical closure outside the decidable
fragment (§8). The following boundaries stay open by design and are tracked
here so no later proof silently absorbs them:

| Boundary id | What stays outside | Current disposition |
|---|---|---|
| `OPEN-MODEL` | Worker/model cognition (any LM output shape, monolithic documents, N-artifacts-one-hash corpora, evolving multi-round feedback) | scripted corpora are 1-2 rounds / small fixtures; production-scale shapes only partially covered (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:21-32`) |
| `OPEN-HUMAN` | Human approvals (`approve-release`), operator grants for fresh authorized launches, human_park resumes | inbox pending is demonstrated; live operator delay/lease-expiry is not CI-proven (`docs/factory-map/04_DELIVERY.md:496-516`); grant minting surface external (reverse uncertainty 1) |
| `OPEN-EXTERNAL-EFFECTS` | git hosts, registries, deployment targets; `source-release`/`package-publish`/`deployment` provider kinds | no in-repo trusted providers (§6 row 1); no-force/no-bypass proven against doubles only |
| `OPEN-CONCURRENCY` | Multi-host dispatch/effect claims; single-host read-then-assign caveat; concurrent duplicate terminals/observers | `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1054-1057`; dispatcher-race gates cover single host only |
| `OPEN-TIME` | Timing-dependent substrate (real-process readiness), watchdog stagnation windows, lease expiry, backoff clocks | readiness substrate suite is quarantined FLAKY (`tools/run-acceptance-matrix.mjs:192-194`); mixed time formats flagged by audit team 6 |
| `OPEN-ENVIRONMENT` | Windows-vs-linux host arms, docker-on-win32 (every readiness check UNKNOWN), CI runs ubuntu-only while production lives on win32 hosts | `docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:70-76`; `.github/workflows/ci.yml:11` (`runs-on: ubuntu-latest`) |
| `OPEN-REPLAY-BOUNDARY` | Replay capsule selection across ≥3 lifecycles (newest-wins binder), epic-scoped material accumulation, resume compatibility without implementation digests | declared divergent, NOT fixed (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1599-1620` conformance-status residuals table) |

## 8. Declared decidable fragment

Mechanically checkable HERE and NOW (deterministic, no model in the loop):
JSON parse + sourceRef non-emptiness + cross-file id resolution (§9); matrix
registry bijection (cc-proof-registry group, ADR-092); label honesty against
`tools/run-acceptance-matrix.mjs` + `.github/workflows/ci.yml` (TEST_COVERAGE);
scope containment arithmetic (`src/shared/repository-scope.ts` — exact-string
path semantics); register/§2.2 coverage diffs (decidable instances per ADR-088).
Everything else — semantic AC satisfaction, model obedience, external-state
truth, multi-host interleavings, timing — remains in §7 and is NOT claimed
proven. The S-rung of the testing ladder
(`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1166-1179`) is claimed only for
the named decidable instances; joint satisfiability of gate conjunctions is
recorded per-bridge in BRIDGE_MATRIX, with the Elite-8 counterexample as the
standing proof that the S question is real (BM-5).

## 9. Validation performed on this reconciliation

1. Both input graphs re-parsed as strict JSON at `12d46037`
   (`node -e require(...)` on both files).
2. Every `graph-reconciliation.v1.json` entry carries a non-empty `sourceRefs`
   array; every referenced forward node/edge id resolves in
   `forward-graph.v1.json` (68 nodes, e01-e93) and every reverse claim id
   resolves in `reverse-graph.v1.json` (45 claims, dep-01..28, SAFE/LIVE/AUD
   families, 1 homeless) — scripted check.
3. Cross-file IDs used by BRIDGE_MATRIX (BM-1..BM-15), STATE_MATRIX
   (SM-rows), ARTIFACT_LINEAGE (AL-rows), TEST_COVERAGE (TC-rows) resolve to
   entries in the JSON artifact.
4. Production citations spot-re-verified at `12d46037` by this reconciler:
   lifecycle default (`product-lifecycle-runtime.ts:991,1008`;
   `composition-root.ts:299-307`), six-package installation
   (`orchestrate-cli.ts:885-897`), task-shadow port
   (`product-lifecycle-runtime.ts:587-593` — `ORDER BY id DESC LIMIT 1`),
   scope containment semantics (`src/shared/repository-scope.ts`
   `repositoryScopeContainsPath`), §2.2 parser token extraction
   (`src/modules/development/domain/srs-module-manifest.ts:68,176-185`),
   §D2-derived scopes deliberately excluding §2.2
   (`src/modules/development/domain/srs-derived-change-scopes.ts:22-31`).
5. Scope guard: this reconciliation changed ONLY the seven files listed in the
   work order; `git status` shows no `src/`, `tests/`, or `dist/` changes; no
   builds, tests, live DB, processes, or network were run (read-only
   inspection + JSON/doc authoring).

## 10. Decisive mismatches (summary)

1. **Root asymmetry** — B roots only at `released`; installed default is
   product-build/`runnable-local` (§3, §6 row 2). Both retained; root set
   corrected to five roots.
2. **Homeless release providers** — B requires trusted providers for three of
   four action kinds; the repository ships one (§6 row 1). Missing production
   path, not missing tests.
3. **Task-shadow binding seam (P0)** — `readTaskForWorkplace` newest-wins
   (`product-lifecycle-runtime.ts:587-593`); recovery budget counted clean
   executions of the shadowed task and never engaged during Elite-8's 15
   deaths (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:80-86`;
   `docs/factory-map/03_DEVELOPMENT.md:580-601`). Neither graph models this
   port as a node; recorded in STATE_MATRIX (SM-14) and TEST_COVERAGE (TC-9).
4. **Elite-8 joint-satisfiability counterexample** — exact Formalization→
   Development handoff (hashes preserved) with accepted SRS §2.2 bare
   filenames unsatisfiable against §D2/§3 full paths (BM-5; details and code
   chain in BRIDGE_MATRIX §4).
5. **Coverage-universe gap** — 234/503 test files outside any CI path (219
   orphans + 15 quarantined); quarantine staleness (checked autonomous runs
   green; both PRE-EXISTING-RED reasons falsified on the current tree)
   (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:52-61,95-115`).
6. **Platform invisibility** — CI ubuntu-only while the factory's production
   hosts are win32 (§7 OPEN-ENVIRONMENT).
7. **ADR-053 residuals** — epic-scoped accumulation, newest-wins capsule
   binder, resume compatibility without implementation digests
   (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1599-1620`) — open, named,
   unchanged by this reconciliation.
