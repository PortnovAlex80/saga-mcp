#!/usr/bin/env node
import { execSync } from 'node:child_process';
/**
 * FRF-WP01 — UC-FOREIGN counterexample reproduction (AUDIT MUST).
 *
 * Subject: `validateSolutionContract` at
 * src/workflow-kernel/workshops/formalization/products.ts (~line 767 at
 * base 5c158608). The validator pins the WHAT-baseline revision, the SRS
 * revision and the whole-WHAT digest, but NEVER checks that the
 * `developmentHandoff` member/scenario/requirement/criterion/realization
 * binding ARRAYS resolve against the accepted material's id sets. A
 * handoff that binds FOREIGN ids (another run, another project, a
 * fabricated scenario) therefore validates GREEN and can reach Development
 * as authoritative planning material.
 *
 * This script builds an honest, fully-accepted Formalization material
 * chain (handoff -> PRD -> UC -> requirements -> acceptance -> baseline ->
 * SRS), settles a Solution Contract whose baselineRef/srsRef/digests are
 * all EXACT, and whose binding arrays are all FOREIGN, then runs the
 * installed validator from dist/. Expected output under the defect:
 * `{ ok: true, ... }` — recorded verbatim in
 * uc-foreign-reproduction.output.json next to this file.
 *
 * FRF-09 must turn this into a blocking FOREIGN_LINEAGE refusal.
 *
 * Run: node docs/refactoring/formalization-frf/baseline/uc-foreign-reproduction.mjs
 * (requires `npm run build` first; imports the installed dist artifact,
 * never the TS source — the reproduction targets what is INSTALLED).
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(here, '..', '..', '..', '..');

const products = await import(
  pathToFileURL(path.join(distRoot, 'dist/workflow-kernel/workshops/formalization/products.js')).href
);

/* ------------------------------------------------------------------ */
/* 1. The honest accepted-material chain (exactly what the desks fold)  */
/* ------------------------------------------------------------------ */

const digestOf = (value) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Discovery handoff: two source claims, one constraint, one unknown, one terminal claim.
const handoff = {
  digest: digestOf({ capsule: 'discovery-terminal', v: 1 }),
  sourceClaimIds: ['claim:source-1', 'claim:source-2'],
  constraintIds: ['constraint:1'],
  unknownIds: ['unknown:1'],
  terminalClaimIds: ['terminal:product-delivered'],
};

// Accepted PRD revision: two intent members, both scenario_required.
const prdRevision = digestOf({ members: ['intent:boundary', 'intent:outcome'], v: 1 });
const prd = {
  revisionDigest: prdRevision.replace('sha256:', ''),
  memberIds: ['intent:boundary', 'intent:outcome'],
  scenarioRequiredMemberIds: ['intent:boundary', 'intent:outcome'],
};

// Accepted UC revision: two scenarios with real actor identities.
const ucRevision = digestOf({ scenarios: ['uc:login', 'uc:export'], v: 1 });
const useCases = {
  revisionDigest: ucRevision.replace('sha256:', ''),
  scenarioIds: ['uc:login', 'uc:export'],
};

// Accepted requirements revision: two FRs covering both scenarios.
const reqRevision = digestOf({ requirements: ['fr:auth', 'fr:export'], v: 1 });
const requirements = {
  revisionDigest: reqRevision.replace('sha256:', ''),
  requirementIds: ['fr:auth', 'fr:export'],
};

// Accepted acceptance revision: two criteria covering both terminals.
const accRevision = digestOf({ criteria: ['ac:login-e2e', 'ac:export-e2e'], v: 1 });
const acceptance = {
  revisionDigest: accRevision.replace('sha256:', ''),
  criterionIds: ['ac:login-e2e', 'ac:export-e2e'],
};

// Accepted reconciliation (consistent) + frozen whole-WHAT baseline.
const reconciliation = {
  revisionDigest: digestOf({ verdict: 'consistent', v: 1 }).replace('sha256:', ''),
  verdict: 'consistent',
};
const baselineFreeze = products.freezeWhatBaseline({
  handoffDigest: handoff.digest,
  prdRevisionDigest: prd.revisionDigest,
  ucRevisionDigest: useCases.revisionDigest,
  requirementsRevisionDigest: requirements.revisionDigest,
  acceptanceRevisionDigest: acceptance.revisionDigest,
  reconciliationRevisionDigest: reconciliation.revisionDigest,
  memberDigests: [
    digestOf({ m: 'intent:boundary' }),
    digestOf({ m: 'intent:outcome' }),
    digestOf({ m: 'uc:login' }),
    digestOf({ m: 'uc:export' }),
    digestOf({ m: 'fr:auth' }),
    digestOf({ m: 'fr:export' }),
    digestOf({ m: 'ac:login-e2e' }),
    digestOf({ m: 'ac:export-e2e' }),
  ],
  acceptedTraceDigest: digestOf({ trace: 'accepted-binding-set', v: 1 }),
});
if (!baselineFreeze.ok) throw new Error(`baseline freeze refused: ${baselineFreeze.detail}`);
const baseline = {
  revisionDigest: baselineFreeze.artifact.digest,
  wholeWhatDigest: baselineFreeze.product.wholeWhatDigest,
};

// Accepted SRS revision realizing both scenarios.
const srsRevision = digestOf({ realized: ['uc:login', 'uc:export'], v: 1 });
const srs = {
  revisionDigest: srsRevision.replace('sha256:', ''),
  realizedScenarioIds: ['uc:login', 'uc:export'],
};

const accepted = {
  handoff, prd, useCases, requirements, acceptance, reconciliation, baseline, srs,
};

// Control: the honest chain itself validates (this must be green — the
// chain is lawful; only the binding check is missing).
const honestValidation = products.validateSolutionContract(
  settleHonest().product, accepted,
);

/* ------------------------------------------------------------------ */
/* 2. The UC-FOREIGN settlement: exact refs/digests, FOREIGN bindings   */
/* ------------------------------------------------------------------ */

function settleHonest() {
  return products.settleSolutionContract(
    baseline,
    srs,
    {
      certificateRef: 'certificate:formalization:1',
      prdIntentBindings: ['intent:boundary', 'intent:outcome'],
      scenarioBindings: ['uc:login', 'uc:export'],
      requirementBindings: ['fr:auth', 'fr:export'],
      acceptanceBindings: ['ac:login-e2e', 'ac:export-e2e'],
      scenarioRealizationBindings: ['uc:login', 'uc:export'],
      terminalClaimBindings: ['terminal:product-delivered'],
      integrationObligations: ['obligation:compose-auth-edge'],
      repositoryPolicyBindings: ['policy:repo-main'],
    },
  );
}

const foreign = products.settleSolutionContract(
  baseline,
  srs,
  {
    certificateRef: 'certificate:formalization:1',
    // FOREIGN: none of these ids exist in the accepted material above.
    // They name another run's scenarios/requirements/criteria and a
    // fabricated realization.
    prdIntentBindings: ['intent:STOLEN-from-another-prd'],
    scenarioBindings: ['uc:FOREIGN-admin-shell', 'uc:FOREIGN-not-in-accepted-uc'],
    requirementBindings: ['fr:FOREIGN-never-derived'],
    acceptanceBindings: ['ac:FOREIGN-never-accepted'],
    scenarioRealizationBindings: ['uc:FOREIGN-not-realized-anywhere'],
    terminalClaimBindings: ['terminal:FOREIGN-claim'],
    integrationObligations: ['obligation:FOREIGN-composition'],
    repositoryPolicyBindings: ['policy:FOREIGN-repo'],
  },
);
if (!foreign.ok) {
  console.error('UNEXPECTED: the settler itself refused the foreign handoff:', foreign.detail);
  process.exit(2);
}

const verdict = products.validateSolutionContract(foreign.product, accepted);

/* ------------------------------------------------------------------ */
/* 3. Record the honest output                                         */
/* ------------------------------------------------------------------ */

const record = {
  reproductionId: 'UC-FOREIGN',
  recordedAt: new Date().toISOString(),
  baseSha: execSync('git rev-parse --short HEAD').toString().trim(),
  subject: 'src/workflow-kernel/workshops/formalization/products.ts :: validateSolutionContract (~line 767 at base)',
  installedArtifact: 'dist/workflow-kernel/workshops/formalization/products.js',
  acceptedMaterial: {
    prdMemberIds: prd.memberIds,
    ucScenarioIds: useCases.scenarioIds,
    requirementIds: requirements.requirementIds,
    criterionIds: acceptance.criterionIds,
    srsRealizedScenarioIds: srs.realizedScenarioIds,
    terminalClaimIds: handoff.terminalClaimIds,
    baselineWholeWhatDigest: baseline.wholeWhatDigest,
  },
  controlHonestChain: {
    scenarioBindings: ['uc:login', 'uc:export'],
    validateSolutionContractResult: { ok: honestValidation.ok },
  },
  attackForeignBindings: {
    scenarioBindings: ['uc:FOREIGN-admin-shell', 'uc:FOREIGN-not-in-accepted-uc'],
    requirementBindings: ['fr:FOREIGN-never-derived'],
    acceptanceBindings: ['ac:FOREIGN-never-accepted'],
    scenarioRealizationBindings: ['uc:FOREIGN-not-realized-anywhere'],
    prdIntentBindings: ['intent:STOLEN-from-another-prd'],
    terminalClaimBindings: ['terminal:FOREIGN-claim'],
  },
  validateSolutionContractResult: verdict,
  verdictUnderTheDefect: verdict.ok
    ? 'GREEN — the foreign handoff is ACCEPTED as an authoritative Solution Contract (the audit counterexample reproduces)'
    : `refused (${verdict.reason}: ${verdict.detail})`,
  requiredFrF09Behavior:
    'FOREIGN_LINEAGE refusal: every handoff binding array must resolve against the exact accepted material id sets (accepted.prd.memberIds, accepted.useCases.scenarioIds, accepted.requirements.requirementIds, accepted.acceptance.criterionIds, accepted.srs.realizedScenarioIds, accepted.handoff.terminalClaimIds).',
};

console.log(JSON.stringify(record, null, 2));

await writeFile(
  path.join(here, 'uc-foreign-reproduction.output.json'),
  JSON.stringify(record, null, 2) + '\n',
  'utf8',
);
process.exit(verdict.ok ? 0 : 1);
