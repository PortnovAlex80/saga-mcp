/**
 * tools/frf-corpus/lib/material.mjs - the green seed material of the FRF
 * scenario corpus (FRF-WP10).
 *
 * THE WIRING LAW (the same one the cells' own focused suites use): the
 * corpus drives the cells' TEST-ONLY surfaces through their exported
 * functions ONLY - it never writes kernel storage, never opens a kernel
 * database, and never touches a cell's internals. The WP03 contract
 * validators are loaded from the frozen docs tree and installed into the
 * cell seams exactly the documented way (content-addressed to the
 * validator file bytes); the .mjs cells import the docs tree themselves
 * through their single seam import site.
 *
 * The green material below is AUTHORED DATA over the frozen WP03 fixture
 * corpus (never derived from the validators under test): the accepted
 * Discovery claim sets, the six PRD intent members, the two UC scenarios,
 * the four requirements, the acceptance criteria, the architecture
 * realization draft, the twelve-kind handoff and the WorkItem set.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WP03 = join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts');

/** Windows-safe dynamic import of an absolute path. */
export const importAbs = (absolute) => import(pathToFileURL(absolute).href);
/** Import a compiled cell module from dist (the TS cells' public surface). */
export const dist = (relative) => importAbs(join(REPO_ROOT, 'dist', `${relative}.js`));
/** Import a source cell module (the .mjs cells' public surface). */
export const src = (...parts) => importAbs(join(REPO_ROOT, 'src', ...parts));

const sha256OfBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const readJson = (...parts) => JSON.parse(readFileSync(join(...parts), 'utf8'));

/* ------------------------------------------------------------------ */
/* The frozen WP03 fixture corpus (independent evidence)               */
/* ------------------------------------------------------------------ */

export const acceptedIdSets = () => readJson(WP03, 'fixtures', 'accepted-id-sets.json').idSets;
export const acceptedIdSetsDoc = () => readJson(WP03, 'fixtures', 'accepted-id-sets.json');
export const greenBaselineFixture = () => readJson(WP03, 'fixtures', 'green', 'what-baseline.json');
export const greenPrdMemberFixture = () => readJson(WP03, 'fixtures', 'green', 'prd-intent-member.json');
export const greenUcScenarioFixture = () => readJson(WP03, 'fixtures', 'green', 'uc-scenario-member.json');
export const greenRequirementsFixture = () => readJson(WP03, 'fixtures', 'green', 'requirements-bundle.json');
export const greenAcBindingFixture = () => readJson(WP03, 'fixtures', 'green', 'ac-binding.json');

/** Load a WP03 validator module from the frozen docs tree. */
export const wp03Validator = (name) => importAbs(join(WP03, 'validators', `${name}.mjs`));

/** The frozen WP03 validator file digest (the seam pin). */
export const wp03ValidatorDigest = (name) => sha256OfBytes(readFileSync(join(WP03, 'validators', `${name}.mjs`)));

/* ------------------------------------------------------------------ */
/* The one-time cell wiring (the documented seams)                     */
/* ------------------------------------------------------------------ */

let wiring = null;

/** Wire every cell seam exactly once per process (idempotent by digest). */
export async function wireCells() {
  if (wiring !== null) return wiring;
  const productIntent = await dist('workflow-kernel/workshops/formalization/cells/product-intent/index');
  const useCases = await dist('workflow-kernel/workshops/formalization/cells/use-cases/index');
  const systemRequirements = await dist('workflow-kernel/workshops/formalization/cells/system-requirements/index');
  const srsRealization = await dist('workflow-kernel/workshops/formalization/cells/srs-realization/index');

  const prdWp03 = await wp03Validator('prd-intent-member');
  const prdInstall = productIntent.installProductIntentContract({
    contractKind: 'frf-contracts.prd-intent-member.v1',
    validatorDigest: wp03ValidatorDigest('prd-intent-member'),
    validateMember: (member, universe) => prdWp03.validatePrdIntentMember(member, universe),
  });
  if (prdInstall.installed !== true) throw new Error(`product-intent seam refused: ${JSON.stringify(prdInstall)}`);

  const ucWp03 = await wp03Validator('uc-scenario-member');
  const ucInstall = useCases.installUcScenarioContract({
    contractKind: 'frf-contracts.uc-scenario-member.v1',
    validatorDigest: wp03ValidatorDigest('uc-scenario-member'),
    validateScenario: (scenario, universe) => ucWp03.validateUcScenarioMember(scenario, universe),
  });
  if (ucInstall.installed !== true) throw new Error(`use-cases seam refused: ${JSON.stringify(ucInstall)}`);

  const reqWp03 = await wp03Validator('requirements-bundle');
  const reqBinding = systemRequirements.bindWp03RequirementsValidator(reqWp03);
  if (reqBinding.bound !== true) throw new Error(`system-requirements seam refused: ${JSON.stringify(reqBinding)}`);
  const acceptance = await src('workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'index.mjs');
  const freeze = await src('workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'freeze.mjs');
  const ingestion = await src('workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'ingestion.mjs');
  const settlement = await src('workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'settlement.mjs');
  const persistence = await src('workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'persistence.mjs');
  const caseDesk = await src('workflow-kernel', 'workshops', 'development', 'handoff', 'case.mjs');
  const workitemDesk = await src('workflow-kernel', 'workshops', 'development', 'handoff', 'workitem.mjs');
  const planDesk = await src('workflow-kernel', 'workshops', 'development', 'handoff', 'plan.mjs');
  const preservationDesk = await src('workflow-kernel', 'workshops', 'development', 'handoff', 'preservation.mjs');
  const lifecycleDesk = await src('workflow-kernel', 'workshops', 'development', 'handoff', 'lifecycle.mjs');

  wiring = {
    acceptance,
    caseDesk,
    freeze,
    ingestion,
    lifecycleDesk,
    persistence,
    planDesk,
    preservationDesk,
    productIntent,
    reqBinding,
    reqWp03,
    settlement,
    srsRealization,
    systemRequirements,
    useCases,
    workitemDesk,
  };
  return wiring;
}

/* ------------------------------------------------------------------ */
/* The green desk-chain material (authored over the WP03 id sets)      */
/* ------------------------------------------------------------------ */

/** The accepted-id-set universe of the product-intent desk. */
export const prdUniverseOf = () => {
  const sets = acceptedIdSets();
  return { idSets: { sourceClaimIds: sets.sourceClaimIds, terminalClaimIds: sets.terminalClaimIds } };
};

/** The green PRD bundle: six members jointly covering every accepted claim. */
export function greenPrdBundle() {
  return {
    schemaVersion: 'frf-cell.product-intent.v1',
    brief: 'A checkout shopping service with an audited nightly settlement batch.',
    members: [
      greenPrdMemberFixture(),
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:boundary-1',
        memberKind: 'system-boundary',
        statement: 'The checkout service and its nightly batch are inside the boundary; external payment providers are outside.',
        sourceClaimRefs: ['claim:scope-1'],
        disposition: { disposition: 'scenario_required' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:constraint-1',
        memberKind: 'constraint',
        statement: 'Responses are deterministic; the batch writes an audit trail for every charge.',
        sourceClaimRefs: ['claim:constraint-1'],
        disposition: { disposition: 'direct_requirement', reason: 'An operational determinism constraint with no meaningful interaction scenario.' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:scope-2',
        memberKind: 'scope-exclusion',
        statement: 'Multi-currency settlement is excluded from this release.',
        sourceClaimRefs: ['claim:scope-2'],
        disposition: { disposition: 'out_of_scope', owner: 'product-owner', reason: 'Deferred to the next release by the discovery decision.' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:terminal-1',
        memberKind: 'terminal-claim',
        statement: 'At terminal state every charge is settled or recorded failed with an audit entry.',
        sourceClaimRefs: ['claim:outcome-1'],
        terminalClaimRefs: ['terminal:audited-1'],
        disposition: { disposition: 'scenario_required' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:unknown-1',
        memberKind: 'assumption-unknown',
        statement: 'The browser support matrix is unknown at formalization time.',
        sourceClaimRefs: ['claim:constraint-1'],
        disposition: { disposition: 'deferred', owner: 'discovery', reason: 'Browser support matrix unknown (owner: discovery).' },
      },
    ],
  };
}

/** The green UC bundle: the WP03 green checkout scenario + the batch scenario. */
export function greenUcBundle() {
  return {
    schemaVersion: 'frf-cell.uc-scenarios.v1',
    scenarios: [
      greenUcScenarioFixture(),
      {
        schemaVersion: 'frf-contracts.uc-scenario-member.v1',
        scenarioId: 'uc:batch-1',
        actorKind: 'scheduler_or_clock',
        actorIdentity: 'the nightly settlement tick',
        goal: 'Settle every pending charge of the day with an audit trail',
        trigger: 'The nightly tick fires at 02:00',
        preconditions: ['pending charges exist from the day'],
        operationalSteps: [
          'The tick selects all pending charges',
          'The system charges each selected order',
          'The system writes the audit trail entry for every charge',
        ],
        alternateFlows: [],
        errorFlows: [
          {
            branchId: 'branch:batch-error',
            steps: [
              'A charge fails',
              'The system records the failed charge and keeps the order pending',
            ],
          },
        ],
        terminalBranches: [
          { branchId: 'branch:batch-main', branchKind: 'main', terminalResult: 'Batch settled with audit entries for every charge' },
          { branchId: 'branch:batch-error', branchKind: 'error', terminalResult: 'Failed charge recorded, order kept pending, audit entry written' },
        ],
        postcondition: 'Every charge is settled or recorded failed with an audit entry',
        prdIntentRefs: ['prd:boundary-1', 'prd:terminal-1'],
        evidenceKindRefs: ['audit'],
      },
    ],
  };
}

/** The system-requirements desk input over the frozen WP03 id sets. */
export function greenReqDeskInput() {
  const sets = acceptedIdSetsDoc();
  return {
    prd: { revisionDigest: sets.revisionPins.prd, memberIds: sets.idSets.prdMemberIds },
    useCases: {
      revisionDigest: sets.revisionPins.uc,
      scenarioIds: sets.idSets.ucScenarioIds,
      branchIdsByScenario: sets.idSets.ucBranchIdsByScenario,
    },
    sourceConstraintIds: sets.idSets.sourceConstraintIds,
    verificationSurfaceIds: sets.idSets.verificationSurfaceIds,
  };
}

/** The authored green requirements (the four members, WP03-shaped). */
export function greenReqMembers() {
  return [
    {
      requirementId: 'fr:cart-1',
      requirementKind: 'FR',
      statement: 'The system shall compute cart totals, take payment and emit an order confirmation for the checkout scenario.',
      prdIntentRefs: ['prd:outcome-1'],
      ucScenarioRefs: ['uc:checkout-1'],
      ucTerminalBranchRefs: ['branch:checkout-alt', 'branch:checkout-main'],
      verificationSurfaceRefs: ['surface:test-suite-1'],
    },
    {
      requirementId: 'fr:batch-1',
      requirementKind: 'FR',
      statement: 'The system shall process the scheduled batch idempotently and record an observable batch result.',
      prdIntentRefs: ['prd:scope-2', 'prd:terminal-1'],
      ucScenarioRefs: ['uc:batch-1'],
      ucTerminalBranchRefs: ['branch:batch-main'],
      verificationSurfaceRefs: ['surface:batch-audit-1'],
    },
    {
      requirementId: 'nfr:retention-1',
      requirementKind: 'NFR',
      statement: 'Order records shall be retained for the compliance-pinned period.',
      prdIntentRefs: ['prd:constraint-1'],
      sourceConstraintRefs: ['constraint:retention-1'],
      verificationSurfaceRefs: ['surface:batch-audit-1'],
    },
    {
      requirementId: 'rule:audit-1',
      requirementKind: 'RULE',
      statement: 'Every emitted order confirmation shall be audit-logged inside the system boundary.',
      prdIntentRefs: ['prd:boundary-1'],
      verificationSurfaceRefs: ['surface:batch-audit-1'],
    },
  ];
}

/**
 * The acceptance-desk universe inputs over the accepted material (the
 * five requirements incl. the deferred telemetry NFR, mirroring the
 * accepted material the desk's own fixtures carry).
 */
export function greenAcceptanceInputs() {
  const sets = acceptedIdSets();
  return {
    requirementsBundle: {
      requirements: [
        ...greenReqMembers().map((member) => ({
          requirementId: member.requirementId,
          requirementKind: member.requirementKind,
          statement: member.statement,
          derivation: {
            prdIntentRefs: [...member.prdIntentRefs],
            ...(member.ucScenarioRefs ? { ucScenarioRefs: [...member.ucScenarioRefs] } : {}),
            ...(member.ucTerminalBranchRefs ? { ucTerminalBranchRefs: [...member.ucTerminalBranchRefs] } : {}),
            ...(member.sourceConstraintRefs ? { sourceConstraintRefs: [...member.sourceConstraintRefs] } : {}),
          },
          verificationSurfaceRefs: [...member.verificationSurfaceRefs],
        })),
        {
          requirementId: 'nfr:telemetry-1',
          requirementKind: 'NFR',
          statement: 'Operational telemetry shall be retained for the agreed window.',
          derivation: { prdIntentRefs: ['prd:unknown-1'] },
          verificationSurfaceRefs: ['surface:batch-audit-1'],
        },
      ],
    },
    useCases: {
      scenarioIds: sets.ucScenarioIds,
      branchIdsByScenario: sets.ucBranchIdsByScenario,
    },
    verifiableStatementIds: ['stmt:checkout-when-1', 'stmt:batch-when-1', 'stmt:retention-when-1'],
    evidenceBindings: [
      {
        evidenceBindingId: 'ev:audit-1',
        evidenceKind: 'audit',
        ucTerminalBranchRefs: ['branch:batch-error'],
        observableTerminalResult: 'Failed batch runs are recorded and audited',
      },
    ],
  };
}

/** The green acceptance bundle (criteria + the telemetry deferral). */
export function greenAcceptanceBundle() {
  return {
    schemaVersion: 'formalization.acceptance-bindings.v1',
    criteria: [
      {
        schemaVersion: 'frf-contracts.ac-binding.v1',
        criterionId: 'ac:checkout-end-1',
        bindsTo: {
          requirementRefs: ['fr:cart-1'],
          ucScenarioRefs: ['uc:checkout-1'],
          ucTerminalBranchRefs: ['branch:checkout-main'],
        },
        evidence: { evidenceKind: 'test', observableTerminalResult: 'Order delivered and confirmed' },
        verifiableStatementRefs: ['stmt:checkout-when-1'],
      },
      {
        schemaVersion: 'frf-contracts.ac-binding.v1',
        criterionId: 'ac:checkout-alt-1',
        bindsTo: {
          requirementRefs: ['fr:cart-1'],
          ucScenarioRefs: ['uc:checkout-1'],
          ucTerminalBranchRefs: ['branch:checkout-alt'],
        },
        evidence: { evidenceKind: 'test', observableTerminalResult: 'Payment failure returns the customer to the cart with a retry option' },
        verifiableStatementRefs: ['stmt:checkout-when-1'],
      },
      {
        schemaVersion: 'frf-contracts.ac-binding.v1',
        criterionId: 'ac:batch-main-1',
        bindsTo: {
          requirementRefs: ['fr:batch-1'],
          ucScenarioRefs: ['uc:batch-1'],
          ucTerminalBranchRefs: ['branch:batch-main'],
        },
        evidence: { evidenceKind: 'monitoring', observableTerminalResult: 'Batch result recorded and observable' },
        verifiableStatementRefs: ['stmt:batch-when-1'],
      },
      {
        schemaVersion: 'frf-contracts.ac-binding.v1',
        criterionId: 'ac:retention-1',
        bindsTo: {
          requirementRefs: ['nfr:retention-1'],
        },
        evidence: { evidenceKind: 'audit', observableTerminalResult: 'Retained order records are retrievable for the compliance-pinned period' },
        verifiableStatementRefs: ['stmt:retention-when-1'],
      },
    ],
    deferrals: [
      {
        requirementId: 'nfr:telemetry-1',
        disposition: 'deferred',
        owner: 'platform-ops',
        reason: 'Telemetry retention window not agreed with the customer; no AC can be verified yet',
      },
    ],
    standaloneEvidenceBindings: [
      {
        evidenceBindingId: 'ev:audit-1',
        evidenceKind: 'audit',
        ucTerminalBranchRefs: ['branch:batch-error'],
        observableTerminalResult: 'Failed batch runs are recorded and audited',
      },
    ],
  };
}

/** The exact accepted-authority surfaces decomposed from the WP03 green fixture. */
export function acceptedSurfacesOf(green = greenBaselineFixture()) {
  return {
    caseIdentity: structuredClone(green.caseIdentity),
    sourceManifests: structuredClone(green.sourceManifests),
    acceptanceRecords: structuredClone(green.acceptanceRecords),
    containers: structuredClone(green.containers),
    traceSet: { traces: structuredClone(green.traceSet.traces) },
    dispositions: structuredClone(green.dispositions),
    evidenceBindings: structuredClone(green.evidenceBindings),
    developmentSurface: structuredClone(green.developmentSurface),
  };
}

/** The post-freeze SRS authority surface. */
export const srsAuthorityOf = () => ({
  revisionDigest: '5f6b1c2a'.padEnd(64, '0'),
  realizationEntryIds: ['realization:uc-checkout-1', 'realization:uc-batch-1'],
  surfaces: ['svc:cart-api', 'svc:batch-runner', 'module:audit-log'],
});

/** The repository/policy authority refs. */
export const repositoryPolicyRefsOf = () => ['repo:primary', 'policy:release-checklist'];

/** The architecture-contract universe pinned to a frozen baseline. */
export const architectureUniverseOf = (frozen, srs = srsAuthorityOf()) => ({
  idSets: {
    evidenceBindingIds: frozen.baseline.evidenceBindings.map((binding) => binding.evidenceBindingId),
    ucScenarioIds: frozen.baseline.containers.uc.members.map((member) => member.scenarioId),
  },
  revisionPins: {
    srsRevisionDigest: srs.revisionDigest,
    whatBaselineDigest: frozen.artifact.digest,
  },
});

/** The green SRS scenario-realization draft (authored data). */
export function greenRealizationDraft() {
  return {
    lineage: { baselineRef: null, traceRule: 'srs-derived-from-frozen-what-baseline' },
    realizationEntries: [
      {
        compositionOwnerSurfaceRef: 'svc:cart-api',
        entrypointSurfaceRef: 'svc:cart-api',
        evidenceBinding: { evidenceBindingRef: 'ev:test-1', evidenceKind: 'test' },
        externalInterfaces: ['POST /cart/checkout'],
        implementationSurfaceRefs: ['module:audit-log'],
        participatingSurfaceRefs: ['svc:cart-api', 'module:audit-log'],
        realizationEntryId: 'realization:uc-checkout-1',
        runtimeEdges: [
          { fromSurfaceRef: 'svc:cart-api', toSurfaceRef: 'module:audit-log' },
          { fromSurfaceRef: 'module:audit-log', toSurfaceRef: 'terminal:checkout-rendered' },
        ],
        scenarioRef: 'uc:checkout-1',
        terminalResult: 'terminal:checkout-rendered',
      },
      {
        compositionOwnerSurfaceRef: 'svc:cart-api',
        entrypointSurfaceRef: 'svc:batch-runner',
        evidenceBinding: { evidenceBindingRef: 'ev:audit-1', evidenceKind: 'audit' },
        externalInterfaces: ['cron 0 * * * * *'],
        implementationSurfaceRefs: ['module:audit-log'],
        participatingSurfaceRefs: ['svc:batch-runner', 'module:audit-log'],
        realizationEntryId: 'realization:uc-batch-1',
        runtimeEdges: [
          { fromSurfaceRef: 'svc:batch-runner', toSurfaceRef: 'module:audit-log' },
          { fromSurfaceRef: 'module:audit-log', toSurfaceRef: 'terminal:batch-receipt' },
        ],
        scenarioRef: 'uc:batch-1',
        terminalResult: 'terminal:batch-receipt',
      },
    ],
    schemaVersion: 'formalization.srs-realization.v1',
    surfaces: [
      { description: 'composition owner of the checkout and batch flows', realizedScenarioRefs: ['uc:checkout-1', 'uc:batch-1'], surfaceId: 'svc:cart-api', surfaceKind: 'composition' },
      { description: 'scheduled batch runner', realizedScenarioRefs: ['uc:batch-1'], surfaceId: 'svc:batch-runner', surfaceKind: 'infrastructure' },
      { description: 'shared audit log module', realizedScenarioRefs: ['uc:checkout-1', 'uc:batch-1'], surfaceId: 'module:audit-log', surfaceKind: 'infrastructure' },
    ],
  };
}

/** A lawful twelve-kind Development handoff over a frozen baseline. */
export const lawfulHandoffOf = (green = greenBaselineFixture(), srs = srsAuthorityOf(), repoPolicies = repositoryPolicyRefsOf()) => ({
  'acceptance-bindings': ['ac:checkout-end-1'],
  'formalization-certificate': [green.caseIdentity.discoveryCertificateRef, green.caseIdentity.formalizationCaseRef],
  'integration-and-construction-obligations': ['svc:cart-api', 'module:audit-log'],
  'prd-intent-bindings': ['prd:boundary-1'],
  'repository-and-policy-bindings': [...repoPolicies],
  'requirement-bindings': ['fr:cart-1', 'nfr:retention-1'],
  'scenario-bindings': ['uc:batch-1'],
  'scenario-realization-bindings': [...srs.realizationEntryIds],
  'solution-contract': ['placeholder-filled-at-seal'],
  'srs-reference-and-hash': [srs.revisionDigest],
  'terminal-claim-bindings': ['terminal:delivered-1'],
  'what-baseline-reference-and-hash': [green.wholeWhatDigest],
});

/** The green WorkItem inputs covering the whole case lawfully. */
export function greenWorkItemInputs() {
  return [
    {
      acceptance: ['ac:checkout-end-1'],
      infrastructure: ['module:audit-log'],
      integration: ['svc:cart-api'],
      requirements: ['fr:cart-1'],
      scenarioRealization: [{ realizationEntryId: 'realization:uc-checkout-1', terminalResult: 'terminal:checkout-rendered' }],
      summary: 'realize the checkout scenario end to end',
      workItemId: 'wi:checkout',
    },
    {
      acceptance: ['ac:batch-error-1'],
      infrastructure: ['svc:batch-runner', 'module:audit-log'],
      integration: ['svc:cart-api'],
      requirements: ['fr:batch-1', 'nfr:retention-1', 'rule:audit-1'],
      scenarioRealization: [{ realizationEntryId: 'realization:uc-batch-1', terminalResult: 'terminal:batch-receipt' }],
      summary: 'realize the scheduled batch scenario with its audit terminal',
      workItemId: 'wi:batch',
    },
    {
      acceptance: ['ac:checkout-end-1', 'ac:batch-error-1'],
      summary: 'independent verifier over the frozen terminal evidence of both scenarios',
      verifier: [
        { evidenceBindingRef: 'ev:test-1', evidenceKind: 'test', realizationEntryId: 'realization:uc-checkout-1' },
        { evidenceBindingRef: 'ev:audit-1', evidenceKind: 'audit', realizationEntryId: 'realization:uc-batch-1' },
      ],
      workItemId: 'wi:verify',
    },
  ];
}

/** The deep-clone helper (mutation seeds never touch the frozen fixtures). */
export const clone = (value) => structuredClone(value);
