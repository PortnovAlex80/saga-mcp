/**
 * GateRun driver — orchestrates one immutable quality inspection.
 */

import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  AcceptedOutputBinding,
  CheckPlan,
  CheckProvider,
  CheckReceipt,
  CheckOutcome,
  GateDecision,
  GateVerdict,
  RepairTargetRole,
} from '../domain/workplace/gate.js';
import { computeCheckPlanDigest } from '../domain/workplace/gate.js';
import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../domain/workplace/workplace-ref.js';
import { decodeCheckDiagnostic } from '../domain/workplace/check-diagnostic.js';

/**
 * BLINDSIGHT C1 — the read-only rejection-history view delivered to every
 * check provider inside `candidateSnapshot`. The durable history (the
 * finding-trajectory chain and the provider's own prior receipts) is already
 * WRITTEN at decision time; this type is its DELIVERY to the point where the
 * next outcome is decided, so a provider can recognize a returning finding
 * key set instead of re-judging every submission in isolation.
 */
export interface TrajectoryTailSnapshot {
  readonly gateRef: string;
  readonly checkPlanDigest: string;
  /** Same-scope chain sets, OLDEST first (capped to the last 8). */
  readonly sets: readonly {
    readonly digest: string;
    readonly count: number;
    readonly keys: readonly string[];
    readonly fatalKeys: readonly string[];
  }[];
}

/** One prior receipt of THIS provider on the same workplace (newest first). */
export interface CheckProviderHistoryEntry {
  readonly checkReceiptRef: string;
  readonly checkRunRef: string;
  readonly subjectCandidateSetRef: string;
  readonly outcome: CheckOutcome;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

export interface GateCandidateHistoryContext {
  readonly findingTrajectoryTails: {
    readonly author: TrajectoryTailSnapshot | null;
    readonly reviewer: TrajectoryTailSnapshot | null;
  };
  readonly providerHistory: readonly CheckProviderHistoryEntry[];
}

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
  recordGatePresentation(gateRunRef: string, presentationRef: string): void;
  setGateRunState(gateRunRef: string, state: 'claimed' | 'checking' | 'decided' | 'terminal'): void;
  recordCheckReceipt(input: Omit<CheckReceipt, 'checkReceiptRef'> & { readonly checkReceiptRef: string }): CheckReceipt;
  recordDecision(decision: GateDecision): { readonly decision: GateDecision; readonly replayed: boolean };
  /**
   * ADR-053 C12 — read the persisted terminal decision + its receipts for an
   * exact GateRun, or null when the run is absent / not yet terminal. Used by
   * the driver to make a GateRun ONE-SHOT: a replay of the same identity returns
   * the persisted decision without re-running providers or regressing state.
   */
  readTerminalDecisionForGateRun(gateRunRef: string): { readonly decision: GateDecision; readonly receipts: readonly CheckReceipt[] } | null;
  /**
   * BLINDSIGHT C1 — read the durable rejection history of the workplace
   * (finding-trajectory chain tails per repair-target role + the prior
   * receipts of one exact provider) for delivery to the check providers via
   * `candidateSnapshot`. Optional: a repo without durable history keeps the
   * legacy blind `{}` snapshot (never fabricated data). Read-only: the result
   * is a delivery view and never enters the GateRun identity.
   */
  readCandidateHistoryContext?(input: {
    readonly workplaceRef: WorkplaceRef;
    readonly providerId: string;
    readonly providerVersion: string;
  }): GateCandidateHistoryContext | null;
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
  /** Audit-only current presentation; excluded from GateRun identity. */
  readonly presentationRef: string;
  /** Exact downstream material selected before the Gate runs. */
  readonly acceptedOutputBindings?: readonly AcceptedOutputBinding[];
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
  const actualCheckPlanDigest = computeCheckPlanDigest(input.checkPlan);
  if (actualCheckPlanDigest !== input.checkPlan.checkPlanDigest) {
    throw new Error(
      `CHECK_PLAN_DIGEST_MISMATCH: declared ${input.checkPlan.checkPlanDigest}, actual ${actualCheckPlanDigest}`,
    );
  }
  const assessmentCandidateSetRefs = input.assessmentCandidateSetRefs ?? [];
  const effectiveCheckInputs = input.checkPlan.entries.map(entry => ({
    parameters: {
      ...input.checkParameters,
      ...entry.parameters,
      assessmentCandidateSetRefs,
    },
    environmentRef: entry.environmentRef ?? input.environmentRef,
  }));
  // ADR-053 C9 — the GateRun identity pins the INSTALLED package
  // (installationDigest) and the exact Workplace revision the gate ran against
  // (expectedWorkplaceRevision), in addition to the subject/assessment/checkPlan
  // inputs. Without these, swapping a handler/provider package or re-running
  // against a newer Workplace revision could reuse a stale GateRun/Decision
  // under the same key.
  const gateRunIdentity = sha256Hex({
    gatePhase: input.gatePhase,
    subjectCandidateSetRef: input.subjectCandidateSetRef,
    assessmentCandidateSetRefs,
    checkPlanDigest: input.checkPlan.checkPlanDigest,
    installationDigest: input.installationDigest,
    expectedWorkplaceRevision: input.expectedWorkplaceRevision,
    acceptedOutputBindings: input.acceptedOutputBindings ?? [],
    effectiveCheckInputs,
  });
  const gateRunRef = `gate-run:${gateRunIdentity}`;
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
  repo.recordGatePresentation(gateRunRef, input.presentationRef);

  // ADR-053 C12 — a GateRun is a ONE-SHOT immutable inspection. If a terminal
  // decision already exists for this exact identity, return the persisted
  // decision + receipts WITHOUT re-running providers or regressing the GateRun
  // state (terminal → checking). Re-invoking checks on replay would repeat
  // potentially nondeterministic / external inspections and could diverge from
  // the original decision.
  const replayed = repo.readTerminalDecisionForGateRun(gateRunRef);
  if (replayed) {
    return { decision: replayed.decision, receipts: replayed.receipts };
  }

  repo.setGateRunState(gateRunRef, 'checking');

  const receipts: CheckReceipt[] = [];
  for (let entryIndex = 0; entryIndex < input.checkPlan.entries.length; entryIndex += 1) {
    const entry = input.checkPlan.entries[entryIndex]!;
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
    // ADR-053 C10 — verify the INSTALLED provider's implementation digest matches
    // the CheckPlan's pinned digest, so a swapped or mismatched implementation
    // cannot run checks under a plan that pinned a different implementation
    // (version match alone is insufficient — two builds can share a version).
    if (provider.providerDigest !== entry.check.providerDigest) {
      throw new Error(
        `CHECK_PROVIDER_DIGEST_MISMATCH: ${entry.check.providerId} expected digest `
          + `'${entry.check.providerDigest}', got '${provider.providerDigest}'`,
      );
    }
    const effectiveInput = effectiveCheckInputs[entryIndex]!;
    // BLINDSIGHT C1 — deliver the durable rejection history to the decision
    // point: the finding-trajectory chain tail (previous finding key sets of
    // this workplace) plus this provider's own prior receipts. Read AFTER the
    // C12 terminal-replay check, so a replayed one-shot GateRun does not
    // re-read history (the persisted decision is authority); read-only — the
    // snapshot never enters gateRunIdentity/receiptDigest by construction.
    const history = repo.readCandidateHistoryContext?.({
      workplaceRef: input.workplaceRef,
      providerId: entry.check.providerId,
      providerVersion: entry.check.version,
    }) ?? null;
    const candidateSnapshot: Readonly<Record<string, unknown>> = history === null
      ? {}
      : {
          subjectCandidateSetRef: input.subjectCandidateSetRef,
          workplaceRef: serializeWorkplaceRef(input.workplaceRef),
          findingTrajectoryTails: history.findingTrajectoryTails,
          providerHistory: history.providerHistory,
        };
    const providerResult = provider.run({
      subjectCandidateSetRef: input.subjectCandidateSetRef,
      parameters: effectiveInput.parameters,
      environmentRef: effectiveInput.environmentRef,
      candidateSnapshot,
    });
    if (providerResult instanceof Promise) {
      throw new Error(
        `ASYNC_CHECK_PROVIDER_UNSUPPORTED: ${entry.check.providerId}; `
          + 'GateRun is currently synchronous',
      );
    }
    const outcome = typeof providerResult === 'string'
      ? providerResult
      : providerResult.outcome;
    const evidenceRefs = typeof providerResult === 'string'
      ? []
      : [...providerResult.evidenceRefs];
    // ADR-053 C11 — include the entry ORDINAL in the receipt ref so two entries
    // of the same provider (different parameters/environment) get distinct
    // receipt keys instead of colliding on `receipt:${gateRunRef}:${providerId}`.
    const checkReceiptRef = `receipt:${gateRunRef}:${entryIndex}:${entry.check.providerId}`;
    const receipt: CheckReceipt = {
      checkReceiptRef,
      checkRunRef: gateRunRef,
      subjectCandidateSetRef: input.subjectCandidateSetRef,
      assessmentCandidateSetRefs,
      check: entry.check,
      environmentRef: entry.environmentRef ?? input.environmentRef,
      outcome,
      evidenceRefs,
      receiptDigest: hashReceipt(
        checkReceiptRef,
        gateRunRef,
        input.subjectCandidateSetRef,
      assessmentCandidateSetRefs,
      entry.check,
      effectiveInput.environmentRef,
      sha256Hex(effectiveInput.parameters),
      outcome,
      evidenceRefs,
      ),
    };
    repo.recordCheckReceipt(receipt);
    receipts.push(receipt);
  }

  const reduction = reduceReceipts(receipts, input.checkPlan);
  const verdict = reduction.verdict;

  repo.setGateRunState(gateRunRef, 'decided');
  const decisionKey = `decision:${gateRunRef}`;
  const transitionRef = `transition:${decisionKey}`;
  // ADR-053 C13 — the decision digest covers the FULL canonical decision body
  // (everything except decisionDigest itself), so any drift in workplace / gate
  // phase / subject / assessment sets / plan+policy digests / installation /
  // receipts / output bindings / recovery produces a different digest. The
  // previous partial digest (key+verdict+repairTarget+receiptRefs) could not
  // distinguish decisions that differed in bound material or pinned package.
  const decisionBody = {
    gateRef: `gate:${input.workplaceRef.processRunId}:${input.gatePhase}`,
    gateRunRef,
    gatePhase: input.gatePhase,
    workplaceRef: input.workplaceRef,
    transitionRef,
    subjectCandidateSetRef: input.subjectCandidateSetRef,
    assessmentCandidateSetRefs,
    verdict,
    repairTargetRole: reduction.repairTargetRole,
    checkPlanRef: input.checkPlan.checkPlanId,
    checkPlanDigest: input.checkPlan.checkPlanDigest,
    decisionPolicyRef: input.checkPlan.decisionPolicyRef,
    decisionPolicyDigest: input.checkPlan.decisionPolicyDigest,
    checkReceiptRefs: receipts.map(r => r.checkReceiptRef),
    installationDigest: input.installationDigest,
    decisionKey,
    acceptedOutputBindings: verdict === 'accepted' && input.gatePhase === 'final'
      ? (input.acceptedOutputBindings ?? [])
      : [],
    recoveryIssueRef: verdict === 'repair_required' ? `recovery:${decisionKey}` : null,
  };
  const decision: GateDecision = {
    ...decisionBody,
    decisionDigest: sha256Hex(decisionBody),
  };
  const recorded = repo.recordDecision(decision);
  repo.setGateRunState(gateRunRef, 'terminal');
  return { decision: recorded.decision, receipts };
}

function reduceReceipts(
  receipts: readonly CheckReceipt[],
  checkPlan: CheckPlan,
): { verdict: GateVerdict; repairTargetRole: RepairTargetRole | null } {
  let target: RepairTargetRole | null = null;
  let repairRequired = false;

  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    const entry = checkPlan.entries[index];
    if (!entry) {
      throw new Error(`CHECK_PLAN_RECEIPT_MISMATCH: receipt ${index} has no plan entry`);
    }

    let requestedTarget: RepairTargetRole | null = null;
    if (receipt.outcome === 'failed') {
      // Escalation (upstream ownership): a deterministic failure whose SUBJECT
      // is a frozen upstream artifact (e.g. the integrated release candidate)
      // is a producer defect. No workplace-local repair can fix it, so the
      // verdict is 'failed' — the cell terminates and the conveyor's
      // continuation machinery re-routes the defect to the producing
      // workshop. This must not burn the local repair budget on impossible
      // probe rewrites.
      if (entry.failureOwnership === 'upstream') {
        return { verdict: 'failed', repairTargetRole: null };
      }
      // CODE-SCOPED upstream ownership: the same escalation, selected by the
      // TYPED diagnostic codes of this one receipt rather than by the whole
      // entry. A mixed provider (workplace-local plan errors AND
      // plan-independent frozen-upstream defects) declares the upstream-owned
      // code set on the plan entry; only a receipt that actually carries one
      // of those codes escalates. Every other failure code — and any receipt
      // without a decodable diagnostic — keeps workplace-local repair
      // routing, so genuine local errors are never misrouted to the
      // producing workshop.
      if (hasUpstreamOwnedFailureCode(receipt, entry)) {
        return { verdict: 'failed', repairTargetRole: null };
      }
      requestedTarget = entry.repairTargetRoleOnFailure ?? 'author';
    } else if (
      (receipt.outcome === 'unknown' || receipt.outcome === 'error')
      && checkPlan.unknownErrorPolicy === 'fail-closed'
    ) {
      if (entry.indeterminateDisposition === 'human-required') {
        return { verdict: 'human_required', repairTargetRole: null };
      }
      // An indeterminate upstream-owned check still needs a local retry
      // (the substrate may be at fault), so it keeps the repair routing.
      requestedTarget = entry.repairTargetRoleOnIndeterminate
        ?? entry.repairTargetRoleOnFailure
        ?? 'author';
    }

    if (requestedTarget === null) continue;
    repairRequired = true;
    if (target !== null && target !== requestedTarget) {
      // Two checks disagree about who owns the repair. The Factory must not
      // guess; stop the line for explicit resolution.
      return { verdict: 'human_required', repairTargetRole: null };
    }
    target = requestedTarget;
  }

  if (repairRequired) {
    return { verdict: 'repair_required', repairTargetRole: target ?? 'author' };
  }
  return { verdict: 'accepted', repairTargetRole: null };
}

function hasUpstreamOwnedFailureCode(
  receipt: CheckReceipt,
  entry: { readonly upstreamOwnedFailureCodes?: readonly string[] },
): boolean {
  const codes = entry.upstreamOwnedFailureCodes;
  if (codes === undefined || codes.length === 0) return false;
  return receipt.evidenceRefs.some(ref => {
    const diagnostic = decodeCheckDiagnostic(ref);
    return diagnostic !== null && codes.includes(diagnostic.code);
  });
}

function hashReceipt(
  ref: string,
  checkRunRef: string,
  subjectCandidateSetRef: string,
  assessmentCandidateSetRefs: readonly string[],
  check: {
    readonly providerId: string;
    readonly version: string;
    readonly providerDigest: string;
  },
  environmentRef: string | null,
  parametersDigest: string,
  outcome: CheckOutcome,
  evidenceRefs: readonly string[],
): string {
  return sha256Hex({
    ref,
    checkRunRef,
    subjectCandidateSetRef,
    assessmentCandidateSetRefs,
    check,
    environmentRef,
    parametersDigest,
    outcome,
    evidenceRefs,
  });
}

