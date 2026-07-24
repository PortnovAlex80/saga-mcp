# D5 Independent Review Audit

**Date:** 2026-07-25  
**Scope:** final code and evidence after the integrity correction  
**Method:** compare each material claim to executable assertions and CI results,
not to test names or PASS labels.

## Audit result

**AUDIT: no unsupported material PASS claims found in the corrected evidence.**

This verdict supersedes the earlier evidence audit, which missed the mismatch
between the deterministic Smoke C narrative and the actual case-builder state.

## Claims checked

| Claim | Executable evidence | Result |
|---|---|---|
| D4 remains sole outcome authority | engine isolation tests; controlled REJECT smoke compares settlement/certificate rows before and after D5 | supported |
| policy explanation is causal | case/validator tests cover GO passed conditions, CLARIFY failed conditions, REJECT passed negative conditions, wrong branch and non-contributing citations | supported |
| frozen case cannot be silently expanded | integrity tests cover unchanged-hash and coherent case+hash allowlist attacks | supported |
| handler cannot self-authorize acceptance | atomic repository derives verdict from the verified stored case | supported |
| exact D4 certificate target is verified | 10 certificate-bundle tests plus D4/D5 shared verifier use | supported |
| accepted report is not trusted by status label | service/integrity tests cover schema, control, task, target and coherent payload+hash drift | supported |
| replay is idempotent and integrity checked | persistence/adversarial tests re-derive verdict and compare row binding/errors | supported |
| REJECT path works end-to-end | controlled smoke issues a real D4 REJECT certificate and obtains a real D5 accepted report | supported |
| diagnosis failure cannot rewrite D4 result | engine/service failure-isolation tests | supported |
| stage does not advance | engine tests and controlled smoke | supported |

## Gate results

GitHub Actions used Node.js 24 on Ubuntu 24.04 and completed:

- TypeScript: pass;
- architecture boundaries: pass;
- focused D5 runtime tests: 91 pass, 0 fail;
- full suite: 701 total, 700 pass, 0 fail, 1 todo.

The todo is pre-existing and outside D5.

## Evidence limitations

- GO and CLARIFY composition retain the earlier live-LM smoke evidence.
- REJECT is controlled end-to-end, not live-LM. It uses the real D4/D5 services,
  persistence and certificate/report verification with a deterministic worker
  fixture.
- CI proves repository behavior under Node.js 24; an unrelated test-lifecycle
  difference was observed under Node.js 22, which is not the project runtime.

## Forbidden and scope checks

- `nul` is absent from the PR change set.
- `docs/research/CHAIN-WORKING-V2.md` is absent from the PR change set.
- D6 implementation is absent.
- The one-shot correction workflow and payload are removed before merge.

## Verdict

D5 satisfies the corrected integrity, causality, idempotency and evidence gates.
It is eligible for squash-merge into `saga3-discovery`. D6 remains a separate,
explicitly authorized phase.
