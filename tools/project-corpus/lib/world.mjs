/**
 * tools/project-corpus/lib/world.mjs - the observed-world view of the
 * project-corpus drivers (WP-13D): the durable hydrated world mapped onto
 * the WP-13A comparison surfaces.
 *
 * The observed view of one run is:
 *   - `world`     - the hydrated kernel world (evidence deduplicated by ref:
 *                   the kernel fact and its persisted receipt row share one
 *                   ref - one immutable fact, never two);
 *   - `summary`   - the WP-13A normalized final-evidence summary
 *                   (worldSummary of tests/workflow-kernel/engine/compare.mjs)
 *                   with instance ids renumbered over the driven input order;
 *   - `events`    - the committed WorkflowEvent kind sequence, in sequence
 *                   order (one event per committed command).
 *
 * Nothing but durable rows feed the view (the projection is never
 * authority; a fresh session rehydrates the same view).
 */

import { createHash } from 'node:crypto';
import { worldSummary, instanceRenumbering } from '../../../tests/workflow-kernel/engine/compare.mjs';

/**
 * Build the observed view of one durable session after a drive.
 * `inputs` is the driven command-input list (instance-renumbering order).
 */
export function observedWorldView(session, inputs, externalEvidence) {
  const hydrated = session.hydrateWorld(externalEvidence === undefined ? undefined : { externalEvidence }).world;
  const byRef = new Map(hydrated.evidence.map((fact) => [fact.ref, fact]));
  const world = { ...hydrated, evidence: [...byRef.values()] };
  const table = instanceRenumbering(inputs);
  return {
    world,
    table,
    summary: worldSummary(world, table),
    events: world.events.map((event) => event.kind),
  };
}

/**
 * The deterministic identity digests of one project descriptor (content
 * addressed over the project id; stable across machines).
 */
export function projectIdentityDigests(projectId) {
  const sha256 = (suffix) => createHash('sha256').update(`ek.project-corpus:${projectId}:${suffix}`, 'utf8').digest('hex');
  return { buildDigest: sha256('build'), packageDigest: sha256('package'), capsuleDigest: sha256('capsule') };
}
