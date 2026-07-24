/**
 * Shared canonicalization + hashing utilities for the Saga 3 Discovery Edition.
 *
 * This module lives in a NEUTRAL layer (src/saga3/shared) so that BOTH the
 * domain layer (settlement policy, input snapshot, certificate) and the
 * persistence layer (proposal/normalization/readiness/settlement repositories)
 * can hash inputs byte-identically. Previously canonicalJson lived in the
 * persistence layer and the domain imported it — an inverted dependency that
 * the architecture test did not catch because it only grepped for "sqlite".
 *
 * Discovery Edition requires deterministic hashing for: proposal content_hash,
 * readiness assessment content_hash, settlement input_hash, policy_hash, and
 * certificate_hash. All of them must be produced by ONE canonicalizer so the
 * lineage hashes are byte-compatible.
 *
 * This module is PURE: only node:crypto. No SQLite, no LM, no I/O.
 */

import { createHash } from 'node:crypto';
import type { DiscoveryProposalPayload } from '../domain/discovery-proposal.js';

/**
 * Deterministic, recursive canonical JSON serialization: object keys sorted
 * lexicographically, arrays in order, scalars via JSON.stringify. Identical to
 * the previous persistence-layer helper (moved here byte-for-byte so all
 * existing hashes remain stable). No whitespace.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 over the canonical JSON of a value, returned as lowercase hex. The
 * single hashing primitive used across Discovery Edition.
 */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * The lineage identifiers a discovery source-ref collector needs from a
 * canonical Proposal row. Generic so both the D3 readiness handler and the D4
 * settlement service can pass their row shapes without duplicating the logic.
 */
export interface DiscoverySourceRefTarget {
  /** The canonical Proposal id. */
  proposalId: number;
  /** Raw submission id, or null for a direct worker proposal. */
  sourceSubmissionId: number | null;
  /** Normalization proposal id, or null when not LM-transformed. */
  normalizationProposalId: number | null;
}

/**
 * Build the EXACT set of source identifiers a readiness advisor is allowed to
 * cite, derived from the canonical Proposal. This is the anti-invent-evidence
 * contract: anything outside this set is rejected by validateReadinessAssessment.
 *
 * Allowed sources:
 *   - the proposal lineage id `proposal:<id>`;
 *   - JSON paths into the canonical Proposal payload fields (`$.problem_statement`, ...);
 *   - indexed evidence paths (`$.evidence_refs[0]`) + the literal evidence strings;
 *   - lineage identifiers `raw:<id>` / `normalization:<id>` when present.
 *
 * SINGLE SOURCE OF TRUTH: the D3 readiness handler and the D4 settlement
 * re-validation MUST use this same function. Previously the two copies drifted
 * (one accepted `proposal:7`/`$.problem_statement`, the other
 * `proposal.problem_statement`), which made an accepted assessment fail
 * settlement re-validation and produce a misleading CLARIFY_READINESS_FAILED.
 */
export function collectDiscoverySourceRefs(
  target: DiscoverySourceRefTarget,
  payload: DiscoveryProposalPayload,
): string[] {
  const refs = new Set<string>();
  refs.add(`proposal:${target.proposalId}`);
  for (const key of Object.keys(payload)) {
    refs.add(`$.${key}`);
  }
  payload.evidence_refs.forEach((evidence, index) => {
    refs.add(`$.evidence_refs[${index}]`);
    refs.add(evidence);
  });
  if (target.sourceSubmissionId !== null) {
    refs.add(`raw:${target.sourceSubmissionId}`);
  }
  if (target.normalizationProposalId !== null) {
    refs.add(`normalization:${target.normalizationProposalId}`);
  }
  return [...refs];
}
