/**
 * support.mjs - the FRF-WP07 WHAT-freeze cell test support: builds the
 * exact accepted-authority surfaces from the committed FRF-WP03 fixture
 * corpus (the accepted-id-sets universe + the green whole-WHAT baseline),
 * freezes the baseline through the cell, and hands the frozen artifacts
 * to the freeze/settlement/persistence tests.
 *
 * The green fixture corpus is INDEPENDENT evidence (authored at WP03
 * from the plan's desk contracts, never generated from this cell): the
 * cell must REPRODUCE its digests byte-for-byte.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..', '..');
const CELL = path.join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze');
const WP03 = path.join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts');

/** Import a local module by absolute path (file:// URL: Windows-safe). */
export const importAbs = (absolute) => import(pathToFileURL(absolute).href);

export const cellModule = (name) => importAbs(path.join(CELL, `${name}.mjs`));
export const distModule = (relative) => importAbs(path.join(REPO_ROOT, 'dist', `${relative}.js`));

export const readJson = (...parts) => JSON.parse(readFileSync(path.join(...parts), 'utf8'));

/** The committed WP03 green what-baseline fixture (independent evidence). */
export function greenBaselineFixture() {
  return readJson(WP03, 'fixtures', 'green', 'what-baseline.json');
}

/** The committed WP03 accepted-id-sets fixture. */
export function acceptedIdSetsFixture() {
  return readJson(WP03, 'fixtures', 'accepted-id-sets.json');
}

/**
 * The exact accepted-authority surfaces, decomposed from the WP03 green
 * fixture: the fixture IS the accepted material manifest this desk must
 * consume (its digests are the accepted digests).
 */
export function acceptedSurfacesOf(green = greenBaselineFixture()) {
  return {
    caseIdentity: structuredClone(green.caseIdentity),
    sourceManifests: structuredClone(green.sourceManifests),
    acceptanceRecords: structuredClone(green.acceptanceRecords),
    containers: structuredClone(green.containers),
    traceSet: { traces: structuredClone(green.traceSet.traces) },
    dispositions: structuredClone(green.dispositions),
    evidenceBindings: structuredClone(green.evidenceBindings),
    developmentSurface: structuredClone(green.developmentSurface),
  };
}

/** Freeze the accepted surfaces (the desk's green path). */
export async function freezeAccepted(surfaces = acceptedSurfacesOf(), options = {}) {
  const freeze = await cellModule('freeze');
  return freeze.freezeWhatBaseline(surfaces, options);
}

/** The post-freeze SRS authority surface (realization entries + construction surfaces). */
export function srsAuthorityOf() {
  return {
    revisionDigest: '5f6b1c2a'.padEnd(64, '0'),
    realizationEntryIds: ['realization:uc-checkout-1', 'realization:uc-batch-1'],
    surfaces: ['svc:cart-api', 'svc:batch-runner', 'module:audit-log'],
  };
}

/** The repository/policy authority refs (post-freeze Development surface). */
export function repositoryPolicyRefsOf() {
  return ['repo:primary', 'policy:release-checklist'];
}

/** A lawful twelve-kind Development handoff over the frozen baseline. */
export function lawfulHandoffOf(green = greenBaselineFixture(), srs = srsAuthorityOf(), repoPolicies = repositoryPolicyRefsOf()) {
  return {
    'acceptance-bindings': ['ac:checkout-end-1'],
    'formalization-certificate': [green.caseIdentity.discoveryCertificateRef, green.caseIdentity.formalizationCaseRef],
    'integration-and-construction-obligations': ['svc:cart-api', 'module:audit-log'],
    'prd-intent-bindings': ['prd:boundary-1'],
    'repository-and-policy-bindings': [...repoPolicies],
    'requirement-bindings': ['fr:cart-1', 'nfr:retention-1'],
    'scenario-bindings': ['uc:batch-1'],
    'scenario-realization-bindings': [...srs.realizationEntryIds],
    'solution-contract': ['placeholder-filled-at-seal'],
    'srs-reference-and-hash': [srs.revisionDigest],
    'terminal-claim-bindings': ['terminal:delivered-1'],
    'what-baseline-reference-and-hash': [green.wholeWhatDigest],
  };
}

/** Settle the frozen baseline (the settle desk's green path). */
export async function settleFrozen(frozen, options = {}) {
  const settlement = await cellModule('settlement');
  return settlement.settleSolutionContract({
    frozenBaseline: frozen.baseline,
    baselineArtifact: frozen.artifact,
    srs: options.srs ?? srsAuthorityOf(),
    repositoryPolicyRefs: options.repositoryPolicyRefs ?? repositoryPolicyRefsOf(),
    handoff: options.handoff ?? lawfulHandoffOf(options.green ?? greenBaselineFixture(), options.srs ?? srsAuthorityOf(), options.repositoryPolicyRefs ?? repositoryPolicyRefsOf()),
  });
}

/** Deep-clone helper for mutation seeds. */
export const clone = (value) => structuredClone(value);
