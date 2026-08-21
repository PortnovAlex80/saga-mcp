/**
 * Refactor Phase 2 / R1 (PROCESS-MODULE-ARCHITECTURAL-REFACTORING-GUIDE §6,
 * NEW-WORKSHOP-DESIGN-AUTHORING-GUIDE §6): the target public surface of a
 * built-in workshop — ONE descriptor, ONE declaration-to-binding closure.
 *
 * TYPE-ONLY by design tonight: no catalog, no import rewiring, no runtime
 * consumer. The characterization test (workshop-descriptor.test.mjs) proves
 * all four installed workshops already FIT this shape; the co-location
 * cutover (R3-R5) later makes each workshop EXPORT it literally.
 *
 * The architectural property (guide §6):
 *   one workshop -> one public descriptor -> one declaration-to-binding
 *   closure -> one closed built-in catalog entry.
 */

import type { ProcessModuleDefinition } from '../domain/process-module.js';
import type { ProcessModuleManifest } from './workshop-capability-manifest.js';

/** What a workshop declares it needs from the host at binding time. */
export interface WorkshopBindingContext {
  readonly db: unknown;
  readonly providers: Record<string, unknown>;
}

/** Runtime bindings resolved from a declaration — never registered globally. */
export interface WorkshopRuntimeBindings {
  readonly checkProviders: readonly unknown[];
  readonly kernelHandlers: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly payloadContracts: readonly unknown[];
}

export interface BuiltInWorkshop {
  readonly manifest: ProcessModuleManifest;
  readonly definition: ProcessModuleDefinition;
  createBindings(context: WorkshopBindingContext): WorkshopRuntimeBindings;
}
