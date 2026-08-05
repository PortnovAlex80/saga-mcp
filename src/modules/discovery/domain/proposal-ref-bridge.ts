/**
 * ProposalRefBridge — convert discovery proposals to ProductRef for the
 * universal desk (Conveyor v4 step 3.B.1).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-11 (Изделие) +
 * Conveyor Mental Model v4 §«One machine, one material, one desk».
 *
 * # Why this bridge exists
 *
 * Discovery's product is a proposal (text JSON in `saga3_proposals`). v4
 * requires every workshop to place text on one universal desk. Like the
 * Formalization artifact-ref bridge, this bridge lets Discovery place a
 * REFERENCE to the proposal (not a body copy) on the desk. The proposal body
 * stays in `saga3_proposals` (single source of truth for D3/D4/D5
 * settlement/certificate chain); the desk carries the content-addressed
 * pointer.
 *
 * The ProductRef's:
 *   - `schemaId` = `'saga3.discovery-proposal-ref.v1'`
 *   - `ref` = `'proposal:<id>#<contentHash>'`
 *   - `digest` = the proposal's `content_hash`
 *
 * D4 settlement continues to reference proposals by their numeric
 * `proposal_id`; the bridge is a one-way mapping that makes the proposal
 * visible on the universal desk WITHOUT duplicating its body. Settlement
 * tables (readiness/settlement/certificate) are NOT affected — they stay
 * authoritative D3/D4/D5.
 */

import type { ProductRef } from '../../../process-modules/domain/spi/index.js';

/** The schema id for a proposal-reference product on the universal desk. */
export const PROPOSAL_REF_SCHEMA = 'saga3.discovery-proposal-ref.v1' as const;

/**
 * Build a ProductRef that references a discovery proposal BY ID + content-hash.
 */
export function buildProposalProductRef(input: {
  proposalId: number;
  contentHash: string;
}): ProductRef {
  if (!Number.isInteger(input.proposalId) || input.proposalId <= 0) {
    throw new Error(
      `buildProposalProductRef: proposalId must be a positive integer, got ${input.proposalId}`,
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(input.contentHash)) {
    throw new Error(
      `buildProposalProductRef: contentHash must be a 64-char hex SHA-256`,
    );
  }
  return {
    schemaId: PROPOSAL_REF_SCHEMA,
    ref: `proposal:${input.proposalId}#${input.contentHash}`,
    digest: input.contentHash,
  };
}

/**
 * Parse a proposal-ref ProductRef back into its components.
 */
export function parseProposalProductRef(ref: ProductRef): {
  proposalId: number;
  contentHash: string;
} {
  if (ref.schemaId !== PROPOSAL_REF_SCHEMA) {
    throw new Error(
      `parseProposalProductRef: expected schema '${PROPOSAL_REF_SCHEMA}', got '${ref.schemaId}'`,
    );
  }
  const m = /^proposal:(\d+)#([a-f0-9]{64})$/i.exec(ref.ref);
  if (!m) {
    throw new Error(
      `parseProposalProductRef: ref '${ref.ref}' does not match proposal:<id>#<hash>`,
    );
  }
  return {
    proposalId: Number(m[1]),
    contentHash: m[2]!.toLowerCase(),
  };
}

/**
 * Verify a proposal's content_hash matches the ProductRef's digest.
 * REG-11-AC-02: hash checked at the trust boundary.
 */
export function proposalHashMatchesRef(
  proposalContentHash: string | null,
  ref: ProductRef,
): boolean {
  if (!proposalContentHash) return false;
  return proposalContentHash.toLowerCase() === ref.digest.toLowerCase();
}
