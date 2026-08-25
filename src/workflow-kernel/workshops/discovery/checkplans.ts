/**
 * workflow-kernel/workshops/discovery/checkplans.ts - the CheckPlans and
 * semantic gates of the Discovery products (WP-11D).
 *
 * Laws implemented here:
 *   - Providers are DECLARED (closed data): a CheckPlan may name only a
 *     provider id the installed manifest declares; an undeclared provider
 *     is a typed fail-closed refusal, never a silent skip and never an
 *     ad-hoc predicate.
 *   - Evaluation is DETERMINISTIC: pure functions of the product values -
 *     no clock, no I/O, no randomness; the same products always yield the
 *     same results on every machine.
 *   - The gate-verdict mapping is declared data applied deterministically:
 *     all checks pass -> accepted; the decision fork (needs-human) ->
 *     human-wait (the typed wait lives in waits.ts); anything else ->
 *     repair. The driver passes the derived verdict to the kernel gate
 *     command; it never invents one.
 *   - The kernel's CheckPlan evidence kind (R15, installed workshop
 *     manifest) is the external Input fact the gate guards require; the
 *     fact is derived from the installed manifest (installed-manifest.ts).
 *
 * PURITY: no imports except sibling pure modules. No I/O, no clock.
 */

import { BRIEF_CONTRACT, IDEA_INTAKE_CONTRACT, INTENT_CONTRACT, productContractRef, validateSealedProduct, type SealedProduct } from './products.js';

/* ------------------------------------------------------------------ */
/* Declared providers (closed data; the manifest pins this set)         */
/* ------------------------------------------------------------------ */

/** One declared deterministic check provider. */
export interface DeclaredCheckProvider {
  readonly providerId: string;
  readonly checks: 'brief-completeness' | 'idea-conservation' | 'intent-decision' | 'lineage';
  readonly productContractRef: string;
}

export const DECLARED_CHECK_PROVIDERS: readonly DeclaredCheckProvider[] = [
  { providerId: 'brief-completeness.provider', checks: 'brief-completeness', productContractRef: productContractRef(BRIEF_CONTRACT) },
  { providerId: 'idea-conservation.provider', checks: 'idea-conservation', productContractRef: productContractRef(IDEA_INTAKE_CONTRACT) },
  { providerId: 'intent-decision.provider', checks: 'intent-decision', productContractRef: productContractRef(INTENT_CONTRACT) },
  { providerId: 'lineage.provider', checks: 'lineage', productContractRef: productContractRef(BRIEF_CONTRACT) },
];

/* ------------------------------------------------------------------ */
/* CheckPlan values                                                    */
/* ------------------------------------------------------------------ */

/** One versioned CheckPlan (the plan a gate runs; data, not a branch). */
export interface CheckPlan {
  readonly planId: 'author-brief-gate' | 'final-intent-gate';
  readonly schemaVersion: 'ek.checkplan.workshop.v1';
  readonly providers: readonly string[];
  readonly failClosed: true;
}

/** The author-gate plan: the brief draft is checked before the desk opens. */
export const AUTHOR_BRIEF_CHECK_PLAN: CheckPlan = {
  planId: 'author-brief-gate',
  schemaVersion: 'ek.checkplan.workshop.v1',
  providers: ['brief-completeness.provider', 'idea-conservation.provider'],
  failClosed: true,
};

/** The final-gate plan: the intent product is checked before effects run. */
export const FINAL_INTENT_CHECK_PLAN: CheckPlan = {
  planId: 'final-intent-gate',
  schemaVersion: 'ek.checkplan.workshop.v1',
  providers: ['intent-decision.provider', 'lineage.provider', 'idea-conservation.provider'],
  failClosed: true,
};

/* ------------------------------------------------------------------ */
/* Typed refusals (closed set)                                         */
/* ------------------------------------------------------------------ */

export type CheckPlanRefusalReason =
  | 'DECLARED_PROVIDER_REQUIRED'
  | 'PRODUCTS_MISSING';

export interface CheckPlanRefusal {
  readonly refused: true;
  readonly reason: CheckPlanRefusalReason;
  readonly detail: string;
}

/** One provider result (deterministic, names the exact defect). */
export interface CheckResult {
  readonly providerId: string;
  readonly passed: boolean;
  readonly detail: string;
}

export type CheckPlanRun =
  | { readonly ok: true; readonly results: readonly CheckResult[] }
  | CheckPlanRefusal;

/* ------------------------------------------------------------------ */
/* The deterministic providers                                         */
/* ------------------------------------------------------------------ */

/** The products one plan run sees (closed shape - no free-form bag). */
export interface CheckPlanProducts {
  readonly idea?: SealedProduct;
  readonly brief?: SealedProduct;
  readonly intent?: SealedProduct;
}

const asStrings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.map(String) : []);

/** brief-completeness: the brief states a real problem/outcome and carries constraints. */
function checkBriefCompleteness(brief: SealedProduct): CheckResult {
  const provider = 'brief-completeness.provider';
  const problem = String(brief.value.problem ?? '');
  const outcome = String(brief.value.outcome ?? '');
  const constraints = asStrings(brief.value.constraints);
  const shape = validateSealedProduct(brief);
  if ('refused' in shape) {
    return { providerId: provider, passed: false, detail: `brief product malformed: ${shape.reason}(${shape.field}): ${shape.detail}` };
  }
  const problemMinLength = BRIEF_CONTRACT.fields.find((field) => field.name === 'problem')?.minLength ?? 12;
  if (problem.length < problemMinLength) {
    return { providerId: provider, passed: false, detail: 'the brief problem statement is too thin to gate' };
  }
  if (outcome.length === 0 || constraints.length === 0) {
    return { providerId: provider, passed: false, detail: 'the brief must state the outcome and carry the constraints' };
  }
  return { providerId: provider, passed: true, detail: 'brief problem/outcome/constraints complete' };
}

/** idea-conservation (D10): every idea unknown survives as a brief open question. */
function checkIdeaConservation(idea: SealedProduct | undefined, brief: SealedProduct): CheckResult {
  const provider = 'idea-conservation.provider';
  if (idea === undefined) {
    return { providerId: provider, passed: false, detail: 'the admitted idea product is required (unknowns cannot be checked without it)' };
  }
  const unknowns = asStrings(idea.value.unknowns);
  const openQuestions = asStrings(brief.value.openQuestions);
  const lost = unknowns.filter((unknown) => !openQuestions.includes(unknown));
  if (lost.length > 0) {
    return { providerId: provider, passed: false, detail: `idea unknowns disappeared from the brief open questions: ${lost.join('; ')}` };
  }
  return { providerId: provider, passed: true, detail: `${unknowns.length} idea unknown(s) conserved as open questions` };
}

/** intent-decision: the decision is lawful, the rationale is real, the route is the next stage. */
function checkIntentDecision(intent: SealedProduct): CheckResult {
  const provider = 'intent-decision.provider';
  const shape = validateSealedProduct(intent);
  if ('refused' in shape) {
    return { providerId: provider, passed: false, detail: `intent product malformed: ${shape.reason}(${shape.field}): ${shape.detail}` };
  }
  return { providerId: provider, passed: true, detail: `decision ${String(intent.value.decision)} with rationale, targeting ${String(intent.value.targetStageRoute)}` };
}

/** lineage: brief.ideaRef binds the admitted idea; intent.briefRef binds the sealed brief. */
function checkLineage(products: CheckPlanProducts): CheckResult {
  const provider = 'lineage.provider';
  const { idea, brief, intent } = products;
  if (brief !== undefined && idea !== undefined && brief.value.ideaRef !== idea.ref) {
    return { providerId: provider, passed: false, detail: `the brief pins idea ${String(brief.value.ideaRef)} but the admitted idea is ${idea.ref}` };
  }
  if (intent !== undefined && brief !== undefined && intent.value.briefRef !== brief.ref) {
    return { providerId: provider, passed: false, detail: `the intent pins brief ${String(intent.value.briefRef)} but the sealed brief is ${brief.ref}` };
  }
  if (intent !== undefined && brief === undefined) {
    return { providerId: provider, passed: false, detail: 'the intent product requires the sealed brief (lineage is never implicit)' };
  }
  return { providerId: provider, passed: true, detail: 'product lineage verified (idea -> brief -> intent)' };
}

const PROVIDER_IMPL: Readonly<Record<DeclaredCheckProvider['checks'], (products: CheckPlanProducts) => CheckResult>> = {
  'brief-completeness': (products) => checkBriefCompleteness(products.brief as SealedProduct),
  'idea-conservation': (products) => checkIdeaConservation(products.idea, products.brief as SealedProduct),
  'intent-decision': (products) => checkIntentDecision(products.intent as SealedProduct),
  lineage: (products) => checkLineage(products),
};

/* ------------------------------------------------------------------ */
/* Plan execution (fail-closed over the declared set)                  */
/* ------------------------------------------------------------------ */

/**
 * Run one CheckPlan deterministically. Fail-closed twice: every named
 * provider must be DECLARED, and every product the plan's providers need
 * must be present - anything else is a typed refusal, never a pass.
 */
export function runCheckPlan(plan: CheckPlan, declared: readonly DeclaredCheckProvider[], products: CheckPlanProducts): CheckPlanRun {
  if (products.brief === undefined && products.intent === undefined) {
    return { refused: true, reason: 'PRODUCTS_MISSING', detail: `plan ${plan.planId} has no products to check (an empty check is never a pass)` };
  }
  const resolved: { readonly providerId: string; readonly checks: DeclaredCheckProvider['checks'] }[] = [];
  for (const providerId of plan.providers) {
    const declaration = declared.find((provider) => provider.providerId === providerId);
    if (declaration === undefined) {
      return { refused: true, reason: 'DECLARED_PROVIDER_REQUIRED', detail: `plan ${plan.planId} names provider ${providerId} which the installed manifest does not declare (fail-closed)` };
    }
    resolved.push({ providerId, checks: declaration.checks });
  }
  const results: CheckResult[] = resolved.map((entry) => PROVIDER_IMPL[entry.checks](products));
  return { ok: true, results };
}

/* ------------------------------------------------------------------ */
/* The semantic gate verdict mapping (declared, deterministic)         */
/* ------------------------------------------------------------------ */

/** The verdict mapping of one plan run (declared data, applied purely). */
export interface GateVerdictMapping {
  readonly allPassed: 'accepted';
  readonly decisionFork: 'human-wait';
  readonly otherwise: 'repair';
}

export const DISCOVERY_GATE_MAPPING: GateVerdictMapping = {
  allPassed: 'accepted',
  decisionFork: 'human-wait',
  otherwise: 'repair',
};

export type SemanticGateVerdict = 'accepted' | 'repair' | 'human-wait';

/**
 * Derive the gate verdict of one completed plan run. The decision fork
 * (intent decision needs-human) routes to the typed human wait - the
 * operator decides, the kernel waits; anything failed routes to repair;
 * everything passed accepts.
 */
export function gateVerdictOf(
  run: { ok: true; results: readonly CheckResult[] },
  products: CheckPlanProducts,
  mapping: GateVerdictMapping = DISCOVERY_GATE_MAPPING,
): SemanticGateVerdict {
  if (products.intent?.value.decision === 'needs-human') {
    return mapping.decisionFork;
  }
  return run.results.every((result) => result.passed) ? mapping.allPassed : mapping.otherwise;
}
