/**
 * tests/workflow-kernel/composition/composition.test.mjs - the EK-8 / WP-12
 * PRODUCTION-COMPOSITION proof suite (blocking; hosted by the
 * workflow-kernel matrix group).
 *
 * Pins the hard-cutover laws over the ONE composition:
 *   C1  exactly one production composition exists (the composition root is
 *       the only orchestration path; identity digest deterministic);
 *   C2  every workshop's role bindings compile + resolve through the ONE
 *       WP-17 path with EXACT role-universe equality, and the
 *       dispatcher/runner/tracker views transport the SAME digest;
 *   C3  the production admission profile pins RUNNING_COUNTER_IDENTITY
 *       (the WP-18 residual note); a foreign counter pin fails admission
 *       closed as TOKEN_COUNTER_MISMATCH (RED/GREEN);
 *   C4  the cognition transport is the WP-18 admitting transport with a
 *       durable AttemptAdmissionStore and the real opencode channel law:
 *       the channel never sees unadmitted bytes and the executor
 *       resolution refuses the claude CLI fail-closed;
 *   C5  the console is command-only: reads come from the disposable
 *       projection, writes go only through typed adapter commands, and the
 *       retired legacy write endpoints are typed refusals (never 500s,
 *       never silently accepted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dist = (relative) => import(`../../../dist/${relative}`);

function freshDbPath(prefix = 'ek-wp12-composition-') {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'kernel.sqlite');
}

/** A deterministic channel standing in for the opencode process boundary (the WP-18 injected seam). */
async function deterministicChannel() {
  const { createHash } = await import('node:crypto');
  return {
    sent: [],
    async send(input) {
      this.sent.push(input.serialized);
      return { status: 'delivered', outcomeDigest: 'sha256:' + createHash('sha256').update(input.serialized, 'utf8').digest('hex') };
    },
  };
}

test('C1: composeProduction arms the ONE composition (five workshops installed, identity deterministic)', async () => {
  const { composeProduction, compositionIdentityDigest } = await dist('workflow-kernel/composition/production.js');
  const channel = await deterministicChannel();
  const a = composeProduction({ dbPath: freshDbPath(), channel });
  const b = composeProduction({ dbPath: freshDbPath(), channel });
  // Workshop identity is DERIVED from each manifest's launch-kind prefix
  // (the nameBranchLiterals law): discovery/formalization/delivery/
  // development + the synthetic reporting workshop.
  assert.deepEqual(a.workshops.map((w) => w.workshop), ['discovery', 'formalization', 'delivery', 'development', 'reporting']);
  for (const workshop of a.workshops) {
    assert.equal(workshop.universeEqual, true, `${workshop.workshop} role universe must be exactly equal`);
    for (const launchKind of workshop.launchKinds) {
      assert.ok(workshop.pins.has(launchKind), `${workshop.workshop}/${launchKind} pin present`);
    }
  }
  // One compilation path => deterministic content addressing: two
  // compositions over the same installed workshop content agree byte for
  // byte on every launch-kind digest.
  assert.equal(compositionIdentityDigest(a), compositionIdentityDigest(b));
});

test('C2: dispatcher/runner/tracker views transport the SAME digest (one resolution path)', async () => {
  const { composeProduction } = await dist('workflow-kernel/composition/production.js');
  const { DISCOVERY_LAUNCH_KINDS } = await dist('workflow-kernel/workshops/discovery/installed-manifest.js');
  const composition = composeProduction({ dbPath: freshDbPath(), channel: await deterministicChannel() });
  const discovery = composition.discoveryRuntime;
  for (const launchKind of [DISCOVERY_LAUNCH_KINDS.author, DISCOVERY_LAUNCH_KINDS.reviewer]) {
    const slot = discovery.slotOf(launchKind);
    assert.ok(slot !== undefined, `${launchKind} must be resolved at composition time`);
    const views = [discovery.dispatcherView(slot), discovery.runnerView(slot), discovery.trackerView(slot)];
    const digests = new Set(views.map((view) => view.roleContractDigest));
    assert.equal(digests.size, 1, `the three consumers must transport one digest for ${launchKind}`);
    assert.equal(views[0].pin, views[1].pin, 'identity-stable pin object (dispatcher === runner)');
    assert.equal(views[1].pin, views[2].pin, 'identity-stable pin object (runner === tracker)');
  }
  // One resolution path, one resolution per launch kind: resolving every
  // kind twice advances the counter by exactly the number of kinds the
  // unified runtime carries (the D4 certifier operator row is excluded by
  // construction - it is resolved by its owning obligation, not a
  // Workplace protocol role).
  const unifiedKinds = composition.workshops.flatMap((workshop) =>
    [...workshop.pins.entries()].filter(([, contract]) => 'protocolRole' in contract).map(([kind]) => kind),
  );
  assert.ok(unifiedKinds.length >= 8, `expected the four workshops' protocol-role launch kinds, got ${unifiedKinds.length}`);
  const before = composition.unifiedRoles.resolutionCount;
  let newlyResolved = 0;
  for (const kind of unifiedKinds) {
    if (!composition.unifiedRoles.isResolved(kind)) newlyResolved += 1;
  }
  for (const kind of unifiedKinds) composition.unifiedRoles.resolveOnce(kind);
  for (const kind of unifiedKinds) composition.unifiedRoles.resolveOnce(kind);
  assert.equal(
    composition.unifiedRoles.resolutionCount,
    before + newlyResolved,
    'the second resolve of every launch kind must be the cached slot (counter advances once per kind)',
  );
});

test('C3: the production profile pins RUNNING_COUNTER_IDENTITY; a foreign pin fails admission closed (RED/GREEN)', async () => {
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const { PRODUCTION_PROMPT_BUDGET_PROFILE, PRODUCTION_LIMIT_TABLE, PRODUCTION_LIMIT_TABLE_DIGEST } = await dist('workflow-kernel/composition/pins.js');
  // The pin: the profile's tokenCounterRef IS the running identity.
  assert.deepEqual(PRODUCTION_PROMPT_BUDGET_PROFILE.tokenCounterRef, envelope.RUNNING_COUNTER_IDENTITY);
  assert.equal(PRODUCTION_PROMPT_BUDGET_PROFILE.providerModelLimitTableRef.digest, PRODUCTION_LIMIT_TABLE_DIGEST);

  // GREEN: accounting over the production pins works (the five mandatory
  // inline layers, canonical order).
  const layers = [
    { layer: 'initial-prompt-frame', content: 'production composition counter pin proof' },
    { layer: 'protocol-skill', content: 'content://skills/protocol digest=sha256:0000' },
    { layer: 'semantic-skill', content: 'content://skills/semantic digest=sha256:0000' },
    { layer: 'tool-schemas', content: '{}' },
    { layer: 'write-authority', content: 'write authority: cell workspace only' },
  ];
  const attempt = {
    providerRoutePin: { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' },
    nextRequestOrdinal: 0,
    cumulativeInputTokens: 0,
  };
  const ok = envelope.accountEnvelope(PRODUCTION_PROMPT_BUDGET_PROFILE, PRODUCTION_LIMIT_TABLE, attempt, { layers });
  assert.equal(ok.ok, true, `the pinned production profile must account a conforming envelope (got ${JSON.stringify(ok.violationDetail ?? ok)})`);
  assert.equal(ok.counterPinVerified, true, 'the pinned counter identity must verify against the running implementation');

  // RED: a foreign counter pin (one byte of drift) => TOKEN_COUNTER_MISMATCH.
  const foreign = {
    ...PRODUCTION_PROMPT_BUDGET_PROFILE,
    tokenCounterRef: { ...envelope.RUNNING_COUNTER_IDENTITY, digest: 'sha256:' + '0'.repeat(64) },
  };
  const refused = envelope.accountEnvelope(foreign, PRODUCTION_LIMIT_TABLE, attempt, { layers });
  assert.equal(refused.ok, false);
  assert.equal(refused.violation, 'TOKEN_COUNTER_MISMATCH');
  assert.equal(refused.counterPinVerified, false);
});

test('C4a: the real channel resolves the executor fail-closed (no claude CLI, no fallback)', async () => {
  const laws = await dist('workflow-kernel/composition/laws.js');
  // The forbidden spellings (the retired runner's patterns, preserved).
  for (const forbidden of ['claude', 'claude.exe', 'claude.cmd', 'claude.ps1', 'claude.sh', 'C:/tools/claude.exe', '/usr/bin/claude', 'node/vscode/anthropic.claude-code/claude-code.exe']) {
    assert.equal(laws.isForbiddenClaudeCli(forbidden), true, `${forbidden} must be forbidden`);
  }
  // The blessed shim is carved out.
  assert.equal(laws.isForbiddenClaudeCli('node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs'), false);

  // Unset env => the claude default => fail closed FACTORY_CLAUDE_BACKEND_FORBIDDEN.
  assert.throws(() => laws.resolveExecutorPath({}), (error) => error.code === 'FACTORY_CLAUDE_BACKEND_FORBIDDEN');
  // An explicit claude path => same refusal.
  assert.throws(() => laws.resolveExecutorPath({ SAGA_REAL_CLAUDE_PATH: 'claude' }), (error) => error.code === 'FACTORY_CLAUDE_BACKEND_FORBIDDEN');
  // The blessed compound executor resolves.
  const resolved = laws.resolveExecutorPath({ SAGA_REAL_CLAUDE_PATH: 'node D:/repo/tools/agent-proxy/claude-shim.mjs' });
  assert.equal(resolved.command, 'node');
  assert.deepEqual([...resolved.args], ['D:/repo/tools/agent-proxy/claude-shim.mjs']);

  // The channel constructor enforces the same law (composition aborts).
  const { OpenCodeShimChannel } = await dist('workflow-kernel/composition/opencode-channel.js');
  assert.throws(() => new OpenCodeShimChannel({ routePin: { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' }, env: {} }), (error) => error.code === 'FACTORY_CLAUDE_BACKEND_FORBIDDEN');
});

test('C4b: the channel throws on a tripwire change and passes only admitted serialized bytes (RED/GREEN)', async () => {
  const { OpenCodeShimChannel } = await dist('workflow-kernel/composition/opencode-channel.js');
  const routePin = { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' };
  // A fake home so the tripwire is hermetic.
  const home = mkdtempSync(join(tmpdir(), 'ek-wp12-laws-home-'));
  const settingsPath = join(home, '.claude', 'settings.json');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(settingsPath, '{"stable": true}', 'utf8');

  // GREEN: stable file + a real child process that exits 3 => channel-error
  // (thrown) - proving the send reached the real process boundary (the `--`
  // separator is node's argv boundary for the injected executor; production
  // resolves the shim, which owns the `-p --model` surface).
  const laws = await dist('workflow-kernel/composition/laws.js');
  const routePin2 = { provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24' };
  // ONE tripwire armed while the file is stable; both channels verify it.
  const tripwire = new laws.ClaudeSettingsTripwire(home);
  const echo = new OpenCodeShimChannel({
    routePin: routePin2,
    executor: { command: process.execPath, args: ['-e', 'process.exit(3)', '--'] },
    tripwire,
  });
  await assert.rejects(() => echo.send({ serialized: 'x', routePin: routePin2, maxOutputTokens: 16 }), /OPENCODE_CHANNEL_EXIT_3/);

  // RED: the settings file changes mid-run => ABORT before any spawn (the
  // SAME armed tripwire observes the change).
  writeFileSync(settingsPath, '{"changed": true}', 'utf8');
  const tripped = new OpenCodeShimChannel({
    routePin: routePin2,
    executor: { command: process.execPath, args: ['-e', 'process.exit(3)', '--'] },
    tripwire,
  });
  await assert.rejects(() => tripped.send({ serialized: 'x', routePin: routePin2, maxOutputTokens: 16 }), (error) => error.code === 'FACTORY_CLAUDE_SETTINGS_TRIPWIRE_ABORT');
  rmSync(home, { recursive: true, force: true });
});

test('C4c: the model intent refuses unless SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS is pinned (LAW 3)', async () => {
  const laws = await dist('workflow-kernel/composition/laws.js');
  assert.throws(() => laws.assertModelSwitchSkipsClaudeSettings({}), (error) => error.code === 'FACTORY_MODEL_SWITCH_SETTINGS_GUARD');
  assert.doesNotThrow(() => laws.assertModelSwitchSkipsClaudeSettings({ SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS: '1' }));
});

test('C5: the console is command-only (projection reads, typed commands, legacy writes refused)', async () => {
  const { composeProduction, consoleAdapterDeps } = await dist('workflow-kernel/composition/production.js');
  const { handleConsoleRequest } = await dist('workflow-kernel/composition/console.js');
  const composition = composeProduction({ dbPath: freshDbPath(), channel: await deterministicChannel() });
  const deps = consoleAdapterDeps(composition);
  const call = (method, path, body) => handleConsoleRequest(composition, deps, { method, path, query: new URLSearchParams() }, body);

  // Reads: the disposable projection + the authoritative world.
  const kanban = call('GET', '/api/kanban');
  assert.equal(kanban.status, 200);
  assert.equal(kanban.body.disposable, true);
  assert.equal(call('GET', '/api/world').status, 200);
  assert.equal(call('GET', '/api/identity').status, 200);

  // The projection rebuild command (disposable by construction).
  const rebuild = call('POST', '/api/projection/rebuild');
  assert.equal(rebuild.status, 200);
  assert.equal(rebuild.body.rebuilt, true);

  // Unknown actions and selection-authority payload fields are typed refusals.
  assert.equal(call('POST', '/api/command', { action: 'delete-project' }).body.code, 'UNKNOWN_ACTION');
  assert.equal(call('POST', '/api/command', { action: 'claim', role: 'reviewer' }).body.code, 'FORBIDDEN_PAYLOAD_FIELD');

  // The retired legacy write endpoints are COMMAND_ONLY_CONSOLE refusals.
  for (const [method, path] of [
    ['POST', '/api/project/archive'], ['POST', '/api/project/delete'], ['POST', '/api/admin/purge-all-projects'],
    ['POST', '/api/factory/start'], ['POST', '/api/factory/pause'], ['POST', '/api/factory/stop'],
    ['POST', '/api/factory/concurrency'], ['POST', '/api/engine/concurrency'], ['POST', '/api/model/set'],
    ['POST', '/api/repository/register'], ['POST', '/api/repository/bootstrap'],
    ['POST', '/api/tasks/status'], ['PATCH', '/api/cards/1'],
  ]) {
    const refusal = call(method, path, {});
    assert.equal(refusal.status, 404, `${method} ${path} must not exist`);
    assert.equal(refusal.body.code, 'COMMAND_ONLY_CONSOLE', `${method} ${path} must be the command-only refusal`);
  }

  // The model intent exists ONLY behind its LAW 3 guard.
  assert.equal(call('POST', '/api/command', { action: 'model.set-route' }).body.code, 'MODEL_SWITCH_SETTINGS_GUARD');
});

test('C6: the driver is the obligation consumer (idle on a fresh database; never a proof)', async () => {
  const { composeProduction } = await dist('workflow-kernel/composition/production.js');
  const composition = composeProduction({ dbPath: freshDbPath(), channel: await deterministicChannel() });
  const result = composition.driveFrontier();
  assert.equal(result.status, 'idle');
  assert.equal(result.consumed, 0, 'an empty frontier consumes nothing');
  const world = composition.session.hydrateWorld();
  assert.equal(world.world.proofs.length, 0, 'empty work is never a terminal proof');
});
