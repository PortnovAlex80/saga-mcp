/**
 * support.mjs - shared WP-11F Formalization-workshop test fixtures: fresh
 * database, the Discovery handoff capsule, compiled role contracts + the
 * one runtime, the shared admitting transport (durable admission store),
 * the authored product chain (PRD -> UC -> FR/NFR/RULE -> AC ->
 * reconciliation -> whole-WHAT baseline -> SRS -> solution contract) and
 * the full-run configuration builder.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const EXAMPLE_TABLE_PATH = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'examples', 'provider-model-limit-table.example.json');

/** The frozen example provider/model limit table (production-scale pins). */
export function frozenExampleTable() {
  const doc = JSON.parse(readFileSync(EXAMPLE_TABLE_PATH, 'utf8'));
  return { artifact: doc.table, declaredDigest: doc.computedRowsDigest };
}

export const dist = (relative) => import(`../../../../dist/${relative}`);

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

export function freshDatabase(prefix = 'ek-wp11f-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'kernel.sqlite');
  return {
    path,
    dir,
    open: async () => {
      const { openKernelDatabase } = await dist('workflow-kernel/persistence/database.js');
      const { KernelPersistenceSession } = await dist('workflow-kernel/persistence/session.js');
      return new KernelPersistenceSession(openKernelDatabase(path));
    },
  };
}

/* ------------------------------------------------------------------ */
/* The accepted Discovery handoff capsule                              */
/* ------------------------------------------------------------------ */

export const LINEAGE = {
  lineageId: 'lineage:message-service-2026-08',
  parentLifecycleRef: 'sha256:' + sha256('discovery-lifecycle-terminal-proof'),
};

export const HANDOFF_BYTES = Buffer.from('message-service discovery handoff package bytes v1', 'utf8');

export const HANDOFF_BINDING = {
  expectedLineageId: LINEAGE.lineageId,
  expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
};

export const SOURCE_CLAIM_IDS = ['SC-1', 'SC-2', 'SC-3'];
export const CONSTRAINT_IDS = ['CON-1'];
export const UNKNOWN_IDS = ['UNK-1'];
export const TERMINAL_CLAIM_IDS = ['TC-1', 'TC-2'];

/** Build one fully-verified Discovery handoff capsule. */
export async function buildHandoffCapsule({ lineage = LINEAGE, packageBytes = HANDOFF_BYTES, parentStatus = 'discovery-terminal' } = {}) {
  const ingress = await dist('workflow-kernel/workshops/formalization/ingress.js');
  return ingress.buildDiscoveryHandoffCapsule(
    {
      certificate: ingress.handoffArtifact({ kind: 'discovery-certificate', decision: 'go', subject: 'message service' }),
      sourceClaims: SOURCE_CLAIM_IDS.map((id, index) => ingress.handoffArtifact({ claimId: id, statement: `Accepted discovery source claim ${index + 1} of the message service subject.` })),
      constraints: CONSTRAINT_IDS.map((id) => ingress.handoffArtifact({ constraintId: id, statement: 'Deterministic responses only; no nondeterministic content.' })),
      unknowns: UNKNOWN_IDS.map((id) => ingress.handoffArtifact({ unknownId: id, question: 'Browser support matrix unknown (owner: discovery).', owner: 'discovery' })),
      terminalLifecycleClaims: TERMINAL_CLAIM_IDS.map((id, index) => ingress.handoffArtifact({ claimId: id, claim: `Terminal lifecycle claim ${index + 1}: the subject is triaged go with recorded strengths.` })),
    },
    lineage,
    { status: parentStatus, terminalProofRef: 'sha256:' + sha256('discovery-terminal-proof') },
    new Uint8Array(packageBytes),
  );
}

/** The handoff view the driver config consumes (capsule-derived refs). */
export async function handoffRefOf(capsule) {
  const refOf = (artifact, id) => ({ ref: artifact.ref, digest: artifact.ref, summary: id });
  return {
    capsuleRef: capsule.capsuleRef,
    digest: capsule.capsuleDigest,
    sourceClaimIds: SOURCE_CLAIM_IDS,
    terminalClaimIds: TERMINAL_CLAIM_IDS,
    sourceClaims: capsule.sourceClaims.map((artifact, index) => refOf(artifact, SOURCE_CLAIM_IDS[index])),
    constraints: capsule.constraints.map((artifact, index) => refOf(artifact, CONSTRAINT_IDS[index])),
    unknowns: capsule.unknowns.map((artifact, index) => refOf(artifact, UNKNOWN_IDS[index])),
    terminalClaims: capsule.terminalLifecycleClaims.map((artifact, index) => refOf(artifact, TERMINAL_CLAIM_IDS[index])),
  };
}

/* ------------------------------------------------------------------ */
/* Role contracts + the one runtime                                    */
/* ------------------------------------------------------------------ */

export async function formalizationRoles() {
  const compiler = await dist('workflow-kernel/roles/compiler.js');
  const roles = await dist('workflow-kernel/workshops/formalization/roles.js');
  const author = compiler.compileRoleContract(roles.buildFormalizationAuthorFixture());
  const reviewer = compiler.compileRoleContract(roles.buildFormalizationReviewerFixture());
  if (!author.compiled || !reviewer.compiled) {
    throw new Error(`formalization fixtures failed to compile: ${JSON.stringify([author.errors, reviewer.errors])}`);
  }
  const runtime = new roles.FormalizationRoleRuntime([
    { launchKind: roles.FORMALIZATION_AUTHOR_LAUNCH_KIND, contract: author.contract },
    { launchKind: roles.FORMALIZATION_REVIEWER_LAUNCH_KIND, contract: reviewer.contract },
  ]);
  return { runtime, author: author.contract, reviewer: reviewer.contract, roles };
}

/* ------------------------------------------------------------------ */
/* Shared admitting transport (durable store, production-size profile)  */
/* ------------------------------------------------------------------ */

export const ROUTE_PIN = { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' };

export async function sharedTransport(session, attempts = []) {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const storeModule = await dist('workflow-kernel/development/admission-store.js');
  const actorsModule = await dist('workflow-kernel/development/actors.js');
  const limits = {
    providerContextLimitTokens: 204800,
    reservedOutputTokens: 8192,
    providerOverheadReserveTokens: 2048,
    safetyMarginTokens: 4096,
    maxTotalInputTokens: 180000,
    maxCumulativeSessionInputTokens: 400000,
    maxProviderRequests: 40,
  };
  const { artifact, declaredDigest } = frozenExampleTable();
  const profile = {
    providerModelLimitTableRef: { ref: 'content://provider-model-limit-tables/factory-illustrative-2026-08', digest: declaredDigest, digestAlgorithm: 'sha256' },
    providerContextLimitTokens: 204800,
    tokenCounterRef: { ...envelope.RUNNING_COUNTER_IDENTITY },
    maxProviderRequests: 40,
    maxStaticTokens: 150000,
    maxDynamicTokens: 30000,
    maxRecoveryTokens: 8000,
    maxToolResultTokens: 12000,
    maxTotalInputTokens: 180000,
    maxCumulativeSessionInputTokens: 400000,
    reservedOutputTokens: 8192,
    providerOverheadReserveTokens: 2048,
    safetyMarginTokens: 4096,
    maxPromptBytes: 1048576,
  };
  const store = new storeModule.DurableAttemptAdmissionStore(session);
  for (const attemptRef of attempts) {
    store.bind(attemptRef, {
      providerRoutePin: ROUTE_PIN,
      promptBudgetProfileRef: 'content://prompt-budget-profiles/formalization-factory-2026-08',
      promptBudgetProfileDigest: 'sha256:' + sha256(JSON.stringify(profile)),
    });
  }
  const transport = envelope.createAdmittingTransport({
    transportId: 'ek-wp11f-formalization-transport',
    routePin: ROUTE_PIN,
    maxOutputTokens: 4096,
    pins: { profile, limitTable: artifact },
    store,
    channel: new actorsModule.ScriptedChannel(),
    exposesMidLoopRequests: true,
  });
  return { transport, store, limits };
}

/* ------------------------------------------------------------------ */
/* The authored product chain (exact digests, folded like the driver)   */
/* ------------------------------------------------------------------ */

export const PRD_MEMBER_IDS = ['PRD-M1', 'PRD-M2', 'PRD-M3', 'PRD-M4'];
export const UC_SCENARIO_IDS = ['UC-1', 'UC-2'];
export const REQUIREMENT_IDS = ['FR-1', 'FR-2', 'FR-3'];
export const AC_IDS = ['AC-1', 'AC-2', 'AC-3'];

/** Build the complete authored chain: every product + the fold states. */
export async function buildAuthoredChain(handoffDigest, acceptedTraceDigest = handoffDigest) {
  const products = await dist('workflow-kernel/workshops/formalization/products.js');
  const contribution = await dist('workflow-kernel/workshops/formalization/contribution.js');

  const accepted0 = contribution.acceptedMaterialOfHandoff({
    digest: handoffDigest,
    sourceClaimIds: SOURCE_CLAIM_IDS,
    constraintIds: CONSTRAINT_IDS,
    unknownIds: UNKNOWN_IDS,
    terminalClaimIds: TERMINAL_CLAIM_IDS,
  });

  const prdProduct = {
    schemaVersion: 'formalization.prd-intent.v1',
    brief: 'A deterministic message service with a browser-rendered frontend.',
    members: [
      { memberId: 'PRD-M1', memberKind: 'system-boundary', statement: 'The service exposes HTTP endpoints and a served frontend.', sourceClaimRefs: ['SC-1'] },
      { memberId: 'PRD-M2', memberKind: 'outcome', statement: 'Operators receive deterministic JSON responses.', sourceClaimRefs: ['SC-2'] },
      { memberId: 'PRD-M3', memberKind: 'outcome', statement: 'Users see the API value rendered in the browser.', sourceClaimRefs: ['SC-3'] },
      { memberId: 'PRD-M4', memberKind: 'constraint', statement: 'Responses are deterministic; no nondeterministic content.', sourceClaimRefs: ['SC-1'] },
    ],
    dispositions: [
      { memberId: 'PRD-M1', disposition: 'scenario_required' },
      { memberId: 'PRD-M2', disposition: 'scenario_required' },
      { memberId: 'PRD-M3', disposition: 'scenario_required' },
      { memberId: 'PRD-M4', disposition: 'direct_requirement', reason: 'An operational constraint with no meaningful interaction scenario.' },
    ],
  };
  const prdArtifact = products.artifactOf(prdProduct);
  const acceptedPrd = contribution.acceptedScenarioRequiredAfter(
    ['PRD-M1', 'PRD-M2', 'PRD-M3'],
    contribution.acceptedMaterialAfter(accepted0, 'formalization.prd-intent.v1', prdArtifact, PRD_MEMBER_IDS),
  );

  const ucProduct = {
    schemaVersion: 'formalization.uc-scenarios.v1',
    scenarios: [
      {
        scenarioId: 'UC-1',
        actorKind: 'operator',
        actorIdentity: 'on-call operator',
        goal: 'Check service health and read a deterministic message.',
        trigger: 'Operator opens the endpoints.',
        preconditions: ['service started'],
        mainFlow: ['GET /healthz', 'GET /api/message'],
        alternateFlows: [],
        errorFlows: ['retry on 5xx'],
        postcondition: 'The operator holds the deterministic health and message payloads.',
        prdIntentRefs: ['PRD-M1', 'PRD-M2'],
      },
      {
        scenarioId: 'UC-2',
        actorKind: 'human',
        actorIdentity: 'end user',
        goal: 'See the API value rendered in the browser.',
        trigger: 'User loads the browser entry.',
        preconditions: ['frontend served'],
        mainFlow: ['load entry', 'frontend fetches the API', 'value renders'],
        alternateFlows: [],
        errorFlows: ['error banner on failure'],
        postcondition: 'The rendered view shows the API value.',
        prdIntentRefs: ['PRD-M3'],
      },
    ],
  };
  const ucArtifact = products.artifactOf(ucProduct);
  const acceptedUc = contribution.acceptedMaterialAfter(acceptedPrd, 'formalization.uc-scenarios.v1', ucArtifact, UC_SCENARIO_IDS);

  const requirementsProduct = {
    schemaVersion: 'formalization.system-requirements.v1',
    prdRevisionRef: `sha256:${acceptedPrd.prd.revisionDigest}`,
    ucRevisionRef: `sha256:${acceptedUc.useCases.revisionDigest}`,
    requirements: [
      { requirementId: 'FR-1', requirementKind: 'FR', statement: 'The service exposes /healthz returning {"status":"ok"}.', prdIntentRefs: ['PRD-M1'], ucScenarioRefs: ['UC-1'] },
      { requirementId: 'FR-2', requirementKind: 'FR', statement: 'The service exposes /api/message returning a deterministic JSON message.', prdIntentRefs: ['PRD-M2'], ucScenarioRefs: ['UC-1'] },
      { requirementId: 'FR-3', requirementKind: 'FR', statement: 'A served HTML+JS frontend fetches the API and renders the value.', prdIntentRefs: ['PRD-M3'], ucScenarioRefs: ['UC-2'] },
    ],
  };
  const requirementsArtifact = products.artifactOf(requirementsProduct);
  const acceptedRequirements = contribution.acceptedMaterialAfter(acceptedUc, 'formalization.system-requirements.v1', requirementsArtifact, REQUIREMENT_IDS);

  const acceptanceProduct = {
    schemaVersion: 'formalization.acceptance-bindings.v1',
    criteria: [
      { criterionId: 'AC-1', given: 'server started', when: 'GET /healthz', then: '200 {"status":"ok"}', requirementRefs: ['FR-1'], ucTerminalBranchRefs: ['UC-1'], evidenceMethod: 'test' },
      { criterionId: 'AC-2', given: 'server started', when: 'GET /api/message', then: '200 deterministic message', requirementRefs: ['FR-2'], ucTerminalBranchRefs: ['UC-1'], evidenceMethod: 'test' },
      { criterionId: 'AC-3', given: 'browser entry loaded', when: 'frontend script runs', then: 'the API value renders', requirementRefs: ['FR-3'], ucTerminalBranchRefs: ['UC-2'], evidenceMethod: 'test' },
    ],
  };
  const acceptanceArtifact = products.artifactOf(acceptanceProduct);
  const acceptedAcceptance = contribution.acceptedMaterialAfter(acceptedRequirements, 'formalization.acceptance-bindings.v1', acceptanceArtifact, AC_IDS);

  const reconciliationProduct = {
    schemaVersion: 'formalization.what-reconciliation.v1',
    verdict: 'consistent',
    gaps: [],
    rows: SOURCE_CLAIM_IDS.map((claimId, index) => ({
      sourceClaimRef: claimId,
      memberRef: PRD_MEMBER_IDS[index],
      scenarioRef: index === 3 ? 'direct' : UC_SCENARIO_IDS[index % 2],
      requirementRefs: index === 3 ? [] : [REQUIREMENT_IDS[index]],
      criterionRefs: index === 3 ? [] : [AC_IDS[index]],
    })),
  };
  const reconciliationArtifact = products.artifactOf(reconciliationProduct);
  const acceptedReconciliation = contribution.acceptedMaterialAfter(acceptedAcceptance, 'formalization.what-reconciliation.v1', reconciliationArtifact, []);

  const baselineInputs = {
    handoffDigest,
    prdRevisionDigest: acceptedPrd.prd.revisionDigest,
    ucRevisionDigest: acceptedUc.useCases.revisionDigest,
    requirementsRevisionDigest: acceptedRequirements.requirements.revisionDigest,
    acceptanceRevisionDigest: acceptedAcceptance.acceptance.revisionDigest,
    reconciliationRevisionDigest: acceptedReconciliation.reconciliation.revisionDigest,
    memberDigests: [
      acceptedPrd.prd.revisionDigest,
      acceptedUc.useCases.revisionDigest,
      acceptedRequirements.requirements.revisionDigest,
      acceptedAcceptance.acceptance.revisionDigest,
      acceptedReconciliation.reconciliation.revisionDigest,
    ],
    acceptedTraceDigest,
  };
  const baseline = products.freezeWhatBaseline(baselineInputs);
  if (!baseline.ok) throw new Error(`baseline freeze failed: ${JSON.stringify(baseline)}`);
  const acceptedBaseline = contribution.acceptedBaselineAfter(acceptedReconciliation, baselineArtifactDigest(baseline.artifact), baseline.product.wholeWhatDigest);

  const srsProduct = {
    schemaVersion: 'formalization.srs.v1',
    baselineRef: `sha256:${acceptedBaseline.baseline.revisionDigest}`,
    scenarioRealizations: [
      {
        scenarioId: 'UC-1',
        entrypoint: 'http-gateway',
        participatingModules: ['http-gateway', 'health-handler', 'message-handler'],
        runtimeEdges: [{ from: 'http-gateway', to: 'health-handler' }, { from: 'http-gateway', to: 'message-handler' }, { from: 'health-handler', to: 'operator-visible-result' }, { from: 'message-handler', to: 'operator-visible-result' }],
        externalInterfaces: ['GET /healthz', 'GET /api/message'],
        compositionOwner: 'platform',
        implementationSurfaces: ['src/server.js'],
        terminalResult: 'operator-visible-result',
        evidenceBinding: 'AC-1, AC-2',
      },
      {
        scenarioId: 'UC-2',
        entrypoint: 'static-frontend',
        participatingModules: ['static-frontend', 'browser-runtime'],
        runtimeEdges: [{ from: 'static-frontend', to: 'browser-runtime' }, { from: 'browser-runtime', to: 'rendered-value' }],
        externalInterfaces: ['GET /', 'GET /app.js'],
        compositionOwner: 'frontend',
        implementationSurfaces: ['public/app.js'],
        terminalResult: 'rendered-value',
        evidenceBinding: 'AC-3',
      },
    ],
    decomposition: [
      { criterionRef: 'AC-1', moduleRef: 'health-handler' },
      { criterionRef: 'AC-2', moduleRef: 'message-handler' },
      { criterionRef: 'AC-3', moduleRef: 'browser-runtime' },
    ],
  };
  const srsArtifact = products.artifactOf(srsProduct);
  const acceptedSrs = contribution.acceptedMaterialAfter(acceptedBaseline, 'formalization.srs.v1', srsArtifact, UC_SCENARIO_IDS);

  const solution = products.settleSolutionContract(
    { revisionDigest: acceptedBaseline.baseline.revisionDigest, wholeWhatDigest: acceptedBaseline.baseline.wholeWhatDigest },
    { revisionDigest: acceptedSrs.srs.revisionDigest, realizedScenarioIds: UC_SCENARIO_IDS },
    {
      certificateRef: 'sha256:' + sha256('discovery-certificate'),
      prdIntentBindings: PRD_MEMBER_IDS,
      scenarioBindings: UC_SCENARIO_IDS,
      requirementBindings: REQUIREMENT_IDS,
      acceptanceBindings: AC_IDS,
      scenarioRealizationBindings: UC_SCENARIO_IDS,
      terminalClaimBindings: TERMINAL_CLAIM_IDS,
      integrationObligations: ['seam:frontend-to-api'],
      repositoryPolicyBindings: ['policy:deterministic-responses'],
    },
  );
  if (!solution.ok) throw new Error(`solution settlement failed: ${JSON.stringify(solution)}`);

  return {
    accepted0,
    prd: { product: prdProduct, artifact: prdArtifact, memberIds: PRD_MEMBER_IDS, scenarioRequired: ['PRD-M1', 'PRD-M2', 'PRD-M3'] },
    uc: { product: ucProduct, artifact: ucArtifact, memberIds: UC_SCENARIO_IDS },
    requirements: { product: requirementsProduct, artifact: requirementsArtifact, memberIds: REQUIREMENT_IDS },
    acceptance: { product: acceptanceProduct, artifact: acceptanceArtifact, memberIds: AC_IDS },
    reconciliation: { product: reconciliationProduct, artifact: reconciliationArtifact, memberIds: [] },
    baseline: { product: baseline.product, artifact: baseline.artifact, expected: baselineInputs, memberIds: [] },
    srs: { product: srsProduct, artifact: srsArtifact, memberIds: UC_SCENARIO_IDS },
    solution: { product: solution.product, artifact: solution.artifact, memberIds: [] },
    acceptedAt: {
      prd: acceptedPrd,
      uc: acceptedUc,
      requirements: acceptedRequirements,
      acceptance: acceptedAcceptance,
      reconciliation: acceptedReconciliation,
      baseline: acceptedBaseline,
      srs: acceptedSrs,
    },
  };
}

function baselineArtifactDigest(artifact) {
  return artifact.digest;
}

/* ------------------------------------------------------------------ */
/* Actor scripts                                                       */
/* ------------------------------------------------------------------ */

const textScript = (text, verdict = 'accepted') => ({ responses: [{ text, verdict }] });
const productScript = (kind, product, text) => ({ responses: [{ text, product: { kind, product } }] });

export function shellScripts() {
  return {
    author: textScript('imported the accepted Discovery handoff as the shell stage material'),
    reviewer: textScript('verified the imported handoff matches the capsule digests'),
  };
}

export function chainScripts(chain) {
  return {
    'define-product-intent': { author: productScript('formalization.prd-intent.v1', chain.prd.product, 'authored the brief and PRD intent members'), reviewer: textScript('reviewed the PRD intent members against the source claims') },
    'model-use-cases': { author: productScript('formalization.uc-scenarios.v1', chain.uc.product, 'modeled the UC scenarios'), reviewer: textScript('reviewed the scenarios against the accepted PRD revision') },
    'derive-system-requirements': { author: productScript('formalization.system-requirements.v1', chain.requirements.product, 'derived FR/NFR from accepted PRD and UC material'), reviewer: textScript('reviewed the requirement lineage') },
    'define-acceptance-contract': { author: productScript('formalization.acceptance-bindings.v1', chain.acceptance.product, 'authored the acceptance criteria'), reviewer: textScript('reviewed the AC bindings') },
    'reconcile-what': { author: productScript('formalization.what-reconciliation.v1', chain.reconciliation.product, 'reconciled the WHAT chain'), reviewer: textScript('verified the reconciliation report') },
    'freeze-what-baseline': { author: textScript('froze the whole-WHAT baseline over the exact accepted inputs'), reviewer: textScript('verified the frozen baseline') },
    'define-architecture-contract': { author: productScript('formalization.srs.v1', chain.srs.product, 'authored the SRS with scenario realization'), reviewer: textScript('reviewed the SRS realization graph') },
    'settle-formalization': { author: textScript('settled the solution contract over both authorities'), reviewer: textScript('verified the solution contract references') },
  };
}

export function authoredOf(chain) {
  return {
    'define-product-intent': { candidate: { kind: 'formalization.prd-intent.v1', product: chain.prd.product }, memberIds: chain.prd.memberIds, scenarioRequiredMemberIds: chain.prd.scenarioRequired },
    'model-use-cases': { candidate: { kind: 'formalization.uc-scenarios.v1', product: chain.uc.product }, memberIds: chain.uc.memberIds },
    'derive-system-requirements': { candidate: { kind: 'formalization.system-requirements.v1', product: chain.requirements.product }, memberIds: chain.requirements.memberIds },
    'define-acceptance-contract': { candidate: { kind: 'formalization.acceptance-bindings.v1', product: chain.acceptance.product }, memberIds: chain.acceptance.memberIds },
    'reconcile-what': { candidate: { kind: 'formalization.what-reconciliation.v1', product: chain.reconciliation.product }, memberIds: chain.reconciliation.memberIds },
    'freeze-what-baseline': { candidate: { kind: 'formalization.what-baseline.v1', product: chain.baseline.product, expected: chain.baseline.expected }, memberIds: chain.baseline.memberIds },
    'define-architecture-contract': { candidate: { kind: 'formalization.srs.v1', product: chain.srs.product }, memberIds: chain.srs.memberIds },
    'settle-formalization': { candidate: { kind: 'formalization.solution-contract.v1', product: chain.solution.product }, memberIds: chain.solution.memberIds },
  };
}

/* ------------------------------------------------------------------ */
/* Full-run configuration                                              */
/* ------------------------------------------------------------------ */

/** Every attempt ref the driver creates (bound to the durable store up front). */
export function allAttemptRefs() {
  const desks = [
    'import-discovery-handoff',
    'define-product-intent',
    'model-use-cases',
    'derive-system-requirements',
    'define-acceptance-contract',
    'reconcile-what',
    'freeze-what-baseline',
    'define-architecture-contract',
    'settle-formalization',
  ];
  return desks.flatMap((nodeId) => [`formalization-attempt:${nodeId}:author`, `formalization-attempt:${nodeId}:reviewer`]);
}

/** Build the complete driver configuration over a session. */
export async function fullRunConfig(session, { chain, transport } = {}) {
  const gates = await dist('workflow-kernel/workshops/formalization/gates.js');
  const manifest = await dist('workflow-kernel/workshops/formalization/manifest.js');
  const effectsModule = await dist('workflow-kernel/workshops/formalization/effects.js');
  const { runtime } = await formalizationRoles();
  runtime.resolveOnce('formalization.implementation.author');
  runtime.resolveOnce('formalization.implementation.reviewer');
  const capsule = await buildHandoffCapsule();
  // Capsule ingress of the accepted Discovery output (the public ingress):
  // the driver runs only over a database that already imported the handoff.
  let ingested;
  if (!session.hydrateWorld().world.heads.has('factory-run:1')) {
    const ingress = await dist('workflow-kernel/workshops/formalization/ingress.js');
    ingested = ingress.ingestDiscoveryHandoff(session, capsule, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
    if (!ingested.imported) {
      throw new Error(`handoff ingress refused: ${ingested.reason}: ${ingested.detail}`);
    }
  }
  const authoredChain = chain ?? (await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef));
  const handoffView = await handoffRefOf(capsule);
  const externalEvidence = [
    ...gates.formalizationExternalEvidence(manifest.FORMALIZATION_CHECK_PROVIDERS, { ok: true, digest: sha256('product-verification') }),
    { kind: 'CheckPlan', ref: 'evidence:CheckPlan#discovery-import-shell', producer: 'external-input', payloadDigest: sha256('discovery-import-shell') },
  ];
  const effects = new effectsModule.FormalizationEffectExecutor();
  const applied = [];
  const config = {
    session,
    roles: runtime,
    ...(transport === undefined ? {} : { transport }),
    effects,
    externalEvidence,
    handoff: handoffView,
    shellCheckPlan: externalEvidence[externalEvidence.length - 1],
    authored: authoredOf(authoredChain),
    shellScripts: shellScripts(),
    scripts: chainScripts(authoredChain),
    effectSink: (effectId, contentDigest) => {
      applied.push({ effectId, contentDigest });
      return `effect:${effectId}:${sha256(contentDigest)}`;
    },
  };
  return { config, chain: authoredChain, effects, applied, capsule, handoffView, ingested };
}
