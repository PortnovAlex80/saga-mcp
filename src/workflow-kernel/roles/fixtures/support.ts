/**
 * workflow-kernel/roles/fixtures/support.ts - shared deterministic builders
 * for the WP-17 synthetic role-contract fixtures.
 *
 * Every value is derived deterministically from literal seeds through the
 * kernel's ONE canonical digest rule - no clock, no randomness, so fixture
 * digests are stable across runs and machines.
 *
 * The fixtures are synthetic shape/digest-discipline proof (ROLE-CONTRACT-
 * SPEC.md section 12): provider/model/tool strings are placeholders; real
 * values are EK-8 authored content.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type {
  CompletionCommandSchemaArtifact,
  ExecutorRoutePolicyTable,
  SkillArtifact,
  TrackerProjectionProfile,
} from '../shapes.js';

/** Content address of a synthetic product-contract seed value. */
export function syntheticProductContractRef(seed: string): string {
  return `sha256:${sha256OfCanonical({ synthetic: seed })}`;
}

/** A cognition-only skill artifact. */
export function syntheticSkill(skillId: string, instructions: string): SkillArtifact {
  return { schemaVersion: 'ek.skill-artifact.ek1.v1', skillId, instructions };
}

/** A one-rule declarative eligibility table for one launch kind. */
export function syntheticRouteTable(tableId: string, launchKind: string, model: string): ExecutorRoutePolicyTable {
  return {
    schemaVersion: 'ek.executor-route-policy.ek1.v1',
    tableId,
    rules: [
      {
        when: { launchKind },
        route: { transportKind: 'opencode', provider: 'synthetic-provider', model, effort: null },
      },
    ],
  };
}

/** A presentation-only projection profile. */
export function syntheticTrackerProfile(
  profileId: string,
  label: string,
  boardColumn: TrackerProjectionProfile['display']['boardColumn'],
): TrackerProjectionProfile {
  return {
    schemaVersion: 'ek.tracker-projection-profile.ek1.v1',
    profileId,
    display: {
      label,
      boardColumn,
      detailSections: ['role-contract', 'prompt-receipt'],
    },
  };
}

/** A draft 2020-12 completion-command payload schema requiring one ref. */
export function syntheticCompletionCommandSchema(requiredRef: string): CompletionCommandSchemaArtifact {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      [requiredRef]: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    },
    required: [requiredRef],
    additionalProperties: false,
  };
}

/**
 * The synthetic PromptBudgetProfile stand-in (the artifact shape itself is
 * frozen by WP-16 part 3; here only its content address is pinned).
 */
export function syntheticPromptBudgetStandIn(profileKey: string): string {
  return `synthetic-prompt-budget-profile-stand-in:${profileKey} (shape frozen by WP-16 part 3)`;
}
