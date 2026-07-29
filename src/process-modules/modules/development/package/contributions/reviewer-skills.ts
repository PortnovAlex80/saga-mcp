/**
 * W9-A4 — Development package-local reviewer skills.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.6 (W9-A4), §11.3 (resource index), §8.2 (NodeProtocol review
 *       skill).
 *
 * This file declares the reviewer-skill and author-skill resource references
 * the Development package pins for its LM nodes. Under the Wave 9 exit gate
 * (§0.11.11: "no global skill/template lookup"), every skill a development node
 * invokes must be resolvable through a package-pinned resource — not through a
 * global skill-name lookup against the `skills/` directory.
 *
 * Each declaration below is a `ResourceIndexEntry` with `kind:
 * 'reviewer-skill'` or `kind: 'skill'`, carrying:
 *   - `logicalId` — the package-namespaced stable id the manifest indexes.
 *   - `path` — the package-relative POSIX path to the skill's SKILL.md.
 *   - `digest` — the documented `'pending@wave-2'` placeholder until the Wave
 *     2 content-addressed installer replaces it with the real content hash.
 *   - `executionProfileId` — which development execution profile pins this skill
 *     as its `reviewSkill` / `executionSkill` / `semanticSkill`.
 *
 * The skill names mirror the `executionProfiles` in
 * `development-process-module.ts` (saga-planner + saga-planning-reviewer on the
 * planning profile) and the verification profile (saga-verifier). This file
 * makes those references package-local data instead of runtime-global lookups.
 *
 * Development has exactly one declared execution profile today
 * (`development-task-graph-planner`); the verifier is an external-adapter-driven
 * workset whose independent-verifier skill is pinned here for the verification
 * node protocol (W9-A3) so the runtime can resolve it without a global lookup.
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type {
  ResourceIndexEntry,
  ResourceKind,
} from '../../../../domain/spi/resource-index.js';

// ---------------------------------------------------------------------------
// Reviewer-skill declarations.
// ---------------------------------------------------------------------------

/**
 * One pinned skill resource with the execution profile that consumes it.
 * Carries the same fields as `ResourceIndexEntry` plus the profile binding so
 * the manifest builder can cross-check that every profile's declared skill has
 * a pinned resource entry.
 */
export interface DevelopmentSkillResource extends ResourceIndexEntry {
  /** The execution-profile id that pins this skill, or 'package' if shared. */
  readonly pinnedByProfile: string;
  /**
   * Which skill slot this resource fills on the profile:
   * 'execution' | 'review' | 'semantic' | 'protocol'.
   */
  readonly slot: 'execution' | 'review' | 'semantic' | 'protocol';
}

function skillResource(args: {
  logicalId: string;
  path: string;
  kind: ResourceKind;
  pinnedByProfile: string;
  slot: DevelopmentSkillResource['slot'];
}): DevelopmentSkillResource {
  return {
    logicalId: args.logicalId,
    path: args.path,
    kind: args.kind,
    digest: 'pending@wave-2',
    pinnedByProfile: args.pinnedByProfile,
    slot: args.slot,
  };
}

// ---------------------------------------------------------------------------
// Reviewer skills — the review-gate skills pinned by profiles.
// ---------------------------------------------------------------------------

/**
 * Planning reviewer skill. Pinned as the `reviewSkill` on the
 * `development-task-graph-planner` profile. Verifies that the proposed task
 * graph covers every implementationRequired AC, that every dependency is
 * acyclic, and that repository bindings match the development case before the
 * planner submits.
 */
export const DEVELOPMENT_PLANNING_REVIEWER_SKILL: DevelopmentSkillResource = skillResource({
  logicalId: 'development.skill.reviewer.planning',
  path: 'skills/saga-planning-reviewer/SKILL.md',
  kind: 'reviewer-skill',
  pinnedByProfile: 'development-task-graph-planner',
  slot: 'review',
});

// ---------------------------------------------------------------------------
// Execution + semantic skills — the author-side skills pinned by each profile.
// ---------------------------------------------------------------------------

/**
 * Planner skill. Pinned as both `executionSkill` and `semanticSkill` on the
 * `development-task-graph-planner` profile (reads the accepted SRS decomposition
 * and proposes typed implementation/integration/verification work).
 */
export const DEVELOPMENT_PLANNER_SKILL: DevelopmentSkillResource = skillResource({
  logicalId: 'development.skill.planner',
  path: 'src/process-modules/modules/development/package/resources/skills/saga-planner/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'development-task-graph-planner',
  slot: 'execution',
});

/**
 * Independent verifier skill. Pinned as the execution/semantic skill for the
 * verification external workset (the `verify-acceptance-workset` node). The
 * verifier generates L3 property tests from the frozen AC contract — NOT from
 * the Builder's tests — and records 4-valued evidence bound to the exact frozen
 * candidate hash.
 */
export const DEVELOPMENT_VERIFIER_SKILL: DevelopmentSkillResource = skillResource({
  logicalId: 'development.skill.verifier',
  path: 'skills/saga-verifier/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'development-verification',
  slot: 'execution',
});

/**
 * Process-module worker protocol skill. Pinned as the `protocolSkill` on EVERY
 * development profile — it teaches the worker the managed-execution,
 * checkpoint, and materialized-call protocol every development LM node must
 * follow.
 */
export const DEVELOPMENT_PROTOCOL_SKILL: DevelopmentSkillResource = skillResource({
  logicalId: 'development.skill.protocol',
  path: 'skills/saga-process-module-worker-protocol/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'package',
  slot: 'protocol',
});

// ---------------------------------------------------------------------------
// Aggregate — the complete pinned skill set.
// ---------------------------------------------------------------------------

/**
 * Every reviewer and author skill the Development package pins. The manifest
 * merges these into its `resourceIndex` (stripping the `pinnedByProfile`/`slot`
 * extension fields, which are package-local metadata) so the runtime resolves
 * skills by package-pinned resource, never by global skill-name lookup.
 */
export const DEVELOPMENT_SKILL_RESOURCES: readonly DevelopmentSkillResource[] = Object.freeze([
  DEVELOPMENT_PLANNING_REVIEWER_SKILL,
  DEVELOPMENT_PLANNER_SKILL,
  DEVELOPMENT_VERIFIER_SKILL,
  DEVELOPMENT_PROTOCOL_SKILL,
]);

/**
 * Strip the package-local extension fields to produce plain `ResourceIndexEntry`
 * values the manifest can carry. Each entry keeps the same `logicalId`, `path`,
 * `kind`, and `digest`; only `pinnedByProfile` and `slot` are dropped (they are
 * build-time metadata, not runtime contract data).
 */
export const DEVELOPMENT_SKILL_RESOURCE_INDEX_ENTRIES: readonly ResourceIndexEntry[] = Object.freeze(
  DEVELOPMENT_SKILL_RESOURCES.map(({ pinnedByProfile: _p, slot: _s, ...entry }) => entry),
);
