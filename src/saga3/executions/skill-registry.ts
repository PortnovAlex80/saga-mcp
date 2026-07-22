/**
 * Saga 3 — Skill Capability Registry.
 *
 * Maps saga skill IDs to their capabilities: what action kinds they can
 * perform, what artifacts they produce, and their execution mode.
 *
 * The registry is populated at startup from the skills/ directory.
 * Workers are assigned through skills — there is no dispatch without a
 * matching skill.
 */

import type { SkillCapability } from '../domain/types.js';

/**
 * The built-in skill registry. Each entry maps a saga skill to its
 * capabilities. In production this is populated from skill frontmatter.
 * For now it is a static catalog.
 */
const REGISTRY: SkillCapability[] = [
  {
    skillId: 'saga-kickstart',
    role: 'discovery',
    actionKinds: ['discover', 'triage', 'brief'],
    producesArtifacts: ['brief', 'decision'],
    executionMode: 'tracker_only',
  },
  {
    skillId: 'saga-product',
    role: 'product',
    actionKinds: ['compile-prd', 'compile-fr', 'compile-nfr'],
    producesArtifacts: ['prd', 'fr', 'nfr'],
    executionMode: 'tracker_only',
  },
  {
    skillId: 'saga-analyst',
    role: 'analyst',
    actionKinds: ['compile-uc', 'compile-ac', 'compile-rule'],
    producesArtifacts: ['uc', 'ac', 'rule'],
    executionMode: 'tracker_only',
  },
  {
    skillId: 'saga-architect',
    role: 'architect',
    actionKinds: ['compile-srs'],
    producesArtifacts: ['srs'],
    executionMode: 'tracker_only',
  },
  {
    skillId: 'saga-reconciler',
    role: 'reconciler',
    actionKinds: ['reconcile', 'stamp-baseline'],
    producesArtifacts: ['baseline'],
    executionMode: 'tracker_only',
  },
  {
    skillId: 'saga-planner',
    role: 'planner',
    actionKinds: ['decompose', 'create-dev-tasks', 'create-verify-tasks'],
    producesArtifacts: ['plan'],
    executionMode: 'tracker_only',
  },
  {
    skillId: 'saga-worker',
    role: 'developer',
    actionKinds: ['implement', 'fix', 'develop'],
    producesArtifacts: ['code', 'test'],
    executionMode: 'git_change',
  },
  {
    skillId: 'saga-verifier',
    role: 'verifier',
    actionKinds: ['verify', 'benchmark', 'test'],
    producesArtifacts: ['evidence'],
    executionMode: 'read_only_evidence',
  },
  {
    skillId: 'saga-diagnostician',
    role: 'diagnostician',
    actionKinds: ['diagnose', 'probe'],
    producesArtifacts: ['diagnosis'],
    executionMode: 'read_only_evidence',
  },
];

/**
 * Look up a skill by skillId.
 */
export function getSkill(skillId: string): SkillCapability | null {
  return REGISTRY.find((s) => s.skillId === skillId) ?? null;
}

/**
 * Find skills capable of performing an action kind.
 */
export function findSkillsForAction(actionKind: string): readonly SkillCapability[] {
  return REGISTRY.filter((s) => s.actionKinds.includes(actionKind));
}

/**
 * Get all registered skills.
 */
export function allSkills(): readonly SkillCapability[] {
  return REGISTRY;
}
