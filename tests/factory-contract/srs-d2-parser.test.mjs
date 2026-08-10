// tests/factory-contract/srs-d2-parser.test.mjs
//
// Regression tests for the SRS §D2 stanza parser and §12 Decision Log checker.
// The parser is intentionally strict: one fenced YAML block inside §D2.
// Subsection/heading/table representations are NOT the canonical contract
// (ADR-042 provider-led verification, strict YAML-only representation).

import { test } from 'node:test';
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const mod = await import(pathToFileURL(path.resolve('dist/modules/formalization/application/srs-d2-parser.js')).href);
const { extractD2Stanzas, checkDecisionLogSection } = mod;

test('D2 YAML code block format: - ac: AC-1 with indented fields parsed correctly', () => {
  const srs = [
    '## §D2 AC Decomposition',
    '',
    '```yaml',
    '- ac: AC-1',
    '  module: editor',
    '  pattern: A',
    '  depends_on: "[]"',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '- ac: AC-2',
    '  module: preview',
    '  pattern: B',
    '  depends_on: "AC-1"',
    '  ac_kind: verification',
    '  criticality: degradable',
    '```',
    '',
    '## After',
    '',
  ].join('\n');
  const stanzas = extractD2Stanzas(srs);
  assert.equal(stanzas.length, 2);
  assert.equal(stanzas[0].ac, 'AC-1');
  assert.equal(stanzas[0].fields.get('pattern'), 'A');
  assert.equal(stanzas[0].fields.get('ac_kind'), 'implementation');
  assert.equal(stanzas[1].ac, 'AC-2');
  assert.equal(stanzas[1].fields.get('criticality'), 'degradable');
});

test('D2 subsection format (bare ac:) is NOT accepted — strict YAML-only', () => {
  const srs = [
    '## §D2: AC Decomposition',
    '',
    '### AC-1: First',
    'ac: AC-1',
    'module/files: editor',
    'pattern: A',
    'ac_kind: implementation',
    'criticality: blocker',
    '',
    '## After',
  ].join('\n');
  const stanzas = extractD2Stanzas(srs);
  assert.equal(stanzas.length, 0, 'subsection format must not be guessed into acceptance');
});

test('D2 heading D.2 (with dot) matched same as D2', () => {
  const srs = [
    '### §D.2 AC Decomposition',
    '',
    '```yaml',
    '- ac: AC-1',
    '  pattern: A',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '```',
    '',
    '## Next',
  ].join('\n');
  const stanzas = extractD2Stanzas(srs);
  assert.equal(stanzas.length, 1);
  assert.equal(stanzas[0].ac, 'AC-1');
});

test('D2 without fenced code block returns 0 stanzas', () => {
  const srs = [
    '## §D2 AC Decomposition',
    '',
    'Some text without code block.',
    '',
    '## After',
  ].join('\n');
  const stanzas = extractD2Stanzas(srs);
  assert.equal(stanzas.length, 0);
});

test('§12 Decision Log subsection format accepted', () => {
  const srs = [
    '## §12. Decision Log',
    '',
    '### Decision 1: Style Selection',
    'We chose Simple Modular Architecture because it fits XS complexity.',
    '',
    '### Decision 2: Vanilla JS',
    'No external dependencies per constraints.',
    '',
    '## §D1',
  ].join('\n');
  const result = checkDecisionLogSection(srs);
  assert.equal(result, null, 'subsection decision log should be accepted');
});

test('§12 Decision Log markdown table format accepted', () => {
  const srs = [
    '## §12 Decision Log',
    '',
    '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
    '|---|----------|---------------|------------------------|-----------|------|',
    '| 1 | Modular | XS | Monolith | Simple | 2026-08 |',
    '',
    '## §D1',
  ].join('\n');
  const result = checkDecisionLogSection(srs);
  assert.equal(result, null, 'table decision log with ≥6 columns should be accepted');
});

test('§12 Decision Log missing entirely rejected', () => {
  const srs = [
    '## Other Section',
    '',
    'Some content.',
  ].join('\n');
  const result = checkDecisionLogSection(srs);
  assert.ok(result !== null, 'missing decision log should be rejected');
  assert.ok(result.includes('missing'), `expected missing message, got: ${result}`);
});

test('D2 section boundary: ### subsections inside ## D2 do not truncate section', () => {
  const srs = [
    '## §D2 AC Decomposition',
    '',
    '```yaml',
    '- ac: AC-1',
    '  module: editor',
    '  pattern: A',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '- ac: AC-2',
    '  module: preview',
    '  pattern: A',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '```',
    '',
    '## §D3 Priority',
  ].join('\n');
  const stanzas = extractD2Stanzas(srs);
  assert.equal(stanzas.length, 2, 'both stanzas must be extracted from fenced block');
});
