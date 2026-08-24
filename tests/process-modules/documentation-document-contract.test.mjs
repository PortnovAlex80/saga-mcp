// tests/process-modules/documentation-document-contract.test.mjs
//
// Pure domain tests for the documentation document contract: the structured
// document validator, the per-kind required-section completeness projection
// and the document-kind registry defaults. No engine, no pdfkit — these are
// the same pure functions the author gate and the renderer consume.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DOCUMENTATION_KINDS,
  DOCUMENTATION_KINDS,
  missingRequiredSections,
  validateDocumentationDocument,
} from '../../dist/modules/documentation/domain/documentation-schemas.js';

function validDocument(overrides = {}) {
  return {
    schemaVersion: 'factory.documentation-document.v1',
    documentKind: 'user-manual',
    title: 'Руководство пользователя',
    locale: 'ru',
    sections: ['purpose', 'getting-started', 'usage', 'troubleshooting']
      .map(id => ({
        id,
        heading: `Раздел ${id}`,
        blocks: [{ type: 'paragraph', text: `Содержимое раздела ${id}.` }],
      })),
    generatedFor: {
      candidateHash: 'a'.repeat(64),
      productSubject: 'Test product',
    },
    ...overrides,
  };
}

test('a complete document validates', () => {
  const decoded = validateDocumentationDocument(validDocument());
  assert.equal(decoded.valid, true);
});

test('structural defects are rejected with concrete errors', () => {
  assert.equal(validateDocumentationDocument(null).valid, false);
  assert.equal(
    validateDocumentationDocument(validDocument({ schemaVersion: 'other' })).valid,
    false,
  );
  assert.equal(
    validateDocumentationDocument(validDocument({ documentKind: 'unknown' })).valid,
    false,
  );
  const duplicated = validDocument();
  duplicated.sections[1] = { ...duplicated.sections[0] };
  const decoded = validateDocumentationDocument(duplicated);
  assert.equal(decoded.valid, false);
  assert.ok(decoded.errors.some(error => error.includes('duplicated')));
  const emptyBlocks = validDocument();
  emptyBlocks.sections[0] = { id: 'purpose', heading: 'x', blocks: [] };
  assert.equal(validateDocumentationDocument(emptyBlocks).valid, false);
});

test('missing required sections are projected per kind', () => {
  const incomplete = validDocument();
  incomplete.sections = incomplete.sections.filter(s => s.id !== 'troubleshooting');
  const document = validateDocumentationDocument(incomplete);
  assert.equal(document.valid, true);
  assert.deepEqual(missingRequiredSections(document.document), ['troubleshooting']);

  const wrongKind = validDocument({ documentKind: 'acceptance-report' });
  const reinterpreted = validateDocumentationDocument(wrongKind);
  assert.equal(reinterpreted.valid, true);
  assert.ok(missingRequiredSections(reinterpreted.document).length > 0);
});

test('the default document set is user, programmer and acceptance report', () => {
  assert.deepEqual([...DEFAULT_DOCUMENTATION_KINDS], [
    'user-manual', 'programmer-manual', 'acceptance-report',
  ]);
  assert.ok(Object.hasOwn(DOCUMENTATION_KINDS, 'operator-manual'));
  for (const kind of Object.values(DOCUMENTATION_KINDS)) {
    assert.ok(kind.requiredSections.length >= 3, `${kind.id} requires sections`);
  }
});
