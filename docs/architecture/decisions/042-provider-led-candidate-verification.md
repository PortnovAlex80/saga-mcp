# ADR-042: Provider-led candidate verification

Date: 2026-08-10  
Status: accepted

## Context

Run 6 exposed an authority contradiction. Eight LM verifier Workplaces reached
final `accepted`, while deterministic Development settlement found no
admissible evidence. The verifier payload contract had been repaired, but the
gate still accepted an LM-authored outcome and treated mutable task metadata as
proof that a trusted provider had run.

The accepted Formalization documents contain mixed verification methods:
deterministic checks, browser/storage/UI checks, and manual accessibility or
screen-reader observation. The structured Formalization handoff retained AC
identity and hashes but dropped those method requirements. Development then
materialized generic read-only LM assessment tasks which had neither browser
authority nor an independent executable oracle.

## Decision drivers

- Acceptance authority must not come from the candidate author or verifier LM.
- Every verdict must bind the exact candidate, AC, plan, provider and evidence.
- Missing execution capability must remain `unknown`, never become a pass.
- The design must use the universal CheckPlan/CheckProvider/Gate grammar.
- Completed Discovery, Formalization and integrated Development production must
  remain immutable and reusable through append-only continuation.

## Options considered

Weights: authority 30, method fidelity 25, safe recovery 20, testability 15,
extensibility 10. Scores are 1–5; totals are out of 500.

| Option | Authority | Fidelity | Recovery | Testability | Extensibility | Total |
|---|---:|---:|---:|---:|---:|---:|
| LM-only verification | 1 | 2 | 2 | 2 | 3 | 180 |
| Deterministic-only checks | 5 | 3 | 4 | 5 | 4 | 440 |
| Provider-led hybrid | 5 | 5 | 4 | 4 | 5 | 470 |

Deterministic-only checking cannot honestly satisfy accepted manual or real
screen-reader methods. LM-only checking cannot establish independent facts
about browser, storage or external state. The provider-led hybrid is selected.

## Decision

Verification is an obligation plan executed by capability providers:

1. Formalization freezes a versioned `VerificationMethodPlan` per obligation.
2. Development binds each check request to the exact integrated candidate,
   accepted AC hash, plan digest, provider digest and environment digest.
3. Sandboxed deterministic providers execute supported checks and emit
   immutable evidence plus `CheckReceipt`s.
4. Manual or subjective obligations require an `authorized_decision` observer
   receipt. They are not silently delegated to an LM.
5. An LM may explain receipts, identify limitations and submit a typed
   assessment, but cannot assert provider trust or the authoritative outcome.
6. Kernel settlement derives the verdict only from exact accepted GateDecisions
   and admissible immutable receipts. Missing receipt is blocked; failed receipt
   is rework; provider error or unavailable environment is indeterminate.

The payload decoder contract is frozen into the WorkIntent by exact id, version
and canonical definition digest. Ambient registry state is only an
implementation lookup and cannot reinterpret durable work.

`CheckProvider` may return evidence references with its outcome. Receipt
identity binds the GateRun, subject/assessment CandidateSets, provider,
environment, outcome and evidence refs. Replaying the same receipt ref with a
different digest is rejected.

This is universal factory physics. Core code does not branch on Development,
Git, a concrete AC, or a browser implementation.

## Immediate safety rule

Until an executable candidate-check provider and preserved method plan are
installed, the Development v2 LM assessment check returns `unknown`. Its plan
maps indeterminate capability to `human_required` rather than spending worker
retry budget or manufacturing acceptance.

## Recovery

Run 6 and `dev=805c95e89a1be1b6cb0c1661411ca2d588988e8f` remain immutable.
A later append-only continuation starts at Development, adopts the exact
integrated candidate/effect evidence, creates no Discovery or Formalization
StageRuns, executes current provider receipts, settles Development and only
then enters Delivery. Operator diagnostics and old LM pass claims remain
advisory fixtures, not current acceptance authority.

## Premortem and mitigations

- **Provider is registered but incapable.** Require category, full
  determinism/capability, active scope, exact version and evidence refs.
- **Receipt is rebound to another candidate.** Bind subject set, candidate/AC
  plan parameters and environment in the immutable digest.
- **Ambient package changes decoder semantics.** Pin payload contract identity
  and canonical definition in WorkIntent plus the module installation digest.
- **Manual checks are auto-passed.** Require an authorized observer receipt;
  absence remains blocked.
- **Provider crashes after observation.** Read-only checks are rerunnable;
  immutable receipt replay must either match exactly or fail closed.
- **Old LM evidence enters settlement.** Settlement reads Gate receipts, not
  payload outcome or task metadata.

## Consequences

The factory may pause honestly when a required check capability is absent.
That is reduced apparent throughput but increased business correctness. The
same receipt protocol can later support browser, compiler, security, publish
and deployment observation without adding another worker engine.

