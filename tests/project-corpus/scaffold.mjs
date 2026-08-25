/**
 * tests/project-corpus/scaffold.mjs - the shared descriptor scaffold of the
 * WP-13D project corpus: one builder per drive mode, closing over the
 * format contract so every descriptor validates by construction.
 */

import { PROJECT_CORPUS_FORMAT_VERSION } from './format.mjs';
import {
  authoredEvents,
  authoredEvidence,
  authoredProofs,
  authoredWaits,
  completedObligationsOf,
  createdObligationKinds,
  IDS,
} from './programs.mjs';

/** The completed lane obligations every settled loop must show. */
const LOOP_LANE_KINDS = [
  'obligation:launchAdmission',
  'obligation:providerSend',
  'obligation:submitContribution',
  'obligation:sealRevision',
  'obligation:presentCandidates',
];

/** A durable-session project descriptor. */
export function durableProject({
  projectId, projectKind, description, program, product, expectedInvariants, notes,
  faultSchedule = [], expectedRefusal, expectedWorldHeads, expectationPolicies = {}, justifications = {},
  seed = 20260825, topologyShape = 'chain', concurrencyCap = 1, allowedTools,
  expectedWaits, expectedObligations, expectedEvidence, expectedProofs, expectedEvents,
}) {
  const waits = expectedWaits ?? authoredWaits(program).map((kind) => ({ kind, state: waitStateOf(program, kind) }));
  return {
    formatVersion: PROJECT_CORPUS_FORMAT_VERSION,
    projectId,
    projectKind,
    description,
    product: product ?? { class: 'none', verification: 'none', fixture: null },
    drive: {
      mode: 'durable-session',
      comparison: { referenceSections: ['heads', 'obligations', 'waits', 'proofs'], expectationPolicies, justifications },
    },
    scenario: {
      identity: { capsuleId: `capsule:${projectId}` },
      seedInput: { fresh: true, seed, ingress: [] },
      topology: { shape: topologyShape, nodes: Object.values(IDS), edges: [], concurrencyCap },
      faultSchedule,
      expectations: {
        events: expectedEvents ?? authoredEvents(program),
        obligations: expectedObligations ?? completedObligationsOf(program, LOOP_LANE_KINDS),
        waits,
        proofs: expectedProofs ?? authoredProofs(program),
        evidence: expectedEvidence ?? authoredEvidence(program),
      },
      verification: product?.verification !== 'none' && product?.class !== 'none'
        ? { productCommands: productCommandsOf(product) }
        : { productCommands: [] },
      timeBudgets: { totalMs: 600000, perStepMs: 60000 },
      program: { steps: program, ...(allowedTools ? { allowedTools } : {}), expectAdmissionReceipts: true, seed },
    },
    expectedWorld: { heads: expectedWorldHeads, allowExtraHeads: true },
    expectedRefusal,
    expectedInvariants,
    ...(notes ? { notes } : {}),
  };
}

/** A planning-conveyor project descriptor. */
export function conveyorProject({
  projectId, projectKind, description, conveyorTopology, product, expectedInvariants, notes,
  expectedWorldHeads, expectations, expectationPolicies = {}, justifications = {},
}) {
  return {
    formatVersion: PROJECT_CORPUS_FORMAT_VERSION,
    projectId,
    projectKind,
    description,
    product: product ?? { class: 'none', verification: 'none', fixture: null },
    drive: {
      mode: 'planning-conveyor',
      conveyorTopology,
      comparison: { referenceSections: [], expectationPolicies, justifications },
    },
    scenario: {
      identity: { capsuleId: `capsule:${projectId}` },
      seedInput: { fresh: true, seed: 20260825, ingress: [] },
      topology: topologyOf(conveyorTopology),
      faultSchedule: [],
      expectations,
      verification: product?.verification !== 'none' && product?.class !== 'none'
        ? { productCommands: productCommandsOf(product) }
        : { productCommands: [] },
      timeBudgets: { totalMs: 600000, perStepMs: 60000 },
    },
    expectedWorld: { heads: expectedWorldHeads, allowExtraHeads: true },
    expectedInvariants,
    ...(notes ? { notes } : {}),
  };
}

/** A development-vertical project descriptor. */
export function developmentProject({
  projectId, projectKind, description, product, expectedInvariants, notes,
  expectedWorldHeads, expectations, expectationPolicies = {}, justifications = {},
}) {
  return {
    formatVersion: PROJECT_CORPUS_FORMAT_VERSION,
    projectId,
    projectKind,
    description,
    product,
    drive: {
      mode: 'development-vertical',
      comparison: { referenceSections: [], expectationPolicies, justifications },
    },
    scenario: {
      identity: { capsuleId: `capsule:${projectId}` },
      seedInput: { fresh: true, seed: 20260825, ingress: [] },
      topology: { shape: 'chain', nodes: ['factory-run:1', 'lifecycle-run:1', 'stage-run:1', 'process-run:1', 'workplace:1'], edges: [], concurrencyCap: 1 },
      faultSchedule: [],
      expectations,
      verification: { productCommands: productCommandsOf(product) },
      timeBudgets: { totalMs: 900000, perStepMs: 120000 },
    },
    expectedWorld: { heads: expectedWorldHeads, allowExtraHeads: true },
    expectedInvariants,
    ...(notes ? { notes } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Small shared derivations                                            */
/* ------------------------------------------------------------------ */

function waitStateOf(program, kind) {
  if (kind === 'TypedWait:human-input') return 'discharged'; // the scripted operator resolves
  if (kind === 'TypedWait:effect-uncertainty') return 'pending'; // the D12 operator disposition stays outstanding
  if (kind === 'TypedWait:external-availability') return 'discharged'; // the same-intent retry discharges the classification wait
  return 'pending';
}

function productCommandsOf(product) {
  if (product?.fixture === 'simple-server') {
    return ['node scripts/build.mjs', 'node verify/loopback.mjs', 'node verify/browser-smoke.mjs'];
  }
  if (product?.fixture === 'static-site') {
    return ['node scripts/build.mjs', 'node verify/structure.mjs', 'node scripts/build.mjs (determinism)'];
  }
  if (product?.fixture === 'batch-report') {
    return ['node scripts/build.mjs', 'node scripts/build.mjs (determinism)'];
  }
  return [];
}

function topologyOf(topology) {
  const shapes = {
    chain: { shape: 'chain', edges: [['work-item:a', 'work-item:b'], ['work-item:b', 'work-item:c']] },
    diamond: { shape: 'diamond', edges: [['work-item:a', 'work-item:b'], ['work-item:a', 'work-item:c'], ['work-item:b', 'work-item:d'], ['work-item:c', 'work-item:d']] },
    'fan-in': { shape: 'fan-in', edges: [['work-item:a', 'work-item:c'], ['work-item:b', 'work-item:c']] },
    'fan-out': { shape: 'fan-out', edges: [['work-item:a', 'work-item:b'], ['work-item:a', 'work-item:c']] },
    independent: { shape: 'none', edges: [] },
    'failed-predecessor': { shape: 'failed-predecessor', edges: [['work-item:a', 'work-item:b']] },
  };
  const entry = shapes[topology] ?? { shape: 'none', edges: [] };
  const nodes = {
    chain: ['work-item:a', 'work-item:b', 'work-item:c'],
    diamond: ['work-item:a', 'work-item:b', 'work-item:c', 'work-item:d'],
    'fan-in': ['work-item:a', 'work-item:b', 'work-item:c'],
    'fan-out': ['work-item:a', 'work-item:b', 'work-item:c'],
    independent: ['work-item:a', 'work-item:b'],
    'failed-predecessor': ['work-item:a', 'work-item:b'],
  }[topology] ?? [];
  return { shape: entry.shape, nodes, edges: entry.edges, concurrencyCap: topology === 'independent' ? 2 : 1 };
}

/** The conveyor-mode expectations common to a fully settled topology. */
export function conveyorExpectations({ cells, failure = false }) {
  const n = failure ? 1 : cells.length; // the failing topology desks exactly one cell
  const repeat = (kind, count) => Array.from({ length: count }, () => kind);
  const workplaceProofs = cells.map((item) => failure && item === 'a'
    ? 'TerminalProof:workplace.truthful-failure'
    : failure && item !== 'a'
      ? 'TerminalProof:workplace.unreachable'
      : 'TerminalProof:workplace.success');
  const proofs = [...new Set([
    ...workplaceProofs,
    ...(failure
      ? ['TerminalProof:node.truthful-failure', 'TerminalProof:process.truthful-failure', 'TerminalProof:stage.truthful-failure', 'TerminalProof:lifecycle.truthful-failure', 'TerminalProof:run.truthful-failure', 'TerminalProof:node.unreachable']
      : ['TerminalProof:cell.success', 'TerminalProof:node.success', 'TerminalProof:process.success', 'TerminalProof:stage.success', 'TerminalProof:lifecycle.success', 'TerminalProof:run.success']),
  ])].sort();
  /* Per-cell desk structure: one author round + one reviewer round ->
     2 contributions, 2 sealed revisions, 2 presentations (BOTH candidate
                     kinds each), 2 accepted gates, 1 cell acceptance, 1
     settled effect. Authored from the universe production table. */
  const gate = failure ? ['GateDecision:accepted', 'GateDecision:repair'] : repeat('GateDecision:accepted', 2 * n);
  const material = failure
    ? [
        ...repeat('WorkplaceProductionRevision', 2),
        ...repeat('CandidateSet:author', 2),
        ...repeat('CandidateSet:reviewer', 2),
        ...repeat('ActivityAttemptContribution', 2),
        'AcceptedCandidateAuthority',
      ]
    : [
        ...repeat('WorkplaceProductionRevision', 2 * n),
        ...repeat('CandidateSet:author', 2 * n),
        ...repeat('CandidateSet:reviewer', 2 * n),
        ...repeat('ActivityAttemptContribution', 2 * n),
        ...repeat('AcceptedCandidateAuthority', 2 * n),
        ...repeat('CellFinalAcceptance', n),
      ];
  const effect = failure ? [] : repeat('EffectReceipt:success', n);
  return {
    events: failure
      ? ['WorkflowEvent:stageRun.localOutcomeRecorded', 'WorkflowEvent:lifecycleRun.outcomeRouted', 'WorkflowEvent:lifecycleRun.terminalProven', 'WorkflowEvent:factoryRun.runTerminalProven']
      : repeat('WorkflowEvent:workplace.materialized', n).concat(
        ['WorkflowEvent:stageRun.localOutcomeRecorded', 'WorkflowEvent:lifecycleRun.outcomeRouted', 'WorkflowEvent:lifecycleRun.terminalProven', 'WorkflowEvent:factoryRun.runTerminalProven'],
      ),
    obligations: [],
    waits: [],
    proofs,
    evidence: { material, gate, effect },
  };
}

/** The dev-vertical expectations of a settled material chain (authored
 *  from the chain structure: one author round + one reviewer round -> 2
 *  contributions, 2 sealed revisions, 2 presentations, 2 accepted gates,
 *  1 cell acceptance, 1 settled effect). */
export function developmentExpectations() {
  const repeat = (kind, count) => Array.from({ length: count }, () => kind);
  return {
    events: ['WorkflowEvent:factoryRun.capsuleImported', 'WorkflowEvent:workplace.materialized', 'WorkflowEvent:workplace.terminalProven'],
    obligations: [],
    waits: [],
    proofs: ['TerminalProof:cell.success', 'TerminalProof:workplace.success', 'TerminalProof:node.success', 'TerminalProof:process.success', 'TerminalProof:stage.success', 'TerminalProof:lifecycle.success', 'TerminalProof:run.success'],
    evidence: {
      material: [
        ...repeat('ActivityAttemptContribution', 2),
        ...repeat('WorkplaceProductionRevision', 2),
        ...repeat('CandidateSet:author', 2),
        ...repeat('CandidateSet:reviewer', 2),
        ...repeat('AcceptedCandidateAuthority', 2),
        'CellFinalAcceptance',
      ],
      gate: repeat('GateDecision:accepted', 2),
      effect: ['EffectReceipt:success'],
    },
  };
}

export { IDS };
