// tests/factory-proof/formalization-resilience-pack.mjs
//
// Formalization closure extension: reviewer-feedback causality, crash/recovery,
// retry exhaustion, duplicate/late calls, stale-fence and restart/idempotency.
// The five reviewed Cells share Factory physics, but every local failed edge is
// still represented explicitly so graph coverage never hides behind an
// equivalence-class claim.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';
import { createScriptedActor, projectFeedbackVariant } from './scripted-actor.mjs';
import {
  buildScenarioCoverageMatrix,
  coverageToken,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';
import {
  FORMALIZATION_FULL_COVERAGE_UNIVERSE,
  FORMALIZATION_HANDLER_KEYS,
  FORMALIZATION_PLATFORM_FAULT_EDGES,
  FORMALIZATION_SCENARIOS,
  FORMALIZATION_STAGE,
  FORMALIZATION_TARGETS,
  RECONCILIATION_SCHEMA,
  REVIEW_SCHEMA,
  buildFormalizationRuntimeCase,
  gateOracle,
  noStrandedExecutionOracle,
  stageOutcomeOracle,
} from './formalization-scenario-pack.mjs';

const TARGET_META = Object.freeze({
  product: Object.freeze({
    ...FORMALIZATION_TARGETS.product,
    authorKey: FORMALIZATION_HANDLER_KEYS.productAuthor,
    reviewerKey: FORMALIZATION_HANDLER_KEYS.productReviewer,
    crashInvocation: 3,
  }),
  useCases: Object.freeze({
    ...FORMALIZATION_TARGETS.useCases,
    authorKey: FORMALIZATION_HANDLER_KEYS.useCasesAuthor,
    reviewerKey: FORMALIZATION_HANDLER_KEYS.useCasesReviewer,
    crashInvocation: 5,
  }),
  acceptance: Object.freeze({
    ...FORMALIZATION_TARGETS.acceptance,
    authorKey: FORMALIZATION_HANDLER_KEYS.acceptanceAuthor,
    reviewerKey: FORMALIZATION_HANDLER_KEYS.acceptanceReviewer,
    crashInvocation: 7,
  }),
  reconciliation: Object.freeze({
    ...FORMALIZATION_TARGETS.reconciliation,
    authorKey: FORMALIZATION_HANDLER_KEYS.reconciliationAuthor,
    reviewerKey: FORMALIZATION_HANDLER_KEYS.reconciliationReviewer,
    crashInvocation: 9,
  }),
  architecture: Object.freeze({
    ...FORMALIZATION_TARGETS.architecture,
    authorKey: FORMALIZATION_HANDLER_KEYS.architectureAuthor,
    reviewerKey: FORMALIZATION_HANDLER_KEYS.architectureReviewer,
    crashInvocation: 11,
  }),
});

function withOverrides(overrides = {}) {
  return Object.freeze({ ...W9_HAPPY_HANDLERS, ...overrides });
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
      : typeof finding?.code === 'string' ? finding.code : 'FORMALIZATION_RECOVERY',
    subjectRef,
    evidence: {
      message: typeof finding?.message === 'string' ? finding.message : '',
      expected: Array.isArray(finding?.expected) ? finding.expected : [],
    },
  };
}

function exactReviewerFeedbackPredicate(visible) {
  const feedback = visible?.recoveryFeedback;
  if (!feedback || typeof feedback !== 'object') return false;
  if (typeof feedback.reasonCode !== 'string'
    || feedback.reasonCode.endsWith('_CORRUPTED')) return false;
  if (typeof feedback.subjectRef !== 'string'
    || feedback.subjectRef.includes('@revision-0')) return false;
  return JSON.stringify(feedback.evidence ?? {}).includes('reviewer-proof-repair-marker');
}

function candidateMaterialDigest(candidate) {
  const refs = Array.isArray(candidate?.product_refs) ? candidate.product_refs : [];
  return refs
    .map(ref => `${String(ref.schemaId)}:${String(ref.digest)}`)
    .sort()
    .join('|');
}

function makeReviewerFeedbackRuntime(variant) {
  const target = TARGET_META.product;
  const journal = [];
  const actor = createScriptedActor({
    rules: [{
      when: exactReviewerFeedbackPredicate,
      act: () => ({ action: 'repair-visible-material' }),
    }],
    fallback: () => ({ action: 'repeat-visible-material' }),
  });
  const baseAuthor = W9_HAPPY_HANDLERS[target.authorKey];
  let firstReviewedMaterialDigest = null;

  const author = context => {
    const exact = productionRecoveryFeedback(context.meta);
    const projected = exact === null ? null : projectFeedbackVariant(exact, variant);
    const reaction = actor.react({
      prompt: 'Formalization reviewed-cell repair',
      recoveryFeedback: projected,
      lastToolError: null,
      deskFiles: [],
    });
    journal.push({
      kind: 'author-reaction',
      variant,
      executionRef: context.assignment.workerExecutionId,
      feedbackPresent: projected !== null,
      output: reaction.output,
      visibleInputDigest: reaction.visibleInputDigest,
      actorOutputDigest: reaction.actorOutputDigest,
    });
    if (reaction.output.action !== 'repair-visible-material') return baseAuthor(context);

    const artifactCreate = context.handlers.artifact_create;
    let changed = false;
    const handlers = {
      ...context.handlers,
      artifact_create(input) {
        if (!changed && input?.type === 'PRD') {
          const filePath = path.join(context.context.workspaceRoot, String(input.path).split('#')[0]);
          const content = readFileSync(filePath, 'utf8');
          writeFileSync(filePath, `${content}\nreviewer-proof-repair-marker\n`, 'utf8');
          changed = true;
          journal.push({ kind: 'author-material-changed', path: input.path });
        }
        return artifactCreate(input);
      },
    };
    return baseAuthor({ ...context, handlers });
  };

  const reviewer = context => {
    const workplaceRef = context.meta.workplace_ref ?? context.meta.workplaceRef;
    if (!workplaceRef) throw new Error('FORMALIZATION_PROOF_REVIEWER_WORKPLACE_REQUIRED');
    const candidate = context.handlers.candidate_read({ workplace_ref: workplaceRef, role: 'author' });
    const materialDigest = candidateMaterialDigest(candidate);
    if (firstReviewedMaterialDigest === null) firstReviewedMaterialDigest = materialDigest;
    const changed = materialDigest !== firstReviewedMaterialDigest;
    journal.push({ kind: 'review-visible-material', variant, materialDigest, changed });
    context.handlers.product_submit({
      schema: REVIEW_SCHEMA,
      content: changed
        ? {
            verdict: 'approved',
            findings: [],
            subject_candidate_set_ref: candidate.candidate_set_ref,
          }
        : {
            verdict: 'changes_requested',
            findings: ['reviewer-proof-repair-marker must be added to the visible PRD material'],
            subject_candidate_set_ref: candidate.candidate_set_ref,
          },
    });
    context.handlers.worker_done({
      task_id: Number(context.assignment.taskId),
      worker_id: context.assignment.workerId,
      execution_id: context.assignment.workerExecutionId,
      result: changed ? 'review approved repaired material' : 'review requested visible material repair',
    });
    return { kind: 'worker-done-accepted' };
  };

  const expectRepair = variant === 'exact';
  return {
    handlers: withOverrides({
      [target.authorKey]: author,
      [target.reviewerKey]: reviewer,
    }),
    actorEvidence: journal,
    driveOptions: {
      maxCycles: expectRepair ? 220 : 120,
      ...(expectRepair ? { stopOnStageOutcome: 'formalized' } : {}),
    },
    oracles: [
      gateOracle('formalization.feedback.final-gate-rejected', target.cell, 'final', 'repair_required'),
      {
        id: `formalization.feedback.actor-${variant}`,
        evaluate() {
          const repairs = journal.filter(row => row.kind === 'author-material-changed');
          return {
            passed: expectRepair ? repairs.length >= 1 : repairs.length === 0,
            details: { variant, repairs: repairs.length },
          };
        },
      },
      expectRepair
        ? gateOracle('formalization.feedback.final-gate-accepted-after-repair', target.cell, 'final', 'accepted')
        : {
            id: `formalization.feedback.${variant}.no-final-acceptance`,
            evaluate({ durableTrace }) {
              const accepted = (durableTrace.gateDecisions ?? []).filter(row =>
                String(row.workplace_ref).includes(target.cell)
                && row.gate_phase === 'final'
                && row.verdict === 'accepted');
              return { passed: accepted.length === 0, details: { accepted: accepted.length } };
            },
          },
      expectRepair
        ? stageOutcomeOracle('formalized')
        : typedBoundedFailureOracle(`formalization.feedback.${variant}.typed-bounded`, target.cell),
      noStrandedExecutionOracle(),
    ],
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
        row.stage_id === FORMALIZATION_STAGE && row.local_outcome === 'failed');
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

function lostThenAcceptedOracle(targetName) {
  const target = TARGET_META[targetName];
  return {
    id: `${targetName}.crash.lost-then-accepted`,
    evaluate({ durableTrace }) {
      const tasks = new Set((durableTrace.workIntents ?? [])
        .filter(t => String(t.workplace_ref).includes(target.cell))
        .map(t => t.id));
      const executions = (durableTrace.workerExecutions ?? []).filter(e => tasks.has(e.task_id));
      const lost = executions.filter(e => e.state === 'lost');
      const finalAccepted = (durableTrace.gateDecisions ?? []).filter(g =>
        String(g.workplace_ref).includes(target.cell)
        && g.gate_phase === 'final'
        && g.verdict === 'accepted');
      return {
        passed: lost.length >= 1 && finalAccepted.length >= 1,
        details: { executionStates: executions.map(e => e.state), finalAccepted: finalAccepted.length },
      };
    },
  };
}

function makeCrashRuntime(targetName) {
  const target = TARGET_META[targetName];
  return {
    handlers: W9_HAPPY_HANDLERS,
    crashPoint: {
      scenarioKeyPrefix: target.authorKey,
      atInvocation: target.crashInvocation,
      effect: 'exit-nonzero',
      name: `formalization-${targetName}-first-author-crash`,
    },
    faultJournal: [{ class: 'worker-crash', target: targetName, boundary: 'worker-before-handler' }],
    driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 240 },
    oracles: [lostThenAcceptedOracle(targetName), stageOutcomeOracle('formalized'), noStrandedExecutionOracle()],
  };
}

function changesRequestedReviewer(targetName) {
  const target = TARGET_META[targetName];
  const base = W9_HAPPY_HANDLERS[target.reviewerKey];
  return context => {
    const submit = context.handlers.product_submit;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema !== REVIEW_SCHEMA) return submit(input);
        const next = structuredClone(input);
        next.content = {
          ...next.content,
          verdict: 'changes_requested',
          findings: [`formalization-${targetName}-retry-exhaustion-stable-finding`],
        };
        return submit(next);
      },
    };
    return base({ ...context, handlers });
  };
}

function makeRetryExhaustionRuntime(targetName) {
  const target = TARGET_META[targetName];
  return {
    handlers: withOverrides({ [target.reviewerKey]: changesRequestedReviewer(targetName) }),
    driveOptions: { maxCycles: 180 },
    oracles: [
      gateOracle(`${targetName}.exhaustion.repair-required`, target.cell, 'final', 'repair_required'),
      recoveryEpochOracle(targetName),
      typedBoundedFailureOracle(`${targetName}.exhaustion.typed-backoff`, target.cell),
      noStrandedExecutionOracle(),
    ],
  };
}

function recoveryEpochOracle(targetName) {
  const target = TARGET_META[targetName];
  return {
    id: `${targetName}.exhaustion.recovery-epoch`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.recoveryEpochs ?? []).filter(row =>
        String(row.workplace_ref).includes(target.cell) && Number(row.epoch) >= 1);
      return {
        passed: rows.length >= 1,
        evidenceRefs: rows.map(row => `recovery-epoch:${row.workplace_ref}:${row.epoch}`),
        details: { epochs: rows.map(row => row.epoch) },
      };
    },
  };
}

function makeDuplicateRuntime() {
  const target = TARGET_META.reconciliation;
  const journal = [];
  const base = W9_HAPPY_HANDLERS[target.authorKey];
  const handler = context => {
    const submit = context.handlers.product_submit;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema !== RECONCILIATION_SCHEMA) return submit(input);
        const first = submit(input);
        try {
          const second = submit(structuredClone(input));
          journal.push({ kind: 'duplicate-submit', accepted: true, replayed: second?.replayed === true });
        } catch (error) {
          journal.push({ kind: 'duplicate-submit', accepted: false,
            error: error instanceof Error ? error.message : String(error) });
        }
        return first;
      },
    };
    return base({ ...context, handlers });
  };
  return {
    handlers: withOverrides({ [target.authorKey]: handler }),
    actorEvidence: journal,
    driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 200 },
    oracles: [
      {
        id: 'formalization.reconciliation.duplicate-submit.idempotent',
        evaluate({ durableTrace }) {
          const rows = (durableTrace.managedSubmissions ?? []).filter(row =>
            row.node_id === target.node && row.schema_version === RECONCILIATION_SCHEMA);
          const probe = journal.find(row => row.kind === 'duplicate-submit');
          const safe = probe?.replayed === true || probe?.accepted === false;
          return { passed: Boolean(safe) && rows.length === 1,
            details: { probe: probe ?? null, durableSubmissionCount: rows.length } };
        },
      },
      stageOutcomeOracle('formalized'),
      noStrandedExecutionOracle(),
    ],
  };
}

function makeLateCallRuntime() {
  const target = TARGET_META.reconciliation;
  const journal = [];
  const base = W9_HAPPY_HANDLERS[target.authorKey];
  const handler = context => {
    const submit = context.handlers.product_submit;
    let captured = null;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema === RECONCILIATION_SCHEMA) captured = structuredClone(input);
        return submit(input);
      },
    };
    const result = base({ ...context, handlers });
    if (!captured) throw new Error('FORMALIZATION_LATE_CALL_NO_RECONCILIATION_SUBMISSION');
    try {
      submit(captured);
      journal.push({ kind: 'late-tool-call', denied: false });
    } catch (error) {
      journal.push({ kind: 'late-tool-call', denied: true,
        error: error instanceof Error ? error.message : String(error) });
    }
    return result;
  };
  return {
    handlers: withOverrides({ [target.authorKey]: handler }),
    actorEvidence: journal,
    driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 200 },
    oracles: [
      {
        id: 'formalization.reconciliation.late-tool-call.denied',
        evaluate() {
          const probe = journal.find(row => row.kind === 'late-tool-call');
          return { passed: probe?.denied === true, details: { probe: probe ?? null } };
        },
      },
      stageOutcomeOracle('formalized'),
      noStrandedExecutionOracle(),
    ],
  };
}

function makeStaleFenceRuntime() {
  const target = TARGET_META.product;
  const journal = [];
  const base = W9_HAPPY_HANDLERS[target.authorKey];
  let staleExecutionRef = null;
  const handler = context => {
    const current = context.assignment.workerExecutionId;
    if (staleExecutionRef === null) {
      staleExecutionRef = current;
      journal.push({ kind: 'seed-stale-execution', executionRef: current });
      throw new Error('FORMALIZATION_PROOF_SEED_STALE_EXECUTION');
    }
    const artifactCreate = context.handlers.artifact_create;
    let probed = false;
    const handlers = {
      ...context.handlers,
      artifact_create(input) {
        if (probed) return artifactCreate(input);
        probed = true;
        const saved = process.env.SAGA_EXECUTION_ID;
        try {
          process.env.SAGA_EXECUTION_ID = staleExecutionRef;
          artifactCreate(structuredClone(input));
          journal.push({ kind: 'stale-fence-artifact-call', denied: false });
        } catch (error) {
          journal.push({ kind: 'stale-fence-artifact-call', denied: true,
            error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (saved === undefined) delete process.env.SAGA_EXECUTION_ID;
          else process.env.SAGA_EXECUTION_ID = saved;
        }
        return artifactCreate(input);
      },
    };
    return base({ ...context, handlers });
  };
  return {
    handlers: withOverrides({ [target.authorKey]: handler }),
    actorEvidence: journal,
    driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 240 },
    oracles: [
      {
        id: 'formalization.product.stale-execution.denied',
        evaluate() {
          const probe = journal.find(row => row.kind === 'stale-fence-artifact-call');
          return { passed: probe?.denied === true, details: { probe: probe ?? null } };
        },
      },
      lostThenAcceptedOracle('product'),
      stageOutcomeOracle('formalized'),
      noStrandedExecutionOracle(),
    ],
  };
}

const feedbackScenario = variant => Object.freeze({
  schemaVersion: 'factory.proof.kernel-scenario.v1',
  id: `formalization/reviewer-feedback-${variant}`,
  kind: 'causal-fault',
  faultClass: 'feedback-fault',
  proves: ['factory.review-verdict'],
  coverageItems: variant === 'exact'
    ? ['recovery:formalization-reviewed-cell:exact-feedback-repair']
    : [`counterfactual:formalization-reviewed-cell:${variant}-feedback-no-magical-repair`],
});

export const FORMALIZATION_RESILIENCE_SCENARIOS = Object.freeze([
  ...['exact', 'absent', 'stale', 'corrupted'].map(feedbackScenario),
  ...Object.keys(TARGET_META).flatMap(targetName => [
    Object.freeze({
      schemaVersion: 'factory.proof.kernel-scenario.v1',
      id: `formalization/${targetName}-worker-crash`,
      kind: 'recovery',
      proves: ['handoff.close-presentation'],
      coverageItems: [`crash:${TARGET_META[targetName].cell}:bounded-recovery`],
    }),
    Object.freeze({
      schemaVersion: 'factory.proof.kernel-scenario.v1',
      id: `formalization/${targetName}-retry-exhaustion`,
      kind: 'causal-fault',
      faultClass: 'authored-semantic',
      proves: ['factory.review-verdict'],
      coverageItems: [
        `recovery:${TARGET_META[targetName].cell}:retry-exhaustion-terminal`,
        coverageToken.transition(TARGET_META[targetName].node, 'complete-failed'),
      ],
    }),
  ]),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/reconciliation-duplicate-submit',
    kind: 'recovery',
    proves: ['frm.submission.reconciliation'],
    coverageItems: ['idempotency:formalization-reconciliation:duplicate-submit'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/reconciliation-late-tool-call',
    kind: 'causal-fault',
    faultClass: 'scheduler-fence',
    proves: ['handoff.close-presentation'],
    coverageItems: ['tool-lifecycle:formalization-reconciliation:late-call-denied'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/product-stale-execution-fence',
    kind: 'causal-fault',
    faultClass: 'scheduler-fence',
    proves: ['handoff.close-presentation'],
    coverageItems: ['fence:formalization-product-contract:stale-execution-denied'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/restart-idempotency',
    kind: 'recovery',
    proves: ['effect.replay-capture', 'effect.formalization-accept-products', 'handoff.route-lifecycle'],
    coverageItems: [
      'restart:formalization:same-input-replay',
      'restart:formalization:incompatible-input-cold',
      'idempotency:formalization:semantic-start-replay',
    ],
  }),
]);

export const FORMALIZATION_CLOSURE_SCENARIOS = Object.freeze([
  ...FORMALIZATION_SCENARIOS,
  ...FORMALIZATION_RESILIENCE_SCENARIOS,
]);

const closureWithoutPlatformFaults = FORMALIZATION_FULL_COVERAGE_UNIVERSE.filter(item =>
  !FORMALIZATION_PLATFORM_FAULT_EDGES.includes(item));

export const FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE = Object.freeze([
  ...new Set([
    ...closureWithoutPlatformFaults,
    ...Object.values(TARGET_META).map(target =>
      `recovery:${target.cell}:retry-exhaustion-terminal`),
  ]),
]);

export function planFormalizationClosureCoverage() {
  const matrix = buildScenarioCoverageMatrix(FORMALIZATION_CLOSURE_SCENARIOS, {
    requiredItems: FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE,
  });
  return {
    matrix,
    summary: summarizeCoverage(matrix),
    minimalScenarioCover: selectScenarioCover(matrix),
    platformFaultEdges: FORMALIZATION_PLATFORM_FAULT_EDGES,
  };
}

const resilienceById = new Map(FORMALIZATION_RESILIENCE_SCENARIOS.map(s => [s.id, s]));

export function buildFormalizationUnifiedRuntimeCase(id) {
  const scenario = resilienceById.get(id);
  if (!scenario) return buildFormalizationRuntimeCase(id);

  const feedback = /^formalization\/reviewer-feedback-(exact|absent|stale|corrupted)$/.exec(id);
  if (feedback) return { scenario, ...makeReviewerFeedbackRuntime(feedback[1]) };

  const crash = /^formalization\/(product|useCases|acceptance|reconciliation|architecture)-worker-crash$/.exec(id);
  if (crash) return { scenario, ...makeCrashRuntime(crash[1]) };

  const exhaustion = /^formalization\/(product|useCases|acceptance|reconciliation|architecture)-retry-exhaustion$/.exec(id);
  if (exhaustion) {
    return {
      scenario,
      specialDrive: 'formalization-retry-exhaustion',
      targetName: exhaustion[1],
      ...makeRetryExhaustionRuntime(exhaustion[1]),
    };
  }

  if (id === 'formalization/reconciliation-duplicate-submit') {
    return { scenario, ...makeDuplicateRuntime() };
  }
  if (id === 'formalization/reconciliation-late-tool-call') {
    return { scenario, ...makeLateCallRuntime() };
  }
  if (id === 'formalization/product-stale-execution-fence') {
    return { scenario, ...makeStaleFenceRuntime() };
  }
  if (id === 'formalization/restart-idempotency') {
    return {
      scenario,
      specialDrive: 'formalization-restart-idempotency',
      handlers: W9_HAPPY_HANDLERS,
      oracles: [],
      driveOptions: { maxCycles: 180 },
    };
  }
  throw new Error(`FORMALIZATION_RESILIENCE_SCENARIO_UNMAPPED: ${id}`);
}

export { TARGET_META as FORMALIZATION_RESILIENCE_TARGETS };
