import type Database from 'better-sqlite3';

const DISCOVERY_MODULE_REF = 'product-discovery@3.0.2';
const DISCOVERY_READINESS_NODE = 'assess-readiness';
const DISCOVERY_PROPOSAL_SCHEMA = 'factory.discovery-proposal.v1';
const DISCOVERY_READINESS_SCHEMA = 'factory.discovery-readiness-assessment.v1';

/**
 * Rebind opaque identities that a worker learned through Factory read APIs,
 * rather than receiving as ordinary business input.
 *
 * Replay restores certified worker production, but opaque refs/ids that belong
 * to the source Factory Run cannot be authoritative in the current Run. This
 * adapter changes only those read-derived identities. Current CandidateSets,
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

  const currentAuthor = db.prepare(
    `SELECT candidate_set_ref
       FROM factory_candidate_sets
      WHERE workplace_ref=? AND role='author'
      ORDER BY sealed_at DESC,candidate_set_ref DESC
      LIMIT 1`,
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
