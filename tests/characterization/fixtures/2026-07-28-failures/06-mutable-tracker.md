---
id: mutable-tracker
symptom: |
  Tracker Markdown that the model is expected to maintain as the authoritative
  view of execution progress. A weak model skips, duplicates, or hallucinates
  checklist state, and the only signal the runner has is a generic PostToolUse
  reminder that cannot block a wrong action.
root_cause_class: mutable-tracker
evidence: |
  - src/process-modules/application/process-execution-workspace.ts:380-408
    writes a per-task Markdown tracker (project-<epic>-<stage>-stage-<task>.md)
    on every workspace provisioning, and "refreshes machine-owned fields" by
    rewriting the file in place (the worker is expected to maintain the
    human-readable step/checklist content between refreshes).
  - tracker-reminder.mjs (root, 55 lines) is a PostToolUse hook that parses the
    exact SAGA_PROCESS_TRACKER_PATH Markdown, regex-extracts the current step
    and checkbox lines, and injects a generic reminder. It is deliberately NOT
    PreToolUse and NOT a context-blocker, so it cannot prevent a wrong action.
  - The tracker is created by refreshing a profile template
    (profile.trackerTemplate, process-execution-workspace.ts:380-389) — the
    template is the only structural guarantee; the live step/checklist content
    is worker-maintained Markdown.
reproduction: |
  Static:
    `grep -n "trackerTemplate\|project-.*-stage-.*\\.md\|refreshMarkdownMachineBindings" src/process-modules/application/process-execution-workspace.ts`
    `wc -l tracker-reminder.mjs && grep -n "PostToolUse\|additionalContext\|SAGA_PROCESS_TRACKER_PATH" tracker-reminder.mjs`
  Dynamic: provision a process workspace for any profile that has a
  trackerTemplate; the file project-<epic>-<stage>-stage-<task>.md appears on
  disk and is mutated on each retry (process-execution-workspace.ts:401-407).
expected_after_fix: |
  Protocol state (ProtocolRun / ProtocolStepRun) is the authoritative source of
  step progress (plan §0.7 / Wave 4, §14.5). The Markdown tracker becomes a
  pure projection regenerated from protocol state, never something the model
  maintains or the runner parses to decide what to do next.
fixing_waves:
  - "5"
  - "4"
---

# Fixture: mutable-tracker

Captured from the 2026-07-28 failure taxonomy (plan §2.2). Task file W00-A6
item 6 names process-execution-workspace.ts + tracker-reminder.mjs and Wave 5
as the fixing wave.

## Boundary that is unstable

Execution progress is communicated to a weak model through a Markdown file the
model itself edits. The runner's only feedback channel is a non-blocking
PostToolUse reminder. There is no authoritative machine-owned step state.

## Why this is a fixture, not a fix

Wave 4 (plan §0.7 / §14.5) introduces durable ProtocolRun/ProtocolStepRun as
the authoritative protocol state; Wave 5 converts tracker/template/hook
assistance into a projection over that state. This fixture pins the current
model-maintained-tracker boundary so Wave 5 can prove the tracker is no longer
load-bearing.
