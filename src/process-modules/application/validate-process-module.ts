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
  if (!profile.protocolSkill.trim()) errors.push(`execution profile '${profile.id}' has no protocolSkill`);
  if (!profile.semanticSkill.trim()) errors.push(`execution profile '${profile.id}' has no semanticSkill`);
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
  if (node.kind === 'external' && !node.adapter.trim()) {
    errors.push(`external node '${node.id}' has no adapter`);
  }
  if (node.kind === 'human' && !node.interactionContract.id.trim()) {
    errors.push(`human node '${node.id}' has no interaction contract`);
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

export function validateProcessModuleDefinition(
  module: ProcessModuleDefinition,
): ProcessModuleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!IDENTIFIER.test(module.identity.name)) errors.push(`module name '${module.identity.name}' is invalid`);
  if (!SEMVER.test(module.identity.version)) errors.push(`module version '${module.identity.version}' is not semantic versioning`);
  if (!IDENTIFIER.test(module.identity.kind)) errors.push(`module kind '${module.identity.kind}' is invalid`);
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

  const terminalSet = new Set(module.flow.terminalNodeIds);
  for (const transition of module.flow.transitions) {
    if (!nodeIdSet.has(transition.from)) errors.push(`transition source '${transition.from}' does not exist`);
    if (!nodeIdSet.has(transition.to)) errors.push(`transition target '${transition.to}' does not exist`);
    if (!transition.on.trim()) errors.push(`transition '${transition.from}' -> '${transition.to}' has no event`);
    if (terminalSet.has(transition.from)) {
      errors.push(`terminal node '${transition.from}' must not have outgoing transitions`);
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
