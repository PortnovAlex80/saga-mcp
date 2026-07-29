/**
 * Resolve an ExecutionProfileDefinition for a given task.
 *
 * Wave 13 removed the built-in module catalog (`modules/catalog.ts`) and the
 * prefix/first-match heuristics that lived here. The resolver now imports the
 * production module definitions DIRECTLY (no catalog, no module-name
 * switching in disguise) and matches a task's `task_kind` against a profile's
 * declared `taskKind` by EXACT equality only.
 *
 * A task's `task_kind` maps to exactly one executionProfile.id within exactly
 * one module (e.g. 'formalization.prd' → module 'solution-formalization' →
 * profile 'formalization-product'). The previous kind-prefix fallback (which
 * silently routed an unknown `discovery.<anything>` to the first discovery
 * profile, masking typos) is GONE: an unknown task_kind resolves to null and
 * the prompt builder falls back to the legacy single-skill path.
 *
 * This resolver is the bridge between the dispatcher (which knows task_kind)
 * and the worker prompt builder (which needs the profile's protocolSkill +
 * semanticSkill). It returns null when no profile matches.
 */

import type {
  ExecutionProfileDefinition,
  ProcessModuleDefinition,
} from '../domain/process-module.js';
import { discoveryProcessModule } from '../modules/discovery/discovery-process-module.js';
import { formalizationProcessModule } from '../modules/formalization/formalization-process-module.js';
import { developmentProcessModule } from '../modules/development/development-process-module.js';
import { deliveryProcessModule } from '../modules/delivery/delivery-process-module.js';

export interface ResolvedExecutionProfile {
  module: ProcessModuleDefinition;
  profile: ExecutionProfileDefinition;
}

/**
 * The production module definitions, imported directly. Wave 13 deleted the
 * built-in catalog (`modules/catalog.ts`); the resolver no longer reaches for
 * it. The order of this list is the iteration order for exact-match lookup.
 */
const MODULES: readonly ProcessModuleDefinition[] = [
  discoveryProcessModule,
  formalizationProcessModule,
  developmentProcessModule,
  deliveryProcessModule,
];

/**
 * Resolve the execution profile for one task_kind. Returns null if no module
 * declares a profile whose `taskKind` EXACTLY matches.
 *
 * Matching rule (post-Wave-13):
 *   1. exact task_kind match (profile.taskKind === taskKind) — the ONLY rule.
 *
 * The previous kind-prefix fallback (taskKind.startsWith(module.identity.kind))
 * is removed: it silently routed an unknown `discovery.<x>` to the first
 * discovery profile, which hid typos and task_kind drift. An unknown
 * task_kind now resolves to null so the caller can surface the mismatch.
 */
export function resolveExecutionProfile(
  taskKind: string | null | undefined,
): ResolvedExecutionProfile | null {
  if (!taskKind || typeof taskKind !== 'string') return null;

  for (const module of MODULES) {
    for (const profile of module.executionProfiles) {
      if (profile.taskKind === taskKind) {
        return { module, profile };
      }
    }
  }

  return null;
}

/**
 * Convenience: resolve just the protocol skill name for a task_kind. Returns
 * null if no profile matches. The prompt builder uses this to inline the
 * reusable protocol SKILL.md alongside the semantic role skill.
 */
export function resolveProtocolSkill(taskKind: string | null | undefined): string | null {
  const resolved = resolveExecutionProfile(taskKind);
  return resolved?.profile.protocolSkill ?? null;
}

/**
 * Convenience: resolve just the semantic skill name for a task_kind. Returns
 * null if no profile matches. When non-null, this OVERRIDES the legacy
 * assignment.skill (which is the same string today, but the override makes
 * the profile the single source of truth).
 */
export function resolveSemanticSkill(taskKind: string | null | undefined): string | null {
  const resolved = resolveExecutionProfile(taskKind);
  return resolved?.profile.semanticSkill ?? null;
}
