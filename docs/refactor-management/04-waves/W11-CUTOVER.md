# Wave 11 — Product Scenario Cutover Preparation

> Plan §0.14 / Phase 13 preparation. **Status:** 🟡 STAGING.
> Frozen input: latest Wave 10 checkpoint.
> Spec: `09-contracts/WAVE11-CUTOVER-SPEC.md`

## Lanes: A1-A8 parallel + 1 serial cutover commit by integrator.
## Integration: A1→A2→A3→A4→A5→A6→A7→A8, then integrator makes the cutover commit.

## Exit gate: §0.14.11 — new runs use installed scenarios, old runs replay via adapters.

## Serial cutover (§0.14.10): integrator makes ONE commit switching new runs to installed
scenarios. NO legacy code deleted. Both paths coexist.
