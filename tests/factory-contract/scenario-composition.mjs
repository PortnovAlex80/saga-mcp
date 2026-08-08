// tests/factory-contract/scenario-composition.mjs
//
// Composition override for scenario-driven scripted workers.
// Test code substitutes ONLY explicit ports: WorkerExecutorFactory and Delivery
// external providers. Factory authority, gates, CandidateSets, effects and
// lifecycle routing remain production implementations.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
import { sha256Hex } from '../../dist/shared/canonical-json.js';

export const FACTORY_CONTRACT_PREFLIGHT_PROVIDER = {
  providerId: 9101,
  name: 'factory-contract-preflight',
  version: '1.0.0',
  category: 'deterministic_evidence',
};
export const FACTORY_CONTRACT_ACTION_PROVIDER = {
  providerId: 9102,
  name: 'factory-contract-deployment-state',
  version: '1.0.0',
  category: 'authoritative_state',
};

function providerEvidence(prefix, body) {
  const hash = sha256Hex(body);
  return { schema: `factory.${prefix}.v1`, ref: `${prefix}:${hash}`, hash };
}

export async function createProductLifecycleComposition(context) {
  const { env, cwd } = context;
  const releaseStateRoot = path.join(env.SAGA_BUTTON_REPO_PATH || cwd, '.git');
  const releaseStatePath = actionKey => path.join(
    releaseStateRoot,
    `.factory-contract-release-${sha256Hex(actionKey)}.json`,
  );

  const preflight = {
    evaluate({ deliveryCase, checkId }) {
      const body = {
        checkId,
        candidateHash: deliveryCase.integratedCandidate.hash,
        result: 'passed',
      };
      return {
        outcome: 'passed',
        evidence: providerEvidence('factory-contract-preflight-evidence', body),
        provider: FACTORY_CONTRACT_PREFLIGHT_PROVIDER,
      };
    },
  };

  const deployment = {
    namespace: 'factory-contract-deployment',
    identity: FACTORY_CONTRACT_ACTION_PROVIDER,
    async execute({ action, actionKey }) {
      const marker = releaseStatePath(actionKey);
      const state = {
        actionKey,
        target: action.target,
        desiredStateHash: action.desiredStateHash,
      };
      writeFileSync(marker, JSON.stringify(state), 'utf8');
      return {
        outcome: 'succeeded',
        externalRef: `factory-contract:${sha256Hex(actionKey)}`,
        resultHash: sha256Hex(state),
      };
    },
    async observe({ action, actionKey }) {
      const marker = releaseStatePath(actionKey);
      let observedStateHash = 'factory-contract:not-applied';
      if (existsSync(marker)) {
        try {
          const state = JSON.parse(readFileSync(marker, 'utf8'));
          if (state?.actionKey === actionKey && state?.target === action.target) {
            observedStateHash = String(state.desiredStateHash || '');
          }
        } catch {
          observedStateHash = 'factory-contract:corrupt-state';
        }
      }
      const matched = observedStateHash === action.desiredStateHash;
      const body = { actionKey, target: action.target, observedStateHash, matched };
      return {
        outcome: matched ? 'matched' : 'mismatched',
        observedStateHash,
        observation: providerEvidence('factory-contract-deployment-observation', body),
      };
    },
  };

  return {
    workerExecutorFactory: createScriptedWorkerExecutorFactory({
      dispatcherPath: fileURLToPath(new URL('./scenario-dispatcher.mjs', import.meta.url)),
      scenariosPath: env.SAGA_SCENARIOS,
      invocationLogPath: env.SAGA_INVOCATION_LOG,
    }),
    resolveWorkerContext: ctx => ({
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
        preflight,
        actionProviders: { deployment },
        observeCurrentCandidateHash(deliveryCase) {
          return deliveryCase.integratedCandidate.hash;
        },
      },
    },
  };
}
