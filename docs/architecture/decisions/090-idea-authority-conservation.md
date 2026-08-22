# ADR-090: Idea authority conservation — one register vocabulary, deterministic synthesis injection, advisory archaeologist

- **Status:** Accepted
- **Date:** 2026-08-22
- **Builds on:** ADR-052, ADR-053, ADR-084, ADR-088, ADR-089
- **Corrects:** the proposed A–G package and root-cause framing of the
  external Elite-6 idea-traceability post-mortem (produced in the Elite-6
  product repository; deliberately NOT copied into this repository and
  never cited as repository evidence — the A–G proposal is recorded in
  substance in the Context and reconciliation table below, and the durable
  in-repo evidence is the CC-00B/CC-00C records plus production
  source/tests) — the proposal's parallel scope-clause ledger, parallel
  unknown ledger, new mechanics-spec product family, gating archaeologist,
  and new conformance-obligation family are all rejected
- **Implementation plan:** `docs/plans/CONFORMANCE-CLOSURE-PLAN.md`
  (§7A, packets CC-IC-1..4, serialized after the CC-GAP-6 seam, which
  landed in integration at commit `50824c6a`; the v1 read-back verifier
  source repair is landed there with round-trip and digest-tamper tests —
  the id-reorder and snake_case-at-verify reds remain explicit CC-IC-1
  base-verification work; the proof-subset landing `3be7393d` already
  corrected the acceptance-contract token direction (v2.1.0
  uncovered-residue form) and the SRS §D2↔AC residues — verify-only for
  CC-IC-4, which adds only the SRS register-coverage residue constraint,
  never a bare member/of flip; the CC-IC v2 vocabulary work remains open —
  CC-IC is a mandatory overall qualification dependency — CC-10B, CC-80,
  and overall K qualification stay RED until CC-IC is implemented and
  proven, while the frozen CC-00C scope stays CC-GAP-6..10)

## Context

An external Elite-6 idea-traceability post-mortem (written in the Elite-6
product repository; deliberately not a repository artifact here — the
durable in-repo adjudication of the same run is CC-00B/CC-00C) reports that
an Elite-style browser game order lost, between Discovery and
Formalization: the dynamic pricing algorithm, arcade dynamics, the ordered
browser smoke test, and an assembled-runnable-whole integration criterion.
It proposes a seven-part
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
2. **The defect is under-typed ownership/binding/anchors/oracle — NOT an
   absent normative AC.** AC-22 DID exist in the formalized
   acceptance-criteria set and explicitly required install -> start -> an
   accessible running game (CC-00C fact F2), and the PRD/SRS retained the
   browser/canvas smoke (FR-9 and neighbors). What was under-typed around
   that existing criterion: whole-product synthesis ownership (AC-22 was
   only nominally attached to an item whose scopes and semantics cannot
   own synthesis — CC-00C fact F3), task binding (no mechanical inherited
   criterion existed for planning admission to fail on — CC-00C I1),
   anchors (no mechanical entrypoint/anchor ownership typing — CC-GAP-6),
   and the end-to-end oracle (a served oracle proving only start + loopback
   HTTP + stop — CC-00C fact F9, CC-GAP-7). The defect is under-typed
   conservation enforcement around an existing normative AC, not content
   dropped in transit and not a missing criterion.
3. **Unknowns are opaque and unconsumed.**
    `DiscoveryProposalPayload.unknowns` is `string[]`
    (`src/modules/discovery/domain/discovery-domain-contracts.ts`), carried
    through normalization aliases and then never consumed by any gate: no
    identity, no owner, no unblock criterion, no disposition. The pricing
    algorithm unknown died exactly there — uncounted, not dropped. Sixth
    pass: the Elite-6 dynamic-pricing loss is recorded as BOTH
    idea-conservation AND product behavior evidence — the exact pricing
    algorithm was genuinely UNKNOWN at Discovery (a real proposal unknown),
    and the shipped frozen Elite-6 product carried `basePrice` constants
    with argument-level tests that did NOT prove per-system pricing
    variation, so the latent defect reached product behavior. No new
    runtime token is created for it: it is covered by this decision's
    open-question and mechanics obligations
    (`formalization.unknowns-owned`,
    `formalization.mechanics-spec-required`); the frozen Elite-6 product
    is not rewritten, and its remediation path is a new change request or
    continuation.
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
settlement (the closed source-class vocabulary `execution|material|human`
is preserved UNCHANGED; a new orthogonal per-entry `kind` vocabulary
`scope|open-question|mechanics|synthesis|ordered-smoke|quality` is added;
measurability semantics bind only qualitative/experience obligations;
lifecycle synthesis semantics), keep one digest/ref, extend the one
disposition network, keep
the existing `coveredConstraintIds` relay and SRS §D2/§2.2 reverse diff as
the only coverage mechanism, use existing RULE artifacts as the
mechanics-spec carrier with typed binding, make `runnable-local` a frozen
lifecycle classification that deterministically injects whole-product
synthesis plus ordered smoke obligations, keep the LM archaeologist
 strictly advisory, and compile FOUR new proof tokens into the single
 ADR-084 `AcceptanceObligationContract` family while realizing
 epic-clause coverage by correcting the direction of the existing
 `frm.submission.acceptance-contract` (and the analogous
 `frm.submission.srs-contract`) tokens. Implementation is four
  bounded serialized packets (CC-IC-1..4) that start after the CC-GAP-6
  seam (landed in integration at commit `50824c6a`), with CC-IC-1 opening
  through a prerequisite v1 read-back
  verifier repair stage (satisfied by that same landing — CC-IC-1
  verifies the repair at its base, never re-implements it).

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
- the register carries more semantics per entry (kind, measurability on
  qualitative/experience entries, synthesis) — extraction quality remains
  a Discovery-assessor boundary;
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
    (typed, non-empty reason; trusted-operator-attributed waiver channel
    only). Every new-v2 waiver requires trusted operator attribution — an
    author or model may at most PROPOSE one, and ANY author-attributed
    waiver is a typed red (a single entry or all open questions in one
    act alike; no undefined mass-waiver concept is needed — an attempted
    mass author waiver is simply that red repeated per entry).
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
   not a verdict — and it is not even automatically produced: it exists
   only when the operator commissions an advisory producer with a
   recorded owner, so no unowned automatic pass is promised. Promotion
   produces a new register revision/digest through
   the normal settlement path and then flows through the same mechanical
   networks — the conservation theorem never depends on the archaeologist
   being right or even existing.
3. **"The open-question kind turns every uncertainty into bureaucracy."**
   The Elite-6 defect was precisely that uncertainty was free and
   invisible. The cheap path remains available — a typed deferral with
   reason, owner, and unblock criterion — but it is counted, owned, and
   unblocked-or-waived explicitly (waivers require trusted operator
   attribution; any author-attributed waiver, single or en masse, is
   red — no undefined mass-waiver concept exists).
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
   The closed source-class vocabulary is PRESERVED unchanged
   (`execution|material|human` — WHAT the order demands); `open-question`
   is NOT a class and the class vocabulary is not overloaded. v2 adds an
   orthogonal per-entry `kind` vocabulary —
   `scope|open-question|mechanics|synthesis|ordered-smoke|quality` — and
   unknowns are drafted as kind `open-question` entries. The worker-facing
   carrier/validator is the Discovery submission boundary
   (`src/modules/discovery/domain/discovery-proposal.ts`,
   `validateDiscoveryProposal`, where every other draft field is already
   checked fail-closed): a draft row carrying a `kind` MUST carry one of
   the six closed values — anything else is a typed submission error, and
   the register builder (`src/shared/constraint-register.ts`) repeats the
   check fail-closed. A kind-less v1-shaped draft row under a NEW v2
   settlement is defaulted deterministically to kind `scope` (the ordinary
   reading of an order clause; kernel-side assignment, no guessing, no
   prose rereading) — the specialization kinds are always explicit
   declarations or kernel drafts (open-question from payload `unknowns`,
   synthesis/ordered-smoke from the declared injection table). The
   legacy boundary: frozen legacy v1 drafts and registers carry no `kind`
   at all, verify unchanged under the v1 schema, and the absence of
   `kind` on v1 data is not a defect; the deterministic default applies
   only to new v2 settlements. No parallel
   scope-clause ledger and no parallel unknown ledger may be created;
   every conservation rule rides this register.
2. **One digest/ref, honest revisions.** The register keeps exactly one
    content-addressed digest/ref. The v2 typed fields are entry content, so
    adding measurability/synthesis semantics to an entry produces a new
    digest — a new register revision, never an in-place mutation. v1
    registers verify unchanged under their schema version — the
    prerequisite read-back repair recorded in the implementation plan
    (CC-IC-1 prerequisite stage, mutation m0) is LANDED IN SOURCE by the
    integrated CC-GAP-6 landing (commit `50824c6a`): the recorded
    production defect (the pre-repair `verifyOrderConstraintRegister` in
    `src/shared/constraint-register.ts` fed persisted canonical camelCase
    entries (`evidenceRef`) into `buildOrderConstraintRegister`, which
    validates the worker-facing snake_case draft shape (`evidence_ref`), so
    verifying any genuine persisted v1 register threw
    `ORDER_CONSTRAINT_EVIDENCE_REF_REQUIRED`; it was dead code with no
    test) is closed in source — the verifier now validates the canonical
    camelCase entry shape directly. TEST TRUTH at `50824c6a` (sixth-pass
    verification): `tests/discovery/order-constraint-register.test.mjs`
    proves build -> verify round-trip identity and digest tamper
    (`ORDER_CONSTRAINT_REGISTER_DIGEST_MISMATCH`); the id-reorder red
    (`ORDER_CONSTRAINT_REGISTER_ID_MISMATCH`, already thrown by the
    repaired source) and the snake_case-draft-at-verify typed rejection
    are NOT yet tested and remain EXPLICIT CC-IC-1 base-verification
    work at that host. CC-IC-1 VERIFIES the source repair at its base and
    CLOSES that residual verification obligation (adding the two missing
    test cases — never re-implementing the verifier) — v2 read-back
    builds on the repaired v1 verifier.
3. **Typed measurability — qualitative/experience obligations only.**
   Measurability semantics bind ONLY qualitative/experience obligations
   (kind `quality`): each such entry carries either a measurable
   interpretation (a numeric/observable interpretation reference) or an
   explicit typed deferral with a reason. A qualitative/experience entry
   with neither is a typed red — never a silent adjective. Entries that
   are not qualitative/experience obligations carry no measurability
   requirement; the obligation is not applied to every entry.
4. **Runnable-local is a frozen lifecycle classification with
   deterministic, declared injection.** When the lifecycle classification is
   `runnable-local` (the product-build terminal), Discovery settlement
   deterministically injects the whole-product-synthesis obligation and the
   ordered-smoke obligation as register entries. The injection rides a
   DECLARED, DIGEST-PINNED injection table — an immutable, versioned,
   content-addressed data declaration mapping the frozen classification to
   the exact injected entry payloads, cited by digest from the settlement
     record — OWNED by
     `src/process-modules/lifecycles/product-build-lifecycle.ts` (declared
     beside the frozen `runnable-local` terminal classification that file
     owns; the lifecycle that freezes the classification owns its injection
     declaration — data, not engine inference) and consumed READ-ONLY by
     Discovery settlement
     (`src/modules/discovery/application/discovery-production-cell-installation.ts`,
     which cites the table digest in the settlement record). The
     lifecycle-classification WIRING PATH is explicit (sixth pass): the
     classification reaches Discovery settlement ONLY through the pinned
     per-run read — `ctx.processRunId` → join
     `factory_stage_runs.process_run_id` → `lifecycle_run_id` → read the
     pinned `factory_lifecycle_runs` `definition_snapshot` +
     `definition_hash` through a typed `readDefinitionByProcessRun`
     port/repository implemented in
     `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts`,
     injected through `src/app/product-lifecycle-runtime.ts` /
     `src/app/composition-root.ts`. The ambient
     `options.lifecycleDefinition ?? productBuildLifecycle` default is NOT
     the normative wiring and is never a substitute for the pinned read.
     Discovery settlement consumes the pinned classification +
     `definitionHash` read-only; a missing row fails closed with a typed
     error — never a default `lifecycleDefinition`, never an ambient
     fallback; Discovery imports no lifecycle internals (no lifecycle
     module import: the classification arrives only through the injected
     pinned read, and no settlement code re-derives it); the dedicated
     test host `tests/discovery/d7-settlement-lifecycle-classification.test.mjs`
     proves the wiring. The injection carries a
     NORMATIVE INTERLEAVE ORDER: proposal-derived entries
    occupy `ord-c-001..NNN` in payload order and injected entries are
   appended AFTER them in the declared table order (synthesis, then
   ordered-smoke), never interleaved among proposal-derived rows, so
   proposal-derived positional ids stay stable across injection-table
   revisions and any reordering is a digest change (an honest revision).
   The engine never infers obligations by rereading order or SRS prose;
   browser/canvas/any frontend specifics arrive only through
   workshop-declared data (Conveyor Mental Model §3; master plan §4).
5. **Open questions are obligations with owners.** Settlement drafts
   kind `open-question` entries 1:1 and positionally from the proposal
    `unknowns` (kernel-side, no guessing, no LM). Every open-question entry
    must reach, through the existing disposition network, either `resolved`
    (with evidence) or `deferred` (with non-empty reason, owner, and
    unblock criterion) or `waived` — every waiver on a new-v2 entry
    requires TRUSTED OPERATOR ATTRIBUTION (a recorded operator identity on
    the per-entry waiver; an author or model may at most propose one), and
    ANY author-attributed waiver — a single entry or many entries in one
    act — is a typed red; no separate "mass waiver" category is defined
    beside the per-entry rule (an attempted multi-entry author waiver is
    simply a set of red per-entry waivers). Undisposed open questions are a
    typed red
   (`FORMALIZATION_CONSTRAINT_UNDISPOSED` per-ID guidance), never opaque
   strings. Dispositions are DIGEST-PINNED to the register they were
   authored against: the disposition freeze carries the `registerDigest` it
   disposes, and a disposition set authored against one register digest
   applied to another is a typed red — positional `ord-c-NNN` dispositions
   are never reusable across register revisions (today
   `constraint_dispositions` is keyed positionally with no register-digest
   binding; closing that gap is CC-IC-2, mutation m2d). And the arithmetic
    stays honest: `resolved` and `deferred` are disposition STATES, not
    coverage discharges — only the trusted-operator-attributed typed
    waiver subtracts an entry from the required set, so a resolved or
    deferred open-question entry REMAINS in (register minus typed waivers
    ⊆ covered) until it is covered or waived by the operator; resolution
    and deferral never become silent waivers.
 6. **Coverage stays the ADR-088 mechanism.** v2 entries join the same
    kernel-derived `coveredConstraintIds` relay and the same SRS §D2 and
    §2.2 reverse diff (register ids minus union of covered ids minus typed
    waivers = empty set). The production requirement direction is
    (register ids minus typed waivers) ⊆ covered — NEVER the converse;
    surplus covered ids are not a conservation failure. Production
    defects recorded against the single proof-token family, with their
    sixth-pass status — TWO of the three already repaired by the landed
    proof-subset commit `3be7393d` (verify-only; never redone), ONE
     remaining for CC-IC-4: (a) the existing
    `frm.submission.acceptance-contract` token in
    `tests/factory-proof/obligation-contracts.mjs` FORMERLY encoded the
    INVERSE subset (`coveredConstraintIds` ⊆ `registerIds-minus-waived`)
    — REPAIRED at `3be7393d` (v2.1.0): the constraint is now the landed
    uncovered-residue form
    (`{ kind: 'subset', member: 'uncoveredConstraintResidue', of:
    'empty' }`), with the inert member binding dropped from the grammar
    constraint, an honest T7 adapter (residue mutants die with
    `FORMALIZATION_CONSTRAINT_UNCOVERED`), and the S4 self-mutation
    proving a future second epic-trace token over the same protection
    fails closed (`PROTECTION_OWNER_AMBIGUOUS`) — verify-only for CC-IC-4;
    (b) the SRS §D2↔AC residues of `frm.submission.srs-contract` — the
    token formerly declared only the foreign half (`d2Stanzas` ⊆
    `frozenAcCodes`); REPAIRED at `3be7393d` (v2.1.0) as two residue
    constraints (`unrepresentedFrozenAcResidue` ⊆ empty and
    `foreignD2AcResidue` ⊆ empty) with a real-validator kill matrix
    (4/4 KILLED_TYPED) — verify-only for CC-IC-4; and (c) the REMAINING
    srs-contract register-coverage residue: the landed token still
    declares no constraint for the register dimension, while the
    production validator `srs-contract-validator.ts` enforces the
    production direction (register minus waived ⊆ union of §D2
    `covered_constraint_ids`) — CC-IC-4 adds this one residue constraint
    in the LANDED residue algebra (an `uncoveredRegisterResidue`-style
    member with `of: 'empty'`). PRESCRIPTION BAN (normative, from the
    landed repair): never prescribe or apply a bare member/of flip for
    this defect class — the residue form keeps the mutated member on the
    worker-authored side; a bare flip would only swap which side a
    mutant rewrites (and for the SRS token would mutate the frozen
    baseline, the authority side a worker cannot author). The new
    conservation tokens must encode the production direction above, and
    the remaining correction's acceptance is mutation-killable through
    the real validator, never a blind operand flip. Injected
    synthesis/smoke obligations are
    enforced by the same planning-admission fail-close and
    entrypoint-ownership conjunction; a nominal attachment remains
    non-coverage.
7. **RULE artifacts are the mechanics-spec carrier.** A mechanics-bearing
   entry is CREATED at Discovery settlement as kind `mechanics` with NO
   `mechanicsRef` — the RULE artifact does not exist yet at that point,
   and an impossible at-Discovery `mechanicsRef` must never be required.
   The typed binding is established later, at disposition/binding time,
   referencing the ACCEPTED RULE artifact through the existing
   `implements_spec`/`verified_by` trace vocabulary; covering such
   an entry requires the referenced RULE artifact to be accepted and
   trace-bound within the current lifecycle, and the binding's absence at
   coverage time is the typed red. No new mechanics-spec product
   family is created.
 8. **One proof-token family — FOUR new tokens plus landed-and-extended
    existing tokens.** The conservation obligations compile as follows:
    epic-clause coverage (post-mortem item A) is realized by the EXISTING
    `frm.submission.acceptance-contract` token — after the LANDED
    `3be7393d` v2.1.0 repair it carries the register-coverage constraint
    in the uncovered-residue form over the protection
    `factory.submission-validator.formalization.acceptance-contract.v1`,
    so that landed repair IS the epic-trace obligation correction
    (verify-only for CC-IC-4); no fifth
    token is compiled for it, because a second obligation over an
    already-claimed protection key throws `PROTECTION_OWNER_AMBIGUOUS` at
    set-equality (`tests/factory-proof/installed-protection-reader.mjs`,
    proven as a self-mutation by `3be7393d` itself)
   and a second parallel protection for the same enforced property
   violates the no-parallel-vocabulary rule. The four NEW tokens are
   `formalization.unknowns-owned`, `formalization.mechanics-spec-required`,
   `formalization.integration-ac-for-runnable-lifecycle`, and
   `formalization.qualitative-quantified`, compiled into the single ADR-084
   `AcceptanceObligationContract` family
    (`tests/factory-proof/obligation-contracts.mjs`) with mutants from the
    existing mutation algebra; the srs-contract §D2↔AC residues are
    already repaired by `3be7393d` (verify-only), and the ONE remaining
    srs-contract register-coverage residue constraint is added in the same
    CC-IC-4 landing, in the landed residue algebra. No second
    obligation registry.
 9. **The LM archaeologist is advisory only, with an explicit producer
    truth.** Its reports are evidence for
    promotion decisions and may be stored as ordinary artifacts, but they
    never gate, never mutate the register, and never write authority.
    PRODUCER TRUTH (sixth pass): a report exists ONLY when the operator
    explicitly commissions an advisory producer run for a specific
    proposal/register digest — an operator-commissioned advisory producer
    with a recorded owner (the commissioning record names the producer
    and the digest it may read). There is NO standing or automatic
    producer: settlement never spawns, schedules, or invokes it, the
    absence of a report is never a red, and the presence of a report is
    never a pass. No unowned automatic pass is promised anywhere in this
    decision or the plan. The
    report artifact carrier is an APPEND-ONLY ADVISORY record in
    `src/modules/discovery/domain/discovery-settlement-records.ts`
    (content-addressed, keyed to the exact proposal/register digest it read,
    stored beside the settlement lineage it informs) — an ordinary evidence
    record with no gate, register, relay, or authority consumer. The
    sole promotion path is a new register revision with a new digest through
    Discovery settlement; a blocking mutation proves an archaeologist report
    cannot alter the register, relay, reverse diff, or any gate outcome.
10. **Null-binding grandfathering is frozen-legacy-v1-only; a new v2
    Factory Start never silently builds a null register.** The ADR-088
    sole grandfather condition (a proposal without `order_constraints`
    builds no register: null binding, empty diffs, typed skips, green
    gates) applies ONLY to frozen legacy v1 data — frozen evidence is
    never rewritten. Every NEW Factory Start under the v2 vocabulary
    carries non-null typed authority from Discovery settlement: a built
    register, or — only if the architecture truly permits an
    obligation-free order — an explicit typed no-obligations attestation
    emitted by settlement (a digest-pinned, distinctly-typed attestation,
    never a silent null binding). An absent required register binding on a
     new v2 start is a typed red, never green. The certificate-to-
     Formalization handoff carries exactly ONE register binding: every NEW
     v2 FormalizationCase carries the register binding mapped from the
     discovery certificate payload (which already carries the built
     register), NEVER a rebuild from proposal text/payload as the v2
     source of truth — the deterministic rebuild fallback in
     `resolveFormalizationCaseConstraintRegister` is frozen-legacy-v1-only,
     and a v2 case with a missing binding and no typed no-obligations
     attestation is a typed red at case admission. The verification
     warrant CROSS-BINDS the certificate/case digest it was issued against:
     `VerificationWarrantRef` carries the `discoveryCertificateHash` (and
     case identity) beside the register and dispositions digests, so a
     warrant cannot be silently re-targeted at a different
     certificate/case — register+dispositions self-consistency alone is
     not identity (CC-IC-1 mutations m6b/m7). Continuations inherit the
     original register ref and never re-extract. Any present register
     fails closed on its obligations.
11. **The corrected diagnosis is normative.** The post-mortem's
    transit-loss framing ("four things vanished at the bridge") is
    superseded: the full Discovery payload rides into Formalization, FR-9
    and the SRS retained browser/canvas/smoke, and AC-22 existed as a
    normative acceptance criterion (install -> start -> accessible running
    game) — what was under-typed is whole-product synthesis ownership,
    task binding, anchors, and the end-to-end oracle around that existing
    criterion, plus consumed, owned unknowns. The conservation guarantee
    itself remains conservation of the counted typed set (ADR-084 honest
    boundary): never semantic completeness of free-text extraction, never
    truthfulness of tagging or dispositions. The external post-mortem is
    not a repository artifact and is never cited as evidence; this ADR,
    the plan, CC-00B/CC-00C, and production source/tests carry the
    correction.
 12. **Implementation is bounded and serialized, not a standing program.**
     The program lands as packets CC-IC-1..4
     (`docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7A), serialized after the
     CC-GAP-6 seam (landed in integration at commit `50824c6a`), through
     the single-writer
     `Constraint register and warrant seam` row, with exact files, tests,
     and blocking mutations per packet and an explicit finish condition
     (the CC-IC-1 mutations carry NAMED test hosts and PINNED legacy-green
     fixtures in the plan §7A). CC-IC-1 opened with a PREREQUISITE repair
     stage — the broken v1
     read-back verifier (`verifyOrderConstraintRegister` in
     `src/shared/constraint-register.ts` — persisted camelCase entries
     validated against the snake_case draft shape; dead code, untested when
     recorded) — whose SOURCE repair is LANDED by that integrated CC-GAP-6
     landing (`50824c6a` repairs the verifier; its host
     `tests/discovery/order-constraint-register.test.mjs` proves
     round-trip identity and digest tamper, while the id-reorder and
     snake_case-at-verify reds are NOT yet tested there):
     CC-IC-1 VERIFIES the repaired verifier is present at its base, CLOSES
     the residual id-reorder and snake_case-at-verify verification
     (explicit base-verification work at that host), and must
     not duplicate or re-implement it; the proof-subset commit `3be7393d`
     already landed the acceptance-contract direction repair and the SRS
     §D2↔AC residues (verify-only for CC-IC-4, which adds only the SRS
     register-coverage residue constraint); the v2 vocabulary work
     (mutations m1..m7 and their lettered variants) remains open. It
     is not a vague parallel implementation program and not a permanently
     open architecture cycle. CC-IC is NOT required for CC-00C exit (the
     frozen CC-00C scope stays CC-GAP-6..10), but it IS a mandatory
     overall qualification dependency: until CC-IC is implemented and
     proven, the CC-10B blocking group, the CC-80 qualification command,
     and overall K qualification (CC-81/CC-82) remain RED — the unproven
     CC-IC set is recorded as an open mandatory dependency, never skipped.

### A–G reconciliation (item by item)

| Item | As proposed by the post-mortem | ADR-090 disposition |
|---|---|---|
| A. Epic-as-authority trace gate | new scope-clause coverage gate; residue fails Formalization | Reused, not built: register ids + kernel-derived `coveredConstraintIds` + SRS §D2/§2.2 reverse diff (ADR-088); v2 entries join the same diff — no parallel scope-clause ledger |
| B. Requirements archaeologist | second model; non-empty output triggers repair | Advisory only, operator-commissioned: a report exists only when the operator commissions an advisory producer with a recorded owner; no standing or automatic producer, no gate; promotion produces a new register revision/digest via Discovery settlement; cannot gate or mutate authority |
| C. Unknowns are obligations | every Unknown becomes OPEN with an owner; Formalization blocked until resolved or deferred | `open-question` register KIND (the class vocabulary `execution|material|human` stays unchanged) drafted 1:1 from proposal unknowns; disposition `resolved`, or `deferred` (reason, owner, unblock criterion), or `waived` with trusted operator attribution — any author-attributed waiver, single or en masse, is red (no undefined mass-waiver concept) — on the existing network |
| D. Mechanics/dynamics first-class | new mechanics-spec artifact family | Existing RULE artifacts are the mechanics-spec carrier; the kind `mechanics` entry is created at Discovery with NO ref and the typed `mechanicsRef` binding is established at disposition/binding time against the accepted RULE artifact, trace-bound via `implements_spec`/`verified_by`; no new product family |
| E. Runnable lifecycle auto-requires integration + ordered smoke AC | inferred at Formalization | `runnable-local` frozen lifecycle classification; Discovery settlement deterministically injects whole-product-synthesis + ordered-smoke obligation entries; engine never infers by rereading prose |
| F. Qualitative adjectives quantified | new measurable-translation requirement | Typed measurability on qualitative/experience (kind `quality`) entries ONLY: measurable interpretation or typed deferral with reason; other entries carry no measurability requirement |
| G. Five conformance obligations | new obligation family | FOUR new proof tokens in the single ADR-084 `AcceptanceObligationContract` (unknowns-owned, mechanics-spec-required, integration-ac-for-runnable-lifecycle, qualitative-quantified); the fifth (epic-clause coverage) rides the EXISTING tokens — the acceptance-contract direction repair and the SRS §D2↔AC residues are LANDED at `3be7393d` (v2.1.0 uncovered-residue algebra; verify-only), and CC-IC-4 adds only the srs-contract register-coverage residue constraint — rather than compiling a fifth token over an already-claimed protection key (`PROTECTION_OWNER_AMBIGUOUS`, self-mutation-proven by `3be7393d`); never a bare member/of flip; existing mutation algebra; blocking via existing CC-10B/CC-80 floors |

## SMART goal and honest boundary

**Objective (SMART).** By CC-IC exit, for every new Factory Start under
the v2 vocabulary (each such start carries non-null typed authority — a
built register, or an explicit typed no-obligations attestation if the
architecture truly permits an obligation-free order; never a silent
null), each of five blocking mutations
turns the blocking group red when reversed — (m1) a proposal unknown absent
from the register's open-question entries; (m2) an open-question entry
without a resolved-or-deferred disposition (reason, owner, unblock
criterion) or a trusted-operator-attributed waiver (any author-attributed
waiver is itself red); (m3) a mechanics-bearing constraint whose RULE
binding is removed or
untrace-bound; (m4) a runnable-local lifecycle
classification without the injected whole-product-synthesis and
ordered-smoke obligations; (m5) a qualitative/experience entry without a
measurable interpretation or typed deferral — and a frozen legacy
registerless (v1) corpus stays green (Specific). Measured solely by the
compiled obligation-contract mutants and the blocking acceptance group,
never by prose (Measurable).
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
- a multi-family blocking-mutation set owed in the CC-IC packets (the
  m1..m7 mutation families with lettered variants across CC-IC-1..3, plus
  the CC-IC-4 token and archaeologist mutants; the m0 read-back
  prerequisite source repair is already landed by the integrated CC-GAP-6
  landing, with its residual id-reorder and snake_case-at-verify
  verification owed by CC-IC-1 — see Decision 2);
- open-question friction: deferring is cheap but never free.

Neutral / follow-ups:

- deferral/waiver discipline follows ADR-088/089 typed-waiver rules
  (every new-v2 waiver requires trusted operator attribution; any
  author-attributed waiver — single or en masse — is red, and no
  undefined mass-waiver concept exists);
- reason-code and token vocabulary above is the contract vocabulary; exact
  string stability is frozen by the CC-IC blocking proofs when they land;
- the frozen legacy registerless (v1) corpus keeps exactly the current
  behavior throughout; new v2 starts carry non-null typed authority.

## Decision Journal

**Date:** 2026-08-22.

**Decision:** conserve idea authority by extending the single versioned
Order Constraint Register vocabulary (source classes
execution/material/human UNCHANGED, plus an orthogonal kind vocabulary
scope/open-question/mechanics/synthesis/ordered-smoke/quality; typed
measurability on qualitative/experience entries only; lifecycle
synthesis semantics) at Discovery settlement, one digest/ref and one
disposition network, coverage through the existing ADR-088 relay and
reverse diff (production direction: register minus waived ⊆ covered),
RULE artifacts as the mechanics-spec carrier with typed binding
established at disposition time against the accepted RULE artifact,
deterministic runnable-local synthesis/smoke injection, an
advisory-only LM archaeologist produced solely by an operator-commissioned
advisory producer, and proof tokens compiled into the single
ADR-084 AcceptanceObligationContract — implemented as the bounded,
serialized CC-IC-1..4 packets after the CC-GAP-6 seam (landed in
integration at commit `50824c6a`, which lands the CC-IC-1 read-back
prerequisite m0 in source, with round-trip and digest-tamper tests; the
proof-subset commit `3be7393d` already lands the acceptance-contract and
SRS §D2↔AC residue repairs), with
null-binding grandfathering frozen-legacy-v1-only (new v2 starts carry
non-null typed authority; continuations inherit the original register
ref) and CC-IC a mandatory overall qualification dependency while CC-00C
scope stays frozen.

**Ex-ante expectations — IF this decision was right, I expect:**

- At CC-IC-1 landing: a frozen legacy registerless corpus and a
  v1-register corpus stay green in CI (the pinned legacy-green fixtures
  of plan §7A stay green unchanged), and a genuine persisted v1 register
  round-trips through the repaired read-back verifier (prerequisite m0 —
  source repair landed by the integrated CC-GAP-6 landing `50824c6a`
  with round-trip and digest-tamper tests already green; CC-IC-1
  verifies it holds at its base AND adds the missing id-reorder and
  snake_case-at-verify reds at the same host, never re-implements the
  verifier); every proposal
  unknown appears as
  an open-question register entry or settlement is red; a runnable-local
  declaration carries the injected synthesis/smoke entries or settlement
  is red; a new v2 Factory Start without non-null typed authority (a
  built register or an explicit typed no-obligations attestation) is red;
  a v2 FormalizationCase whose register binding is supplied by the
  proposal-payload rebuild fallback, or that carries no binding and no
  attestation, is red; a warrant re-targeted across certificate/case
  digests is red;
  a continuation that re-extracts a register instead of inheriting the
  original ref is red.
- At CC-IC-2 landing: an undisposed open-question entry fails the
  disposition gate with per-ID guidance; a deferral without owner or
  unblock criterion is red; ANY author-attributed waiver (single or en
  masse) is red; dispositions carried across a registerDigest
  change (positional ord-c reuse) are red.
- At CC-IC-3 landing: removing a RULE binding from a mechanics-bearing
  constraint turns the coverage diff red.
- At CC-IC-4 landing: the four new tokens are set-equal with installed
  protections, their mutants are killed, the landed `3be7393d`
  acceptance-contract and SRS §D2↔AC residue repairs verify green at the
  base (never redone), the added srs-contract register-coverage residue
  constraint kills its residue mutants, an archaeologist report
  cannot alter the register/digest/relay/gates, and the blocking group
  includes them.
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

- The external Elite-6 idea-traceability post-mortem (produced in the
  Elite-6 product repository) — the A–G proposal this decision corrects;
  deliberately not a repository artifact and never cited as evidence: the
  A–G substance is recorded in the Context and reconciliation table here,
  and the durable in-repo adjudication is CC-00B/CC-00C below
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
- `src/shared/constraint-register.ts` — the register vocabulary, and the
  read-back verifier
  (`verifyOrderConstraintRegister`: the recorded camelCase-into-snake_case
  breakage) repaired IN SOURCE by the integrated CC-GAP-6 landing
  (`50824c6a`; round-trip and digest-tamper tests green there; the
  id-reorder and snake_case-at-verify reds are added by CC-IC-1
  base-verification work) — the landed-in-source CC-IC-1 prerequisite
  (m0)
- `src/modules/discovery/domain/discovery-domain-contracts.ts` —
  `DiscoveryProposalPayload.unknowns` (opaque `string[]` today)
- `src/modules/discovery/domain/discovery-proposal.ts` — the worker-facing
  draft carrier/validator (`validateDiscoveryProposal`): where the v2
  `kind` vocabulary is checked fail-closed at the submission boundary
- `src/modules/discovery/domain/discovery-settlement-records.ts` — the
  durable settlement/certificate records; the append-only advisory
  archaeologist report carrier (CC-IC-4)
- `src/modules/discovery/application/discovery-production-cell-installation.ts`
  — settlement builds the register onto the certificate payload (the
  certificate-to-case binding source; the open-question lifting and
  injection-table consumption site)
- `src/modules/formalization/domain/formalization-schemas.ts` —
  `FormalizationConstraintRegisterBinding` and the
  `resolveFormalizationCaseConstraintRegister` rebuild fallback (frozen
  legacy-v1-only under this decision)
- `src/modules/formalization/application/formalization-production-cell-installation.ts`
  — the baseline-payload disposition freeze and `warrantRef` projection
  (the one-source-three-projections site; CC-IC-2 limited ownership)
- `src/modules/formalization/application/formalization-contract-validator.ts`
  — `constraint_dispositions` keyed positionally by `ord-c-NNN` with no
  register-digest binding today (the m2d gap)
- `src/modules/formalization/application/srs-contract-validator.ts` — the
  production-direction §D2 register coverage that the landed v2.1.0
  `frm.submission.srs-contract` token still under-represents (the one
  remaining register-coverage residue constraint, owed by CC-IC-4)
- `src/modules/development/domain/development-schemas.ts` —
  `VerificationWarrantRef` (gains the certificate/case cross-bind)
- `src/process-modules/lifecycles/product-build-lifecycle.ts` — the frozen
  `runnable-local` terminal classification; owner of the declared
  digest-pinned injection table (CC-IC-1); the classification reaches
  settlement ONLY through the pinned per-run read, whose grounded owner
  list is explicit (seventh pass): the repository file
  `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts`
  (owner of the typed `readDefinitionByProcessRun` join/read — nothing
  else in this wiring may change there) plus the composition files
  `src/app/composition-root.ts` → `src/app/product-lifecycle-runtime.ts`
  (owners of the DI/composition of that ONE typed port — CC-IC-1 edits
  all three LIMITED to exactly that wiring, through the single-writer
  `Constraint register and warrant seam` row of the plan §4.3, so no
  other packet may concurrently edit them)
- `tests/factory-proof/obligation-contracts.mjs` — the single
  AcceptanceObligationContract family the CC-IC tokens join; the formerly
  inverted `frm.submission.acceptance-contract` subset constraint and the
  SRS §D2↔AC direction defects are REPAIRED at `3be7393d` (v2.1.0
  uncovered-residue algebra; verify-only for CC-IC-4), leaving only the
  srs-contract register-coverage residue constraint to add — never a
  bare member/of flip
- `tests/factory-proof/installed-protection-reader.mjs` —
  `assertProtectionSetEquality` and `PROTECTION_OWNER_AMBIGUOUS` (why a
  fifth token over an already-claimed protection key cannot compile)
