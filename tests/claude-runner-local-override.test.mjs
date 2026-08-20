/**
 * Local claude-CLI override guard (directive 2026-08-20).
 *
 * The opencode migration made the claude CLI executor forbidden
 * (FACTORY_CLAUDE_BACKEND_FORBIDDEN, cost-driven). The operator may bring
 * claude back for LOCAL runs: the guard must allow the claude CLI only when
 * BOTH (a) the run explicitly set SAGA_ALLOW_LOCAL_CLAUDE_CLI=1 and (b) the
 * execution's claim-time frozen route is the lmstudio backend — such a worker
 * gets ANTHROPIC_BASE_URL env-injected from the frozen local endpoint and
 * physically cannot reach Anthropic. Everything else — missing flag, cloud
 * agent-proxy route, plain claude-cli route, no route — must stay forbidden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { localClaudeCliOverrideAllowed } from '../tracker-view/claude-runner.mjs';

const FLAG = { SAGA_ALLOW_LOCAL_CLAUDE_CLI: '1' };
const NO_FLAG = {};

function assignment(route) {
  return { execution_context: { model_route: route } };
}

const LMSTUDIO_FROZEN = {
  provider: 'lmstudio',
  model: 'qwen/qwen3.6-35b-a3b',
  endpoint: { backend: 'lmstudio', base_url: 'http://localhost:1234/v1' },
};
const AGENT_PROXY_FROZEN = {
  provider: 'zai',
  model: 'glm-4.7',
  endpoint: { backend: 'agent-proxy', base_url: null },
};
const LEGACY_CLAUDE_ROUTE = { provider: 'zai', model: 'opus', endpoint: null };

test('flag + frozen lmstudio route → override allowed', () => {
  assert.equal(localClaudeCliOverrideAllowed(assignment(LMSTUDIO_FROZEN), FLAG), true);
});

test('frozen lmstudio route without the flag → forbidden', () => {
  assert.equal(localClaudeCliOverrideAllowed(assignment(LMSTUDIO_FROZEN), NO_FLAG), false);
});

test('flag + agent-proxy (cloud opencode) route → still forbidden', () => {
  assert.equal(localClaudeCliOverrideAllowed(assignment(AGENT_PROXY_FROZEN), FLAG), false);
});

test('flag + legacy claude-cli route without lmstudio backend → still forbidden', () => {
  assert.equal(localClaudeCliOverrideAllowed(assignment(LEGACY_CLAUDE_ROUTE), FLAG), false);
});

test('flag + provider=lmstudio with no frozen endpoint (pre-C-1 row) → allowed', () => {
  // Legacy rows carry the provider but no endpoint; the runner resolves the
  // backend to lmstudio from the provider in that case, so the override
  // matches the same condition the spawn path will use.
  assert.equal(
    localClaudeCliOverrideAllowed(assignment({ provider: 'lmstudio', model: 'qwen/x' }), FLAG),
    true,
  );
});

test('flag + no execution_context at all → forbidden (fail closed)', () => {
  assert.equal(localClaudeCliOverrideAllowed({}, FLAG), false);
  assert.equal(localClaudeCliOverrideAllowed(undefined, FLAG), false);
});

test('wrong flag value is not an opt-in', () => {
  assert.equal(
    localClaudeCliOverrideAllowed(assignment(LMSTUDIO_FROZEN), { SAGA_ALLOW_LOCAL_CLAUDE_CLI: 'true' }),
    false,
  );
  assert.equal(
    localClaudeCliOverrideAllowed(assignment(LMSTUDIO_FROZEN), { SAGA_ALLOW_LOCAL_CLAUDE_CLI: '1', SAGA_REAL_CLAUDE_PATH: 'claude' }),
    true,
  );
});
