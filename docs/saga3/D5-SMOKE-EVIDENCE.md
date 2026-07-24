# D5 Smoke Evidence — Advisory Discovery Diagnosis

**Final verification date:** 2026-07-25  
**Branch:** `d5-discovery-diagnosis`  
**Runtime:** Node.js 24 on GitHub Actions / Ubuntu 24.04  
**Focused D5 suite:** 91 tests, 91 pass, 0 fail across 9 files  
**Full suite:** 701 tests, 700 pass, 0 fail, 1 pre-existing todo

Core principle:

```
LM proposes. Advisor assesses. Kernel settles. Certificate proves.
Diagnosis explains.
```

D5 is post-factum and advisory. It explains an already-issued
`DiscoveryOutcomeCertificate`; it does not choose the outcome, mutate the D4
settlement or certificate, change `scopeCompleted`, or advance the stage.

## Verification matrix

| Smoke | Scenario | Evidence type | Result |
|---|---|---|---|
| A | GO explanation | live LM, real diagnosis service and worker | PASS |
| B | CLARIFY explanation | live LM, real diagnosis service and worker | PASS |
| C | REJECT explanation | controlled end-to-end D4 → D5 run | PASS |
| D | invented diagnosis evidence | controlled real validator + atomic persistence | PASS |
| E | restart after accepted diagnosis | real service reuse path, no worker respawn | PASS |

The evidence types are intentionally distinct. A and B demonstrate real LM
composition. C is deterministic and controlled, but it is no longer only a pair
of unit tests: it issues a real D4 REJECT certificate and runs the real D5
service, persistence and projection path. D attacks the evidence boundary. E
proves durable restart reuse.

## Smoke A — GO explanation

A live diagnosis worker explained an existing GO certificate. The accepted
report:

- preserved the D4 decision and certificate;
- returned `diagnosis.status = completed`;
- returned `diagnosis.authority = advisory_diagnosis`;
- created no blocking cause;
- recommended `proceed_with_monitoring`;
- cited only refs from the frozen case allowlist.

This demonstrates that the LM can compose a useful explanation while the kernel
retains acceptance authority.

## Smoke B — CLARIFY explanation

A live diagnosis worker explained a CLARIFY certificate carrying
`CLARIFY_CONDITIONALLY_READY` and `CLARIFY_BLOCKING_GAPS`. The accepted report:

- covered every certificate reason code;
- cited only conditions that contributed to the authoritative decision;
- converted blocking causes into concrete information requests;
- preserved the D4 certificate byte-for-byte.

The earlier false-cause defect is closed: alternative REJECT predicates are no
longer exposed as failed causes of a GO/CLARIFY branch. The diagnosis case now
uses the exact D4 policy evaluation trace.

## Smoke C — controlled end-to-end REJECT

Executable evidence:

`tests/saga3/d5-controlled-reject-smoke.test.mjs`

The test uses a controlled fixture to create coherent negative product and
readiness inputs. It then:

1. invokes the real `Saga3DiscoverySettlementService`;
2. obtains a real D4 settlement with `decision = reject`;
3. obtains a real immutable outcome certificate carrying
   `REJECT_WORKER_AND_ADVISOR_AGREE`;
4. invokes the real `Saga3DiscoveryDiagnosisService`;
5. submits a diagnosis through the real atomic repository boundary;
6. verifies an accepted advisory report grounded in contributing **passed
   REJECT conditions**;
7. verifies that the D4 settlement and certificate are byte-identical before
   and after diagnosis;
8. invokes diagnosis again and verifies the same report id/hash with no worker
   respawn.

This is controlled rather than live-LM evidence. It nevertheless covers the
full D4-authority → frozen case → bounded D5 worker → atomic kernel validation →
engine-facing diagnosis result path. It replaces the previous weaker claim that
case-builder A3 plus validator B12 were sufficient smoke evidence.

## Smoke D — invented evidence is durably rejected

A report citing a source ref absent from `allowed_source_refs` is rejected by the
kernel and persisted as `rejected_by_kernel` with non-empty
`validation_errors`. The D4 certificate remains unchanged.

The correction adds stronger attacks beyond the original smoke:

- frozen case tamper with an unchanged hash;
- coherent case + hash allowlist expansion;
- contract, task, authority and control-lifecycle drift;
- coherent accepted-report payload + hash tamper;
- replay of content whose newly derived verdict disagrees with the stored row.

These are covered by `d5-diagnosis-integrity.test.mjs` and the expanded
adversarial/persistence suites.

## Smoke E — restart reuse

After an accepted diagnosis exists for a certificate target, a second
`diagnose()` call returns the same report id and content hash without spawning a
new worker. Before projection, the service re-verifies:

- the stored frozen case and case hash;
- exact certificate/control/task binding;
- report schema and canonical content hash;
- accepted status and empty validation errors;
- payload target;
- the full deterministic diagnosis validator result.

A stored `accepted_by_kernel` label alone is therefore insufficient to produce
an advisory success.

## Integrity and authority conclusions

The final implementation preserves these boundaries:

- D4 remains the sole outcome authority.
- D5 can write only its control/report records plus its own bounded
  WorkIntent/task lifecycle.
- The handler cannot tell persistence that a report is accepted; the repository
  derives the verdict inside `BEGIN IMMEDIATE` from the verified frozen case.
- D5 builds its case only from the shared full D4 certificate-bundle verifier.
- Policy explanations use the exact D4 evaluation trace, including
  `passed`, `failed` and `not_evaluated` states.
- Restart and replay paths re-verify integrity rather than trusting stored
  status labels.
- The stage remains `discovery`; no automatic repair or D6 transition occurs.

## Final verification

GitHub Actions on Node.js 24 completed all gates successfully:

- TypeScript: pass;
- architecture boundaries: pass;
- focused D5 suite: 91/91;
- full repository suite: 701 total, 700 pass, 0 fail, 1 todo.

The todo is the pre-existing non-D5 `track(reject)` case. The forbidden files
`nul` and `docs/research/CHAIN-WORKING-V2.md` are absent from the PR change set.
