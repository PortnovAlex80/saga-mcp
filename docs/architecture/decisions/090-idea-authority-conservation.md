# ADR-090: Idea authority conservation — one register vocabulary, deterministic synthesis injection, advisory archaeologist

- **Status:** Accepted
- **Date:** 2026-08-22
- **Builds on:** ADR-052, ADR-053, ADR-084, ADR-088, ADR-089
- **Corrects:** the proposed A–G package and root-cause framing in
  `.research/IDEA-TRACEABILITY-POSTMORTEM.md` (read-only Elite-6 evidence
  copy, left unchanged) — the proposal's parallel scope-clause ledger,
  parallel unknown ledger, new mechanics-spec product family, gating
  archaeologist, and new conformance-obligation family are all rejected
- **Implementation plan:** `docs/plans/CONFORMANCE-CLOSURE-PLAN.md`
  (§7A, packets CC-IC-1..4, serialized after the CC-GAP-6 seam lands;
  blocking mutations wired into CC-10B and CC-80 once landed)

## Context

The Elite-6 idea traceability post-mortem (external evidence copy at
`.research/IDEA-TRACEABILITY-POSTMORTEM.md`) reports that an Elite-style
browser game order lost, between Discovery and Formalization: the dynamic
pricing algorithm, arcade dynamics, the ordered browser smoke test, and an
assembled-runnable-whole integration criterion. It proposes a seven-part
remedy (A–G): an epic-as-authority trace gate with scope-clause coverage, a
gating second-model requirements archaeologist, unknowns-as-obligations, a
new mechanics-spec artifact family, runnable-lifecycle auto-required ACs,
mandatory quantification of qualitative adjectives, and five new
conformance obligations.

The Elite-6 terminal evidence already adjudicated in this repository
(CC-00B/CC-00C records) does not support the post-mortem's transit-loss
narrative, and the current code shows precisely where the conservation
surface is missing:

1. **The content crossed the boundary.** The full Discovery payload rides
   into Formalization (the empirical correction already recorded for
   AC-drift network A1 in
   `docs/architecture/AC-DRIFT-REMEDY-DESIGN.md`: the sealed proposal
   payload reaches the Formalization case, `process_node_input`, and the
   spawn prompt; the author saw the requirements). The Formalization SRS
   (FR-9 and neighbors) retained the browser/canvas/smoke requirements, and
   CC-00C fact F2 records that AC-22 existed requiring install plus start
   leading to an accessible running game.
2. **What never existed is the normative counted surface.** No normative
   acceptance-criterion/set-equality/owner was created for whole-product
   synthesis: AC-22 was only nominally attached, nothing failed planning
   admission because no mechanical inherited criterion existed to fail on
   (CC-00C root-cause wording, corrected 2026-08-22). The defect is absent
   conservation enforcement, not content dropped in transit.
3. **Unknowns are opaque and unconsumed.**
   `DiscoveryProposalPayload.unknowns` is `string[]`
   (`src/modules/discovery/domain/discovery-domain-contracts.ts`), carried
   through normalization aliases and then never consumed by any gate: no
   identity, no owner, no unblock criterion, no disposition. The pricing
   algorithm unknown died exactly there — uncounted, not dropped.
4. **The conservation vocabulary already exists and is partially landed.**
   The versioned Order Constraint Register
   (`factory.order-constraint-register.v1`, stable `ord-c-NNN` ids, classes
   `execution|material|human`, digest-pinned,
   `src/shared/constraint-register.ts`), the disposition network
   (brief `constraint_dispositions`, `accepted|waived+reason`,
   `formalization-contract-validator.ts`), the coverage network
   (kernel-derived `coveredConstraintIds`, SRS §D2 back-edge and §2.2
   module-manifest reverse diff, ADR-088), and the warrant seam
   (`VerificationWarrantRef`) are the single existing family. The `RULE`
   artifact type with `implements_spec`/`verified_by` trace vocabulary
   already carries business-rule/mechanics semantics. The product-build
   lifecycle already freezes the `runnable-local` terminal classification
   (`src/process-modules/lifecycles/product-build-lifecycle.ts`).

The decision fork is how to conserve idea authority across the
Discovery-to-Development translation: adopt the post-mortem package as
proposed (parallel ledgers and new product families), extend the single
existing register vocabulary, or run no program at all.

## Decision drivers

| Driver | Weight | Reason |
|---|---:|---|
| Correctness and fail-closed conservation | 25 | A counted obligation may not be silently dropped, deferred into opacity, or forged |
| Vocabulary economy | 20 | Parallel scope-clause/unknown ledgers recreate the AC-drift fragmentation this program exists to close |
| Legacy monotonicity | 15 | Registerless corpora keep exactly the current green behavior (ADR-088 sole grandfather condition) |
| Autonomous mechanizability | 15 | The rule must be mechanically decidable with typed reasons; no human or LM adjudication on the gate path |
| Implementation scope and reuse | 10 | Extend the landed register/disposition/coverage seams and the single ADR-084 proof-token family |
| Agent readability | 10 | One register, one disposition grammar, one coverage diff |
| Reversibility | 5 | Additive register schema version; packets revert as units |

Scores use 1 as poor and 5 as excellent.

## Considered options

### Option A: the post-mortem package as proposed (parallel ledgers and new families)

Adopt A–G verbatim: a new epic scope-clause coverage gate beside the
register, every Unknown becoming an OPEN item in a new obligation ledger, a
new mechanics-spec artifact family, a gating requirements archaeologist
whose non-empty output triggers repair, and five new conformance
obligations as a separate family.

Pros:

- directly mirrors the post-mortem text; each remedy is locally explicit;
- the archaeologist gives a second semantic reading of epic vs AC set.

Cons:

- a parallel scope-clause ledger and a parallel unknown ledger duplicate the
  register/disposition/coverage family — the exact fragmentation ADR-088
  closed, reopened;
- a new mechanics-spec product family beside RULE/SPEC duplicates existing
  artifact types and trace vocabulary;
- a gating archaeologist puts a non-deterministic LM on the authority path
  and violates the deterministic-gate rule (ADR-084 honest proof boundary;
  the LLM-oracle-on-a-gate rejection in AC-DRIFT-REMEDY-DESIGN);
- a separate obligation family beside the ADR-084
  AcceptanceObligationContract breaks set-equality accounting.

### Option B: one register vocabulary, extended; existing networks; single proof-token family (selected)

Extend the one versioned Order Constraint Register additively at Discovery
settlement (source obligation classes `execution|material|human|
open-question`; typed measurability semantics; lifecycle synthesis
semantics), keep one digest/ref, extend the one disposition network, keep
the existing `coveredConstraintIds` relay and SRS §D2/§2.2 reverse diff as
the only coverage mechanism, use existing RULE artifacts as the
mechanics-spec carrier with typed binding, make `runnable-local` a frozen
lifecycle classification that deterministically injects whole-product
synthesis plus ordered smoke obligations, keep the LM archaeologist
strictly advisory, and compile the five proof tokens into the single
ADR-084 `AcceptanceObligationContract` family. Implementation is four
bounded serialized packets (CC-IC-1..4) that start only after the CC-GAP-6
seam lands.

Pros:

- every A–G intent is conserved on the existing vocabulary — no parallel
  ledger, no new product family, no second obligation registry;
- the registerless grandfather condition and all ADR-088 semantics are
  untouched (monotone);
- every gate stays deterministic and typed; the LM stays off the authority
  path;
- the Elite-6 loss shapes (uncounted unknowns, unowned synthesis,
  unquantified adjectives, unbound mechanics) each become a mechanical
  reverse-diff or disposition red.

Cons:

- register schema v2 churn on a live seam — must be additive and serialized
  behind CC-GAP-6 through the single-writer row;
- the register carries more semantics per entry (class, measurability,
  synthesis) — extraction quality remains a Discovery-assessor boundary;
- more blocking mutations owed (the CC-IC set).

### Option C: no program

Rely on the landed networks 1–3 (ADR-088/CC-GAP-6..9) alone and accept the
remaining loss class: unknowns stay opaque strings, qualitative entries
stay unquantified, mechanics stay unbound, synthesis ownership depends on
the order text happening to name an execution constraint.

Pros:

- zero new surface; nothing to serialize or prove;
- no schema-version churn.

Cons:

- the Elite-6 unknowns/mechanics/qualitative loss shapes remain
  mechanically invisible — a green factory can still lose them;
- conservation remains prose-dependent, exactly the defect the post-mortem
  demonstrates.

## MCDA matrix

| Option | Correctness 25 | Economy 20 | Monotonicity 15 | Autonomy 15 | Scope 10 | Readability 10 | Reversibility 5 | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Post-mortem package verbatim | 3 | 1 | 3 | 3 | 2 | 2 | 3 | 240 |
| B. One-register extension | 5 | 5 | 5 | 5 | 4 | 4 | 4 | **475** |
| C. No program | 2 | 5 | 5 | 2 | 5 | 4 | 5 | 370 |

Option B leads the nearest alternative by more than ten percent. Option C's
economy is the economy of not building the conservation surface; its
correctness score reflects that the demonstrated loss class stays green.
Option A loses on vocabulary economy and autonomy: it recreates parallel
authorities and puts an LM on a gate.

## Pre-mortem on Option B

Assumption: Option B was implemented and failed six months later.

1. Register v2 churn broke legacy corpora — older v1 readers threw on new
   fields. Likelihood: low. Detection: registerless and v1 corpus gates
   stay green in CI. Response: the schema extension is strictly additive
   and version-gated; v1 registers verify under their own schema version;
   the null-binding grandfather path is unchanged (ADR-088).
2. Discovery workers learned that unknowns become obligations and started
   hiding them, padding them, or deferring everything. Likelihood: medium.
   Detection: open-question entries are drafted 1:1 and positionally from
   the payload `unknowns` by the kernel — an unknown present in the
   proposal and absent from the register is a red (mutation m1);
   mass-deferral without owner/unblock criterion is a red (mutation m2).
   Extraction quality remains the Discovery assessor's boundary and the
   archaeologist's advisory beat; neither sits on the gate path.
3. Waiver/deferral abuse made open questions a rubber stamp. Likelihood:
   medium. Detection: deferrals carry reason, owner, and unblock criterion;
   discharge/deferral accounting follows the ADR-088/089 waiver discipline
   (typed, non-empty reason; operator-attributed waiver channel only).
4. The archaeologist quietly became a gate — someone wired its report to
   planning admission. Likelihood: medium. Detection: a blocking mutation
   proves an archaeologist report cannot alter the register digest, the
   relay, the reverse diff, or any gate outcome; the sole promotion path is
   a new register revision with a new digest produced by Discovery
   settlement.
5. Runnable-local injection hardcoded browser/canvas semantics into the
   engine (LEGO violation). Likelihood: low. Detection: injection is
   deterministic data declared by the frozen lifecycle classification and
   workshop-declared register lines; a mutation proves the engine performs
   no prose rereading and no workshop-name branch (Conveyor Mental Model
   §3; master plan §4 no-workshop-branch rule).

Net effect: remaining failure modes are typed reds with named reasons or
advisory-channel noise; no silent-green failure mode is introduced.

## Red Team

1. **"One register means one choke point — v2 schema churn risks every
   gate at once."** The extension is additive and version-gated; v1 content
   keeps its identity and behavior; the digest already content-addresses
   entries, so new typed fields honestly produce a new revision. CC-IC-1
   serializes behind the CC-GAP-6 seam through the single-writer row — the
   choke point is the price of having exactly one conservation authority,
   and it is paid deliberately.
2. **"An advisory-only archaeologist is toothless — you rebuilt the human
   review you removed."** Its output is evidence for promotion decisions,
   not a verdict. Promotion produces a new register revision/digest through
   the normal settlement path and then flows through the same mechanical
   networks — the conservation theorem never depends on the archaeologist
   being right.
3. **"The open-question class turns every uncertainty into bureaucracy."**
   The Elite-6 defect was precisely that uncertainty was free and
   invisible. The cheap path remains available — a typed deferral with
   reason, owner, and unblock criterion — but it is counted, owned, and
   unblocked-or-waived explicitly.
4. **"RULE-as-mechanics-spec confuses policy artifacts with algorithm
   specs."** RULE is the existing business-rule artifact and already binds
   designs through `implements_spec`/`verified_by` traces; SPEC remains the
   design-contract carrier. The decision adds typed binding/coverage
   between register entries and RULE artifacts — no new product family, no
   second spec vocabulary.
5. **"You still cannot prove the register counted everything — semantic
   perfection is unreachable."** Accepted and recorded: the SMART goal is
   mutation-killable mechanical conservation of the counted register, never
   semantic perfection. Extraction quality belongs to the Discovery
   assessor; the second reading is advisory; this is the ADR-084 honest
   proof boundary applied to idea authority.

All five objections are answered inside Option B; objections 1 and 3 shaped
the serialization and disposition wording, 4 the RULE binding wording, 5
the explicit non-goal.

## Decision

Choose Option B. Normatively:

1. **One register vocabulary.** The single versioned Order Constraint
   Register is extended additively
   (`factory.order-constraint-register.v2`) at Discovery settlement.
   Source obligation classes become `execution|material|human|
   open-question`. No parallel scope-clause ledger and no parallel unknown
   ledger may be created; every conservation rule rides this register.
2. **One digest/ref, honest revisions.** The register keeps exactly one
   content-addressed digest/ref. The v2 typed fields are entry content, so
   adding measurability/synthesis semantics to an entry produces a new
   digest — a new register revision, never an in-place mutation. v1
   registers verify unchanged under their schema version.
3. **Typed measurability.** Every register entry carries measurability
   semantics: either a measurable interpretation (a numeric/observable
   interpretation reference) or an explicit typed deferral with a reason.
   A qualitative entry with neither is a typed red — never a silent
   adjective.
4. **Runnable-local is a frozen lifecycle classification with
   deterministic injection.** When the lifecycle classification is
   `runnable-local` (the product-build terminal), Discovery settlement
   deterministically injects the whole-product-synthesis obligation and the
   ordered-smoke obligation as register entries. The engine never infers
   obligations by rereading order or SRS prose; browser/canvas/any frontend
   specifics arrive only through workshop-declared data (Conveyor Mental
   Model §3; master plan §4).
5. **Open questions are obligations with owners.** Settlement drafts
   `open-question` entries 1:1 and positionally from the proposal
   `unknowns` (kernel-side, no guessing, no LM). Every open-question entry
   must reach, through the existing disposition network, either `resolved`
   (with evidence) or `deferred`/`waived` (with non-empty reason, owner,
   and unblock criterion). Undisposed open questions are a typed red
   (`FORMALIZATION_CONSTRAINT_UNDISPOSED` per-ID guidance), never opaque
   strings.
6. **Coverage stays the ADR-088 mechanism.** v2 entries join the same
   kernel-derived `coveredConstraintIds` relay and the same SRS §D2 and
   §2.2 reverse diff (register ids minus union of covered ids minus typed
   waivers = empty set). Injected synthesis/smoke obligations are enforced
   by the same planning-admission fail-close and entrypoint-ownership
   conjunction; a nominal attachment remains non-coverage.
7. **RULE artifacts are the mechanics-spec carrier.** Mechanics-bearing
   register entries bind to RULE artifacts through typed references and the
   existing `implements_spec`/`verified_by` trace vocabulary; covering such
   an entry requires the referenced RULE artifact to be accepted and
   trace-bound within the current lifecycle. No new mechanics-spec product
   family is created.
8. **One proof-token family.** The five conservation obligations
   (epic-clause coverage; unknowns owned; mechanics-spec required;
   integration/synthesis AC for runnable-local; qualitative quantified)
   compile as proof tokens into the single ADR-084
   `AcceptanceObligationContract` family
   (`tests/factory-proof/obligation-contracts.mjs`) with mutants from the
   existing mutation algebra. No second obligation registry.
9. **The LM archaeologist is advisory only.** Its reports are evidence for
   promotion decisions and may be stored as ordinary artifacts, but they
   never gate, never mutate the register, and never write authority. The
   sole promotion path is a new register revision with a new digest through
   Discovery settlement; a blocking mutation proves an archaeologist report
   cannot alter the register, relay, reverse diff, or any gate outcome.
10. **Legacy monotonicity is preserved.** A proposal without
    `order_constraints` builds no register: null binding, empty diffs,
    typed skips, green gates (the ADR-088 sole grandfather condition,
    unchanged). Any present register fails closed on its obligations.
11. **The corrected diagnosis is normative.** The post-mortem's
    transit-loss framing ("four things vanished at the bridge") is
    superseded: the full Discovery payload rides into Formalization, FR-9
    and the SRS retained browser/canvas/smoke, and AC-22 existed — what was
    missing is a normative AC/set-equality/owner surface and consumed,
    owned unknowns. The post-mortem evidence copy is left unchanged; this
    ADR and the plan carry the correction.
12. **Implementation is bounded and serialized, not a standing program.**
    The program lands as packets CC-IC-1..4
    (`docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7A), serialized after the
    CC-GAP-6 seam lands, through the single-writer
    `Constraint register and warrant seam` row, with exact files, tests,
    and blocking mutations per packet and an explicit finish condition. It
    is not a vague parallel implementation program and not a permanently
    open architecture cycle.

### A–G reconciliation (item by item)

| Item | As proposed by the post-mortem | ADR-090 disposition |
|---|---|---|
| A. Epic-as-authority trace gate | new scope-clause coverage gate; residue fails Formalization | Reused, not built: register ids + kernel-derived `coveredConstraintIds` + SRS §D2/§2.2 reverse diff (ADR-088); v2 entries join the same diff — no parallel scope-clause ledger |
| B. Requirements archaeologist | second model; non-empty output triggers repair | Advisory only; promotion produces a new register revision/digest via Discovery settlement; cannot gate or mutate authority |
| C. Unknowns are obligations | every Unknown becomes OPEN with an owner; Formalization blocked until resolved or deferred | `open-question` register class drafted 1:1 from proposal unknowns; disposition `resolved` or `deferred`/`waived` with reason, owner, unblock criterion on the existing network |
| D. Mechanics/dynamics first-class | new mechanics-spec artifact family | Existing RULE artifacts are the mechanics-spec carrier; typed binding/coverage added; no new product family |
| E. Runnable lifecycle auto-requires integration + ordered smoke AC | inferred at Formalization | `runnable-local` frozen lifecycle classification; Discovery settlement deterministically injects whole-product-synthesis + ordered-smoke obligation entries; engine never infers by rereading prose |
| F. Qualitative adjectives quantified | new measurable-translation requirement | Typed measurability on every register entry: measurable interpretation or typed deferral with reason |
| G. Five new conformance obligations | new obligation family | Compiled proof tokens in the single ADR-084 `AcceptanceObligationContract`; existing mutation algebra; blocking via existing CC-10B/CC-80 floors |

## SMART goal and honest boundary

**Objective (SMART).** By CC-IC exit, for every new Factory Start whose
Discovery settlement builds a register, each of five blocking mutations
turns the blocking group red when reversed — (m1) a proposal unknown absent
from the register's open-question entries; (m2) an open-question entry
without a resolved-or-deferred/waived disposition carrying reason, owner,
and unblock criterion; (m3) a mechanics-bearing constraint whose RULE
binding is removed or untrace-bound; (m4) a runnable-local lifecycle
classification without the injected whole-product-synthesis and
ordered-smoke obligations; (m5) a qualitative entry without a measurable
interpretation or typed deferral — and a registerless legacy corpus stays
green (Specific). Measured solely by the compiled obligation-contract
mutants and the blocking acceptance group, never by prose (Measurable).
Achieved by extending the landed register/disposition/coverage seams and
the single proof-token family (Achievable). It closes the Elite-6
translation-loss class on the existing vocabulary (Relevant). Bounded by
the four CC-IC exit checklists serialized after the CC-GAP-6 seam
(Time-bound).

**This goal explicitly does not promise semantic perfection.** A green
proof certifies mechanical conservation of the counted register — not that
the count was complete, not that a disposition is truthful, not that an
interpretation is faithful. Extraction quality remains the Discovery
assessor's boundary, disposition truthfulness remains the reviewer network's
boundary, and the archaeologist remains advisory. This is the ADR-084
honest proof boundary applied to idea authority.

## Consequences

Positive:

- the four Elite-6 loss shapes (uncounted unknowns, unowned synthesis,
  unquantified adjectives, unbound mechanics) each become a typed red on
  one vocabulary;
- unknowns stop being opaque strings and become owned obligations with
  unblock criteria;
- synthesis and smoke obligations arrive deterministically from a frozen
  lifecycle classification — no prose rereading, no engine inference;
- the archaeologist gives a second reading without any authority;
- the single proof-token family keeps set-equality accounting intact.

Negative:

- register schema v2 churn on a live seam, serialized behind CC-GAP-6;
- more semantics per register entry raises extraction burden on Discovery;
- five more blocking mutations owed in the CC-IC set;
- open-question friction: deferring is cheap but never free.

Neutral / follow-ups:

- deferral/waiver discipline follows ADR-088/089 typed-waiver rules;
- reason-code and token vocabulary above is the contract vocabulary; exact
  string stability is frozen by the CC-IC blocking proofs when they land;
- the registerless corpus keeps exactly the current behavior throughout.

## Decision Journal

**Date:** 2026-08-22.

**Decision:** conserve idea authority by extending the single versioned
Order Constraint Register vocabulary (source classes
execution/material/human/open-question; typed measurability; lifecycle
synthesis semantics) at Discovery settlement, one digest/ref and one
disposition network, coverage through the existing ADR-088 relay and
reverse diff, RULE artifacts as the mechanics-spec carrier with typed
binding, deterministic runnable-local synthesis/smoke injection, an
advisory-only LM archaeologist, and proof tokens compiled into the single
ADR-084 AcceptanceObligationContract — implemented as the bounded,
serialized CC-IC-1..4 packets after the CC-GAP-6 seam lands.

**Ex-ante expectations — IF this decision was right, I expect:**

- At CC-IC-1 landing: a registerless corpus and a v1-register corpus stay
  green in CI; every proposal unknown appears as an open-question register
  entry or settlement is red; a runnable-local declaration carries the
  injected synthesis/smoke entries or settlement is red.
- At CC-IC-2 landing: an undisposed open-question entry fails the
  disposition gate with per-ID guidance; a deferral without owner or
  unblock criterion is red.
- At CC-IC-3 landing: removing a RULE binding from a mechanics-bearing
  constraint turns the coverage diff red.
- At CC-IC-4 landing: the five tokens are set-equal with installed
  protections, their mutants are killed, an archaeologist report cannot
  alter the register/digest/relay/gates, and the blocking group includes
  them.
- Within 90 days of CC-IC exit: a recurrence of the Elite-6 unknown-loss
  shape (an uncounted unknown reaching terminal) is mechanically red in a
  regression proof.

**Check trigger:** CC-IC packet exits, or any later proposal to create a
parallel scope-clause/unknown ledger, a new mechanics-spec product family,
a gating archaeologist, or a second obligation registry.

**What would change my mind:** evidence that the register vocabulary
cannot express a material class of conservation obligations without
duplicating validator implementation (then extend the vocabulary by
version, still one register); or an operator directive that order unknowns
are advisory rather than binding.

## References

- `.research/IDEA-TRACEABILITY-POSTMORTEM.md` — the A–G proposal this
  decision corrects (evidence copy, unchanged)
- `docs/factory-run/conformance-closure/CC-00B-ELITE6-TERMINAL-INTEGRITY.md`
- `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
- `docs/architecture/AC-DRIFT-REMEDY-DESIGN.md` — the three-network design
  and the A1 empirical correction
- `docs/architecture/decisions/084-causal-conformance-proof-kernel.md`
- `docs/architecture/decisions/088-register-conditional-synthesis-coverage.md`
- `docs/architecture/decisions/089-bounded-in-check-substrate-retry-then-typed-unknown.md`
- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` — §3.2, §4.3, §5, §7A (CC-IC-1..4),
  CC-10B, CC-80, CC-81, §13
- `docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md` — §3, §8
- `src/shared/constraint-register.ts` — the register vocabulary
- `src/modules/discovery/domain/discovery-domain-contracts.ts` —
  `DiscoveryProposalPayload.unknowns` (opaque `string[]` today)
- `src/process-modules/lifecycles/product-build-lifecycle.ts` — the frozen
  `runnable-local` terminal classification
- `tests/factory-proof/obligation-contracts.mjs` — the single
  AcceptanceObligationContract family the CC-IC tokens join
