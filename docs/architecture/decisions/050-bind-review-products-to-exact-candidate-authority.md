# ADR-050: Bind review products to exact CandidateSet authority

- **Status:** Accepted
- **Date:** 2026-08-11
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

Real GLM-4.7 run 005 paused after two reviewer attempts. Both typed verdicts
were structurally valid but copied the adjacent Workplace ref into
`subject_candidate_set_ref` instead of the exact author CandidateSet ref.
The payload decoder accepted any non-empty string; the final Gate correctly
failed closed with `unknown`. Scripted reviewers always copied the correct
field, so temporal tests never exercised this semantic identity mutation.

Cynefin classification: **complicated**. The authority boundary is knowable,
but it can be placed at prompt, WorkIntent, or WorkerExecution scope.

## Decision drivers

| Driver | Weight | Why it matters |
|---|---:|---|
| Authority correctness | 30 | A review must never float to a different candidate |
| Fail-fast recovery | 25 | Bad testimony must be repairable before a Gate retry is consumed |
| Universal conveyor fit | 20 | Core code must not branch on Development or schema IDs |
| Implementation risk | 15 | The real factory must be restarted quickly and safely |
| Reversibility | 10 | Historical runs and products remain readable |

## Considered options

### Option A — Prompt and static decoder hardening

Render stronger instructions and require a `candidate-set/` prefix. This is
cheap and catches the observed typo, but another valid yet wrong CandidateSet
still passes. Reversible, but not an authority boundary.

### Option B — Exact binding in subject-versioned WorkIntent

When reviewer work is projected, the kernel freezes a generic exact-field
binding to the accepted author CandidateSet. The author CandidateSet identity
participates in the reviewer generation key, so author repair creates new
immutable review authority. Submission validates the binding transactionally
before INSERT. Static decoder and Gate equality remain defense in depth.

### Option C — Claim-time binding in execution-context v3

Keep the WorkIntent as a reusable template, resolve the accepted author set
during claim, and freeze it into a new execution-context version. This has the
strongest race narrative but expands claim, replay, hashing, and compatibility
surfaces. It is appropriate if reviewer WorkIntents must remain reusable.

## MCDA matrix

Scores are 1–5; weighted total is out of 500.

| Option | Authority (30) | Recovery (25) | Universal fit (20) | Risk (15) | Reversible (10) | Σ |
|---|---:|---:|---:|---:|---:|---:|
| A | 2 | 3 | 4 | 5 | 5 | 350 |
| B | 5 | 5 | 5 | 4 | 5 | 485 |
| C | 5 | 5 | 5 | 2 | 3 | 435 |

The margin is meaningful: subject-versioned WorkIntents remove the premise
that reviewer authority is reusable while avoiding an execution-context
migration.

## Pre-mortem

Assume Option B failed after six months:

1. **Author repair reused an old reviewer intent** — likelihood M; detected by
   generation-key regression; mitigation: include exact subject hash in the key.
2. **Binding validator became a policy DSL** — likelihood M; detected in review;
   mitigation: support bounded top-level exact-string equality only.
3. **Prompt still encourages the adjacent field** — likelihood M; detected by
   real-model canary; mitigation: expose the exact binding in task metadata and
   retain explicit reviewer instructions.
4. **Legacy unbound rows were treated as current authority** — likelihood L;
   detected by Gate mismatch; mitigation: keep the final Gate fail-closed.

**Net effect:** the option survives with a deliberately small binding language
and subject-versioned generation.

## Red Team

**Strongest argument:** the exact subject belongs to each WorkerExecution,
because a long-lived reviewer WorkIntent can outlive author repair.

**Response:** incorporated the invariant by making the reviewer WorkIntent
itself subject-specific. A changed author CandidateSet creates a new immutable
generation; same-subject retries reuse it. This closes the lifecycle problem
without adding execution-context v3. If future scheduling requires reusable
review intents, supersede this ADR with claim-time binding.

## Decision

Choose **Option B**. Production Cell reviewer projection freezes a generic
`payload_bindings` exact-field rule in WorkIntent authority, includes the author
CandidateSet in generation identity, and exposes the exact ref in task metadata.
The managed-submission transaction rejects a mismatch before persistence. Both
review decoders also reject Workplace-shaped refs, while the final Gate remains
the last fail-closed relational check.

## Consequences

**Positive:**

- wrong semantic identity is rejected at `product_submit`;
- the same execution can correct its payload without consuming Gate retries;
- author repair cannot silently retarget historical review authority;
- the enforcement is module- and schema-neutral.

**Negative:**

- one logical Workplace can project multiple historical reviewer tasks after
  author repair;
- payload bindings currently support only exact top-level string fields.

**Follow-ups:** add an adversarial temporal worker that first submits the
adjacent Workplace ref, then corrects it; retain a real-model canary.

## Decision Journal

**Date:** 2026-08-11
**Decision:** Exact reviewer subject identity is immutable WorkIntent authority.

**Ex-ante expectations:**

- In 30 days, no reviewer Gate retry is consumed by a wrong subject ref.
- In 90 days, any additional cross-product identity field uses the same generic
  binding rather than a module-specific submission check.

**Check trigger:** any `factory.review-verdict.v1:unknown` or
`PRODUCT_PAYLOAD_BINDING_REJECTED` incident.

**What would change my mind:** evidence that WorkIntent generation cannot be
subject-versioned without breaking projection semantics; then move the exact
binding to execution-context authority.

## References

- ADR-049 production-wired temporal and dual-cycle model
- `src/process-modules/application/node-executors/production-cell-node-executor.ts`
- `src/process-modules/persistence/sqlite-managed-node-submission-repository.ts`
