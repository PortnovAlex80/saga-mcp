/**
 * workflow-kernel/domain/explorer.ts - the reference state explorer of the
 * pure workflow kernel (WP-05, plan phase EK-2).
 *
 * The explorer is a PURE in-memory reference machine built FROM the frozen
 * EK-1 transition universe (./universe.js) plus the per-aggregate reducers
 * (./reducers/index.ts). It:
 *
 *   - applies commands with full transition legality, idempotency keys,
 *     CAS revision fences, evidence verification, obligation fan-out and
 *     wait wake sources (the durable-handoff grammar);
 *   - enforces the write-time progress invariant: every committed
 *     nonterminal result keeps a runnable obligation, a typed wait with a
 *     live wake source, or a legal successor edge (the model cannot reach
 *     an unexplained nonterminal state);
 *   - propagates failure/unreachable explicitly (D3/D6/D7): a terminally
 *     failed predecessor converts dependant readiness waits into
 *     unreachable settlement work, never a dead wake source;
 *   - generates a LEGAL TRACE for every one of the 53 declared commands
 *     (static ancestors over the obligation + evidence + wake graph, then
 *     deterministic breadth-first search with a retained random seed);
 *   - generates ILLEGAL TRACES for the mutation classes and minimizes a
 *     failing trace (delta debugging) while preserving the seed.
 *
 * PURITY: node:crypto for digests only. No SQLite, no UI, no worker
 * providers, no package names, no workshop module names.
 */

import { createHash } from 'node:crypto';
import type {
  AggregateHead,
  CommandInput,
  CommandOutcome,
  CommitPlan,
  EvidenceFact,
  IdempotencyKey,
  InstanceId,
  ObligationRecord,
  ProofRecord,
  ProgressWitness,
  TypedRefusal,
  WaitRecord,
  WorkflowEventRecord,
  WorkIntent,
} from './types.js';
import {
  COMMANDS,
  EVIDENCE_DESCRIPTORS,
  OBLIGATIONS,
  PROOFS,
  WAITS,
  normalizeProofId,
  type CommandDescriptor,
  type CommandName,
  type EvidenceKind,
  type ProofKind,
  type WaitKind,
} from './universe.js';
import { REDUCERS, reducerForCommand, validateRegistry } from './reducers/index.js';
import type { AggregateReducer, GuardResult } from './types.js';

/* ------------------------------------------------------------------ */
/* Deterministic PRNG (mulberry32) - the retained random seed          */
/* ------------------------------------------------------------------ */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Evidence production map (derived from the frozen evidence registry)  */
/* ------------------------------------------------------------------ */

/**
 * Kinds produced by the kernel LEDGER itself rather than by one command:
 * obligations, events, completion receipts, settlement work, the D3 wait
 * dispositions and the five typed waits (wait records double as evidence).
 */
const LEDGER_PRODUCED_KINDS: readonly string[] = [
  'TransitionObligation',
  'WorkflowEvent',
  'ObligationCompletionReceipt',
  'SettlementWorkObligation',
  'TypedWaitDisposition',
  'WakeDischarge:external-availability-event',
  'TypedWait:human-input',
  'TypedWait:external-availability',
  'TypedWait:policy-quota',
  'TypedWait:readiness',
  'TypedWait:effect-uncertainty',
];

/** Kinds produced by non-command authorities (manifest, verifier actor, input). */
const EXTERNAL_INPUT_KINDS: readonly string[] = [
  'CheckPlan', // installed workshop manifest (R15)
  'ProductVerificationEvidence', // independent verifier actor (R5)
  'ProductVerificationFailure', // independent verifier actor (R5)
];

/**
 * Command -> produced evidence kinds. Every arrow case in the frozen
 * producers prose is resolved explicitly here; completeness over all 67
 * kinds is asserted by the model tests.
 */
const COMMAND_PRODUCTION: Readonly<Record<string, readonly EvidenceKind[] | ((input: CommandInput) => readonly EvidenceKind[])>> = {
  'factoryRun.importCapsule': ['CapsuleIngressReceipt', 'TerminalLifecycleClaim', 'TerminalClaimCoverage', 'ConstructionSurface', 'SeamOwnership'],
  'factoryRun.requestStop': ['OperatorStopCommand'],
  'factoryRun.resume': ['WakeDischarge:policy-quota-release'],
  'factoryRun.observeWatchdog': ['WatchdogObservation'],
  'factoryRun.recordRunTerminalProof': ['ContextEnvelopeComplianceEvidence', 'ForwardReverseReconciliationReceipt'],
  'lifecycleRun.routeOutcome': ['LifecycleRoutingReceipt'],
  'lifecycleRun.cancel': ['TypedWaitDisposition'],
  'lifecycleRun.verifyTerminalClaims': ['ExecutableVerifierResult'],
  'processRun.settle': ['ProcessOutcomeCertificate'],
  'cognition.sendProviderRequest': ['ProviderSendOutcome'],
  'activityAttempt.create': ['ProviderRoutePin'],
  'activityAttempt.admitProviderRequest': ['PromptAssemblyReceipt:admitted'],
  'activityAttempt.recordOutcome': ['ActivityAttempt:completed'],
  'activityAttempt.recordProviderRefusal': ['ActivityAttempt:failed-typed'],
  'activityAttempt.classifyWorkerLoss': ['ActivityAttempt:failed-typed'],
  'activityAttempt.cancel': ['ActivityAttempt:cancelled'],
  'workplace.admitWorkIntent': ['WorkIntent', 'CanonicalRoleContractBinding', 'InputEvidenceRefs'],
  'workplace.recordContribution': ['ActivityAttemptContribution'],
  'workplace.sealProductionRevision': ['WorkplaceProductionRevision'],
  'workplace.presentCandidateSet': ['CandidateSet:author', 'CandidateSet:reviewer'],
  'workplace.runAuthorGate': (input) => {
    const kinds: EvidenceKind[] = [`GateDecision:${input.gateVerdict ?? 'accepted'}`];
    if (input.gateVerdict === 'accepted') kinds.push('AcceptedCandidateAuthority');
    return kinds;
  },
  'workplace.runFinalGate': (input) => {
    const kinds: EvidenceKind[] = [`GateDecision:${input.gateVerdict ?? 'accepted'}`];
    if (input.gateVerdict === 'accepted') kinds.push('AcceptedCandidateAuthority');
    return kinds;
  },
  'workplace.enterRepairWait': ['RecoveryIssue'],
  'workplace.rolloverRepairEpoch': ['RepairTerminalityEvidence'],
  'workplace.widenAuthorityScope': ['RepairTerminalityEvidence'],
  'workplace.resolveHumanResponse': ['WakeDischarge:human-response-command'],
  'nodeRun.recordHumanDecision': ['WakeDischarge:human-response-command'],
  'workplace.settleEffect': (input) => {
    const outcome = input.effectOutcome ?? 'success';
    const kinds: EvidenceKind[] = [`EffectReceipt:${outcome}`];
    if (outcome === 'policy-terminal') kinds.push('EffectPolicyRefusal');
    return kinds;
  },
  'workplace.recordFinalAcceptance': ['CellFinalAcceptance'],
  'workItem.planGraph': [
    'WorkItem',
    'WorkItemDependency',
    'WorkItemObligationMapping',
    'EpicScopeCoverage',
    'DeferredScopeEntry',
    'DiscoveryUnknownObligation',
    'QualitativeRequirementDisposition',
  ],
};

function producedKinds(command: CommandName, input: CommandInput): EvidenceKind[] {
  const entry = COMMAND_PRODUCTION[command];
  if (!entry) return [];
  return typeof entry === 'function' ? [...entry(input)] : [...entry];
}

/** Which commands can produce the evidence kind (static, for the ancestor graph). */
export function producerCommandsOfKind(kind: EvidenceKind): CommandName[] {
  const producers: CommandName[] = [];
  for (const [command, entry] of Object.entries(COMMAND_PRODUCTION)) {
    if (typeof entry === 'function') {
      if (command === 'workplace.runAuthorGate' || command === 'workplace.runFinalGate') {
        if (kind === 'AcceptedCandidateAuthority' || kind.startsWith('GateDecision:')) producers.push(command as CommandName);
      } else if (command === 'workplace.settleEffect') {
        if (kind.startsWith('EffectReceipt:') || kind === 'EffectPolicyRefusal') producers.push(command as CommandName);
      }
      continue;
    }
    if ((entry as readonly string[]).includes(kind)) producers.push(command as CommandName);
  }
  return producers;
}

/** How a kind enters the world (completeness asserted by the model tests). */
export function evidenceSourceClass(kind: EvidenceKind): 'command' | 'ledger' | 'external-input' {
  if ((EXTERNAL_INPUT_KINDS as readonly string[]).includes(kind)) return 'external-input';
  if ((LEDGER_PRODUCED_KINDS as readonly string[]).includes(kind)) return 'ledger';
  return 'command';
}

/* ------------------------------------------------------------------ */
/* World state                                                         */
/* ------------------------------------------------------------------ */

export interface KernelWorld {
  readonly seed: number;
  readonly heads: ReadonlyMap<InstanceId, AggregateHead>;
  readonly events: readonly WorkflowEventRecord[];
  readonly obligations: readonly ObligationRecord[];
  readonly waits: readonly WaitRecord[];
  readonly proofs: readonly ProofRecord[];
  readonly evidence: readonly EvidenceFact[];
  readonly workIntents: ReadonlyMap<string, WorkIntent>;
  readonly idempotency: ReadonlyMap<IdempotencyKey, { readonly eventSequence: number }>;
  readonly instanceCounters: Readonly<Record<string, number>>;
  readonly sequence: number;
}

export function createWorld(seed: number): KernelWorld {
  // The stateless cognition transport boundary is pre-seeded (not an
  // aggregate owner; replaceable transport behind the provider-send
  // obligation).
  const heads = new Map<InstanceId, AggregateHead>([
    ['cognition:transport', { aggregate: 'CognitionTransport', instanceId: 'cognition:transport', revision: 0, status: 'stateless' }],
  ]);
  // External-input evidence is present from the start: the installed
  // workshop manifest (CheckPlan, R15) and the independent verifier actor
  // through public ingress (R5). The reference explorer admits them as
  // world inputs; production conformance (WP-13A) authors them per
  // scenario instead of seeding them unconditionally.
  const evidence: EvidenceFact[] = EXTERNAL_INPUT_KINDS.map((kind, index) => ({
    kind: kind as EvidenceKind,
    ref: `evidence:${kind}#external`,
    producer: 'external-input',
    payloadDigest: createHash('sha256').update(`${kind}:${seed}:${index}`, 'utf8').digest('hex'),
  }));
  return {
    seed,
    heads,
    events: [],
    obligations: [],
    waits: [],
    proofs: [],
    evidence,
    workIntents: new Map(),
    idempotency: new Map(),
    instanceCounters: { CognitionTransport: 1 },
    sequence: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Static ancestor graph (from the frozen universe alone)              */
/* ------------------------------------------------------------------ */

/**
 * Guard-known requirements the registry prose cannot express (each entry
 * mirrors the exact guard in the owning reducer file).
 */
const SUPPLEMENTARY_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  'workplace.recordContribution': ['ActivityAttempt:completed'],
  'workplace.sealProductionRevision': ['ActivityAttemptContribution'],
  'workplace.presentCandidateSet': ['WorkplaceProductionRevision'],
  'workplace.runAuthorGate': ['CandidateSet:author', 'CheckPlan'],
  'workplace.runFinalGate': ['CandidateSet:reviewer', 'CheckPlan'],
  'workplace.admitWorkIntent': [], // role pin is synthetic; reviewer entry via openReviewerDesk edge
  'workplace.recordFinalAcceptance': ['AcceptedCandidateAuthority'],
  'workplace.settleEffect': ['AcceptedCandidateAuthority'],
  'workplace.closePresentation': ['CellFinalAcceptance'],
  'workplace.issueWorkplaceTerminalProof': ['CellFinalAcceptance', 'ObligationCompletionReceipt'],
  'factoryRun.start': ['CapsuleIngressReceipt'],
  'factoryRun.recordRunTerminalProof': ['CapsuleIngressReceipt', 'TerminalClaimCoverage'],
  'lifecycleRun.verifyTerminalClaims': ['TerminalLifecycleClaim', 'ConstructionSurface'],
  'lifecycleRun.issueTerminalProof': ['LifecycleRoutingReceipt', 'TerminalClaimCoverage', 'TerminalLifecycleClaim', 'ConstructionSurface'],
  'nodeRun.recordCellAcceptance': ['CellFinalAcceptance', 'WorkItemDependency'],
  'nodeRun.recordProviderOutcome': ['AcceptedCandidateAuthority'],
  'nodeRun.fail': ['RecoveryIssue', 'EffectReceipt:policy-terminal'],
  'activityAttempt.create': ['WorkIntent'],
  'activityAttempt.admitProviderRequest': ['PromptAssemblyReceipt:admitted'],
  'cognition.sendProviderRequest': ['PromptAssemblyReceipt:admitted'],
  'workItem.planGraph': ['TerminalLifecycleClaim', 'ConstructionSurface', 'TerminalClaimCoverage'],
  'stageRun.recordLocalOutcome': ['ObligationCompletionReceipt'],
  'processRun.settle': ['ObligationCompletionReceipt'],
};

const requiredKindsCache = new Map<string, { evidence: EvidenceKind[]; proofs: ProofKind[] }>();

/** Evidence kinds command C consumes: closures + consumers + producer arrows + guards. */
function requiredKindsOf(command: CommandName, includeProofClosures = true): { evidence: EvidenceKind[]; proofs: ProofKind[] } {
  const cacheKey = `${command}|${includeProofClosures ? 1 : 0}`;
  const cached = requiredKindsCache.get(cacheKey);
  if (cached) return cached;
  const computed = computeRequiredKindsOf(command, includeProofClosures);
  requiredKindsCache.set(cacheKey, computed);
  return computed;
}

function computeRequiredKindsOf(command: CommandName, includeProofClosures: boolean): { evidence: EvidenceKind[]; proofs: ProofKind[] } {
  const evidence = new Set<EvidenceKind>();
  const proofs = new Set<ProofKind>();
  if (includeProofClosures) {
    for (const proof of PROOFS) {
      if (proof.issuingCommand.includes(command)) {
        for (const closureEntry of proof.requiredEvidenceClosure) {
          if (closureEntry.startsWith('TerminalProof:')) {
            proofs.add(normalizeProofId(closureEntry));
          } else {
            evidence.add(closureEntry as EvidenceKind);
          }
        }
      }
    }
  }
  for (const descriptor of EVIDENCE_DESCRIPTORS) {
    if (descriptor.consumers.some((consumer) => consumer.includes(command))) {
      evidence.add(descriptor.id);
    }
    // Arrow-shaped producers ("source -> consuming command"): the command on
    // the right consumes the kind (e.g. "capsule planning facts ->
    // workItem.planGraph").
    if (descriptor.producer.includes('->') && descriptor.producer.includes(command)) {
      const right = descriptor.producer.split('->')[1] ?? '';
      if (right.includes(command)) evidence.add(descriptor.id);
    }
  }
  for (const kind of SUPPLEMENTARY_REQUIREMENTS[command] ?? []) {
    evidence.add(kind as EvidenceKind);
  }
  return { evidence: [...evidence].sort(), proofs: [...proofs].sort() };
}

const staticAncestorsCache = new Map<CommandName, CommandName[]>();

/** The commands that must (may) precede `target` per the frozen universe. */
export function staticAncestors(target: CommandName): CommandName[] {
  const cached = staticAncestorsCache.get(target);
  if (cached) return cached;
  const computed = computeStaticAncestors(target);
  staticAncestorsCache.set(target, computed);
  return computed;
}

function computeStaticAncestors(target: CommandName): CommandName[] {
  const depends = new Map<CommandName, Set<CommandName>>();
  const addEdge = (to: CommandName, from: CommandName): void => {
    if (to === from) return;
    let set = depends.get(to);
    if (!set) {
      set = new Set<CommandName>();
      depends.set(to, set);
    }
    set.add(from);
  };
  // Obligation edges: the target command needs its source command first.
  for (const obligation of OBLIGATIONS) {
    addEdge(obligation.target, obligation.source);
  }
  // Wait edges: a wake command needs a creator of the wait it discharges.
  for (const wait of WAITS) {
    for (const wakeCommand of wait.wakeCommands) {
      for (const descriptor of COMMANDS) {
        if (descriptor.waits.includes(wait.kind)) addEdge(wakeCommand, descriptor.name);
      }
    }
  }
  // WorkIntent edge: an attempt needs the Workplace that admitted its intent.
  addEdge('activityAttempt.create', 'workplace.admitWorkIntent');
  // Status-machine edges: a command needs a command that can produce one of
  // the statuses it is legal from (state-machine prerequisites the pure
  // obligation/evidence graph cannot express).
  for (const reducer of REDUCERS) {
    const statusProducers = new Map<string, CommandName[]>();
    for (const rule of reducer.transitions) {
      if (rule.toStatus === '*') continue;
      const list = statusProducers.get(rule.toStatus) ?? [];
      list.push(rule.command);
      statusProducers.set(rule.toStatus, list);
    }
    for (const rule of reducer.transitions) {
      for (const status of rule.fromStatuses) {
        for (const producer of statusProducers.get(status) ?? []) {
          addEdge(rule.command, producer);
        }
      }
    }
  }
  // Guard-known cross-aggregate prerequisite: a node instance materializes
  // only while a process is node-entered (nodeRun.create guard).
  addEdge('nodeRun.create', 'processRun.enterNode');
  // Evidence edges: a command needs the producers of the kinds it consumes.
  for (const descriptor of COMMANDS) {
    const { evidence, proofs } = requiredKindsOf(descriptor.name);
    for (const kind of evidence) {
      if ((EXTERNAL_INPUT_KINDS as readonly string[]).includes(kind) || (LEDGER_PRODUCED_KINDS as readonly string[]).includes(kind)) continue;
      for (const producer of producerCommandsOfKind(kind)) {
        addEdge(descriptor.name, producer);
      }
    }
    for (const proofId of proofs) {
      for (const proof of PROOFS) {
        if (proof.id === proofId) {
          for (const command of COMMANDS) {
            if (proof.issuingCommand.includes(command.name)) addEdge(descriptor.name, command.name);
          }
        }
      }
    }
  }
  const seen = new Set<CommandName>();
  const queue: CommandName[] = [target];
  while (queue.length > 0) {
    const current = queue.shift() as CommandName;
    for (const dependency of depends.get(current) ?? []) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  seen.delete(target);
  return [...seen].sort();
}

/* ------------------------------------------------------------------ */
/* Durable-handoff applicability law                                   */
/* ------------------------------------------------------------------ */

/**
 * Commands exempt from the open-obligation precondition. Each exemption is
 * a universe fact, not a convenience:
 *   - operator/ingress commands (stop, watchdog observation, capsule
 *     ingress, cancellation, continuation; resume is wake-driven);
 *   - own-aggregate settlement (terminal proofs of the owning scope);
 *   - WorkIntent-launched (attempt creation and outcome path);
 *   - verdict/evidence-driven repair and human-wait entries;
 *   - kernel autonomy (module activation, cell materialization, node
 *     terminal recording, kernel results, the planning authority).
 */
const DURABLE_HANDOFF_EXEMPT: readonly CommandName[] = [
  'factoryRun.bootstrap',
  'factoryRun.importCapsule',
  'factoryRun.requestStop',
  'factoryRun.observeWatchdog',
  'factoryRun.recordRunTerminalProof',
  'lifecycleRun.createContinuation',
  'lifecycleRun.cancel',
  'lifecycleRun.issueTerminalProof',
  'stageRun.activate',
  'processRun.recordNodeTerminal',
  'nodeRun.create',
  'nodeRun.materializeCell',
  'nodeRun.recordKernelResult',
  'workplace.admitWorkIntent',
  'workplace.enterRepairWait',
  'workplace.rolloverRepairEpoch',
  'workplace.widenAuthorityScope',
  'workplace.enterHumanWait',
  'workplace.resolveHumanResponse',
  'workplace.recordFinalAcceptance',
  'workplace.issueWorkplaceTerminalProof',
  'activityAttempt.create',
  'activityAttempt.recordProviderRefusal',
  'activityAttempt.recordOutcome',
  'activityAttempt.classifyWorkerLoss',
  'activityAttempt.cancel',
  'workItem.planGraph',
];

function openObligationTargets(world: KernelWorld): Set<CommandName> {
  const targets = new Set<CommandName>();
  for (const obligation of world.obligations) {
    if (obligation.state === 'open') targets.add(obligation.target);
  }
  return targets;
}

function wakeCommandsOf(world: KernelWorld): Set<CommandName> {
  const wakes = new Set<CommandName>();
  for (const wait of world.waits) {
    if (wait.state === 'pending') {
      for (const command of wait.wakeCommands) wakes.add(command);
    }
  }
  return wakes;
}

function intentCompletionCommands(world: KernelWorld): Set<CommandName> {
  const commands = new Set<CommandName>();
  for (const intent of world.workIntents.values()) commands.add(intent.completionCommand);
  return commands;
}

/* ------------------------------------------------------------------ */
/* Command application (the pure reference machine)                     */
/* ------------------------------------------------------------------ */

/** Deliberate mutation injection points (tests only; never default). */
export interface MutationSeeds {
  /** Mutation e: accept a stale expected revision (must turn invariants red). */
  readonly disableRevisionFence?: boolean;
  /** Mutation f: accept a duplicate idempotency key twice. */
  readonly disableIdempotency?: boolean;
  /** Mutation g: leave a dead predecessor's dependant wait pending. */
  readonly disableDeadWakeConversion?: boolean;
  /** Mutation a: drop the successor obligations a command must create. */
  readonly dropSuccessorObligations?: boolean;
  /** Mutation c: terminalize from empty work (empty closure accepted). */
  readonly acceptEmptyClosureProofs?: boolean;
}

const ALLOWED_INPUT_KEYS: readonly string[] = [
  'command',
  'instanceId',
  'expectedRevision',
  'idempotencyKey',
  'evidenceRefs',
  'rolePin',
  'protocolRole',
  'workIntentRef',
  'gateVerdict',
  'effectOutcome',
  'terminalOutcome',
  'stageRoute',
];

export interface ApplyResult {
  readonly world: KernelWorld;
  readonly outcome: CommandOutcome;
}

function isCreationCommand(command: string): boolean {
  const descriptor = COMMANDS.find((entry) => entry.name === command);
  if (!descriptor) return false;
  const reducer = REDUCERS.find((entry) => entry.aggregate === descriptor.aggregate);
  if (!reducer) return false;
  const rule = reducer.transitions.find((entry) => entry.command === command);
  return rule ? rule.fromStatuses.length === 0 : false;
}

/** Which declared proofs does this input select? */
function selectedOutcome(command: CommandName, input: CommandInput): string {
  if (input.terminalOutcome !== undefined) return input.terminalOutcome;
  if (command === 'lifecycleRun.cancel') return 'cancellation';
  if (command === 'nodeRun.recordCellAcceptance' || command === 'workplace.recordFinalAcceptance') return 'success';
  if (command === 'nodeRun.settleUnreachable') return 'unreachable';
  if (command === 'nodeRun.fail' || command === 'processRun.settleFailure') return 'truthful-failure';
  if (command === 'workplace.issueWorkplaceTerminalProof') return 'success';
  if (input.gateVerdict === 'terminal-reject' || input.effectOutcome === 'policy-terminal') return 'truthful-failure';
  return 'none';
}

function proofMatchesOutcome(proofId: string, selector: string): boolean {
  if (selector === 'none') return false;
  const outcome = proofId.split('.')[1];
  if (selector === 'accepted' || selector === 'success' || selector === 'already-applied' || selector === 'repair' || selector === 'retryable' || selector === 'unknown' || selector === 'human-wait') {
    return outcome === 'success';
  }
  return outcome === selector;
}

function shouldCreateWait(kind: WaitKind, input: CommandInput, nextStatus: string): boolean {
  switch (kind) {
    case 'TypedWait:readiness':
      return nextStatus.endsWith('readiness-waited');
    case 'TypedWait:policy-quota':
      return nextStatus === 'stop-requested';
    case 'TypedWait:human-input':
      return input.gateVerdict === 'human-wait' || input.effectOutcome === 'human-wait' || nextStatus === 'human-wait-entered' || nextStatus === 'effect-human-waited';
    case 'TypedWait:effect-uncertainty':
      return input.effectOutcome === 'unknown' || nextStatus === 'effect-uncertainty-waited' || nextStatus === 'provider-uncertainty-waited';
    case 'TypedWait:external-availability':
      return nextStatus === 'worker-loss-classified';
    default:
      return false;
  }
}

function computeWitness(
  nextStatus: string,
  obligations: readonly ObligationRecord[],
  waits: readonly WaitRecord[],
  reducer: AggregateReducer,
  command: string,
): ProgressWitness | undefined {
  const open = obligations.filter((obligation) => obligation.state === 'open');
  if (open.length > 0) return { kind: 'runnable-obligation', obligationKind: open[0].kind };
  const pending = waits.filter((wait) => wait.state === 'pending');
  if (pending.length > 0) return { kind: 'typed-wait', waitKind: pending[0].kind };
  if (reducer.statelessBoundary === true) return { kind: 'committed-transition', nextStatus };
  const hasSuccessor = reducer.transitions.some((rule) => rule.command !== command && rule.fromStatuses.includes(nextStatus));
  if (hasSuccessor) return { kind: 'committed-transition', nextStatus };
  return undefined;
}

export function applyCommand(world: KernelWorld, input: CommandInput, mutations?: MutationSeeds): ApplyResult {
  const refuseHere = (reason: import('./types.js').RefusalReason, detail: string): ApplyResult => ({
    world,
    outcome: { refused: true, reason, detail } as TypedRefusal,
  });

  // Strict closed input shape: no free-form payload and no manifest field an
  // attempt could re-resolve (mutation j).
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.includes(key)) {
      return refuseHere('ATTEMPT_RERESOLVED_MANIFEST', `command input key "${key}" is not part of the closed command shape (no manifest, no metadata bag)`);
    }
  }

  const resolved = reducerForCommand(input.command);
  if (!resolved) {
    return refuseHere('UNKNOWN_COMMAND', `${input.command} is not declared in the frozen transition universe`);
  }
  const { reducer, descriptor } = resolved;
  if (!reducer.ownedCommands.includes(input.command)) {
    return refuseHere('COMMAND_NOT_OWNED_BY_AGGREGATE', `${input.command} belongs to ${descriptor.aggregate}, not to ${reducer.aggregate}`);
  }

  const head = world.heads.get(input.instanceId);
  const matching = reducer.transitions.filter((rule) => {
    if (rule.command !== input.command) return false;
    const statusOk = rule.fromStatuses.length === 0 ? head === undefined : head !== undefined && rule.fromStatuses.includes(head.status);
    const appliesOk = rule.applies === undefined || rule.applies(input);
    return statusOk && appliesOk;
  });
  if (matching.length === 0) {
    return refuseHere('ILLEGAL_TRANSITION', `${input.command} has no legal edge for ${reducer.aggregate} ${input.instanceId} in status ${head?.status ?? '<uncreated>'}`);
  }
  const rule = matching[0];

  // CAS fence (expected revision compare-and-set).
  const currentRevision = head?.revision ?? 0;
  if (!mutations?.disableRevisionFence && input.expectedRevision !== currentRevision) {
    return refuseHere('STALE_EXPECTED_REVISION', `${input.command} expected revision ${input.expectedRevision}, current is ${currentRevision}`);
  }

  // Idempotency: the same key never commits twice.
  if (!mutations?.disableIdempotency) {
    const recorded = world.idempotency.get(input.idempotencyKey);
    if (recorded) {
      return { world, outcome: { replayed: true, idempotencyKey: input.idempotencyKey, originalEventSequence: recorded.eventSequence } };
    }
  }

  // Durable-handoff applicability.
  if (!DURABLE_HANDOFF_EXEMPT.includes(input.command)) {
    const lawful =
      openObligationTargets(world).has(input.command) ||
      wakeCommandsOf(world).has(input.command) ||
      intentCompletionCommands(world).has(input.command);
    if (!lawful) {
      return refuseHere('ILLEGAL_TRANSITION', `${input.command} runs only behind an open obligation, a pending wake source or an admitted WorkIntent (durable handoff)`);
    }
  }

  // Guard (evidence, roles, terminality).
  const guard = reducer.guards[input.command];
  const evidenceMap = new Map(world.evidence.map((fact) => [fact.ref, fact]));
  const guardContext = {
    evidence: evidenceMap,
    proofs: world.proofs,
    openObligations: world.obligations.filter((obligation) => obligation.state === 'open'),
    pendingWaits: world.waits.filter((wait) => wait.state === 'pending'),
    workIntents: world.workIntents,
    heads: [...world.heads.values()],
  };
  let guardResult: GuardResult | undefined;
  if (guard) {
    const result = guard(input, head, guardContext);
    if ('refused' in result) return { world, outcome: result };
    guardResult = result;
  }

  /* ---------------- commit ---------------- */

  const nextStatus = rule.toStatus === '*' ? (head ? head.status : reducer.initialStatus) : rule.toStatus;
  const nextRevision = currentRevision + 1;
  const sequence = world.sequence + 1;

  const event: WorkflowEventRecord | null =
    descriptor.emitsEvents.length > 0
      ? {
          kind: descriptor.emitsEvents[0],
          sourceOwner: reducer.aggregate,
          sourceInstanceId: input.instanceId,
          sourceRevision: nextRevision,
          transition: input.command,
          evidenceRefs: input.evidenceRefs ?? [],
          sequence,
        }
      : null; // cognition.sendProviderRequest declares no event (universe-faithful)

  // Obligations (fan-out is explicit; one row per target-owner edge).
  const obligationKinds = mutations?.dropSuccessorObligations ? [] : (rule.obligations ?? descriptor.createsObligations);
  const obligations: ObligationRecord[] = obligationKinds.map((kind) => {
    const spec = OBLIGATIONS.find((entry) => entry.kind === kind);
    const target = spec ? spec.target : input.command;
    const targetDescriptor: CommandDescriptor | undefined = COMMANDS.find((entry) => entry.name === target);
    const targetCreates = targetDescriptor ? isCreationCommand(target) : true;
    return {
      kind,
      source: input.command,
      sourceInstanceId: input.instanceId,
      target,
      targetAggregate: targetDescriptor ? targetDescriptor.aggregate : reducer.aggregate,
      targetInstanceId: targetCreates ? null : target === input.command ? input.instanceId : null,
      evidenceRefs: input.evidenceRefs ?? [],
      state: 'open',
      idempotencyKey: `${input.idempotencyKey}#${kind}`,
    };
  });

  // Waits: declared kinds whose condition holds, each with its exact durable
  // wake source(s) - a wait without a wake source is unconstructible (mutation d).
  const waitKinds = descriptor.waits.filter((kind) => shouldCreateWait(kind, input, nextStatus));
  const waits: WaitRecord[] = [];
  for (const kind of waitKinds) {
    const spec = WAITS.find((entry) => entry.kind === kind);
    if (!spec || (spec.wakeCommands.length === 0 && spec.wakeObligationKinds.length === 0)) {
      return refuseHere('WAIT_WITHOUT_WAKE_SOURCE', `wait kind ${kind} has no durable wake source`);
    }
    waits.push({
      kind,
      ownerAggregate: reducer.aggregate,
      ownerInstanceId: input.instanceId,
      wakeCommands: spec.wakeCommands,
      wakeObligationKinds: spec.wakeObligationKinds,
      ...(spec.deadWakeConversion ? { deadWakeConversion: spec.deadWakeConversion } : {}),
      state: 'pending',
    });
  }

  // Proofs: the declared proofs matching the chosen outcome, with the exact
  // evidence closure from the frozen registry (same-transaction facts
  // appended per D11/R3).
  const selector = selectedOutcome(input.command, input);
  const issuedProofs: {
    readonly id: ProofKind;
    readonly evidenceClosure: readonly string[];
    readonly memberDispositions?: readonly import('./types.js').MemberDisposition[];
  }[] = [];
  const proofs: ProofRecord[] = [];
  for (const declared of descriptor.proofs) {
    const proofId = normalizeProofId(declared);
    if (!proofMatchesOutcome(proofId, selector)) continue;
    const registry = PROOFS.find((entry) => entry.id === proofId);
    const sameTransaction = producedKinds(input.command, input);
    const closure: string[] = [];
    if (registry) {
      for (const closureEntry of registry.requiredEvidenceClosure) {
        closure.push(closureEntry.startsWith('TerminalProof:') ? normalizeProofId(closureEntry) : closureEntry);
      }
    }
    for (const kind of sameTransaction) {
      if (registry?.requiredEvidenceClosure.includes(kind) && !closure.includes(kind)) closure.push(kind);
    }
    if (mutations?.acceptEmptyClosureProofs) {
      closure.length = 0;
    } else if (closure.length === 0) {
      // An unexplained proof is never committed: terminalization has an
      // exact proof; an empty queue is never a proof (mutation c).
      return refuseHere('EMPTY_WORK_IS_NOT_A_PROOF', `${proofId} would commit with an empty evidence closure`);
    } else {
      // The frozen failure closures list ALTERNATIVE causes (gate
      // terminal-reject, policy-terminal, D6 repair terminality); the owning
      // guards enforce the exact disjunction. The engine's belt-and-braces
      // check is therefore disjunctive: at least one pre-existing closure
      // entry must be present (an empty pre-existing set fails).
      const anyPresent =
        closure.some((entry) =>
          entry.startsWith('TerminalProof:')
            ? world.proofs.some((proof) => proof.id === entry)
            : [...evidenceMap.values()].some((fact) => fact.kind === entry),
        ) || closure.some((entry) => sameTransaction.includes(entry as EvidenceKind));
      if (!anyPresent) {
        return refuseHere('MISSING_EVIDENCE', `${proofId} closure references absent evidence`);
      }
    }
    const memberDispositions = guardResult?.memberDispositions;
    issuedProofs.push({ id: proofId, evidenceClosure: closure, ...(memberDispositions ? { memberDispositions } : {}) });
    proofs.push({
      id: proofId,
      scope: registry?.scope ?? proofId.split(':')[1].split('.')[0],
      ownerAggregate: reducer.aggregate,
      ownerInstanceId: input.instanceId,
      evidenceClosure: closure,
      ...(memberDispositions ? { memberDispositions } : {}),
    });
  }

  // Evidence facts produced by this command (+ the ledger co-requisites).
  const produced = producedKinds(input.command, input);
  const newEvidence: EvidenceFact[] = produced.map((kind) => ({
    kind,
    ref: `evidence:${kind}#${sequence}`,
    producer: input.command,
    payloadDigest: createHash('sha256').update(`${kind}:${input.idempotencyKey}`, 'utf8').digest('hex'),
  }));
  newEvidence.push({ kind: 'TransitionObligation', ref: `evidence:TransitionObligation#${sequence}`, producer: input.command });
  if (event) newEvidence.push({ kind: 'WorkflowEvent', ref: `evidence:WorkflowEvent#${sequence}`, producer: input.command });

  // WorkIntent record creation (the immutable launch intent).
  const workIntents = new Map(world.workIntents);
  if (input.command === 'workplace.admitWorkIntent' && input.rolePin) {
    const intentRef = `evidence:WorkIntent#${sequence}`;
    workIntents.set(intentRef, {
      intentRef,
      workItemRef: (input.evidenceRefs ?? [])[0] ?? 'workitem:planning',
      workplaceInstanceId: input.instanceId,
      workplaceExpectedRevision: nextRevision,
      completionCommand: 'activityAttempt.recordOutcome',
      protocolRole: input.protocolRole ?? 'author',
      roleContract: input.rolePin,
      inputEvidenceRefs: input.evidenceRefs ?? [],
    });
  }

  // Obligation completion: the leased obligation targeting THIS command
  // completes in the same transaction (with its completion receipt).
  const obligationsAfter = world.obligations.map((obligation) => ({ ...obligation }));
  let leased = 0;
  for (const obligation of obligationsAfter) {
    if (leased >= 1) break;
    if (obligation.state === 'open' && obligation.target === input.command) {
      obligation.state = 'completed';
      obligation.completionEvidenceRef = `evidence:ObligationCompletionReceipt#${sequence}`;
      leased += 1;
    }
  }
  if (leased > 0) {
    newEvidence.push({ kind: 'ObligationCompletionReceipt', ref: `evidence:ObligationCompletionReceipt#${sequence}`, producer: input.command });
  }
  obligationsAfter.push(...obligations);

  // Wake discharges (D5).
  const completedKinds = new Set(
    obligationsAfter
      .filter((obligation) => obligation.state === 'completed' && obligation.completionEvidenceRef === `evidence:ObligationCompletionReceipt#${sequence}`)
      .map((obligation) => obligation.kind),
  );
  let wakeDischarged = false;
  const waitsAfter = world.waits.map((wait) => {
    if (wait.state !== 'pending') return wait;
    if (wakeDischarged) return wait;
    if (wait.wakeCommands.includes(input.command)) {
      wakeDischarged = true;
      const dischargeKind = 'WakeDischarge:human-response-command';
      newEvidence.push({ kind: dischargeKind, ref: `evidence:WakeDischarge#${sequence}:${wait.kind}`, producer: input.command });
      return { ...wait, state: 'discharged' as const, dischargeEvidenceRef: `evidence:WakeDischarge#${sequence}:${wait.kind}` };
    }
    if (wait.wakeObligationKinds.some((kind) => completedKinds.has(kind))) {
      const dischargeKind = wait.kind === 'TypedWait:external-availability' ? 'WakeDischarge:external-availability-event' : 'ObligationCompletionReceipt';
      newEvidence.push({ kind: dischargeKind, ref: `evidence:WakeDischarge#${sequence}:${wait.kind}`, producer: input.command });
      return { ...wait, state: 'discharged' as const, dischargeEvidenceRef: `evidence:WakeDischarge#${sequence}:${wait.kind}` };
    }
    return wait;
  });
  waitsAfter.push(...waits);

  // D7 dead-wake conversion: a terminally failed predecessor converts every
  // dependant readiness wait into explicit unreachable settlement work.
  const failureCommitted = proofs.some((proof) => proof.id.endsWith('.truthful-failure') || proof.id.endsWith('.unreachable'));
  if (failureCommitted && !mutations?.disableDeadWakeConversion) {
    let conversionOccurred = false;
    for (let index = 0; index < waitsAfter.length; index += 1) {
      const wait = waitsAfter[index];
      if (wait.state === 'pending' && wait.kind === 'TypedWait:readiness') {
        waitsAfter[index] = { ...wait, state: 'converted' };
        conversionOccurred = true;
      }
    }
    if (conversionOccurred) {
      newEvidence.push({ kind: 'SettlementWorkObligation', ref: `evidence:SettlementWorkObligation#${sequence}`, producer: input.command });
      obligationsAfter.push({
        kind: 'obligation:markDependantsUnreachable',
        source: input.command,
        sourceInstanceId: input.instanceId,
        target: 'nodeRun.settleUnreachable',
        targetAggregate: 'NodeRun',
        targetInstanceId: null,
        evidenceRefs: [],
        state: 'open',
        idempotencyKey: `${input.idempotencyKey}#settle-unreachable`,
      });
    }
  }

  // New head.
  const heads = new Map(world.heads);
  const terminalProof = rule.terminal ? proofs[0]?.id : undefined;
  heads.set(input.instanceId, {
    aggregate: reducer.aggregate,
    instanceId: input.instanceId,
    revision: nextRevision,
    status: nextStatus,
    ...(terminalProof ? { terminal: terminalProof } : {}),
  });

  // Instance counter bump on creation (deterministic fresh ids).
  const instanceCounters = { ...world.instanceCounters };
  if (head === undefined) {
    instanceCounters[reducer.aggregate] = (instanceCounters[reducer.aggregate] ?? 0) + 1;
  }

  // Write-time progress invariant: a committed nonterminal result must keep
  // a runnable obligation, a typed wait, or a legal successor edge.
  const witness = computeWitness(nextStatus, obligations, waits, reducer, input.command);
  if (!rule.terminal && witness === undefined) {
    return refuseHere('NONTERMINAL_DEAD_END', `${input.command} would leave ${reducer.aggregate} ${input.instanceId} nonterminal in ${nextStatus} with no obligation, wait or legal successor edge`);
  }

  const plan: CommitPlan = {
    descriptor,
    nextStatus,
    terminal: rule.terminal,
    issuedProofs,
    recordedEvidence: newEvidence,
    createdObligationTargets: obligations.map((obligation) => ({ kind: obligation.kind, target: obligation.target, evidenceRefs: obligation.evidenceRefs })),
    createdWaitKinds: waits.map((wait) => wait.kind),
    progressWitness: witness ?? { kind: 'committed-transition', nextStatus },
  };

  const idempotency = new Map(world.idempotency);
  if (!mutations?.disableIdempotency) {
    idempotency.set(input.idempotencyKey, { eventSequence: sequence });
  }

  const nextWorld: KernelWorld = {
    seed: world.seed,
    heads,
    events: event ? [...world.events, event] : [...world.events],
    obligations: obligationsAfter,
    waits: waitsAfter,
    proofs: [...world.proofs, ...proofs],
    evidence: [...world.evidence, ...newEvidence],
    workIntents,
    idempotency,
    instanceCounters,
    sequence,
  };

  const outcome: CommandOutcome = {
    committed: true,
    event,
    nextRevision,
    plan,
    obligations,
    waits,
    proofs,
    evidence: newEvidence,
  };
  return { world: nextWorld, outcome };
}

/* ------------------------------------------------------------------ */
/* World-level invariant checker                                       */
/* ------------------------------------------------------------------ */

export interface InvariantViolation {
  readonly kind:
    | 'NONTERMINAL_DEAD_END'
    | 'WAIT_WITHOUT_WAKE_SOURCE'
    | 'DEAD_WAKE_SOURCE'
    | 'DUPLICATE_IDEMPOTENCY_KEY'
    | 'EMPTY_CLOSURE_PROOF'
    | 'DUPLICATE_EFFECT'
    | 'UNEXPLAINED_NONTERMINAL'
    | 'REGISTRY_PROBLEM';
  readonly detail: string;
}

/**
 * The world-level invariant oracle used by the mutation tests: a mutated
 * world (or a world produced by a mutated engine) must be named here, or
 * the mutation survived. All checks are pure functions of the world.
 */
export function findInvariantViolations(world: KernelWorld): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const problem of validateRegistry()) {
    violations.push({ kind: 'REGISTRY_PROBLEM', detail: problem });
  }

  const openTargets = openObligationTargets(world);
  const failureProofs = world.proofs.filter((proof) => proof.id.endsWith('.truthful-failure') || proof.id.endsWith('.unreachable'));

  for (const wait of world.waits) {
    if (wait.state !== 'pending') continue;
    if (wait.wakeCommands.length === 0 && wait.wakeObligationKinds.length === 0) {
      violations.push({ kind: 'WAIT_WITHOUT_WAKE_SOURCE', detail: `${wait.kind} on ${wait.ownerInstanceId} has no wake source` });
      continue;
    }
    const wakeObligationsAlive = world.obligations.some((obligation) => obligation.state === 'open' && wait.wakeObligationKinds.includes(obligation.kind));
    const wakeCommandsViable = wait.wakeCommands.length > 0;
    if (!wakeObligationsAlive && !wakeCommandsViable) {
      violations.push({ kind: 'DEAD_WAKE_SOURCE', detail: `${wait.kind} on ${wait.ownerInstanceId} has no live wake source` });
    }
    if (wait.kind === 'TypedWait:readiness' && failureProofs.length > 0) {
      violations.push({ kind: 'DEAD_WAKE_SOURCE', detail: `${wait.kind} on ${wait.ownerInstanceId} stayed pending after a predecessor terminal failure (D7 conversion missing)` });
    }
  }

  const seenKeys = new Set<string>();
  for (const key of world.idempotency.keys()) {
    if (seenKeys.has(key)) violations.push({ kind: 'DUPLICATE_IDEMPOTENCY_KEY', detail: `idempotency key ${key} committed twice` });
    seenKeys.add(key);
  }

  // DUPLICATE_EFFECT (WP-13B residual, fixed 2026-08-26): the exactly-once
  // law is over EFFECT EXECUTION — a producer may record several receipts on
  // the legal D2 outcome ladder (unknown → TypedWait:effect-uncertainty →
  // operator wake → success; retryable → retry → success), so counting every
  // receipt flagged the legal post-uncertainty re-settle. The duplicate the
  // oracle must name is the effect EXECUTED to completion twice: two
  // `EffectReceipt:success` facts for one producer. `already-applied` is the
  // idempotent-replay marker (proof no second execution happened), never a
  // duplicate.
  const successCounts = new Map<string, number>();
  for (const fact of world.evidence) {
    if (fact.kind === 'EffectReceipt:success') {
      successCounts.set(fact.producer, (successCounts.get(fact.producer) ?? 0) + 1);
    }
  }
  for (const [producer, count] of successCounts) {
    if (count > 1) {
      violations.push({ kind: 'DUPLICATE_EFFECT', detail: `producer ${producer} recorded ${count} successful effect receipts (the effect executed twice; retries after unknown/retryable are legal, duplicate success is not)` });
    }
  }

  for (const proof of world.proofs) {
    if (proof.evidenceClosure.length === 0) {
      violations.push({ kind: 'EMPTY_CLOSURE_PROOF', detail: `${proof.id} committed with an empty evidence closure (empty work is not a proof)` });
    }
  }

  for (const head of world.heads.values()) {
    if (head.terminal !== undefined) continue;
    const reducer = REDUCERS.find((entry) => entry.aggregate === head.aggregate);
    if (!reducer) continue;
    if (reducer.terminalStatuses.includes(head.status)) continue;
    if (reducer.statelessBoundary === true) continue; // replaceable transport: always live, owns nothing
    // Structural dead-end detection: a nonterminal status with NO outgoing
    // legal edge is a reducer-table defect (the write-time invariant already
    // guarantees every COMMITTED nonterminal result kept an obligation, a
    // typed wait or a successor edge - spine-end worlds are mid-conveyor,
    // so runtime liveness beyond the per-step witness is not quiescence).
    const hasOpenEdge = reducer.transitions.some((rule) => rule.fromStatuses.includes(head.status));
    if (!hasOpenEdge) {
      violations.push({ kind: 'NONTERMINAL_DEAD_END', detail: `${head.aggregate} ${head.instanceId} is nonterminal in ${head.status} with no outgoing legal edge` });
    }
  }
  void openTargets;

  return violations;
}

/* ------------------------------------------------------------------ */
/* Trace generation                                                    */
/* ------------------------------------------------------------------ */

export interface TraceStep {
  readonly input: CommandInput;
  readonly outcome: CommandOutcome;
}

export interface Trace {
  readonly seed: number;
  readonly target: CommandName;
  readonly steps: readonly TraceStep[];
  readonly reached: boolean;
}

function latestInstance(world: KernelWorld, aggregate: string): InstanceId | undefined {
  let latest: InstanceId | undefined;
  let best = -1;
  for (const head of world.heads.values()) {
    if (head.aggregate === aggregate && head.terminal === undefined && head.revision > best) {
      best = head.revision;
      latest = head.instanceId;
    }
  }
  return latest;
}

function nextInstanceId(world: KernelWorld, aggregate: string): InstanceId {
  const n = (world.instanceCounters[aggregate] ?? 0) + 1;
  const kebab = aggregate.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return `${kebab}:${n}`;
}

/** Target-aware variant preference (derived from the target's requirements). */
export interface VariantPreference {
  readonly gate?: import('./types.js').GateVerdict;
  readonly effect?: import('./types.js').EffectOutcome;
  readonly terminal?: import('./types.js').TerminalOutcome;
  /** Prefer the readiness-waiting admit variant (dead-predecessor traces). */
  readonly readinessFirst?: boolean;
}

const DEFAULT_PREFERENCE: VariantPreference = {};

/** Deterministically synthesize input variants for a command's rule set. */
function inputVariantsFor(world: KernelWorld, command: CommandName, instanceId: InstanceId, expectedRevision: number, ruleIndex: number, preference: VariantPreference = DEFAULT_PREFERENCE): CommandInput[] {
  const base = {
    command,
    instanceId,
    expectedRevision,
    idempotencyKey: `key:${command}:${ruleIndex}:${world.sequence + 1}`,
  };
  const pin = {
    roleContractRef: `sha256:${createHash('sha256').update(`contract:${command}`, 'utf8').digest('hex')}`,
    roleContractDigest: createHash('sha256').update(`contract:${command}:body`, 'utf8').digest('hex'),
  };
  const firstIntentRef = [...world.workIntents.keys()].sort()[0];
  const build = (fields: Partial<CommandInput>): CommandInput => ({ ...base, ...fields }) as CommandInput;

  const order = <T>(values: readonly T[], preferred: T | undefined): T[] => {
    if (preferred === undefined) return [...values];
    return [preferred, ...values.filter((value) => value !== preferred)];
  };

  // Preferred value first (target-aware), then success-shaped defaults: the
  // guided walk must open the reviewer desk (accepted author gate), settle
  // effects (success) and prove success terminals before other variants.
  const variants: CommandInput[] = [];
  for (const verdict of order(['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject', undefined] as const, preference.gate)) {
    variants.push(build({ gateVerdict: verdict }));
  }
  for (const outcome of order(['success', 'already-applied', 'repair', 'retryable', 'unknown', 'human-wait', 'policy-terminal', undefined] as const, preference.effect)) {
    variants.push(build({ effectOutcome: outcome }));
  }
  for (const outcome of order(['success', 'truthful-failure', 'cancellation', 'unreachable', undefined] as const, preference.terminal)) {
    variants.push(build({ terminalOutcome: outcome }));
  }
  for (const route of ['initial-discovery', 'solution-formalization', 'solution-development', 'delivery-release', 'verify-terminal-claims', undefined] as const) {
    variants.push(build({ stageRoute: route }));
  }
  variants.push(build({ evidenceRefs: ['evidence:input'] }));
  if (command === 'workplace.admitWorkIntent') {
    const pairs: { role: 'author' | 'reviewer'; refs: boolean }[] = preference.readinessFirst
      ? [{ role: 'author', refs: false }, { role: 'author', refs: true }, { role: 'reviewer', refs: false }, { role: 'reviewer', refs: true }]
      : [{ role: 'author', refs: true }, { role: 'reviewer', refs: true }, { role: 'author', refs: false }, { role: 'reviewer', refs: false }];
    for (const pair of pairs) {
      variants.push(build({ protocolRole: pair.role, rolePin: pin, ...(pair.refs ? { evidenceRefs: ['evidence:readiness'] } : {}) }));
    }
  }
  if (command === 'activityAttempt.create') {
    const intent = firstIntentRef !== undefined ? world.workIntents.get(firstIntentRef) : undefined;
    if (intent) {
      variants.push(build({ workIntentRef: firstIntentRef, rolePin: intent.roleContract }));
    }
  }
  return variants;
}

function worldKey(world: KernelWorld): string {
  const heads = [...world.heads.entries()].map(([id, head]) => `${id}@${head.status}#${head.revision}`).sort().join(',');
  const obligations = world.obligations.filter((obligation) => obligation.state === 'open').map((obligation) => obligation.kind).sort().join(',');
  return `${heads}|${obligations}|${world.evidence.length}`;
}

interface Expansion {
  readonly input: CommandInput;
  readonly priority: number;
  readonly jitter: number;
}

function enumerateExpansions(world: KernelWorld, allowed: Set<string>, rng: Rng): Expansion[] {
  const expansions: Expansion[] = [];
  let counter = 0;
  for (const descriptor of COMMANDS) {
    if (!allowed.has(descriptor.name)) continue;
    const resolved = reducerForCommand(descriptor.name);
    if (!resolved) continue;
    const { reducer } = resolved;
    const rules = reducer.transitions.filter((rule) => rule.command === descriptor.name);
    const creation = rules.some((rule) => rule.fromStatuses.length === 0);
    const instanceId = creation ? nextInstanceId(world, reducer.aggregate) : latestInstance(world, reducer.aggregate);
    if (!creation && instanceId === undefined) continue;
    const head = instanceId !== undefined ? world.heads.get(instanceId) : undefined;
    if (!creation && (!head || head.terminal !== undefined)) continue;
    const expected = head?.revision ?? 0;
    rules.forEach((_rule, ruleIndex) => {
      for (const variant of inputVariantsFor(world, descriptor.name, instanceId as string, expected, ruleIndex)) {
        counter += 1;
        expansions.push({ input: variant, priority: counter, jitter: rng() });
      }
    });
  }
  return expansions;
}

let cachedDependencyEdges: Map<CommandName, Set<CommandName>> | undefined;

/** The full static dependency edge set (same construction as staticAncestors). */
export function staticDependencyEdges(): Map<CommandName, Set<CommandName>> {
  if (cachedDependencyEdges) return cachedDependencyEdges;
  cachedDependencyEdges = buildStaticDependencyEdges();
  return cachedDependencyEdges;
}

function buildStaticDependencyEdges(): Map<CommandName, Set<CommandName>> {
  const edges = new Map<CommandName, Set<CommandName>>();
  const addEdge = (to: CommandName, from: CommandName): void => {
    if (to === from) return;
    if (!edges.has(to)) edges.set(to, new Set<CommandName>());
    edges.get(to)?.add(from);
  };
  const waitCreators = new Map<WaitKind, CommandName[]>();
  for (const descriptor of COMMANDS) {
    for (const kind of descriptor.waits) {
      const list = waitCreators.get(kind) ?? [];
      list.push(descriptor.name);
      waitCreators.set(kind, list);
    }
  }
  for (const obligation of OBLIGATIONS) addEdge(obligation.target, obligation.source);
  for (const wait of WAITS) {
    for (const wakeCommand of wait.wakeCommands) {
      for (const creator of waitCreators.get(wait.kind) ?? []) addEdge(wakeCommand, creator);
    }
  }
  addEdge('activityAttempt.create', 'workplace.admitWorkIntent');
  for (const reducer of REDUCERS) {
    const statusProducers = new Map<string, CommandName[]>();
    for (const rule of reducer.transitions) {
      if (rule.toStatus === '*') continue;
      const list = statusProducers.get(rule.toStatus) ?? [];
      list.push(rule.command);
      statusProducers.set(rule.toStatus, list);
    }
    for (const rule of reducer.transitions) {
      for (const status of rule.fromStatuses) {
        for (const producer of statusProducers.get(status) ?? []) addEdge(rule.command, producer);
      }
    }
  }
  addEdge('nodeRun.create', 'processRun.enterNode');
  for (const descriptor of COMMANDS) {
    const { evidence, proofs } = requiredKindsOf(descriptor.name);
    for (const kind of evidence) {
      if ((EXTERNAL_INPUT_KINDS as readonly string[]).includes(kind) || (LEDGER_PRODUCED_KINDS as readonly string[]).includes(kind)) continue;
      for (const producer of producerCommandsOfKind(kind)) addEdge(descriptor.name, producer);
    }
    for (const proofId of proofs) {
      for (const proof of PROOFS) {
        if (proof.id === proofId) {
          for (const command of COMMANDS) {
            if (proof.issuingCommand.includes(command.name)) addEdge(descriptor.name, command.name);
          }
        }
      }
    }
  }
  return edges;
}

/**
 * Derive the demand-driven variant preference from a requirement set.
 * Success-first: a command that can issue a success-shaped proof gets the
 * success preference; only commands with NO success-shaped proof (pure
 * failure/unreachable/cancellation settlement) prefer their own outcome.
 */
function preferenceFromRequirements(evidence: readonly EvidenceKind[], proofs: readonly ProofKind[]): VariantPreference {
  const preference: {
    gate?: import('./types.js').GateVerdict;
    effect?: import('./types.js').EffectOutcome;
    terminal?: import('./types.js').TerminalOutcome;
    readinessFirst?: boolean;
  } = {};
  if (evidence.includes('GateDecision:human-wait' as EvidenceKind)) preference.gate = 'human-wait';
  else if (evidence.includes('GateDecision:repair' as EvidenceKind)) preference.gate = 'repair';
  else if (evidence.includes('GateDecision:upstream-repair' as EvidenceKind)) preference.gate = 'upstream-repair';
  else if (evidence.includes('GateDecision:terminal-reject' as EvidenceKind)) preference.gate = 'terminal-reject';
  if (evidence.includes('EffectReceipt:unknown' as EvidenceKind)) preference.effect = 'unknown';
  else if (evidence.includes('EffectReceipt:repair' as EvidenceKind)) preference.effect = 'repair';
  else if (evidence.includes('EffectReceipt:human-wait' as EvidenceKind)) preference.effect = 'human-wait';
  else if (evidence.includes('EffectReceipt:policy-terminal' as EvidenceKind)) preference.effect = 'policy-terminal';
  else if (evidence.includes('EffectReceipt:retryable' as EvidenceKind)) preference.effect = 'retryable';
  const hasSuccess = proofs.some((proofId) => proofId.endsWith('.success'));
  const needsUnreachable = !hasSuccess && proofs.some((proofId) => proofId.endsWith('.unreachable'));
  const needsFailure = !hasSuccess && proofs.some((proofId) => proofId.endsWith('.truthful-failure'));
  const needsCancellation = !hasSuccess && proofs.some((proofId) => proofId.endsWith('.cancellation'));
  if (needsUnreachable) {
    preference.terminal = 'unreachable';
    preference.readinessFirst = true;
  } else if (needsFailure) {
    preference.terminal = 'truthful-failure';
  } else if (needsCancellation) {
    preference.terminal = 'cancellation';
  }
  return preference;
}

/** The target-aware variant preference (its own requirements, success-first). */
function variantPreferenceFor(target: CommandName): VariantPreference {
  // Closure-free: the closure union spans ALL outcomes and would poison the
  // success preference (e.g. settleEffect pulling terminal-reject gates).
  const { evidence, proofs } = requiredKindsOf(target, false);
  const preference = preferenceFromRequirements(evidence, proofs);
  const humanWaitWake = WAITS.some((wait) => wait.kind === 'TypedWait:human-input' && wait.wakeCommands.includes(target));
  if (humanWaitWake && preference.gate === undefined) {
    return { ...preference, gate: 'human-wait' };
  }
  return preference;
}

/** Try to commit the target DIRECTLY from a seed world (cheap path). */
function directCommitFrom(world: KernelWorld, target: CommandName, seed: number, preference: VariantPreference): TraceStep[] | undefined {
  const resolved = reducerForCommand(target);
  if (!resolved) return undefined;
  const rules = resolved.reducer.transitions.filter((rule) => rule.command === target);
  const creation = rules.some((rule) => rule.fromStatuses.length === 0);
  if (creation) return undefined;
  const instances = [...world.heads.values()]
    .filter((head) => head.aggregate === resolved.reducer.aggregate && head.terminal === undefined)
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  for (const head of instances) {
    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
      for (const variant of inputVariantsFor(world, target, head.instanceId, head.revision, ruleIndex, preference)) {
        const applied = applyCommand(world, variant);
        if ('committed' in applied.outcome && applied.outcome.committed) {
          void seed;
          return [{ input: variant, outcome: applied.outcome }];
        }
      }
    }
  }
  return undefined;
}

/**
 * Generate a legal trace reaching `target`. Deterministic given the seed.
 *
 * Strategy: a LAZY dependency-driven walk - try the target first; on refusal,
 * recursively satisfy one static dependency at a time (success-shaped input
 * variants first) and retry, so only commands the target actually needs are
 * committed (destructive siblings are never applied). A bounded
 * breadth-first fallback over the ancestor set retains the seed.
 */
export function generateLegalTrace(target: CommandName, seed = 20260825, maxDepth = 24, frontierCap = 200, start?: { world: KernelWorld; steps: readonly TraceStep[] }): Trace {
  const registryProblems = validateRegistry();
  if (registryProblems.length > 0) {
    throw new Error(`registry invalid: ${registryProblems[0]}`);
  }

  // Phase 1: lazy dependency-driven walk (optionally seeded by a committed
  // prefix world produced while generating another target's trace). Seeded
  // walks try a DIRECT commit first - the cheap common case - before any
  // dependency exploration.
  if (start) {
    const directSeeded = directCommitFrom(start.world, target, seed, variantPreferenceFor(target));
    if (directSeeded) {
      return { seed, target, steps: [...start.steps, ...directSeeded], reached: true };
    }
  }
  const lazy = runLazyWalk(target, seed, start);
  if (lazy.reached) {
    return { seed, target, steps: lazy.steps, reached: true };
  }

  // Phase 2: bounded breadth-first fallback.
  const ancestors = new Set<string>(staticAncestors(target));
  ancestors.add(target);
  const rng = mulberry32(seed);
  const frontierStart = { world: createWorld(seed), steps: [] as TraceStep[] };
  let frontier = [frontierStart];
  const visited = new Set<string>([worldKey(frontierStart.world)]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const nextFrontier: { world: KernelWorld; steps: TraceStep[] }[] = [];
    for (const entry of frontier) {
      const expansions = enumerateExpansions(entry.world, ancestors, rng).sort((a, b) => a.priority - b.priority || a.jitter - b.jitter);
      for (const expansion of expansions) {
        const applied = applyCommand(entry.world, expansion.input);
        if (!('committed' in applied.outcome) || !applied.outcome.committed) continue;
        const steps = [...entry.steps, { input: expansion.input, outcome: applied.outcome }];
        if (expansion.input.command === target) {
          return { seed, target, steps, reached: true };
        }
        const key = worldKey(applied.world);
        if (visited.has(key)) continue;
        visited.add(key);
        nextFrontier.push({ world: applied.world, steps });
        if (nextFrontier.length >= frontierCap) break;
      }
      if (nextFrontier.length >= frontierCap) break;
    }
    frontier = nextFrontier;
  }
  return { seed, target, steps: [], reached: false };
}


/* ------------------------------------------------------------------ */
/* Illegal traces + minimization                                       */
/* ------------------------------------------------------------------ */

/** Apply a step list to a fresh world; stops at the first refusal. */
export function runSteps(steps: readonly CommandInput[], seed = 20260825): { world: KernelWorld; steps: readonly TraceStep[]; refusal: TypedRefusal | undefined } {
  let world = createWorld(seed);
  const traced: TraceStep[] = [];
  for (const input of steps) {
    const applied = applyCommand(world, input);
    traced.push({ input, outcome: applied.outcome });
    if (!('committed' in applied.outcome)) {
      return { world, steps: traced, refusal: applied.outcome as TypedRefusal };
    }
    world = applied.world;
  }
  return { world, steps: traced, refusal: undefined };
}

/**
 * Minimize a failing trace by delta debugging: repeatedly try dropping
 * single steps; keep a drop when the predicate still holds on the shorter
 * trace. The seed is retained inside every intermediate run.
 */
export function minimizeTrace(
  steps: readonly CommandInput[],
  predicate: (run: { world: KernelWorld; steps: readonly TraceStep[]; refusal: TypedRefusal | undefined }) => boolean,
  seed = 20260825,
): { steps: readonly CommandInput[]; minimized: boolean } {
  let current = [...steps];
  let minimized = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const candidate = current.slice(0, index).concat(current.slice(index + 1));
      const run = runSteps(candidate, seed);
      if (predicate(run)) {
        current = candidate;
        minimized = true;
        changed = true;
      }
    }
  }
  return { steps: current, minimized };
}

/**
 * The lazy dependency-driven walk shared by generateLegalTrace and
 * explainTraceFailure. Try the target first; on refusal, recursively satisfy
 * the producers of whatever the target is still missing (goal regression),
 * pushing each command's own requirement preference down to its
 * dependencies; retry after every dependency progress.
 */
/**
 * Per-aggregate instance caps for creation commands: the reference walk
 * models one conveyor cell (plus bounded fan-out), not an instance farm.
 */
const INSTANCE_CAPS: Readonly<Record<string, number>> = {
  FactoryRun: 1,
  LifecycleRun: 2,
  StageRun: 2,
  ProcessRun: 2,
  NodeRun: 6,
  Workplace: 4,
  ActivityAttempt: 6,
  WorkItem: 4,
};
const INSTANCE_CAP_DEFAULTS = INSTANCE_CAPS;

function runLazyWalk(target: CommandName, seed: number, start?: { world: KernelWorld; steps: readonly TraceStep[] }, applicationBudget = 180, perCommandCap = 6): {
  readonly reached: boolean;
  readonly steps: readonly TraceStep[];
  readonly world: KernelWorld;
  readonly targetRefusals: readonly TypedRefusal[];
} {
  const edges = staticDependencyEdges();
  const preference = variantPreferenceFor(target);
  let world = start ? start.world : createWorld(seed);
  const steps: TraceStep[] = start ? [...start.steps] : [];
  const targetRefusals: TypedRefusal[] = [];
  const seenRefusals = new Set<string>();
  const inProgress = new Set<CommandName>();
  // Progress-keyed memo: a command is skipped only while the world has not
  // advanced since its last exploration (loops re-enter after progress).
  const exploredAtSequence = new Map<CommandName, number>();
  const applicationCount = new Map<CommandName, number>();
  let applications = 0;
  void applications;

  const preferenceCache = new Map<CommandName, VariantPreference>();
  // The TARGET's own (wake-aware) preference also propagates to children.
  preferenceCache.set(target, preference);
  const preferenceFor = (command: CommandName): VariantPreference => {
    let cached = preferenceCache.get(command);
    if (!cached) {
      // Closure-free requirements: proof-closure unions span ALL outcomes
      // (success AND failure) and would poison the success preference.
      const { evidence, proofs } = requiredKindsOf(command, false);
      cached = preferenceFromRequirements(evidence, proofs);
      preferenceCache.set(command, cached);
    }
    return cached;
  };


  const probe = (command: CommandName, ambient: VariantPreference): { world: KernelWorld; input: CommandInput; outcome: CommandOutcome } | undefined => {
    const resolved = reducerForCommand(command);
    if (!resolved) return undefined;
    const rules = resolved.reducer.transitions.filter((rule) => rule.command === command);
    const creation = rules.some((rule) => rule.fromStatuses.length === 0);
    let instanceIds: InstanceId[];
    if (creation) {
      const existing = [...world.heads.values()].filter((head) => head.aggregate === resolved.reducer.aggregate).length;
      const cap = INSTANCE_CAPS[resolved.reducer.aggregate] ?? 2;
      if (existing >= cap) return undefined;
      instanceIds = [nextInstanceId(world, resolved.reducer.aggregate)];
    } else {
      // Oldest non-terminal instance first: a live attempt must not be
      // starved by later siblings (the author->reviewer loop reuses the
      // workplace; retries reuse the attempt pool).
      instanceIds = [...world.heads.values()]
        .filter((head) => head.aggregate === resolved.reducer.aggregate && head.terminal === undefined)
        .sort((a, b) => (a.revision < b.revision ? -1 : a.instanceId < b.instanceId ? -1 : 1))
        .map((head) => head.instanceId);
    }
    for (const instanceId of instanceIds) {
      const head = world.heads.get(instanceId);
      if (!creation && (!head || head.terminal !== undefined)) continue;
      const expected = head?.revision ?? 0;
      for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
        for (const variant of inputVariantsFor(world, command, instanceId, expected, ruleIndex, ambient)) {
          const applied = applyCommand(world, variant);
          if ('committed' in applied.outcome && applied.outcome.committed) {
            return { world: applied.world, input: variant, outcome: applied.outcome };
          }
          if (command === target && !('replayed' in applied.outcome)) {
            const refusal = applied.outcome as TypedRefusal;
            if (!seenRefusals.has(refusal.detail)) {
              seenRefusals.add(refusal.detail);
              targetRefusals.push(refusal);
            }
          }
        }
      }
    }
    return undefined;
  };

  const commit = (result: { world: KernelWorld; input: CommandInput; outcome: CommandOutcome }): boolean => {
    world = result.world;
    steps.push({ input: result.input, outcome: result.outcome });
    applications += 1;
    applicationCount.set(result.input.command, (applicationCount.get(result.input.command) ?? 0) + 1);
    return true;
  };

  // Goal regression: order dependencies so the producers of the kinds the
  // command is still missing come first - a sibling that produces nothing
  // the command needs can never burn shared state before the real spine.
  const orderDependencies = (command: CommandName): CommandName[] => {
    const dependencies = [...(edges.get(command) ?? [])].sort();
    const { evidence, proofs } = requiredKindsOf(command);
    const presentKinds = new Set(world.evidence.map((fact) => fact.kind));
    const presentProofs = new Set(world.proofs.map((proof) => proof.id));
    const missingProducers = new Set<CommandName>();
    for (const kind of evidence) {
      if (presentKinds.has(kind)) continue;
      for (const producer of producerCommandsOfKind(kind)) missingProducers.add(producer);
    }
    for (const proofId of proofs) {
      if (presentProofs.has(proofId)) continue;
      for (const proof of PROOFS) {
        if (proof.id === proofId) {
          for (const candidate of COMMANDS) {
            if (proof.issuingCommand.includes(candidate.name)) missingProducers.add(candidate.name);
          }
        }
      }
    }
    return dependencies.sort((a, b) => {
      const aScore = missingProducers.has(a) ? 0 : 1;
      const bScore = missingProducers.has(b) ? 0 : 1;
      return aScore - bScore || (a < b ? -1 : 1);
    });
  };

  const applyRec = (command: CommandName, ambient: VariantPreference): boolean => {
    if (applications >= applicationBudget) return false;
    if (inProgress.has(command)) return false;
    if ((applicationCount.get(command) ?? 0) >= perCommandCap) return false;
    const direct = probe(command, ambient);
    if (direct) {
      return commit(direct);
    }
    if (exploredAtSequence.get(command) === world.sequence) return false;
    exploredAtSequence.set(command, world.sequence);
    inProgress.add(command);
    const childPreference = preferenceFor(command);
    // Keep satisfying dependencies while ANY progress is made anywhere in
    // the subtree (deep progress can unlock this command many steps later),
    // re-probing after each progress; the application budget bounds loops.
    let progress = true;
    while (progress && applications < applicationBudget) {
      progress = false;
      for (const dependency of orderDependencies(command)) {
        if (dependency === command) continue;
        const before = applications;
        const applied = applyRec(dependency, childPreference);
        const madeProgress = applied || applications > before;
        if (madeProgress) {
          progress = true;
          const retry = probe(command, ambient);
          if (retry) {
            inProgress.delete(command);
            return commit(retry);
          }
        }
      }
    }
    inProgress.delete(command);
    return false;
  };

  const reached = applyRec(target, preference);
  return { reached, steps, world, targetRefusals };
}

/**
 * Canonical spine scripts (WP-05): explicit, ENGINE-VALIDATED legal traces
 * for the five conveyor spines. Every step goes through applyCommand with
 * full legality, CAS fencing, guards and the write-time invariants - a
 * script step that the model refuses throws immediately, so the scripts
 * cannot rot silently. They are readable witnesses of the frozen universe's
 * happy paths; the generic lazy walk remains the fallback for anything the
 * spines do not exercise.
 */

interface SpineStepSpec {
  readonly command: CommandName;
  readonly instanceId: string;
  readonly revision: number;
  readonly gateVerdict?: import('./types.js').GateVerdict;
  readonly effectOutcome?: import('./types.js').EffectOutcome;
  readonly terminalOutcome?: import('./types.js').TerminalOutcome;
  readonly stageRoute?: import('./types.js').StageRoute;
  readonly protocolRole?: import('./types.js').ProtocolRole;
  readonly evidenceRefs?: readonly string[];
  readonly workIntentRef?: string;
}

function pinFor(seed: number, role: string): { roleContractRef: string; roleContractDigest: string } {
  return {
    roleContractRef: `sha256:${createHash('sha256').update(`spine:${seed}:${role}`, 'utf8').digest('hex')}`,
    roleContractDigest: createHash('sha256').update(`spine:${seed}:${role}:body`, 'utf8').digest('hex'),
  };
}

function runSpine(name: string, seed: number, steps: readonly SpineStepSpec[]): Trace {
  let world = createWorld(seed);
  const traced: TraceStep[] = [];
  let stepIndex = 0;
  for (const spec of steps) {
    const fields: {
      gateVerdict?: import('./types.js').GateVerdict;
      effectOutcome?: import('./types.js').EffectOutcome;
      terminalOutcome?: import('./types.js').TerminalOutcome;
      stageRoute?: import('./types.js').StageRoute;
      protocolRole?: import('./types.js').ProtocolRole;
      evidenceRefs?: readonly string[];
      workIntentRef?: string;
      rolePin?: { roleContractRef: string; roleContractDigest: string };
    } = {};
    if (spec.gateVerdict !== undefined) fields.gateVerdict = spec.gateVerdict;
    if (spec.effectOutcome !== undefined) fields.effectOutcome = spec.effectOutcome;
    if (spec.terminalOutcome !== undefined) fields.terminalOutcome = spec.terminalOutcome;
    if (spec.stageRoute !== undefined) fields.stageRoute = spec.stageRoute;
    if (spec.protocolRole !== undefined) {
      fields.protocolRole = spec.protocolRole;
      fields.rolePin = pinFor(seed, `${spec.command}:${spec.protocolRole}`);
    }
    if (spec.evidenceRefs !== undefined) fields.evidenceRefs = spec.evidenceRefs;
    if (spec.workIntentRef !== undefined) {
      const intent = world.workIntents.get(spec.workIntentRef);
      if (!intent) {
        throw new Error(`spine ${name} step ${stepIndex}: WorkIntent ${spec.workIntentRef} not admitted`);
      }
      fields.workIntentRef = spec.workIntentRef;
      fields.rolePin = { roleContractRef: intent.roleContract.roleContractRef, roleContractDigest: intent.roleContract.roleContractDigest };
    }
    const input: CommandInput = {
      command: spec.command,
      instanceId: spec.instanceId,
      expectedRevision: spec.revision,
      idempotencyKey: `spine:${name}:${stepIndex}`,
      ...fields,
    };
    const applied = applyCommand(world, input);
    if (!('committed' in applied.outcome) || !applied.outcome.committed) {
      const refusal = applied.outcome as TypedRefusal;
      throw new Error(`spine ${name} step ${stepIndex} (${spec.command}) refused: ${refusal.reason}: ${refusal.detail}`);
    }
    traced.push({ input, outcome: applied.outcome });
    world = applied.world;
    stepIndex += 1;
  }
  return { seed, target: steps[steps.length - 1].command, steps: traced, reached: true };
}

/** The full success spine: capsule -> planning -> cell -> gates -> effects -> run proof. */
function successSpine(seed: number): Trace {
  return runSpine('success', seed, [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', revision: 0 },
    { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', revision: 1 },
    { command: 'workItem.planGraph', instanceId: 'work-item:1', revision: 0, evidenceRefs: ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'] },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', revision: 2 },
    { command: 'lifecycleRun.create', instanceId: 'lifecycle-run:1', revision: 0 },
    { command: 'stageRun.create', instanceId: 'stage-run:1', revision: 0 },
    { command: 'stageRun.activate', instanceId: 'stage-run:1', revision: 1 },
    { command: 'processRun.create', instanceId: 'process-run:1', revision: 0 },
    { command: 'processRun.enterNode', instanceId: 'process-run:1', revision: 1 },
    { command: 'nodeRun.create', instanceId: 'node-run:1', revision: 0 },
    { command: 'nodeRun.materializeCell', instanceId: 'node-run:1', revision: 1 },
    { command: 'workplace.materialize', instanceId: 'workplace:1', revision: 0 },
    // Author round.
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 1, protocolRole: 'author', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:1', revision: 0, workIntentRef: 'evidence:WorkIntent#13' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1', revision: 1 },
    { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', revision: 0 },
    { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1', revision: 2 },
    { command: 'workplace.recordContribution', instanceId: 'workplace:1', revision: 2 },
    { command: 'workplace.sealProductionRevision', instanceId: 'workplace:1', revision: 3 },
    { command: 'workplace.presentCandidateSet', instanceId: 'workplace:1', revision: 4 },
    { command: 'workplace.runAuthorGate', instanceId: 'workplace:1', revision: 5, gateVerdict: 'accepted' },
    // Reviewer round.
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 6, protocolRole: 'reviewer', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:2', revision: 0, workIntentRef: 'evidence:WorkIntent#22' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:2', revision: 1 },
    { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', revision: 1 },
    { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:2', revision: 2 },
    { command: 'workplace.recordContribution', instanceId: 'workplace:1', revision: 7 },
    { command: 'workplace.sealProductionRevision', instanceId: 'workplace:1', revision: 8 },
    { command: 'workplace.presentCandidateSet', instanceId: 'workplace:1', revision: 9 },
    { command: 'workplace.runFinalGate', instanceId: 'workplace:1', revision: 10, gateVerdict: 'accepted' },
    { command: 'workplace.settleEffect', instanceId: 'workplace:1', revision: 11, effectOutcome: 'success' },
    { command: 'workplace.recordFinalAcceptance', instanceId: 'workplace:1', revision: 12 },
    { command: 'workplace.closePresentation', instanceId: 'workplace:1', revision: 13 },
    { command: 'workplace.issueWorkplaceTerminalProof', instanceId: 'workplace:1', revision: 14, terminalOutcome: 'success' },
    // Node/process/stage settlement.
    { command: 'nodeRun.recordKernelResult', instanceId: 'node-run:1', revision: 2 },
    { command: 'nodeRun.recordCellAcceptance', instanceId: 'node-run:1', revision: 3 },
    { command: 'processRun.recordNodeTerminal', instanceId: 'process-run:1', revision: 2 },
    { command: 'processRun.settle', instanceId: 'process-run:1', revision: 3, terminalOutcome: 'success' },
    { command: 'stageRun.recordLocalOutcome', instanceId: 'stage-run:1', revision: 2, terminalOutcome: 'success' },
    { command: 'lifecycleRun.routeOutcome', instanceId: 'lifecycle-run:1', revision: 1, stageRoute: 'verify-terminal-claims' },
    { command: 'lifecycleRun.verifyTerminalClaims', instanceId: 'lifecycle-run:1', revision: 2 },
    { command: 'lifecycleRun.issueTerminalProof', instanceId: 'lifecycle-run:1', revision: 3, terminalOutcome: 'success' },
    { command: 'factoryRun.recordRunTerminalProof', instanceId: 'factory-run:1', revision: 3, terminalOutcome: 'success' },
  ]);
}

/** The truthful-failure spine: repair verdict -> repair wait -> epoch caps -> propagation. */
function failureSpine(seed: number): Trace {
  return runSpine('failure', seed, [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', revision: 0 },
    { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', revision: 1 },
    { command: 'workItem.planGraph', instanceId: 'work-item:1', revision: 0, evidenceRefs: ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'] },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', revision: 2 },
    { command: 'lifecycleRun.create', instanceId: 'lifecycle-run:1', revision: 0 },
    { command: 'stageRun.create', instanceId: 'stage-run:1', revision: 0 },
    { command: 'stageRun.activate', instanceId: 'stage-run:1', revision: 1 },
    { command: 'processRun.create', instanceId: 'process-run:1', revision: 0 },
    { command: 'processRun.enterNode', instanceId: 'process-run:1', revision: 1 },
    { command: 'nodeRun.create', instanceId: 'node-run:1', revision: 0 },
    { command: 'nodeRun.materializeCell', instanceId: 'node-run:1', revision: 1 },
    { command: 'workplace.materialize', instanceId: 'workplace:1', revision: 0 },
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 1, protocolRole: 'author', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:1', revision: 0, workIntentRef: 'evidence:WorkIntent#13' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1', revision: 1 },
    { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', revision: 0 },
    { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1', revision: 2 },
    { command: 'workplace.recordContribution', instanceId: 'workplace:1', revision: 2 },
    { command: 'workplace.sealProductionRevision', instanceId: 'workplace:1', revision: 3 },
    { command: 'workplace.presentCandidateSet', instanceId: 'workplace:1', revision: 4 },
    // The gate rejects with a repair verdict; the repair epoch caps exhaust (D6).
    { command: 'workplace.runAuthorGate', instanceId: 'workplace:1', revision: 5, gateVerdict: 'repair' },
    { command: 'workplace.enterRepairWait', instanceId: 'workplace:1', revision: 6 },
    // A second repair round exercises the scope-widening path (FWD:F082).
    { command: 'workplace.widenAuthorityScope', instanceId: 'workplace:1', revision: 7 },
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 8, protocolRole: 'author', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:2', revision: 0, workIntentRef: 'evidence:WorkIntent#24' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:2', revision: 1 },
    { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', revision: 1 },
    { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:2', revision: 2 },
    { command: 'workplace.recordContribution', instanceId: 'workplace:1', revision: 9 },
    { command: 'workplace.sealProductionRevision', instanceId: 'workplace:1', revision: 10 },
    { command: 'workplace.presentCandidateSet', instanceId: 'workplace:1', revision: 11 },
    { command: 'workplace.runAuthorGate', instanceId: 'workplace:1', revision: 12, gateVerdict: 'repair' },
    { command: 'workplace.enterRepairWait', instanceId: 'workplace:1', revision: 13 },
    { command: 'workplace.rolloverRepairEpoch', instanceId: 'workplace:1', revision: 14, terminalOutcome: 'truthful-failure' },
    // Failure propagation: cell failure -> node failure -> process settle-failure.
    { command: 'workplace.issueWorkplaceTerminalProof', instanceId: 'workplace:1', revision: 15, terminalOutcome: 'truthful-failure' },
    { command: 'nodeRun.fail', instanceId: 'node-run:1', revision: 2 },
    { command: 'processRun.recordNodeTerminal', instanceId: 'process-run:1', revision: 2 },
    { command: 'processRun.settleFailure', instanceId: 'process-run:1', revision: 3 },
    { command: 'stageRun.recordLocalOutcome', instanceId: 'stage-run:1', revision: 2, terminalOutcome: 'truthful-failure' },
  ]);
}

/** The human-input / provider spine: human-wait verdict, wake, approval, provider outcome, uncertainty. */
function humanProviderSpine(seed: number): Trace {
  return runSpine('human', seed, [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', revision: 0 },
    { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', revision: 1 },
    { command: 'workItem.planGraph', instanceId: 'work-item:1', revision: 0, evidenceRefs: ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'] },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', revision: 2 },
    { command: 'lifecycleRun.create', instanceId: 'lifecycle-run:1', revision: 0 },
    { command: 'stageRun.create', instanceId: 'stage-run:1', revision: 0 },
    { command: 'stageRun.activate', instanceId: 'stage-run:1', revision: 1 },
    { command: 'processRun.create', instanceId: 'process-run:1', revision: 0 },
    { command: 'processRun.enterNode', instanceId: 'process-run:1', revision: 1 },
    { command: 'nodeRun.create', instanceId: 'node-run:1', revision: 0 },
    { command: 'nodeRun.materializeCell', instanceId: 'node-run:1', revision: 1 },
    { command: 'workplace.materialize', instanceId: 'workplace:1', revision: 0 },
    // Author round accepted (opens the reviewer desk).
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 1, protocolRole: 'author', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:1', revision: 0, workIntentRef: 'evidence:WorkIntent#13' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1', revision: 1 },
    { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', revision: 0 },
    { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1', revision: 2 },
    { command: 'workplace.recordContribution', instanceId: 'workplace:1', revision: 2 },
    { command: 'workplace.sealProductionRevision', instanceId: 'workplace:1', revision: 3 },
    { command: 'workplace.presentCandidateSet', instanceId: 'workplace:1', revision: 4 },
    { command: 'workplace.runAuthorGate', instanceId: 'workplace:1', revision: 5, gateVerdict: 'accepted' },
    // Reviewer round with a human-wait verdict.
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 6, protocolRole: 'reviewer', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:2', revision: 0, workIntentRef: 'evidence:WorkIntent#22' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:2', revision: 1 },
    { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', revision: 1 },
    { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:2', revision: 2 },
    { command: 'workplace.recordContribution', instanceId: 'workplace:1', revision: 7 },
    { command: 'workplace.sealProductionRevision', instanceId: 'workplace:1', revision: 8 },
    { command: 'workplace.presentCandidateSet', instanceId: 'workplace:1', revision: 9 },
    { command: 'workplace.runFinalGate', instanceId: 'workplace:1', revision: 10, gateVerdict: 'human-wait' },
    { command: 'workplace.enterHumanWait', instanceId: 'workplace:1', revision: 11 },
    { command: 'workplace.resolveHumanResponse', instanceId: 'workplace:1', revision: 12 },
    // Human approval node: decision -> release -> provider outcome (unknown).
    { command: 'nodeRun.recordKernelResult', instanceId: 'node-run:1', revision: 2 },
    { command: 'nodeRun.recordHumanDecision', instanceId: 'node-run:1', revision: 3 },
    { command: 'nodeRun.recordProviderOutcome', instanceId: 'node-run:1', revision: 4, effectOutcome: 'success' },
  ]);
}

/** The unreachable spine (D7): failed predecessor converts a dependant's readiness wait. */
function unreachableSpine(seed: number): Trace {
  return runSpine('unreachable', seed, [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', revision: 0 },
    { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', revision: 1 },
    { command: 'workItem.planGraph', instanceId: 'work-item:1', revision: 0, evidenceRefs: ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'] },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', revision: 2 },
    { command: 'lifecycleRun.create', instanceId: 'lifecycle-run:1', revision: 0 },
    { command: 'stageRun.create', instanceId: 'stage-run:1', revision: 0 },
    { command: 'stageRun.activate', instanceId: 'stage-run:1', revision: 1 },
    { command: 'processRun.create', instanceId: 'process-run:1', revision: 0 },
    { command: 'processRun.enterNode', instanceId: 'process-run:1', revision: 1 },
    { command: 'nodeRun.create', instanceId: 'node-run:1', revision: 0 },
    { command: 'nodeRun.materializeCell', instanceId: 'node-run:1', revision: 1 },
    // Cell A (the predecessor that will terminally fail).
    { command: 'workplace.materialize', instanceId: 'workplace:1', revision: 0 },
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 1, protocolRole: 'author', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:1', revision: 0, workIntentRef: 'evidence:WorkIntent#13' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1', revision: 1 },
    { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport', revision: 0 },
    { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1', revision: 2 },
    { command: 'workplace.recordContribution', instanceId: 'workplace:1', revision: 2 },
    { command: 'workplace.sealProductionRevision', instanceId: 'workplace:1', revision: 3 },
    { command: 'workplace.presentCandidateSet', instanceId: 'workplace:1', revision: 4 },
    { command: 'workplace.runAuthorGate', instanceId: 'workplace:1', revision: 5, gateVerdict: 'repair' },
    { command: 'workplace.enterRepairWait', instanceId: 'workplace:1', revision: 6 },
    { command: 'workplace.rolloverRepairEpoch', instanceId: 'workplace:1', revision: 7, terminalOutcome: 'truthful-failure' },
    // Cell B (the dependant) materializes and waits for readiness.
    { command: 'workplace.materialize', instanceId: 'workplace:2', revision: 0 },
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:2', revision: 1, protocolRole: 'author' },
    // The predecessor terminalizes; D7 converts the dependant's wait.
    { command: 'workplace.issueWorkplaceTerminalProof', instanceId: 'workplace:1', revision: 8, terminalOutcome: 'truthful-failure' },
    // The dependant settles unreachable from the dead predecessor.
    { command: 'workplace.issueWorkplaceTerminalProof', instanceId: 'workplace:2', revision: 2, terminalOutcome: 'unreachable' },
    { command: 'nodeRun.settleUnreachable', instanceId: 'node-run:1', revision: 2 },
  ]);
}

/** The operator spine: stop/resume/watchdog/cancel + attempt loss. */
function operatorSpine(seed: number): Trace {
  return runSpine('operator', seed, [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', revision: 0 },
    { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', revision: 1 },
    { command: 'workItem.planGraph', instanceId: 'work-item:1', revision: 0, evidenceRefs: ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'] },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', revision: 2 },
    { command: 'factoryRun.requestStop', instanceId: 'factory-run:1', revision: 3 },
    { command: 'factoryRun.resume', instanceId: 'factory-run:1', revision: 4 },
    { command: 'factoryRun.observeWatchdog', instanceId: 'factory-run:1', revision: 5 },
    { command: 'lifecycleRun.create', instanceId: 'lifecycle-run:1', revision: 0 },
    { command: 'lifecycleRun.createContinuation', instanceId: 'lifecycle-run:2', revision: 0 },
    { command: 'lifecycleRun.cancel', instanceId: 'lifecycle-run:1', revision: 1 },
    { command: 'factoryRun.recordRunTerminalProof', instanceId: 'factory-run:1', revision: 6, terminalOutcome: 'cancellation' },
  ]);
}

/** The attempt-loss spine: refusal, worker loss classification, retry attempt, cancel. */
function attemptLossSpine(seed: number): Trace {
  return runSpine('attempt-loss', seed, [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', revision: 0 },
    { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', revision: 1 },
    { command: 'workItem.planGraph', instanceId: 'work-item:1', revision: 0, evidenceRefs: ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'] },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', revision: 2 },
    { command: 'lifecycleRun.create', instanceId: 'lifecycle-run:1', revision: 0 },
    { command: 'stageRun.create', instanceId: 'stage-run:1', revision: 0 },
    { command: 'stageRun.activate', instanceId: 'stage-run:1', revision: 1 },
    { command: 'processRun.create', instanceId: 'process-run:1', revision: 0 },
    { command: 'processRun.enterNode', instanceId: 'process-run:1', revision: 1 },
    { command: 'nodeRun.create', instanceId: 'node-run:1', revision: 0 },
    { command: 'nodeRun.materializeCell', instanceId: 'node-run:1', revision: 1 },
    { command: 'workplace.materialize', instanceId: 'workplace:1', revision: 0 },
    { command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', revision: 1, protocolRole: 'author', evidenceRefs: ['evidence:readiness'] },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:1', revision: 0, workIntentRef: 'evidence:WorkIntent#13' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1', revision: 1 },
    { command: 'activityAttempt.recordProviderRefusal', instanceId: 'activity-attempt:1', revision: 2 },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:2', revision: 0, workIntentRef: 'evidence:WorkIntent#13' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:2', revision: 1 },
    { command: 'activityAttempt.classifyWorkerLoss', instanceId: 'activity-attempt:2', revision: 2 },
    { command: 'activityAttempt.create', instanceId: 'activity-attempt:3', revision: 0, workIntentRef: 'evidence:WorkIntent#13' },
    { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:3', revision: 1 },
    { command: 'activityAttempt.cancel', instanceId: 'activity-attempt:3', revision: 2 },
  ]);
}

/** Replay a spine through runSteps to obtain its final committed world. */
function spineWorldOf(spine: Trace, seed: number): KernelWorld {
  const run = runSteps(spine.steps.map((step) => step.input), seed);
  if (run.refusal) {
    throw new Error(`spine replay refused: ${run.refusal.reason}: ${run.refusal.detail}`);
  }
  return run.world;
}

/**
 * All canonical spine traces. Every step is engine-validated; any refusal
 * throws (the caller surfaces it as a blocking test failure).
 */
export function canonicalSpineTraces(seed = 20260825): Trace[] {
  return [
    successSpine(seed),
    failureSpine(seed),
    humanProviderSpine(seed),
    unreachableSpine(seed),
    operatorSpine(seed),
    attemptLossSpine(seed),
  ];
}

/** Test diagnostic: the raw lazy-walk inputs (failure analysis only). */
export function debugLazyWalkInputs(target: CommandName, seed = 20260825): readonly CommandInput[] {
  return runLazyWalk(target, seed).steps.map((step) => step.input);
}

/**
 * Diagnostic twin of generateLegalTrace: runs the same lazy walk and reports
 * the committed steps plus every distinct refusal the TARGET itself produced
 * (test diagnostics; not used by the green path).
 */
export function explainTraceFailure(target: CommandName, seed = 20260825): {
  readonly target: CommandName;
  readonly committed: readonly string[];
  readonly targetRefusals: readonly TypedRefusal[];
  readonly workplaceStatuses: readonly string[];
} {
  let lazyWorldAtDescribe: KernelWorld = createWorld(seed);
  const describe = (input: CommandInput): string => {
    const discriminator = input.gateVerdict ?? input.effectOutcome ?? input.terminalOutcome ?? input.stageRoute ?? input.protocolRole;
    const head = lazyWorldAtDescribe.heads.get(input.instanceId);
    return `${input.command}@${input.instanceId}${discriminator !== undefined ? ':' + discriminator : ''}${head ? ' [' + head.status + '->' + (head.terminal ?? '?') + ']' : ''}`;
  };
  const lazy = runLazyWalk(target, seed);
  const described: string[] = [];
  for (const step of lazy.steps) {
    if ('committed' in step.outcome) {
      described.push(`${describe(step.input)} => ${step.outcome.plan.nextStatus}`);
    }
  }
  return {
    target,
    committed: described,
    targetRefusals: lazy.targetRefusals,
    workplaceStatuses: [...lazy.world.heads.values()].filter((head) => head.aggregate === 'Workplace').map((head) => `${head.instanceId}:${head.status}`),
  };
}

/**
 * Every declared command must have at least one generated positive trace.
 *
 * Targets are generated in ascending static-dependency order, and every
 * successful trace's committed world becomes a seed prefix for later
 * targets (trace composition): a trace is always a fully legal committed
 * history, and reusing a prefix only avoids re-deriving the same spine.
 */
export function generateAllLegalTraces(seed = 20260825): Map<CommandName, Trace> {
  const traces = new Map<CommandName, Trace>();

  // Phase A: a handful of deep GOAL WALKS (full budget). Each goal walk's
  // committed step sequence is itself a legal trace, and every prefix of it
  // ending at a command's application is that command's positive trace -
  // the settlement, failure, human-input and provider spines cover almost
  // the whole universe at the cost of a few walks instead of 53.
  const goals: readonly CommandName[] = [
    'factoryRun.recordRunTerminalProof', // success settlement spine
    'nodeRun.fail', // truthful-failure spine (repair loop, D6)
    'workplace.resolveHumanResponse', // human-input wake spine
    'nodeRun.recordProviderOutcome', // provider/human-node spine
    'processRun.settle', // process settlement spine
    'nodeRun.settleUnreachable', // unreachable settlement spine (D7)
  ];
  const prefixes: { world: KernelWorld; steps: readonly TraceStep[] }[] = [];
  const pool: { world: KernelWorld; steps: readonly TraceStep[] }[] = [];
  const poolKeys = new Set<string>();
  const addToPool = (world: KernelWorld, steps: readonly TraceStep[]): void => {
    const key = worldKey(world);
    if (poolKeys.has(key) || pool.length >= 16) return;
    poolKeys.add(key);
    pool.push({ world, steps });
  };

  // Phase A0: the canonical engine-validated spines. Every spine step is a
  // committed legal transition; the first application of each command in a
  // spine yields that command's positive trace (the spine prefix).
  for (const spine of canonicalSpineTraces(seed)) {
    addToPool(spineWorldOf(spine, seed), spine.steps);
    if (!prefixes.some((entry) => worldKey(entry.world) === worldKey(spineWorldOf(spine, seed)))) {
      prefixes.push({ world: spineWorldOf(spine, seed), steps: spine.steps });
    }
    const seen = new Set<CommandName>();
    for (let index = 0; index < spine.steps.length; index += 1) {
      const step = spine.steps[index];
      if (seen.has(step.input.command)) continue;
      seen.add(step.input.command);
      if (!traces.get(step.input.command)?.reached) {
        traces.set(step.input.command, { seed, target: step.input.command, steps: spine.steps.slice(0, index + 1), reached: true });
      }
    }
  }

  for (const goal of goals) {
    // Chain the goal walks: seed each with the most advanced successful
    // prefix so far (settlement spines build on one another).
    const bestPrefix = [...prefixes].sort((a, b) => b.steps.length - a.steps.length)[0];
    const lazy = runLazyWalk(goal, seed, bestPrefix, 260, 8);
    if (lazy.reached) {
      addToPool(lazy.world, lazy.steps);
      if (!prefixes.some((entry) => worldKey(entry.world) === worldKey(lazy.world))) {
        prefixes.push({ world: lazy.world, steps: lazy.steps });
      }
      // Record prefixes: the FIRST application of each command in this walk.
      const seen = new Set<CommandName>();
      for (let index = 0; index < lazy.steps.length; index += 1) {
        const step = lazy.steps[index];
        if (seen.has(step.input.command)) continue;
        seen.add(step.input.command);
        if (!traces.get(step.input.command)?.reached) {
          traces.set(step.input.command, { seed, target: step.input.command, steps: lazy.steps.slice(0, index + 1), reached: true });
        }
      }
    }
  }
  // Direct-only probes from every prefix world for anything still missing,
  // repeated after each goal round (cheap, high yield).
  for (let round = 0; round < 2; round += 1) {
    let roundProgress = false;
    for (const descriptor of COMMANDS) {
      if (traces.get(descriptor.name)?.reached) continue;
      const preference = variantPreferenceFor(descriptor.name);
      for (const entry of prefixes) {
        const direct = directCommitFrom(entry.world, descriptor.name, seed, preference);
        if (direct) {
          traces.set(descriptor.name, { seed, target: descriptor.name, steps: [...entry.steps, ...direct], reached: true });
          roundProgress = true;
          break;
        }
      }
    }
    if (!roundProgress) break;
  }

  // Phase B: direct-only probes from every prefix world (cheap), then the
  // status-aware seeded walk, then a fresh walk.
  const attemptedSeeds = new Set<string>();
  for (const descriptor of COMMANDS) {
    if (traces.get(descriptor.name)?.reached) continue;
    const preference = variantPreferenceFor(descriptor.name);
    let trace: Trace | undefined;
    for (const entry of prefixes) {
      const direct = directCommitFrom(entry.world, descriptor.name, seed, preference);
      if (direct) {
        trace = { seed, target: descriptor.name, steps: [...entry.steps, ...direct], reached: true };
        break;
      }
    }
    if (!trace) {
      const targetReducer = REDUCERS.find((entry) => entry.aggregate === descriptor.aggregate);
      const ruleStatuses = new Set(targetReducer?.transitions.filter((rule) => rule.command === descriptor.name).flatMap((rule) => rule.fromStatuses) ?? []);
      const isCreation = ruleStatuses.size === 0;
      const cap = INSTANCE_CAP_DEFAULTS[descriptor.aggregate] ?? 2;
      const scored = pool
        .map((entry) => {
          const live = [...entry.world.heads.values()].filter((head) => head.aggregate === descriptor.aggregate && head.terminal === undefined);
          if (isCreation) return live.length < cap ? { entry, score: 1 } : { entry, score: 0 };
          if (live.length === 0) return { entry, score: 0 };
          return live.some((head) => ruleStatuses.has(head.status)) ? { entry, score: 3 } : { entry, score: 1 };
        })
        .filter((candidate) => candidate.score > 0 && !attemptedSeeds.has(`${descriptor.name}|${worldKey(candidate.entry.world)}`))
        .sort((a, b) => b.score - a.score || b.entry.steps.length - a.entry.steps.length);
      const budgetSeeds = scored.filter((candidate) => candidate.score === 3).slice(0, 3).concat(scored.filter((candidate) => candidate.score === 1).slice(0, 2));
      for (const candidate of budgetSeeds) {
        attemptedSeeds.add(`${descriptor.name}|${worldKey(candidate.entry.world)}`);
        const candidateTrace = generateLegalTrace(descriptor.name, seed, 24, 200, candidate.entry);
        if (candidateTrace.reached) {
          trace = candidateTrace;
          break;
        }
      }
    }
    if (!trace) {
      trace = generateLegalTrace(descriptor.name, seed);
    }
    traces.set(descriptor.name, trace);
    if (trace.reached) {
      const run = runSteps(trace.steps.map((step) => step.input), seed);
      if (!run.refusal) {
        addToPool(run.world, trace.steps);
        if (!prefixes.some((entry) => worldKey(entry.world) === worldKey(run.world))) {
          prefixes.push({ world: run.world, steps: trace.steps });
        }
      }
    }
  }

  // Phase C: repair passes with the enriched pool.
  for (let pass = 0; pass < 2; pass += 1) {
    let newlyReached = false;
    for (const descriptor of COMMANDS) {
      if (traces.get(descriptor.name)?.reached) continue;
      let trace: Trace | undefined;
      const preference = variantPreferenceFor(descriptor.name);
      for (const entry of [...pool].sort((a, b) => b.steps.length - a.steps.length).slice(0, 6)) {
        const direct = directCommitFrom(entry.world, descriptor.name, seed, preference);
        if (direct) {
          trace = { seed, target: descriptor.name, steps: [...entry.steps, ...direct], reached: true };
          break;
        }
      }
      if (!trace) {
        const best = [...pool].sort((a, b) => b.steps.length - a.steps.length)[0];
        trace = generateLegalTrace(descriptor.name, seed, 24, 200, best);
      }
      traces.set(descriptor.name, trace);
      if (trace.reached) {
        newlyReached = true;
        const run = runSteps(trace.steps.map((step) => step.input), seed);
        if (!run.refusal) {
          addToPool(run.world, trace.steps);
          if (!prefixes.some((entry) => worldKey(entry.world) === worldKey(run.world))) {
            prefixes.push({ world: run.world, steps: trace.steps });
          }
        }
      }
    }
    if (!newlyReached) break;
  }
  return traces;
}
