import type {
  KernelHandler,
  KernelHandlerContext,
} from '../../../process-modules/application/kernel-handler-registry.js';
import { acceptedSingletonExecutionReceipt } from '../../../process-modules/application/production-cell-output.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../domain/development-kernel-ports.js';
import type { DevelopmentModuleInstallationDependencies } from '../domain/development-kernel-ports.js';
import {
  createDevelopmentKernelHandlers as createLegacyKernelHandlers,
  createDevelopmentOutputPayloadResolver,
  createDevelopmentOutputResolver,
} from './development-installation.js';

export { createDevelopmentOutputPayloadResolver, createDevelopmentOutputResolver };

/**
 * Target Production Cell adapter for Development kernel operations.
 *
 * The planner is no longer a physical `lm` Flow node. Its accepted Cell
 * manifest is the only predecessor product. The existing canonicalizer still
 * consumes a NodeExecutionReceipt-shaped producer fence internally, so this
 * adapter derives that fence from the accepted CandidateSet manifest. No task
 * projection or standalone LM execution is authoritative.
 */
export function createDevelopmentKernelHandlers(
  deps: DevelopmentModuleInstallationDependencies,
): Record<string, KernelHandler> {
  const handlers = createLegacyKernelHandlers(deps);
  const canonicalize = handlers[DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph];
  if (!canonicalize) {
    throw new Error('DEVELOPMENT_TASK_GRAPH_CANONICALIZER_MISSING');
  }
  return {
    ...handlers,
    [DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph]: (
      ctx: KernelHandlerContext,
    ) => canonicalize({
      ...ctx,
      input: acceptedSingletonExecutionReceipt(
        ctx.input,
        DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph,
      ),
    }),
  };
}
