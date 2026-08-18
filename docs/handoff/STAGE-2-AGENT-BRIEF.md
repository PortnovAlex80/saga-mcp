# Agent brief — saga-mcp, stage 2 (scripted coverage) and stage 3 (legacy purge)

You are picking up well-specified, mechanical work on a factory runtime. The
architectural decisions are already made and are **not yours to revisit** — this
brief tells you exactly what to build, what to never do, and what to escalate.

Branch: `saga4`. Start from `ca45d915` or later. Commit and push after each
completed, verified task (not after every file).

---

## 0. The one rule that overrides everything

**Never launch a real LLM worker.** The factory spawns workers through
`claude -p`, which inherits the operator's expensive model. A single real run
can exhaust the subscription.

All verification happens through the **scripted-inference seam**, which already
exists and is architecturally correct: it replaces only the *inference spawn*
and nothing else.

```
tests/mock-claude/scripted-executor.mjs          the WorkerExecutor port stand-in
tests/factory-e2e/scripted-inference.mjs         scripted inference wiring
tests/factory-e2e/w9-happy-handlers.mjs          per-node happy handlers
tests/factory-e2e/w9-03-adversarial-handlers.mjs one targeted override per scenario
```

If a task seems to require a real model, stop and escalate. It does not.

---

## 1. What this system is (2 minutes, then read the real doc)

A conveyor that manufactures software. The LLM is an untrusted, replaceable
worker that may only **produce text**; every authority belongs to the factory:

- `worker_done` is not acceptance — it means "material was left on the desk";
- only a `GateDecision` accepts, repairs or terminates a cell;
- git, publish, deploy are fenced factory **Effects**, never worker actions;
- task rows and board columns are **projections** and can never authorize a
  transition.

Normative document — read before touching runtime code:
`docs/architecture/CONVEYOR-MENTAL-MODEL.md`. Section numbers below (§4, §20,
§23…) refer to it. It is the arbiter of every design question in this brief.

---

## 2. Current state (all verified, all pushed)

Two load-bearing gaps in the model were recently closed:

| Gap | What was added |
|---|---|
| §23 progress-obligation invariant existed only as prose | `src/application/progress/progress-classification.ts` + `sqlite-progress-reader.ts`, wired into the engine loop, emitting `[progress-invariant]` incidents |
| §20 durable `EffectAttempt` did not exist | `factory_effect_attempts` table (immutable, four-valued outcome) + `recordEffectAttempt` on `SqliteCellFinalAcceptance` |

A scripted corpus was harvested from a captured real run:

```
tools/harvest-golden-corpus.mjs                        the harvester (deterministic)
tests/fixtures/golden-corpus/accessible-counter/       54 products, 8 documents
tests/mock-claude/corpus.mjs                           fail-closed loader
```

The corpus is material a **real model produced and real gates accepted**. It is
the material your scripted workers must serve.

### Test baseline — do not regress these numbers

```bash
npm run build                                     # must exit 0
node --test "tests/architecture/*.test.mjs"       # 302 pass, 0 fail
node --test "tests/lifecycle/*.test.mjs"          # 114 pass, 0 fail
node --test "tests/process-modules/*.test.mjs"    # 1035 pass, 0 fail
node --test "tests/infrastructure/*.test.mjs"     # 324 pass, 0 fail, 12 skipped
node --test "tests/discovery/*.test.mjs"          # 180 pass, 0 fail
node --test tests/factory-e2e/w9-02-happy-path.test.mjs   # 3 pass (~25s)
node --test tests/factory-contract/golden-path.test.mjs   # 1 pass (~55s)
```

The 12 infrastructure skips are intentional: two suites bind an exact commit
inside `.factory-sandboxes`, which is scratch space and absent on most machines.
They declare that precondition and skip. **Do not "fix" them by deleting the
assertions.**

---

## 3. TASK A — feed the scripted workers from the corpus

**Why:** the existing imitators inline invented prose. For example
`tests/mock-claude/workshops/formalization/generic-author.mjs` carries a
hand-written SRS template around line 246. A harness that asserts against text
no gate ever accepted proves nothing about the factory.

**Do:** replace inlined document/product bodies in
`tests/mock-claude/workshops/**` with corpus reads.

```js
import { loadCorpus } from '../../corpus.mjs';
const corpus = loadCorpus();               // 'accessible-counter'

const srs   = corpus.document('05-SRS.md');
const prd   = corpus.document('01-PRD.md');
const props = corpus.product('produce-proposal', 'factory.discovery-proposal.v1');
```

Inspect what exists before writing code:

```bash
node -e "const {loadCorpus}=require('./tests/mock-claude/corpus.mjs')" # ESM: use import
node --input-type=module -e "
import {loadCorpus} from './tests/mock-claude/corpus.mjs';
const c = loadCorpus();
console.log(c.nodes());
console.log(c.manifest.products.map(p=>p.nodeId+' '+p.schemaId).join('\n'));
"
```

**Acceptance:**
1. `node --test tests/factory-e2e/w9-02-happy-path.test.mjs` still passes, still
   deterministic (both drives identical).
2. `node --test tests/architecture/golden-corpus-coverage.test.mjs` passes.
3. No worker invents a document body that the corpus could have supplied.

**Warning:** the corpus content differs from the current synthetic text, so a
gate may reject it (for example an acceptance-criteria checker that matches a
criterion code against a document heading). If that happens, **the corpus is
right and the imitator is wrong** — adjust how the worker submits, never weaken
the gate. If a gate genuinely cannot accept real accepted material, escalate:
that is an architectural finding, not a test problem.

---

## 4. TASK B — turn PENDING outcome edges into TRACED ones

Read `tests/architecture/lifecycle-outcome-edge-coverage.test.mjs` first. It is
the worklist. Today runtime coverage is **3/16**: only
`discovery:go → formalization:formalized → development:verified` has a trace.

The other 13 edges are declared in the route table but **no run has ever taken
them**. Most are TERMINALS — where settlement, certificates and order projection
execute. An untraversed terminal is the highest-risk path in the conveyor.

### The pattern to copy

`tests/factory-e2e/w9-03-adversarial-handlers.mjs` is the template: it imports
`W9_HAPPY_HANDLERS` and overrides **exactly one** node handler, leaving every
other cell on the happy path. Do the same, one scenario per outcome edge.

### Order of work (highest risk first)

1. `solution-formalization:clarification-required`
2. `solution-formalization:inconsistent`
3. `solution-formalization:infeasible`
4. `solution-development:rework-required`
5. `solution-development:blocked`
6. `solution-development:clarification-required`
7. `solution-formalization:failed`, `solution-development:failed`
8. Discovery strength codes (`clarify`, `reject`, `defer`, `inconclusive`,
   `failed`) — these all route forward to Formalization by design (Discovery is
   an idea-strength gate, not a build gate), so the trace must assert that the
   emitted code reaches the **discovery certificate**, not that routing differs.

### For each edge

- add a scenario that makes the workshop emit that outcome through its normal
  product/gate path;
- assert the lifecycle actually reaches the declared terminal/stage, and that
  settlement wrote what the terminal implies (certificate / order projection);
- move the edge from `PENDING` to `TRACED` in the registry with the scenario
  name;
- keep the registry's set equality green.

### Absolutely forbidden while doing this

The scripted worker may replace **model cognition only**. It must not replace or
bypass:

- assignment, reservation, or the execution fence;
- the Workplace desk, `product_submit`, `worker_done`;
- gates, check providers, or their verdicts;
- effects, routing, settlement, persistence.

Never write to authority tables (`factory_gate_decisions`,
`factory_accepted_authority_head`, `factory_candidate_sets`,
`factory_cell_final_acceptances`, `factory_effect_attempts`, …) from a test
handler. Reading them is fine — `w9-03-adversarial-handlers.mjs` shows the
correct read of the accepted-author head.

A scenario that reaches a terminal by writing the terminal is worthless. If an
edge cannot be reached through normal production, say so and escalate — that is
either a real unreachable edge (which needs a mechanical unreachability proof)
or a real defect.

---

## 5. TASK C — purge legacy (do this LAST, operator's sequencing)

The product is **pre-production**: no backward compatibility was ever promised,
so every `legacy` / `compat` / `v1-fallback` branch is pure debt.

Enumerated candidates (verify each before deleting):

- `applyTestWarmStart` / `captureTestWarmStart` in
  `src/infrastructure/testing/test-warm-start.ts` — already documented no-ops;
  remove the call sites in `claude-worker-executor-factory.ts` and the
  `testWarmStart?` field in `pinned-workspace-materializer.ts`, then delete the
  module.
- `readFrozenProductionIngressIfBound` — the "explicitly unbound LEGACY
  execution" branch (`authority === null && work_intent_id === null`), plus the
  `seedUnboundExecution` fixture that exists only to satisfy it.
  **REFUTED 2026-08-18 — DECIDED KEEP.** Not legacy: this branch is the lawful
  fence for `tracker_only` tasks (any claim without a WorkIntent recreates it).
  Deleting it breaks `worker_done` for plain tracker usage. Evidence and the
  required design decision first:
  `docs/testing/TASK-C-PREVERIFICATION.md`, CANDIDATE 2.
- `FactoryPostAcceptanceEffectRegistry.run` — the "legacy idempotent adapters"
  branch that fabricates a successful receipt.
  **REFUTED 2026-08-18 — DECIDED KEEP.** Load-bearing today: two live effects
  (`formalization-accept-products`, `replay-capture`) return void and every
  acceptance settles through the fabricated receipt. The correct purge is first
  migrating both effects to explicit `succeeded` receipts, then removing the
  fallback — a migration task, not a deletion.
  `docs/testing/TASK-C-PREVERIFICATION.md`, CANDIDATE 3.
- `'factory.execution.v1'` in `ACCEPTED_POLICY_VERSIONS`
  (`src/shared/authority/authorize-tool-call.ts`).
- `src/db.ts`: `supportedVersions` `{0,3..13}` and the whole migration ladder
  (`migrateFactorySchemaV3ToV4`, `rebuildFactoryOrdersWithoutColumnUniques`,
  `rebuildLaunchIdempotencyIndex`, `migrateSyntheticBriefsToDbNative`, every
  `ensure*Column`).
- node-run v1/v2 duality: `start`/`startV2`, `complete`/`completeV2`,
  `readLastCompleted`/`readLastCompletedV2` — two shapes of one table.

**Method:** not a grep for the word "legacy". For each branch ask: *does this
exist only to serve old data or an old format?* If yes, delete it together with
its fixture and its test.

**Stage acceptance:** `docs/architecture/legacy-allowlist.json` is empty; no
`SAGA_*` toggle selects old behaviour; one schema version; one node-run
contract; full test baseline still green.

**Careful:** deleting the migration ladder changes `db.ts` behaviour for any
existing database on the operator's machine. Do the deletion, but call it out
explicitly in the commit message and in your report.

---

## 6. Verification protocol — run before every commit

```bash
npm run build                                    # exit 0, no TS errors
node --test "tests/architecture/*.test.mjs"
node --test "tests/lifecycle/*.test.mjs"
node --test "tests/process-modules/*.test.mjs"
node --test "tests/infrastructure/*.test.mjs"
node --test tests/factory-e2e/w9-02-happy-path.test.mjs
```

Rules:
- **Never** report success without pasting the actual counts.
- If a ratchet fails because you deliberately changed something (schema
  snapshot, sanctioned-writer list, handler map), update it **in the same
  commit** with a comment explaining why — that is what those ratchets are for.
- If a test fails and you do not understand why, do not weaken it. Investigate
  or escalate.

Commit style: one commit per completed task, imperative subject, body explaining
*why* (the codebase's commit messages are unusually explanatory — match that).
Push to `origin saga4` after each.

---

## 7. Escalate instead of deciding — reserved for the architect

Do **not** decide these yourself. Collect evidence, write it up, stop.

1. **Any change to material authority or replay semantics.** Capsule selection,
   `WorkplaceProductionRevision`, CandidateSet identity, the accepted-authority
   head, `semanticInputDigest`. A recent regression came from patching a symptom
   here (`newest-wins` capsule selection) and it violated §9 and §15.
2. **Any gate, check provider or effect that would need weakening** for a
   scenario to pass.
3. **Declaring an outcome edge "unreachable"** rather than untested.
4. **The workshop-uniformity audit** — whether each workshop is a pure
   declaration over one shared kernel, and specifically whether the
   `development` workshop has grown its own mechanics. This is an open
   architectural question reserved for review; do not refactor workshops.
5. **Anything that adds a second dispatcher, submit protocol, lifecycle engine,
   mock/hybrid mode, or a runtime branch on workshop name** — §27 forbids all of
   these and CI ratchets enforce them.

---

## 8. Report format when you hand back

For each task: what you changed, the exact test counts before and after, which
outcome edges moved `PENDING → TRACED`, every ratchet you updated and why, and
every item you escalated with the evidence you gathered.

State plainly what you did **not** finish. An honest gap is more useful than a
green number that hides one.
