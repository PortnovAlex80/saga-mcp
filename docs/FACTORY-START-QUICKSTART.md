# Saga4 Factory — canonical launch quickstart

This is the short operator instruction for a real Saga4 Factory run. The
author/reviewer workers use the configured real Claude/GLM route. This is not a
mock or hybrid run.

## 1. Build

```powershell
npm run build
```

## 2. Composition and runtime controls

`factory.mjs` uses the canonical production composition at
`tracker-view/product-delivery-composition.mjs`. The composition wires
infrastructure providers; it does not replace the LLM worker. Set
`SAGA_PRODUCT_LIFECYCLE_COMPOSITION` only to intentionally override it.

```powershell
# Optional override. scripts/factory.mjs defaults to the canonical production
# composition at tracker-view/product-delivery-composition.mjs and validates it
# before creating or recovering a launch.
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
node scripts/factory.mjs resume $db
```

Resume continues the same LifecycleRun. An intentional new start creates new
run identities and may reuse semantically compatible replay capsules.

Set `SAGA_FACTORY_CONCURRENCY` before both `start` and `resume`. The runtime
uses the durable operator value capped by the canonical model profile and
counts all durable active executions before each new assignment. Lowering the
value never kills active workers; it suppresses replacements until the active
cohort is below the new ceiling.

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

If a run failed after CandidateSet sealing only because the pinned check plan
and runtime provider versions differ, use the separate failed-gate recovery:

```powershell
node scripts/factory.mjs resume $db --recover-failed-gate
```

This is not a general retry. It requires the exact provider-version mismatch,
an unchanged sealed CandidateSet and product hashes, a compatible passed-check
prefix, no GateDecision and no live actors. It preserves the abandoned GateRun
as immutable evidence and never reruns the accepted author or aliases an
obsolete provider version. The two recovery flags are mutually exclusive.

### Continue after a terminal downstream workshop failure

Do not use `resume`, `start`, checkpoint restore, or the legacy stage-reset
script when a terminal run has an exact accepted upstream prefix. Create an
append-only continuation only after its incident-specific adoption evidence
has passed the dry check:

```powershell
node scripts/factory.mjs continue $db `
  --from-lifecycle 1 `
  --adopt-task 15 `
  --scope index.html `
  --scope js/app.js `
  --scope css/styles.css `
  --check
```

`--check` uses a SQLite backup and consumes no live authorization. The real
command is identical without `--check`. It first writes a SQLite backup, then
creates a child LifecycleRun in the same FactoryOrder chain and launches that
child. The failed parent remains terminal and visible. Accepted inherited
stages appear in the pipeline as `inherited`; they have no child StageRuns and
must not start workers again.

The command is intentionally narrow: the parent must have the exact terminal
Development incident, the adopted task must have verifiable acceptance and Git
integration evidence, the repository head must still match, and there must be
no competing active leaf. Any mismatch fails closed.

For a continuation of a failed continuation, `--from-lifecycle` names the
latest failed leaf, not the immutable root. The command verifies and carries
the complete inherited prefix recursively; `factory_orders.lifecycle_run_id`
continues to point at the root. It never forks an older ancestor.

If that leaf failed after an exact author CandidateSet passed its author gate
but before any reviewer CandidateSet/final gate/effect existed, the command may
also create a narrow immutable carry-forward authorization. The child then
creates a NEW current author CandidateSet, runs the CURRENT author gate and
hires a fresh reviewer. The old CandidateSet/decision remain evidence; no old
review verdict or final acceptance is copied. A mismatch in product schema,
item contract, source/base Git identity, failure class or canonical head makes
the carry-forward ineligible and fails closed.

If the latest leaf failed only after final gate + Git EffectReceipt +
CellFinalAcceptance, use that leaf and its current integrated author task as
the adoption source. The dry check must prove the canonical head equals the
recorded effect, the source commit is already an ancestor, and the failure is
the exact post-acceptance projection class. The child does not rerun the author
and the Git provider returns `already-applied`; it still creates current gates
and continues through candidate freeze and verification. Never point the
command back at an older leaf merely because its original baseline still
matches an earlier commit.

Do **not** use the current implementation continuation after the integrated
candidate has already been frozen and only verification/settlement is blocked.
That is a later authority boundary: author carry-forward is inapplicable, and
the current package would materialize a new implementation item. A dry check
returning `authorCarryForwardAuthorizationRef: null` is therefore not launch
permission for the implementation continuation. Use the verification-only
suffix:

```powershell
node scripts/factory.mjs continue <db> `
  --from-lifecycle <latest-terminal-leaf> --verification-only --check
```

Preflight must adopt the exact task graph, implementation workset, frozen
candidate and effect receipts, report no author carry-forward, and recover the
complete hash-pinned verification-method plan. The same command without
`--check` is launchable only when every required executable provider and
authorized-observer receipt is present. Missing manual/visual/screen-reader
authority is `human_required`, not permission to repeat implementation or
manufacture a pass. This rule prevents repeating accepted warehouse
production.

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
