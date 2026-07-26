/**
 * Validation for a ProcessModuleInstallation.
 *
 * The Definition is validated separately (validateProcessModuleDefinition) —
 * structural checks on identity, flow, outcomes, profiles. Installation
 * validation is ORTHOGONAL: it checks the binding between Definition and
 * Executor, NOT the Definition's internal shape. This keeps the two validators
 * composable (an Installation re-validates its Definition via the catalog) and
 * lets an author register a Definition without an executor while still
 * benefiting from the catalog's read-only validation.
 *
 * Rules enforced:
 *   1. definition.identity must equal executor.moduleRef (exact name+version).
 *   2. executor.kind must be one of the declared EXECUTOR_KINDS.
 *   3. For `generic-flow` executors: every `KernelFlowNodeDefinition.handler`
 *      in the flow must resolve to a registered callable in the provided
 *      KernelHandlerRegistry (fail-fast at install time, not at first
 *      dispatch — closes the "P2 will add" probe gap for kernel handlers).
 *      The `process-outcome-emitter` handler is always provided by the Runtime
 *      and need NOT be registered by the module.
 *   4. (P2/conformance kit will add: probe run that checks the executor
 *      actually produces a valid ProcessModuleRunResult.)
 */

import { EXECUTOR_KINDS } from '../persistence/process-run.js';
import { processModuleKey } from '../domain/process-module.js';
import type { ProcessModuleInstallation } from './process-module-executor.js';
import type { KernelHandlerRegistry } from './kernel-handler-registry.js';
import { PROCESS_OUTCOME_EMITTER_HANDLER_ID } from './handlers/process-outcome-emitter.js';

export interface ProcessModuleInstallationValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidateProcessModuleInstallationOptions {
  /**
   * Kernel handler registry to validate handler coverage against. Required for
   * `generic-flow` executors; ignored for other kinds. When omitted for a
   * `generic-flow` executor, handler coverage is skipped (caller takes the
   * risk of an unbacked handler id surfacing at dispatch time).
   */
  kernelHandlerRegistry?: KernelHandlerRegistry;
}

export function validateProcessModuleInstallation(
  installation: ProcessModuleInstallation,
  options: ValidateProcessModuleInstallationOptions = {},
): ProcessModuleInstallationValidationResult {
  const errors: string[] = [];
  const { definition, executor } = installation;

  const defKey = processModuleKey(definition.identity);
  const execKey = processModuleKey(executor.moduleRef);
  if (defKey !== execKey) {
    errors.push(
      `installation binding mismatch: definition '${defKey}' vs executor '${execKey}'`,
    );
  }

  const validKinds = new Set<string>(EXECUTOR_KINDS as readonly string[]);
  if (!validKinds.has(executor.kind as string)) {
    errors.push(
      `executor kind '${executor.kind}' is invalid; expected one of [${EXECUTOR_KINDS.join(', ')}]`,
    );
  }

  // Rule 3: for generic-flow executors, every kernel node's handler must be
  // registered (except the runtime-provided process-outcome-emitter).
  if (executor.kind === 'generic-flow' && options.kernelHandlerRegistry) {
    const registry = options.kernelHandlerRegistry;
    const kernelHandlers = new Set<string>();
    for (const node of definition.flow.nodes) {
      if (node.kind !== 'kernel') continue;
      const handlerId = node.handler;
      if (kernelHandlers.has(handlerId)) continue;
      kernelHandlers.add(handlerId);
      if (handlerId === PROCESS_OUTCOME_EMITTER_HANDLER_ID) continue;
      if (!registry.has(handlerId)) {
        errors.push(
          `kernel node '${node.id}' declares handler '${handlerId}' that is not `
            + `registered in the KernelHandlerRegistry — register it before installing `
            + `the module (generic-flow executor dispatches by handler id)`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
