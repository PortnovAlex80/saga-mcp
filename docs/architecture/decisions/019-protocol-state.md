# ADR-019: Protocol state lives in Runtime persistence; evidence is verified before step advance

**Status:** Accepted
**Date:** 2026-07-28
**Plan ref:** §3.9, §8 (8.3, 8.4, 8.7, 8.13), §9.7, §14.6 (Phase 5)

## Context

Today there is **no protocol state persistence**. The tracker Markdown — read by
the `tracker-reminder.mjs` PostToolUse hook — is the de-facto source of "which
protocol step is the worker on" (baseline §"tracker-reminder.mjs",
§"Missing aggregates"). The hook parses a single env-bound
`SAGA_PROCESS_TRACKER_PATH` Markdown file, regex-extracts the current step and
checkbox lines, and injects a reminder. It is **not PreToolUse, not a
context-blocker, not authoritative** (plan §13.5; baseline §"tracker-reminder.mjs").

Consequences:

1. **Module code reaches into protocol state directly.** There is no Runtime-owned
   `ProtocolRun`/`ProtocolStepRun` table (baseline §"Missing aggregates"); the
   worker's position in a multi-step node protocol survives only in workspace
   Markdown and in the worker's process memory.

2. **Protocol state does not survive worker death.** A crash, restart, review
   retry, or recovery loses the worker's step position, because it lived in
   process memory + Markdown, not in durable Runtime rows (plan §8.7).

3. **Step advance is not gated on evidence.** Nothing verifies that required
   durable evidence exists before a step advances (plan §8.4). The hook is
   advisory; the gateway has no protocol-step awareness.

4. **Recovery is module-private.** Each module's installation implements its own
   recovery shape; there is no generic Runtime protocol shared by every module
   and every node kind (plan §8.8).

Plan §8.3 makes Runtime own `ProtocolRun`/`ProtocolStepRun` state; §8.4 requires
step completion only after required durable evidence exists; §8.7 requires
protocol state to survive worker death, restart, retry, and recovery; §9.7 adds
`ProtocolRun`/`ProtocolStepRun` persistence with explicit state transitions.

## Decision

Protocol state is a **Runtime-owned** aggregate. Module code declares protocol
shape and policy; it never updates protocol persistence directly. Evidence is
verified before any step advances.

1. **Runtime owns `ProtocolRun` and `ProtocolStepRun` state** (plan §8.3). Module
   code NEVER updates protocol persistence directly. A module declares its
   `NodeProtocolDefinition` (plan §8.2: identifier+version; owning Flow node;
   entry step; stable step ids; deterministic step transitions; per-step
   instructions/resources/allowed tools/evidence requirements/assistance/guards;
   completion evidence; recovery entry steps; retry semantics). Runtime drives
   the state machine.

2. **Step completion occurs only after required durable evidence exists** (plan
   §8.4). Evidence categories: a successful tool receipt, a produced artifact
   reference, a trace reference, a human receipt, an external receipt, or a
   module verifier receipt. Runtime understands the standard evidence categories
   but never their domain meaning; module-specific evidence is checked by a
   versioned verifier registered by the package (plan §8.5).

3. **If semantic work cannot be inferred from a tool receipt, the worker issues a
   generic protocol step completion command** and Runtime verifies declared
   evidence before advancing (plan §8.6). The gateway guards are authoritative;
   the optional Claude Code PreToolUse guard is only an earlier rejection and
   cannot replace server enforcement (plan §11.7; ADR-020).

4. **Protocol state survives worker death, process restart, review retry, and
   recovery** (plan §8.7). A fresh worker reads its step position, prior step
   evidence, and remaining requirements from Runtime rows, not from logs or task
   status.

5. **Recovery is one generic Runtime protocol** used by every module and every
   node kind (plan §8.8, §8.10–8.12). A module declares recovery policy; it does
   not implement a private recovery engine. `RecoveryIssue` is a structured
   record (failed contract + product refs, producer node + attempt, verifier
   identity + digest, stable reason code, failed conditions, expected/actual
   evidence, repairable fields, human explanation). Module policy maps it to one
   standard `RecoveryAction` (retry / return-to producer / enter recovery node /
   request human / pause for external / escalate / terminate). Runtime validates
   the declared target, persists the issue and decision, opens a new attempt, and
   supplies `RecoveryFeedback` with the original immutable inputs, accepted
   predecessor products, and failed product. Prior attempts and products are
   never overwritten (plan §8.11).

6. **Positive acceptance is also generic** (plan §8.13). A package-declared
   verifier or acceptance capability emits a typed acceptance receipt; Runtime
   atomically records that receipt and advances the declared transition. Runtime
   does not know what SRS, proposal, SEO report, release candidate, or director
   approval means.

7. **Recovery stays inside a Process Module** until that module emits a public
   outcome or exhausts its declared policy (plan §8.14). A Lifecycle Scenario may
   then route that public outcome, but does not inspect or repair module-internal
   state.

8. **`ProtocolRun`/`ProtocolStepRun` persistence has explicit state transitions**
   (plan §9.7). Wave 5 adds the tables, the `ProtocolRuntime` service, and the
   start/evidence-verify/complete/retry/pause/resume/recovery transitions (plan
   §14.6.1–14.6.3).

## Consequences

**Positive:**

- A worker crash mid-protocol no longer loses step position; a fresh worker
  resumes from durable Runtime rows (plan §8.7).
- Step advance cannot happen without durable evidence — closing the "worker
  skipped verification" failure mode (plan §8.4).
- Recovery is uniform across modules; a new module declares policy, it does not
  build a private engine (plan §8.8).
- The Markdown tracker becomes a true projection — its drift can no longer
  corrupt protocol correctness (plan §3.9; ADR-018).

**Negative:**

- Wave 5 must add `ProtocolRun`, `ProtocolStepRun`, evidence, and transition
  persistence, plus the generic `ProtocolRuntime` service (plan §14.6). Until
  then the Markdown tracker remains the de-facto step source behind a
  compatibility seam (ADR-021; plan §16.5 — "do not make tracker read-only
  before ProtocolRun is authoritative").
- Per-step tool restrictions cannot be enabled until protocol step identity is
  live and tested (plan §16.6).
- Module-private recovery shapes must be rewritten as policy declarations — a
  real design cost for the four existing modules.

## Current state (frozen-commit `fd26fd1`)

- No `protocol_state`/`ProtocolRun`/`ProtocolStepRun` tables (baseline
  §"Missing aggregates").
- `tracker-reminder.mjs` (root, 56 lines) is the only hook; PostToolUse only,
  advisory, single env-bound path, parses Markdown (baseline §"tracker-reminder.mjs").
- `recovery.ts` (domain) defines module-agnostic `RecoveryIssue`/`RecoveryFeedback`
  + schema-id constants — the seed for the generic Runtime protocol.
- Listed as a Wave 7/13 removal surface in `COMPATIBILITY-INVENTORY.md` (Markdown
  tracker as protocol source).

## References

- Plan §3.9 (task metadata is a projection, not authoritative)
- Plan §8.3 (Runtime owns protocol state), §8.4 (evidence before advance), §8.7 (survives death)
- Plan §8.8–8.14 (generic recovery, RecoveryIssue, acceptance)
- Plan §9.7 (ProtocolRun/ProtocolStepRun persistence)
- Plan §11.7 (gateway guards authoritative; PreToolUse is optimization only)
- Plan §13.5 (Markdown tracker reminder is generic only)
- Plan §14.6 (Phase 5: protocol runtime), §16.5, §16.6 (cutover ordering)
- Baseline §"tracker-reminder.mjs", §"Missing aggregates", §"domain/recovery.ts"
- Related: ADR-018 (execution envelopes), ADR-020 (tool ownership), ADR-021 (compatibility)
