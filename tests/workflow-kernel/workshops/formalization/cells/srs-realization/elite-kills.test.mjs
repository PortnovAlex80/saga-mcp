/**
 * elite-kills.test.mjs - FRF-WP08: the plan's NAMED Elite kill tests,
 * RED/GREEN pinned. Plan FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN,
 * "Elite and simple-server kill tests" and the kill criterion:
 * "if an AC-complete product with a missing entrypoint, composition edge,
 * or scenario handoff can reach Development execution, this design has not
 * fixed the architectural defect and must not be closed."
 *
 *   missing-entrypoint  - a product surface required by a scenario's
 *                         realization absent from the architecture contract
 *                         => typed refusal, never silent (COVERAGE_GAP).
 *   missing-composition - a declared composition surface realizing NO
 *                         scenario => refusal (FOREIGN_LINEAGE).
 *
 * Both kills are pinned at BOTH validator levels (the realization section
 * and the sealed architecture contract) and through the desk author path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cell,
  greenFixture,
  killMissingComposition,
  killMissingEntrypoint,
  killMissingImplementationSurface,
  killRemovedCompositionOwner,
  killRemovedInputToControllerEdge,
  killRemovedStateToRendererEdge,
} from './support.mjs';

const assertRefused = (outcome, reason, detailPart) => {
  assert.equal(outcome.ok, false, `expected refusal, got ${JSON.stringify(outcome).slice(0, 220)}`);
  assert.equal(outcome.reason, reason);
  if (detailPart !== undefined) assert.ok(outcome.detail.includes(detailPart), `detail "${outcome.detail}" should mention "${detailPart}"`);
};

test('GREEN pin: the Elite interactive composition path is accepted end-to-end', () => {
  const g = greenFixture();
  const desk = cell.authorArchitectureContract(g.draft, g.universe);
  assert.equal(desk.ok, true, JSON.stringify(desk).slice(0, 220));
  assert.equal(desk.product.realization.realizationEntries.length, 4);
  const verdict = cell.validateArchitectureContract(desk.product, g.universe);
  assert.equal(verdict.ok, true, JSON.stringify(verdict).slice(0, 220));
});

test('ELITE KILL missing-entrypoint: the browser bootstrap surface absent from the contract is a typed refusal at every level', () => {
  const g = greenFixture();
  const mutated = killMissingEntrypoint(g);

  // Section level.
  const parsed = cell.parseSrsRealizationDraft(mutated);
  assert.equal(parsed.ok, true, 'the kill parses (structure is intact; the CONTRACT is incomplete)');
  assertRefused(cell.validateSrsRealization(parsed.section, g.universe), 'COVERAGE_GAP', 'arch:elite-browser-bootstrap');

  // Contract level (the sealed product re-runs the section validator).
  assertRefused(cell.validateArchitectureContract({ ...g.contract, realization: parsed.section }, g.universe), 'COVERAGE_GAP', 'arch:elite-browser-bootstrap');

  // Desk author path (parse -> validate -> seal): the kill never seals.
  assertRefused(cell.authorArchitectureContract(mutated, g.universe), 'COVERAGE_GAP', 'which the contract does not declare');
});

test('ELITE KILL missing-entrypoint (implementation surface): the evidence harness absent from the contract is refused typed', () => {
  const g = greenFixture();
  const mutated = killMissingImplementationSurface(g);
  const parsed = cell.parseSrsRealizationDraft(mutated);
  assert.equal(parsed.ok, true);
  assertRefused(cell.validateSrsRealization(parsed.section, g.universe), 'COVERAGE_GAP', 'arch:elite-test-harness');
  assertRefused(cell.authorArchitectureContract(mutated, g.universe), 'COVERAGE_GAP', 'arch:elite-test-harness');
});

test('ELITE KILL missing-composition: a declared composition surface realizing NO scenario is refused', () => {
  const g = greenFixture();
  const mutated = killMissingComposition(g);

  const parsed = cell.parseSrsRealizationDraft(mutated);
  assert.equal(parsed.ok, true, 'the kill parses (the surface is well-formed; it realizes nothing)');
  assertRefused(cell.validateSrsRealization(parsed.section, g.universe), 'FOREIGN_LINEAGE', 'arch:orphan-composer');
  assertRefused(cell.authorArchitectureContract(mutated, g.universe), 'FOREIGN_LINEAGE', 'realizes no scenario');
});

test('ELITE KILL: removing the composition owner is refused before any seal', () => {
  const g = greenFixture();
  const mutated = killRemovedCompositionOwner(g);
  const parsed = cell.parseSrsRealizationDraft(mutated);
  assert.equal(parsed.ok, true);
  assertRefused(cell.validateSrsRealization(parsed.section, g.universe), 'COVERAGE_GAP', 'arch:elite-composition-owner');
  assertRefused(cell.authorArchitectureContract(mutated, g.universe), 'COVERAGE_GAP', 'arch:elite-composition-owner');
});

test('ELITE KILL: the removed input-to-controller edge is refused through the desk path', () => {
  const g = greenFixture();
  assertRefused(cell.authorArchitectureContract(killRemovedInputToControllerEdge(g), g.universe), 'COVERAGE_GAP', 'unreachable from the entrypoint');
});

test('ELITE KILL: the removed state-to-renderer edge is refused through the desk path', () => {
  const g = greenFixture();
  assertRefused(cell.authorArchitectureContract(killRemovedStateToRendererEdge(g), g.universe), 'COVERAGE_GAP', 'unreachable from the entrypoint');
});

test('ELITE KILL: the missing-entrypoint and missing-composition refusals route to desk verdicts, never to a silent pass', () => {
  const g = greenFixture();
  const entrypoint = cell.authorArchitectureContract(killMissingEntrypoint(g), g.universe);
  const composition = cell.authorArchitectureContract(killMissingComposition(g), g.universe);
  assert.equal(entrypoint.ok, false);
  assert.equal(composition.ok, false);
  assert.equal(cell.deskVerdictOf(entrypoint), 'repair', 'COVERAGE_GAP routes the author desk back to repair');
  assert.equal(cell.deskVerdictOf(composition), 'upstream-repair', 'FOREIGN_LINEAGE routes upstream (the defect belongs to the owning material)');
});
