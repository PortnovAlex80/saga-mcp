from pathlib import Path

root = Path('.')

matrix_path = root / 'docs/saga3/D5-TEST-MATRIX.md'
s = matrix_path.read_text(encoding='utf-8')
s = s.replace(
    "- **smoke** — Stage 6 live engine/service run on the real LM (A,B) or controlled\n>   live-DB (C,D,E).",
    "- **smoke** — live LM evidence for A/B and controlled end-to-end or integrity evidence for C/D/E.\n> - **integrity** — adversarial checks of frozen-case, lineage, replay and accepted-report verification.",
)
marker = (
    "The exact test names may evolve slightly during implementation; the invariant +\n"
    "scenario columns are the contract.\n\n---\n"
)
final_status = """The exact test names may evolve slightly during implementation; the invariant +
scenario columns are the contract.

## Final executable status

The original A–H rows remain the planning trace. The final executable suite is
larger because the independent review added a shared certificate-bundle suite,
integrity attacks and a controlled end-to-end REJECT smoke.

| File | Tests | Result |
|---|---:|---|
| `d5-certificate-bundle.test.mjs` | 10 | pass |
| `d5-diagnosis-case.test.mjs` | 10 | pass |
| `d5-diagnosis-validator.test.mjs` | 23 | pass |
| `d5-diagnosis-persistence.test.mjs` | 13 | pass |
| `d5-diagnosis-service.test.mjs` | 8 | pass |
| `d5-diagnosis-engine.test.mjs` | 11 | pass |
| `d5-adversarial.test.mjs` | 10 | pass |
| `d5-diagnosis-integrity.test.mjs` | 5 | pass |
| `d5-controlled-reject-smoke.test.mjs` | 1 | pass |
| **Focused runtime total** | **91** | **91 pass / 0 fail** |

The D5 architecture-boundary file adds 11 static checks. The repository-wide
Node.js 24 gate is 701 total, 700 pass, 0 fail and 1 pre-existing todo.

---
"""
if marker not in s:
    raise RuntimeError('D5 matrix final-status marker missing')
s = s.replace(marker, final_status, 1)
s = s.replace(
    "| A3 | I3 | reject agreement snapshot | worker+advisor reject → `worker_advisor_agreement` condition `passed`; the negative conditions that WOULD fail a go are `not_applicable` | `d5-diagnosis-case.test.mjs` | `D5 case: reject agreement represented correctly` | pure |",
    "| A3 | I3 | reject agreement snapshot | exact policy trace contains contributing passed REJECT predicates; GO branch predicates are `not_evaluated` and cannot be cited as causes | `d5-diagnosis-case.test.mjs` | `D5 case: reject agreement represented correctly` | pure |",
)
s = s.replace(
    "| B9 | §8 | passed condition as root cause | a cause cites a `failed_condition_id` whose condition is `passed` ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: passed condition as root cause rejected` | pure |",
    "| B9 | §8 | invalid condition grounding | a cause cites a non-contributing or wrong-branch `cited_condition_id` ⇒ rejected | `d5-diagnosis-validator.test.mjs` | final validator grounding tests | pure |",
)
h_marker = "\n---\n\n## H. Smoke scenarios (§20 — Stage 6)"
integrity = """

---

## G2. Independent integrity correction tests

| # | invariant | attack | expected | file | evidence |
|---|---|---|---|---|---|
| I-1 | I3,I4 | frozen case changed while stored hash is unchanged | atomic submit rejects before persistence | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-2 | I3,I4 | case and case hash coherently changed to expand allowlist | independent task/control anchors reject | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-3 | I3,I7 | stored control case drifts from the freshly rebuilt verified certificate bundle | `ensureDiagnosisControl` fails closed | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-4 | I3 | contract, task, authority or lifecycle status drifts | atomic submit rejects | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-5 | I3,I4,I7 | accepted report schema/control/task/target or payload+hash is coherently tampered | accepted-report verifier rejects | `d5-diagnosis-integrity.test.mjs` | integrity |

The persistence/adversarial suites additionally verify that replay re-derives the
verdict from the verified frozen case and rejects a stored row whose verdict,
validation errors or target binding no longer agree.

---

## H. Smoke scenarios (§20 — Stage 6)"""
if h_marker not in s:
    raise RuntimeError('D5 matrix smoke marker missing')
s = s.replace(h_marker, integrity, 1)
s = s.replace(
    "| S-C | I1 | worker reject + advisor reject → reject → diagnosis | outcome stays reject; blocking causes non-empty; reconsideration conditions described. **Deterministic coverage** — the LM does not reject the trivial smoke product (same constraint as D4 Smoke C), so the REJECT diagnosis path is covered by validator B12 (reject without blocking cause rejected) + case builder A3 (reject agreement decomposition), not by a live run | `D5-SMOKE-EVIDENCE.md` | deterministic (validator + case) |",
    "| S-C | I1,I3,I7 | coherent worker reject + advisor reject → real D4 REJECT certificate → real D5 diagnosis | accepted advisory report cites contributing passed REJECT conditions; D4 artifacts remain byte-identical; restart returns same report without respawn | `d5-controlled-reject-smoke.test.mjs`, `D5-SMOKE-EVIDENCE.md` | controlled end-to-end |",
)
coverage_start = s.index('## Coverage summary')
s = s[:coverage_start] + """## Coverage summary

Final executable evidence:

- certificate-bundle verification: 10;
- diagnosis case/policy trace: 10;
- deterministic validator: 23;
- persistence and atomic replay: 13;
- service lifecycle/restart: 8;
- engine integration/isolation: 11;
- adversarial attacks: 10;
- independent integrity correction: 5;
- controlled end-to-end REJECT smoke: 1;
- D5 architecture boundaries: 11 static checks.

The focused runtime suite is **91/91** across 9 files. Architecture boundaries,
TypeScript and the full repository suite are separate gates. The final Node.js
24 repository run is **701 total / 700 pass / 0 fail / 1 todo**.

Smoke evidence classification:

- A and B: live LM;
- C: controlled end-to-end D4 → D5 REJECT;
- D: controlled invalid-evidence attack;
- E: durable restart reuse.

The matrix no longer treats validator A3/B12 as a substitute for Smoke C.
"""
matrix_path.write_text(s, encoding='utf-8')

todo_path = root / 'docs/saga3/D5-TODO.md'
t = todo_path.read_text(encoding='utf-8')
start = t.index('## Final state')
end = t.index('\n---\n', start)
summary = """## Final corrected state — independent review complete

The original seven implementation stages remain below as historical trace. An
independent review then found four integrity/causal defects and one evidence gap.
Those defects are now corrected without starting D6.

| Correction | Result |
|---|---|
| exact D4 policy evaluation trace | GO/CLARIFY/REJECT explanations cite only contributing conditions; alternative branches are `not_evaluated` |
| shared certificate-bundle verification | D4 replay/recovery and D5 case construction use one full verifier |
| atomic kernel-owned diagnosis verdict | handler cannot declare acceptance; repository validates the verified frozen case inside `BEGIN IMMEDIATE` |
| accepted-report/replay verification | restart, post-worker and replay paths re-hash, re-bind and re-validate before projection |
| coherent case/allowlist drift protection | fresh bundle case, control, task metadata and authority anchors must agree |
| controlled REJECT smoke | real D4 REJECT certificate → real D5 accepted advisory report → byte-identical D4 artifacts → restart reuse |

**Final gates on Node.js 24 / Ubuntu 24.04:**

- `npx tsc --noEmit`: pass;
- architecture boundary gate: pass;
- focused D5 runtime suite: **91/91** across 9 files;
- full repository suite: **701 total / 700 pass / 0 fail / 1 todo**;
- forbidden files absent from PR change set;
- D6 not started.

The single todo is the pre-existing non-D5 `track(reject)` case.

**Independent reviewer state:** D5 implementation and evidence are corrected;
the branch is eligible for final squash-merge after the final documentation CI
run. This summary does not start D6 and does not alter D4 authority.
"""
t = t[:start] + summary + t[end:]
todo_path.write_text(t, encoding='utf-8')

audit = """# D5 Independent Review Audit

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
"""
(root / 'docs/saga3/D5-REVIEW-AUDIT.md').write_text(audit, encoding='utf-8')
