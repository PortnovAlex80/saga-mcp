/**
 * workflow-kernel/workshops/development/checkplans.ts - the installed
 * CHECKPLANS and SEMANTIC GATES of the converted workshop (WP-11V, plan
 * EK-8; R15: the CheckPlan is installed-manifest data, an external Input
 * authority the kernel's gate guards require).
 *
 * Gates are DATA + one pure evaluator:
 *   - author gate   (workplace.runAuthorGate): machine checks over the
 *     integrated candidate (scope coverage, product contract shape,
 *     acceptance-contract presence);
 *   - final gate    (workplace.runFinalGate): machine checks over the
 *     reviewer verdict payload (verification evidence, monotonicity);
 *   - certification gate (the effect settlement the freeze waits on): the
 *     readiness check is OPERATOR-ONLY - the machine cannot observe
 *     readiness-for-certification (the Elite-2 class), so the declared
 *     rule yields human-wait and the kernel's typed wait carries the
 *     operator disposition (D5/D12 discipline).
 *
 * The evaluator never invents a verdict: it walks the DECLARED rule rows
 * in order and returns the first match, or terminal-reject when no machine
 * rule matches an all-machine check set. The kernel's own guards remain
 * the authority (a gate without CheckPlan evidence is refused by the
 * kernel - the gate-bypass fence).
 *
 * PURITY: pure functions over declared data. No I/O, no session.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { EvidenceFact } from '../../domain/types.js';
import type {
  CheckPlanRow,
  GateDeclaration,
  GateVerdictRule,
} from './installation.js';
import { gateVerdictVocabulary } from './installation.js';

/* ------------------------------------------------------------------ */
/* The installed CheckPlan rows                                        */
/* ------------------------------------------------------------------ */

export const AUTHOR_GATE_ID = 'development.author';
export const FINAL_GATE_ID = 'development.final';
export const CERTIFICATION_GATE_ID = 'development.certification';

function checkRow(row: Omit<CheckPlanRow, 'contentRef' | 'digest'> & { readonly content: unknown }): CheckPlanRow {
  const digest = sha256OfCanonical(row.content);
  return {
    checkId: row.checkId,
    gate: row.gate,
    evaluator: row.evaluator,
    contentRef: `sha256:${digest}`,
    digest,
  };
}

/** The complete installed CheckPlan of the workshop (content-addressed rows). */
export function developmentCheckPlanRows(): readonly CheckPlanRow[] {
  return [
    checkRow({
      checkId: 'development.check.scope-coverage',
      gate: AUTHOR_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'every capsule requirement scope ref of the task projection is covered by the integrated candidate',
        inputProduct: 'workshop.development.integrated-candidate.v1',
      },
    }),
    checkRow({
      checkId: 'development.check.product-contract-shape',
      gate: AUTHOR_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'the candidate product digest verifies against the acceptance contract surfaces',
        inputProduct: 'workshop.development.integrated-candidate.v1',
      },
    }),
    checkRow({
      checkId: 'development.check.verification-evidence',
      gate: FINAL_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'independent ProductVerificationEvidence exists for the candidate material (R5)',
        inputProduct: 'workshop.development.review-verdict-payload.v1',
      },
    }),
    checkRow({
      checkId: 'development.check.verdict-monotonicity',
      gate: FINAL_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'the reviewer verdict payload is non-empty and its tool record digest is present (no prose-only verdict)',
        inputProduct: 'workshop.development.review-verdict-payload.v1',
      },
    }),
    checkRow({
      checkId: 'development.check.readiness-for-certification',
      gate: CERTIFICATION_GATE_ID,
      evaluator: 'operator',
      content: {
        rule: 'readiness of the frozen product for certification: the machine carries the verification evidence but CANNOT observe the readiness disposition (Elite-2); an operator must dispose it',
        inputProduct: 'workshop.development.readiness-manifest.v1',
        wake: 'TypedWait:human-input via the effect settlement, discharged by the operator disposition command',
      },
    }),
  ];
}

/** The CheckPlan evidence facts the driver injects as external Input authority (R15). */
export function developmentCheckPlanEvidence(): readonly EvidenceFact[] {
  return developmentCheckPlanRows().map((row) => ({
    kind: 'CheckPlan' as const,
    ref: `checkplan:${row.checkId}#${row.digest.slice(0, 16)}`,
    producer: 'external-input',
    payloadDigest: row.digest,
  }));
}

/* ------------------------------------------------------------------ */
/* The declared semantic gates                                         */
/* ------------------------------------------------------------------ */

/**
 * The declared gates of the workshop. Every kernel-facing name (command,
 * evidence kind, verdict, wait kind) is validated against the frozen
 * universe by validateWorkshopInstallation; the verdict vocabulary is the
 * DERIVED frozen five.
 */
export function developmentGateDeclarations(): readonly GateDeclaration[] {
  const verdicts = gateVerdictVocabulary();
  return [
    {
      gateId: AUTHOR_GATE_ID,
      command: 'workplace.runAuthorGate',
      requiredEvidenceKinds: ['CandidateSet:author', 'CheckPlan'],
      verdictVocabulary: verdicts,
      rules: [
        { when: { checkId: 'development.check.scope-coverage', outcome: 'pass' }, verdict: 'accepted' },
        { when: { checkId: 'development.check.product-contract-shape', outcome: 'fail' }, verdict: 'repair' },
      ],
    },
    {
      gateId: FINAL_GATE_ID,
      command: 'workplace.runFinalGate',
      requiredEvidenceKinds: ['CandidateSet:reviewer', 'CheckPlan'],
      verdictVocabulary: verdicts,
      rules: [
        { when: { checkId: 'development.check.verification-evidence', outcome: 'pass' }, verdict: 'accepted' },
        { when: { checkId: 'development.check.verification-evidence', outcome: 'fail' }, verdict: 'terminal-reject' },
        { when: { checkId: 'development.check.verdict-monotonicity', outcome: 'fail' }, verdict: 'repair' },
      ],
    },
    {
      gateId: CERTIFICATION_GATE_ID,
      command: 'workplace.settleEffect',
      requiredEvidenceKinds: ['AcceptedCandidateAuthority', 'CheckPlan'],
      verdictVocabulary: verdicts,
      waitOn: { verdict: 'human-wait', waitKind: 'TypedWait:human-input' },
      rules: [
        // The Elite-2 class: the readiness check is operator-only, so the
        // declared rule yields human-wait - the machine never certifies
        // readiness itself and never skips the wait.
        { when: { checkId: 'development.check.readiness-for-certification', outcome: 'operator-only' }, verdict: 'human-wait' },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The pure gate evaluator                                             */
/* ------------------------------------------------------------------ */

/** One check result row fed to the evaluator (produced by the machine checks or scripted actors). */
export interface CheckResult {
  readonly checkId: string;
  readonly outcome: 'pass' | 'fail' | 'operator-only';
}

export type GateEvaluation =
  | { readonly decided: true; readonly verdict: string; readonly rule: GateVerdictRule }
  | { readonly refused: true; readonly code: 'GATE_RULES_CANNOT_DECIDE' | 'GATE_UNKNOWN_CHECK'; readonly detail: string };

/**
 * Evaluate one declared gate over its check results: the FIRST matching
 * declared rule wins; no machine rule matching an operator-only check set
 * is refused typed (never a default verdict, never an invented one).
 */
export function evaluateSemanticGate(gate: GateDeclaration, results: readonly CheckResult[]): GateEvaluation {
  const known = new Set(gate.rules.map((rule) => rule.when.checkId));
  for (const result of results) {
    if (!known.has(result.checkId)) {
      return { refused: true, code: 'GATE_UNKNOWN_CHECK', detail: `check ${result.checkId} is outside gate ${gate.gateId}'s declared rules` };
    }
  }
  for (const rule of gate.rules) {
    const result = results.find((entry) => entry.checkId === rule.when.checkId);
    if (result === undefined) continue;
    if (result.outcome === rule.when.outcome) {
      return { decided: true, verdict: rule.verdict, rule };
    }
  }
  return {
    refused: true,
    code: 'GATE_RULES_CANNOT_DECIDE',
    detail: `no declared rule of gate ${gate.gateId} matches the check results [${results.map((entry) => `${entry.checkId}:${entry.outcome}`).join(', ')}]; an undecided gate never defaults`,
  };
}
