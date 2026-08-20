# Agent brief — saga-mcp, stage 16: the defect-shape matrix

Continues stage 14. **All rules from stages 2–15 still apply.** **Do not launch a
factory run** — stage 15 owns the live run; this stage is pure test construction.

Branch `saga4`.

---

## 0. What you are building and why

Today `tests/factory-e2e/` holds **18 scenarios across 5 lanes**. Every one of
them was written *after* a real run had already found the bug. Not one has ever
found a defect first.

The scripted seam is used as a **regression harness** — one scenario per known
bug. This stage turns it into a **matrix** — a systematic sweep of the space where
defects live.

### 0.1 The key fact that makes this possible

You cannot predict the *content* of the next defect. You **can** enumerate its
*shape*. Every defect found in this project falls into four shapes:

| # | Shape | Real instance |
|---|---|---|
| **S1** | **Material re-identification** — something is deleted and recreated with identical content after a seal referenced it | trace rows 11–16 deleted and re-added → `REPLAY_CAPTURE_TRACE_NOT_FOUND` |
| **S2** | **Self-declaration narrowing** — the candidate declares less than the canonical requirement | `testCommand` listing 7 of 9 files; install command omitting an imported package |
| **S3** | **Cross-authority contradiction** — two factory-issued constraints cannot both be satisfied on one card | AC requires an artefact class; `changeScopes` forbids its path |
| **S4** | **Constraint loss across restatement** — a requirement present upstream is absent downstream with no disposition | order constraints absent from every AC |

A generator applying these four shapes to any fixture would have caught **all
five** defects this project has found the expensive way. That is the thesis you
are implementing.

### 0.2 The material budget — read this before writing any fixture

The factory has no intelligence of its own; the LLM is the only mind in the
system. But the factory is **not blind** — deterministic check providers read the
material. So:

> **Text is arbitrary exactly where nothing derives a decision from it. Where a
> provider derives a decision, the structure must be real.**

Three tiers:

- **Tier 1 — opaque.** Nobody parses it (document bodies, PRD prose).
  `"x"` is a valid fixture value. The factory only hashes it.
- **Tier 2 — schema-checked.** A product must satisfy its payload contract.
  **Shape** matters (fields, types); content does not.
  `{ "title": "a", "criteria": ["b"] }` is enough.
- **Tier 3 — semantically read by a provider.** Content matters *inside that
  provider's logic only*: git paths compared by `implementation-scope`, the graph
  checked by `task-graph-contract`, the command tokenized by the coverage report.

**All four defect shapes live in tier 3.** So your fixtures must carry real
structure there — and it can be tiny and meaningless. To reproduce the scope
deadlock you need three strings: an AC implying path class `zzz/`, a card scoped
to `aaa/`, a commit touching `zzz/thing`. No product, no code, no semantics.
`w9-06`'s invented `atlas/registry-map.json` world is the model to copy.

**One exception:** `factory.local-runnability.v1` actually executes commands in a
container. That cannot be faked with a string — use a three-file fake project
(one passing test, one failing test), exactly as
`tests/infrastructure/local-runnability-derived-canonical.test.mjs` already does.

**Do not build a realistic product.** A realistic fixture is slower, more
fragile, and proves less. Minimal structure, arbitrary text.

---

## 1. The five spaces

Build them in this order. Each is independent; finishing three well beats
starting five.

Home: `tests/matrix/` (new directory). One file per space, plus
`tests/matrix/README.md` explaining the thesis in §0.1 so the next reader does not
re-derive it.

---

### SPACE A — progress space (exhaustive forward sweep)

**Question:** is there any reachable state in which a workplace neither
progresses nor fails closed?

**You already have the classifier.** `classifyWorkplaceProgress` in
`src/application/progress/progress-classification.ts` implements CONVEYOR §23 and
returns one of `live_owner | runnable_command | typed_wait | transition_due |
stalled | inconsistent_state`. It has been used **reactively** (a sweep every 30
episodes) and never driven over its whole input space.

**Assertion:** for every reachable combination, the classification is one of the
four healthy classes, **or** a named test documents why that combination is
legitimately `stalled`/`inconsistent_state`.

#### TODO — Space A

- [ ] A1. Enumerate the dimensions from the code, not from memory: loop states
      (the frozen set), gate verdicts, effect-attempt outcomes (the five in
      `factory_effect_attempts`), obligation states.
- [ ] A2. Compute the cartesian product. Print the total count in the test output.
- [ ] A3. Mark unreachable combinations with a one-line reason each. An
      unreachable cell with no reason is not allowed — that is where a defect
      hides.
- [ ] A4. For every reachable cell, assert the classification is healthy, or is
      listed in a `KNOWN_UNHEALTHY` registry with a reason and an owner.
- [ ] A5. Set-equality between the computed reachable set and the classified set,
      so a new dimension value cannot be added without classifying it in the same
      commit.
- [ ] A6. Report the numbers: total cells, reachable, healthy, known-unhealthy.

---

### SPACE B — material re-identification (shape S1)

**Question:** for every kind of material a seal can reference, does the seal still
resolve after the referenced thing is deleted and recreated with identical
content?

The trace fix (stage 11) closed this for traces. **Nothing proves it for the
other kinds.**

#### TODO — Space B

- [ ] B1. Enumerate every material kind a sealed structure references: artifacts,
      traces, products, candidate-set members, check receipts, effect receipts,
      workplace revisions. Read the schema; do not guess the list.
- [ ] B2. For each kind, determine whether the reference is by **row id** or by
      **content identity**. Record the answer per kind in a table in the test
      file.
- [ ] B3. For every kind referenced by row id, write a test: seal a reference,
      delete the row, recreate identical content, resolve the seal.
- [ ] B4. Assert it resolves. Where it does not, **do not fix it** — record it as
      a finding with the kind, the file and the line.
- [ ] B5. Assert the honest negative too: content that genuinely no longer exists
      must fail closed, naming the material by content and not by a number.
- [ ] B6. Report the table: kind → identity basis → resolves after re-creation.

---

### SPACE C — self-declaration narrowing (shape S2)

**Question:** for every surface where the candidate declares something the
factory then acts on, can the declaration narrow the factory's canonical
requirement?

Two are closed (`testCommand` by derived-canonical enforcement, install by
environment derivation). **Others are not enumerated at all.**

#### TODO — Space C

- [ ] C1. Enumerate every candidate-declared surface. Start from the readiness
      manifest and the readiness profile; then search for any field the factory
      reads from candidate-produced material to decide *how* to check it.
- [ ] C2. For each, record: is the canonical requirement derived, or taken from
      the declaration?
- [ ] C3. For each declaration-driven surface, write a narrowing test: declare
      less than canonical, assert the check does **not** pass.
- [ ] C4. Where narrowing still succeeds, **do not fix it** — record the surface,
      the file and the line as a finding.
- [ ] C5. Assert the additive direction stays legal: a declaration adding more
      than canonical must still pass. Additive-only means *additive is allowed*.
- [ ] C6. Report the table: surface → derived or declared → narrowing blocked.

---

### SPACE D — cross-authority contradiction (shape S3)

**Question:** for every pair of constraints enforced simultaneously on one
subject, does an assignment satisfying both exist — and if not, is there a lawful
transition out?

Stage 14 delivered one decidable instance (the widening ledger). **Generalize
it.**

#### TODO — Space D

- [ ] D1. Enumerate the constraints enforced on a single card at once: the check
      plan's providers, the change-scope fence, the payload contract, the review
      gate.
- [ ] D2. For each pair, classify: independent (cannot contradict), or
      potentially contradictory. Give a one-line reason per pair.
- [ ] D3. For every potentially contradictory pair, either prove satisfiability,
      or prove a lawful transition exists out of the contradiction.
- [ ] D4. Write the domain-free RED for at least one pair other than
      scope-vs-AC — the point is to prove the method generalizes.
- [ ] D5. Assert no pair can produce a livelock: contradiction must reach a
      transition or a terminal, never a repeating epoch.
- [ ] D6. Report the pair matrix with each classification.
- [ ] **D7. Shared-path contention — found live in stage 15, currently untested.**
      Two different cards were blocked on the same root-level file
      (`tsconfig.json`) at 11:44 and 12:28. Root configuration belongs to no card
      and is needed by many. Write the domain-free case: N cards, one shared
      path, needed sequentially. Assert the contention rule does not permanently
      refuse a path that no card owns. **If it does refuse, that is a finding, not
      a fix** — it is the case the stage-13 brief said to escalate ("two cells
      that legitimately must write the same path").

---

### SPACE E — constraint loss across restatement (shape S4)

**Question:** at every boundary where material is restated by a worker, can an
upstream requirement disappear without a disposition?

The AC-drift remedy's order-constraint register closed the discovery→formalization
boundary. **The other boundaries are not covered.**

#### TODO — Space E

- [ ] E1. Enumerate every boundary where a worker restates upstream material in
      its own words: order→proposal, proposal→PRD, PRD→AC, AC→task graph,
      task graph→implementation.
- [ ] E2. For each, record whether a constraint register (or equivalent) carries
      requirements across, and whether consuming it is obligatory.
- [ ] E3. For each uncovered boundary, write a test: place a distinctive token
      upstream, restate without it, assert the loss is detected.
- [ ] E4. The token is an arbitrary string — `"CONSTRAINT-ALPHA"` is fine. This is
      tier-1 material; **do not invent a realistic requirement.**
- [ ] E5. Where loss goes undetected, **do not fix it** — record the boundary as a
      finding.
- [ ] E6. Report the boundary table: boundary → register present → loss detected.
- [ ] **E7. Silent surrender — found live in stage 15, and it is the sharpest gap
      in this brief.** A card was blocked by the scope fence at 11:44, and at
      12:01 it passed — not by declaring `scope-insufficient` (the ledger holds
      **zero** events), but by simply no longer touching the paths it had needed.
      The requirement did not get satisfied; it disappeared. The card was then
      accepted by the reviewer at 12:04.
      This is constraint loss relocated from the *formalization* boundary
      (which the register closed) to the *implementation* boundary, and the
      escape hatch — giving up quietly — turned out cheaper for the worker than
      the lawful route, even though the teaching suffix was in the message.
      Write it: a card whose criteria require an artefact it did not produce
      must not be acceptable as complete. **Nothing today asserts this.** If the
      test passes on current code, prove non-vacuity before believing it.

---

## 2. Rules that apply to every space

- [ ] **Findings, not fixes.** This stage builds the instrument and reads it.
      Every gap you find is recorded with file and line and left alone. A repair
      written in the same breath as its discovery has no failing test that
      predates it.
- [ ] **Domain-free fixtures.** No path, package or concept from any real run. If
      a fixture only works for the thing that broke, it is not a matrix cell.
- [ ] **Arbitrary text, real structure** (§0.2). Do not build a realistic product.
- [ ] **Non-vacuity.** Every assertion must be able to fail. For each space, prove
      it: break the mechanism temporarily, confirm RED, restore, confirm GREEN,
      and record the RED message verbatim in the report. An assertion nobody has
      seen fail is not evidence.
- [ ] **No real LLM.** The scripted seam replaces inference only.
- [ ] **Speed is a feature.** The point is thousands of traversals in a minute
      instead of hours per finding. If a space cannot run in seconds, say so.

---

## 3. Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/matrix/*.test.mjs"           # new
node --test "tests/architecture/*.test.mjs"     # was 411 pass
node --test "tests/lifecycle/*.test.mjs"        # was 136 pass
node --test "tests/process-modules/*.test.mjs"  # was 1220 pass
node --test "tests/infrastructure/*.test.mjs"   # was 407 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"   # was 20 pass
```

This stage adds tests and changes no production code. **If any existing count
moves, you changed something you should not have.** Investigate before
committing.

One commit per space. Push to `origin saga4`.

---

## 4. Escalate, do not decide

1. **Any finding.** All of them. This stage does not repair.
2. **Any space whose dimensions cannot be enumerated from code** — that is itself
   a finding about the code.
3. **Any fixture that needs a realistic product to work** — it means the
   provider's real dependency is larger than §0.2 assumes, and the architect
   needs to know.
4. **Starting a factory run.**

## 5. Report format

Per space: the TODO list with each item checked or explained, the table it
produced, the non-vacuity RED message verbatim, and the run time.

Then one consolidated findings list, ordered by how badly each would hurt in a
real run.

State plainly which spaces you did not build. Three spaces done properly are
worth more than five half-built.
