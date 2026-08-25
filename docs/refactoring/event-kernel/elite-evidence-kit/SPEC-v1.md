# Elite Evidence Kit v1 — Specification

**Directive:** operator 2026-08-25. Convert Elite factory runs into
deterministic regression corpus for the event kernel. The oracle is SYSTEM
behavior under known actor responses — not product quality.

## Separation of concerns

| Layer | Variability | Test oracle |
|---|---|---|
| Factory stability | Deterministic | Normalized trace comparison (blocking) |
| LLM decision quality | Variable | Not a regression target |
| Product refinement | Future workshop | Not in scope |

## What to capture (per run)

```
elite-evidence-kit/
  source-manifest.json       # run ID, source SHA, build digest, schema version,
                             # package-store Merkle digest, repo commit digest,
                             # DB backup digest, journal digest
  input-capsule/             # Discovery output, Formalization output, SRS, AC,
                             # certificates, package/module installation identities
  actor-program/             # actual author/reviewer responses (accepted AND
                             # rejected), normalized tool calls
  expected-trace.json        # partial event order, mandatory transitions,
                             # permitted alternatives, final typed outcome
  expected-invariants.json   # no orphan task, no silent obligation loss,
                             # no review bypass, no duplicate settlement,
                             # exactly-once terminal, truthful outcomes
  failure-witnesses/         # minimal fragments reproducing any defects found
```

## Trace normalization

Exclude: timestamps, PIDs, row IDs, random UUIDs, ordering of independent
parallel tasks. Compare: command sequence, obligation lifecycle, gate
decisions, effect receipts, terminal proofs, invariant checks.

## Two corpus entries

### Elite-8 (negative scenario)
- Terminal: failed at `development-plan-task-graph`
- Expected: honest typed refusal, no chain damage, no orphan work
- Use: planner acceptance + graph validation regression

### Elite-fresh-20260825 (success/partial)
- 30/30 tasks done, 29/30 gates accepted, terminal development-blocked
  (readiness test-infrastructure failure, not a product defect)
- Expected: full pipeline discovery→formalization→development(30 items),
  honest readiness refusal, no phantom executions, REG-28 drain observed
- Use: full-conveyor regression + readiness boundary test

## Greenfield constraint

```
Elite DB/package-store/logs
          ↓ read-only extractor (this tool)
Elite Evidence Kit v1
          ↓ public capsule ingress (WP-08)
fresh event-kernel DB
          ↓ replay/scripted actors (WP-13A/B)
normalized trace comparison
```

The old SQLite DB is NEVER used directly by the new kernel. Old
`factory_replay_capsules` are NOT transferred (ADR-079 packageDigest in
replay key → legal miss after kernel replacement). LLM texts become actor
programs in the new cognition port.

## Implementation mapping

| Kit component | Owning WP | Phase |
|---|---|---|
| Read-only extractor | WP-13D | EK-9 |
| Capsule ingress | WP-08 | EK-5 |
| Actor programs | WP-13B | EK-9 |
| Scenario contract | WP-13A | EK-9 |
| Trace comparison | WP-13A | EK-9 |
| Corpus hosting | WP-13C | EK-9 |
