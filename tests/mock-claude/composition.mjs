/**
 * Composition override для scripted workers.
 *
 * Usage: SAGA_PRODUCT_LIFECYCLE_COMPOSITION=tests/mock-claude/composition.mjs
 *
 * Внедряет ScriptedWorkerExecutorFactory через DI port. Production factory
 * не создаётся. Delivery/Development providers наследуются из base composition.
 *
 * Документ §8.9: "A test may inject delivery providers and WorkerExecutorFactory
 * because those are explicit ports in current composition."
 */
import { createScriptedWorkerExecutorFactory } from './scripted-executor.mjs';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from '../../dist/modules/development/domain/development-settlement-policy.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from '../../dist/modules/delivery/domain/delivery-settlement-policy.js';

export async function createProductLifecycleComposition(context) {
  const { env, cwd } = context;

  return {
    workerExecutorFactory: createScriptedWorkerExecutorFactory(),
    resolveWorkerContext: (ctx) => ({
      projectId: ctx.projectId,
      epicId: ctx.epicId ?? 0,
      workspaceRoot: cwd,
      dbPath: env.DB_PATH,
      sagaEntry: `${cwd}/dist/index.js`,
      sagaSkillRoot: cwd,
      claudePath: undefined,
      lmStudioUrl: env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1',
    }),

    development: {
      taskGraphPolicy: new ReferenceDevelopmentTaskGraphPolicy(),
      settlementPolicy: new ReferenceDevelopmentSettlementPolicy(),
    },

    delivery: {
      preflightPolicy: new ReferenceDeliveryPreflightPolicy(),
      settlementPolicy: new ReferenceDeliverySettlementPolicy(),
      providers: {
        preflightChecks: [],
        approvalSource: { pending: async () => null },
        actionProviders: [],
        observeCurrentCandidateHash: async () => null,
      },
    },
  };
}
