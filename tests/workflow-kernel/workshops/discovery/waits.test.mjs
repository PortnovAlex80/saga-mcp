/**
 * waits.test.mjs - WP-11D deliverable 5: the typed-wait vocabulary of the
 * Discovery workshop - D5/D12 declarations only, invented kinds refused
 * typed, wake sources read from the frozen universe registry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const waits = await import('../../../../dist/workflow-kernel/workshops/discovery/waits.js');
const universe = await import('../../../../dist/workflow-kernel/domain/universe.js');

test('Discovery declares exactly its two legitimate waits, both D5/D12', () => {
  assert.deepEqual(
    waits.DECLARED_WAIT_KINDS.map((entry) => `${entry.kind}:${entry.reason}`),
    ['TypedWait:human-input:D5', 'TypedWait:effect-uncertainty:D12'],
  );
});

test('fence: an invented wait kind is refused UNIVERSE_VIOLATION (wait-kind invention, family 3)', () => {
  for (const invented of ['TypedWait:operator-mood', 'TypedWait:discovery-decision', 'human-input', '']) {
    const resolution = waits.discoveryWaitOf(invented);
    assert.equal(resolution.refused, true, invented);
    assert.equal(resolution.reason, 'UNIVERSE_VIOLATION');
    assert.match(resolution.detail, /five frozen kinds/);
  }
});

test('fence: a frozen kind Discovery never legitimately waits on is refused (no silent stretch)', () => {
  for (const frozen of ['TypedWait:external-availability', 'TypedWait:policy-quota', 'TypedWait:readiness']) {
    const resolution = waits.discoveryWaitOf(frozen);
    assert.equal(resolution.refused, true, frozen);
    assert.equal(resolution.reason, 'WAIT_WITHOUT_WAKE_SOURCE');
    assert.match(resolution.detail, /not a legitimate wait of this workshop/);
  }
});

test('the declared waits resolve with their frozen wake sources', () => {
  const human = waits.discoveryWaitOf('TypedWait:human-input');
  assert.equal(human.resolved, true);
  assert.deepEqual([...human.wakeCommands], ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);
  const uncertain = waits.discoveryWaitOf('TypedWait:effect-uncertainty');
  assert.equal(uncertain.resolved, true);
  assert.deepEqual([...uncertain.wakeCommands], ['workplace.resolveHumanResponse'], 'D12: the operator disposition is the ONLY wake');
});

test('the declared vocabulary is a subset of the frozen five (never a widening)', () => {
  const frozen = new Set(universe.WAIT_KINDS);
  for (const entry of waits.DECLARED_WAIT_KINDS) {
    assert.ok(frozen.has(entry.kind), `${entry.kind} is frozen`);
  }
});
