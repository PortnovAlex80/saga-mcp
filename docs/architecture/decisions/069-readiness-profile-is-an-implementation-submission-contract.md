# ADR-069: Readiness profile is an implementation submission contract

- **Status:** Accepted
- **Date:** 2026-08-14
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

Python-002 completed Discovery, Formalization, Planning and integration, then
created fourteen verification Workplaces. Every local-runnability provider
failed because the frozen `IntegratedReleaseCandidate` had no explicit
`readiness` profile. One accepted implementation result omitted build data and
the other reported only a test command. The implementation payload contract
allowed both, and candidate freeze selected the first profile it happened to
find (or none). This spent verifier work on a candidate already known to be
structurally unverifiable.

ADR-053 requires exact, immutable material authority. ADR-058 requires the
accepted candidate—not incidental repository files—to state how local
runnability is proved. Therefore neither command inference nor a late repeated
failure is lawful.

This was triaged as **Complicated**: the failure and authority boundaries were
knowable, but there were several reasonable placements for the contract.
Parallel subagents were not used because the active developer instruction
forbids spawning them; option generation and Red Team analysis were performed
locally.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Authority correctness | 30 | Commands must be explicit accepted material. |
| Early/actionable failure | 25 | Bad payloads must be repairable in the same execution. |
| Partition/order invariance | 20 | Task completion order cannot select the run contract. |
| Testability | 10 | Missing and conflicting profiles need deterministic tests. |
| Reversibility | 10 | The cutover must leave older installed module versions readable. |
| Implementation cost | 5 | Real canaries should resume without a graph-schema redesign. |

## Considered options

### Option A — retain late provider failure

Keep `readiness` optional and let each verification Gate fail closed. This is
small and preserves old payloads, but repeats a candidate-wide structural
failure for every acceptance criterion and cannot repair the producer.

### Option B — submission firewall plus freeze consensus

Version the implementation payload contract, require a complete static/served
profile on every standard implementation result, pin that contract in the
Production Cell, and reject non-identical accepted profiles during candidate
freeze. Managed continuations inherit the exact baseline profile.

### Option C — planner-owned readiness authority

Add a readiness owner and profile to the task-graph schema. The planner would
choose one implementation item whose result supplies it. This centralizes the
declaration but makes an LM planning proposal the command authority and requires
a larger graph/package migration before it closes the immediate boundary.

## MCDA matrix

Scores are 1 (poor) to 5 (strong).

| Option | correctness (30) | early failure (25) | invariance (20) | testability (10) | reversibility (10) | cost (5) | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 2 | 1 | 2 | 3 | 5 | 5 | 230 |
| B | 5 | 5 | 5 | 5 | 4 | 4 | 485 |
| C | 4 | 4 | 4 | 4 | 3 | 2 | 380 |

**Sanity check:** B wins on the three load-bearing properties. Its main cost is
duplicate declarations, bounded by canonical consensus at freeze.

## Pre-mortem

Assumption: Option B was implemented and failed six months later.

1. **Different implementation tasks invent different commands** — likelihood:
   M; detectable: yes, freeze returns a typed mismatch; mitigation: canonical
   equality and one documented final-product profile.
2. **A worker omits the profile despite the skill text** — likelihood: M;
   detectable: yes, pre-INSERT payload error; mitigation: pinned contract v1.1.
3. **A repair continuation loses the run contract** — likelihood: M;
   detectable: continuation regression; mitigation: inherit the exact baseline
   candidate profile when no standard implementation presentation exists.
4. **Legacy installed runs are reinterpreted** — likelihood: L; detectable by
   package replay; mitigation: module version 1.3.0 and immutable old packages.

**Net effect:** the option survives with consensus and versioning as mandatory
guards.

## Red Team

**Strongest argument against Option B:** a scoped implementation item may not
own product-wide build files, so requiring it to repeat the profile can cause
guessing and disagreement; Option C names one owner.

**Source in repo:** the Development worker skill explicitly says scoped items
must not widen their change scopes merely to make an intermediate candidate
runnable.

**Response:** incorporated as a boundary distinction. Declaring the immutable
final run contract grants no file-write authority and does not require the
intermediate branch to be runnable. Consensus prevents one scoped worker from
silently overriding another. If repeated real canaries show profile disagreement
despite explicit submission feedback, a typed non-LM product-contract owner may
supersede this ADR; file inference remains forbidden.

## Decision

Choose **Option B: submission firewall plus freeze consensus**.

`solution-development@1.3.0` pins implementation payload-contract v1.1. A
missing or malformed profile creates no submission/CandidateSet/Gate rows and
can be corrected in the same execution. Candidate freeze requires every
standard implementation result to carry a canonically identical profile and
fails before verification fan-out otherwise. Continuations retain their exact
baseline profile.

## Consequences

**Positive:**

- unverifiable candidates do not create an acceptance-criterion failure storm;
- command authority is explicit, immutable and order-independent;
- no language/file-name inference is introduced.

**Negative:**

- each implementation presentation repeats the final run contract;
- disagreement is a candidate-freeze failure after implementation, although
  individual omissions and malformed profiles fail at submission.

**Neutral / follow-ups:**

- scripted workers and package/resource version references move to 1.3.0;
- Python, TypeScript and Kotlin canaries must exercise different command shapes.

## Decision Journal

**Date:** 2026-08-14  
**Decision:** require readiness at implementation submission and conserve it by
canonical consensus at candidate freeze.

**Ex-ante expectations:**

- In 30 days: no fresh Development run reaches verification with a candidate
  lacking readiness; malformed declarations are repaired within the author
  execution.
- In 90 days: no provider or settlement path infers commands from incidental
  filenames; all accepted multi-item candidates have one profile digest.

**Check trigger:** the next Python, TypeScript and Kotlin real-model canaries.  
**What would change my mind:** repeated profile disagreements caused by scoped
workers despite actionable contract feedback; that would justify a dedicated,
typed product-contract authority upstream of implementation.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-058](058-local-runnability-before-human-acceptance.md)
- [ADR-067](067-single-productref-ingress-before-revision.md)
- [ADR-068](068-isolate-python-readiness-with-ephemeral-venv.md)
