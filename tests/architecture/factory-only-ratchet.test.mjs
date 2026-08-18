// tests/architecture/factory-only-ratchet.test.mjs
//
// K1 commit 1/5 of the Saga Core Renewal program — RESTORED TARGET.
//
// package.json has referenced this file since the factory ratchet script
// was introduced, but the file did not exist at the evidence baseline
// (eb0ace82, confirmed by the 2026-08-17 external audit): the command
// meant to prevent old factory paths from returning was itself not
// executable. This file is the deliberate replacement target.
//
// First invariant restored here — script-target integrity:
//
//   No package.json script may invoke node against a local file (or glob)
//   that does not exist.
//
// This is the exact failure class that broke `npm run test:factory:ratchet`
// itself: a script pointing at a missing target. The ratchet fails the
// suite the moment any script gains a dangling reference, so a broken
// verification command can never again ship silently.
//
// Later K-releases extend this file with the factory-only surface
// ratchets (K2 legacy inventory; K7 authority SQL bans; K16/K17 zero
// allowlists).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

/** Collect local filesystem targets referenced by one script string. */
function scriptTargets(script) {
  const targets = [];
  for (const segment of script.split('&&')) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith('node')) continue;
    const tokens = trimmed.split(/\s+/).slice(1);
    for (const token of tokens) {
      if (token === '-e') break; // inline code, not a file target
      if (token.startsWith('-')) continue; // flags (--test, --test-concurrency=1)
      const clean = token.replace(/^["']|["']$/g, '');
      if (!clean.includes('/')) continue;
      // Build outputs exist only after `npm run build`; their integrity is
      // the build script's concern, not this ratchet's.
      if (clean.startsWith('dist/')) continue;
      targets.push(clean);
    }
  }
  return targets;
}

/** Expand a path that may contain a basename glob (tests/foo/*.test.mjs). */
function globMatches(pattern) {
  const clean = pattern.replace(/"/g, '');
  const globStar = clean.indexOf('*');
  if (globStar === -1) {
    return { ok: existsSync(join(repoRoot, clean)), sample: clean };
  }
  const dir = dirname(clean);
  const base = clean.slice(globStar);
  const baseRe = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const absDir = join(repoRoot, dir);
  if (!existsSync(absDir)) return { ok: false, sample: clean };
  const matches = readdirSync(absDir).filter((f) => baseRe.test(f));
  return { ok: matches.length > 0, sample: clean };
}

test('the factory ratchet command itself resolves to this file', () => {
  assert.equal(pkg.scripts['test:factory:ratchet'], 'node --test tests/architecture/factory-only-ratchet.test.mjs');
  assert.ok(existsSync(join(repoRoot, 'tests/architecture/factory-only-ratchet.test.mjs')));
});

test('no package script references a missing node target', () => {
  const broken = [];
  for (const [name, script] of Object.entries(pkg.scripts)) {
    for (const target of scriptTargets(script)) {
      const { ok, sample } = globMatches(target);
      if (!ok) broken.push(`${name} -> ${sample}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    `package.json scripts reference missing targets (the exact class that broke test:factory:ratchet at the baseline):\n${broken.map((b) => `  ${b}`).join('\n')}`,
  );
});
