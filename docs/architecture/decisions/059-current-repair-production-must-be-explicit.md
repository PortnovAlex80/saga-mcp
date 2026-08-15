# 059. Current repair production must be explicit

- **Status:** Accepted
- **Date:** 2026-08-11
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

Run019 exposed a split authority boundary in Formalization. A rejected author
repaired physical files, but three replacement executions published no
`artifact_update`/`artifact_create`/`trace_add` rows. `worker_done` validated
the accumulated ProcessRun graph and accepted each execution; the later author
Gate correctly required current-execution managed production, but returned only
`failed`. The Factory spent the remaining repair attempts without telling the
worker what authority was missing.

The disk hashes also differed from the registered artifact hashes. Reusing the
prior CandidateSet would therefore certify either stale database material or
unregistered bytes. ADR-053 requires Workplace-owned immutable production and
forbids treating WorkerExecution or a temporal `latest` lookup as material
authority. The current runtime already seals a content-addressed
`WorkplaceProductionSnapshot` before CandidateSet creation; this decision
closes the pre-seal repair boundary without introducing a second material
model.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Authority correctness | 30 | Rejected or stale material must never become current implicitly. |
| Actionable recovery | 25 | A live worker must be able to repair before consuming another Gate attempt. |
| ADR-053 alignment | 20 | Workplace material, not execution chronology, is the durable subject. |
| Regression testability | 15 | The exact live failure must be reproducible without an LLM. |
| Delivery cost/reversibility | 10 | The clean E2E must continue without a half-cut-over schema. |

## Considered options

### Option A — Carry forward the prior CandidateSet

Reuse the previous author product and rerun current gates. This is cheap and
valid only for unchanged, already-valid production after a downstream failure.
It is invalid here because the reviewer required material changes and the file
and artifact hashes diverged.

### Option B — Explicit current production plus actionable diagnostics

Keep current-execution production strict. Reject `worker_done` before it gives
up the fence when no current managed contribution exists. Preserve validator
codes/gaps as content-addressed Gate diagnostics. Clarify that Write/Edit
changes bytes while `artifact_update` publishes Factory production. Continue
to seal the existing immutable Workplace snapshot before CandidateSet review.

### Option C — Full delta/revision cutover now

Introduce `RepairAuthorization`, contribution records and immutable
WorkplaceProductionRevision assembly per ADR-053. This is the target model and
best long-term repair grammar, but a partial cutover during the live E2E would
touch CandidateSet identity, replay, persistence and all workshops at once.

## MCDA matrix

Scores are 1–5; totals apply the weights above.

| Option | Correctness (30) | Recovery (25) | ADR fit (20) | Testability (15) | Cost (10) | Σ/500 |
|---|---:|---:|---:|---:|---:|---:|
| A | 1 | 3 | 1 | 3 | 5 | 220 |
| B | 4 | 5 | 4 | 5 | 5 | 450 |
| C | 5 | 4 | 5 | 4 | 1 | 420 |

**Sanity check:** Option B wins only because the existing immutable Workplace
snapshot already supplies the post-publication QC identity. Without that seal,
Option C would be mandatory.

## Pre-mortem

Assumption: Option B was implemented and failed six months later.

1. **A fresh ledger row is mistaken for exact material** — likelihood M;
   detected by candidate snapshot/artifact-hash mismatch; mitigation: Gate and
   reviewer consume the sealed snapshot identity, never `latest` as authority.
2. **A workshop forgets to enable the policy** — likelihood M; detected by the
   policy matrix/architecture tests; mitigation: explicit
   `requireManagedProduction` on every managed Formalization author node.
3. **Gate feedback loses validator semantics again** — likelihood L; detected
   by diagnostic round-trip tests; mitigation: encode every gap as immutable
   `factory-check-diagnostic/v1` evidence.
4. **Repairs remain expensive whole-bundle rewrites** — likelihood H;
   mitigation: proceed with ADR-053 contribution/revision cutover after the
   clean E2E, rather than adding carry-forward shortcuts.

**Net effect:** the leading option survives with the immutable-snapshot and
policy-coverage mitigations made explicit.

## Red Team

**Strongest argument against the leading option:** a current ledger row proves
that an execution touched material, not that an immutable revision exists.
Run019 demonstrated file/row divergence, and mutable artifact reads could make
a reviewer observe different bytes from the CandidateSet subject.

**Source in repo:** ADR-053 and
`src/process-modules/shared/workplace-production-snapshot.ts`.

**Response:** incorporated. Option B is accepted only because CandidateSet
sealing already writes a content-addressed Workplace snapshot. Current
production and hash validation are prerequisites for that seal, not a new
authority. Any path that reviews mutable `latest` material without comparing
the sealed hashes remains a defect and is part of the ADR-053 cutover.

## Decision

Chose: **Option B — explicit current production plus actionable diagnostics.**

It preserves strict authority, fixes the liveness failure at the earliest
repairable boundary, and is a small reversible change over the existing sealed
snapshot. Whole-Candidate carry-forward is rejected. The full revision model
remains the architectural target, but will not be approximated by temporal
lookups or silently introduced under pinned package semantics.

## Consequences

**Positive:**
- File-only repair is rejected while the worker still owns the execution.
- Prior execution rows cannot impersonate current author production.
- Gate recovery contains exact codes, messages and artifact subjects.
- Scripted tests can reproduce the live failure deterministically.

**Negative:**
- A repair must explicitly call `artifact_update`, even for bytes it has just
  verified or copied.
- The contribution/revision cutover from ADR-053 remains unfinished.

**Neutral / follow-ups:**
- Complete ADR-053 after the clean Mars/Venus E2E.
- Add an invariant test that reviewer reads remain bound to sealed hashes.

## Decision Journal

**Date:** 2026-08-11
**Decision (one line):** Require exact repair executions to publish managed
production and preserve all rejection details before CandidateSet sealing.

**Ex-ante expectations:**
- In 30 days, no run consumes repeated author attempts for an unexplained
  `factory.submission-validator.*:failed` receipt.
- In 90 days, repair production is represented by ADR-053 revisions and no
  module uses latest-execution lookup as material authority.

**Check trigger:** the next Formalization repair or any mismatch between a
CandidateSet snapshot hash and reviewer-visible artifact content.

**What would change my mind:** evidence that the existing Workplace snapshot
cannot preserve the exact reviewer subject; then Option C becomes immediate.

## References

- `053-workplace-production-revision-as-accepted-material-authority.md`
- `058-local-runnability-before-human-acceptance.md`
- `../CONVEYOR-MENTAL-MODEL.md`
