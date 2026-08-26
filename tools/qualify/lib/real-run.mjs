/**
 * tools/qualify/lib/real-run.mjs - the EK-12 REAL-OPCODE run engine (the
 * coordinator-owned execution WP-15 prewired behind the fences).
 *
 * ONE run = ONE real product (R1/R2/R3) driven through the COMPLETE conveyor
 * with REAL cognition: every provider request of every workshop actor passes
 * the production composition's admitting transport (composeProduction - the
 * ONE WP-17 role path, the ONE WP-18 admission boundary) over the REAL
 * opencode shim channel (OpenCodeShimChannel: `node claude-shim.mjs -p
 * --model glm-4.7` with the exact admitted serialized envelope on stdin -
 * the same channel the factory/elite2 workers use; the claude CLI is never
 * invoked, fail-closed by LAW 1).
 *
 * The conveyor phases (per the plan's EK-12 law "the complete idea ->
 * Discovery -> Formalization -> Development -> Delivery path"):
 *
 *   phase 1 Discovery      - the run's kernel database (the prewire path):
 *                            the run's idea through the PUBLIC idea ingress,
 *                            driveDiscoveryWorkshop over the composition
 *                            runtime + REAL transport (2 provider requests),
 *                            to the durable handoff obligation.
 *   phase 2 Formalization  - its own fresh phase database (every workshop
 *                            driver is a full lifecycle vertical on a fresh
 *                            database - the frozen instance-identity law):
 *                            the Discovery handoff capsule through the
 *                            public ingress, all nine desks (shell + 8) over
 *                            the REAL transport (18 provider requests), to
 *                            the run terminal proof.
 *   phase 3 Development    - its own fresh phase database: the development
 *                            capsule through the public capsule ingress,
 *                            the WP-08 material chain over the REAL
 *                            transport (2 provider requests), the effect
 *                            settled ONLY over the run's VERIFIED product
 *                            repository, to the run terminal proof.
 *   phase 4 Delivery       - its own fresh phase database: the verified
 *                            development bundle through the public ingress,
 *                            the WP-11L release conveyor over the REAL
 *                            transport (2 provider requests), the local
 *                            packaging effect + release record.
 *
 * Every phase: the workshop driver drives through the WP-07 obligation
 * consumer (the same consumeClaim engine runUntilIdle loops), the
 * receipt-completeness law over the observed world, and the WP-09
 * forward/reverse observed-graph reconciliation (equal, or a typed finding).
 * Transient real-channel deaths are re-driven LAWFULLY (the drivers are
 * idempotent over durable facts; the transport redrives the SAME obligation
 * + ordinal without re-admission) - a typed kernel refusal is never retried.
 *
 * After the conveyor: the produced repository is verified INDEPENDENTLY per
 * the run's declared evidence profile (build/test/smoke/package) through the
 * WP-15 product-evidence layer.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);
const tests = (relative) => import(pathToFileURL(join(REPO_ROOT, 'tests', relative)).href);

import { freshDir, writeEvidence, sha256Of } from './fences.mjs';
import { okCheck, redCheck, receiptCompleteness, traceFingerprint } from './series.mjs';
import { stageProductRepo, runProductEvidence } from './product-evidence.mjs';

/** The production composition module (loaded once per process). */
let productionModule = null;
async function production() {
  if (productionModule === null) productionModule = await dist('workflow-kernel/composition/production.js');
  return productionModule;
}

/* ------------------------------------------------------------------ */
/* Per-run inputs (the honest idea per product kind)                    */
/* ------------------------------------------------------------------ */

export const RUN_IDEAS = {
  R1: {
    schemaVersion: 'ek.workshop-product.idea-intake.v1',
    ideaId: 'idea-served-hello-api',
    statement: 'A simple served Node API product: /healthz plus /api/message with a deterministic JSON message, and a served browser frontend that fetches and renders it.',
    context: 'EK-12 real qualification run R1; single product board',
    constraints: ['no external services', 'loopback verification only', 'deterministic message payload'],
    outcomeWish: 'a formalizable brief the next stage can turn into requirements',
    unknowns: ['browser matrix unknown (owner: later stages)'],
  },
  R2: {
    schemaVersion: 'ek.workshop-product.idea-intake.v1',
    ideaId: 'idea-reusable-validation-library',
    statement: 'A command-line reusable validation library product with its own unit proof harnesses and a CLI smoke surface.',
    context: 'EK-12 real qualification run R2; single product board',
    constraints: ['pure Node, no runtime dependencies', 'tests are product-owned proof harnesses'],
    outcomeWish: 'a formalizable brief the next stage can turn into requirements',
    unknowns: ['error-message locale unknown (owner: operator)'],
  },
  R3: {
    schemaVersion: 'ek.workshop-product.idea-intake.v1',
    ideaId: 'idea-full-stack-expense-tracker',
    statement: 'A full-stack CRUD product with persistence: served API over a durable store, a browser frontend, restart survival and a browser smoke surface.',
    context: 'EK-12 real qualification run R3; single product board',
    constraints: ['file-backed persistence (no external database)', 'restart survival is a terminal claim'],
    outcomeWish: 'a formalizable brief the next stage can turn into requirements',
    unknowns: ['storage quota unknown (owner: operator)'],
  },
};

/** The declared packaging entries per run (the delivery local package input). */
export const RUN_PACKAGING_ENTRIES = {
  R1: ['src/server.js', 'public/index.html', 'public/app.js', 'package.json', 'acceptance-contract.json'],
  R2: ['src/validate.mjs', 'package.json', 'product.json'],
  R3: ['src/server.mjs', 'src/store.mjs', 'public/index.html', 'public/app.js', 'public/style.css', 'package.json', 'product.json'],
};

/** The expected REAL provider requests per phase (the receipt-count oracle). */
export const EXPECTED_REQUESTS = { discovery: 2, formalization: 18, development: 2, delivery: 2 };

/* ------------------------------------------------------------------ */
/* Composition + phase scaffolding                                     */
/* ------------------------------------------------------------------ */

async function composePhase(dbPath, channel) {
  const mod = await production();
  /* channel: the ONE injected seam of the composition (WP-18) - used only by
   * the deterministic bring-up pass; the real series passes nothing (the
   * production default: the OpenCodeShimChannel over the opencode shim). */
  const composition = mod.composeProduction(channel === undefined ? { dbPath } : { dbPath, channel });
  return { composition, identity: mod.compositionIdentityDigest(composition) };
}

/** Resolve launch kinds on the composition's ONE unified runtime (slotOf
 *  returns nothing before the one resolution of that kind). */
function resolveUnified(composition, launchKinds) {
  for (const launchKind of launchKinds) {
    const resolution = composition.unifiedRoles.resolveOnce(launchKind);
    if ('refused' in resolution) {
      throw new Error(`REAL_RUN_ROLE_RESOLUTION_REFUSED: ${launchKind}: ${resolution.reason}: ${resolution.detail}`);
    }
  }
}

/** A transient channel DEATH class the lawful re-drive may retry. Typed
 *  admission states (ADMISSION_STALE, SEND_UNCERTAIN_DUPLICATE_BLOCKED,
 *  budget refusals...) are FINDINGS, never retried. */
function retryableBlock(result) {
  const blocked = (result.steps ?? [])
    .filter((step) => step.result && typeof step.result === 'object'
      && ['refused', 'actor-refused', 'acceptance-refused', 'approval-refused', 'packaging-refused'].includes(step.result.status));
  if (blocked.length === 0) return { retry: false, blocked };
  const retryable = blocked.every((step) => /OPENCODE_CHANNEL_(EXIT|SPAWN_FAILED)|channel-error/i.test(JSON.stringify(step.result)));
  return { retry: retryable, blocked };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive one workshop phase with lawful re-drives: the drivers are idempotent
 * over durable facts and the transport redrives the SAME obligation + ordinal
 * (no re-admission, no double charge), so a transient real-channel death is
 * re-driven; a typed kernel refusal is a FINDING and stops the phase.
 */
async function drivePhase(label, drive, { maxDrives = 6, backoffMs = 15000, log = () => {} } = {}) {
  const drives = [];
  for (let attempt = 1; attempt <= maxDrives; attempt += 1) {
    const startedAt = Date.now();
    let result;
    let thrown = null;
    try {
      result = await drive();
    } catch (error) {
      thrown = error;
    }
    if (thrown !== null) {
      drives.push({ attempt, elapsedMs: Date.now() - startedAt, thrown: String(thrown?.message ?? thrown).slice(0, 500) });
      const transient = /OPENCODE_CHANNEL_(EXIT|SPAWN_FAILED)/i.test(String(thrown?.message ?? thrown));
      if (!transient || attempt === maxDrives) return { result: null, thrown, drives };
      log(`(drive ${attempt} threw, transient; lawful re-drive in ${backoffMs / 1000}s)\n`);
      await sleep(backoffMs);
      continue;
    }
    const { retry, blocked } = retryableBlock(result);
    drives.push({ attempt, elapsedMs: Date.now() - startedAt, blockedAt: result.blockedAt, blocked: blocked.map((step) => ({ step: step.step, result: step.result })) });
    if (result.blockedAt === undefined) return { result, thrown: null, drives };
    if (!retry || attempt === maxDrives) return { result, thrown: null, drives };
    log(`(drive ${attempt} blocked at ${result.blockedAt}, transient channel class; lawful re-drive in ${backoffMs / 1000}s)\n`);
    await sleep(backoffMs);
  }
  return { result: null, thrown: new Error('drive loop exhausted'), drives };
}

/** The per-phase world evidence: normalized trace + receipts + reconciliation. */
async function phaseWorldEvidence(session, phaseDir, phase, { requireRunTerminal, externalEvidence }) {
  const worldLib = await import(pathToFileURL(join(REPO_ROOT, 'tools', 'project-corpus', 'lib', 'world.mjs')).href);
  /* The observed world view includes the phase's call-scoped external
   * Input-authority facts (the WP-09 oracle law: the reverse closure walk
   * sees the same world the settlement-time guards saw). */
  const observed = worldLib.observedWorldView(session, [], externalEvidence);
  const world = observed.world;
  const completeness = receiptCompleteness(world, { requireRunTerminal });
  const observedGraphs = await dist('workflow-kernel/planning/observed-graphs.js');
  const conveyor = await dist('workflow-kernel/planning/conveyor.js');
  const edges = conveyor.dependencyRowsOf(session);
  /* WP-09 observed-graph reconciliation, per the phase topology:
   *  - forward: every DECLARED dependency edge/node observed as consumed
   *    (requireDeclaredSubsetOnly - a single-cell vertical declares no
   *    dependency rows; its accepted items are the observed forward
   *    progress, never an undeclared-planning violation);
   *  - reverse: EXACT proof-closure equality with the frozen proof registry.
   * The strict conveyor composition (exact forward equality) is recorded
   * alongside for transparency; it applies to dependency conveyors. */
  const strict = observedGraphs.forwardReverseReconciliation(world, edges);
  const forwardSubset = observedGraphs.compareGraphs(
    observedGraphs.forwardObservedGraph(world, edges),
    observedGraphs.declaredPlanningGraph(edges),
    { requireDeclaredSubsetOnly: true },
  );
  const reverse = observedGraphs.reverseClosureReconciliation(world);
  const reconciliation = {
    phaseEqual: forwardSubset.equal && reverse.equal,
    declaredEdgeCount: edges.length,
    forward: { equal: forwardSubset.equal, divergences: forwardSubset.divergences ?? [], nodeCount: forwardSubset.nodeCount, edgeCount: forwardSubset.edgeCount },
    reverse: { equal: reverse.equal, divergences: reverse.divergences ?? [], nodeCount: reverse.nodeCount, edgeCount: reverse.edgeCount },
    strictConveyorComparison: { equal: strict.equal, divergences: strict.divergences ?? [] },
  };
  writeEvidence(phaseDir, 'receipts.json', completeness.receipts);
  writeEvidence(phaseDir, 'normalized-trace.json', observed.summary);
  writeEvidence(phaseDir, 'reconciliation.json', reconciliation);
  return {
    world,
    completeness,
    reconciliation,
    fingerprint: traceFingerprint(observed.summary),
    admitted: completeness.receipts.promptAssemblyReceipts.admitted.length,
  };
}

/* ------------------------------------------------------------------ */
/* Phase drivers                                                       */
/* ------------------------------------------------------------------ */

/** Phase 1: Discovery on the run's kernel database (the prewire path). */
export async function discoveryPhase(run, dbPath, phaseDir, log, channel) {
  const { composition, identity } = await composePhase(dbPath, channel);
  const support = await tests('workflow-kernel/workshops/discovery/support.mjs');
  const products = await dist('workflow-kernel/workshops/discovery/products.js');
  const intake = await dist('workflow-kernel/workshops/discovery/idea-intake.js');
  const manifestModule = await dist('workflow-kernel/workshops/discovery/installed-manifest.js');
  const mod = await production();

  const ideaValue = RUN_IDEAS[run.id];
  const idea = products.sealProduct(ideaValue);
  const bundle = intake.buildIdeaBundle(idea, support.IDEA_LINEAGE, { status: 'operator-intake', decisionRef: support.OPERATOR_DECISION_REF }, new Uint8Array(support.INTAKE_BYTES));
  const ingested = intake.ingestIdeaBundle(composition.session, bundle, new Uint8Array(support.INTAKE_BYTES), {
    expectedLineageId: support.IDEA_LINEAGE.lineageId,
    expectedParentLifecycleRef: null,
  });
  const ingressOk = ingested.imported === true;

  const { brief, intent } = await support.buildProductFixtures(idea);
  const manifest = manifestModule.installedWorkshopManifest();
  const launchKinds = manifestModule.DISCOVERY_LAUNCH_KINDS;
  const externalEvidence = await support.externalEvidence(manifest, true);
  for (const ref of ['activity-attempt:1', 'activity-attempt:2']) mod.bindAttemptLaunchPins(composition.admissionStore, ref);

  const driver = await dist('workflow-kernel/workshops/discovery/driver.js');
  const { result, thrown, drives } = await drivePhase('discovery', async () => driver.driveDiscoveryWorkshop({
    session: composition.session,
    roles: composition.discoveryRuntime,
    authorLaunchKind: launchKinds.author,
    reviewerLaunchKind: launchKinds.reviewer,
    transport: composition.transport,
    manifest,
    taskSummary: `${run.id} Discovery cognition round (real channel): ${run.title}. One request/response round - answer with the round's assessment of the admitted idea (constraints carried, unknowns surfaced). The kernel gates and verifies every product independently; do not start servers or long-running processes.`,
    requiredInfo: support.requiredIdeaInfo(idea),
    idea,
    brief,
    intent,
    verifyProducts: await support.productVerifier({ idea, brief, intent, manifest }),
    externalEvidence,
  }, { authorScript: support.authorScript(), reviewerScript: support.reviewerScript('go') }), { log });

  writeEvidence(phaseDir, 'journal.json', { drives, steps: result?.steps ?? [] });
  let worldEvidence;
  try {
    worldEvidence = await phaseWorldEvidence(composition.session, phaseDir, 'discovery', { requireRunTerminal: false, externalEvidence });
  } finally {
    composition.session.close();
  }

  const world = worldEvidence.world;
  const handoff = world.obligations.find((obligation) => obligation.kind === 'obligation:enterStage.solution-formalization');
  const checks = [
    ingressOk
      ? okCheck('discovery-ingress', `the run's idea imported through the PUBLIC idea ingress (bundle ${String(bundle.bundleDigest).slice(0, 12)}; idea ${ideaValue.ideaId})`)
      : redCheck('discovery-ingress', `idea ingress refused: ${JSON.stringify(ingested)}`),
    thrown === null && result?.blockedAt === undefined
      ? okCheck('discovery-settled', `the Discovery workshop settled over the REAL transport (${drives.length} drive(s), last ${drives[drives.length - 1]?.elapsedMs ?? 0}ms; trace ${worldEvidence.fingerprint.slice(0, 12)})`)
      : redCheck('discovery-settled', thrown !== null ? String(thrown?.message ?? thrown) : `blocked at ${String(result?.blockedAt)}: ${JSON.stringify(drives.at(-1)?.blocked ?? []).slice(0, 400)}`),
    world.heads.get('workplace:1')?.terminal === 'TerminalProof:workplace.success'
      ? okCheck('discovery-workplace-terminal', 'workplace:1 terminal TerminalProof:workplace.success')
      : redCheck('discovery-workplace-terminal', `workplace:1 terminal: ${String(world.heads.get('workplace:1')?.terminal)}`),
    handoff !== undefined && handoff.state === 'open'
      ? okCheck('discovery-durable-handoff', 'obligation:enterStage.solution-formalization stays OPEN (the durable handoff; the lifecycle routed and continues)')
      : redCheck('discovery-durable-handoff', `handoff obligation: ${handoff === undefined ? 'absent' : handoff.state}`),
    ...worldEvidence.completeness.checks.map((check) => (check.ok ? okCheck(`discovery-${check.id}`, check.detail) : redCheck(`discovery-${check.id}`, check.detail))),
    worldEvidence.reconciliation.phaseEqual
      ? okCheck('discovery-reconciliation', `WP-09 reconciliation green: forward declared-subset (${worldEvidence.reconciliation.forward.nodeCount ?? 0} observed nodes over ${worldEvidence.reconciliation.declaredEdgeCount} declared edge(s)) + exact reverse proof-closure (${worldEvidence.reconciliation.reverse.edgeCount ?? 0} closure edges)`)
      : redCheck('discovery-reconciliation', `reconciliation divergences: ${JSON.stringify({ forward: worldEvidence.reconciliation.forward.divergences, reverse: worldEvidence.reconciliation.reverse.divergences }).slice(0, 400)}`),
  ];
  return {
    checks,
    identity,
    admittedReceipts: worldEvidence.admitted,
    expectedRequests: EXPECTED_REQUESTS.discovery,
  };
}

/** Phase 2: Formalization (all nine desks) on its own fresh phase database. */
export async function formalizationPhase(run, dbPath, phaseDir, log, channel) {
  const { composition, identity } = await composePhase(dbPath, channel);
  const f = await tests('workflow-kernel/workshops/formalization/support.mjs');
  const mod = await production();

  const capsule = await f.buildHandoffCapsule();
  const ingress = await dist('workflow-kernel/workshops/formalization/ingress.js');
  const ingested = ingress.ingestDiscoveryHandoff(composition.session, capsule, new Uint8Array(f.HANDOFF_BYTES), f.HANDOFF_BINDING);
  const ingressOk = ingested.imported === true;

  const gates = await dist('workflow-kernel/workshops/formalization/gates.js');
  const manifest = await dist('workflow-kernel/workshops/formalization/manifest.js');
  const effectsModule = await dist('workflow-kernel/workshops/formalization/effects.js');
  const chain = await f.buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  const handoffView = await f.handoffRefOf(capsule);
  const externalEvidence = [
    ...gates.formalizationExternalEvidence(manifest.FORMALIZATION_CHECK_PROVIDERS, { ok: true, digest: f.sha256('product-verification') }),
    { kind: 'CheckPlan', ref: 'evidence:CheckPlan#discovery-import-shell', producer: 'external-input', payloadDigest: f.sha256('discovery-import-shell') },
  ];
  const applied = [];
  const config = {
    session: composition.session,
    roles: composition.formalizationRuntime,
    transport: composition.transport,
    effects: new effectsModule.FormalizationEffectExecutor(),
    externalEvidence,
    handoff: handoffView,
    shellCheckPlan: externalEvidence[externalEvidence.length - 1],
    authored: f.authoredOf(chain),
    shellScripts: f.shellScripts(),
    scripts: f.chainScripts(chain),
    effectSink: (effectId, contentDigest) => {
      applied.push({ effectId, contentDigest });
      return `effect:${effectId}:${f.sha256(contentDigest)}`;
    },
  };
  for (const ref of f.allAttemptRefs()) mod.bindAttemptLaunchPins(composition.admissionStore, ref);

  const driver = await dist('workflow-kernel/workshops/formalization/driver.js');
  const { result, thrown, drives } = await drivePhase('formalization', () => driver.runFormalizationWorkshop(config), { log });
  writeEvidence(phaseDir, 'journal.json', { drives, steps: result?.steps ?? [], desks: result?.desks ?? [], appliedEffects: applied });

  let worldEvidence;
  try {
    worldEvidence = await phaseWorldEvidence(composition.session, phaseDir, 'formalization', { requireRunTerminal: true, externalEvidence });
  } finally {
    composition.session.close();
  }
  const world = worldEvidence.world;
  const acceptedDesks = (result?.desks ?? []).filter((desk) => desk.gateVerdict === 'accepted').length;
  const checks = [
    ingressOk
      ? okCheck('formalization-ingress', `the Discovery handoff capsule imported through the public ingress (capsule ${String(capsule.capsuleDigest).slice(0, 12)})`)
      : redCheck('formalization-ingress', `handoff ingress refused: ${JSON.stringify(ingested)}`),
    thrown === null && result?.blockedAt === undefined
      ? okCheck('formalization-settled', `all nine desks settled over the REAL transport (${drives.length} drive(s); ${acceptedDesks}/8 formalization desks accepted; trace ${worldEvidence.fingerprint.slice(0, 12)})`)
      : redCheck('formalization-settled', thrown !== null ? String(thrown?.message ?? thrown) : `blocked at ${String(result?.blockedAt)}: ${JSON.stringify(drives.at(-1)?.blocked ?? []).slice(0, 400)}`),
    world.heads.get('factory-run:1')?.terminal === 'TerminalProof:run.success'
      ? okCheck('formalization-run-terminal', 'factory-run:1 terminal TerminalProof:run.success')
      : redCheck('formalization-run-terminal', `terminal: ${String(world.heads.get('factory-run:1')?.terminal)}`),
    ...worldEvidence.completeness.checks.map((check) => (check.ok ? okCheck(`formalization-${check.id}`, check.detail) : redCheck(`formalization-${check.id}`, check.detail))),
    worldEvidence.reconciliation.phaseEqual
      ? okCheck('formalization-reconciliation', `WP-09 reconciliation green: forward declared-subset (${worldEvidence.reconciliation.forward.nodeCount ?? 0} observed nodes over ${worldEvidence.reconciliation.declaredEdgeCount} declared edge(s)) + exact reverse proof-closure (${worldEvidence.reconciliation.reverse.edgeCount ?? 0} closure edges)`)
      : redCheck('formalization-reconciliation', `reconciliation divergences: ${JSON.stringify({ forward: worldEvidence.reconciliation.forward.divergences, reverse: worldEvidence.reconciliation.reverse.divergences }).slice(0, 400)}`),
  ];
  return {
    checks,
    identity,
    admittedReceipts: worldEvidence.admitted,
    expectedRequests: EXPECTED_REQUESTS.formalization,
  };
}

/** Phase 3: Development (the WP-08 material chain) over the run's product repo. */
export async function developmentPhase(run, dbPath, phaseDir, productRepo, log, channel) {
  const { composition, identity } = await composePhase(dbPath, channel);
  const support = await tests('workflow-kernel/development/support.mjs');
  const mod = await production();

  const capsule = await support.buildCapsuleFixture();
  const ingress = await dist('workflow-kernel/development/capsule.js');
  const imported = ingress.ingestCapsule(composition.session, capsule, new Uint8Array(support.CAPSULE_BYTES), {
    expectedLineageId: support.LINEAGE.lineageId,
    expectedParentLifecycleRef: support.LINEAGE.parentLifecycleRef,
  });
  const ingressOk = imported.imported === true;

  for (const ref of ['activity-attempt:1', 'activity-attempt:2', 'activity-attempt:3']) mod.bindAttemptLaunchPins(composition.admissionStore, ref);

  /* The in-conveyor product acceptance check (the effect settles ONLY on it):
   * R1 - the WP-08 acceptance layer (build + real server start + API +
   *      browser smoke); R2/R3 - a real build + the product's own unit proof
   *      harnesses inside the run's product repository. */
  const verifyProduct = run.id === 'R1'
    ? async () => {
        const acceptance = await dist('workflow-kernel/development/product-acceptance.js');
        const check = await acceptance.checkProductAcceptance(productRepo);
        if (check.ok) return { ok: true, detail: `verified in the run's product repository: ${check.verified.join(', ')}`, digest: check.evidenceDigest };
        return { ok: false, detail: `${check.reason}: ${check.detail}`, digest: sha256Of(String(check.detail)) };
      }
    : async () => {
        const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: productRepo, encoding: 'utf8', timeout: 180000 });
        if ((build.status ?? -1) !== 0) return { ok: false, detail: `build failed: ${String(build.stderr).slice(0, 200)}`, digest: sha256Of('build-failed') };
        const files = readdirSync(join(productRepo, 'test')).filter((name) => /\.(test|proof)\.mjs$/.test(name)).sort();
        const unit = spawnSync(process.execPath, ['--test', ...files.map((name) => join('test', name))], { cwd: productRepo, encoding: 'utf8', timeout: 180000 });
        if ((unit.status ?? -1) !== 0) return { ok: false, detail: `unit proofs failed: ${String(unit.stderr).slice(0, 200)}`, digest: sha256Of('unit-failed') };
        return { ok: true, detail: `build + ${files.length} unit proof harness(es) green in the run's product repository`, digest: sha256Of(`ek12-${run.id}-dev-verified`) };
      };

  const chain = await dist('workflow-kernel/development/material-chain.js');
  const developmentRuntime = composition.developmentRuntime.value;
  resolveUnified(composition, [developmentRuntime.launchKinds.author, developmentRuntime.launchKinds.reviewer]);
  const externalEvidence = chain.externalInputEvidence(`sha256:${sha256Of(`ek12-${run.id}-development`)}`, true);
  const { result, thrown, drives } = await drivePhase('development', async () => chain.driveDevelopmentVertical({
    session: composition.session,
    roles: composition.unifiedRoles,
    authorLaunchKind: developmentRuntime.launchKinds.author,
    reviewerLaunchKind: developmentRuntime.launchKinds.reviewer,
    transport: composition.transport,
    taskSummary: `${run.id} Development cognition round (real channel): ${run.title}. One request/response round - answer with the round's assessment of the material plan against the acceptance contract. The kernel verifies the product independently in the run's own repository; do not start servers or long-running processes.`,
    requiredInfo: await support.taskManifest(),
    verifyProduct,
    externalEvidence,
  }, { authorScript: await support.authorScript(), reviewerScript: await support.reviewerScript('accepted') }), { log });
  writeEvidence(phaseDir, 'journal.json', { drives, steps: result?.steps ?? [] });

  let worldEvidence;
  try {
    worldEvidence = await phaseWorldEvidence(composition.session, phaseDir, 'development', { requireRunTerminal: true, externalEvidence });
  } finally {
    composition.session.close();
  }
  const world = worldEvidence.world;
  const checks = [
    ingressOk
      ? okCheck('development-ingress', `the development capsule imported through the public capsule ingress (${imported.ingressReceiptRef ?? 'receipt'})`)
      : redCheck('development-ingress', `capsule ingress refused: ${JSON.stringify(imported)}`),
    thrown === null && result?.blockedAt === undefined
      ? okCheck('development-settled', `the material chain settled over the REAL transport with the effect over the VERIFIED product (${drives.length} drive(s); trace ${worldEvidence.fingerprint.slice(0, 12)})`)
      : redCheck('development-settled', thrown !== null ? String(thrown?.message ?? thrown) : `blocked at ${String(result?.blockedAt)}: ${JSON.stringify(drives.at(-1)?.blocked ?? []).slice(0, 400)}`),
    world.heads.get('factory-run:1')?.terminal === 'TerminalProof:run.success'
      ? okCheck('development-run-terminal', 'factory-run:1 terminal TerminalProof:run.success')
      : redCheck('development-run-terminal', `terminal: ${String(world.heads.get('factory-run:1')?.terminal)}`),
    ...worldEvidence.completeness.checks.map((check) => (check.ok ? okCheck(`development-${check.id}`, check.detail) : redCheck(`development-${check.id}`, check.detail))),
    worldEvidence.reconciliation.phaseEqual
      ? okCheck('development-reconciliation', `WP-09 reconciliation green: forward declared-subset (${worldEvidence.reconciliation.forward.nodeCount ?? 0} observed nodes over ${worldEvidence.reconciliation.declaredEdgeCount} declared edge(s)) + exact reverse proof-closure (${worldEvidence.reconciliation.reverse.edgeCount ?? 0} closure edges)`)
      : redCheck('development-reconciliation', `reconciliation divergences: ${JSON.stringify({ forward: worldEvidence.reconciliation.forward.divergences, reverse: worldEvidence.reconciliation.reverse.divergences }).slice(0, 400)}`),
  ];
  return {
    checks,
    identity,
    admittedReceipts: worldEvidence.admitted,
    expectedRequests: EXPECTED_REQUESTS.development,
  };
}

/** Phase 4: Delivery (the WP-11L release conveyor) with the local package. */
export async function deliveryPhase(run, dbPath, phaseDir, productRepo, log, channel) {
  const { composition, identity } = await composePhase(dbPath, channel);
  const d = await tests('workflow-kernel/workshops/delivery/support.mjs');
  const mod = await production();

  const bundle = await d.buildVerifiedBundle();
  const ingress = await dist('workflow-kernel/workshops/delivery/bundle.js');
  const imported = ingress.ingressVerifiedBundle(composition.session, bundle, new Uint8Array(d.PACKAGE_BYTES), {
    expectedLineageId: d.LINEAGE.lineageId,
    expectedParentLifecycleRef: d.LINEAGE.parentLifecycleRef,
  });
  const ingressOk = imported.imported === true;

  const manifestModule = await dist('workflow-kernel/workshops/delivery/manifest.js');
  const preflightModule = await dist('workflow-kernel/workshops/delivery/preflight.js');
  const policy = manifestModule.DELIVERY_RELEASE_POLICY;
  const preflight = preflightModule.runPreflight(bundle, policy);
  const externalEvidence = preflightModule.preflightEvidenceOf(preflight);
  const storeRoot = join(phaseDir, 'release-store');
  const inboxRoot = join(phaseDir, 'approval-inbox');
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(inboxRoot, { recursive: true });

  for (const ref of ['activity-attempt:1', 'activity-attempt:2']) mod.bindAttemptLaunchPins(composition.admissionStore, ref);

  const conveyor = await dist('workflow-kernel/workshops/delivery/conveyor.js');
  resolveUnified(composition, [composition.deliveryRuntime.authorLaunchKind, composition.deliveryRuntime.reviewerLaunchKind]);
  const config = {
    session: composition.session,
    roles: composition.unifiedRoles,
    authorLaunchKind: composition.deliveryRuntime.authorLaunchKind,
    reviewerLaunchKind: composition.deliveryRuntime.reviewerLaunchKind,
    transport: composition.transport,
    taskSummary: `${run.id} Delivery cognition round (real channel): assess the local release package assembly over the verified Development bundle. One request/response round - answer with the round's assessment. The kernel runs the packaging effect and records the release independently; do not start servers or long-running processes.`,
    requiredInfo: await d.taskManifest(),
    bundle,
    preflight,
    policy,
    storeRoot,
    inboxRoot,
    packaging: { productRoot: productRepo.replaceAll('\\', '/'), entries: RUN_PACKAGING_ENTRIES[run.id] },
    requestedBy: 'ek12-real-run-operator',
  };
  const operatorDecision = { ...d.approvedDecision(), requestId: conveyor.approvalRequestIdOf(config) };
  const { result, thrown, drives } = await drivePhase('delivery', () => conveyor.driveReleaseRun(config, {
    authorScript: d.authorScript(),
    reviewerScript: d.reviewerScript('accepted'),
    operatorDecision,
  }), { log });
  writeEvidence(phaseDir, 'journal.json', { drives, steps: result?.steps ?? [] });

  let worldEvidence;
  try {
    worldEvidence = await phaseWorldEvidence(composition.session, phaseDir, 'delivery', { requireRunTerminal: true, externalEvidence });
  } finally {
    composition.session.close();
  }
  const world = worldEvidence.world;
  const releases = existsSync(join(storeRoot, 'releases')) ? readdirSync(join(storeRoot, 'releases')) : [];
  const checks = [
    ingressOk
      ? okCheck('delivery-ingress', `the verified Development bundle imported through the public ingress (${String(bundle.bundleDigest ?? '').slice(0, 12)})`)
      : redCheck('delivery-ingress', `bundle ingress refused: ${JSON.stringify(imported)}`),
    thrown === null && result?.blockedAt === undefined
      ? okCheck('delivery-settled', `the release conveyor settled over the REAL transport (${drives.length} drive(s)); operator decision recorded, ${releases.length} release record(s); trace ${worldEvidence.fingerprint.slice(0, 12)}`)
      : redCheck('delivery-settled', thrown !== null ? String(thrown?.message ?? thrown) : `blocked at ${String(result?.blockedAt)}: ${JSON.stringify(drives.at(-1)?.blocked ?? []).slice(0, 400)}`),
    world.heads.get('factory-run:1')?.terminal === 'TerminalProof:run.success'
      ? okCheck('delivery-run-terminal', 'factory-run:1 terminal TerminalProof:run.success')
      : redCheck('delivery-run-terminal', `terminal: ${String(world.heads.get('factory-run:1')?.terminal)}`),
    releases.length > 0
      ? okCheck('delivery-release-record', `local release record(s) under ${join(storeRoot, 'releases').replaceAll('\\', '/')}`)
      : redCheck('delivery-release-record', `no release record under ${join(storeRoot, 'releases').replaceAll('\\', '/')}`),
    ...worldEvidence.completeness.checks.map((check) => (check.ok ? okCheck(`delivery-${check.id}`, check.detail) : redCheck(`delivery-${check.id}`, check.detail))),
    worldEvidence.reconciliation.phaseEqual
      ? okCheck('delivery-reconciliation', `WP-09 reconciliation green: forward declared-subset (${worldEvidence.reconciliation.forward.nodeCount ?? 0} observed nodes over ${worldEvidence.reconciliation.declaredEdgeCount} declared edge(s)) + exact reverse proof-closure (${worldEvidence.reconciliation.reverse.edgeCount ?? 0} closure edges)`)
      : redCheck('delivery-reconciliation', `reconciliation divergences: ${JSON.stringify({ forward: worldEvidence.reconciliation.forward.divergences, reverse: worldEvidence.reconciliation.reverse.divergences }).slice(0, 400)}`),
  ];
  return {
    checks,
    identity,
    admittedReceipts: worldEvidence.admitted,
    expectedRequests: EXPECTED_REQUESTS.delivery,
  };
}

/* ------------------------------------------------------------------ */
/* One real run                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run one real project (R1/R2/R3): the complete conveyor over the REAL
 * cognition transport + INDEPENDENT product verification. All paths fresh;
 * evidence under the run's evidence dir; honest checks only.
 */
export async function runRealProject(series, descriptor, { log = () => {}, channels } = {}) {
  const startedAt = Date.now();
  const evidenceDir = series.runEvidence(descriptor.id);
  const checks = [];
  const context = { runId: descriptor.id, productKind: descriptor.productKind, fixture: descriptor.fixture };

  /* Fresh-path provisioning (the fence refuses reused paths). */
  const kernelDir = freshDir(join(evidenceDir, 'kernel'), 'run kernel databases dir');
  const dbDiscovery = join(kernelDir, 'kernel.sqlite');
  const dbFormalization = join(kernelDir, 'formalization.sqlite');
  const dbDevelopment = join(kernelDir, 'development.sqlite');
  const dbDelivery = join(kernelDir, 'delivery.sqlite');
  const productRepo = freshDir(join(evidenceDir, 'product-repo'), 'run product repository');
  const staged = stageProductRepo(descriptor.fixture, productRepo);
  checks.push(okCheck('fresh-paths', `fresh kernel databases (discovery ${dbDiscovery.replaceAll('\\', '/')} + one per workshop phase) + fresh product repository ${productRepo.replaceAll('\\', '/')} (fixture ${staged.fixture})`));

  const phases = [];
  const identities = {};
  const runPhase = async (name, phaseDir, fn) => {
    const phaseStarted = Date.now();
    log(`  [${descriptor.id}] ${name} phase ... `);
    let outcome = null;
    try {
      outcome = await fn(phaseDir);
    } catch (error) {
      checks.push(redCheck(`${name}-phase`, `phase threw: ${String(error?.stack ?? error).slice(0, 500)}`));
      outcome = { checks: [], admittedReceipts: 0, expectedRequests: EXPECTED_REQUESTS[name] ?? 0 };
    }
    const elapsed = Date.now() - phaseStarted;
    identities[name] = outcome.identity ?? null;
    phases.push({ phase: name, elapsedMs: elapsed, admittedReceipts: outcome.admittedReceipts ?? 0, expectedRequests: outcome.expectedRequests ?? null });
    for (const check of outcome.checks ?? []) checks.push(check);
    const phaseGreen = (outcome.checks ?? []).length > 0 && outcome.checks.every((check) => check.status === 'green');
    log(`${phaseGreen ? 'GREEN' : 'RED'} in ${elapsed}ms (${outcome.admittedReceipts ?? 0}/${outcome.expectedRequests ?? '?'} real provider requests)\n`);
  };

  await runPhase('discovery', freshDir(join(evidenceDir, 'discovery'), 'discovery phase evidence'), (phaseDir) => discoveryPhase(descriptor, dbDiscovery, phaseDir, log, channels?.discovery));
  await runPhase('formalization', freshDir(join(evidenceDir, 'formalization'), 'formalization phase evidence'), (phaseDir) => formalizationPhase(descriptor, dbFormalization, phaseDir, log, channels?.formalization));
  await runPhase('development', freshDir(join(evidenceDir, 'development'), 'development phase evidence'), (phaseDir) => developmentPhase(descriptor, dbDevelopment, phaseDir, productRepo, log, channels?.development));
  await runPhase('delivery', freshDir(join(evidenceDir, 'delivery'), 'delivery phase evidence'), (phaseDir) => deliveryPhase(descriptor, dbDelivery, phaseDir, productRepo, log, channels?.delivery));

  /* The prompt-receipt law across the whole run: every provider request of
   * every phase carried an admitted PromptAssemblyReceipt, and the real
   * request count equals the conveyor's exact expectation. */
  const totalAdmitted = phases.reduce((sum, phase) => sum + (phase.admittedReceipts ?? 0), 0);
  const totalExpected = phases.reduce((sum, phase) => sum + (phase.expectedRequests ?? 0), 0);
  checks.push(totalAdmitted === totalExpected
    ? okCheck('real-provider-request-count', `${totalAdmitted} admitted PromptAssemblyReceipts across the four phases = the conveyor's exact expectation (${phases.map((phase) => `${phase.phase}:${phase.admittedReceipts}`).join(', ')})`)
    : redCheck('real-provider-request-count', `${totalAdmitted} admitted receipts != expected ${totalExpected} (${phases.map((phase) => `${phase.phase}:${phase.admittedReceipts}/${phase.expectedRequests ?? '?'}`).join(', ')})`));

  /* INDEPENDENT product verification: the run's evidence profile in the
   * run's own product repository (build/test/smoke/package per kind). */
  const product = await runProductEvidence(descriptor.productKind, descriptor.evidence, productRepo);
  context.product = { fixture: staged.fixture, buildDigests: product.buildDigests, packageDigest: product.packageDigest, packageReceiptOwner: product.packageReceiptOwner };
  checks.push(product.ok
    ? okCheck('product-outputs-verified', `${descriptor.productKind}: ${product.steps.map((step) => `${step.label}=${step.code}`).join(', ')} (package receipt ${String(product.packageDigest).slice(0, 12)})`)
    : redCheck('product-outputs-verified', String(product.failure)));
  writeEvidence(evidenceDir, 'product-steps.json', product.steps);
  writeEvidence(evidenceDir, 'delivery-receipt.json', { packageDigest: product.packageDigest, receiptOwner: product.packageReceiptOwner, releaseStore: join(evidenceDir, 'delivery', 'release-store').replaceAll('\\', '/') });
  context.compositionIdentities = identities;

  /* Persist the run record. */
  writeEvidence(evidenceDir, 'checks.json', checks);
  writeEvidence(evidenceDir, 'run.json', {
    runId: descriptor.id,
    title: descriptor.title,
    productKind: descriptor.productKind,
    kitId: series.kitId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    databases: { discovery: dbDiscovery.replaceAll('\\', '/'), formalization: dbFormalization.replaceAll('\\', '/'), development: dbDevelopment.replaceAll('\\', '/'), delivery: dbDelivery.replaceAll('\\', '/') },
    productRepository: productRepo.replaceAll('\\', '/'),
    phases,
    ...context,
  });

  const status = checks.every((check) => check.status === 'green') ? 'green' : 'red';
  return {
    id: descriptor.id,
    status,
    elapsedMs: Date.now() - startedAt,
    checksGreen: `${checks.filter((check) => check.status === 'green').length}/${checks.length}`,
    admittedReceipts: totalAdmitted,
    evidenceDir: evidenceDir.replaceAll('\\', '/'),
    checks,
  };
}

/* ------------------------------------------------------------------ */
/* The EK-12 preflight injection check (non-qualifying, before R1)      */
/* ------------------------------------------------------------------ */

/**
 * Prove the pre-send receipt refuses oversized injections WITHOUT reaching
 * the network: compose the production over a POISON channel (any send throws
 * and is counted), stage the lawful spine to exactly ONE admitted attempt
 * (public commands only, the development driver stopped after the attempt
 * creation), then issue the exact NEXT provider request with (a) an
 * oversized hook context and (b) an oversized tool result. The accountant
 * must refuse each at the pre-send boundary (the deterministic probe verdict
 * names the violation) and the transport must surface the typed refusal (the
 * durable store's fail-closed refusal-commit guard) with ZERO channel sends.
 */
export async function preflightInjectionCheck(series, { log = () => {} } = {}) {
  const preflightDir = freshDir(join(series.evidenceRoot, 'preflight'), 'preflight evidence dir');
  const checks = [];
  const dbPath = join(preflightDir, 'kernel.sqlite');
  let channelSendAttempts = 0;
  const poisonChannel = {
    async send() {
      channelSendAttempts += 1;
      throw new Error('PREFLIGHT_CHANNEL_MUST_NOT_BE_REACHED: the pre-send receipt must refuse before any network send');
    },
  };

  const mod = await production();
  const composition = mod.composeProduction({ dbPath, channel: poisonChannel });
  const support = await tests('workflow-kernel/development/support.mjs');
  const session = composition.session;
  const probes = [];
  try {
    /* The lawful spine to exactly one attempt (public ingress + the material
     * chain driver stopped right after the attempt creation). */
    const capsule = await support.buildCapsuleFixture();
    const ingress = await dist('workflow-kernel/development/capsule.js');
    const imported = ingress.ingestCapsule(session, capsule, new Uint8Array(support.CAPSULE_BYTES), {
      expectedLineageId: support.LINEAGE.lineageId,
      expectedParentLifecycleRef: support.LINEAGE.parentLifecycleRef,
    });
    checks.push(imported.imported
      ? okCheck('preflight-ingress', 'the preflight capsule imported through the public ingress')
      : redCheck('preflight-ingress', `ingress refused: ${JSON.stringify(imported)}`));

    mod.bindAttemptLaunchPins(composition.admissionStore, 'activity-attempt:1');
    const chain = await dist('workflow-kernel/development/material-chain.js');
    const developmentRuntime = composition.developmentRuntime.value;
    resolveUnified(composition, [developmentRuntime.launchKinds.author, developmentRuntime.launchKinds.reviewer]);
    const staged = await chain.driveDevelopmentVertical({
      session,
      roles: composition.unifiedRoles,
      authorLaunchKind: developmentRuntime.launchKinds.author,
      reviewerLaunchKind: developmentRuntime.launchKinds.reviewer,
      transport: composition.transport,
      taskSummary: 'EK-12 preflight injection probe (non-qualifying): stage one attempt, stop before cognition',
      requiredInfo: await support.taskManifest(),
      verifyProduct: async () => ({ ok: true, detail: 'staging stub (never reached)', digest: 'preflight' }),
      externalEvidence: chain.externalInputEvidence(`sha256:${sha256Of('ek12-preflight')}`, true),
    }, {
      authorScript: await support.authorScript(),
      reviewerScript: await support.reviewerScript('accepted'),
      stopAfter: 'author-attempt',
    });
    const attemptHead = session.hydrateWorld().world.heads.get('activity-attempt:1');
    checks.push(attemptHead !== undefined && staged.blockedAt === undefined
      ? okCheck('preflight-attempt-staged', 'the lawful spine staged activity-attempt:1 through public commands (the exact next provider request is the probe target)')
      : redCheck('preflight-attempt-staged', `staging blocked at ${String(staged.blockedAt)}; attempt head: ${JSON.stringify(attemptHead ?? null)}`));

    /* The injected envelopes: one oversized hook context, one oversized tool
     * result (both under maxPromptBytes so the LAYER budget violation is the
     * refusal the accountant names, not the byte cap). */
    const assembly = await dist('workflow-kernel/development/envelope-assembly.js');
    const slot = composition.unifiedRoles.slotOf(developmentRuntime.launchKinds.author);
    const base = {
      roleContract: slot.contract,
      taskSummary: 'EK-12 preflight injection probe (non-qualifying)',
      requiredInfo: await support.taskManifest(),
    };
    const oversizedHook = assembly.assembleDevelopmentEnvelope({ ...base, hookContext: [`hook-block ${'x'.repeat(400000)}`] });
    const oversizedToolResult = assembly.assembleDevelopmentEnvelope({ ...base, toolResults: [`tool-result ${'y'.repeat(200000)}`] });

    const pinsModule = await dist('workflow-kernel/composition/pins.js');
    const pins = pinsModule.productionAdmissionPins().pins;
    const attempt = {
      attemptRef: 'activity-attempt:1',
      contextRevision: 0,
      nextRequestOrdinal: 1,
      cumulativeInputTokens: 0,
      providerRoutePin: composition.transport.routePin,
      promptBudgetProfileRef: 'content://prompt-budget-profiles/factory-production-ek8',
      promptBudgetProfileDigest: 'preflight-probe',
    };
    for (const [name, envelope, expectedViolation] of [
      ['oversized-hook-context', oversizedHook, 'MAX_DYNAMIC_TOKENS_EXCEEDED'],
      ['oversized-tool-result', oversizedToolResult, 'MAX_TOOL_RESULT_TOKENS_EXCEEDED'],
    ]) {
      const verdict = (await dist('workflow-kernel/context-envelope/transport.js')).probeAccounting(pins, attempt, envelope);
      const refusal = verdict.ok === true ? null : { violation: verdict.violation, detail: verdict.violationDetail };
      let transportRefusal = null;
      try {
        const send = await composition.transport.sendProviderRequest({
          attemptRef: 'activity-attempt:1',
          expectedContextRevision: 0,
          envelope,
          idempotencyKey: `preflight:${name}`,
        });
        transportRefusal = send.kind === 'refused' ? { kind: send.refusal.kind, detail: send.refusal.detail } : { unexpectedKind: send.kind };
      } catch (error) {
        /* The durable store's fail-closed refusal-commit guard: the refusal
         * is the typed pre-commit finding of the production composition. */
        transportRefusal = { thrown: String(error?.message ?? error).slice(0, 300) };
      }
      probes.push({ name, expectedViolation, refusal, transportRefusal, channelSendsAfter: channelSendAttempts });
      const refusedAtBoundary = refusal !== null && refusal.violation === expectedViolation && channelSendAttempts === 0 && transportRefusal !== null;
      checks.push(refusedAtBoundary
        ? okCheck(`preflight-${name}`, `the exact next provider request was REFUSED at its pre-send receipt (${refusal.violation}: ${String(refusal.detail).slice(0, 120)}); transport surface: ${JSON.stringify(transportRefusal).slice(0, 160)}; channel sends: 0`)
        : redCheck(`preflight-${name}`, `probe=${JSON.stringify(refusal)} transport=${JSON.stringify(transportRefusal)} channelSends=${channelSendAttempts}`));
    }
    checks.push(channelSendAttempts === 0
      ? okCheck('preflight-no-network', 'the poison channel recorded ZERO sends: both oversized injections were refused before any network send')
      : redCheck('preflight-no-network', `the channel was reached ${channelSendAttempts} time(s) - the pre-send boundary failed`));
  } finally {
    session.close();
  }
  writeEvidence(preflightDir, 'preflight.json', { checks, probes, channelSendAttempts, dbPath: dbPath.replaceAll('\\', '/') });
  const ok = checks.every((check) => check.status === 'green');
  log(`  preflight injection check: ${ok ? 'GREEN' : 'RED'} (${channelSendAttempts} channel sends)\n`);
  return { ok, checks, preflightDir };
}
