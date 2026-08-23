# 00 — Factory Map: Shared Contract

- **Status:** hypothesis, authored from the production tree (not from other map documents)
- **Branch:** `map/discovery-formalization-2026-08-23`
- **Scope of this file:** the contract every `docs/factory-map/*.md` stratum document obeys.
- **Prohibited sources:** this document set was authored WITHOUT reading or writing any
  forward-graph or reverse-graph file. Forward and reverse maps are independent work
  products (see §4). No `03_FORWARD*` / `04_REVERSE*` (or equivalently named) file was
  opened, and none is created here.
- **Evidence base:** read-only inspection of `D:\Development\saga-mcp-MAP-DF` at commit
  `586871ad` (HEAD of this branch). No builds, tests, live DB, processes, or network were
  run to produce this map.

---

## 1. What the factory map is

The map is an **auditable, later machine-derived proof surface**. Concretely:

1. **Auditable** — every claim in a map document carries an exact `path:line` citation into
   the repository. A reader with the commit checked out can verify each claim without
   trusting the author. Citations are frozen at authoring time (§7); a later refactor that
   moves lines invalidates the citation, not silently the claim.
2. **Later machine-derived** — the map documents are the human-authored strata hypothesis.
   The eventual graph artifacts (forward and reverse) are expected to be *derived* by
   machines from the same production sources the strata cite, and then *reconciled against*
   these documents. The map does not itself claim to be machine output; it defines the
   target surface machines must reproduce.
3. **Proof surface, not narrative** — the map exists so that proofs (edge proofs, goal
   rootedness, evidence measurement) have a fixed subject: the *production-installed
   surface* (§6). Anything not installed in production is strata, not surface, and is
   segregated into DEAD/DECLARATIVE-ONLY sections (never silently mixed into live cards).

The map is a hypothesis in the sense of GUARDRAILS Signs 008/009 (ADR-005/ADR-007 lesson):
descriptive mapping is never claimed as implemented guarantee. Where a guarantee is only
declared (a placeholder digest, an unregistered provider, a manifest pin without a runtime
consumer), the evidence label says so.

## 2. Edge proof (producer → consumer)

An edge in the map is **not** proven by a raw schema-subset relation between producer
output type and consumer input type. The correct edge proof is:

```text
edge(producer, consumer) is proven  ⇔
  ∃ bridge_e installed in production:
       bridge_e(PostProducer) satisfies PreConsumer
       ∧ bridge_e preserves exact authority/identity/provenance bindings
```

with the three clauses meaning:

1. **`bridge_e(PostProducer) satisfies PreConsumer`** — there exists a concrete, installed
   bridge element (lifecycle output mapping, stage input mapping, output resolver,
   post-acceptance projection, content-hash join) that transforms the producer's accepted
   post-state into values that satisfy the consumer's declared preconditions: schema id,
   cardinality, and value constraints (refs resolve, hashes match, required fields exist).
   A type-level "output schema ⊆ input schema" observation proves nothing.
2. **Preservation of exact authority/identity/provenance bindings** — the bridge selects
   material by exact immutable identity (ProductRef/CandidateSet/certificate ref + content
   digest) and never by recency, "latest", task/execution/node id, or epic accumulation.
   This is the ADR-053 material-authority requirement
   (`docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md:229-233`,
   `docs/architecture/CONVEYOR-MENTAL-MODEL.md:61-63`). An edge that satisfies schemas but re-derives
   identity (e.g., "latest proposal in epic") is a **failed edge proof**, and the failure
   is recorded as a CONTRADICTION in the stratum document.
3. **The bridge must be installed in production composition** — a bridge that exists only
   in a manifest entry, test helper, or dead handler is not a bridge; the edge is
   UNPROVEN and the stratum document must label it so.

Edges in stratum documents are always written in the explicit triple
`producer → bridge_e → consumer` with citations for each of the three elements.

## 3. Semantic model of the mapped system

The mapped system is modeled as an **extended labeled transition system (LTS)**:

- **States** are *durable* database-backed aggregates (ProcessRun, NodeRun, Workplace,
  CandidateSet, GateRun/GateDecision, EffectAttempt, baseline/solution-contract rows), not
  in-memory values.
- **Labels** are typed commands/events (submission, completion, gate decision, effect
  outcome, lifecycle transition), each with guards and an append-only evidence trail
  (the CONVEYOR-TRANSITION-DIAGNOSTICS causal envelope,
  `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md:45-96`).
- **Guards** are the invariants/fences preconditions of a transition (check plans, fences,
  CAS revision checks, entry conditions).
- **Effects** are the post-conditions, including authorized external effects with
  idempotency keys and receipts (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:960-1016`).
- **Bounded abstractions** — where the model abstracts (e.g., "a cell attempt", "a repair
  round"), the abstraction must carry its bound (maxAttempts, totalAttempts cap, review
  budget) so liveness claims remain checkable.

It is **not literally a finite automaton**: state is not a finite enum (it includes
content-addressed material with unbounded digests), transitions are guarded database
transactions, and the same abstract state may materialize unbounded concrete rows (repair
attempts, certificates). Map documents must not describe nodes as "states of an automaton";
they describe desks/nodes as components of this extended LTS. This correction follows
`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1071-1091` (composed state machines table) and the §23
progress-obligation invariant (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1126-1152`).

## 4. Goal roots; supportive nodes; forward/reverse independence

1. **Goal roots** of the graph are not just "product reached the happy terminal". The
   rooted goals are at least:
   - **product success** — the lifecycle's declared terminal produces the intended product
     (e.g., `runnable-local` for product-build);
   - **safety** — no illegal transition, no authority leak, no unproven acceptance
     (fitness-function catalog, `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1317-1401`);
   - **liveness** — every nonterminal scope has a live owner, runnable command, typed
     wait, or pending transition obligation (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1126-1139`);
   - **auditability** — every durable transition has citable evidence/receipts
     (`docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md:34-44`).
2. **Supportive nodes are not discarded** merely because one happy terminal does not
   require them. A readiness cell, reviewer desk, reconciliation desk, or baseline-freeze
   kernel node is retained in the map if ANY goal root needs it (e.g., auditability needs
   the certificate lineage even when the product path alone would not). Graph
   minimization against a single accepting path is a modeling error in this contract.
3. **Forward and reverse maps are independently authored and reconciled later.** The
   forward map (producer → consumer order) and the reverse map (consumer → producer
   obligations) are separate work products owned by separate authors; neither imports the
   other. Reconciliation (comparing both for edge-set equality and binding preservation)
   is a later, explicit phase with its own document. Stratum documents (01, 02, …) feed
   both directions by stating, per desk/node card, both **forward consumers** and
   **backward obligations**.

## 5. Evidence labels

Every factual claim in a map document carries exactly one label from this closed set.
Labels are never merged into a single "covered" bit; a claim may be cited with multiple
INDEPENDENT labels (e.g., declared + CI-executed), but each label must be justified by
its own citation.

| Label | Meaning | Minimal justification |
|---|---|---|
| `declared` | The fact exists as a declaration in source (constant, type, manifest entry, table row schema) | `path:line` of the declaration |
| `file-exists` | The referenced resource/path exists on disk at the cited commit | `path` (existence check) |
| `demonstrated` | The behavior is shown by a committed artifact of a run/test, but no CI-hosted command proves it | artifact `path` (+ scenario id) |
| `matrix-hosted` | The claim is checked by a suite enumerated in `tools/run-acceptance-matrix.mjs:64-163` GROUPS or by the committed scenario-evidence corpus | suite/evidence `path` |
| `CI-executed` | The checking command runs as a blocking step in `.github/workflows/ci.yml` | ci step name + `.github/workflows/ci.yml:line` |

Quarantine is part of the truth: a suite listed in `tools/run-acceptance-matrix.mjs:175+`
QUARANTINE (e.g., FLAKY `tests/factory-contract/golden-path.test.mjs`) is NOT
`CI-executed` evidence, even though the file exists; it may be at most `file-exists` or
`demonstrated`.

## 6. Map equality target

The map's equality target is:

```text
production-installed surface == mapped surface
```

- The **production-installed surface** is the set of flows/cells/handlers/check
  providers/effects/schemas that the production composition root actually registers and
  installs (for this repo: `src/app/product-lifecycle-runtime.ts` +
  `src/modules/<workshop>/index.ts` registration + `installProductionModules` in
  `src/orchestrate-cli.ts:885-897`).
- The **mapped surface** is the set of live cards in the stratum documents (excluding the
  explicitly segregated DEAD/DECLARATIVE-ONLY strata).
- Equality is asserted per workshop in each stratum document's LIVE SURFACE section, with
  citations to the registration call sites.
- **Evidence is measured over this surface only.** Test coverage, gap, and contradiction
  claims are evaluated against the live cards; dead strata get their evidence measured
  separately (usually it will be `declared`/`file-exists` only).

## 7. The one fixed desk/node card schema

Every live production node and every cognitive desk gets exactly one card, with exactly
these fields, in exactly this order. Fields are mandatory; if a field is empty for a
node, the card writes `none (reason)` rather than omitting the field.

| # | Field | Content |
|---|---|---|
| 1 | `id / kind` | node id + `production-cell` / `kernel` / `terminal` (and cell id when different) |
| 2 | `roles` | author / reviewer / kernel; execution profile ids |
| 3 | `input authority / cardinality` | exact schemas + refs consumed, how they are selected (exact ref/digest), cardinality |
| 4 | `tools / protocol` | allowedTools list, MCP tools, protocol skill, templates/checklists |
| 5 | `output authority / schema` | output schema id, who seals/accepts it, digest authority |
| 6 | `gates` | gate ids/phases, check plan ids, provider ids/versions/digests |
| 7 | `repair / retry` | retry policy, repair targets, budgets (maxAttempts, totalAttempts), onExhausted |
| 8 | `state / effects` | durable state owned/mutated; post-acceptance effects; failure branches |
| 9 | `forward consumers` | exact downstream nodes/bridges consuming this node's accepted output |
| 10 | `backward obligations` | what upstream authority this node requires to be already true |
| 11 | `scripted outside participant` | how a scripted worker/scenario drives this node in tests (or `none`) |
| 12 | `tests / CI` | test files + evidence label per claim (`matrix-hosted`/`CI-executed`/…) |
| 13 | `uncovered` | known uncovered conditions of THIS node (honest gaps) |

(Card fields 1–13; the label `tests / CI` is field 12 and `uncovered` is field 13; the
`scripted outside participant` field is 11.)

## 8. Stratum document skeleton (mandatory section vocabulary)

Each workshop document (`01_DISCOVERY.md`, `02_FORMALIZATION.md`, …) must contain, in
order, these exact top-level sections:

1. `PURPOSE`
2. `ENTRY CONTRACT`
3. `LIVE PRODUCTION NODE / DESK CARDS` (one card per node, §7 schema)
4. `WORKSHOP EXIT CONTRACT`
5. `DOWNSTREAM CONTRACT (producer → bridge → consumer)`
6. `DEAD / DECLARATIVE-ONLY STRATA`
7. `TEST COVERAGE`
8. `UNCOVERED CONDITIONS`
9. `CONTRADICTIONS`

## 9. Citation and authoring rules

1. Citations are `relative/path/from/repo/root:LINE` or `:START-END`, frozen at authoring
   commit `586871ad`.
2. A claim without a citation is a hypothesis marker and must start with `HYPOTHESIS:`.
3. Dead/declarative strata never appear in live cards and vice versa.
4. Docs never weaken a production invariant to make a citation convenient; if the tree
   contradicts the normative model, it is recorded under CONTRADICTIONS with both sides
   cited (model citation + code citation).
5. This document set does not read, write, or assume the contents of forward/reverse
   graph files (§ Prohibited sources).
