import type {
  ExecutionProfileDefinition,
  FlowNodeDefinition,
  ProcessModuleDefinition,
} from '../domain/process-module.js';

export interface ProcessModuleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

// C3: the closed set of standard lifecycle module kinds. identity.kind outside
// this set is a warning, not an error — custom modules remain expressible, but
// a typo is surfaced before the module is silently dropped from routing.
const STANDARD_MODULE_KINDS = new Set<string>([
  'discovery',
  'formalization',
  'development',
  'delivery',
]);

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function validateExecutionProfile(
  profile: ExecutionProfileDefinition,
  errors: string[],
  warnings: string[],
): void {
  if (!IDENTIFIER.test(profile.id)) {
    errors.push(`execution profile '${profile.id}' has an invalid id`);
  }
  if (!profile.workIntentKind.trim()) errors.push(`execution profile '${profile.id}' has no workIntentKind`);
  if (!profile.workIntentSchema.id.trim()) errors.push(`execution profile '${profile.id}' has no workIntentSchema`);
  if (!profile.taskKind.trim()) errors.push(`execution profile '${profile.id}' has no taskKind`);
  if (!profile.executionSkill.trim()) errors.push(`execution profile '${profile.id}' has no executionSkill`);
  if (profile.reviewSkill !== undefined && profile.reviewSkill !== null && !profile.reviewSkill.trim()) {
    errors.push(`execution profile '${profile.id}' has an empty reviewSkill`);
  }
  if (!profile.protocolSkill.trim()) errors.push(`execution profile '${profile.id}' has no protocolSkill`);
  if (!profile.semanticSkill.trim()) errors.push(`execution profile '${profile.id}' has no semanticSkill`);
  if (
    profile.artifactAcceptanceAuthority !== undefined
    && profile.artifactAcceptanceAuthority !== 'worker'
    && profile.artifactAcceptanceAuthority !== 'kernel-gate'
  ) {
    errors.push(
      `execution profile '${profile.id}' has invalid artifactAcceptanceAuthority`,
    );
  }
  if (!profile.outputSchema.id.trim()) errors.push(`execution profile '${profile.id}' has no outputSchema`);
  if (profile.retryPolicy.maxAttempts < 1 || !Number.isInteger(profile.retryPolicy.maxAttempts)) {
    errors.push(`execution profile '${profile.id}' retryPolicy.maxAttempts must be a positive integer`);
  }
  for (const tool of duplicates(profile.allowedTools)) {
    errors.push(`execution profile '${profile.id}' repeats allowed tool '${tool}'`);
  }
  if (profile.allowedTools.length === 0) {
    warnings.push(`execution profile '${profile.id}' has an empty allowedTools list`);
  }
  if (profile.trackerTemplate === null) {
    warnings.push(`execution profile '${profile.id}' has no external tracker template`);
  }
  if (profile.checklists.length === 0) {
    warnings.push(`execution profile '${profile.id}' has no pre-submit checklist`);
  }
}

function validateNode(
  node: FlowNodeDefinition,
  executionProfileIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!IDENTIFIER.test(node.id)) errors.push(`flow node '${node.id}' has an invalid id`);
  if (!node.label.trim()) errors.push(`flow node '${node.id}' has no label`);
  if (!node.description.trim()) errors.push(`flow node '${node.id}' has no description`);

  if (node.kind === 'lm' && !executionProfileIds.has(node.executionProfile)) {
    errors.push(`LM node '${node.id}' references missing execution profile '${node.executionProfile}'`);
  }
  if (node.kind === 'kernel' && !node.handler.trim()) {
    errors.push(`kernel node '${node.id}' has no handler`);
  }
  if (node.kind === 'human' && !node.interactionContract.id.trim()) {
    errors.push(`human node '${node.id}' has no interaction contract`);
  }
  // C1: a composite node delegates to another ProcessModule, so it must
  // declare that module's versioned identity. A composite node without a
  // moduleRef is a leaf that routes nowhere — a structural hole in the flow.
  if (node.kind === 'composite') {
    const ref = node.moduleRef;
    if (
      ref === undefined
      || ref === null
      || typeof ref !== 'object'
      || !IDENTIFIER.test(ref.name ?? '')
      || !SEMVER.test(ref.version ?? '')
    ) {
      errors.push(`composite node '${node.id}' must declare moduleRef`);
    }
  }
}

function reachableNodeIds(module: ProcessModuleDefinition): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const node of module.flow.nodes) adjacency.set(node.id, []);
  for (const transition of module.flow.transitions) {
    adjacency.get(transition.from)?.push(transition.to);
  }

  const reached = new Set<string>();
  const pending = [module.flow.entryNodeId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reached.has(current)) continue;
    reached.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return reached;
}

function canReachWithoutTerminal(
  module: ProcessModuleDefinition,
  fromNodeId: string,
  targetNodeId: string,
): boolean {
  const terminals = new Set(module.flow.terminalNodeIds);
  const pending = [fromNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === targetNodeId) return true;
    visited.add(current);
    if (terminals.has(current)) continue;
    for (const transition of module.flow.transitions) {
      if (transition.from === current) pending.push(transition.to);
    }
  }
  return false;
}

export function validateProcessModuleDefinition(
  module: ProcessModuleDefinition,
): ProcessModuleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!IDENTIFIER.test(module.identity.name)) errors.push(`module name '${module.identity.name}' is invalid`);
  if (!SEMVER.test(module.identity.version)) errors.push(`module version '${module.identity.version}' is not semantic versioning`);
  if (!IDENTIFIER.test(module.identity.kind)) errors.push(`module kind '${module.identity.kind}' is invalid`);
  // C3: identity.kind is a small closed set. A well-formed identifier that is
  // not in the standard set still type-checks, but it is almost always a
  // typo (e.g. 'formalisation' vs 'formalization') that silently drops the
  // module out of lifecycle routing. Warn, do not error, so custom modules
  // remain expressible.
  if (!STANDARD_MODULE_KINDS.has(module.identity.kind)) {
    warnings.push(
      `identity.kind '${module.identity.kind}' is not in the standard set {discovery,formalization,development,delivery}`,
    );
  }
  if (!module.identity.displayName.trim()) errors.push('module displayName is required');
  if (!module.identity.description.trim()) errors.push('module description is required');
  if (!module.inputContract.id.trim()) errors.push('inputContract.id is required');
  if (!module.outputContract.id.trim()) errors.push('outputContract.id is required');

  const outcomeCodes = module.outcomes.map(outcome => outcome.code);
  for (const code of duplicates(outcomeCodes)) errors.push(`duplicate outcome '${code}'`);
  if (outcomeCodes.length === 0) errors.push('at least one process outcome is required');
  for (const outcome of module.outcomes) {
    if (!IDENTIFIER.test(outcome.code)) errors.push(`outcome '${outcome.code}' has an invalid code`);
    if (!outcome.description.trim()) errors.push(`outcome '${outcome.code}' has no description`);
  }

  const profileIds = module.executionProfiles.map(profile => profile.id);
  for (const id of duplicates(profileIds)) errors.push(`duplicate execution profile '${id}'`);
  const profileIdSet = new Set(profileIds);
  for (const profile of module.executionProfiles) validateExecutionProfile(profile, errors, warnings);

  const nodeIds = module.flow.nodes.map(node => node.id);
  for (const id of duplicates(nodeIds)) errors.push(`duplicate flow node '${id}'`);
  const nodeIdSet = new Set(nodeIds);
  if (!nodeIdSet.has(module.flow.entryNodeId)) {
    errors.push(`entry node '${module.flow.entryNodeId}' does not exist`);
  }
  if (module.flow.terminalNodeIds.length === 0) errors.push('flow must define at least one terminal node');
  for (const terminalId of duplicates(module.flow.terminalNodeIds)) {
    errors.push(`terminal node '${terminalId}' is declared more than once`);
  }
  for (const terminalId of module.flow.terminalNodeIds) {
    if (!nodeIdSet.has(terminalId)) errors.push(`terminal node '${terminalId}' does not exist`);
  }
  for (const node of module.flow.nodes) validateNode(node, profileIdSet, errors);

  // up its executionProfile in the module's own profile table. A module that
  // declares LM nodes but ships an empty executionProfiles array therefore
  // cannot run any of its LM nodes — a high-risk structural hole that would
  // otherwise fail only at runtime with a confusing missing-profile error.
  const hasLmNode = module.flow.nodes.some(node => node.kind === 'lm');
  if (hasLmNode && module.executionProfiles.length === 0) {
    errors.push('module has LM nodes but no execution profiles');
  }

  const terminalSet = new Set(module.flow.terminalNodeIds);
  const transitionKeys = module.flow.transitions.map(transition =>
    `${transition.from}\u0000${transition.on}`);
  for (const key of duplicates(transitionKeys)) {
    const [from, event] = key.split('\u0000');
    errors.push(
      `flow has ambiguous transitions from '${from}' on event '${event}'`,
    );
  }
  for (const transition of module.flow.transitions) {
    if (!nodeIdSet.has(transition.from)) errors.push(`transition source '${transition.from}' does not exist`);
    if (!nodeIdSet.has(transition.to)) errors.push(`transition target '${transition.to}' does not exist`);
    if (!transition.on.trim()) errors.push(`transition '${transition.from}' -> '${transition.to}' has no event`);
    if (terminalSet.has(transition.from)) {
      errors.push(`terminal node '${transition.from}' must not have outgoing transitions`);
    }
  }

  const recoveryIds = (module.flow.recovery ?? []).map(policy => policy.id);
  for (const id of duplicates(recoveryIds)) {
    errors.push(`duplicate flow recovery policy '${id}'`);
  }
  const recoveryTriggerOwners = new Map<string, string>();
  for (const policy of module.flow.recovery ?? []) {
    if (!IDENTIFIER.test(policy.id)) {
      errors.push(`flow recovery policy '${policy.id}' has an invalid id`);
    }
    if (!nodeIdSet.has(policy.verifyNodeId)) {
      errors.push(
        `flow recovery policy '${policy.id}' verifier '${policy.verifyNodeId}' does not exist`,
      );
    }
    if (!nodeIdSet.has(policy.repairNodeId)) {
      errors.push(
        `flow recovery policy '${policy.id}' repair node '${policy.repairNodeId}' does not exist`,
      );
    }
    if (terminalSet.has(policy.verifyNodeId)) {
      errors.push(
        `flow recovery policy '${policy.id}' cannot use terminal verifier '${policy.verifyNodeId}'`,
      );
    }
    if (terminalSet.has(policy.repairNodeId)) {
      errors.push(
        `flow recovery policy '${policy.id}' cannot target terminal repair node '${policy.repairNodeId}'`,
      );
    }
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
      errors.push(
        `flow recovery policy '${policy.id}' maxAttempts must be a positive integer`,
      );
    }
    if (policy.triggerEvents.length === 0) {
      errors.push(`flow recovery policy '${policy.id}' has no triggerEvents`);
    }
    if (policy.resolvedEvents.length === 0) {
      errors.push(`flow recovery policy '${policy.id}' has no resolvedEvents`);
    }
    for (const event of duplicates(policy.triggerEvents)) {
      errors.push(`flow recovery policy '${policy.id}' repeats trigger event '${event}'`);
    }
    for (const event of duplicates(policy.resolvedEvents)) {
      errors.push(`flow recovery policy '${policy.id}' repeats resolved event '${event}'`);
    }
    const triggerSet = new Set(policy.triggerEvents);
    for (const event of policy.resolvedEvents) {
      if (triggerSet.has(event)) {
        errors.push(
          `flow recovery policy '${policy.id}' uses '${event}' as both trigger and resolved event`,
        );
      }
      const resolvedRoute = module.flow.transitions.some(transition =>
        transition.from === policy.verifyNodeId
        && transition.on === event);
      if (!resolvedRoute) {
        errors.push(
          `flow recovery policy '${policy.id}' resolved event '${event}' `
            + `has no transition from verifier '${policy.verifyNodeId}'`,
        );
      }
    }
    for (const event of policy.triggerEvents) {
      const ownerKey = `${policy.verifyNodeId}\u0000${event}`;
      const existingOwner = recoveryTriggerOwners.get(ownerKey);
      if (existingOwner && existingOwner !== policy.id) {
        errors.push(
          `flow recovery trigger '${policy.verifyNodeId}' + '${event}' `
            + `is owned by both '${existingOwner}' and '${policy.id}'`,
        );
      } else {
        recoveryTriggerOwners.set(ownerKey, policy.id);
      }
      const route = module.flow.transitions.find(transition =>
        transition.from === policy.verifyNodeId
        && transition.on === event
        && transition.to === policy.repairNodeId);
      if (!route) {
        errors.push(
          `flow recovery policy '${policy.id}' requires transition `
            + `'${policy.verifyNodeId}' --${event}--> '${policy.repairNodeId}'`,
        );
      }
    }
    if (
      nodeIdSet.has(policy.repairNodeId)
      && nodeIdSet.has(policy.verifyNodeId)
      && !canReachWithoutTerminal(module, policy.repairNodeId, policy.verifyNodeId)
    ) {
      errors.push(
        `flow recovery policy '${policy.id}' repair path from '${policy.repairNodeId}' `
          + `does not return to verifier '${policy.verifyNodeId}' before a terminal node`,
      );
    }
  }

  const declaredOutcomes = new Set(outcomeCodes);
  const emittedOutcomes = new Set<string>();
  for (const node of module.flow.nodes) {
    if (!terminalSet.has(node.id)) continue;
    if (node.emitsOutcome === undefined) {
      errors.push(`terminal node '${node.id}' must emit a process outcome`);
      continue;
    }
    emittedOutcomes.add(node.emitsOutcome);
    if (!declaredOutcomes.has(node.emitsOutcome)) {
      errors.push(`terminal node '${node.id}' emits undeclared outcome '${node.emitsOutcome}'`);
    }
  }
  for (const outcome of module.outcomes) {
    if (outcome.terminal && !emittedOutcomes.has(outcome.code)) {
      errors.push(`terminal outcome '${outcome.code}' is not emitted by any terminal node`);
    }
  }

  if (nodeIdSet.has(module.flow.entryNodeId)) {
    const reached = reachableNodeIds(module);
    for (const nodeId of nodeIds) {
      if (!reached.has(nodeId)) errors.push(`flow node '${nodeId}' is unreachable from entry`);
    }
  }

  for (const invariantId of duplicates(module.invariants.map(invariant => invariant.id))) {
    errors.push(`duplicate invariant '${invariantId}'`);
  }
  for (const policyId of duplicates(module.policies.map(policy => `${policy.id}@${policy.version}`))) {
    errors.push(`duplicate policy '${policyId}'`);
  }
  for (const artifactType of duplicates(module.artifacts.map(artifact => artifact.type))) {
    errors.push(`duplicate artifact type '${artifactType}'`);
  }

  return { valid: errors.length === 0, errors, warnings };
}
