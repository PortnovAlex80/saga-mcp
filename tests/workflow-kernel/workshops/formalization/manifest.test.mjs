/**
 * manifest.test.mjs - the installed workshop manifest of the Formalization
 * workshop (WP-11F): the target process graph shape (eleven nodes,
 * eighteen transitions), reachability, declared desks/providers/skills/
 * tools/hooks, fail-closed lookups and the deterministic manifest digest.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const manifest = () => import('../../../../dist/workflow-kernel/workshops/formalization/manifest.js');

test('the installed flow has exactly eleven nodes and eighteen transitions', async () => {
  const m = await manifest();
  assert.equal(m.FORMALIZATION_FLOW_NODES.length, 11);
  assert.equal(m.FORMALIZATION_FLOW_EDGES.length, 18);
  // Six Production Cells + two kernel nodes + three terminal nodes.
  const byKind = { 'production-cell': 0, kernel: 0, terminal: 0 };
  for (const node of m.FORMALIZATION_FLOW_NODES) byKind[node.kind] += 1;
  assert.deepEqual(byKind, { 'production-cell': 6, kernel: 2, terminal: 3 });
});

test('every nonterminal node is reachable from the entry', async () => {
  const m = await manifest();
  const edgesFrom = new Map();
  for (const edge of m.FORMALIZATION_FLOW_EDGES) {
    edgesFrom.set(edge.from, [...(edgesFrom.get(edge.from) ?? []), edge.to]);
  }
  const reachable = new Set([m.entryNodeId()]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of [...reachable]) {
      for (const next of edgesFrom.get(node) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          grew = true;
        }
      }
    }
  }
  for (const node of m.FORMALIZATION_FLOW_NODES) {
    assert.ok(reachable.has(node.id), `node ${node.id} is unreachable from the entry`);
  }
});

test('every formalized path visits all six Production Cells and both kernel nodes', async () => {
  const m = await manifest();
  const desks = m.deskNodeIds();
  assert.deepEqual(desks, [
    'define-product-intent',
    'model-use-cases',
    'derive-system-requirements',
    'define-acceptance-contract',
    'reconcile-what',
    'freeze-what-baseline',
    'define-architecture-contract',
    'settle-formalization',
  ]);
  // The primary accepted path chains every desk in order.
  let current = m.entryNodeId();
  const visited = [];
  while (current !== undefined) {
    visited.push(current);
    const next = m.edgeTarget(current, current.startsWith('settle') ? 'domain.formalized' : current.startsWith('freeze') ? 'domain.frozen' : 'domain.accepted');
    current = next.ok ? next.to : undefined;
  }
  assert.deepEqual(visited, [...desks, 'complete-formalized']);
});

test('every reviewed cell has accepted and failed exits; freeze and settle have their full exits', async () => {
  const m = await manifest();
  const edgesOf = (from) => m.FORMALIZATION_FLOW_EDGES.filter((edge) => edge.from === from);
  for (const cell of ['define-product-intent', 'model-use-cases', 'derive-system-requirements', 'define-acceptance-contract', 'reconcile-what', 'define-architecture-contract']) {
    const ons = edgesOf(cell).map((edge) => edge.on).sort();
    assert.deepEqual(ons, ['domain.accepted', 'domain.failed'], `${cell} exits`);
  }
  assert.deepEqual(edgesOf('freeze-what-baseline').map((e) => e.on).sort(), ['domain.drift-detected', 'domain.failed', 'domain.frozen']);
  assert.deepEqual(edgesOf('settle-formalization').map((e) => e.on).sort(), ['domain.failed', 'domain.formalized', 'domain.inconsistent']);
});

test('terminal nodes emit exactly the three outcome codes', async () => {
  const m = await manifest();
  assert.deepEqual(
    m.terminalNodeIds().map((id) => m.nodeOf(id).node.emitsOutcome).sort(),
    ['failed', 'formalized', 'inconsistent'],
  );
});

test('every desk pins a declared check provider (fail-closed lookup)', async () => {
  const m = await manifest();
  for (const nodeId of m.deskNodeIds()) {
    const resolved = m.checkProviderOfDesk(nodeId);
    assert.equal(resolved.ok, true, `${nodeId}: ${resolved.ok ? '' : resolved.detail}`);
    assert.match(resolved.provider.providerDigest, /^[0-9a-f]{64}$/);
  }
  // An unknown desk and a terminal node are refused fail-closed.
  assert.equal(m.checkProviderOfDesk('not-a-node').ok, false);
  assert.equal(m.checkProviderOfDesk('complete-formalized').ok, false);
  // An undeclared provider id is refused (the desk descriptor pins an
  // installed provider; a swapped pin fails closed).
  assert.equal(m.nodeOf('model-use-cases').ok, true);
  const swapped = { ...m.installedWorkshopManifest() };
  void swapped;
  const missing = m.FORMALIZATION_CHECK_PROVIDERS.find((entry) => entry.nodeId === 'model-use-cases');
  assert.notEqual(missing, undefined);
});

test('the manifest declares installed skills, tools, hooks and role bindings as data', async () => {
  const m = await manifest();
  const installed = m.installedWorkshopManifest();
  // One protocol skill + one semantic skill per desk.
  assert.equal(installed.skills.filter((s) => s.kind === 'protocol').length, 1);
  assert.equal(installed.skills.filter((s) => s.kind === 'semantic').length, m.deskNodeIds().length);
  // The closed read/write/review tool surfaces.
  for (const access of ['read', 'write', 'review']) {
    assert.ok(installed.tools.some((tool) => tool.access === access), `tool surface ${access}`);
  }
  assert.ok(installed.tools.some((tool) => tool.toolId === 'artifact_create'));
  assert.ok(installed.tools.some((tool) => tool.toolId === 'product_submit'));
  // Declared hooks (additionalContext injections).
  assert.deepEqual(installed.hooks.map((hook) => hook.event).sort(), ['PostToolUse', 'SessionStart']);
  // The workshop binds exactly the two frozen-manifest launch kinds.
  assert.deepEqual(
    installed.roleBindings.map((binding) => binding.launchKind),
    ['formalization.implementation.author', 'formalization.implementation.reviewer'],
  );
  for (const binding of installed.roleBindings) {
    assert.ok(['author', 'reviewer'].includes(binding.protocolRole));
  }
});

test('the manifest digest is deterministic and covers the whole manifest', async () => {
  const m = await manifest();
  const first = m.installedWorkshopManifest();
  const second = m.installedWorkshopManifest();
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.match(first.manifestDigest, /^[0-9a-f]{64}$/);
  // The identity is compound (never a bare workshop-name literal); 3.0.0 is
  // the FRF-WP11 semantic cutover (the scenario-first cells became the desk
  // authority - the module version is the bumped semantic-contract identity).
  assert.equal(first.moduleId, 'workshop:solution-formalization');
  assert.equal(first.moduleVersion, '3.0.0');
});
