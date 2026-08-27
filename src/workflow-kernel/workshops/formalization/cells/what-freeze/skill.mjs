/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/skill.mjs -
 * the installed SKILL artifacts of the WHAT-freeze cell (FRF-WP07;
 * manifest-data pattern: identity lives in installed declarations, never
 * in kernel conditionals).
 *
 * The two kernel desks are operator-staffed and DETERMINISTIC: the
 * baseline is BUILT from the exact accepted surfaces (no authoring), so
 * the semantic skill is an operator/reviewer runbook, not an authorship
 * brief. Skill ids follow the installed manifest's per-desk convention
 * (`formalization-desk-<desk>`), cross-checked against the installed
 * manifest by the blocking cell-contracts test.
 *
 * PURITY: pure data, content-addressed via the canonical digest rule.
 */

import { sha256OfCanonical } from './shared.mjs';
import { FREEZE_NODE_ID, SETTLE_NODE_ID } from './protocol.mjs';

/** One installed skill artifact (the manifest's InstalledSkillDeclaration shape). */
export function skillDeclarationOf(skillId, kind, servesDesks, content) {
  return {
    skillId,
    kind,
    servesDesks: [...servesDesks],
    digest: sha256OfCanonical(content),
    content,
  };
}

/** The freeze desk's semantic skill (the operator/reviewer runbook). */
export function freezeSkillDeclaration() {
  return skillDeclarationOf(`formalization-desk-${FREEZE_NODE_ID}`, 'semantic', [FREEZE_NODE_ID], {
    title: 'Freeze the whole-WHAT baseline (kernel desk, deterministic)',
    rules: [
      'Consume ONLY the exact accepted surfaces carried by the transition: case identity, source manifests, one acceptance record per accepted pre-freeze desk, the six containers (member and branch ids AND digests plus revision pins), the accepted trace set, the five disposition sections, the evidence-method bindings, the Development resolution surface.',
      'Never scan by epic, lifecycle, task, execution, status, type, chronology, maximum id or latest artifact; never reparse mutable documents after their atomic member manifest was accepted.',
      'Freeze the sections AS DECLARED - no folding: dispositions and evidence bindings are distinct named sections (F-8 / ledger D-10).',
      'Drift (substitution, duplicate digest, post-reconciliation mutation, digest mismatch) is NEVER patched through the baseline: open the freeze-drift human decision (TypedWait:effect-uncertainty, D12) and wait for the operator disposition receipt.',
      'A missing surface class makes the desk INDETERMINATE: open the D5 human-input wait; never guess the accepted universe.',
      'The lawful drift repair is a NEW immutable revision in the OWNING upstream desk; the freezer re-runs on the new exact surfaces only.',
    ],
  });
}

/** The settle desk's semantic skill. */
export function settleSkillDeclaration() {
  return skillDeclarationOf(`formalization-desk-${SETTLE_NODE_ID}`, 'semantic', [SETTLE_NODE_ID], {
    title: 'Settle the solution contract (kernel desk, deterministic)',
    rules: [
      'Consume ONLY the exact frozen whole-WHAT baseline artifact and the exact accepted SRS revision; never rediscover accepted artifacts.',
      'Every one of the twelve Development handoff kinds carries typed non-empty values resolving against the FROZEN baseline exact id sets per its own resolvesAgainst declaration (cr-02); a foreign binding is FOREIGN_LINEAGE - the UC-FOREIGN class dies here.',
      'Settlement never emits a contract it could not validate (the settler fence, A2).',
      'The ladder is deterministic: authority pins, then binding resolution, then the seal; the first failing rung decides the outcome (formalized / inconsistent / failed).',
    ],
  });
}

/** All installed skill artifacts of the cell. */
export function whatFreezeSkillDeclarations() {
  return [freezeSkillDeclaration(), settleSkillDeclaration()];
}
