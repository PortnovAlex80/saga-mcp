/**
 * ProcessModuleInstallationRegistry — runtime registry of runnable modules.
 *
 * Distinct from ProcessModuleRegistry (the catalog): the catalog stores
 * Definitions (read-only, no executor); this registry stores Installations
 * (Definition + Executor). The Runtime consults the Installation registry to
 * answer "can this module be started? with which executor?".
 *
 * Invariants:
 *   - An Installation cannot be registered without a valid Definition AND a
 *     matching executor (validateProcessModuleInstallation enforces the match).
 *   - One Installation per module ref. Re-registering the same ref throws.
 *   - The catalog and installation registry can overlap (a module may be both
 *     catalogued and installed) or diverge (a module catalogued but not yet
 *     installed is inspectable but not startable; a module installed but not
 *     in the catalog is a runtime-only binding — rare, allowed for tests).
 */

import { processModuleKey, type ProcessModuleReference } from '../domain/process-module.js';
import { validateProcessModuleDefinition } from './validate-process-module.js';
import {
  validateProcessModuleInstallation,
  type ValidateProcessModuleInstallationOptions,
} from './validate-process-module-installation.js';
import type { ProcessModuleInstallation } from './process-module-executor.js';
import type { KernelHandlerRegistry } from './kernel-handler-registry.js';

export class ProcessModuleInstallationRegistrationError extends Error {
  constructor(
    readonly moduleRef: ProcessModuleReference,
    readonly errors: readonly string[],
  ) {
    super(
      `process module installation ${processModuleKey(moduleRef)} is invalid: ${errors.join('; ')}`,
    );
    this.name = 'ProcessModuleInstallationRegistrationError';
  }
}

export class ProcessModuleInstallationRegistry {
  private readonly installations = new Map<string, ProcessModuleInstallation>();
  private readonly kernelHandlerRegistry: KernelHandlerRegistry | null;

  constructor(options: { kernelHandlerRegistry?: KernelHandlerRegistry } = {}) {
    this.kernelHandlerRegistry = options.kernelHandlerRegistry ?? null;
  }

  /**
   * Register an Installation. Validates BOTH the Definition (structural) and
   * the binding (definition↔executor match). Throws if either fails or if the
   * module ref is already installed.
   *
   * For `generic-flow` executors the registry also validates kernel-handler
   * coverage against the KernelHandlerRegistry passed at construction time:
   * every `KernelFlowNodeDefinition.handler` (except the runtime-provided
   * `process-outcome-emitter`) must be registered before the module can be
   * installed. This makes "unbacked handler id" a fail-fast at startup rather
   * than a surprise at first dispatch.
   */
  register(installation: ProcessModuleInstallation): void {
    const key = processModuleKey(installation.definition.identity);

    // Definition structural validation — re-runs the catalog validator so an
    // installation never carries an invalid definition, even if the caller
    // bypassed the catalog.
    const defValidation = validateProcessModuleDefinition(installation.definition);
    if (!defValidation.valid) {
      throw new ProcessModuleInstallationRegistrationError(
        installation.definition.identity,
        defValidation.errors,
      );
    }

    const validationOptions: ValidateProcessModuleInstallationOptions = {};
    if (this.kernelHandlerRegistry) {
      validationOptions.kernelHandlerRegistry = this.kernelHandlerRegistry;
    }
    const bindingValidation = validateProcessModuleInstallation(
      installation,
      validationOptions,
    );
    if (!bindingValidation.valid) {
      throw new ProcessModuleInstallationRegistrationError(
        installation.definition.identity,
        bindingValidation.errors,
      );
    }

    if (this.installations.has(key)) {
      throw new Error(`process module installation ${key} is already registered`);
    }
    this.installations.set(key, installation);
  }

  /**
   * Resolve an Installation by module ref. Returns null if the module is not
   * installed (it may still be catalogued without an executor).
   */
  get(reference: ProcessModuleReference): ProcessModuleInstallation | null {
    return this.installations.get(processModuleKey(reference)) ?? null;
  }

  /**
   * Resolve an Installation, throwing if absent. Used by the Runtime when it
   * needs to actually execute — a catalogued-but-not-installed module cannot
   * be started.
   */
  require(reference: ProcessModuleReference): ProcessModuleInstallation {
    const installation = this.get(reference);
    if (!installation) {
      throw new Error(
        `process module ${processModuleKey(reference)} is not installed `
        + '(catalogued without executor, or not registered at all)',
      );
    }
    return installation;
  }

  list(): readonly ProcessModuleInstallation[] {
    return [...this.installations.values()];
  }
}
