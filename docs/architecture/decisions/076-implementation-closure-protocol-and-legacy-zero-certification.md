# ADR-076: Implementation closure protocol and legacy-zero certification

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** the implicit assumption that an Accepted ADR is implemented
- **Program:** Saga Core Renewal, release K0 (see
  `docs/vision/SAGA-CORE-RENEWAL-PLAN.md`)

---

## Context

The decisions directory holds 50 ADR files (024, 025, 028–075). Their
`Status:` headers describe the *decision* lifecycle (Proposed / Accepted),
not the *implementation* lifecycle. ADR-053 has been Accepted since
2026-08-10, yet the conformance audits of 2026-08-16 record its cutover as
incomplete: epic-scoped accepted reads, a newest-wins replay binder, and
resume compatibility without implementation digests are all still present.

The recurring failure mode is strangler migration without strangulation:
new structures are added and tested, while the old source of truth remains
callable. Nothing in the repository can answer, for a given ADR, "which
release owns finishing this, and what evidence will count as proof".

## Decision

### 1. Decision status and implementation status are separate axes

`Status:` inside an ADR file records the decision lifecycle. The
**implementation closure state** is recorded only in the machine-checkable
registry (`docs/architecture/adr-closure-registry.json`) and takes exactly
one value per ADR:

| State | Meaning |
|---|---|
| `unassessed` | Decision exists; implementation evidence not yet reconciled. |
| `planned` | Owning K-release and required evidence are assigned. |
| `in-progress` | The closure commit train has started; the closure gate is not yet satisfied. |
| `implemented` | Code is present, but migration, ratchet, or full proof remains incomplete. |
| `closed` | Code, migration, tests, negative ratchet, docs, and exact-SHA review all pass. |
| `superseded` | A verified successor decision replaces this ADR; historical rationale remains. |
| `rejected` | Intentionally not implemented; rationale and replacement path are explicit. |

**Accepted is not Implemented is not Closed.**

### 2. Closure theorem

> An ADR is `closed` only when the system would fail a deterministic test
> or architecture ratchet if the prohibited old behavior were reintroduced.

Prose alignment, a landed feature, or the absence of observed failures are
evidence, but never sufficient closure evidence.

### 3. Required closure evidence

A `closed` entry must reference:

1. The exact decision file (plus any amendment or successor).
2. The implementation commit or bounded commit train.
3. A positive unit or property test for the required behavior.
4. A negative test or architecture ratchet for the prohibited legacy behavior.
5. Replay / temporal / migration / fault tests when the decision affects
   durability.
6. Clean-install schema proof and upgrade proof when persistence changes.
7. Public API and operator documentation proof when the surface changes.
8. Independent reviewer verdicts appropriate to the risk tier, all recorded
   against the same SHA.

### 4. Registry rules

- Every numbered ADR file in `docs/architecture/decisions/` has exactly one
  registry entry; every entry points to an existing file. No duplicates, no
  orphans.
- Every ADR whose file status is Accepted must carry a non-empty
  `owningReleases` list and an `evidenceOwner` (the release whose exit gate
  produces the principal proof), or be `superseded`/`rejected`.
- `superseded` requires a `successor` that exists in the registry; a
  superseded ADR cannot disappear from the ledger. Successor chains must
  terminate (no cycles).
- `rejected` requires an explicit rationale.
- The registry records the program evidence baseline (exact commit SHA) it
  was reconciled against.

### 5. Legacy-zero certification rules

The terminal objective of the program is measurable, not aspirational:

- No execution-scoped field participates in material identity or
  accepted-material selection.
- No epic-scoped or latest-row query is reachable from an authority read path.
- No logical handler ID can establish resume compatibility without its
  implementation digest.
- No accepted state can be written outside the single AuthorityCommit service.
- No LM, flow, node, dispatcher, effect, or presentation adapter can publish
  accepted material directly.
- No runtime feature flag, compatibility reader, dual writer, or dual store
  preserves the old authority model.
- No clean-install schema contains legacy authority tables or columns.
- No public API exports deprecated authority types or aliases.
- Historical upgrade code lives in an offline migration tool, not imported by
  the runtime.

A legacy path is **removed** only when production code, schema, public API,
tests, scripts, and operational documentation no longer contain a callable
version of it. Unused, hidden behind a flag, deprecated, or excluded by
convention does not count as removed.

### 6. Enforcement

- `tools/adr-closure-registry.mjs` validates the registry against the
  decisions directory and exits non-zero on any rule violation.
- `tests/architecture/adr-closure-registry.test.mjs` runs the validator
  against the real repository state, so an unowned Accepted ADR or an
  incomplete registry fails the architecture suite.

## Consequences

- Every ADR now has one current closure state, one owning release, and a
  named proof obligation. Ambiguity about "is ADR-N done" becomes a query,
  not an audit.
- Closing an ADR requires writing the negative ratchet, which is precisely
  the artifact that prevents strangler regressions.
- The registry becomes the input to K20 legacy-free certification: GA
  requires every entry in a terminal state with exact evidence.
