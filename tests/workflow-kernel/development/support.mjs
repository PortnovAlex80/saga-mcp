/**
 * support.mjs - shared WP-08 Development-vertical fixtures: fresh database,
 * the Discovery+Formalization capsule, compiled role contracts, the shared
 * transport (durable admission store) and the production-scale prompt
 * profiles.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dist = (relative) => import(`../../../dist/${relative}`);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXAMPLE_TABLE_PATH = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'examples', 'provider-model-limit-table.example.json');
export const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'fixtures', 'simple-server');

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

export function freshDatabase(prefix = 'ek-wp08-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'kernel.sqlite');
  return { path: dbPath, dir, async open() {
    const { openKernelDatabase } = await dist('workflow-kernel/persistence/database.js');
    const { KernelPersistenceSession } = await dist('workflow-kernel/persistence/session.js');
    return new KernelPersistenceSession(openKernelDatabase(dbPath));
  } };
}

/* ------------------------------------------------------------------ */
/* Capsule fixture                                                     */
/* ------------------------------------------------------------------ */

export const LINEAGE = {
  lineageId: 'lineage:simple-server-2026-08',
  parentLifecycleRef: 'sha256:' + sha256('formalization-lifecycle-terminal-proof'),
};

export const CAPSULE_BYTES = Buffer.from('simple-server discovery+formalization package bytes v1', 'utf8');

/** Build one fully-verified Discovery+Formalization capsule. */
export async function buildCapsuleFixture({ lineage = LINEAGE, packageBytes = CAPSULE_BYTES } = {}) {
  const { capsuleArtifact, buildCapsule } = await dist('workflow-kernel/development/capsule.js');
  return buildCapsule(
    {
      certificate: capsuleArtifact({ kind: 'formalization-certificate', decision: 'formalized', baseline: 'sha256:' + sha256('baseline') }),
      requirements: [
        capsuleArtifact({ id: 'REQ-1', text: 'The service exposes /healthz returning {"status":"ok"}.' }),
        capsuleArtifact({ id: 'REQ-2', text: 'The service exposes /api/message returning a deterministic JSON message.' }),
        capsuleArtifact({ id: 'REQ-3', text: 'A served HTML+JS frontend fetches the API and renders the value.' }),
      ],
      terminalClaims: [
        capsuleArtifact({ claimId: 'TC-1', claim: 'loopback verification green over /healthz, /api/message and the frontend integration' }),
        capsuleArtifact({ claimId: 'TC-2', claim: 'browser smoke hook green (entry, asset, API, rendered text oracle)' }),
      ],
      acceptanceCriteria: [
        capsuleArtifact({ acId: 'AC-1', given: 'server started', when: 'GET /healthz', then: '200 {"status":"ok"}' }),
        capsuleArtifact({ acId: 'AC-2', given: 'server started', when: 'GET /api/message', then: '200 deterministic message' }),
        capsuleArtifact({ acId: 'AC-3', given: 'browser entry loaded', when: 'frontend script runs', then: '#message renders the API value' }),
      ],
      modulePackage: capsuleArtifact({ name: 'simple-server-module', entry: 'development.production-cell', interfaces: ['/healthz', '/api/message', '/', '/app.js'] }),
      buildOutput: capsuleArtifact({ script: 'npm run build', output: 'dist/build-manifest.json' }),
      baseRepository: capsuleArtifact({ baseline: 'sha256:' + sha256('base-repository'), tree: 'solution-development base' }),
    },
    lineage,
    { status: 'formalization-terminal', terminalProofRef: 'sha256:' + sha256('formalization-terminal-proof') },
    new Uint8Array(packageBytes),
  );
}

/* ------------------------------------------------------------------ */
/* Role contracts + runtime                                            */
/* ------------------------------------------------------------------ */

export async function compiledContracts() {
  const compiler = await dist('workflow-kernel/roles/compiler.js');
  const fixtures = await dist('workflow-kernel/roles/fixtures/index.js');
  const author = compiler.compileRoleContract(fixtures.buildImplementerFixture());
  const reviewer = compiler.compileRoleContract(fixtures.buildReviewerFixture());
  if (!author.compiled || !reviewer.compiled) {
    throw new Error(`fixture contracts failed to compile: ${JSON.stringify([author.errors, reviewer.errors])}`);
  }
  return {
    author: author.contract,
    reviewer: reviewer.contract,
    authorLaunchKind: fixtures.implementerLaunchKind,
    reviewerLaunchKind: fixtures.reviewerLaunchKind,
  };
}

export async function roleRuntime() {
  const { RoleContractRuntime } = await dist('workflow-kernel/development/role-contract-runtime.js');
  const contracts = await compiledContracts();
  const runtime = new RoleContractRuntime([
    { launchKind: contracts.authorLaunchKind, contract: contracts.author },
    { launchKind: contracts.reviewerLaunchKind, contract: contracts.reviewer },
  ]);
  return { runtime, ...contracts };
}

/* ------------------------------------------------------------------ */
/* Prompt budget profiles (production scale)                           */
/* ------------------------------------------------------------------ */

export function frozenExampleTable() {
  const doc = JSON.parse(readFileSync(EXAMPLE_TABLE_PATH, 'utf8'));
  return { artifact: doc.table, declaredDigest: doc.computedRowsDigest };
}

/** The glm-4.7 production-scale route (204800 context tokens). */
export const ROUTE_PIN_GLM47 = { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' };
export const ROUTE_PIN_GLM52 = { provider: 'zai', model: 'glm-5.2', version: 'catalog-2026-08-24' };

/** A production-scale profile over the frozen example table (Elite-3 sized). */
export async function productionProfile(overrides = {}) {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const { artifact } = frozenExampleTable();
  void envelope;
  return {
    providerModelLimitTableRef: {
      ref: 'content://provider-model-limit-tables/factory-illustrative-2026-08',
      digest: frozenExampleTable().declaredDigest,
      digestAlgorithm: 'sha256',
    },
    providerContextLimitTokens: 204800,
    tokenCounterRef: /* RUNNING_COUNTER_IDENTITY set below */ undefined,
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
    ...overrides,
  };
}

export async function admissionPins(profileOverrides = {}) {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const profile = await productionProfile(profileOverrides);
  if (profile.tokenCounterRef === undefined) {
    profile.tokenCounterRef = { ...envelope.RUNNING_COUNTER_IDENTITY };
  }
  const { artifact } = frozenExampleTable();
  return { pins: { profile, limitTable: artifact }, profile };
}

/* ------------------------------------------------------------------ */
/* Transport + durable store wiring                                    */
/* ------------------------------------------------------------------ */

/** Create the shared admitting transport over the DURABLE store. */
export async function sharedTransport(session, { routePin = ROUTE_PIN_GLM47, channel, attempts = [] } = {}) {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const storeModule = await dist('workflow-kernel/development/admission-store.js');
  const actorsModule = await dist('workflow-kernel/development/actors.js');
  const { pins, profile } = await admissionPins();
  const store = new storeModule.DurableAttemptAdmissionStore(session);
  for (const attemptRef of attempts) {
    store.bind(attemptRef, {
      providerRoutePin: routePin,
      promptBudgetProfileRef: 'content://prompt-budget-profiles/development-factory-2026-08',
      promptBudgetProfileDigest: 'sha256:' + sha256(JSON.stringify(profile)),
    });
  }
  const transport = envelope.createAdmittingTransport({
    transportId: 'ek-wp08-development-transport',
    routePin,
    maxOutputTokens: 4096,
    pins,
    store,
    channel: channel ?? new actorsModule.ScriptedChannel(),
    exposesMidLoopRequests: true,
  });
  return { transport, store, pins, profile };
}

/* ------------------------------------------------------------------ */
/* Task manifest + scripts                                             */
/* ------------------------------------------------------------------ */

/**
 * The lawful conveyor spine from an imported capsule to the production
 * Workplace (public commands + obligation consumer only). Returns the
 * workplace instance id.
 */
export async function driveToWorkplace(session) {
  const consumer = await dist('workflow-kernel/application/obligation-consumer.js');
  const consume = async (kind, invocation = {}) => {
    const frontier = consumer.openFrontier(session).find((entry) => entry.kind === kind);
    if (frontier === undefined) throw new Error(`spine: obligation ${kind} not open`);
    if (frontier.refusal !== undefined) throw new Error(`spine: ${kind} unresolvable: ${frontier.refusal.detail}`);
    return consumer.consumeClaim(session, frontier.claim, invocation, {});
  };
  await consume('obligation:ingestCapsuleFacts');               // factoryRun.start
  await consume('obligation:bootstrapLifecycleRun');            // lifecycleRun.create
  await consume('obligation:enterStage.initial-discovery');     // stageRun.create
  session.stageRun.applyCommand({ command: 'stageRun.activate', instanceId: 'stage-run:1', expectedRevision: 1, idempotencyKey: 'spine:activate' });
  await consume('obligation:bindProcessModule');                // processRun.create
  await consume('obligation:enterFirstNode');                   // processRun.enterNode
  session.nodeRun.applyCommand({ command: 'nodeRun.create', instanceId: 'node-run:1', expectedRevision: 0, idempotencyKey: 'spine:node' });
  await consume('obligation:materializeWorkplace.production-cell'); // workplace.materialize
  return 'workplace:1';
}


export async function taskManifest() {
  const { referenceOf } = await dist('workflow-kernel/development/envelope-assembly.js');
  return {
    scope: [
      referenceOf('requirements', sha256('req-1'), 'REQ-1 /healthz returns ok'),
      referenceOf('requirements', sha256('req-2'), 'REQ-2 /api/message deterministic'),
      referenceOf('requirements', sha256('req-3'), 'REQ-3 frontend fetch+render'),
    ],
    unknowns: [referenceOf('unknowns', sha256('unknown-browser-matrix'), 'browser matrix unknown (owner: discovery)')],
    terminalClaims: [
      referenceOf('terminal-claims', sha256('tc-1'), 'TC-1 loopback green'),
      referenceOf('terminal-claims', sha256('tc-2'), 'TC-2 smoke green'),
    ],
  };
}

export async function authorScript() {
  return {
    responses: [
      {
        toolCalls: [
          { name: 'read-file', args: ['acceptance-contract.json'] },
          { name: 'run-command', args: ['npm run build'] },
        ],
        text: 'built the simple-server product against the acceptance contract',
        product: { digest: sha256('simple-server-product-v1'), description: 'server.js + public/* + verify hooks' },
      },
    ],
  };
}

export async function reviewerScript(verdict = 'accepted') {
  return {
    responses: [
      {
        toolCalls: [{ name: 'run-command', args: ['npm run verify'] }],
        text: `verified the product against the acceptance contract; verdict ${verdict}`,
        verdict,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Product verification binding (real acceptance check)                */
/* ------------------------------------------------------------------ */

export async function productVerifier() {
  const acceptance = await dist('workflow-kernel/development/product-acceptance.js');
  return async () => {
    const check = await acceptance.checkProductAcceptance(FIXTURE_ROOT);
    if (check.ok) {
      return { ok: true, detail: `verified: ${check.verified.join(', ')}`, digest: check.evidenceDigest };
    }
    return { ok: false, detail: `${check.reason}: ${check.detail}`, digest: sha256(check.detail) };
  };
}
