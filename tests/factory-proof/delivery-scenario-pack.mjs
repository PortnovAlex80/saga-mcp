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

// DEMONSTRATED (landed) Delivery obligations — these MOVED here from the
// pending universe as their scenarios passed through the unified kernel.
// The universe is monotonic: a landed token never leaves U, it only moves
// from pending to required (factory-coverage-universe ratchet).
export const DELIVERY_REQUIRED_UNIVERSE = Object.freeze([
  'L:approval:binds-candidate+preflight+policy-hash',
  'L:candidate-immutability:drift-after-certification-blocks',
  'L:observe-before-retry:no-duplicate-non-idempotent-effect',
]);

export const DELIVERY_PENDING_UNIVERSE = Object.freeze([
  'K4:crash-after-effect-before-receipt',
  // NOT proven — the three-start proof found the Development git-change
  // desk-replay seam first. Status: BLOCKED_BY the Development prerequisite
  // 'restart:development:git-change-desk-replay'. Discovering an upstream
  // obligation does NOT discharge the Delivery one — the token stays.
  'restart:delivery:idempotent-settlement',
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
  // The human gate: an explicit DENIAL by the trusted approval provider must
  // end the lifecycle at the typed 'blocked' terminal — no publication, no
  // external effect. The release authorization alone is not enough.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/denied-blocked',
    kind: 'positive',
    proves: ['handoff.route-lifecycle'],
    coverageItems: [
      'L:approval:denied-blocked',
      coverageToken.transition('settle-delivery', 'complete-blocked'),
    ],
  }),
  // The human gate, pending arm: the trusted approver has NOT decided yet —
  // the lifecycle must end at the typed 'approval-required' terminal with
  // zero effects. Publication is HELD, never assumed.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/pending-holds-publication',
    kind: 'positive',
    proves: ['handoff.route-lifecycle'],
    coverageItems: [
      'L:approval:pending-holds-publication',
      coverageToken.transition('settle-delivery', 'complete-approval-required'),
    ],
  }),
  // Authoritative observation: the external state provider reports a state
  // DIVERGENT from the desired one after execution — settlement must fail
  // the release closed (blocked), never trust the execute receipt alone.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/observation-mismatch-blocked',
    kind: 'positive',
    proves: ['effect.deploy'],
    coverageItems: [
      'L:observation:mismatch-prevents-released',
      'external:observation:authoritative-state',
    ],
  }),
  // Unknown publication: the provider cannot confirm the mutation (receipt
  // 'uncertain') — the runtime routes to authoritative observation, and the
  // release is decided by what the external state ACTUALLY says.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/publication-unknown-fails-closed',
    kind: 'positive',
    proves: ['effect.deploy'],
    coverageItems: [
      'L:publication:unknown-fails-closed-effect-nonterminal',
      'external:observation:authoritative-state',
    ],
  }),
  // The grant binds the EXACT release policy: an operatorAuthorization whose
  // releasePolicyHash does not match the policy's contentHash is invalid —
  // settlement blocks, nothing is authorized by a stale/diverted grant.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/grant-policy-hash-mismatch-blocked',
    kind: 'positive',
    proves: ['handoff.route-lifecycle'],
    coverageItems: [
      'L:approval:binds-candidate+preflight+policy-hash',
      coverageToken.transition('settle-delivery', 'complete-blocked'),
    ],
  }),
  // Candidate immutability (world-driven): the deployment itself mutates
  // the external world beyond the certified material — the candidate
  // observer reads the WORLD, and a world carrying post-certification
  // mutations yields a diverged current candidate. The observe-release node
  // fails closed on the typed lineage check; the release never settles on
  // mutated material even though the effects fired. (The settlement
  // 'candidate-drifted' TOCTOU branch stays unpinned — no external-world
  // event exists inside that window.)
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/candidate-immutability-drift-fails-closed',
    kind: 'positive',
    proves: ['handoff.route-lifecycle'],
    coverageItems: [
      'L:candidate-immutability:drift-after-certification-blocks',
      coverageToken.transition('settle-delivery', 'complete-failed'),
    ],
  }),
  // Observe-before-retry (cross-run idempotency): a non-idempotent effect is
  // NEVER mutated twice. The external world already holds the desired state
  // (a prior run applied it) — this run's pre-mutation observation must see
  // it matched and skip the mutation entirely. Zero real executions, the
  // release still settles lawfully.
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'delivery/observe-before-retry-no-duplicate-effect',
    kind: 'positive',
    proves: ['effect.deploy'],
    coverageItems: [
      'L:observe-before-retry:no-duplicate-non-idempotent-effect',
      coverageToken.transition('settle-delivery', 'complete-released'),
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
    case 'delivery/denied-blocked':
      return {
        scenario,
        launchMode: 'authorized',
        humanApprovalRequired: true,
        approvalStatus: 'denied',
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          // outcomeRoutes: blocked -> terminal STATUS 'delivery-blocked'.
          terminalOracle('delivery-blocked'),
          deliveryStageOutcomeOracle('blocked'),
          {
            id: 'delivery.denied.zero-effects',
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
    case 'delivery/pending-holds-publication':
      return {
        scenario,
        launchMode: 'authorized',
        humanApprovalRequired: true,
        approvalStatus: 'pending',
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          // An undecided approval HOLDS the flow open (lifecycle paused, no
          // stage outcome, no terminal) — publication waits for the human,
          // it is never assumed. The hold IS the contract.
          {
            id: 'delivery.pending.holds-open',
            evaluate({ durableTrace }) {
              const run = (durableTrace.lifecycleRuns ?? [])[0];
              const stage = (durableTrace.stageRuns ?? [])
                .find(row => row.stage_id === 'delivery-release');
              const held = run && run.status === 'paused'
                && run.terminal_status === null
                && stage && stage.local_outcome === null;
              return {
                passed: Boolean(held),
                evidenceRefs: run ? [`lifecycle-run:${run.id}`] : [],
                details: { run: run ?? null, stageOutcome: stage?.local_outcome ?? null },
              };
            },
          },
          {
            id: 'delivery.pending.zero-effects',
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
    case 'delivery/observation-mismatch-blocked':
      return {
        scenario,
        launchMode: 'authorized',
        observeMismatch: true,
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('delivery-blocked'),
          deliveryStageOutcomeOracle('blocked'),
          {
            id: 'delivery.mismatch.effect-attempted-release-denied',
            evaluate({ durableTrace }) {
              const actions = (durableTrace.deliveryEffectActions ?? [])
                .filter(a => String(a.node_id).startsWith('publish')
                  || String(a.provider_namespace).startsWith('proof-deployment'));
              const attempted = actions.some(a => a.execution_attempts >= 1);
              const released = (durableTrace.lifecycleRuns ?? [])
                .some(run => run.terminal_status === 'released');
              return {
                passed: attempted && !released,
                evidenceRefs: actions.map(a => `${a.provider_namespace}:${a.action_key}`),
                details: {
                  deliveryActions: actions.length,
                  attempted: actions.some(a => a.execution_attempts >= 1),
                  releasedTerminal: released,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'delivery/publication-unknown-fails-closed':
      return {
        scenario,
        launchMode: 'authorized',
        executeUncertain: true,
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          // Production contract (observed live): an indeterminable
          // publication FAILS the stage typed — never a guessed release,
          // never a silent retry-until-lucky. The operator re-requests.
          terminalOracle('failed'),
          // The effect stays NON-TERMINAL: the uncertain receipt leaves the
          // ledger action un-resolved (not falsely succeeded, not failed) —
          // only an authoritative observation in a later run may settle it.
          {
            id: 'delivery.unknown.effect-nonterminal-release-denied',
            evaluate({ durableTrace }) {
              const actions = (durableTrace.deliveryEffectActions ?? [])
                .filter(a => String(a.node_id).startsWith('publish')
                  || String(a.provider_namespace).startsWith('proof-deployment'));
              const attempted = actions.some(a => a.execution_attempts >= 1);
              const allNonTerminal = actions.length > 0
                && actions.every(a => a.state !== 'succeeded' && a.state !== 'failed');
              const released = (durableTrace.lifecycleRuns ?? [])
                .some(run => run.terminal_status === 'released');
              return {
                passed: attempted && allNonTerminal && !released,
                evidenceRefs: actions
                  .map(a => `${a.provider_namespace}:${a.action_key}:${a.state}`),
                details: {
                  actions: actions.map(a => ({ state: a.state, attempts: a.execution_attempts })),
                  releasedTerminal: released,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'delivery/grant-policy-hash-mismatch-blocked':
      return {
        scenario,
        launchMode: 'authorized',
        corruptGrantPolicyHash: true,
        // The binding is enforced at the EARLIEST boundary: the lifecycle
        // input validator rejects a grant whose releasePolicyHash does not
        // match the submitted policy's contentHash — no lifecycle run, no
        // settlement, no effects. The typed refusal IS the contract.
        expectError: 'PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_INVALID',
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          {
            id: 'delivery.grant-mismatch.zero-lifecycle-zero-effects',
            evaluate({ durableTrace }) {
              const runs = durableTrace.lifecycleRuns ?? [];
              const actions = durableTrace.deliveryEffectActions ?? [];
              return {
                passed: runs.length === 0 && actions.length === 0,
                evidenceRefs: [
                  ...runs.map(run => `lifecycle-run:${run.id}:${run.status}`),
                  ...actions.map(a => `${a.provider_namespace}:${a.action_key}`),
                ],
                details: {
                  lifecycleRuns: runs.length,
                  deliveryEffectActions: actions.length,
                },
              };
            },
          },
        ],
      };
    case 'delivery/candidate-immutability-drift-fails-closed':
      return {
        scenario,
        launchMode: 'authorized',
        driftCandidate: true,
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('failed'),
          // A failed process leaves the stage with local_outcome null (no
          // lawful stage outcome exists) — pin the stage STATUS failed.
          {
            id: 'delivery.drift.stage-failed',
            evaluate({ durableTrace }) {
              const stage = (durableTrace.stageRuns ?? [])
                .find(row => row.stage_id === DELIVERY_STAGE);
              return {
                passed: stage?.status === 'failed' && stage?.local_outcome === null,
                evidenceRefs: stage ? [`stage-run:${stage.id}`] : [],
                details: {
                  status: stage?.status ?? null,
                  localOutcome: stage?.local_outcome ?? null,
                },
              };
            },
          },
          // The fail-closed boundary is TYPED: the observe-release node dies
          // on the install-layer candidate-lineage check — the world's
          // current candidate no longer equals the certified one.
          {
            id: 'delivery.drift.typed-lineage-failure',
            evaluate({ durableTrace }) {
              const deliveryRun = (durableTrace.processRuns ?? [])
                .find(row => String(row.module_name).includes('delivery'));
              const error = String(deliveryRun?.error ?? '');
              const typed = error.includes('invalid publication/candidate lineage');
              return {
                passed: Boolean(deliveryRun) && typed,
                evidenceRefs: deliveryRun ? [`process-run:${deliveryRun.id}`] : [],
                details: {
                  processRun: deliveryRun?.id ?? null,
                  error: error.slice(0, 200),
                },
              };
            },
          },
          // The effects DID fire — and the release is still denied: drift
          // fails the release closed, it does not settle on mutated material.
          {
            id: 'delivery.drift.effect-fired-release-denied',
            evaluate({ durableTrace }) {
              const actions = (durableTrace.deliveryEffectActions ?? [])
                .filter(a => String(a.node_id).startsWith('publish')
                  || String(a.provider_namespace).startsWith('proof-deployment'));
              const fired = actions.some(a => a.execution_attempts >= 1);
              const released = (durableTrace.lifecycleRuns ?? [])
                .some(run => run.terminal_status === 'released');
              return {
                passed: fired && !released,
                evidenceRefs: actions.map(a => `${a.provider_namespace}:${a.action_key}`),
                details: {
                  deliveryActions: actions.length,
                  fired,
                  releasedTerminal: released,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      };
    case 'delivery/observe-before-retry-no-duplicate-effect':
      return {
        scenario,
        launchMode: 'authorized',
        worldAlreadyApplied: true,
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('released'),
          deliveryStageOutcomeOracle('released'),
          // The receipt exists and is succeeded — the release settles lawfully
          // WITHOUT a second mutation of the non-idempotent effect.
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
    default:
      throw new Error(`DELIVERY_SCENARIO_UNMAPPED: ${id}`);
  }
}
