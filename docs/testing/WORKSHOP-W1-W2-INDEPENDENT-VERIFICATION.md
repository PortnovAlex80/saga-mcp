# WORKSHOP W1/W2 — independent verification of the 2026-08-15 analysis

Verification target: `saga4@423aa2b97f1e2ab131e045ce59256fedfc8d61fb`.

This note verifies claims in `WORKSHOP-W1-W2-ANALYSIS-REPORT.md` against the committed test documentation and current production code. It does not claim to reproduce the local testbed: `.factory-testbed` DB/logs and the harness scripts are not committed in this snapshot, and GitHub exposes no CI status for commit `423aa2b9`.

## Verdict

### W1

Supported by the committed STATUS/JOURNAL:

- all 20 unique project IDs P01-P20 reached a W1 pass state;
- W1->W2 was recorded as GO;
- the journal spans roughly 07:15-08:45 UTC, so the reported ~90 minute round wall-clock is plausible.

Qualification:

- the W1 journal contains duplicate attempt rows for P03 and P04, so `20/20` means 20 unique projects reached pass, not exactly 20 execution attempts;
- the blind-review arithmetic in the original report was wrong. The 14 recorded scores sum to 303, therefore the mean is `303 / 14 = 21.64/25 = 86.6%`, not 21.8/25 (87%). `W1-BLIND-REVIEW.md` is corrected in the accompanying fix branch.

### W2 status

The committed STATUS/JOURNAL corroborate P01-P07 as of their timestamps:

- P01, P03, P04, P05, P06 pass;
- P02 fail with `FORMALIZATION_ACCEPTANCE_HASH_DRIFT`;
- P07 fail at `freeze-acceptance-baseline`.

The later P08-running state appears in the analysis report but not in the older STATUS/JOURNAL snapshots, so it should be treated as an observation from the local testbed, not independently proven by the repository snapshot.

The report also says build was clean and 16/16 new regression tests were green on `4f6c9190`. GitHub has no status checks attached to `423aa2b9`, so that statement cannot be independently verified from GitHub and remains operator-local evidence.

## TB-8 — CONFIRMED engine contract bug

The corrected TB-8 diagnosis is correct and no longer a hypothesis.

The accepted document heading cited by the report is compatible with the intended identifier:

`AC-NFR-1.1`

but the canonical Formalization parser used:

`AC-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*`

which rejects a hyphen inside a segment. Development independently duplicated the same narrow grammar in its verification-method reader. Therefore the same product could fail first in W2 baseline freeze or later in W3 verification adoption.

Fix in branch `agent/fix-tb8-ac-code-grammar`:

- Formalization accepts `AC-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*`;
- Development accepts the same grammar;
- parser regression covers `AC-NFR-1.1`;
- architecture ratchet prevents the narrow grammar from returning.

Severity correction: by the bug registry's own definition, P07 is S1 because the run terminated failed. Data integrity was preserved by fail-closed behavior, but that does not make a terminally dead run S2 under the stated scale.

The suggested early heading/code check before the terminal kernel freeze is still useful hardening, but it is not required to explain or fix this incident. The regex mismatch alone is sufficient.

## TB-6 — symptom confirmed, root cause NOT yet proven

Confirmed:

- `formalization-accept-products-effect.ts` reads the exact sealed product snapshot and compares its artifact content hash to the current mutable `artifacts.content_hash`;
- on mismatch it throws `FORMALIZATION_ACCEPTANCE_HASH_DRIFT`;
- this is intentional fail-closed behavior: a mutable row is forbidden from silently substituting different material after sealing.

Not yet proven:

- that the 09:34:16 mutation was performed by the claimed repair execution after that execution had semantically submitted;
- that the primary bug is specifically a 49-second gate/repair race;
- that the acceptance effect should return `repair_required` instead of failing the invariant.

Why the current causal claim is too strong: managed artifact writes are recorded through `recordManagedArtifactProduction`, which resolves provenance with `requireLiveProducer: true`; the producer's `worker_executions.state` must still be `running`. An `artifacts.updated_at` timestamp by itself therefore does not identify which execution owned the write or prove that a terminal worker mutated after submission.

Evidence required before changing production behavior:

1. for artifact 37, read every `factory_managed_artifact_productions` row around 09:32-09:35 including `execution_id`, `task_id`, `content_hash`, operation and `recorded_at`;
2. join those execution IDs to `worker_executions` and reconstruct running/exited/lost timestamps;
3. resolve CandidateSet #1/#2 to their exact `WorkplaceProductionRevision` members and hashes;
4. resolve the GateDecision subject for each accepted gate;
5. identify the exact writer that produced the content hash observed at 09:34:16.

Until this is done, keep TB-6 open as a provenance/race hypothesis. Do not weaken `FORMALIZATION_ACCEPTANCE_HASH_DRIFT`: it is currently the component preventing silent acceptance of different material.

## Commit 423aa2b9 scope

The commit is documentation-only and matches the author's scope statement: exactly seven files under `docs/testing/` were added. It did not modify `.gitignore`, `AGENTS.md`, or harness scripts.

## Other report claims

The prediction of another 2-4 W2 failures and the proposed risk concentration on P11/L/XL projects are forecasting hypotheses, not findings. They should not be used as evidence of an architectural defect until later runs support them.
