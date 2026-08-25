/**
 * support.mjs - shared WP-11L Delivery-workshop test fixtures: fresh kernel
 * databases, the verified Development bundle, the compiled delivery role
 * runtime, the shared admitting transport (the SAME durable admission
 * store discipline as the development suite), the release/inbox store
 * roots and the full release-run configuration.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dist = (relative) => import(`../../../../dist/${relative}`);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EXAMPLE_TABLE_PATH = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'examples', 'provider-model-limit-table.example.json');
export const PRODUCT_ROOT = join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'fixtures', 'simple-server');

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Database + operator stores                                          */
/* ------------------------------------------------------------------ */

export function freshDatabase(prefix = 'ek-wp11l-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'kernel.sqlite');
  return {
    path: dbPath,
    dir,
    async open() {
      const { openKernelDatabase } = await dist('workflow-kernel/persistence/database.js');
      const { KernelPersistenceSession } = await dist('workflow-kernel/persistence/session.js');
      return new KernelPersistenceSession(openKernelDatabase(dbPath));
    },
  };
}

/** A fresh release store + approval inbox root (the operator-provisioned dirs). */
export function operatorStores(prefix = 'ek-wp11l-stores-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { storeRoot: join(dir, 'release-store'), inboxRoot: join(dir, 'approval-inbox') };
}

/* ------------------------------------------------------------------ */
/* The verified Development bundle fixture                             */
/* ------------------------------------------------------------------ */

export const LINEAGE = {
  lineageId: 'lineage:simple-server-2026-08',
  parentLifecycleRef: 'sha256:' + sha256('development-lifecycle-terminal-proof'),
};

export const PACKAGE_BYTES = Buffer.from('simple-server verified development bundle bytes v1', 'utf8');

/** Build one fully-verified Development bundle (the Delivery input product). */
export async function buildVerifiedBundle({ lineage = LINEAGE, packageBytes = PACKAGE_BYTES, certificateDecision = 'verified' } = {}) {
  const { bundleArtifact, buildVerifiedDevelopmentBundle } = await dist('workflow-kernel/workshops/delivery/bundle.js');
  return buildVerifiedDevelopmentBundle(
    {
      developmentCertificate: bundleArtifact({ kind: 'development-certificate', decision: certificateDecision, baseline: 'sha256:' + sha256('dev-baseline') }),
      integratedCandidate: bundleArtifact({ candidate: 'simple-server@build-3', revision: 3, tree: 'sha256:' + sha256('dev-tree') }),
      verifiedIntegrationBundle: bundleArtifact({ verifier: 'loopback+smoke green over every acceptance surface', digest: 'sha256:' + sha256('integration') }),
      terminalClaims: [
        bundleArtifact({ claimId: 'TC-1', claim: 'loopback verification green over /healthz, /api/message and the frontend integration' }),
        bundleArtifact({ claimId: 'TC-2', claim: 'browser smoke hook green (entry, asset, API, rendered text oracle)' }),
      ],
      packagingInput: bundleArtifact({ input: 'delivery/package-input.json', script: 'scripts/package.mjs', externalDeployment: false }),
    },
    lineage,
    { status: 'development-terminal', terminalProofRef: 'sha256:' + sha256('development-terminal-proof') },
    new Uint8Array(packageBytes),
  );
}

/* ------------------------------------------------------------------ */
/* Delivery roles + transport (the ONE resolution + admission path)     */
/* ------------------------------------------------------------------ */

export async function deliveryRoles() {
  const { deliveryRoleRuntime } = await dist('workflow-kernel/workshops/delivery/roles.js');
  const { runtime, authorLaunchKind, reviewerLaunchKind } = deliveryRoleRuntime();
  // Resolve each launch kind EXACTLY ONCE (the runtime caches the slots).
  const authorSlot = runtime.resolveOnce(authorLaunchKind);
  const reviewerSlot = runtime.resolveOnce(reviewerLaunchKind);
  if (!authorSlot.resolved || !reviewerSlot.resolved) {
    throw new Error(`delivery roles failed to resolve: ${JSON.stringify([authorSlot, reviewerSlot])}`);
  }
  return { runtime, authorLaunchKind, reviewerLaunchKind, authorSlot: authorSlot.slot, reviewerSlot: reviewerSlot.slot };
}

export function frozenExampleTable() {
  const doc = JSON.parse(readFileSync(EXAMPLE_TABLE_PATH, 'utf8'));
  return { artifact: doc.table, declaredDigest: doc.computedRowsDigest };
}

export const ROUTE_PIN = { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' };

async function admissionPins() {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const { artifact } = frozenExampleTable();
  const profile = {
    providerModelLimitTableRef: {
      ref: 'content://provider-model-limit-tables/factory-illustrative-2026-08',
      digest: frozenExampleTable().declaredDigest,
      digestAlgorithm: 'sha256',
    },
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
  return { pins: { profile, limitTable: artifact }, profile };
}

/** The shared admitting transport over the DURABLE store (same discipline as WP-08). */
export async function sharedTransport(session, { attempts = [] } = {}) {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const storeModule = await dist('workflow-kernel/development/admission-store.js');
  const actorsModule = await dist('workflow-kernel/development/actors.js');
  const { pins, profile } = await admissionPins();
  const store = new storeModule.DurableAttemptAdmissionStore(session);
  for (const attemptRef of attempts) {
    store.bind(attemptRef, {
      providerRoutePin: ROUTE_PIN,
      promptBudgetProfileRef: 'content://prompt-budget-profiles/delivery-factory-2026-08',
      promptBudgetProfileDigest: 'sha256:' + sha256(JSON.stringify(profile)),
    });
  }
  const transport = envelope.createAdmittingTransport({
    transportId: 'ek-wp11l-delivery-transport',
    routePin: ROUTE_PIN,
    maxOutputTokens: 4096,
    pins,
    store,
    channel: new actorsModule.ScriptedChannel(),
    exposesMidLoopRequests: true,
  });
  return { transport, store, pins, profile };
}

/* ------------------------------------------------------------------ */
/* Task manifest + scripts + operator decision                         */
/* ------------------------------------------------------------------ */

export async function taskManifest() {
  const { referenceOf } = await dist('workflow-kernel/development/envelope-assembly.js');
  return {
    scope: [
      referenceOf('verified-bundle', sha256('bundle-scope'), 'the verified Development bundle (certificate + candidate)'),
    ],
    unknowns: [referenceOf('unknowns', sha256('unknown-release-channel'), 'release channel unknown (owner: policy)')],
    terminalClaims: [
      referenceOf('terminal-claims', sha256('tc-1'), 'TC-1 loopback green'),
      referenceOf('terminal-claims', sha256('tc-2'), 'TC-2 smoke green'),
    ],
  };
}

export function authorScript() {
  return {
    responses: [
      {
        toolCalls: [
          { name: 'read-file', args: ['acceptance-contract.json'] },
          { name: 'run-command', args: ['node scripts/package.mjs'] },
        ],
        text: 'assembled the local release package over the verified bundle candidate',
        product: { digest: sha256('simple-server-release-package-v1'), description: 'release store entries + package manifest' },
      },
    ],
  };
}

export function reviewerScript(verdict = 'accepted') {
  return {
    responses: [
      {
        toolCalls: [{ name: 'read-file', args: ['release-store/releases'] }],
        text: `verified the local release package against the verified bundle; verdict ${verdict}`,
        verdict,
      },
    ],
  };
}

export function approvedDecision(overrides = {}) {
  return {
    status: 'approved',
    decidedBy: 'release-operator-one',
    rationale: 'preflight green; candidate/preflight/policy triple verified; local packaging approved',
    providerId: 'operator-release-1',
    ...overrides,
  };
}

/** The scripted operator decision bound to one release run's request. */
export async function operatorDecisionOf(config, overrides = {}) {
  const conveyor = await dist('workflow-kernel/workshops/delivery/conveyor.js');
  return { ...approvedDecision(overrides), requestId: conveyor.approvalRequestIdOf(config) };
}

/* ------------------------------------------------------------------ */
/* The conveyor spine (public commands only; kernel-fence staging)      */
/* ------------------------------------------------------------------ */

/**
 * Drive the lawful spine from an imported bundle to the materialized
 * release Workplace (the staging surface for kernel-fence mutations).
 */
export async function driveSpineToWorkplace(session) {
  const consumer = await dist('workflow-kernel/application/obligation-consumer.js');
  const consume = async (kind, invocation = {}, externalEvidence) => {
    const frontier = consumer.openFrontier(session).find((entry) => entry.kind === kind);
    if (frontier === undefined) throw new Error(`spine: obligation ${kind} not open`);
    if (frontier.refusal !== undefined) throw new Error(`spine: ${kind} unresolvable: ${frontier.refusal.detail}`);
    return consumer.consumeClaim(session, frontier.claim, invocation, { externalEvidence });
  };
  const evidence = [
    { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input', payloadDigest: sha256('spine-checkplan') },
    { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: sha256('spine-pve') },
  ];
  await consume('obligation:ingestCapsuleFacts', {}, evidence);       // factoryRun.start
  await consume('obligation:bootstrapLifecycleRun', {}, evidence);    // lifecycleRun.create
  await consume('obligation:enterStage.initial-discovery', {}, evidence); // stageRun.create
  session.stageRun.applyCommand({ command: 'stageRun.activate', instanceId: 'stage-run:1', expectedRevision: 1, idempotencyKey: 'spine:activate' });
  await consume('obligation:bindProcessModule', {}, evidence);        // processRun.create
  await consume('obligation:enterFirstNode', {}, evidence);           // processRun.enterNode
  session.nodeRun.applyCommand({ command: 'nodeRun.create', instanceId: 'node-run:1', expectedRevision: 0, idempotencyKey: 'spine:node' });
  await consume('obligation:materializeWorkplace.production-cell', {}, evidence); // workplace.materialize
  return 'workplace:1';
}

/** A staged world at the materialized release cell (mutation staging). */
export async function stagedCellWorld() {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const ingress = await dist('workflow-kernel/workshops/delivery/bundle.js');
  const ingressed = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  if (!ingressed.imported) throw new Error(`staging ingress refused: ${JSON.stringify(ingressed)}`);
  await driveSpineToWorkplace(session);
  const roles = await deliveryRoles();
  return { session, bundle, roles };
}

/** Admit the author WorkIntent on a staged cell (returns the intent ref). */
export function admitAuthorIntent(staged) {
  const outcome = staged.session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', expectedRevision: 1,
    idempotencyKey: 'mutation:author-intent', protocolRole: 'author', rolePin: staged.roles.authorSlot.pin,
    evidenceRefs: ['work-item:1', 'evidence:scope'],
  });
  if (outcome.refused) throw new Error(`staging intent refused: ${JSON.stringify(outcome)}`);
  return [...staged.session.hydrateWorld().world.workIntents.keys()][0];
}

/* ------------------------------------------------------------------ */
/* The full release-run configuration                                  */
/* ------------------------------------------------------------------ */

/**
 * Boot a complete release world: fresh database + verified bundle ingress
 * + green preflight + resolved roles + transport + operator stores.
 * Returns everything the conveyor needs plus the session for assertions.
 */
export async function bootReleaseWorld({ certificateDecision = 'verified', policy } = {}) {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle({ certificateDecision });
  const ingress = await dist('workflow-kernel/workshops/delivery/bundle.js');
  const preflightModule = await dist('workflow-kernel/workshops/delivery/preflight.js');
  const manifestModule = await dist('workflow-kernel/workshops/delivery/manifest.js');
  const packagingModule = await dist('workflow-kernel/workshops/delivery/packaging.js');

  const imported = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  const policyValue = policy ?? manifestModule.DELIVERY_RELEASE_POLICY;
  const preflight = preflightModule.runPreflight(bundle, policyValue);

  const roles = await deliveryRoles();
  const stores = operatorStores();
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
  const config = {
    session,
    roles: roles.runtime,
    authorLaunchKind: roles.authorLaunchKind,
    reviewerLaunchKind: roles.reviewerLaunchKind,
    transport,
    taskSummary: 'Assemble and release the local package over the verified Development bundle',
    requiredInfo: await taskManifest(),
    bundle,
    preflight,
    policy: policyValue,
    storeRoot: stores.storeRoot,
    inboxRoot: stores.inboxRoot,
    packaging: { productRoot: PRODUCT_ROOT, entries: [...packagingModule.DEFAULT_PACKAGING_ENTRIES] },
    requestedBy: 'release-conveyor',
  };
  return { session, bundle, imported, preflight, roles, stores, config, ingress, preflightModule, manifestModule, packagingModule };
}
