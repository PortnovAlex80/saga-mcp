import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('conveyor model links the universal diagnostic appendices', () => {
  const model = read('docs/architecture/CONVEYOR-MENTAL-MODEL.md');
  assert.match(model, /CONVEYOR-TRANSITION-DIAGNOSTICS\.md/);
  assert.match(model, /CONVEYOR-TRANSITION-CHECKLIST\.md/);
  assert.match(model, /thousandth workshop/);
});

test('diagnostics preserve evidence authority and define deterministic explanation', () => {
  const diagnostics = read('docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md');
  assert.match(diagnostics, /Domain state and evidence/);
  assert.match(diagnostics, /source of truth/);
  assert.match(diagnostics, /root unmet invariants/);
  assert.match(diagnostics, /Workshop\s+names are labels/);
  assert.match(diagnostics, /Silence alone never\s+proves a dead worker/);
});

test('transition checklist covers every universal boundary and artifact reuse', () => {
  const checklist = read('docs/architecture/CONVEYOR-TRANSITION-CHECKLIST.md');
  for (const section of [
    'Factory and workshop boundary',
    'Flow and production cell',
    'Desk, worker and provenance',
    'Review and quality gate',
    'Settlement, next workshop and effects',
    'Required incident card',
    'Conformance scenario for every new workshop',
  ]) {
    assert.ok(checklist.includes(section), `missing checklist section: ${section}`);
  }
  assert.match(checklist, /no completed LM production repeats/);
});
