/**
 * W8-A7 — Formalization package-local reviewer skills.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
 * Plan: §11.3 (resource index), §8.2 (NodeProtocol review skill).
 *
 * This file declares the reviewer-skill and author-skill resource references
 * the Formalization package pins for its LM nodes. Under the Wave 8 exit gate
 * (§0.11.11: "no global skill/template lookup"), every skill a formalization
 * node invokes must be resolvable through a package-pinned resource — not
 * through a global skill-name lookup against the `skills/` directory.
 *
 * Each declaration below is a `ResourceIndexEntry` with `kind:
 * 'reviewer-skill'` or `kind: 'skill'`, carrying:
 *   - `logicalId` — the package-namespaced stable id the manifest indexes.
 *   - `path` — the package-relative POSIX path to the skill's SKILL.md.
 *   - `digest` — the documented `'pending@wave-2'` placeholder until the Wave
 *     2 content-addressed installer replaces it with the real content hash.
 *   - `executionProfileId` — which formalization execution profile pins this
 *     skill as its `reviewSkill` / `executionSkill` / `semanticSkill`.
 *
 * The skill names mirror the `executionProfiles` in
 * `formalization-process-module.ts` (saga-product, saga-analyst, saga-architect,
 * saga-reconciler + their reviewers). This file makes those references
 * package-local data instead of runtime-global lookups.
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
export interface FormalizationSkillResource extends ResourceIndexEntry {
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
  slot: FormalizationSkillResource['slot'];
}): FormalizationSkillResource {
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
// Reviewer skills — the review-gate skills pinned by each profile.
// ---------------------------------------------------------------------------

/**
 * Requirements reviewer for PRD, UC, AC, and reconciliation artifacts. Pinned
 * as the `reviewSkill` on the product, use-case, acceptance, and reconciler
 * profiles. Verifies structural completeness, traceability edges, and parent
 * lineage before approving.
 */
export const FORMALIZATION_REQUIREMENTS_REVIEWER_SKILL: FormalizationSkillResource = skillResource({
  logicalId: 'formalization.skill.reviewer.requirements',
  path: 'src/process-modules/modules/formalization/package/resources/skills/saga-requirements-reviewer/SKILL.md',
  kind: 'reviewer-skill',
  pinnedByProfile: 'formalization-product|formalization-use-cases|formalization-acceptance|formalization-reconciler',
  slot: 'review',
});

/**
 * Architecture reviewer for SRS artifacts. Pinned as the `reviewSkill` on the
 * architect profile. Verifies the Invariant Registry, FR/NFR completeness, and
 * the derived_from → PRD edge before approving.
 */
export const FORMALIZATION_ARCHITECTURE_REVIEWER_SKILL: FormalizationSkillResource = skillResource({
  logicalId: 'formalization.skill.reviewer.architecture',
  path: 'src/process-modules/modules/formalization/package/resources/skills/saga-architecture-reviewer/SKILL.md',
  kind: 'reviewer-skill',
  pinnedByProfile: 'formalization-architect',
  slot: 'review',
});

// ---------------------------------------------------------------------------
// Execution + semantic skills — the author-side skills pinned by each profile.
// ---------------------------------------------------------------------------

/**
 * Product Owner skill. Pinned as both `executionSkill` and `semanticSkill` on
 * the product profile (PRD authoring).
 */
export const FORMALIZATION_PRODUCT_SKILL: FormalizationSkillResource = skillResource({
  logicalId: 'formalization.skill.product',
  path: 'src/process-modules/modules/formalization/package/resources/skills/saga-product/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'formalization-product',
  slot: 'execution',
});

/**
 * Business Analyst skill. Pinned as both `executionSkill` and `semanticSkill`
 * on the use-case and acceptance profiles (UC + AC authoring).
 */
export const FORMALIZATION_ANALYST_SKILL: FormalizationSkillResource = skillResource({
  logicalId: 'formalization.skill.analyst',
  path: 'src/process-modules/modules/formalization/package/resources/skills/saga-analyst/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'formalization-use-cases|formalization-acceptance',
  slot: 'execution',
});

/**
 * System Architect skill. Pinned as both `executionSkill` and `semanticSkill`
 * on the architect profile (SRS authoring).
 */
export const FORMALIZATION_ARCHITECT_SKILL: FormalizationSkillResource = skillResource({
  logicalId: 'formalization.skill.architect',
  path: 'src/process-modules/modules/formalization/package/resources/skills/saga-architect/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'formalization-architect',
  slot: 'execution',
});

/**
 * Reconciler skill. Pinned as both `executionSkill` and `semanticSkill` on the
 * reconciler profile (WHAT-side traceability repair).
 */
export const FORMALIZATION_RECONCILER_SKILL: FormalizationSkillResource = skillResource({
  logicalId: 'formalization.skill.reconciler',
  path: 'src/process-modules/modules/formalization/package/resources/skills/saga-reconciler/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'formalization-reconciler',
  slot: 'execution',
});

/**
 * Process-module worker protocol skill. Pinned as the `protocolSkill` on EVERY
 * formalization profile — it teaches the worker the managed-execution,
 * checkpoint, and materialized-call protocol every formalization LM node must
 * follow.
 */
export const FORMALIZATION_PROTOCOL_SKILL: FormalizationSkillResource = skillResource({
  logicalId: 'formalization.skill.protocol',
  path: 'skills/saga-process-module-worker-protocol/SKILL.md',
  kind: 'skill',
  pinnedByProfile: 'package',
  slot: 'protocol',
});

// ---------------------------------------------------------------------------
// Aggregate — the complete pinned skill set.
// ---------------------------------------------------------------------------

/**
 * Every reviewer and author skill the Formalization package pins. The manifest
 * (W8-A1) merges these into its `resourceIndex` (stripping the
 * `pinnedByProfile`/`slot` extension fields, which are package-local metadata)
 * so the runtime resolves skills by package-pinned resource, never by global
 * skill-name lookup.
 */
export const FORMALIZATION_SKILL_RESOURCES: readonly FormalizationSkillResource[] = Object.freeze([
  FORMALIZATION_REQUIREMENTS_REVIEWER_SKILL,
  FORMALIZATION_ARCHITECTURE_REVIEWER_SKILL,
  FORMALIZATION_PRODUCT_SKILL,
  FORMALIZATION_ANALYST_SKILL,
  FORMALIZATION_ARCHITECT_SKILL,
  FORMALIZATION_RECONCILER_SKILL,
  FORMALIZATION_PROTOCOL_SKILL,
]);

/**
 * Strip the package-local extension fields to produce plain `ResourceIndexEntry`
 * values the manifest can carry. Each entry keeps the same `logicalId`, `path`,
 * `kind`, and `digest`; only `pinnedByProfile` and `slot` are dropped (they are
 * build-time metadata, not runtime contract data).
 */
export const FORMALIZATION_SKILL_RESOURCE_INDEX_ENTRIES: readonly ResourceIndexEntry[] = Object.freeze(
  FORMALIZATION_SKILL_RESOURCES.map(({ pinnedByProfile: _p, slot: _s, ...entry }) => entry),
);
