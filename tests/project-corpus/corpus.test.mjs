/**
 * corpus.test.mjs - the WP-13D project-corpus format suite: every
 * descriptor validates against the closed corpus contract, the inventory
 * spans the required families, the compiled durable scenarios pass the
 * WP-13A scenario validator, and the corpus is deterministic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCorpus, SMOKE_PROJECT_IDS } from './registry.mjs';
import { validateProjectDescriptor, PROJECT_CORPUS_FORMAT_VERSION } from './format.mjs';
import { validateScenario } from '../workflow-kernel/engine/scenario.mjs';
import { buildScenarioDocument } from '../../tools/project-corpus/lib/modes.mjs';
import { authoredEvents } from './programs.mjs';

let corpus;
test.before(async () => {
  corpus = await loadCorpus();
});

test('all 20 descriptors validate against the closed corpus contract', () => {
  assert.equal(corpus.length, 20);
  for (const descriptor of corpus) {
    const { valid, errors } = validateProjectDescriptor(descriptor);
    assert.equal(valid, true, `${descriptor.projectId}: ${JSON.stringify(errors)}`);
    assert.equal(descriptor.formatVersion, PROJECT_CORPUS_FORMAT_VERSION);
  }
});

test('project ids are unique and ordered', () => {
  const ids = corpus.map((descriptor) => descriptor.projectId);
  assert.equal(new Set(ids).size, 20);
  assert.deepEqual([...ids].sort(), ids, 'the registry order is the id order');
});

test('the corpus spans every required family', () => {
  const kinds = new Set(corpus.map((descriptor) => descriptor.projectKind));
  for (const kind of [
    'interactive-served', 'static', 'batch', 'scheduled', 'autonomous', 'cross-module', 'topology',
    'honest-failure', 'human-wait', 'effect-uncertainty', 'restart-heavy', 'idempotency',
  ]) {
    assert.ok(kinds.has(kind), `project kind ${kind} is represented`);
  }
  const modes = new Set(corpus.map((descriptor) => descriptor.drive.mode));
  assert.deepEqual([...modes].sort(), ['development-vertical', 'durable-session', 'planning-conveyor']);
});

test('the dependency topologies chain/diamond/fan-in/fan-out/independent are all covered', () => {
  const topologies = corpus
    .filter((descriptor) => descriptor.drive.mode === 'planning-conveyor')
    .map((descriptor) => descriptor.drive.conveyorTopology);
  for (const topology of ['chain', 'diamond', 'fan-in', 'fan-out', 'independent', 'failed-predecessor']) {
    assert.ok(topologies.includes(topology), `topology ${topology} is covered`);
  }
});

test('every durable-session scenario document passes the WP-13A scenario validator', () => {
  for (const descriptor of corpus.filter((entry) => entry.drive.mode === 'durable-session')) {
    const { doc } = buildScenarioDocument(descriptor);
    const { valid, errors } = validateScenario(doc);
    assert.equal(valid, true, `${descriptor.projectId}: ${JSON.stringify(errors)}`);
  }
});

test('fault schedules hold only scheduler-level classes (input-level faults are authored behaviors)', () => {
  const schedulerClasses = ['crash-before-commit', 'crash-after-event', 'worker-loss', 'projection-wipe', 'projection-stale-write'];
  for (const descriptor of corpus) {
    for (const fault of descriptor.scenario.faultSchedule) {
      assert.ok(schedulerClasses.includes(fault.fault), `${descriptor.projectId}: fault class ${fault.fault} must be scheduler-level`);
    }
  }
  const restartHeavy = corpus.filter((descriptor) => descriptor.projectKind === 'restart-heavy');
  assert.equal(restartHeavy.length, 2, 'the restart-heavy family (crash matrix + projection faults)');
});

test('the restart-matrix schedule covers all 16 registry points one-to-one', async () => {
  const { FAULT_POINTS } = await import('../../tools/project-corpus/lib/modes.mjs');
  const p18 = corpus.find((descriptor) => descriptor.projectId === 'p18-restart-matrix');
  const { crashPointOf } = await import('../../tools/project-corpus/lib/modes.mjs');
  const points = p18.scenario.faultSchedule.map((entry) => crashPointOf(entry));
  assert.equal(new Set(points).size, 16, '16 distinct registry points');
  assert.deepEqual([...points].sort(), [...FAULT_POINTS].sort());
});

test('authored expectations derive from the frozen universe, never from output', () => {
  for (const descriptor of corpus.filter((entry) => entry.drive.mode === 'durable-session')) {
    const events = descriptor.scenario.expectations.events;
    const authored = authoredEvents(descriptor.scenario.program.steps);
    /* For the typed-refusal terminal the authored events stop before the
       refused step; everywhere else they are the full program sequence. */
    const ok = descriptor.expectedRefusal !== undefined
      ? events.length < authored.length && authored.slice(0, events.length).every((kind, index) => kind === events[index])
      : events.length === authored.length && events.every((kind, index) => kind === authored[index]);
    assert.equal(ok, true, `${descriptor.projectId}: events are the universe-derived program sequence`);
  }
});

test('the format rejects unknown keys and out-of-vocabulary values', () => {
  const base = corpus.find((descriptor) => descriptor.projectId === 'p06-autonomous-ladder');
  const withJunk = { ...structuredClone(base), bogus: true };
  assert.equal(validateProjectDescriptor(withJunk).valid, false);
  const badKind = { ...structuredClone(base), projectKind: 'vibes-driven' };
  assert.equal(validateProjectDescriptor(badKind).valid, false);
  const badInvariant = { ...structuredClone(base), expectedInvariants: ['everything-is-fine'] };
  assert.equal(validateProjectDescriptor(badInvariant).valid, false);
  const inputFault = structuredClone(base);
  inputFault.scenario.faultSchedule = [{ fault: 'stale-expected-revision', anchor: { command: 'factoryRun.start', instanceId: 'factory-run:1' } }];
  assert.equal(validateProjectDescriptor(inputFault).valid, false, 'input-level fault classes belong in authored behaviors');
  const subsetWithoutJustification = structuredClone(base);
  subsetWithoutJustification.drive.comparison.expectationPolicies = { obligations: 'declared-subset' };
  delete subsetWithoutJustification.drive.comparison.justifications.obligations;
  assert.equal(validateProjectDescriptor(subsetWithoutJustification).valid, false, 'declared-subset requires a justification');
});

test('the corpus is deterministic: loading twice yields identical descriptors', async () => {
  const second = await loadCorpus();
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(corpus)));
});

test('the smoke subset exists and spans the families', () => {
  assert.equal(SMOKE_PROJECT_IDS.length, 5);
  const byId = new Map(corpus.map((descriptor) => [descriptor.projectId, descriptor]));
  for (const id of SMOKE_PROJECT_IDS) assert.ok(byId.has(id), `smoke id ${id} exists`);
  const smokeModes = new Set(SMOKE_PROJECT_IDS.map((id) => byId.get(id).drive.mode));
  assert.deepEqual([...smokeModes].sort(), ['development-vertical', 'durable-session', 'planning-conveyor']);
});
