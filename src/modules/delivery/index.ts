/**
 * Delivery module registration (the LEGO contract).
 *
 * `registerDelivery(registries, sharedDeps, options)` constructs Delivery's
 * module-specific concrete adapters (approval inbox, runtime, providers,
 * output repository), registers its kernel handlers AND its human
 * interactions (the delivery approval interaction), builds its
 * `GenericFlowExecutor`, and registers the module definition + installation.
 * Called once from the composition root.
 *
 * Returns the executor plus the runtime, approval inbox and output repository
 * the composition root's public return surface exposes.
 *
 * This file lives under `src/modules/` (the module-scoped tree); the SQLite-
 * substrate gates that cover `src/process-modules/modules/` do not apply here.
 */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { SqliteDeliveryOutputRepository } from './infrastructure/delivery-persistence.js';
import { SqliteDeliveryApprovalInbox } from './infrastructure/sqlite-delivery-approval-inbox.js';
import { SqliteDeliveryRuntime } from './infrastructure/sqlite-delivery-runtime.js';
import {
  createDeliveryProcessProductPort,
  createDeliveryExternalEffectLedgerPort,
} from '../../infrastructure/process-modules/delivery-ports.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from './domain/delivery-settlement-policy.js';
import {
  createDeliveryHumanInteractions,
  createDeliveryKernelHandlers,
  createDeliveryOutputResolver,
} from './application/delivery-installation.js';
import { deliveryProcessModule } from '../../process-modules/modules/delivery/delivery-process-module.js';
import type {
  DeliveryApprovalPort,
  DeliveryObservationPort,
  DeliveryPreflightStatePort,
  DeliveryPublicationPort,
  DeliverySettlementStatePort,
  DeliveryModuleInstallationDependencies,
  DeliveryOutputRepository,
} from './domain/delivery-kernel-ports.js';
import type {
  DeliveryApprovalSource,
  DeliveryRuntimeProviders,
} from './domain/delivery-provider-ports.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

/**
 * Delivery provider configuration — the runtime providers minus the mandatory
 * `approval` (which defaults to the approval inbox when not supplied).
 */
export type DeliveryProviderConfiguration =
  Omit<DeliveryRuntimeProviders, 'approval'> & {
    approval?: DeliveryApprovalSource;
  };

/**
 * Delivery-specific overrides. Mirrors the historical
 * `DeliveryCompositionDependencies`. The composition must never fabricate an
 * external success or a human decision, so preflight/publication/observation/
 * approval providers remain explicit overrides (no defaults).
 */
export interface DeliveryCompositionDependencies {
  runtime?: SqliteDeliveryRuntime;
  providers?: DeliveryProviderConfiguration;
  approvalInbox?: SqliteDeliveryApprovalInbox;
  preflightState?: DeliveryPreflightStatePort;
  approval?: DeliveryApprovalPort;
  publication?: DeliveryPublicationPort;
  observation?: DeliveryObservationPort;
  settlementState?: DeliverySettlementStatePort;
  preflightPolicy?: DeliveryModuleInstallationDependencies['preflightPolicy'];
  settlementPolicy?: DeliveryModuleInstallationDependencies['settlementPolicy'];
  outputRepository?: DeliveryOutputRepository;
}

/** Alias for {@link DeliveryCompositionDependencies}. */
export type RegisterDeliveryOptions = DeliveryCompositionDependencies;

/** Module-specific artifacts the composition root exposes on its return surface. */
export interface DeliveryRegistration {
  executor: GenericFlowExecutor;
  /** The delivery runtime (null when only individual ports were supplied). */
  runtime: SqliteDeliveryRuntime | null;
  approvalInbox: SqliteDeliveryApprovalInbox;
  outputRepository: DeliveryOutputRepository;
}

function requireDeliveryPort<T>(
  port: T | null | undefined,
  name: string,
): T {
  if (port) return port;
  throw new Error(
    `PRODUCT_LIFECYCLE_COMPOSITION_INCOMPLETE: delivery.${name}; `
    + 'provide a complete Delivery port set, a SqliteDeliveryRuntime, or '
    + 'delivery.providers for the standard runtime',
  );
}

/**
 * Register the Delivery Process Module. Mutates `registries` in place.
 */
export function registerDelivery(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  options: RegisterDeliveryOptions,
): DeliveryRegistration {
  const { db, certificateRepo } = sharedDeps;

  const approvalInbox = options.approvalInbox
    ?? new SqliteDeliveryApprovalInbox(db);
  const providers: DeliveryRuntimeProviders | null =
    options.providers
      ? {
        ...options.providers,
        approval: options.providers.approval ?? approvalInbox,
      }
      : null;
  const runtime = options.runtime
    ?? (providers
      ? new SqliteDeliveryRuntime({
        db,
        providers,
        // Injected concrete adapters (composition root owns construction) so
        // the Delivery module imports no getDb/Sqlite*.
        products: createDeliveryProcessProductPort(db),
        effectLedger: createDeliveryExternalEffectLedgerPort(db),
      })
      : null);
  const preflightPolicy = options.preflightPolicy
    ?? new ReferenceDeliveryPreflightPolicy();
  const outputRepository = options.outputRepository
    ?? new SqliteDeliveryOutputRepository(db);
  const deps: DeliveryModuleInstallationDependencies = {
    preflightState: requireDeliveryPort(
      options.preflightState ?? runtime,
      'preflightState',
    ),
    approval: requireDeliveryPort(
      options.approval ?? runtime,
      'approval',
    ),
    publication: requireDeliveryPort(
      options.publication ?? runtime,
      'publication',
    ),
    observation: requireDeliveryPort(
      options.observation ?? runtime,
      'observation',
    ),
    settlementState: requireDeliveryPort(
      options.settlementState ?? runtime,
      'settlementState',
    ),
    preflightPolicy,
    settlementPolicy: options.settlementPolicy
      ?? new ReferenceDeliverySettlementPolicy(preflightPolicy),
    outputRepository,
    // The delivery settlement kernel issues its own ProcessOutcomeCertificate
    // and emits an explicit ModuleCompletion.
    certificateRepo,
  };

  // Register kernel handlers + human interactions (delivery approval).
  registries.kernelHandlers.registerAll(createDeliveryKernelHandlers(deps));
  registries.humanInteractions.registerAll(createDeliveryHumanInteractions(deps));

  // Build the executor.
  const executor = new GenericFlowExecutor({
    moduleRef: deliveryProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    nodeExecutors: sharedDeps.nodeExecutors,
    recoveryCaseRepo: sharedDeps.recoveryCaseRepo,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createDeliveryOutputResolver(outputRepository),
    onWorkplaceVerified: sharedDeps.onWorkplaceVerified,
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });

  // Register module definition + installation.
  registries.moduleRegistry.register(deliveryProcessModule);
  registries.installationRegistry.register({
    definition: deliveryProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, runtime, approvalInbox, outputRepository };
}
