/**
 * support.mjs - shared Formalization-workshop test fixtures (FRF-WP11
 * cutover shape): fresh database, the Discovery handoff capsule (seeded
 * from the FROZEN WP03 accepted-id-set fixture so the capsule's claim
 * universe and the corpus green material are one universe), compiled role
 * contracts + the one runtime, the shared admitting transport, the
 * authored desk chain over the FRF cells (WP03 member bundles - the same
 * authored green material the FRF scenario corpus drives) and the
 * full-run configuration builder.
 *
 * The authored chain is AUTHORED DATA over the frozen WP03 fixture
 * corpus (never derived from the validators under test): the corpus's
 * green material (tools/frf-corpus/lib/material.mjs) is the single
 * source; the driver gates it through the installed cells exactly the
 * way the corpus drives the same cells.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const EXAMPLE_TABLE_PATH = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'examples', 'provider-model-limit-table.example.json');
const CORPUS = join(REPO_ROOT, 'tools', 'frf-corpus', 'lib', 'material.mjs');

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

export function freshDatabase(prefix = 'frf-wp11-') {
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
/* The accepted id-set fixture (the one universe of the green chain)    */
/* ------------------------------------------------------------------ */

/** The corpus material lib (the single source of the authored green data). */
export const corpusMaterial = () => import(pathToFileURL(CORPUS).href);

/** The frozen WP03 accepted id sets (capsule seed + authored chain ids). */
export const fixtureIdSets = async () => (await corpusMaterial()).acceptedIdSets();

/* ------------------------------------------------------------------ */
/* The accepted Discovery handoff capsule (seeded from the fixture)     */
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

/** The capsule's claim/constraint/unknown/terminal ids (the fixture universe). */
export const SOURCE_CLAIM_IDS = ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'];
export const CONSTRAINT_IDS = ['constraint:retention-1'];
export const UNKNOWN_IDS = ['unknown:browser-matrix-1'];
export const TERMINAL_CLAIM_IDS = ['terminal:audited-1', 'terminal:delivered-1'];

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
    // The exact lineage-universe ids (the chain seed resolves against ids, never artifact refs).
    constraintIds: CONSTRAINT_IDS,
    unknownIds: UNKNOWN_IDS,
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
    transportId: 'frf-wp11-formalization-transport',
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
/* The authored desk chain over the FRF cells (WP03 member bundles)     */
/* ------------------------------------------------------------------ */

export const PRD_MEMBER_IDS = ['prd:boundary-1', 'prd:constraint-1', 'prd:outcome-1', 'prd:scope-2', 'prd:terminal-1', 'prd:unknown-1'];
export const UC_SCENARIO_IDS = ['uc:checkout-1', 'uc:batch-1'];
export const REQUIREMENT_IDS = ['fr:cart-1', 'fr:batch-1', 'nfr:retention-1', 'rule:audit-1', 'nfr:telemetry-1'];
export const AC_IDS = ['ac:checkout-end-1', 'ac:checkout-alt-1', 'ac:batch-main-1', 'ac:retention-1'];

/**
 * Build the complete authored desk chain (the corpus green material over
 * the frozen WP03 fixture ids): every desk's authored bundle, the freeze
 * surfaces, the SRS draft + revision pin and the lawful twelve-kind
 * handoff. Returns the per-desk handles the tests mutate + the authored
 * candidates the driver consumes.
 */
export async function buildAuthoredChain() {
  const m = await corpusMaterial();
  const sets = await fixtureIdSets();
  const prdBundle = m.greenPrdBundle();
  const ucBundle = m.greenUcBundle();
  const reqMembers = m.greenReqMembers();
  // The deferred-at-acceptance telemetry NFR is AUTHORED here (the fifth
  // accepted requirement): the corpus acceptance universe carries it as
  // accepted material, so the honest chain accepts it at this desk and the
  // acceptance desk's deferral resolves against the sealed bundle.
  reqMembers.push({
    requirementId: 'nfr:telemetry-1',
    requirementKind: 'NFR',
    statement: 'Operational telemetry shall be retained for the agreed window.',
    prdIntentRefs: ['prd:unknown-1'],
    verificationSurfaceRefs: ['surface:batch-audit-1'],
  });
  const acceptanceInputs = m.greenAcceptanceInputs();
  const acceptanceBundle = m.greenAcceptanceBundle();
  const surfaces = m.acceptedSurfacesOf();
  const draft = m.greenRealizationDraft();
  const srs = m.srsAuthorityOf();
  const handoff = m.lawfulHandoffOf();
  const repositoryPolicyRefs = m.repositoryPolicyRefsOf();

  const chain = {
    prd: { product: prdBundle, memberIds: PRD_MEMBER_IDS, scenarioRequired: ['prd:outcome-1', 'prd:boundary-1', 'prd:terminal-1'] },
    uc: { product: ucBundle, memberIds: UC_SCENARIO_IDS },
    requirements: { product: reqMembers, memberIds: REQUIREMENT_IDS, deskInput: { verificationSurfaceIds: sets.verificationSurfaceIds } },
    acceptance: { product: acceptanceBundle, memberIds: AC_IDS, deskInput: { verifiableStatementIds: acceptanceInputs.verifiableStatementIds, evidenceBindings: acceptanceInputs.evidenceBindings } },
    reconciliation: { memberIds: [] },
    baseline: { surfaces, memberIds: [] },
    srs: { product: draft, memberIds: UC_SCENARIO_IDS, deskInput: { srsRevisionDigest: srs.revisionDigest }, authority: srs },
    solution: { product: handoff, memberIds: [], deskInput: { repositoryPolicyRefs } },
    fixtureSets: sets,
  };
  chain.authored = authoredOf(chain);
  return chain;
}

/** The per-desk authored candidates the driver config consumes. */
export function authoredOf(chain) {
  return {
    'define-product-intent': { candidate: { kind: 'frf-cell.product-intent.v1', product: chain.prd.product } },
    'model-use-cases': { candidate: { kind: 'frf-cell.uc-scenarios.v1', product: chain.uc.product } },
    'derive-system-requirements': { candidate: { kind: 'formalization.system-requirements.v1', product: chain.requirements.product, deskInput: chain.requirements.deskInput } },
    'define-acceptance-contract': { candidate: { kind: 'formalization.acceptance-bindings.v1', product: chain.acceptance.product, deskInput: chain.acceptance.deskInput } },
    'reconcile-what': { candidate: { kind: 'formalization.what-reconciliation.v1' } },
    'freeze-what-baseline': { candidate: { kind: 'frf-contracts.what-baseline.v1', surfaces: chain.baseline.surfaces } },
    'define-architecture-contract': { candidate: { kind: 'formalization.srs.v1', product: chain.srs.product, deskInput: chain.srs.deskInput } },
    'settle-formalization': { candidate: { kind: 'frf-contracts.solution-contract.v1', product: chain.solution.product, deskInput: chain.solution.deskInput } },
  };
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
    'define-product-intent': { author: productScript('frf-cell.product-intent.v1', chain.prd.product, 'authored the brief and PRD intent members'), reviewer: textScript('reviewed the PRD intent members against the source claims') },
    'model-use-cases': { author: productScript('frf-cell.uc-scenarios.v1', chain.uc.product, 'modeled the UC scenarios'), reviewer: textScript('reviewed the scenarios against the accepted PRD revision') },
    'derive-system-requirements': { author: productScript('formalization.system-requirements.v1', chain.requirements.product, 'derived FR/NFR from accepted PRD and UC material'), reviewer: textScript('reviewed the requirement lineage') },
    'define-acceptance-contract': { author: productScript('formalization.acceptance-bindings.v1', chain.acceptance.product, 'authored the acceptance criteria'), reviewer: textScript('reviewed the AC bindings') },
    'reconcile-what': { author: textScript('reconciled the WHAT chain (report-only)'), reviewer: textScript('verified the computed reconciliation report') },
    'freeze-what-baseline': { author: textScript('froze the whole-WHAT baseline over the exact accepted surfaces'), reviewer: textScript('verified the frozen baseline') },
    'define-architecture-contract': { author: productScript('formalization.srs.v1', chain.srs.product, 'authored the SRS with scenario realization'), reviewer: textScript('reviewed the SRS realization graph') },
    'settle-formalization': { author: textScript('settled the solution contract over both authorities'), reviewer: textScript('verified the solution contract references') },
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
  const authoredChain = chain ?? (await buildAuthoredChain());
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
    authored: authoredChain.authored,
    shellScripts: shellScripts(),
    scripts: chainScripts(authoredChain),
    effectSink: (effectId, contentDigest) => {
      applied.push({ effectId, contentDigest });
      return `effect:${effectId}:${sha256(contentDigest)}`;
    },
  };
  return { config, chain: authoredChain, effects, applied, capsule, handoffView, ingested };
}
