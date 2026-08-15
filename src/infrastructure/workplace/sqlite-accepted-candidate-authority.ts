import type Database from 'better-sqlite3';
import type { AcceptedCandidateAuthority } from '../../process-modules/application/post-acceptance-effects.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

/** Hydrate/verify the exact persisted authority before any post-seal effect. */
export function assertPersistedAcceptedCandidateAuthority(
  db: Database.Database,
  authority: AcceptedCandidateAuthority,
): void {
  const workplaceRef = serializeWorkplaceRef(authority.workplaceRef);
  const candidate = db.prepare(
    `SELECT workplace_ref,production_revision_ref
       FROM factory_candidate_sets WHERE candidate_set_ref=?`,
  ).get(authority.candidateSetRef) as {
    workplace_ref: string;
    production_revision_ref: string;
  } | undefined;
  if (!candidate
      || candidate.workplace_ref !== workplaceRef
      || candidate.production_revision_ref !== authority.productionRevisionRef) {
    throw new Error('AUTHORITY_CANDIDATE_REVISION_MISMATCH');
  }
  const revision = db.prepare(
    `SELECT workplace_ref FROM factory_workplace_production_revisions
      WHERE revision_ref=?`,
  ).get(authority.productionRevisionRef) as { workplace_ref: string } | undefined;
  if (!revision || revision.workplace_ref !== workplaceRef) {
    throw new Error('AUTHORITY_REVISION_WORKPLACE_MISMATCH');
  }
  const members = db.prepare(
    `SELECT product_schema AS schemaId,product_ref AS ref,product_digest AS digest
       FROM factory_candidate_set_members
      WHERE candidate_set_ref=? ORDER BY ordinal`,
  ).all(authority.candidateSetRef) as Array<{
    schemaId: string;
    ref: string;
    digest: string;
  }>;
  const memberCoordinates = new Set(members.map(member => canonicalProductRefs([member])));
  if (authority.acceptedProductRefs.some(product => !memberCoordinates.has(canonicalProductRefs([product])))) {
    throw new Error('AUTHORITY_PRODUCT_MEMBERS_MISMATCH');
  }
  if (members.filter(member => member.schemaId === authority.productSchema).length !== 1) {
    throw new Error('AUTHORITY_PRODUCT_SCHEMA_MISMATCH');
  }
  const decision = db.prepare(
    `SELECT workplace_ref,subject_candidate_set_ref,gate_phase,verdict,accepted_output_bindings
       FROM factory_gate_decisions WHERE decision_key=?`,
  ).get(authority.gateDecisionKey) as {
    workplace_ref: string;
    subject_candidate_set_ref: string;
    gate_phase: string;
    verdict: string;
    accepted_output_bindings: string;
  } | undefined;
  if (!decision
      || decision.workplace_ref !== workplaceRef
      || decision.subject_candidate_set_ref !== authority.candidateSetRef
      || decision.gate_phase !== 'final'
      || decision.verdict !== 'accepted') {
    throw new Error('AUTHORITY_GATE_DECISION_MISMATCH');
  }
  const bindings = JSON.parse(decision.accepted_output_bindings) as Array<{
    binding: string;
    productRefs: typeof members;
    productContractRef?: AcceptedCandidateAuthority['productContractRef'];
  }>;
  const primary = bindings.filter(binding => binding.binding === 'primary-output');
  if (primary.length !== 1
      || canonicalProductRefs(primary[0]!.productRefs) !== canonicalProductRefs(authority.acceptedProductRefs)
      || primary[0]!.productRefs.length !== 1
      || primary[0]!.productRefs[0]!.schemaId !== authority.productSchema
      || JSON.stringify(primary[0]!.productContractRef ?? null) !== JSON.stringify(authority.productContractRef)) {
    throw new Error('AUTHORITY_ACCEPTED_OUTPUT_BINDING_MISMATCH');
  }
  const appliedHead = db.prepare(
    `SELECT decision_key FROM factory_workplace_gate_decision_heads
      WHERE workplace_ref=?`,
  ).get(workplaceRef) as { decision_key: string } | undefined;
  if (!appliedHead || appliedHead.decision_key !== authority.gateDecisionKey) {
    throw new Error('AUTHORITY_APPLIED_GATE_HEAD_MISMATCH');
  }
}

function canonicalProductRefs(
  refs: readonly { schemaId: string; ref: string; digest: string }[],
): string {
  return JSON.stringify([...refs]
    .map(ref => ({ schemaId: ref.schemaId, ref: ref.ref, digest: ref.digest }))
    .sort((a, b) => a.schemaId.localeCompare(b.schemaId)
      || a.digest.localeCompare(b.digest)
      || a.ref.localeCompare(b.ref)));
}
