# Agent brief — saga-mcp, stage 4: pin the admission boundary

Continues `docs/handoff/STAGE-3-AGENT-BRIEF.md`. **Every rule there still applies** —
especially: never spawn a real LLM worker, never weaken a gate, never write to
authority tables from a test handler, never report success without pasting real
test counts.

Branch `saga4`.

---

## 0. Context you need before touching anything

An architectural audit asked whether the `development` workshop had grown its own
private machinery — i.e. whether "a new workshop = the shared kernel + different
skills" is actually true. Two documents hold the answer:

- `ideas/2026-08-18-kernel-surface-evidence-development-chain.md` — the facts
- `ideas/2026-08-18-ees-admission-judgment.md` — the decision drawn from them

Short version, because it determines what this stage is and is not:

The kernel **is** already generic. Fan-out is a `materialization` field on a
production cell. The git candidate is the factory-level `git-integration` effect.
Runnability is a factory-level check provider. Gates, recovery, authority, replay
— all kernel, none branching on workshop name. Nothing needs to move out of
`development` into the kernel.

What is **not** generic is **admission**: how a new workshop gets plugged in. A
code-producing workshop today needs 3–4 deliberate edits inside the kernel
repository. That is known, intentional for now, and already scheduled — the
Change Plane release **C12 (Semantic Adapter SDK)**,
`docs/vision/CONTROLLED-CHANGE-PLANE-PLAN.md:671`, whose exit gate is literally
"a minimal second fixture pack passes the conformance kit".

**So this stage does NOT open admission and does NOT refactor anything.** It makes
the current admission cost *visible and mechanically frozen*, so it cannot grow
by accident between now and C12. That is all.

If you find yourself editing runtime behaviour, you have misread the task. Stop.

---

## TASK 1 — the admission-distance ratchet (the substance of this stage)

Add `tests/architecture/kernel-admission-distance.test.mjs`.

**Admission distance** = the number of deliberate edits inside the kernel
repository required to plug in a new workshop. The ratchet pins today's manual
admission points so that adding one becomes a conscious act with a code review,
not a quiet drift.

### 1.1 Count and freeze these four surfaces

1. **Payload contracts** — `WORKSHOP_PAYLOAD_CONTRACTS` in
   `src/process-modules/application/workshop-capability-manifest.ts`.
2. **Executable capabilities** — `WORKSHOP_EXECUTABLE_CAPABILITIES` in the same
   file. Note `requireExecutableCapability` (same file, ~line 297) throws
   `WORKSHOP_CAPABILITY_UNDECLARED` for anything absent — this is the fail-closed
   boundary being pinned.
3. **Composition-root registrations** — the `registerDiscovery` /
   `registerFormalization` / `registerDevelopment` / `registerDelivery` calls in
   `src/app/product-lifecycle-runtime.ts` (around 787–796).
4. **Lifecycle start gateway** — the accepted lifecycle input schema check in
   `src/app/product-lifecycle-runtime.ts` (around 919–924), which admits only
   `PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA`.

Assert **exact expected counts / exact expected sets**, not `>=`. A lower bound
lets the surface grow silently, which is the exact failure this ratchet exists to
prevent.

Prefer asserting against **imported values** where the module exports them
(counts, ids) over regex-scraping source text. Where you must read source (the
composition root), reuse the comment-stripping helper pattern already used in
`tests/architecture/conveyor-completeness-ratchets.test.mjs` — a ratchet must
judge code, not prose.

### 1.2 Freeze the single behavioural leak

`src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts`
(~lines 509 and 548) is the **only** place in the kernel found to branch
behaviourally on a stage name:

```
linkType = workflowStage === 'development' ? 'implements' : 'depends_on'
```

Do **not** fix it. It is owned by K15 (unified vocabulary) and C5 (the trace model
owns edge types); changing it now would be an unreviewed semantic change to
persisted projection data.

Instead, assert it is the **only** one: a test that fails if a second behavioural
branch on a workshop/stage name appears anywhere in the kernel outside
`src/modules/`, `src/process-modules/modules/`, and the allowlisted line(s).

The evidence package §6 contains the full classification of every current
name-mention (warning sets, owner metadata, named constants, comments, the legacy
`epics.stage` enum). Use it to build the allowlist. If your scan finds a mention
that §6 does **not** classify, that is new drift since 2026-08-18 — report it,
do not allowlist it silently.

### 1.3 The test must explain itself

The file header must state, in prose a future reader can act on: what admission
distance is, why the numbers are frozen rather than lower-bounded, that C12 is the
appointed owner of opening this boundary, and that raising a number is legitimate
**when done deliberately in the same commit as the admission it accounts for**.

A ratchet nobody understands gets deleted the first time it goes red.

---

## TASK 2 — promote the two audit documents out of `ideas/`

`ideas/` is a scratch directory. These two files are now cited findings and must
not rot there.

- Move both to `docs/research/` alongside
  `ARCHITECTURE-RESEARCH-2026-08-18.md` and
  `CONVEYOR-TRANSITION-AUDIT-2026-08-18.md`, keeping the dated filenames.
- In the evidence package, correct §1's own framing where the judgment
  superseded it: the "development is asymmetric" signal was measured, and
  `delivery` has the same four-kernel-node shape while producing no code. Leave
  the measurements themselves untouched — the record of how a wrong signal was
  corrected is worth more than a tidy document.
- Add a line at the top of each pointing to the other, and to this brief.

Do not rewrite the analysis. You are relocating and cross-linking, not editing
conclusions.

---

## TASK 3 — verify the two escalated legacy candidates are correctly recorded

Stage 3 refuted two of the enumerated legacy candidates (dossier:
`TASK-C-PREVERIFICATION.md`):

- the "unbound LEGACY" branch in `readFrozenProductionIngressIfBound` — found to
  be a legitimate `tracker_only` fence, not legacy;
- the fabricated receipt in `FactoryPostAcceptanceEffectRegistry.run` — found to
  be load-bearing for two live effects.

Confirm both are recorded as **decided-keep with reasons** in the dossier and are
**not** still listed as pending deletions in
`docs/architecture/legacy-allowlist.json` or in any stage brief's candidate list.
A refuted candidate left on a to-delete list is a trap for the next agent.

If either is still listed as pending, fix the listing — do not delete the code.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"
node --test "tests/lifecycle/*.test.mjs"
node --test "tests/process-modules/*.test.mjs"
node --test "tests/infrastructure/*.test.mjs"
node --test tests/factory-e2e/w9-02-happy-path.test.mjs
node --test tests/factory-contract/golden-path.test.mjs
```

This stage changes **no runtime code**. If any suite outside
`tests/architecture/` changes its counts, something is wrong with your change,
not with the suite. Investigate before committing.

One commit per task. Push to `origin saga4`.

---

## Escalate, do not decide

Unchanged from stages 2 and 3, plus:

1. **Any change that opens admission** — making the capability manifest
   composite, letting a package ship a kernel handler, accepting a second
   lifecycle input schema at the start gateway. All of it belongs to C12 and is
   forbidden here.
2. **Any temptation to extract a generic abstraction** from the three
   development-private handlers (`resolve-task-graph`,
   `freeze-integrated-candidate`, `bind-runnable-candidate`). There is exactly
   one consumer. The project's own budget rule forbids a new kernel abstraction
   before a second fixture exercises it (Controlled Change Plane §8.1).
3. **The `linkType` branch.** Report, never fix. Owned by K15/C5.
4. **Any admission point your scan finds that the evidence package §6 does not
   classify** — that is drift, and the architect decides it.

## Report format

Per task: what changed, exact counts before and after, the four frozen numbers
your ratchet now pins, and every item escalated with its evidence.

State plainly what you did not finish.
