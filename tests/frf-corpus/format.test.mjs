/**
 * format.test.mjs - the FRF scenario-contract extension suite (FRF-WP10):
 *   - every corpus descriptor validates against the ADDITIVE contract
 *     (the EK base validated by the EK validator + the frf block by the
 *     extension's closed vocabulary);
 *   - closed-vocabulary rejections (unknown dimension, verdict, refusal
 *     reason, binding kind, mutation kind, bad kind-target pair, two
 *     crashes, wait-anchor misuse, missing dimension-required section);
 *   - every mirrored vocabulary is PINNED against its source of truth
 *     (the WP03 validators and the cell declarations) by set equality;
 *   - the scenario digest is deterministic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FRF_BINDING_DOMAIN_KINDS,
  FRF_CLOSURE_VERDICTS,
  FRF_DESK_CHAIN,
  FRF_DESK_VERDICTS,
  FRF_REFUSAL_REASONS,
  frfScenarioDigest,
  validateFrfScenario,
  wp03HandoffBindingKinds,
} from '../../tools/frf-corpus/format.mjs';
import { frfCorpus, SMOKE_SCENARIO_IDS } from '../../tools/frf-corpus/lib/registry.mjs';

const ROOT = join(dirnameOf(import.meta.url), '..', '..');
const dist = (relative) => import(pathToFileURL(join(ROOT, 'dist', `${relative}.js`)).href);
const srcAbs = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

function dirnameOf(url) {
  return join(fileURLToPath(url), '..');
}

const baseDoc = async () => {
  const corpus = await frfCorpus();
  return structuredClone(corpus[0]);
};

test('every corpus descriptor validates against the additive FRF scenario contract', async () => {
  const corpus = await frfCorpus();
  assert.equal(corpus.length, 11);
  for (const descriptor of corpus) {
    const { valid, errors } = validateFrfScenario(descriptor);
    assert.equal(valid, true, `${descriptor.frf.scenarioId}: ${JSON.stringify(errors)}`);
  }
});

test('the smoke subset is a strict subset of the corpus', async () => {
  const corpus = await frfCorpus();
  const ids = corpus.map((descriptor) => descriptor.frf.scenarioId);
  for (const id of SMOKE_SCENARIO_IDS) assert.equal(ids.includes(id), true);
});

test('the EK base sections are still validated by the EK contract (additive, not a bypass)', async () => {
  const doc = await baseDoc();
  delete doc.seedInput; // a required EK base key
  const { valid, errors } = validateFrfScenario(doc);
  assert.equal(valid, false);
  assert.equal(errors.some((error) => error.path === '$.seedInput' && error.code === 'missing-key'), true);
});

test('a missing frf block is refused', async () => {
  const doc = await baseDoc();
  delete doc.frf;
  const { valid, errors } = validateFrfScenario(doc);
  assert.equal(valid, false);
  assert.equal(errors[0].path, '$.frf');
});

test('unknown keys inside the frf block are refused (closed shape)', async () => {
  const doc = await baseDoc();
  doc.frf.surprise = true;
  const { valid, errors } = validateFrfScenario(doc);
  assert.equal(valid, false);
  assert.equal(errors.some((error) => error.code === 'unknown-key' && error.path === '$.frf'), true);
});

test('unknown dimension, verdict, refusal reason, binding kind and fault anchor are refused', async () => {
  const doc = await baseDoc();
  doc.frf.dimension = 'not-a-dimension';
  assert.equal(validateFrfScenario(doc).valid, false);

  const doc2 = await baseDoc();
  doc2.frf.expectedWorld.verdicts[0].verdict = 'deferred';
  const errors2 = validateFrfScenario(doc2).errors;
  assert.equal(errors2.some((error) => error.code === 'not-in-vocabulary'), true);

  const doc3 = await baseDoc();
  doc3.frf.expectedWorld.verdicts[0].desk = 'not-a-desk';
  assert.equal(validateFrfScenario(doc3).valid, false);

  const doc4 = await baseDoc();
  doc4.frf.expectedWorld.refusals = [{ target: 'plan-development', reason: 'TOTALLY_UNKNOWN' }];
  assert.equal(validateFrfScenario(doc4).valid, false);

  const doc5 = await baseDoc();
  doc5.frf.expectedWorld.bindingDomains[0].kind = 'not-a-binding-kind';
  assert.equal(validateFrfScenario(doc5).valid, false);

  const doc6 = await baseDoc();
  doc6.frf.faultSchedule = [{ fault: 'crash-before-desk', anchor: 'not-an-anchor' }];
  assert.equal(validateFrfScenario(doc6).valid, false);
});

test('a mutation kind may not target a surface outside its lawful pairs', async () => {
  const doc = await baseDoc();
  doc.frf.mutations = [{ kind: 'foreign-binding', target: 'define-architecture-contract:entrypoint' }];
  const { valid, errors } = validateFrfScenario(doc);
  assert.equal(valid, false);
  assert.equal(errors.some((error) => error.code === 'invalid-value' && error.path === '$.frf.mutations[0].target'), true);
});

test('a schedule with two crashes is refused (one process dies once)', async () => {
  const doc = await baseDoc();
  doc.frf.faultSchedule = [
    { fault: 'crash-before-desk', anchor: 'freeze-what-baseline' },
    { fault: 'crash-after-desk', anchor: 'settle-formalization' },
  ];
  const { valid, errors } = validateFrfScenario(doc);
  assert.equal(valid, false);
  assert.equal(errors.some((error) => error.message.includes('one process dies once')), true);
});

test('evidence-commit and wait-disposition crashes anchor only at their seams', async () => {
  const doc = await baseDoc();
  doc.frf.faultSchedule = [{ fault: 'crash-before-evidence-commit', anchor: 'plan-development' }];
  assert.equal(validateFrfScenario(doc).valid, false);
  const doc2 = await baseDoc();
  doc2.frf.faultSchedule = [{ fault: 'crash-before-wait-disposition', anchor: 'freeze-what-baseline' }];
  assert.equal(validateFrfScenario(doc2).valid, false);
});

test('dimension-required expectation sections are enforced', async () => {
  const doc = await baseDoc();
  delete doc.frf.expectedWorld.bindingDomains;
  const { valid, errors } = validateFrfScenario(doc);
  assert.equal(valid, false);
  assert.equal(errors.some((error) => error.code === 'missing-key' && error.path === '$.frf.expectedWorld.bindingDomains'), true);
});

test('the scenarioId pattern is enforced', async () => {
  const doc = await baseDoc();
  doc.frf.scenarioId = 'Not An Id';
  assert.equal(validateFrfScenario(doc).valid, false);
});

/* ------------------------------------------------------------------ */
/* Vocabulary pins (mirrors vs their sources of truth)                 */
/* ------------------------------------------------------------------ */

test('PIN: the seven typed refusal reasons equal the frozen cell refusal vocabulary', async () => {
  const sysreq = await dist('workflow-kernel/workshops/formalization/cells/system-requirements/index');
  assert.deepEqual([...FRF_REFUSAL_REASONS].sort(), [...sysreq.REFUSAL_REASONS].sort());
});

test('PIN: the twelve binding-domain kinds equal the WP03 what-baseline validator list', () => {
  assert.deepEqual([...FRF_BINDING_DOMAIN_KINDS].sort(), [...wp03HandoffBindingKinds()].sort());
  assert.equal(FRF_BINDING_DOMAIN_KINDS.length, 12);
});

test('PIN: the desk verdict vocabularies equal the cell gate/outcome tables', async () => {
  const acceptance = await srcAbs('src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'index.mjs');
  const whatFreezeProtocol = await srcAbs('src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'protocol.mjs');
  const five = [...acceptance.GATE_VERDICTS].sort();
  for (const desk of ['define-product-intent', 'model-use-cases', 'derive-system-requirements', 'define-acceptance-contract', 'define-architecture-contract']) {
    assert.deepEqual([...FRF_DESK_VERDICTS[desk]].sort(), five, `${desk} verdict vocabulary must be the frozen five`);
  }
  assert.deepEqual([...whatFreezeProtocol.FREEZE_OUTCOMES].sort(), [...FRF_DESK_VERDICTS['freeze-what-baseline']].sort());
  assert.deepEqual([...whatFreezeProtocol.SETTLE_OUTCOMES].sort(), [...FRF_DESK_VERDICTS['settle-formalization']].sort());
  assert.deepEqual([...FRF_CLOSURE_VERDICTS], ['consistent', 'gaps']);
});

test('PIN: the desk chain ids equal the cell protocol declarations', async () => {
  const productIntent = await dist('workflow-kernel/workshops/formalization/cells/product-intent/index');
  const useCases = await dist('workflow-kernel/workshops/formalization/cells/use-cases/index');
  const sysreq = await dist('workflow-kernel/workshops/formalization/cells/system-requirements/index');
  const srs = await dist('workflow-kernel/workshops/formalization/cells/srs-realization/index');
  const acceptance = await srcAbs('src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'index.mjs');
  const whatFreezeProtocol = await srcAbs('src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'protocol.mjs');
  const declared = [
    productIntent.PRODUCT_INTENT_CELL_ID,
    useCases.UC_CELL_ID,
    sysreq.SYSTEM_REQUIREMENTS_DESK_ID,
    acceptance.ACCEPTANCE_CELL_NODE_ID,
    'reconcile-what',
    whatFreezeProtocol.FREEZE_NODE_ID,
    srs.SRS_REALIZATION_DESK_ID,
    whatFreezeProtocol.SETTLE_NODE_ID,
    'admit-development-case',
    'plan-development',
  ];
  assert.deepEqual([...FRF_DESK_CHAIN], declared);
});

test('the scenario digest is deterministic and content-addressed', async () => {
  const corpus = await frfCorpus();
  const first = frfScenarioDigest(corpus[0]);
  const second = frfScenarioDigest(structuredClone(corpus[0]));
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  const digests = new Set(corpus.map((descriptor) => frfScenarioDigest(descriptor)));
  assert.equal(digests.size, corpus.length);
});
