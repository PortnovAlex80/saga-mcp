import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { validateLifecycleDefinition } from '../process-modules/application/lifecycle-router.js';
import { validateProcessModuleDefinition } from '../process-modules/application/validate-process-module.js';
import { discoveryToFormalizationLifecycle } from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import { createBuiltInProcessModuleRegistry } from '../process-modules/modules/catalog.js';
import type { ToolHandler } from '../types.js';

const registry = createBuiltInProcessModuleRegistry();

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required (non-empty string)`);
  }
  return value;
}

function handleProcessModuleList() {
  const modules = registry.list().map(module => {
    const validation = validateProcessModuleDefinition(module);
    return {
      identity: module.identity,
      input_schema: module.inputContract.id,
      output_schema: module.outputContract.id,
      outcomes: module.outcomes.map(outcome => outcome.code),
      node_count: module.flow.nodes.length,
      lm_node_count: module.flow.nodes.filter(node => node.kind === 'lm').length,
      execution_profile_count: module.executionProfiles.length,
      valid: validation.valid,
      validation_errors: validation.errors,
      validation_warnings: validation.warnings,
    };
  });
  return { modules, count: modules.length };
}

function handleProcessModuleGet(args: Record<string, unknown>) {
  const name = requiredString(args, 'name');
  const version = requiredString(args, 'version');
  const module = registry.require({ name, version });
  return {
    module,
    validation: validateProcessModuleDefinition(module),
  };
}

function handleProcessModuleValidate(args: Record<string, unknown>) {
  const name = requiredString(args, 'name');
  const version = requiredString(args, 'version');
  const module = registry.require({ name, version });
  return {
    module_ref: `${name}@${version}`,
    ...validateProcessModuleDefinition(module),
  };
}

function handleProcessLifecycleGet() {
  return {
    lifecycle: discoveryToFormalizationLifecycle,
    validation: validateLifecycleDefinition(discoveryToFormalizationLifecycle, registry),
  };
}

export const definitions: Tool[] = [
  {
    name: 'process_module_list',
    description:
      'List registered Saga Process Modules with their versioned identity, contracts, local outcomes, Flow size and deterministic validation status. Read-only. Use this before designing a new module to inspect the installed module catalog.',
    annotations: {
      title: 'Process Module: List',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'process_module_get',
    description:
      'Read one registered Process Module definition by exact name and semantic version. Returns contracts, outcomes, Flow, artifacts, policies, invariants, execution profiles and validation result. Read-only.',
    annotations: {
      title: 'Process Module: Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact module name, for example product-discovery.' },
        version: { type: 'string', description: 'Exact semantic version, for example 3.0.0.' },
      },
      required: ['name', 'version'],
    },
  },
  {
    name: 'process_module_validate',
    description:
      'Run deterministic structural validation for one registered Process Module. Checks identity/version, outcomes, Flow reachability, terminal nodes, execution profiles, tracker/checklist declarations, policies, invariants and artifact uniqueness. Read-only.',
    annotations: {
      title: 'Process Module: Validate',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact registered module name.' },
        version: { type: 'string', description: 'Exact registered module version.' },
      },
      required: ['name', 'version'],
    },
  },
  {
    name: 'process_lifecycle_get',
    description:
      'Read and validate the built-in Discovery-to-Formalization Lifecycle. Shows Stage Bindings, input/output mappings and local-outcome routes. Read-only.',
    annotations: {
      title: 'Process Lifecycle: Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  process_module_list: handleProcessModuleList,
  process_module_get: handleProcessModuleGet,
  process_module_validate: handleProcessModuleValidate,
  process_lifecycle_get: handleProcessLifecycleGet,
};
