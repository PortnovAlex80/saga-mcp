// tests/factory-proof/discovery-scenario-pack.mjs
//
// First workshop pack for the unified Saga conformance kernel.
//
// Discovery contributes ONLY declarative scenarios, cognition stimuli and
// independent mechanical oracles. It does not own a runner, a gate emulator,
// retry logic or lifecycle routing. Every case executes through runScenario()
// and the canonical production Factory composition.

import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';
import {
  buildScenarioCoverageMatrix,
  coverageToken,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';

export const DISCOVERY_PROPOSAL_SCHEMA = 'factory.discovery-proposal.v1';
export const DISCOVERY_READINESS_SCHEMA = 'factory.discovery-readiness-assessment.v2';
export const DISCOVERY_PROPOSAL_PROVIDER = 'discovery.proposal-contract.v1';
export const DISCOVERY_READINESS_PROVIDER = 'discovery.readiness-contract.v1';

const DISCOVERY_STAGE = 'initial-discovery';
const FORMALIZATION_STAGE = 'solution-formalization';

function uniqueHandlerKey(suffix) {
  const matches = Object.keys(W9_HAPPY_HANDLERS).filter(key => key.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `DISCOVERY_SCENARIO_HANDLER_KEY_DRIFT: expected one W9 handler ending '${suffix}', got ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

const PROPOSAL_HANDLER_KEY = uniqueHandlerKey('/produce-proposal/author/singleton');
const READINESS_HANDLER_KEY = uniqueHandlerKey('/assess-readiness/author/singleton');

function mutateSubmission(baseHandler, targetSchema, mutate) {
  return context => {
    const upstream = context.handlers.product_submit;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema !== targetSchema) return upstream(input);
        const next = structuredClone(input);
        next.content = mutate(structuredClone(input.content), context);
        return upstream(next);
      },
    };
    return baseHandler({ ...context, handlers });
  };
}

function withOverrides(overrides = {}) {
  return Object.freeze({
    ...W9_HAPPY_HANDLERS,
    ...overrides,
  });
}

function proposalMutation(mutate) {
  return mutateSubmission(
    W9_HAPPY_HANDLERS[PROPOSAL_HANDLER_KEY],
    DISCOVERY_PROPOSAL_SCHEMA,
    mutate,
  );
}

function readinessMutation(mutate) {
  return mutateSubmission(
    W9_HAPPY_HANDLERS[READINESS_HANDLER_KEY],
    DISCOVERY_READINESS_SCHEMA,
    mutate,
  );
}

function strengthHandlers(outcome) {
  const overrides = {
    [PROPOSAL_HANDLER_KEY]: proposalMutation(content => ({
      ...content,
      recommended_outcome: outcome,
    })),
  };
  if (outcome === 'reject') {
    overrides[READINESS_HANDLER_KEY] = readinessMutation(content => ({
      ...content,
      overall_readiness: 'not_ready',
      recommended_next_action: 'reject',
      blocking_gaps: [{
        code: 'DISCOVERY-PROOF-REJECT',
        description: 'The readiness advisor agrees that the proposal should be rejected.',
        source_refs: ['$.risks'],
      }],
      confidence: 0.95,
      rationale: 'Worker and advisor agree on a grounded reject outcome.',
    }));
  }
  return withOverrides(overrides);
}

function deletedOutcomeHandlers() {
  return withOverrides({
    [PROPOSAL_HANDLER_KEY]: proposalMutation(content => ({
      ...content,
      recommended_outcome: 'defer',
    })),
  });
}

function missingProposalFieldHandlers() {
  return withOverrides({
    [PROPOSAL_HANDLER_KEY]: proposalMutation(content => {
      const next = { ...content };
      delete next.rationale;
      return next;
    }),
  });
}

function wrongProposalHashHandlers() {
  return withOverrides({
    [READINESS_HANDLER_KEY]: readinessMutation(content => ({
      ...content,
      proposal_content_hash: 'f'.repeat(64),
    })),
  });
}

function inventedReadinessEvidenceHandlers() {
  return withOverrides({
    [READINESS_HANDLER_KEY]: readinessMutation(content => ({
      ...content,
      dimension_assessments: {
        ...content.dimension_assessments,
        problem_clarity: {
          ...content.dimension_assessments.problem_clarity,
          source_refs: ['urn:factory-proof:invented-source'],
        },
      },
    })),
  });
}

function missingReadinessDimensionHandlers() {
  return withOverrides({
    [READINESS_HANDLER_KEY]: readinessMutation(content => {
      const dimensions = { ...content.dimension_assessments };
      delete dimensions.risk_visibility;
      return { ...content, dimension_assessments: dimensions };
    }),
  });
}

function parseSnapshot(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function sameValue(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function receiptOracle(id, providerId, outcome) {
  return {
    id,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.checkReceipts ?? [])
        .filter(row => row.provider_id === providerId && row.outcome === outcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => String(row.check_receipt_ref)),
        details: { providerId, outcome, count: rows.length },
      };
    },
  };
}

function gateOracle(id, workplaceFragment, verdict) {
  return {
    id,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.gateDecisions ?? [])
        .filter(row => String(row.workplace_ref).includes(workplaceFragment)
          && row.verdict === verdict);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => String(row.decision_key)),
        details: { workplaceFragment, verdict, count: rows.length },
      };
    },
  };
}

function stageOutcomeOracle(expectedOutcome) {
  return {
    id: `discovery.stage-outcome.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? [])
        .filter(row => row.stage_id === DISCOVERY_STAGE && row.local_outcome === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `stage-run:${row.id}`),
        details: { expectedOutcome, count: rows.length },
      };
    },
  };
}

function certificateOracle(expectedOutcome) {
  return {
    id: `discovery.certificate.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.processOutcomeCertificates ?? [])
        .filter(row => String(row.module_ref_key).includes('discovery')
          && row.decision === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `process-certificate:${row.id}`),
        details: { expectedOutcome, count: rows.length },
      };
    },
  };
}

function exactHandoffOracle(expectedOutcome) {
  return {
    id: `discovery.handoff-exact.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const discovery = (durableTrace.stageRuns ?? [])
        .find(row => row.stage_id === DISCOVERY_STAGE && row.local_outcome === expectedOutcome);
      if (!discovery) {
        return { passed: false, details: { reason: 'discovery stage outcome missing' } };
      }
      const transition = (durableTrace.processTransitions ?? [])
        .find(row => row.from_stage_run_id === discovery.id
          && row.outcome === expectedOutcome
          && row.target_type === 'stage'
          && row.target_stage_id === FORMALIZATION_STAGE);
      if (!transition) {
        return { passed: false, details: { reason: 'forward transition missing', discoveryStageRunId: discovery.id } };
      }
      const formalization = (durableTrace.stageRuns ?? [])
        .find(row => row.id === transition.to_stage_run_id && row.stage_id === FORMALIZATION_STAGE);
      if (!formalization) {
        return { passed: false, details: { reason: 'formalization stage run missing', transitionId: transition.id } };
      }
      const mapped = parseSnapshot(discovery.mapped_output_snapshot);
      const input = parseSnapshot(formalization.input_snapshot);
      if (!mapped || !input) {
        return {
          passed: false,
          details: { reason: 'handoff snapshots are not parseable JSON objects' },
        };
      }

      const checks = {
        outcome: mapped.decision === expectedOutcome
          && input.discoveryOutcome === expectedOutcome,
        certificateRef: mapped.certificate?.ref === input.discoveryCertificateRef,
        certificateHash: mapped.certificate?.hash === input.discoveryCertificateHash,
        proposalRef: mapped.proposal?.ref === input.discoveryProposalRef,
        proposalHash: mapped.proposal?.hash === input.discoveryProposalHash,
        proposalPayload: sameValue(mapped.proposalPayload, input.discoveryProposalPayload),
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      return {
        passed: failed.length === 0,
        evidenceRefs: [
          `stage-run:${discovery.id}`,
          `lifecycle-transition:${transition.id}`,
          `stage-run:${formalization.id}`,
        ],
        details: {
          failed,
          transitionKey: transition.transition_key,
          handoffHash: transition.handoff_hash,
        },
      };
    },
  };
}

function noDiscoveryCompletionOracle(id) {
  return {
    id,
    evaluate({ durableTrace }) {
      const completedStage = (durableTrace.stageRuns ?? [])
        .some(row => row.stage_id === DISCOVERY_STAGE && row.local_outcome !== null);
      const certificate = (durableTrace.processOutcomeCertificates ?? [])
        .some(row => String(row.module_ref_key).includes('discovery'));
      const formalization = (durableTrace.stageRuns ?? [])
        .some(row => row.stage_id === FORMALIZATION_STAGE);
      return {
        passed: !completedStage && !certificate && !formalization,
        details: { completedStage, certificate, formalization },
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

const positiveCoverage = outcome => [
  coverageToken.gate('discovery-proposal', 'accepted'),
  coverageToken.gate('discovery-readiness', 'accepted'),
  coverageToken.transition('produce-proposal', 'assess-readiness'),
  coverageToken.transition('assess-readiness', 'settle'),
  coverageToken.transition('settle', `complete-${outcome}`),
  `binding:discovery-readiness:exact-proposal-hash`,
  `grounding:discovery-readiness:allowed-source-refs`,
  `handoff:initial-discovery->solution-formalization:${outcome}`,
];

export const DISCOVERY_SCENARIOS = Object.freeze([
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/happy-go',
    kind: 'positive',
    proves: [
      'discovery.proposal-contract',
      'discovery.readiness-contract',
      'handoff.route-lifecycle',
    ],
    coverageItems: positiveCoverage('go'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/happy-clarify',
    kind: 'positive',
    proves: [
      'discovery.proposal-contract',
      'discovery.readiness-contract',
      'handoff.route-lifecycle',
    ],
    coverageItems: positiveCoverage('clarify'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/happy-reject',
    kind: 'positive',
    proves: [
      'discovery.proposal-contract',
      'discovery.readiness-contract',
      'handoff.route-lifecycle',
    ],
    coverageItems: positiveCoverage('reject'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/proposal-deleted-outcome',
    kind: 'causal-fault',
    faultClass: 'contract-shape',
    proves: ['discovery.proposal-contract'],
    coverageItems: [
      coverageToken.gate('discovery-proposal', 'repair_required'),
      coverageToken.negativeTransition('produce-proposal', 'assess-readiness'),
      'grammar:discovery-proposal:closed-outcome-vocabulary',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/proposal-missing-required-field',
    kind: 'causal-fault',
    faultClass: 'contract-shape',
    proves: ['discovery.proposal-contract'],
    coverageItems: [
      coverageToken.gate('discovery-proposal', 'repair_required'),
      coverageToken.negativeTransition('produce-proposal', 'assess-readiness'),
      'shape:discovery-proposal:required-fields',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/readiness-wrong-proposal-hash',
    kind: 'causal-fault',
    faultClass: 'authority-binding',
    proves: ['discovery.proposal-contract', 'discovery.readiness-contract'],
    coverageItems: [
      coverageToken.gate('discovery-proposal', 'accepted'),
      coverageToken.gate('discovery-readiness', 'repair_required'),
      coverageToken.transition('produce-proposal', 'assess-readiness'),
      coverageToken.negativeTransition('assess-readiness', 'settle'),
      'negative-binding:discovery-readiness:foreign-proposal-hash-rejected',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/readiness-invented-source-ref',
    kind: 'causal-fault',
    faultClass: 'derived-evidence',
    proves: ['discovery.proposal-contract', 'discovery.readiness-contract'],
    coverageItems: [
      coverageToken.gate('discovery-proposal', 'accepted'),
      coverageToken.gate('discovery-readiness', 'repair_required'),
      coverageToken.transition('produce-proposal', 'assess-readiness'),
      coverageToken.negativeTransition('assess-readiness', 'settle'),
      'negative-grounding:discovery-readiness:invented-source-rejected',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/readiness-missing-dimension',
    kind: 'causal-fault',
    faultClass: 'contract-shape',
    proves: ['discovery.proposal-contract', 'discovery.readiness-contract'],
    coverageItems: [
      coverageToken.gate('discovery-proposal', 'accepted'),
      coverageToken.gate('discovery-readiness', 'repair_required'),
      coverageToken.transition('produce-proposal', 'assess-readiness'),
      coverageToken.negativeTransition('assess-readiness', 'settle'),
      'shape:discovery-readiness:seven-required-dimensions',
    ],
  }),
]);

const byId = new Map(DISCOVERY_SCENARIOS.map(scenario => [scenario.id, scenario]));

const POSITIVE_ORACLES = outcome => [
  receiptOracle(`discovery.proposal-receipt.passed.${outcome}`, DISCOVERY_PROPOSAL_PROVIDER, 'passed'),
  receiptOracle(`discovery.readiness-receipt.passed.${outcome}`, DISCOVERY_READINESS_PROVIDER, 'passed'),
  gateOracle(`discovery.proposal-gate.accepted.${outcome}`, 'discovery-proposal', 'accepted'),
  gateOracle(`discovery.readiness-gate.accepted.${outcome}`, 'discovery-readiness', 'accepted'),
  stageOutcomeOracle(outcome),
  certificateOracle(outcome),
  exactHandoffOracle(outcome),
  noStrandedExecutionOracle(),
];

const PROPOSAL_NEGATIVE_ORACLES = id => [
  receiptOracle(`${id}.proposal-receipt.failed`, DISCOVERY_PROPOSAL_PROVIDER, 'failed'),
  gateOracle(`${id}.proposal-gate.repair-required`, 'discovery-proposal', 'repair_required'),
  noDiscoveryCompletionOracle(`${id}.no-laundered-discovery-output`),
  noStrandedExecutionOracle(),
];

const READINESS_NEGATIVE_ORACLES = id => [
  receiptOracle(`${id}.proposal-receipt.passed`, DISCOVERY_PROPOSAL_PROVIDER, 'passed'),
  receiptOracle(`${id}.readiness-receipt.failed`, DISCOVERY_READINESS_PROVIDER, 'failed'),
  gateOracle(`${id}.proposal-gate.accepted`, 'discovery-proposal', 'accepted'),
  gateOracle(`${id}.readiness-gate.repair-required`, 'discovery-readiness', 'repair_required'),
  noDiscoveryCompletionOracle(`${id}.no-settlement-after-invalid-readiness`),
  noStrandedExecutionOracle(),
];

export function buildDiscoveryRuntimeCase(id) {
  const scenario = byId.get(id);
  if (!scenario) {
    throw new Error(
      `DISCOVERY_SCENARIO_UNKNOWN: ${id}; known=${[...byId.keys()].join(',')}`,
    );
  }
  switch (id) {
    case 'discovery/happy-go':
      return {
        scenario,
        handlers: withOverrides(),
        driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 140 },
        oracles: POSITIVE_ORACLES('go'),
      };
    case 'discovery/happy-clarify':
      return {
        scenario,
        handlers: strengthHandlers('clarify'),
        driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 140 },
        oracles: POSITIVE_ORACLES('clarify'),
      };
    case 'discovery/happy-reject':
      return {
        scenario,
        handlers: strengthHandlers('reject'),
        driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 140 },
        oracles: POSITIVE_ORACLES('reject'),
      };
    case 'discovery/proposal-deleted-outcome':
      return {
        scenario,
        handlers: deletedOutcomeHandlers(),
        driveOptions: { maxCycles: 60 },
        oracles: PROPOSAL_NEGATIVE_ORACLES('discovery.deleted-outcome'),
      };
    case 'discovery/proposal-missing-required-field':
      return {
        scenario,
        handlers: missingProposalFieldHandlers(),
        driveOptions: { maxCycles: 60 },
        oracles: PROPOSAL_NEGATIVE_ORACLES('discovery.missing-proposal-field'),
      };
    case 'discovery/readiness-wrong-proposal-hash':
      return {
        scenario,
        handlers: wrongProposalHashHandlers(),
        driveOptions: { maxCycles: 80 },
        oracles: READINESS_NEGATIVE_ORACLES('discovery.wrong-proposal-hash'),
      };
    case 'discovery/readiness-invented-source-ref':
      return {
        scenario,
        handlers: inventedReadinessEvidenceHandlers(),
        driveOptions: { maxCycles: 80 },
        oracles: READINESS_NEGATIVE_ORACLES('discovery.invented-source'),
      };
    case 'discovery/readiness-missing-dimension':
      return {
        scenario,
        handlers: missingReadinessDimensionHandlers(),
        driveOptions: { maxCycles: 80 },
        oracles: READINESS_NEGATIVE_ORACLES('discovery.missing-dimension'),
      };
    default:
      throw new Error(`DISCOVERY_SCENARIO_UNMAPPED: ${id}`);
  }
}

export const DISCOVERY_PHASE1_REQUIRED_COVERAGE = Object.freeze([
  coverageToken.obligation('discovery.proposal-contract'),
  coverageToken.obligation('discovery.readiness-contract'),
  coverageToken.obligation('handoff.route-lifecycle'),
  coverageToken.gate('discovery-proposal', 'accepted'),
  coverageToken.gate('discovery-proposal', 'repair_required'),
  coverageToken.gate('discovery-readiness', 'accepted'),
  coverageToken.gate('discovery-readiness', 'repair_required'),
  coverageToken.transition('produce-proposal', 'assess-readiness'),
  coverageToken.negativeTransition('produce-proposal', 'assess-readiness'),
  coverageToken.transition('assess-readiness', 'settle'),
  coverageToken.negativeTransition('assess-readiness', 'settle'),
  coverageToken.transition('settle', 'complete-go'),
  coverageToken.transition('settle', 'complete-clarify'),
  coverageToken.transition('settle', 'complete-reject'),
  'binding:discovery-readiness:exact-proposal-hash',
  'negative-binding:discovery-readiness:foreign-proposal-hash-rejected',
  'grounding:discovery-readiness:allowed-source-refs',
  'negative-grounding:discovery-readiness:invented-source-rejected',
  'grammar:discovery-proposal:closed-outcome-vocabulary',
  'shape:discovery-proposal:required-fields',
  'shape:discovery-readiness:seven-required-dimensions',
  'handoff:initial-discovery->solution-formalization:go',
  'handoff:initial-discovery->solution-formalization:clarify',
  'handoff:initial-discovery->solution-formalization:reject',
]);

// The complete target is intentionally larger than Phase 1. Keeping the gaps
// explicit prevents an 8-scenario pack from being misrepresented as total
// Discovery conformance. K4/strict-spawn work will close recovery/fence faults.
export const DISCOVERY_FULL_COVERAGE_UNIVERSE = Object.freeze([
  ...DISCOVERY_PHASE1_REQUIRED_COVERAGE,
  coverageToken.transition('produce-proposal', 'complete-failed'),
  coverageToken.transition('assess-readiness', 'complete-failed'),
  coverageToken.transition('settle', 'complete-failed'),
  'recovery:discovery-proposal:exact-feedback-repair',
  'recovery:discovery-readiness:exact-feedback-repair',
  'counterfactual:discovery-proposal:absent-feedback-no-magical-repair',
  'counterfactual:discovery-proposal:stale-feedback-no-magical-repair',
  'counterfactual:discovery-proposal:corrupted-feedback-no-magical-repair',
  'counterfactual:discovery-readiness:absent-feedback-no-magical-repair',
  'counterfactual:discovery-readiness:stale-feedback-no-magical-repair',
  'counterfactual:discovery-readiness:corrupted-feedback-no-magical-repair',
  'fence:discovery-proposal:stale-execution-denied',
  'fence:discovery-readiness:stale-execution-denied',
  'idempotency:discovery-proposal:duplicate-submit',
  'idempotency:discovery-readiness:duplicate-submit',
  'crash:discovery-proposal:bounded-recovery',
  'crash:discovery-readiness:bounded-recovery',
]);

export function planDiscoveryCoverage() {
  const phase1Matrix = buildScenarioCoverageMatrix(DISCOVERY_SCENARIOS, {
    requiredItems: DISCOVERY_PHASE1_REQUIRED_COVERAGE,
  });
  const fullMatrix = buildScenarioCoverageMatrix(DISCOVERY_SCENARIOS, {
    requiredItems: DISCOVERY_FULL_COVERAGE_UNIVERSE,
  });
  return {
    phase1: {
      matrix: phase1Matrix,
      summary: summarizeCoverage(phase1Matrix),
      minimalScenarioCover: selectScenarioCover(phase1Matrix),
    },
    full: {
      matrix: fullMatrix,
      summary: summarizeCoverage(fullMatrix),
      minimalScenarioCover: selectScenarioCover(fullMatrix),
    },
  };
}
