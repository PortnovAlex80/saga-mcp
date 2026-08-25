/**
 * support.mjs - shared WP-11D Discovery-workshop fixtures: fresh database,
 * the content-addressed idea bundle, the sealed brief/intent products,
 * compiled role bindings (WP-17 path), the shared admitting transport and
 * the deterministic product verifier over the declared check plans.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dist = (relative) => import(`../../../../dist/${relative}`);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EXAMPLE_TABLE_PATH = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'examples', 'provider-model-limit-table.example.json');

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

export function freshDatabase(prefix = 'ek-wp11d-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'kernel.sqlite');
  return { path: dbPath, dir, async open() {
    const { openKernelDatabase } = await dist('workflow-kernel/persistence/database.js');
    const { KernelPersistenceSession } = await dist('workflow-kernel/persistence/session.js');
    return new KernelPersistenceSession(openKernelDatabase(dbPath));
  } };
}

/* ------------------------------------------------------------------ */
/* Idea intake fixture (the first stage has NO producing parent)        */
/* ------------------------------------------------------------------ */

export const IDEA_LINEAGE = {
  lineageId: 'lineage:operator-idea-2026-08',
  parentLifecycleRef: null,
};

export const INTAKE_BYTES = Buffer.from('operator idea intake bytes: the message-relay service idea', 'utf8');

export const OPERATOR_DECISION_REF = 'sha256:' + sha256('operator-decision-to-start');

export const IDEA_VALUE = {
  schemaVersion: 'ek.workshop-product.idea-intake.v1',
  ideaId: 'idea-message-relay',
  statement: 'A message relay service that buffers bursts and exposes a deterministic drain API.',
  context: 'operator intake session 2026-08; single product board',
  constraints: ['no external message broker', 'bounded memory', 'deterministic drain order'],
  outcomeWish: 'a formalizable brief the next stage can turn into requirements',
  unknowns: ['browser matrix unknown (owner: later stages)', 'retention window unknown (owner: operator)'],
};

export async function buildIdeaFixture({ lineage = IDEA_LINEAGE, ideaValue = IDEA_VALUE, intakeBytes = INTAKE_BYTES } = {}) {
  const products = await dist('workflow-kernel/workshops/discovery/products.js');
  const intake = await dist('workflow-kernel/workshops/discovery/idea-intake.js');
  const idea = products.sealProduct(ideaValue);
  return {
    idea,
    bundle: intake.buildIdeaBundle(idea, lineage, { status: 'operator-intake', decisionRef: OPERATOR_DECISION_REF }, new Uint8Array(intakeBytes)),
    intakeBytes: new Uint8Array(intakeBytes),
  };
}

/** Ingest the fixture through the PUBLIC ingress; asserts success. */
export async function ingestIdeaFixture(session, overrides = {}) {
  const intake = await dist('workflow-kernel/workshops/discovery/idea-intake.js');
  const fixture = await buildIdeaFixture(overrides.fixture ?? {});
  const result = intake.ingestIdeaBundle(
    session,
    overrides.bundle ?? fixture.bundle,
    overrides.intakeBytes ?? fixture.intakeBytes,
    overrides.binding ?? { expectedLineageId: IDEA_LINEAGE.lineageId, expectedParentLifecycleRef: null },
  );
  if (!result.imported) {
    throw new Error(`idea fixture ingestion refused: ${result.reason}: ${result.detail}`);
  }
  return { ...fixture, result };
}

/* ------------------------------------------------------------------ */
/* Brief / intent product fixtures (lineage-correct by construction)   */
/* ------------------------------------------------------------------ */

export async function buildProductFixtures(idea) {
  const contributions = await dist('workflow-kernel/workshops/discovery/contributions.js');
  const products = await dist('workflow-kernel/workshops/discovery/products.js');
  const brief = products.sealProduct(contributions.draftBriefFromIdea(idea));
  const intent = products.sealProduct(contributions.draftIntentFromBrief(brief, 'go', 'The brief is complete: constraints carried, unknowns conserved; formalization may start.'));
  return { brief, intent };
}

/* ------------------------------------------------------------------ */
/* Role bindings (the ONE WP-17 compile + resolve path)                */
/* ------------------------------------------------------------------ */

export async function roleRuntime() {
  const bindings = await dist('workflow-kernel/workshops/discovery/role-bindings.js');
  const manifestModule = await dist('workflow-kernel/workshops/discovery/installed-manifest.js');
  const manifest = manifestModule.installedWorkshopManifest();
  const runtime = bindings.discoveryRoleRuntime(manifest);
  return {
    runtime,
    manifest,
    authorLaunchKind: manifestModule.DISCOVERY_LAUNCH_KINDS.author,
    reviewerLaunchKind: manifestModule.DISCOVERY_LAUNCH_KINDS.reviewer,
    bindings,
  };
}

/* ------------------------------------------------------------------ */
/* Shared admitting transport (durable store)                          */
/* ------------------------------------------------------------------ */

export const ROUTE_PIN = { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' };

export function frozenExampleTable() {
  const doc = JSON.parse(readFileSync(EXAMPLE_TABLE_PATH, 'utf8'));
  return { artifact: doc.table, declaredDigest: doc.computedRowsDigest };
}

export async function admissionPins() {
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

export async function sharedTransport(session, { routePin = ROUTE_PIN, attempts = [] } = {}) {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const cognition = await dist('workflow-kernel/workshops/discovery/cognition.js');
  const admissionStore = await dist('workflow-kernel/workshops/discovery/admission-store.js');
  const { pins, profile } = await admissionPins();
  const store = new admissionStore.DurableWorkshopAdmissionStore(session);
  for (const attemptRef of attempts) {
    store.bind(attemptRef, {
      providerRoutePin: routePin,
      promptBudgetProfileRef: 'content://prompt-budget-profiles/discovery-workshop-2026-08',
      promptBudgetProfileDigest: 'sha256:' + sha256(JSON.stringify(profile)),
    });
  }
  const transport = envelope.createAdmittingTransport({
    transportId: 'ek-wp11d-transport',
    routePin,
    maxOutputTokens: 4096,
    pins,
    store,
    channel: new cognition.DeterministicChannel(),
    exposesMidLoopRequests: true,
  });
  return { transport, store, pins, profile };
}

/* ------------------------------------------------------------------ */
/* Required info + scripts + verifier                                  */
/* ------------------------------------------------------------------ */

export function referenceOf(kind, digestHex, summary) {
  return { ref: `content://${kind}/${digestHex}`, digest: `sha256:${digestHex}`, summary };
}

export function requiredIdeaInfo(idea) {
  return {
    idea: [referenceOf('idea', idea.digest.slice(0, 16), `idea ${idea.value.ideaId}: ${String(idea.value.statement).slice(0, 48)}`)],
    unknowns: idea.value.unknowns.map((unknown, index) => referenceOf('unknowns', sha256(`unknown-${index}`), String(unknown))),
    terminalClaims: [
      referenceOf('terminal-claims', sha256('tc-brief'), 'TC-BRIEF the accepted brief carries every constraint'),
      referenceOf('terminal-claims', sha256('tc-decision'), 'TC-DECISION the decision is recorded with rationale'),
    ],
  };
}

export function authorScript() {
  return {
    responses: [
      {
        toolCalls: [
          { name: 'tool:read-idea', args: ['idea-intake'] },
          { name: 'tool:write-brief', args: ['brief.json'] },
        ],
        text: 'authored the brief from the admitted idea; constraints carried, unknowns surfaced',
        product: { digest: sha256('brief-product-v1'), description: 'the brief product over the admitted idea' },
      },
    ],
  };
}

export function reviewerScript(decision = 'go') {
  return {
    responses: [
      {
        toolCalls: [{ name: 'tool:record-decision', args: ['intent.json'] }],
        text: `reviewed the sealed brief revision; decision ${decision}`,
        product: { digest: sha256('intent-product-v1'), description: `the intent product (decision ${decision})` },
        verdict: 'accepted',
      },
    ],
  };
}

/** The deterministic product verifier: the declared check plans over the sealed products. */
export async function productVerifier({ idea, brief, intent, manifest, expectFail = false }) {
  const checkplans = await dist('workflow-kernel/workshops/discovery/checkplans.js');
  return async () => {
    if (expectFail) {
      return { ok: false, detail: 'CHECK_MUTATION: the verifier is pinned to fail', digest: 'sha256:' + sha256('check-mutation') };
    }
    const run = checkplans.runCheckPlan(checkplans.FINAL_INTENT_CHECK_PLAN, manifest.checkProviders, { idea, brief, intent });
    if ('refused' in run) {
      return { ok: false, detail: `${run.reason}: ${run.detail}`, digest: 'sha256:' + sha256(run.detail) };
    }
    const failed = run.results.filter((result) => !result.passed);
    if (failed.length > 0) {
      return { ok: false, detail: failed.map((result) => result.detail).join('; '), digest: 'sha256:' + sha256(failed.map((r) => r.detail).join()) };
    }
    return { ok: true, detail: 'intent + lineage + conservation green', digest: 'sha256:' + sha256('discovery-products-verified') };
  };
}

/** External-input evidence of the gates (CheckPlan facts from the installed manifest). */
export async function externalEvidence(manifest, verificationOk = true) {
  const driver = await dist('workflow-kernel/workshops/discovery/driver.js');
  const facts = [...driver.discoveryCheckPlanEvidence(manifest)];
  facts.push(verificationOk
    ? { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: 'sha256:' + sha256('products-ok') }
    : { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: 'sha256:' + sha256('products-fail') });
  return facts;
}

/** A complete driver config over a fresh session (the scenario fixture). */
export async function discoveryConfig(session, overrides = {}) {
  const { runtime, manifest, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
  const ingested = await ingestIdeaFixture(session, overrides.ingest ?? {});
  const { brief, intent } = await buildProductFixtures(overrides.idea ?? ingested.idea);
  const info = requiredIdeaInfo(overrides.idea ?? ingested.idea);
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
  const intentProduct = overrides.intent ?? intent;
  const briefProduct = overrides.brief ?? brief;
  return {
    config: {
      session,
      roles: runtime,
      authorLaunchKind,
      reviewerLaunchKind,
      transport,
      manifest,
      taskSummary: 'Convert the admitted idea into the accepted brief + decision products',
      requiredInfo: info,
      idea: overrides.idea ?? ingested.idea,
      brief: briefProduct,
      intent: intentProduct,
      verifyProducts: overrides.verifyProducts ?? await productVerifier({
        idea: overrides.idea ?? ingested.idea, brief: briefProduct, intent: intentProduct, manifest,
        expectFail: overrides.expectVerificationFail ?? false,
      }),
      externalEvidence: overrides.externalEvidence ?? await externalEvidence(manifest, !(overrides.expectVerificationFail ?? false)),
    },
    runtime,
    manifest,
    ingested,
    idea: overrides.idea ?? ingested.idea,
    brief: briefProduct,
    intent: intentProduct,
    authorLaunchKind,
    reviewerLaunchKind,
  };
}
