/**
 * FRF-WP03 pure validator: PRD intent member
 * (contract frf-contracts.prd-intent-member.v1).
 *
 * Deterministic, closed-vocabulary, fail-closed with typed refusal codes.
 * Takes the accepted id-set universe as INPUT; bindings that do not resolve
 * against the supplied accepted sets are refused FOREIGN_LINEAGE (the
 * UC-FOREIGN fix TARGET pattern: never trust a binding without its accepted
 * universe).
 *
 * Typed refusals:
 *   MALFORMED_PRODUCT - structural violations, open vocabularies,
 *                       missing disposition parts (owner/reason).
 *   SCOPE_VIOLATION   - the member carries final requirements / scenarios /
 *                       acceptance / SRS content (define-product-intent fence).
 *   MISSING_LINEAGE   - no accepted source-claim set supplied; empty refs.
 *   COVERAGE_GAP      - member has no required disposition (coverage law).
 *   FOREIGN_LINEAGE   - source/scope/terminal-claim refs outside the exact
 *                       accepted sets.
 */

import {
  REFUSAL_REASONS,
  refused,
  resolveRefs,
  sealed,
} from './common.mjs';

export const CONTRACT_KIND = 'frf-contracts.prd-intent-member.v1';

const MEMBER_KINDS = Object.freeze([
  'actor-stakeholder',
  'assumption-unknown',
  'constraint',
  'outcome',
  'scope-exclusion',
  'system-boundary',
  'terminal-claim',
]);

const DISPOSITIONS = Object.freeze([
  'deferred',
  'direct_requirement',
  'out_of_scope',
  'scenario_required',
]);

/** Keys the product-intent desk must never produce (plan desk contract). */
const FORBIDDEN_KEYS = Object.freeze([
  'acceptance',
  'acceptanceCriteria',
  'fr',
  'nfr',
  'requirements',
  'rule',
  'scenarios',
  'srs',
  'useCases',
]);

export function validatePrdIntentMember(member, universe) {
  if (member === null || typeof member !== 'object' || Array.isArray(member)) {
    return refused('MALFORMED_PRODUCT', 'PRD intent member is not an object');
  }
  if (member.schemaVersion !== CONTRACT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${CONTRACT_KIND}`);
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    if (member[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `the product-intent desk must not produce final ${forbidden} content`);
    }
  }
  if (typeof member.memberId !== 'string' || member.memberId.length === 0) {
    return refused('MALFORMED_PRODUCT', 'every PRD intent member needs a stable id');
  }
  const purpose = `PRD member ${member.memberId}`;
  if (typeof member.statement !== 'string' || member.statement.length === 0) {
    return refused('MALFORMED_PRODUCT', `${purpose} needs a statement`);
  }
  if (!MEMBER_KINDS.includes(member.memberKind)) {
    return refused('MALFORMED_PRODUCT', `${purpose} has member kind ${String(member.memberKind)} outside the closed seven-kind vocabulary`);
  }

  // Lineage: exact Discovery source claims (fail-closed against the supplied set).
  const claimRefusal = resolveRefs(member.sourceClaimRefs, 'sourceClaimIds', universe, { purpose });
  if (claimRefusal !== null) return claimRefusal;
  if (Array.isArray(member.scopeClaimRefs) && member.scopeClaimRefs.length > 0) {
    // Scope claims are a subset class of the accepted source claims.
    const scopeRefusal = resolveRefs(member.scopeClaimRefs, 'sourceClaimIds', universe, { purpose });
    if (scopeRefusal !== null) return scopeRefusal;
  }
  if (Array.isArray(member.terminalClaimRefs) && member.terminalClaimRefs.length > 0) {
    const terminalRefusal = resolveRefs(member.terminalClaimRefs, 'terminalClaimIds', universe, { purpose });
    if (terminalRefusal !== null) return terminalRefusal;
  }

  // Disposition: exactly one of the closed four; coverage law (cr-04).
  const disposition = member.disposition;
  if (disposition === undefined) {
    return refused('COVERAGE_GAP', `${purpose} has no required disposition (exactly one of scenario_required, direct_requirement, deferred, out_of_scope is required)`);
  }
  if (disposition === null || typeof disposition !== 'object' || Array.isArray(disposition)) {
    return refused('MALFORMED_PRODUCT', `${purpose} carries a malformed disposition record`);
  }
  if (!DISPOSITIONS.includes(disposition.disposition)) {
    return refused('MALFORMED_PRODUCT', `${purpose} has disposition ${String(disposition.disposition)} outside the closed four-value vocabulary`);
  }
  if ((disposition.disposition === 'deferred' || disposition.disposition === 'out_of_scope')
    && (typeof disposition.owner !== 'string' || disposition.owner.length === 0 || typeof disposition.reason !== 'string' || disposition.reason.length === 0)) {
    return refused('MALFORMED_PRODUCT', `${disposition.disposition} of ${member.memberId} requires an owner and a reason`);
  }
  if (disposition.disposition === 'direct_requirement'
    && (typeof disposition.reason !== 'string' || disposition.reason.length === 0)) {
    return refused('MALFORMED_PRODUCT', `direct requirement route of ${member.memberId} requires a reason (why no meaningful interaction or operational scenario exists)`);
  }
  return sealed(CONTRACT_KIND, member);
}

export { REFUSAL_REASONS };
