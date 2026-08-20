# ADR-084: Causal conformance proof kernel and Factory-owned derived evidence

- **Status:** Accepted
- **Date:** 2026-08-20
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

The Factory has finite, versioned production, acceptance, effect and routing
graphs around a non-deterministic actor: the LLM. `GRAPH-TEST-STRATEGY.md`
correctly observes that those graphs can be exercised with deterministic
scripted workers, but edge coverage alone does not prove the agentic control
loop. A useful proof must connect where a defect was introduced to the exact
detector, evidence, feedback, causal repair owner, append-only re-entry point
and bounded outcome.

The distinction became concrete in the artifact hash incident preserved by
commit `9906d227`. A worker supplied a shape-valid 64-hex `content_hash` without
binding it to source bytes. The Factory accepted the caller-authored derived
fact. Whether the model copied, guessed or transformed a familiar digest is
not observable from the local evidence and is not part of the diagnosis. The
architectural defect is that lexical validity was confused with provenance.

The immediate fix moved file hashing into the artifact handler. Audit of that
fix found two remaining concerns:

1. model-facing `artifact_create` still invited the caller to supply the hash;
2. an unavailable file observation returned `null`, and `artifact_update`
   could write that `null` over a previously verified digest.

There are also multiple test composition surfaces. A new proof layer must not
become another runtime, another recovery router, or a circular mirror generated
from the same declarations it claims to verify.

This ADR extends ADR-053's exact material authority, ADR-081's proof-backed
commit rule, and ADR-083's derivation-over-declaration rule.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Correctness and fail-closed authority | 30 | A false proof or caller-authored identity corrupts accepted material. |
| Alignment with ADR-053 exact authority | 20 | Evidence and repair must bind exact material, never chronology or prose. |
| Oracle independence | 15 | A test generated solely from production declarations can certify a missing gate. |
| Testability and diagnostics | 15 | Failures must identify detector, subject, feedback and repair frontier. |
| Reversibility | 10 | The proof vocabulary should land before a production recovery schema. |
| Implementation cost | 5 | The current incident needs a focused fix without another long refactor. |
| Extensibility | 5 | The same grammar must cover worker, provider, effect and temporal faults. |

## Considered options

### Option A — graph strategy plus hand-written incident tests

Keep levels A–D, add the hash regression and a small fault catalog. This is
cheap and reversible, but it leaves feedback causality, recovery ownership and
coverage drift implicit. A scripted “bad then good” sequence can still pass
without consuming feedback.

### Option B — universal production recovery registry now

Add persisted `RecoveryPlan`/invalidation-cone authority and make every local
and cross-stage failure route through it. This could eventually automate
arbitrary continuation from a causal producer, but current lineage and
diagnosability are not complete enough to make that choice safely. It requires
a schema/cutover and risks laundering an ambiguous diagnosis into authority.

### Option C — causal conformance proof kernel first

Extend the existing graph strategy with an independent normative obligation
registry, a test-side scenario/trace vocabulary, feedback-counterfactual
scripted actors, and explicit recovery-completeness criteria. Fix the active
derived-evidence boundary without adding a new persisted recovery authority.
Use proof results to decide later which recovery frontier/invalidation facts
must become production schema.

## MCDA matrix

Scores are 1–5; total is `score × weight`, maximum 500.

| Option | Correctness 30 | ADR-053 20 | Oracle independence 15 | Test/diagnostics 15 | Reversibility 10 | Cost 5 | Extensibility 5 | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Hand-written additions | 3 | 4 | 2 | 3 | 5 | 5 | 2 | 330 |
| B. Production registry now | 4 | 4 | 3 | 5 | 1 | 1 | 5 | 360 |
| C. Proof kernel first | 5 | 5 | 5 | 5 | 5 | 3 | 4 | **485** |

**Sanity check:** Option C wins because it strengthens the theorem and its
observability without yet turning an inferred root cause into production
authority. The margin is meaningful; cost is intentionally subordinate to
correctness for this subsystem.

## Pre-mortem

Assumption: Option C was implemented and failed six months later.

1. **Circular oracle** — likelihood: high; detectable by deleting an installed
   gate and observing that coverage stays green. Mitigation: normative
   obligations are maintained independently; require set equality and a
   mutation killed by each assigned gate.
2. **Omniscient scripted workers** — likelihood: high; detectable when the
   repair succeeds with feedback removed. Mitigation: actors see only real
   WorkIntent/desk/tool feedback; require exact-feedback vs stale/absent
   counterfactual pairs and input-digest→output-digest traces.
3. **A fourth test runtime emerges** — likelihood: medium; detectable by a new
   transition reducer or scenario-only authority writes. Mitigation: one
   production composition authority; DSL describes inputs/faults/assertions
   only; production reducers and SQLite remain the oracle.
4. **Server hashing observes the wrong checkout** — likelihood: medium;
   detectable when active checkout differs from `project_repositories.local_path`.
   Mitigation: resolve the current machine's active checkout before the
   canonical repository path and test that seam; later deduplicate this query
   behind the common workspace resolver before adding broader hard failures.
5. **Legacy poisoned material re-enters acceptance** — likelihood: medium;
   detectable through independent rehash/reconciliation. Mitigation: new
   material is fail-closed; add a later legacy reconciliation/quarantine proof
   before claiming historical closure.

**Net effect:** the option survives with a deliberately narrow initial claim.

## Red Team

**Strongest argument against the leading option:** a server-side hash is not
automatically authoritative if the server reads a different checkout from the
worker, and `verified | unavailable` can become another spelling of nullable
identity. Removing a field from an installed v1 contract without a version
change would also violate package immutability.

**Source in repo at the start of this decision:** `artifactDiskHash()` read
`project_repositories.local_path`, while other paths selected an active
`repository_checkouts.local_path`. The artifact MCP contracts remain versioned
package contributions.

**Response:** incorporated. This increment preserves legacy handler input,
changes the model-facing guidance to mark caller digests non-authoritative,
distinguishes no observation from a `NULL` write, and does not claim universal
missing-file rejection or cross-execution recovery. Artifact hashing now uses
the same active-machine-checkout precedence as worker workspace resolution;
a later contract version and removal of the duplicated root-resolution query
remain explicit follow-ups.

## Decision

Chose: **Option C — causal conformance proof kernel first.**

The Factory is treated as a closed-loop typed control system for a declared
finite fault model. Graph coverage remains necessary, but a conformance proof
must also show the complete causal path:

```text
fault origin → normative obligation → authorized detector → exact evidence
→ repair owner → feedback → minimal frontier → invalidation cone
→ append-only regenerated suffix → acceptance or bounded typed outcome
```

The proof kernel is test-side. It never decides production transitions or
repair routes. Production declarations are the installed surface, not the sole
source of expected truth.

### Independent oracle contract

Every proof reconciles three sources:

1. normative obligation registry (`REG`/`PROC`/ADR/failure-axis references);
2. installed nodes/contracts/checks/providers/effects/routes;
3. independently observed durable trace and external-world facts.

Coverage is set equality plus executed receipts, not a hand-written `TRACED`
label. Each deterministic obligation has at least one negative mutation that
its assigned protection must reject.

### Scripted actor contract

A scripted worker replaces model cognition only. It uses the production
assignment, desk, MCP, CandidateSet, Gate, feedback, effect, routing and SQLite
paths. It cannot read scenario identity, attempt number or hidden DB state. A
repair proof requires a nonce-bearing exact-feedback counterfactual: exact
feedback repairs; absent, stale or altered feedback does not.

### Derived evidence authority

```text
derivedEvidence = F(authoritativeSource)
owner(derivedEvidence) = component that authoritatively observes that source
```

The worker owns authored semantic content. The Factory owns digests and
canonical identities of material it observes. A worker may echo a previously
Factory-issued digest as a fenced assertion, but a naked caller-computed digest
is not evidence. For file-backed, DB-native and external-ref material, the
authoritative source adapter differs; “Factory-derived” does not mean
“filesystem-only”.

For Formalization documents the three hash roles remain distinct and
load-bearing: `content_hash` is the current observed container coordinate,
`accepted_hash` freezes the accepted container version, and `criterionHash`
identifies an atomic parsed AC member. The obsolete authority is the worker's
ability to author the first value, not the persisted server-derived hashes.
Repair therefore targets the container presentation/workspace/path boundary;
it never asks the worker to guess a better digest string.

### Honest proof boundary

This increment proves deterministic Factory physics for declared faults. It
does not prove that an LLM semantic verdict is true, that every semantic defect
is known, or that every cross-stage root cause is uniquely diagnosable. An
ambiguous signature routes to a deterministic probe or typed wait; it is never
silently guessed.

## Consequences

**Positive:**

- Graph tests gain detection, feedback, ownership and convergence semantics.
- Fabricated/stale derived values become a reusable fault category.
- A test cannot claim feedback delivery merely by returning a good second
  fixture.
- Cross-stage “step back” is defined as append-only recovery from provenance,
  not stage-number rollback.

**Negative:**

- The normative obligation registry is intentionally independent and must be
  maintained.
- Scenario authors must provide counterfactual and mutation cases, not only a
  happy repair.
- Universal automated cross-stage recovery remains open until lineage,
  diagnosability and invalidation proofs justify a production schema.

**Neutral / follow-ups:**

- Select one production composition authority and make its proofs blocking.
- Centralize the now-aligned effective repository-root query before
  hard-failing every missing file.
- Version model-visible artifact contracts before physically deleting legacy
  digest fields.
- Add legacy accepted-material reconciliation/quarantine.
- Add the first causal scenario for fabricated derived evidence, then expand
  the registry across gate, effect and temporal fault classes.

## Decision Journal

**Date:** 2026-08-20

**Decision:** establish a causal conformance proof kernel and Factory-owned
derived-evidence rule before adding a universal production recovery registry.

**Ex-ante expectations — IF this decision was right, I expect:**

- In 30 days: every new installed deterministic gate/check names at least one
  normative obligation and has positive, negative and repair coverage; removal
  of the gate turns the blocking matrix red.
- In 90 days: known repair regressions produce a minimized causal trace showing
  exact subject, detector, issue, owner and frontier; no test-only reducer has
  been introduced.
- In 90 days: no model-facing production contract asks a worker to author a
  digest for bytes the Factory can observe.

**Check trigger:** a new gate/provider/effect is installed, a repair reaches the
wrong owner, or a shape-valid caller-derived value reaches accepted authority.

**What would change my mind:** if independent obligations cannot be maintained
without duplicating the complete production domain, replace the registry with a
smaller externally curated contract corpus; if cross-stage faults cannot be
diagnosed from existing lineage, add explicit production provenance before
attempting automatic invalidation.

## References

- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
- `docs/architecture/decisions/081-authority-commit-proof-contract.md`
- `docs/architecture/decisions/083-readiness-toolchain-package-identity-contract.md`
- `docs/architecture/CONVEYOR-MENTAL-MODEL.md` §23
- `docs/testing/GRAPH-TEST-STRATEGY.md`
- `tests/architecture/artifact-hash-canonicalization.test.mjs`
