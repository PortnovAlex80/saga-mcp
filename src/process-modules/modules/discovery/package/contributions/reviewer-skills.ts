/**
 * W9-A2 — Discovery package-local reviewer skills.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.4 (W9-A2), §11.3 (resource index), §8.2 (NodeProtocol review
 *       skill).
 *
 * This file declares the reviewer-skill and author-skill resource references
 * the Discovery package pins for its LM nodes. Under the Wave 9 exit gate
 * (§0.11.11: "no global skill/template lookup"), every skill a discovery node
 * invokes must be resolvable through a package-pinned resource — not through a
 * global skill-name lookup against the `skills/` directory.
 *
 * Each declaration below is a `ResourceIndexEntry` with `kind:
 * 'reviewer-skill'` or `kind: 'skill'`, carrying:
 *   - `logicalId` — the package-namespaced stable id the manifest indexes.
 *   - `path` — the package-relative POSIX path to the skill's SKILL.md.
 *   - `digest` — the documented `'pending@wave-2'` placeholder until the Wave
 *     2 content-addressed installer replaces it with the real content hash.
 *   - `executionProfileId` — which discovery execution profile pins this skill
 *     as its `reviewSkill` / `executionSkill` / `semanticSkill`.
 *
 * The skill names mirror the `executionProfiles` in
 * `discovery-process-module.ts` (saga-discovery-worker, saga-discovery-
 * normalizer, saga-discovery-readiness-advisor, saga-discovery-diagnosis-
 * advisor + the shared protocol). This file makes those references package-
 * local data instead of runtime-global lookups.
 *
 * Discovery is single-author advisory: it has no paired author/review-gate
 * cycle like Formalization. The readiness and diagnosis advisors ARE the
 * review surface (they assess the proposal / explain the certificate). The
 * legacy saga-kickstart and saga-readiness-checker skills are declared as
 * optional reviewer-skill resources for the future human-in-the-loop review
 * hook; they are pinned here so the runtime can surface them without a global
 * lookup if a review step is ever added.
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
export interface DiscoverySkillResource extends ResourceIndexEntry {
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
  slot: DiscoverySkillResource['slot'];
}): DiscoverySkillResource {
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
// Reviewer skills — the advisory review-gate skills pinned by profiles.
// ---------------------------------------------------------------------------

/**
 * Readiness advisor skill. Pinned as the `reviewSkill` on the readiness-advisor
 * profile (the advisory readiness classification IS the discovery review of
 * the proposal's grounding). Verifies problem clarity, scope boundedness,
 * stakeholder coverage, assumption/unknown/risk visibility, and evidence
 * grounding before the assessment is accepted.
 */
export const DISCOVERY_READINESS_ADVISOR_REVIEWER_SKILL: DiscoverySkillResource = skillResource({
  logicalId: 'discovery.skill.reviewer.readiness',
  path: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-readiness-advisor/SKILL.md',
  kind: 'reviewer-skill',
  pinnedByProfile: 'discovery-readiness-advisor',
  slot: 'review',
});

/**
 * Diagnosis advisor skill. Pinned as the `reviewSkill` on the diagnosis-advisor
 * profile (the diagnosis IS the advisory review/explanation of the issued
 * certificate). Verifies that every cited condition id and source ref belongs
 * to the immutable certificate's policy trace before the report is accepted.
 */
export const DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL: DiscoverySkillResource = skillResource({
  logicalId: 'discovery.skill.reviewer.diagnosis',
  path: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-diagnosis-advisor/SKILL.md',
  kind: 'reviewer-skill',
  pinnedByProfile: 'discovery-diagnosis-advisor',
  slot: 'review',
});

// ---------------------------------------------------------------------------
// Execution + semantic skills — the author-side skills pinned by each profile.
// ---------------------------------------------------------------------------

/**
 * Discovery proposal worker skill. Pinned as both `executionSkill` and
 * `semanticSkill` on the proposal-worker profile (investigation + proposal
 * authoring).
 */
export const DISCOVERY_WORKER_SKILL: DiscoverySkillResource = skillResource({
  logicalId: 'discovery.skill.worker',
  path: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-worker/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'discovery-proposal-worker',
  slot: 'execution',
});

/**
 * Discovery normalizer skill. Pinned as both `executionSkill` and
 * `semanticSkill` on the normalizer profile (semantic transformation of
 * ambiguous source fields without inventing evidence).
 */
export const DISCOVERY_NORMALIZER_SKILL: DiscoverySkillResource = skillResource({
  logicalId: 'discovery.skill.normalizer',
  path: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-normalizer/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'discovery-normalizer',
  slot: 'execution',
});

/**
 * Process-module worker protocol skill. Pinned as the `protocolSkill` on EVERY
 * discovery profile — it teaches the worker the managed-execution,
 * checkpoint, and materialized-call protocol every discovery LM node must
 * follow.
 */
export const DISCOVERY_PROTOCOL_SKILL: DiscoverySkillResource = skillResource({
  logicalId: 'discovery.skill.protocol',
  path: 'skills/saga-process-module-worker-protocol/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'package',
  slot: 'protocol',
});

// ---------------------------------------------------------------------------
// Optional legacy review skills — pinned for the future human-in-the-loop hook.
// ---------------------------------------------------------------------------

/**
 * Legacy saga-kickstart skill (the original discovery brief author). Pinned as
 * an optional reviewer-skill resource so a future human review / hand-off step
 * can surface it without a global lookup. Not bound to any execution profile;
 * its `pinnedByProfile` is 'package-optional'.
 */
export const DISCOVERY_KICKSTART_REVIEWER_SKILL: DiscoverySkillResource = skillResource({
  logicalId: 'discovery.skill.reviewer.kickstart',
  path: 'skills/saga-kickstart/SKILL.md',
  kind: 'reviewer-skill',
  pinnedByProfile: 'package-optional',
  slot: 'review',
});

// ---------------------------------------------------------------------------
// Aggregate — the complete pinned skill set.
// ---------------------------------------------------------------------------

/**
 * Every reviewer and author skill the Discovery package pins. The manifest
 * (W9-A1) merges these into its `resourceIndex` (stripping the
 * `pinnedByProfile`/`slot` extension fields, which are package-local metadata)
 * so the runtime resolves skills by package-pinned resource, never by global
 * skill-name lookup.
 */
export const DISCOVERY_SKILL_RESOURCES: readonly DiscoverySkillResource[] = Object.freeze([
  DISCOVERY_READINESS_ADVISOR_REVIEWER_SKILL,
  DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL,
  DISCOVERY_WORKER_SKILL,
  DISCOVERY_NORMALIZER_SKILL,
  DISCOVERY_PROTOCOL_SKILL,
  DISCOVERY_KICKSTART_REVIEWER_SKILL,
]);

/**
 * Strip the package-local extension fields to produce plain `ResourceIndexEntry`
 * values the manifest can carry. Each entry keeps the same `logicalId`, `path`,
 * `kind`, and `digest`; only `pinnedByProfile` and `slot` are dropped (they are
 * build-time metadata, not runtime contract data).
 */
export const DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES: readonly ResourceIndexEntry[] = Object.freeze(
  DISCOVERY_SKILL_RESOURCES.map(({ pinnedByProfile: _p, slot: _s, ...entry }) => entry),
);
