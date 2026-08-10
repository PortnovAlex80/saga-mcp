// tests/factory-temporal\lib\temporal-composition.mjs
//
// Canonical composition for temporal conformance tests. Mirrors
// tests/factory-contract/scenario-composition.mjs but isolates temporal
// scenarios from the contract scenarios directory and makes the worker
// executor factory pluggable per-test (so fault-injection scenarios can
// inject crash-on-boundary executors).
//
// STRICT OVERLAY ALLOWLIST — what this composition replaces:
//   1. workerExecutorFactory  → scripted or fault-injecting executor
//   2. verificationCheckProviderFactory → test provider (trusts well-formed LM assessments)
//   3. delivery preflight/action/observe providers → deterministic file-marker providers
//
// What this composition NEVER replaces:
//   - lifecycle selection (productBuildLifecycle)
//   - stage routing (LifecycleOrchestrator)
//   - package installation (installProductionModules)
//   - repository implementations (SQLite)
//   - settlement policy
//   - CandidateSet sealing
//   - GateRun driving
//   - effect semantics (GitIntegrationEffect, ReplayCaptureEffect)
//   - recovery policy (ProductionCellCoordinator)
//
// The composition-fingerprint test (composition-fingerprint.test.mjs) asserts
// that this overlay does not add or remove any of the above production pieces.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScriptedWorkerExecutorFactory } from '../../factory-contract/scenario-scripted-executor.mjs';
import { createTestVerificationCheckProviderFactory } from '../../factory-contract/test-verification-check-provider.mjs';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from '../../../dist/modules/development/domain/development-settlement-policy.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from '../../../dist/modules/delivery/domain/delivery-settlement-policy.js';
import { sha256Hex } from '../../../dist/shared/canonical-json.js';

export const TEMPORAL_PREFLIGHT_PROVIDER = {
  providerId: 9101,
  name: 'factory-contract-preflight',
  version: '1.0.0',
  category: 'deterministic_evidence',
};
export const TEMPORAL_ACTION_PROVIDER = {
  providerId: 9102,
  name: 'factory-contract-deployment-state',
  version: '1.0.0',
  category: 'authoritative_state',
};

function providerEvidence(prefix, body) {
  const hash = sha256Hex(body);
  return { schema: `factory.${prefix}.v1`, ref: `${prefix}:${hash}`, hash };
}

/**
 * Build the canonical composition for a temporal test run.
 *
 * Reads scenario path and invocation log from env (SAGA_SCENARIOS,
 * SAGA_INVOCATION_LOG), matching how orchestrate-cli wires the composition.
 * A fault-injecting executor may be injected via
 * SAGA_TEMPORAL_EXECUTOR_FACTORY_PATH; otherwise the standard scripted
 * executor (scenario-scripted-executor.mjs) is used.
 */
export async function createProductLifecycleComposition(context) {
  const { env, cwd } = context;
  const scenariosPath = env.SAGA_SCENARIOS;
  const invocationLogPath = env.SAGA_INVOCATION_LOG;
  const workerExecutorFactoryOverride = env.SAGA_TEMPORAL_EXECUTOR_FACTORY_PATH
    ? (await import(fileURLToPath(new URL(env.SAGA_TEMPORAL_EXECUTOR_FACTORY_PATH, import.meta.url)))).default
      ?? (await import(fileURLToPath(new URL(env.SAGA_TEMPORAL_EXECUTOR_FACTORY_PATH, import.meta.url)))).createFaultInjectingExecutorFactory()
    : null;

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
        provider: TEMPORAL_PREFLIGHT_PROVIDER,
      };
    },
  };

  const deployment = {
    namespace: 'factory-contract-deployment',
    identity: TEMPORAL_ACTION_PROVIDER,
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
    // The ONLY production port replaced. Temporal scenarios may inject a
    // fault-injecting executor via SAGA_TEMPORAL_EXECUTOR_FACTORY_PATH; the
    // default is the scripted executor that spawns scenario-dispatcher.
    workerExecutorFactory: workerExecutorFactoryOverride
      ? workerExecutorFactoryOverride({ scenariosPath, invocationLogPath })
      : createScriptedWorkerExecutorFactory({
        dispatcherPath: fileURLToPath(new URL('../../factory-contract/scenario-dispatcher.mjs', import.meta.url)),
        scenariosPath,
        invocationLogPath,
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
      // These are PRODUCTION Reference policies (the same classes the canonical
      // composition uses), NOT test-specific replacements. They are bound
      // explicitly to guarantee the test uses the reference settlement/task-graph
      // policy, not a stale or accidental default. ADR-048 allows replacing only
      // the inference port (workerExecutorFactory) and the declared check-provider
      // port (verificationCheckProviderFactory). The policy bindings below are
      // the SAME production policies — they are not "replacements" in the ADR-048
      // sense. The overlay allowlist ratchet (OVERLAY_ALLOWLIST) documents that
      // a composition claiming to be canonical must NOT bind different policy
      // classes; this test composition binds the EXACT same classes.
      taskGraphPolicy: new ReferenceDevelopmentTaskGraphPolicy(),
      settlementPolicy: new ReferenceDevelopmentSettlementPolicy(),
      // The ONLY true test port replacement: the verification check provider
      // trusts well-formed LM assessments instead of always returning 'unknown'.
      verificationCheckProviderFactory: createTestVerificationCheckProviderFactory(),
    },

    delivery: {
      // Same Reference policies as production (see comment above).
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
