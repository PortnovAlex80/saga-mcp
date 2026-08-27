/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * checkplan.ts - the CHECKPLAN, the DECLARED DETERMINISTIC PROVIDERS and
 * the semantic gate of the derive-system-requirements Production Cell
 * (FRF-WP05).
 *
 * Laws implemented here:
 *   - Every check is a DECLARED, deterministic, content-addressed CheckPlan
 *     row (R15: installed-manifest input evidence). An undeclared check id
 *     fed to the gate is a typed refusal (GATE_UNKNOWN_CHECK); a result set
 *     that omits one of the gate's declared checks is a typed refusal
 *     (GATE_CHECK_MISSING) - the VALIDATOR-BYPASS fence: the gate can
 *     never accept a bundle whose wp03-validation row is missing.
 *   - The validation check runs the WP03 requirements-bundle validator
 *     through the documented seam (./seam.ts). When the seam is unbound or
 *     fails its fail-closed binding, the check is INDETERMINATE and the
 *     gate's declared rule yields human-wait on the D5 typed wait
 *     TypedWait:human-input (discharged via workplace.resolveHumanResponse)
 *     - never a silent pass, never a fallback validator.
 *   - The gate verdict vocabulary is the kernel's frozen five; the verdict
 *     is a pure function of (declared rules, check results) with
 *     first-match-wins and no default verdict.
 *   - The declared provider is derived from the INSTALLED manifest row of
 *     the desk (fail-closed when the desk or its provider is not
 *     installed) and is digest-verified before it may gate anything
 *     (an impostor provider never runs).
 *
 * PURITY: pure functions over declared data. No session, no SQL, no clock.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import type { EvidenceFact } from '../../../../domain/types.js';
import { checkProviderOfDesk } from '../../manifest.js';
import {
  REQUIREMENT_KINDS,
  REQUIREMENTS_BUNDLE_CONTRACT_KIND,
  SYSTEM_REQUIREMENTS_DESK_ID,
  SYSTEM_REQUIREMENTS_PRODUCT_KIND,
  SYSTEM_REQUIREMENTS_STRUCTURE_PROVIDER_ID,
} from './contract.js';
import type {
  RequirementMember,
  RequirementsBundle,
  RequirementsRefusalReason,
  RequirementsUniverse,
} from './contract.js';
import { fenceCandidateScope } from './bundle.js';
import type { SeamBinding } from './seam.js';

/* ------------------------------------------------------------------ */
/* The declared deterministic provider                                 */
/* ------------------------------------------------------------------ */

/**
 * The cell's declared check provider: the installed manifest row of the
 * desk, extended with the WP03 payload-contract binding this cell gates
 * through. The providerDigest is RECOMPUTED over the extended declaration
 * (never copied from the installed row), so an impostor declaration
 * cannot reuse the installed digest.
 */
export interface SystemRequirementsProviderDeclaration {
  readonly providerId: typeof SYSTEM_REQUIREMENTS_STRUCTURE_PROVIDER_ID;
  readonly version: string;
  readonly providerDigest: string;
  readonly nodeId: typeof SYSTEM_REQUIREMENTS_DESK_ID;
  readonly productKind: typeof SYSTEM_REQUIREMENTS_PRODUCT_KIND;
  /** The pure validator this provider gates through (the seam target). */
  readonly validator: 'wp03:validateRequirementsBundle';
  readonly wp03ContractKind: typeof REQUIREMENTS_BUNDLE_CONTRACT_KIND;
  readonly repairTargetRole: 'author';
}

/**
 * Resolve the declared provider of the cell from the INSTALLED manifest
 * (fail-closed: the desk and its structure provider must be installed;
 * this cell adds the WP03 contract binding on top, it never substitutes a
 * provider).
 */
export function declaredSystemRequirementsProvider():
  | { readonly ok: true; readonly provider: SystemRequirementsProviderDeclaration }
  | { readonly ok: false; readonly detail: string } {
  const installed = checkProviderOfDesk(SYSTEM_REQUIREMENTS_DESK_ID);
  if (!installed.ok) return { ok: false, detail: installed.detail };
  if (installed.provider.providerId !== SYSTEM_REQUIREMENTS_STRUCTURE_PROVIDER_ID) {
    return { ok: false, detail: `desk ${SYSTEM_REQUIREMENTS_DESK_ID} pins provider ${installed.provider.providerId}, the cell binds ${SYSTEM_REQUIREMENTS_STRUCTURE_PROVIDER_ID}` };
  }
  const provider: SystemRequirementsProviderDeclaration = {
    providerId: SYSTEM_REQUIREMENTS_STRUCTURE_PROVIDER_ID,
    version: installed.provider.version,
    providerDigest: '',
    nodeId: SYSTEM_REQUIREMENTS_DESK_ID,
    productKind: SYSTEM_REQUIREMENTS_PRODUCT_KIND,
    validator: 'wp03:validateRequirementsBundle',
    wp03ContractKind: REQUIREMENTS_BUNDLE_CONTRACT_KIND,
    repairTargetRole: 'author',
  };
  const providerDigest = sha256OfCanonical({
    providerId: provider.providerId,
    version: provider.version,
    nodeId: provider.nodeId,
    productKind: provider.productKind,
    validator: provider.validator,
    wp03ContractKind: provider.wp03ContractKind,
    repairTargetRole: provider.repairTargetRole,
  });
  return { ok: true, provider: { ...provider, providerDigest } };
}

/**
 * Verify one provider declaration against the cell's declared provider
 * (the impostor fence: a tampered digest, kind or validator never gates).
 */
export function verifySystemRequirementsProvider(provider: SystemRequirementsProviderDeclaration): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const declared = declaredSystemRequirementsProvider();
  if (!declared.ok) return { ok: false, detail: declared.detail };
  if (
    provider.providerDigest !== declared.provider.providerDigest ||
    provider.providerId !== declared.provider.providerId ||
    provider.productKind !== declared.provider.productKind ||
    provider.validator !== declared.provider.validator ||
    provider.wp03ContractKind !== declared.provider.wp03ContractKind
  ) {
    return { ok: false, detail: `provider ${String(provider.providerId)} does not verify against the cell's declared provider (an undeclared or tampered provider never gates a requirements bundle)` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The CheckPlan rows                                                  */
/* ------------------------------------------------------------------ */

export const SYSTEM_REQUIREMENTS_FINAL_GATE_ID = 'system-requirements.final' as const;

/** The check ids of the cell's CheckPlan (the closed declared set). */
export const SYSTEM_REQUIREMENTS_CHECK_IDS = [
  'system-requirements.check.product-kind',
  'system-requirements.check.requirement-kind-vocabulary',
  'system-requirements.check.derivation-lineage',
  'system-requirements.check.verification-surface-coverage',
  'system-requirements.check.revision-pins',
  'system-requirements.check.wp03-validation',
] as const;
export type SystemRequirementsCheckId = (typeof SYSTEM_REQUIREMENTS_CHECK_IDS)[number];

/** One content-addressed CheckPlan row. */
export interface CheckPlanRow {
  readonly checkId: SystemRequirementsCheckId;
  readonly gate: typeof SYSTEM_REQUIREMENTS_FINAL_GATE_ID;
  readonly evaluator: 'machine';
  readonly contentRef: string;
  readonly digest: string;
  readonly content: { readonly rule: string; readonly inputProduct: string };
}

function checkRow(checkId: SystemRequirementsCheckId, rule: string): CheckPlanRow {
  const content = { rule, inputProduct: SYSTEM_REQUIREMENTS_PRODUCT_KIND };
  const digest = sha256OfCanonical({ checkId, gate: SYSTEM_REQUIREMENTS_FINAL_GATE_ID, evaluator: 'machine', content });
  return { checkId, gate: SYSTEM_REQUIREMENTS_FINAL_GATE_ID, evaluator: 'machine', contentRef: `sha256:${digest}`, digest, content };
}

/** The complete installed CheckPlan of the cell (content-addressed rows). */
export function systemRequirementsCheckPlanRows(): readonly CheckPlanRow[] {
  return [
    checkRow('system-requirements.check.product-kind', 'the desk produces exactly its declared product kind: a requirements bundle of FR/NFR/RULE members, never another desk\'s artifact family'),
    checkRow('system-requirements.check.requirement-kind-vocabulary', 'every member kind is inside the closed FR/NFR/RULE vocabulary'),
    checkRow('system-requirements.check.derivation-lineage', 'law L1: every requirement derives from exact accepted PRD/UC members (a scenario-derived FR binds scenario AND terminal-branch identities; a branch resolves within one cited owning scenario; cross-cutting NFR/RULE may bind accepted source constraints)'),
    checkRow('system-requirements.check.verification-surface-coverage', 'law L2: every requirement has a verification surface resolving inside the accepted verification-surface set'),
    checkRow('system-requirements.check.revision-pins', 'law L3: the bundle pins the exact accepted PRD/UC revision digests'),
    checkRow('system-requirements.check.wp03-validation', 'the WP03 requirements-bundle validator (frf-contracts.requirements-bundle.v1) seals the bundle against the supplied accepted-universe; INDETERMINATE when the seam is unbound (D5 human wait, never a silent pass)'),
  ];
}

/** The CheckPlan evidence facts the host injects as external Input authority (R15). */
export function systemRequirementsCheckPlanEvidence(): readonly EvidenceFact[] {
  return systemRequirementsCheckPlanRows().map((row) => ({
    kind: 'CheckPlan' as const,
    ref: `checkplan:${row.checkId}#${row.digest.slice(0, 16)}`,
    producer: 'external-input',
    payloadDigest: row.digest,
  }));
}

/* ------------------------------------------------------------------ */
/* The deterministic machine checks                                    */
/* ------------------------------------------------------------------ */

/** One check result row (the machine checks are deterministic). */
export interface CheckResult {
  readonly checkId: SystemRequirementsCheckId;
  readonly outcome: 'pass' | 'fail' | 'indeterminate';
  /** The typed refusal reason a failing check carries (law/refusal pairing). */
  readonly reason?: RequirementsRefusalReason;
  readonly detail: string;
}

/** The issues a check run accumulates (the repair feedback surface). */
export interface CheckIssue {
  readonly source: RequirementsRefusalReason;
  readonly detail: string;
}

/** One failing check's typed finding. */
interface Fail {
  readonly reason: RequirementsRefusalReason;
  readonly detail: string;
}

export interface CheckRunOutcome {
  readonly ok: boolean;
  readonly results: readonly CheckResult[];
  readonly issues: readonly CheckIssue[];
}

const everyRefWithin = (refs: readonly string[], universe: readonly string[]): boolean =>
  refs.every((ref) => universe.includes(ref));

const refList = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/**
 * Run the cell's declared machine checks over one candidate. Deterministic
 * and total: every declared check yields exactly one result row whatever
 * the candidate shape. The wp03-validation check is INDETERMINATE exactly
 * when the seam is unbound (fail-closed binder refusal included).
 */
export function runSystemRequirementsChecks(
  candidate: { readonly kind?: unknown; readonly product?: unknown },
  universe: RequirementsUniverse | undefined,
  seam: SeamBinding | undefined,
): CheckRunOutcome {
  const results: CheckResult[] = [];
  const issues: CheckIssue[] = [];
  const product = (candidate === null || typeof candidate !== 'object' ? undefined : candidate.product) as RequirementsBundle | undefined;
  const kind = candidate === null || typeof candidate !== 'object' ? undefined : candidate.kind;
  const requirements: readonly RequirementMember[] = Array.isArray(product?.requirements) ? [...product.requirements] : [];

  // product-kind (desk fence: kind match + artifact-family scope).
  {
    const scope = fenceCandidateScope(product);
    let fail: Fail | undefined;
    if (scope !== null) {
      fail = { reason: 'SCOPE_VIOLATION', detail: scope.detail };
    } else if (kind !== SYSTEM_REQUIREMENTS_PRODUCT_KIND) {
      fail = { reason: 'MALFORMED_PRODUCT', detail: `the desk gates product kind ${SYSTEM_REQUIREMENTS_PRODUCT_KIND}; the presented kind is ${String(kind)}` };
    }
    pushResult(results, issues, 'system-requirements.check.product-kind', fail, 'the candidate is the desk product kind carrying only FR/NFR/RULE members');
  }

  // requirement-kind-vocabulary.
  {
    let fail: Fail | undefined;
    if (requirements.length === 0) {
      fail = { reason: 'MALFORMED_PRODUCT', detail: 'the requirements bundle must contain at least one FR, NFR or RULE' };
    } else {
      for (const requirement of requirements) {
        if (requirement === null || typeof requirement !== 'object' || !(REQUIREMENT_KINDS as readonly string[]).includes(String(requirement.requirementKind))) {
          fail = { reason: 'MALFORMED_PRODUCT', detail: `requirement ${String(requirement?.requirementId)} has kind ${String(requirement?.requirementKind)} outside the closed FR/NFR/RULE vocabulary` };
          break;
        }
      }
    }
    pushResult(results, issues, 'system-requirements.check.requirement-kind-vocabulary', fail, 'every member kind is inside the closed vocabulary');
  }

  // derivation-lineage (law L1).
  {
    let fail: Fail | undefined;
    if (universe === undefined) {
      fail = { reason: 'MISSING_LINEAGE', detail: 'no accepted-universe was supplied (fail-closed: the Cell will not guess the accepted sets)' };
    } else {
      for (const requirement of requirements) {
        if (requirement === null || typeof requirement !== 'object') continue;
        const purpose = `requirement ${String(requirement.requirementId)}`;
        const derivation = requirement.derivation;
        const prdRefs = refList(derivation?.prdIntentRefs);
        const scenarioRefs = refList(derivation?.ucScenarioRefs);
        const branchRefs = refList(derivation?.ucTerminalBranchRefs);
        const constraintRefs = refList(derivation?.sourceConstraintRefs);
        if (prdRefs.length === 0) {
          fail = { reason: 'MISSING_LINEAGE', detail: `${purpose} binds no exact PRD intent member` };
          break;
        }
        if (!everyRefWithin(prdRefs, universe.idSets.prdMemberIds)) {
          fail = { reason: 'FOREIGN_LINEAGE', detail: `${purpose} derives from PRD members outside the exact accepted id set (law L1: no requirement derives from foreign material)` };
          break;
        }
        if (scenarioRefs.length > 0 && !everyRefWithin(scenarioRefs, universe.idSets.ucScenarioIds)) {
          fail = { reason: 'FOREIGN_LINEAGE', detail: `${purpose} derives from UC scenarios outside the exact accepted id set (law L1)` };
          break;
        }
        if (branchRefs.length > 0 || scenarioRefs.length > 0) {
          if (branchRefs.length === 0 && requirement.requirementKind === 'FR') {
            fail = { reason: 'MISSING_LINEAGE', detail: `${purpose} is a scenario-derived FR but binds no exact UC terminal branch` };
            break;
          }
          if (scenarioRefs.length === 0 && branchRefs.length > 0) {
            fail = { reason: 'FOREIGN_LINEAGE', detail: `${purpose} cites terminal branches without citing their owning UC scenarios (cross-level citation; law L1)` };
            break;
          }
          const owning = new Set<string>();
          for (const scenarioId of scenarioRefs) {
            for (const branchId of universe.idSets.ucBranchIdsByScenario[scenarioId] ?? []) owning.add(branchId);
          }
          if (branchRefs.some((ref) => !owning.has(ref))) {
            fail = { reason: 'FOREIGN_LINEAGE', detail: `${purpose} cites terminal branches outside the cited scenarios' frozen branch id sets (a branch resolves within exactly one owning UC scenario; law L1)` };
            break;
          }
        }
        if (constraintRefs.length > 0 && !everyRefWithin(constraintRefs, universe.idSets.sourceConstraintIds)) {
          fail = { reason: 'FOREIGN_LINEAGE', detail: `${purpose} binds source constraints outside the exact accepted set (law L1)` };
          break;
        }
      }
    }
    pushResult(results, issues, 'system-requirements.check.derivation-lineage', fail, 'every requirement derives from exact accepted PRD/UC members (law L1)');
  }

  // verification-surface-coverage (law L2).
  {
    let fail: Fail | undefined;
    if (universe === undefined) {
      fail = { reason: 'MISSING_LINEAGE', detail: 'no accepted verification-surface set was supplied (fail-closed)' };
    } else {
      for (const requirement of requirements) {
        if (requirement === null || typeof requirement !== 'object') continue;
        const surfaces = refList(requirement.verificationSurfaceRefs);
        const purpose = `requirement ${String(requirement.requirementId)}`;
        if (surfaces.length === 0) {
          fail = { reason: 'COVERAGE_GAP', detail: `${purpose} names no verification surface (law L2: an unverifiable requirement is a coverage gap)` };
          break;
        }
        if (!everyRefWithin(surfaces, universe.idSets.verificationSurfaceIds)) {
          fail = { reason: 'FOREIGN_LINEAGE', detail: `${purpose} names verification surfaces outside the exact accepted set (law L2)` };
          break;
        }
      }
    }
    pushResult(results, issues, 'system-requirements.check.verification-surface-coverage', fail, 'every requirement verifies through an accepted verification surface (law L2)');
  }

  // revision-pins (law L3).
  {
    let fail: Fail | undefined;
    if (universe === undefined) {
      fail = { reason: 'MISSING_LINEAGE', detail: 'no accepted revision pins were supplied (fail-closed)' };
    } else if (product?.prdRevisionRef !== `sha256:${universe.revisionPins.prd}`) {
      fail = { reason: 'STALE_LINEAGE', detail: `the pinned PRD revision ${String(product?.prdRevisionRef)} is not the accepted revision sha256:${universe.revisionPins.prd} (law L3: no stale derivation)` };
    } else {
      const citesUc = requirements.some((requirement) => refList(requirement?.derivation?.ucScenarioRefs).length > 0 || refList(requirement?.derivation?.ucTerminalBranchRefs).length > 0);
      if (citesUc && product?.ucRevisionRef !== `sha256:${universe.revisionPins.uc}`) {
        fail = { reason: 'STALE_LINEAGE', detail: `the pinned UC revision ${String(product?.ucRevisionRef)} is not the accepted revision sha256:${universe.revisionPins.uc} (law L3: a scenario-derived requirement may not derive from a stale revision)` };
      }
    }
    pushResult(results, issues, 'system-requirements.check.revision-pins', fail, 'the bundle pins the exact accepted PRD/UC revisions (law L3)');
  }

  // wp03-validation (the seam; INDETERMINATE => D5 human wait).
  {
    if (seam === undefined || !seam.bound) {
      const detail = seam !== undefined && !seam.bound
        ? `the WP03 validator seam failed its fail-closed binding (${seam.reason}: ${seam.detail}); the machine cannot decide`
        : 'the WP03 requirements-bundle validator is not bound at this composition root; the machine cannot decide';
      results.push({ checkId: 'system-requirements.check.wp03-validation', outcome: 'indeterminate', detail });
    } else {
      const validation = seam.seam.validate(product, universe);
      if (validation.ok) {
        results.push({ checkId: 'system-requirements.check.wp03-validation', outcome: 'pass', detail: `the WP03 validator sealed the bundle as ${validation.ref}` });
      } else {
        results.push({ checkId: 'system-requirements.check.wp03-validation', outcome: 'fail', reason: validation.reason as RequirementsRefusalReason, detail: validation.detail });
        issues.push({ source: validation.reason as RequirementsRefusalReason, detail: validation.detail });
      }
    }
  }

  return { ok: results.every((result) => result.outcome === 'pass'), results, issues };
}

function pushResult(
  results: CheckResult[],
  issues: CheckIssue[],
  checkId: SystemRequirementsCheckId,
  fail: Fail | undefined,
  passDetail: string,
): void {
  if (fail !== undefined) {
    results.push({ checkId, outcome: 'fail', reason: fail.reason, detail: fail.detail });
    issues.push({ source: fail.reason, detail: fail.detail });
  } else {
    results.push({ checkId, outcome: 'pass', detail: passDetail });
  }
}

/* ------------------------------------------------------------------ */
/* The declared semantic gate                                          */
/* ------------------------------------------------------------------ */

/** The gate verdict surface (the kernel's frozen five). */
export type SemanticGateVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

/** One declared verdict rule: first match wins, no default verdict. */
export interface GateVerdictRule {
  readonly when: {
    readonly checkId: SystemRequirementsCheckId;
    readonly outcome: CheckResult['outcome'];
    /** Optional typed-reason refinement (still declared data). */
    readonly reason?: RequirementsRefusalReason;
  };
  readonly verdict: SemanticGateVerdict;
}

/** The declared gate of the cell. */
export interface GateDeclaration {
  readonly gateId: typeof SYSTEM_REQUIREMENTS_FINAL_GATE_ID;
  readonly command: 'workplace.runFinalGate';
  readonly requiredEvidenceKinds: readonly ['CheckPlan'];
  readonly verdictVocabulary: readonly SemanticGateVerdict[];
  readonly waitOn: { readonly verdict: 'human-wait'; readonly waitKind: 'TypedWait:human-input' };
  readonly rules: readonly GateVerdictRule[];
}

/**
 * The declared gate of the cell. Rule order is the precedence:
 *   1. the indeterminate wp03 row yields human-wait (the D5 typed wait);
 *   2. the desk-contract fences come next: another desk's artifact family
 *      is a SCOPE_VIOLATION terminal-reject (not an author repair), and a
 *      kind mismatch repairs;
 *   3. then the typed payload findings - FOREIGN_LINEAGE belongs to the
 *      owning upstream material (upstream-repair, mirroring the workshop
 *      gate routing table), everything else repairs the author desk;
 *   4. only a passing wp03 row on a fully-present result set accepts.
 */
export function systemRequirementsGateDeclaration(): GateDeclaration {
  return {
    gateId: SYSTEM_REQUIREMENTS_FINAL_GATE_ID,
    command: 'workplace.runFinalGate',
    requiredEvidenceKinds: ['CheckPlan'],
    verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
    waitOn: { verdict: 'human-wait', waitKind: 'TypedWait:human-input' },
    rules: [
      { when: { checkId: 'system-requirements.check.wp03-validation', outcome: 'indeterminate' }, verdict: 'human-wait' },
      { when: { checkId: 'system-requirements.check.product-kind', outcome: 'fail', reason: 'SCOPE_VIOLATION' }, verdict: 'terminal-reject' },
      { when: { checkId: 'system-requirements.check.product-kind', outcome: 'fail' }, verdict: 'repair' },
      { when: { checkId: 'system-requirements.check.wp03-validation', outcome: 'fail', reason: 'FOREIGN_LINEAGE' }, verdict: 'upstream-repair' },
      { when: { checkId: 'system-requirements.check.wp03-validation', outcome: 'fail' }, verdict: 'repair' },
      { when: { checkId: 'system-requirements.check.derivation-lineage', outcome: 'fail', reason: 'FOREIGN_LINEAGE' }, verdict: 'upstream-repair' },
      { when: { checkId: 'system-requirements.check.derivation-lineage', outcome: 'fail' }, verdict: 'repair' },
      { when: { checkId: 'system-requirements.check.verification-surface-coverage', outcome: 'fail', reason: 'FOREIGN_LINEAGE' }, verdict: 'upstream-repair' },
      { when: { checkId: 'system-requirements.check.verification-surface-coverage', outcome: 'fail' }, verdict: 'repair' },
      { when: { checkId: 'system-requirements.check.revision-pins', outcome: 'fail' }, verdict: 'repair' },
      { when: { checkId: 'system-requirements.check.requirement-kind-vocabulary', outcome: 'fail' }, verdict: 'repair' },
      { when: { checkId: 'system-requirements.check.wp03-validation', outcome: 'pass' }, verdict: 'accepted' },
    ],
  };
}

export type GateEvaluation =
  | { readonly decided: true; readonly verdict: SemanticGateVerdict; readonly rule: GateVerdictRule }
  | {
      readonly refused: true;
      readonly code: 'GATE_RULES_CANNOT_DECIDE' | 'GATE_UNKNOWN_CHECK' | 'GATE_CHECK_MISSING';
      readonly detail: string;
    };

/**
 * Evaluate the declared gate over one check-result set.
 *
 * The VALIDATOR-BYPASS fence: every declared check of the gate must be
 * present in the result set (GATE_CHECK_MISSING otherwise). A host that
 * "forgets" the wp03-validation row cannot reach any verdict - least of
 * all accepted. Extra unknown ids are refused (GATE_UNKNOWN_CHECK); no
 * declared rule matching is refused (GATE_RULES_CANNOT_DECIDE). The
 * evaluator never invents a verdict and never defaults to accepted.
 */
export function evaluateSystemRequirementsGate(gate: GateDeclaration, results: readonly CheckResult[]): GateEvaluation {
  const declared = new Set(gate.rules.map((rule) => rule.when.checkId));
  for (const result of results) {
    if (!(SYSTEM_REQUIREMENTS_CHECK_IDS as readonly string[]).includes(result.checkId)) {
      return { refused: true, code: 'GATE_UNKNOWN_CHECK', detail: `check ${String(result.checkId)} is outside the cell's declared CheckPlan` };
    }
    if (!declared.has(result.checkId)) {
      return { refused: true, code: 'GATE_UNKNOWN_CHECK', detail: `check ${String(result.checkId)} is not governed by any declared rule of gate ${gate.gateId}` };
    }
  }
  const present = new Set(results.map((result) => result.checkId));
  const missing = [...declared].filter((checkId) => !present.has(checkId));
  if (missing.length > 0) {
    return {
      refused: true,
      code: 'GATE_CHECK_MISSING',
      detail: `gate ${gate.gateId} was handed no result for ${missing.sort().join(', ')} (the validator-bypass fence: an incomplete result set never reaches a verdict)`,
    };
  }
  for (const rule of gate.rules) {
    const result = results.find((entry) => entry.checkId === rule.when.checkId);
    if (result === undefined) continue;
    if (result.outcome !== rule.when.outcome) continue;
    if (rule.when.reason !== undefined && result.reason !== rule.when.reason) continue;
    return { decided: true, verdict: rule.verdict, rule };
  }
  return {
    refused: true,
    code: 'GATE_RULES_CANNOT_DECIDE',
    detail: `no declared rule of gate ${gate.gateId} matches the check results [${results.map((entry) => `${entry.checkId}:${entry.outcome}${entry.reason === undefined ? '' : `(${entry.reason})`}`).join(', ')}]; an undecided gate never defaults`,
  };
}

/**
 * The convenience gate entry point: verify the declared provider, run the
 * deterministic checks, evaluate the declared gate. Pure end to end.
 */
export function gateSystemRequirementsCandidate(
  provider: SystemRequirementsProviderDeclaration,
  candidate: { readonly kind?: unknown; readonly product?: unknown },
  universe: RequirementsUniverse | undefined,
  seam: SeamBinding | undefined,
): { readonly verdict: SemanticGateVerdict; readonly rule: GateVerdictRule; readonly results: readonly CheckResult[]; readonly issues: readonly CheckIssue[] } | { readonly refused: true; readonly detail: string } {
  const verified = verifySystemRequirementsProvider(provider);
  if (!verified.ok) return { refused: true, detail: verified.detail };
  const run = runSystemRequirementsChecks(candidate, universe, seam);
  const gate = systemRequirementsGateDeclaration();
  const evaluation = evaluateSystemRequirementsGate(gate, run.results);
  if ('refused' in evaluation) return { refused: true, detail: `${evaluation.code}: ${evaluation.detail}` };
  return { verdict: evaluation.verdict, rule: evaluation.rule, results: run.results, issues: run.issues };
}
