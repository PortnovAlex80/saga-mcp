// tests/infrastructure/adr-095-removal-inventory.mjs
//
// ADR-095 Phase-2B — the EXACT, machine-consumed Discovery-legacy removal
// inventory, now a COMPLETE partition (Phase-2A authored the classified
// baseline; Phase-2B closed it per the two independent audit corrections
// verified on 2026-08-24). This is NOT a test file (no *.test.mjs suffix,
// hosted by no matrix glob); it is the shared data module consumed by
// tests/architecture/adr-095-phase2-bridge-ratchets.test.mjs (blocking,
// architecture group) and available to every later ADR-095 phase.
//
// Phase-2B corrections applied (each independently re-verified, not trusted):
//   C1 the four package contribution data files have ZERO production
//      consumers except the unconsumed barrel (src reverse scan: manifest.ts
//      imports no contributions file; nothing outside contributions/ imports
//      the barrel). tool-contributions.ts is WHOLLY DEAD (all 9 rows are
//      ControlIntent-era tool-lane declarations for tools no MCP composition
//      registers) → reclassified to deadPhase4Files. The other three stay
//      partial-live with their dead rows now EXHAUSTIVELY classified
//      (output-contracts: normalization/diagnosis/brief bundle contracts;
//      acceptance-capabilities: runtime-persistence +
//      settlement-policy-repository + diagnosis-advisory; reviewer-skills:
//      normalizer + diagnosis-advisor pins).
//   C2 discovery-domain-contracts.ts is NOT fully-kept: its only src
//      importers are the LIVE discovery-process-module.ts (exactly 5
//      constants) and two DEAD files (discovery-installation.ts,
//      discovery-outcome-certificate-projection.ts). Reclassified
//      partial-live with every row classified: 5 live constants, 56
//      legacy-only rows (incl. the whole DiscoveryRuntimePersistencePort /
//      DiscoverySettlementPort surfaces and every mirror constant whose LIVE
//      definition lives in the live domain files).
//   C3 the legacy test inventory is EXACT PATHS, not a d1-d7 wildcard: four
//      LIVE unhosted suites (d1-1-authority, d1-1-binding, d3-readiness-domain,
//      d4-settlement-policy — green in isolation 62/62, 2026-08-24) are
//      hosted BLOCKING in the discovery-live-v2 matrix group in Phase-2B;
//      five mixed suites (d3/d4 architecture-boundary, d4-settlement-recovery
//      (m6a live block), mcp-catalog-authority-errors,
//      conveyor-v4.3-focused-invariants) carry migrate-preserving-live-
//      assertions actions at the phase that kills their dead surface; every
//      other legacy-only test has an exact delete action with its
//      exclusive-legacy justification; _conveyor-fakes.mjs is classified
//      (helper consumed only by two delete-classified suites).
//   C4 skills/saga-kickstart/SKILL.md is KEPT (live resource pinned by
//      DISCOVERY_KICKSTART_REVIEWER_SKILL, pinnedByProfile 'package-optional');
//      it was missing from the Phase-2A surface partition.
//   C5 missing same-commit obligations recorded for EVERY hosted dead
//      importer: kernel-admission-distance (sqlite-discovery-runtime.ts:413
//      linkType copy + settlement-debug DRIFT register anchor + drift count
//      16→15), v4-target-conformance (REG-11 proposal-ref-bridge existence),
//      work-intent-contract-immutability, handler-digest-runtime-consistency,
//      discovery-package-contributions, migration-conformance, the hosted
//      discovery-outcome-certificate-projection.test.mjs, and the hosted
//      factory-proof workshop-inventory baseline (pins dead projection +
//      handler-adapter dependency edges).
//   C6 completeness is PROVEN, not claimed: a bidirectional scoped partition
//      scan (scopedPartitionScan) walks the scoped src trees (all of
//      src/modules/discovery, all of src/process-modules/modules/discovery,
//      the four src/tools/discovery-*.ts), the scoped test trees (all of
//      tests/discovery, all of tests/modules/discovery), every individually
//      scoped out-of-tree test/fixture, and the six relevant skills, and
//      asserts every file is in EXACTLY ONE partition bucket (dead | kept |
//      partial-live | legacy-test | hosted-importer). Mutation negatives in
//      the bridge suite (BR6) prove the scan fails on an unclassified file,
//      a missing classified file, and a double classification.
//
// Phase semantics follow ADR-095's normative phase order:
//   phase 3 = live side-effect removal FIRST (writes stop while tables exist);
//   phase 4 = atomic version bump + manifest repin + dead code/resource
//             deletion + existing-DB boot test (one commit);
//   phase 5 = fresh-schema closure removal from SCHEMA_SQL (no DROP).
// AMENDED at Phase 3.1 (2026-08-24): deadPhase3[0] (the products.ts
// projection block) is EXECUTED; AMENDED at Phase 3.2 (2026-08-24):
// deadPhase3[1] (the settlement-debug legacy Discovery query) is EXECUTED
// in the canonical lineage; every deadPhase3 entry now carries
// status/contentMarkers enforced machine-side by the validator (see the
// deadPhase3 section comment). No bucket changed; no file deleted; the
// presence counter is untouched (phase 3 contributes code-blocks only).
// AMENDED at the canonical Phase-3.3 integration (2026-08-24): deadPhase3[2]
// (the runtimePersistence construction in product-lifecycle-runtime.ts) and
// deadPhase3[3] (the ModuleSharedDeps.runtimePersistence field) are EXECUTED
// (authored on the stage22/discovery-phase3-3 branch line over the Phase-2C
// + 3.1 base, integrated by union cherry-pick over the canonical 3.1 + 3.2
// lineage) — the shared runtime-persistence port construction is gone from
// the live composition, so every ensure*/lazy CREATE TABLE IF NOT EXISTS
// recreation site reachable through that port is inert (their only
// remaining definers are deadPhase4Files, which die at the phase-4 cutover
// BEFORE the phase-5 schema work — F2 ordering). ALL FOUR deadPhase3
// entries are EXECUTED and the pending set is EMPTY (Phase 3 exit).
// `entry.kind`:
//   file        — a whole source file deleted at the phase;
//   resource    — a package resource file deleted at the phase;
//   code-block  — a removal INSIDE a file that itself stays live (kept);
//   symbol      — a named export/constant surface reduced/repinned at the
//                 phase (e.g. DISCOVERY_HANDLER_REFS), not a whole file;
//   table/index — fresh-DB schema objects removed from SCHEMA_SQL (phase 5).

import fs from 'node:fs';
import path from 'node:path';

function joinPath(root, rel) {
  return path.join(root, ...rel.split('/'));
}

export const ADR_095_INVENTORY = Object.freeze({
  schemaVersion: 3,
  decision: 'ADR-095',
  phaseAuthored: '2C',
  authoredAt: '2026-08-24',
  authorities: Object.freeze([
    'docs/architecture/decisions/095-complete-removal-of-dead-discovery-legacy.md',
    'docs/factory-map/01_DISCOVERY.md',
    'docs/factory-map/GRAPH_RECONCILIATION.md',
    'docs/factory-run/stage22-elite9/DISCOVERY-PHASE1-CENSUS.md',
    'docs/factory-run/stage22-elite9/PRE-ELITE9-TRACKER.md',
  ]),

  // The ADR-095 six-handler legacy baseline (Phase-1 census: the persisted
  // handler logical IDs of the active product-discovery@3.0.2 installation in
  // all 19 censused factory DBs). Exactly one id is LIVE; the other five are
  // RETIRED by the cutover.
  legacyHandlerIds: Object.freeze([
    'discovery-resolve-proposal-submission',
    'discovery-prepare-normalization',
    'discovery-resolve-normalized-proposal',
    'discovery-prepare-readiness',
    'discovery-resolve-readiness',
    'discovery-settlement-policy',
  ]),
  liveHandlerId: 'discovery-settlement-policy',
  moduleIdentity: Object.freeze({
    name: 'product-discovery',
    version: '3.0.2',
    versionPinPath: 'src/process-modules/lifecycles/product-delivery-module-contracts.ts',
  }),

  // -------------------------------------------------------------------------
  // DEAD — phase 3: live write-side effects removed FIRST (F1/F2 ordering).
  // Every entry removes a WRITE or a lazy-recreation site while the legacy
  // tables still exist; nothing here deletes a production legacy file.
  //
  // Phase-3.1 (2026-08-24): entry[0] (the products.ts projection block) is
  // EXECUTED; Phase-3.2 (2026-08-24): entry[1] (the settlement-debug legacy
  // Discovery query) is EXECUTED in the canonical lineage. Machine
  // truthfulness: every entry carries `status` ('executed'|'pending') plus
  // `contentMarkers` (strings that MUST be absent from the host file once
  // executed, MUST be present while pending) — validateAdr095Inventory
  // enforces BOTH directions against the on-disk host file, so the
  // executed/pending claim can never drift from the code truth.
  //
  // Phase-3.3 (2026-08-24; authored on branch stage22/discovery-phase3-3,
  // integrated into the canonical lineage by the union cherry-pick over
  // 3.1 + 3.2): entries[2] (the runtimePersistence construction) and [3]
  // (the ModuleSharedDeps field) are EXECUTED. Canonical merged truth: ALL
  // FOUR entries are EXECUTED (3.1, 3.2, 3.3, 3.3) and the pending set is
  // EMPTY — the Phase-3 exit state; Phase 4 remains pending.
  // -------------------------------------------------------------------------
  deadPhase3: Object.freeze([
    Object.freeze({
      kind: 'code-block',
      path: 'src/tools/products.ts',
      status: 'executed',
      executedAt: '2026-08-24',
      executedIn: 'Phase 3.1',
      contentMarkers: Object.freeze([
        'projectDiscoveryProposal',
        'requiresDiscoveryProjection',
        'PROPOSAL_REF_SCHEMA',
        'discovery_proposal_id',
      ]),
      detail: 'product_submit discovery projection block (requiresDiscoveryProjection/' +
        'projectDiscoveryProposal call + PROPOSAL_REF_SCHEMA product emission), the ' +
        'projectDiscoveryProposal/PROPOSAL_REF_SCHEMA imports, and the ' +
        'discovery_proposal_id response field — REMOVED (Phase 3.1, 2026-08-24); ' +
        'product_submit is projection-free; Discovery proposals are ordinary typed products',
      evidence: 'ADR-095 Decision 1 bullet 1; 01_DISCOVERY.md map §PURPOSE edge 5 (LIVE WRITER); ' +
        'reverse-dep scan: products.ts was the only src importer of discovery-proposal-projection',
      sameCommitObligations: Object.freeze([
        'tests/replay/conveyor-v4.3-focused-invariants.test.mjs imported ' +
        'dist/modules/discovery/infrastructure/discovery-proposal-projection.js — ' +
        'MIGRATED in the SAME Phase-3.1 commit, preserving live assertions (see ' +
        'legacyTests entry: invariant 5 "Discovery proposal is a schema projection behind ' +
        'universal product_submit" re-pointed to the projection-free product_submit seam ' +
        'with negative proofs that the legacy projection cannot be recreated/provided; the ' +
        'live replay/routing/authority invariants stay)',
      ]),
    }),
    Object.freeze({
      kind: 'code-block',
      path: 'src/tools/settlement-debug.ts',
      status: 'executed',
      executedAt: '2026-08-24',
      executedIn: 'Phase 3.2',
      contentMarkers: Object.freeze(['factory_discovery_settlements']),
      detail: 'settlement_explain legacy Discovery query over factory_discovery_settlements ' +
        '(discoverySettlement block) — REMOVED (Phase 3.2, 2026-08-24); the TOOL ITSELF ' +
        'STAYS for non-Discovery traces; the discoverySettlement response key is gone',
      evidence: 'ADR-095 Decision 1 bullet 1; map CONTRADICTIONS context (settlement-debug.ts:117-139); ' +
        'corroborating code fact: the legacy query selected ds.process_run_id/ds.settlement_hash, ' +
        'columns absent from the D4 DDL, so better-sqlite3 prepare() always threw and the ' +
        'catch block swallowed it — the block could never return data on the current schema',
      sameCommitObligations: Object.freeze([
        'tests/architecture/kernel-admission-distance.test.mjs (BLOCKING-hosted, architecture ' +
        'group) carried DRIFT_REPORTED anchor "module_ref_key === \'discovery\'" on this file ' +
        'plus FROZEN_REGISTER_COUNTS drift:16 — SATISFIED in the same Phase-3.2 commit ' +
        '(anchor dropped, drift 16→15; code evidence: exactly this one behavioural site died)',
        'ADDITIONAL same-commit repin discovered during execution (not recorded at Phase-2C): ' +
        'tests/architecture/v4-target-conformance-ratchet.test.mjs ALLOWED_TASK_KIND_SWITCHES ' +
        'whitelisted src/tools/settlement-debug.ts (its honest-shrinkage test fails on dead ' +
        'entries) — SATISFIED: entry removed in the same Phase-3.2 commit',
        'tableAllowedOutsideSpecific below dropped its factory_discovery_settlements live ' +
        'site and checkR3 dropped the settlement-debug pre-cutover table allowance in the ' +
        'same Phase-3.2 commit — reintroducing the query is RED from every arm',
      ]),
    }),
    Object.freeze({
      kind: 'code-block',
      path: 'src/app/product-lifecycle-runtime.ts',
      status: 'executed',
      executedAt: '2026-08-24',
      executedIn: 'Phase 3.3',
      contentMarkers: Object.freeze(['discoveryRuntimePersistence', 'SqliteFactoryDiscoveryRuntime']),
      detail: 'the shared runtimePersistence construction (options.discoveryRuntimePersistence ' +
        '?? new SqliteFactoryDiscoveryRuntime()) and its runtimePersistence hand-off into ' +
        'module registration — REMOVED (Phase 3.3, 2026-08-24); the file ITSELF STAYS; the ' +
        'constructor was the ONLY live entry to the ensure*/lazy CREATE TABLE IF NOT EXISTS ' +
        'recreation sites (pre-mortem F2), so they are inert until their deadPhase4Files ' +
        'deletion at phase 4',
      evidence: 'ADR-095 Decision 3 (F2); map STRATA 4; 01_DISCOVERY.md §6.4',
      sameCommitObligations: Object.freeze([
        'tests/architecture/adr-095-phase3-runtime-persistence-removal.test.mjs (BLOCKING-hosted ' +
        'by the architecture glob) proves the removal behaviorally: the REAL ' +
        'createProductLifecycleRuntime composition over a REAL getDb() database no longer ' +
        'regrows the ten-table legacy closure after it is dropped from the test DB (the F2 ' +
        'counterfactual), factory_work_intents stays live with its paused status transition, ' +
        'and the src absence arms pin the construction/port/field to the dead files only ' +
        '(hosted dead-importer entry records its Phase-4 positive-control obligation)',
      ]),
    }),
    Object.freeze({
      kind: 'code-block',
      path: 'src/modules/module-registration.ts',
      status: 'executed',
      executedAt: '2026-08-24',
      executedIn: 'Phase 3.3',
      contentMarkers: Object.freeze(['runtimePersistence']),
      detail: 'the ModuleSharedDeps.runtimePersistence field (FactoryDiscoveryRuntimePersistence ' +
        'type import + field) — REMOVED (Phase 3.3, 2026-08-24); the file ITSELF STAYS; the ' +
        'shared module-registration contract carries no Discovery legacy port',
      evidence: 'ADR-095 Decision 3 (F2); module-registration.ts:23,64',
      sameCommitObligations: Object.freeze([]),
    }),
  ]),

  // -------------------------------------------------------------------------
  // DEAD — phase 4: the atomic cutover commit (module-version bump + manifest
  // repin to the production-cell digest + code/resource deletion).
  // Phase-2B count: 27 files (Phase-2A 26 + tool-contributions.ts per C1).
  // -------------------------------------------------------------------------
  deadPhase4Files: Object.freeze([
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/discovery-proposal-projection.ts',
      detail: 'the product_submit → factory_proposals projection implementation. Its LAST live ' +
        'consumption (the products.ts block) was removed in Phase 3.1 (2026-08-24); 0 src ' +
        'importers remain — the file deletion lands with the phase-4 code deletion',
      evidence: 'ADR-095 Decision 1 bullet 1 + pre-mortem F1 (the LIVE WRITER; writer removed FIRST, ' +
        'schema only at phase 5); src reverse-dep scan at Phase 3.1: products.ts no longer imports it',
      sameCommitObligations: Object.freeze([
        'phase 3 must remove the products.ts projection block FIRST (deadPhase3[0]) — DONE ' +
        '(Phase 3.1, 2026-08-24, status:executed); tests/replay/conveyor-v4.3-focused-invariants ' +
        '.test.mjs MIGRATED in the same Phase-3.1 commit (see its legacyTests entry)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/discovery-installation.ts',
      detail: 'the dead six-handler ControlIntent factory createDiscoveryKernelHandlers ' +
        '(registers all six legacyHandlerIds; CONTRADICTION 1 source) + ' +
        'createDiscoveryWorkplacePersistence',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 1; src reverse-dep scan: ' +
        'only callers are the dead package adapter + a type-only import',
      sameCommitObligations: Object.freeze([
        're-home the DiscoveryBriefProvisioningPort/Context types imported (type-only) by ' +
        'src/infrastructure/process-modules/brief-provisioning-ports.ts',
        'update the hosted blocker suite ' +
        'tests/architecture/handler-digest-runtime-consistency.test.mjs (imports this module ' +
        'via dist; ADR-095 six-blocker list; repin to the one-handler production-cell digest)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-proposal-tools.ts',
      detail: 'dead MCP discovery proposal tool (proposal_submit lane); no MCP composition import',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 3; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs imports it — MIGRATE per ' +
        'its legacyTests action (live catalog/authority/error-normalization assertions stay; ' +
        'the pinned sorted tool-name set drops the dead discovery tools)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-normalization-tools.ts',
      detail: 'dead MCP normalization tool',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 3; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs, ' +
        'tests/discovery/d2-normalization-lineage.test.mjs import it (d2 line: DELETE per its ' +
        'legacyTests action; mcp-catalog: MIGRATE)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-readiness-tools.ts',
      detail: 'dead MCP readiness tool',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 3; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs, ' +
        'tests/discovery/d3-readiness-{correction,handler,index-migration}.test.mjs import it ' +
        '(d3 line: DELETE per legacyTests actions; mcp-catalog: MIGRATE)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-tool-args.ts',
      detail: 'shared helpers of the three dead MCP discovery tools only',
      evidence: 'ADR-095 Decision 1 bullet 2; src reverse-dep scan: imported ONLY by the three dead ' +
        'tool files (src/application/actionable-tool-error.ts references it in COMMENTS only — ' +
        'stale comment cleanup, not a code dependency)',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs, ' +
        'tests/discovery/tool-actionable-errors.test.mjs import it (tool-actionable-errors: ' +
        'DELETE per its legacyTests action — it pins ONLY the dead args helpers; mcp-catalog: ' +
        'MIGRATE — its enrichPayloadErrors/FACTORY_TOOL_CALL_SHAPES lanes re-point to the live ' +
        'parameterized surface src/application/actionable-tool-error.ts or delete with the tools)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/discovery-settlement-service.ts',
      detail: 'legacy FactoryDiscoverySettlementService — no production construction site',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 2; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d4-settlement-{persistence,recovery}.test.mjs, ' +
        'tests/discovery/d5-certificate-bundle.test.mjs import it (d4-persistence/d5: DELETE per ' +
        'legacyTests actions; d4-recovery: MIGRATE preserving the m6a live block)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/discovery-normalization-service.ts',
      detail: 'legacy D2 normalization service — 0 src importers',
      evidence: 'ADR-095 Decision 1 bullet 2 ("discovery-normalization*.ts" residue family); src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d2-normalization-lifecycle.test.mjs imports it (unhosted legacy-only consumer)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/discovery-readiness-service.ts',
      detail: 'legacy readiness service — 0 src importers',
      evidence: 'ADR-095 Decision 1 bullet 2 residue family; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d3-readiness-correction.test.mjs imports it (unhosted legacy-only consumer)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/discovery-certificate-bundle.ts',
      detail: 'legacy certificate bundle — imported only by the dead settlement service',
      evidence: 'ADR-095 Decision 1 bullet 2 (named residue); src reverse-dep scan: sole importer is discovery-settlement-service.ts',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d5-certificate-bundle.test.mjs imports it (unhosted legacy-only consumer)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/ensure-discovery-workspace.ts',
      detail: 'legacy workspace provisioning (stale stage-tracker.md lane) — 0 src importers',
      evidence: 'ADR-095 Decision 1 bullet 2 (named residue); pre-mortem F2 ("provisions legacy workspace state"); src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d1-workspace-creation.test.mjs imports it (unhosted legacy-only consumer)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/discovery-outcome-certificate-projection.ts',
      detail: 'read-only legacy certificate projection — 0 src importers',
      evidence: 'ADR-095 Decision 1 bullet 2 (named residue); src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/execution/migration-conformance.test.mjs (BLOCKING-hosted in the process-modules ' +
        'matrix group since Phase-2A) imports it via dist — MANDATORY same-commit phase-4 ' +
        'repin/delete-list migration, see mandatoryPhase4Repins below',
        'tests/process-modules/discovery-outcome-certificate-projection.test.mjs (BLOCKING-hosted ' +
        'by the process-modules glob) imports it via dist — same-commit migrate-or-delete',
        'tests/factory-proof/workshop-inventory.baseline.json (hosted by the factory-proof group) ' +
        'pins the "discovery-outcome-certificate-projection.ts (modules->legacy)" dependency ' +
        'edge — regenerate the baseline in the same commit (see hostedDeadImporters)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/discovery-normalization-repository.ts',
      detail: 'D2 repository: lazy CREATEs factory_raw_submissions/factory_control_intents/' +
        'factory_normalization_proposals on construction; after phase 3 no src caller remains',
      evidence: 'ADR-095 Decision 1 bullet 3; pre-mortem F2; src reverse-dep scan: importers are ' +
        'the dead tools, the dead projection (removed phase 3), sibling dead repos, sqlite-discovery-runtime',
      sameCommitObligations: Object.freeze([
        'unhosted legacy-only test consumers: tests/discovery/d2-normalization-lineage, ' +
        'd3-readiness-{correction,handler,index-migration}, d4-settlement-atomicity',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/discovery-readiness-repository.ts',
      detail: 'D3 shadow readiness repository: lazy CREATEs the readiness closure on construction',
      evidence: 'ADR-095 Decision 1 bullet 3; pre-mortem F2; src reverse-dep scan: importers are ' +
        'the dead readiness tool + sqlite-discovery-runtime',
      sameCommitObligations: Object.freeze([
        'unhosted legacy-only test consumers: tests/discovery/d3-readiness-*, d4-settlement-*, d5-certificate-bundle',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/discovery-settlement-repository.ts',
      detail: 'D4 repository: lazy CREATEs factory_discovery_settlements/' +
        'factory_discovery_outcome_certificates on construction',
      evidence: 'ADR-095 Decision 1 bullet 3; pre-mortem F2; src reverse-dep scan: sole src importer is sqlite-discovery-runtime',
      sameCommitObligations: Object.freeze([
        'tests/execution/migration-conformance.test.mjs (BLOCKING-hosted since Phase-2A) imports ' +
        'it via dist — MANDATORY same-commit phase-4 repin/delete-list migration, see mandatoryPhase4Repins',
        'unhosted legacy-only test consumers: tests/discovery/d4-settlement-*, d5-certificate-bundle',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/discovery-proposal-repository.ts',
      detail: 'D3 proposal row repository (factory_proposals)',
      evidence: 'ADR-095 Decision 1 bullet 3; src reverse-dep scan: sole src importer is sqlite-discovery-runtime',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts',
      detail: 'the legacy DiscoveryRuntimePersistencePort implementation (shared substrate whose ' +
        'construction is removed in phase 3). Its ensure*/lazy CREATE TABLE IF NOT EXISTS ' +
        'recreation sites (pre-mortem F2) die WITH the file: phase 3 removes the only live ' +
        'construction so the sites are inert, and the F2 ordering invariant (every lazy-recreate ' +
        'site gone BEFORE phase-5 schema work) holds because phase 4 precedes phase 5',
      evidence: 'ADR-095 Decision 1 bullet 3 + Decision 3; 01_DISCOVERY.md STRATA 4; sole src importer: product-lifecycle-runtime.ts:349-350',
      sameCommitObligations: Object.freeze([
        'tests/architecture/work-intent-contract-immutability.test.mjs (BLOCKING-hosted, ' +
        'architecture glob) imports it via dist — re-point its fixture at the kept ' +
        'factory_work_intents schema (the TABLE STAYS; only this adapter import dies)',
        'tests/architecture/kernel-admission-distance.test.mjs (BLOCKING-hosted, architecture ' +
        'glob) pins src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts:413 as one ' +
        'of the EXACT THREE linkType behavioural copies — same-commit re-pin of the copies list ' +
        '(three → two: the projection-persistence and tasks.ts copies remain)',
        'unhosted legacy-only test consumers: tests/discovery/d4-settlement-atomicity, ' +
        'd4-settlement-persistence, d4-settlement-recovery (migrate: m6a block stays), d5-certificate-bundle',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/discovery-runtime-port.ts',
      detail: 'the legacy runtime-persistence port types (FactoryDiscoveryRuntimePersistence); its ' +
        'two live type consumers (module-registration.ts, product-lifecycle-runtime.ts) lose the ' +
        'field in phase 3',
      evidence: 'ADR-095 Decision 1 bullet 3; src reverse-dep scan: remaining importers after phase 3 are dead files only',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/domain/proposal.ts',
      detail: 'legacy Proposal domain record (factory_proposals row shape)',
      evidence: 'ADR-095 Decision 1 bullet 2 (named residue); src reverse-dep scan: imported only by dead-lane files',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/domain/proposal-ref-bridge.ts',
      detail: 'PROPOSAL_REF_SCHEMA bridge (its live emission from products.ts was removed in ' +
        'Phase 3.1, 2026-08-24)',
      evidence: 'ADR-095 Decision 1 bullet 1+2; src reverse-dep scan: after Phase 3.1 only the dead proposal tool imports it',
      sameCommitObligations: Object.freeze([
        'tests/modules/discovery/proposal-ref-bridge.test.mjs imports it (unhosted legacy-only consumer — DELETE)',
        'tests/architecture/v4-target-conformance-ratchet.test.mjs (BLOCKING-hosted, architecture ' +
        'glob) asserts REG-11 "proposal-ref bridge for Discovery exists" via existsSync — ' +
        'same-commit removal/replacement of REG-11 (see hostedDeadImporters)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/domain/discovery-normalization.ts',
      detail: 'legacy D2 normalization domain',
      evidence: 'ADR-095 Decision 1 bullet 2 ("discovery-normalization*.ts"); src reverse-dep scan: importers are dead-lane only',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d2-normalization.test.mjs imports it (unhosted legacy-only consumer)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/domain/discovery-normalization-records.ts',
      detail: 'legacy D2 records',
      evidence: 'ADR-095 Decision 1 bullet 2 ("discovery-normalization*.ts"); src reverse-dep scan: importers are dead-lane only',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/domain/discovery-normalization-proposal.ts',
      detail: 'legacy D2 normalization-proposal domain',
      evidence: 'ADR-095 Decision 1 bullet 2 ("discovery-normalization*.ts"); src reverse-dep scan: importers are sqlite-discovery-runtime + dead tool',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d2-normalization{,-lineage}.test.mjs import it (unhosted legacy-only consumers)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/domain/discovery-outcome-certificate.ts',
      detail: 'legacy D4 outcome-certificate domain record',
      evidence: 'ADR-095 Decision 1 bullet 2 (named residue); src reverse-dep scan: importers are the dead settlement service + certificate bundle',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d4-settlement-atomicity.test.mjs imports it (unhosted legacy-only consumer)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/domain/discovery-readiness-records.ts',
      detail: 'legacy D3 readiness records',
      evidence: 'ADR-095 Decision 1 bullet 2 (named residue); src reverse-dep scan: importers are dead-lane only',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/process-modules/modules/discovery/package/contributions/handler-adapter.ts',
      detail: 'the never-invoked package adapter — the ONLY caller of the dead six-handler factory; ' +
        'mirrors the five retired handler ids (DISCOVERY_PACKAGE_HANDLER_IDS)',
      evidence: 'ADR-095 Decision 1 bullet 4; 01_DISCOVERY.md STRATA 1; src reverse-dep scan: sole importer is contributions/index.ts (barrel)',
      sameCommitObligations: Object.freeze([
        'drop the barrel re-exports from package/contributions/index.ts in the same commit (its ' +
        'handler-adapter block is a partialLive dead row — see partialLiveFiles)',
        'update tests/process-modules/discovery-package-contributions.test.mjs (BLOCKING-hosted; ' +
        'ADR-095 six-blocker list) to pin the live one-handler contributions',
        'tests/factory-proof/workshop-inventory.baseline.json pins the "handler-adapter.ts ' +
        '(legacy->modules)" dependency edge — regenerate the baseline in the same commit',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/process-modules/modules/discovery/package/contributions/tool-contributions.ts',
      detail: 'WHOLLY DEAD (Phase-2B correction C1): all 9 rows are ControlIntent-era tool-lane ' +
        'declarations (proposal_submit, normalization_get/submit, readiness_get/submit, ' +
        'diagnosis_get/submit, artifact_create.brief, worker_done) for tools no MCP composition ' +
        'registers; the manifest (W9-A1) imports NONE of this — it declares its own inline ' +
        'resourceIndex/contract refs — and the barrel re-exporting it has zero production importers',
      evidence: 'src reverse-dep scan 2026-08-24: zero src importers outside package/contributions/; ' +
        'manifest.ts imports only discovery-process-module.js + assistance.js + domain SPI files; ' +
        'the W9-A2 doc-claim "the manifest spreads this into ProcessModuleManifest.toolContributions" ' +
        'is not realized in code',
      sameCommitObligations: Object.freeze([
        'drop the tool-contributions re-export block from package/contributions/index.ts in the ' +
        'same commit (partialLive dead row)',
        'update tests/process-modules/discovery-package-contributions.test.mjs (BLOCKING-hosted; ' +
        'imports this file via dist) to pin the live one-handler contributions without the ' +
        'tool-contribution lanes',
      ]),
    }),
  ]),

  deadPhase4Resources: Object.freeze([
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-normalizer/SKILL.md',
      detail: 'dead normalizer lane execution skill (manifest logicalId discovery.skill.normalizer)',
      evidence: 'ADR-095 Decision 1 bullet 5 (dead-lane skills); 01_DISCOVERY.md STRATA 5/CONTRADICTION 3',
      sameCommitObligations: Object.freeze([
        'drop the discovery.skill.normalizer resourceIndex entry (manifest.ts inline index) + ' +
        'reviewer-skills pin (DISCOVERY_NORMALIZER_SKILL dead row) in the same commit',
      ]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-diagnosis-advisor/SKILL.md',
      detail: 'dead diagnosis lane execution skill (logicalId discovery.skill.diagnosis-advisor)',
      evidence: 'ADR-095 Decision 1 bullet 5; 01_DISCOVERY.md STRATA 5 (diagnosis flow deleted from the module)',
      sameCommitObligations: Object.freeze([
        'drop the discovery.skill.diagnosis-advisor resourceIndex entry (manifest.ts inline ' +
        'index) + reviewer-skills pin (DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL dead row) ' +
        'in the same commit',
      ]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/normalization-call-template.json',
      detail: 'dead normalizer lane call template (logicalId discovery.template.normalization-call)',
      evidence: 'ADR-095 Decision 1 bullet 5 (call-templates); no live profile references the lane',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/normalization-stage-tracker.md',
      detail: 'dead normalizer lane tracker (logicalId discovery.tracker.normalization-stage)',
      evidence: 'ADR-095 Decision 1 bullet 5 (trackers)',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/normalization-checklist.md',
      detail: 'dead normalizer lane checklist (logicalId discovery.checklist.normalization)',
      evidence: 'ADR-095 Decision 1 bullet 5 (checklists)',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/diagnosis-call-template.json',
      detail: 'dead diagnosis lane call template (logicalId discovery.template.diagnosis-call)',
      evidence: 'ADR-095 Decision 1 bullet 5',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/diagnosis-stage-tracker.md',
      detail: 'dead diagnosis lane tracker (logicalId discovery.tracker.diagnosis-stage)',
      evidence: 'ADR-095 Decision 1 bullet 5',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/diagnosis-checklist.md',
      detail: 'dead diagnosis lane checklist (logicalId discovery.checklist.diagnosis)',
      evidence: 'ADR-095 Decision 1 bullet 5',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/stage-tracker.md',
      detail: 'legacy root workspace stage-tracker template — sole consumer is the dead ' +
        'ensure-discovery-workspace.ts provisioning (NOT part of the manifest resourceIndex)',
      evidence: 'repo grep: only ensure-discovery-workspace.ts:144 consumes this exact template ' +
        '(the other stage-tracker references are formalization/development packages or the LIVE ' +
        'proposal/readiness trackers); ADR-095 Decision 1 bullet 5 trackers family',
      sameCommitObligations: Object.freeze([]),
    }),
  ]),

  // Symbol-level phase-4 surface (the atomic manifest boundary, ADR-095
  // Decision 4 / F5 STOP-SHIP): one commit bumps product-discovery to a
  // strictly higher version, reduces DISCOVERY_HANDLER_IDS/DISCOVERY_HANDLER_REFS
  // to exactly the live settlement ref, and repins the digest to the EXECUTED
  // dist bytes of discovery-production-cell-installation.js.
  deadPhase4Symbols: Object.freeze([
    Object.freeze({
      kind: 'symbol',
      path: 'src/process-modules/modules/discovery/package/manifest.ts',
      detail: 'DISCOVERY_HANDLER_IDS/DISCOVERY_HANDLER_REFS reduced to exactly ' +
        'discovery-settlement-policy; DISCOVERY_HANDLER_IMPLEMENTATION_DIGEST repinned to the ' +
        'production-cell installation bytes; product-discovery version bumped ATOMICALLY; the ' +
        'inline resourceIndex drops its dead-lane entries (discovery.skill.normalizer, ' +
        'discovery.skill.diagnosis-advisor — see deadPhase4Resources obligations)',
      evidence: 'ADR-095 Decision 4 + pre-mortem F3/F5; 01_DISCOVERY.md STRATA 6 + CONTRADICTIONS 1-2',
      sameCommitObligations: Object.freeze([
        'same-commit version bump at src/process-modules/lifecycles/product-delivery-module-contracts.ts:30-33',
        'same-commit update of tests/architecture/handler-digest-runtime-consistency.test.mjs ' +
        '(re-pin from the six-handler legacy digest to the one-handler production-cell digest — ratchet 2)',
        'same-commit update of tests/process-modules/discovery-package-contributions.test.mjs',
      ]),
    }),
  ]),

  // -------------------------------------------------------------------------
  // DEAD — phase 5: fresh-schema closure removal from SCHEMA_SQL (NO DROP of
  // existing user tables; existing DBs keep everything as inert history).
  // -------------------------------------------------------------------------
  deadPhase5Tables: Object.freeze([
    'factory_proposals',
    'factory_raw_submissions',
    'factory_control_intents',
    'factory_normalization_proposals',
    'factory_readiness_control_intents',
    'factory_readiness_assessments',
    'factory_discovery_settlements',
    'factory_discovery_outcome_certificates',
    'factory_discovery_diagnosis_control_intents',
    'factory_discovery_diagnosis_reports',
  ]),
  deadPhase5Indexes: Object.freeze([
    'idx_factory_proposals_intent',
    'idx_factory_proposals_task',
    'idx_factory_proposals_kind',
    'idx_factory_proposals_idempotency',
    'idx_factory_raw_submission_idempotency',
    'idx_factory_raw_submission_intent',
    'idx_factory_normalization_idempotency',
    'idx_factory_control_epic',
    'idx_factory_readiness_control_target',
    'idx_factory_readiness_assessment_idempotency',
    'idx_factory_readiness_control_epic',
    'idx_factory_readiness_assessment_control',
    'idx_factory_settlement_input',
    'idx_factory_settlement_epic',
    'idx_factory_diagnosis_control_target',
    'idx_factory_diagnosis_control_epic',
    'idx_factory_diagnosis_reports_control',
    'idx_factory_diagnosis_reports_idempotency',
    'idx_factory_diagnosis_reports_one_accepted',
  ]),

  // -------------------------------------------------------------------------
  // KEPT LIVE — the explicit preserved surface (ADR-095 Decision 5).
  // FULLY-KEPT entries (productionFiles, liveResources, testFiles, kept
  // tables/indexes/triggers): nothing may be deleted, weakened, or repointed
  // by any phase. PARTIAL-LIVE entries (partialLiveFiles): kept AS FILES —
  // row-level repoint/removal inside them is allowed (and partly REQUIRED by
  // phase-4 same-commit obligations) while whole-FILE deletion is FORBIDDEN.
  // Phase-2B: every partial-live file's rows are EXHAUSTIVELY classified
  // (liveRows + deadRows) — the Phase-2A "unresolved" row questions are
  // CLOSED (C1/C2); discovery-domain-contracts.ts moved here from
  // productionFiles; tool-contributions.ts moved OUT to deadPhase4Files.
  // -------------------------------------------------------------------------
  keptLive: Object.freeze({
    productionFiles: Object.freeze([
      'src/modules/discovery/index.ts',
      'src/modules/discovery/application/discovery-production-cell-installation.ts',
      'src/modules/discovery/application/discovery-check-providers.ts',
      'src/modules/discovery/domain/discovery-proposal.ts',
      'src/modules/discovery/domain/discovery-readiness-assessment.ts',
      'src/modules/discovery/domain/discovery-settlement-policy.ts',
      'src/modules/discovery/domain/discovery-settlement-input.ts',
      'src/modules/discovery/domain/discovery-settlement-records.ts',
      'src/process-modules/modules/discovery/discovery-process-module.ts',
      'src/process-modules/modules/discovery/package/manifest.ts',
      'src/process-modules/modules/discovery/package/assistance.ts',
      'src/process-modules/modules/discovery/package/index.ts',
      'src/tools/products.ts',
      'src/tools/settlement-debug.ts',
      'src/app/product-lifecycle-runtime.ts',
      'src/modules/module-registration.ts',
      'src/infrastructure/process-modules/brief-provisioning-ports.ts',
      'src/process-modules/lifecycles/product-delivery-module-contracts.ts',
    ]),
    // KEPT AS FILES with row-level dead/live classification (Phase-2B: every
    // row classified; whole-file deletion forbidden; dead rows die at the
    // phase named in their obligation).
    partialLiveFiles: Object.freeze([
      Object.freeze({
        path: 'src/modules/discovery/domain/discovery-domain-contracts.ts',
        detail: 'PARTIAL-LIVE (Phase-2B correction C2). Sole live src importer: ' +
          'discovery-process-module.ts (exactly 5 constants). The dead importers are ' +
          'discovery-installation.ts + discovery-outcome-certificate-projection.ts (both ' +
          'deadPhase4Files). Mirror constants whose LIVE definitions live elsewhere stay ' +
          'authoritative in their live files.',
        liveRows: Object.freeze([
          Object.freeze({ row: 'DISCOVERY_PROPOSAL_SCHEMA', consumer: 'discovery-process-module.ts' }),
          Object.freeze({ row: 'DISCOVERY_READINESS_ASSESSMENT_SCHEMA', consumer: 'discovery-process-module.ts' }),
          Object.freeze({ row: 'DISCOVERY_INTENT_KIND', consumer: 'discovery-process-module.ts' }),
          Object.freeze({ row: 'DISCOVERY_READINESS_INTENT_KIND', consumer: 'discovery-process-module.ts' }),
          Object.freeze({ row: 'DISCOVERY_WORK_INTENT_SCHEMA', consumer: 'discovery-process-module.ts' }),
        ]),
        deadRows: Object.freeze([
          Object.freeze({
            row: 'DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA, DISCOVERY_SETTLEMENT_INPUT_SCHEMA, NO_READINESS_HASH',
            justification: 'mirror constants consumed from THIS file only by dead discovery-installation.ts; ' +
              'the live definitions live in discovery-production-cell-installation.ts, ' +
              'discovery-settlement-input.ts, discovery-settlement-records.ts respectively',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_DIAGNOSIS_REPORT_SCHEMA, DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA, ' +
              'DISCOVERY_NORMALIZATION_INTENT_KIND, DISCOVERY_DIAGNOSIS_INTENT_KIND',
            justification: 'legacy-lane schema/kind constants; zero src importers of THIS copy (the ' +
              'normalization/diagnosis lanes are dead; shared/work-intent.ts keeps its own kind copies)',
            phase: 4,
          }),
          Object.freeze({
            row: 'DiscoveryRuntimePersistencePort + every Ensure*/Insert/Issue/Prepare port-input ' +
              'shape + every D1-D5 record/status/interface type (WorkIntentStatus, ' +
              'DiscoveryOutcome, DiscoveryProposalPayload, OverallReadiness, RecommendedNextAction, ' +
              'ReadinessShadowResult, DiagnosisDecision, ExecutionProvenance, ProposalProvenance, ' +
              'RawDiscoverySubmissionStatus, RawDiscoverySubmissionRecord, ControlIntentStatus, ' +
              'DiscoveryNormalizationProposalRecord, ReadinessControlStatus, ' +
              'ReadinessAssessmentStatus, ReadinessAssessmentRecord, ReadinessControlExecution, ' +
              'SettlementStatus, SettlementDecision, DiscoverySettlementReasonCode, ' +
              'SettlementRecord, OutcomeCertificateRecord, SettlementInputKey, ' +
              'SettlementProposalRecord, AuthorityScope, WorkIntent, CreateWorkIntent, ' +
              'ProposalStatus, ProposalRecord, DiagnosisControlStatus, DiagnosisReportStatus, ' +
              'DiagnosisControlIntentRecord, DiagnosisControlExecution, DiagnosisReportRecord, ' +
              'EnsureProjectedTask, EnsureNodeExecutionPlan, EnsureNormalizationControl, ' +
              'NormalizationControlExecution, EnsureReadinessControl, EnsureDiagnosisControl, ' +
              'SubmitDiagnosisReportInput, IssueCertificateAtomicallyInput, InsertSettlementPort, ' +
              'PrepareIntentForExecutionResult, ReadinessControlIntentRecord, SettleRequest, ' +
              'DiscoverySettlementResult, DiscoverySettlementPort)',
            justification: 'consumed from THIS file only by dead files (installation/projection) or by ' +
              'nobody; the live settlement surface keeps its own types in ' +
              'discovery-settlement-policy/input/records.ts and discovery-readiness-assessment.ts',
            phase: 4,
          }),
        ]),
        obligations: Object.freeze([
          'phase 4 deletes the dead rows in the SAME commit as discovery-installation.ts + ' +
          'discovery-outcome-certificate-projection.ts (their only consumers); the file stays, ' +
          'reduced to the 5 live constants',
        ]),
      }),
      Object.freeze({
        path: 'src/process-modules/modules/discovery/package/contributions/output-contracts.ts',
        detail: 'kept as live declared contract data; 3 dead rows (C1)',
        liveRows: Object.freeze([
          Object.freeze({ row: 'DISCOVERY_INPUT_CONTRACT', consumer: 'declared live input contract (discovery-case v1)' }),
          Object.freeze({ row: 'DISCOVERY_PROPOSAL_BUNDLE_CONTRACT', consumer: 'live proposal lane' }),
          Object.freeze({ row: 'DISCOVERY_READINESS_BUNDLE_CONTRACT', consumer: 'live readiness lane' }),
          Object.freeze({ row: 'DISCOVERY_SETTLEMENT_INPUT_CONTRACT', consumer: 'live settlement lane' }),
          Object.freeze({ row: 'DISCOVERY_OUTPUT_CONTRACT', consumer: 'live terminal output contract' }),
          Object.freeze({ row: 'DISCOVERY_CERTIFICATE_CONTRACT', consumer: 'live certificate payload contract' }),
          Object.freeze({ row: 'DISCOVERY_DECLARED_OUTCOMES / DISCOVERY_OUTCOME_CODES', consumer: 'live declared outcome set' }),
        ]),
        deadRows: Object.freeze([
          Object.freeze({
            row: 'DISCOVERY_NORMALIZATION_BUNDLE_CONTRACT',
            justification: 'normalization lane is dead; no live surface speaks factory.discovery-normalization-proposal.v1',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_DIAGNOSIS_BUNDLE_CONTRACT',
            justification: 'diagnosis lane is dead (D5 deleted from the module)',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_BRIEF_BUNDLE_CONTRACT',
            justification: 'ControlIntent-era brief auto-provisioning projection is dead; live brief ' +
              'provisioning is the injected port recorded on discovery-installation obligations',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_NODE_OUTPUT_CONTRACTS aggregate entries for the three dead bundle contracts',
            justification: 'aggregate shrinks with its dead members (proposal → readiness → ' +
              'settlement-input order preserved)',
            phase: 4,
          }),
        ]),
        obligations: Object.freeze([
          'phase 4 removes the three dead bundle contracts + their aggregate entries; ' +
          'tests/process-modules/discovery-package-contributions.test.mjs re-pins the reduced ' +
          'contract set in the same commit',
        ]),
      }),
      Object.freeze({
        path: 'src/process-modules/modules/discovery/package/contributions/acceptance-capabilities.ts',
        detail: 'kept as live declared capability/guard data; 3 dead rows (C1)',
        liveRows: Object.freeze([
          Object.freeze({ row: 'DISCOVERY_CAP_MANAGED_PRODUCTION_LEDGER', consumer: 'live capability' }),
          Object.freeze({ row: 'DISCOVERY_CAP_OUTCOME_CERTIFICATE_ISSUER', consumer: 'live capability' }),
          Object.freeze({ row: 'DISCOVERY_CAP_LM_NODE_EXECUTION_PERSISTENCE', consumer: 'live optional capability' }),
          Object.freeze({ row: 'DISCOVERY_GUARD_AUTHORITY_FENCE', consumer: 'live guard' }),
          Object.freeze({ row: 'DISCOVERY_GUARD_MANAGED_PRODUCTION', consumer: 'live guard' }),
          Object.freeze({ row: 'DISCOVERY_GUARD_NODE_ALLOWED_TOOLS', consumer: 'live guard' }),
          Object.freeze({ row: 'DISCOVERY_GUARD_EXECUTION_ID_FENCE', consumer: 'live guard' }),
        ]),
        deadRows: Object.freeze([
          Object.freeze({
            row: 'DISCOVERY_CAP_RUNTIME_PERSISTENCE',
            justification: 'declares the dead discovery-runtime-persistence port capability; the port + ' +
              'its sqlite implementation are deadPhase4Files and the runtimePersistence field dies in phase 3',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_CAP_SETTLEMENT_POLICY_REPOSITORY',
            justification: 'declares the dead settlement-policy repository capability (discovery-settlement-repository.ts is dead)',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_GUARD_DIAGNOSIS_ADVISORY',
            justification: 'diagnosis lane is dead; the guard binds a flow node that no longer exists',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_CAPABILITY_REQUIREMENTS / DISCOVERY_GUARD_BINDINGS aggregate entries for the three dead rows',
            justification: 'aggregates shrink with their dead members',
            phase: 4,
          }),
        ]),
        obligations: Object.freeze([
          'phase 4 removes the dead capability/guard rows + aggregate entries; ' +
          'tests/process-modules/discovery-package-contributions.test.mjs re-pins in the same commit',
        ]),
      }),
      Object.freeze({
        path: 'src/process-modules/modules/discovery/package/contributions/reviewer-skills.ts',
        detail: 'kept as live pinned skill data; 2 dead rows (C1)',
        liveRows: Object.freeze([
          Object.freeze({ row: 'DISCOVERY_READINESS_ADVISOR_REVIEWER_SKILL', consumer: 'live readiness advisor review skill' }),
          Object.freeze({ row: 'DISCOVERY_WORKER_SKILL', consumer: 'live proposal worker execution skill' }),
          Object.freeze({ row: 'DISCOVERY_PROTOCOL_SKILL', consumer: 'live shared protocol skill (every profile)' }),
          Object.freeze({ row: 'DISCOVERY_KICKSTART_REVIEWER_SKILL', consumer: 'live optional reviewer skill (skills/saga-kickstart/SKILL.md — KEPT per C4)' }),
        ]),
        deadRows: Object.freeze([
          Object.freeze({
            row: 'DISCOVERY_NORMALIZER_SKILL',
            justification: 'pins the dead saga-discovery-normalizer/SKILL.md resource (deadPhase4Resources)',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL',
            justification: 'pins the dead saga-discovery-diagnosis-advisor/SKILL.md resource (deadPhase4Resources)',
            phase: 4,
          }),
          Object.freeze({
            row: 'DISCOVERY_SKILL_RESOURCES / DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES aggregate entries for the two dead pins',
            justification: 'aggregates shrink with their dead members',
            phase: 4,
          }),
        ]),
        obligations: Object.freeze([
          'phase 4 removes the two dead pins + aggregate entries in the SAME commit as the dead ' +
          'skill resources and the manifest inline resourceIndex entries',
        ]),
      }),
      Object.freeze({
        path: 'src/process-modules/modules/discovery/package/contributions/index.ts',
        detail: 'the contributions barrel (kept: the package declared import surface, pinned by ' +
          'the hosted discovery-package-contributions suite); row-level dead re-export blocks die ' +
          'with their sources',
        liveRows: Object.freeze([
          Object.freeze({ row: 'acceptance-capabilities re-export block', consumer: 'live rows only after phase-4 reduction' }),
          Object.freeze({ row: 'output-contracts re-export block', consumer: 'live rows only after phase-4 reduction' }),
          Object.freeze({ row: 'reviewer-skills re-export block', consumer: 'live rows only after phase-4 reduction' }),
        ]),
        deadRows: Object.freeze([
          Object.freeze({
            row: 'tool-contributions re-export block (11 symbols)',
            justification: 'tool-contributions.ts is wholly dead (C1)',
            phase: 4,
          }),
          Object.freeze({
            row: 'handler-adapter re-export block (10 symbols)',
            justification: 'handler-adapter.ts is deadPhase4Files',
            phase: 4,
          }),
        ]),
        obligations: Object.freeze([
          'phase 4 drops both dead re-export blocks in the SAME commit as their source files',
        ]),
      }),
    ]),
    liveResources: Object.freeze([
      'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-worker/SKILL.md',
      'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-readiness-advisor/SKILL.md',
      'src/process-modules/modules/discovery/package/resources/discovery-doc-template.md',
      'src/process-modules/modules/discovery/package/resources/proposal-call-template.json',
      'src/process-modules/modules/discovery/package/resources/proposal-stage-tracker.md',
      'src/process-modules/modules/discovery/package/resources/proposal-checklist.md',
      'src/process-modules/modules/discovery/package/resources/readiness-call-template.json',
      'src/process-modules/modules/discovery/package/resources/readiness-stage-tracker.md',
      'src/process-modules/modules/discovery/package/resources/readiness-checklist.md',
      'skills/saga-process-module-worker-protocol/SKILL.md',
      'skills/saga-kickstart/SKILL.md',
    ]),
    // factory_work_intents is NOT part of the legacy closure: it is a live
    // shared protocol entity (dispatcher, work-assignment-core,
    // atomic-release, author-carry-forward, factory_execution_completion_products)
    // and STAYS with its indexes and immutability trigger.
    keptTables: Object.freeze([
      'factory_work_intents',
    ]),
    keptIndexes: Object.freeze([
      'idx_factory_work_intents_epic',
      'idx_factory_work_intents_kind_status',
    ]),
    keptTriggers: Object.freeze([
      'trg_factory_work_intents_contract_immutable',
    ]),
    // ADR-095 Decision 5: the live E2E/constraint/output suites, preserved
    // untouched. Phase-2A hosted the four orphans (matrix group
    // discovery-live-v2) + migration-conformance (process-modules group).
    // Phase-2B hosts FOUR MORE proven-live orphans (C3): d1-1-authority,
    // d1-1-binding, d3-readiness-domain, d4-settlement-policy (green in
    // isolation 62/62 combined, 2026-08-24) — the live-v2 executor surface
    // now covers D1 authority/binding, D3 readiness domain, D4 settlement
    // policy domain in addition to the Phase-2A four.
    testFiles: Object.freeze([
      'tests/discovery/d7-settlement-lifecycle-classification.test.mjs',
      'tests/discovery/order-constraint-register.test.mjs',
      'tests/matrix/e-constraint-loss.test.mjs',
      'tests/modules/discovery/discovery-check-providers.test.mjs',
      'tests/execution/migration-conformance.test.mjs',
      'tests/factory-proof/discovery-scenario-pack.test.mjs',
      'tests/factory-proof/discovery-resilience-pack.test.mjs',
      'tests/process-modules/discovery-output-handoff.test.mjs',
      'tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs',
      'tests/discovery/d1-1-authority.test.mjs',
      'tests/discovery/d1-1-binding.test.mjs',
      'tests/discovery/d3-readiness-domain.test.mjs',
      'tests/discovery/d4-settlement-policy.test.mjs',
    ]),
  }),

  // -------------------------------------------------------------------------
  // LEGACY TESTS — the exact per-file partition + action (Phase-2B correction
  // C3: PATHS, not wildcards). Three verdicts:
  //   delete  — legacy-only (exercises ONLY removed surfaces; operator
  //             approval ADR-095 §7); deleted at the named phase;
  //   migrate — MIXED: contains live assertions that MUST be preserved
  //             (migrated/re-pointed FIRST, never deleted) when the dead
  //             surface dies at the named phase;
  //   helper  — a non-test fixture consumed ONLY by delete-classified files;
  //             deleted with its last consumer in the same commit.
  // Hosting truth (matrix --list-json, 2026-08-24): every file here is
  // UNHOSTED (no blocking run-set, no quarantine) except where noted.
  // -------------------------------------------------------------------------
  legacyTests: Object.freeze([
    // ---- DELETE (phase 4) — legacy-only, unhosted -------------------------
    Object.freeze({
      path: 'tests/discovery/d1-workspace-creation.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'sole dist import: ensure-discovery-workspace.js (deadPhase4Files); exercises only the legacy workspace provisioning',
    }),
    Object.freeze({
      path: 'tests/discovery/d2-normalization-lifecycle.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'sole dist import: discovery-normalization-service.js (deadPhase4Files); also consumes _conveyor-fakes',
    }),
    Object.freeze({
      path: 'tests/discovery/d2-normalization-lineage.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-normalization-tools/-proposal/-repository (deadPhase4Files); live infra (db/work-intent/authority) drives only dead lanes',
    }),
    Object.freeze({
      path: 'tests/discovery/d2-normalization.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-normalization.js + discovery-normalization-proposal.js (deadPhase4Files)',
    }),
    Object.freeze({
      path: 'tests/discovery/d3-readiness-correction.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-readiness-service/-tools, normalization+readiness repositories (deadPhase4Files); also consumes _conveyor-fakes',
    }),
    Object.freeze({
      path: 'tests/discovery/d3-readiness-handler.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-readiness-tools + normalization/readiness repositories (deadPhase4Files)',
    }),
    Object.freeze({
      path: 'tests/discovery/d3-readiness-index-migration.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-readiness-tools + normalization/readiness repositories (deadPhase4Files)',
    }),
    Object.freeze({
      path: 'tests/discovery/d4-settlement-atomicity.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-outcome-certificate, normalization/settlement repositories, sqlite-discovery-runtime (deadPhase4Files)',
    }),
    Object.freeze({
      path: 'tests/discovery/d4-settlement-persistence.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-settlement-service, settlement/readiness repositories, sqlite-discovery-runtime (deadPhase4Files)',
    }),
    Object.freeze({
      path: 'tests/discovery/d5-certificate-bundle.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'dead dist imports: discovery-certificate-bundle, discovery-settlement-service, repositories, sqlite-discovery-runtime (deadPhase4Files)',
    }),
    Object.freeze({
      path: 'tests/discovery/tool-actionable-errors.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'sole dist import: discovery-tool-args.js (deadPhase4Files); the PARAMETERIZED structured-error surface it inspired lives on in src/application/actionable-tool-error.ts (pinned by tests/application/actionable-tool-error.test.mjs + mcp-conformance)',
    }),
    Object.freeze({
      path: 'tests/modules/discovery/proposal-ref-bridge.test.mjs',
      verdict: 'delete',
      phase: 4,
      justification: 'sole dist import: proposal-ref-bridge.js (deadPhase4Files); the bridge has no live surface after phase 3 removes the products.ts emission',
    }),
    Object.freeze({
      path: 'tests/discovery/_conveyor-fakes.mjs',
      verdict: 'helper',
      phase: 4,
      justification: 'non-test fixture (no *.test.mjs suffix); consumed ONLY by d2-normalization-lifecycle + d3-readiness-correction (both delete-classified) — delete with the last consumer in the same commit',
    }),
    // ---- MIGRATE (preserve live assertions) --------------------------------
    Object.freeze({
      path: 'tests/discovery/d3-architecture-boundary.test.mjs',
      verdict: 'migrate',
      phase: 4,
      justification: 'MIXED. Live assertion to PRESERVE: "readiness domain has no DB import" over ' +
        'discovery-readiness-assessment.ts (KEPT). Dead assertions (over readiness-service, ' +
        'readiness-records, readiness-repository, readiness-tools — all deadPhase4Files) are ' +
        'deleted with their files. Migration keeps the file, reduced to the live boundary check.',
    }),
    Object.freeze({
      path: 'tests/discovery/d4-architecture-boundary.test.mjs',
      verdict: 'migrate',
      phase: 4,
      justification: 'MIXED. Live assertions to PRESERVE (5): settlement-policy purity ×3 (no DB, ' +
        'no LM client, no SQLite import), settlement-input purity ×1, and src/index.ts registers ' +
        'NO settlement_submit/certificate_submit tool (workers must never mint certificates). ' +
        'Dead assertions (over settlement-service ×4, settlement-repository ×2, ' +
        'outcome-certificate domain ×1 — deadPhase4Files) are deleted with their files.',
    }),
    Object.freeze({
      path: 'tests/discovery/d4-settlement-recovery.test.mjs',
      verdict: 'migrate',
      phase: 4,
      justification: 'MIXED. The m6a live block (ADR-090 CC-IC-1, line ~1222: "a continuation ' +
        'inherits the ORIGINAL register — same pinned inputs → byte-identical digest; ' +
        're-extraction from drifted material is a typed red") drives the LIVE ' +
        'production-cell installation + lifecycles and MUST be preserved. The 18 ' +
        'service/repository/runtime recovery+integrity lanes drive the dead settlement ' +
        'service/repositories via sqlite-discovery-runtime and are deleted with them.',
    }),
    Object.freeze({
      path: 'tests/characterization/mcp-catalog-authority-errors.test.mjs',
      verdict: 'migrate',
      phase: 4,
      justification: 'MIXED (hosted in NO group — matrix-checked 2026-08-24). Live assertions to ' +
        'PRESERVE: catalog shape/no-duplicates, authority fencing (managed identity, allowed ' +
        'tools, AUTHORITY_DENIED/CONTEXT_INVALID), identity guard, friendlyError normalization, ' +
        'error envelope wiring. Dead-surface migration in the same commit as the tool deletion: ' +
        'the pinned sorted tool-name set drops the three dead discovery tools; the ' +
        'FACTORY_TOOL_CALL_SHAPES/vocabulary lanes for the dead tools re-point to the live ' +
        'parameterized surface (src/application/actionable-tool-error.ts) or delete with the tools.',
    }),
    Object.freeze({
      path: 'tests/replay/conveyor-v4.3-focused-invariants.test.mjs',
      verdict: 'migrate',
      phase: 3,
      executedAt: '2026-08-24',
      executedInPhase: '3.1',
      justification: 'MIXED (hosted BLOCKING in the process-modules group since the canonical ' +
        'Phase-3.1 integration, 2026-08-24 — Red Team LOW-1; unhosted before that; ' +
        'removal/de-hosting guard G2l in acceptance-matrix-coverage; its Phase-5 ' +
        'same-commit repin obligation is recorded in mandatoryPhase5Repins). Live invariants to ' +
        'PRESERVE (10 of 11): executor-kind unification, capsule routing, retired-simulator ' +
        'exclusion, replay-capsule payload shape, idempotency binding, gate-rejected/failed-replay ' +
        'detectability, replay-certification fail-closure — all over live replay/routing/authority ' +
        'infra. The phase-3 migration (SAME commit as the products.ts projection block removal): ' +
        'invariant 5 "Discovery proposal is a schema projection behind universal product_submit" ' +
        'drops its discovery-proposal-projection.js import and re-points to the projection-free ' +
        'product_submit seam (the proposal DOMAIN type import stays — discovery-proposal.ts is KEPT). ' +
        'EXECUTED in Phase 3.1 (2026-08-24): the dead import is gone; the migrated invariant drives ' +
        'the REAL product_submit handler and proves the negative (no discovery_proposal_id field, ' +
        'no factory_proposals row, no proposal-ref side product), preserving invariant 6 (one ' +
        'universal typed-product submit seam)',
    }),
  ]),

  // -------------------------------------------------------------------------
  // HOSTED DEAD IMPORTERS — machine-recorded same-commit actions for every
  // BLOCKING-hosted test/fixture that imports or pins a dead surface (C5).
  // These suites are LIVE (they stay hosted); only their dead pins migrate.
  // -------------------------------------------------------------------------
  hostedDeadImporters: Object.freeze([
    Object.freeze({
      file: 'tests/architecture/handler-digest-runtime-consistency.test.mjs',
      hostedIn: 'architecture',
      obligation: 'imports dist discovery-installation.js (six-handler digest lane) — Phase-4 ' +
        'same-commit repin to the one-handler production-cell digest (ratchet 2; ADR-095 blocker list)',
    }),
    Object.freeze({
      file: 'tests/architecture/kernel-admission-distance.test.mjs',
      hostedIn: 'architecture',
      obligation: 'TWO dead pins: (a) "the linkType behavioural ternary exists in exactly the ' +
        'three known copies" includes src/modules/discovery/infrastructure/sqlite-discovery-' +
        'runtime.ts:413 — Phase-4 same-commit re-pin of the copies list (three → two); ' +
        '(b) DRIFT_REPORTED anchor src/tools/settlement-debug.ts "module_ref_key === ' +
        '\'discovery\'" + FROZEN_REGISTER_COUNTS drift:16 — SATISFIED at Phase 3.2 ' +
        '(2026-08-24): anchor dropped, drift 16→15, same commit as the settlement-debug ' +
        'block removal',
    }),
    Object.freeze({
      file: 'tests/architecture/v4-target-conformance-ratchet.test.mjs',
      hostedIn: 'architecture',
      obligation: 'REG-11 asserts proposal-ref-bridge.ts EXISTS via existsSync — Phase-4 ' +
        'same-commit removal/replacement of REG-11 with the bridge deletion',
    }),
    Object.freeze({
      file: 'tests/architecture/work-intent-contract-immutability.test.mjs',
      hostedIn: 'architecture',
      obligation: 'imports dist sqlite-discovery-runtime.js as its fixture adapter — Phase-4 ' +
        'same-commit re-point at the KEPT factory_work_intents schema (the table, indexes, and ' +
        'immutability trigger stay; only this adapter import dies)',
    }),
    Object.freeze({
      file: 'tests/process-modules/discovery-package-contributions.test.mjs',
      hostedIn: 'process-modules',
      obligation: 'imports dist tool-contributions.js + handler-adapter.js + the three partial-live ' +
        'containers + the barrel — Phase-4 same-commit repin to the live one-handler, ' +
        'reduced-row contributions (ADR-095 blocker list)',
    }),
    // NOTE: tests/execution/migration-conformance.test.mjs is ALSO a hosted
    // dead importer but is classified kept-live (keptLive.testFiles) — its
    // scan bucket is kept:tests and its obligation lives in
    // mandatoryPhase4Repins (a scan bucket may not overlap; the obligation
    // is not the bucket).
    Object.freeze({
      file: 'tests/process-modules/discovery-outcome-certificate-projection.test.mjs',
      hostedIn: 'process-modules',
      obligation: 'imports dist discovery-outcome-certificate-projection.js — Phase-4 same-commit ' +
        'migrate-or-delete (legacy-only oracle over the dead projection)',
    }),
    Object.freeze({
      file: 'tests/factory-proof/workshop-inventory.baseline.json',
      hostedIn: 'factory-proof (consumed by the workshop-inventory suite)',
      obligation: 'pins dependency edges naming the DEAD discovery-outcome-certificate-projection.ts ' +
        '"(modules->legacy)" and contributions/handler-adapter.ts "(legacy->modules)" — Phase-4 ' +
        'same-commit baseline regeneration (the edge scan changes when the files die)',
    }),
    Object.freeze({
      file: 'tests/architecture/adr-095-phase3-runtime-persistence-removal.test.mjs',
      hostedIn: 'architecture',
      obligation: 'imports dist sqlite-discovery-runtime.js ONLY as the Phase-3.3 positive ' +
        'control (constructing the dead adapter on a closure-dropped test DB proves the ' +
        'regrow detector is non-vacuous and that the lazy ensure* sites still exist in the ' +
        'dead lane nothing live constructs) — Phase-4 same-commit obligation: when ' +
        'sqlite-discovery-runtime.ts is deleted, replace the positive control with an ' +
        'inline equivalent DDL execution (or drop the control arm, keeping the composition ' +
        'absence proof) in the SAME commit; the suite must never weaken its composition ' +
        'no-regrow assertion',
    }),
  ]),

  // -------------------------------------------------------------------------
  // UNRESOLVED — EMPTY since Phase-2B (2026-08-24). The Phase-2A baseline of
  // 5 (4 contribution containers + the legacy-only test list) was CLOSED by
  // the exhaustive row classifications (C1/C2) and the exact test partition
  // (C3), and completeness is enforced FORWARD by the bidirectional scoped
  // partition scan below: any NEW unclassified file in a scoped tree fails
  // validation, so an unresolved list would be dead weight. Growth from empty
  // is rejected: if a file is genuinely ambiguous, the SCAN is what must be
  // extended (with its classification), never this list.
  // -------------------------------------------------------------------------
  unresolved: Object.freeze([]),

  // -------------------------------------------------------------------------
  // Phase-4 atomic machine gate: CLEARED in Phase-2B — the partition scan
  // proves the classification exhaustive (bidirectionally, with mutation
  // negatives in BR6), so the Phase-4 block reason ("unresolved non-empty")
  // no longer holds. The validator still enforces the coupling in BOTH
  // directions: this flag must be false exactly while unresolved is empty.
  // -------------------------------------------------------------------------
  phase4BlockedByUnresolved: false,

  // -------------------------------------------------------------------------
  // Bidirectional dead-file presence counter — LIVE since Phase-2B (the
  // Phase-2A deferral reason "the dead set is not proven complete" is
  // discharged by the partition scan). Fails on EARLY deletion (a dead path
  // removed before its phase) AND on NEW dead files (a path added to the
  // dead set without a reviewed classification change updating this count).
  // -------------------------------------------------------------------------
  presenceCounter: Object.freeze({
    deferred: false,
    deadPathCount: 36,
    deadFileCount: 27,
    deadResourceCount: 9,
  }),

  // -------------------------------------------------------------------------
  // SCOPED PARTITION SCAN (C6) — the bidirectional completeness proof.
  // Scope: the complete discovery src trees, the four dead tool files, the
  // discovery test trees, every individually scoped out-of-tree test/fixture
  // that touches a dead surface, and the six relevant skills. The validator
  // asserts: (disk files in scope) === (classified paths in scope), i.e. no
  // unclassified file and no ghost classification, with every file in
  // EXACTLY ONE bucket.
  // -------------------------------------------------------------------------
  scopedPartitionScan: Object.freeze({
    directoryTrees: Object.freeze([
      'src/modules/discovery',
      'src/process-modules/modules/discovery',
      'tests/discovery',
      'tests/modules/discovery',
    ]),
    individualFiles: Object.freeze([
      'src/tools/discovery-proposal-tools.ts',
      'src/tools/discovery-normalization-tools.ts',
      'src/tools/discovery-readiness-tools.ts',
      'src/tools/discovery-tool-args.ts',
      'tests/characterization/mcp-catalog-authority-errors.test.mjs',
      'tests/replay/conveyor-v4.3-focused-invariants.test.mjs',
      'tests/execution/migration-conformance.test.mjs',
      'tests/process-modules/discovery-outcome-certificate-projection.test.mjs',
      'tests/process-modules/discovery-package-contributions.test.mjs',
      'tests/architecture/handler-digest-runtime-consistency.test.mjs',
      'tests/architecture/kernel-admission-distance.test.mjs',
      'tests/architecture/v4-target-conformance-ratchet.test.mjs',
      'tests/architecture/work-intent-contract-immutability.test.mjs',
      'tests/factory-proof/workshop-inventory.baseline.json',
      'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-worker/SKILL.md',
      'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-readiness-advisor/SKILL.md',
      'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-normalizer/SKILL.md',
      'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-diagnosis-advisor/SKILL.md',
      'skills/saga-process-module-worker-protocol/SKILL.md',
      'skills/saga-kickstart/SKILL.md',
    ]),
    // NOTE on skill paths: the four saga-discovery-* execution skills live
    // under src/process-modules/modules/discovery/package/resources/skills/
    // (also reachable through the directory tree above — listed individually
    // so the scan proves their classification even if the tree moves); the
    // two platform skills live at repo-root skills/.
    note: 'every file under the scoped trees and every individually scoped file must be classified in exactly one partition bucket: dead | kept-live | partial-live | legacy-test | hosted-importer | kept-live-test',
  }),

  // -------------------------------------------------------------------------
  // REMOVAL SYMBOLS (Phase-2C, schemaVersion 3) — the src-level surface the
  // eight ADR-095 ratchets pin. Every entry names a symbol class that must be
  // ABSENT from src/ after its phase, together with the EXACT pinned set of
  // live (non-dead) files that legitimately reference it TODAY on the
  // legacy-present tree (machine-derived by the 2026-08-24 comment-stripped
  // src scan; every outside reference maps to a recorded phase-3/phase-4
  // obligation). Ratchet 3 (src symbol/table absence) consumes this; the
  // allowedOutside sets empty when the phase-4 marker (product-discovery
  // version bump) lands, so reintroducing any symbol post-cutover is RED.
  // -------------------------------------------------------------------------
  removalSymbols: Object.freeze({
    note: 'path tokens use a leading slash + extension alternation ([/\\x27]name\\.(ts|js)) so live longer names (discovery-proposal.*) never false-match the dead shorter ones (proposal.*)',
    // Path tokens of the dead phase-4 files whose basenames are collision-free
    // across the whole repo. EXCLUDED (collision risk with LIVE same-named
    // files in other modules' contributions/): /handler-adapter,
    // /tool-contributions — their dead surfaces are pinned by namedSymbols
    // (DISCOVERY_PACKAGE_HANDLER_IDS, DISCOVERY_TOOL_CONTRIBUTIONS, ...) plus
    // the barrel's classified dead re-export rows instead.
    pathTokens: Object.freeze([
      Object.freeze({
        token: '/discovery-installation',
        deadFile: 'src/modules/discovery/application/discovery-installation.ts',
        allowedOutside: Object.freeze([
          Object.freeze({ path: 'src/infrastructure/process-modules/brief-provisioning-ports.ts', cleanedAtPhase: 4, reason: 'type-only import of the BriefProvisioning port types; re-homed in the phase-4 same-commit obligation' }),
          Object.freeze({ path: 'src/process-modules/modules/discovery/package/manifest.ts', cleanedAtPhase: 4, reason: 'the DISCOVERY_HANDLER_IMPLEMENTATION_DIGEST pin; repinned to the production-cell bytes at the phase-4 cutover' }),
        ]),
      }),
      Object.freeze({
        token: '/discovery-proposal-projection',
        deadFile: 'src/modules/discovery/infrastructure/discovery-proposal-projection.ts',
        allowedOutside: Object.freeze([
          Object.freeze({ path: 'src/tools/products.ts', cleanedAtPhase: 3, reason: 'the LIVE WRITER block; removed first at phase 3 (F1 ordering)' }),
        ]),
      }),
      Object.freeze({
        token: '/proposal-ref-bridge',
        deadFile: 'src/modules/discovery/domain/proposal-ref-bridge.ts',
        allowedOutside: Object.freeze([
          Object.freeze({ path: 'src/tools/products.ts', cleanedAtPhase: 3, reason: 'the PROPOSAL_REF_SCHEMA product emission; removed at phase 3' }),
        ]),
      }),
      Object.freeze({
        token: '/discovery-runtime-port',
        deadFile: 'src/modules/discovery/infrastructure/discovery-runtime-port.ts',
        allowedOutside: Object.freeze([
          Object.freeze({ path: 'src/app/product-lifecycle-runtime.ts', cleanedAtPhase: 3, reason: 'the FactoryDiscoveryRuntimePersistence type import; field dies at phase 3' }),
          Object.freeze({ path: 'src/modules/module-registration.ts', cleanedAtPhase: 3, reason: 'the ModuleSharedDeps.runtimePersistence field type; dies at phase 3' }),
        ]),
      }),
      Object.freeze({
        token: '/sqlite-discovery-runtime',
        deadFile: 'src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts',
        allowedOutside: Object.freeze([
          Object.freeze({ path: 'src/app/product-lifecycle-runtime.ts', cleanedAtPhase: 3, reason: 'the runtimePersistence construction (options.discoveryRuntimePersistence ?? new SqliteFactoryDiscoveryRuntime()); removed at phase 3 (F2)' }),
        ]),
      }),
      // The remaining dead files have ZERO outside src references today
      // (machine-verified 2026-08-24); the tokens are pinned anyway so any
      // FUTURE import of a dead module is RED in both ratchet arms.
      ...Object.freeze([
        '/discovery-proposal-tools',
        '/discovery-normalization-tools',
        '/discovery-readiness-tools',
        '/discovery-tool-args',
        '/discovery-settlement-service',
        '/discovery-normalization-service',
        '/discovery-readiness-service',
        '/discovery-certificate-bundle',
        '/ensure-discovery-workspace',
        '/discovery-outcome-certificate-projection',
        '/discovery-normalization-repository',
        '/discovery-readiness-repository',
        '/discovery-settlement-repository',
        '/discovery-proposal-repository',
        '/proposal',
        '/discovery-normalization',
        '/discovery-normalization-records',
        '/discovery-normalization-proposal',
        '/discovery-outcome-certificate',
        '/discovery-readiness-records',
      ].map((token) => Object.freeze({
        token,
        deadFile: Object.freeze([
          'src/tools/discovery-proposal-tools.ts',
          'src/tools/discovery-normalization-tools.ts',
          'src/tools/discovery-readiness-tools.ts',
          'src/tools/discovery-tool-args.ts',
          'src/modules/discovery/application/discovery-settlement-service.ts',
          'src/modules/discovery/application/discovery-normalization-service.ts',
          'src/modules/discovery/application/discovery-readiness-service.ts',
          'src/modules/discovery/application/discovery-certificate-bundle.ts',
          'src/modules/discovery/application/ensure-discovery-workspace.ts',
          'src/modules/discovery/application/discovery-outcome-certificate-projection.ts',
          'src/modules/discovery/infrastructure/discovery-normalization-repository.ts',
          'src/modules/discovery/infrastructure/discovery-readiness-repository.ts',
          'src/modules/discovery/infrastructure/discovery-settlement-repository.ts',
          'src/modules/discovery/infrastructure/discovery-proposal-repository.ts',
          'src/modules/discovery/domain/proposal.ts',
          'src/modules/discovery/domain/discovery-normalization.ts',
          'src/modules/discovery/domain/discovery-normalization-records.ts',
          'src/modules/discovery/domain/discovery-normalization-proposal.ts',
          'src/modules/discovery/domain/discovery-outcome-certificate.ts',
          'src/modules/discovery/domain/discovery-readiness-records.ts',
        ].find((f) => f.endsWith(`${token}.ts`))),
        allowedOutside: Object.freeze([]),
      }))),
    ]),
    // Named exported symbols of the dead files (and the dead rows of the
    // partial-live containers). allowedOutside is the EXACT live referencing
    // set today; each entry dies at its named phase.
    namedSymbols: Object.freeze([      // -- phase-3 live-write/type hosts --------------------------------
      Object.freeze({ symbol: 'projectDiscoveryProposal', allowedOutside: Object.freeze([{ path: 'src/tools/products.ts', cleanedAtPhase: 3 }]) }),
      Object.freeze({ symbol: 'requiresDiscoveryProjection', allowedOutside: Object.freeze([{ path: 'src/tools/products.ts', cleanedAtPhase: 3 }]) }),
      Object.freeze({ symbol: 'PROPOSAL_REF_SCHEMA', allowedOutside: Object.freeze([{ path: 'src/tools/products.ts', cleanedAtPhase: 3 }]) }),
      Object.freeze({ symbol: 'discovery_proposal_id', allowedOutside: Object.freeze([{ path: 'src/tools/products.ts', cleanedAtPhase: 3 }]) }),
      Object.freeze({ symbol: 'SqliteFactoryDiscoveryRuntime', allowedOutside: Object.freeze([{ path: 'src/app/product-lifecycle-runtime.ts', cleanedAtPhase: 3 }]) }),
      Object.freeze({ symbol: 'FactoryDiscoveryRuntimePersistence', allowedOutside: Object.freeze([{ path: 'src/app/product-lifecycle-runtime.ts', cleanedAtPhase: 3 }, { path: 'src/modules/module-registration.ts', cleanedAtPhase: 3 }]) }),
      // -- phase-4 re-homes / dead rows of kept containers --------------
      Object.freeze({ symbol: 'DiscoveryBriefProvisioningPort', allowedOutside: Object.freeze([{ path: 'src/infrastructure/process-modules/brief-provisioning-ports.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DiscoveryBriefProvisioningContext', allowedOutside: Object.freeze([{ path: 'src/infrastructure/process-modules/brief-provisioning-ports.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DiscoveryBriefProvisioningOutcome', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DiscoveryRuntimePersistencePort', allowedOutside: Object.freeze([{ path: 'src/modules/discovery/domain/discovery-domain-contracts.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DiscoverySettlementPort', allowedOutside: Object.freeze([{ path: 'src/modules/discovery/domain/discovery-domain-contracts.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_NORMALIZATION_BUNDLE_CONTRACT', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/output-contracts.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_DIAGNOSIS_BUNDLE_CONTRACT', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/output-contracts.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_BRIEF_BUNDLE_CONTRACT', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/output-contracts.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_CAP_RUNTIME_PERSISTENCE', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/acceptance-capabilities.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_CAP_SETTLEMENT_POLICY_REPOSITORY', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/acceptance-capabilities.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_GUARD_DIAGNOSIS_ADVISORY', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/acceptance-capabilities.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_NORMALIZER_SKILL', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/reviewer-skills.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      Object.freeze({ symbol: 'DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL', allowedOutside: Object.freeze([{ path: 'src/process-modules/modules/discovery/package/contributions/reviewer-skills.ts', cleanedAtPhase: 4 }, { path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }]) }),
      // -- phase-4 barrel dead re-export rows (C1) ----------------------
      ...Object.freeze([
        'DISCOVERY_PROPOSAL_SUBMIT_CONTRIBUTION',
        'DISCOVERY_NORMALIZATION_GET_CONTRIBUTION',
        'DISCOVERY_NORMALIZATION_SUBMIT_CONTRIBUTION',
        'DISCOVERY_READINESS_GET_CONTRIBUTION',
        'DISCOVERY_READINESS_SUBMIT_CONTRIBUTION',
        'DISCOVERY_DIAGNOSIS_GET_CONTRIBUTION',
        'DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION',
        'DISCOVERY_BRIEF_ARTIFACT_CREATE_CONTRIBUTION',
        'DISCOVERY_WORKER_DONE_CONTRIBUTION',
        'DISCOVERY_PACKAGE_HANDLER_IDS',
        'DISCOVERY_TOOL_CONTRIBUTIONS',
        'DISCOVERY_TOOL_NAMESPACE',
        'DISCOVERY_TOOL_RESOURCE_IDS',
        'createDiscoveryPackageHandlerAdapter',
        'createFakeDiscoveryBriefProvisioningPort',
        'FakeDiscoveryBriefProvisioningRecord',
      ].map((symbol) => Object.freeze({
        symbol,
        allowedOutside: Object.freeze([
          Object.freeze({ path: 'src/process-modules/modules/discovery/package/contributions/index.ts', cleanedAtPhase: 4 }),
        ]),
      }))),
      // -- dead-internal only today; pinned so ANY future reference is RED -
      ...Object.freeze([
        'createDiscoveryKernelHandlers',
        'createDiscoveryWorkplacePersistence',
        'FactoryDiscoverySettlementService',
        'SettlementValidationError',
        'ensureDiscoveryWorkspace',
        'FACTORY_TOOL_CALL_SHAPES',
        'FACTORY_ARG_SOURCES',
      ].map((symbol) => Object.freeze({ symbol, allowedOutside: Object.freeze([]) }))),
    ]),
    // Dead-lane manifest resourceIndex logicalIds (phase 4 drops the inline
    // entries; the SKILL/template/tracker/checklist resources themselves are
    // deadPhase4Resources).
    manifestDeadLaneLogicalIds: Object.freeze([
      'discovery.skill.normalizer',
      'discovery.skill.diagnosis-advisor',
      'discovery.template.normalization-call',
      'discovery.template.diagnosis-call',
      'discovery.tracker.normalization-stage',
      'discovery.tracker.diagnosis-stage',
      'discovery.checklist.normalization',
      'discovery.checklist.diagnosis',
    ]),
    manifestDeadLaneAllowedIn: Object.freeze([
      // manifest.ts carries the inline resourceIndex entries; reviewer-skills.ts
      // pins the discovery.skill.normalizer logicalId inside the
      // DISCOVERY_NORMALIZER_SKILL dead row (verified by src scan 2026-08-24:
      // the ONLY other live reference — both die at phase 4).
      'src/process-modules/modules/discovery/package/manifest.ts',
      'src/process-modules/modules/discovery/package/contributions/reviewer-skills.ts',
    ]),
    // Table/index name allowed live sites: the fresh DDL home for all ten
    // tables + nineteen indexes. The ONE legacy query host
    // (settlement_explain over factory_discovery_settlements) was emptied at
    // Phase 3.2 (2026-08-24) when the query died — no live src site may name
    // a dead table anymore. Table absence under src/ is enforced from phase 5
    // (ratchet 3 table arm keys on the schema-closure state, not phase 4).
    tableAllowedOutsideCommon: Object.freeze(['src/schema.ts']),
    tableAllowedOutsideSpecific: Object.freeze({
      factory_discovery_settlements: Object.freeze([]),
    }),
  }),

  // -------------------------------------------------------------------------
  // Mandatory same-commit Phase-4 migration for the BLOCKING-hosted
  // migration-conformance suite (the Phase-2A hosting decision recorded here
  // so it cannot be forgotten at the cutover). SCOPE NOTE (red-team F2): the
  // suite does NOT assert the six-handler count/IDs — handler shape is owned
  // by tests/architecture/handler-digest-runtime-consistency.test.mjs + the
  // Phase-4 hard ratchet (same-commit repin to the one-handler
  // production-cell digest). What migration-conformance hard-pins on the
  // legacy surface: the two dead dist imports + the factory_proposals seed.
  // -------------------------------------------------------------------------
  mandatoryPhase4Repins: Object.freeze([
    Object.freeze({
      file: 'tests/execution/migration-conformance.test.mjs',
      obligation: 'hosted BLOCKING (process-modules group) since Phase-2A GREEN on the legacy ' +
        'baseline (35/35, 2026-08-24) WITHOUT repinning — the production surface has not ' +
        'changed yet. The suite does NOT assert the six-handler count/IDs: its ' +
        'package-isolation lane validates discoveryPackageManifest STRUCTURALLY only ' +
        '(ProcessModuleManifest shape + contract refs + package-local resources), so the ' +
        'handler-shape cutover truth is owned by handler-digest-runtime-consistency + the ' +
        'Phase-4 hard ratchet, not here. Its hard legacy pins are the dist imports of ' +
        'discovery-settlement-repository.js (restart lane) and ' +
        'discovery-outcome-certificate-projection.js (exact-output lane) — both ' +
        'deadPhase4Files — and the fresh-DB factory_proposals INSERT seed. At the Phase-4 ' +
        'cutover commit those imports MUST move to the live surface or delete their tests ' +
        'per the legacy-only list in the SAME commit; at Phase 5 the factory_proposals ' +
        'INSERT follows the schema closure removal.',
    }),
  ]),

  // -------------------------------------------------------------------------
  // Mandatory same-commit Phase-5 repins (Red Team LOW-2, canonical Phase-3.1
  // integration 2026-08-24). Phase 5 removes the ten-table closure from the
  // fresh SCHEMA_SQL (no DROP): every BLOCKING-hosted assertion that reads a
  // closure table against a FRESH database flips from "zero rows on the
  // still-existing table" to "table ABSENT" — a COUNT(*) over a missing
  // table is a hard SQLITE_ERROR, not a green negative. Each obligation
  // below names the exact hosted file and the assertion that MUST be repinned
  // in the SAME Phase-5 commit; the validator enforces structurally that the
  // file exists on disk and is a classified inventory path (no prose-only
  // obligations that can silently rot).
  // -------------------------------------------------------------------------
  mandatoryPhase5Repins: Object.freeze([
    Object.freeze({
      file: 'tests/replay/conveyor-v4.3-focused-invariants.test.mjs',
      hostedIn: 'process-modules (Red Team LOW-1 hosting; de-hosting guard G2l)',
      obligation: 'the Phase-3.1-migrated invariant 5 proves the projection-free ' +
        'product_submit seam with SELECT COUNT(*) FROM factory_proposals = 0 (negative ' +
        'proof on the still-existing table, asserted twice incl. after the fenced ' +
        'resubmit). At the Phase-5 fresh-schema closure removal the table no longer ' +
        'exists in a fresh DB: in the SAME Phase-5 commit both assertions MUST be ' +
        'repinned to the stronger truthful negative — the factory_proposals table (and ' +
        'its idx_factory_proposals_* indexes) are ABSENT from the fresh schema — never ' +
        'relaxed or deleted; invariant 6 (one universal typed-product submit seam) and ' +
        'the fenced-resubmit refusal stay unchanged.',
    }),
  ]),
});

// ---------------------------------------------------------------------------
// Self-validation. Fail-closed: importing tests call this and it throws with
// a precise message on any structural defect. Pure sync checks only. The
// optional `inventory` argument (defaults to ADR_095_INVENTORY) exists so
// tests can PROVE the machine rules fire — e.g. that a decoupled
// phase4BlockedByUnresolved flag or a wrong presence-counter count is
// rejected — instead of trusting that the current object merely satisfies
// them. `listFilesOverride` lets tests feed a VIRTUAL file listing to the
// partition scan (mutation negatives) without touching disk.
// ---------------------------------------------------------------------------

export function validateAdr095Inventory(repoRoot, inventory = ADR_095_INVENTORY, listFilesOverride = null) {
  const errors = [];
  const inv = inventory;
  const root = repoRoot;

  const deadFileEntries = [
    ...inv.deadPhase3.filter((e) => e.kind === 'file' || e.kind === 'resource'),
    ...inv.deadPhase4Files,
    ...inv.deadPhase4Resources,
  ];
  const deadPaths = new Set();
  for (const e of deadFileEntries) {
    if (deadPaths.has(e.path)) errors.push(`duplicate dead path: ${e.path}`);
    deadPaths.add(e.path);
  }

  const partialLiveEntries = inv.keptLive.partialLiveFiles ?? [];
  const partialLivePaths = partialLiveEntries.map((p) => (typeof p === 'string' ? p : p.path));
  const legacyTestPaths = inv.legacyTests.map((t) => t.path);
  const hostedImporterPaths = inv.hostedDeadImporters.map((h) => h.file);
  const keptPaths = new Set([
    ...inv.keptLive.productionFiles,
    ...partialLivePaths,
    ...inv.keptLive.liveResources,
    ...inv.keptLive.testFiles,
  ]);

  // Cross-bucket disjointness: dead ∩ anything-else = ∅.
  const legacyBuckets = [
    ['keptLive.productionFiles', inv.keptLive.productionFiles],
    ['partialLiveFiles', partialLivePaths],
    ['keptLive.liveResources', inv.keptLive.liveResources],
    ['keptLive.testFiles', inv.keptLive.testFiles],
    ['legacyTests', legacyTestPaths],
    ['hostedDeadImporters', hostedImporterPaths],
  ];
  for (const [bucketName, bucket] of legacyBuckets) {
    const seen = new Set();
    for (const p of bucket) {
      if (seen.has(p)) errors.push(`duplicate path inside ${bucketName}: ${p}`);
      seen.add(p);
      if (deadPaths.has(p)) errors.push(`path both dead and in ${bucketName}: ${p}`);
    }
  }

  // Partial-live containers: exhaustive row classification required — every
  // entry must carry at least one liveRow and, when it has dead rows, a
  // phase + justification per dead row.
  for (const entry of partialLiveEntries) {
    if (typeof entry === 'string') {
      errors.push(`partial-live entry must be an object with classified rows: ${entry}`);
      continue;
    }
    if (!entry.liveRows || entry.liveRows.length === 0) {
      errors.push(`partial-live container has NO live rows — it is wholly dead, classify it deadPhase4Files instead: ${entry.path}`);
    }
    for (const dr of entry.deadRows ?? []) {
      if (typeof dr.phase !== 'number') {
        errors.push(`partial-live dead row without phase: ${entry.path} :: ${String(dr.row).slice(0, 60)}…`);
      }
      if (!dr.justification || dr.justification.length < 10) {
        errors.push(`partial-live dead row without justification: ${entry.path} :: ${String(dr.row).slice(0, 60)}…`);
      }
    }
  }

  // Legacy tests: exact verdicts with phases.
  for (const t of inv.legacyTests) {
    if (!['delete', 'migrate', 'helper'].includes(t.verdict)) {
      errors.push(`legacyTests entry with unknown verdict '${t.verdict}': ${t.path}`);
    }
    if (!['3', '4'].includes(String(t.phase))) {
      errors.push(`legacyTests entry with non-phase phase '${String(t.phase)}': ${t.path}`);
    }
    if (!t.justification || t.justification.length < 10) {
      errors.push(`legacyTests entry without justification: ${t.path}`);
    }
  }

  // Unresolved closure: EMPTY, enforced forward by the partition scan. The
  // Phase-4 gate is unblocked exactly while unresolved is empty; a
  // non-empty unresolved list is no longer expressible without failing here.
  if (inv.unresolved.length !== 0) {
    errors.push(
      `unresolved must be EMPTY since Phase-2B (got ${inv.unresolved.length}): the partition ` +
        'scan enforces completeness — extend the scan with a classification, never this list',
    );
  }
  const blocked = inv.unresolved.length > 0;
  if (inv.phase4BlockedByUnresolved !== blocked) {
    errors.push(
      `phase4BlockedByUnresolved must be ${blocked} (unresolved.length=${inv.unresolved.length}): ` +
        'the flag is true exactly while unresolved is non-empty',
    );
  }

  // Presence counter (bidirectional, over the proven-complete set).
  if (blocked !== true && inv.presenceCounter.deferred !== false) {
    errors.push('presence counter must be LIVE (deferred:false) once unresolved is empty');
  }
  if (blocked === true && inv.presenceCounter.deferred !== true) {
    errors.push('presence counter must stay deferred while unresolved is non-empty');
  }
  if (inv.presenceCounter.deferred === false) {
    if (inv.presenceCounter.deadPathCount !== deadPaths.size) {
      errors.push(
        `presenceCounter.deadPathCount (${inv.presenceCounter.deadPathCount}) != actual dead ` +
          `path count (${deadPaths.size}) — the bidirectional counter fails on both early ` +
          'deletion and unreviewed dead-set growth',
      );
    }
    if (inv.presenceCounter.deadFileCount !== inv.deadPhase4Files.length) {
      errors.push('presenceCounter.deadFileCount != deadPhase4Files.length');
    }
    if (inv.presenceCounter.deadResourceCount !== inv.deadPhase4Resources.length) {
      errors.push('presenceCounter.deadResourceCount != deadPhase4Resources.length');
    }
  }

  // Every dead file/resource entry and every kept production/resource/test
  // path must resolve on disk TODAY (Phase-2B deletes nothing).
  for (const e of deadFileEntries) {
    if (!fs.existsSync(joinPath(root, e.path))) {
      errors.push(`dead entry path missing on disk (expected present-today): ${e.path}`);
    }
  }
  for (const p of keptPaths) {
    if (!fs.existsSync(joinPath(root, p))) {
      errors.push(`kept-live path missing on disk: ${p}`);
    }
  }

  // Retired handler ids = legacy six minus the live settlement id; the live
  // id must be part of the legacy baseline (cutover reduces, never invents).
  const retired = inv.legacyHandlerIds.filter((id) => id !== inv.liveHandlerId);
  if (retired.length !== inv.legacyHandlerIds.length - 1) {
    errors.push('liveHandlerId not present in legacyHandlerIds baseline');
  }
  if (new Set(inv.legacyHandlerIds).size !== inv.legacyHandlerIds.length) {
    errors.push('legacyHandlerIds contains duplicates');
  }

  // Phase-5 closure: exactly the ADR ten tables, each present in the fresh
  // SCHEMA_SQL today; kept tables present too; no dead index on a kept table.
  const schema = fs.readFileSync(joinPath(root, 'src/schema.ts'), 'utf8');
  if (inv.deadPhase5Tables.length !== 10) {
    errors.push(`expected exactly 10 dead phase-5 tables (ADR ratchet 5), got ${inv.deadPhase5Tables.length}`);
  }
  for (const t of inv.deadPhase5Tables) {
    if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(schema)) {
      errors.push(`dead phase-5 table not found in src/schema.ts: ${t}`);
    }
    if (inv.keptLive.keptTables.includes(t)) {
      errors.push(`table both dead and kept: ${t}`);
    }
  }
  for (const i of inv.deadPhase5Indexes) {
    if (!new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${i}\\b`).test(schema)) {
      errors.push(`dead phase-5 index not found in src/schema.ts: ${i}`);
    }
  }
  for (const t of inv.keptLive.keptTables) {
    if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(schema)) {
      errors.push(`kept table not found in src/schema.ts: ${t}`);
    }
  }
  for (const tg of inv.keptLive.keptTriggers) {
    if (!schema.includes(tg)) {
      errors.push(`kept trigger not found in src/schema.ts: ${tg}`);
    }
  }

  // Dead code-block entries live inside KEPT files (their host file survives;
  // only the block dies) — the host must be kept-live, not itself dead.
  // Phase-3.1/3.2 machine truthfulness: every phase-3 code-block carries
  // `status` ('executed'|'pending') + `contentMarkers`, and the on-disk host
  // file must AGREE in BOTH directions:
  //   status 'executed' → NO marker may remain in the host file (the block is
  //     really gone; re-adding any removed surface fails here);
  //   status 'pending'  → EVERY marker must still be present (the block is
  //     really there; claiming execution prematurely fails here).
  // The `listFilesOverride` hook does not apply here — markers always check
  // the real on-disk host files.
  for (const e of inv.deadPhase3) {
    if (e.kind === 'code-block' && deadPaths.has(e.path)) {
      errors.push(`phase-3 code-block host is itself a dead file: ${e.path}`);
    }
    if (e.kind !== 'code-block') continue;
    if (e.status !== 'executed' && e.status !== 'pending') {
      errors.push(`phase-3 code-block without status 'executed'|'pending': ${e.path}`);
      continue;
    }
    if (e.status === 'executed' && typeof e.executedAt !== 'string') {
      errors.push(`executed phase-3 code-block without executedAt: ${e.path}`);
    }
    if (!Array.isArray(e.contentMarkers) || e.contentMarkers.length === 0) {
      errors.push(`phase-3 code-block without contentMarkers: ${e.path}`);
      continue;
    }
    const hostText = fs.readFileSync(joinPath(root, e.path), 'utf8');
    for (const marker of e.contentMarkers) {
      const present = hostText.includes(marker);
      if (e.status === 'executed' && present) {
        errors.push(
          `phase-3 code-block claims status 'executed' but marker '${marker}' is still ` +
            `present in ${e.path} — the removal has NOT landed (untruthful executed state)`,
        );
      }
      if (e.status === 'pending' && !present) {
        errors.push(
          `phase-3 code-block claims status 'pending' but marker '${marker}' is absent ` +
            `from ${e.path} — either the block was removed without updating this inventory ` +
              'or the marker drifted (untruthful pending state)',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // REMOVAL SYMBOLS (Phase-2C) — structural validation. The allowedOutside
  // sets are DATA pinned to the 2026-08-24 src scan; here we prove they are
  // structurally sound (every allowed site is a classified, on-disk path;
  // every path token names its dead file; the dead-lane logicalIds exist in
  // the manifest today). The DYNAMIC enforcement (occurrences outside the
  // allowed sets are RED) lives in the ratchet suite via the Phase-2C
  // checks module — the validator here cannot see phase state.
  // -------------------------------------------------------------------------
  const symbols = inv.removalSymbols;
  if (!symbols || !Array.isArray(symbols.pathTokens) || !Array.isArray(symbols.namedSymbols)) {
    throw new Error(
      'ADR-095 removal inventory self-validation FAILED:\n  - removalSymbols section missing (required since schemaVersion 3 / Phase-2C)',
    );
  }
  const classifiedPaths = new Set([
    ...deadPaths,
    ...keptPaths,
    ...legacyTestPaths,
    ...hostedImporterPaths,
  ]);
  const checkAllowedOutside = (owner, list) => {
    for (const entry of list) {
      const p = typeof entry === 'string' ? entry : entry.path;
      if (!classifiedPaths.has(p)) {
        errors.push(`${owner}: allowedOutside path is not a classified inventory path: ${p}`);
      }
      if (!fs.existsSync(joinPath(root, p))) {
        errors.push(`${owner}: allowedOutside path missing on disk: ${p}`);
      }
      if (typeof entry === 'object' && ![3, 4].includes(entry.cleanedAtPhase)) {
        errors.push(`${owner}: allowedOutside entry without cleanedAtPhase 3|4: ${p}`);
      }
    }
  };
  const seenTokens = new Set();
  for (const t of symbols.pathTokens) {
    if (seenTokens.has(t.token)) errors.push(`duplicate path token: ${t.token}`);
    seenTokens.add(t.token);
    if (!deadPaths.has(t.deadFile)) {
      errors.push(`path token does not name a dead file: ${t.token} -> ${t.deadFile}`);
    }
    const base = t.deadFile.split('/').pop().replace(/\.ts$/, '');
    if (t.token !== `/${base}`) {
      errors.push(`path token '${t.token}' is not the basename of its dead file ${t.deadFile}`);
    }
    checkAllowedOutside(`pathToken ${t.token}`, t.allowedOutside);
  }
  // The collision-excluded tokens must stay excluded while their live
  // same-named siblings exist in other modules (they are pinned by
  // namedSymbols + the barrel's classified rows instead).
  const excludedTokens = ['/handler-adapter', '/tool-contributions'];
  for (const x of excludedTokens) {
    if (seenTokens.has(x)) errors.push(`collision-risk token must stay excluded from pathTokens: ${x}`);
  }
  const seenSymbols = new Set();
  for (const s of symbols.namedSymbols) {
    if (seenSymbols.has(s.symbol)) errors.push(`duplicate named symbol: ${s.symbol}`);
    seenSymbols.add(s.symbol);
    checkAllowedOutside(`namedSymbol ${s.symbol}`, s.allowedOutside);
  }
  const manifestSrc = fs.readFileSync(
    joinPath(root, 'src/process-modules/modules/discovery/package/manifest.ts'),
    'utf8',
  );
  const seenLogicalIds = new Set();
  for (const id of symbols.manifestDeadLaneLogicalIds) {
    if (seenLogicalIds.has(id)) errors.push(`duplicate dead-lane logicalId: ${id}`);
    seenLogicalIds.add(id);
    if (!manifestSrc.includes(id)) {
      errors.push(`dead-lane logicalId not present in manifest.ts today (pin is stale): ${id}`);
    }
  }
  for (const p of symbols.manifestDeadLaneAllowedIn) {
    if (!classifiedPaths.has(p) || !fs.existsSync(joinPath(root, p))) {
      errors.push(`manifestDeadLaneAllowedIn path not classified/on disk: ${p}`);
    }
  }
  for (const p of symbols.tableAllowedOutsideCommon) {
    if (!fs.existsSync(joinPath(root, p))) errors.push(`tableAllowedOutsideCommon path missing on disk: ${p}`);
  }
  for (const [table, paths] of Object.entries(symbols.tableAllowedOutsideSpecific ?? {})) {
    if (!inv.deadPhase5Tables.includes(table)) {
      errors.push(`tableAllowedOutsideSpecific key is not a dead phase-5 table: ${table}`);
    }
    for (const p of paths) {
      if (!fs.existsSync(joinPath(root, p))) {
        errors.push(`tableAllowedOutsideSpecific[${table}] path missing on disk: ${p}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // MANDATORY PHASE-5 REPINS (Red Team LOW-2, canonical Phase-3.1
  // integration). Structural truthfulness: every obligation names a real,
  // on-disk, CLASSIFIED hosted test file — a path that stops existing, or
  // one that was never classified in this inventory, fails here instead of
  // rotting as prose. (The listFilesOverride hook is intentionally NOT
  // applied: obligation targets are individually pinned files, and the
  // partition scan below already honors the override for scope.)
  // -------------------------------------------------------------------------
  if (!Array.isArray(inv.mandatoryPhase5Repins) || inv.mandatoryPhase5Repins.length === 0) {
    throw new Error(
      'ADR-095 removal inventory self-validation FAILED:\n  - mandatoryPhase5Repins section missing/empty ' +
        '(required since the canonical Phase-3.1 integration / Red Team LOW-2)',
    );
  }
  const seenPhase5RepinFiles = new Set();
  for (const entry of inv.mandatoryPhase5Repins) {
    if (seenPhase5RepinFiles.has(entry.file)) {
      errors.push(`duplicate mandatoryPhase5Repins file: ${entry.file}`);
    }
    seenPhase5RepinFiles.add(entry.file);
    if (!classifiedPaths.has(entry.file)) {
      errors.push(`mandatoryPhase5Repins file is not a classified inventory path: ${entry.file}`);
    }
    if (!fs.existsSync(joinPath(root, entry.file))) {
      errors.push(`mandatoryPhase5Repins file missing on disk: ${entry.file}`);
    }
    if (typeof entry.hostedIn !== 'string' || entry.hostedIn.trim().length === 0) {
      errors.push(`mandatoryPhase5Repins entry without hostedIn group: ${entry.file}`);
    }
    if (typeof entry.obligation !== 'string' || !entry.obligation.includes('factory_proposals')) {
      errors.push(
        `mandatoryPhase5Repins obligation must name the factory_proposals assertion it repins: ${entry.file}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // BIDIRECTIONAL SCOPED PARTITION SCAN (C6).
  // -------------------------------------------------------------------------
  const scanResult = runScopedPartitionScan(root, inv, listFilesOverride);
  errors.push(...scanResult.errors);

  if (errors.length > 0) {
    throw new Error(
      'ADR-095 removal inventory self-validation FAILED:\n  - ' + errors.join('\n  - '),
    );
  }
  return {
    retiredHandlerIds: retired,
    deadPaths,
    keptPaths,
    scopedFiles: scanResult.scopedFiles,
    classifiedPaths: scanResult.classifiedPaths,
  };
}

// Walks the scoped trees (+ individual files) and proves the on-disk file set
// equals the classified set, with exactly-one-bucket membership. When
// `listFilesOverride` is provided (a (dirTree) => string[] function), it
// replaces disk walking for the trees — the mutation-negative hook proving
// the scan is non-vacuous (an unclassified file, a missing classified file,
// or a double classification must all fail).
function runScopedPartitionScan(root, inv, listFilesOverride) {
  const errors = [];
  const trees = inv.scopedPartitionScan.directoryTrees;
  const individualFiles = inv.scopedPartitionScan.individualFiles;

  // Bucket membership sets.
  const deadPaths = new Set([
    ...inv.deadPhase3.filter((e) => e.kind === 'file' || e.kind === 'resource').map((e) => e.path),
    ...inv.deadPhase4Files.map((e) => e.path),
    ...inv.deadPhase4Resources.map((e) => e.path),
  ]);
  const keptFileBuckets = new Map([
    ['kept:production', inv.keptLive.productionFiles],
    ['kept:partialLive', (inv.keptLive.partialLiveFiles ?? []).map((p) => (typeof p === 'string' ? p : p.path))],
    ['kept:resources', inv.keptLive.liveResources],
    ['kept:tests', inv.keptLive.testFiles],
  ]);
  const legacyTests = new Set(inv.legacyTests.map((t) => t.path));
  const hostedImporters = new Set(inv.hostedDeadImporters.map((h) => h.file));

  const classify = (rel) => {
    const buckets = [];
    if (deadPaths.has(rel)) buckets.push('dead');
    for (const [name, list] of keptFileBuckets) {
      if (list.includes(rel)) buckets.push(name);
    }
    if (legacyTests.has(rel)) buckets.push('legacy-test');
    if (hostedImporters.has(rel)) buckets.push('hosted-importer');
    return buckets;
  };

  // Collect the on-disk scoped file set.
  const scopedFiles = new Set();
  for (const tree of trees) {
    const files = listFilesOverride
      ? listFilesOverride(tree)
      : walkTree(joinPath(root, tree)).map((abs) => toRelativePosix(root, abs));
    if (files === null) {
      errors.push(`scoped tree missing on disk: ${tree}`);
      continue;
    }
    for (const rel of files) scopedFiles.add(rel);
  }
  // Individual files: nested entries (e.g. package skill resources already
  // inside a tree) are fine but must not double-classify; every individual
  // file must exist on disk when no override is active.
  for (const rel of individualFiles) {
    const nested = scopedFiles.has(rel);
    if (!nested) {
      if (!listFilesOverride && !fs.existsSync(joinPath(root, rel))) {
        errors.push(`scoped individual file missing on disk: ${rel}`);
        continue;
      }
      scopedFiles.add(rel);
    }
  }

  // Direction 1 — every scoped on-disk file is classified in EXACTLY ONE bucket.
  for (const rel of scopedFiles) {
    const buckets = classify(rel);
    if (buckets.length === 0) {
      errors.push(`partition scan: UNCLASSIFIED scoped file: ${rel} (classify it or prove it out of scope — never ignore)`);
    } else if (buckets.length > 1) {
      errors.push(`partition scan: file classified in MULTIPLE buckets (${buckets.join(' + ')}): ${rel}`);
    }
  }

  // Direction 2 — every classified path inside the scoped universe exists in
  // the scoped on-disk set (no ghost classifications).
  const classifiedPaths = new Set([
    ...deadPaths,
    ...keptFileBuckets.get('kept:production'),
    ...keptFileBuckets.get('kept:partialLive'),
    ...keptFileBuckets.get('kept:resources'),
    ...keptFileBuckets.get('kept:tests'),
    ...legacyTests,
    ...hostedImporters,
  ]);
  for (const rel of classifiedPaths) {
    if (!scopedFiles.has(rel)) {
      // Files outside the scoped trees (e.g. kept tests in tests/factory-proof
      // or tests/matrix, kept src hosts like products.ts) are legitimate —
      // the scan scope covers the DISCOVERY universe; ghosts INSIDE the
      // scoped universe are what must fail. A classified path inside a
      // scoped tree prefix must appear in the scoped set.
      const insideScope = trees.some((tree) => rel.startsWith(`${tree}/`));
      if (insideScope) {
        errors.push(`partition scan: classified path inside a scoped tree but ABSENT from the scanned set: ${rel}`);
      }
    }
  }

  return { scopedFiles, classifiedPaths, errors };
}

function walkTree(absDir) {
  if (!fs.existsSync(absDir)) return null;
  const out = [];
  const stack = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

function toRelativePosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}
