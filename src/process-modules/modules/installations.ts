/**
 * Built-in ProcessModuleInstallation registry.
 *
 * Wires each catalogued Definition to its executor. The registry may be
 * constructed with a KernelHandlerRegistry so that `generic-flow` installations
 * fail-fast at startup when a declared kernel handler has no registered callable
 * (P6c handler-coverage check).
 *
 * The Installation registry is injected into the Runtime in the composition
 * root.
 */

import { ProcessModuleInstallationRegistry } from '../application/process-module-installation-registry.js';
import type { ProcessModuleInstallation } from '../application/process-module-executor.js';
import type { KernelHandlerRegistry } from '../application/kernel-handler-registry.js';
import type { ExternalAdapterRegistry } from '../application/external-adapter-registry.js';
import type { HumanInteractionRegistry } from '../application/human-interaction-registry.js';

export interface CreateInstallationRegistryOptions {
  /**
   * When provided, installation validation checks that every kernel-node
   * handler (except the runtime-provided process-outcome-emitter) resolves to
   * a registered callable. Recommended for generic-flow installations.
   */
  kernelHandlerRegistry?: KernelHandlerRegistry;
  externalAdapterRegistry?: ExternalAdapterRegistry;
  humanInteractionRegistry?: HumanInteractionRegistry;
}

export function createBuiltInProcessModuleInstallationRegistry(
  installations: readonly ProcessModuleInstallation[],
  options: CreateInstallationRegistryOptions = {},
): ProcessModuleInstallationRegistry {
  const registry = new ProcessModuleInstallationRegistry(options);
  for (const installation of installations) {
    registry.register(installation);
  }
  return registry;
}
