import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import { singletonProductionCell } from '../../application/standard-production-cell.js';
import { buildCheckPlan } from '../../application/standard-check-providers.js';
import {
  REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
  REVIEW_VERDICT_CHECK_PROVIDER_ID,
  REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
} from '../../application/review-verdict-check-provider.js';
import { DEVELOPMENT_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../modules/development/domain/development-kernel-ports.js';
import {
  ACCEPTANCE_VERIFICATION_SCHEMA,
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
} from '../../../modules/development/domain/development-schemas.js';
import {
  PLAN_INDEPENDENT_FROZEN_SRS_FAILURE_CODES,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_VERSION,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_ID,
  DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION,
  DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
  DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION,
  DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID,
  DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_VERSION,
} from '../../../modules/development/application/development-check-providers.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../../modules/development/application/candidate-check-contracts.js';

export { DEVELOPMENT_PROCESS_MODULE_REF };

const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';
const DEVELOPMENT_RESOURCE_ROOT =
  'src/process-modules/modules/development/package/resources';
const DEVELOPMENT_TRACKER =
  `${DEVELOPMENT_RESOURCE_ROOT}/process-module-stage-tracker.md`;
const DEVELOPMENT_SUBMISSION_CALL =
  `${DEVELOPMENT_RESOURCE_ROOT}/task-graph-submit-call-template.json`;
const DEVELOPMENT_CHECKLIST =
  `${DEVELOPMENT_RESOURCE_ROOT}/task-graph-planner-checklist.md`;
const IMPLEMENTATION_TRACKER =
  `${DEVELOPMENT_RESOURCE_ROOT}/implementation-task-tracker.md`;
const IMPLEMENTATION_CHECKLIST =
  `${DEVELOPMENT_RESOURCE_ROOT}/implementation-worker-checklist.md`;
const READINESS_CHECKLIST =
  `${DEVELOPMENT_RESOURCE_ROOT}/readiness-certification-checklist.md`;

const COMMON_READ_TOOLS = [
  'task_get', 'task_list', 'artifact_list', 'artifact_get', 'trace_list', 'repository_list',
  'repository_checkout_list', 'candidate_read', 'product_read', 'Read', 'Glob', 'Grep',
] as const;
// Stage-8 (defect A, G3 dossier §9): no worker-selected merge authority —
// ADR-039 / K11 commit 4; CONVEYOR §18:847-848. The merge tools were removed
// from every profile; the fenced git-integration post-acceptance effect owns
// integration. Enforced by tests/architecture/no-worker-fenced-effect-grants.test.mjs.
const COMMON_WRITE_TOOLS = [
  ...COMMON_READ_TOOLS,
  'worker_done',
  'verification_record',
  'product_submit',
  'Write', 'Edit', 'Bash',
] as const;

const PLANNER_CHECK_PLAN = buildCheckPlan(
  'development.plan-task-graph.final',
  [{
    providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
    // CODE-SCOPED upstream ownership (Red-Team correction 2026-08-24): the
    // three plan-independent frozen-SRS failure codes — srs-artifact-drifted,
    // srs-module-manifest-missing, srs-file-identity-conflict — are decided
    // from the frozen SRS (+ register) ALONE. No planner resubmission can
    // repair them (the SRS is frozen upstream; the planner cannot edit it),
    // so exactly these receipts escalate to the producer-defect verdict
    // 'failed' (failureOwnership:'upstream' semantics): the cell routes
    // complete-failed → terminal Development outcome, and the continuation
    // defect-evidence seam (readParentDefectEvidence) carries the typed
    // cause to the upstream repair boundary instead of burning planner
    // attempts (maxAttempts + recovery epochs) on an unrepairable defect —
    // the Elite-8 death. Deliberately NOT the blanket entry-level
    // failureOwnership:'upstream': genuine plan errors emitted by the SAME
    // provider (srs-module-uncovered, task-graph-invalid, decode/binding
    // codes) must keep routing planner repair.
    upstreamOwnedFailureCodes: PLAN_INDEPENDENT_FROZEN_SRS_FAILURE_CODES,
  }],
);
const IMPLEMENTATION_AUTHOR_PLAN = buildCheckPlan(
  // v3 — STAGE-18 R2: the claim-surface monotonicity provider joins the
  // plan after the scope check. The scope check compares the current claim
  // against the git diff and the frozen scopes but never against the card's
  // own prior claims — the stage-15 silent narrowings (sub 14→15 accepted
  // terminal, subs 17/18/19→20 passed the gate) rode exactly that hole.
  // A dropped file is now either an explicit snapshot.droppedFiles
  // disposition or a failed submission routed back to the author.
  'development.implementation.author.v3',
  [{
    providerId: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST,
    repairTargetRoleOnFailure: 'author',
    repairTargetRoleOnIndeterminate: 'author',
    // Desync firewall: this check reads an implementation-result payload and
    // its Git diff. If the cell's product contract ever changes shape (e.g.
    // a managed textual candidate), module install must fail here instead of
    // the gate rejecting every submission live.
    expectedSubjectSchemaRef: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
    subjectScope: 'cell-product',
  }, {
    providerId: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_IMPLEMENTATION_CLAIM_MONOTONICITY_CHECK_PROVIDER_DIGEST,
    repairTargetRoleOnFailure: 'author',
    expectedSubjectSchemaRef: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
    subjectScope: 'cell-product',
  }],
);
const IMPLEMENTATION_FINAL_PLAN = buildCheckPlan(
  'development.implementation.final',
  [{
    providerId: REVIEW_VERDICT_CHECK_PROVIDER_ID,
    version: REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
    providerDigest: REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
    parameters: { verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA },
    repairTargetRoleOnFailure: 'author',
    repairTargetRoleOnIndeterminate: 'reviewer',
    expectedSubjectSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
    subjectScope: 'cell-product',
  }],
);
const VERIFICATION_FINAL_PLAN = buildCheckPlan(
  'development.verification.final.v4',
  [{
    providerId: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
    repairTargetRoleOnIndeterminate: 'author',
  }],
);
const READINESS_CERTIFICATION_PLAN = buildCheckPlan(
  // v2 — CERTIFICATION-GAMING-REMEDY step 2: the monotonicity ratchet
  // provider joins the plan BEFORE the runnability provider, so a narrowed or
  // changed readiness declaration escalates (human_required) even when the
  // narrowed command itself would pass.
  // v3 — CC-GAP-9 / ADR-089: the runnability entry's indeterminate outcomes
  // (the typed unknown `warrant-blocked-environment` emitted after the
  // bounded in-check substrate retry is exhausted) route human_required —
  // the cell's humanRequiredTransition (complete-blocked, a truthful typed
  // wait with a wake source) — instead of author repair. A substrate
  // condition alone never produces a failed verdict; deterministic product
  // failures keep failureOwnership:'upstream' → gate verdict 'failed'. The
  // cell's failed transition routes that verdict through settle-development
  // (CC-GAP-8: the criterion ledger is already open, so only the settlement
  // seam may terminalize the run), where the X3 failed-receipt read settles
  // blocked / candidate-missing / local-readiness-failed — the
  // continuation-acceptable certificate that re-routes the producer defect
  // to the producing workshop.
  'development.readiness-certification.final.v3',
  [{
    providerId: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_DIGEST,
    // M1-a / D2: a narrowed or changed declaration on the same
    // sourceCandidate is NOT a gate failure (the worker submitted nothing
    // malformed) — it is an ESCALATION. 'unknown' + fail-closed +
    // human-required disposition reduces to a human_required verdict, which
    // the cell routes through its humanRequiredTransition (complete-blocked).
    // Escalation-only by construction: this entry never softens the
    // runnability check below it.
    indeterminateDisposition: 'human-required',
    expectedSubjectSchemaRef: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    subjectScope: 'cell-product',
  }, {
    providerId: LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
    version: LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
    providerDigest: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    // The runnability subject resolves (LR-01) to the FROZEN integrated
    // release candidate produced upstream — not this verifier's own probe.
    // A deterministic failure is a producer defect: escalate to 'failed'
    // (continuation re-routes the defect to the producing workshop) instead
    // of burning this workplace's repair budget on probe rewrites that
    // cannot fix the product.
    //
    // SEAM L2 (c) restore: bb968ecf dropped this flag while keeping the
    // comment, so a failed runnability check repair-looped the CERTIFIER
    // (who can only rewrite the manifest, never the frozen candidate) and
    // the typed seam repair-issue never reached the producing task. The
    // upstream flag is what routes the seam defect through the existing
    // escalation → continuation → producing-workshop path.
    failureOwnership: 'upstream',
    expectedSubjectSchemaRef: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    subjectScope: 'cell-product',
    // CC-GAP-9 / ADR-089: this provider's indeterminate outcome is exactly
    // the typed unknown `warrant-blocked-environment` — an exhausted
    // in-check substrate retry (docker daemon down / not linux; frozen
    // bound + schedule inside the check; no model, no WorkerExecution, no
    // CandidateSet, no repair budget). A missing environment precondition
    // is NOT a worker defect: an author repair round would charge the
    // worker repair budget for a machine fault (§15 budgets charge spin,
    // not work) and no product defect exists to remove. 'unknown' +
    // fail-closed + human-required disposition reduces to a human_required
    // verdict → complete-blocked (resumable: after the substrate recovers,
    // the same criterion executes again under current authority, and the
    // earlier unknown receipt never poisons the later pass).
    indeterminateDisposition: 'human-required',
  }],
);

export const developmentProcessModule: ProcessModuleDefinition = {
  identity: {
    ...DEVELOPMENT_PROCESS_MODULE_REF,
    kind: 'development',
    displayName: 'Solution Development',
    description:
      'Plans, implements, reviews, integrates, freezes and verifies one exact release candidate.',
  },
  inputContract: { id: DEVELOPMENT_CASE_SCHEMA },
  outputContract: { id: VERIFIED_INTEGRATION_BUNDLE_SCHEMA },
  outcomes: [
    { code: 'verified', description: 'All required implementation and acceptance evidence binds to the unchanged frozen candidate.', terminal: true },
    { code: 'blocked', description: 'Required work, trusted evidence, integration state or a human decision is unavailable.', terminal: true },
    { code: 'failed', description: 'Development infrastructure or immutable lineage validation failed.', terminal: true },
  ],
  flow: {
    id: 'factory.development.standard',
    version: '2.1.0',
    entryNodeId: 'plan-task-graph',
    nodes: [
      {
        id: 'plan-task-graph',
        label: 'Plan Task Graph',
        kind: 'production-cell',
        description:
          'Produce one typed implementation/integration/verification graph; the cell gate validates exact lineage, coverage and DAG semantics before acceptance.',
        inputSchema: { id: DEVELOPMENT_CASE_SCHEMA },
        outputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
        cellDefinition: singletonProductionCell({
          id: 'development-plan-task-graph',
          executionProfileId: 'development-task-graph-planner',
          outputSchemaRef: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
          payloadContract: {
            contractId: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_ID,
            version: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_VERSION,
            contractDigest: DEVELOPMENT_TASK_GRAPH_PAYLOAD_CONTRACT_DIGEST,
          },
          cardinality: '1',
          maxAttempts: 3,
          onExhausted: 'requeue',
          checkPlan: PLANNER_CHECK_PLAN,
          acceptedTransition: 'resolve-task-graph',
          failedTransition: 'complete-failed',
          humanRequiredTransition: 'complete-blocked',
        }),
      },
      {
        id: 'resolve-task-graph',
        label: 'Freeze Task Graph',
        kind: 'kernel',
        description:
          'Canonicalize the already gate-accepted task-graph proposal and materialize its projected work idempotently.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
        outputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
      },
      {
        id: 'implement-work-items',
        label: 'Implement and Review Work Items',
        kind: 'production-cell',
        description:
          'Fan out validated implementation items through the universal Workplace author/review/gate/repair loop.',
        cellDefinition: {
          id: 'development-implementation',
          inputSelectors: ['resolve-task-graph.items'],
          materialization: {
            sourceBinding: 'resolve-task-graph',
            workKeySelector: 'items',
            dependencySelector: 'dependsOnKeys',
            completionPolicy: 'all',
            taskProvenance: { sourceArtifactIdsSelector: 'sourceArtifactIds' },
          },
          author: {
            skillRef: 'development-implementation-worker',
            capabilityPreset: 'sandbox-code-author',
          },
          productContracts: [{
            binding: 'implementationResult',
            schemaRef: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
            mediaType: 'application/json',
            cardinality: '1',
            payloadContract: {
              contractId: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
              version: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
              contractDigest: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST,
            },
          }],
          authorGate: {
            gateId: 'development-implementation-author',
            gatePhase: 'author',
            checkPlan: IMPLEMENTATION_AUTHOR_PLAN,
          },
          review: {
            reviewer: {
              skillRef: 'development-implementation-reviewer',
              capabilityPreset: 'sandbox-code-reviewer',
            },
            verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
            payloadContract: {
              contractId: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
              version: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
              contractDigest: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
            },
            finalGate: {
              gateId: 'development-implementation-final',
              gatePhase: 'final',
              checkPlan: IMPLEMENTATION_FINAL_PLAN,
            },
          },
          recovery: { maxAttempts: 3, onExhausted: 'requeue' },
          postAcceptanceEffect: 'git-integration',
          transitions: {
            accepted: 'freeze-integrated-candidate',
            humanRequired: 'complete-blocked',
            // CC-GAP-8 terminal accounting: the graph (and therefore the
            // criterion-key ledger) is already materialized when this cell
            // runs, so its terminal failure MUST route through settlement —
            // the only seam that appends the terminal-route facts. Settlement
            // reconstructs the workset from accepted cell products and settles
            // blocked/implementation-incomplete (required work unavailable),
            // which the continuation boundary accepts.
            failed: 'settle-development',
          },
        },
      },
      {
        id: 'freeze-integrated-candidate',
        label: 'Freeze Integrated Candidate',
        kind: 'kernel',
        description:
          'Observe the declared integration branches and persist one immutable content-addressed candidate after all accepted implementation results are merged.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.freezeIntegratedCandidate,
        inputSchema: { id: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA },
        outputSchema: { id: INTEGRATED_SOURCE_CANDIDATE_SCHEMA },
      },
      {
        id: 'certify-product-readiness',
        label: 'Certify Product Readiness',
        kind: 'production-cell',
        description: 'Declare and execute one candidate-wide run contract against the exact integrated source.',
        inputSchema: { id: INTEGRATED_SOURCE_CANDIDATE_SCHEMA },
        outputSchema: { id: DEVELOPMENT_READINESS_MANIFEST_SCHEMA },
        cellDefinition: singletonProductionCell({
          id: 'development-readiness-certification',
          executionProfileId: 'development-readiness-certifier',
          outputSchemaRef: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
          payloadContract: {
            contractId: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_ID,
            version: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION,
            contractDigest: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DIGEST,
          },
          cardinality: '1',
          maxAttempts: 3,
          onExhausted: 'requeue',
          checkPlan: READINESS_CERTIFICATION_PLAN,
          acceptedTransition: 'bind-runnable-candidate',
          // CC-GAP-8 terminal accounting: the ledger is open when this cell
          // runs, so a terminal failure routes through settlement — never a
          // bare outcome emitter. Settlement's X3 seam reads the FAILED
          // local-runnability receipt run-wide and settles blocked /
          // candidate-missing / local-readiness-failed with the decoded
          // producer-defect text — the durable certificate the continuation
          // reads to re-route the defect to the producing workshop.
          failedTransition: 'settle-development',
          humanRequiredTransition: 'complete-blocked',
        }),
      },
      {
        id: 'bind-runnable-candidate',
        label: 'Bind Runnable Candidate',
        kind: 'kernel',
        description: 'Bind the exact accepted readiness manifest and deterministic receipt to the frozen source.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.bindRunnableCandidate,
        inputSchema: { id: DEVELOPMENT_READINESS_MANIFEST_SCHEMA },
        outputSchema: { id: INTEGRATED_CANDIDATE_SCHEMA },
      },
      {
        id: 'verify-acceptance',
        label: 'Verify Acceptance Criteria',
        kind: 'production-cell',
        description:
          'Fan out independent acceptance verification over the exact frozen candidate.',
        cellDefinition: {
          id: 'development-verification',
          inputSelectors: [
            'resolve-task-graph.verificationItems',
            'bind-runnable-candidate.candidate',
          ],
          materialization: {
            sourceBinding: 'resolve-task-graph',
            workKeySelector: 'verificationItems',
            completionPolicy: 'all',
            taskProvenance: {
              sourceArtifactIdsSelector: 'sourceArtifactIds',
              verificationTargetArtifactIdSelector: 'sourceArtifactIds',
            },
          },
          author: {
            skillRef: 'development-verification-worker',
            capabilityPreset: 'sandbox-verifier',
          },
          productContracts: [{
            binding: 'verificationEvidence',
            schemaRef: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
            mediaType: 'application/json',
            cardinality: '1',
            payloadContract: {
              contractId: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID,
              version: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION,
              contractDigest: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DIGEST,
            },
          }],
          authorGate: {
            gateId: 'development-verification-final',
            gatePhase: 'final',
            checkPlan: VERIFICATION_FINAL_PLAN,
          },
          recovery: { maxAttempts: 2, onExhausted: 'requeue' },
          transitions: {
            accepted: 'settle-development',
            humanRequired: 'complete-blocked',
            // See the flow transition comment: a failed verification verdict
            // is routed through settlement for an explicit completion and a
            // continuation-acceptable terminal outcome (blocked/rework).
            failed: 'settle-development',
          },
        },
      },
      {
        id: 'settle-development',
        label: 'Settle Development',
        kind: 'kernel',
        description:
          'Re-read exact accepted Cell products and the frozen candidate, then issue the deterministic Development certificate.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settle,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
        outputSchema: { id: DEVELOPMENT_CERTIFICATE_SCHEMA },
      },
      ...['verified', 'blocked', 'failed']
        .map(code => ({
          id: `complete-${code}`,
          label: `Complete: ${code}`,
          kind: 'kernel' as const,
          description: `Emit the local Development process outcome '${code}'.`,
          handler: 'process-outcome-emitter',
          emitsOutcome: code,
        })),
    ],
    transitions: [
      { from: 'plan-task-graph', to: 'resolve-task-graph', on: 'domain.accepted' },
      { from: 'plan-task-graph', to: 'complete-failed', on: 'domain.failed' },
      { from: 'resolve-task-graph', to: 'implement-work-items', on: 'domain.valid' },
      { from: 'resolve-task-graph', to: 'settle-development', on: 'domain.failed' },
      { from: 'implement-work-items', to: 'freeze-integrated-candidate', on: 'domain.accepted' },
      // CC-GAP-8 terminal accounting (review counterexample repair): the
      // criterion-key ledger opened at resolve-task-graph, so this post-ledger
      // cell failure may NOT exit through the bare complete-failed emitter —
      // that left every unexecuted obligation a forever-pending row with no
      // terminal fact. Route through settlement like every other failed node:
      // it settles blocked/implementation-incomplete, records the terminal
      // facts with the certificate as provenance, and leaves a
      // continuation-acceptable boundary.
      { from: 'implement-work-items', to: 'settle-development', on: 'domain.failed' },
      { from: 'freeze-integrated-candidate', to: 'certify-product-readiness', on: 'domain.frozen' },
      { from: 'freeze-integrated-candidate', to: 'settle-development', on: 'domain.failed' },
      { from: 'certify-product-readiness', to: 'bind-runnable-candidate', on: 'domain.accepted' },
      // CC-GAP-8 terminal accounting (review counterexample repair): same
      // seam discipline as implement-work-items above. The failed verdict is
      // unchanged at the gate (failureOwnership 'upstream'); only the FLOW
      // target changes — settlement, not the bare emitter — so the X3 failed
      // readiness receipt becomes a blocked / candidate-missing /
      // local-readiness-failed certificate and the ledger gets its terminal
      // facts instead of unexplained pending rows.
      { from: 'certify-product-readiness', to: 'settle-development', on: 'domain.failed' },
      { from: 'bind-runnable-candidate', to: 'verify-acceptance', on: 'domain.bound' },
      { from: 'bind-runnable-candidate', to: 'settle-development', on: 'domain.failed' },
      { from: 'verify-acceptance', to: 'settle-development', on: 'domain.accepted' },
      // Upstream-defect escalation: a failed verification verdict refuted the
      // FROZEN integrated candidate (failureOwnership:'upstream'). Route the
      // failure through the settlement kernel — exactly like every other
      // failed-node transition in this flow (post-ledger cell failures
      // included; see the implement-work-items / certify-product-readiness
      // edges above) — so it issues an explicit ModuleCompletion and a
      // terminal conveyor outcome the Development continuation service
      // accepts (blocked on missing verification evidence, rework-required on
      // failed evidence).
      { from: 'verify-acceptance', to: 'settle-development', on: 'domain.failed' },
      ...['verified', 'blocked', 'failed']
        .map(code => ({
          from: 'settle-development',
          to: `complete-${code}`,
          on: `domain.${code}`,
        })),
    ],
    terminalNodeIds: [
      'complete-verified', 'complete-blocked', 'complete-failed',
    ],
  },
  artifacts: [
    { type: 'development-case', schema: { id: DEVELOPMENT_CASE_SCHEMA }, authority: 'kernel', description: 'Immutable Development input.' },
    { type: 'development-task-graph-proposal', schema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA }, authority: 'worker', description: 'Typed planner product inspected inside its Production Cell.' },
    { type: 'development-task-graph', schema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA }, authority: 'kernel', description: 'Canonical coverage-complete acyclic work graph.' },
    { type: 'development-implementation-workset', schema: { id: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA }, authority: 'kernel', description: 'Accepted implementation/review products reconstructed from Cell CandidateSets.' },
    { type: 'integrated-release-candidate', schema: { id: INTEGRATED_CANDIDATE_SCHEMA }, authority: 'kernel', description: 'Frozen integrated repository/build target.' },
    { type: 'integrated-source-candidate', schema: { id: INTEGRATED_SOURCE_CANDIDATE_SCHEMA }, authority: 'kernel', description: 'Exact integrated source before run certification.' },
    { type: 'development-readiness-manifest', schema: { id: DEVELOPMENT_READINESS_MANIFEST_SCHEMA }, authority: 'worker', description: 'Candidate-wide run contract checked against the exact source.' },
    { type: 'acceptance-verification-workset', schema: { id: ACCEPTANCE_VERIFICATION_SCHEMA }, authority: 'kernel', description: 'Independent verification evidence bound to the frozen candidate.' },
    { type: 'verified-integration-bundle', schema: { id: VERIFIED_INTEGRATION_BUNDLE_SCHEMA }, authority: 'kernel', description: 'Canonical Development output for Delivery.' },
    { type: 'development-certificate', schema: { id: DEVELOPMENT_CERTIFICATE_SCHEMA }, authority: 'kernel', description: 'Immutable Development settlement decision.' },
  ],
  policies: [
    { id: 'development-task-graph-validation', version: '2.0.0', handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph, description: 'Cell gate validates the proposal; kernel canonicalizes and materializes the accepted graph.' },
    { id: 'development-settlement', version: '1.0.0', handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settle, description: 'Admits only a complete workset with trusted evidence for the unchanged frozen candidate.' },
    { id: 'development-candidate-freeze', version: '1.0.0', handler: DEVELOPMENT_KERNEL_HANDLER_IDS.freezeIntegratedCandidate, description: 'Seals merged repository heads before verification.' },
  ],
  invariants: [
    { id: 'development.planner-cell-gates-graph', description: 'Task-graph semantics are accepted or repaired inside the planner Production Cell before kernel materialization.', enforcement: 'runtime' },
    { id: 'development.review-before-integration', description: 'Only the exact source commit accepted by the implementation Cell may enter integration.', enforcement: 'policy' },
    { id: 'development.integrate-before-verification', description: 'Integration completes and one candidate freezes before verification starts.', enforcement: 'runtime' },
    { id: 'development.evidence-pins-candidate', description: 'Every acceptance record pins the accepted AC hash and frozen candidate hash.', enforcement: 'policy' },
    { id: 'development.no-post-verification-mutation', description: 'Candidate drift invalidates prior evidence.', enforcement: 'policy' },
    { id: 'development.unknown-denies', description: 'Unknown/error verification never authorizes a verified bundle.', enforcement: 'policy' },
    { id: 'development.exact-lineage', description: 'All cells and kernels consume exact immutable refs/hashes.', enforcement: 'test' },
    { id: 'development.module-does-not-route', description: 'Development emits only local outcomes; lifecycle routing is external.', enforcement: 'static' },
  ],
  executionProfiles: [
    {
      id: 'development-task-graph-planner',
      workIntentKind: 'development.plan-task-graph',
      workIntentSchema: { id: 'factory.work-intent.development-task-graph.v1' },
      taskKind: 'planning.decomposition',
      executionSkill: 'saga-planner',
      reviewSkill: 'saga-planning-reviewer',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-planner',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: [
        ...COMMON_READ_TOOLS,
        'conflict_check', 'product_submit', 'worker_done',
        'Write', 'Edit', 'Bash',
      ],
      trackerTemplate: DEVELOPMENT_TRACKER,
      workspaceTemplates: [DEVELOPMENT_SUBMISSION_CALL, DEVELOPMENT_CHECKLIST],
      callTemplates: [DEVELOPMENT_SUBMISSION_CALL],
      checklists: [DEVELOPMENT_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
      retryPolicy: { maxAttempts: 3, retryOn: ['schema-rejected', 'lineage-gap'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'development-implementation-worker',
      workIntentKind: 'development.implementation',
      workIntentSchema: { id: 'factory.work-intent.development-implementation.v1' },
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-worker',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'git_change',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [IMPLEMENTATION_CHECKLIST],
      callTemplates: [],
      checklists: [IMPLEMENTATION_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA },
      retryPolicy: { maxAttempts: 3, retryOn: ['review-rejected', 'merge-conflict'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'development-implementation-reviewer',
      workIntentKind: 'development.implementation-review',
      workIntentSchema: { id: 'factory.work-intent.development-implementation-review.v1' },
      taskKind: 'development.code.review',
      executionSkill: 'saga-development-code-reviewer',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-development-code-reviewer',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [IMPLEMENTATION_CHECKLIST],
      callTemplates: [],
      checklists: [IMPLEMENTATION_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_REVIEW_VERDICT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['review-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'development-readiness-certifier',
      workIntentKind: 'development.readiness-certification',
      workIntentSchema: { id: 'factory.work-intent.development-readiness-certification.v1' },
      taskKind: 'development.readiness',
      executionSkill: 'saga-readiness-certifier',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-readiness-certifier',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [READINESS_CHECKLIST],
      callTemplates: [],
      checklists: [READINESS_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_READINESS_MANIFEST_SCHEMA },
      retryPolicy: { maxAttempts: 3, retryOn: ['evidence-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'development-verification-worker',
      workIntentKind: 'development.verification',
      workIntentSchema: { id: 'factory.work-intent.development-verification.v1' },
      taskKind: 'verification.ac',
      executionSkill: 'saga-worker',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-worker',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [IMPLEMENTATION_CHECKLIST],
      callTemplates: [],
      checklists: [IMPLEMENTATION_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['evidence-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
  ],
};
