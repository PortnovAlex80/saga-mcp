/**
 * generalization.test.mjs - WP-11V deliverable 3 / the EK-8 GENERALIZATION
 * PROOF: the synthetic non-game workshop (a report generator) runs the
 * complete production-cell lifecycle over the SAME frozen kernel and
 * proves it required NO new kernel transition kind, table, driver or
 * reconciler - it is pure manifest + mapping + CheckPlan data.
 *
 * The proof has four legs:
 *   1. REGISTRY PIN - the frozen registries still hold exactly the base
 *      counts (9 aggregates, 53 commands, 49 obligation kinds, 5 wait
 *      kinds, 28 proof kinds, 67 evidence kinds): adding the workshop
 *      changed none of them;
 *   2. FULL RUN - the scenario reaches TerminalProof:run.success through
 *      public commands only (the WP-07 consumer behind the WP-08 staged
 *      vertical), with the workshop's own contracts, products, checks and
 *      capsule;
 *   3. EXERCISED SUBSET - every kind the committed world exercised is a
 *      member of the frozen registries, and every written table is one of
 *      the nine sole-writer aggregate tables (no private workshop table);
 *   4. INTERFACE EQUALITY - the synthetic installation validates through
 *      the Development package's generic validator (the same workshop
 *      semantic interface discipline), while importing no workshop
 *      package (checked in structure.test.mjs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase } from '../../development/support.mjs';

const scenario = await import('../../../../dist/workflow-kernel/workshops/synthetic/scenario.js');
const installation = await import('../../../../dist/workflow-kernel/workshops/synthetic/installation.js');
const bindings = await import('../../../../dist/workflow-kernel/workshops/synthetic/bindings.js');
const products = await import('../../../../dist/workflow-kernel/workshops/synthetic/products.js');
const universe = await import('../../../../dist/workflow-kernel/domain/universe.js');
const developmentInstallation = await import('../../../../dist/workflow-kernel/workshops/development/installation.js');
const schema = await import('../../../../dist/workflow-kernel/persistence/schema.js');

/* ------------------------------------------------------------------ */
/* Leg 1: the frozen registries are pinned at the base counts           */
/* ------------------------------------------------------------------ */

test('REGISTRY PIN: adding the synthetic workshop changed no frozen registry', () => {
  assert.equal(universe.AGGREGATE_NAMES.length, 9, 'the 9 owner aggregates are unchanged');
  assert.equal(universe.COMMAND_NAMES.length, 53, 'the 53-command universe is closed');
  assert.equal(universe.OBLIGATION_KINDS.length, 49, 'no new obligation kind was added');
  assert.equal(universe.WAIT_KINDS.length, 5, 'no new wait kind was added');
  assert.equal(universe.PROOF_KINDS.length, 28, 'no new proof kind was added');
  assert.equal(universe.EVIDENCE_KINDS.length, 67, 'no new evidence kind was added');
});

/* ------------------------------------------------------------------ */
/* Leg 4 (fast): the installation validates through the shared interface */
/* ------------------------------------------------------------------ */

test('INTERFACE EQUALITY: the synthetic installation validates through the Development validator (same semantic interface)', () => {
  const value = installation.syntheticReportingInstallation();
  // Structurally identical shape: the generic validator accepts it as-is.
  const validated = developmentInstallation.validateWorkshopInstallation(value);
  assert.equal(validated.valid, true, JSON.stringify(validated));
  assert.equal(value.identity.workshopId, 'workshop:synthetic-reporting');
  assert.ok(value.products.length >= 3, 'input and output product schemas are declared');
  assert.ok(value.checkPlans.length >= 3, 'the CheckPlan rows are declared');
  assert.ok(value.gates.length >= 3 && value.effects.length >= 1 && value.waits.length >= 2);
});

test('the synthetic bindings compile through the ONE path over frozen-schema-valid rows', () => {
  const compiled = bindings.compileReportingBindings();
  assert.equal(compiled.bound, true, JSON.stringify(compiled));
  const { author, reviewer, certifier } = compiled.value;
  assert.notEqual(author.contractDigest, reviewer.contractDigest, 'exact and separate identities');
  assert.equal(certifier.ownedCommand, 'lifecycleRun.verifyTerminalClaims', 'the D4 certifier is the shared frozen operator contract');
  // The lifecycle family class of the rows is READ from the frozen manifest.
  assert.equal(typeof compiled.value.workshopClass, 'string');
  assert.ok(compiled.value.workshopClass.length > 0);
});

test('the report product verification is pure data: stale dataset and missing sections refuse typed', () => {
  const draft = products.buildReportDraft('sha256:' + 'a'.repeat(64));
  const ok = products.verifyReportProduct(draft, { datasetDigest: products.datasetDigest(), sectionRefs: products.SYNTHETIC_SECTION_REFS });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.verified, ['dataset-digest-match', 'section-coverage']);
  const stale = products.verifyReportProduct(draft, { datasetDigest: 'f'.repeat(64), sectionRefs: products.SYNTHETIC_SECTION_REFS });
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /stale dataset/);
  const missing = products.verifyReportProduct(draft, { datasetDigest: products.datasetDigest(), sectionRefs: ['content://report-sections/extra'] });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /missing section refs/);
});

/* ------------------------------------------------------------------ */
/* Leg 2 + 3: the full run and the exercised-subset proof              */
/* ------------------------------------------------------------------ */

test('FULL RUN: the synthetic report workshop reaches the run terminal proof over the same kernel', async () => {
  const db = freshDatabase('ek-wp11v-syn-');
  const session = await db.open();
  const result = await scenario.runSyntheticReportingScenario(session);

  // Nothing refused, nothing blocked.
  assert.equal(result.blockedAt, undefined, JSON.stringify(result.run.steps.filter((s) => s.result.status !== 'committed' && s.result.status !== 'skipped')));
  const refused = result.run.steps.filter((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
  assert.deepEqual(refused, [], 'no step refused');

  // Every terminal proof of the ladder.
  const proofKinds = new Set(result.exercised.proofKinds);
  for (const kind of [
    'TerminalProof:cell.success',
    'TerminalProof:workplace.success',
    'TerminalProof:node.success',
    'TerminalProof:process.success',
    'TerminalProof:stage.success',
    'TerminalProof:lifecycle.success',
    'TerminalProof:run.success',
  ]) {
    assert.ok(proofKinds.has(kind), `${kind} issued by the synthetic run`);
  }
  assert.equal(session.hydrateWorld().world.heads.get('factory-run:1')?.terminal, 'TerminalProof:run.success');

  // The workshop output product mapped from the terminal facts.
  assert.equal(result.publishedReport.mapped, true, JSON.stringify(result.publishedReport));
  assert.equal(result.publishedReport.value.runTerminalOutcome, 'success');
  assert.match(result.publishedReport.value.acceptanceDigest, /^[0-9a-f]{64}$/);

  // The workshop's own role identities pinned the attempts.
  const intents = [...session.hydrateWorld().world.workIntents.values()];
  const authorIntent = intents.find((intent) => intent.protocolRole === 'author');
  const reviewerIntent = intents.find((intent) => intent.protocolRole === 'reviewer');
  assert.ok(authorIntent && reviewerIntent);
  assert.equal(authorIntent.roleContract.roleContractRef, `sha256:${result.bindings.author.contractDigest}`);
  assert.equal(reviewerIntent.roleContract.roleContractRef, `sha256:${result.bindings.reviewer.contractDigest}`);

  // Leg 3a: every exercised kind is a member of the frozen registries.
  assert.deepEqual(result.exercised.commands.filter((command) => !(universe.COMMAND_NAMES).includes(command)), [], 'no exercised command outside the frozen universe');
  assert.deepEqual(result.exercised.obligationKinds.filter((kind) => !(universe.OBLIGATION_KINDS).includes(kind)), [], 'no exercised obligation kind outside the frozen registry');
  assert.deepEqual(result.exercised.waitKinds.filter((kind) => !(universe.WAIT_KINDS).includes(kind)), [], 'no exercised wait kind outside the frozen registry');
  assert.deepEqual(result.exercised.evidenceKinds.filter((kind) => !(universe.EVIDENCE_KINDS).includes(kind)), [], 'no exercised evidence kind outside the frozen registry');
  assert.deepEqual(result.exercised.proofKinds.filter((kind) => !(universe.PROOF_KINDS).includes(kind)), [], 'no exercised proof kind outside the frozen registry');
  assert.deepEqual(result.exercised.aggregateHeads.filter((aggregate) => !(universe.AGGREGATE_NAMES).includes(aggregate)), [], 'no aggregate outside the nine owners');

  // Leg 3b: every table in the database belongs to the declared kernel
  // schema (the nine sole-writer aggregates + the shared ledger +
  // projections) - no private workshop table exists.
  const tables = session.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  const aggregatePrefixes = Object.values(schema.AGGREGATE_TABLE_PREFIXES ?? {});
  assert.equal(aggregatePrefixes.length, 9, 'the schema exports the nine aggregate table prefixes');
  const declared = new Set([...schema.SCHEMA_TABLES]);
  for (const table of tables) {
    assert.equal(
      declared.has(table) || /^sqlite_/.test(table),
      true,
      `table ${table} is not part of the kernel schema - a workshop may not own a private table`,
    );
  }
  session.close();
});

test('the synthetic run is idempotent: a full re-drive converges without new facts', async () => {
  const db = freshDatabase('ek-wp11v-syn-');
  const session = await db.open();
  const first = await scenario.runSyntheticReportingScenario(session);
  assert.equal(first.blockedAt, undefined);
  const eventsAfterFirst = session.hydrateWorld().world.events.length;
  const second = await scenario.runSyntheticReportingScenario(session);
  assert.equal(second.blockedAt, undefined, JSON.stringify(second.run.steps.filter((s) => s.result.status !== 'committed' && s.result.status !== 'skipped').slice(0, 3)));
  assert.equal(session.hydrateWorld().world.events.length, eventsAfterFirst, 'no duplicate WorkflowEvents on re-drive');
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM workplace_cell_final_acceptance').get().n, 1, 'exactly one CellFinalAcceptance after the re-drive');
  session.close();
});
