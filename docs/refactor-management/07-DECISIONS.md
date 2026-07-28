# 07 — Cross-cutting Decisions

Record of architecture decisions taken DURING execution that are not already
in the plan: resolutions of frozen-contract change requests, scope calls,
tooling choices, and any deviation from the plan with rationale.

A worker that needs a frozen-contract change STOPS its lane and files an entry
here (per plan §0.1.7). The integrator resolves centrally, publishes a new
checkpoint, and restarts dependent work.

Format:
```
## D-YYYYMMDD-NN — <title>
- Context: ...
- Decision: ...
- Rationale: ...
- Affects: waves/lanes/files
- Status: proposed | accepted | superseded
```

---

## D-20260728-01 — Refactor HQ location and operating model
- Context: Plan §0.1 mandates frozen input commits, disjoint path ownership, serial cherry-pick integration, and a single integrator. The integrator needs a durable place to keep the plan, checklist, wave files, and subagent tasks so context loss between sessions does not lose progress.
- Decision: All refactor governance lives under `docs/refactor-management/`. The integrator (this agent) is the sole writer of this folder. The verbatim plan is mirrored at `00-PLAN.md` (committed). Subagent task files under `05-subagent-tasks/` are the exact contracts workers execute; workers return one focused commit and never edit this folder.
- Rationale: Plan §0.1.3 (frozen input commit per wave), §0.1.6 (integrator cherry-picks serially), §0.1.20-equivalent (recoverable after context loss). Keeps the management surface separate from the production code surface so workers have unambiguous path ownership.
- Affects: all waves; folder `docs/refactor-management/`.
- Status: accepted
