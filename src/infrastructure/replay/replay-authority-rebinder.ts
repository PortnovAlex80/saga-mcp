import type Database from 'better-sqlite3';

/**
 * Rebind authority identities that are discovered through Factory read APIs,
 * rather than supplied as worker input.
 *
 * A reviewer obtains the author CandidateSet through candidate_read. Therefore
 * a captured review verdict legitimately contains the source run's
 * subject_candidate_set_ref, but that opaque authority ref MUST NOT be replayed
 * into a new Factory Run. Replay restores the worker's semantic verdict while
 * binding it to the current Workplace's current author CandidateSet. The
 * current Gate still validates that exact CandidateSet and remains the only
 * acceptance authority.
 */
export function rebindReplayAuthorityReferences(
  db: Database.Database,
  taskMetadata: Readonly<Record<string, unknown>>,
  value: unknown,
): unknown {
  if (taskMetadata.role !== 'reviewer') return value;
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

  let rebound = false;
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
        rebound = true;
      } else {
        result[key] = visit(child);
      }
    }
    return result;
  };

  const result = visit(value);
  // Reviewer products that do not carry a CandidateSet subject are left alone:
  // not every reviewer schema necessarily embeds the ref. Schemas that do
  // carry it are deterministically rebound to current authority above.
  void rebound;
  return result;
}
