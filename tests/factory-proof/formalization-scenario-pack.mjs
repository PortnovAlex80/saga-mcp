// tests/factory-proof/formalization-scenario-pack.mjs
//
// Formalization workshop pack for the unified Saga conformance kernel.
// The pack owns only deterministic cognition stimuli, independent oracles and
// coverage declarations. All Workplace/CandidateSet/Gate/review/effect/routing
// authority remains in the production Factory.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';
import {
  buildScenarioCoverageMatrix,
  coverageToken,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';

export const FORMALIZATION_STAGE = 'solution-formalization';
export const DEVELOPMENT_STAGE = 'solution-development';
export const REVIEW_SCHEMA = 'factory.review-verdict.v1';
export const RECONCILIATION_SCHEMA = 'factory.formalization-reconciliation-report.v1';

export const FORMALIZATION_TARGETS = Object.freeze({
  product: Object.freeze({
    node: 'define-product-contract',
    cell: 'formalization-product-contract',
    validator: 'formalization.product-contract.v1',
    provider: 'factory.submission-validator.formalization.product-contract.v1',
    obligation: 'frm.submission.product-contract',
    next: 'model-use-cases',
  }),
  useCases: Object.freeze({
    node: 'model-use-cases',
    cell: 'formalization-use-cases',
    validator: 'formalization.use-cases.v1',
    provider: 'factory.submission-validator.formalization.use-cases.v1',
    obligation: 'frm.submission.use-cases',
    next: 'define-acceptance-contract',
  }),
  acceptance: Object.freeze({
    node: 'define-acceptance-contract',
    cell: 'formalization-acceptance-contract',
    validator: 'formalization.acceptance-contract.v1',
    provider: 'factory.submission-validator.formalization.acceptance-contract.v1',
    obligation: 'frm.submission.acceptance-contract',
    next: 'reconcile-what',
  }),
  reconciliation: Object.freeze({
    node: 'reconcile-what',
    cell: 'formalization-reconciliation',
    validator: 'formalization.reconciliation.v1',
    provider: 'factory.submission-validator.formalization.reconciliation.v1',
    obligation: 'frm.submission.reconciliation',
    next: 'freeze-acceptance-baseline',
  }),
  architecture: Object.freeze({
    node: 'define-architecture-contract',
    cell: 'formalization-architecture-contract',
    validator: 'formalization.srs-contract.v1',
    provider: 'factory.submission-validator.formalization.srs-contract.v1',
    obligation: 'frm.submission.srs-contract',
    next: 'settle-formalization',
  }),
});

function uniqueHandlerKey(suffix) {
  const matches = Object.keys(W9_HAPPY_HANDLERS).filter(key => key.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `FORMALIZATION_SCENARIO_HANDLER_KEY_DRIFT: expected one W9 handler ending '${suffix}', got ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

export const FORMALIZATION_HANDLER_KEYS = Object.freeze({
  productAuthor: uniqueHandlerKey('/define-product-contract/author/singleton'),
  productReviewer: uniqueHandlerKey('/define-product-contract/reviewer/singleton'),
  useCasesAuthor: uniqueHandlerKey('/model-use-cases/author/singleton'),
  useCasesReviewer: uniqueHandlerKey('/model-use-cases/reviewer/singleton'),
  acceptanceAuthor: uniqueHandlerKey('/define-acceptance-contract/author/singleton'),
  acceptanceReviewer: uniqueHandlerKey('/define-acceptance-contract/reviewer/singleton'),
  reconciliationAuthor: uniqueHandlerKey('/reconcile-what/author/singleton'),
  reconciliationReviewer: uniqueHandlerKey('/reconcile-what/reviewer/singleton'),
  architectureAuthor: uniqueHandlerKey('/define-architecture-contract/author/singleton'),
  architectureReviewer: uniqueHandlerKey('/define-architecture-contract/reviewer/singleton'),
});

function withOverrides(overrides = {}) {
  return Object.freeze({ ...W9_HAPPY_HANDLERS, ...overrides });
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

export function stageOutcomeOracle(expectedOutcome) {
  return {
    id: `formalization.stage-outcome.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? [])
        .filter(row => row.stage_id === FORMALIZATION_STAGE && row.local_outcome === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `stage-run:${row.id}`),
        details: { expectedOutcome, count: rows.length },
      };
    },
  };
}

export function certificateOracle(expectedOutcome) {
  return {
    id: `formalization.certificate.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.processOutcomeCertificates ?? [])
        .filter(row => String(row.module_ref_key).includes('formalization')
          && row.decision === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `process-certificate:${row.id}`),
        details: { expectedOutcome, count: rows.length },
      };
    },
  };
}

export function receiptOracle(id, providerId, outcome) {
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

export function gateOracle(id, workplaceFragment, gatePhase, verdict) {
  return {
    id,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.gateDecisions ?? [])
        .filter(row => String(row.workplace_ref).includes(workplaceFragment)
          && row.gate_phase === gatePhase
          && row.verdict === verdict);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => String(row.decision_key)),
        details: { workplaceFragment, gatePhase, verdict, count: rows.length },
      };
    },
  };
}

export function submissionRejectionOracle(id, validatorId) {
  return {
    id,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.submissionValidationRejections ?? [])
        .filter(row => row.validator_id === validatorId);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => String(row.rejection_ref)),
        details: {
          validatorId,
          count: rows.length,
          rejectionCodes: rows.map(row => row.rejection_code),
        },
      };
    },
  };
}

export function noStrandedExecutionOracle() {
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

function allFormalizationCellsAcceptedOracle() {
  return {
    id: 'formalization.all-reviewed-cells.accepted',
    evaluate({ durableTrace }) {
      const failures = [];
      const facts = {};
      for (const target of Object.values(FORMALIZATION_TARGETS)) {
        const rows = (durableTrace.gateDecisions ?? []).filter(row =>
          String(row.workplace_ref).includes(target.cell));
        const author = rows.some(row => row.gate_phase === 'author' && row.verdict === 'accepted');
        const final = rows.some(row => row.gate_phase === 'final' && row.verdict === 'accepted');
        facts[target.cell] = { author, final };
        if (!author || !final) failures.push(target.cell);
      }
      return { passed: failures.length === 0, details: { failures, facts } };
    },
  };
}

function acceptedArtifactAuthorityOracle() {
  const formalizationTypes = new Set(['brief', 'PRD', 'FR', 'NFR', 'RULE', 'UC', 'AC', 'SRS']);
  return {
    id: 'formalization.accept-products.exact-artifact-hashes',
    evaluate({ durableTrace }) {
      const rows = (durableTrace.artifacts ?? []).filter(row => formalizationTypes.has(row.type));
      const withMaterial = rows.filter(row => typeof row.content_hash === 'string' && row.content_hash.length > 0);
      const bad = withMaterial.filter(row =>
        row.status !== 'accepted'
        || row.accepted_hash !== row.content_hash
        || row.drift_state !== 'clean');
      return {
        passed: withMaterial.length >= 8 && bad.length === 0,
        evidenceRefs: withMaterial.map(row => `artifact:${row.id}`),
        details: {
          observed: withMaterial.length,
          bad: bad.map(row => ({ id: row.id, type: row.type, code: row.code,
            status: row.status, contentHash: row.content_hash,
            acceptedHash: row.accepted_hash, driftState: row.drift_state })),
        },
      };
    },
  };
}

function formalizationEffectOracle() {
  return {
    id: 'formalization.accept-products.effect-receipts',
    evaluate({ durableTrace }) {
      const rows = (durableTrace.effectReceipts ?? []).filter(row =>
        row.effect_kind === 'formalization.accept-exact-products.v1');
      const unsettled = rows.filter(row => row.state !== 'completed' && row.state !== 'succeeded');
      return {
        passed: rows.length >= 5 && unsettled.length === 0,
        evidenceRefs: rows.map(row => String(row.effect_key)),
        details: { count: rows.length, states: rows.map(row => row.state) },
      };
    },
  };
}

function exactDevelopmentHandoffOracle() {
  return {
    id: 'formalization.handoff-exact.development',
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
      const mapped = parseSnapshot(formalization.mapped_output_snapshot);
      const input = parseSnapshot(development.input_snapshot);
      if (!mapped || !input) return { passed: false, details: { reason: 'unparseable snapshots' } };
      const payload = mapped.solutionContractPayload;
      const checks = {
        decision: mapped.decision === 'formalized'
          && input.formalizationCertificate?.decision === 'formalized',
        certificateSchema: mapped.certificate?.schema === input.formalizationCertificate?.schema,
        certificateRef: mapped.certificate?.ref === input.formalizationCertificate?.ref,
        certificateHash: mapped.certificate?.hash === input.formalizationCertificate?.hash,
        solutionSchema: mapped.solutionContract?.schema === input.solutionContract?.schema,
        solutionRef: mapped.solutionContract?.ref === input.solutionContract?.ref,
        solutionHash: mapped.solutionContract?.hash === input.solutionContract?.hash,
        baselineHash: payload?.bundle?.acceptanceBaselineHash === input.acceptanceBaselineHash,
        srs: sameValue(payload?.srs, input.srs),
        acceptanceCriteria: sameValue(payload?.acceptanceCriteria, input.acceptanceCriteria),
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      return {
        passed: failed.length === 0,
        evidenceRefs: [
          `stage-run:${formalization.id}`,
          `lifecycle-transition:${transition.id}`,
          `stage-run:${development.id}`,
        ],
        details: { failed, transitionKey: transition.transition_key, handoffHash: transition.handoff_hash },
      };
    },
  };
}

function positiveCoverage() {
  const items = [
    coverageToken.obligation('effect.formalization-accept-products'),
    coverageToken.obligation('handoff.route-lifecycle'),
    coverageToken.transition('freeze-acceptance-baseline', 'define-architecture-contract'),
    coverageToken.transition('settle-formalization', 'complete-formalized'),
    'binding:formalization:baseline-before-how',
    'binding:formalization:accepted-artifact-hashes',
    'handoff:solution-formalization->solution-development:formalized',
  ];
  for (const target of Object.values(FORMALIZATION_TARGETS)) {
    items.push(coverageToken.obligation(target.obligation));
    items.push(coverageToken.gate(`${target.cell}.author`, 'accepted'));
    items.push(coverageToken.gate(`${target.cell}.final`, 'accepted'));
    items.push(coverageToken.transition(target.node, target.next));
  }
  return items;
}

function preflightCoverage(targetName, detail) {
  const target = FORMALIZATION_TARGETS[targetName];
  return [
    coverageToken.obligation(target.obligation),
    `preflight:${target.node}:rejected-before-completion`,
    `repair:${target.node}:same-execution`,
    `negative-transition:${target.node}-/->${target.next}`,
    detail,
  ];
}

export const FORMALIZATION_SCENARIOS = Object.freeze([
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/happy-formalized',
    kind: 'positive',
    proves: [
      'frm.submission.product-contract',
      'frm.submission.use-cases',
      'frm.submission.acceptance-contract',
      'frm.submission.reconciliation',
      'frm.submission.srs-contract',
      'factory.review-verdict',
      'effect.formalization-accept-products',
      'handoff.route-lifecycle',
    ],
    coverageItems: positiveCoverage(),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/product-missing-brief-lineage-repair',
    kind: 'causal-fault',
    faultClass: 'authority-binding',
    proves: ['frm.submission.product-contract'],
    coverageItems: preflightCoverage('product', 'lineage:formalization-product:brief-root-required'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/use-cases-missing-fr-coverage-repair',
    kind: 'causal-fault',
    faultClass: 'authority-binding',
    proves: ['frm.submission.use-cases'],
    coverageItems: preflightCoverage('useCases', 'lineage:formalization-use-cases:accepted-fr-required'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/acceptance-missing-trace-repair',
    kind: 'causal-fault',
    faultClass: 'authority-binding',
    proves: ['frm.submission.acceptance-contract'],
    coverageItems: preflightCoverage('acceptance', 'lineage:formalization-acceptance:fr-nfr-uc-required'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/acceptance-heading-mismatch-repair',
    kind: 'causal-fault',
    faultClass: 'contract-shape',
    proves: ['frm.submission.acceptance-contract'],
    coverageItems: preflightCoverage('acceptance', 'grammar:formalization-ac:exact-heading-resolution'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/reconciliation-malformed-report-rejected',
    kind: 'causal-fault',
    faultClass: 'contract-shape',
    proves: ['frm.submission.reconciliation'],
    coverageItems: [
      coverageToken.obligation('frm.submission.reconciliation'),
      'shape:formalization-reconciliation:typed-report-protected',
      coverageToken.negativeTransition('reconcile-what', 'freeze-acceptance-baseline'),
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/architecture-invalid-d2-repair',
    kind: 'causal-fault',
    faultClass: 'contract-shape',
    proves: ['frm.submission.srs-contract'],
    coverageItems: preflightCoverage('architecture', 'grammar:formalization-srs:d2-enums-and-frozen-ac-codes'),
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'formalization/reviewer-foreign-subject',
    kind: 'causal-fault',
    faultClass: 'authority-binding',
    proves: ['factory.review-verdict'],
    coverageItems: [
      coverageToken.obligation('factory.review-verdict'),
      'detector:work-intent-payload-binding:subject_candidate_set_ref',
      coverageToken.negativeTransition('define-product-contract', 'model-use-cases'),
      'binding:formalization-reviewer:exact-author-candidate',
    ],
  }),
]);

function makeTraceRepairRuntime(targetName, shouldOmit) {
  const target = FORMALIZATION_TARGETS[targetName];
  const keyName = targetName === 'product' ? 'productAuthor'
    : targetName === 'useCases' ? 'useCasesAuthor'
      : 'acceptanceAuthor';
  const key = FORMALIZATION_HANDLER_KEYS[keyName];
  const base = W9_HAPPY_HANDLERS[key];
  const journal = [];
  const handler = context => {
    let omitted = null;
    const traceAdd = context.handlers.trace_add;
    const workerDone = context.handlers.worker_done;
    const handlers = {
      ...context.handlers,
      trace_add(input) {
        if (omitted === null && shouldOmit(input)) {
          omitted = structuredClone(input);
          journal.push({ kind: 'omitted-trace', node: target.node, input: omitted });
          return { scenarioOmitted: true };
        }
        return traceAdd(input);
      },
      worker_done(input) {
        try {
          return workerDone(input);
        } catch (error) {
          journal.push({ kind: 'preflight-rejected', node: target.node,
            error: error instanceof Error ? error.message : String(error) });
          if (!omitted) throw error;
          traceAdd(omitted);
          journal.push({ kind: 'same-execution-repair', node: target.node });
          return workerDone(input);
        }
      },
    };
    return base({ ...context, handlers });
  };
  return {
    handlers: withOverrides({ [key]: handler }),
    actorEvidence: journal,
    driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 180 },
    oracles: [
      submissionRejectionOracle(`${target.node}.preflight-rejection`, target.validator),
      stageOutcomeOracle('formalized'),
      noStrandedExecutionOracle(),
    ],
  };
}

function makeFileRepairRuntime(targetName, mutateContent) {
  const target = FORMALIZATION_TARGETS[targetName];
  const key = targetName === 'acceptance'
    ? FORMALIZATION_HANDLER_KEYS.acceptanceAuthor
    : FORMALIZATION_HANDLER_KEYS.architectureAuthor;
  const base = W9_HAPPY_HANDLERS[key];
  const journal = [];
  const handler = context => {
    const artifactCreate = context.handlers.artifact_create;
    const artifactUpdate = context.handlers.artifact_update;
    const workerDone = context.handlers.worker_done;
    let captured = null;
    const handlers = {
      ...context.handlers,
      artifact_create(input) {
        const isTarget = targetName === 'acceptance' ? input?.type === 'AC' : input?.type === 'SRS';
        if (!isTarget || captured !== null) return artifactCreate(input);
        const artifactPath = path.join(context.context.workspaceRoot, String(input.path).split('#')[0]);
        const goodContent = readFileSync(artifactPath, 'utf8');
        const badContent = mutateContent(goodContent);
        writeFileSync(artifactPath, badContent, 'utf8');
        captured = { input: structuredClone(input), artifactPath, goodContent };
        journal.push({ kind: 'mutated-file-before-create', node: target.node, path: input.path });
        const created = artifactCreate(input);
        captured.createdId = created?.id ?? null;
        return created;
      },
      worker_done(input) {
        try {
          return workerDone(input);
        } catch (error) {
          journal.push({ kind: 'preflight-rejected', node: target.node,
            error: error instanceof Error ? error.message : String(error) });
          if (!captured) throw error;
          // The submission validator reads the artifact content pinned at
          // create time (readExactArtifactContent), so restoring the file is
          // not enough: re-creating leaves the mutated hash pinned and the
          // retry fails identically (observed: 5 identical-digest rejections
          // → stasis). The production contract path for a changed existing
          // artifact is artifact_update — the factory re-hashes from disk.
          writeFileSync(captured.artifactPath, captured.goodContent, 'utf8');
          if (captured.createdId != null) {
            artifactUpdate({ id: captured.createdId });
          }
          journal.push({ kind: 'same-execution-file-repair', node: target.node });
          return workerDone(input);
        }
      },
    };
    return base({ ...context, handlers });
  };
  return {
    handlers: withOverrides({ [key]: handler }),
    actorEvidence: journal,
    driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 200 },
    oracles: [
      submissionRejectionOracle(`${target.node}.preflight-rejection`, target.validator),
      stageOutcomeOracle('formalized'),
      noStrandedExecutionOracle(),
    ],
  };
}

function makeMalformedReconciliationRuntime() {
  const key = FORMALIZATION_HANDLER_KEYS.reconciliationAuthor;
  const base = W9_HAPPY_HANDLERS[key];
  const journal = [];
  const handler = context => {
    const productSubmit = context.handlers.product_submit;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema !== RECONCILIATION_SCHEMA) return productSubmit(input);
        const malformed = { ...structuredClone(input), content: { status: 'reconciled' } };
        try {
          const result = productSubmit(malformed);
          journal.push({ kind: 'malformed-reconciliation-accepted-by-product-submit', result });
          return result;
        } catch (error) {
          journal.push({ kind: 'malformed-reconciliation-rejected',
            error: error instanceof Error ? error.message : String(error) });
          return productSubmit(input);
        }
      },
    };
    return base({ ...context, handlers });
  };
  return {
    handlers: withOverrides({ [key]: handler }),
    actorEvidence: journal,
    driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 180 },
    oracles: [
      {
        id: 'formalization.reconciliation.malformed-report-rejected-before-authority',
        evaluate() {
          const rejected = journal.some(row => row.kind === 'malformed-reconciliation-rejected');
          return { passed: rejected, details: { journal } };
        },
      },
      noStrandedExecutionOracle(),
    ],
  };
}

function makeForeignReviewerRuntime() {
  const key = FORMALIZATION_HANDLER_KEYS.productReviewer;
  const base = W9_HAPPY_HANDLERS[key];
  const journal = [];
  const handler = context => {
    const productSubmit = context.handlers.product_submit;
    const handlers = {
      ...context.handlers,
      product_submit(input) {
        if (input?.schema !== REVIEW_SCHEMA) return productSubmit(input);
        const next = structuredClone(input);
        next.content = {
          ...next.content,
          subject_candidate_set_ref: 'candidate-set/foreign-formalization-proof',
        };
        try {
          return productSubmit(next);
        } catch (error) {
          // The production fence for a foreign review subject is the reviewer
          // WorkIntent's payload binding, enforced at product_submit intake
          // (PRODUCT_PAYLOAD_BINDING_REJECTED on subject_candidate_set_ref) —
          // BEFORE any CandidateSet can seal the verdict. The gate/provider
          // 'unknown' path is therefore architecturally preempted for this
          // fault class (it stays reachable for stale bindings after an author
          // reseal). Journal the SAME typed feedback a real worker sees and
          // rethrow: an adversarial reviewer must not magically converge.
          const message = error instanceof Error ? error.message : String(error);
          journal.push({
            kind: 'foreign-subject-submit-rejected',
            error: message,
            bindsSubjectField: message.includes("field 'subject_candidate_set_ref'"),
          });
          throw error;
        }
      },
    };
    return base({ ...context, handlers });
  };
  return {
    handlers: withOverrides({ [key]: handler }),
    actorEvidence: journal,
    driveOptions: { maxCycles: 100 },
    oracles: [
      {
        id: 'formalization.review.foreign-subject-rejected-at-intake',
        evaluate() {
          const rejections = journal.filter(row => row.kind === 'foreign-subject-submit-rejected');
          return {
            passed: rejections.length > 0 && rejections.every(row => row.bindsSubjectField),
            details: { rejections },
          };
        },
      },
      {
        id: 'formalization.review.foreign-subject-never-sealed',
        evaluate({ durableTrace }) {
          const sealed = (durableTrace.managedSubmissions ?? [])
            .filter(row => row.schema_version === REVIEW_SCHEMA);
          return {
            passed: sealed.length === 0,
            evidenceRefs: sealed.map(row => `submission:${row.id}`),
            details: { sealedVerdictSubmissions: sealed.length },
          };
        },
      },
      {
        id: 'formalization.review.foreign-subject-no-final-acceptance',
        evaluate({ durableTrace }) {
          const rows = (durableTrace.gateDecisions ?? []).filter(row =>
            String(row.workplace_ref).includes(FORMALIZATION_TARGETS.product.cell)
            && row.gate_phase === 'final');
          return {
            passed: rows.length === 0,
            details: { finalGateDecisions: rows.length },
          };
        },
      },
      {
        id: 'formalization.review.foreign-subject-no-downstream-node',
        evaluate({ durableTrace }) {
          const rows = (durableTrace.managedSubmissions ?? [])
            .filter(row => row.node_id === 'model-use-cases');
          return {
            passed: rows.length === 0,
            details: { downstreamNodeSubmissions: rows.length },
          };
        },
      },
      noStrandedExecutionOracle(),
    ],
  };
}

const byId = new Map(FORMALIZATION_SCENARIOS.map(scenario => [scenario.id, scenario]));

export function buildFormalizationRuntimeCase(id) {
  const scenario = byId.get(id);
  if (!scenario) {
    throw new Error(`FORMALIZATION_SCENARIO_UNKNOWN: ${id}; known=${[...byId.keys()].join(',')}`);
  }
  switch (id) {
    case 'formalization/happy-formalized':
      return {
        scenario,
        handlers: withOverrides(),
        driveOptions: { stopOnStageOutcome: 'formalized', maxCycles: 180 },
        oracles: [
          ...Object.values(FORMALIZATION_TARGETS).flatMap(target => [
            receiptOracle(`${target.node}.author-check.passed`, target.provider, 'passed'),
          ]),
          receiptOracle('formalization.review-verdict.passed', 'factory.review-verdict.v1', 'passed'),
          allFormalizationCellsAcceptedOracle(),
          formalizationEffectOracle(),
          acceptedArtifactAuthorityOracle(),
          stageOutcomeOracle('formalized'),
          certificateOracle('formalized'),
          exactDevelopmentHandoffOracle(),
          noStrandedExecutionOracle(),
        ],
      };
    case 'formalization/product-missing-brief-lineage-repair':
      return { scenario, ...makeTraceRepairRuntime('product', input => input?.link_type === 'derived_from') };
    case 'formalization/use-cases-missing-fr-coverage-repair':
      return { scenario, ...makeTraceRepairRuntime('useCases', input => input?.link_type === 'covers') };
    case 'formalization/acceptance-missing-trace-repair':
      return { scenario, ...makeTraceRepairRuntime('acceptance', input => input?.link_type === 'derived_from') };
    case 'formalization/acceptance-heading-mismatch-repair':
      return { scenario, ...makeFileRepairRuntime('acceptance', content => content.replace(/^## AC-/m, '## ACX-')) };
    case 'formalization/reconciliation-malformed-report-rejected':
      return { scenario, ...makeMalformedReconciliationRuntime() };
    case 'formalization/architecture-invalid-d2-repair':
      return { scenario, ...makeFileRepairRuntime('architecture', content => content.replace('ac_kind: implementation', 'ac_kind: impossible')) };
    case 'formalization/reviewer-foreign-subject':
      return { scenario, ...makeForeignReviewerRuntime() };
    default:
      throw new Error(`FORMALIZATION_SCENARIO_UNMAPPED: ${id}`);
  }
}

export const FORMALIZATION_PHASE1_REQUIRED_COVERAGE = Object.freeze([
  coverageToken.obligation('frm.submission.product-contract'),
  coverageToken.obligation('frm.submission.use-cases'),
  coverageToken.obligation('frm.submission.acceptance-contract'),
  coverageToken.obligation('frm.submission.reconciliation'),
  coverageToken.obligation('frm.submission.srs-contract'),
  coverageToken.obligation('factory.review-verdict'),
  coverageToken.obligation('effect.formalization-accept-products'),
  coverageToken.obligation('handoff.route-lifecycle'),
  ...positiveCoverage().filter(item => !item.startsWith('obligation:')),
  ...preflightCoverage('product', 'lineage:formalization-product:brief-root-required'),
  ...preflightCoverage('useCases', 'lineage:formalization-use-cases:accepted-fr-required'),
  ...preflightCoverage('acceptance', 'lineage:formalization-acceptance:fr-nfr-uc-required'),
  'grammar:formalization-ac:exact-heading-resolution',
  'shape:formalization-reconciliation:typed-report-protected',
  'grammar:formalization-srs:d2-enums-and-frozen-ac-codes',
  'detector:work-intent-payload-binding:subject_candidate_set_ref',
  coverageToken.negativeTransition('define-product-contract', 'model-use-cases'),
  'binding:formalization-reviewer:exact-author-candidate',
]);

export const FORMALIZATION_PLATFORM_FAULT_EDGES = Object.freeze([
  coverageToken.transition('freeze-acceptance-baseline', 'complete-inconsistent'),
  coverageToken.transition('freeze-acceptance-baseline', 'complete-failed'),
  coverageToken.transition('settle-formalization', 'complete-inconsistent'),
  coverageToken.transition('settle-formalization', 'complete-failed'),
  'effect-fault:formalization-accept-products:post-gate-pre-effect-drift',
]);

export const FORMALIZATION_FULL_COVERAGE_UNIVERSE = Object.freeze([
  ...new Set([
    ...FORMALIZATION_PHASE1_REQUIRED_COVERAGE,
    ...Object.values(FORMALIZATION_TARGETS).flatMap(target => [
      coverageToken.transition(target.node, 'complete-failed'),
      `crash:${target.cell}:bounded-recovery`,
    ]),
    'recovery:formalization-reviewed-cell:exact-feedback-repair',
    'counterfactual:formalization-reviewed-cell:absent-feedback-no-magical-repair',
    'counterfactual:formalization-reviewed-cell:stale-feedback-no-magical-repair',
    'counterfactual:formalization-reviewed-cell:corrupted-feedback-no-magical-repair',
    'idempotency:formalization-reconciliation:duplicate-submit',
    'tool-lifecycle:formalization-reconciliation:late-call-denied',
    'fence:formalization-product-contract:stale-execution-denied',
    'restart:formalization:same-input-replay',
    'restart:formalization:incompatible-input-cold',
    'idempotency:formalization:semantic-start-replay',
  ]),
]);

export function planFormalizationCoverage() {
  const phase1Matrix = buildScenarioCoverageMatrix(FORMALIZATION_SCENARIOS, {
    requiredItems: FORMALIZATION_PHASE1_REQUIRED_COVERAGE,
  });
  const fullMatrix = buildScenarioCoverageMatrix(FORMALIZATION_SCENARIOS, {
    requiredItems: FORMALIZATION_FULL_COVERAGE_UNIVERSE,
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
    platformFaultEdges: FORMALIZATION_PLATFORM_FAULT_EDGES,
  };
}
