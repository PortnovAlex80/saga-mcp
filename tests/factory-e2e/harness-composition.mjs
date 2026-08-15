// tests/factory-e2e/harness-composition.mjs
//
// ProductLifecycleCompositionOverrides for the W9 fresh harness. Mirrors
// tests/factory-contract/scenario-composition.mjs but substitutes the
// IN-PROCESS scripted executor (scripted-inference.mjs) for the spawn-based
// scenario dispatcher, and supplies the explicit Delivery providers the
// lifecycle runtime requires.
//
// Factory authority, gates, CandidateSets, effects and lifecycle routing stay
// production implementations. Only worker INFERENCE is substituted (the
// canonical workerExecutorFactory seam — Factory Contract Harness §8.9).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInProcessScriptedExecutorFactory } from './scripted-inference.mjs';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from '../../dist/modules/development/domain/development-settlement-policy.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from '../../dist/modules/delivery/domain/delivery-settlement-policy.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

export const FRESH_HARNESS_PREFLIGHT_PROVIDER = {
  providerId: 9001,
  name: 'fresh-harness-preflight',
  version: '1.0.0',
  category: 'deterministic_evidence',
};

export const FRESH_HARNESS_DEPLOYMENT_PROVIDER = {
  providerId: 9002,
  name: 'fresh-harness-deployment-state',
  version: '1.0.0',
  category: 'authoritative_state',
};

function providerEvidence(prefix, body) {
  const hash = sha256Hex(body);
  return { schema: `factory.${prefix}.v1`, ref: `${prefix}:${hash}`, hash };
}

/**
 * Build the ProductLifecycleCompositionOverrides for a fresh-harness drive.
 *
 * @param {object} opts
 * @param {object} opts.observer  Scripted observer (from createScriptedObserver).
 * @param {string} opts.repoPath  Fresh per-run git repo (release-state markers live under .git).
 * @param {string} opts.sagaRepoRoot  saga-mcp repo root (sagaEntry = <root>/dist/index.js).
 * @param {Record<string, Function>} [opts.handlers]  Optional scripted scenario handlers.
 * @param {object} [opts.crashPoint]  Optional deterministic crash point (W9-03).
 */
export function buildHarnessComposition(opts) {
  const { observer, repoPath, sagaRepoRoot, handlers, crashPoint } = opts;
  const scriptedExecutorFactory = createInProcessScriptedExecutorFactory({
    observer,
    handlers: handlers ?? {},
    crashPoint: crashPoint ?? null,
  });

  const releaseStateRoot = path.join(repoPath, '.git');
  const releaseStatePath = actionKey => path.join(
    releaseStateRoot,
    `.fresh-harness-release-${sha256Hex(actionKey)}.json`,
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
        evidence: providerEvidence('fresh-harness-preflight-evidence', body),
        provider: FRESH_HARNESS_PREFLIGHT_PROVIDER,
      };
    },
  };

  const deployment = {
    namespace: 'fresh-harness-deployment',
    identity: FRESH_HARNESS_DEPLOYMENT_PROVIDER,
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
        externalRef: `fresh-harness:${sha256Hex(actionKey)}`,
        resultHash: sha256Hex(state),
      };
    },
    async observe({ action, actionKey }) {
      const marker = releaseStatePath(actionKey);
      let observedStateHash = 'fresh-harness:not-applied';
      if (existsSync(marker)) {
        try {
          const state = JSON.parse(readFileSync(marker, 'utf8'));
          if (state?.actionKey === actionKey && state?.target === action.target) {
            observedStateHash = String(state.desiredStateHash || '');
          }
        } catch {
          observedStateHash = 'fresh-harness:corrupt-state';
        }
      }
      const matched = observedStateHash === action.desiredStateHash;
      const body = { actionKey, target: action.target, observedStateHash, matched };
      return {
        outcome: matched ? 'matched' : 'mismatched',
        observedStateHash,
        observation: providerEvidence('fresh-harness-deployment-observation', body),
      };
    },
  };

  return {
    workerExecutorFactory: scriptedExecutorFactory,
    resolveWorkerContext: ctx => ({
      projectId: ctx.projectId,
      epicId: ctx.epicId ?? 0,
      workspaceRoot: repoPath,
      dbPath: process.env.DB_PATH,
      sagaEntry: path.resolve(sagaRepoRoot, 'dist/index.js'),
      sagaSkillRoot: sagaRepoRoot,
      claudePath: undefined,
      lmStudioUrl: process.env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1',
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
