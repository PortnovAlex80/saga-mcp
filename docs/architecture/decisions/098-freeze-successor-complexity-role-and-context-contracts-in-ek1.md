# ADR-098: Freeze successor complexity, role and context contracts in EK-1

- **Status:** Accepted
- **Date:** 2026-08-24
- **Supersedes:** none
- **Superseded by:** none
- **Decision-maker:** primary architect after autonomous-decision analysis and hostile review

## Context

The greenfield event-kernel plan answers the recurring authority and durable
handoff failures, but an independent critique identified four ways in which
the replacement could still fail before implementation starts:

1. A 60-day plan with many packages and hundreds of checks can become a
   second-system project unless structural complexity has a measured ceiling.
2. `AgentLaunchSpec` already improves role/skill pinning, but role identity is
   still re-derived at several boundaries from task status/tags or execution
   context. The target needs one finite binding contract from Workplace intent
   through dispatch, runner, prompt/tools and tracker projection.
3. The current runner measures prompt-layer bytes and can enforce
   `SAGA_PROMPT_MAX_BYTES`, but zero means unlimited and the check does not own
   the cumulative request across hooks, tool schemas/results and recovery
   context. Large planner requests therefore remain a known failure class.
4. The current OpenCode shim sees initial stdin and postflight stream events,
   while the opaque OpenCode loop owns later provider calls. It cannot prove
   pre-send admission after hooks and tool results without an instrumented
   transport boundary.

The placement of these protections is an architecture fork. Putting target
contracts into the ADR-053 closure predecessor appears to protect the project
earlier, but that predecessor describes current task, ExecutionProfile,
AgentLaunchSpec, runner and tracker semantics. Freezing a greenfield target
from those representations would either preserve the wrong model or create two
contract authorities across the exact boundary ADR-053 warns about.

EK-1 already has the necessary property: it permits no production behavior
change and precedes every target implementation phase. It can therefore be the
independent pre-implementation oracle without adding a third bridge plan.

## Cynefin triage

This decision is **Complicated**. The relevant sources, boundaries and tradeoffs
are discoverable; multiple valid placements exist; expert analysis and an
independent challenge can select one before implementation.

## Decision drivers

Scores use 1 (poor) through 5 (strong).

| Driver | Weight | Why it matters |
|---|---:|---|
| Independent pre-implementation oracle | 25 | The contract must exist before code can make itself the oracle. |
| Scope and authority correctness | 20 | Target contracts must not be derived from legacy authorities. |
| Coverage of identified risks | 20 | Complexity, role binding and cumulative pre-send context are conjunctive. |
| Simplicity and document load | 15 | The response must reduce coordination surface, not add another programme. |
| Protection of predecessor qualification | 10 | Current closure evidence must not be invalidated by successor work. |
| Reversibility | 10 | A rejected specification should cost documents and fixtures, not production rollback. |

## Considered options

### Option A - Amend the predecessor only

Add a new predecessor phase that freezes the complexity, role and prompt
contracts before the successor starts. This is early, but it asks an obsolete
representation to define its replacement.

### Option B - Add a separate bridge plan

Create a five-day intake-risk plan between the predecessor and event-kernel
plan. This gives clean formal independence but adds a third plan, more gates and
another authority boundary.

### Option C - Strengthen EK-1 only

Keep the predecessor focused on canonical consistency and ADR-053 truth. Make
EK-1 freeze independently verified complexity, role and context specifications
before EK-2 or any target production implementation.

### Option D - Split responsibility between predecessor and EK-1

Freeze caps and schemas in the predecessor, then implement them in the
successor. This initially appeared strongest, but creates duplicate contract
authority and couples the greenfield protocol to legacy concepts.

## MCDA matrix

| Option | Oracle (25) | Scope (20) | Coverage (20) | Simplicity (15) | Protect predecessor (10) | Reversibility (10) | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A - predecessor only | 4 | 2 | 4 | 4 | 4 | 4 | 360 |
| B - bridge plan | 5 | 4 | 4 | 2 | 1 | 5 | 375 |
| C - EK-1 only | 5 | 5 | 4 | 5 | 5 | 4 | 470 |
| D - split authority | 3 | 3 | 5 | 4 | 4 | 4 | 375 |

The initial analysis scored D at 475 because it treated earlier placement as
independence. The hostile review invalidated that premise: a target contract
specified from the legacy universe is earlier, but not independent. EK-1 is
already a no-production-change phase, so C has the independent-oracle property
without a second specification authority.

## Pre-mortem

Assume Option C was chosen and the successor still failed.

1. **Implementation quietly changed the EK-1 contracts.** Likelihood: high.
   Detection: specification digest mismatch. Mitigation: any semantic change
   reopens EK-1 and invalidates later evidence; spec authors/verifiers cannot
   implement the corresponding production packages.
2. **The complexity metric was gamed with line-count reduction.** Likelihood:
   medium. Detection: architectural surface grows while LOC falls. Mitigation:
   conjunctive AST/schema/universe dimensions; no scalar score and no waiver.
3. **CanonicalRoleContract became a god object or giant prompt.** Likelihood:
   medium. Detection: mutable fields, duplicated text, transition policy in a
   skill. Mitigation: immutable content-addressed references; Workplace owns
   transitions; semantic skills contain cognition only.
4. **Budget compliance silently removed required meaning.** Likelihood: high.
   Detection: scope/unknown/claim graph differs after prompt assembly.
   Mitigation: mandatory layers cannot truncate; large products use exact refs;
   dynamic overflow becomes a typed repair result.
5. **Provider token counting drifted.** Likelihood: medium. Detection: pinned
   counter disagrees with provider postflight evidence. Mitigation: pin the
   counter/version, retain a conservative byte ceiling and reserve provider,
   output and safety margins.
6. **Concurrent requests both passed a receipt-derived cumulative limit.**
   Likelihood: medium. Detection: duplicate ordinal/CAS mutation. Mitigation:
   ActivityAttempt owns fenced counters; admission, receipt and exact send
   obligation commit atomically and counters are never reconstructed from
   receipts.
7. **The opaque CLI hid later provider requests.** Likelihood: high with the
   current shim. Detection: a hook/tool injection has no exact pre-send receipt.
   Mitigation: instrument the final OpenCode transport boundary or fail closed;
   postflight usage is not admission proof.

## Red Team

The strongest objection was directed at initial Option D: the predecessor
represents the protocol being removed. Asking it to freeze target role and
context contracts either contaminates the new kernel or creates predecessor
and successor authorities that must later be reconciled. A default-on byte cap
in the predecessor could fail earlier, but it would not define a valid
provider-aware cumulative envelope. The review also noted that EK-1 already
forbids production changes, freezes the transition universe and uses
independent forward/reverse derivations.

The objection is accepted. The decision changed from D to C. The predecessor
receives only an explanatory boundary statement, not target implementation or
new qualification work.

A final implementation-readiness challenge found additional false-green paths:
specifications without a pre-WP-05 executable validator, independent
WorkIntent/attempt role resolution, receipt-derived concurrent counters, an
opaque OpenCode multi-turn loop, admission mistaken for send evidence, a second
provider selector hidden in the limit profile, a source-SHA-dependent contract
digest, omitted ADR-098 closure, and a self-referential final qualification
SHA. All were accepted as stop-ship corrections in the plan: machine admission
receipt, atomic inheritance/CAS/outbox semantics, instrumented pre-send
transport, sole route authority, cross-SHA contract digest, explicit ADR-098
closure, and separate qualificationSourceSha/closureSha identities.

## Decision

Choose **Option C - Strengthen EK-1 only**.

Before any EK-2 production implementation, EK-1 must freeze and independently
verify three content-addressed admission specifications:

1. a conjunctive structural complexity budget with deterministic measurements
   and finite per-dimension targets;
2. one finite CanonicalRoleContract schema and installed-manifest binding from
   Workplace intent through ActivityAttempt, dispatch, runner and tracker;
3. one positive finite PromptBudgetProfile and cumulative context-accounting
   protocol producing an immutable PromptAssemblyReceipt before every provider
   request, with both per-request and session-total limits.

Before WP-05, `npm run validate:ek-admission-specs` must validate all three
specifications, deliberate invalid mutations must be red, and EK-1 must issue a
content-addressed `EK-ADMISSION-RECEIPT.json`. WP-05 records that exact receipt
digest as a prerequisite. Thus WP-17/WP-18 implement an already executable
specification oracle; they do not create it.

The stable cross-SHA identity is
`admissionContractDigest = H(canonical(specificationDigests, validatorDigest, mutationCorpusDigest))`.
The EK-1 source SHA remains receipt provenance outside that digest. EK-13
recomputes the contract digest; it does not require a final-checkout receipt to
equal the original receipt containing a different source SHA.

ActivityAttempt is the sole mutable owner of prompt/context admission counters.
Its CAS command atomically admits one exact final provider request, appends the
admitted receipt and creates an idempotent provider-send TransitionObligation.
A refused receipt is not a send receipt, and receipts are never summed to infer
current authority. The exact role binding is copied atomically from WorkIntent;
ActivityAttempt cannot resolve it again.

`executorRoutePolicyRef` is the sole provider/model selection authority and is
a finite declarative eligibility table, not executable policy. ActivityAttempt
pins its one selected provider/model/version. PromptBudgetProfile names only a
read-only `providerModelLimitTableRef` keyed by that pinned identity; the limit
table cannot select, reroute or fallback. Route rule/condition/branch counts and
serialized size are complexity-budget dimensions.

The accounting point is after all prompt, skill, tool schema, hook, retained
tool-result and recovery assembly and immediately before network send. An
opaque `opencode run` loop that exposes only stdin and postflight events is
nonconforming. The implementation must provide an instrumented OpenCode
transport boundary or fail closed; it may not claim coverage from estimates.

The author and verifier of these specifications may not implement the matching
production work packages. A semantic specification change reopens EK-1. It
cannot be handled as an implementation detail or qualification waiver.

No third plan is created. The ADR-053 closure predecessor remains responsible
only for current canonical truth and its existing receipt.

## Consequences

**Positive:**

- The three objections become blocking conditions before implementation.
- The new kernel is judged against an independent target rather than legacy
  task/runner behavior.
- Complexity can decrease even when incident regressions increase.
- Role drift and prompt overflow become typed, replayable protocol evidence.
- No additional bridge plan or long-lived authority is introduced.

**Negative:**

- EK-1 is larger and cannot be treated as a quick inventory exercise.
- Token accounting must pin provider/model assumptions and maintain a
  conservative fallback ceiling.
- The existing OpenCode CLI shim cannot by itself satisfy per-request pre-send
  accounting; a pinned instrumented transport boundary is required.
- Any legitimate contract change invalidates downstream evidence and requires
  re-verification.

## Validation and closure evidence

ADR-098 remains `planned` until all of the following are blocking and green:

- [x] EK-1 stores hashes for the three specifications, validator and independent
      EK admission receipt before WP-05.
- [x] `validate:ek-admission-specs` rejects a removed complexity dimension,
      duplicate/missing role binding, zero/unbounded limit, arbitrary contract
      field, executable/fallback route rule, route-selecting limit table and
      unclassified hook/tool context source.
- [x] `test:workflow-complexity` kills a second authority/path and an
      unbudgeted universe expansion.
- [x] `test:role-contract` proves one digest across scripted, replay and real
      launch paths, atomic WorkIntent-to-ActivityAttempt inheritance and every
      fallback resolver.
- [x] `test:prompt-budget` covers initial prompt, hooks, tool schemas/results,
      recovery, concurrent admission, crash/send distinction and one-over-limit
      behavior without silent truncation.
- [x] The real OpenCode lane exposes exact pre-send receipts for all turns; an
      initial-stdin/postflight-only adapter is blocking-red.
- [x] EK-8 reports zero legacy/replacement debt and one binding/accounting path.
- [x] EK-13 records final complexity vectors, role manifest digest and prompt
      distribution with no waiver, recomputes admissionContractDigest, and
      updates ADR-098/registry only from these executable digests.
- [x] EK-13 distinguishes qualificationSourceSha from the later docs-only
      closureSha and proves their executable trees byte-identical; the receipt
      never attempts to contain its own commit hash.

## Decision journal

- **Ex ante expectation:** the amended EK-1 prevents code-first growth and
  turns large-prompt and role-drift incidents into bounded protocol cases.
- **30-day check:** compare actual structural vectors and specification churn;
  investigate if any dimension changes more than once after freeze.
- **90-day check:** compare qualification prompt distributions and role digests
  across scripted and real projects; revisit if provider drift repeatedly
  invalidates deterministic admission or if complexity caps require waivers.
- **Reversal trigger:** independent evidence that EK-1 cannot specify these
  contracts without executing target production behavior. If triggered, pause
  EK-2 and reconsider a separate executable specification harness, not a
  predecessor-owned contract.

## References

- `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md`
- `docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`
- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
- `docs/architecture/decisions/097-event-projected-workflow-kernel.md`
- `tracker-view/claude-runner.mjs`
- `src/lifecycle/work-assignment-core.ts`
- `src/infrastructure/work/sqlite-work-assignment-adapter.ts`
- `tests/characterization/fixtures/2026-07-28-failures/06-mutable-tracker.md`
- `tests/characterization/fixtures/2026-07-28-failures/08-skill-drift.md`
