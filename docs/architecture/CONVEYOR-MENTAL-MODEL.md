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
