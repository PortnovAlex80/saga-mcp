// tests/modules/development/readiness-test-surface.test.mjs
//
// CC-GLOB-SURFACE — focused unit tests for the PURE declared-test-surface
// tokenizer (src/modules/development/domain/readiness-test-surface.ts).
//
// The Elite-6 empirical case these pin: a readiness declaration stated
// `node --test tests/**/*.test.js` (the sealed package.json scripts.test said
// the same). The pre-fix parser matched the GLOB TOKEN against the test-file
// suffix regex and "enumerated" it as one literal nonexistent file:
//
//   resolveDeclaredTestSurface → declaration-enumerated ['tests/**/*.test.js']
//   → coverage report: "executed 1 of 22" (21 real canonical files + the
//     phantom glob string as the 22nd canonical entry)
//   → derived-canonical surgery: the 21 real files appended AFTER the glob
//     that already denotes the whole tree — duplicate explicit additions
//     over directory-shaped coverage.
//
// Required semantics (CC-GLOB-SURFACE):
//   - a whole-tree glob rooted at a test directory (`tests/**/*.test.js`) is
//     DIRECTORY COVERAGE of that tree — canonical files underneath are
//     covered, no duplicate explicit files are appended;
//   - a partial/subdirectory glob must not be overclaimed as whole-tree
//     coverage — the pure parser cannot expand it deterministically (no fs,
//     no shell), so it stays honestly unresolved-opaque;
//   - literal test files, directory-shaped tokens and npm-script resolution
//     preserve their current behavior (ratchet);
//   - no shell glob expansion, no filesystem authority, no runner-specific
//     guessing is added — recognition is by token SHAPE only.
//
// The `enforceDerivedCanonicalMirror` helper below mirrors, branch for
// branch, the decision order of enforceDerivedCanonicalTestSet in
// src/infrastructure/verification/local-runnability-check-provider.ts (the
// provider-level truth is pinned separately by
// tests/infrastructure/local-runnability-derived-canonical.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDeclaredTestSurface,
  extractTestFileTokens,
  extractTestDirectoryToken,
  isNpmStyleTestCommand,
  withTestFilesExtendedTo,
} from '../../../dist/modules/development/domain/readiness-test-surface.js';

// The exact Elite-6 declaration shape (command and sealed scripts.test were
// identical) and its canonical set: 21 test files under tests/.
const ELITE6_COMMAND = 'node --test tests/**/*.test.js';
const ELITE6_CANONICAL = Array.from({ length: 21 }, (_, i) =>
  `tests/gs-${String(i + 1).padStart(2, '0')}.test.js`);

/** Faithful mirror of enforceDerivedCanonicalTestSet's branch order. */
function enforceDerivedCanonicalMirror(input) {
  const { testCommand, canonicalFiles, sealedPackageJsonTestScript } = input;
  if (canonicalFiles.length === 0) {
    return { status: 'honored', testCommand, addedFiles: [] };
  }
  const declared = resolveDeclaredTestSurface({ testCommand, sealedPackageJsonTestScript });
  if (declared.status === 'unresolved-opaque') {
    return { status: 'honored', testCommand, addedFiles: [] };
  }
  if (declared.status === 'declaration-enumerated') {
    const missing = canonicalFiles.filter(file => !declared.files.includes(file));
    if (missing.length === 0) {
      return { status: 'honored', testCommand, addedFiles: [] };
    }
    const derived = withTestFilesExtendedTo({
      command: testCommand,
      targetFiles: [...new Set([...declared.files, ...canonicalFiles])],
    });
    return { status: 'gate-derived', testCommand: derived.command, addedFiles: derived.addedFiles };
  }
  const scriptCommand = sealedPackageJsonTestScript ?? testCommand;
  const scriptSurface = resolveDeclaredTestSurface({
    testCommand: scriptCommand,
    sealedPackageJsonTestScript: null,
  });
  const scriptFiles = scriptSurface.status === 'declaration-enumerated'
    ? scriptSurface.files
    : null;
  const missing = scriptFiles === null
    ? []
    : canonicalFiles.filter(file => !scriptFiles.includes(file));
  if (missing.length === 0) {
    return { status: 'honored', testCommand, addedFiles: [] };
  }
  const derived = withTestFilesExtendedTo({
    command: scriptCommand,
    targetFiles: [...new Set([...(scriptFiles ?? []), ...canonicalFiles])],
  });
  return { status: 'gate-derived', testCommand: derived.command, addedFiles: derived.addedFiles };
}

test('CC-GLOB-SURFACE RED/GREEN core: the Elite-6 whole-tree glob is directory coverage, never a phantom literal, and derives NO duplicate additions', () => {
  // ORACLE 1 — declared surface: the glob denotes the whole tests tree, so
  // the resolution must be truthful whole-directory coverage with an empty
  // file list (the tree itself is the surface), NOT declaration-enumerated
  // with the literal glob string as a phantom file.
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: ELITE6_COMMAND,
      sealedPackageJsonTestScript: ELITE6_COMMAND,
    }),
    { status: 'whole-tests-directory', files: [] },
    'a whole-tree tests glob must classify as directory coverage of tests',
  );
  // The tokenizer must not enumerate the glob token as a literal file.
  assert.deepEqual(
    extractTestFileTokens(ELITE6_COMMAND),
    [],
    'a glob token is a pattern, not a literal enumerated test file',
  );

  // ORACLE 2 — added files: directory coverage already covers every
  // canonical file underneath, so the derived-canonical decision must add
  // nothing (pre-fix this derived 21 duplicate additions after the glob).
  const enforced = enforceDerivedCanonicalMirror({
    testCommand: ELITE6_COMMAND,
    canonicalFiles: ELITE6_CANONICAL,
    sealedPackageJsonTestScript: ELITE6_COMMAND,
  });
  assert.deepEqual(
    { status: enforced.status, addedFiles: enforced.addedFiles },
    { status: 'honored', addedFiles: [] },
    'whole-tree glob coverage must not be extended with duplicate explicit files',
  );

  // ORACLE 3 — effective command: honored verbatim; the executed command is
  // the declaration itself (the runner expands the glob, never this parser).
  assert.equal(enforced.testCommand, ELITE6_COMMAND);
});

test('CC-GLOB-SURFACE: an opaque npm-test declaration whose SEALED script states the whole-tree glob resolves to whole-directory coverage', () => {
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: 'npm test',
      sealedPackageJsonTestScript: ELITE6_COMMAND,
    }),
    { status: 'resolved-via-sealed-package-json', files: [] },
    'the sealed script\'s whole-tree glob is whole-directory coverage',
  );
  const enforced = enforceDerivedCanonicalMirror({
    testCommand: 'npm test',
    canonicalFiles: ELITE6_CANONICAL,
    sealedPackageJsonTestScript: ELITE6_COMMAND,
  });
  assert.deepEqual(
    { status: enforced.status, addedFiles: enforced.addedFiles },
    { status: 'honored', addedFiles: [] },
    'the sealed glob script covers the canonical tree — no duplicate appends',
  );
});

test('CC-GLOB-SURFACE negative mutation: a partial/subdirectory glob is honestly opaque — never phantom-enumerated, never whole-tree overclaimed', () => {
  const partial = 'node --test tests/unit/**/*.test.js';
  // The pure parser cannot expand a subdirectory glob deterministically (no
  // fs, no shell): it must say so, not fabricate coverage in either
  // direction.
  assert.deepEqual(
    resolveDeclaredTestSurface({ testCommand: partial, sealedPackageJsonTestScript: null }),
    { status: 'unresolved-opaque', files: null },
    'a partial glob must be honestly opaque',
  );
  assert.deepEqual(
    extractTestFileTokens(partial),
    [],
    'a partial glob token must not be enumerated as a literal file',
  );
  const enforced = enforceDerivedCanonicalMirror({
    testCommand: partial,
    canonicalFiles: ELITE6_CANONICAL,
    sealedPackageJsonTestScript: null,
  });
  assert.deepEqual(
    { status: enforced.status, addedFiles: enforced.addedFiles },
    { status: 'honored', addedFiles: [] },
    'opacity means report-only: no fabricated additions',
  );
});

test('CC-GLOB-SURFACE negative mutations: near-lookalikes of the whole-tree glob shape are NOT directory coverage', () => {
  const lookalikes = [
    'node --test tests/*.test.js',           // non-recursive: no ** segment
    'node --test tests/**/unit/*.test.js',   // literal directory inside the glob
    'node --test tests-all/**/*.test.js',    // root is not exactly a test directory
    'node --test tests/**/*.test.js.bak',    // trailing segment is not a test-file suffix
    'node --test tests/**/foo.test.js',      // literal basename after ** — a subset, not the tree
  ];
  for (const command of lookalikes) {
    assert.deepEqual(
      resolveDeclaredTestSurface({ testCommand: command, sealedPackageJsonTestScript: null }),
      { status: 'unresolved-opaque', files: null },
      `near-lookalike must stay honestly opaque: ${command}`,
    );
    assert.deepEqual(
      extractTestFileTokens(command),
      [],
      `near-lookalike glob tokens must never be enumerated as literal files: ${command}`,
    );
  }
});

test('CC-GLOB-SURFACE: whole-tree recognition covers the other test-directory roots and suffix families', () => {
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: 'node --test test/**/*.spec.ts',
      sealedPackageJsonTestScript: null,
    }),
    { status: 'whole-tests-directory', files: [] },
  );
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: 'node --test __tests__/**/*.test.mjs',
      sealedPackageJsonTestScript: null,
    }),
    { status: 'whole-tests-directory', files: [] },
  );
});

test('CC-GLOB-SURFACE ratchet: literal test files preserve current behavior', () => {
  // The exact pin already relied upon by the D4 authority matrix
  // (tests/matrix/d-authority-contradiction.test.mjs).
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: 'node --test tests/aaa.test.mjs tests/bbb.test.mjs',
      sealedPackageJsonTestScript: null,
    }),
    { status: 'declaration-enumerated', files: ['tests/aaa.test.mjs', 'tests/bbb.test.mjs'] },
  );
  // The additive surgery over literal enumerations is unchanged: a shortfall
  // still derives the missing canonical files behind the declared runner.
  const enforced = enforceDerivedCanonicalMirror({
    testCommand: 'node --test tests/aaa.test.mjs',
    canonicalFiles: ['tests/aaa.test.mjs', 'tests/bbb.test.mjs'],
    sealedPackageJsonTestScript: null,
  });
  assert.deepEqual(enforced, {
    status: 'gate-derived',
    testCommand: 'node --test tests/aaa.test.mjs tests/bbb.test.mjs',
    addedFiles: ['tests/bbb.test.mjs'],
  });
});

test('CC-GLOB-SURFACE ratchet: directory-shaped commands and the bare-script-name guard preserve current behavior', () => {
  assert.equal(extractTestDirectoryToken('node --test tests/'), 'tests');
  assert.equal(extractTestDirectoryToken('node --test tests/**'), 'tests');
  assert.equal(extractTestDirectoryToken('node --test __tests__'), '__tests__');
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: 'node --test tests/',
      sealedPackageJsonTestScript: null,
    }),
    { status: 'whole-tests-directory', files: [] },
  );
  // The BARE word `test`/`tests` is the package-manager script name, never a
  // directory — `npm test` without a resolvable sealed script stays opaque.
  assert.equal(extractTestDirectoryToken('npm test'), null);
  assert.ok(isNpmStyleTestCommand('npm test'));
  assert.deepEqual(
    resolveDeclaredTestSurface({ testCommand: 'npm test', sealedPackageJsonTestScript: null }),
    { status: 'unresolved-opaque', files: null },
  );
  // Genuinely opaque runners stay opaque.
  assert.deepEqual(
    resolveDeclaredTestSurface({ testCommand: 'jest', sealedPackageJsonTestScript: null }),
    { status: 'unresolved-opaque', files: null },
  );
  assert.deepEqual(
    resolveDeclaredTestSurface({ testCommand: 'echo ok', sealedPackageJsonTestScript: null }),
    { status: 'unresolved-opaque', files: null },
  );
});

test('CC-GLOB-SURFACE ratchet: npm-style resolution through a literal sealed script preserves current behavior', () => {
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: 'npm test',
      sealedPackageJsonTestScript: 'node --test tests/a.test.js tests/b.test.js',
    }),
    {
      status: 'resolved-via-sealed-package-json',
      files: ['tests/a.test.js', 'tests/b.test.js'],
    },
  );
  assert.deepEqual(
    resolveDeclaredTestSurface({
      testCommand: 'npm run test',
      sealedPackageJsonTestScript: 'node --test tests/',
    }),
    { status: 'resolved-via-sealed-package-json', files: [] },
  );
});
