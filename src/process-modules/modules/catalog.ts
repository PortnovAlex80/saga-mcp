import { ProcessModuleRegistry } from '../application/process-module-registry.js';
import { discoveryProcessModule } from './discovery/discovery-process-module.js';
import { formalizationProcessModule } from './formalization/formalization-process-module.js';
import { developmentProcessModule } from './development/development-process-module.js';
import { deliveryProcessModule } from './delivery/delivery-process-module.js';

export function createBuiltInProcessModuleRegistry(): ProcessModuleRegistry {
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  registry.register(formalizationProcessModule);
  registry.register(developmentProcessModule);
  registry.register(deliveryProcessModule);
  return registry;
}
