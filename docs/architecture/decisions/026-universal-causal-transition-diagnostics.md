# 026. Universal causal transition diagnostics

**Status:** Accepted

## Context

The factory has four current workshops but one intended execution protocol.
Operational evidence is fragmented across lifecycle, process, node, Workplace,
execution, product and gate stores. The legacy `activity_log` is readable but
cannot deterministically answer why a transition did not occur. A diagnostic
design must work unchanged for 4 or 1000 modules.

## Options and MCDA

Weights: correctness 3, universality 3, recovery usefulness 3, delivery risk 2,
operability 2. Scores are 1–5.

| Option | Correctness | Universal | Recovery | Delivery | Operability | Weighted total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Extend free-text `activity_log` | 2 | 3 | 2 | 5 | 3 | 37 |
| Query all domain tables on demand | 4 | 4 | 4 | 4 | 2 | 48 |
| Causal envelope + domain evidence + deterministic explainer | 5 | 5 | 5 | 3 | 5 | **61** |

## Pre-mortem and Red Team

- The event journal becomes a second source of truth. Mitigation: events always
  link authority rows; only domain evidence authorizes transitions.
- Failed transactions emit fictional facts. Mitigation: separate committed
  fact/outbox events from rejected-command diagnostics.
- Instrumentation misses a module-specific path. Mitigation: instrument
  universal use cases and add module conformance tests/architecture ratchets.
- Logs leak prompts or secrets. Mitigation: hashes/references and safe details;
  raw telemetry is redacted and separately retained.
- A quiet worker is declared dead. Mitigation: diagnosis requires leases,
  liveness and receipts, never log silence.
- Hash chaining increases write/cutover risk. Decision: content-address payloads
  and preserve causal links now; make cryptographic stream chaining optional
  hardening, not a prerequisite for useful diagnostics.

## Decision

Adopt the third option. Introduce one `CausalContext`, one normalized append-only
event contract and one consistent-snapshot invariant-DAG explainer across all
factory layers. It deterministically diagnoses current provable blockers and
indexes historical evidence; it does not replace domain receipts or claim a
historical cause under partial coverage. Every cut-over mutation atomically
commits a minimal outbox obligation. Domain evidence remains authority and
runtime telemetry remains non-authoritative support. Workshop checks may vary
declaratively; transition physics and diagnosis may not branch on workshop name.

Go/no-go rules: no UI says “root cause” for partial/ambiguous coverage; no
transition consumes this journal; no module-specific branch enters the core
explainer. Projector outage does not stop domain commits because the outbox is
durable, but failure to write the same-transaction outbox obligation rolls the
domain mutation back. Hash chains/signing, external anchoring and complete legacy
history are deferred hardening.

## Consequences

- Incident cards become reproducible and can name reusable products/resume
  actions instead of forcing repeated LM work.
- Existing repositories must propagate correlation/causation and expose
  evidence references.
- `activity_log` may remain as a compatibility projection but cannot satisfy the
  new audit contract alone.
- Current structural convergence is acknowledged; remaining bespoke module
  persistence is explicit migration debt rather than hidden as “already done”.

### Decision Journal

**Date:** 2026-08-06

**Decision:** diagnose every module through one causal envelope and one
first-unmet-invariant algorithm grounded in domain evidence.

**Expected in 30 days:** every new universal transition emits correlated
evidence and a stalled run produces a structured incident card.

**Expected in 90 days:** a fifth module passes the generic crash/review/resume
scenario without core switches or a bespoke diagnostic reader.

**Check trigger:** any new module, transition table, log format, or incident in
which accepted prior work is unnecessarily regenerated.

**What would change the decision:** evidence that atomic/outbox causal events
cannot be added without unacceptable write contention; the fallback would keep
the same envelope as a rebuildable projection over domain evidence.

## References

- [Conveyor mental model](../CONVEYOR-MENTAL-MODEL.md)
- [Transition diagnostics](../CONVEYOR-TRANSITION-DIAGNOSTICS.md)
- [Transition checklist](../CONVEYOR-TRANSITION-CHECKLIST.md)
- [ADR 024](024-factory-checkpoint-resume-and-adoption.md)
