/**
 * workflow-kernel/workshops/development/runbook.ts - the staged RUNBOOK of
 * the converted Development workshop (WP-11V, plan EK-8): the full
 * scenario capsule -> implementation -> review -> integration -> freeze ->
 * readiness certification -> verified, driven ONLY through public kernel
 * commands, the WP-07 obligation consumer and WP-09-style durable topology
 * reads - building ON the WP-08 vertical by importing it, never editing it.
 *
 * Phases:
 *   ingress        capsule.ingestCapsule (the one public capsule ingress);
 *   integration    the WP-08 vertical up to the accepted final gate
 *                  (implementation + review + integration), with the gate
 *                  verdict DECIDED by this workshop's declared gate rules;
 *   certification  the Elite-2 readiness gate: the machine verifies the
 *                  product (real acceptance check) but CANNOT observe
 *                  readiness-for-certification, so the effect settles
 *                  human-wait (the frozen TypedWait:human-input), the
 *                  operator disposes the readiness manifest through the
 *                  D12-disciplined public wake path, and the dispositioned
 *                  effect executes once and settles success (the
 *                  already-applied arm is lawful too and is exercised
 *                  separately - see alreadyAppliedResumeArm);
 *   verified       the WP-08 vertical re-drive converges the settlement
 *                  ladder to the run terminal proof; the terminal facts
 *                  map onto the workshop's VerifiedBundle output.
 *
 * D12 arm: effectUncertaintyArm settles the effect UNKNOWN and proves the
 * operator-disposition fence - a wake without the disposition receipt is a
 * TYPED REFUSAL, never an automatic duplicate.
 *
 * Every step is idempotent over durable facts: re-driving a reopened
 * session converges. The runbook writes ONLY through sole-writer
 * repositories and the obligation consumer.
 */

import type { EvidenceFact, TypedRefusal } from '../../domain/types.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';
import type { CapsuleIngressResult, CapsuleLineageBinding, DiscoveryFormalizationCapsule } from '../../development/capsule.js';
import { ingestCapsule } from '../../development/capsule.js';
import type { DevelopmentVerticalConfig, VerticalRunResult } from '../../development/material-chain.js';
import { driveDevelopmentVertical, INSTANCES } from '../../development/material-chain.js';
import type { ActorScript } from '../../development/actors.js';
import type { ConsumeResult } from '../../application/obligation-consumer.js';
import { consumeClaim, openFrontier } from '../../application/obligation-consumer.js';
import type { ObligationClaim } from '../../application/obligation-consumer.js';
import type { WakeResult } from '../../application/waits.js';
import { pendingWaits, wakeByCommand } from '../../application/waits.js';
import type { CheckResult, GateEvaluation } from './checkplans.js';
import { CERTIFICATION_GATE_ID, FINAL_GATE_ID, developmentGateDeclarations, evaluateSemanticGate } from './checkplans.js';
import type { MappingRefusal } from './mappings.js';
import { toReadinessManifest, toVerifiedBundle } from './mappings.js';
import type { ReadinessManifest, VerifiedBundle } from './products.js';
import type { OperatorDispositionReceipt } from './waits.js';
import { buildOperatorDisposition, verifyOperatorDisposition } from './waits.js';
import type { OperatorReadinessDecision } from './waits.js';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** The scenario inputs beyond the WP-08 vertical config. */
export interface WorkshopScenarioOptions {
  readonly authorScript: ActorScript;
  readonly reviewerScript: ActorScript;
  /** The capsule + its bytes + the expected lineage binding (public ingress inputs). */
  readonly capsule: DiscoveryFormalizationCapsule;
  readonly packageBytes: Uint8Array;
  readonly lineage: CapsuleLineageBinding;
  /** The scripted operator of the readiness disposition (the D12 actor). */
  readonly operator: { readonly operatorId: string; readonly note: string; readonly decision?: OperatorReadinessDecision };
  /** Override the final-gate machine checks (defaults derive from the real product verification). */
  readonly finalGateChecks?: readonly CheckResult[];
}

/* ------------------------------------------------------------------ */
/* World helpers (durable reads only)                                  */
/* ------------------------------------------------------------------ */

function worldOf(session: KernelPersistenceSession) {
  return session.hydrateWorld().world;
}

/** The frontier claim of the open obligation targeting one exact command (WP-09-style durable binding). */
function frontierClaimOf(session: KernelPersistenceSession, target: string): ObligationClaim | undefined {
  const entry = openFrontier(session).find((candidate) => candidate.target === target && candidate.claim !== undefined);
  return entry?.claim;
}

/** The pending wait row of one kind owned by one instance. */
function pendingWaitOf(session: KernelPersistenceSession, kind: string, ownerInstanceId: string): { readonly rowId: number } | undefined {
  return pendingWaits(session).find((wait) => wait.kind === kind && wait.ownerInstanceId === ownerInstanceId);
}

/** The payload digest of the first committed evidence fact of one kind produced by one instance. */
function evidenceDigestOf(session: KernelPersistenceSession, kind: string): string | undefined {
  return worldOf(session).evidence.find((fact) => fact.kind === kind)?.payloadDigest;
}

/** A typed refused consume result (the closed ConsumeResult refusal arm). */
function refusedConsume(claim: ObligationClaim, detail: string): ConsumeResult {
  return {
    status: 'refused',
    claim,
    refusal: { refused: true, reason: 'MISSING_EVIDENCE', detail },
    fenceLost: false,
  };
}

/* ------------------------------------------------------------------ */
/* Gate decisions (declared rules only)                                */
/* ------------------------------------------------------------------ */

/** The declared certification gate decision: the readiness check is operator-only, so the verdict is always human-wait. */
export function certificationGateDecision(): GateEvaluation {
  const gate = developmentGateDeclarations().find((entry) => entry.gateId === CERTIFICATION_GATE_ID);
  if (gate === undefined) {
    throw new Error('WORKSHOP_RUNBOOK_INCOMPLETE: the certification gate declaration is missing from the installed workshop');
  }
  return evaluateSemanticGate(gate, [{ checkId: 'development.check.readiness-for-certification', outcome: 'operator-only' }]);
}

/** The declared final-gate decision over machine checks (verification evidence + verdict monotonicity). */
export function finalGateDecision(verificationOk: boolean, reviewerPayloadWellFormed: boolean): GateEvaluation {
  const gate = developmentGateDeclarations().find((entry) => entry.gateId === FINAL_GATE_ID);
  if (gate === undefined) {
    throw new Error('WORKSHOP_RUNBOOK_INCOMPLETE: the final gate declaration is missing from the installed workshop');
  }
  return evaluateSemanticGate(gate, [
    { checkId: 'development.check.verification-evidence', outcome: verificationOk ? 'pass' : 'fail' },
    { checkId: 'development.check.verdict-monotonicity', outcome: reviewerPayloadWellFormed ? 'pass' : 'fail' },
  ]);
}

/* ------------------------------------------------------------------ */
/* The certification phase (Elite-2 + D12 through the public path)      */
/* ------------------------------------------------------------------ */

export interface CertificationPhaseResult {
  /** True when the phase already happened in this run world (idempotent re-drive skip). */
  readonly replayed?: boolean;
  /** The machine observation of the product (real acceptance check). */
  readonly machineObservation: { readonly ok: boolean; readonly detail: string; readonly digest: string };
  /** The declared certification gate decision (human-wait - the machine cannot observe readiness). */
  readonly gate: GateEvaluation;
  /** The effect settlement as human-wait (commits TypedWait:human-input). */
  readonly settle: ConsumeResult;
  /** The freeze-boundary readiness manifest (this workshop's input product of certification). */
  readonly readinessManifest: { readonly mapped: true; readonly value: ReadinessManifest; readonly digest: string } | MappingRefusal;
  /** The content-addressed operator disposition receipt (verified before the wake). */
  readonly disposition: OperatorDispositionReceipt;
  /** The D12-disciplined public wake: the operator disposition command discharges the typed wait. */
  readonly wake: WakeResult;
  /** The idempotent resume: the effect re-settles already-applied. */
  readonly resume: ConsumeResult;
}

function externalEvidenceOf(config: DevelopmentVerticalConfig): readonly EvidenceFact[] {
  return config.externalEvidence;
}

/** Enter and discharge the readiness certification: human wait -> operator disposition -> idempotent resume. */
async function certifyReadiness(
  config: DevelopmentVerticalConfig,
  options: WorkshopScenarioOptions,
): Promise<CertificationPhaseResult> {
  const session = config.session;

  // 0. Idempotent re-drive: the operator disposition already committed in
  //    this run world (its durable wake key) - the whole phase replays.
  const dispositionKey = 'workshop:development:certification:disposition';
  if (worldOf(session).idempotency.has(dispositionKey)) {
    const machineObservation = await config.verifyProduct();
    const settle = { status: 'replayed' as const, claim: undefined as unknown as ConsumeResult['claim'], originalEventSequence: -1 };
    return {
      replayed: true,
      machineObservation,
      gate: certificationGateDecision(),
      settle,
      readinessManifest: { refused: true, code: 'EMPTY_SCOPE_IS_NOT_A_PRODUCT', detail: 'replayed certification phase (the manifest mapped on the first drive)' },
      disposition: buildOperatorDisposition({
        operatorId: options.operator.operatorId,
        readinessManifestDigest: machineObservation.digest.replace(/^sha256:/, ''),
        decision: options.operator.decision ?? 'readiness-certified',
        note: `${options.operator.note} (replayed)`,
      }),
      wake: { status: 'replayed' as const, waitKind: 'TypedWait:human-input', command: 'workplace.resolveHumanResponse', idempotencyKey: dispositionKey },
      resume: { status: 'replayed' as const, claim: undefined as unknown as ConsumeResult['claim'], originalEventSequence: -1 },
    };
  }

  // 1. The machine observation of the frozen product (the real acceptance check).
  const machineObservation = await config.verifyProduct();

  // 2. The declared gate decision: readiness-for-certification is operator-only.
  const gate = certificationGateDecision();
  if (!('decided' in gate) || gate.verdict !== 'human-wait') {
    throw new Error(`WORKSHOP_CERTIFICATION_GATE_UNDECIDED: ${JSON.stringify(gate)}`);
  }

  // 3. Settle the effect as human-wait through the obligation consumer (the
  //    public claim path); the kernel commits TypedWait:human-input.
  const settleClaim = frontierClaimOf(session, 'workplace.settleEffect');
  if (settleClaim === undefined) {
    throw new Error('WORKSHOP_CERTIFICATION_NO_EFFECT_CLAIM: no open obligation targets the effect settlement after the accepted final gate');
  }
  const settle = consumeClaim(session, settleClaim, { effectOutcome: 'human-wait' }, { externalEvidence: externalEvidenceOf(config) });

  // 4. The freeze-boundary readiness manifest from durable facts.
  const settledEvidenceKinds = worldOf(session).evidence
    .filter((fact) => fact.kind.startsWith('EffectReceipt:'))
    .map((fact) => fact.kind);
  const readinessManifest = toReadinessManifest({
    capsuleRef: options.capsule.capsuleRef,
    workplaceInstanceId: INSTANCES.workplace,
    machineObservation: machineObservation.ok ? 'product-verified' : 'product-verification-failed',
    verificationDigest: machineObservation.digest.replace(/^sha256:/, ''),
    settledEvidenceKinds,
  });

  // 5. The operator disposition receipt (content-addressed; verified before use).
  const manifestDigest = 'mapped' in readinessManifest ? readinessManifest.digest : machineObservation.digest;
  const disposition = buildOperatorDisposition({
    operatorId: options.operator.operatorId,
    readinessManifestDigest: manifestDigest,
    decision: options.operator.decision ?? 'readiness-certified',
    note: options.operator.note,
  });
  const verified = verifyOperatorDisposition(disposition);
  if (!verified.verified) {
    throw new Error(`WORKSHOP_DISPOSITION_UNVERIFIED: ${verified.detail}`);
  }

  // 6. The D12-disciplined public wake: the operator disposition command
  //    discharges the pending typed wait.
  const wait = pendingWaitOf(session, 'TypedWait:human-input', INSTANCES.workplace);
  if (wait === undefined) {
    throw new Error('WORKSHOP_CERTIFICATION_NO_WAIT: the human-wait settlement did not leave a pending TypedWait:human-input');
  }
  const wake = wakeByCommand(session, wait.rowId, {
    command: 'workplace.resolveHumanResponse',
    idempotencyKey: 'workshop:development:certification:disposition',
    operatorDispositionRef: disposition.ref,
    evidenceRefs: [disposition.ref],
  });

  // 7. The post-disposition resume: the operator disposition AUTHORIZES the
  //    freeze, so the effect executes once and settles success (the frozen
  //    run-success guard requires exactly EffectReceipt:success; the
  //    already-applied arm is exercised separately and documented). The
  //    deterministic key rule keeps the settlement idempotent - a re-drive
  //    replays, it never sends twice.
  const resumeClaim = frontierClaimOf(session, 'workplace.settleEffect');
  const resume = resumeClaim === undefined
    ? refusedConsume(settleClaim, 'no open obligation targets the effect resume')
    : consumeClaim(session, resumeClaim, { effectOutcome: 'success' }, { externalEvidence: externalEvidenceOf(config) });

  return { machineObservation, gate, settle, disposition, wake, resume, readinessManifest };
}

/**
 * The already-applied arm of the certification resume: when the operator
 * disposition discovers the effect condition ALREADY held, the truthful
 * resume outcome is already-applied (a success-shaped receipt for final
 * acceptance). FROZEN-UNIVERSE NOTE (reported, not worked around): the
 * run-success guard accepts only EffectReceipt:success, so a world whose
 * last effect receipt is already-applied can complete the cell acceptance
 * but not the run terminal proof - EK-8 reconciliation owns that edge.
 */
export function alreadyAppliedResumeArm(config: DevelopmentVerticalConfig, operator: { readonly operatorId: string; readonly note: string }): {
  readonly settle: ConsumeResult;
  readonly wake: WakeResult;
  readonly resume: ConsumeResult;
} {
  const session = config.session;
  const settleClaim = frontierClaimOf(session, 'workplace.settleEffect');
  if (settleClaim === undefined) {
    throw new Error('WORKSHOP_ALREADY_APPLIED_NO_CLAIM: no open obligation targets the effect settlement');
  }
  const settle = consumeClaim(session, settleClaim, { effectOutcome: 'human-wait' }, { externalEvidence: externalEvidenceOf(config) });
  const wait = pendingWaitOf(session, 'TypedWait:human-input', INSTANCES.workplace);
  if (wait === undefined) {
    throw new Error('WORKSHOP_ALREADY_APPLIED_NO_WAIT: the human-wait settlement did not leave a pending wait');
  }
  const disposition = buildOperatorDisposition({
    operatorId: operator.operatorId,
    readinessManifestDigest: '0'.repeat(64),
    decision: 'readiness-certified',
    note: `${operator.note} (condition already held)`,
  });
  const wake = wakeByCommand(session, wait.rowId, {
    command: 'workplace.resolveHumanResponse',
    idempotencyKey: 'workshop:development:already-applied-disposition',
    operatorDispositionRef: disposition.ref,
    evidenceRefs: [disposition.ref],
  });
  const resumeClaim = frontierClaimOf(session, 'workplace.settleEffect');
  const resume = resumeClaim === undefined
    ? refusedConsume(settleClaim, 'no open obligation targets the effect resume')
    : consumeClaim(session, resumeClaim, { effectOutcome: 'already-applied' }, { externalEvidence: externalEvidenceOf(config) });
  return { settle, wake, resume };
}

/* ------------------------------------------------------------------ */
/* The D12 effect-uncertainty arm                                      */
/* ------------------------------------------------------------------ */

export interface EffectUncertaintyArmResult {
  /** The effect settled UNKNOWN (commits TypedWait:effect-uncertainty). */
  readonly settle: ConsumeResult;
  /** The typed refusal of the automatic wake WITHOUT an operator disposition (D12). */
  readonly refusedWithoutDisposition: WakeResult;
  /** The lawful wake WITH the operator disposition receipt. */
  readonly wake: WakeResult;
  /** The idempotent resume (already-applied). */
  readonly resume: ConsumeResult;
}

/** The D12 arm: an uncertain effect never redrives automatically; only the operator disposition wakes it. */
export function effectUncertaintyArm(config: DevelopmentVerticalConfig, operator: { readonly operatorId: string; readonly note: string }): EffectUncertaintyArmResult {
  const session = config.session;
  const settleClaim = frontierClaimOf(session, 'workplace.settleEffect');
  if (settleClaim === undefined) {
    throw new Error('WORKSHOP_D12_NO_EFFECT_CLAIM: no open obligation targets the effect settlement');
  }
  const settle = consumeClaim(session, settleClaim, { effectOutcome: 'unknown' }, { externalEvidence: externalEvidenceOf(config) });

  const wait = pendingWaitOf(session, 'TypedWait:effect-uncertainty', INSTANCES.workplace);
  if (wait === undefined) {
    throw new Error('WORKSHOP_D12_NO_WAIT: the unknown settlement did not leave a pending TypedWait:effect-uncertainty');
  }
  // The fence: an automatic wake (no operator disposition receipt) is refused.
  const refusedWithoutDisposition = wakeByCommand(session, wait.rowId, {
    command: 'workplace.resolveHumanResponse',
    idempotencyKey: 'workshop:development:d12-automatic-redrive',
  });
  // The lawful operator disposition.
  const disposition = buildOperatorDisposition({
    operatorId: operator.operatorId,
    readinessManifestDigest: '0'.repeat(64),
    decision: 'readiness-certified',
    note: `${operator.note} (uncertainty disposition)`,
  });
  const wake = wakeByCommand(session, wait.rowId, {
    command: 'workplace.resolveHumanResponse',
    idempotencyKey: 'workshop:development:d12-disposition',
    operatorDispositionRef: disposition.ref,
    evidenceRefs: [disposition.ref],
  });
  const resumeClaim = frontierClaimOf(session, 'workplace.settleEffect');
  const resume = resumeClaim === undefined
    ? refusedConsume(settleClaim, 'no open obligation targets the effect resume')
    : consumeClaim(session, resumeClaim, { effectOutcome: 'success' }, { externalEvidence: externalEvidenceOf(config) });
  return { settle, refusedWithoutDisposition, wake, resume };
}

/* ------------------------------------------------------------------ */
/* The full scenario                                                   */
/* ------------------------------------------------------------------ */

/** The ingress outcome of one scenario drive: fresh import or durable replay skip. */
export type WorkshopIngressOutcome =
  | CapsuleIngressResult
  | { readonly imported: true; readonly replayed: true; readonly capsuleRef: string; readonly detail: string };

export interface WorkshopScenarioResult {
  readonly ingress: WorkshopIngressOutcome;
  /** Phase A: capsule -> implementation -> review -> integration (accepted final gate). */
  readonly integration: VerticalRunResult;
  /** The final-gate verdict DECIDED by the declared rules. */
  readonly finalGateVerdict: string;
  /** Phase B: the readiness certification (Elite-2 + D12). */
  readonly certification: CertificationPhaseResult;
  /** Phase C: the idempotent re-drive completing the settlement ladder. */
  readonly completion: VerticalRunResult;
  /** The workshop output mapped from the terminal facts. */
  readonly verifiedBundle: { readonly mapped: true; readonly value: VerifiedBundle; readonly digest: string } | MappingRefusal;
  /** Every terminal proof kind issued (cell -> run). */
  readonly terminalProofs: readonly string[];
  /** True iff lifecycleRun.verifyTerminalClaims committed its ExecutableVerifierResult evidence (D4 certifier). */
  readonly claimsVerified: boolean;
  readonly blockedAt: string | undefined;
}

/**
 * Drive the complete Development workshop scenario. Stateless over durable
 * facts: every phase checks its own postcondition, so a re-drive after any
 * crash converges (the completion phase IS such a re-drive).
 */
export async function runDevelopmentWorkshopScenario(
  config: DevelopmentVerticalConfig,
  options: WorkshopScenarioOptions,
): Promise<WorkshopScenarioResult> {
  // --- ingress (the one public capsule ingress; idempotent over the durable key) ---
  const ingressKey = `capsule-ingress:${options.capsule.capsuleRef}`;
  const alreadyIngressed = worldOf(config.session).idempotency.has(ingressKey);
  const ingress: WorkshopIngressOutcome = alreadyIngressed
    ? { imported: true, replayed: true, capsuleRef: options.capsule.capsuleRef, detail: 'the capsule is already imported in this run world (durable idempotency key); the fresh-run ingress law forbids a second import' }
    : ingestCapsule(config.session, options.capsule, options.packageBytes, options.lineage);
  if ('refused' in ingress) {
    throw new Error(`WORKSHOP_INGRESS_REFUSED: ${ingress.reason}: ${ingress.detail}`);
  }

  // --- the final-gate machine checks over the real product verification ---
  const verification = await config.verifyProduct();
  const checks: readonly CheckResult[] = options.finalGateChecks ?? [
    { checkId: 'development.check.verification-evidence', outcome: verification.ok ? 'pass' : 'fail' },
    { checkId: 'development.check.verdict-monotonicity', outcome: 'pass' },
  ];
  const finalDecision = finalGateDecision(
    checks.find((check) => check.checkId === 'development.check.verification-evidence')?.outcome === 'pass',
    checks.find((check) => check.checkId === 'development.check.verdict-monotonicity')?.outcome !== 'fail',
  );
  if (!('decided' in finalDecision)) {
    throw new Error(`WORKSHOP_FINAL_GATE_UNDECIDED: ${JSON.stringify(finalDecision)}`);
  }
  const finalGateVerdict = finalDecision.verdict;

  // The WP-08 vertical accepts accepted / upstream-repair / human-wait
  // final verdicts; repair and terminal-reject end the material loop before
  // integration and are reported as a blocked scenario (fail-closed).
  const integration: VerticalRunResult = (finalGateVerdict === 'accepted' || finalGateVerdict === 'upstream-repair' || finalGateVerdict === 'human-wait')
    ? await driveDevelopmentVertical(config, {
        authorScript: options.authorScript,
        reviewerScript: options.reviewerScript,
        finalGateVerdict,
        stopAfter: 'final-gate',
      })
    : { steps: [{ step: 'final-gate', result: { status: 'acceptance-refused', reason: 'WORKSHOP_GATE_VERDICT', detail: `the declared final-gate rules decided ${finalGateVerdict}; the material loop ends before integration` } }], blockedAt: 'final-gate' };
  const blockedA = integration.steps.find((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
  if (blockedA !== undefined || finalGateVerdict !== 'accepted') {
    return {
      ingress, integration, finalGateVerdict,
      certification: unavailableCertification(`the integration phase did not reach an accepted final gate (verdict ${finalGateVerdict}, blocked at ${String(blockedA?.step)})`),
      completion: { steps: [], blockedAt: 'integration' },
      verifiedBundle: { refused: true, code: 'ACTOR_PRODUCED_NO_PRODUCT', detail: 'no verified bundle without an accepted integration' },
      terminalProofs: [],
      claimsVerified: false,
      blockedAt: blockedA?.step ?? 'final-gate',
    };
  }

  // --- phase B: the readiness certification (Elite-2 + D12 public path) ---
  const certification = await certifyReadiness(config, options);
  if (certification.settle.status === 'refused' || certification.wake.status === 'refused' || certification.resume.status === 'refused') {
    return {
      ingress, integration, finalGateVerdict, certification,
      completion: { steps: [], blockedAt: 'certification' },
      verifiedBundle: { refused: true, code: 'ACTOR_PRODUCED_NO_PRODUCT', detail: 'no verified bundle without a discharged readiness certification' },
      terminalProofs: [],
      claimsVerified: false,
      blockedAt: 'certification',
    };
  }

  // --- phase C: the idempotent re-drive completes the ladder to the run proof ---
  const completion = await driveDevelopmentVertical(config, {
    authorScript: options.authorScript,
    reviewerScript: options.reviewerScript,
  });

  // --- the workshop output from the terminal facts ---
  const world = worldOf(config.session);
  const terminalProofs = world.proofs.map((proof) => proof.id);
  const acceptanceDigest = evidenceDigestOf(config.session, 'CellFinalAcceptance') ?? '';
  const claimCoverageRefs = world.evidence
    .filter((fact) => fact.kind === 'TerminalClaimCoverage' || fact.kind === 'TerminalLifecycleClaim')
    .map((fact) => fact.ref);
  const verifiedBundle = toVerifiedBundle({
    capsuleRef: options.capsule.capsuleRef,
    workplaceInstanceId: INSTANCES.workplace,
    acceptanceDigest: acceptanceDigest.replace(/^sha256:/, ''),
    terminalProofs,
    claimCoverageRefs,
    runTerminalOutcome: world.heads.get(INSTANCES.factory)?.terminal === 'TerminalProof:run.success' ? 'success' : 'not-terminal',
  });
  const claimsVerified = world.evidence.some((fact) => fact.kind === 'ExecutableVerifierResult');
  const blockedC = completion.steps.find((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
  return {
    ingress, integration, finalGateVerdict, certification, completion, verifiedBundle,
    terminalProofs, claimsVerified,
    blockedAt: blockedC?.step,
  };
}

function unavailableCertification(detail: string): CertificationPhaseResult {
  const refusal: TypedRefusal = { refused: true, reason: 'ILLEGAL_TRANSITION', detail };
  return {
    machineObservation: { ok: false, detail, digest: '0'.repeat(64) },
    gate: { refused: true, code: 'GATE_RULES_CANNOT_DECIDE', detail },
    settle: { status: 'refused', claim: undefined as unknown as CertificationPhaseResult['settle']['claim'], refusal, fenceLost: false },
    readinessManifest: { refused: true, code: 'EMPTY_SCOPE_IS_NOT_A_PRODUCT', detail },
    disposition: buildOperatorDisposition({ operatorId: 'unavailable', readinessManifestDigest: '0'.repeat(64), decision: 'readiness-rejected', note: detail }),
    wake: { status: 'refused', refusal },
    resume: { status: 'refused', claim: undefined as unknown as CertificationPhaseResult['resume']['claim'], refusal, fenceLost: false },
  };
}

/** Convenience re-export for callers staging phases manually. */
export { driveDevelopmentVertical };
