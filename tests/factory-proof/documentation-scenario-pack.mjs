// tests/factory-proof/documentation-scenario-pack.mjs
//
// Documentation (PDF docs) workshop pack for the unified Saga conformance
// kernel — admission artifact per ADR-085 / authoring guide §19.
//
// The pack owns only deterministic cognition stimuli, independent oracles and
// coverage declarations. All Workplace/CandidateSet/Gate/review/render/
// settlement/routing authority remains in the production Factory — there is
// NO documentation-specific runner (the drive composes runScenario(), the
// same kernel every other workshop drives through).
//
// Engine honesty (2026-08-24 port): the PDF render engine (pdfkit +
// dejavu-fonts-ttf) is an OPTIONAL dependency that is NOT installed in the
// shared node_modules tree. The `documentation/missing-engine-blocked`
// scenario is therefore the scenario drivable TODAY: the render kernel
// probes the provider, finds the engine absent and settles the HONEST typed
// `blocked` outcome (module invariant documentation.missing-engine-blocks).
// The `documentation/happy-documented` spine becomes drivable the moment
// the orchestrator admits the render dependencies; its coverage tokens stay
// declared (never silently dropped from the universe).

import Database from 'better-sqlite3';
import nodeCrypto from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';
import {
  buildScenarioCoverageMatrix,
  coverageToken,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';

export const DOCUMENTATION_STAGE = 'documentation-release';
export const DEVELOPMENT_STAGE = 'solution-development';
export const DOCUMENTATION_DOCUMENT_SCHEMA = 'factory.documentation-document.v1';
export const DOCUMENTATION_REVIEW_VERDICT_SCHEMA = 'factory.documentation-review-verdict.v1';
export const DOCUMENTATION_COMPLETENESS_PROVIDER = 'factory.documentation-completeness.v1';
export const DEFAULT_DOCUMENTATION_KINDS = ['user-manual', 'programmer-manual', 'acceptance-report'];

// Mirrors the module definition (documentation-process-module.ts). The
// inventory and the coverage universe read this — no second hand-list of
// nodes exists outside the module declaration and this projection.
export const DOCUMENTATION_TOPOLOGY = Object.freeze({
  nodes: Object.freeze([
    'assemble-documentation-case',
    'author-documents',
    'render-documentation-bundle',
    'settle-documentation',
    'complete-documented',
    'complete-blocked',
    'complete-failed',
  ]),
  outcomes: Object.freeze(['documented', 'blocked', 'failed']),
  executionProfiles: Object.freeze(['documentation-writer', 'documentation-reviewer']),
});

function withDocumentationHandlers() {
  return Object.freeze({
    ...W9_HAPPY_HANDLERS,
    // Fan-out authoring: every workKey (one per document kind) submits ONE
    // structured documentation document with ALL sections the kind's
    // completeness contract requires — through the production product_submit
    // intake, never a test-side authority.
    'documentation-release@1.0.0/author-documents/author/*': function documentationAuthor({ handlers, assignment, meta }) {
      const brief = meta.cell_input_item
        ?? (meta.process_node_input?.documents ?? []).find(
          item => String(item.id) === String(meta.work_key),
        )
        ?? null;
      if (!brief || !brief.kind || !Array.isArray(brief.requiredSections)) {
        throw new Error(`documentation brief not found for work key ${meta.work_key}`);
      }
      handlers.product_submit({
        schema: DOCUMENTATION_DOCUMENT_SCHEMA,
        content: {
          schemaVersion: DOCUMENTATION_DOCUMENT_SCHEMA,
          documentKind: brief.kind,
          title: String(brief.kindTitle ?? brief.kind),
          locale: 'ru',
          sections: brief.requiredSections.map(sectionId => ({
            id: sectionId,
            heading: `Раздел ${sectionId}`,
            blocks: [
              { type: 'paragraph', text: `Детерминированное содержимое раздела ${sectionId} для ${brief.kind}.` },
            ],
          })),
          generatedFor: {
            candidateHash: String(brief.candidateHash),
            productSubject: String(brief.productSubject ?? 'fresh-harness product'),
          },
        },
      });
      handlers.worker_done({
        task_id: Number(assignment.taskId),
        worker_id: assignment.workerId,
        execution_id: assignment.workerExecutionId,
        result: `authored documentation document ${brief.kind}`,
      });
      return { kind: 'worker-done-accepted' };
    },
    // Reviewer: binds the verdict to the EXACT author CandidateSet (the
    // production candidate_read authority), one concrete finding as the
    // payload contract requires (findings is non-empty).
    'documentation-release@1.0.0/author-documents/reviewer/*': function documentationApprovedReview({ handlers, assignment, meta }) {
      const workplaceRef = meta.workplace_ref ?? meta.workplaceRef;
      if (!workplaceRef) throw new Error('reviewer task has no workplace_ref');
      const cand = handlers.candidate_read({ workplace_ref: workplaceRef, role: 'author' });
      handlers.product_submit({
        schema: DOCUMENTATION_REVIEW_VERDICT_SCHEMA,
        content: {
          subject_candidate_set_ref: cand.candidate_set_ref,
          verdict: 'approved',
          findings: [{ message: 'Все обязательные разделы присутствуют и содержательны.' }],
        },
      });
      handlers.worker_done({
        task_id: Number(assignment.taskId),
        worker_id: assignment.workerId,
        execution_id: assignment.workerExecutionId,
        result: 'review: approved',
      });
      return { kind: 'worker-done-accepted' };
    },
  });
}

// ---------------------------------------------------------------------------
// Independent oracles (read-only durable-trace assertions).
// ---------------------------------------------------------------------------

function terminalOracle(expectedStatus) {
  return {
    id: `documentation.terminal.${expectedStatus}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.lifecycleRuns ?? [])
        .filter(row => row.status === 'completed' && row.terminal_status === expectedStatus);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `lifecycle-run:${row.id}`),
        details: { expectedStatus, count: rows.length },
      };
    },
  };
}

function stageOutcomeOracle(expectedOutcome) {
  return {
    id: `documentation.stage-outcome.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? [])
        .filter(row => row.stage_id === DOCUMENTATION_STAGE && row.local_outcome === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `stage-run:${row.id}`),
        details: { expectedOutcome, count: rows.length },
      };
    },
  };
}

function gateOracle(id, gatePhase, verdict, minCount) {
  return {
    id,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.gateDecisions ?? [])
        .filter(row => String(row.workplace_ref).includes('documentation-authoring')
          && row.gate_phase === gatePhase
          && row.verdict === verdict);
      return {
        passed: rows.length >= minCount,
        evidenceRefs: rows.map(row => String(row.decision_key)),
        details: { gatePhase, verdict, count: rows.length, minCount },
      };
    },
  };
}

function checkReceiptOracle(id, providerId, outcome, minCount) {
  return {
    id,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.checkReceipts ?? [])
        .filter(row => row.provider_id === providerId && row.outcome === outcome);
      return {
        passed: rows.length >= minCount,
        evidenceRefs: rows.map(row => String(row.check_receipt_ref)),
        details: { providerId, outcome, count: rows.length, minCount },
      };
    },
  };
}

function certificateOracle(expectedDecision, reasonCode) {
  return {
    id: `documentation.certificate.${expectedDecision}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.processOutcomeCertificates ?? [])
        .filter(row => String(row.module_ref_key).includes('documentation')
          && row.decision === expectedDecision);
      const reasonsOk = reasonCode
        ? rows.some(row => String(row.reason_codes ?? '').includes(reasonCode))
        : true;
      return {
        passed: rows.length > 0 && reasonsOk,
        evidenceRefs: rows.map(row => `process-certificate:${row.id}`),
        details: { expectedDecision, count: rows.length, reasonCode, reasonsOk },
      };
    },
  };
}

// The exact Development → Documentation handoff: the documentation StageRun
// input snapshot must carry the frozen candidate hash, the repository
// snapshots and the documentation profile — through the REAL lifecycle
// resolver (this exercises the canonical bundle-payload mapping paths).
function exactHandoffOracle() {
  return {
    id: 'documentation.handoff-exact.verified',
    evaluate({ durableTrace }) {
      const development = (durableTrace.stageRuns ?? [])
        .find(row => row.stage_id === DEVELOPMENT_STAGE && row.local_outcome === 'verified');
      if (!development) return { passed: false, details: { reason: 'development verified stage missing' } };
      const transition = (durableTrace.processTransitions ?? [])
        .find(row => row.from_stage_run_id === development.id
          && row.outcome === 'verified'
          && row.target_type === 'stage'
          && row.target_stage_id === DOCUMENTATION_STAGE);
      if (!transition) {
        return { passed: false, details: { reason: 'verified → documentation-release transition missing' } };
      }
      const documentation = (durableTrace.stageRuns ?? [])
        .find(row => row.id === transition.to_stage_run_id && row.stage_id === DOCUMENTATION_STAGE);
      if (!documentation) {
        return { passed: false, details: { reason: 'documentation stage run missing' } };
      }
      let input;
      try {
        input = JSON.parse(documentation.input_snapshot ?? '{}');
      } catch {
        return { passed: false, details: { reason: 'documentation input snapshot not parseable' } };
      }
      const checks = {
        integratedCandidateHash: typeof input.integratedCandidateHash === 'string'
          && input.integratedCandidateHash.length > 0,
        candidateRepositories: Array.isArray(input.candidateRepositories)
          && input.candidateRepositories.length > 0
          && typeof input.candidateRepositories[0]?.commitSha === 'string',
        documentKinds: Array.isArray(input.documentKinds)
          && input.documentKinds.length === DEFAULT_DOCUMENTATION_KINDS.length,
        outputRoot: typeof input.outputRoot === 'string' && input.outputRoot.length > 0,
        developmentCertificate: typeof input.developmentCertificate?.hash === 'string',
        srs: 'srs' in input,
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      return {
        passed: failed.length === 0,
        evidenceRefs: [
          `stage-run:${development.id}`,
          `lifecycle-transition:${transition.id}`,
          `stage-run:${documentation.id}`,
        ],
        details: { failed, handoffHash: transition.handoff_hash },
      };
    },
  };
}

// Blocked spine: NO bundle may exist — the render kernel typed-blocked before
// any durable output (honest boundary, never a degraded release).
function zeroBundlesOracle() {
  return {
    id: 'documentation.blocked.zero-bundles',
    evaluate({ bootstrap }) {
      const db = new Database(bootstrap.dbPath, { readonly: true });
      try {
        let count = 0;
        try {
          count = db.prepare('SELECT COUNT(*) AS n FROM factory_documentation_bundles').get().n;
        } catch {
          count = 0; // table never created — no bundle, still the honest state
        }
        return { passed: count === 0, evidenceRefs: [], details: { bundles: count } };
      } finally {
        db.close();
      }
    },
  };
}

// Happy spine: the render kernel REALLY rendered. The persisted bundle row
// (factory_documentation_bundles) carries per-document receipts — each PDF
// must exist on disk in the bundle's own outputRoot, be non-empty, start
// with the %PDF magic and hash to EXACTLY the receipt's pdfByteHash/size.
function renderedPdfsOracle() {
  return {
    id: 'documentation.documented.rendered-pdfs-on-disk',
    evaluate({ bootstrap }) {
      const db = new Database(bootstrap.dbPath, { readonly: true });
      try {
        const rows = db.prepare(
          'SELECT payload_snapshot FROM factory_documentation_bundles',
        ).all();
        if (rows.length !== 1) {
          return { passed: false, evidenceRefs: [], details: { bundles: rows.length } };
        }
        const bundle = JSON.parse(rows[0].payload_snapshot);
        const failures = [];
        const evidenceRefs = [];
        const { createHash } = nodeCrypto;
        for (const doc of bundle.documents ?? []) {
          const posixFile = path.posix.join(
            String(bundle.outputRoot ?? '').replaceAll('\\', '/'),
            String(doc.pdfFileName ?? ''),
          );
          const native = path.join(...posixFile.split('/'));
          let bytes = null;
          try {
            bytes = nodeFs.readFileSync(native);
          } catch {
            failures.push(`${doc.kind}: file unreadable ${native}`);
            continue;
          }
          const magicOk = bytes.subarray(0, 5).toString('latin1') === '%PDF-';
          const sizeOk = bytes.byteLength === doc.pdfByteSize;
          const hashOk = createHash('sha256').update(bytes).digest('hex') === doc.pdfByteHash;
          const rendererOk = doc.renderer?.id === 'factory.documentation.render.pdfkit';
          if (!magicOk || !sizeOk || !hashOk || !rendererOk || bytes.byteLength === 0) {
            failures.push(`${doc.kind}: {magic:${magicOk}, size:${sizeOk}, hash:${hashOk}, renderer:${rendererOk}, bytes:${bytes.byteLength}}`);
          }
          evidenceRefs.push(`pdf:${doc.kind}:${doc.pdfByteHash.slice(0, 16)}`);
        }
        const kindsOk = (bundle.documents ?? []).length === DEFAULT_DOCUMENTATION_KINDS.length;
        if (!kindsOk) failures.push(`expected ${DEFAULT_DOCUMENTATION_KINDS.length} documents, got ${(bundle.documents ?? []).length}`);
        return {
          passed: failures.length === 0,
          evidenceRefs,
          details: {
            outputRoot: bundle.outputRoot,
            documents: (bundle.documents ?? []).map(d => ({ kind: d.kind, pdfByteSize: d.pdfByteSize })),
            failures,
          },
        };
      } finally {
        db.close();
      }
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

// ---------------------------------------------------------------------------
// Scenarios (declarative DSL).
// ---------------------------------------------------------------------------

const blockedSpineCoverage = [
  coverageToken.gate('documentation-document-author', 'accepted'),
  coverageToken.gate('documentation-document-final', 'accepted'),
  coverageToken.transition('assemble-documentation-case', 'author-documents'),
  coverageToken.transition('author-documents', 'render-documentation-bundle'),
  coverageToken.transition('render-documentation-bundle', 'settle-documentation'),
  coverageToken.transition('settle-documentation', 'complete-blocked'),
  'handoff:solution-development->documentation-release:verified',
  'blocked:documentation:missing-engine-honest-blocked-terminal',
  'binding:documentation-document:exact-submission-digest',
  'sections:documentation-document:per-kind-required-sections',
];

const documentedSpineCoverage = [
  coverageToken.gate('documentation-document-author', 'accepted'),
  coverageToken.gate('documentation-document-final', 'accepted'),
  coverageToken.transition('assemble-documentation-case', 'author-documents'),
  coverageToken.transition('author-documents', 'render-documentation-bundle'),
  coverageToken.transition('render-documentation-bundle', 'settle-documentation'),
  coverageToken.transition('settle-documentation', 'complete-documented'),
  'handoff:solution-development->documentation-release:verified',
  'render:documentation:deterministic-pdf-receipts',
  'bundle:documentation:immutable-workset-receipt',
  'binding:documentation-document:exact-submission-digest',
  'sections:documentation-document:per-kind-required-sections',
];

export const DOCUMENTATION_SCENARIOS = Object.freeze([
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'documentation/missing-engine-blocked',
    kind: 'positive',
    proves: [
      'documentation.missing-engine-blocks',
      'documentation.completeness-contract',
      'handoff.route-lifecycle',
    ],
    coverageItems: blockedSpineCoverage,
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'documentation/happy-documented',
    kind: 'positive',
    proves: [
      'documentation.render-bundle-contract',
      'documentation.completeness-contract',
      'handoff.route-lifecycle',
    ],
    coverageItems: documentedSpineCoverage,
  }),
]);

/**
 * The subset harvestable in the CURRENT environment. `happy-documented`
 * needs the pdfkit render engine (admitted 2026-08-24, 9a8c532f) AND a
 * Cyrillic TTF (dejavu-fonts-ttf, or SAGA_DOCS_FONT — the drive proposes a
 * system font when the package is absent). `missing-engine-blocked` stays
 * harvestable wherever the capability is absent; committed-evidence folding
 * remains the operator harvest + CC-00 K0 re-baselining ceremony (the
 * snapshot is ledger-frozen — tests/factory-proof/k0-baseline.test.mjs).
 */
export const DOCUMENTATION_HARVESTABLE_SCENARIOS = Object.freeze(
  DOCUMENTATION_SCENARIOS.filter(scenario =>
    scenario.id === 'documentation/missing-engine-blocked'
    || scenario.id === 'documentation/happy-documented'),
);

// EXHAUSTIVE by construction: the union of every declared scenario's
// coverageItems (mirrors DELIVERY_REQUIRED_UNIVERSE).
export const DOCUMENTATION_REQUIRED_UNIVERSE = Object.freeze(
  [...new Set(DOCUMENTATION_SCENARIOS.flatMap(scenario => scenario.coverageItems ?? []))].sort(),
);

// The complete target universe is intentionally larger than the declared
// spine. Keeping the gaps explicit prevents a 2-scenario pack from being
// misrepresented as total documentation conformance (same honest pattern as
// DISCOVERY_FULL_COVERAGE_UNIVERSE / DEVELOPMENT_PENDING_UNIVERSE).
export const DOCUMENTATION_PENDING_UNIVERSE = Object.freeze([
  coverageToken.gate('documentation-document-author', 'repair_required'),
  coverageToken.negativeTransition('author-documents', 'render-documentation-bundle'),
  'recovery:documentation-document:exact-feedback-repair',
  'recovery:documentation-document:review-changes-requested-repair',
  'counterfactual:documentation-document:absent-feedback-no-magical-repair',
  'counterfactual:documentation-document:stale-feedback-no-magical-repair',
  'fence:documentation-document:stale-execution-denied',
  'idempotency:documentation-document:duplicate-submit',
  'crash:documentation-document:bounded-recovery',
  'crash:documentation-render:bundle-replay-idempotency',
]);

export const DOCUMENTATION_PLATFORM_FAULT_EDGES = Object.freeze([]);

const byId = new Map(DOCUMENTATION_SCENARIOS.map(scenario => [scenario.id, scenario]));

export function buildDocumentationRuntimeCase(id) {
  const scenario = byId.get(id);
  if (!scenario) {
    throw new Error(
      `DOCUMENTATION_SCENARIO_UNKNOWN: ${id}; known=${[...byId.keys()].join(',')}`,
    );
  }
  switch (id) {
    case 'documentation/missing-engine-blocked':
      return {
        scenario,
        launchMode: 'documentation-input',
        handlers: withDocumentationHandlers(),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('documentation-blocked'),
          stageOutcomeOracle('blocked'),
          gateOracle('documentation.author-gate.accepted', 'author', 'accepted', DEFAULT_DOCUMENTATION_KINDS.length),
          gateOracle('documentation.final-gate.accepted', 'final', 'accepted', DEFAULT_DOCUMENTATION_KINDS.length),
          checkReceiptOracle(
            'documentation.completeness-receipt.passed',
            DOCUMENTATION_COMPLETENESS_PROVIDER,
            'passed',
            DEFAULT_DOCUMENTATION_KINDS.length,
          ),
          certificateOracle('blocked', 'render-not-available'),
          exactHandoffOracle(),
          zeroBundlesOracle(),
          noStrandedExecutionOracle(),
        ],
      };
    case 'documentation/happy-documented':
      return {
        scenario,
        launchMode: 'documentation-input',
        handlers: withDocumentationHandlers(),
        driveOptions: { maxCycles: 420, maxEmptyDispatchStreak: 15 },
        oracles: [
          terminalOracle('runnable-local'),
          stageOutcomeOracle('documented'),
          gateOracle('documentation.author-gate.accepted', 'author', 'accepted', DEFAULT_DOCUMENTATION_KINDS.length),
          gateOracle('documentation.final-gate.accepted', 'final', 'accepted', DEFAULT_DOCUMENTATION_KINDS.length),
          checkReceiptOracle(
            'documentation.completeness-receipt.passed',
            DOCUMENTATION_COMPLETENESS_PROVIDER,
            'passed',
            DEFAULT_DOCUMENTATION_KINDS.length,
          ),
          certificateOracle('documented', null),
          exactHandoffOracle(),
          renderedPdfsOracle(),
          noStrandedExecutionOracle(),
        ],
      };
    default:
      throw new Error(`DOCUMENTATION_SCENARIO_UNMAPPED: ${id}`);
  }
}

export function planDocumentationCoverage() {
  const matrix = buildScenarioCoverageMatrix(DOCUMENTATION_SCENARIOS, {
    requiredItems: DOCUMENTATION_REQUIRED_UNIVERSE,
  });
  return {
    matrix,
    summary: summarizeCoverage(matrix),
    minimalScenarioCover: selectScenarioCover(matrix),
  };
}
