// tests/factory-proof/discovery-resilience-pack.mjs
//
// Discovery closure pack for the unified Saga conformance kernel.
// Adds causal feedback, crash/retry, duplicate/late-call and stale-fence proofs
// without adding a Discovery-specific runner or state machine. Cognition is the
// only substitution: all CandidateSet, Gate, recovery and lifecycle authority
// remains production-owned.

import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';
import { createScriptedActor, projectFeedbackVariant } from './scripted-actor.mjs';
import {
  buildScenarioCoverageMatrix,
  coverageToken,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';
import {
  DISCOVERY_FULL_COVERAGE_UNIVERSE,
  DISCOVERY_PHASE1_REQUIRED_COVERAGE,
  DISCOVERY_SCENARIOS,
  buildDiscoveryRuntimeCase,
} from './discovery-scenario-pack.mjs';

const PROPOSAL_SCHEMA = 'factory.discovery-proposal.v1';
const READINESS_SCHEMA = 'factory.discovery-readiness-assessment.v2';
const PROPOSAL_PROVIDER = 'discovery.proposal-contract.v1';
const READINESS_PROVIDER = 'discovery.readiness-contract.v1';
const DISCOVERY_STAGE = 'initial-discovery';

function uniqueHandlerKey(suffix) {
  const matches = Object.keys(W9_HAPPY_HANDLERS).filter(key => key.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `DISCOVERY_RESILIENCE_HANDLER_KEY_DRIFT: expected one W9 handler ending '${suffix}', got ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

const PROPOSAL_KEY = uniqueHandlerKey('/produce-proposal/author/singleton');
const READINESS_KEY = uniqueHandlerKey('/assess-readiness/author/singleton');

const TARGET = Object.freeze({
  proposal: Object.freeze({
    key: PROPOSAL_KEY,
    schema: PROPOSAL_SCHEMA,
    provider: PROPOSAL_PROVIDER,
    workplace: 'discovery-proposal',
    node: 'produce-proposal',
    nextNode: 'assess-readiness',
    feedbackNeedle: 'rationale',
    crashInvocation: 1,
  }),
  readiness: Object.freeze({
    key: READINESS_KEY,
    schema: READINESS_SCHEMA,
    provider: READINESS_PROVIDER,
    workplace: 'discovery-readiness',
    node: 'assess-readiness',
    nextNode: 'settle',
    feedbackNeedle: 'proposal_content_hash',
    crashInvocation: 2,
  }),
});

function withOverrides(overrides = {}) {
  return Object.freeze({ ...W9_HAPPY_HANDLERS, ...overrides });
}

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

function invalidHandler(targetName) {
  const target = TARGET[targetName];
  const base = W9_HAPPY_HANDLERS[target.key];
  if (targetName === 'proposal') {
    return mutateSubmission(base, target.schema, content => {
      const next = { ...content };
      delete next.rationale;
      return next;
    });
  }
  return mutateSubmission(base, target.schema, content => ({
    ...content,
    proposal_content_hash: 'f'.repeat(64),
  }));
}

function productionRecoveryFeedback(meta) {
  const raw = meta?.recovery_feedback
    ?? meta?.process_node_input?.bindings?.recoveryFeedback
    ?? null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const issue = raw.issue && typeof raw.issue === 'object' && !Array.isArray(raw.issue)
    ? raw.issue
    : raw;
  const finding = Array.isArray(issue.findings) && issue.findings[0]
    && typeof issue.findings[0] === 'object'
    ? issue.findings[0]
    : null;
  const subjectRef = finding?.subjectRef
    ?? (Array.isArray(issue.subjectRefs) ? issue.subjectRefs[0]?.ref : null)
    ?? null;
  return {
    reasonCode: typeof issue.reasonCode === 'string'
      ? issue.reasonCode
      : typeof finding?.code === 'string' ? finding.code : 'DISCOVERY_RECOVERY',
    subjectRef,
    evidence: {
      message: typeof finding?.message === 'string' ? finding.message : '',
      expected: Array.isArray(finding?.expected) ? finding.expected : [],
    },
  };
}

function exactFeedbackPredicate(needle) {
  return visible => {
    const feedback = visible?.recoveryFeedback;
    if (!feedback || typeof feedback !== 'object') return false;
    if (typeof feedback.reasonCode !== 'string'
      || feedback.reasonCode.endsWith('_CORRUPTED')) return false;
    if (typeof feedback.subjectRef !== 'string'
      || feedback.subjectRef.includes('@revision-0')) return false;
    return JSON.stringify(feedback.evidence ?? {}).includes(needle);
  };
}

function makeFeedbackRuntime(targetName, variant) {
  const target = TARGET[targetName];
  const journal = [];
  const actor = createScriptedActor({
    rules: [{
      when: exactFeedbackPredicate(target.feedbackNeedle),
      act: () => ({ action: 'repair-from-exact-feedback' }),
    }],
    fallback: () => ({ action: 'repeat-invalid-production' }),
  });
  const bad = invalidHandler(targetName);
  const good = W9_HAPPY_HANDLERS[target.key];

  const handler = context => {
    const exact = productionRecoveryFeedback(context.meta);
    const projected = exact === null ? null : projectFeedbackVariant(exact, variant);
    const reaction = actor.react({
      prompt: `${targetName} Discovery repair`,
      recoveryFeedback: projected,
      lastToolError: null,
      deskFiles: [],
    });
    journal.push({
      target: targetName,
      variant,
      executionRef: context.assignment.workerExecutionId,
      feedbackPresent: projected !== null,
      output: reaction.output,
      visibleInputDigest: reaction.visibleInputDigest,
      actorOutputDigest: reaction.actorOutputDigest,
    });
    return reaction.output.action === 'repair-from-exact-feedback'
      ? good(context)
      : bad(context);
  };

  const expectRepair = variant === 'exact';
  return {
    handlers: withOverrides({ [target.key]: handler }),
    actorEvidence: journal,
    driveOptions: { maxCycles: expectRepair ? 140 : 80 },
    oracles: [
      gateSeenOracle(`${targetName}.feedback.rejected`, target.workplace, 'repair_required'),
      actorRepairOracle(targetName, variant, journal, expectRepair),
      expectRepair
        ? gateSeenOracle(`${targetName}.feedback.accepted-after-repair`, target.workplace, 'accepted')
        : noAcceptedGateOracle(`${targetName}.feedback.no-magical-accept`, target.workplace),
      expectRepair
        ? stageOutcomeOracle('go')
        : typedBoundedFailureOracle(`${targetName}.feedback.typed-bounded`, target.workplace),
      noStrandedOracle(),
    ],
  };
}

function gateSeenOracle(id, workplaceFragment, verdict) {
  return {
    id,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.gateDecisions ?? []).filter(row =>
        String(row.workplace_ref).includes(workplaceFragment) && row.verdict === verdict);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => String(row.decision_key)),
        details: { workplaceFragment, verdict, count: rows.length },
      };
    },
  };
}

function noAcceptedGateOracle(id, workplaceFragment) {
  return {
    id,
    evaluate({ durableTrace }) {
      const accepted = (durableTrace.gateDecisions ?? []).filter(row =>
        String(row.workplace_ref).includes(workplaceFragment) && row.verdict === 'accepted');
      return { passed: accepted.length === 0, details: { accepted: accepted.length } };
    },
  };
}

function actorRepairOracle(target, variant, journal, expectRepair) {
  return {
    id: `${target}.feedback.actor-${variant}`,
    evaluate() {
      const repairs = journal.filter(row => row.output?.action === 'repair-from-exact-feedback');
      return {
        passed: expectRepair ? repairs.length >= 1 : repairs.length === 0,
        details: { variant, reactions: journal.length, repairs: repairs.length },
      };
    },
  };
}

function stageOutcomeOracle(outcome) {
  return {
    id: `discovery.stage.${outcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? []).filter(row =>
        row.stage_id === DISCOVERY_STAGE && row.local_outcome === outcome);
      return { passed: rows.length > 0, details: { outcome, count: rows.length } };
    },
  };
}

function typedBoundedFailureOracle(id, workplaceFragment) {
  return {
    id,
    evaluate({ durableTrace }) {
      const workplaces = (durableTrace.workplaces ?? []).filter(row =>
        String(row.workplace_ref).includes(workplaceFragment));
      const typed = workplaces.some(row => row.loop_state === 'repair_wait'
        || row.loop_state === 'paused'
        || row.loop_state === 'terminal');
      const failedStage = (durableTrace.stageRuns ?? []).some(row =>
        row.stage_id === DISCOVERY_STAGE && row.local_outcome === 'failed');
      return {
        passed: typed || failedStage,
        details: {
          states: workplaces.map(row => ({ loop: row.loop_state, terminal: row.terminal_reason })),
          failedStage,
        },
      };
    },
  };
}

function noStrandedOracle() {
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

function lostThenAcceptedOracle(targetName) {
  const target = TARGET[targetName];
  return {
    id: `${targetName}.crash.lost-then-accepted`,
    evaluate({ durableTrace }) {
      const tasks = new Set((durableTrace.workIntents ?? [])
        .filter(t => String(t.workplace_ref).includes(target.workplace))
        .map(t => t.id));
      const executions = (durableTrace.workerExecutions ?? []).filter(e => tasks.has(e.task_id));
      const lost = executions.filter(e => e.state === 'lost');
      const accepted = (durableTrace.gateDecisions ?? []).filter(g =>
        String(g.workplace_ref).includes(target.workplace) && g.verdict === 'accepted');
      return {
        passed: lost.length >= 1 && accepted.length >= 1,
        details: { executionStates: executions.map(e => e.state), accepted: accepted.length },
      };
    },
  };
}

function makeCrashRuntime(targetName) {
  const target = TARGET[targetName];
  return {
    handlers: W9_HAPPY_HANDLERS,
    crashPoint: {
      scenarioKeyPrefix: target.key,
      atInvocation: target.crashInvocation,
      effect: 'exit-nonzero',
      name: `discovery-${targetName}-first-worker-crash`,
    },
    faultJournal: [{
      class: 'worker-crash',
      target: targetName,
      boundary: 'worker-before-handler',
    }],
    driveOptions: { maxCycles: 160 },
    oracles: [lostThenAcceptedOracle(targetName), stageOutcomeOracle('go'), noStrandedOracle()],
  };
}

function makeRetryExhaustionRuntime(targetName) {
  const target = TARGET[targetName];
  return {
    handlers: withOverrides({ [target.key]: invalidHandler(targetName) }),
    driveOptions: { maxCycles: 220 },
    oracles: [
      gateSeenOracle(`${targetName}.exhaustion.repair-required`, target.workplace, 'repair_required'),
      // Recovery-budget terminalization is ProductionCellCoordinator authority,
      // not a second persisted GateDecision. Do not invent a `verdict=failed`
      // gate row as an oracle; prove the externally visible stage terminal plus
      // the typed Workplace terminal/wait instead.
      typedBoundedFailureOracle(`${targetName}.exhaustion.typed-terminal`, target.workplace),
      stageOutcomeOracle('failed'),
      noStrandedOracle(),
    ],
  };
}

function makeDuplicateRuntime(targetName) {
  const target = TARGET[targetName];
  const journal = [];
  const base = W9_HAPPY_HANDLERS[target.key];
  const handler = context => {
    const upstream = context.handlers.product_submit;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema !== target.schema) return upstream(input);
        const first = upstream(input);
        try {
          const second = upstream(structuredClone(input));
          journal.push({
            kind: 'duplicate-submit',
            target: targetName,
            accepted: true,
            replayed: second?.replayed === true,
          });
        } catch (error) {
          journal.push({
            kind: 'duplicate-submit',
            target: targetName,
            accepted: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return first;
      },
    };
    return base({ ...context, handlers });
  };
  return {
    handlers: withOverrides({ [target.key]: handler }),
    actorEvidence: journal,
    driveOptions: { maxCycles: 140 },
    oracles: [
      duplicateIdempotencyOracle(targetName, target, journal),
      stageOutcomeOracle('go'),
      noStrandedOracle(),
    ],
  };
}

function duplicateIdempotencyOracle(targetName, target, journal) {
  return {
    id: `${targetName}.duplicate-submit.idempotent`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.managedSubmissions ?? []).filter(row =>
        row.node_id === target.node && row.schema_version === target.schema);
      const probe = journal.find(row => row.kind === 'duplicate-submit');
      const secondWasSafe = probe?.replayed === true || probe?.accepted === false;
      return {
        passed: Boolean(secondWasSafe) && rows.length === 1,
        details: { probe: probe ?? null, durableSubmissionCount: rows.length },
      };
    },
  };
}

function makeLateCallRuntime(targetName) {
  const target = TARGET[targetName];
  const journal = [];
  const base = W9_HAPPY_HANDLERS[target.key];
  const handler = context => {
    let captured = null;
    const upstream = context.handlers.product_submit;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema === target.schema) captured = structuredClone(input);
        return upstream(input);
      },
    };
    const result = base({ ...context, handlers });
    if (!captured) throw new Error(`DISCOVERY_LATE_CALL_PROBE_NO_${targetName.toUpperCase()}_SUBMISSION`);
    try {
      upstream(captured);
      journal.push({ kind: 'late-tool-call', target: targetName, denied: false });
    } catch (error) {
      journal.push({
        kind: 'late-tool-call', target: targetName, denied: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  };
  return {
    handlers: withOverrides({ [target.key]: handler }),
    actorEvidence: journal,
    driveOptions: { maxCycles: 140 },
    oracles: [
      {
        id: `${targetName}.late-tool-call.denied`,
        evaluate() {
          const probe = journal.find(row => row.kind === 'late-tool-call');
          return { passed: probe?.denied === true, details: { probe: probe ?? null } };
        },
      },
      stageOutcomeOracle('go'),
      noStrandedOracle(),
    ],
  };
}

function makeStaleFenceRuntime(targetName) {
  const target = TARGET[targetName];
  const journal = [];
  const base = W9_HAPPY_HANDLERS[target.key];
  let staleExecutionRef = null;

  const handler = context => {
    const current = context.assignment.workerExecutionId;
    if (staleExecutionRef === null) {
      staleExecutionRef = current;
      journal.push({ kind: 'seed-stale-execution', target: targetName, executionRef: current });
      throw new Error(`DISCOVERY_PROOF_SEED_STALE_EXECUTION:${targetName}`);
    }
    const upstream = context.handlers.product_submit;
    let probed = false;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema !== target.schema || probed) return upstream(input);
        probed = true;
        const saved = process.env.SAGA_EXECUTION_ID;
        try {
          process.env.SAGA_EXECUTION_ID = staleExecutionRef;
          upstream(structuredClone(input));
          journal.push({ kind: 'stale-fence-call', target: targetName, denied: false });
        } catch (error) {
          journal.push({
            kind: 'stale-fence-call', target: targetName, denied: true,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (saved === undefined) delete process.env.SAGA_EXECUTION_ID;
          else process.env.SAGA_EXECUTION_ID = saved;
        }
        return upstream(input);
      },
    };
    return base({ ...context, handlers });
  };

  return {
    handlers: withOverrides({ [target.key]: handler }),
    actorEvidence: journal,
    driveOptions: { maxCycles: 180 },
    oracles: [
      {
        id: `${targetName}.stale-execution.denied`,
        evaluate() {
          const probe = journal.find(row => row.kind === 'stale-fence-call');
          return { passed: probe?.denied === true, details: { probe: probe ?? null } };
        },
      },
      lostThenAcceptedOracle(targetName),
      stageOutcomeOracle('go'),
      noStrandedOracle(),
    ],
  };
}

const feedbackScenario = (target, variant, coverage) => Object.freeze({
  schemaVersion: 'factory.proof.kernel-scenario.v1',
  id: `discovery/${target}-feedback-${variant}`,
  kind: 'causal-fault',
  faultClass: 'feedback-fault',
  proves: [target === 'proposal' ? 'discovery.proposal-contract' : 'discovery.readiness-contract'],
  coverageItems: coverage,
});

const feedbackCoverage = (target, variant) => variant === 'exact'
  ? [`recovery:discovery-${target}:exact-feedback-repair`]
  : [`counterfactual:discovery-${target}:${variant}-feedback-no-magical-repair`];

export const DISCOVERY_RESILIENCE_SCENARIOS = Object.freeze([
  ...['proposal', 'readiness'].flatMap(target => [
    feedbackScenario(target, 'exact', feedbackCoverage(target, 'exact')),
    feedbackScenario(target, 'absent', feedbackCoverage(target, 'absent')),
    feedbackScenario(target, 'stale', feedbackCoverage(target, 'stale')),
    feedbackScenario(target, 'corrupted', feedbackCoverage(target, 'corrupted')),
  ]),
  ...['proposal', 'readiness'].flatMap(target => [
    Object.freeze({
      schemaVersion: 'factory.proof.kernel-scenario.v1',
      id: `discovery/${target}-worker-crash`,
      kind: 'recovery',
      proves: ['handoff.run-gate'],
      coverageItems: [`crash:discovery-${target}:bounded-recovery`],
    }),
    Object.freeze({
      schemaVersion: 'factory.proof.kernel-scenario.v1',
      id: `discovery/${target}-retry-exhaustion`,
      kind: 'causal-fault',
      faultClass: 'contract-shape',
      proves: [target === 'proposal' ? 'discovery.proposal-contract' : 'discovery.readiness-contract'],
      coverageItems: [
        `recovery:discovery-${target}:retry-exhaustion-terminal`,
        coverageToken.transition(TARGET[target].node, 'complete-failed'),
      ],
    }),
    Object.freeze({
      schemaVersion: 'factory.proof.kernel-scenario.v1',
      id: `discovery/${target}-duplicate-submit`,
      kind: 'recovery',
      proves: [target === 'proposal' ? 'discovery.proposal-contract' : 'discovery.readiness-contract'],
      coverageItems: [`idempotency:discovery-${target}:duplicate-submit`],
    }),
    Object.freeze({
      schemaVersion: 'factory.proof.kernel-scenario.v1',
      id: `discovery/${target}-late-tool-call`,
      kind: 'causal-fault',
      faultClass: 'scheduler-fence',
      proves: ['handoff.close-presentation'],
      coverageItems: [`tool-lifecycle:discovery-${target}:late-call-denied`],
    }),
    Object.freeze({
      schemaVersion: 'factory.proof.kernel-scenario.v1',
      id: `discovery/${target}-stale-execution-fence`,
      kind: 'causal-fault',
      faultClass: 'scheduler-fence',
      proves: ['handoff.close-presentation'],
      coverageItems: [`fence:discovery-${target}:stale-execution-denied`],
    }),
  ]),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'discovery/restart-idempotency',
    kind: 'recovery',
    proves: ['effect.replay-capture', 'handoff.route-lifecycle'],
    coverageItems: [
      'restart:discovery:same-input-replay',
      'restart:discovery:incompatible-input-cold',
      'idempotency:discovery:semantic-start-replay',
    ],
  }),
]);

export const DISCOVERY_CLOSURE_SCENARIOS = Object.freeze([
  ...DISCOVERY_SCENARIOS,
  ...DISCOVERY_RESILIENCE_SCENARIOS,
]);

// `settle -> complete-failed` is an internal kernel-exception edge: no admitted
// Discovery worker material can lawfully produce it because both upstream cells
// have already passed their Gates. It belongs to the platform K4 kernel-fault
// scheduler, not to the workshop cognition/fault matrix. Keep it explicitly
// outside workshop closure rather than fabricating an authority-table mutation.
export const DISCOVERY_PLATFORM_FAULT_EDGES = Object.freeze([
  coverageToken.transition('settle', 'complete-failed'),
]);

const workshopFullBase = DISCOVERY_FULL_COVERAGE_UNIVERSE.filter(item =>
  !DISCOVERY_PLATFORM_FAULT_EDGES.includes(item));

export const DISCOVERY_CLOSURE_COVERAGE_UNIVERSE = Object.freeze([
  ...new Set([
    ...workshopFullBase,
    'recovery:discovery-proposal:retry-exhaustion-terminal',
    'recovery:discovery-readiness:retry-exhaustion-terminal',
    'tool-lifecycle:discovery-proposal:late-call-denied',
    'tool-lifecycle:discovery-readiness:late-call-denied',
    'restart:discovery:same-input-replay',
    'restart:discovery:incompatible-input-cold',
    'idempotency:discovery:semantic-start-replay',
  ]),
]);

export function planDiscoveryClosureCoverage() {
  const matrix = buildScenarioCoverageMatrix(DISCOVERY_CLOSURE_SCENARIOS, {
    requiredItems: DISCOVERY_CLOSURE_COVERAGE_UNIVERSE,
  });
  return {
    matrix,
    summary: summarizeCoverage(matrix),
    minimalScenarioCover: selectScenarioCover(matrix),
    platformFaultEdges: DISCOVERY_PLATFORM_FAULT_EDGES,
  };
}

const resilienceById = new Map(DISCOVERY_RESILIENCE_SCENARIOS.map(s => [s.id, s]));

export function buildDiscoveryUnifiedRuntimeCase(id) {
  const scenario = resilienceById.get(id);
  if (!scenario) return buildDiscoveryRuntimeCase(id);
  if (id === 'discovery/restart-idempotency') {
    return {
      scenario,
      specialDrive: 'discovery-restart-idempotency',
      handlers: W9_HAPPY_HANDLERS,
      oracles: [],
      driveOptions: { maxCycles: 80 },
    };
  }

  const feedback = /^discovery\/(proposal|readiness)-feedback-(exact|absent|stale|corrupted)$/.exec(id);
  if (feedback) {
    return { scenario, ...makeFeedbackRuntime(feedback[1], feedback[2]) };
  }
  const crash = /^discovery\/(proposal|readiness)-worker-crash$/.exec(id);
  if (crash) return { scenario, ...makeCrashRuntime(crash[1]) };
  const exhaustion = /^discovery\/(proposal|readiness)-retry-exhaustion$/.exec(id);
  if (exhaustion) return { scenario, ...makeRetryExhaustionRuntime(exhaustion[1]) };
  const duplicate = /^discovery\/(proposal|readiness)-duplicate-submit$/.exec(id);
  if (duplicate) return { scenario, ...makeDuplicateRuntime(duplicate[1]) };
  const late = /^discovery\/(proposal|readiness)-late-tool-call$/.exec(id);
  if (late) return { scenario, ...makeLateCallRuntime(late[1]) };
  const fence = /^discovery\/(proposal|readiness)-stale-execution-fence$/.exec(id);
  if (fence) return { scenario, ...makeStaleFenceRuntime(fence[1]) };

  throw new Error(`DISCOVERY_RESILIENCE_RUNTIME_UNMAPPED: ${id}`);
}

export { DISCOVERY_PHASE1_REQUIRED_COVERAGE };
