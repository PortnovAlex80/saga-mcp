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

/** The publication effect left a durable receipt with a deterministic key. */
function releaseEffectReceiptOracle() {
  return {
    id: 'delivery.publication.effect-receipt',
    evaluate({ durableTrace }) {
      const rows = (durableTrace.effectReceipts ?? []).filter(row =>
        String(row.effect_kind ?? row.effect ?? '').includes('deploy')
        || String(row.effect_kind ?? row.effect ?? '').includes('publish')
        || String(row.effect_kind ?? row.effect ?? '').includes('release'));
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => String(row.effect_key ?? row.id)),
        details: { count: rows.length, kinds: [...new Set(rows.map(row => String(row.effect_kind ?? row.effect)))] },
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
  'L:deferred:approval-required-without-external-action',
  'L:approval:pending-holds-publication',
  'L:approval:denied-blocked',
  'L:approval:binds-candidate+preflight+policy-hash',
  'L:publication:unknown-failure-routes-to-observation',
  'L:observation:mismatch-prevents-released',
  'L:observe-before-retry:no-duplicate-non-idempotent-effect',
  'L:candidate-immutability:drift-after-certification-blocks',
  'restart:delivery:idempotent-settlement',
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
]);

const byId = new Map(DELIVERY_SCENARIOS.map(scenario => [scenario.id, scenario]));

export function buildDeliveryRuntimeCase(id) {
  const scenario = byId.get(id);
  if (!scenario) throw new Error(`DELIVERY_SCENARIO_UNKNOWN: ${id}; known=${[...byId.keys()].join(',')}`);
  switch (id) {
    case 'delivery/happy-released-authorized':
      return {
        scenario,
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('released'),
          deliveryStageOutcomeOracle('released'),
          releaseEffectReceiptOracle(),
          noStrandedExecutionOracle(),
        ],
      };
    default:
      throw new Error(`DELIVERY_SCENARIO_UNMAPPED: ${id}`);
  }
}
