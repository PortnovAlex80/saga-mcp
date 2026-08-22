// tests/factory-proof/development-scenario-pack.mjs
//
// Development workshop pack for the unified Saga conformance kernel —
// TRANCHE D-A (night 2026-08-22): topology inventory + the positive spine.
//
// The pack owns only deterministic cognition stimuli, independent oracles
// and coverage declarations. All Workplace/CandidateSet/Gate/review/effect/
// git-integration/verification/settlement authority remains in the
// production Factory (guides: WORKSHOP-CONFORMANCE-PACK-AUTHORING-GUIDE §9,
// WORKSHOP-CONFORMANCE-COVERAGE-AGENT-GUIDE §9).
//
// HONEST SCOPE: this tranche proves the positive spine end-to-end
// (Formalization --exact--> Development --verified--> runnable-local).
// The full D0–D10 universe (negatives, fan-out physics, effects, restarts,
// continuations) is DECLARED below but not yet authored — Development is
// NOT closed until every required item has PASS evidence (§13 closure rule).

import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';
import { coverageToken } from './coverage-kernel.mjs';

export const DEVELOPMENT_STAGE = 'solution-development';
export const FORMALIZATION_STAGE = 'solution-formalization';
export const DEV_MODULE = 'solution-development@1.4.4';

// --- Topology inventory (authoring guide §Step 1, read from the module) ---
export const DEVELOPMENT_TOPOLOGY = Object.freeze({
  moduleRef: DEV_MODULE,
  nodes: Object.freeze([
    Object.freeze({ id: 'plan-task-graph', kind: 'production-cell', cell: 'development-plan-task-graph', roles: ['author'] }),
    Object.freeze({ id: 'resolve-task-graph', kind: 'kernel', handler: 'development-task-graph-validation@2.0.0' }),
    Object.freeze({ id: 'implement-work-items', kind: 'production-cell', cell: 'development-implementation', fanOut: 'workItems', roles: ['author', 'reviewer'] }),
    Object.freeze({ id: 'freeze-integrated-candidate', kind: 'kernel' }),
    Object.freeze({ id: 'certify-product-readiness', kind: 'production-cell', cell: 'development-readiness-certification', roles: ['author'] }),
    Object.freeze({ id: 'bind-runnable-candidate', kind: 'kernel' }),
    Object.freeze({ id: 'verify-acceptance', kind: 'production-cell', cell: 'development-verification', fanOut: 'verificationItems', roles: ['author'] }),
    Object.freeze({ id: 'settle-development', kind: 'kernel', handler: 'development-settlement@1.0.0' }),
  ]),
  outcomes: Object.freeze(['verified', 'blocked', 'failed']),
  installedVariants: Object.freeze([
    'solution-development-managed@1.1.0',
    'solution-development-managed@1.2.0',
    'solution-development-verification-continuation@1.0.0',
  ]),
});

// --- Oracles (read ONLY real authority tables via the shared observer) ---

function stageOutcomeOracle(stageId, expectedOutcome) {
  return {
    id: `development.stage-outcome.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? [])
        .filter(row => row.stage_id === stageId && row.local_outcome === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `stage-run:${row.id}`),
        details: { stageId, expectedOutcome, count: rows.length },
      };
    },
  };
}

function cellAcceptedOracle(cellFragment) {
  return {
    id: `development.${cellFragment}.accepted`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.gateDecisions ?? []).filter(row =>
        String(row.workplace_ref).includes(cellFragment)
        && row.gate_phase === 'final' && row.verdict === 'accepted');
      const workplaces = new Set(rows.map(row => String(row.workplace_ref)));
      // Fan-out cells accept per work item: every materialized workplace of
      // the cell must have its own final acceptance.
      const materialized = (durableTrace.workplaces ?? [])
        .filter(row => String(row.workplace_ref).includes(cellFragment));
      return {
        passed: rows.length > 0 && workplaces.size === materialized.length,
        evidenceRefs: rows.map(row => String(row.decision_key)),
        details: {
          acceptedWorkplaces: workplaces.size,
          materializedWorkplaces: materialized.length,
        },
      };
    },
  };
}

/**
 * D0 — the exact Formalization → Development handoff (authoring guide §9.3):
 * upstream mapped_output_snapshot == downstream input_snapshot on the
 * authority-bearing fields (certificate schema/ref/hash, solution contract,
 * baseline hash, SRS projection, acceptance criteria).
 */
function exactFormalizationHandoffOracle() {
  return {
    id: 'development.handoff-exact.formalization',
    evaluate({ durableTrace }) {
      const formalization = (durableTrace.stageRuns ?? [])
        .find(row => row.stage_id === FORMALIZATION_STAGE && row.local_outcome === 'formalized');
      if (!formalization) return { passed: false, details: { reason: 'formalization stage missing' } };
      const transition = (durableTrace.processTransitions ?? [])
        .find(row => row.from_stage_run_id === formalization.id
          && row.outcome === 'formalized'
          && row.target_type === 'stage'
          && row.target_stage_id === DEVELOPMENT_STAGE);
      if (!transition) {
        return { passed: false, details: { reason: 'formalization->development transition missing' } };
      }
      const development = (durableTrace.stageRuns ?? [])
        .find(row => row.id === transition.to_stage_run_id && row.stage_id === DEVELOPMENT_STAGE);
      if (!development) return { passed: false, details: { reason: 'development stage missing' } };
      const parse = value => {
        if (typeof value !== 'string' || value.length === 0) return null;
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch { return null; }
      };
      const mapped = parse(formalization.mapped_output_snapshot);
      const input = parse(development.input_snapshot);
      if (!mapped || !input) return { passed: false, details: { reason: 'unparseable snapshots' } };
      const payload = mapped.solutionContractPayload;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const checks = {
        decision: mapped.decision === 'formalized'
          && input.formalizationCertificate?.decision === 'formalized',
        certificateRef: mapped.certificate?.ref === input.formalizationCertificate?.ref,
        certificateHash: mapped.certificate?.hash === input.formalizationCertificate?.hash,
        solutionRef: mapped.solutionContract?.ref === input.solutionContract?.ref,
        solutionHash: mapped.solutionContract?.hash === input.solutionContract?.hash,
        baselineHash: payload?.bundle?.acceptanceBaselineHash === input.acceptanceBaselineHash,
        srs: same(payload?.srs, input.srs),
        acceptanceCriteria: same(payload?.acceptanceCriteria, input.acceptanceCriteria),
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      return {
        passed: failed.length === 0,
        evidenceRefs: [`stage-run:${formalization.id}`, `lifecycle-transition:${transition.id}`, `stage-run:${development.id}`],
        details: { failed, transitionKey: transition.transition_key, handoffHash: transition.handoff_hash },
      };
    },
  };
}

function certificateOracle() {
  return {
    id: 'development.certificate.verified',
    evaluate({ durableTrace }) {
      const rows = (durableTrace.processOutcomeCertificates ?? [])
        .filter(row => String(row.module_ref_key).includes('development')
          && row.decision === 'verified');
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `process-certificate:${row.id}`),
        details: { count: rows.length },
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

// --- Scenarios ---

function positiveSpineCoverage() {
  return [
    coverageToken.obligation('dev.task-graph'),
    coverageToken.obligation('dev.impl-scope'),
    coverageToken.obligation('dev.readiness-monotonicity'),
    coverageToken.obligation('factory.local-runnability'),
    coverageToken.transition('plan-task-graph', 'resolve-task-graph'),
    coverageToken.transition('implement-work-items', 'freeze-integrated-candidate'),
    coverageToken.transition('certify-product-readiness', 'bind-runnable-candidate'),
    coverageToken.transition('verify-acceptance', 'settle-development'),
    coverageToken.transition('settle-development', 'complete-verified'),
    'handoff:solution-formalization->solution-development:formalized',
    'fanout:development-implementation:per-work-item-workplace',
    'fanin:development-settlement:all-required-accepted',
    'effect:git-integration:after-final-acceptance',
  ];
}

export const DEVELOPMENT_SCENARIOS = Object.freeze([
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/happy-verified',
    kind: 'positive',
    proves: [
      'dev.task-graph',
      'dev.impl-scope',
      'dev.readiness-monotonicity',
      'factory.local-runnability',
    ],
    coverageItems: positiveSpineCoverage(),
  }),
]);

// --- Planned (not yet demonstrated) universe — honest tranche boundary ---

export const DEVELOPMENT_PENDING_UNIVERSE = Object.freeze([
  // Found live by the delivery restart proof (2026-08-22): a replayed
  // git-change work item carries the capsule's original commitSha, but the
  // fresh execution's desk froze a NEW effective base — the implementation-
  // scope check's merge-base discipline then rejects the replay. Cross-
  // lifecycle replay semantics for desk-bound git-change cells is an open
  // Development-universe item, NOT a delivery concern.
  'restart:development:git-change-desk-replay',
  'D2:fanout-scheduling:dependency-order-and-concurrency-cap',
  'D2:fanin:completion-policy-all-blocks-early-fanin',
  'D2:sibling-isolation:accepted-sibling-conserved-during-repair',
  'D3:impl-scope:file-outside-effective-scope-rejected',
  'D3:claim-monotonicity:silent-narrowing-rejected',
  'D4:review:changes-returns-to-same-workplace-author',
  'D4:git-effect:integration-only-after-final-acceptance',
  'D4:git-effect:redrive-idempotent',
  'D5:freeze:frozen-candidate-content-addressed-and-immutable',
  'D6:readiness:declared-source-mismatch-rejected',
  'D7:bind:stale-readiness-hash-failed',
  'D8:verification:evidence-pins-exact-candidate-hash',
  'D8:verification:upstream-defect-routes-to-settlement',
  'D9:settlement:blocked-and-failed-outcomes',
  'D10:continuation:managed-source-author-no-git-authority',
  'D10:replan:superseded-tasks-not-claimable',
  'restart:development:idempotent-redrive',
  'feedback:development:exact-repairs-and-absent-does-not',
]);

export const DEVELOPMENT_PLATFORM_FAULT_EDGES = Object.freeze([
  'K4:git-effect:crash-after-external-mutation-before-receipt',
  'K4:settlement:internal-exception-complete-failed',
]);

const byId = new Map(DEVELOPMENT_SCENARIOS.map(scenario => [scenario.id, scenario]));

export function buildDevelopmentRuntimeCase(id) {
  const scenario = byId.get(id);
  if (!scenario) {
    throw new Error(`DEVELOPMENT_SCENARIO_UNKNOWN: ${id}; known=${[...byId.keys()].join(',')}`);
  }
  switch (id) {
    case 'development/happy-verified':
      return {
        scenario,
        // The W9 happy map covers the whole product-build lifecycle through
        // Development (planner, implement fan-out, review, readiness,
        // verification fan-out) — the spine drives the REAL production
        // handlers to the lifecycle's natural terminal (runnable-local).
        handlers: Object.freeze({ ...W9_HAPPY_HANDLERS }),
        driveOptions: { maxCycles: 320, maxEmptyDispatchStreak: 15 },
        oracles: [
          stageOutcomeOracle(DEVELOPMENT_STAGE, 'verified'),
          exactFormalizationHandoffOracle(),
          cellAcceptedOracle('development-plan-task-graph'),
          cellAcceptedOracle('development-implementation'),
          cellAcceptedOracle('development-readiness-certification'),
          cellAcceptedOracle('development-verification'),
          certificateOracle(),
          noStrandedExecutionOracle(),
        ],
      };
    default:
      throw new Error(`DEVELOPMENT_SCENARIO_UNMAPPED: ${id}`);
  }
}
