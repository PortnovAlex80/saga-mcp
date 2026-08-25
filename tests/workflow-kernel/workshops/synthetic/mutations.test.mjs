/**
 * mutations.test.mjs - WP-11V fence family 4: the SYNTHETIC-WORKSHOP
 * KERNEL-MODIFICATION ATTEMPT. Every way a new workshop could try to
 * extend the kernel is refused typed at the data boundary:
 *
 *   - a new COMMAND in a gate/effect row           -> GATE/EFFECT_COMMAND_OUTSIDE_UNIVERSE;
 *   - a new EVIDENCE kind in a gate requirement    -> GATE_EVIDENCE_KIND_OUTSIDE_UNIVERSE;
 *   - a new WAIT kind or wake source               -> WAIT_*_OUTSIDE_*;
 *   - a new OBLIGATION kind                        -> OBLIGATION_KIND_OUTSIDE_UNIVERSE;
 *   - a new lifecycle family name in a binding row -> the frozen schema compile refusal;
 *   - a verdict-vocabulary drift                   -> GATE_VERDICT_VOCABULARY_DRIFT.
 *
 * The kernel itself is never touched: all six attempts are DATA mutations
 * of the synthetic installation, and all six are killed before any kernel
 * surface sees them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installation = await import('../../../../dist/workflow-kernel/workshops/synthetic/installation.js');
const bindings = await import('../../../../dist/workflow-kernel/workshops/synthetic/bindings.js');
const developmentInstallation = await import('../../../../dist/workflow-kernel/workshops/development/installation.js');
const compiler = await import('../../../../dist/workflow-kernel/roles/compiler.js');
const universe = await import('../../../../dist/workflow-kernel/domain/universe.js');

const COMMAND_NAMES = universe.COMMAND_NAMES;
const REGISTRY_SIZES = {
  commands: universe.COMMAND_NAMES.length,
  obligations: universe.OBLIGATION_KINDS.length,
  waits: universe.WAIT_KINDS.length,
  proofs: universe.PROOF_KINDS.length,
  evidenceKinds: universe.EVIDENCE_KINDS.length,
};

const base = installation.syntheticReportingInstallation();

test('ATTEMPT new transition kind (command): a synthetic gate naming its own command is refused', () => {
  const mutated = structuredClone(base);
  mutated.gates = base.gates.map((gate, index) => index === 0 ? { ...gate, command: 'workplace.renderReport' } : gate);
  const refusal = developmentInstallation.validateWorkshopInstallation(mutated);
  assert.equal(refusal.refused, true);
  assert.equal(refusal.code, 'GATE_COMMAND_OUTSIDE_UNIVERSE');
  assert.match(refusal.detail, /53-command universe/);
});

test('ATTEMPT new transition kind (command): a synthetic effect naming its own publish command is refused', () => {
  const mutated = structuredClone(base);
  mutated.effects = base.effects.map((effect) => ({ ...effect, command: 'syntheticReport.publish' }));
  const refusal = developmentInstallation.validateWorkshopInstallation(mutated);
  assert.equal(refusal.refused, true);
  assert.equal(refusal.code, 'EFFECT_COMMAND_OUTSIDE_UNIVERSE');
});

test('ATTEMPT new evidence kind: a gate requiring a workshop-private evidence kind is refused', () => {
  const mutated = structuredClone(base);
  mutated.gates = base.gates.map((gate, index) => index === 0 ? { ...gate, requiredEvidenceKinds: ['ReportRenderEvidence'] } : gate);
  const refusal = developmentInstallation.validateWorkshopInstallation(mutated);
  assert.equal(refusal.refused, true);
  assert.equal(refusal.code, 'GATE_EVIDENCE_KIND_OUTSIDE_UNIVERSE');
});

test('ATTEMPT new wait kind and wake source: both are refused typed', () => {
  const inventedKind = structuredClone(base);
  inventedKind.waits = [...base.waits, { purpose: 'publication-mood', kind: 'TypedWait:publication-mood', wakeCommands: ['workplace.resolveHumanResponse'], operatorDispositionRequired: true, rationale: 'invented' }];
  assert.equal(developmentInstallation.validateWorkshopInstallation(inventedKind).code, 'WAIT_KIND_OUTSIDE_UNIVERSE');

  const inventedWake = structuredClone(base);
  inventedWake.waits = base.waits.map((wait) => ({ ...wait, wakeCommands: ['factoryRun.observeWatchdog'] }));
  const refusal = developmentInstallation.validateWorkshopInstallation(inventedWake);
  assert.ok(refusal.code === 'WAIT_WAKE_COMMAND_OUTSIDE_REGISTRY' || refusal.code === 'WAIT_WAKE_COMMAND_OUTSIDE_UNIVERSE');
});

test('ATTEMPT new obligation kind: the obligation assertion refuses it', () => {
  const refusal = developmentInstallation.assertObligationKindsInstalled(['obligation:renderReportPage'], 'mutation:synthetic');
  assert.equal(refusal.refused, true);
  assert.equal(refusal.code, 'OBLIGATION_KIND_OUTSIDE_UNIVERSE');
  assert.match(refusal.detail, /kernel widening/);
});

test('ATTEMPT new lifecycle family (manifest row outside the frozen schema enum): the compile is refused', async () => {
  const input = bindings.reportingAuthorCompileInput();
  // The raw source mutation: a row whose family value is not admitted by the frozen schema.
  const mutatedBinding = { ...input.binding, workshop: 'reporting' };
  const outcome = compiler.compileRoleContract({ ...input, binding: mutatedBinding });
  assert.equal(outcome.compiled, false, 'the frozen schema refuses an invented family name');
  assert.ok(outcome.errors.some((error) => error.includes('workshop')), JSON.stringify(outcome.errors));
  // The lawful rows (family read from the frozen manifest) compile.
  const lawful = compiler.compileRoleContract(input);
  assert.equal(lawful.compiled, true);
});

test('ATTEMPT verdict vocabulary drift: a private verdict list is refused', () => {
  const mutated = structuredClone(base);
  mutated.gates = base.gates.map((gate, index) => index === 0 ? { ...gate, verdictVocabulary: ['accepted', 'published'] } : gate);
  const refusal = developmentInstallation.validateWorkshopInstallation(mutated);
  assert.equal(refusal.refused, true);
  assert.equal(refusal.code, 'GATE_VERDICT_VOCABULARY_DRIFT');
});

test('STATIC PROOF: the frozen reconciliation universe document still equals the live registries', () => {
  // The synthetic workshop was added WITHOUT touching the frozen transition
  // universe: the EK-1 reconciliation document (the normative JSON) still
  // pins exactly the live registry membership and counts.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const doc = JSON.parse(readFileSync(path.join(root, 'docs', 'refactoring', 'event-kernel', 'reconciliation', 'transition-universe.json'), 'utf8'));
  const frozen = { commands: 53, obligations: 49, waits: 5, proofs: 28, evidenceKinds: 67 };
  for (const [family, count] of Object.entries(frozen)) {
    assert.equal(doc.counts[family], count, `the frozen document pins ${family}=${count}`);
    assert.equal(REGISTRY_SIZES[family], count, `the live ${family} registry holds ${count}`);
  }
  const frozenCommandNames = doc.commands.map((entry) => entry.name);
  assert.deepEqual(
    frozenCommandNames.filter((name) => !COMMAND_NAMES.includes(name)),
    [],
    'the frozen document names no command outside the live registry',
  );
});
