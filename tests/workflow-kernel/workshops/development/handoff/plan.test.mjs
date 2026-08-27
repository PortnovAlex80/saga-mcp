/**
 * plan.test.mjs - the FRF-WP09 planning gates: WorkItem bindings, the
 * typed obligation kinds, and THE AUDIT'S NAMED GAP KILL (ledger D-4 /
 * reverse cr-01): an AC-complete-but-scenario-incomplete task graph is
 * REFUSED typed before Development execution.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGreenCase,
  buildGreenWorkItems,
  deepClone,
  greenWorkItemInputs,
  handoffModule,
  planGreenCase,
} from './support.mjs';

test('GREEN PATH: the green task graph passes every planning gate and seals content-addressed', async () => {
  const record = await buildGreenCase();
  const planned = await planGreenCase(record);
  assert.equal(planned.plan.schemaVersion, 'frf-development.plan.v1');
  assert.match(planned.plan.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(planned.plan.caseDigest, record.developmentCase.caseDigest);
  assert.equal(planned.plan.handoffFingerprint, record.developmentCase.handoffFingerprint);
  assert.deepEqual(planned.coverage.acceptanceCriteria, ['ac:batch-error-1', 'ac:checkout-end-1']);
  assert.deepEqual(planned.coverage.realizationEntries, ['realization:uc-batch-1', 'realization:uc-checkout-1']);
  assert.deepEqual(planned.coverage.requirements, ['fr:batch-1', 'fr:cart-1', 'nfr:retention-1', 'rule:audit-1']);
  assert.deepEqual(planned.coverage.surfaces, ['module:audit-log', 'svc:batch-runner', 'svc:cart-api']);
  assert.deepEqual(planned.coverage.verifiers, ['realization:uc-batch-1', 'realization:uc-checkout-1']);
});

test('GREEN PATH: typed infrastructure obligations that do not map one-to-one to an AC are first-class plan citizens', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  const workItems = await buildGreenWorkItems([
    ...greenWorkItemInputs(),
    {
      infrastructure: ['module:audit-log'],
      summary: 'audit-log hardening: typed infrastructure obligation, no AC behind it',
      workItemId: 'wi:audit-hardening',
    },
  ]);
  const planned = plan.planDevelopment(record.developmentCase, workItems);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.plan.workItems.map((w) => w.workItemId), ['wi:checkout', 'wi:batch', 'wi:verify', 'wi:audit-hardening']);
});

test('LAW: a WorkItem binds one or more of the five obligation kinds (edge/0031)', async () => {
  const workitem = await handoffModule('workitem');
  const empty = workitem.buildWorkItem({ summary: 'obligation-free', workItemId: 'wi:empty' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'MISSING_LINEAGE');
  assert.match(empty.detail, /edge\/0031/);
});

test('LAW: every WorkItem obligation resolves against the case domains (foreign obligations never enter a plan)', async () => {
  const record = await buildGreenCase();
  const workitem = await handoffModule('workitem');
  const plan = await handoffModule('plan');
  const seeds = [
    { input: { acceptance: ['ac:FOREIGN-never-accepted'], workItemId: 'wi:foreign-ac' }, domain: 'acceptance-bindings domain' },
    { input: { requirements: ['fr:FOREIGN-never-derived'], workItemId: 'wi:foreign-fr' }, domain: 'requirement-bindings domain' },
    { input: { scenarioRealization: ['realization:FOREIGN'], workItemId: 'wi:foreign-entry' }, domain: 'scenario-realization-bindings domain' },
    { input: { infrastructure: ['svc:FOREIGN-runner'], workItemId: 'wi:foreign-surface' }, domain: 'integration-and-construction-obligations domain' },
  ];
  for (const seed of seeds) {
    const built = workitem.buildWorkItem(seed.input);
    assert.equal(built.ok, true);
    const validation = workitem.validateWorkItem(built.workItem, record.developmentCase);
    assert.equal(validation.ok, false, `the foreign ${seed.input.workItemId} obligation must be refused`);
    assert.equal(validation.reason, 'FOREIGN_LINEAGE');
    assert.match(validation.detail, /outside the DevelopmentCase/);
    // And the plan gate inherits the kill.
    const planned = plan.planDevelopment(record.developmentCase, [built.workItem, ...(await buildGreenWorkItems())]);
    assert.equal(planned.ok, false);
    assert.equal(planned.reason, 'FOREIGN_LINEAGE');
  }
});

test('LAW: a scenario-realization obligation carries the entry\'s terminal result or is refused', async () => {
  const record = await buildGreenCase();
  const workitem = await handoffModule('workitem');
  const built = workitem.buildWorkItem({
    scenarioRealization: [{ realizationEntryId: 'realization:uc-checkout-1', terminalResult: 'terminal:FOREIGN-result' }],
    workItemId: 'wi:wrong-terminal',
  });
  const validation = workitem.validateWorkItem(built.workItem, record.developmentCase);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'DRIFT_DETECTED');
  assert.match(validation.detail, /terminal result/);
});

test('AUDIT KILL (D-4 / cr-01): an AC-complete but scenario-incomplete task graph is REFUSED typed', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  // Every AC criterion covered, every requirement covered, every surface
  // covered - but NO scenario-realization obligation anywhere: the exact
  // shape the audit found ("no AC-complete-but-scenario-incomplete task
  // graph check").
  const acOnly = await buildGreenWorkItems([
    {
      acceptance: ['ac:checkout-end-1', 'ac:batch-error-1'],
      infrastructure: ['module:audit-log', 'svc:batch-runner'],
      integration: ['svc:cart-api'],
      requirements: ['fr:cart-1', 'fr:batch-1', 'nfr:retention-1', 'rule:audit-1'],
      summary: 'the AC-complete disconnected graph',
      workItemId: 'wi:ac-all',
    },
  ]);
  const planned = plan.planDevelopment(record.developmentCase, acOnly);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'COVERAGE_GAP');
  assert.match(planned.detail, /scenario-incomplete/);
  assert.match(planned.detail, /covers every AC criterion/);
  assert.match(planned.detail, /realization:uc-checkout-1/);
});

test('AUDIT KILL (D-4 / cr-01): dropping ONE scenario identity from an otherwise complete plan refuses the plan', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  const inputs = greenWorkItemInputs().map((input) => (
    input.workItemId === 'wi:batch' ? { ...input, scenarioRealization: [], acceptance: ['ac:batch-error-1'] } : input
  ));
  const workItems = await buildGreenWorkItems(inputs);
  const planned = plan.planDevelopment(record.developmentCase, workItems);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'COVERAGE_GAP');
  assert.match(planned.detail, /scenario-incomplete/);
  assert.match(planned.detail, /realization:uc-batch-1/);
});

test('AUDIT KILL (cr-01, surfaces): an entrypoint/runtime-edge/composition-owner surface omitted from the plan is refused', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  // wi:batch drops the composition owner svc:cart-api AND its own runner;
  // wi:verify keeps the verifier obligations so ONLY the surface gate can fire.
  const inputs = greenWorkItemInputs().map((input) => (
    input.workItemId === 'wi:batch'
      ? { ...input, infrastructure: [], integration: [], requirements: ['fr:batch-1', 'nfr:retention-1', 'rule:audit-1'] }
      : input
  ));
  const workItems = await buildGreenWorkItems(inputs);
  const planned = plan.planDevelopment(record.developmentCase, workItems);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'COVERAGE_GAP');
  assert.match(planned.detail, /scenario-incomplete/);
  assert.match(planned.detail, /svc:batch-runner|svc:cart-api/);
});

test('AUDIT KILL (edge/0032, verifier): a plan covering every AC but omitting the verifier is invalid', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  const inputs = greenWorkItemInputs()
    .map((input) => ({ ...input, verifier: undefined }))
    .filter((input) => input.workItemId !== 'wi:verify');
  inputs.push({ acceptance: ['ac:checkout-end-1', 'ac:batch-error-1'], summary: 'AC coverage without verification', workItemId: 'wi:no-verifier' });
  const workItems = await buildGreenWorkItems(inputs);
  const planned = plan.planDevelopment(record.developmentCase, workItems);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'COVERAGE_GAP');
  assert.match(planned.detail, /verifier-omitted/);
  assert.match(planned.detail, /ev:test-1/);
});

test('AUDIT KILL (edge/0038, disconnected local task): a multi-module scenario cannot be one disconnected local task', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  // wi:batch keeps its own local runner + audit-log surfaces but drops
  // the composition owner: alone it "realizes" the multi-module batch
  // scenario while binding none of the composition.
  const inputs = greenWorkItemInputs().map((input) => (
    input.workItemId === 'wi:batch' ? { ...input, integration: [] } : input
  ));
  const workItems = await buildGreenWorkItems(inputs);
  const planned = plan.planDevelopment(record.developmentCase, workItems);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'COVERAGE_GAP');
  assert.match(planned.detail, /disconnected-local-task/);
  assert.match(planned.detail, /uc:batch-1/);
  assert.match(planned.detail, /svc:cart-api/);
});

test('AUDIT KILL (verifier fidelity): a verifier obligation must carry the frozen evidence method exactly', async () => {
  const record = await buildGreenCase();
  const workitem = await handoffModule('workitem');
  const built = workitem.buildWorkItem({
    acceptance: ['ac:checkout-end-1'],
    verifier: [{ evidenceBindingRef: 'ev:audit-1', evidenceKind: 'audit', realizationEntryId: 'realization:uc-checkout-1' }],
    workItemId: 'wi:wrong-evidence',
  });
  const validation = workitem.validateWorkItem(built.workItem, record.developmentCase);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'DRIFT_DETECTED');
  assert.match(validation.detail, /accepted evidence is test\/ev:test-1/);
});

test('GATE (AC coverage): an uncovered AC criterion refuses the plan even with full scenario coverage', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  // wi:batch drops its AC obligation; wi:verify stops backstopping
  // ac:batch-error-1 - so ONLY the AC gate can fire (scenario, surface,
  // requirement and verifier coverage all stay complete).
  const inputs = greenWorkItemInputs().map((input) => {
    if (input.workItemId === 'wi:batch') return { ...input, acceptance: [] };
    if (input.workItemId === 'wi:verify') return { ...input, acceptance: ['ac:checkout-end-1'] };
    return input;
  });
  const workItems = await buildGreenWorkItems(inputs);
  const planned = plan.planDevelopment(record.developmentCase, workItems);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'COVERAGE_GAP');
  assert.match(planned.detail, /ac:batch-error-1/);
});

test('GATE (requirement preservation): planning preserves FR/NFR/RULE identities in addition to AC identities', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  const inputs = greenWorkItemInputs().map((input) => (
    input.workItemId === 'wi:batch' ? { ...input, requirements: ['fr:batch-1'] } : input
  ));
  const workItems = await buildGreenWorkItems(inputs);
  const planned = plan.planDevelopment(record.developmentCase, workItems);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'COVERAGE_GAP');
  assert.match(planned.detail, /nfr:retention-1/);
  assert.match(planned.detail, /rule:audit-1/);
});

test('GATE (malformed): duplicate WorkItem ids and empty plans are refused', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  const empty = plan.planDevelopment(record.developmentCase, []);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'MISSING_LINEAGE');
  const workItems = await buildGreenWorkItems();
  const duplicated = plan.planDevelopment(record.developmentCase, [...workItems, deepClone(workItems[0])]);
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.reason, 'MALFORMED_PRODUCT');
  assert.match(duplicated.detail, /wi:checkout/);
});

test('CONSUMER GATE: validateDevelopmentPlan re-runs the ladder and verifies the seal', async () => {
  const record = await buildGreenCase();
  const plan = await handoffModule('plan');
  const planned = await planGreenCase(record);
  const validation = plan.validateDevelopmentPlan(planned.plan, record.developmentCase);
  assert.equal(validation.ok, true);
  const tampered = deepClone(planned.plan);
  tampered.planDigest = '0'.repeat(64);
  const tamperedValidation = plan.validateDevelopmentPlan(tampered, record.developmentCase);
  assert.equal(tamperedValidation.reason, 'DRIFT_DETECTED');
  const stale = deepClone(planned.plan);
  stale.caseDigest = '1'.repeat(64);
  const staleValidation = plan.validateDevelopmentPlan(stale, record.developmentCase);
  assert.equal(staleValidation.reason, 'STALE_LINEAGE');
});
