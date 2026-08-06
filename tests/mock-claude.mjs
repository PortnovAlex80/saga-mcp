#!/usr/bin/env node

// Backward-compatible entrypoint retained for existing tests and scripts.
// The old mock was a monolithic always-approve handler. The canonical
// implementation now lives in tools/claude-cli-simulator.mjs and selects a
// deterministic scenario from the exact Saga execution binding.

if (process.env.SAGA_MOCK_DECISION && !process.env.SAGA_SIM_DECISION) {
  process.env.SAGA_SIM_DECISION = process.env.SAGA_MOCK_DECISION;
}

// Historical tests relied on unknown legacy tasks being approved. The new
// simulator fails closed by default; only this compatibility wrapper enables
// the old fallback explicitly.
process.env.SAGA_SIM_ALLOW_GENERIC_APPROVE ??= '1';
process.env.SAGA_SIM_EXIT_ZERO_ON_FAILURE ??= '1';

await import('../tools/claude-cli-simulator.mjs');
