# Saga4 Factory — canonical launch quickstart

This is the short operator instruction for a real Saga4 Factory run. The
author/reviewer workers use the configured real Claude/GLM route. This is not a
mock or hybrid run.

## 1. Build

```powershell
npm run build
```

## 2. Set the required composition

`factory.mjs` is the launch command, but the lifecycle runtime must also be
given an explicit composition module. The composition wires infrastructure
providers; it does not replace the LLM worker.

```powershell
$env:SAGA_PRODUCT_LIFECYCLE_COMPOSITION =
  (Resolve-Path 'tracker-view/product-delivery-composition.mjs').Path
$env:SAGA_FACTORY_CONCURRENCY = '2'
$env:SAGA_FACTORY_CHECKPOINT_LOGS = '1'
```

The tracker composition is a safe local-dry-run Delivery profile. Discovery,
Formalization and Development use real workers. Delivery never fabricates a
publication or release receipt; it fails closed or requests approval.

## 3. Start a new isolated Factory

Use a fresh sandbox path. `factory.mjs` provisions the Git repository, project,
epic, Factory Order and durable launch request.

```powershell
$root = (Resolve-Path '.factory-sandboxes').Path + '\my-factory-run'
$db = Join-Path $root 'factory.sqlite'
$env:SAGA_FACTORY_CHECKPOINT_STORE = Join-Path $root 'checkpoints'

node scripts/factory.mjs start $db `
  'Build an accessible single-page counter with keyboard support and local persistence.' `
  --model glm-4.7 `
  --sandbox $root
```

For a new run on an existing Project, omit `--sandbox` and point at its DB. Do
not write launch rows manually and do not reset production tables.

## 4. Observe the correct database

`factory.mjs` starts the engine, not the tracker UI. Start a tracker against the
same DB on a free port:

```powershell
$env:DB_PATH = (Resolve-Path $db).Path
$env:PORT = '4331'
node tracker-view/tracker-view.mjs
```

Open:

```text
http://localhost:4331/?project=1
```

Never assume that `localhost:4321` points at the current run. Verify the page
title/DB identity and the database path.

## 5. What healthy progress looks like

Between worker cycles, `LifecycleRun.status=paused` can mean a durable wait, not
a stopped factory. Check all of these together:

- active WorkerExecution has a fresh heartbeat and progress timestamp;
- its lease is valid and `stuck_state=active`;
- the current Workplace is `in_progress/running` or `review_in_progress/running`;
- author completion creates a CandidateSet, then a GateDecision is evaluated;
- reviewer work is a separate fenced execution;
- only final acceptance creates a ReplayCapsule.

## 6. Inter-stage validation checklist

After Discovery, verify the next ProcessRun input contains the exact certificate
ref and hash. After Formalization, verify the exact Solution Contract and frozen
acceptance baseline. Before Development, verify the repository base commit and
package installation pin. Before Delivery, verify the integrated candidate hash
and explicit release authorization/deferred profile.

Products are content-addressed. Consumers must use exact ProductRefs, not
`latest` task output.

## 7. Replay capsules

Capsules are created only from a final accepted CellFinalAcceptance. A worker
exit or a raw `accepted` check is insufficient. Reviewed cells should produce
separate author and reviewer capsules. Replay creates new current CandidateSets
and gates; it never restores old Workplace state or external-effect receipts.

## 8. Resume

For an interrupted run, use the canonical resume command against the same DB:

```powershell
$env:SAGA_PRODUCT_LIFECYCLE_COMPOSITION =
  (Resolve-Path 'tracker-view/product-delivery-composition.mjs').Path
node scripts/factory.mjs resume $db
```

Resume continues the same LifecycleRun. An intentional new start creates new
run identities and may reuse semantically compatible replay capsules.

If incident triage proves that the current Workplace is `blocked/paused`
because submission-preflight rejections exhausted the worker-attempt budget,
plain resume is intentionally insufficient. After taking and verifying a
checkpoint, use the explicit one-attempt recovery directive:

```powershell
node scripts/factory.mjs resume $db --requeue-paused
```

This narrow command re-runs the node's declared validator when historical
feedback predates the durable rejection ledger, records exact recovery
feedback, verifies the artifact/file snapshot and absence of active actors,
persists a single-use operator authorization, then requeues by Workplace CAS.
It refuses already completed/gated work and does not accept any artifact.

## 9. Evidence files

For an observed run, keep a stage report and bug list beside its isolated DB:

- `FACTORY-RUN-REPORT.md` — stage outcomes and exact handoffs;
- `FACTORY-BUGS.md` — runtime, UI and documentation defects.

Do not silently edit worker instructions or reset the DB while a run is active.

## 10. If the factory appears stopped

Treat it as an incident when all of the following are true:

- LifecycleRun is `paused` at the same node;
- the Workplace is `blocked/paused` or `repair_wait`;
- no WorkerExecution has a live lease;
- the projected task has no `current_execution_id`;
- no new CandidateSet/GateDecision appears across several host cycles.

Preserve the DB, worker JSONL logs, execution workspaces, and latest checkpoint.
Do not immediately resume: first identify the last rejected MCP call and check
whether a durable RecoveryIssue/RecoveryCase and feedback file were created.
If the only durable error is “exited without terminal worker_done”, inspect the
worker log for an earlier rejected `worker_done`; otherwise a domain validation
failure may have been collapsed into a generic lost-worker state.
