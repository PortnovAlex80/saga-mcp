# 067. Single ProductRef ingress before Workplace revision assembly

- **Status:** Accepted
- **Date:** 2026-08-14
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

ADR-053 requires every accepted material path to converge on a
`WorkplaceProductionRevision`, with WorkerExecution and physical production
mechanisms retained only as provenance. The B-7 audit found a false-green
cutover: `production-source-adapters.ts` defines adapters for managed artifacts,
traces, typed submissions, Git changes, and carry-forward, but production calls
only `producedProductsToContribution`. The executor still selects typed versus
managed production through `productSource`, and the live helper labels every
batch as typed submission by default.

The real production boundary already exposes content-addressed `ProductRef`
values. Git changes and verification evidence arrive as typed products; managed
artifacts and traces arrive as one exact Workplace snapshot product. Recreating
their physical source taxonomy inside revision assembly would make provenance
affect authority again.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Material correctness and fail-closed behavior | 30 | A missing or ambiguous source must create no revision, CandidateSet, GateRun, or obligation. |
| ADR-053 authority alignment | 25 | Adapter, execution, task, and presentation identity must disappear before material identity is computed. |
| Implementation cost | 15 | The Factory must reach real E2E quickly without another speculative subsystem. |
| Testability | 15 | The seam needs direct malformed-input, alias-invariance, and temporal tests. |
| Reversibility | 10 | The cutover must not require destructive migration of existing authority rows. |
| Extensibility | 5 | A future genuinely new ingress must remain possible, but is not the current priority. |

## Considered options

### Option A — One exact ProductRef ingress seam

Select exactly one physical reader from the frozen WorkIntent capability set:
an intent authorized for `product_submit` requires an exact typed submission;
otherwise it requires the exact managed Workplace snapshot. The ingress port
validates schema, ref, digest, and payload and returns canonical
`{ productRef, payload }[]`. It never probes one mode and falls back to another.
Revision assembly receives only canonical products. Carry-forward supplies the
already sealed exact ProductRefs and is not a physical source variant. Delete
the five unused adapters and the `productSource` projection/branches.

### Option B — Adapter-owned presentation batch

Retain the ProductReader but return a rich discriminated batch with a frozen
adapter coordinate, source receipt, products, evidence, origin, and optional
carry authorization. One dispatcher would normalize the batch and unify normal
and carry-forward sealing. This preserves a visible source taxonomy while
centralizing it.

### Option C — ProductionSourceAdapter registry and atomic ingress service

Introduce a versioned/digested adapter registry, five concrete adapters, source
receipts, a new ingress service, Workshop manifest bindings, and an atomic
normalize/persist/seal transaction. This is the most extensible option and the
largest coordinated cutover.

## MCDA matrix

Scores are 1–5. The total is the weighted average.

| Option | Correctness 30 | Authority 25 | Cost 15 | Testability 15 | Reversibility 10 | Extensibility 5 | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. One ProductRef ingress | 4.5 | 5.0 | 4.5 | 4.5 | 4.5 | 3.0 | 4.55 |
| B. Presentation batch | 3.5 | 2.5 | 2.0 | 3.0 | 3.0 | 5.0 | 2.98 |
| C. Adapter registry/service | 4.5 | 3.0 | 1.0 | 4.5 | 2.0 | 5.0 | 3.23 |

**Sanity check:** extensibility is intentionally low-weighted. No third live
physical ingress currently justifies putting adapter identity back into the
authority path.

## Pre-mortem

Assumption: Option A was implemented and failed six months later.

1. **Silent typed-to-managed fallback returned stale desk material** —
   likelihood medium; detectable by zero-row typed-ingress tests; mitigation:
   select one mode from the frozen WorkIntent and forbid fallback.
2. **Capability changes altered ingress selection on replay** — likelihood low;
   detectable by replay with mutated current installation; mitigation: use the
   immutable execution WorkIntent, while sealed replay reads ProductRefs only.
3. **A malformed payload reached CandidateSet sealing** — likelihood medium;
   detectable by row-count mutation tests; mitigation: recompute payload digest
   and validate pinned schema before entering the seal transaction.
4. **A third real ingress appeared and forced branching back into the executor**
   — likelihood low; detectable by a new executor conditional; mitigation: add
   a boundary-local reader only when that concrete ingress exists and keep its
   identity out of revision/Gate/replay digests.
5. **Carry-forward diverged from normal ProductRef conservation** — likelihood
   medium; detectable by produced-versus-carried alias tests; mitigation: feed
   exact sealed ProductRefs through the same canonical contribution function.

**Net effect:** the option survives with fail-closed mode selection and
cross-presentation convergence as release vetoes.

## Red Team

**Strongest argument against the initial leading option:** a frozen
`ingressAdapterRef` and discriminated presentation batch recreate physical
source/presenter identity as post-seal authority. They replace five dead
adapters with a framework for hypothetical adapters and allow registry changes
to affect acceptance or replay for identical ProductRefs.

**Source in repo:** only `producedProductsToContribution` has a production
caller; all five specialized adapters are test-only. ADR-053 states that
presenter and execution are provenance only.

**Response:** accepted. The Red Team changed the selection from the conservative
batch design to Option A. The chosen seam erases physical provenance before
revision assembly and introduces no adapter coordinate into material authority.

## Decision

Chose: **One exact ProductRef ingress seam**.

The executor will consume one fail-closed ingress result and pass canonical
ProductRefs to source-blind revision assembly. Ingress mode comes from the
frozen WorkIntent capability contract, not mutable task metadata or an LM field.
`productSource`, `product_source`, `requireTypedSubmission`, the unused physical
adapters, and their false-green architecture claims are removed. Git and
evidence remain product schemas, not revision source branches. Carry-forward
reuses exact sealed ProductRefs through the same canonical contribution path.

## Consequences

**Positive:**

- One real runtime seam replaces dead parallel architecture.
- Physical source, adapter, execution, and task identity cannot enter revision
  or CandidateSet material identity.
- Missing typed output and malformed payloads fail before a semantic Gate
  attempt.
- No database migration is required.

**Negative:**

- The design deliberately does not provide a plugin registry for hypothetical
  future ingress kinds.
- WorkIntent capability semantics become a load-bearing pre-seal contract and
  need direct tests.
- Existing module definitions and dispatcher metadata branches must be removed
  together rather than through a dual-read period.

**Neutral / follow-ups:**

- Keep physical provenance in audit receipts only.
- Add a third ingress reader only after a concrete irreducible source exists.
- Update the ADR-053 B-7 tracker and architecture ratchets to test the runtime
  call path, not exported function names.

## Decision Journal

**Date:** 2026-08-14  
**Decision (one line):** Normalize exactly one frozen WorkIntent ingress to
canonical ProductRefs before Workplace revision assembly.

**Ex-ante expectations — IF this decision was right, I expect:**

- In 30 days: `productSource`, `product_source`, and
  `requireTypedSubmission` remain absent from `src/`, and no new source branch
  appears in revision, CandidateSet, Gate, effect, or replay code.
- In 90 days: typed, managed, and carried presentations with equal ProductRefs
  converge to the same material digest/revision identity in regression tests.
- In 90 days: any new ingress implementation is confined to the pre-seal
  boundary and does not add adapter identity to accepted authority.

**Check trigger:** any new production mechanism or a replay mismatch involving
equal ProductRefs.  
**What would change my mind:** a third live ingress whose validation cannot be
expressed at the ProductRef boundary without source-specific material semantics.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-066](066-freeze-canaries-until-contract-state-and-cutover-conformance.md)
- [ADR-053 execution tracker](../ADR-053-CUTOVER-EXECUTION-TRACKER.md)
