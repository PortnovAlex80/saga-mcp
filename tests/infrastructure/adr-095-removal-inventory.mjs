// tests/infrastructure/adr-095-removal-inventory.mjs
//
// ADR-095 Phase-2A — the EXACT, machine-consumed Discovery-legacy removal
// inventory: the exact CLASSIFIED baseline, not a complete inventory (the
// distinction is load-bearing while `unresolved` is non-empty). This is NOT
// a test file (no *.test.mjs suffix, hosted by no matrix glob); it is the
// shared data module consumed by
// tests/architecture/adr-095-phase2-bridge-ratchets.test.mjs (blocking,
// architecture group) and available to every later ADR-095 phase.
//
// Derivation discipline (per the Phase-2A brief):
//   - every dead/kept classification below is derived from the production
//     code at HEAD + ADR-095 (docs/architecture/decisions/
//     095-complete-removal-of-dead-discovery-legacy.md) + the factory maps
//     (docs/factory-map/01_DISCOVERY.md DEAD/DECLARATIVE-ONLY STRATA 1-7,
//     GRAPH_RECONCILIATION dead-candidate classification) + the Phase-1
//     census (docs/factory-run/stage22-elite9/DISCOVERY-PHASE1-CENSUS.md);
//   - NO ambiguous residue is guessed: files whose exclusive-deadness is not
//     proven are listed in `unresolved` (dead paths classified so far: 35 =
//     26 phase-4 files + 9 dead-lane resources; kept paths: 43 = 20
//     fully-kept production files + 4 partial-live containers + 10 live
//     resources + 9 live test files) and the Phase-1 "full inventory" item
//     stays open (see PRE-ELITE9-TRACKER Point 5 phase 1);
//   - self-validation (validateAdr095Inventory) proves: entry uniqueness,
//     dead ∩ kept = ∅, every `present-today` file/resource path resolves on
//     disk, every table/index entry exists in src/schema.ts, the retired
//     handler-id set is exactly the ADR six-handler baseline minus the one
//     live settlement handler, the unresolved list never grows beyond its
//     pinned baseline of 5, every partial-live container carries its
//     row-level unresolved entry, and the `phase4BlockedByUnresolved` gate
//     is true exactly while unresolved is non-empty (atomic Phase-4 block).
//
// Phase semantics follow ADR-095's normative phase order:
//   phase 3 = live side-effect removal FIRST (writes stop while tables exist);
//   phase 4 = atomic version bump + manifest repin + dead code/resource
//             deletion + existing-DB boot test (one commit);
//   phase 5 = fresh-schema closure removal from SCHEMA_SQL (no DROP).
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
  schemaVersion: 1,
  decision: 'ADR-095',
  phaseAuthored: '2A',
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
  // -------------------------------------------------------------------------
  deadPhase3: Object.freeze([
    Object.freeze({
      kind: 'code-block',
      path: 'src/tools/products.ts',
      detail: 'product_submit discovery projection block (requiresDiscoveryProjection/' +
        'projectDiscoveryProposal call + PROPOSAL_REF_SCHEMA product emission), the ' +
        'projectDiscoveryProposal/PROPOSAL_REF_SCHEMA imports, and the ' +
        'discovery_proposal_id response field',
      evidence: 'ADR-095 Decision 1 bullet 1; 01_DISCOVERY.md map §PURPOSE edge 5 (LIVE WRITER); ' +
        'reverse-dep scan: products.ts is the only src importer of discovery-proposal-projection',
      sameCommitObligations: Object.freeze([
        'tests/replay/conveyor-v4.3-focused-invariants.test.mjs imports ' +
        'dist/modules/discovery/infrastructure/discovery-proposal-projection.js ' +
        '(unhosted legacy-only consumer — migrate or delete under the operator-approved list)',
      ]),
    }),
    Object.freeze({
      kind: 'code-block',
      path: 'src/tools/settlement-debug.ts',
      detail: 'settlement_explain legacy Discovery query over factory_discovery_settlements ' +
        '(discoverySettlement block; the TOOL ITSELF STAYS for non-Discovery traces)',
      evidence: 'ADR-095 Decision 1 bullet 1; map CONTRADICTIONS context (settlement-debug.ts:117-139)',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'code-block',
      path: 'src/app/product-lifecycle-runtime.ts',
      detail: 'the shared runtimePersistence construction (options.discoveryRuntimePersistence ' +
        '?? new SqliteFactoryDiscoveryRuntime()) and its runtimePersistence hand-off into ' +
        'module registration; the file ITSELF STAYS',
      evidence: 'ADR-095 Decision 3 (F2); map STRATA 4; 01_DISCOVERY.md §6.4',
      sameCommitObligations: Object.freeze([]),
    }),
    Object.freeze({
      kind: 'code-block',
      path: 'src/modules/module-registration.ts',
      detail: 'the ModuleSharedDeps.runtimePersistence field (FactoryDiscoveryRuntimePersistence ' +
        'type import + field); the file ITSELF STAYS',
      evidence: 'ADR-095 Decision 3 (F2); module-registration.ts:23,64',
      sameCommitObligations: Object.freeze([]),
    }),
  ]),

  // -------------------------------------------------------------------------
  // DEAD — phase 4: the atomic cutover commit (module-version bump + manifest
  // repin to the production-cell digest + code/resource deletion).
  // -------------------------------------------------------------------------
  deadPhase4Files: Object.freeze([
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/infrastructure/discovery-proposal-projection.ts',
      detail: 'the product_submit → factory_proposals projection implementation. Its LAST live ' +
        'consumption (the products.ts block) is removed in phase 3; the file deletion lands ' +
        'with the phase-4 code deletion (still 1 src importer today — the live writer)',
      evidence: 'ADR-095 Decision 1 bullet 1 + pre-mortem F1 (the LIVE WRITER; writer removed FIRST, ' +
        'schema only at phase 5); src reverse-dep scan: sole src importer is src/tools/products.ts',
      sameCommitObligations: Object.freeze([
        'phase 3 must remove the products.ts projection block FIRST (deadPhase3[0]); ' +
        'tests/replay/conveyor-v4.3-focused-invariants.test.mjs imports it (unhosted legacy-only consumer)',
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
        'via dist; ADR-095 six-blocker list)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-proposal-tools.ts',
      detail: 'dead MCP discovery proposal tool (proposal_submit lane); no MCP composition import',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 3; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs imports it (unhosted legacy-only consumer)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-normalization-tools.ts',
      detail: 'dead MCP normalization tool',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 3; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs, ' +
        'tests/discovery/d2-normalization-lineage.test.mjs import it (unhosted legacy-only consumers)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-readiness-tools.ts',
      detail: 'dead MCP readiness tool',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 3; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs, ' +
        'tests/discovery/d3-readiness-{correction,handler,index-migration}.test.mjs import it (unhosted legacy-only consumers)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/tools/discovery-tool-args.ts',
      detail: 'shared helpers of the three dead MCP discovery tools only',
      evidence: 'ADR-095 Decision 1 bullet 2; src reverse-dep scan: imported ONLY by the three dead tool files',
      sameCommitObligations: Object.freeze([
        'tests/characterization/mcp-catalog-authority-errors.test.mjs, ' +
        'tests/discovery/tool-actionable-errors.test.mjs import it (unhosted legacy-only consumers)',
      ]),
    }),
    Object.freeze({
      kind: 'file',
      path: 'src/modules/discovery/application/discovery-settlement-service.ts',
      detail: 'legacy FactoryDiscoverySettlementService — no production construction site',
      evidence: 'ADR-095 Decision 1 bullet 2; 01_DISCOVERY.md STRATA 2; src reverse-dep scan: 0 src importers',
      sameCommitObligations: Object.freeze([
        'tests/discovery/d4-settlement-{persistence,recovery}.test.mjs, ' +
        'tests/discovery/d5-certificate-bundle.test.mjs import it (unhosted legacy-only consumers)',
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
        'architecture glob) imports it — re-point its fixture at the kept factory_work_intents ' +
        'schema (the TABLE STAYS; only this adapter import dies)',
        'unhosted legacy-only test consumers: tests/discovery/d4-settlement-atomicity, ' +
        'd4-settlement-persistence, d4-settlement-recovery, d5-certificate-bundle',
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
      detail: 'PROPOSAL_REF_SCHEMA bridge (phase 3 removes its live emission from products.ts)',
      evidence: 'ADR-095 Decision 1 bullet 1+2; src reverse-dep scan: after phase 3 only the dead proposal tool imports it',
      sameCommitObligations: Object.freeze([
        'tests/modules/discovery/proposal-ref-bridge.test.mjs imports it (unhosted legacy-only consumer)',
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
        'drop the barrel re-exports from package/contributions/index.ts in the same commit',
        'update tests/process-modules/discovery-package-contributions.test.mjs (BLOCKING-hosted; ' +
        'ADR-095 six-blocker list) to pin the live one-handler contributions',
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
        'drop the discovery.skill.normalizer resourceIndex entry + reviewer-skills pin in the same commit',
      ]),
    }),
    Object.freeze({
      kind: 'resource',
      path: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-diagnosis-advisor/SKILL.md',
      detail: 'dead diagnosis lane execution skill (logicalId discovery.skill.diagnosis-advisor)',
      evidence: 'ADR-095 Decision 1 bullet 5; 01_DISCOVERY.md STRATA 5 (diagnosis flow deleted from the module)',
      sameCommitObligations: Object.freeze([
        'drop the discovery.skill.diagnosis-advisor resourceIndex entry + reviewer-skills pin in the same commit',
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
        'production-cell installation bytes; product-discovery version bumped ATOMICALLY',
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
  // by any phase. PARTIAL-LIVE entries (partialLiveFilesWithUnresolvedRows):
  // kept AS CONTAINERS — row-level repoint/removal inside them is allowed
  // (and partly REQUIRED by phase-4 same-commit obligations, e.g. dropping
  // the dead-lane reviewer-skill pins) while whole-FILE deletion is
  // FORBIDDEN until their unresolved row-level classification closes.
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
      'src/modules/discovery/domain/discovery-domain-contracts.ts',
      'src/process-modules/modules/discovery/discovery-process-module.ts',
      'src/process-modules/modules/discovery/package/manifest.ts',
      'src/process-modules/modules/discovery/package/assistance.ts',
      'src/process-modules/modules/discovery/package/contributions/index.ts',
      'src/process-modules/modules/discovery/package/index.ts',
      'src/tools/products.ts',
      'src/tools/settlement-debug.ts',
      'src/app/product-lifecycle-runtime.ts',
      'src/modules/module-registration.ts',
      'src/infrastructure/process-modules/brief-provisioning-ports.ts',
      'src/process-modules/lifecycles/product-delivery-module-contracts.ts',
    ]),
    // KEPT AS CONTAINERS, unresolved at ROW level (each has a matching
    // `unresolved` entry below): these files carry live rows AND rows whose
    // dead-vs-live classification is still open. Row-level repoint/removal
    // is allowed; whole-file deletion is forbidden until resolved.
    partialLiveFilesWithUnresolvedRows: Object.freeze([
      'src/process-modules/modules/discovery/package/contributions/tool-contributions.ts',
      'src/process-modules/modules/discovery/package/contributions/output-contracts.ts',
      'src/process-modules/modules/discovery/package/contributions/acceptance-capabilities.ts',
      'src/process-modules/modules/discovery/package/contributions/reviewer-skills.ts',
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
    // untouched. The four Discovery orphans were hosted BLOCKING in Phase-2A
    // (matrix group discovery-live-v2); migration-conformance was hosted
    // BLOCKING green-on-legacy-baseline in the process-modules group.
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
    ]),
  }),

  // -------------------------------------------------------------------------
  // UNRESOLVED — residue NOT classified by this baseline. Do not guess these;
  // each needs its own proven derivation before Phase 4. MONOTONE ratchet:
  // the exact baseline is 5 (4 partial-live contribution containers +
  // 1 legacy-only test list); entries may only be RESOLVED (removed), never
  // added — validateAdr095Inventory rejects growth beyond the baseline. The
  // Phase-1 "full live-v2/dead-legacy/shared inventory" item in the
  // PRE-ELITE9 tracker stays OPEN until this list is empty.
  // -------------------------------------------------------------------------
  unresolved: Object.freeze([
    Object.freeze({
      path: 'src/process-modules/modules/discovery/package/contributions/tool-contributions.ts',
      question: 'KEPT AS A CONTAINER (keptLive.partialLiveFilesWithUnresolvedRows). The open ' +
        'question is ROW-level: which DISCOVERY_TOOL_CONTRIBUTIONS rows (the legacy ' +
        'proposal/normalization/readiness/diagnosis submit-get lanes) are dead-lane data vs ' +
        'live declared capability surface? Requires a map of consumers before Phase 4 decides ' +
        'row-level repoint/removal — whole-file deletion is forbidden until this closes.',
    }),
    Object.freeze({
      path: 'src/process-modules/modules/discovery/package/contributions/output-contracts.ts',
      question: 'KEPT AS A CONTAINER (partialLiveFilesWithUnresolvedRows). Open question is ' +
        'ROW-level: which DISCOVERY_NORMALIZATION/READINESS/DIAGNOSIS_BUNDLE_CONTRACT rows are ' +
        'dead-lane data vs live declared output contracts? Same row-level rule as ' +
        'tool-contributions.',
    }),
    Object.freeze({
      path: 'src/process-modules/modules/discovery/package/contributions/acceptance-capabilities.ts',
      question: 'KEPT AS A CONTAINER (partialLiveFilesWithUnresolvedRows). Open question is ' +
        'ROW-level: several rows name legacy capabilities (DISCOVERY_CAP_RUNTIME_PERSISTENCE, ' +
        'DISCOVERY_CAP_SETTLEMENT_POLICY_REPOSITORY, DISCOVERY_GUARD_DIAGNOSIS_ADVISORY…) — ' +
        'which rows die with the legacy lanes and which stay live?',
    }),
    Object.freeze({
      path: 'src/process-modules/modules/discovery/package/contributions/reviewer-skills.ts',
      question: 'KEPT AS A CONTAINER (partialLiveFilesWithUnresolvedRows). Open question is ' +
        'ROW-level: live lanes stay; the dead normalizer/diagnosis-advisor pins ' +
        '(DISCOVERY_NORMALIZER_SKILL, DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL) are Phase-4 ' +
        'same-commit obligations already recorded on the resource entries — the ROW ' +
        'classification of the remaining pins is what stays open.',
    }),
    Object.freeze({
      path: 'tests/discovery/*.test.mjs (d1-d7 legacy suites) + tests/characterization/' +
        'mcp-catalog-authority-errors.test.mjs + tests/discovery/tool-actionable-errors.test.mjs ' +
        '+ tests/modules/discovery/proposal-ref-bridge.test.mjs + tests/replay/' +
        'conveyor-v4.3-focused-invariants.test.mjs',
      question: 'the legacy-only TEST deletion list (operator-approved by ADR-095 §7): each file ' +
        'must be proven to exercise ONLY removed surfaces (exclusive-legacy justification) ' +
        'before deletion executes; tests also covering live v2 behavior migrate FIRST. The ' +
        'per-entry sameCommitObligations fields above record the consumers; the migrate-vs-delete ' +
        'decision per file is the still-open half of Phase 1.',
    }),
  ]),

  // -------------------------------------------------------------------------
  // Phase-4 atomic machine gate: while ANY unresolved entry remains, Phase 4
  // (the deletion cutover) MUST NOT land. validateAdr095Inventory enforces
  // the coupling: this flag is true EXACTLY WHILE unresolved is non-empty —
  // clearing it requires emptying unresolved in the SAME commit, and
  // resolving the last entry requires clearing the flag (and adding the
  // presence counter) in the same commit. No partial states.
  // -------------------------------------------------------------------------
  phase4BlockedByUnresolved: true,

  // -------------------------------------------------------------------------
  // Honest deferral: NO dead-file presence counter exists in Phase-2A. A
  // both-directions counter (fails on early deletion AND on new dead files)
  // is only honest once the dead set is PROVEN complete; today the unresolved
  // list is non-empty, so such a counter could pass while the classification
  // is wrong. Phase 2 (full inventory closure) empties unresolved, clears
  // phase4BlockedByUnresolved, and adds the counter — all in the same commit.
  // -------------------------------------------------------------------------
  presenceCounter: Object.freeze({
    deferred: true,
    reason: 'the dead-file set is not proven complete (see `unresolved`): a bidirectional ' +
      'presence counter over an incomplete inventory is dishonest — it would pass while ' +
      'ambiguous residue is unclassified. Add the counter only when unresolved.length === 0.',
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
      obligation: 'hosted BLOCKING (process-modules group) in Phase-2A GREEN on the legacy ' +
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
});

// ---------------------------------------------------------------------------
// Self-validation. Fail-closed: importing tests call this and it throws with
// a precise message on any structural defect. Pure sync checks only. The
// optional `inventory` argument (defaults to ADR_095_INVENTORY) exists so
// tests can PROVE the machine rules fire — e.g. that a decoupled
// phase4BlockedByUnresolved flag is rejected — instead of trusting that the
// current object merely satisfies them.
// ---------------------------------------------------------------------------

// Monotone baseline: `unresolved` starts at exactly five entries and may
// only shrink. Growth is a classification regression, never progress.
const UNRESOLVED_BASELINE = 5;

export function validateAdr095Inventory(repoRoot, inventory = ADR_095_INVENTORY) {
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

  const partialLive = inv.keptLive.partialLiveFilesWithUnresolvedRows ?? [];
  const keptPaths = new Set([
    ...inv.keptLive.productionFiles,
    ...partialLive,
    ...inv.keptLive.liveResources,
    ...inv.keptLive.testFiles,
  ]);
  for (const p of keptPaths) {
    if (deadPaths.has(p)) errors.push(`path both dead and kept: ${p}`);
  }

  // Partial-live containers are KEPT as files with ROW-level questions open:
  // each must carry its matching unresolved entry and must not be
  // double-listed as fully kept.
  const unresolvedPaths = new Set(inv.unresolved.map((u) => u.path));
  for (const p of partialLive) {
    if (inv.keptLive.productionFiles.includes(p)) {
      errors.push(`partial-live container double-listed as fully-kept: ${p}`);
    }
    if (!unresolvedPaths.has(p)) {
      errors.push(`partial-live container missing its row-level unresolved entry: ${p}`);
    }
  }

  // Unresolved monotonicity: entries may only be resolved (removed), never
  // added — growth beyond the pinned baseline is a regression.
  if (inv.unresolved.length > UNRESOLVED_BASELINE) {
    errors.push(
      `unresolved list GREW beyond the pinned baseline ${UNRESOLVED_BASELINE} ` +
        `(got ${inv.unresolved.length}) — unresolved may only shrink`,
    );
  }

  // Phase-4 atomic gate: blocked exactly while unresolved is non-empty. The
  // flag cannot be cleared early (deletion cutover while rows are
  // unclassified) and cannot linger after closure.
  const blocked = inv.unresolved.length > 0;
  if (inv.phase4BlockedByUnresolved !== blocked) {
    errors.push(
      `phase4BlockedByUnresolved must be ${blocked} (unresolved.length=${inv.unresolved.length}): ` +
        'Phase 4 is blocked exactly while unresolved is non-empty; the flag flips atomically ' +
        'with the last resolution (same commit)',
    );
  }
  if (blocked && inv.presenceCounter.deferred !== true) {
    errors.push('presence counter must stay deferred while unresolved is non-empty');
  }
  if (!blocked && inv.presenceCounter.deferred === true) {
    errors.push(
      'unresolved is empty but the presence counter is still deferred — add the bidirectional ' +
        'counter and clear deferred in the same commit as the last resolution',
    );
  }

  // Every dead file/resource entry and every kept production/resource/test
  // path must resolve on disk TODAY (Phase-2A deletes nothing).
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
  for (const e of inv.deadPhase3) {
    if (e.kind === 'code-block' && deadPaths.has(e.path)) {
      errors.push(`phase-3 code-block host is itself a dead file: ${e.path}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      'ADR-095 removal inventory self-validation FAILED:\n  - ' + errors.join('\n  - '),
    );
  }
  return { retiredHandlerIds: retired, deadPaths, keptPaths };
}
