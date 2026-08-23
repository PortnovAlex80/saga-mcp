# ADR-089: Bounded in-check substrate retry, then typed unknown and human_required — substrate unavailability is never product failure

- **Status:** Accepted
- **Date:** 2026-08-22
- **Builds on:** ADR-088, CONVEYOR-MENTAL-MODEL §15/§17/§21/§23
- **Corrects:** the CC-GAP-9 substrate classification/recovery contract in
  `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` (section 3.2 and the CC-00C
  package) and
  `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
- **Implementation plan:** `docs/plans/CONFORMANCE-CLOSURE-PLAN.md`
  (CC-00C / CC-GAP-9; blocking mutations wired into CC-10B and CC-80;
  CC-GAP-9 outcome/routing serialized before CC-GAP-7 warrant execution)

## Context

The Elite-6 final readiness manifest declared node:20-alpine Docker and
`factory.local-runnability.v1` failed **before install/test/serve** with
`LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`. The product was never exercised.
Routing then sent `domain.failed` directly to `complete-failed` and
terminal: a machine fault was recorded as a product verdict (CC-00C F8,
F10).

Current code makes the flattening deliberate. The readiness provider maps
every `ReadinessExecutionError` — including the Docker-unavailable
substrate code — to a `'failed'` check outcome
(`src/infrastructure/verification/local-runnability-check-provider.ts`,
`evidence('failed', ...)` for `ReadinessExecutionError` at :953-969), with
an explicit design comment at :861-866: Docker unavailable "→ caught below
→ `'failed'` (NOT `'error'`, which would retry indefinitely)". So the
existing seam already knows the two wrong answers — flatten to failed, or
retry forever — and picks one.

The drafted CC-GAP-9 remedy routed substrate failure "to deterministic
repair or `human_required` continuation — including a repair round for the
seam repair issue". An adversarial review of that draft (2026-08-22)
accepted three corrections:

1. **A deterministic repair round is the wrong tool for a substrate
   fault.** A repair round re-hires a worker to change product material;
   Docker unavailability is not a product defect, so the round either
   spins without a defect to remove or charges worker repair budget for a
   machine fault — exactly the "budgets must charge spin, not work"
   violation the Conveyor model forbids (§15), on the wrong axis.
2. **Escalating every transient substrate blip straight to a human wastes
   autonomy.** The model already has the right grammar for retryable
   control-plane waiting: observation retry is "a bounded/durable control
   operation, not a private worker queue" (§21). A missing environment
   precondition should get the same bounded in-factory treatment before
   any human is involved.
3. **Once retry is exhausted, the honest verdict is `unknown`, not
   `failed`.** The check never exercised the product. The model's
   four-valued check outcome (`passed|failed|unknown|error`) already
   requires that "missing execution capability or a required environment
   produces `unknown`" and that such outcomes "stop the line without
   consuming worker repair budget" (§17). `failed` must be reserved for a
   check that ran against the product and found the product wanting.

Two accounting corollaries follow and are normative here:

- **Unknown receipts must not poison a later pass.** After the substrate
  recovers, the same criterion executes again; a later passed receipt
  discharges the obligation. The earlier unknown stays as append-only
  history and never prevents, fails, annotates, or counts against the
  later pass. Discharge accounting is CC-GAP-8's append-only
  criterion-key ledger.
- **The blocked state is `human_required` and resumable.** It is a
  truthful typed wait with a wake source (§23 progress-obligation
  invariant), never an anonymous infinite pause, and never a terminal
  product failure.

The decision fork is how the readiness/warrant execution treats a missing
environment precondition: classify, retry, or escalate — and what verdict
survives.

## Decision drivers

| Driver | Weight | Reason |
|---|---:|---|
| Truthful classification | 25 | A machine fault is never a product verdict; product-failed, oracle-insufficient, and substrate-unavailable stay distinct |
| Autonomous progress | 20 | Transient substrate blips resolve with no human and no worker repair round |
| Evidence and accounting honesty | 15 | Unknown receipts are append-only history that never poisons a later pass; discharge needs a passed receipt or an operator-attributed waiver |
| Resumability | 15 | The blocked state is human_required and resumable; the obligation executes after recovery with no lost or wrongly repeated work |
| Determinism and testability | 10 | The retry bound, schedule, and transitions are deterministic and mutation-provable |
| Implementation scope and reuse | 10 | Rides the existing check/receipt seams and typed-outcome routing; no parallel vocabulary |
| Agent readability | 5 | One rule with named typed reasons |

Scores use 1 as poor and 5 as excellent.

## Considered options

### Option A: Flatten substrate unavailability into terminal product failure (the observed routing)

Keep the Elite-6 behavior (and today's provider mapping): a substrate
precondition failure yields `'failed'`, `domain.failed` routes to
`complete-failed` terminal.

Pros:

- one terminal path, no new states, the smallest state machine;
- no retry policy and no new wait surface;
- matches the current provider code exactly.

Cons:

- records a product verdict for a machine fault — the CC-GAP-9 defect
  itself;
- destroys resumability: the order terminalizes although nothing about the
  product was learned;
- collapses substrate-unavailable into product-failed, so repair routing
  and accounting are wrong downstream.

### Option B: Bounded deterministic in-check substrate retry, then typed unknown and human_required blocked/resumable (selected)

When a readiness/warrant check detects a missing environment precondition,
the check retries that precondition deterministically inside the check —
a frozen attempt bound and schedule, no model, no WorkerExecution, no
CandidateSet, no repair epoch, no repair budget consumed. When the bound
is exhausted, the check emits a typed **unknown** outcome
(`warrant-blocked-environment`) and the scope routes to a
**human_required blocked/resumable** continuation. A substrate condition
alone never yields product-failed. An earlier unknown receipt never
poisons a later pass; discharge requires a passed receipt or an
operator-attributed waiver (CC-GAP-8).

Pros:

- transient substrate blips self-heal with no human, no repair round, and
  no budget charge;
- the verdict after exhaustion is the honest one — the product was never
  exercised — reusing the four-valued check outcome the model already
  mandates;
- blocked/resumable preserves all accepted work and executes the same
  criterion under current authority after recovery;
- product-failed, oracle-insufficient, and substrate-unavailable stay
  mechanically distinct typed classes;
- the no-poison rule keeps accounting monotone: unknown is an outstanding
  obligation, never a verdict and never a stain.

Cons:

- adds two seams to the readiness provider: a frozen retry policy and a
  blocked/resumable typed wait surface;
- more blocking mutations owed in the CC-00C set (bound exhaustion,
  budget isolation, no-poison, routing);
- a too-low bound escalates genuinely slow substrates to humans —
  deliberate, visible friction, tunable only by a deliberate policy
  change.

### Option C: Immediate deterministic repair round or human_required escalation, no in-check retry (the drafted CC-GAP-9 wording)

Keep the drafted remedy verbatim: substrate failure routes to a
deterministic repair round or `human_required` continuation immediately.

Pros:

- no retry policy to freeze or test;
- every substrate fault gets immediate (human) attention;
- closest to the already-drafted plan text.

Cons:

- a repair round re-hires a worker for a machine fault with no product
  defect to remove — spin charged to the wrong budget (§15), producing
  new CandidateSets for an unchanged defect class;
- every transient blip (Docker daemon restart) becomes a human incident —
  escalation noise that trains operators to ignore the channel;
- the repair round vocabulary mislabels the incident: there is no
  rejected material and no RecoveryIssue semantics for an environment
  precondition.

## MCDA matrix

| Option | Truth 25 | Autonomy 20 | Honesty 15 | Resumability 15 | Determinism 10 | Scope 10 | Readability 5 | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Flatten to product failure | 1 | 3 | 2 | 1 | 4 | 4 | 4 | 230 |
| B. Bounded retry → typed unknown → human_required resumable | 5 | 5 | 5 | 5 | 4 | 3 | 4 | 465 |
| C. Immediate repair/human escalation | 4 | 2 | 4 | 3 | 4 | 4 | 4 | 345 |

Option B leads the nearest alternative by more than ten percent. Option
A's determinism/scope advantage is the advantage of not building the fix;
its resumability score is 1 because terminalization forecloses recovery
by design. Option C loses on autonomy (every blip escalates) and on
truthful classification (a repair round asserts a product defect exists).

## Pre-mortem on Option B

Assumption: Option B was implemented and failed six months later.

1. A slow-starting substrate exhausted the bound and escalated to
   `human_required` on every run; alert fatigue led an operator to waive
   routinely. Likelihood: medium. Detection: the unknown receipt records
   the attempt count and the frozen bound; the human_required incident
   names the exact substrate precondition and the resume action.
   Response: the bound is frozen, visible policy — raising it is a
   deliberate recorded change, never silent; the waiver channel stays
   operator-attributed.
2. A downstream surface rendered an unknown receipt as `failed` and the
   order was terminalized anyway — poison through the UI. Likelihood:
   medium. Detection: CC-GAP-8 accounting treats unknown as outstanding;
   the no-poison blocking mutation reverses any rendering that fails or
   annotates a later pass. Response: unknown is an obligation, not a
   verdict; the mutation makes the poisoning shape red.
3. The blocked state became an anonymous infinite pause — nobody resumed
   after the substrate returned. Likelihood: medium. Detection: blocked
   is a `human_required` typed wait with a wake source (progress-
   obligation invariant, §23) visible in status surfaces; resumption is
   deterministic once the precondition holds. Response: the wait carries
   an owner and a resume command; it is never an unnamed parked scope.
4. The in-check retry was implemented as an unbounded silent
   wait-until-up loop. Likelihood: low. Detection: the bound is part of
   the emitted receipt; the routing mutation requires exhaustion to
   produce exactly one typed unknown outcome plus one human_required
   continuation. Response: unbounded waiting is the design the current
   code comment already rejects ("`'error'`, which would retry
   indefinitely"); Option B bounds it instead of flattening it.
5. The retry crept into repair-round semantics — consuming repair budget
   or producing CandidateSets. Likelihood: low. Detection: in-check
   substrate retry touches only the provider/check seam; a blocking
   mutation proves budget and candidate counters are unchanged across an
   exhausted retry. Response: the grammar separation is the contract
   (observation retry, §21 — not recovery, §17).

Net effect: the remaining failure modes are honest, visible, typed states
with named reasons; no silent-green or silent-terminal failure mode
remains.

## Red Team

1. **"Never product-failed means a dead substrate can never end a run."**
   It can — by operator decision, not engine verdict. The human_required
   continuation is resumable, and an operator may cancel the order or
   attach an operator-attributed waiver. What is forbidden is the engine
   writing `product-failed` for a machine fault. Classification honesty
   is not immortality.
2. **"`unknown` is a euphemism for `failed`."** No. `failed` asserts a
   check exercised the product and the product was wanting; `unknown`
   asserts the check never exercised the product. They license different
   actions (repair vs environment provisioning) and leave different
   obligations outstanding. The four-valued check outcome exists exactly
   so this distinction is representable.
3. **"Bounded in-check retry is a hidden repair round."** A repair round
   re-hires a worker over material; in-check substrate retry re-evaluates
   an environment precondition through the provider/check seam with no
   model, no material, and no budget. It is the observation-retry grammar
   (§21), not the recovery grammar (§17).
4. **"The no-poison rule lets a later pass erase an earlier unknown."**
   It erases nothing: the ledger is append-only and the earlier unknown
   remains history. Discharge keys on the latest authoritative receipt
   for the criterion; an unknown never discharges and never blocks.
5. **"Determinism claims require the substrate itself to be
   deterministic."** The retry schedule, bound, and transitions are
   deterministic; the substrate is an external provider whose recovery
   timing is outside the factory — which is precisely why the verdict
   after exhaustion is `unknown` rather than `failed`.

All five objections are answered inside Option B; objections 1 and 4
shaped the waiver/no-poison wording, 2 and 3 the outcome vocabulary, 5
the determinism scope.

## Decision

Choose Option B. The CC-GAP-9 substrate classification/recovery contract
is normatively:

1. **Three classes stay distinct.** product-failed (a check exercised the
   product and the product failed), oracle-insufficient (the declared
   oracle cannot prove the claim — an outstanding obligation, never a
   pass and never a product verdict), and substrate-unavailable (a
   missing environment precondition) are preserved as distinct typed
   outcomes on every surface and route. No code path or projection may
   collapse them.
2. **Bounded deterministic in-check substrate retry.** When a
   readiness/warrant check detects a missing environment precondition
   (for example `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`), the check
   retries that precondition deterministically inside the check: a frozen
   attempt bound and schedule, no model involvement, no WorkerExecution,
   no CandidateSet, no repair epoch, no worker repair budget consumed.
3. **Typed unknown after exhaustion.** When the bound is exhausted, the
   check emits a typed **unknown** outcome (`warrant-blocked-environment`)
   — never `passed`, never `failed` — and the verification obligation
   stays outstanding in CC-GAP-8's append-only criterion-key accounting.
4. **human_required blocked/resumable continuation.** The scope routes to
   a `human_required` blocked continuation that is resumable: a truthful
   typed wait with a wake source. After the precondition holds, the same
   criterion executes again under current authority. A substrate
   condition alone never produces a terminal product failure.
5. **No-poison accounting.** An earlier unknown receipt never prevents,
   fails, annotates, or counts against a later executed check of the same
   criterion. Discharge requires a passed receipt or an
   operator-attributed waiver (the CC-GAP-8 discharge rule); the unknown
   remains append-only history.
6. **Legacy records are grandfathered, never reclassified.** Frozen
   Elite-6 evidence is not rewritten; enforcement binds future gate
   evaluation.
7. **Prohibited shapes** (each owed a blocking mutation): routing
   substrate unavailability to terminal product failure; collapsing the
   three outcome classes into one; unbounded or silent-until-up retry;
   charging substrate retry to worker repair budget; rendering an
   unknown receipt as `passed` or as `failed` on any surface; letting an
   earlier unknown block or fail a later pass.

## Consequences

Positive:

- the Elite-6 routing defect (machine fault → `complete-failed` terminal)
  becomes mechanically red at classification and at routing;
- transient substrate faults self-heal without humans, repair rounds, or
  budget charges;
- product verdicts stay about the product: `failed` means the product was
  exercised and wanting;
- blocked/resumable preserves all accepted work; resumption executes the
  same criterion under current authority;
- accounting stays honest and monotone: unknown is outstanding, never
  discharged, never a stain on a later pass.

Negative:

- two new seams on the readiness provider (frozen retry policy;
  blocked/resumable typed wait) and their blocking mutations are owed in
  the CC-00C set;
- genuinely slow substrates escalate to humans until the bound is tuned —
  deliberate, visible friction;
- the human_required continuation adds one more nonterminal state that
  status surfaces must label truthfully.

Neutral:

- the operator-attributed waiver remains the only other discharge
  channel (CC-GAP-8 rule, ADR-088 waiver discipline);
- reason-code vocabulary above is the contract vocabulary; exact string
  stability is frozen by the CC-GAP-9 blocking proofs when they land;
- CC-GAP-9 stays serialized before CC-GAP-7 warrant execution and routed
  through the plan's single-writer readiness seam row.

## Decision Journal

Date: 2026-08-22.

Decision: CC-GAP-9 substrate handling is bounded deterministic in-check
substrate retry, then a typed unknown outcome
(`warrant-blocked-environment`) and a human_required blocked/resumable
continuation — never a product-failed verdict; product-failed,
oracle-insufficient, and substrate-unavailable remain distinct typed
classes; unknown receipts never poison a later pass; discharge requires a
passed receipt or an operator-attributed waiver.

Ex-ante expectations:

- At CC-GAP-9 landing, a substrate-unavailable readiness failure retries
  in-check up to the frozen bound, then produces exactly one typed
  unknown `warrant-blocked-environment` outcome and one human_required
  blocked/resumable continuation; routing the same failure to
  `complete-failed` terminal fails the blocking mutation.
- At CC-GAP-9 landing, the blocking mutations also prove: an exhausted
  retry consumes no worker repair budget and creates no CandidateSet; an
  earlier unknown receipt cannot prevent or fail a later passed receipt
  for the same criterion (no-poison); collapsing the three outcome
  classes into one fails classification.
- Legacy and frozen Elite-6 records remain unchanged.
- At CC-00C exit, no substrate condition can produce a product-failed
  verdict or a terminal product failure on any surface or route.

Check trigger: CC-GAP-9 exit, or any later proposal to charge substrate
retry to worker repair budget, to render unknown as failed or passed, or
to route substrate unavailability to terminal product failure.

What would change this decision: evidence that a bounded in-check retry
cannot be made deterministic on the readiness seam, or an operator
directive that substrate availability is an operator-managed externality
with no in-factory retry.

## References

- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` — sections 3.2, CC-00C,
  CC-10B, CC-80, 13
- `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
- `docs/factory-run/conformance-closure/CC-00B-ELITE6-TERMINAL-INTEGRITY.md`
- `docs/architecture/decisions/088-register-conditional-synthesis-coverage.md`
- `docs/architecture/CONVEYOR-MENTAL-MODEL.md` — §15 (budgets charge spin,
  not work), §17 (four-valued check outcome; unknown stops the line
  without consuming repair budget), §21 (bounded observation retry),
  §23 (typed waits with wake sources; no anonymous infinite pause)
- `src/infrastructure/verification/local-runnability-check-provider.ts`
  — the seam that today maps `ReadinessExecutionError` (including
  `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`) to `'failed'` (:861-866,
  :953-969)
