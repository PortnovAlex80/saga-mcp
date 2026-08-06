/**
 * GateRun driver — orchestrates the full Production Cell gate lifecycle for
 * one CandidateSet.
 *
 * Sequence (REG-15 GateRun lifecycle):
 *   1. createGateRun(claimed) — claim the gate authority for this workplace
 *   2. setGateRunState(checking) — begin running checks
 *   3. For each CheckPlanEntry: provider.run(candidate) → recordCheckReceipt
 *   4. setGateRunState(decided) — checks complete, reducing to a verdict
 *   5. recordDecision(GateDecision) — the immutable act of OTK
 *   6. setGateRunState(terminal) — gate complete
 *
 * The driver is pure with respect to Workplace/Flow state — it only calls
 * the GateRepository methods. The resulting GateDecision is returned to the
 * caller, which applies it to the Workplace via the coordinator/runtime.
 *
 * Decision policy: for the first slice, a simple fail-closed reducer:
 *   - Any receipt 'failed' → verdict 'repair_required'
 *   - Any receipt 'unknown' or 'error' → verdict 'repair_required' (fail-closed)
 *   - All receipts 'passed' → verdict 'accepted'
 *
 * Future: a real DecisionPolicyReducer will replace this inline logic,
 * incorporating criticality classification and DegradationAuthorization.
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

/**
 * Minimal port interface for the gate repository methods the driver needs.
 * This is satisfied by SqliteGateRepository. Defined as a structural port to
 * keep the driver testable without the concrete SQLite adapter.
 */
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

/**
 * Registry of CheckProviders, keyed by providerId. The driver resolves each
 * CheckPlanEntry's provider from this registry.
 */
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
  /**
   * Parameters passed to every check provider. Typically includes the SRS
   * artifact ref so the provider can read the content.
   */
  readonly checkParameters: Readonly<Record<string, unknown>>;
  readonly environmentRef: string | null;
}

export interface DriveGateRunResult {
  readonly decision: GateDecision;
  readonly receipts: readonly CheckReceipt[];
}

/**
 * Drive a GateRun end-to-end: claim → check → decide → terminal.
 *
 * Returns the recorded GateDecision and all CheckReceipts. The caller is
 * responsible for applying the decision to the Workplace (via the coordinator
 * or ConveyorRuntime.applyGateDecision).
 */
export function driveGateRun(
  repo: GateRunDriverRepo,
  providers: CheckProviderRegistry,
  input: DriveGateRunInput,
): DriveGateRunResult {
  const gateRunRef = `gate-run:${input.subjectCandidateSetRef}:${input.checkPlan.checkPlanDigest}`;

  // 1. Claim the gate.
  repo.createGateRun({
    gateRunRef,
    workplaceRef: input.workplaceRef,
    gatePhase: input.gatePhase,
    subjectCandidateSetRef: input.subjectCandidateSetRef,
    assessmentCandidateSetRefs: input.assessmentCandidateSetRefs ?? [],
    checkPlanRef: input.checkPlan.checkPlanId,
    checkPlanDigest: input.checkPlan.checkPlanDigest,
    expectedWorkplaceRevision: input.expectedWorkplaceRevision,
    gateLeaseRef: input.gateLeaseRef,
  });

  // 2. Begin checking.
  repo.setGateRunState(gateRunRef, 'checking');

  // 3. Run each check and record receipts.
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
      parameters: { ...input.checkParameters, ...entry.parameters },
      environmentRef: entry.environmentRef ?? input.environmentRef,
      candidateSnapshot: {},
    });
    const checkReceiptRef = `receipt:${gateRunRef}:${entry.check.providerId}`;
    const receipt: CheckReceipt = {
      checkReceiptRef,
      checkRunRef: gateRunRef,
      subjectCandidateSetRef: input.subjectCandidateSetRef,
      assessmentCandidateSetRefs: input.assessmentCandidateSetRefs ?? [],
      check: entry.check,
      environmentRef: entry.environmentRef ?? input.environmentRef,
      outcome: outcome as CheckOutcome,
      evidenceRefs: [],
      receiptDigest: hashReceipt(checkReceiptRef, entry.check, outcome as CheckOutcome),
    };
    repo.recordCheckReceipt(receipt);
    receipts.push(receipt);
  }

  // 4. Reduce receipts to a verdict (fail-closed decision policy).
  const verdict = reduceReceipts(receipts, input.checkPlan.unknownErrorPolicy);

  // 5. Record the GateDecision.
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
    assessmentCandidateSetRefs: input.assessmentCandidateSetRefs ?? [],
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

  // 6. Terminal.
  repo.setGateRunState(gateRunRef, 'terminal');

  return { decision: recorded.decision, receipts };
}

/**
 * Fail-closed decision policy reducer.
 *
 *   - Any 'failed' → repair_required
 *   - Any 'unknown'/'error' → repair_required (fail-closed unless policy says safe)
 *   - All 'passed' → accepted
 *
 * When unknownErrorPolicy is 'fail-open-safe', unknown/error outcomes do NOT
 * block acceptance (used for advisory checks). The default is 'fail-closed'.
 */
function reduceReceipts(
  receipts: readonly CheckReceipt[],
  unknownErrorPolicy: 'fail-closed' | 'fail-open-safe',
): GateVerdict {
  for (const receipt of receipts) {
    if (receipt.outcome === 'failed') {
      return 'repair_required';
    }
    if (
      (receipt.outcome === 'unknown' || receipt.outcome === 'error')
      && unknownErrorPolicy === 'fail-closed'
    ) {
      return 'repair_required';
    }
  }
  return 'accepted';
}

function hashReceipt(ref: string, check: { readonly providerId: string; readonly version: string; readonly providerDigest: string }, outcome: CheckOutcome): string {
  return createHash('sha256')
    .update(JSON.stringify({ ref, check, outcome }))
    .digest('hex');
}

function hashDecision(key: string, verdict: GateVerdict, receipts: readonly CheckReceipt[]): string {
  return createHash('sha256')
    .update(JSON.stringify({
      key,
      verdict,
      receiptRefs: receipts.map(r => r.checkReceiptRef),
    }))
    .digest('hex');
}
