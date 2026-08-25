# Workflow Kernel Test Strategy (DRAFT for EK-10 landing)

> **Status: DRAFT** (WP-14, for the EK-10 landing). The testing strategy for
> the target protocol (EK-9 universal test engine, EK-11 scripted
> qualification, EK-12 real-agent qualification). It folds and replaces the
> legacy `docs/design/TESTING-STRATEGY.md`, the temporal/conformance/graph
> testing designs and `docs/architecture/FAILURE-AXES.md` (whose axis map is
> preserved below as the fault-matrix classification frame). Protocol
> vocabulary: `docs/architecture/WORKFLOW-KERNEL.md`.

## 1. Principles

1. **The oracle is the independently frozen universe, not production output.**
   Expected events, obligations, waits, proofs and evidence come from the
   EK-1 transition/claim universe; expected results are never copied from
   what the implementation happened to emit.
2. **One production path for all actor types.** Scripted, replay and real LLM
   actors replace cognition only; they use the same commands, ingress,
   validation, role contracts and context accountant. A test harness never
   writes authority tables and never fabricates factory receipts — canonical
   factory signing/digest code is used through public ingress.
3. **Everything is blocking.** The new suite has no quarantine, shadow or
   unhosted category. CI fails if a test, driver, universe, corpus or removal
   guard is deleted or de-hosted.
4. **Failures reproduce and minimize.** Random seeds and fault schedules are
   retained; failing traces are minimized while preserving the failure.
5. **Mutations prove the tests bite.** Every architecture law has mutation
   tokens; a non-decreasing kill-rate floor exists from the first honest run.

## 2. Levels

| Level | What | Tokens | Oracle |
|---|---|---|---|
| L0 static | tsc + lint + source ratchets (schema-mutation bans, projection-authority bans, legacy-zero) | 0 | static |
| L1 pure model | `src/workflow-kernel/domain/**` reducers, legality, idempotency, fences, progress invariant; reference state explorer; legal/illegal trace generation | 0 | frozen universe |
| L2 persistence | fresh bootstrap, fingerprint open/refusal, sole-writer repos, transactional event/evidence/obligation writes, duplicate keys | 0 | schema contract |
| L3 composition/faults | obligation consumer, waits, fault-point execution with restart, concurrency caps | 0 | normalized traces vs reference model |
| L4 real cognition | OpenCode transport runs (qualification series) | real | terminal proofs + product verification |

## 3. Scenario contract (versioned format)

One versioned scenario format drives L1 reference model and L3/L4 production
composition from the same input:

- protocol/build/package/capsule identities;
- fresh seed input through **public commands** only;
- actor program and allowed tool/result sequence;
- dependency topology and concurrency cap;
- fault schedule (exact fault points and timings);
- expected normalized events, obligations, waits and terminal proofs;
- expected material/gate/effect evidence;
- product verification commands and time budgets.

Normalization rules: generated IDs, timestamps, leases and paths are
normalized only when they are not semantic. Comparison is on normalized
traces and final evidence; the `PromptAssemblyReceipt` and role-contract
digest are compared in reference and production traces — prompt text alone is
not the oracle.

## 4. The declared universe (declared = demonstrated)

An independently declared `WORKFLOW_OBLIGATION_UNIVERSE` (the EK-1 frozen
transition universe: 9 aggregates +4 authorities, 53 commands, 49 obligation
kinds, 5 wait kinds, 28 proofs, 67 evidence kinds, decisions D1–D12) is the
machine oracle:

- every declared transition has at least one generated positive trace;
- every declared transition has at least one illegal mutation that must be
  killed;
- declared equals demonstrated — a transition never demonstrated, or a
  demonstration outside the declaration, is blocking-red;
- structural-complexity mutations live in the universe: a second owner,
  second binding path, second accountant, private scheduler or workshop
  branch is blocking-red;
- widening the universe without an approved measured complexity delta is a
  mutation that must be caught.

## 5. Fault matrix (required dimensions)

Every dimension below is a required axis of the blocking matrix; the
failure-axes frame (§5.1) classifies *why* each fault bites.

| Dimension | Values (minimum) |
|---|---|
| protocol role | author; reviewer |
| semantic profile | planner; implementer; reviewer; certifier |
| actor behavior | compliant; omission; extra paths; malformed product; repairing; stale hash; foreign ref; duplicate completion; prose-only review; timeout; crash; tool misuse |
| gate result | accept; repair; upstream repair; human wait; terminal reject |
| effect result | success; already-applied; retryable; unknown; human wait; policy terminal; repair (D2) |
| dependency | none; chain; diamond; fan-in; fan-out; cycle refusal; failed predecessor |
| restart boundary | before/after every event, evidence, obligation, worker, gate, effect and settlement commit |
| projection state | absent; stale; false; delayed; rebuilt |
| payload scale | minimum; normal production; current observed maximum (incl. preserved large-prompt classes: ~436 KB planner request, largest preserved Elite-8 request) |
| role binding | correct digest; foreign digest; stale digest; task/tag mismatch; attempted downstream re-resolution |
| context budget | one token below; exact limit; one token above; reduced provider limit; duplicate history; raw product metadata; disabled/zero cap; silent truncation attempt; large reference; token-counter drift; concurrent admission; output-limit mismatch |
| platform | Windows production lane; Linux CI lane |
| concurrency | 1; exact cap 2; cap saturation with deterministic barrier; stale lease; two consumers |

Mandatory projection mutations: (a) delete all Kanban rows while work is
running; (b) write false/stale rows; (c) stop the projector, finish work,
rebuild. All three must yield the identical normalized authoritative trace
and terminal proof.

Mandatory admission proofs: an admitted receipt is not accepted as send
evidence; the same provider-send obligation/ordinal is redriven after a
pre-send crash; an uncertain non-idempotent send is never automatically
duplicated; oversized hook `additionalContext` and oversized tool results
appear in the exact next pre-send receipt and are refused before network
send when the envelope is exceeded; two concurrent admissions at one
`contextRevision` produce exactly one CAS success and one stale typed
refusal.

### 5.1 Failure-axes frame (classification, not enumeration)

Faults are classified top-down along the axes derived from what the system
*is* (untrusted actors produce material; deterministic authorities judge;
durable state records; obligations move work; effects touch the world):

1. **Decision** — wrong verdict for the inputs handed to it.
2. **Delivery** — authority never reaches (or corruptly reaches) the actor
   bound by it, before it acts. Corrupt delivery is worse than none.
3. **Reference** — a name stops denoting the same thing (row ids, digests,
   aliases, paths, package versions, capsule keys).
4. **Containment** — an actor acts beyond granted authority.
5. **Concurrency** — simultaneous actors corrupt each other (leases, fences,
   CAS races).
6. **Durability** — a crash at any point must converge exactly-once.
7. **World-model fidelity** — factory belief vs external reality (git refs,
   filesystems, providers); the world is the authority, not a column.
8. **Liveness** — a well-founded measure guarantees termination; every lawful
   transition must strictly decrease unresolved-obligation distance to
   terminal, or equivalently the write-time progress invariant plus bounded
   epochs guarantee no infinite healthy-state walk.

A defect fitting no axis is a defect of this frame: correct the frame, do not
squeeze the defect into a box.

## 6. Model checking and minimization

- The reference explorer derives legal/illegal traces from the frozen
  universe; seeds retained; failing traces minimized deterministically.
- The pure model cannot reach an unexplained nonterminal state; the pure
  package imports nothing from persistence, UI or workshop modules.
- Normalized production-intended traces compare against the reference model
  per scenario.

## 7. Mutation testing (architecture-law tokens)

Required mutation classes (each must be killed blocking-red):

- missing successor obligation; two owners for one fact; terminalization
  from empty work; wait without wake source; stale expected revision
  accepted; duplicate effect accepted twice; dead predecessor leaving a
  dependant pending; workshop-specific kernel branch;
- WorkIntent role digest A paired with ActivityAttempt digest B; an attempt
  independently re-resolving the manifest; a semantic profile treated as a
  kernel role; transition universe widened without an approved complexity
  delta;
- admission-spec mutations: removing a complexity dimension;
  duplicate/omitted role binding; zero/unbounded limit; arbitrary contract
  field; executable/implicit-fallback route rule; limit-table route
  selection; unclassified hook/tool context source.

## 8. Project qualification

### 8.1 Development reliability series (EK-11)

- `npm run qualify:development -- --kit <kit-manifest>`; driver owns fresh
  paths, evidence capture, dirty-build refusal.
- The canonical simple product (dependency-light Node HTTP server,
  `/healthz`, `/api/message` with deterministic JSON, served HTML/JS
  frontend, package/build/start commands, unit + loopback HTTP + real browser
  smoke, local packaging/delivery input) **ten times**, ten fresh databases
  and repositories, one immutable build and capsule.
- 10/10 terminal successes with identical normalized authority traces; no
  manual stop/resume, SQL, repository patch or actor repair.

### 8.2 Twenty-project scripted corpus (EK-11)

P01 served Node/browser hello · P02 static counter · P03 CLI text stats ·
P04 validation library · P05 todo CRUD · P06 CSV→JSON CLI · P07 webhook
receiver · P08 markdown site generator · P09 file-backed notes service ·
P10 in-memory job-queue simulator · P11 read-only metrics dashboard ·
P12 JSON-Schema validator package · P13 SQLite inventory · P14 multi-module
event processor · P15 REST service with operator frontend · P16 local
release packager (idempotent effect receipt) · P17 configuration linter ·
P18 import/export with recovery path · P19 canvas game (keyboard, browser
smoke) · P20 full-stack expense tracker.

- `npm run qualify:projects:scripted -- --kit <kit-manifest> --all`;
  every project has a versioned capsule, claim graph, actor program,
  verifier and maximum duration; 20/20 from fresh paths.
- Verify **actual product outputs** (build/test/start evidence; browser
  smoke for browser products; command/API smoke otherwise; local Delivery
  effect receipts), not factory statuses alone.
- Concurrency evidence: four independent scripted projects concurrently with
  isolated databases/repositories and no cross-run identity/material leak;
  a within-project diamond at cap 2 with a deterministic barrier proving
  peak = 2 without timing-based assertions.

### 8.3 Real OpenCode qualification (EK-12)

- Env per the runbook (opencode-only law; `SAGA_REAL_CLAUDE_PATH`,
  `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`; settings tripwire verified,
  never edited). Provider/model pinned and recorded; a positive finite
  PromptBudgetProfile for that exact provider/model or refusal to start.
- The pinned transport must expose and receipt every final pre-send request;
  initial-stdin/postflight-only observability disqualifies the kit.
- Three consecutive runs on one immutable kit: R1 served Node/browser API
  product; R2 CLI/library product with tests; R3 full-stack CRUD with
  persistence and browser smoke. Full idea → Discovery → Formalization →
  Development → Delivery for each; forward/reverse reconciliation; runs
  verified independently (install/build/test/start/smoke/delivery receipt).
- Any failure: preserve evidence, add a minimal blocking regression, build a
  new immutable kit, restart the series from R1.

## 9. Blocking commands

EK-specific (hosted by WP-13C; stable names):

`npm run validate:ek-admission-specs` · `test:workflow-model` ·
`test:workflow-persistence` · `test:workflow-faults` ·
`test:development-capsule` · `test:workflow-complexity` ·
`test:role-contract` · `test:prompt-budget` · `test:project-corpus` ·
`test:legacy-zero` · `test:docs-current` · `qualify:development` ·
`qualify:projects:scripted` · `qualify:projects:real`.

Canonical aggregates kept green: `build`, `test:architecture`,
`test:factory-model`, `test:factory-temporal`, `test:factory-contract`,
`test:process-modules`, `test:acceptance-matrix`, `coverage:factory`,
`npm test`.

## 10. Ratchets

- `test:legacy-zero`: every deletion-manifest entry absent; production
  imports resolve only to the new runtime; forbidden old table/column names
  absent from production SQL; no migration/adoption/compatibility fallback;
  no workshop-owned scheduler/state table.
- `test:docs-current`: the current-document linter (five failure classes —
  see `docs/refactoring/event-kernel/CURRENT-DOCUMENT-LINTER-SPEC.md`).
- Complexity: the measured vector satisfies every conjunctive EK-1 cap; one
  production composition; one obligation-consumer protocol; one role-binding
  path; one cumulative accountant; zero projection-authority reads; zero
  workshop-name kernel branches; zero temporary legacy/replacement debt
  after EK-8.

## 11. Hosting rules

- Every test file is blocking-hosted and removal-guarded; CI fails on
  deletion/de-hosting of tests, drivers, universes, corpora or guards.
- Windows production lane behavior has executable evidence, not prose.
- No timeout inflation, skip, quarantine or oracle weakening may hide a
  failure; a hidden failure is treated as a failed gate.
