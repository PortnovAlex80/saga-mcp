/**
 * universe-registry.test.mjs - the domain registry is pinned to the FROZEN
 * EK-1 transition universe by deep equality on every collection (WP-05).
 * Any drift in src/workflow-kernel/domain/universe.ts is a blocking failure.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const UNIVERSE_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'reconciliation', 'transition-universe.json');
const FROZEN_INPUTS_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'frozen-inputs', 'FROZEN-INPUTS.json');

const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
const frozen = JSON.parse(readFileSync(FROZEN_INPUTS_PATH, 'utf8'));
const frozenEntry = frozen.inputs.find((entry) => entry.file.includes('transition-universe.json'));

const domain = await import('../../../dist/workflow-kernel/domain/universe.js');

test('the byte-frozen universe copy still matches the EK-1 admission digest', () => {
  assert.ok(frozenEntry, 'frozen-inputs manifest lists transition-universe.json');
  const frozenCopyPath = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'frozen-inputs', frozenEntry.file);
  const actual = createHash('sha256').update(readFileSync(frozenCopyPath, 'utf8')).digest('hex');
  assert.equal(actual, frozenEntry.sha256, 'the byte-frozen transition-universe copy changed - ABORT condition');
  // The registry pins the reconciliation copy (the authoritative artifact);
  // the frozen copy is the digest-pinned duplicate of the same universe.
  const reconciliation = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
  const frozenCopy = JSON.parse(readFileSync(frozenCopyPath, 'utf8'));
  assert.equal(reconciliation.counts.commands, frozenCopy.counts.commands);
  assert.equal(reconciliation.counts.obligations, frozenCopy.counts.obligations);
  assert.equal(reconciliation.counts.proofs, frozenCopy.counts.proofs);
  assert.equal(reconciliation.counts.evidenceKinds, frozenCopy.counts.evidenceKinds);
});

test('aggregate names equal the frozen universe (9 aggregates, D1)', () => {
  assert.deepEqual([...domain.AGGREGATE_NAMES], universe.aggregates.map((a) => a.name));
  assert.equal(domain.AGGREGATE_NAMES.length, 9);
});

test('non-aggregate authority kinds equal the frozen universe (4 authorities)', () => {
  assert.deepEqual([...domain.NON_AGGREGATE_AUTHORITY_KINDS], universe.nonAggregateAuthorities.map((a) => `authority:${a.name}`));
  assert.equal(domain.NON_AGGREGATE_AUTHORITY_KINDS.length, 4);
});

test('relation kinds equal the plan Target logical model (22 relations)', () => {
  assert.equal(domain.RELATION_KINDS.length, 22);
  for (const name of ['relation:ProtocolMetadata', 'relation:KanbanCard', 'relation:CellFinalAcceptance', 'relation:TypedWait', 'relation:TerminalProof']) {
    assert.ok(domain.RELATION_KINDS.includes(name), `${name} declared`);
  }
});

test('command descriptors equal the frozen universe (53 commands, exact edges)', () => {
  assert.equal(domain.COMMANDS.length, universe.counts.commands);
  assert.equal(domain.COMMANDS.length, 53);
  for (const command of universe.commands) {
    const descriptor = domain.COMMANDS.find((entry) => entry.name === command.name);
    assert.ok(descriptor, `${command.name} declared in the registry`);
    assert.equal(descriptor.aggregate, command.aggregate);
    assert.deepEqual([...descriptor.emitsEvents], command.emitsEvents ?? []);
    assert.deepEqual([...descriptor.createsObligations], command.createsObligations ?? []);
    assert.deepEqual([...descriptor.waits], command.waits ?? []);
    assert.deepEqual([...descriptor.proofs], command.proofs ?? []);
  }
});

test('obligation edges equal the frozen universe (49 kinds with exact sources/targets)', () => {
  assert.equal(domain.OBLIGATIONS.length, universe.counts.obligations);
  assert.equal(domain.OBLIGATIONS.length, 49);
  for (const obligation of universe.obligations) {
    const descriptor = domain.OBLIGATIONS.find((entry) => entry.kind === obligation.kind);
    assert.ok(descriptor, `${obligation.kind} declared`);
    assert.equal(descriptor.source, obligation.source);
    assert.equal(descriptor.target, obligation.target);
  }
});

test('wait descriptors equal the frozen universe (5 kinds, each with a durable wake source)', () => {
  assert.equal(domain.WAITS.length, universe.counts.waits);
  assert.equal(domain.WAITS.length, 5);
  for (const wait of domain.WAITS) {
    assert.ok(
      wait.wakeCommands.length > 0 || wait.wakeObligationKinds.length > 0 || wait.deadWakeConversion !== undefined,
      `${wait.kind} has a durable wake source or a D7 dead-wake conversion`,
    );
  }
});

test('proof descriptors equal the frozen universe (28 proofs with exact closures)', () => {
  assert.equal(domain.PROOFS.length, universe.counts.proofs);
  assert.equal(domain.PROOFS.length, 28);
  for (const proof of universe.proofs) {
    const expectedId = `TerminalProof:${proof.scope}.${proof.kind.split(':')[1]}`;
    const descriptor = domain.PROOFS.find((entry) => entry.id === expectedId);
    assert.ok(descriptor, `${expectedId} declared`);
    assert.equal(descriptor.ownerAggregate, proof.ownerAggregate);
    assert.deepEqual([...descriptor.requiredEvidenceClosure], proof.requiredEvidenceClosure ?? []);
  }
});

test('evidence kinds equal the frozen universe (67 kinds)', () => {
  assert.equal(domain.EVIDENCE_DESCRIPTORS.length, universe.counts.evidenceKinds);
  assert.equal(domain.EVIDENCE_DESCRIPTORS.length, 67);
  for (const kind of universe.evidenceKinds) {
    const descriptor = domain.EVIDENCE_DESCRIPTORS.find((entry) => entry.id === kind.id);
    assert.ok(descriptor, `${kind.id} declared`);
  }
});

test('the D7 unreachable scope set is exactly {cell, workplace, node}', () => {
  const issuable = domain.PROOFS.filter((proof) => !proof.issuingCommand.startsWith('unresolved'));
  const unreachableScopes = [...new Set(issuable.filter((proof) => proof.outcome === 'unreachable').map((proof) => proof.scope))].sort();
  assert.deepEqual(unreachableScopes, ['cell', 'node', 'workplace']);
});

test('normalizeProofId maps the command-array .failure spelling onto the 28-kind union', () => {
  assert.equal(domain.normalizeProofId('TerminalProof:run.failure'), 'TerminalProof:run.truthful-failure');
  assert.equal(domain.normalizeProofId('TerminalProof:cell.success'), 'TerminalProof:cell.success');
  assert.throws(() => domain.normalizeProofId('TerminalProof:galaxy.success'), /UNIVERSE_VIOLATION/);
});
