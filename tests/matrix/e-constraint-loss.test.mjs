// tests/matrix/e-constraint-loss.test.mjs
//
// STAGE-16 SPACE E — constraint loss across restatement (defect shape S4).
//
// Thesis (see tests/matrix/README.md): a requirement present upstream can be
// absent downstream with no disposition. The AC-drift remedy (stage-12 wave C,
// the order-constraint register) closed ONE boundary (discovery→formalization).
// This file sweeps ALL boundaries where a worker restates upstream material in
// its own words and asks, per boundary: if a distinctive token travels in the
// upstream material and the restatement omits it, does anything DETECT the
// loss?
//
// Method (brief §SPACE E):
//   E1  the boundaries are enumerated FROM the process-module sources — the
//       cited node lines are re-derived from the files in test 1, so a moved
//       node breaks the citation, not just the comment.
//   E2  a table in-file: boundary → constraint register (or equivalent
//       carrying mechanism) present? → consuming it obligatory? → exactly
//       which wired check covers which loss.
//   E3  every boundary is driven LIVE: the REAL validators/policies/providers
//       from ../../dist (the same code the gates run), fed domain-free
//       fixtures over an in-memory DB façade (the SQL routing mirrors the
//       exact statements the validators issue). Covered boundaries must
//       detect the loss; uncovered boundaries assert the HONEST current
//       behavior (loss passes) and land in the FINDINGS registry — no fake
//       detection (brief §2).
//   E4  the token is the arbitrary string 'CONSTRAINT-ALPHA' — tier-1
//       material. No realistic requirement anywhere.
//   E5  findings registry: boundary, what was fed, what the factory said,
//       file:line of where a detector SHOULD live. Findings, not fixes.
//   E6  the boundary table is printed to the console.
//
// No real LLM. No SQLite. No filesystem writes. Runtime target: < 1 s.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOrderConstraintRegister,
  buildOrderConstraintRegisterV2,
  assertOrderConstraintUnknownsLifted,
} from '../../dist/shared/constraint-register.js';
import { canonicalJson } from '../../dist/shared/canonical-json.js';
import {
  createDiscoveryProductionCellKernelHandlers,
} from '../../dist/modules/discovery/application/discovery-production-cell-installation.js';
import {
  productBuildLifecycle,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST,
} from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';
import {
  createFormalizationProductionCellKernelHandlers,
  FORMALIZATION_KERNEL_HANDLER_IDS,
} from '../../dist/modules/formalization/application/formalization-production-cell-installation.js';
import { resolveFormalizationCaseConstraintRegister } from '../../dist/modules/formalization/domain/formalization-schemas.js';
import { validateDiscoveryProposal } from '../../dist/modules/discovery/domain/discovery-proposal.js';
import { READINESS_DIMENSIONS } from '../../dist/modules/discovery/domain/discovery-readiness-assessment.js';
import { createFormalizationContractValidator } from '../../dist/modules/formalization/application/formalization-contract-validator.js';
import { createAcceptanceContractValidator } from '../../dist/modules/formalization/application/acceptance-contract-validator.js';
import {
  buildContractSnapshot,
  findContractGap,
} from '../../dist/modules/formalization/application/formalization-contract-analysis.js';
import {
  FORMALIZATION_CASE_SCHEMA,
  DEVELOPMENT_CASE_SCHEMA,
} from '../../dist/process-modules/lifecycles/product-delivery-module-contracts.js';
import {
  decodeDevelopmentTaskGraphProposal,
  buildCanonicalDevelopmentTaskGraph,
} from '../../dist/modules/development/domain/development-task-graph.js';
import {
  ReferenceDevelopmentTaskGraphPolicy,
  hashDevelopmentPolicy,
} from '../../dist/modules/development/domain/development-settlement-policy.js';
import {
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import {
  developmentImplementationPayloadContract,
  createDevelopmentVerificationCheckProvider,
  createDevelopmentImplementationScopeCheckProvider,
  createImplementationClaimMonotonicityCheckProvider,
} from '../../dist/modules/development/application/development-check-providers.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const src = relative => readFileSync(join(repoRoot, relative), 'utf8');

/** E4: the tier-1 token. Arbitrary text; nothing downstream may parse it. */
const TOKEN = 'CONSTRAINT-ALPHA';

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const HEX40 = 'a1'.repeat(20);

/** 1-based line number of the first line containing `needle` in `text`. */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  assert.ok(index !== -1, `citation source drifted: '${needle}' not found`);
  return text.slice(0, index).split('\n').length;
}

// ── E1: the boundaries, enumerated from the process modules ─────────────────
//
// Every row cites the node that owns the restatement and where the restated
// material is produced (prompt assembly / payload / card). Test 1 re-derives
// the node line numbers from the files so the citations cannot rot silently.
const DISCOVERY_MODULE = 'src/process-modules/modules/discovery/discovery-process-module.ts';
const FORMALIZATION_MODULE = 'src/process-modules/modules/formalization/formalization-process-module.ts';
const DEVELOPMENT_MODULE = 'src/process-modules/modules/development/development-process-module.ts';
const CARD_EXECUTOR = 'src/process-modules/application/node-executors/production-cell-node-executor.ts';

const BOUNDARIES = [
  {
    id: 'B1',
    boundary: 'order → proposal (Discovery, produce-proposal)',
    upstream: 'the order/initiative prose (tier-1, opaque — factory.discovery-case.v1 carries no typed constraint field)',
    restatement: 'DiscoveryProposalPayload.order_constraints — typed drafts the discovery worker serializes while the order is visible',
    node: `${DISCOVERY_MODULE}:70-88 (node 'produce-proposal'; executionProfile 'discovery-proposal-worker' :163-187)`,
    promptAssembly: 'resources/proposal-call-template.json + skills/saga-discovery-worker/SKILL.md:54-66 (the serialization instruction); drafts validated at src/modules/discovery/domain/discovery-proposal.ts:116-147',
  },
  {
    id: 'B2',
    boundary: 'proposal → PRD/brief (Formalization, define-product-contract)',
    upstream: 'the accepted DiscoveryProposal (its order_constraints became the digest-pinned register at settlement)',
    restatement: 'the brief/PRD artifacts; the register reaction is the brief artifact metadata constraint_dispositions',
    node: `${FORMALIZATION_MODULE}:149-163 (node 'define-product-contract')`,
    promptAssembly: 'resources/artifact-create-call-template.json + formalization-node-checklist.md (authorProfile :301-302); dispositions gate: src/modules/formalization/application/formalization-contract-validator.ts:77-86',
  },
  {
    id: 'B3',
    boundary: 'PRD → AC (Formalization, define-acceptance-contract)',
    upstream: 'the accepted PRD/FR/NFR/UC artifacts',
    restatement: 'AC artifacts: trace_add derived_from edges + metadata covered_constraint_ids',
    node: `${FORMALIZATION_MODULE}:179-193 (node 'define-acceptance-contract')`,
    promptAssembly: 'resources/trace-add-call-template.json; validator: src/modules/formalization/application/acceptance-contract-validator.ts:168-223; reverse orphan check (UNWIRED — finding E-F2): src/modules/formalization/application/formalization-contract-analysis.ts:211-239',
  },
  {
    id: 'B4',
    boundary: 'AC → task graph (Development, plan-task-graph)',
    upstream: 'the frozen acceptance baseline / DevelopmentCase.acceptanceCriteria',
    restatement: 'the typed task-graph proposal (acceptanceCriterionIds per item; constraint relay is kernel-derived, never proposed)',
    node: `${DEVELOPMENT_MODULE}:242-276 (node 'plan-task-graph')`,
    promptAssembly: 'machine-filled card: src/modules/development/application/development-workspace-preparation.ts:78-124; gate semantics: src/modules/development/domain/development-settlement-policy.ts:250-589; relay derivation: src/modules/development/domain/development-task-graph.ts:221-253',
  },
  {
    id: 'B5',
    boundary: 'task graph → workplace cards (Development, implement-work-items / verify-acceptance)',
    upstream: 'the canonical task graph item (cell_input_item: key, acceptanceCriterionIds, changeScopes, coveredConstraintIds)',
    restatement: 'the implementation result product (workItemKey + git snapshot) and the verification evidence product',
    node: `${DEVELOPMENT_MODULE}:278-383 (node 'implement-work-items'; verification fan-out :384-434)`,
    promptAssembly: `card projection: ${CARD_EXECUTOR}:1744 (cell_input_item: workplace.item) and :1751-1753 (nodeInput = { upstream, item }); implementation scope provider: src/modules/development/application/development-check-providers.ts:717-917; verification echo check: :1089-1112`,
  },
];

// ── E2: the carrying-mechanism table ────────────────────────────────────────
//
// boundary → register (or equivalent) present? → consuming it obligatory?
// → exactly which WIRED check covers which loss. 'Wired' means: a gate,
// provider, validator or settlement path actually invokes it on the live
// conveyor (grep-verified; the wiring-honesty assertions below pin it).
const CARRYING = [
  {
    id: 'B1',
    registerPresent: 'no — the register is BORN here, from worker-typed drafts; nothing upstream is typed to diff against',
    obligatory: 'no — order_constraints is optional (discovery-proposal.ts:116-121) and is never diffed against the order text (by design: constraint-register.ts:24-30 makes extraction quality "the discovery assessor\'s boundary")',
    covers: 'nothing; a malformed draft is rejected, an OMITTED one is not',
    lossDetected: false,
    finding: 'E-F1',
  },
  {
    id: 'B2',
    registerPresent: 'yes — FormalizationCase resolves the digest-pinned register from discoveryProposalPayload (formalization-schemas.ts:70-86)',
    obligatory: 'yes — product validator mode "required" (wire-submission-validation.ts:73-77); FORMALIZATION_CONSTRAINT_UNDISPOSED (formalization-contract-validator.ts:77-86)',
    covers: 'every register ID must be disposed in the brief metadata (accepted | waived+reason)',
    lossDetected: true,
    finding: null,
  },
  {
    id: 'B3',
    registerPresent: 'yes — AC metadata covered_constraint_ids diffed against the register (constraint-coverage.ts:37-107)',
    obligatory: 'yes — FORMALIZATION_CONSTRAINT_UNCOVERED at define-acceptance-contract AND reconcile-what; trace_add forward edges obligatory (acceptance validator + settlement findFirstTraceabilityGapForLifecycle, sqlite-formalization-kernel.ts:246-322 — forward only)',
    covers: 'register IDs (covered or validly waived); every AC → FR/NFR(+UC) edge',
    lossDetected: 'partial — register-carried IDs yes; a plain FR/NFR with NO incoming UC covers / AC derived_from edge passes every wired gate (the reconciliation:true reverse check exists at formalization-contract-analysis.ts:211-239 and is passed by NO call site — finding E-F2)',
    finding: 'E-F2',
  },
  {
    id: 'B4',
    registerPresent: 'yes — coveredConstraintIds are KERNEL-derived per item from the frozen criteria (development-task-graph.ts:221-253): inherited, never proposed, cannot be forged or dropped at the handoff',
    obligatory: 'yes — ReferenceDevelopmentTaskGraphPolicy set equality: implementation-coverage-gap (:455-517) and verification-plan-coverage-gap (:518-536)',
    covers: 'every implementationRequired AC covered by a required implementation item, zero foreign ids; verification coverage === the exact accepted AC set',
    lossDetected: true,
    finding: null,
  },
  {
    id: 'B5',
    registerPresent: 'yes on the card — cell_input_item carries acceptanceCriterionIds + coveredConstraintIds into the workplace',
    obligatory: 'verification card: yes — evidence must echo the card-pinned set (development-check-providers.ts:1089-1112, verification-lineage-mismatch). Implementation card: NO — the implementation result consumer contract (development-check-providers.ts:206-297) has no constraint/criterion field at all, and the scope provider reads cell_input_item only for key/changeScopes (:786-813)',
    covers: 'verification echo only',
    lossDetected: 'split — verification card yes; implementation card no (finding E-F3)',
    finding: 'E-F3',
  },
  {
    // Same boundary B5 — its SECOND loss channel. B5 row one: the echo
    // channel (E-F3). This row: the acceptance channel — found live in
    // stage 15 (brief addendum E7).
    id: 'B5',
    registerPresent: 'yes on the card (as the row above) — but nothing downstream consumes it for the implementation card',
    obligatory: 'no — after a scope-fence rejection, the card may pass by simply NO LONGER TOUCHING the paths its work needed: no scope-insufficient declaration, no waiver, no disposition. The gate checks what was presented; nothing checks what was NOT presented',
    covers: 'nothing — the requirement disappears between two repair rounds',
    lossDetected: false,
    finding: 'E-F4',
  },
];

// ── E5: the findings registry (findings, not fixes — brief §2) ──────────────
const FINDINGS = [
  {
    id: 'E-F1',
    boundary: 'B1 order → proposal',
    severity: 'high',
    fed: `order prose containing the token '${TOKEN}'; worker serialized ONE order_constraints draft and omitted the token-bearing one`,
    factorySaid: `validateDiscoveryProposal → valid=true (order_constraints is optional and structurally fine); buildOrderConstraintRegister → a register WITHOUT the token; every downstream register diff is empty, so the entire closed network (B2/B3/B4/B5) inherits an ungated LM extraction loss`,
    shouldLive: 'src/modules/discovery/application/discovery-check-providers.ts:47-77 — the proposal check provider currently runs only structural validateDiscoveryProposal; a detector would need a typed upstream form on factory.discovery-case.v1 to diff against (none exists today — the gap is by design, constraint-register.ts:24-30)',
  },
  {
    id: 'E-F2',
    boundary: 'B3 PRD → AC (plain FR/NFR, not register-carried)',
    severity: 'high',
    fed: 'FR-B accepted in the product bundle; the AC author restated only FR-A; no UC covers FR-B either',
    factorySaid: 'findContractGap over every WIRED dimension set ({product,useCases,acceptance} at define-acceptance-contract and {product,useCases,acceptance,coverage} at reconcile-what) → gap=null; settlement trace check (sqlite-formalization-kernel.ts:246-322) is forward-only (AC→FR), never reverse. The detector CODE exists — findContractGap({reconciliation:true}) names the orphan — but no call site passes that flag',
    shouldLive: 'the reconciliation validator wiring: src/modules/formalization/application/formalization-check-providers.ts:32-37 and src/process-modules/application/wire-submission-validation.ts:60-63 — add reconciliation:true to the dimension set (the orphan check at formalization-contract-analysis.ts:211-239 then runs at the reconcile-what gate)',
  },
  {
    id: 'E-F3',
    boundary: 'B5 task graph → implementation card',
    severity: 'high',
    fed: `card (cell_input_item) pins coveredConstraintIds ['ord-c-001'] (the '${TOKEN}' register entry); the implementation worker submits a scope-clean git change that never addresses it`,
    factorySaid: "developmentImplementationPayloadContract.validate → [] errors (the consumer contract has NO field that carries or echoes the card's criterion/constraint set — the token cannot even be expressed, let alone missed); the implementation scope provider reads cell_input_item only for {key, changeScopes}; the gate passes",
    shouldLive: 'src/modules/development/application/development-check-providers.ts:717-917 (createDevelopmentImplementationScopeCheckProvider) — an echo obligation on cell_input_item.acceptanceCriterionIds/coveredConstraintIds, exactly like the verification provider\'s constraintLineageOk at :1089-1112. The verification echo proves the VERIFIER saw the id, not that the implementer did',
  },
  {
    id: 'E-F4',
    boundary: 'B5-surrender implementation card → acceptance',
    severity: 'high',
    fed: `LIVE, stage-15 run (verified from its DB, not from a report): card 45b9646b… hit the fence at 11:44:26 — path-outside-authority [jest.config.js, tsconfig.json] outside frozen changeScopes [package.json, src/physics/, tests/] (teaching suffix present); 17 minutes later, at 12:01:07, the SAME card's author gate returned ACCEPTED on a candidate that simply no longer touched those paths — no scope-insufficient declaration (factory_scope_widening_events holds ZERO rows for the whole run), no waiver, no disposition. The reviewer accepted it at 12:04:58. The domain-free reproduction below: a card whose criterion requires an artefact under zzz/, attempt 1 touches zzz/shared.config (fence fires), attempt 2 drops zzz/ entirely and touches only aaa/ — accepted`,
    factorySaid: `attempt 1 → failed, path-outside-authority (the fence works); attempt 2 → 'passed'. The scope provider's only questions are identity, ancestry, exact-set diff equality, and containment against frozen scopes — it never asks whether the card's criteria/constraints are covered by what was produced. developmentImplementationPayloadContract has no field to carry the answer even if it asked. The review-verdict channel's input vocabulary has no card-requirement field either: the gate checked what was presented, nothing checked what was NOT presented`,
    shouldLive: 'src/modules/development/application/development-check-providers.ts:887-917 — the acceptance side of the implementation path: a criterion/constraint COVERAGE obligation on the accepted implementation result (the card pins acceptanceCriterionIds + coveredConstraintIds; the accepted diff must dispose them — produced, or explicitly waived like the formalization register dispositions). The lawful exits already exist: worker_done scope-insufficient (stage 13) or a typed waiver — silent abandonment must be neither',
  },
  {
    id: 'E-F5',
    boundary: 'implementation attempt → attempt (claim-surface monotonicity, brief E8)',
    severity: 'high',
    fed: `LIVE, stage-15, both cards: card 2 claimed tsconfig.json on submits 17/18/19 then dropped it on 20 (accepted); card 1 claimed it on 14, dropped it on 15 — accepted, terminal. Domain-free: prior attempt claims [package.json, aaa/thing, zzz/shared.config], resubmission claims [package.json, aaa/thing] with no disposition`,
    factorySaid: 'the narrowed resubmission passed the implementation scope provider — it compares the CURRENT claim against the git diff and the frozen scopes, never against the PRIOR attempt\'s claim. The narrowing is a pure function of two durable rows (factory_managed_node_submissions of one task) and nothing read it',
    shouldLive: 'FIXED 2026-08-20 (STAGE-18 R2): development.implementation-claim-monotonicity.v1 in src/modules/development/application/development-check-providers.ts:1464 — the union of the card\'s prior claims is the surface; a drop is legal only with an explicit snapshot.droppedFiles {path, reason} disposition. Joined the author plan as development.implementation.author.v3 (the scope provider stays permissive by design; the ratchet is its own provider)',
  },
];

// ── fixtures: in-memory DB façades routing the exact validator SQL ──────────

/** A faithful in-memory stand-in for the formalization validators' DB handle.
 * Route table (each route matches the exact statement shape the validators
 * issue — see formalization-contract-validator.ts:147-192, :229-279 and
 * acceptance-contract-validator.ts:58-118, constraint-coverage.ts:42-96). */
function formalizationDb({ taskId = 50, processRunId = 1, taskMetadata, brief, artifacts = [], traces = [] }) {
  const artifactById = new Map(artifacts.map(a => [a.id, a]));
  const meta = value => (typeof value === 'string' ? value : JSON.stringify(value));
  return {
    prepare(sql) {
      if (/^SELECT metadata FROM tasks WHERE id=\?/.test(sql)) {
        return { get: id => (id === taskId ? { metadata: meta(taskMetadata) } : undefined), all: () => [] };
      }
      if (sql.includes('FROM artifacts a') && sql.includes('WHERE a.id=?')) {
        // readExactArtifactContent (the acceptance-contract validator v1.2.0
        // heading-resolution gate reads the exact accepted bytes of every
        // /^AC-/ artifact). AC artifacts get the real-bytes fixture below;
        // non-AC types never reach the gate.
        return {
          get: id => {
            const a = artifactById.get(id);
            if (a && a.type === 'AC') {
              return { path: AC_HEADING_PATH, content_hash: AC_HEADING_HASH, project_repository_id: 1 };
            }
            return { path: 'docs/x.md', content_hash: null, project_repository_id: null };
          },
          all: () => [],
        };
      }
      if (sql.includes('FROM project_repositories pr')) {
        // resolveEffectiveRepositoryRoot — the active-machine-checkout
        // precedence resolver shared by workers and artifact hashing.
        return { get: () => ({ local_path: AC_HEADING_REPO }), all: () => [] };
      }
      if (sql.includes("a.type='brief'") && sql.includes('factory_managed_artifact_productions')) {
        return { get: () => (brief ? { id: brief.id, metadata: meta(brief.metadata) } : undefined), all: () => [] };
      }
      if (/^SELECT DISTINCT a\.id/.test(sql)) { // readContractArtifacts(processRunId)
        return { get: () => undefined, all: () => artifacts.map(a => ({ ...a, metadata: meta(a.metadata) })) };
      }
      if (sql.includes('FROM artifacts WHERE id IN')) {
        // the graph port spreads the ids: .all(...ids)
        return { get: () => undefined, all: (...ids) => ids.map(id => artifactById.get(id)).filter(Boolean) };
      }
      if (sql.includes('FROM artifact_traces WHERE id IN')) {
        return { get: () => undefined, all: (...ids) => traces.filter(t => ids.includes(t.id)) };
      }
      if (sql.includes('FROM artifact_traces') && sql.includes('source_id IN')) {
        return { get: () => undefined, all: (...ids) => traces.filter(t => ids.includes(t.sourceArtifactId)) };
      }
      throw new Error(`formalizationDb: unrouted SQL: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Real-bytes AC fixture (the acceptance-contract validator v1.2.0
// heading-resolution gate): every /^AC-/ artifact code must resolve to
// exactly one level-2/3 heading in real repository-backed bytes whose sha256
// equals content_hash. The file carries one heading per AC id used by this
// suite (AC-5, AC-9); each artifact resolves to exactly its own leaf.
// ---------------------------------------------------------------------------
const AC_HEADING_REPO = mkdtempSync(join(tmpdir(), 'e-constraint-loss-'));
mkdirSync(join(AC_HEADING_REPO, 'docs'), { recursive: true });
const AC_HEADING_PATH = 'docs/ac.md';
const AC_HEADING_BODY = [
  '# AC Documents',
  '',
  '## AC-5: Restatement Boundary Fixture',
  '',
  'Deterministic AC document for the boundary sweep.',
  '',
  '## AC-9: Constraint Carry Fixture',
  '',
  'Deterministic AC document for the coverage validator.',
  '',
].join('\n');
const AC_HEADING_HASH = createHash('sha256').update(AC_HEADING_BODY, 'utf8').digest('hex');
writeFileSync(join(AC_HEADING_REPO, 'docs', 'ac.md'), AC_HEADING_BODY, 'utf8');
process.on('exit', () => {
  try { rmSync(AC_HEADING_REPO, { recursive: true, force: true }); } catch { /* best effort */ }
});

const artifact = (id, type, extra = {}) => ({
  id, projectId: 7, epicId: 8, type, code: `${type}-${id}`, status: 'accepted',
  contentHash: sha256(`content:${id}`), acceptedHash: sha256(`content:${id}`),
  driftState: 'clean', tags: null, metadata: {}, ...extra,
});
const trace = (id, sourceArtifactId, targetId, linkType) => ({
  id, sourceArtifactId, targetType: 'artifact', targetId, linkType,
});

/** The FormalizationCase that rides the task's process_node_input metadata.
 * constraintRegister is absent on purpose: production resolves it from
 * discoveryProposalPayload.order_constraints (formalization-schemas.ts:70-86). */
const caseCarryingToken = {
  schemaVersion: FORMALIZATION_CASE_SCHEMA,
  discoveryProposalPayload: {
    order_constraints: [
      { class: 'execution', text: `${TOKEN} must hold`, evidence_ref: 'order.source_body' },
      { class: 'material', text: 'an unrelated second constraint', evidence_ref: 'order.source_body' },
    ],
  },
};

// ── E1 ──────────────────────────────────────────────────────────────────────

test('space E — E1: the restatement boundaries are enumerated from the process modules, not from memory', () => {
  const discovery = src(DISCOVERY_MODULE);
  const formalization = src(FORMALIZATION_MODULE);
  const development = src(DEVELOPMENT_MODULE);
  const cardExecutor = src(CARD_EXECUTOR);
  // The cited node lines are re-derived from the sources. A moved node breaks
  // the citation (and this test), never the reader's trust.
  assert.equal(lineOf(discovery, "id: 'produce-proposal'"), 71);
  assert.ok(/discovery-proposal-worker/.test(discovery), 'discovery proposal profile drifted');
  assert.equal(lineOf(formalization, "id: 'define-product-contract'"), 164);
  assert.equal(lineOf(formalization, "id: 'define-acceptance-contract'"), 194);
  assert.equal(lineOf(development, "id: 'plan-task-graph'"), 242);
  assert.equal(lineOf(development, "id: 'implement-work-items'"), 278);
  assert.ok(lineOf(cardExecutor, 'cell_input_item: workplace.item') > 0, 'card projection site drifted');
  assert.equal(BOUNDARIES.length, 5, 'the E1 boundary list is fixed at five');
  for (const row of BOUNDARIES) {
    assert.ok(row.node && row.promptAssembly && row.upstream && row.restatement, `${row.id} citation incomplete`);
  }
});

// ── E3 · B1: order → proposal — UNCOVERED (finding E-F1) ────────────────────

test(`space E — E3.B1 order→proposal: '${TOKEN}' lost at extraction is NOT detected (finding E-F1, honest current behavior)`, () => {
  // The order body (tier-1 prose) mentions the token; the worker restates the
  // order as proposal prose + ONE typed draft, omitting the token's draft.
  const restated = {
    problem_statement: `x mentions ${TOKEN} in prose only`,
    observed_context: 'o', stakeholders_or_actors: ['a'], assumptions: [], unknowns: [],
    risks: [], candidate_scope: 's', evidence_refs: ['e'],
    recommended_outcome: 'go', rationale: 'r',
    order_constraints: [
      { class: 'material', text: 'an unrelated second constraint', evidence_ref: 'order.source_body' },
    ],
  };
  // 1. The proposal gate's ONLY check (the real one the discovery cell runs —
  //    createDiscoveryProposalCheckProvider calls exactly this validator).
  const validation = validateDiscoveryProposal(restated);
  assert.equal(validation.valid, true, 'honest behavior: the omission is structurally legal');
  // 2. Settlement then builds the register from exactly what was serialized
  //    (discovery-production-cell-installation.ts:141-144) — the register
  //    never sees the token.
  const register = buildOrderConstraintRegister(restated.order_constraints);
  assert.ok(register);
  assert.deepEqual(
    register.constraints.map(entry => entry.text.includes(TOKEN)),
    [false],
    'honest behavior: the register pins only the serialized drafts',
  );
  // 3. Every downstream register diff (B2/B3/B4/B5) is therefore empty: the
  //    closed network cannot detect a loss that happened before it started.
  assert.equal(FINDINGS.find(f => f.id === 'E-F1').boundary.startsWith('B1'), true);
});

// ── E3 · B2: proposal → PRD/brief — COVERED (the stage-12 precedent, live) ──

test(`space E — E3.B2 proposal→PRD: register id '${TOKEN}' left undisposed IS detected (FORMALIZATION_CONSTRAINT_UNDISPOSED)`, () => {
  const make = briefMetadata => createFormalizationContractValidator(
    formalizationDb({ taskMetadata: { process_node_input: caseCarryingToken }, brief: { id: 900, metadata: briefMetadata } }),
    'formalization.product-contract.v1', 'define-product-contract',
    { product: true, constraintDispositions: true }, // the production wiring (wire-submission-validation.ts:52-55)
  );
  const input = { processRunId: 1, moduleRef: 'solution-formalization@1.0.0', nodeId: 'define-product-contract', executionId: 'e1', taskId: 50, contractRef: null };

  // LOSS: the brief reacts to nothing — the author restated the proposal and
  // dropped the constraint with no disposition.
  const loss = make({}).validate(input);
  assert.equal(loss.accepted, false);
  assert.equal(loss.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');
  assert.match(loss.gaps[0].message, /ord-c-001/);
  assert.match(loss.gaps[0].message, new RegExp(TOKEN), 'the rejection names the lost token');
  assert.equal(loss.gaps.length, 2, 'both register ids are reported per-ID');

  // A waiver without a reason is not a disposition.
  const badWaiver = make({ constraint_dispositions: {
    'ord-c-001': { disposition: 'waived', reason: ' ' },
    'ord-c-002': { disposition: 'accepted' },
  } }).validate(input);
  assert.equal(badWaiver.accepted, false);
  assert.equal(badWaiver.code, 'FORMALIZATION_CONSTRAINT_UNDISPOSED');

  // Honest carry: accepted | waived+reason passes the reaction gate.
  const carried = make({ constraint_dispositions: {
    'ord-c-001': { disposition: 'accepted' },
    'ord-c-002': { disposition: 'waived', reason: 'out of scope for this build' },
  } }).validate(input);
  assert.equal(carried.accepted, true, 'a valid disposition set carries the register across');
  assert.equal(carried.receipt.validatorId, 'formalization.product-contract.v1');
});

// ── E3 · B3a: PRD → AC — COVERED for register-carried ids ───────────────────

test(`space E — E3.B3a PRD→AC: register id '${TOKEN}' covered by no AC IS detected (FORMALIZATION_CONSTRAINT_UNCOVERED)`, () => {
  const artifacts = [
    artifact(999, 'brief'),
    artifact(1, 'PRD'),
    artifact(2, 'FR'),
    artifact(4, 'UC'),
    artifact(9, 'AC', { metadata: {} }), // the restating AC author: no covered_constraint_ids
  ];
  const traces = [
    trace(11, 1, 999, 'derived_from'),
    trace(12, 4, 1, 'derived_from'),
    trace(13, 4, 2, 'covers'),
    trace(14, 9, 2, 'derived_from'),
    trace(15, 9, 4, 'derived_from'),
  ];
  const db = formalizationDb({
    taskMetadata: { process_node_input: caseCarryingToken },
    brief: { id: 900, metadata: { constraint_dispositions: {
      'ord-c-002': { disposition: 'waived', reason: 'deferred' }, // ord-c-001 must be COVERED by an AC
    } } },
    artifacts, traces,
  });
  const validator = createAcceptanceContractValidator(db);
  const input = { processRunId: 1, moduleRef: 'solution-formalization@1.0.0', nodeId: 'define-acceptance-contract', executionId: 'e2', taskId: 50, contractRef: null };

  const loss = validator.validate(input);
  assert.equal(loss.accepted, false);
  assert.equal(loss.code, 'FORMALIZATION_CONSTRAINT_UNCOVERED');
  const gap = loss.gaps.find(g => (g.message ?? '').includes('ord-c-001'));
  assert.ok(gap, 'the uncovered id is reported per-ID');
  assert.match(gap.message, new RegExp(TOKEN));

  // Honest carry: the AC metadata covers the id → accepted with receipt.
  artifacts[4] = artifact(9, 'AC', { metadata: { covered_constraint_ids: ['ord-c-001'] } });
  const carried = createAcceptanceContractValidator(formalizationDb({
    taskMetadata: { process_node_input: caseCarryingToken },
    brief: { id: 900, metadata: { constraint_dispositions: { 'ord-c-002': { disposition: 'waived', reason: 'deferred' } } } },
    artifacts, traces,
  })).validate(input);
  assert.equal(carried.accepted, true);
  assert.equal(carried.receipt.validatorId, 'formalization.acceptance-contract.v1');
});

// ── E3 · B3b: PRD → AC — UNCOVERED for plain FR/NFR (finding E-F2) ──────────

test('space E — E3.B3b PRD→AC: a plain FR with no UC/AC consumer is NOT detected by any WIRED gate (finding E-F2); the detector code exists but is unwired', () => {
  // The real snapshot builder over an in-memory graph port (the port's three
  // reads are exactly what the SQLite adapter implements).
  const artifacts = [
    artifact(999, 'brief'), artifact(1, 'PRD'),
    artifact(2, 'FR', { code: 'FR-A' }),
    artifact(3, 'FR', { code: 'FR-B' }), // the orphan: restated nowhere downstream
    artifact(4, 'UC'), artifact(5, 'AC'),
  ];
  const traces = [
    trace(11, 1, 999, 'derived_from'),
    trace(12, 4, 1, 'derived_from'),
    trace(13, 4, 2, 'covers'),       // UC covers FR-A only
    trace(14, 5, 2, 'derived_from'), // AC derived from FR-A only
    trace(15, 5, 4, 'derived_from'),
  ];
  const port = {
    readArtifactsByIds: ids => ids.map(id => artifacts.find(a => a.id === id)).filter(Boolean),
    readTracesByIds: ids => traces.filter(t => ids.includes(t.id)),
    readOutgoingArtifactTraces: ids => traces.filter(t => ids.includes(t.sourceArtifactId)),
  };
  const snapshot = buildContractSnapshot(port, artifacts);

  // Every dimension set any wired gate passes today. Note: the wired
  // reconciliation validator's literal `{ ..., coverage: true }` is a FLAG of
  // the validator layer — createFormalizationContractValidator resolves it to
  // a real coverage requirement (register-ID diff) or drops it. It contributes
  // nothing to an FR orphan either way: with no register the diff is empty,
  // with a register it only diffs register IDs. Both forms are driven.
  const acceptanceDims = { product: true, useCases: true, acceptance: true }; // define-acceptance-contract
  assert.equal(findContractGap(snapshot, acceptanceDims), null,
    'honest behavior: FR-B (no consumer at all) passes the acceptance gate');
  assert.equal(
    findContractGap(snapshot, { product: true, useCases: true, acceptance: true, coverage: { constraintIds: [], waivedIds: [] } }),
    null,
    'honest behavior: FR-B passes the reconciliation gate too (register diff empty)');
  assert.equal(
    findContractGap(snapshot, { product: true, useCases: true, acceptance: true, coverage: { constraintIds: ['ord-c-001'], waivedIds: ['ord-c-001'] } }),
    null,
    'honest behavior: even a register-carrying reconciliation gate (register validly waived) never looks at FR consumers — only at register IDs',
  );
  // The settlement trace check is forward-only (sqlite-formalization-kernel.ts:246-322:
  // PRD→brief, SRS→PRD, UC→PRD/FR, AC→FR/NFR) — it cannot see a reverse orphan.

  // The check that WOULD catch it exists in the same real module:
  assert.match(
    findContractGap(snapshot, { reconciliation: true }),
    /FR\/NFR 3 \(FR-B\) has no incoming covers\/derived_from from any UC\/AC — orphan requirement/,
    'the unwired reconciliation dimension names the orphan exactly',
  );

  // Wiring honesty: no call site passes reconciliation:true today. If this
  // assertion ever fails, finding E-F2 has been fixed — revisit the registry.
  const providerWiring = src('src/modules/formalization/application/formalization-check-providers.ts');
  const rootWiring = src('src/process-modules/application/wire-submission-validation.ts');
  for (const [name, text] of [['formalization-check-providers.ts', providerWiring], ['wire-submission-validation.ts', rootWiring]]) {
    const calls = [...text.matchAll(/createFormalizationContractValidator\([^)]*'formalization\.reconciliation\.v1'[^)]*\)/gs)];
    assert.ok(calls.length === 1, `${name}: the reconciliation validator registration moved`);
    assert.ok(!/reconciliation:\s*true/.test(calls[0][0]),
      `${name}: the reconciliation validator NOW passes reconciliation:true — finding E-F2 is fixed; update the FINDINGS registry`);
  }
});

// ── E3 · B4: AC → task graph — COVERED ──────────────────────────────────────

test(`space E — E3.B4 AC→task graph: a dropped AC IS detected; the '${TOKEN}' relay is kernel-derived and undroppable`, () => {
  const policyBody = { id: 'matrix-policy', version: '1.0.0' };
  const devCase = {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 7, epicId: 8, initiatedBy: 'matrix',
    formalizationCertificate: { schema: 'factory.solution-contract-certificate.v1', ref: 'certificate:1', hash: sha256('cert'), decision: 'formalized' },
    solutionContract: { schema: 'factory.sc.x', ref: 'r', hash: sha256('sol') },
    acceptanceBaselineHash: sha256('baseline'),
    srs: { schema: 'factory.srs.x', ref: 'r2', hash: sha256('srs') },
    acceptanceCriteria: [
      { artifactId: 101, code: 'AC-1', acceptedHash: sha256('ac1'), implementationRequired: true, criticality: 'blocker', coveredConstraintIds: ['ord-c-001'] },
      { artifactId: 102, code: 'AC-2', acceptedHash: sha256('ac2'), implementationRequired: true, criticality: 'blocker' },
      { artifactId: 103, code: 'AC-3', acceptedHash: sha256('ac3'), implementationRequired: false, criticality: 'nice_to_have' },
    ],
    repositories: [{ projectRepositoryId: 5, integrationBranch: 'b', expectedBaseCommit: 'c0' }],
    policy: { ...policyBody, contentHash: hashDevelopmentPolicy(policyBody) },
  };
  const implItem = {
    key: 'imp-1', kind: 'implementation', taskKind: 'development.code',
    executionSkill: 'saga-worker', executionMode: 'git_change', projectRepositoryId: 5,
    acceptanceCriterionKeys: ['101:AC-1', '102:AC-2'], dependsOnKeys: [], changeScopes: ['zzz/'],
    required: true, criticality: 'blocker',
  };
  const verifyItem = id => ({
    key: `verify-${id.split(':')[1]}`, kind: 'verification', taskKind: 'verification.ac',
    executionSkill: 'saga-verifier', executionMode: 'read_only_evidence', projectRepositoryId: 5,
    acceptanceCriterionKeys: [id], dependsOnKeys: [], changeScopes: [],
    required: true, criticality: 'blocker',
  });
  const completeProposal = {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: [implItem],
    verificationItems: ['101:AC-1', '102:AC-2', '103:AC-3'].map(verifyItem),
    integrationTargets: [{ projectRepositoryId: 5, sourceWorkItemKeys: ['imp-1'], targetBranch: 'b', expectedBaseCommit: 'c0' }],
  };
  const submission = { schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA, ref: 'managed-node-submission:9', hash: sha256('sub') };
  const policy = new ReferenceDevelopmentTaskGraphPolicy();

  const build = proposal => {
    const decoded = decodeDevelopmentTaskGraphProposal(proposal); // the REAL proposal decoder
    if (!decoded.ok) assert.fail(decoded.errors.join('; '));
    return buildCanonicalDevelopmentTaskGraph(devCase, decoded.value, submission);
  };

  // Positive control: the complete graph validates.
  assert.equal(policy.validate(devCase, build(completeProposal)).valid, true);

  // LOSS: the planner drops the verification item for AC-3 (artifactId 103).
  const lossy = structuredClone(completeProposal);
  lossy.verificationItems = lossy.verificationItems.filter(item => item.key !== 'verify-AC-3');
  const verdict = policy.validate(devCase, build(lossy));
  assert.equal(verdict.valid, false, 'a dropped AC is detected');
  assert.ok(verdict.reasonCodes.includes('verification-plan-coverage-gap'));
  assert.match(verdict.errors.join('; '), /missing AC criterion keys: \[103:AC-3\]/);

  // LOSS: an implementation item quietly stops carrying an implementationRequired AC.
  const narrowed = structuredClone(completeProposal);
  narrowed.implementationItems[0].acceptanceCriterionKeys = ['102:AC-2'];
  const narrowedVerdict = policy.validate(devCase, build(narrowed));
  assert.equal(narrowedVerdict.valid, false);
  assert.ok(narrowedVerdict.reasonCodes.includes('implementation-coverage-gap'));

  // The constraint relay: the PROPOSAL carries no coveredConstraintIds, yet the
  // canonical item does — inherited from the frozen criteria, kernel-side
  // (development-task-graph.ts:221-253). The planner cannot drop CONSTRAINT-ALPHA here.
  const canonical = build(completeProposal);
  assert.deepEqual(canonical.implementationItems[0].coveredConstraintIds, ['ord-c-001']);
  assert.deepEqual(
    canonical.verificationItems.find(item => item.key === 'verify-AC-1').coveredConstraintIds,
    ['ord-c-001'],
  );
});

// ── E3 · B5: task graph → cards — SPLIT (finding E-F3) ──────────────────────

test(`space E — E3.B5 task graph→cards: the implementation card loses '${TOKEN}' silently (finding E-F3); the verification card echo IS detected`, () => {
  const card = {
    key: 'imp-1', acceptanceCriterionKeys: ['101:AC-1'], changeScopes: ['zzz/'],
    coveredConstraintIds: ['ord-c-001'], // CONSTRAINT-ALPHA rides the card
  };

  // (a) IMPLEMENTATION CARD — honest current behavior: the real consumer
  // contract of the implementation result has NO field that echoes the card's
  // criterion/constraint set, so the token cannot be restated, dropped, or
  // missed: the gate passes a result that never addresses it.
  const implementationResult = {
    workItemKey: 'imp-1', // identity echo — the ONLY card field the result must repeat
    repository: { baseCommit: HEX40 },
    snapshot: { commitSha: HEX40, changedFiles: ['zzz/thing'] },
  };
  const payloadErrors = developmentImplementationPayloadContract.validate(implementationResult);
  assert.deepEqual(payloadErrors, [],
    'honest behavior: a constraint-blind implementation result passes its consumer contract');
  // Wiring honesty: the scope provider reads cell_input_item only for
  // {key, changeScopes} (development-check-providers.ts:786). If this fails,
  // finding E-F3 gained (or lost) its echo — revisit the registry.
  const providers = src('src/modules/development/application/development-check-providers.ts');
  const implScopeSlice = providers.slice(
    providers.indexOf('createDevelopmentImplementationScopeCheckProvider'),
    providers.indexOf('createDevelopmentVerificationCheckProvider'),
  );
  assert.match(implScopeSlice, /cell_input_item\?: \{ key\?: unknown; changeScopes\?: unknown \};/,
    'the implementation scope provider now decodes MORE than key/changeScopes from the card — finding E-F3 changed');
  assert.ok(!implScopeSlice.includes('coveredConstraintIds') && !implScopeSlice.includes('acceptanceCriterionIds'),
    'the implementation gate reads the card constraint/criterion set — finding E-F3 is fixed; update the FINDINGS registry');

  // (b) VERIFICATION CARD — the contrast: the REAL verification provider
  // (createDevelopmentVerificationCheckProvider) fails the evidence when it
  // does not echo the card-pinned constraint set.
  const makeProvider = coveredConstraintIds => {
    const evidence = {
      schemaVersion: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
      verificationItemKey: 'verify-101',
      acceptanceCriterionKey: '101:AC-1',
      acceptedCriterionHash: sha256('ac1'),
      candidateHash: sha256('cand'),
      ...(coveredConstraintIds ? { coveredConstraintIds } : {}),
      outcome: 'passed',
      evidence: { summary: 's', observations: ['o'], limitations: [] },
    };
    const taskMetadata = {
      cell_input_item: { key: 'verify-101', acceptanceCriterionKeys: ['101:AC-1'], coveredConstraintIds: ['ord-c-001'] },
      process_node_input: { upstream: { bindings: { candidate: { candidateHash: sha256('cand') } } } },
    };
    const row = {
      payload_snapshot: JSON.stringify(evidence),
      content_hash: 'digest-1',
      verification_target_artifact_id: 101,
      metadata: JSON.stringify(taskMetadata),
      accepted_hash: sha256('ac1'),
    };
    const db = {
      prepare(sql) {
        if (!sql.includes('factory_managed_node_submissions')) throw new Error(`unrouted SQL: ${sql.slice(0, 60)}`);
        return { get: () => row, all: () => [] };
      },
    };
    const candidateSets = {
      read: () => ({
        role: 'author',
        workplaceRef: { processRunId: 1 },
        members: [{ productRef: { schemaId: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA, ref: 'managed-node-submission:9', digest: 'digest-1' } }],
      }),
    };
    return { provider: createDevelopmentVerificationCheckProvider({ db, candidateSets }) };
  };
  const run = provider => provider.run({ subjectCandidateSetRef: 'candidate-set/matrix', parameters: { processRunId: 1 } });

  // Echo present → passed.
  assert.equal(run(makeProvider(['ord-c-001']).provider), 'passed');
  // LOSS: the verifier drops the echo → detected, typed, with repair text.
  const dropped = run(makeProvider(undefined).provider);
  assert.equal(dropped.outcome, 'failed');
  const diagnostic = decodeCheckDiagnostic(dropped.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'verification-lineage-mismatch');
  assert.match(diagnostic.message, /coveredConstraintIds/);
});

// ── E8: claim-surface monotonicity (brief addendum — the implementable E7) ──

/**
 * E8's rule, verbatim from the brief: a card may not silently narrow its own
 * claimed surface between attempts. Dropping a previously-claimed file is
 * either an explicit disposition or a regression. NO semantics needed — the
 * narrowing is visible in durable state (consecutive submissions of one
 * card): stage-15 card 2 claimed tsconfig.json on submits 17/18/19 and
 * dropped it on 20; card 1 claimed it on 14, dropped it on 15, was accepted
 * and went terminal.
 *
 * The mechanism already existed on another surface
 * (development.readiness-profile-monotonicity.v1 forbids the declared
 * readiness surface from shrinking across rounds of the same bytes).
 * FIXED 2026-08-20 (STAGE-18 R2): development.implementation-claim-
 * monotonicity.v1 joined the author plan (v3) — the union of the card's
 * prior claims is the surface; a drop is legal only with an explicit
 * snapshot.droppedFiles {path, reason} disposition. This test now pins the
 * FIXED state: the scope provider alone stays permissive (containment is
 * one-directional by design), and the monotonicity provider refuses the
 * same durable rows.
 */
test('space E — E8 claim-surface monotonicity: the silent narrowing is refused by the claim-monotonicity provider (fixed by STAGE-18 R2; the scope provider stays permissive by design)', () => {
  const priorFiles = ['package.json', 'aaa/thing', 'zzz/shared.config'];
  const narrowedFiles = ['package.json', 'aaa/thing']; // zzz/ silently dropped

  // The narrowing is computable from durable state alone: consecutive
  // factory_managed_node_submissions rows for one task. The façade DB holds
  // both attempts exactly as the live DB did.
  const rows = new Map([
    [9, { // the prior attempt — claimed zzz/shared.config
      payload_snapshot: JSON.stringify({ workItemKey: 'imp-1', repository: { baseCommit: HEX40 }, snapshot: { commitSha: HEX40, changedFiles: priorFiles } }),
      content_hash: sha256('prior'),
      metadata: JSON.stringify({ cell_input_item: { key: 'imp-1', changeScopes: ['package.json', 'aaa/', 'zzz/'] } }),
      task_id: 42, local_path: 'x:/matrix/product', effective_base_commit: HEX40,
    }],
    [10, { // the narrowed resubmission — zzz/ silently dropped
      payload_snapshot: JSON.stringify({ workItemKey: 'imp-1', repository: { baseCommit: HEX40 }, snapshot: { commitSha: HEX40, changedFiles: narrowedFiles } }),
      content_hash: sha256('narrowed'),
      metadata: JSON.stringify({ cell_input_item: { key: 'imp-1', changeScopes: ['package.json', 'aaa/', 'zzz/'] } }),
      task_id: 42, local_path: 'x:/matrix/product', effective_base_commit: HEX40,
    }],
  ]);
  const claimed = id => JSON.parse(rows.get(id).payload_snapshot).snapshot.changedFiles;
  // (d) durable derivability, by construction: prior ⊋ current, no disposition.
  assert.ok(claimed(9).length > claimed(10).length && claimed(10).every(f => claimed(9).includes(f)),
    'the narrowing is a pure function of the two durable rows');

  const provider = createDevelopmentImplementationScopeCheckProvider({
    db: { prepare(sql) {
      if (sql.includes('factory_managed_node_submissions')) {
        return { get: id => rows.get(Number(id)) };
      }
      throw new Error(`unrouted SQL: ${sql.slice(0, 60)}`);
    } },
    candidateSets: { read: () => ({
      role: 'author',
      workplaceRef: { processRunId: 1 },
      members: [{ productRef: { schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, ref: 'managed-node-submission:10', digest: sha256('narrowed') } }],
    }) },
    git: { read(_p, args) {
      if (args[0] === 'merge-base') return HEX40;
      if (args[0] === 'diff') return narrowedFiles.join('\n');
      return null;
    } },
  });
  const narrowed = provider.run({ subjectCandidateSetRef: 'candidate-set/m', parameters: { processRunId: 1 } });
  const outcome = typeof narrowed === 'string' ? narrowed : narrowed.outcome;
  assert.equal(outcome, 'passed',
    'the SCOPE provider alone stays permissive (containment is one-directional by design) — the ratchet is the second provider');

  // STAGE-18 R2 (the fix): the same durable rows through the claim-surface
  // monotonicity provider — the silent narrowing is REFUSED.
  const monoProvider = createImplementationClaimMonotonicityCheckProvider({
    db: { prepare(sql) {
      if (!sql.includes('factory_managed_node_submissions')) {
        throw new Error(`unrouted SQL: ${sql.slice(0, 60)}`);
      }
      return {
        get: id => rows.get(Number(id)),
        all: () => [...rows.entries()].map(([id, r]) => ({ id, payload_snapshot: r.payload_snapshot })),
      };
    } },
    candidateSets: { read: () => ({
      role: 'author',
      workplaceRef: { processRunId: 1 },
      members: [{ productRef: { schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, ref: 'managed-node-submission:10', digest: sha256('narrowed') } }],
    }) },
  });
  const monoResult = monoProvider.run({ subjectCandidateSetRef: 'candidate-set/m', parameters: { processRunId: 1 } });
  const monoOutcome = typeof monoResult === 'string' ? monoResult : monoResult.outcome;
  assert.equal(monoOutcome, 'failed',
    'the claim-monotonicity provider refuses the silently narrowed resubmission — E-F5 fixed by R2');
  if (typeof monoResult === 'object') {
    const diagnostic = decodeCheckDiagnostic(monoResult.evidenceRefs[0]);
    assert.equal(diagnostic.code, 'IMPLEMENTATION_CLAIM_NARROWED');
    assert.match(diagnostic.message, /zzz\/shared\.config/, 'the dropped path is named');
  }

  // The copied form exists on ANOTHER surface (the shape E8 copied): the
  // readiness monotonicity provider. Pin both providers' existence and the
  // structural split — monotonicity lives in its OWN provider, the scope
  // provider stays vocabulary-free.
  const providers = src('src/modules/development/application/development-check-providers.ts');
  assert.match(providers, /createDevelopmentReadinessMonotonicityCheckProvider/,
    'the readiness monotonicity provider must exist (the shape E8 copied)');
  assert.match(providers, /createImplementationClaimMonotonicityCheckProvider/,
    'the implementation claim-monotonicity provider must exist (R2)');
  const implStart = providers.indexOf('export function createDevelopmentImplementationScopeCheckProvider');
  const implEnd = providers.indexOf('\nexport function', implStart + 1);
  const implSlice = providers.slice(implStart, implEnd === -1 ? undefined : implEnd);
  assert.ok(!/prior submission|previous submission|monotonic|narrow/i.test(implSlice),
    'the implementation scope provider gained monotonicity vocabulary — the ratchet must stay its own provider; update this registry');
});

// ── E7: the silent surrender (brief addendum, found live in stage 15) ───────

/**
 * The REAL implementation scope provider over in-memory façades: the DB row
 * (exact submission SQL), the CandidateSet binding, and a git port whose
 * merge-base/diff answers mirror a faithful repository. The card pins
 * coveredConstraintIds (CONSTRAINT-ALPHA rides it, as B5) and the criterion
 * implies an artefact under zzz/ — but the provider's vocabulary decides
 * what it can even ask about.
 */
function implementationScopeHarness({ changedFiles, scopes = ['aaa/'] }) {
  const digest = sha256('payload');
  const payload = {
    workItemKey: 'imp-1',
    repository: { baseCommit: HEX40 },
    snapshot: { commitSha: HEX40, changedFiles },
  };
  const metadata = {
    cell_input_item: {
      key: 'imp-1',
      changeScopes: scopes,
      acceptanceCriterionIds: [101],
      coveredConstraintIds: ['ord-c-001'],
    },
  };
  const row = {
    payload_snapshot: JSON.stringify(payload),
    content_hash: digest,
    metadata: JSON.stringify(metadata),
    task_id: 42,
    local_path: 'x:/matrix/product',
    effective_base_commit: HEX40,
  };
  const db = {
    prepare(sql) {
      if (!sql.includes('factory_managed_node_submissions')) {
        throw new Error(`unrouted SQL: ${sql.slice(0, 60)}`);
      }
      return { get: () => row };
    },
  };
  const candidateSets = {
    read: () => ({
      role: 'author',
      workplaceRef: { processRunId: 1 },
      members: [{
        productRef: {
          schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
          ref: 'managed-node-submission:9',
          digest,
        },
      }],
    }),
  };
  const git = {
    read(_path, args) {
      if (args[0] === 'merge-base') return HEX40;
      if (args[0] === 'diff') return changedFiles.join('\n');
      return null;
    },
  };
  return createDevelopmentImplementationScopeCheckProvider({ db, candidateSets, git });
}

function runScopeProvider(provider) {
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/matrix',
    parameters: { processRunId: 1 },
  });
  return typeof result === 'string' ? { outcome: result, evidenceRefs: [] } : result;
}

test(`space E — E7 silent surrender: a card whose criteria require an artefact it stopped touching is ACCEPTED (finding E-F4, honest current behavior)`, () => {
  // Attempt 1 — the fence fires, exactly as it did live at 11:44:26: the
  // work genuinely needs zzz/shared.config, the carve forbids it, the
  // teaching suffix tells the worker the lawful exit.
  const fenced = runScopeProvider(implementationScopeHarness({
    changedFiles: ['aaa/thing', 'zzz/shared.config'],
  }));
  assert.equal(fenced.outcome, 'failed', 'the fence must fire on the out-of-scope need');
  const fenceDiagnostic = decodeCheckDiagnostic(fenced.evidenceRefs[0]);
  assert.equal(fenceDiagnostic.code, 'path-outside-authority');
  assert.match(fenceDiagnostic.message, /zzz\/shared\.config/);
  assert.match(fenceDiagnostic.message, /scope-insufficient/,
    'the lawful exit is taught in the rejection itself');

  // Attempt 2 — THE SILENT SURRENDER: same card, same pinned criteria, but
  // the worker simply stops touching zzz/. No declaration, no waiver, no
  // disposition. The gate passes: its questions are identity, ancestry,
  // exact-set equality and containment — never coverage of the card's
  // criteria by what was produced. This is the live 12:01:07 acceptance.
  const surrendered = runScopeProvider(implementationScopeHarness({
    changedFiles: ['aaa/thing'],
  }));
  assert.equal(surrendered.outcome, 'passed',
    'honest behavior: the silent surrender passes the implementation gate — finding E-F4');

  // The consumer contract cannot even express the answer: no constraint or
  // criterion field exists on the implementation result (E-F3's pin, restated
  // here because the surrender chain runs through it).
  assert.deepEqual(
    developmentImplementationPayloadContract.validate({
      workItemKey: 'imp-1',
      repository: { baseCommit: HEX40 },
      snapshot: { commitSha: HEX40, changedFiles: ['aaa/thing'] },
    }),
    [],
    'a constraint-blind implementation result passes its consumer contract',
  );

  // The reviewer channel cannot ask either: the review-verdict provider's
  // input vocabulary carries findings and scopes, never the card's
  // requirement set. Fixing E-F4 on the gate side alone would not close the
  // acceptance side — the pin below breaks if the reviewer learns the
  // card's requirements (then revisit the registry).
  const reviewProvider = src('src/process-modules/application/review-verdict-check-provider.ts');
  assert.ok(
    !reviewProvider.includes('coveredConstraintIds') && !reviewProvider.includes('acceptanceCriterionIds'),
    'the review-verdict provider reads the card constraint/criterion set — E-F4\'s acceptance side changed; update the FINDINGS registry',
  );
});

// ── E5 + E6 ─────────────────────────────────────────────────────────────────

// ── CC-IC-1 (ADR-090): m1 + m6b across the live settlement paths ────────────
//
// The CC-IC-1 packets add two LIVE detectors to this sweep's boundary set:
//   m1  — B1's unknown channel: proposal `unknowns` are lifted 1:1/positionally
//         into kind `open-question` register entries by the REAL production-cell
//         settlement (kernel-side, no guessing); a dropped unknown is a typed
//         settlement red (ORDER_CONSTRAINT_UNKNOWN_NOT_LIFTED), never a silent
//         under-count.
//   m6b — the certificate→case handoff: a v2 FormalizationCase resolves its
//         ONE register binding from the DISCOVERY CERTIFICATE (the v2 source
//         of truth); the proposal-payload rebuild fallback is frozen-legacy-
//         v1-only — a v2 case whose binding diverges from the certificate
//         register is a typed red (FORMALIZATION_REGISTER_BINDING_BYPASSED).

/** Canonical sha256 over an object (the settlement's content-hash convention). */
const sha256Canonical = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** A parseable SRS §D2 (one AC-1 stanza) + §12 decision log, warrant-ref shape. */
function eSrsContent() {
  const { SRS_CONTRACT } = globalThis.__eSrsContract ?? {};
  const cols = SRS_CONTRACT?.decisionLogColumns ?? ['id', 'decision', 'status', 'alternatives', 'rationale', 'date'];
  return [
    '# SRS',
    '',
    '## §12 Decision Log',
    '',
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    '| 1 | KISS | inherited | none | simplicity | 2026-01-01 |',
    '',
    '### §D2. AC Map',
    '',
    '```yaml',
    '- ac: AC-1',
    '  title: "Feature"',
    '  module: core',
    '  files: [src/core.ts]',
    '  invariants: []',
    '  test_layers: [L0]',
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '```',
    '',
  ].join('\n');
}

const D7_PROPOSAL = {
  problem_statement: `x mentions ${TOKEN} in prose only`,
  observed_context: 'o', stakeholders_or_actors: ['a'], assumptions: [],
  unknowns: [`the ${TOKEN} pricing algorithm is not yet chosen`],
  risks: [], candidate_scope: 's', evidence_refs: ['e'],
  recommended_outcome: 'go', rationale: 'r',
  order_constraints: [
    { class: 'material', text: 'an unrelated second constraint', evidence_ref: 'order.source_body' },
  ],
};

function readinessBodyFor(proposalHash) {
  const dims = {};
  for (const d of READINESS_DIMENSIONS) {
    dims[d] = { status: 'sufficient', rationale: 'g', source_refs: ['$.problem_statement'] };
  }
  return {
    proposal_content_hash: proposalHash,
    overall_readiness: 'ready',
    dimension_assessments: dims,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'g',
  };
}

/** In-memory façade routing the exact statements the discovery settlement issues. */
function discoverySettlementDbFaçade({ proposalPayload, readinessPayloadBody }) {
  const proposalHash = sha256Canonical(proposalPayload);
  const readinessHash = sha256Canonical(readinessPayloadBody);
  const row = (id, nodeId, schema, payload, hash) => ({
    id, process_run_id: 1, node_id: nodeId, intent_id: 1, task_id: 1,
    execution_id: 'exec-1', schema_version: schema,
    payload_snapshot: JSON.stringify(payload), content_hash: hash,
    submitted_at: '2026-01-01T00:00:00Z',
  });
  const submissions = new Map([
    [501, row(501, 'produce-proposal', 'factory.discovery-proposal.v1', proposalPayload, proposalHash)],
    [502, row(502, 'produce-readiness', 'factory.discovery-readiness-assessment.v2', readinessPayloadBody, readinessHash)],
  ]);
  return {
    prepare(sql) {
      if (sql.includes('FROM factory_managed_node_submissions')) {
        return { get: id => submissions.get(Number(id)), all: () => [...submissions.values()] };
      }
      if (sql.includes('SELECT input_hash,started_at FROM factory_process_runs')) {
        return { get: () => ({ input_hash: 'i'.repeat(64), started_at: '2026-01-01T00:00:00Z' }), all: () => [] };
      }
      throw new Error(`discoverySettlementDbFaçade: unrouted SQL: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
    },
  };
}

/**
 * Drive the REAL production-cell settlement handler with the REAL declared
 * injection wiring the composition (product-lifecycle-runtime.ts) injects —
 * the same code path a live Factory Start drives.
 */
function driveDiscoverySettlement({ proposalPayload }) {
  const readinessBody = readinessBodyFor(sha256Canonical(proposalPayload));
  const db = discoverySettlementDbFaçade({ proposalPayload, readinessPayloadBody: readinessBody });
  const issued = [];
  const handlers = createDiscoveryProductionCellKernelHandlers({
    db,
    certificates: {
      issue: command => {
        issued.push(command);
        return { record: { id: 600, certificateHash: command.certificateHash } };
      },
    },
    lifecycleDefinitionReader: {
      // The pinned per-run read (ADR-090 wiring path): the product-build
      // definition pinned by definition_hash, exactly as the repository join
      // returns it.
      readDefinitionByProcessRun: () => ({
        lifecycleRunId: 7,
        lifecycleRefKey: 'product-build@1.2.0',
        definition: JSON.parse(JSON.stringify(productBuildLifecycle)),
        definitionHash: sha256Canonical(productBuildLifecycle),
      }),
    },
    lifecycleInjectionDeclarations: [{
      table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
      tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
      tableDigest: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST,
    }],
    lifecycleInjectionRequiredClassifications: ['runnable-local'],
  });
  const manifest = product => ({
    schema: 'factory.production-cell-output-manifest.v1',
    bindings: {
      final: true,
      items: [{
        accepted: true, id: 'i', workKey: 'w', workplaceRef: 'wp', candidateSetRef: 'cs',
        execution: { intentId: 1, taskId: 1, executionRef: 'exec-1' },
        products: [product],
      }],
    },
  });
  const result = handlers['discovery-settlement-policy']({
    projectId: 1, epicId: 8, processRunId: 1,
    node: { id: 'settle-discovery' },
    input: manifest({ schemaId: 'factory.discovery-readiness-assessment.v2', ref: 'managed-node-submission:502', digest: sha256Canonical(readinessBody) }),
    frame: { productions: { 'produce-proposal': manifest({ schemaId: 'factory.discovery-proposal.v1', ref: 'managed-node-submission:501', digest: sha256Canonical(proposalPayload) }) } },
    heartbeat: () => {},
    initiatedBy: 'matrix',
  });
  return { result, issued };
}

test(`space E — CC-IC-1 m1 at B1: proposal unknown '${TOKEN}' survives settlement as an open-question entry; dropping it is a typed red`, () => {
  const { result, issued } = driveDiscoverySettlement({ proposalPayload: D7_PROPOSAL });
  assert.ok(['go', 'clarify', 'reject'].includes(result.event), `settlement failed: ${result.production?.bindings?.error}`);
  const register = issued[0].payload.constraintRegister;
  assert.ok(register, 'the unknown + drafts + injected obligations build a v2 register');
  assert.equal(register.schemaVersion, 'factory.order-constraint-register.v2');
  const openQuestions = register.constraints.filter(entry => entry.kind === 'open-question');
  assert.deepEqual(openQuestions.map(entry => entry.text), D7_PROPOSAL.unknowns);
  assert.ok(register.constraints.some(entry => entry.text === D7_PROPOSAL.order_constraints[0].text));
  assert.deepEqual(
    register.constraints.slice(-2).map(entry => entry.kind),
    ['synthesis', 'ordered-smoke'],
    'the runnable-local injected block is appended after the proposal-derived block',
  );
  // The conservation assert holds for the honest build…
  assertOrderConstraintUnknownsLifted(register, D7_PROPOSAL.unknowns);
  // …and the MUTANT (settlement lifting that dropped the unknown) is red:
  const mutant = { ...register, constraints: register.constraints.filter(entry => entry.kind !== 'open-question') };
  assert.throws(
    () => assertOrderConstraintUnknownsLifted(mutant, D7_PROPOSAL.unknowns),
    /ORDER_CONSTRAINT_UNKNOWN_NOT_LIFTED/,
  );
});

test('space E — CC-IC-1 m6b: a v2 FormalizationCase takes its ONE register binding from the discovery certificate; a rebuild-supplied binding is a typed red', () => {
  // A REAL v2 discovery certificate: register built from unknowns + the
  // declared injection table (exactly what settlement issues).
  const certificateRegister = buildOrderConstraintRegisterV2({
    drafts: D7_PROPOSAL.order_constraints,
    unknowns: D7_PROPOSAL.unknowns,
    injections: [{ table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE, tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF }],
  });
  assert.ok(certificateRegister);
  const certificatePayload = {
    schemaVersion: 'factory.discovery-outcome-certificate.v1',
    decision: 'go', reasonCodes: [], rationale: 'r', inputHash: 'i'.repeat(64),
    constraintRegister: certificateRegister,
    payload: {},
  };
  const certificateHash = sha256Canonical(certificatePayload);

  const caseWithCertificate = {
    schemaVersion: FORMALIZATION_CASE_SCHEMA,
    discoveryEpicId: 8, formalizationEpicId: 8,
    discoveryCertificateRef: 'certificate:1',
    discoveryCertificateHash: certificateHash,
    discoveryOutcome: 'go',
    discoveryProposalRef: 'proposal:1',
    discoveryProposalHash: 'b'.repeat(64),
    discoveryProposalPayload: D7_PROPOSAL,
    initiativeSubject: 'matrix', initiatedBy: 'matrix',
  };

  const formalizationGraph = () => ({
    readAcceptedArtifactsForLifecycle: () => ({ prd: 2, frs: [3], nfrs: [], rules: [], ucs: [26], acs: [29], srs: 40 }),
    readAcceptanceBaselineHashForLifecycle: () => ({ hash: 'b'.repeat(64), clean: true, dirty: [] }),
    readArtifactsByIds: ids => ids.map(id => ({
      id, projectId: 1, epicId: 8, type: id === 29 ? 'AC' : 'PRD', code: id === 29 ? 'AC-1' : null,
      status: 'accepted', contentHash: sha256(`artifact-${id}`), acceptedHash: sha256(`artifact-${id}`),
      driftState: 'clean', tags: '[]', metadata: {},
    })),
    readOutgoingArtifactTraces: () => [],
    findFirstTraceabilityGapForLifecycle: () => null,
    areTasksReady: () => ({ ready: true, blockingTaskIds: [] }),
    readOwningLifecycleRunId: () => 7,
    readBriefConstraintDispositionsForLifecycle: () => ({}),
  });

  const drive = (theCase, readCertificate) => {
    const issued = [];
    const persisted = [];
    const handlers = createFormalizationProductionCellKernelHandlers({
      graph: formalizationGraph(),
      baselineRepository: {
        readByProcessRun: () => ({
          artifactRef: 'baseline:ref', snapshotHash: 's'.repeat(64), baselineHash: 'b'.repeat(64),
          payload: { acceptanceCriteria: [{ artifactId: 29, code: 'AC-1', title: 'F', contentHash: sha256('ac') }] },
        }),
      },
      solutionContractRepository: {
        persist: payload => {
          persisted.push(payload);
          return { replayed: false, record: { artifactRef: 'solution-contract:x', contentHash: sha256('sc'), payload } };
        },
      },
      settlementPolicy: { settle: () => ({ decision: 'formalized', reasonCodes: [], rationale: 'c', inputHash: 'i'.repeat(64) }) },
      certificateRepository: {
        read: readCertificate,
        issue: command => { issued.push(command); return { record: { id: 91, certificateHash: command.certificateHash } }; },
      },
      readArtifactContent: id => (id === 40 ? eSrsContent() : 'x'.repeat(10)),
    });
    const result = handlers[FORMALIZATION_KERNEL_HANDLER_IDS.settle]({
      projectId: 1, epicId: 8, processRunId: 2, input: {},
      frame: { runInput: theCase }, heartbeat: () => {}, initiatedBy: 'matrix',
      node: { id: 'settle-formalization' },
    });
    return { result, issued, persisted };
  };

  const readCertificate = () => ({ id: 1, processRunId: 1, certificateHash, certificatePayload });

  // Honest carry: the warrant cites the CERTIFICATE register (unknowns +
  // injected entries included), and the coverage relay freezes the same ONE
  // register.
  const honest = drive(caseWithCertificate, readCertificate);
  assert.equal(honest.result.event, 'formalized', honest.result.production?.bindings?.settlementError);
  const warrant = honest.issued[0].payload.payload.warrantRef;
  assert.ok(warrant);
  assert.equal(warrant.constraintRegisterDigest, certificateRegister.registerDigest);
  assert.deepEqual(
    honest.persisted[0].constraintRegisterCoverage.entries.map(entry => entry.id),
    certificateRegister.constraints.map(entry => entry.id),
  );

  // The MUTANT (m6b): the case's register binding is supplied by the
  // proposal-payload rebuild (a divergent digest) instead of the one
  // certificate binding — a typed red at case admission.
  const rebuilt = resolveFormalizationCaseConstraintRegister(caseWithCertificate);
  assert.ok(rebuilt, 'the v1 fallback rebuild still resolves a DIFFERENT register from the payload drafts');
  assert.notEqual(rebuilt.constraintRegisterDigest, certificateRegister.registerDigest);
  const bypassed = drive({ ...caseWithCertificate, constraintRegister: rebuilt }, readCertificate);
  assert.equal(bypassed.result.event, 'failed');
  assert.match(bypassed.result.production.bindings.settlementError, /FORMALIZATION_REGISTER_BINDING_BYPASSED/);

  // A v2 certificate hash mismatch (a re-targeted certificate) is also a red.
  const hashMismatch = drive(
    caseWithCertificate,
    () => ({ id: 1, processRunId: 1, certificateHash: 'c'.repeat(64), certificatePayload }),
  );
  assert.equal(hashMismatch.result.event, 'failed');
  assert.match(hashMismatch.result.production.bindings.settlementError, /FORMALIZATION_DISCOVERY_CERTIFICATE_HASH_MISMATCH/);
});

test('space E — E5: the findings registry is well-formed and every uncovered boundary is registered', () => {
  assert.equal(FINDINGS.length, 5);
  for (const finding of FINDINGS) {
    assert.ok(finding.id && finding.boundary && finding.fed && finding.factorySaid && finding.shouldLive && finding.severity,
      `${finding.id} is missing a registry field`);
    assert.match(finding.shouldLive, /src\/.*\.ts:\d+/, `${finding.id} must cite file:line for the detector's home`);
  }
  // Every boundary whose lossDetected is not fully true must be registered.
  for (const row of CARRYING) {
    if (row.lossDetected === true) continue;
    assert.ok(FINDINGS.some(f => f.id === row.finding), `${row.id} is uncovered but not registered`);
  }
});

test('space E — E6: the boundary table (boundary → register present → loss detected)', () => {
  // Consistency between the two tables before printing.
  for (const carrying of CARRYING) {
    const boundary = BOUNDARIES.find(b => b.id === carrying.id);
    assert.ok(boundary, `carrying row ${carrying.id} has no boundary row`);
  }
  const cell = (value, width) => {
    const text = String(value);
    return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
  };
  const lines = [
    '[space E] constraint-loss boundary table (S4: upstream requirement absent downstream, no disposition)',
    ...CARRYING.map(row => {
      const detected = row.lossDetected === true
        ? 'YES' : row.lossDetected === false ? 'NO ' : 'SPLIT/PART';
      return `  ${row.id} ${cell(BOUNDARIES.find(b => b.id === row.id).boundary, 46)} register:${row.registerPresent === 'yes' || row.registerPresent.startsWith('yes') ? 'yes' : 'no '}  loss detected:${detected}${row.finding ? `  → ${row.finding}` : ''}`;
    }),
    `[space E] findings: ${FINDINGS.map(f => `${f.id} (${f.severity})`).join(', ')} — details in the FINDINGS registry; nothing was fixed (brief §2)`,
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
});
