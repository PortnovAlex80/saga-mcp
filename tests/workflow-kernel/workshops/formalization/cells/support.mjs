/**
 * support.mjs - FRF-WP04 focused-suite support: loads the REAL FRF-WP03
 * contract validators from the docs tree, installs them into the two
 * Production Cell seams (content-addressed to the validator file bytes),
 * and builds the green bundles + RED-seed corpus the cell gates run over.
 *
 * THE SEAM (honest): the cells (src/.../cells/{product-intent,use-cases})
 * never import the docs tree; THIS file is the test-time wiring point:
 *
 *   WP03 validator (docs/refactoring/formalization-frf/contracts/)
 *     -> adapter with validatorDigest = sha256(validator .mjs bytes)
 *     -> cell.install<ProductIntent|UcScenario>Contract(...)
 *     -> the cell gates call the WP03 semantics through the seam.
 *
 * FRF-11 replaces this injection with installed-package wiring and
 * deletes the test-only seam resets.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))));
const CONTRACTS = join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts');

export const dist = (relative) => import(`../../../../../dist/${relative}`);

const sha256OfBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

/* ------------------------------------------------------------------ */
/* The WP03 contracts (docs tree; loaded here ONLY, never by the cells) */
/* ------------------------------------------------------------------ */

export async function loadWp03PrdValidator() {
  return import(pathToFileURL(join(CONTRACTS, 'validators', 'prd-intent-member.mjs')).href);
}

export async function loadWp03UcValidator() {
  return import(pathToFileURL(join(CONTRACTS, 'validators', 'uc-scenario-member.mjs')).href);
}

/** Install the real WP03 PRD validator into the product-intent cell seam. */
export async function installProductIntentWp03Seam() {
  const cell = await dist('workflow-kernel/workshops/formalization/cells/product-intent/index.js');
  const wp03 = await loadWp03PrdValidator();
  const validatorDigest = sha256OfBytes(readFileSync(join(CONTRACTS, 'validators', 'prd-intent-member.mjs')));
  const outcome = cell.installProductIntentContract({
    contractKind: 'frf-contracts.prd-intent-member.v1',
    validatorDigest,
    validateMember: (member, universe) => wp03.validatePrdIntentMember(member, universe),
  });
  if (!('installed' in outcome) || outcome.installed !== true) {
    throw new Error(`product-intent seam install refused: ${JSON.stringify(outcome)}`);
  }
  return { cell, validatorDigest };
}

/** Install the real WP03 UC validator into the use-cases cell seam. */
export async function installUcWp03Seam() {
  const cell = await dist('workflow-kernel/workshops/formalization/cells/use-cases/index.js');
  const wp03 = await loadWp03UcValidator();
  const validatorDigest = sha256OfBytes(readFileSync(join(CONTRACTS, 'validators', 'uc-scenario-member.mjs')));
  const outcome = cell.installUcScenarioContract({
    contractKind: 'frf-contracts.uc-scenario-member.v1',
    validatorDigest,
    validateScenario: (scenario, universe) => wp03.validateUcScenarioMember(scenario, universe),
  });
  if (!('installed' in outcome) || outcome.installed !== true) {
    throw new Error(`use-cases seam install refused: ${JSON.stringify(outcome)}`);
  }
  return { cell, validatorDigest };
}

/* ------------------------------------------------------------------ */
/* The WP03 fixture corpus                                             */
/* ------------------------------------------------------------------ */

export function acceptedIdSets() {
  return JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'accepted-id-sets.json'), 'utf8')).idSets;
}

export function greenPrdMember() {
  return JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'green', 'prd-intent-member.json'), 'utf8'));
}

export function greenUcScenario() {
  return JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'green', 'uc-scenario-member.json'), 'utf8'));
}

/** Every RED seed of one desk prefix ('prd' | 'uc'): { file, reason, member }. */
export function redSeeds(prefix) {
  const dir = join(CONTRACTS, 'fixtures', 'red');
  const pattern = prefix === 'prd' ? /^0[1-7]-prd-/ : /^(0[89]|1[0-4])-uc-/;
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const match = name.match(/\.(FOREIGN_LINEAGE|COVERAGE_GAP|MALFORMED_PRODUCT|SCOPE_VIOLATION|MISSING_LINEAGE|STALE_LINEAGE|DRIFT_DETECTED)\.json$/);
      if (match === null) throw new Error(`RED seed ${name} has no typed refusal suffix`);
      return { file: name, reason: match[1], member: JSON.parse(readFileSync(join(dir, name), 'utf8')) };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

/* ------------------------------------------------------------------ */
/* Green bundles                                                       */
/* ------------------------------------------------------------------ */

/** The accepted-id-set universe of the product-intent desk (Discovery handoff sets). */
export function prdUniverseOf() {
  const sets = acceptedIdSets();
  return { idSets: { sourceClaimIds: sets.sourceClaimIds, terminalClaimIds: sets.terminalClaimIds } };
}

/**
 * The green product-intent bundle: six WP03 members over the accepted
 * Discovery claim sets, jointly covering EVERY accepted source claim
 * (the desk coverage law) with all four dispositions exercised.
 */
export function greenPrdBundle() {
  return {
    schemaVersion: 'frf-cell.product-intent.v1',
    brief: 'A checkout shopping service with an audited nightly settlement batch.',
    members: [
      greenPrdMember(),
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:boundary-1',
        memberKind: 'system-boundary',
        statement: 'The checkout service and its nightly batch are inside the boundary; external payment providers are outside.',
        sourceClaimRefs: ['claim:scope-1'],
        disposition: { disposition: 'scenario_required' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:constraint-1',
        memberKind: 'constraint',
        statement: 'Responses are deterministic; the batch writes an audit trail for every charge.',
        sourceClaimRefs: ['claim:constraint-1'],
        disposition: { disposition: 'direct_requirement', reason: 'An operational determinism constraint with no meaningful interaction scenario.' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:scope-2',
        memberKind: 'scope-exclusion',
        statement: 'Multi-currency settlement is excluded from this release.',
        sourceClaimRefs: ['claim:scope-2'],
        disposition: { disposition: 'out_of_scope', owner: 'product-owner', reason: 'Deferred to the next release by the discovery decision.' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:terminal-1',
        memberKind: 'terminal-claim',
        statement: 'At terminal state every charge is settled or recorded failed with an audit entry.',
        sourceClaimRefs: ['claim:outcome-1'],
        terminalClaimRefs: ['terminal:audited-1'],
        disposition: { disposition: 'scenario_required' },
      },
      {
        schemaVersion: 'frf-contracts.prd-intent-member.v1',
        memberId: 'prd:unknown-1',
        memberKind: 'assumption-unknown',
        statement: 'The browser support matrix is unknown at formalization time.',
        sourceClaimRefs: ['claim:constraint-1'],
        disposition: { disposition: 'deferred', owner: 'discovery', reason: 'Browser support matrix unknown (owner: discovery).' },
      },
    ],
  };
}

/**
 * The green use-cases bundle: the WP03 green checkout scenario plus an
 * authored scheduler_or_clock batch scenario; together they cover every
 * scenario_required member of the upstream accepted intent set.
 */
export function greenUcBundle() {
  return {
    schemaVersion: 'frf-cell.uc-scenarios.v1',
    scenarios: [
      greenUcScenario(),
      {
        schemaVersion: 'frf-contracts.uc-scenario-member.v1',
        scenarioId: 'uc:batch-1',
        actorKind: 'scheduler_or_clock',
        actorIdentity: 'the nightly settlement tick',
        goal: 'Settle every pending charge of the day with an audit trail',
        trigger: 'The nightly tick fires at 02:00',
        preconditions: ['pending charges exist from the day'],
        operationalSteps: [
          'The tick selects all pending charges',
          'The system charges each selected order',
          'The system writes the audit trail entry for every charge',
        ],
        alternateFlows: [],
        errorFlows: [
          {
            branchId: 'branch:batch-error',
            steps: [
              'A charge fails',
              'The system records the failed charge and keeps the order pending',
            ],
          },
        ],
        terminalBranches: [
          { branchId: 'branch:batch-main', branchKind: 'main', terminalResult: 'Batch settled with audit entries for every charge' },
          { branchId: 'branch:batch-error', branchKind: 'error', terminalResult: 'Failed charge recorded, order kept pending, audit entry written' },
        ],
        postcondition: 'Every charge is settled or recorded failed with an audit entry',
        prdIntentRefs: ['prd:boundary-1', 'prd:terminal-1'],
        evidenceKindRefs: ['audit'],
      },
    ],
  };
}
