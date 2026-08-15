# ADR-031: Target-only factory runtime

Status: accepted

## Decision

The repository exposes one factory runtime and one start gateway. A launch is
either a new idea URL or a project resume. Every ProcessRun pins its package,
input, authority, repository, model route and execution fence. Every workplace
uses the same Production Cell protocol: intent, reservation, author product,
review product, sealed CandidateSet, kernel GateDecision and atomic settlement.

Runtime code fails closed when any required binding is absent. Task rows are
projections and never substitute for workplace, candidate, gate or checkpoint
authority. Worker resources resolve only from the pinned package snapshot.

## Decision method

| Option | Safety | Clarity | Verification | Result |
|---|---:|---:|---:|---|
| Text-only cleanup | low | medium | low | rejected |
| Parallel runtime paths | low | low | low | rejected |
| Target-only production allowlist | high | high | high | selected |

Pre-mortem risks are a hidden start route, a nullable execution binding, a
projection read becoming authoritative, and a test that requires a bypass.
Architecture ratchets and full mock-factory runs cover these failure modes.

## Acceptance

- `/api/factory/start` is the only start route.
- worker launch requires a preassigned fenced card and pinned launch spec.
- checkpoint resume/adopt validates content and provenance before settlement.
- managed tool calls without frozen authority are denied.
- all built-in LM profiles use kernel-gate acceptance.
- build, full tests, process-module tests and two complete mock factories pass.
