# W10-01 — Frozen Clean GLM-4.7 Acceptance Run Profile

> The deterministic, repo-side configuration of the real-model acceptance run.
> W10-02 (Operator + Integrator) LAUNCHES exactly this profile against the real
> GLM-4.7 endpoint. Nothing in W10-02 may change these frozen parameters; a
> deviation requires a new frozen profile (a new W10-01).

## Model identity

- **Model:** GLM-4.7 (the Factory acceptance model; matches the active factory
  `mars-venus-e2e-*` runs).
- **Inference backend:** the `claude` CLI launched by the Factory's production
  worker executor (`SAGA_CLAUDE_PATH`), configured by the OPERATOR to route to
  GLM-4.7. The exact endpoint/credentials are operator-side and are confirmed
  BY THE OPERATOR at W10-02 launch (they are intentionally NOT in this repo).

## Concurrency cap (frozen)

- **Effective worker concurrency: ≤ 2.** Enforced by the Factory concurrency
  policy (`readConcurrencyAdmission`). This is the finish-line cap ("GLM-4.7
  effective concurrency ≤ 2", FACTORY-E2E-STABILIZATION-TRACKER). No swarm.

## Run scenario (frozen)

- **Lifecycle:** `product-build@1.2.0` — the educational "Mars or Venus" ballistic
  mission calculator (the Factory acceptance product).
- **State:** FRESH — a new DB (`DB_PATH`), fresh repository; no carry-over from
  prior runs.
- **Inference:** REAL GLM-4.7 (not scripted). The W9 scripted harness proved the
  deterministic runtime path; W10 proves the real-inference path on the SAME
  runtime.
- **Authority:** no authority hacks — the `AUTHORITY_TABLES` no-write guarantee
  holds; the C5 head-binding, C7 fencing, and LR-07 local-ready receipt binding
  are all active. Terminal `verified` REQUIRES a passed local-readiness receipt
  for the exact sealed candidate.

## Acceptance criteria for W10-02 (the operator launch)

The run is ACCEPTED only if ALL hold:
1. The cohort converges to **runnable-local**: Development `verified` WITH a
   passed `factory.local-runnability.v1` receipt for the exact sealed candidate.
2. Effective concurrency observed ≤ 2 (durably, in the run log).
3. Model identity observed = GLM-4.7 (durably).
4. No authority hacks (no manual SQL to authority tables; `AUTHORITY_TABLES`
   guard green in the post-run inspection).
5. The locally produced product builds, starts, and is probeable on loopback,
   then shuts down cleanly.

## DFX budget for W10-02

- 3 reserved DFX slots remain (W9 consumed 0). Each live defect in the real run
  consumes ONE slot (regression test + fix) and returns to the failed acceptance
  task.
- **Hard stop:** after 3 consumed DFX slots without W10 success → W12-03 becomes
  a documented **no-go** (the plan is not expanded).

## Exit rule (W10-01)

Endpoint/model identity and worker cap are observable durably (model = GLM-4.7 by
operator config; cap ≤ 2 by concurrency policy). The operator confirms the live
endpoint at W10-02 launch. Nothing blocks freezing this profile.
