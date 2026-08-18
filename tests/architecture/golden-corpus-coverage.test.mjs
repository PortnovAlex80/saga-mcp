/**
 * The scripted-worker corpus is real, complete and fail-closed.
 *
 * Stage 2 of the conveyor plan feeds LLM imitators from material a real model
 * produced and real gates ACCEPTED (a captured golden run), instead of prose
 * invented for the harness. These tests pin the three properties that make such
 * a corpus trustworthy:
 *
 *   1. it carries the material of every workshop the lifecycle installs;
 *   2. its payloads are the captured bytes, not a re-authored approximation;
 *   3. asking for absent material FAILS rather than silently degrading — an
 *      imitator that invents text proves nothing about the factory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpus } from '../mock-claude/corpus.mjs';

const corpus = loadCorpus();

test('the corpus covers every workshop of the installed product lifecycle', () => {
  const nodes = corpus.nodes();
  // One representative producing node per workshop of product-build/delivery.
  const required = {
    discovery: ['produce-proposal', 'assess-readiness'],
    formalization: [
      'define-product-contract',
      'model-use-cases',
      'define-acceptance-contract',
      'define-architecture-contract',
      'reconcile-what',
    ],
    development: ['plan-task-graph', 'implement-work-items'],
  };
  for (const [workshop, expected] of Object.entries(required)) {
    for (const nodeId of expected) {
      assert.ok(
        nodes.includes(nodeId),
        `${workshop}: corpus must carry material for node '${nodeId}' (have: ${nodes.join(', ')})`,
      );
    }
  }
});

test('the corpus carries the typed products each workshop hands downstream', () => {
  // These are the schemas the next stage actually consumes — the handoff
  // surface. Material for them is what makes a scripted run non-vacuous.
  const handoffs = [
    ['produce-proposal', 'factory.discovery-proposal.v1'],
    ['assess-readiness', 'factory.discovery-readiness-assessment.v1'],
    ['define-product-contract', 'factory.formalization-product-bundle.v1'],
    ['define-acceptance-contract', 'factory.formalization-acceptance-bundle.v1'],
    ['define-architecture-contract', 'factory.formalization-architecture-bundle.v1'],
    ['implement-work-items', 'factory.development-implementation-result.v1'],
  ];
  for (const [nodeId, schemaId] of handoffs) {
    const payload = corpus.product(nodeId, schemaId);
    assert.equal(typeof payload, 'object', `${nodeId}/${schemaId} must parse`);
    assert.ok(payload !== null, `${nodeId}/${schemaId} must not be null`);
    assert.ok(
      Object.keys(payload).length > 0,
      `${nodeId}/${schemaId} must carry real content, not an empty envelope`,
    );
  }
});

test('the corpus carries the produced requirement documents, not stubs', () => {
  const prd = corpus.document('01-PRD.md');
  const srs = corpus.document('05-SRS.md');
  const acceptance = corpus.document('03-acceptance-criteria.md');
  // A real produced PRD/SRS is substantial; a stub would sail through a test
  // that only checks for a non-empty string.
  assert.ok(prd.split('\n').length > 50, 'PRD is a produced document');
  assert.ok(srs.split('\n').length > 200, 'SRS is a produced document');
  assert.match(acceptance, /AC-/, 'acceptance criteria carry criterion codes');
});

test('every harvested product descriptor points at a readable payload', () => {
  for (const descriptor of corpus.manifest.products) {
    const payload = corpus.product(
      descriptor.nodeId, descriptor.schemaId, descriptor.ordinal,
    );
    assert.ok(payload !== undefined,
      `${descriptor.file} must be readable through the loader`);
    assert.ok(descriptor.sourcePayloadHash.length > 0,
      `${descriptor.file} must record the hash of the captured bytes`);
  }
});

test('the loader fails closed on absent material — an imitator never invents text', () => {
  assert.throws(
    () => corpus.product('no-such-node', 'factory.discovery-proposal.v1'),
    /GOLDEN_CORPUS_PRODUCT_ABSENT/,
  );
  assert.throws(
    () => corpus.product('produce-proposal', 'factory.no-such-schema.v1'),
    /GOLDEN_CORPUS_PRODUCT_ABSENT/,
  );
  assert.throws(
    () => corpus.document('no-such-document.md'),
    /GOLDEN_CORPUS_DOCUMENT_ABSENT/,
  );
});

test('the absence message names what the node DOES have, so a gap is actionable', () => {
  try {
    corpus.product('produce-proposal', 'factory.no-such-schema.v1');
    assert.fail('expected the loader to fail closed');
  } catch (error) {
    assert.match(error.message, /available for node 'produce-proposal'/);
    assert.match(error.message, /factory\.discovery-proposal\.v1/);
  }
});
