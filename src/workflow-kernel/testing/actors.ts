/**
 * workflow-kernel/testing/actors.ts - the EK-9 deterministic actor library
 * (WP-13B, plan phase EK-9 "actor behavior" dimension).
 *
 * An actor is DATA - a program - never bespoke test code. A program is a
 * list of actor steps; each step names the protocol role, the semantic
 * profile, the behavior class and the allowed tool/result sequence, and the
 * compiler turns that data into exact kernel CommandInputs over the SAME
 * cognition port the kernel uses:
 *
 *   - cognition-bound steps run through the WP-18 admitting-transport
 *     contract (admission at the exact pre-send boundary + the injected
 *     scripted channel - deterministic, no model calls, no network);
 *   - every step is a PUBLIC COMMAND of the frozen universe applied through
 *     the pure reference machine (dist domain explorer) or the sole-writer
 *     repositories (the scenario fault driver).
 *
 * The twelve behavior classes of the required dimension are closed:
 *   compliant, omission, extra-paths, malformed-product, repairing,
 *   stale-hash, foreign-ref, duplicate-completion, prose-only-review,
 *   timeout, crash, tool-misuse.
 * Each behavior has ONE deterministic kernel-visible materialization:
 *   compliant             -> commits as authored;
 *   omission              -> the required evidence/intent/pin field is
 *                            dropped (typed MISSING_EVIDENCE or
 *                            ROLE_CONTRACT_REF_MISMATCH);
 *   extra-paths           -> the program itself carries uncontracted extra
 *                            steps (typed ILLEGAL_TRANSITION via the
 *                            durable-handoff law);
 *   malformed-product     -> the gate verdict data records the malformed
 *                            product as 'repair' (the gate is the judge);
 *   repairing             -> the D6 repair loop is walked through public
 *                            commands (enterRepairWait -> rollover ->
 *                            re-admission -> accepted);
 *   stale-hash            -> expectedRevision is offset (typed
 *                            STALE_EXPECTED_REVISION);
 *   foreign-ref           -> evidence refs point outside the world (typed
 *                            FOREIGN_EVIDENCE_REF / MISSING_EVIDENCE);
 *   duplicate-completion  -> the completion input is re-issued verbatim
 *                            (idempotent replay, never a second commit);
 *   prose-only-review     -> the structured presentation step is absent
 *                            (typed MISSING_EVIDENCE at the gate);
 *   timeout               -> the worker never returns; the attempt is
 *                            classified (TypedWait:external-availability +
 *                            obligation retry);
 *   crash                 -> the scripted channel dies mid-exchange (the
 *                            scenario fault driver owns restart settlement);
 *   tool-misuse           -> an arbitrary manifest-bag key rides the input
 *                            (typed ATTEMPT_RERESOLVED_MANIFEST) and/or the
 *                            tool sequence leaves the pinned contract's
 *                            allowed tool set (the tool-protocol checker).
 *
 * PURITY: node:crypto for deterministic pins only. No clock, no network, no
 * model calls, no database. The banned-substitute vocabulary (boards,
 * heartbeats, task statuses, tags) never appears as a resolution input.
 */

import { createHash } from 'node:crypto';
import type {
  CanonicalRoleContractReference,
  CommandInput,
  EffectOutcome,
  GateVerdict,
  StageRoute,
  TerminalOutcome,
  TypedRefusal,
} from '../domain/types.js';
import type { CommandName } from '../domain/universe.js';
import { applyCommand, createWorld, type KernelWorld } from '../domain/explorer.js';

/* ------------------------------------------------------------------ */
/* Closed actor vocabularies (mirror of the scenario contract)          */
/* ------------------------------------------------------------------ */

/** The twelve required actor-behavior classes (EK-9 "Required dimensions"). */
export const ACTOR_BEHAVIORS = [
  'compliant',
  'omission',
  'extra-paths',
  'malformed-product',
  'repairing',
  'stale-hash',
  'foreign-ref',
  'duplicate-completion',
  'prose-only-review',
  'timeout',
  'crash',
  'tool-misuse',
] as const;
export type ActorBehavior = (typeof ACTOR_BEHAVIORS)[number];

/** Semantic profiles select a contract slot, never a transition owner. */
export const SEMANTIC_PROFILES = ['planner', 'implementer', 'reviewer', 'certifier'] as const;
export type SemanticProfileName = (typeof SEMANTIC_PROFILES)[number];

/** The only two Workplace protocol roles. */
export const PROTOCOL_ROLES = ['author', 'reviewer'] as const;
export type ProtocolRoleName = (typeof PROTOCOL_ROLES)[number];

/** Which pinned role contract a step carries (a named choice or an exact pin value). */
export type PinChoice = 'author' | 'reviewer' | 'foreign' | 'mismatched-digest' | 'none' | CanonicalRoleContractReference;

/* ------------------------------------------------------------------ */
/* The cognition port: a scripted channel (deterministic, no model)     */
/* ------------------------------------------------------------------ */

/** One deterministic outcome of a scripted provider-channel send. */
export type ScriptedChannelStep =
  /** The external send succeeded (an outcome digest is known). */
  | { readonly kind: 'delivered' }
  /** D12: the non-idempotent send happened, its outcome is unknown. */
  | { readonly kind: 'unknown' }
  /** The channel died before/around the send (crash window "before send"). */
  | { readonly kind: 'error'; readonly message: string };

/** The cognition script of one actor program (channel results, in order). */
export interface ActorCognitionScript {
  readonly channel: readonly ScriptedChannelStep[];
}

/* ------------------------------------------------------------------ */
/* The tool/result protocol                                            */
/* ------------------------------------------------------------------ */

/** Result classes a scripted tool call may return (bounded by the contract). */
export const TOOL_RESULT_CLASSES = ['read', 'write', 'search', 'board', 'shell', 'network'] as const;
export type ToolResultClass = (typeof TOOL_RESULT_CLASSES)[number];

/** One allowed tool call inside an actor step (data, not a callback). */
export interface ToolCallSpec {
  readonly tool: string;
  readonly resultClass: ToolResultClass;
  /** Bounded result size in tokens (the budget dimension input). */
  readonly resultTokens: number;
}

/** One tool-protocol violation (a tool outside the pinned allowed set). */
export interface ToolProtocolViolation {
  readonly stepId: string;
  readonly tool: string;
  readonly allowedTools: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Actor step data                                                     */
/* ------------------------------------------------------------------ */

/**
 * One actor-program step: pure data. Field names follow the kernel
 * CommandInput; the compiler resolves pins, intent refs and revisions by a
 * deterministic dry walk of the reference machine.
 */
export interface ActorStep {
  readonly stepId: string;
  readonly semanticProfile: SemanticProfileName;
  readonly behavior: ActorBehavior;
  readonly command: CommandName;
  /** Logical instance key; the compiler maps it to the concrete instance id. */
  readonly instance: string;
  readonly key?: string;
  readonly evidenceRefs?: readonly string[];
  readonly pin?: PinChoice;
  readonly protocolRole?: ProtocolRoleName;
  /** stepId of the admit step whose WorkIntent ref feeds workIntentRef. */
  readonly intentOf?: string;
  readonly gateVerdict?: GateVerdict;
  readonly effectOutcome?: EffectOutcome;
  readonly terminalOutcome?: TerminalOutcome;
  readonly stageRoute?: StageRoute;
  /** stale-hash: offset applied to the computed expectedRevision (default +1). */
  readonly revisionOffset?: number;
  /** tool-misuse: the arbitrary manifest-bag key name injected into the input. */
  readonly manifestBag?: string;
  /** Fields deleted before application (omission; default rule per command). */
  readonly dropFields?: readonly string[];
  /** duplicate-completion: re-issue this step's input verbatim right after. */
  readonly duplicate?: boolean;
  /** The allowed tool/result sequence of the step. */
  readonly tools?: readonly ToolCallSpec[];
}

/** Pin set the compiler resolves 'author'/'reviewer'/'foreign' against. */
export interface ActorPinSet {
  readonly author: CanonicalRoleContractReference;
  readonly reviewer: CanonicalRoleContractReference;
  readonly foreign: CanonicalRoleContractReference;
}

/** Authored expectation of one program: where the kernel must answer no. */
export interface RefusalExpectation {
  readonly stepId: string;
  readonly command: string;
  readonly reason: string;
}

/** The compiled actor program (kernel inputs + scenario view + protocol). */
export interface CompiledActorProgram {
  /** Kernel CommandInputs with every behavior materialized, in order. */
  readonly inputs: readonly CommandInput[];
  /** The same steps as scenario-contract actor steps (validatable data). */
  readonly scenarioSteps: readonly Record<string, unknown>[];
  /** Tool-protocol violations (tools outside the pinned allowed set). */
  readonly toolViolations: readonly ToolProtocolViolation[];
  /** The first typed refusal the reference machine answers (or null). */
  readonly refusal: TypedRefusal | null;
  /** stepId of the refused step (when refusal is set). */
  readonly refusedStepId: string | null;
  /** The dry-walk world at the refusal (or the final world). */
  readonly world: KernelWorld;
}

/* ------------------------------------------------------------------ */
/* Deterministic pins                                                  */
/* ------------------------------------------------------------------ */

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Deterministic content-addressed pin set (stable across machines). */
export function actorPinSet(seed = 'ek-wp13b'): ActorPinSet {
  const pinOf = (name: string): CanonicalRoleContractReference => ({
    roleContractRef: `sha256:${sha256(`contract:${seed}:${name}`)}`,
    roleContractDigest: sha256(`contract:${seed}:${name}:body`),
  });
  return {
    author: pinOf('author'),
    reviewer: pinOf('reviewer'),
    foreign: pinOf('foreign'),
  };
}

/* ------------------------------------------------------------------ */
/* Compilation: data -> kernel inputs                                  */
/* ------------------------------------------------------------------ */

/** Default omission rule: the field whose absence the guard must name. */
function omissionFieldOf(command: string): string {
  if (command === 'activityAttempt.create') return 'workIntentRef';
  if (command === 'workplace.admitWorkIntent') return 'rolePin';
  if (command === 'workplace.settleEffect') return 'effectOutcome';
  if (command === 'workplace.issueWorkplaceTerminalProof') return 'terminalOutcome';
  return 'evidenceRefs';
}

function resolvePin(choice: PinChoice | undefined, pins: ActorPinSet): CanonicalRoleContractReference | undefined {
  if (choice === undefined || choice === 'none') return undefined;
  if (typeof choice === 'object') return choice; // an exact pin value carried as data
  switch (choice) {
    case 'author':
      return pins.author;
    case 'reviewer':
      return pins.reviewer;
    case 'foreign':
      return pins.foreign;
    case 'mismatched-digest':
      // The exact ref of the author contract paired with the FOREIGN digest:
      // the attempt/intent equality guard must name the digest mismatch.
      return { roleContractRef: pins.author.roleContractRef, roleContractDigest: pins.foreign.roleContractDigest };
    default:
      return undefined;
  }
}

/**
 * Compile an actor program into kernel CommandInputs. The compiler dry-walks
 * the pure reference machine so expected revisions and WorkIntent refs are
 * exact; behavior classes are materialized deterministically as documented.
 */
export function compileActorProgram(
  steps: readonly ActorStep[],
  options: { readonly seed?: number; readonly pins?: ActorPinSet; readonly allowedTools?: readonly string[] } = {},
): CompiledActorProgram {
  const seed = options.seed ?? 20260825;
  const pins = options.pins ?? actorPinSet();
  const allowedTools = options.allowedTools ?? ['saga-board', 'fs:read', 'fs:write', 'search:code'];
  let world: KernelWorld = createWorld(seed);
  const revisions = new Map<string, number>();
  const inputs: CommandInput[] = [];
  const scenarioSteps: Record<string, unknown>[] = [];
  const toolViolations: ToolProtocolViolation[] = [];
  const intentRefs = new Map<string, string>();
  let refusal: TypedRefusal | null = null;
  let refusedStepId: string | null = null;

  const recordViolation = (step: ActorStep): void => {
    for (const call of step.tools ?? []) {
      if (!allowedTools.includes(call.tool)) {
        toolViolations.push({ stepId: step.stepId, tool: call.tool, allowedTools: [...allowedTools] });
      }
    }
  };

  for (const step of steps) {
    if (refusal !== null) break;
    const head = world.heads.get(step.instance);
    const currentRevision = revisions.get(step.instance) ?? head?.revision ?? 0;
    // stale-hash: the offset is the point (authored as revisionOffset, default +1).
    const revision =
      step.behavior === 'stale-hash' ? currentRevision + (step.revisionOffset ?? 1) : currentRevision + (step.revisionOffset ?? 0);

    const input: Record<string, unknown> = {
      command: step.command,
      instanceId: step.instance,
      expectedRevision: revision,
      idempotencyKey: step.key ?? `key:${step.stepId}`,
    };

    const drop = new Set(step.dropFields ?? (step.behavior === 'omission' ? [omissionFieldOf(step.command)] : []));
    if (step.behavior === 'foreign-ref' && !drop.has('evidenceRefs')) {
      input.evidenceRefs = ['evidence:foreign#ref'];
    } else if (step.evidenceRefs !== undefined && !drop.has('evidenceRefs')) {
      input.evidenceRefs = [...step.evidenceRefs];
    }
    const pin = resolvePin(step.pin, pins);
    if (pin !== undefined && !drop.has('rolePin')) input.rolePin = pin;
    if (step.protocolRole !== undefined && !drop.has('protocolRole')) input.protocolRole = step.protocolRole;
    if (step.intentOf !== undefined && !drop.has('workIntentRef')) {
      if (step.behavior === 'foreign-ref') {
        // The foreign-ref surface of an intent-bound step: a WorkIntent ref
        // no Workplace transition ever admitted.
        input.workIntentRef = 'evidence:WorkIntent#foreign';
      } else {
        const ref = intentRefs.get(step.intentOf);
        if (ref === undefined) {
          throw new Error(`actor step ${step.stepId}: intentOf "${step.intentOf}" has no admitted intent (dry walk)`);
        }
        input.workIntentRef = ref;
      }
    }
    if (step.gateVerdict !== undefined && !drop.has('gateVerdict')) input.gateVerdict = step.gateVerdict;
    if (step.effectOutcome !== undefined && !drop.has('effectOutcome')) input.effectOutcome = step.effectOutcome;
    if (step.terminalOutcome !== undefined && !drop.has('terminalOutcome')) input.terminalOutcome = step.terminalOutcome;
    if (step.stageRoute !== undefined && !drop.has('stageRoute')) input.stageRoute = step.stageRoute;
    if (step.behavior === 'tool-misuse' && step.manifestBag !== undefined) {
      input[step.manifestBag] = { re: 'solvable', bag: true };
    }

    const kernelInput = input as unknown as CommandInput;
    const applications: CommandInput[] = [kernelInput];
    if (step.behavior === 'duplicate-completion' || step.duplicate === true) {
      applications.push({ ...kernelInput });
    }

    for (let index = 0; index < applications.length; index += 1) {
      const applied = applyCommand(world, applications[index]);
      inputs.push(applications[index]);
      const scenarioStep: Record<string, unknown> = {
        stepId: index === 0 ? step.stepId : `${step.stepId}#dup`,
        semanticProfile: step.semanticProfile,
        behavior: step.behavior,
        command: step.command,
        instanceId: step.instance,
        expectedRevision: applications[index].expectedRevision,
        idempotencyKey: applications[index].idempotencyKey,
      };
      for (const field of ['evidenceRefs', 'rolePin', 'protocolRole', 'workIntentRef', 'gateVerdict', 'effectOutcome', 'terminalOutcome', 'stageRoute'] as const) {
        if (applications[index][field] !== undefined) scenarioStep[field] = applications[index][field];
      }
      scenarioStep.toolSequence = (step.tools ?? []).map((call) => call.tool);
      scenarioSteps.push(scenarioStep);
      recordViolation(step);
      if (applied.outcome && (applied.outcome as TypedRefusal).refused === true) {
        refusal = applied.outcome as TypedRefusal;
        refusedStepId = step.stepId;
        break;
      }
      if (!(applied.outcome as { replayed?: boolean }).replayed) {
        world = applied.world;
        revisions.set(step.instance, (revisions.get(step.instance) ?? head?.revision ?? 0) + 1);
      }
    }

    // Remember the WorkIntent ref this admit step created (for intentOf).
    if (step.command === 'workplace.admitWorkIntent' && step.pin !== undefined && step.pin !== 'none') {
      const latest = [...world.workIntents.keys()].filter((ref) => !intentRefs.has(ref)).pop();
      if (latest !== undefined) intentRefs.set(step.stepId, latest);
    }
  }

  return { inputs, scenarioSteps, toolViolations, refusal, refusedStepId, world };
}

/** Drive compiled inputs over a fresh reference world (convenience). */
export function runActorProgram(
  compiled: CompiledActorProgram,
  seed = 20260825,
): { world: KernelWorld; steps: { input: CommandInput; outcome: unknown }[]; refusal: TypedRefusal | null } {
  let world = createWorld(seed);
  const steps: { input: CommandInput; outcome: unknown }[] = [];
  let refusal: TypedRefusal | null = null;
  for (const input of compiled.inputs) {
    const applied = applyCommand(world, input);
    steps.push({ input, outcome: applied.outcome });
    if ((applied.outcome as TypedRefusal).refused === true) {
      refusal = applied.outcome as TypedRefusal;
      break;
    }
    if (!(applied.outcome as { replayed?: boolean }).replayed) world = applied.world;
  }
  return { world, steps, refusal };
}

/* ------------------------------------------------------------------ */
/* Program recipes (reusable data builders, still pure data)            */
/* ------------------------------------------------------------------ */

/** Tool sequence constants (allowed set first, forbidden tools for misuse). */
export const TOOL_CALLS = {
  read: (tokens = 8): ToolCallSpec => ({ tool: 'fs:read', resultClass: 'read', resultTokens: tokens }),
  write: (tokens = 16): ToolCallSpec => ({ tool: 'fs:write', resultClass: 'write', resultTokens: tokens }),
  search: (tokens = 12): ToolCallSpec => ({ tool: 'search:code', resultClass: 'search', resultTokens: tokens }),
  board: (tokens = 4): ToolCallSpec => ({ tool: 'saga-board', resultClass: 'board', resultTokens: tokens }),
  forbiddenShell: (tokens = 32): ToolCallSpec => ({ tool: 'shell:exec', resultClass: 'shell', resultTokens: tokens }),
  forbiddenNetwork: (tokens = 64): ToolCallSpec => ({ tool: 'net:fetch', resultClass: 'network', resultTokens: tokens }),
} as const;

/** The deterministic cognition script of one author/reviewer attempt loop. */
export function attemptCognitionScript(behavior: ActorBehavior): ActorCognitionScript {
  switch (behavior) {
    case 'crash':
      return { channel: [{ kind: 'error', message: 'EK_SCRIPTED_CHANNEL_DEATH before outcome' }] };
    default:
      return { channel: [{ kind: 'delivered' }] };
  }
}

/** The factory vertical prefix (bootstrap through workplace materialize). */
export function verticalPrefixSteps(instanceIds: {
  factory: string; lifecycle: string; stage: string; process: string; node: string; workplace: string;
}, profile: SemanticProfileName = 'planner'): ActorStep[] {
  const b = 'compliant' as const;
  return [
    { stepId: 'bootstrap', semanticProfile: profile, behavior: b, command: 'factoryRun.bootstrap', instance: instanceIds.factory, tools: [] },
    { stepId: 'import-capsule', semanticProfile: profile, behavior: b, command: 'factoryRun.importCapsule', instance: instanceIds.factory, tools: [] },
    { stepId: 'start', semanticProfile: profile, behavior: b, command: 'factoryRun.start', instance: instanceIds.factory, tools: [] },
    { stepId: 'lifecycle-create', semanticProfile: profile, behavior: b, command: 'lifecycleRun.create', instance: instanceIds.lifecycle, tools: [] },
    { stepId: 'stage-create', semanticProfile: profile, behavior: b, command: 'stageRun.create', instance: instanceIds.stage, tools: [] },
    { stepId: 'stage-activate', semanticProfile: profile, behavior: b, command: 'stageRun.activate', instance: instanceIds.stage, tools: [] },
    { stepId: 'process-create', semanticProfile: profile, behavior: b, command: 'processRun.create', instance: instanceIds.process, tools: [] },
    { stepId: 'enter-node', semanticProfile: profile, behavior: b, command: 'processRun.enterNode', instance: instanceIds.process, tools: [] },
    { stepId: 'node-create', semanticProfile: profile, behavior: b, command: 'nodeRun.create', instance: instanceIds.node, tools: [] },
    { stepId: 'workplace-materialize', semanticProfile: profile, behavior: b, command: 'workplace.materialize', instance: instanceIds.workplace, tools: [] },
  ];
}

/**
 * One author or reviewer attempt loop as data. The behavior class of the
 * loop shapes it: 'timeout' replaces the outcome with worker-loss
 * classification; 'prose-only-review' drops the structured presentation;
 * 'malformed-product' records the gate's repair verdict.
 */
export function attemptLoopSteps(input: {
  readonly loopId: string;
  readonly role: ProtocolRoleName;
  readonly profile: SemanticProfileName;
  readonly behavior?: ActorBehavior;
  readonly workplace: string;
  readonly attempt: string;
  readonly gate: 'author' | 'final';
  readonly gateVerdict: GateVerdict;
  readonly tools?: readonly ToolCallSpec[];
}): ActorStep[] {
  const behavior = input.behavior ?? 'compliant';
  const b = (fallback: ActorBehavior): ActorBehavior => (behavior === 'compliant' ? fallback : behavior);
  const tools = input.tools ?? [TOOL_CALLS.read(), TOOL_CALLS.search(), TOOL_CALLS.write()];
  const steps: ActorStep[] = [
    {
      stepId: `${input.loopId}-admit`,
      semanticProfile: input.profile,
      behavior,
      command: 'workplace.admitWorkIntent',
      instance: input.workplace,
      pin: input.role,
      protocolRole: input.role,
      evidenceRefs: [`evidence:${input.loopId}-scope`],
    },
    {
      stepId: `${input.loopId}-attempt`,
      semanticProfile: input.profile,
      behavior,
      command: 'activityAttempt.create',
      instance: input.attempt,
      pin: input.role,
      intentOf: `${input.loopId}-admit`,
    },
    {
      stepId: `${input.loopId}-admission`,
      semanticProfile: input.profile,
      behavior,
      command: 'activityAttempt.admitProviderRequest',
      instance: input.attempt,
    },
    {
      stepId: `${input.loopId}-send`,
      semanticProfile: input.profile,
      behavior,
      command: 'cognition.sendProviderRequest',
      instance: 'cognition:transport',
    },
  ];
  if (behavior === 'timeout') {
    steps.push({
      stepId: `${input.loopId}-worker-loss`,
      semanticProfile: input.profile,
      behavior,
      command: 'activityAttempt.classifyWorkerLoss',
      instance: input.attempt,
    });
    return steps;
  }
  steps.push(
    {
      stepId: `${input.loopId}-outcome`,
      semanticProfile: input.profile,
      behavior,
      command: 'activityAttempt.recordOutcome',
      instance: input.attempt,
      intentOf: `${input.loopId}-admit`,
    },
    {
      stepId: `${input.loopId}-contribution`,
      semanticProfile: input.profile,
      behavior,
      command: 'workplace.recordContribution',
      instance: input.workplace,
    },
    {
      stepId: `${input.loopId}-seal`,
      semanticProfile: input.profile,
      behavior,
      command: 'workplace.sealProductionRevision',
      instance: input.workplace,
    },
  );
  if (behavior !== 'prose-only-review') {
    steps.push({
      stepId: `${input.loopId}-present`,
      semanticProfile: input.profile,
      behavior,
      command: 'workplace.presentCandidateSet',
      instance: input.workplace,
    });
  }
  steps.push({
    stepId: `${input.loopId}-gate`,
    semanticProfile: input.profile,
    behavior: b('compliant'),
    command: input.gate === 'author' ? 'workplace.runAuthorGate' : 'workplace.runFinalGate',
    instance: input.workplace,
    gateVerdict: behavior === 'malformed-product' ? 'repair' : input.gateVerdict,
    tools,
  });
  return steps;
}
