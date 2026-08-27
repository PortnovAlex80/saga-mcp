/**
 * FRF-WP06 define-acceptance-contract cell - THE CELL PROTOCOL.
 *
 * Desk contract authority:
 *   docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md
 *   "#Desk contracts/define-acceptance-contract" -
 *     - Every AC must bind to exact FR or NFR material.
 *     - A scenario-facing AC must retain its exact UC and terminal-branch
 *       binding (the BOTH-citation-shapes law, WP03 seam).
 *     - Every required UC terminal result must have at least one
 *       end-to-end AC or an accepted evidence binding of type test,
 *       monitoring, audit, or independent agent review (cr-05).
 *     - AC remains WHAT-side verification and must not contain
 *       architecture or file allocation decisions.
 *   Graph authority (plan "#Target process graph", installed at EK-8
 *   WP-11F, ledger D-0): the cell sits after derive-system-requirements;
 *   its accepted exit leads to reconcile-what; its failed exit leads to
 *   complete-failed.
 *
 * INPUT = the exact accepted material carried by the
 * domain.accepted transition of derive-system-requirements:
 *   - the accepted requirements bundle (frf-contracts.requirements-bundle.v1):
 *     FR/NFR/RULE members with exact derivation lineage;
 *   - the accepted UC scenarios and their terminal branches
 *     (frf-contracts.uc-scenario-member.v1 universe: scenario ids and
 *     the branch-ids-by-scenario map);
 *   - the accepted verifiable-statement id set the criteria cite;
 *   - the accepted standalone evidence bindings (cr-05 coverers that are
 *     not AC criteria).
 * OUTPUT = the cell product formalization.acceptance-bindings.v1 (the
 * INSTALLED product kind of this desk; no new artifact family): a
 * bundle of frf-contracts.ac-binding.v1 criteria plus explicit
 * requirement deferral dispositions, validated per criterion through
 * the WP03 seam and closed by the cell's closure validators
 * (closure.mjs).
 *
 * PURITY: pure data + pure functions. No I/O, no clock, no session.
 */

import { WP03_AC_BINDING_KIND } from './wp03-seam.mjs';

/** The installed node id this cell implements (manifest.ts pin). */
export const ACCEPTANCE_CELL_NODE_ID = 'define-acceptance-contract';

/** The installed product kind this cell emits (manifest.ts pin). */
export const ACCEPTANCE_CELL_PRODUCT_KIND = 'formalization.acceptance-bindings.v1';

/** The bundle schemaVersion: the installed desk product kind. */
export const ACCEPTANCE_BUNDLE_SCHEMA_VERSION = ACCEPTANCE_CELL_PRODUCT_KIND;

/** The flow position (plan "#Target process graph", 18 edges). */
export const ACCEPTANCE_CELL_FLOW = Object.freeze({
  nodeId: ACCEPTANCE_CELL_NODE_ID,
  kind: 'production-cell',
  predecessor: 'derive-system-requirements',
  acceptedTransition: Object.freeze({ on: 'domain.accepted', to: 'reconcile-what' }),
  failedTransition: Object.freeze({ on: 'domain.failed', to: 'complete-failed' }),
});

/** The closed evidence-kind vocabulary (cr-05 / WP03 contract enum). */
export const EVIDENCE_KINDS = Object.freeze([
  'audit',
  'independent-agent-review',
  'monitoring',
  'test',
]);

/** The deferral disposition vocabulary of the requirements-coverage law. */
export const DEFERRAL_DISPOSITIONS = Object.freeze(['deferred']);

/** The cell's INPUT contract (what the transition must carry; fail-closed). */
export const ACCEPTANCE_CELL_INPUT_CONTRACT = Object.freeze({
  inputId: 'frf-cells.acceptance-input.v1',
  consumes: Object.freeze([
    Object.freeze({
      material: 'accepted-requirements-bundle',
      contract: 'frf-contracts.requirements-bundle.v1',
      carries: 'FR/NFR/RULE member ids + derivation lineage (scenario-derived FRs carry UC scenario and branch bindings)',
    }),
    Object.freeze({
      material: 'accepted-uc-scenarios',
      contract: 'frf-contracts.uc-scenario-member.v1',
      carries: 'accepted scenario ids + the terminal branch id set of each scenario',
    }),
    Object.freeze({
      material: 'accepted-verifiable-statements',
      contract: 'accepted-id-set',
      carries: 'the exact accepted verifiable-statement id set criteria cite',
    }),
    Object.freeze({
      material: 'accepted-evidence-bindings',
      contract: 'accepted-id-set',
      carries: 'standalone evidence bindings that may cover required terminal results (cr-05)',
      optional: false,
    }),
  ]),
});

/** The cell's OUTPUT contract (what the desk's author must produce). */
export const ACCEPTANCE_CELL_OUTPUT_CONTRACT = Object.freeze({
  outputId: 'frf-cells.acceptance-output.v1',
  productKind: ACCEPTANCE_CELL_PRODUCT_KIND,
  schemaVersion: ACCEPTANCE_BUNDLE_SCHEMA_VERSION,
  payload: Object.freeze({
    criteria: Object.freeze({
      contract: WP03_AC_BINDING_KIND,
      validatedBy: 'the WP03 validateAcBinding seam (wp03-seam.mjs); refusals propagate verbatim',
    }),
    deferrals: Object.freeze({
      contract: 'frf-cells.requirement-deferral.v1',
      shape: '{ requirementId, disposition: "deferred", owner, reason } (owner and reason required - the plan disposition grammar)',
    }),
    standaloneEvidenceBindings: Object.freeze({
      contract: 'frf-cells.evidence-binding.v1',
      shape: '{ evidenceBindingId, evidenceKind (closed 4), ucTerminalBranchRefs, observableTerminalResult }',
    }),
  }),
  fence:
    'AC remains WHAT-side verification: architecture or file-allocation keys are typed SCOPE_VIOLATION (per criterion, WP03 seam)',
});

/**
 * Build the WP03 accepted-id-set universe for this cell from its declared
 * inputs. Fail-closed: a missing input material is a typed refusal, never
 * an empty guess (WP03 validators additionally refuse any id-set class we
 * fail to supply).
 *
 * @param {object} inputs the accepted material carried by the transition
 * @returns {{ ok: true, universe: object } | { ok: false, reason: string, detail: string }}
 */
export function acceptanceUniverseFrom(inputs) {
  if (inputs === null || typeof inputs !== 'object') {
    return { ok: false, reason: 'MISSING_LINEAGE', detail: 'the acceptance cell received no input material' };
  }
  const bundle = inputs.requirementsBundle;
  const uc = inputs.useCases;
  if (bundle === null || typeof bundle !== 'object' || !Array.isArray(bundle.requirements)) {
    return { ok: false, reason: 'MISSING_LINEAGE', detail: 'no accepted requirements bundle was carried by the transition (fail-closed; the cell will not guess the accepted FR/NFR universe)' };
  }
  if (uc === null || typeof uc !== 'object' || !Array.isArray(uc.scenarioIds)) {
    return { ok: false, reason: 'MISSING_LINEAGE', detail: 'no accepted UC scenario set was carried by the transition (fail-closed)' };
  }
  if (uc.branchIdsByScenario === null || typeof uc.branchIdsByScenario !== 'object') {
    return { ok: false, reason: 'MISSING_LINEAGE', detail: 'no accepted UC terminal-branch map was carried by the transition (fail-closed; branch citations resolve within their owning scenario)' };
  }
  if (!Array.isArray(inputs.verifiableStatementIds)) {
    return { ok: false, reason: 'MISSING_LINEAGE', detail: 'no accepted verifiable-statement id set was carried by the transition (fail-closed)' };
  }
  const frIds = [];
  const nfrIds = [];
  const ruleIds = [];
  const scenarioDerived = Object.create(null);
  for (const requirement of bundle.requirements) {
    if (requirement.requirementKind === 'FR') frIds.push(requirement.requirementId);
    else if (requirement.requirementKind === 'NFR') nfrIds.push(requirement.requirementId);
    else if (requirement.requirementKind === 'RULE') ruleIds.push(requirement.requirementId);
    const derivation = requirement.derivation ?? {};
    scenarioDerived[requirement.requirementId] =
      Array.isArray(derivation.ucScenarioRefs) && derivation.ucScenarioRefs.length > 0;
  }
  const evidenceBindingIds = Array.isArray(inputs.evidenceBindings)
    ? inputs.evidenceBindings.map((binding) => binding.evidenceBindingId)
    : [];
  const universe = {
    idSets: {
      frIds,
      nfrIds,
      ruleIds,
      ucScenarioIds: [...uc.scenarioIds],
      ucBranchIdsByScenario: { ...uc.branchIdsByScenario },
      verifiableStatementIds: [...inputs.verifiableStatementIds],
      evidenceBindingIds,
    },
    /** Cell-local lineage facts the closure validators consume. */
    scenarioDerivedRequirements: scenarioDerived,
  };
  return { ok: true, universe };
}
