/**
 * workflow-kernel/workshops/synthetic/scenario.ts - the scenario entry of
 * the synthetic report-generator workshop (WP-11V, the EK-8
 * generalization proof): a THIN wiring of THIS workshop's data into the
 * SAME kernel composition - the WP-07 obligation consumer behind the
 * WP-08 staged vertical, the same sole-writer repositories, the same
 * admitting transport, the same capsule ingress.
 *
 * This module owns NO driver: every transition is consumed by the one
 * obligation consumer (directly or behind the staged vertical), every
 * durable fact is written by a sole-writer repository, and the exercised
 * kind set of the whole run is REPORTED so the tests can prove it is a
 * SUBSET of the frozen registries - no new kernel transition kind, table,
 * driver or reconciler was needed to run a brand-new non-game workshop.
 *
 * PURITY over the session: no direct SQL, no projection reads, no timers.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { EvidenceFact } from '../../domain/types.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';
import type { CapsuleLineageBinding, DiscoveryFormalizationCapsule } from '../../development/capsule.js';
import { buildCapsule, capsuleArtifact, ingestCapsule } from '../../development/capsule.js';
import type { DevelopmentVerticalConfig, VerticalRunResult } from '../../development/material-chain.js';
import { INSTANCES, driveDevelopmentVertical } from '../../development/material-chain.js';
import type { ActorScript } from '../../development/actors.js';
import { ScriptedChannel } from '../../development/actors.js';
import { DurableAttemptAdmissionStore } from '../../development/admission-store.js';
import { createAdmittingTransport } from '../../context-envelope/transport.js';
import { RUNNING_COUNTER_IDENTITY } from '../../context-envelope/accountant.js';
import type { PromptBudgetProfile, ProviderModelLimitTableArtifact } from '../../context-envelope/accountant.js';
import type { ExternalReference } from '../../context-envelope/receipt.js';
import { compileReportingBindings, REPORTING_AUTHOR_LAUNCH_KIND, REPORTING_REVIEWER_LAUNCH_KIND, reportingRoleRuntime } from './bindings.js';
import type { ReportingBindings } from './bindings.js';
import { buildPublishedReport, buildReportDraft, datasetDigest, renderReportMarkdown, SYNTHETIC_DATASET, SYNTHETIC_SECTION_REFS, verifyReportProduct } from './products.js';
import type { PublishedReport } from './products.js';
import { syntheticCheckPlanEvidence } from './installation.js';

/* ------------------------------------------------------------------ */
/* The synthetic capsule (report-class discovery+formalization output) */
/* ------------------------------------------------------------------ */

/** The content-addressed terminal proof ref of the synthetic formalization parent. */
export const SYNTHETIC_PARENT_TERMINAL_PROOF_REF: string = `sha256:${sha256OfCanonical({ proof: 'synthetic-reporting-formalization-terminal' })}`;

export const SYNTHETIC_LINEAGE: CapsuleLineageBinding = {
  expectedLineageId: 'lineage:synthetic-reporting-2026-08',
  expectedParentLifecycleRef: SYNTHETIC_PARENT_TERMINAL_PROOF_REF,
};

/** Build the report workshop's Discovery+Formalization capsule. */
export function syntheticCapsule(): { readonly capsule: DiscoveryFormalizationCapsule; readonly packageBytes: Uint8Array } {
  const datasetDigestHex = datasetDigest();
  const packageBytes = Buffer.from(renderReportMarkdown(), 'utf8');
  const capsule = buildCapsule(
    {
      certificate: capsuleArtifact({ kind: 'formalization-certificate', decision: 'formalized', dataset: datasetDigestHex }),
      requirements: [
        capsuleArtifact({ id: 'REQ-R1', text: 'The report renders every dataset row into the throughput table.' }),
        capsuleArtifact({ id: 'REQ-R2', text: 'Outliers above the threshold are listed in the outlier notes.' }),
      ],
      terminalClaims: [
        capsuleArtifact({ claimId: 'TC-R1', claim: 'the published report cites the exact dataset digest' }),
        capsuleArtifact({ claimId: 'TC-R2', claim: 'every declared section ref is present in the published report' }),
      ],
      acceptanceCriteria: [
        capsuleArtifact({ acId: 'AC-R1', given: 'dataset snapshot', when: 'report rendered', then: 'dataset digest matches' }),
        capsuleArtifact({ acId: 'AC-R2', given: 'section refs', when: 'report rendered', then: 'all sections present' }),
      ],
      modulePackage: capsuleArtifact({ name: 'synthetic-reporting-module', entry: 'reporting.production-cell', interfaces: ['tool:read-dataset', 'tool:render-section', 'tool:verify-report'] }),
      buildOutput: capsuleArtifact({ script: 'render-report', output: 'report.md' }),
      baseRepository: capsuleArtifact({ baseline: `sha256:${datasetDigestHex}`, tree: 'synthetic-reporting base' }),
    },
    {
      lineageId: SYNTHETIC_LINEAGE.expectedLineageId,
      parentLifecycleRef: SYNTHETIC_PARENT_TERMINAL_PROOF_REF,
    },
    { status: 'formalization-terminal', terminalProofRef: SYNTHETIC_PARENT_TERMINAL_PROOF_REF },
    new Uint8Array(packageBytes),
  );
  return { capsule, packageBytes: new Uint8Array(packageBytes) };
}

/* ------------------------------------------------------------------ */
/* The admission wiring (the same instrumented path)                   */
/* ------------------------------------------------------------------ */

const SYNTHETIC_ROUTE_PIN = { provider: 'synthetic', model: 'report-model', version: 'ek8-2026-08' } as const;

function syntheticLimitTable(): ProviderModelLimitTableArtifact {
  return {
    kind: 'provider-model-limit-table',
    rows: [
      { provider: SYNTHETIC_ROUTE_PIN.provider, model: SYNTHETIC_ROUTE_PIN.model, version: SYNTHETIC_ROUTE_PIN.version, contextLimitTokens: 200000 },
    ],
  };
}

function syntheticBudgetProfile(): PromptBudgetProfile {
  const table = syntheticLimitTable();
  return {
    providerModelLimitTableRef: {
      ref: 'content://provider-model-limit-tables/synthetic-reporting-ek8',
      // The accountant's content-address rule: sha256 over the canonical ROWS array.
      digest: `sha256:${sha256OfCanonical(table.rows)}`,
      digestAlgorithm: 'sha256',
    },
    providerContextLimitTokens: 200000,
    tokenCounterRef: { ...RUNNING_COUNTER_IDENTITY },
    maxProviderRequests: 10,
    maxStaticTokens: 100000,
    maxDynamicTokens: 20000,
    maxRecoveryTokens: 4000,
    maxToolResultTokens: 8000,
    maxTotalInputTokens: 120000,
    maxCumulativeSessionInputTokens: 300000,
    reservedOutputTokens: 4096,
    providerOverheadReserveTokens: 2048,
    safetyMarginTokens: 2048,
    maxPromptBytes: 524288,
  };
}

/* ------------------------------------------------------------------ */
/* The scripted actors                                                 */
/* ------------------------------------------------------------------ */

export function syntheticAuthorScript(): ActorScript {
  const draft = buildReportDraft('capsule');
  return {
    responses: [
      {
        toolCalls: [
          { name: 'tool:read-dataset', args: [SYNTHETIC_DATASET.datasetId] },
          { name: 'tool:render-section', args: ['content://report-sections/summary'] },
        ],
        text: 'rendered the throughput report from the dataset snapshot',
        product: { digest: draft.reportDigest, description: 'the rendered throughput report (markdown)' },
      },
    ],
  };
}

export function syntheticReviewerScript(): ActorScript {
  return {
    responses: [
      {
        toolCalls: [{ name: 'tool:verify-report', args: [SYNTHETIC_DATASET.datasetId] }],
        text: 'verified the report against the dataset digest and the section refs',
        verdict: 'accepted',
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* The scenario                                                        */
/* ------------------------------------------------------------------ */

/** The distinct frozen kinds one committed world exercised (the generalization numbers). */
export interface ExercisedKinds {
  readonly commands: readonly string[];
  readonly obligationKinds: readonly string[];
  readonly waitKinds: readonly string[];
  readonly evidenceKinds: readonly string[];
  readonly proofKinds: readonly string[];
  readonly aggregateHeads: readonly string[];
}

export interface SyntheticScenarioResult {
  readonly bindings: ReportingBindings;
  readonly run: VerticalRunResult;
  readonly publishedReport: { readonly mapped: true; readonly value: PublishedReport; readonly digest: string } | { readonly mapped: false; readonly detail: string };
  readonly exercised: ExercisedKinds;
  readonly blockedAt: string | undefined;
}

function refOf(kind: string, digestHex: string, summary: string): ExternalReference {
  return { ref: `content://${kind}/${digestHex}`, digest: `sha256:${digestHex}`, summary };
}

/**
 * Run the complete synthetic report-generator scenario over the SAME
 * kernel: capsule -> spine -> author loop -> reviewer loop -> final gate ->
 * verified product effect -> CellFinalAcceptance -> settlement ladder ->
 * run terminal proof. Deterministic; safe to re-drive (idempotent).
 */
export async function runSyntheticReportingScenario(session: KernelPersistenceSession): Promise<SyntheticScenarioResult> {
  // 1. The workshop's own role bindings (compiled through the one path).
  const compiled = compileReportingBindings();
  if ('refused' in compiled) {
    throw new Error(`SYNTHETIC_BINDINGS_REFUSED: ${compiled.detail}`);
  }
  const { runtime } = reportingRoleRuntime(compiled.value);

  // 2. Capsule ingress (the one public ingress; idempotent over the durable key).
  const { capsule, packageBytes } = syntheticCapsule();
  const alreadyIngressed = session.hydrateWorld().world.idempotency.has(`capsule-ingress:${capsule.capsuleRef}`);
  if (!alreadyIngressed) {
    const ingress = ingestCapsule(session, capsule, packageBytes, SYNTHETIC_LINEAGE);
    if ('refused' in ingress) {
      throw new Error(`SYNTHETIC_INGRESS_REFUSED: ${ingress.reason}: ${ingress.detail}`);
    }
  }

  // 3. The same instrumented transport over the durable admission store.
  const profile = syntheticBudgetProfile();
  const limitTable = syntheticLimitTable();
  const store = new DurableAttemptAdmissionStore(session);
  for (const attemptRef of ['activity-attempt:1', 'activity-attempt:2']) {
    store.bind(attemptRef, {
      providerRoutePin: { ...SYNTHETIC_ROUTE_PIN },
      promptBudgetProfileRef: 'content://prompt-budget-profiles/synthetic-reporting-ek8',
      promptBudgetProfileDigest: profile.providerModelLimitTableRef.digest,
    });
  }
  const transport = createAdmittingTransport({
    transportId: 'ek-wp11v-synthetic-reporting-transport',
    routePin: { ...SYNTHETIC_ROUTE_PIN },
    maxOutputTokens: 4096,
    pins: { profile, limitTable },
    store,
    channel: new ScriptedChannel(),
    exposesMidLoopRequests: true,
  });

  // 4. The task projection of THIS workshop (dataset + sections + claims).
  const datasetDigestHex = datasetDigest();
  const requiredInfo = {
    scope: [
      refOf('dataset', datasetDigestHex.slice(0, 16), `dataset ${SYNTHETIC_DATASET.datasetId} (${SYNTHETIC_DATASET.rows.length} rows)`),
      ...SYNTHETIC_SECTION_REFS.map((section, index) => refOf('report-sections', `${datasetDigestHex.slice(0, 12)}${index}`, `section ${section}`)),
    ],
    unknowns: [refOf('unknowns', datasetDigestHex.slice(16, 32), 'threshold policy unknown (owner: upstream policy cell)')],
    terminalClaims: [
      refOf('terminal-claims', `${datasetDigestHex.slice(0, 16)}t1`, 'TC-R1 dataset digest cited'),
      refOf('terminal-claims', `${datasetDigestHex.slice(0, 16)}t2`, 'TC-R2 all sections present'),
    ],
  };

  // 5. The external Input authority evidence of THIS workshop (its CheckPlan).
  const draft = buildReportDraft(capsule.capsuleRef);
  const verification = verifyReportProduct(draft, { datasetDigest: datasetDigestHex, sectionRefs: SYNTHETIC_SECTION_REFS });
  const externalEvidence: readonly EvidenceFact[] = [
    ...syntheticCheckPlanEvidence(),
    verification.ok
      ? { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#synthetic', producer: 'external-input', payloadDigest: verification.digest }
      : { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#synthetic', producer: 'external-input', payloadDigest: verification.digest },
    { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: datasetDigestHex },
  ];

  // 6. The SAME staged vertical over THIS workshop's data.
  const config: DevelopmentVerticalConfig = {
    session,
    roles: runtime,
    authorLaunchKind: REPORTING_AUTHOR_LAUNCH_KIND,
    reviewerLaunchKind: REPORTING_REVIEWER_LAUNCH_KIND,
    transport,
    taskSummary: 'Render the dataset snapshot into the throughput report',
    requiredInfo,
    verifyProduct: async () => {
      const check = verifyReportProduct(draft, { datasetDigest: datasetDigestHex, sectionRefs: SYNTHETIC_SECTION_REFS });
      return { ok: check.ok, detail: check.detail, digest: check.digest };
    },
    externalEvidence,
  };
  const run = await driveDevelopmentVertical(config, {
    authorScript: syntheticAuthorScript(),
    reviewerScript: syntheticReviewerScript(),
    finalGateVerdict: 'accepted',
  });

  // 7. The workshop output from the terminal facts.
  const world = session.hydrateWorld().world;
  const acceptanceDigest = world.evidence.find((fact) => fact.kind === 'CellFinalAcceptance')?.payloadDigest ?? '';
  const publishedReport = buildPublishedReport({
    capsuleRef: capsule.capsuleRef,
    acceptanceDigest: acceptanceDigest.replace(/^sha256:/, ''),
    terminalProofs: world.proofs.map((proof) => proof.id),
    runTerminalOutcome: world.heads.get(INSTANCES.factory)?.terminal === 'TerminalProof:run.success' ? 'success' : 'not-terminal',
  });

  // 8. The exercised kind set (the generalization numbers for the tests).
  const exercised: ExercisedKinds = {
    commands: [...new Set(world.events.map((event) => event.transition))],
    obligationKinds: [...new Set(world.obligations.map((obligation) => obligation.kind))],
    waitKinds: [...new Set(world.waits.map((wait) => wait.kind))],
    evidenceKinds: [...new Set(world.evidence.map((fact) => fact.kind))],
    proofKinds: [...new Set(world.proofs.map((proof) => proof.id))],
    aggregateHeads: [...new Set([...world.heads.values()].map((head) => head.aggregate))],
  };
  const blocked = run.steps.find((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
  return { bindings: compiled.value, run, publishedReport, exercised, blockedAt: blocked?.step };
}
