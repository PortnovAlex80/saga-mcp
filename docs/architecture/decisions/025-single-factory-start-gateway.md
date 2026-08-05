# 025. Single factory start gateway

**Status:** Accepted

## Context

The factory had independent HTTP, UI and CLI ways to create or restart work.
Those paths accepted caller-owned epic ids, input files, idempotency keys and a
resume switch. That made it possible to create a second run instead of
continuing the durable order. The required public contract has only two
meanings: a project number resumes its existing order; an HTTPS product-idea
link creates a new order.

`GUARDRAILS.md` requires architectural decisions to be recorded and repeatedly
warns that silent fallbacks and split authorities invalidate lifecycle claims.

## Decision drivers

- Correctness and fail-closed identity resolution (weight 3).
- One start authority across HTTP, UI and the runtime-host boundary (weight 3).
- Crash/retry recovery and durable provenance (weight 2).
- Delivery risk and compatibility with the running lifecycle (weight 2).
- Reversibility (weight 2).

## Considered options

1. **Route-only facade.** Add `/api/factory/start`, but forward to all existing
   public engine/CLI inputs. Cheapest, but the invariant is cosmetic.
2. **Strict public cutover with launch capabilities.** Remove alternate public
   routes and raw CLI inputs now, freeze idea sources and use a durable,
   single-use `launch_ref`; retain the proven lifecycle loop as its internal
   implementation.
3. **Immediate supervisor rewrite.** Replace the process host, all application
   start methods and process supervision with a new FactoryOrder supervisor in
   one release.

## MCDA

Scores are 1 (poor) to 5 (excellent).

| Option | Correctness ×3 | One authority ×3 | Recovery ×2 | Delivery safety ×2 | Reversibility ×2 | Total |
|---|---:|---:|---:|---:|---:|---:|
| Route-only facade | 2 | 2 | 2 | 5 | 5 | 36 |
| Strict cutover + capability | 4 | 4 | 4 | 4 | 4 | 48 |
| Immediate supervisor rewrite | 5 | 5 | 5 | 1 | 2 | 46 |

## Pre-mortem

Assume the selected option failed after six months:

1. An old executable still accepted positional project/epic arguments. Mitigation:
   runtime argument parsing accepts only an unconsumed `launch_ref`, plus an
   architecture ratchet for retired HTTP routes and CLI flags.
2. Concurrent resume requests spawned duplicate hosts. Mitigation: one pending
   launch ticket per order, atomic ticket claim and return of an already-healthy
   host.
3. A project with several active runs resumed the wrong epic. Mitigation: exact
   one-run resolution; ambiguity is an error, never `ORDER BY ... LIMIT 1`.
4. A changed URL silently changed the product brief. Mitigation: capture exact
   bytes, final URL, media type and SHA-256 before provisioning and reuse the
   frozen source on retry.
5. Provisioning failure erased audit history. Mitigation: durable order state
   becomes `start_failed`; project/order/source rows are not rolled back.

## Red Team

The strongest objection was that a single HTTP button could conceal multiple
real authorities. In response, the executable boundary was changed in the same
cutover: positional coordinates, input paths, inline input and resume flags are
not parsed. The host must atomically claim a durable ticket. The old start and
restart HTTP routes were removed rather than forwarded. The review also found
URL SSRF, stale PID, authentication and full provisioning-reconciler risks.
This change blocks private/link-local URL targets, redirects and oversized or
unsupported content, avoids killing a healthy host, and retains failed orders.
A dedicated authenticated remote-ingress policy and a full failed-provisioning
reconciler remain follow-up hardening; the tracker remains local-control-plane
software and must not be exposed as an unauthenticated internet service.

## Decision

Adopt option 2. `POST /api/factory/start` is the sole public start gateway and
accepts exactly `{project_id}` or `{idea_url}`. A project selector is resume-only
and resolves one exact nonterminal LifecycleRun. An idea URL is create-only and
is frozen before aggregate creation. Every detached host requires a durable,
single-use launch capability. The lifecycle loop remains internal to reduce
cutover regression; its former caller-controlled launch contract does not.

## Consequences

- Operators no longer choose epic, input, idempotency or resume semantics.
- Existing unambiguous projects acquire an explicit FactoryOrder on first
  resume; ambiguous projects fail closed.
- New URL orders have immutable source provenance and stable retry identity.
- Direct old HTTP/CLI recipes break intentionally.
- URL ingestion is a security boundary with strict size/media/network policy.
- Stop/status/concurrency remain operational controls, not start authorities.

### Decision Journal

**Date:** 2026-08-06

**Decision (one line):** One XOR factory start gateway backed by single-use
durable launch capabilities.

**Ex-ante expectations — IF this decision was right, I expect:**

- In 30 days: no new public route or CLI flag can create/resume a Product
  Lifecycle outside `/api/factory/start`; duplicate resume tests still yield one
  claimable launch.
- In 90 days: restart incidents resume the same lifecycle/order without asking
  operators for epic, input path or idempotency key.

**Check trigger:** any addition of a factory launch route, runtime-host argument,
or report of duplicate LifecycleRuns for one project.

**What would change my mind:** operational evidence that launch tickets cannot
be reconciled safely after host crashes, requiring the full supervisor rewrite.

## References

- [ADR 024](024-factory-checkpoint-resume-and-adoption.md)
- `GUARDRAILS.md`
