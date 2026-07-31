# Conveyor Mental Model — Saga4

The architectural metaphor that governs how the Saga conveyor moves work from
idea to release. This document captures the conceptual model so every change to
the conveyor can be checked against it. It is NOT a spec — the formal invariant
is **CGAD P18** (`cgad-v2-spec.md`); this file is the plain-language model
behind it.

## The conveyor

A product initiative moves through **stages** (Discovery → Formalization →
Development → Delivery). Each stage is run by a **module** (a swappable unit
with its own skills/specialty). Inside a module, work flows through a **Flow** of
**nodes**.

## Three entities, one primary

The conveyor has three kinds of entity. Getting their roles right is the whole
game.

| Entity | Code | Lifetime | Role |
|---|---|---|---|
| **Workplace** (место) | a **node** in a ProcessRun | durable — lives for the whole run | PRIMARY. Owns the card and the desk. |
| **Worker** (рабочий) | an LM execution (a `task` + execution fence) | one-shot — comes, works, leaves, never returns | GUEST on the workplace. |
| **Card** (карточка) | the projected `task` row | durable — belongs to the workplace | Carries the work done so far. |
| **Desk** (стол) | the execution workspace directory | durable — belongs to the workplace | Holds the worker's drafts/tools. |

**The workplace is the primary entity.** The worker is a one-shot guest on it.
The card and the desk are property of the **workplace**, not the worker, and
survive a worker change.

## The repair mechanic (recovery)

Every workplace has a common mechanic — independent of its specialty — for
sending work back for rework:

> When a verifier (engineer / kernel node) finds a defect, a **new worker** is
> brought to the **SAME workplace**. The new worker takes the **SAME card** (with
> the work already done on it) and continues on the **SAME desk** (with the
> prior drafts). The worker fixes the defect and the verifier re-checks.

The worker never carries the card or the desk away. The next worker always finds
the workplace's card and desk waiting.

This is exactly the **physical-resume** path (`generic-flow-executor.ts`
restoreFrame), generalised to **semantic recovery**. There is one proven path,
not two.

## What this rules out (the bug this model replaced)

- ~~Recovery mints a **new card** per attempt~~ → the verifier looks at the new
  empty card, finds "no work", and the loop never converges.
- ~~Recovery gives the worker a **clean desk**~~ → the worker starts from
  scratch every round and cannot converge on a complex artifact
  (BUGS-2026-07-30 #10 "каждый запуск — чистый лист").
- ~~A gate reads the card by **worker identity**~~ → it is blinded to the
  workplace's prior work on every repair round.

## Resume must not be coupled to package digest

A run's **work** (the card's accepted artifacts/traces/submissions and the
projected tasks on the kanban) lives in the durable database, keyed by
process-run + node. It does **not** live inside the module package. The package
is the **toolset and instructions** (templates, skills, schemas, tracker rules)
the workers use — it is a separate concern from the work they produced.

A ProcessRun pins an `installation_id` + `package_digest` so a run is
reproducible against the exact bytes it started with. But this pin is an
**integrity boundary for toolset versioning**, not a gate on whether the run's
work can be resumed. When the toolset changes (e.g. a tracker rule or a skill is
updated), `PackageInstaller.installPackage` recomputes the digest and a naive
resume throws "already holds the active slot with a different package_digest" —
even though every artifact, trace, submission and task on the workplace's card
is unchanged and still valid.

The correct behaviour: **resume is about the work on the card, not the toolset
version.** If the package changed, the runtime reinstalls the new version (or
records the drift) and resumes against the existing work. The card, the desk,
the accepted artifacts, the submissions and the kanban tasks all survive a
toolset change. Coupling resume-correctness to `package_digest` equality is the
same class of mistake as coupling a gate's read to transient task identity: it
treats an ancillary identity (which tools; which worker) as if it owned the
work, when the workplace owns the work.

(In practice today this is mitigated by clearing stale installations before
resume so the new digest installs cleanly. The deeper fix is for the runtime to
tolerate a digest change on resume — reinstating the installation rather than
rejecting the resume — and record the drift for audit.)

## Why Discovery is permissive (the market is the real gate)

A user who enters a hypothesis into the conveyor wants to see it built — **even
if the conveyor's own assessment judges the idea weak**. Discovery is an
idea-strength gate, not a build gate: its job is to record how strong the idea
looks (go / clarify / reject / defer / inconclusive / failed) into the discovery
certificate, **not** to block the conveyor.

The reasoning is product-level: **the only real validation of an idea is the
market.** An expert assessment that "this idea is bad" is itself a hypothesis —
it can be wrong, and history is full of ideas experts dismissed that succeeded.
The conveyor must not impose that judgement as a hard block, because doing so
privileges one assessor's opinion over the market's verdict.

So every Discovery outcome forwards to Formalization. The strength of the idea
travels in the certificate (so downstream stages know the assessed risk), but it
never terminates the run. Formalization is the conveyor's real go/no-go gate:
it reasons about whether a *contract* can be built from the idea, and its
non-formalized outcomes terminate there — but even that is about buildability,
not about whether the idea is "good".

The strict-gate variant (non-go Discovery terminates) survives as a separate
declarative scenario package (`LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT`) for
regulated/contractual environments where an explicit go/no-go gate is legally
required. The production lifecycle is permissive by default.

## How this is enforced (CGAD P18)

- **Card reuse:** `LmNodeExecutor` computes the generationKey WITHOUT a
  per-recovery-attempt suffix, so `ensureNodeExecutionPlan` reclaims the
  workplace's existing card. (`lm-node-executor.ts`)
- **Desk stability:** the workspace directory is keyed by the **node**
  (`executions/node-<nodeId>/`), so drafts survive across workers.
  (`pinned-workspace-materializer.ts`)
- **Stable node-input hash:** the workplace's identity hash excludes the
  transient recovery loop input, so the reused card's reserved metadata compares
  equal across attempts. (`saga-board-adapter-data-builder.ts`)
- **Durable product reads:** kernel gates read managed productions by durable
  node-scope (processRunId + moduleRef + nodeId), never by transient task.
  (`formalization-installation.ts`)

Per-attempt **audit** is preserved orthogonally: each repair round records its
own `NodeRun` (keyed on process_run + node + attempt), independent of task
identity.

## Analogy key (the words we use)

- **конвейер** = the Saga runtime (orchestrator + executors + persistence)
- **цех** = a process module (discovery / formalization / development / delivery)
- **место** (workplace) = a node in a ProcessRun
- **рабочий** (worker) = an LM execution (one task, one execution fence)
- **инженер** (engineer) = a kernel node (the verifier)
- **карточка** (card) = the projected task row
- **стол** (desk) = the execution workspace directory
- **скилл** = the execution profile / semantic skill of a workplace
