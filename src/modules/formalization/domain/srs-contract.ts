/**
 * Canonical SRS contract — the single source of truth for what a valid SRS
 * must contain. Used by:
 *   - architect skill (produces artifacts matching this contract)
 *   - SRS template (sections match this contract)
 *   - srs-contract-validator (pre-submit structural check)
 *   - architecture-reviewer skill (semantic review against this contract)
 *
 * Contract version pinning: the version + digest are stamped on the
 * formalization-architect execution profile, which flows through WorkIntent
 * authority_scope to both author and reviewer. A reviewer checking an SRS
 * produced under contract v2.1 with reviewer rules from v2.2 throws
 * SRS_CONTRACT_VERSION_MISMATCH, not changes_requested.
 *
 * When the contract changes (new required field, new section, changed enum):
 *   1. Bump SRS_CONTRACT_VERSION
 *   2. Recompute SRS_CONTRACT_DIGEST (sha256 of the canonical contract JSON)
 *   3. Update architect skill + template + validator + reviewer to match
 *   4. Old SRS artifacts created under a previous version are NOT retroactively
 *      re-checkable — their metadata carries the version they were created under.
 */

import { createHash } from 'node:crypto';

export const SRS_CONTRACT_VERSION = '2.2' as const;

/**
 * The canonical contract definition. Content-addressed via SRS_CONTRACT_DIGEST.
 * Every consumer (architect, template, validator, reviewer) MUST agree on this
 * shape — it is the machine-checked source of truth that replaces ad-hoc skill
 * text as the authority for SRS validity.
 */
export const SRS_CONTRACT = {
  version: SRS_CONTRACT_VERSION,
  requiredSections: [
    '§2.1 Architectural Style',
    '§2.2 Module Manifest',
    '§2.3 Invariant Registry',
    '§2.5 Test Strategy',
    '§7 Glossary',
    '§9 Technology Stack',
    '§D Decomposition',
    '§12 Decision Log',
  ],
  conditionalSections: {
    '§2b API Contract / Port Registry': 'if any public protocol',
    '§10 Supporting Systems': 'L/XL only',
    '§11 External Integration Landscape': 'if external I/O',
  },
  d2RequiredFields: [
    'ac',
    'title',
    'module',
    'files',
    'invariants',
    'test_layers',
    'pattern',
    'depends_on',
    'ac_kind',
    'criticality',
  ],
  d2EnumFields: {
    ac_kind: ['implementation', 'verification'],
    pattern: ['A', 'B'],
    criticality: ['blocker', 'degradable', 'nice_to_have'],
  },
  decisionLogColumns: [
    '#',
    'Decision',
    'Source/profile',
    'Alternatives considered',
    'Rationale',
    'Date',
  ],
  decisionLogPolicy: 'semantic-coverage-no-numeric-minimum',
} as const;

/**
 * Content-addressed digest of the canonical contract. Computed once at module
 * load. When the contract changes, this digest changes — that is the signal
 * that all consumers must be re-synchronized.
 */
export const SRS_CONTRACT_DIGEST: string = createHash('sha256')
  .update(JSON.stringify(SRS_CONTRACT), 'utf8')
  .digest('hex');

/**
 * Contract reference stamped on WorkIntent / execution profile.
 * Author and reviewer MUST carry the same ref — if they differ, the
 * reviewer is checking an SRS against a contract it was not produced under.
 */
export interface SrsContractRef {
  readonly version: string;
  readonly digest: string;
}

export const SRS_CONTRACT_REF: SrsContractRef = {
  version: SRS_CONTRACT_VERSION,
  digest: SRS_CONTRACT_DIGEST,
};
