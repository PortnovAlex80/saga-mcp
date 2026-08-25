/**
 * workflow-kernel/workshops/synthetic/installation.ts - the SYNTHETIC
 * NON-GAME WORKSHOP of the EK-8 generalization proof (WP-11V): a
 * report-generator workshop installed as PURE DATA over the SAME frozen
 * kernel - no new kernel transition kind, table, driver or reconciler.
 *
 * What this package is:
 *   - manifest + mapping + CheckPlan DATA (this file, products.ts,
 *     bindings.ts): identity, product schemas, installed skills/tools/
 *     hooks, check rows, gate rows, effect rows, wait rows, and role
 *     bindings compiled through the SAME one compilation path over rows
 *     that validate against the SAME frozen schema;
 *   - a thin scenario entry (scenario.ts) that wires THIS data into the
 *     SAME kernel composition (the WP-07 obligation consumer, the sole-
 *     writer repositories, the WP-09 durable topology bindings and the
 *     WP-08 staged vertical) - the package contains no driver of its own.
 *
 * What this package is NOT:
 *   - it imports NO other workshop package (independence is asserted by
 *     tests/workflow-kernel/workshops/synthetic/structure.test.mjs);
 *   - it never names a kernel kind that is not in the frozen registries
 *     (validate-by-the-development-validator is cross-asserted in tests;
 *     a new kind is the synthetic kernel-modification mutation and is
 *     refused);
 *   - it holds no SQL, no private table, no scheduler, no reconciler.
 *
 * The lifecycle family class value of the manifest rows is READ from the
 * frozen role-contract manifest (single source) - a report generator is a
 * documentation-class cell producer - never restated as a source literal
 * (the EK-2 dimension workshops.nameBranchLiterals stays zero).
 *
 * PURITY: pure data builders. No I/O, no session, no clock.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { EffectOutcome, GateVerdict } from '../../domain/types.js';
import type { CommandName, EvidenceKind, WaitKind } from '../../domain/universe.js';
import { EVIDENCE_KINDS } from '../../domain/universe.js';

/* ------------------------------------------------------------------ */
/* The local installation shape (structurally the workshop interface)   */
/* ------------------------------------------------------------------ */

export interface SyntheticProductField {
  readonly name: string;
  readonly kind: 'string' | 'digest' | 'ref' | 'ref-list' | 'enum' | 'boolean';
  /** For kind=enum: the closed value set (data, never a kernel vocabulary). */
  readonly values?: readonly string[];
  readonly required: boolean;
}

export interface SyntheticProductSchema {
  readonly schemaId: string;
  readonly role: 'input' | 'output';
  readonly phase: string;
  readonly fields: readonly SyntheticProductField[];
}

export interface SyntheticCheckRow {
  readonly checkId: string;
  readonly gate: string;
  readonly evaluator: 'machine' | 'operator';
  readonly contentRef: string;
  readonly digest: string;
}

export interface SyntheticGateRule {
  readonly when: { readonly checkId: string; readonly outcome: 'pass' | 'fail' | 'operator-only' };
  readonly verdict: GateVerdict;
}

export interface SyntheticGate {
  readonly gateId: string;
  readonly command: CommandName;
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
  readonly verdictVocabulary: readonly GateVerdict[];
  readonly waitOn?: { readonly verdict: GateVerdict; readonly waitKind: WaitKind };
  readonly rules: readonly SyntheticGateRule[];
}

export interface SyntheticEffect {
  readonly effectId: string;
  readonly command: CommandName;
  readonly idempotencyKeyRule: string;
  readonly outcomes: readonly EffectOutcome[];
  readonly idempotentResumeOutcome: 'already-applied';
  readonly verificationEvidenceKind: EvidenceKind;
}

export interface SyntheticWait {
  readonly purpose: string;
  readonly kind: WaitKind;
  readonly wakeCommands: readonly CommandName[];
  readonly operatorDispositionRequired: boolean;
  readonly rationale: string;
}

/** The synthetic workshop installation (the same semantic interface shape, declared independently). */
export interface SyntheticReportingInstallation {
  readonly identity: {
    readonly workshopId: string;
    readonly workshopClass: string;
    readonly version: string;
    readonly processModuleRef: string;
  };
  readonly products: readonly SyntheticProductSchema[];
  readonly installed: {
    readonly skills: readonly { readonly skillId: string; readonly instructionsRef: string; readonly digest: string }[];
    readonly tools: readonly { readonly toolRef: string; readonly schemaSummary: string }[];
    readonly hooks: readonly { readonly event: string; readonly additionalContextRef: string; readonly digest: string }[];
  };
  readonly checkPlans: readonly SyntheticCheckRow[];
  readonly gates: readonly SyntheticGate[];
  readonly effects: readonly SyntheticEffect[];
  readonly waits: readonly SyntheticWait[];
}

/* ------------------------------------------------------------------ */
/* Derived vocabularies (single source: the frozen evidence registry)  */
/* ------------------------------------------------------------------ */

const gateVerdicts = (): readonly GateVerdict[] =>
  EVIDENCE_KINDS.filter((kind) => kind.startsWith('GateDecision:')).map((kind) => kind.slice('GateDecision:'.length) as GateVerdict);

const effectOutcomes = (): readonly EffectOutcome[] =>
  EVIDENCE_KINDS.filter((kind) => kind.startsWith('EffectReceipt:')).map((kind) => kind.slice('EffectReceipt:'.length) as EffectOutcome);

/* ------------------------------------------------------------------ */
/* The installed data                                                  */
/* ------------------------------------------------------------------ */

export const SYNTHETIC_AUTHOR_GATE_ID = 'synthetic-reporting.author';
export const SYNTHETIC_FINAL_GATE_ID = 'synthetic-reporting.final';
export const SYNTHETIC_READINESS_GATE_ID = 'synthetic-reporting.readiness';

function checkRow(row: { readonly checkId: string; readonly gate: string; readonly evaluator: 'machine' | 'operator'; readonly content: unknown }): SyntheticCheckRow {
  const digest = sha256OfCanonical(row.content);
  return { checkId: row.checkId, gate: row.gate, evaluator: row.evaluator, contentRef: `sha256:${digest}`, digest };
}

/** The complete synthetic workshop installation (pure data). */
export function syntheticReportingInstallation(): SyntheticReportingInstallation {
  return {
    identity: {
      workshopId: 'workshop:synthetic-reporting',
      workshopClass: 'reporting-cell-class',
      version: 'ek.workshop-installation.ek8.v1',
      processModuleRef: 'content://process-modules/synthetic-reporting-cell@ek8',
    },
    products: [
      {
        schemaId: 'workshop.synthetic-reporting.report-draft.v1',
        role: 'input',
        phase: 'review',
        fields: [
          { name: 'capsuleRef', kind: 'string', required: true },
          { name: 'datasetDigest', kind: 'digest', required: true },
          { name: 'reportDigest', kind: 'digest', required: true },
          { name: 'sectionRefs', kind: 'ref-list', required: true },
        ],
      },
      {
        schemaId: 'workshop.synthetic-reporting.publication-readiness.v1',
        role: 'input',
        phase: 'certification',
        fields: [
          { name: 'capsuleRef', kind: 'string', required: true },
          { name: 'workplaceInstanceId', kind: 'string', required: true },
          { name: 'machineObservation', kind: 'enum', values: ['report-verified', 'report-verification-failed'], required: true },
          { name: 'unobservable', kind: 'enum', values: ['publication-readiness'], required: true },
        ],
      },
      {
        schemaId: 'workshop.synthetic-reporting.published-report.v1',
        role: 'output',
        phase: 'verified',
        fields: [
          { name: 'capsuleRef', kind: 'string', required: true },
          { name: 'acceptanceDigest', kind: 'digest', required: true },
          { name: 'terminalProofs', kind: 'ref-list', required: true },
          { name: 'runTerminalOutcome', kind: 'enum', values: ['success'], required: true },
        ],
      },
    ],
    installed: {
      skills: [
        {
          skillId: 'synthetic-reporting.skill.report-author',
          instructionsRef: `sha256:${sha256OfCanonical({ skillId: 'synthetic-reporting.skill.report-author', instructions: 'Render the dataset into the report skeleton; cite every section ref; never invent a section.' })}`,
          digest: sha256OfCanonical({ skillId: 'synthetic-reporting.skill.report-author', instructions: 'Render the dataset into the report skeleton; cite every section ref; never invent a section.' }),
        },
        {
          skillId: 'synthetic-reporting.skill.report-reviewer',
          instructionsRef: `sha256:${sha256OfCanonical({ skillId: 'synthetic-reporting.skill.report-reviewer', instructions: 'Check the draft against the dataset digest and the section refs; return one frozen verdict.' })}`,
          digest: sha256OfCanonical({ skillId: 'synthetic-reporting.skill.report-reviewer', instructions: 'Check the draft against the dataset digest and the section refs; return one frozen verdict.' }),
        },
      ],
      tools: [
        { toolRef: 'tool:read-dataset', schemaSummary: '(ref) -> rows (bounded)' },
        { toolRef: 'tool:render-section', schemaSummary: '(sectionRef, rows) -> markdown' },
        { toolRef: 'tool:verify-report', schemaSummary: '() -> ProductVerificationEvidence|ProductVerificationFailure' },
      ],
      hooks: [
        {
          event: 'SessionStart',
          additionalContextRef: `sha256:${sha256OfCanonical({ event: 'SessionStart', inject: 'workshop:synthetic-reporting CheckPlan summary + dataset refs' })}`,
          digest: sha256OfCanonical({ event: 'SessionStart', inject: 'workshop:synthetic-reporting CheckPlan summary + dataset refs' }),
        },
      ],
    },
    checkPlans: [
      checkRow({
        checkId: 'synthetic-reporting.check.section-coverage',
        gate: SYNTHETIC_AUTHOR_GATE_ID,
        evaluator: 'machine',
        content: { rule: 'every section ref of the dataset snapshot appears in the report draft' },
      }),
      checkRow({
        checkId: 'synthetic-reporting.check.dataset-digest-match',
        gate: SYNTHETIC_FINAL_GATE_ID,
        evaluator: 'machine',
        content: { rule: 'the draft cites the exact dataset digest (no stale dataset)' },
      }),
      checkRow({
        checkId: 'synthetic-reporting.check.publication-readiness',
        gate: SYNTHETIC_READINESS_GATE_ID,
        evaluator: 'operator',
        content: { rule: 'publication readiness of the rendered report is operator-only (Elite-2 class, same as every workshop)' },
      }),
    ],
    gates: [
      {
        gateId: SYNTHETIC_AUTHOR_GATE_ID,
        command: 'workplace.runAuthorGate',
        requiredEvidenceKinds: ['CandidateSet:author', 'CheckPlan'],
        verdictVocabulary: gateVerdicts(),
        rules: [
          { when: { checkId: 'synthetic-reporting.check.section-coverage', outcome: 'pass' }, verdict: 'accepted' },
          { when: { checkId: 'synthetic-reporting.check.section-coverage', outcome: 'fail' }, verdict: 'repair' },
        ],
      },
      {
        gateId: SYNTHETIC_FINAL_GATE_ID,
        command: 'workplace.runFinalGate',
        requiredEvidenceKinds: ['CandidateSet:reviewer', 'CheckPlan'],
        verdictVocabulary: gateVerdicts(),
        rules: [
          { when: { checkId: 'synthetic-reporting.check.dataset-digest-match', outcome: 'pass' }, verdict: 'accepted' },
          { when: { checkId: 'synthetic-reporting.check.dataset-digest-match', outcome: 'fail' }, verdict: 'repair' },
        ],
      },
      {
        gateId: SYNTHETIC_READINESS_GATE_ID,
        command: 'workplace.settleEffect',
        requiredEvidenceKinds: ['AcceptedCandidateAuthority', 'CheckPlan'],
        verdictVocabulary: gateVerdicts(),
        waitOn: { verdict: 'human-wait', waitKind: 'TypedWait:human-input' },
        rules: [
          { when: { checkId: 'synthetic-reporting.check.publication-readiness', outcome: 'operator-only' }, verdict: 'human-wait' },
        ],
      },
    ],
    effects: [
      {
        effectId: 'synthetic-reporting.publication',
        command: 'workplace.settleEffect',
        idempotencyKeyRule: 'workshop:synthetic-reporting:effect:<capsuleRef> (deterministic per capsule)',
        outcomes: effectOutcomes(),
        idempotentResumeOutcome: 'already-applied',
        verificationEvidenceKind: 'ProductVerificationEvidence',
      },
    ],
    waits: [
      {
        purpose: 'publication.readiness',
        kind: 'TypedWait:human-input',
        wakeCommands: ['workplace.resolveHumanResponse'],
        operatorDispositionRequired: true,
        rationale: 'Elite-2 class shared by every workshop: publication readiness is operator-only; the effect resumes already-applied after the disposition',
      },
      {
        purpose: 'publication.uncertainty',
        kind: 'TypedWait:effect-uncertainty',
        wakeCommands: ['workplace.resolveHumanResponse'],
        operatorDispositionRequired: true,
        rationale: 'D12 shared by every workshop: an uncertain publication effect wakes only on an operator disposition receipt',
      },
    ],
  };
}

/** The synthetic workshop's CheckPlan evidence facts (R15 external Input authority). */
export function syntheticCheckPlanEvidence(): readonly { readonly kind: 'CheckPlan'; readonly ref: string; readonly producer: string; readonly payloadDigest: string }[] {
  return syntheticReportingInstallation().checkPlans.map((row) => ({
    kind: 'CheckPlan' as const,
    ref: `checkplan:${row.checkId}#${row.digest.slice(0, 16)}`,
    producer: 'external-input',
    payloadDigest: row.digest,
  }));
}
