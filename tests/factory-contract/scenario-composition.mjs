// tests/factory-contract/scenario-composition.mjs
//
// Composition override for scenario-driven scripted workers.
// Injects a ScriptedWorkerExecutorFactory through the WorkerExecutorFactory DI port.
// The worker process runs scenario-dispatcher.mjs which loads scenario handlers
// from the module specified by SAGA_SCENARIOS env.
//
// This is the ONLY test infrastructure that touches the production composition.
// Production code never imports this file.

import { fileURLToPath } from 'node:url';
import { createScriptedWorkerExecutorFactory } from './scenario-scripted-executor.mjs';
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
    workerExecutorFactory: createScriptedWorkerExecutorFactory({
      dispatcherPath: fileURLToPath(new URL('./scenario-dispatcher.mjs', import.meta.url)),
      scenariosPath: env.SAGA_SCENARIOS,
      invocationLogPath: env.SAGA_INVOCATION_LOG,
    }),
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
