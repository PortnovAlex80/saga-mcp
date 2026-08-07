/**
 * GateRun driver — orchestrates one immutable quality inspection.
 */

import { createHash } from 'node:crypto';
import type {
  CheckPlan,
  CheckProvider,
  CheckReceipt,
  CheckOutcome,
  GateDecision,
  GateVerdict,
} from '../domain/workplace/gate.js';
import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';

export interface GateRunDriverRepo {
  createGateRun(input: {
    readonly gateRunRef: string;
    readonly workplaceRef: WorkplaceRef;
    readonly gatePhase: 'author' | 'final';
    readonly subjectCandidateSetRef: string;
    readonly assessmentCandidateSetRefs: readonly string[];
    readonly checkPlanRef: string;
    readonly checkPlanDigest: string;
    readonly expectedWorkplaceRevision: number;
    readonly gateLeaseRef: string;
  }): unknown;
  setGateRunState(gateRunRef: string, state: 'claimed' | 'checking' | 'decided' | 'terminal'): void;
  recordCheckReceipt(input: Omit<CheckReceipt, 'checkReceiptRef'> & { readonly checkReceiptRef: string }): CheckReceipt;
  recordDecision(decision: GateDecision): { readonly decision: GateDecision; readonly replayed: boolean };
}

export interface CheckProviderRegistry {
  resolve(providerId: string): CheckProvider | null;
}

export interface DriveGateRunInput {
  readonly workplaceRef: WorkplaceRef;
  readonly subjectCandidateSetRef: string;
  readonly assessmentCandidateSetRefs?: readonly string[];
  readonly checkPlan: CheckPlan;
  readonly gatePhase: 'author' | 'final';
  readonly expectedWorkplaceRevision: number;
  readonly gateLeaseRef: string;
  readonly installationDigest: string;
  readonly checkParameters: Readonly<Record<string, unknown>>;
  readonly environmentRef: string | null;
}

export interface DriveGateRunResult {
  readonly decision: GateDecision;
  readonly receipts: readonly CheckReceipt[];
}

export function driveGateRun(
  repo: GateRunDriverRepo,
  providers: CheckProviderRegistry,
  input: DriveGateRunInput,
): DriveGateRunResult {
  const assessmentCandidateSetRefs = input.assessmentCandidateSetRefs ?? [];
  const gateRunRef =
    `gate-run:${input.subjectCandidateSetRef}:${input.checkPlan.checkPlanDigest}`;

  repo.createGateRun({
    gateRunRef,
    workplaceRef: input.workplaceRef,
    gatePhase: input.gatePhase,
    subjectCandidateSetRef: input.subjectCandidateSetRef,
    assessmentCandidateSetRefs,
    checkPlanRef: input.checkPlan.checkPlanId,
    checkPlanDigest: input.checkPlan.checkPlanDigest,
    expectedWorkplaceRevision: input.expectedWorkplaceRevision,
    gateLeaseRef: input.gateLeaseRef,
  });
  repo.setGateRunState(gateRunRef, 'checking');

  const receipts: CheckReceipt[] = [];
  for (const entry of input.checkPlan.entries) {
    const provider = providers.resolve(entry.check.providerId);
    if (!provider) {
      throw new Error(
        `CHECK_PROVIDER_MISSING: ${entry.check.providerId} not registered`,
      );
    }
    if (provider.version !== entry.check.version) {
      throw new Error(
        `CHECK_PROVIDER_VERSION_MISMATCH: expected ${entry.check.version}, got ${provider.version}`,
      );
    }
    const outcome = provider.run({
      subjectCandidateSetRef: input.subjectCandidateSetRef,
      parameters: {
        ...input.checkParameters,
        ...entry.parameters,
        // Final-gate providers (review verdicts, comparison/consistency checks)
        // receive the exact immutable assessment sets. The core does not
        // interpret them and there is no latest/task fallback.
        assessmentCandidateSetRefs,
      },
      environmentRef: entry.environmentRef ?? input.environmentRef,
      candidateSnapshot: {},
    });
    if (outcome instanceof Promise) {
      throw new Error(
        `ASYNC_CHECK_PROVIDER_UNSUPPORTED: ${entry.check.providerId}; `
          + 'GateRun is currently synchronous',
      );
    }
    const checkReceiptRef = `receipt:${gateRunRef}:${entry.check.providerId}`;
    const receipt: CheckReceipt = {
      checkReceiptRef,
      checkRunRef: gateRunRef,
      subjectCandidateSetRef: input.subjectCandidateSetRef,
      assessmentCandidateSetRefs,
      check: entry.check,
      environmentRef: entry.environmentRef ?? input.environmentRef,
      outcome,
      evidenceRefs: [],
      receiptDigest: hashReceipt(checkReceiptRef, entry.check, outcome),
    };
    repo.recordCheckReceipt(receipt);
    receipts.push(receipt);
  }

  const verdict = reduceReceipts(receipts, input.checkPlan.unknownErrorPolicy);

  repo.setGateRunState(gateRunRef, 'decided');
  const decisionKey = `decision:${gateRunRef}`;
  const transitionRef = `transition:${decisionKey}`;
  const decision: GateDecision = {
    gateRef: `gate:${input.workplaceRef.processRunId}:${input.gatePhase}`,
    gateRunRef,
    gatePhase: input.gatePhase,
    workplaceRef: input.workplaceRef,
    transitionRef,
    subjectCandidateSetRef: input.subjectCandidateSetRef,
    assessmentCandidateSetRefs,
    verdict,
    repairTargetRole: verdict === 'repair_required' ? 'author' : null,
    checkPlanRef: input.checkPlan.checkPlanId,
    checkPlanDigest: input.checkPlan.checkPlanDigest,
    decisionPolicyRef: input.checkPlan.decisionPolicyRef,
    decisionPolicyDigest: input.checkPlan.decisionPolicyDigest,
    checkReceiptRefs: receipts.map(r => r.checkReceiptRef),
    installationDigest: input.installationDigest,
    decisionKey,
    acceptedOutputBindings: [],
    recoveryIssueRef: verdict === 'repair_required' ? `recovery:${decisionKey}` : null,
    decisionDigest: hashDecision(decisionKey, verdict, receipts),
  };
  const recorded = repo.recordDecision(decision);
  repo.setGateRunState(gateRunRef, 'terminal');
  return { decision: recorded.decision, receipts };
}

function reduceReceipts(
  receipts: readonly CheckReceipt[],
  unknownErrorPolicy: 'fail-closed' | 'fail-open-safe',
): GateVerdict {
  for (const receipt of receipts) {
    if (receipt.outcome === 'failed') return 'repair_required';
    if (
      (receipt.outcome === 'unknown' || receipt.outcome === 'error')
      && unknownErrorPolicy === 'fail-closed'
    ) {
      return 'repair_required';
    }
  }
  return 'accepted';
}

function hashReceipt(
  ref: string,
  check: {
    readonly providerId: string;
    readonly version: string;
    readonly providerDigest: string;
  },
  outcome: CheckOutcome,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ ref, check, outcome }))
    .digest('hex');
}

function hashDecision(
  key: string,
  verdict: GateVerdict,
  receipts: readonly CheckReceipt[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      key,
      verdict,
      receiptRefs: receipts.map(r => r.checkReceiptRef),
    }))
    .digest('hex');
}
