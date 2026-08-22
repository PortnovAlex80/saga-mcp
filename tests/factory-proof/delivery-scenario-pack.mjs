// tests/factory-proof/delivery-scenario-pack.mjs
//
// Delivery workshop pack — TRANCHE L-A (night 2026-08-22): topology + the
// authorized-release positive spine (approval NOT required — the direct
// lawful path into publication; guides §10, authoring guide §10).
//
// Delivery is the strongest non-LLM universality proof: NO execution
// profiles. The test seam controls ONLY the deterministic external
// providers (buildCanonicalDeliveryProviders) — kernel, human adapter,
// effect ledger, action keys, observation, settlement stay production.
//
// HONEST SCOPE: deferred/approval-required/denied/blocked paths, approval
// binding mutants, observation mismatch, restart boundaries are DECLARED
// pending — Delivery closure is NOT claimed by this tranche.

import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';
import { coverageToken } from './coverage-kernel.mjs';

export const DELIVERY_STAGE = 'delivery-release';
export const DEVELOPMENT_STAGE = 'solution-development';

export const DELIVERY_TOPOLOGY = Object.freeze({
  nodes: Object.freeze([
    Object.freeze({ id: 'preflight-release', kind: 'kernel' }),
    Object.freeze({ id: 'approve-release', kind: 'human' }),
    Object.freeze({ id: 'publish-deploy', kind: 'kernel', providers: ['publication'] }),
    Object.freeze({ id: 'observe-release', kind: 'kernel', providers: ['observation'] }),
    Object.freeze({ id: 'settle-delivery', kind: 'kernel' }),
  ]),
  outcomes: Object.freeze(['released', 'approval-required', 'blocked', 'failed']),
  executionProfiles: Object.freeze([]),
});

function terminalOracle(expected) {
  return {
    id: `delivery.terminal.${expected}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.lifecycleRuns ?? [])
        .filter(row => String(row.terminal_status ?? row.terminalStatus ?? '') === expected);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `lifecycle-run:${row.id}`),
        details: { expected, count: rows.length },
      };
    },
  };
}

function deliveryStageOutcomeOracle(expected) {
  return {
    id: `delivery.stage-outcome.${expected}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? [])
        .filter(row => row.stage_id === DELIVERY_STAGE && row.local_outcome === expected);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `stage-run:${row.id}`),
        details: { expected, count: rows.length },
      };
    },
  };
}

/** The publication effect left a durable ledger action with a deterministic
 * key, executed to `succeeded` by the publish node. This reads the REAL
 * delivery authority (factory_external_effect_actions, written by the
 * production external-effect ledger) — not the legacy generic receipt table
 * the delivery runtime never writes. */
function releaseEffectReceiptOracle() {
  return {
    id: 'delivery.publication.effect-receipt',
    evaluate({ durableTrace }) {
      const rows = (durableTrace.deliveryEffectActions ?? []).filter(row =>
        row.state === 'succeeded' && String(row.provider_effect_id ?? '') !== '');
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `${row.provider_namespace}:${row.action_key}`),
        details: {
          count: rows.length,
          allActions: durableTrace.deliveryEffectActions ?? [],
        },
      };
    },
  };
}

function noStrandedExecutionOracle() {
  return {
    id: 'factory.no-stranded-worker-executions',
    evaluate({ result }) {
      return {
        passed: result.strandedActiveExecutions === 0,
        details: { strandedActiveExecutions: result.strandedActiveExecutions },
      };
    },
  };
}

export const DELIVERY_PENDING_UNIVERSE = Object.freeze([
  'L:approval:pending-holds-publication',
  'L:approval:denied-blocked',
  'L:approval:binds-candidate+preflight+policy-hash',
  'L:publication:unknown-failure-routes-to-observation',
  'L:observation:mismatch-prevents-released',
  'L:observe-before-retry:no-duplicate-non-idempotent-effect',
  'L:candidate-immutability:drift-after-certification-blocks',
  'K4:crash-after-effect-before-receipt',
]);

export const DELIVERY_SCENARIOS = Object.freeze([
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/happy-released-authorized',
    kind: 'positive',
    proves: ['handoff.route-lifecycle', 'effect.deploy'],
    coverageItems: [
      coverageToken.obligation('handoff.route-lifecycle'),
      coverageToken.transition('settle-delivery', 'complete-released'),
      'handoff:solution-development->delivery-release:verified',
      'external:publication:deterministic-action-key',
      'external:observation:authoritative-state',
      'kernel:delivery:no-execution-profiles',
    ],
  }),
  // The authorization boundary, fail-closed: a DEFERRED delivery input (no
  // operator grant — the harness default) must end the lifecycle at the typed
  // 'approval-required' terminal with ZERO external effects. A release
  // without explicit authorization is unreachable by construction.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/deferred-approval-required',
    kind: 'positive',
    proves: ['handoff.route-lifecycle'],
    coverageItems: [
      'L:deferred:approval-required-without-external-action',
      coverageToken.transition('settle-delivery', 'complete-approval-required'),
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/restart-idempotent-settlement',
    kind: 'recovery',
    proves: ['effect.replay-capture', 'effect.deploy'],
    coverageItems: [
      'restart:delivery:idempotent-settlement',
      'L:observe-before-retry:no-duplicate-non-idempotent-effect',
    ],
  }),
]);

const byId = new Map(DELIVERY_SCENARIOS.map(scenario => [scenario.id, scenario]));

export function buildDeliveryRuntimeCase(id) {
  const scenario = byId.get(id);
  if (!scenario) throw new Error(`DELIVERY_SCENARIO_UNKNOWN: ${id}; known=${[...byId.keys()].join(',')}`);
  switch (id) {
    case 'delivery/happy-released-authorized':
      return {
        scenario,
        launchMode: 'authorized',
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('released'),
          deliveryStageOutcomeOracle('released'),
          releaseEffectReceiptOracle(),
          noStrandedExecutionOracle(),
        ],
      };
    case 'delivery/deferred-approval-required':
      return {
        scenario,
        launchMode: 'harness-default',
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('approval-required'),
          deliveryStageOutcomeOracle('approval-required'),
          // Fail-closed authorization: the DELIVERY stage (publish-deploy)
          // may fire no external action at all. Development-stage effects
          // (git-integration on implementation cells) are a different
          // workshop's lawful material.
          {
            id: 'delivery.deferred.zero-effects',
            evaluate({ durableTrace }) {
              const actions = (durableTrace.deliveryEffectActions ?? [])
                .filter(a => String(a.node_id).startsWith('publish')
                  || String(a.provider_namespace).startsWith('proof-deployment'));
              return {
                passed: actions.length === 0,
                evidenceRefs: actions.map(a => `${a.provider_namespace}:${a.action_key}`),
                details: { count: actions.length, actions },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'delivery/restart-idempotent-settlement':
      // Driven by runDeliveryRestartProof (multi-start; see the drive).
      return {
        scenario,
        launchMode: 'restart-proof',
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: {},
        oracles: [],
      };
    default:
      throw new Error(`DELIVERY_SCENARIO_UNMAPPED: ${id}`);
  }
}
