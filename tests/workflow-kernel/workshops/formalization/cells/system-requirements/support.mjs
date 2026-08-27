/**
 * support.mjs - shared FRF-WP05 system-requirements Cell test fixtures:
 * the accepted upstream desk input (the supplied accepted-id sets), the
 * authored green bundle, and THE DOCUMENTED WP03 VALIDATOR SEAM binding
 * (the dynamic import of the docs-tree validator - see
 * src/workflow-kernel/workshops/formalization/cells/system-requirements/
 * SEAM.md for the seam contract).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** system-requirements <- cells <- formalization <- workshops <- workflow-kernel <- tests <- ROOT */
const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(dirname(HERE))))));

/** The documented seam entry: the FRF-WP03 docs-tree validator module. */
export const WP03_VALIDATOR_PATH = join(
  REPO_ROOT,
  'docs',
  'refactoring',
  'formalization-frf',
  'contracts',
  'validators',
  'requirements-bundle.mjs',
);

/** The FRF-WP03 committed fixture corpus (green bundle + accepted id sets + red seeds). */
export const WP03_FIXTURES_DIR = join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'fixtures');

export const dist = (relative) => import(`../../../../../../dist/${relative}`);

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export const cell = () => dist('workflow-kernel/workshops/formalization/cells/system-requirements/index.js');

/* ------------------------------------------------------------------ */
/* The bound WP03 seam (THE documented binding fragment)               */
/* ------------------------------------------------------------------ */

/**
 * Bind the docs-tree WP03 validator through the cell's fail-closed seam.
 * This dynamic import IS the seam: production code never imports docs;
 * the test host binds the validator at test time (SEAM.md).
 */
export async function boundSeam() {
  const wp03Module = await import(`file:///${WP03_VALIDATOR_PATH.replace(/\\/g, '/')}`);
  const { bindWp03RequirementsValidator } = await cell();
  const binding = bindWp03RequirementsValidator(wp03Module);
  if (!binding.bound) {
    throw new Error(`the WP03 seam refused the docs-tree validator: ${binding.reason}: ${binding.detail}`);
  }
  return binding;
}

/* ------------------------------------------------------------------ */
/* The accepted upstream desk input (the supplied accepted-id sets)     */
/* ------------------------------------------------------------------ */

export const PRD_REVISION = sha256('frf-wp05-accepted-prd-revision');
export const UC_REVISION = sha256('frf-wp05-accepted-uc-revision');

export function greenDeskInput() {
  return {
    prd: {
      revisionDigest: PRD_REVISION,
      memberIds: ['prd:boundary-1', 'prd:constraint-1', 'prd:outcome-1', 'prd:scope-2'],
    },
    useCases: {
      revisionDigest: UC_REVISION,
      scenarioIds: ['uc:batch-1', 'uc:checkout-1'],
      branchIdsByScenario: {
        'uc:batch-1': ['branch:batch-error', 'branch:batch-main'],
        'uc:checkout-1': ['branch:checkout-alt', 'branch:checkout-main'],
      },
    },
    sourceConstraintIds: ['constraint:retention-1'],
    verificationSurfaceIds: ['surface:batch-audit-1', 'surface:test-suite-1'],
  };
}

/* ------------------------------------------------------------------ */
/* The authored green bundle                                           */
/* ------------------------------------------------------------------ */

export function greenMembers() {
  return [
    {
      requirementId: 'fr:cart-1',
      requirementKind: 'FR',
      statement: 'The system shall compute cart totals, take payment and emit an order confirmation for the checkout scenario.',
      prdIntentRefs: ['prd:outcome-1'],
      ucScenarioRefs: ['uc:checkout-1'],
      ucTerminalBranchRefs: ['branch:checkout-alt', 'branch:checkout-main'],
      verificationSurfaceRefs: ['surface:test-suite-1'],
    },
    {
      requirementId: 'fr:batch-1',
      requirementKind: 'FR',
      statement: 'The system shall process the scheduled batch idempotently and record an observable batch result.',
      prdIntentRefs: ['prd:scope-2'],
      ucScenarioRefs: ['uc:batch-1'],
      ucTerminalBranchRefs: ['branch:batch-main'],
      verificationSurfaceRefs: ['surface:batch-audit-1'],
    },
    {
      requirementId: 'nfr:retention-1',
      requirementKind: 'NFR',
      statement: 'Order records shall be retained for the compliance-pinned period.',
      prdIntentRefs: ['prd:constraint-1'],
      sourceConstraintRefs: ['constraint:retention-1'],
      verificationSurfaceRefs: ['surface:batch-audit-1'],
    },
    {
      requirementId: 'rule:audit-1',
      requirementKind: 'RULE',
      statement: 'Every emitted order confirmation shall be audit-logged inside the system boundary.',
      prdIntentRefs: ['prd:boundary-1'],
      verificationSurfaceRefs: ['surface:batch-audit-1'],
    },
  ];
}

/** Build the green bundle through the cell's builder (fail-closed). */
export async function greenBundle() {
  const { buildRequirementsBundle } = await cell();
  const outcome = buildRequirementsBundle({
    prdRevisionDigest: PRD_REVISION,
    ucRevisionDigest: UC_REVISION,
    requirements: greenMembers(),
  });
  if (!outcome.ok) throw new Error(`green bundle build refused: ${outcome.reason}: ${outcome.detail}`);
  return outcome.sealed;
}

/** The green candidate as presented to the desk gate. */
export async function greenCandidate() {
  const { candidateOf } = await cell();
  const sealed = await greenBundle();
  return { candidate: candidateOf(sealed.bundle), sealed };
}

/** Derive the accepted universe from the green desk input (fail-closed). */
export async function greenUniverse() {
  const { deriveAcceptedUniverse } = await cell();
  const outcome = deriveAcceptedUniverse(greenDeskInput());
  if (!outcome.ok) throw new Error(`green universe derivation refused: ${outcome.reason}: ${outcome.detail}`);
  return outcome.universe;
}

/* ------------------------------------------------------------------ */
/* The committed FRF-WP03 fixture corpus                               */
/* ------------------------------------------------------------------ */

/** The WP03 accepted-id-sets fixture as a cell desk input. */
export function wp03DeskInput() {
  const sets = JSON.parse(readFileSync(join(WP03_FIXTURES_DIR, 'accepted-id-sets.json'), 'utf8'));
  return {
    prd: { revisionDigest: sets.revisionPins.prd, memberIds: sets.idSets.prdMemberIds },
    useCases: {
      revisionDigest: sets.revisionPins.uc,
      scenarioIds: sets.idSets.ucScenarioIds,
      branchIdsByScenario: sets.idSets.ucBranchIdsByScenario,
    },
    sourceConstraintIds: sets.idSets.sourceConstraintIds,
    verificationSurfaceIds: sets.idSets.verificationSurfaceIds,
  };
}

/** One committed requirements payload (green or red seed) by file name. */
export function wp03Fixture(fileName) {
  return JSON.parse(readFileSync(join(WP03_FIXTURES_DIR, fileName), 'utf8'));
}

/** The committed requirements red seeds with their frozen typed refusal codes. */
export const WP03_REQ_RED_SEEDS = [
  { fileName: 'red/15-req-foreign-prd-member.FOREIGN_LINEAGE.json', code: 'FOREIGN_LINEAGE' },
  { fileName: 'red/16-req-foreign-uc-scenario.FOREIGN_LINEAGE.json', code: 'FOREIGN_LINEAGE' },
  { fileName: 'red/17-req-cross-level-branch.FOREIGN_LINEAGE.json', code: 'FOREIGN_LINEAGE' },
  { fileName: 'red/18-req-fr-no-branch-lineage.MISSING_LINEAGE.json', code: 'MISSING_LINEAGE' },
  { fileName: 'red/19-req-stale-prd-pin.STALE_LINEAGE.json', code: 'STALE_LINEAGE' },
  { fileName: 'red/20-req-foreign-verification-surface.FOREIGN_LINEAGE.json', code: 'FOREIGN_LINEAGE' },
  { fileName: 'red/21-req-open-requirement-kind.MALFORMED_PRODUCT.json', code: 'MALFORMED_PRODUCT' },
  { fileName: 'red/22-req-uc-coverage-gap.COVERAGE_GAP.json', code: 'COVERAGE_GAP' },
];
