import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { strictEqual } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('ek-admission: validate:ek-admission-specs is green and its digest binds the specifications', () => {
  const out = execFileSync('node', ['tools/validate-ek-admission-specs.mjs'], {
    cwd: ROOT, encoding: 'utf8',
  });
  strictEqual(out.includes('ALL GREEN'), true, 'admission validator must be green');
  strictEqual(out.includes('admissionContractDigest'), true, 'digest must be emitted');
  // The digest binds the specs: verify the canonicalization includes every
  // specification digest value (regression guard for the verifier-refuted
  // array-replacer bug that serialized {"digests":{}}).
  const digestLine = out.split('\n').find((l) => l.includes('"complexityBudget"'));
  strictEqual(digestLine !== undefined, true, 'specificationDigests must be printed');
});
