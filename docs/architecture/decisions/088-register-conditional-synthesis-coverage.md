# ADR-088: Register-conditional synthesis coverage — grandfather only the registerless

- **Status:** Accepted
- **Date:** 2026-08-22
- **Builds on:** ADR-052, ADR-053, ADR-084
- **Corrects:** the CC-GAP-6 coverage contract in
  `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` (section 3.2 and the CC-00C
  package) and
  `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
- **Implementation plan:** `docs/plans/CONFORMANCE-CLOSURE-PLAN.md`
  (CC-00C / CC-GAP-6; blocking mutations wired into CC-10B and CC-80)

## Context

The Elite-6 terminal run shipped an ordered browser-product claim through
planning while no item owned whole-product synthesis: AC-22 existed and was
only nominally attached to `impl-galaxy-ship-foundation` (scopes
`package.json` plus `data/domain/tests`). CC-GAP-6 was drafted to close
semantic claim-to-work coverage mechanically on the existing vocabulary —
the versioned Order Constraint Register
(`factory.order-constraint-register.v1`), the `coveredConstraintIds` relay,
and SRS §2.2 module-manifest scope coverage — with a reverse diff
(register ids minus union of covered ids minus typed waivers = empty) as
the exit criterion.

An adversarial review of that draft (2026-08-22) found that its
grandfathering clause re-opened the defect it was written to close. The
draft said: proposals without `order_constraints`, criteria without
`coveredConstraintIds`, and SRS documents without a §2.2 manifest produce
"an empty diff or a typed legacy skip, never a red gate". Three specific
defects follow from that clause:

1. **Grandfathering ignores the register.** The three missing shapes are
   not equivalent. "No register" is a property of the Discovery
   settlement — there is genuinely nothing to cover, and the existing
   null-binding path (`readConstraintCoverageRequirement` returns null;
   the reverse diff returns `[]`) correctly keeps every gate green. "No
   `coveredConstraintIds`" and "no §2.2 manifest" are properties of
   downstream documents that can be missing while a non-empty register
   exists. Grandfathering them unconditionally lets a register-bearing
   corpus dodge the entire exit criterion by omitting a document section.
   Current code evidence: `assessSrsModuleManifestCoverage`
   (`src/modules/development/application/development-check-providers.ts`)
   emits `srs-module-manifest-skip` unconditionally — for an unavailable
   SRS, an absent §2.2 section, or a file-less manifest — without ever
   consulting the register.
2. **A wide decoy item satisfies per-file scope coverage without owning
   the constraint.** The drafted exit criterion ("every §2.2
   manifest-declared file lies inside some frozen item change scope") is
   purely per-file. An item with a deliberately wide scope can contain
   every declared file while covering a different constraint or none.
   For execution-class constraints that declare entrypoint files
   (install -> start), the product can then be assembled by items none of
   which owns the constraint — AC-22's exact shape.
3. **The planner can forge `coveredConstraintIds` today.**
   `DevelopmentTaskGraphProposalItem`
   (`src/modules/development/domain/development-schemas.ts`) omits
   `coveredConstraintIds` and immediately re-admits it
   (`Omit<...> & { coveredConstraintIds?: readonly string[] }`), and
   `canonicalItems` (`development-task-graph.ts`) overrides the field
   only when the inherited union is non-empty. When the referenced frozen
   criteria carry no coverage, a planner-supplied
   `coveredConstraintIds` survives the spread into the frozen item — the
   reverse diff can be forged green by the very actor whose admission it
   must police.

The decision fork is how to bound grandfathering and relay authority so
the exit criterion is mechanical, monotone for genuinely legacy corpora,
and unforgeable.

## Decision drivers

| Driver | Weight | Reason |
|---|---:|---|
| Correctness and fail-closed coverage | 25 | A non-empty register is a mechanical promise; nothing may render it vacuous |
| Evidence honesty | 20 | A green gate must never be forgeable by planner output or by omission |
| Legacy monotonicity | 15 | Registerless corpora stay green; frozen evidence is never rewritten |
| Autonomous execution | 15 | The rule must be mechanically decidable with typed reasons, no human adjudication |
| Implementation scope and reuse | 10 | Extend the register/relay/§2.2 seams; no parallel vocabulary |
| Agent readability | 10 | One grandfather condition and named typed reasons |
| Reversibility | 5 | The contract and its gate wiring revert as one unit |

Scores use 1 as poor and 5 as excellent.

## Considered options

### Option A: Unconditional legacy skip (the drafted clause)

Keep the drafted CC-GAP-6 wording: any of no-register /
no-`coveredConstraintIds` / no-§2.2 yields an empty diff or a typed legacy
skip, never a red gate.

Pros:

- smallest change from the drafted plan text;
- can never break a legacy corpus, whatever it contains;
- no new typed reasons or gate wiring.

Cons:

- grandfathers omission inside register-bearing corpora, re-opening the
  Elite-6 pass shape under a register;
- per-file scope coverage admits wide decoy items;
- planner-forged `coveredConstraintIds` would pass the reverse diff.

### Option B: Register-conditional fail (selected)

Grandfather only the registerless corpus. When a non-empty register
exists, missing coverage and a missing/file-less §2.2 manifest are typed
red. Entrypoint ownership for execution-class constraints is the
conjunction of file ownership and constraint coverage on one item.
`coveredConstraintIds` is strictly kernel-derived; planner output can
neither propose nor forge it.

Pros:

- one grandfather condition matching the existing null-binding semantics;
- the Elite-6 shape becomes mechanically red at planning admission and at
  the task-graph gate;
- the reverse diff becomes non-vacuous (neither omittable nor forgeable);
- reuses the register, the relay, the §2.2 manifest, and typed waivers —
  no parallel vocabulary;
- registerless corpora keep exactly the current green behavior.

Cons:

- register-bearing corpora with manifest-less SRS go red until the
  manifest (or a typed waiver) lands — deliberate friction;
- `assessSrsModuleManifestCoverage` must become register-aware and
  `canonicalItems` must derive unconditionally (behavior change on two
  live seams);
- three additional blocking mutations are owed in the CC-00C set.

### Option C: Formalization-only enforcement

Enforce the whole reverse diff upstream at the Formalization gate
(AC-drift network 2) and leave Development planning with no mechanical
admission criterion — planning inherits only advisory information.

Pros:

- one enforcement point, evaluated where the register is digest-pinned;
- no Development-side gate changes;
- the Formalization seam (`constraintCoverageGapIdList`) already computes
  the exact diff.

Cons:

- the Elite-6 defect was precisely that nothing failed at planning
  admission — upstream-only enforcement recreates that gap;
- §2.2 scope coverage needs frozen item changeScopes, which do not exist
  at Formalization;
- entrypoint ownership is a task-graph fact (item scopes plus inherited
  coverage), unavailable upstream;
- planner forgery of the relay would remain undetected at the seam where
  it is persisted.

## MCDA matrix

| Option | Correctness 25 | Honesty 20 | Monotonicity 15 | Autonomy 15 | Scope 10 | Readability 10 | Reversibility 5 | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A. Unconditional skip | 2 | 2 | 5 | 3 | 5 | 4 | 4 | 320 |
| B. Register-conditional fail | 5 | 5 | 4 | 5 | 4 | 4 | 4 | 460 |
| C. Formalization-only | 3 | 3 | 4 | 3 | 3 | 3 | 3 | 315 |

Option B leads both alternatives by more than ten percent: the decision
is not close. Option A's monotonicity advantage is illusory because the
plan's monotonicity promise binds only corpora without a register
("enforcement binds new registers and never rewrites frozen evidence").

## Pre-mortem on Option B

Assumption: Option B was implemented and failed six months later.

1. A register-bearing workshop shipped SRSes without §2.2 and every gate
   went red, blocking unrelated work. Likelihood: medium. Detection: the
   typed red names the missing manifest and the remediation. Response:
   the red is the honest state — the fix is producing the manifest or a
   typed waiver, never re-adding a skip.
2. Legacy registerless corpora broke. Likelihood: low. Detection: legacy
   corpus gates stay green in CI. Response: the sole grandfather
   condition is the existing null-binding path; no other behavior
   changes for registerless corpora.
3. The kernel-only derivation rejected proposals that harmlessly carried
   the field, generating planner friction and repair loops. Likelihood:
   medium. Response: decode/canonicalization discards planner-supplied
   values mechanically — proposals are trimmed, not failed; the blocking
   mutation proves the forged set cannot reach the frozen item or the
   reverse diff.
4. Entrypoint ownership was gamed by scope shapes that contain files
   without owning them (prefix or wildcard inflation). Likelihood:
   medium. Detection: ownership is the conjunction on one item — the
   decoy must also cover the constraint, and a covering item must also
   own a declared entrypoint file; the mutation proves both halves fail.
5. A non-empty but fully waived register fired contradictory reds.
   Likelihood: low. Detection: typed waivers are subtracted before the
   red decision; a fully waived register is empty for enforcement.

Net effect: the remaining failure modes are honest reds with named
reasons or already-covered conjunctions; no silent-green failure mode
remains.

## Red Team

1. **"This breaks the plan's monotonicity guarantee."** The guarantee is
   for corpora without a register; a corpus with a non-empty register is
   exactly what enforcement binds. Under Option A, a future corpus
   identical to Elite-6 that does build a register can still pass by
   omitting §2.2 or coverage metadata — grandfathering that omission is
   grandfathering the defect. Accepted: this objection is what drew the
   single-grandfather-condition boundary.
2. **"Fail-red on missing §2.2 punishes workshops whose SRS legitimately
   has no module manifest."** Only when a non-empty register exists. A
   registerless workshop keeps the typed skip. When the order counted
   execution constraints, a manifest-less SRS is precisely the missing
   synthesis-ownership evidence.
3. **"Kernel-only derivation could silently drop coverage if frozen
   criteria lose their relay fields."** That drop is exactly what the
   reverse diff detects: register minus union minus waived non-empty
   goes red. The two rules are complements — kernel derivation prevents
   forged green; the reverse diff prevents silent drop.
4. **"The entrypoint rule hardcodes frontend/browser semantics in the
   engine."** Entrypoint files arrive from workshop-declared data —
   register lines and the §2.2 manifest. The engine checks only the
   mechanical conjunction (one item covers the constraint and owns the
   file). No workshop-name, `moduleRef`, or role-profession branch is
   added (LEGO principle; the plan's no-workshop-branch rule).

All four objections are answered inside Option B; objections 1 and 2
shaped the grandfather boundary, 3 and 4 the derivation and ownership
wording.

## Decision

Choose Option B. The CC-GAP-6 coverage contract is normatively:

1. **Sole grandfather condition.** A corpus is grandfathered if and only
   if no constraint register exists (Discovery proposal without
   `order_constraints`; null register binding). Every downstream diff is
   then empty, the typed legacy skip applies, and gates stay green.
   Frozen evidence is never rewritten; enforcement binds gate evaluation,
   not recorded history.
2. **Register-conditional red.** When a non-empty register exists:
   - register ids minus union of kernel-derived `coveredConstraintIds`
     minus typed waivers is non-empty — a typed red
     (`constraint-register-uncovered`), never a skip;
   - an SRS without a §2.2 manifest, with a file-less manifest, or an
     unavailable SRS artifact — a typed red
     (`srs-module-manifest-missing`), never `srs-module-manifest-skip`;
   - per-file manifest gaps stay `srs-module-uncovered`.
3. **Entrypoint ownership.** Every entrypoint file declared by an
   execution-class register entry must lie inside the frozen change
   scopes of at least one task-graph item whose kernel-derived
   `coveredConstraintIds` include that same entry. The test is the
   conjunction on one item: a wide decoy item whose scopes contain the
   file while covering no such constraint does not satisfy it, and a
   covering item owning none of its declared entrypoint files does not
   satisfy it. Violation fails planning admission with a typed reason
   (`constraint-entrypoint-unowned`).
4. **Kernel-only relay authority.** `coveredConstraintIds` on criteria,
   items, cards, and verification evidence is derived by the kernel —
   the union over the referenced frozen criteria (and, upstream, the
   metadata relay at Formalization ingress). The planner proposal shape
   must not re-admit the field; decode/canonicalization must discard any
   planner-supplied value; a blocking mutation must prove a forged
   proposal cannot alter the frozen relay or the reverse diff.

## Consequences

Positive:

- the Elite-6 pass shape (register-bearing order, nominal attachment, no
  synthesis owner) is mechanically red at planning admission and at the
  task-graph gate;
- registerless legacy corpora keep exactly the current behavior
  (monotone);
- `coveredConstraintIds` becomes unforgeable from planner output, making
  the reverse diff non-vacuous;
- no parallel deliverable-claim vocabulary: the same register ids, relay,
  §2.2 manifest, and typed waivers do all the work.

Negative:

- register-bearing corpora with manifest-less SRS go red until the
  manifest or a typed waiver lands — deliberate, named friction;
- three typed reasons and one derivation rule must be proven by blocking
  mutations in the CC-00C set (wired into CC-10B and CC-80);
- `assessSrsModuleManifestCoverage` and `canonicalItems` change behavior
  (register-aware skip; unconditional kernel derivation).

Neutral:

- typed waivers remain the only escape hatch and must carry a non-empty
  reason (existing A1 disposition rule);
- CC-GAP-6 implementation stays serialized through the plan's
  single-writer `Constraint register and warrant seam` row;
- reason-code names above are the contract vocabulary; exact string
  stability is frozen by the CC-GAP-6 blocking proofs when they land.

## Decision Journal

Date: 2026-08-22.

Decision: CC-GAP-6 synthesis coverage is register-conditional — only the
registerless corpus is grandfathered; a non-empty register makes missing
coverage and a missing/file-less §2.2 manifest typed red; execution-class
entrypoint ownership is the per-constraint conjunction of file ownership
and constraint coverage on one item; `coveredConstraintIds` is strictly
kernel-derived and unforgeable from planner output.

Ex-ante expectations:

- At CC-GAP-6 landing, `assessSrsModuleManifestCoverage` consults the
  register before any skip, and `canonicalItems` derives the relay
  unconditionally from frozen criteria.
- At CC-GAP-6 landing, the four blocking mutations (reverse diff;
  manifest-less red; decoy ownership; forged proposal) make the blocking
  group red when reversed.
- At CC-00C exit, no register-bearing corpus can pass planning admission
  with an uncovered non-waived register line, a manifest-less §2.2, an
  unowned execution entrypoint, or a planner-forged relay.
- Registerless corpus gates remain green throughout.

Check trigger: CC-GAP-6 exit, or any later proposal to widen
grandfathering beyond the null register binding.

What would change this decision: evidence that a register-bearing legacy
corpus exists whose frozen evidence would need rewriting to comply (it
must instead be versioned forward, not grandfathered), or an operator
directive that ordered constraints are advisory rather than binding.

## References

- `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` — sections 3.2, CC-00C,
  CC-10B, CC-80, 13
- `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
- `docs/factory-run/conformance-closure/CC-00B-ELITE6-TERMINAL-INTEGRITY.md`
- `docs/architecture/decisions/052-freeze-atomic-acceptance-criteria.md`
- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
- `docs/architecture/decisions/084-causal-conformance-proof-kernel.md`
- `src/shared/constraint-register.ts`
- `src/modules/formalization/application/constraint-coverage.ts`
- `src/modules/formalization/application/formalization-contract-analysis.ts`
- `src/modules/development/application/development-check-providers.ts`
- `src/modules/development/domain/development-task-graph.ts`
- `src/modules/development/domain/development-schemas.ts`
