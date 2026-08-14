import type Database from 'better-sqlite3';

const DISCOVERY_MODULE_REF = 'product-discovery@3.0.2';
const DISCOVERY_READINESS_NODE = 'assess-readiness';
const DISCOVERY_PROPOSAL_SCHEMA = 'factory.discovery-proposal.v1';
const DISCOVERY_READINESS_SCHEMA = 'factory.discovery-readiness-assessment.v1';

const DEVELOPMENT_MODULE_REFS = new Set([
  'solution-development@1.1.0',
  'solution-development@1.2.0',
  'solution-development@1.3.0',
]);
const DEVELOPMENT_VERIFICATION_NODE = 'verify-acceptance';
const DEVELOPMENT_INTEGRATED_CANDIDATE_SCHEMA = 'factory.integrated-release-candidate.v1';
const DEVELOPMENT_VERIFICATION_EVIDENCE_SCHEMA = 'factory.candidate-verification-evidence-product.v2';

/**
 * Rebind opaque identities that a worker learned through Factory read APIs or
 * current-run authority inputs, rather than producing as semantic business data.
 *
 * Replay restores certified worker production, but opaque refs/ids that belong
 * to the source Factory Run cannot be authoritative in the current Run. This
 * adapter changes only those authority-bound identities. Current CandidateSets,
 * ProductRefs and Gates remain the authority and validate the rebound product.
 */
export function rebindReplayAuthorityReferences(
  db: Database.Database,
  taskMetadata: Readonly<Record<string, unknown>>,
  schemaId: string,
  value: unknown,
): unknown {
  let rebound = value;

  if (taskMetadata.role === 'reviewer') {
    rebound = rebindReviewerCandidateSet(db, taskMetadata, rebound);
  }

  if (
    taskMetadata.process_module_ref === DISCOVERY_MODULE_REF
    && taskMetadata.process_node_id === DISCOVERY_READINESS_NODE
    && taskMetadata.role === 'author'
    && schemaId === DISCOVERY_READINESS_SCHEMA
  ) {
    rebound = rebindDiscoveryProposal(taskMetadata, rebound);
  }

  if (
    DEVELOPMENT_MODULE_REFS.has(String(taskMetadata.process_module_ref))
    && taskMetadata.process_node_id === DEVELOPMENT_VERIFICATION_NODE
    && taskMetadata.role === 'author'
    && schemaId === DEVELOPMENT_VERIFICATION_EVIDENCE_SCHEMA
  ) {
    rebound = rebindDevelopmentVerificationCandidate(taskMetadata, rebound);
  }

  return rebound;
}

function rebindReviewerCandidateSet(
  db: Database.Database,
  taskMetadata: Readonly<Record<string, unknown>>,
  value: unknown,
): unknown {
  const workplaceRef = typeof taskMetadata.workplace_ref === 'string'
    ? taskMetadata.workplace_ref
    : null;
  if (!workplaceRef) {
    throw new Error('CAPSULE_REPLAY_AUTHORITY_CONTEXT_MISSING: reviewer task has no workplace_ref');
  }

  // ADR-053 cutover: resolve the accepted author CandidateSet by EXACT gate-
  // decision ref (the final-accepted verdict's subject_candidate_set_ref),
  // NOT by recency (ORDER BY sealed_at DESC). The reviewer replays against the
  // AUTHORITY-ACCEPTED author set, which is exactly what the gate decision
  // records. Recency could pick a rejected repair attempt sealed later.
  const currentAuthor = db.prepare(
    `SELECT accepted_author_candidate_set_ref AS candidate_set_ref
       FROM factory_accepted_authority_head
      WHERE workplace_ref=?`,
  ).get(workplaceRef) as { candidate_set_ref: string } | undefined;
  if (!currentAuthor) {
    throw new Error(
      `CAPSULE_REPLAY_AUTHORITY_SUBJECT_MISSING: ${workplaceRef} has no current author CandidateSet`,
    );
  }

  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    const row = item as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(row)) {
      if (
        (key === 'subject_candidate_set_ref' || key === 'subjectCandidateSetRef')
        && typeof child === 'string'
        && child.startsWith('candidate-set/')
      ) {
        result[key] = currentAuthor.candidate_set_ref;
      } else {
        result[key] = visit(child);
      }
    }
    return result;
  };

  return visit(value);
}

function rebindDiscoveryProposal(
  taskMetadata: Readonly<Record<string, unknown>>,
  value: unknown,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CAPSULE_REPLAY_DISCOVERY_PRODUCT_INVALID: readiness assessment must be an object');
  }

  const currentInput = taskMetadata.process_node_input ?? taskMetadata.cell_input_item;
  const proposalRef = findExactProductRef(currentInput, DISCOVERY_PROPOSAL_SCHEMA);
  if (!proposalRef) {
    throw new Error(
      'CAPSULE_REPLAY_DISCOVERY_SOURCE_MISSING: current readiness input has no exact discovery proposal ProductRef',
    );
  }
  const prefix = 'managed-node-submission:';
  if (!proposalRef.ref.startsWith(prefix)) {
    throw new Error(
      `CAPSULE_REPLAY_DISCOVERY_SOURCE_INVALID: unsupported proposal ref '${proposalRef.ref}'`,
    );
  }
  const proposalId = Number(proposalRef.ref.slice(prefix.length));
  if (!Number.isSafeInteger(proposalId) || proposalId < 1) {
    throw new Error(
      `CAPSULE_REPLAY_DISCOVERY_SOURCE_INVALID: malformed proposal ref '${proposalRef.ref}'`,
    );
  }

  return {
    ...(value as Record<string, unknown>),
    proposal_id: proposalId,
    proposal_content_hash: proposalRef.digest,
  };
}

function rebindDevelopmentVerificationCandidate(
  taskMetadata: Readonly<Record<string, unknown>>,
  value: unknown,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'CAPSULE_REPLAY_DEVELOPMENT_VERIFICATION_INVALID: verification product must be an object',
    );
  }
  const currentInput = taskMetadata.process_node_input ?? taskMetadata.cell_input_item;
  const candidate = findObject(
    currentInput,
    row => row.schemaVersion === DEVELOPMENT_INTEGRATED_CANDIDATE_SCHEMA
      && typeof row.candidateHash === 'string'
      && row.candidateHash.length > 0,
  );
  if (!candidate || typeof candidate.candidateHash !== 'string') {
    throw new Error(
      'CAPSULE_REPLAY_DEVELOPMENT_CANDIDATE_MISSING: current verification input has no frozen candidate',
    );
  }
  return {
    ...(value as Record<string, unknown>),
    candidateHash: candidate.candidateHash,
  };
}

function findObject(
  value: unknown,
  predicate: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (predicate(row)) return row;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findObject(child, predicate);
    if (found) return found;
  }
  return null;
}

function findExactProductRef(
  value: unknown,
  schemaId: string,
): { ref: string; digest: string } | null {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (
      row.schemaId === schemaId
      && typeof row.ref === 'string'
      && typeof row.digest === 'string'
    ) {
      return { ref: row.ref, digest: row.digest };
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findExactProductRef(child, schemaId);
    if (found) return found;
  }
  return null;
}
