---
id: skill-drift
symptom: |
  The semantic skill resolved for a worker can drift from what the assignment
  declares. A reviewer task whose assignment.skill is 'saga-reviewer' is
  inlined the AUTHOR semantic skill (e.g. 'saga-product') whenever a Process
  Module execution profile supplies a semanticSkill, because profile.semanticSkill
  overrides assignment.skill unconditionally and there is no separate
  author/reviewer skill mechanism.
root_cause_class: skill-drift
evidence: |
  - tracker-view/claude-runner.mjs:73 — verbatim:
      `const effectiveSemanticSkill = semanticSkillName ?? assignment.skill ?? \`saga-${role}\`;`
    profile.semanticSkill wins over assignment.skill; the reviewer's
    saga-reviewer assignment is silently replaced by the profile's author skill.
  - tracker-view/claude-runner.mjs:27-33 roleFromTask derives role from a
    role:<value> task tag, falling back to 'reviewer' only when
    assignment.skill==='saga-reviewer'. role only chooses a fallback skill
    name; it does NOT restore a reviewer skill when a profile semanticSkill is
    present.
  - tracker-view/claude-runner.mjs:91-104 inlines a SINGLE semantic skill
    (the drifted one) into the prompt for both author and reviewer runs.
  - Plan §13.18 (verbatim): "Reviewer skill declarations exist, but runner
    prompt assembly resolves the profile semantic skill before considering the
    review assignment."
  - Baseline §01 (claude-runner.mjs entry): "No separate author/reviewer skill
    mechanism beyond role tag + status + profile.semanticSkill — reviewer skill
    can be overwritten by author semantic skill (plan §13.18)."
reproduction: |
  Static: `grep -n "effectiveSemanticSkill\|semanticSkillName\|reviewer" tracker-view/claude-runner.mjs`
  Construct an assignment where task.status='review', assignment.skill=
  'saga-reviewer', and resolvedProfile.profile.semanticSkill='saga-product'.
  Read buildPrompt(...) (claude-runner.mjs:35-113): effectiveSemanticSkill
  resolves to 'saga-product', not 'saga-reviewer', and the reviewer run is
  inlined the author skill. The drift is unconditional whenever a profile is
  resolved.
expected_after_fix: |
  Author and reviewer skills are independent declared fields on the execution
  profile / AgentLaunchSpec (plan §13.18, §0.2.7 Wave 1 immutable
  AgentLaunchSpec, §0.4.2). The runner resolves the reviewer skill from the
  review assignment, not by overwriting the author semantic skill. A reviewer
  run never inlines the author skill.
fixing_waves:
  - "5"
  - "1"
---

# Fixture: skill-drift

Captured from the 2026-07-28 failure taxonomy (plan §2.2). Task file W00-A6
item 8 names claude-runner.mjs effectiveSemanticSkill and Wave 5 as the fixing
wave; plan §13.18 is the root-cause statement.

## Boundary that is unstable

Skill identity is not a declared, immutable per-role contract. It is computed
by a precedence chain in the runner prompt assembler that lets a profile's
author-side semanticSkill overwrite the reviewer assignment.

## Why this is a fixture, not a fix

Wave 1 (plan §0.2.7 / §0.4.2) freezes AgentLaunchSpec including the
author/reviewer skill split, and Wave 5 converts the runner to resolve skills
from that spec. This fixture pins the current precedence chain so Wave 5 can
prove a reviewer run is never inlined the author skill.
