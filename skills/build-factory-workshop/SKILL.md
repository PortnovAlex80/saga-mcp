---
name: build-factory-workshop
description: Design, implement, or review a Factory workshop as declarative Production Cells over the universal Workplace, CandidateSet, GateDecision, recovery, and Flow mechanisms. Use when adding a workshop, converting an LM workflow into factory cells, introducing fan-out/review/tool use, or checking that module-specific orchestration has not leaked into the kernel.
---

# Build Factory Workshop

Build workshops as data and packaged knowledge. Never create a dispatcher,
status machine, acceptance shortcut, workspace engine, or resume mechanism for
one workshop.

## Establish the product boundary

For every LM-produced product, write down:

- accepted upstream product bindings used as inputs;
- output binding, schema, media type, and cardinality;
- stable identity of one unit of work;
- author skill and closed capability preset;
- deterministic checks and semantic review expectations;
- repair target, attempt budget, and exhausted outcome;
- downstream event emitted only after the final gate accepts.

Treat code, prose, plans, reviews, and verdicts alike: each is text produced by
an LM. Tool calls are structured requests executed by platform providers. File
writes, tests, Git and external APIs are effects and evidence, not alternative
orchestration semantics.

## Choose cell shape

Use a singleton cell when one accepted input produces one product. Use fan-out
when an accepted upstream binding contains stable items. Derive each `workKey`
from an immutable item identifier, never array position, worker, attempt, PID,
or current time.

Declare a reviewer only when independent semantic judgement is required. With
no reviewer, make the author gate final. With a reviewer, keep author and
reviewer executions inside the same Workplace control loop; a proven defect
returns the same Workplace to its declared repair role.

## Assemble the declaration

Create a `production-cell` Flow node whose `ProductionCellDefinition` provides:

1. `inputSelectors` resolving exact accepted ProductRefs;
2. `materialization` with source binding, work-key selector, and completion
   policy;
3. author and optional reviewer role profiles;
4. output product contracts;
5. author and final CheckPlans;
6. bounded recovery policy;
7. typed accepted, human-required, and failed transitions.

Package skills, schemas, workspace templates and capability presets with the
module. The core may interpret these generic contracts but must not recognize
the workshop name, task kind, product schema, or business vocabulary.

## Preserve authority and provenance

Require the normal chain for every accepted output:

`WorkIntent -> fenced WorkerExecution -> ProductRef -> sealed CandidateSet -> CheckRun evidence -> GateDecision -> Workplace transition`

Only the core executes effects and transitions. A worker may propose products
and request tools; it cannot set `accepted`, `done`, a cursor, or a fence.
Test/mock modes may replace LM generation and selected expensive checks, but
must retain work identity, provenance, fencing, transition legality, review
integrity, audit events, and the non-production eligibility boundary.

## Validate before handoff

Verify all of the following:

- retry materializes no duplicate Workplace for a stable `workKey`;
- crash after product submission resumes from durable state without regenerating
  an accepted product;
- fan-out completion obeys the declared `all`, `any`, or `quorum` policy;
- the workspace contains exact inputs, skills, allowed tools, and prior gate
  findings on repair;
- CandidateSet membership is immutable and the final GateDecision binds its
  exact digest and execution fence;
- module code contains declarations and handlers only, while generic runtime
  code contains no module vocabulary;
- a clean full mock follows the same path as production and leaves inspectable
  traces for each transition and rejection.

Reject any design that makes a workshop work by manually editing artifacts,
tasks, acceptance flags, cursors, or database rows.
