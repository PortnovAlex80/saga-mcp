# ADR-024: Factory checkpoint, exact resume, and provenance-safe adoption

**Status:** Accepted  
**Date:** 2026-08-06  
**Relates to:** ADR-027,
`FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md`, `PARTIAL-RESET-AND-RESUME.md`

## Context

Restarting the engine for the same order can currently leave a paused
`LifecycleRun` untouched unless every caller remembers to send `resume=true`.
At a paused LM node the executor can also launch the worker again even when the
database and repository already contain useful products. The old
`saga4-snapshot.mjs` JSON exporter is not a safe recovery mechanism: its table
list is incomplete, it does not capture artifact bytes, and its project import
path can delete unrelated rows.

The factory needs three deliberately different operations:

- **resume**: continue the unique active run in the same database;
- **checkpoint/adopt**: verify previously captured products and make them an
  explicit input to the same order without pretending an LM produced them now;
- **restore-clone**: reconstruct a complete database and file snapshot at a new
  location for diagnosis or continuation.

## Decision drivers

- No repeated paid LM work when durable accepted or sealed work already exists.
- Fail closed on ambiguous run identity, changed inputs, or changed bytes.
- Preserve execution, product, gate, trace, response, and repository provenance.
- Never merge arbitrary database row IDs into a live database.
- Additive and reversible while Conveyor v4 is still cutting over.

## Considered options and MCDA

Scores are 1 (poor) to 5 (best). Weighted criteria: correctness/auditability
3, factory-model alignment 2, time-to-value 2, reversibility 2, operability 1.

| Option | Correctness | Alignment | Time | Reversible | Operable | Weighted |
|---|---:|---:|---:|---:|---:|---:|
| A. Layered resume + CAS checkpoint + import authority | 5 | 5 | 4 | 5 | 4 | **47** |
| B. Immediate full CandidateSet-only runtime cutover | 5 | 5 | 2 | 2 | 3 | 36 |
| C. Auto-resume plus expanded JSON dump | 2 | 2 | 5 | 4 | 3 | 31 |

## Decision

Choose **A**.

1. `start` auto-adopts the unique `created|running|paused` LifecycleRun for the
   epic and reuses its idempotency key. `restart` always requests resume. More
   than one active run is corruption and blocks launch rather than choosing the
   newest row.
2. A published factory checkpoint is an immutable, content-addressed manifest.
   SQLite is captured with the online backup API; artifact/log/repository files
   are copied by SHA-256; the manifest is written last. Verification rehashes
   every member and runs SQLite integrity and foreign-key checks.
3. Restore is clone-only: the target DB and workspace must not already exist.
4. Adoption is append-only. It verifies checkpoint scope, run input hash,
   artifact bytes and target repository containment, then records a distinct
   `checkpoint_import` authority and imported product bindings. It never edits
   historical worker executions and never creates an accepted gate decision.
   Imported candidates must pass the ordinary gate/runtime path.
5. Definition replay is allowed only with a durable compatibility receipt when
   the executable suffix (entry/current/future stage identity, module refs,
   routes and mappings) is unchanged. Display-only changes are compatible.
6. JSON snapshots must not be used for
   live recovery.
7. Test acceleration has two explicit profiles instead of a weaker hidden
   gate: `checkpoint_replay` skips the LM only in a diagnostic clone and reruns
   the real downstream gate; existing `test-warm-start` runs the real LM with a
   verified prior draft so workdesk/tools/recovery-feedback remain testable.

## Pre-mortem and mitigations

| Failure | Earliest signal | Mitigation |
|---|---|---|
| DB and files captured at different moments | artifact hash differs before/after copy | double-hash; do not publish manifest |
| Imported documents bypass review | adoption appears as accepted output | import authority cannot write gate decisions; gate remains mandatory |
| Wrong run resumed | multiple active rows for an epic | unique lookup, fail closed with an actionable error |
| Code drift silently changes routing | executable suffix differs | structural classifier and append-only compatibility receipt |
| Partial checkpoint looks complete | missing object after crash | CAS writes atomically; manifest and `COMPLETE` marker are last |
| Restore damages production DB | target path already exists | restore-clone refuses overwrite |

## Consequences

Recovery no longer depends on remembering a UI flag, and a checkpoint contains
the database plus the actual bytes referenced by it. Adoption remains auditable
and cannot masquerade as a new LM execution. The design adds storage usage and
requires retention policy later. Until all workshops use v4 CandidateSet as
their runtime authority, adoption is an input/recovery bridge rather than an
excuse to mark a production cell accepted.

## Decision journal

- **Expected:** restarting an order launches the same LifecycleRun and reaches
  its current node without requiring the original input file.
- **Expected:** deleting or changing one captured file makes verification fail.
- **Expected:** importing the same manifest twice is idempotent; a different
  manifest under the same adoption key is rejected.
- **Revisit when:** CandidateSet
  can then become the sole runtime checkpoint authority.
- **Revisit by:** 2026-09-15.
