/**
 * workflow-kernel/domain/universe.ts - the frozen EK-1 transition universe as
 * the kernel's executable vocabulary registry (WP-05).
 *
 * SOURCE OF TRUTH: docs/refactoring/event-kernel/reconciliation/transition-universe.json
 * (frozen at the EK-1 admission; 9 aggregates + 4 non-aggregate authorities,
 * 53 commands, 52 event kinds, 49 obligation kinds, 5 wait kinds, 28 terminal
 * proofs, 67 evidence kinds - protocol decisions D1-D12 applied).
 *
 * This file is a faithful, hand-frozen transcription; it is NOT generated at
 * build time. tests/workflow-kernel/model/universe-registry.test.mjs pins it
 * to the frozen JSON by deep equality on every collection, so any drift is a
 * blocking test failure. Editing the vocabulary here without an approved
 * complexity delta is the mutation "transition universe widened without an
 * approved complexity delta" and turns test:workflow-complexity red.
 *
 * PURITY: no imports at all - this module is pure data.
 */

export const UNIVERSE_SCHEMA_VERSION = "ek.transition-universe.ek1-reconciliation.v1";

/** The 9 owner aggregates of the frozen universe (D1 physical names). */
export const AGGREGATE_NAMES = [
  "FactoryRun",
  "LifecycleRun",
  "StageRun",
  "ProcessRun",
  "NodeRun",
  "Workplace",
  "ActivityAttempt",
  "WorkItem",
  "CognitionTransport"
] as const;
export type AggregateName = (typeof AGGREGATE_NAMES)[number];

/**
 * The 4 non-aggregate authorities, declared as namespaced kind literals -
 * the declaration style frozen by complexity-budget.json
 * (kernelCompositionConvention.nonAggregateAuthorityNames).
 */
export const NON_AGGREGATE_AUTHORITY_KINDS = [
  "authority:Planning",
  "authority:InstalledWorkshopManifest",
  "authority:TargetOwnerCapability",
  "authority:Input"
] as const;
export type NonAggregateAuthorityKind = (typeof NON_AGGREGATE_AUTHORITY_KINDS)[number];

/**
 * The 22 authoritative relation kinds of the plan's Target logical model,
 * declared as namespaced kind literals (kernelCompositionConvention.relationNames).
 */
export const RELATION_KINDS = [
  "relation:ProtocolMetadata",
  "relation:FactoryRun",
  "relation:LifecycleRun",
  "relation:StageRun",
  "relation:ProcessRun",
  "relation:NodeRun",
  "relation:WorkItem",
  "relation:WorkItemDependency",
  "relation:Workplace",
  "relation:WorkIntent",
  "relation:ActivityAttempt",
  "relation:PromptAssemblyReceipt",
  "relation:WorkplaceProductionRevision",
  "relation:CandidateSet",
  "relation:GateDecision",
  "relation:EffectReceipt",
  "relation:CellFinalAcceptance",
  "relation:WorkflowEvent",
  "relation:TransitionObligation",
  "relation:TypedWait",
  "relation:TerminalProof",
  "relation:KanbanCard"
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const COMMAND_NAMES = [
  "factoryRun.bootstrap",
  "factoryRun.importCapsule",
  "factoryRun.start",
  "factoryRun.requestStop",
  "factoryRun.resume",
  "factoryRun.observeWatchdog",
  "factoryRun.recordRunTerminalProof",
  "lifecycleRun.create",
  "lifecycleRun.createContinuation",
  "lifecycleRun.routeOutcome",
  "lifecycleRun.issueTerminalProof",
  "lifecycleRun.cancel",
  "lifecycleRun.verifyTerminalClaims",
  "stageRun.create",
  "stageRun.activate",
  "stageRun.recordLocalOutcome",
  "processRun.create",
  "processRun.enterNode",
  "processRun.recordNodeTerminal",
  "processRun.settle",
  "processRun.settleFailure",
  "nodeRun.create",
  "nodeRun.materializeCell",
  "nodeRun.recordKernelResult",
  "nodeRun.recordCellAcceptance",
  "nodeRun.recordHumanDecision",
  "nodeRun.recordProviderOutcome",
  "nodeRun.settleUnreachable",
  "nodeRun.fail",
  "workItem.planGraph",
  "workplace.materialize",
  "workplace.admitWorkIntent",
  "workplace.recordContribution",
  "workplace.sealProductionRevision",
  "workplace.presentCandidateSet",
  "workplace.runAuthorGate",
  "workplace.runFinalGate",
  "workplace.enterRepairWait",
  "workplace.rolloverRepairEpoch",
  "workplace.widenAuthorityScope",
  "workplace.enterHumanWait",
  "workplace.resolveHumanResponse",
  "workplace.settleEffect",
  "workplace.recordFinalAcceptance",
  "workplace.closePresentation",
  "workplace.issueWorkplaceTerminalProof",
  "activityAttempt.create",
  "activityAttempt.admitProviderRequest",
  "activityAttempt.recordProviderRefusal",
  "activityAttempt.recordOutcome",
  "activityAttempt.classifyWorkerLoss",
  "activityAttempt.cancel",
  "cognition.sendProviderRequest"
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const WORKFLOW_EVENT_KINDS = [
  "WorkflowEvent:activityAttempt.cancelled",
  "WorkflowEvent:activityAttempt.created",
  "WorkflowEvent:activityAttempt.outcomeRecorded",
  "WorkflowEvent:activityAttempt.providerRefusalRecorded",
  "WorkflowEvent:activityAttempt.providerRequestAdmitted",
  "WorkflowEvent:activityAttempt.workerLossClassified",
  "WorkflowEvent:factoryRun.bootstrapped",
  "WorkflowEvent:factoryRun.capsuleImported",
  "WorkflowEvent:factoryRun.resumed",
  "WorkflowEvent:factoryRun.runTerminalProven",
  "WorkflowEvent:factoryRun.started",
  "WorkflowEvent:factoryRun.stopRequested",
  "WorkflowEvent:factoryRun.watchdogObserved",
  "WorkflowEvent:lifecycleRun.cancelled",
  "WorkflowEvent:lifecycleRun.continuationCreated",
  "WorkflowEvent:lifecycleRun.created",
  "WorkflowEvent:lifecycleRun.outcomeRouted",
  "WorkflowEvent:lifecycleRun.terminalClaimsVerified",
  "WorkflowEvent:lifecycleRun.terminalProven",
  "WorkflowEvent:nodeRun.cellAcceptanceRecorded",
  "WorkflowEvent:nodeRun.cellMaterialized",
  "WorkflowEvent:nodeRun.created",
  "WorkflowEvent:nodeRun.failed",
  "WorkflowEvent:nodeRun.humanDecisionRecorded",
  "WorkflowEvent:nodeRun.kernelResultRecorded",
  "WorkflowEvent:nodeRun.providerOutcomeRecorded",
  "WorkflowEvent:nodeRun.unreachableSettled",
  "WorkflowEvent:processRun.created",
  "WorkflowEvent:processRun.nodeEntered",
  "WorkflowEvent:processRun.nodeTerminalRecorded",
  "WorkflowEvent:processRun.settleFailed",
  "WorkflowEvent:processRun.settled",
  "WorkflowEvent:stageRun.activated",
  "WorkflowEvent:stageRun.created",
  "WorkflowEvent:stageRun.localOutcomeRecorded",
  "WorkflowEvent:workItem.graphPlanned",
  "WorkflowEvent:workplace.authorGateDecided",
  "WorkflowEvent:workplace.authorityScopeWidened",
  "WorkflowEvent:workplace.candidateSetPresented",
  "WorkflowEvent:workplace.contributionRecorded",
  "WorkflowEvent:workplace.effectSettled",
  "WorkflowEvent:workplace.finalAcceptanceRecorded",
  "WorkflowEvent:workplace.finalGateDecided",
  "WorkflowEvent:workplace.humanResponseResolved",
  "WorkflowEvent:workplace.humanWaitEntered",
  "WorkflowEvent:workplace.materialized",
  "WorkflowEvent:workplace.presentationClosed",
  "WorkflowEvent:workplace.productionRevisionSealed",
  "WorkflowEvent:workplace.repairEpochRolledOver",
  "WorkflowEvent:workplace.repairWaitEntered",
  "WorkflowEvent:workplace.terminalProven",
  "WorkflowEvent:workplace.workIntentAdmitted"
] as const;
export type WorkflowEventKind = (typeof WORKFLOW_EVENT_KINDS)[number];

export const OBLIGATION_KINDS = [
  "obligation:ingestCapsuleFacts",
  "obligation:bootstrapLifecycleRun",
  "obligation:enterStage.initial-discovery",
  "obligation:enterStage.solution-formalization",
  "obligation:enterStage.solution-development",
  "obligation:enterStage.delivery-release",
  "obligation:enterStage.continuation",
  "obligation:routeLifecycle",
  "obligation:replayCaptureSweep",
  "obligation:bindProcessModule",
  "obligation:enterFirstNode",
  "obligation:materializeWorkplace.production-cell",
  "obligation:materializeWorkplace.workItems-fanout",
  "obligation:materializeWorkplace.verificationItems-fanout",
  "obligation:instantiateDependantWorkplaces",
  "obligation:openUnknownObligation",
  "obligation:launchAdmission",
  "obligation:providerSend",
  "obligation:submitContribution",
  "obligation:sealRevision",
  "obligation:presentCandidates",
  "obligation:runGate.author",
  "obligation:runGate.final",
  "obligation:openReviewerDesk",
  "obligation:runEffects",
  "obligation:routeUpstreamRepair",
  "obligation:requeueRepair",
  "obligation:requeueAfterBackoff",
  "obligation:requeueWidened",
  "obligation:requeueAfterHumanResolution",
  "obligation:resumeEffect",
  "obligation:effectRedrive",
  "obligation:completeCellNode",
  "obligation:closePresentation",
  "obligation:propagateCellFailure",
  "obligation:markDependantsUnreachable",
  "obligation:propagateNodeFailure",
  "obligation:recordStageOutcome",
  "obligation:recordStageOutcome.failed",
  "obligation:advanceProcessFlow",
  "obligation:advanceProcessFlow.settle",
  "obligation:freezeCandidate",
  "obligation:retryAttempt",
  "obligation:publishRelease",
  "obligation:observeRelease",
  "obligation:watchdogRestart",
  "obligation:watchdogBudgetExhausted",
  "obligation:verifyTerminalClaims",
  "obligation:runSettlement"
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export const WAIT_KINDS = [
  "TypedWait:human-input",
  "TypedWait:external-availability",
  "TypedWait:policy-quota",
  "TypedWait:readiness",
  "TypedWait:effect-uncertainty"
] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export const PROOF_KINDS = [
  "TerminalProof:cell.success",
  "TerminalProof:cell.truthful-failure",
  "TerminalProof:cell.cancellation",
  "TerminalProof:cell.unreachable",
  "TerminalProof:workplace.success",
  "TerminalProof:workplace.truthful-failure",
  "TerminalProof:workplace.cancellation",
  "TerminalProof:workplace.unreachable",
  "TerminalProof:node.success",
  "TerminalProof:node.truthful-failure",
  "TerminalProof:node.cancellation",
  "TerminalProof:node.unreachable",
  "TerminalProof:process.success",
  "TerminalProof:process.truthful-failure",
  "TerminalProof:process.cancellation",
  "TerminalProof:process.unreachable",
  "TerminalProof:stage.success",
  "TerminalProof:stage.truthful-failure",
  "TerminalProof:stage.cancellation",
  "TerminalProof:stage.unreachable",
  "TerminalProof:lifecycle.success",
  "TerminalProof:lifecycle.truthful-failure",
  "TerminalProof:lifecycle.cancellation",
  "TerminalProof:lifecycle.unreachable",
  "TerminalProof:run.success",
  "TerminalProof:run.truthful-failure",
  "TerminalProof:run.cancellation",
  "TerminalProof:run.unreachable"
] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

export const EVIDENCE_KINDS = [
  "CellFinalAcceptance",
  "GateDecision:accepted",
  "GateDecision:repair",
  "GateDecision:upstream-repair",
  "GateDecision:human-wait",
  "GateDecision:terminal-reject",
  "CheckPlan",
  "CandidateSet:author",
  "CandidateSet:reviewer",
  "WorkplaceProductionRevision",
  "ActivityAttemptContribution",
  "ActivityAttempt:completed",
  "ActivityAttempt:failed-typed",
  "ActivityAttempt:cancelled",
  "WorkIntent",
  "CanonicalRoleContractBinding",
  "PromptAssemblyReceipt:admitted",
  "PromptAssemblyReceipt:refused",
  "ProviderSendOutcome",
  "ProviderRoutePin",
  "TransitionObligation",
  "ObligationCompletionReceipt",
  "SettlementWorkObligation",
  "TypedWait:human-input",
  "TypedWait:external-availability",
  "TypedWait:policy-quota",
  "TypedWait:readiness",
  "TypedWait:effect-uncertainty",
  "WakeDischarge:human-response-command",
  "WakeDischarge:external-availability-event",
  "WakeDischarge:policy-quota-release",
  "TypedWaitDisposition",
  "OperatorStopCommand",
  "WorkflowEvent",
  "WorkItem",
  "WorkItemDependency",
  "WorkItemObligationMapping",
  "EpicScopeCoverage",
  "DeferredScopeEntry",
  "DiscoveryUnknownObligation",
  "QualitativeRequirementDisposition",
  "TerminalLifecycleClaim",
  "TerminalClaimCoverage",
  "ConstructionSurface",
  "ExecutableVerifierResult",
  "SeamOwnership",
  "EffectReceipt:success",
  "EffectReceipt:already-applied",
  "EffectReceipt:retryable",
  "EffectReceipt:unknown",
  "EffectReceipt:human-wait",
  "EffectReceipt:policy-terminal",
  "EffectReceipt:repair",
  "EffectPolicyRefusal",
  "AcceptedCandidateAuthority",
  "CapsuleIngressReceipt",
  "ProductVerificationEvidence",
  "ProductVerificationFailure",
  "ContextEnvelopeComplianceEvidence",
  "ForwardReverseReconciliationReceipt",
  "TypedRefusalReceipt",
  "InputEvidenceRefs",
  "LifecycleRoutingReceipt",
  "ProcessOutcomeCertificate",
  "RecoveryIssue",
  "RepairTerminalityEvidence",
  "WatchdogObservation"
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** One declared command of the frozen universe (typed transition descriptor). */
export interface CommandDescriptor {
  readonly name: CommandName;
  readonly aggregate: AggregateName;
  readonly emitsEvents: readonly WorkflowEventKind[];
  readonly createsObligations: readonly ObligationKind[];
  readonly waits: readonly WaitKind[];
  /**
   * Proofs the command may issue, in the universe's command-array form.
   * The frozen JSON spells the truthful-failure outcome as `<scope>.failure`
   * inside command arrays while the proof registry spells it
   * `truthful-failure`; normalizeProofId() maps the command form onto the
   * 28-kind registry union.
   */
  readonly proofs: readonly string[];
}

/** Normalize a command-array proof spelling onto the 28-kind union. */
export function normalizeProofId(entry: string): ProofKind {
  const normalized = entry.replace(/\.(success|failure|cancellation|unreachable)$/, (suffix) =>
    suffix === '.failure' ? '.truthful-failure' : suffix,
  );
  if (!(PROOF_KINDS as readonly string[]).includes(normalized)) {
    throw new Error(`UNIVERSE_VIOLATION: proof ${entry} normalizes to unknown kind ${normalized}`);
  }
  return normalized as ProofKind;
}

export const COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "factoryRun.bootstrap",
    aggregate: "FactoryRun",
    emitsEvents: ["WorkflowEvent:factoryRun.bootstrapped"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "factoryRun.importCapsule",
    aggregate: "FactoryRun",
    emitsEvents: ["WorkflowEvent:factoryRun.capsuleImported"],
    createsObligations: ["obligation:ingestCapsuleFacts"],
    waits: [],
    proofs: [],
  },
  {
    name: "factoryRun.start",
    aggregate: "FactoryRun",
    emitsEvents: ["WorkflowEvent:factoryRun.started"],
    createsObligations: ["obligation:bootstrapLifecycleRun"],
    waits: [],
    proofs: [],
  },
  {
    name: "factoryRun.requestStop",
    aggregate: "FactoryRun",
    emitsEvents: ["WorkflowEvent:factoryRun.stopRequested"],
    createsObligations: [],
    waits: ["TypedWait:policy-quota"],
    proofs: [],
  },
  {
    name: "factoryRun.resume",
    aggregate: "FactoryRun",
    emitsEvents: ["WorkflowEvent:factoryRun.resumed"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "factoryRun.observeWatchdog",
    aggregate: "FactoryRun",
    emitsEvents: ["WorkflowEvent:factoryRun.watchdogObserved"],
    createsObligations: ["obligation:watchdogRestart", "obligation:watchdogBudgetExhausted"],
    waits: [],
    proofs: [],
  },
  {
    name: "factoryRun.recordRunTerminalProof",
    aggregate: "FactoryRun",
    emitsEvents: ["WorkflowEvent:factoryRun.runTerminalProven"],
    createsObligations: [],
    waits: [],
    proofs: ["TerminalProof:run.success", "TerminalProof:run.failure", "TerminalProof:run.cancellation", "TerminalProof:run.unreachable"],
  },
  {
    name: "lifecycleRun.create",
    aggregate: "LifecycleRun",
    emitsEvents: ["WorkflowEvent:lifecycleRun.created"],
    createsObligations: ["obligation:enterStage.initial-discovery"],
    waits: [],
    proofs: [],
  },
  {
    name: "lifecycleRun.createContinuation",
    aggregate: "LifecycleRun",
    emitsEvents: ["WorkflowEvent:lifecycleRun.continuationCreated"],
    createsObligations: ["obligation:enterStage.continuation"],
    waits: [],
    proofs: [],
  },
  {
    name: "lifecycleRun.routeOutcome",
    aggregate: "LifecycleRun",
    emitsEvents: ["WorkflowEvent:lifecycleRun.outcomeRouted"],
    createsObligations: ["obligation:enterStage.solution-formalization", "obligation:enterStage.solution-development", "obligation:enterStage.delivery-release", "obligation:verifyTerminalClaims"],
    waits: [],
    proofs: [],
  },
  {
    name: "lifecycleRun.issueTerminalProof",
    aggregate: "LifecycleRun",
    emitsEvents: ["WorkflowEvent:lifecycleRun.terminalProven"],
    createsObligations: ["obligation:runSettlement", "obligation:replayCaptureSweep"],
    waits: [],
    proofs: ["TerminalProof:lifecycle.success", "TerminalProof:lifecycle.failure", "TerminalProof:lifecycle.cancellation", "TerminalProof:lifecycle.unreachable"],
  },
  {
    name: "lifecycleRun.cancel",
    aggregate: "LifecycleRun",
    emitsEvents: ["WorkflowEvent:lifecycleRun.cancelled"],
    createsObligations: [],
    waits: [],
    proofs: ["TerminalProof:lifecycle.cancellation"],
  },
  {
    name: "lifecycleRun.verifyTerminalClaims",
    aggregate: "LifecycleRun",
    emitsEvents: ["WorkflowEvent:lifecycleRun.terminalClaimsVerified"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "stageRun.create",
    aggregate: "StageRun",
    emitsEvents: ["WorkflowEvent:stageRun.created"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "stageRun.activate",
    aggregate: "StageRun",
    emitsEvents: ["WorkflowEvent:stageRun.activated"],
    createsObligations: ["obligation:bindProcessModule"],
    waits: [],
    proofs: [],
  },
  {
    name: "stageRun.recordLocalOutcome",
    aggregate: "StageRun",
    emitsEvents: ["WorkflowEvent:stageRun.localOutcomeRecorded"],
    createsObligations: ["obligation:routeLifecycle"],
    waits: [],
    proofs: ["TerminalProof:stage.success", "TerminalProof:stage.failure", "TerminalProof:stage.cancellation", "TerminalProof:stage.unreachable"],
  },
  {
    name: "processRun.create",
    aggregate: "ProcessRun",
    emitsEvents: ["WorkflowEvent:processRun.created"],
    createsObligations: ["obligation:enterFirstNode"],
    waits: [],
    proofs: [],
  },
  {
    name: "processRun.enterNode",
    aggregate: "ProcessRun",
    emitsEvents: ["WorkflowEvent:processRun.nodeEntered"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "processRun.recordNodeTerminal",
    aggregate: "ProcessRun",
    emitsEvents: ["WorkflowEvent:processRun.nodeTerminalRecorded"],
    createsObligations: ["obligation:advanceProcessFlow", "obligation:advanceProcessFlow.settle", "obligation:freezeCandidate"],
    waits: [],
    proofs: [],
  },
  {
    name: "processRun.settle",
    aggregate: "ProcessRun",
    emitsEvents: ["WorkflowEvent:processRun.settled"],
    createsObligations: ["obligation:recordStageOutcome"],
    waits: [],
    proofs: ["TerminalProof:process.success", "TerminalProof:process.failure", "TerminalProof:process.cancellation", "TerminalProof:process.unreachable"],
  },
  {
    name: "processRun.settleFailure",
    aggregate: "ProcessRun",
    emitsEvents: ["WorkflowEvent:processRun.settleFailed"],
    createsObligations: ["obligation:recordStageOutcome.failed"],
    waits: [],
    proofs: ["TerminalProof:process.failure"],
  },
  {
    name: "nodeRun.create",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.created"],
    createsObligations: ["obligation:materializeWorkplace.production-cell"],
    waits: [],
    proofs: [],
  },
  {
    name: "nodeRun.materializeCell",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.cellMaterialized"],
    createsObligations: ["obligation:materializeWorkplace.workItems-fanout", "obligation:materializeWorkplace.verificationItems-fanout"],
    waits: [],
    proofs: [],
  },
  {
    name: "nodeRun.recordKernelResult",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.kernelResultRecorded"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "nodeRun.recordCellAcceptance",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.cellAcceptanceRecorded"],
    createsObligations: [],
    waits: [],
    proofs: ["TerminalProof:node.success"],
  },
  {
    name: "nodeRun.recordHumanDecision",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.humanDecisionRecorded"],
    createsObligations: ["obligation:publishRelease"],
    waits: [],
    proofs: [],
  },
  {
    name: "nodeRun.recordProviderOutcome",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.providerOutcomeRecorded"],
    createsObligations: ["obligation:observeRelease", "obligation:effectRedrive"],
    waits: ["TypedWait:effect-uncertainty"],
    proofs: [],
  },
  {
    name: "nodeRun.settleUnreachable",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.unreachableSettled"],
    createsObligations: [],
    waits: [],
    proofs: ["TerminalProof:node.unreachable"],
  },
  {
    name: "nodeRun.fail",
    aggregate: "NodeRun",
    emitsEvents: ["WorkflowEvent:nodeRun.failed"],
    createsObligations: ["obligation:propagateNodeFailure"],
    waits: [],
    proofs: ["TerminalProof:node.failure"],
  },
  {
    name: "workItem.planGraph",
    aggregate: "WorkItem",
    emitsEvents: ["WorkflowEvent:workItem.graphPlanned"],
    createsObligations: ["obligation:instantiateDependantWorkplaces", "obligation:openUnknownObligation"],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.materialize",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.materialized"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.admitWorkIntent",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.workIntentAdmitted"],
    createsObligations: [],
    waits: ["TypedWait:readiness"],
    proofs: [],
  },
  {
    name: "workplace.recordContribution",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.contributionRecorded"],
    createsObligations: ["obligation:sealRevision"],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.sealProductionRevision",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.productionRevisionSealed"],
    createsObligations: ["obligation:presentCandidates"],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.presentCandidateSet",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.candidateSetPresented"],
    createsObligations: ["obligation:runGate.author", "obligation:runGate.final"],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.runAuthorGate",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.authorGateDecided"],
    createsObligations: ["obligation:openReviewerDesk"],
    waits: ["TypedWait:human-input"],
    proofs: [],
  },
  {
    name: "workplace.runFinalGate",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.finalGateDecided"],
    createsObligations: ["obligation:runEffects", "obligation:routeUpstreamRepair"],
    waits: ["TypedWait:human-input"],
    proofs: [],
  },
  {
    name: "workplace.enterRepairWait",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.repairWaitEntered"],
    createsObligations: ["obligation:requeueRepair"],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.rolloverRepairEpoch",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.repairEpochRolledOver"],
    createsObligations: ["obligation:requeueAfterBackoff"],
    waits: [],
    proofs: ["TerminalProof:workplace.failure"],
  },
  {
    name: "workplace.widenAuthorityScope",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.authorityScopeWidened"],
    createsObligations: ["obligation:requeueWidened"],
    waits: [],
    proofs: ["TerminalProof:workplace.failure"],
  },
  {
    name: "workplace.enterHumanWait",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.humanWaitEntered"],
    createsObligations: [],
    waits: ["TypedWait:human-input"],
    proofs: [],
  },
  {
    name: "workplace.resolveHumanResponse",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.humanResponseResolved"],
    createsObligations: ["obligation:requeueAfterHumanResolution", "obligation:resumeEffect"],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.settleEffect",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.effectSettled"],
    createsObligations: ["obligation:effectRedrive"],
    waits: ["TypedWait:human-input", "TypedWait:effect-uncertainty"],
    proofs: [],
  },
  {
    name: "workplace.recordFinalAcceptance",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.finalAcceptanceRecorded"],
    createsObligations: ["obligation:closePresentation", "obligation:completeCellNode"],
    waits: [],
    proofs: ["TerminalProof:cell.success"],
  },
  {
    name: "workplace.closePresentation",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.presentationClosed"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "workplace.issueWorkplaceTerminalProof",
    aggregate: "Workplace",
    emitsEvents: ["WorkflowEvent:workplace.terminalProven"],
    createsObligations: ["obligation:propagateCellFailure", "obligation:markDependantsUnreachable"],
    waits: [],
    proofs: ["TerminalProof:workplace.success", "TerminalProof:workplace.failure", "TerminalProof:workplace.cancellation", "TerminalProof:workplace.unreachable"],
  },
  {
    name: "activityAttempt.create",
    aggregate: "ActivityAttempt",
    emitsEvents: ["WorkflowEvent:activityAttempt.created"],
    createsObligations: ["obligation:launchAdmission"],
    waits: [],
    proofs: [],
  },
  {
    name: "activityAttempt.admitProviderRequest",
    aggregate: "ActivityAttempt",
    emitsEvents: ["WorkflowEvent:activityAttempt.providerRequestAdmitted"],
    createsObligations: ["obligation:providerSend"],
    waits: [],
    proofs: [],
  },
  {
    name: "activityAttempt.recordProviderRefusal",
    aggregate: "ActivityAttempt",
    emitsEvents: ["WorkflowEvent:activityAttempt.providerRefusalRecorded"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "activityAttempt.recordOutcome",
    aggregate: "ActivityAttempt",
    emitsEvents: ["WorkflowEvent:activityAttempt.outcomeRecorded"],
    createsObligations: ["obligation:submitContribution"],
    waits: [],
    proofs: [],
  },
  {
    name: "activityAttempt.classifyWorkerLoss",
    aggregate: "ActivityAttempt",
    emitsEvents: ["WorkflowEvent:activityAttempt.workerLossClassified"],
    createsObligations: ["obligation:retryAttempt"],
    waits: ["TypedWait:external-availability", "TypedWait:effect-uncertainty"],
    proofs: [],
  },
  {
    name: "activityAttempt.cancel",
    aggregate: "ActivityAttempt",
    emitsEvents: ["WorkflowEvent:activityAttempt.cancelled"],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
  {
    name: "cognition.sendProviderRequest",
    aggregate: "CognitionTransport",
    emitsEvents: [],
    createsObligations: [],
    waits: [],
    proofs: [],
  },
];

/** One declared durable obligation edge: source command -> target command. */
export interface ObligationDescriptor {
  readonly kind: ObligationKind;
  readonly source: CommandName;
  readonly target: CommandName;
  readonly evidenceRefs: readonly string[];
}

export const OBLIGATIONS: readonly ObligationDescriptor[] = [
  {
    kind: "obligation:ingestCapsuleFacts",
    source: "factoryRun.importCapsule",
    target: "factoryRun.start",
    evidenceRefs: ["CapsuleIngressReceipt (verified digests)"],
  },
  {
    kind: "obligation:bootstrapLifecycleRun",
    source: "factoryRun.start",
    target: "lifecycleRun.create",
    evidenceRefs: ["run identity + pinned capsule digests"],
  },
  {
    kind: "obligation:enterStage.initial-discovery",
    source: "lifecycleRun.create",
    target: "stageRun.create",
    evidenceRefs: ["initial stage route"],
  },
  {
    kind: "obligation:enterStage.solution-formalization",
    source: "lifecycleRun.routeOutcome",
    target: "stageRun.create",
    evidenceRefs: ["outcome go|clarify|reject (permissive discovery routing; idea strength recorded, not gated)"],
  },
  {
    kind: "obligation:enterStage.solution-development",
    source: "lifecycleRun.routeOutcome",
    target: "stageRun.create",
    evidenceRefs: ["outcome formalized; D0 handoff: certificate ref/hash, solution contract, baseline hash, SRS projection, AC set"],
  },
  {
    kind: "obligation:enterStage.delivery-release",
    source: "lifecycleRun.routeOutcome",
    target: "stageRun.create",
    evidenceRefs: ["outcome verified"],
  },
  {
    kind: "obligation:enterStage.continuation",
    source: "lifecycleRun.createContinuation",
    target: "stageRun.create",
    evidenceRefs: ["authorized policy + operator grant + prior terminal evidence; or accepted-prefix (R11)"],
  },
  {
    kind: "obligation:routeLifecycle",
    source: "stageRun.recordLocalOutcome",
    target: "lifecycleRun.routeOutcome",
    evidenceRefs: ["stage local outcome + ProcessOutcomeCertificate"],
  },
  {
    kind: "obligation:replayCaptureSweep",
    source: "lifecycleRun.issueTerminalProof",
    target: "workplace.settleEffect",
    evidenceRefs: ["replay-capture effect for cross-run capsule reuse"],
  },
  {
    kind: "obligation:bindProcessModule",
    source: "stageRun.activate",
    target: "processRun.create",
    evidenceRefs: ["installed module identity (one process per stage — R10)"],
  },
  {
    kind: "obligation:enterFirstNode",
    source: "processRun.create",
    target: "processRun.enterNode",
    evidenceRefs: ["declared module flow entry"],
  },
  {
    kind: "obligation:materializeWorkplace.production-cell",
    source: "nodeRun.create",
    target: "workplace.materialize",
    evidenceRefs: ["production-cell node binding"],
  },
  {
    kind: "obligation:materializeWorkplace.workItems-fanout",
    source: "nodeRun.materializeCell",
    target: "workplace.materialize",
    evidenceRefs: ["one per WorkItem (implement-work-items)"],
  },
  {
    kind: "obligation:materializeWorkplace.verificationItems-fanout",
    source: "nodeRun.materializeCell",
    target: "workplace.materialize",
    evidenceRefs: ["one per verification item (verify-acceptance)"],
  },
  {
    kind: "obligation:instantiateDependantWorkplaces",
    source: "workItem.planGraph",
    target: "workplace.materialize",
    evidenceRefs: ["dependency edges; readiness is a predicate, never a blocked->todo command; explicit deferrals create no instantiation obligation"],
  },
  {
    kind: "obligation:openUnknownObligation",
    source: "workItem.planGraph",
    target: "workplace.admitWorkIntent",
    evidenceRefs: ["DiscoveryUnknownObligation with owner (cannot disappear at a workshop boundary)"],
  },
  {
    kind: "obligation:launchAdmission",
    source: "activityAttempt.create",
    target: "activityAttempt.admitProviderRequest",
    evidenceRefs: ["first PromptAssemblyReceipt paired with launch admission"],
  },
  {
    kind: "obligation:providerSend",
    source: "activityAttempt.admitProviderRequest",
    target: "cognition.sendProviderRequest",
    evidenceRefs: ["exact idempotent ordinal; crash before send redrives the SAME obligation+ordinal, never a new admission"],
  },
  {
    kind: "obligation:submitContribution",
    source: "activityAttempt.recordOutcome",
    target: "workplace.recordContribution",
    evidenceRefs: ["public ingress contribution"],
  },
  {
    kind: "obligation:sealRevision",
    source: "workplace.recordContribution",
    target: "workplace.sealProductionRevision",
    evidenceRefs: ["contribution -> production revision"],
  },
  {
    kind: "obligation:presentCandidates",
    source: "workplace.sealProductionRevision",
    target: "workplace.presentCandidateSet",
    evidenceRefs: ["production revision -> CandidateSet"],
  },
  {
    kind: "obligation:runGate.author",
    source: "workplace.presentCandidateSet",
    target: "workplace.runAuthorGate",
    evidenceRefs: ["CheckPlan over CandidateSet:author"],
  },
  {
    kind: "obligation:runGate.final",
    source: "workplace.presentCandidateSet",
    target: "workplace.runFinalGate",
    evidenceRefs: ["CheckPlan over CandidateSet:reviewer verdict set"],
  },
  {
    kind: "obligation:openReviewerDesk",
    source: "workplace.runAuthorGate",
    target: "workplace.admitWorkIntent",
    evidenceRefs: ["pinned exact author CandidateSet; role=reviewer"],
  },
  {
    kind: "obligation:runEffects",
    source: "workplace.runFinalGate",
    target: "workplace.settleEffect",
    evidenceRefs: ["every declared effect completes with an exact receipt (AcceptedCandidateAuthority input — R3)"],
  },
  {
    kind: "obligation:routeUpstreamRepair",
    source: "workplace.runFinalGate",
    target: "processRun.settle",
    evidenceRefs: ["GateDecision:upstream-repair verdict (R1): out-of-scope/upstream-material defect routed as typed repair obligation to the owning upstream aggregate; never silently widened"],
  },
  {
    kind: "obligation:requeueRepair",
    source: "workplace.enterRepairWait",
    target: "workplace.admitWorkIntent",
    evidenceRefs: ["exact RecoveryIssue feedback; same Workplace re-staffed (R18)"],
  },
  {
    kind: "obligation:requeueAfterBackoff",
    source: "workplace.rolloverRepairEpoch",
    target: "workplace.admitWorkIntent",
    evidenceRefs: ["durable backoff deadline wake"],
  },
  {
    kind: "obligation:requeueWidened",
    source: "workplace.widenAuthorityScope",
    target: "workplace.admitWorkIntent",
    evidenceRefs: ["widened frozen scope, same Workplace"],
  },
  {
    kind: "obligation:requeueAfterHumanResolution",
    source: "workplace.resolveHumanResponse",
    target: "workplace.admitWorkIntent",
    evidenceRefs: ["human resolution -> repair requeue (replaces legacy direct unpark writes)"],
  },
  {
    kind: "obligation:resumeEffect",
    source: "workplace.resolveHumanResponse",
    target: "workplace.settleEffect",
    evidenceRefs: ["human resolution -> effect resume"],
  },
  {
    kind: "obligation:effectRedrive",
    source: "workplace.settleEffect",
    target: "workplace.settleEffect",
    evidenceRefs: ["idempotent effect action key; crash after external mutation before receipt redrives to receipt or typed wait (FWD:F103-class)"],
  },
  {
    kind: "obligation:completeCellNode",
    source: "workplace.recordFinalAcceptance",
    target: "nodeRun.recordCellAcceptance",
    evidenceRefs: ["exact CellFinalAcceptance evidence"],
  },
  {
    kind: "obligation:closePresentation",
    source: "workplace.recordFinalAcceptance",
    target: "workplace.closePresentation",
    evidenceRefs: ["durable, fenced, idempotent presentation closure"],
  },
  {
    kind: "obligation:propagateCellFailure",
    source: "workplace.issueWorkplaceTerminalProof",
    target: "nodeRun.fail",
    evidenceRefs: ["workplace truthful-failure proof reference"],
  },
  {
    kind: "obligation:markDependantsUnreachable",
    source: "workplace.issueWorkplaceTerminalProof",
    target: "nodeRun.settleUnreachable",
    evidenceRefs: ["dependants explicitly unreachable + SettlementWorkObligation (runnable settlement); nothing waits on a dead wake source"],
  },
  {
    kind: "obligation:propagateNodeFailure",
    source: "nodeRun.fail",
    target: "processRun.settleFailure",
    evidenceRefs: ["typed node failure proof"],
  },
  {
    kind: "obligation:recordStageOutcome",
    source: "processRun.settle",
    target: "stageRun.recordLocalOutcome",
    evidenceRefs: ["ProcessOutcomeCertificate evidence (R14)"],
  },
  {
    kind: "obligation:recordStageOutcome.failed",
    source: "processRun.settleFailure",
    target: "stageRun.recordLocalOutcome",
    evidenceRefs: ["failure outcome certificate"],
  },
  {
    kind: "obligation:advanceProcessFlow",
    source: "processRun.recordNodeTerminal",
    target: "processRun.enterNode",
    evidenceRefs: ["declared module flow (module flows are installed-manifest content — R17)"],
  },
  {
    kind: "obligation:advanceProcessFlow.settle",
    source: "processRun.recordNodeTerminal",
    target: "processRun.settle",
    evidenceRefs: ["declared module flow terminal edge"],
  },
  {
    kind: "obligation:freezeCandidate",
    source: "processRun.recordNodeTerminal",
    target: "nodeRun.recordKernelResult",
    evidenceRefs: ["fan-in: exact predecessor CellFinalAcceptance evidence of ALL implement cells"],
  },
  {
    kind: "obligation:retryAttempt",
    source: "activityAttempt.classifyWorkerLoss",
    target: "activityAttempt.create",
    evidenceRefs: ["bounded retry for retryable substrate failures; typed unknown on exhaustion"],
  },
  {
    kind: "obligation:publishRelease",
    source: "nodeRun.recordHumanDecision",
    target: "nodeRun.recordProviderOutcome",
    evidenceRefs: ["approved release publication"],
  },
  {
    kind: "obligation:observeRelease",
    source: "nodeRun.recordProviderOutcome",
    target: "nodeRun.recordProviderOutcome",
    evidenceRefs: ["observation after idempotent publication EffectReceipt"],
  },
  {
    kind: "obligation:watchdogRestart",
    source: "factoryRun.observeWatchdog",
    target: "factoryRun.resume",
    evidenceRefs: ["durable restart evidence; typed command only, never SQL repair"],
  },
  {
    kind: "obligation:watchdogBudgetExhausted",
    source: "factoryRun.observeWatchdog",
    target: "lifecycleRun.issueTerminalProof",
    evidenceRefs: ["budget-watch truthful failure"],
  },
  {
    kind: "obligation:verifyTerminalClaims",
    source: "lifecycleRun.routeOutcome",
    target: "lifecycleRun.verifyTerminalClaims",
    evidenceRefs: ["every required terminal lifecycle claim verified over its owned construction surface"],
  },
  {
    kind: "obligation:runSettlement",
    source: "lifecycleRun.issueTerminalProof",
    target: "factoryRun.recordRunTerminalProof",
    evidenceRefs: ["final run proof bound to lifecycle terminal evidence"],
  },
];

/** One declared typed wait with its exact durable wake source(s) (D5/D7/D12). */
export interface WaitDescriptor {
  readonly kind: WaitKind;
  /** Commands whose receipts discharge this wait (wake sources). */
  readonly wakeCommands: readonly CommandName[];
  /** Obligation kinds whose completion receipt discharges this wait (D5). */
  readonly wakeObligationKinds: readonly ObligationKind[];
  /** On a terminally failed predecessor the wait converts to this settlement obligation (D7). */
  readonly deadWakeConversion?: ObligationKind;
}

export const WAITS: readonly WaitDescriptor[] = [
  {
    kind: "TypedWait:human-input",
    // wakeSource (frozen prose): operator human-response command -> workplace.resolveHumanResponse | operator approval-decision command -> nodeRun.recordHumanDecision
    // dischargeEvidence (frozen): WakeDischarge:human-response-command
    wakeCommands: ["workplace.resolveHumanResponse", "nodeRun.recordHumanDecision"],
    wakeObligationKinds: [],
  },
  {
    kind: "TypedWait:external-availability",
    // wakeSource (frozen prose): substrate re-probe obligation with deadline (bounded in-check retry; typed unknown on exhaustion, never product-failed) -> obligation completion
    // dischargeEvidence (frozen): probe-obligation ObligationCompletionReceipt + probe result (exact kind pending D5)
    wakeCommands: [],
    wakeObligationKinds: ["obligation:retryAttempt"],
  },
  {
    kind: "TypedWait:policy-quota",
    // wakeSource (frozen prose): backoff deadline obligation (requeueAfterBackoff) | operator resume command (factoryRun.resume) after requestStop
    // dischargeEvidence (frozen): deadline-obligation ObligationCompletionReceipt + policy re-evaluation | resume command receipt (exact kind pending D5)
    wakeCommands: ["factoryRun.resume"],
    wakeObligationKinds: ["obligation:requeueAfterBackoff"],
  },
  {
    kind: "TypedWait:readiness",
    // wakeSource (frozen prose): predecessor CellFinalAcceptance/EffectReceipt evidence arrival (predecessor obligation completion); a terminally failed predecessor converts this wait into unreachable settlement via obligation:markDe
    // dischargeEvidence (frozen): predecessor ObligationCompletionReceipt + exact CellFinalAcceptance/EffectReceipt refs
    wakeCommands: [],
    wakeObligationKinds: ["obligation:completeCellNode", "obligation:effectRedrive"],
    deadWakeConversion: "obligation:markDependantsUnreachable",
  },
  {
    kind: "TypedWait:effect-uncertainty",
    // wakeSource (frozen prose): operator resolution command (never an automatic duplicate of a non-idempotent external send/effect)
    // dischargeEvidence (frozen): uncertainty-resolution receipt (exact kind pending D12)
    wakeCommands: ["workplace.resolveHumanResponse"],
    wakeObligationKinds: [],
  },
];

/** One declared terminal proof: exact evidence closure for one exact scope. */
export interface ProofDescriptor {
  readonly id: ProofKind;
  readonly scope: string;
  readonly outcome: 'success' | 'truthful-failure' | 'cancellation' | 'unreachable';
  readonly ownerAggregate: string;
  readonly issuingCommand: string;
  readonly requiredEvidenceClosure: readonly string[];
}

export const PROOFS: readonly ProofDescriptor[] = [
  {
    id: "TerminalProof:cell.success",
    scope: "cell",
    outcome: "success",
    ownerAggregate: "Workplace",
    issuingCommand: "workplace.recordFinalAcceptance",
    requiredEvidenceClosure: ["CellFinalAcceptance"],
  },
  {
    id: "TerminalProof:cell.truthful-failure",
    scope: "cell",
    outcome: "truthful-failure",
    ownerAggregate: "Workplace",
    issuingCommand: "workplace.runAuthorGate | workplace.runFinalGate | workplace.settleEffect",
    requiredEvidenceClosure: ["GateDecision:terminal-reject", "EffectReceipt:policy-terminal", "EffectPolicyRefusal", "RepairTerminalityEvidence"],
  },
  {
    id: "TerminalProof:cell.cancellation",
    scope: "cell",
    outcome: "cancellation",
    ownerAggregate: "Workplace",
    issuingCommand: "lifecycleRun.cancel",
    requiredEvidenceClosure: ["OperatorStopCommand", "TypedWaitDisposition"],
  },
  {
    id: "TerminalProof:cell.unreachable",
    scope: "cell",
    outcome: "unreachable",
    ownerAggregate: "Workplace",
    issuingCommand: "workplace.issueWorkplaceTerminalProof",
    requiredEvidenceClosure: ["TerminalProof:cell.failure", "SettlementWorkObligation"],
  },
  {
    id: "TerminalProof:workplace.success",
    scope: "workplace",
    outcome: "success",
    ownerAggregate: "Workplace",
    issuingCommand: "workplace.issueWorkplaceTerminalProof",
    requiredEvidenceClosure: ["CellFinalAcceptance", "ObligationCompletionReceipt"],
  },
  {
    id: "TerminalProof:workplace.truthful-failure",
    scope: "workplace",
    outcome: "truthful-failure",
    ownerAggregate: "Workplace",
    issuingCommand: "workplace.rolloverRepairEpoch | workplace.widenAuthorityScope",
    requiredEvidenceClosure: ["GateDecision:terminal-reject", "EffectReceipt:policy-terminal", "RepairTerminalityEvidence"],
  },
  {
    id: "TerminalProof:workplace.cancellation",
    scope: "workplace",
    outcome: "cancellation",
    ownerAggregate: "Workplace",
    issuingCommand: "lifecycleRun.cancel",
    requiredEvidenceClosure: ["OperatorStopCommand", "ActivityAttempt:cancelled", "TypedWaitDisposition"],
  },
  {
    id: "TerminalProof:workplace.unreachable",
    scope: "workplace",
    outcome: "unreachable",
    ownerAggregate: "Workplace",
    issuingCommand: "workplace.issueWorkplaceTerminalProof",
    requiredEvidenceClosure: ["TerminalProof:workplace.failure", "SettlementWorkObligation"],
  },
  {
    id: "TerminalProof:node.success",
    scope: "node",
    outcome: "success",
    ownerAggregate: "NodeRun",
    issuingCommand: "nodeRun.recordCellAcceptance | nodeRun.recordKernelResult",
    requiredEvidenceClosure: ["TerminalProof:workplace.success", "WorkItemDependency", "CellFinalAcceptance", "EffectReceipt:success"],
  },
  {
    id: "TerminalProof:node.truthful-failure",
    scope: "node",
    outcome: "truthful-failure",
    ownerAggregate: "NodeRun",
    issuingCommand: "nodeRun.fail",
    requiredEvidenceClosure: ["TerminalProof:workplace.failure"],
  },
  {
    id: "TerminalProof:node.cancellation",
    scope: "node",
    outcome: "cancellation",
    ownerAggregate: "NodeRun",
    issuingCommand: "lifecycleRun.cancel",
    requiredEvidenceClosure: ["OperatorStopCommand", "TypedWaitDisposition"],
  },
  {
    id: "TerminalProof:node.unreachable",
    scope: "node",
    outcome: "unreachable",
    ownerAggregate: "NodeRun",
    issuingCommand: "nodeRun.settleUnreachable",
    requiredEvidenceClosure: ["TerminalProof:node.failure", "SettlementWorkObligation"],
  },
  {
    id: "TerminalProof:process.success",
    scope: "process",
    outcome: "success",
    ownerAggregate: "ProcessRun",
    issuingCommand: "processRun.settle",
    requiredEvidenceClosure: ["TerminalProof:node.success", "ObligationCompletionReceipt", "ProcessOutcomeCertificate"],
  },
  {
    id: "TerminalProof:process.truthful-failure",
    scope: "process",
    outcome: "truthful-failure",
    ownerAggregate: "ProcessRun",
    issuingCommand: "processRun.settleFailure",
    requiredEvidenceClosure: ["TerminalProof:node.failure"],
  },
  {
    id: "TerminalProof:process.cancellation",
    scope: "process",
    outcome: "cancellation",
    ownerAggregate: "ProcessRun",
    issuingCommand: "lifecycleRun.cancel",
    requiredEvidenceClosure: ["OperatorStopCommand", "TypedWaitDisposition"],
  },
  {
    id: "TerminalProof:process.unreachable",
    scope: "process",
    outcome: "unreachable",
    ownerAggregate: "ProcessRun",
    issuingCommand: "unresolved - unreachable scope set frozen by D7",
    requiredEvidenceClosure: ["TerminalProof:process.failure", "SettlementWorkObligation"],
  },
  {
    id: "TerminalProof:stage.success",
    scope: "stage",
    outcome: "success",
    ownerAggregate: "StageRun",
    issuingCommand: "stageRun.recordLocalOutcome",
    requiredEvidenceClosure: ["TerminalProof:process.success", "ObligationCompletionReceipt"],
  },
  {
    id: "TerminalProof:stage.truthful-failure",
    scope: "stage",
    outcome: "truthful-failure",
    ownerAggregate: "StageRun",
    issuingCommand: "stageRun.recordLocalOutcome",
    requiredEvidenceClosure: ["TerminalProof:process.failure"],
  },
  {
    id: "TerminalProof:stage.cancellation",
    scope: "stage",
    outcome: "cancellation",
    ownerAggregate: "StageRun",
    issuingCommand: "lifecycleRun.cancel",
    requiredEvidenceClosure: ["OperatorStopCommand", "TypedWaitDisposition"],
  },
  {
    id: "TerminalProof:stage.unreachable",
    scope: "stage",
    outcome: "unreachable",
    ownerAggregate: "StageRun",
    issuingCommand: "unresolved - unreachable scope set frozen by D7",
    requiredEvidenceClosure: ["TerminalProof:stage.failure", "SettlementWorkObligation"],
  },
  {
    id: "TerminalProof:lifecycle.success",
    scope: "lifecycle",
    outcome: "success",
    ownerAggregate: "LifecycleRun",
    issuingCommand: "lifecycleRun.issueTerminalProof",
    requiredEvidenceClosure: ["TerminalProof:stage.success", "LifecycleRoutingReceipt", "ExecutableVerifierResult", "TerminalClaimCoverage", "TerminalLifecycleClaim", "ConstructionSurface"],
  },
  {
    id: "TerminalProof:lifecycle.truthful-failure",
    scope: "lifecycle",
    outcome: "truthful-failure",
    ownerAggregate: "LifecycleRun",
    issuingCommand: "lifecycleRun.issueTerminalProof",
    requiredEvidenceClosure: ["TerminalProof:stage.failure"],
  },
  {
    id: "TerminalProof:lifecycle.cancellation",
    scope: "lifecycle",
    outcome: "cancellation",
    ownerAggregate: "LifecycleRun",
    issuingCommand: "lifecycleRun.cancel",
    requiredEvidenceClosure: ["OperatorStopCommand", "TypedWaitDisposition"],
  },
  {
    id: "TerminalProof:lifecycle.unreachable",
    scope: "lifecycle",
    outcome: "unreachable",
    ownerAggregate: "LifecycleRun",
    issuingCommand: "unresolved - unreachable scope set frozen by D7",
    requiredEvidenceClosure: ["TerminalProof:lifecycle.failure", "SettlementWorkObligation"],
  },
  {
    id: "TerminalProof:run.success",
    scope: "run",
    outcome: "success",
    ownerAggregate: "FactoryRun",
    issuingCommand: "factoryRun.recordRunTerminalProof",
    requiredEvidenceClosure: ["TerminalProof:lifecycle.success", "ProductVerificationEvidence", "EffectReceipt:success", "CapsuleIngressReceipt", "ContextEnvelopeComplianceEvidence", "ForwardReverseReconciliationReceipt", "TerminalClaimCoverage"],
  },
  {
    id: "TerminalProof:run.truthful-failure",
    scope: "run",
    outcome: "truthful-failure",
    ownerAggregate: "FactoryRun",
    issuingCommand: "factoryRun.recordRunTerminalProof",
    requiredEvidenceClosure: ["TerminalProof:lifecycle.failure", "ProductVerificationFailure"],
  },
  {
    id: "TerminalProof:run.cancellation",
    scope: "run",
    outcome: "cancellation",
    ownerAggregate: "FactoryRun",
    issuingCommand: "factoryRun.recordRunTerminalProof",
    requiredEvidenceClosure: ["OperatorStopCommand", "TypedWaitDisposition"],
  },
  {
    id: "TerminalProof:run.unreachable",
    scope: "run",
    outcome: "unreachable",
    ownerAggregate: "FactoryRun",
    issuingCommand: "unresolved - unreachable scope set frozen by D7",
    requiredEvidenceClosure: ["TerminalProof:run.failure", "TypedRefusalReceipt"],
  },
];

/** One declared evidence kind: producer command(s) and consumer(s). */
export interface EvidenceDescriptor {
  readonly id: EvidenceKind;
  readonly producer: string;
  readonly consumers: readonly string[];
}

export const EVIDENCE_DESCRIPTORS: readonly EvidenceDescriptor[] = [
  {
    id: "CellFinalAcceptance",
    producer: "workplace.recordFinalAcceptance",
    consumers: ["TerminalProof:cell.success", "TerminalProof:workplace.success", "TerminalProof:node.success", "obligation:completeCellNode"],
  },
  {
    id: "GateDecision:accepted",
    producer: "workplace.runAuthorGate | workplace.runFinalGate",
    consumers: ["AcceptedCandidateAuthority", "TerminalProof closure via CellFinalAcceptance"],
  },
  {
    id: "GateDecision:repair",
    producer: "workplace.runAuthorGate | workplace.runFinalGate",
    consumers: ["workplace.enterRepairWait (repair loop)"],
  },
  {
    id: "GateDecision:upstream-repair",
    producer: "workplace.runAuthorGate | workplace.runFinalGate (added by R1)",
    consumers: ["obligation:routeUpstreamRepair"],
  },
  {
    id: "GateDecision:human-wait",
    producer: "workplace.runAuthorGate | workplace.runFinalGate",
    consumers: ["workplace.enterHumanWait"],
  },
  {
    id: "GateDecision:terminal-reject",
    producer: "workplace.runAuthorGate | workplace.runFinalGate (added by R1)",
    consumers: ["TerminalProof:cell.failure", "TerminalProof:workplace.failure"],
  },
  {
    id: "CheckPlan",
    producer: "InstalledWorkshopManifest (immutable content-addressed input; referenced as gate evidence — R15)",
    consumers: ["workplace.runAuthorGate", "workplace.runFinalGate"],
  },
  {
    id: "CandidateSet:author",
    producer: "workplace.presentCandidateSet",
    consumers: ["workplace.runAuthorGate", "AcceptedCandidateAuthority"],
  },
  {
    id: "CandidateSet:reviewer",
    producer: "workplace.presentCandidateSet",
    consumers: ["workplace.runFinalGate"],
  },
  {
    id: "WorkplaceProductionRevision",
    producer: "workplace.sealProductionRevision",
    consumers: ["workplace.presentCandidateSet"],
  },
  {
    id: "ActivityAttemptContribution",
    producer: "workplace.recordContribution",
    consumers: ["workplace.sealProductionRevision"],
  },
  {
    id: "ActivityAttempt:completed",
    producer: "activityAttempt.recordOutcome",
    consumers: ["workplace.recordContribution"],
  },
  {
    id: "ActivityAttempt:failed-typed",
    producer: "activityAttempt.recordProviderRefusal | activityAttempt.classifyWorkerLoss",
    consumers: ["obligation:retryAttempt", "workplace repair routing"],
  },
  {
    id: "ActivityAttempt:cancelled",
    producer: "activityAttempt.cancel (pending D3)",
    consumers: ["TerminalProof:workplace.cancellation"],
  },
  {
    id: "WorkIntent",
    producer: "workplace.admitWorkIntent",
    consumers: ["activityAttempt.create"],
  },
  {
    id: "CanonicalRoleContractBinding",
    producer: "workplace.admitWorkIntent (pin; value from InstalledWorkshopManifest — FWD:F007)",
    consumers: ["activityAttempt.create (atomic equality verification)"],
  },
  {
    id: "PromptAssemblyReceipt:admitted",
    producer: "activityAttempt.admitProviderRequest",
    consumers: ["ContextEnvelopeComplianceEvidence", "activityAttempt.recordOutcome"],
  },
  {
    id: "PromptAssemblyReceipt:refused",
    producer: "activityAttempt.admitProviderRequest",
    consumers: ["ContextEnvelopeComplianceEvidence"],
  },
  {
    id: "ProviderSendOutcome",
    producer: "cognition.sendProviderRequest -> activityAttempt.recordOutcome",
    consumers: ["EffectReceipt:unknown closure", "ActivityAttempt:failed-typed"],
  },
  {
    id: "ProviderRoutePin",
    producer: "activityAttempt.create (single route-policy evaluation)",
    consumers: ["cognition.sendProviderRequest"],
  },
  {
    id: "TransitionObligation",
    producer: "every source command per durable-handoff grammar (co-requisite with its WorkflowEvent — R16)",
    consumers: ["TargetOwnerCapability consumer", "ObligationCompletionReceipt"],
  },
  {
    id: "ObligationCompletionReceipt",
    producer: "the target-command transaction of each obligation",
    consumers: ["TerminalProof:workplace.success", "TerminalProof:process.success", "TerminalProof:stage.success"],
  },
  {
    id: "SettlementWorkObligation",
    producer: "nodeRun.settleUnreachable (and unreachable settlements)",
    consumers: ["TerminalProof:*:unreachable closures"],
  },
  {
    id: "TypedWait:human-input",
    producer: "workplace.enterHumanWait | gate human-wait verdicts | nodeRun human nodes",
    consumers: ["workplace.resolveHumanResponse | nodeRun.recordHumanDecision (wake discharge)"],
  },
  {
    id: "TypedWait:external-availability",
    producer: "bounded-retry exhaustion paths (W4)",
    consumers: ["probe-obligation completion (kind pending D5)"],
  },
  {
    id: "TypedWait:policy-quota",
    producer: "factoryRun.requestStop | workplace.rolloverRepairEpoch backoff",
    consumers: ["factoryRun.resume | requeueAfterBackoff deadline (kind pending D5)"],
  },
  {
    id: "TypedWait:readiness",
    producer: "workplace.materialize/admitWorkIntent while predecessor evidence incomplete (R4)",
    consumers: ["predecessor obligation completion discharge"],
  },
  {
    id: "TypedWait:effect-uncertainty",
    producer: "workplace.settleEffect(unknown) | activityAttempt.classifyWorkerLoss | nodeRun.recordProviderOutcome crash windows",
    consumers: ["operator resolution command (discharge kind pending D12)"],
  },
  {
    id: "WakeDischarge:human-response-command",
    producer: "workplace.resolveHumanResponse | nodeRun.recordHumanDecision",
    consumers: ["TypedWait:human-input closure"],
  },
  {
    id: "WakeDischarge:external-availability-event",
    producer: "probe-obligation completion + probe result (pending D5)",
    consumers: ["TypedWait:external-availability closure"],
  },
  {
    id: "WakeDischarge:policy-quota-release",
    producer: "deadline-obligation completion + policy re-evaluation | operator resume (pending D5)",
    consumers: ["TypedWait:policy-quota closure"],
  },
  {
    id: "TypedWaitDisposition",
    producer: "cancellation settlement (shape pending D3)",
    consumers: ["all TerminalProof:cancellation closures"],
  },
  {
    id: "OperatorStopCommand",
    producer: "factoryRun.requestStop (resume analogous)",
    consumers: ["all TerminalProof:cancellation closures"],
  },
  {
    id: "WorkflowEvent",
    producer: "every aggregate command (co-requisite fact of the same transaction — R16)",
    consumers: ["TransitionObligation creation", "OperatorStopCommand", "offline replay verification"],
  },
  {
    id: "WorkItem",
    producer: "workItem.planGraph (immutable)",
    consumers: ["WorkIntent", "ConstructionSurface", "TerminalProof:node.success"],
  },
  {
    id: "WorkItemDependency",
    producer: "workItem.planGraph (immutable)",
    consumers: ["readiness predicates", "TerminalProof:node.success"],
  },
  {
    id: "WorkItemObligationMapping",
    producer: "workItem.planGraph (immutable)",
    consumers: ["obligation:instantiateDependantWorkplaces", "obligation:openUnknownObligation"],
  },
  {
    id: "EpicScopeCoverage",
    producer: "workItem.planGraph (epic scope equality: covered + explicitly deferred == declared)",
    consumers: ["ForwardReverseReconciliationReceipt", "TerminalClaimCoverage"],
  },
  {
    id: "DeferredScopeEntry",
    producer: "workItem.planGraph (owner + reason)",
    consumers: ["EpicScopeCoverage"],
  },
  {
    id: "DiscoveryUnknownObligation",
    producer: "workItem.planGraph clause (pending D10)",
    consumers: ["TerminalClaimCoverage", "obligation:openUnknownObligation"],
  },
  {
    id: "QualitativeRequirementDisposition",
    producer: "workItem.planGraph (parameterized or explicitly deferred)",
    consumers: ["TerminalClaimCoverage"],
  },
  {
    id: "TerminalLifecycleClaim",
    producer: "capsule planning facts -> workItem.planGraph (immutable)",
    consumers: ["ExecutableVerifierResult", "TerminalClaimCoverage"],
  },
  {
    id: "TerminalClaimCoverage",
    producer: "workItem.planGraph (terminal-claim equality: owned and verifiable == required)",
    consumers: ["TerminalProof:lifecycle.success", "TerminalProof:run.success"],
  },
  {
    id: "ConstructionSurface",
    producer: "workItem.planGraph (immutable)",
    consumers: ["ExecutableVerifierResult"],
  },
  {
    id: "ExecutableVerifierResult",
    producer: "lifecycleRun.verifyTerminalClaims (pending D4)",
    consumers: ["TerminalProof:lifecycle.success"],
  },
  {
    id: "SeamOwnership",
    producer: "workItem.planGraph (every seam/test/integration surface owned)",
    consumers: ["TerminalClaimCoverage"],
  },
  {
    id: "EffectReceipt:success",
    producer: "workplace.settleEffect (sole writer — R13)",
    consumers: ["CellFinalAcceptance closure", "EffectReceipt:already-applied", "TerminalProof:run.success"],
  },
  {
    id: "EffectReceipt:already-applied",
    producer: "workplace.settleEffect (idempotency-key replay; added by R2)",
    consumers: ["CellFinalAcceptance closure (satisfies via idempotency-key equality with prior success)"],
  },
  {
    id: "EffectReceipt:retryable",
    producer: "workplace.settleEffect (bounded substrate retry; added by R2)",
    consumers: ["obligation:effectRedrive"],
  },
  {
    id: "EffectReceipt:unknown",
    producer: "workplace.settleEffect | nodeRun.recordProviderOutcome (crash after un-idempotent external send)",
    consumers: ["TypedWait:effect-uncertainty (resolution pending D12)"],
  },
  {
    id: "EffectReceipt:human-wait",
    producer: "workplace.settleEffect (human_required; typed as human-input wait per R12)",
    consumers: ["workplace.enterHumanWait -> resolveHumanResponse -> resumeEffect"],
  },
  {
    id: "EffectReceipt:policy-terminal",
    producer: "workplace.settleEffect (added by R2)",
    consumers: ["TerminalProof:cell.failure", "TerminalProof:workplace.failure"],
  },
  {
    id: "EffectReceipt:repair",
    producer: "workplace.settleEffect (repair_required verdict; git-integration conflict canonical case — pending D2)",
    consumers: ["workplace.enterRepairWait (pending D2 re-typing alternative)"],
  },
  {
    id: "EffectPolicyRefusal",
    producer: "workplace.settleEffect (typed policy refusal over the exact effect contract)",
    consumers: ["EffectReceipt:policy-terminal"],
  },
  {
    id: "AcceptedCandidateAuthority",
    producer: "workplace.runFinalGate / workplace.runAuthorGate accept transaction (R3; FWD:F066/F071 'authority commit isFinal')",
    consumers: ["workplace.settleEffect (exact effect input)", "workplace.recordFinalAcceptance"],
  },
  {
    id: "CapsuleIngressReceipt",
    producer: "factoryRun.importCapsule",
    consumers: ["factoryRun.start", "TerminalProof:run.success", "InputEvidenceRefs"],
  },
  {
    id: "ProductVerificationEvidence",
    producer: "independent verifier actor through public ingress (R5; no new aggregate)",
    consumers: ["TerminalProof:run.success"],
  },
  {
    id: "ProductVerificationFailure",
    producer: "independent verifier actor through public ingress (R5)",
    consumers: ["TerminalProof:run.failure"],
  },
  {
    id: "ContextEnvelopeComplianceEvidence",
    producer: "settlement-time predicate over PromptAssemblyReceipt sequence + role-digest pins (R6; no new linearization point)",
    consumers: ["TerminalProof:run.success"],
  },
  {
    id: "ForwardReverseReconciliationReceipt",
    producer: "settlement-time forward/reverse observed-graph comparison (R7; EK-6/EK-12 command)",
    consumers: ["TerminalProof:run.success"],
  },
  {
    id: "TypedRefusalReceipt",
    producer: "factoryRun.bootstrap | factoryRun.importCapsule fail-closed refusals (pre-run); in-run grounding pending D7",
    consumers: ["TerminalProof:run.unreachable (pending D7)"],
  },
  {
    id: "InputEvidenceRefs",
    producer: "workplace.admitWorkIntent (binding)",
    consumers: ["WorkIntent"],
  },
  {
    id: "LifecycleRoutingReceipt",
    producer: "lifecycleRun.routeOutcome (RouteLifecycle obligation completion)",
    consumers: ["TerminalProof:lifecycle.success"],
  },
  {
    id: "ProcessOutcomeCertificate",
    producer: "processRun.settle (one transaction)",
    consumers: ["stageRun.recordLocalOutcome", "TerminalProof:process.success (is the proof evidence — R14)"],
  },
  {
    id: "RecoveryIssue",
    producer: "workplace.enterRepairWait | workplace.settleEffect(repair)",
    consumers: ["obligation:requeueRepair (exact feedback)", "GateDecision:repair loop"],
  },
  {
    id: "RepairTerminalityEvidence",
    producer: "workplace.rolloverRepairEpoch (repair-epoch ledger: attempt/epoch counters vs frozen caps) | workplace.widenAuthorityScope (scope-refusal receipt) — pending D6",
    consumers: ["TerminalProof:cell.failure", "TerminalProof:workplace.failure"],
  },
  {
    id: "WatchdogObservation",
    producer: "factoryRun.observeWatchdog (pending D9)",
    consumers: ["obligation:watchdogRestart", "obligation:watchdogBudgetExhausted"],
  },
];
