/**
 * Resolve an ExecutionProfileDefinition for a given task.
 *
 * The catalog (ProcessModuleRegistry) holds the module Definitions; each
 * Definition carries executionProfiles. A task's `task_kind` maps to exactly
 * one executionProfile.id within exactly one module (e.g. 'formalization.prd'
 * → module 'solution-formalization' → profile 'formalization-product').
 *
 * This resolver is the bridge between the dispatcher (which knows task_kind)
 * and the worker prompt builder (which needs the profile's protocolSkill +
 * semanticSkill). It returns null when no profile matches — the prompt builder
 * then falls back to the legacy single-skill path.
 */

import { createBuiltInProcessModuleRegistry } from '../modules/catalog.js';
import type {
  ExecutionProfileDefinition,
  ProcessModuleDefinition,
} from '../domain/process-module.js';

const registry = createBuiltInProcessModuleRegistry();

export interface ResolvedExecutionProfile {
  module: ProcessModuleDefinition;
  profile: ExecutionProfileDefinition;
}

/**
 * Resolve the execution profile for one task_kind. Returns null if no module
 * declares a profile whose workIntentKind or taskKind matches.
 *
 * Matching rules (in order):
 *   1. exact task_kind match (profile.taskKind === taskKind) — preferred
 *   2. workIntentKind prefix match (taskKind startsWith profile.workIntentKind)
 *      — covers sub-kinds like 'formalization.prd' vs workIntentKind
 *      'formalization.product' (they don't match exactly, but the module
 *      identity is preserved by the task_kind namespace prefix).
 *
 * The resolver is module-agnostic: it iterates the catalog. A new module with
 * new profiles is picked up automatically — no registration needed here.
 */
export function resolveExecutionProfile(
  taskKind: string | null | undefined,
): ResolvedExecutionProfile | null {
  if (!taskKind || typeof taskKind !== 'string') return null;

  for (const module of registry.list()) {
    // 1. Exact task_kind match.
    for (const profile of module.executionProfiles) {
      if (profile.taskKind === taskKind) {
        return { module, profile };
      }
    }
  }

  // 2. Prefix match on the module kind (e.g. task_kind='discovery.work'
  //    matches module.identity.kind='discovery' → first profile of that
  //    module). This is the fallback when task_kind does not exactly equal
  //    any profile.taskKind (true for discovery.work, which uses
  //    workIntentKind='discovery' as the namespace).
  const kindPrefix = taskKind.split('.')[0];
  if (kindPrefix) {
    for (const module of registry.list()) {
      if (module.identity.kind === kindPrefix && module.executionProfiles.length > 0) {
        // Return the FIRST profile of the matching module — for discovery,
        // discovery-proposal-worker is first and is the entry-point profile.
        return { module, profile: module.executionProfiles[0] };
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
