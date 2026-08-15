import {
  processModuleKey,
  type ProcessModuleDefinition,
  type ProcessModuleReference,
} from '../domain/process-module.js';
import { validateProcessModuleDefinition } from './validate-process-module.js';

export class ProcessModuleRegistrationError extends Error {
  constructor(
    readonly moduleRef: ProcessModuleReference,
    readonly validationErrors: readonly string[],
  ) {
    super(
      `process module ${processModuleKey(moduleRef)} is invalid: ${validationErrors.join('; ')}`,
    );
    this.name = 'ProcessModuleRegistrationError';
  }
}

export class ProcessModuleRegistry {
  private readonly modules = new Map<string, ProcessModuleDefinition>();

  register(module: ProcessModuleDefinition): void {
    const key = processModuleKey(module.identity);
    const validation = validateProcessModuleDefinition(module);
    if (!validation.valid) {
      throw new ProcessModuleRegistrationError(module.identity, validation.errors);
    }
    if (this.modules.has(key)) {
      throw new Error(`process module ${key} is already registered`);
    }
    this.modules.set(key, module);
  }

  get(reference: ProcessModuleReference): ProcessModuleDefinition | null {
    return this.modules.get(processModuleKey(reference)) ?? null;
  }

  require(reference: ProcessModuleReference): ProcessModuleDefinition {
    const module = this.get(reference);
    if (!module) throw new Error(`process module ${processModuleKey(reference)} is not registered`);
    return module;
  }

  list(): readonly ProcessModuleDefinition[] {
    return [...this.modules.values()];
  }
}
