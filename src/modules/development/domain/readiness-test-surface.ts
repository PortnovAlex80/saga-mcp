// src/modules/development/domain/readiness-test-surface.ts
//
// CERTIFICATION-GAMING-REMEDY — the shared, PURE model of a readiness
// declaration's test-file surface. Two consumers, one definition:
//
//   - M2-2 (local-runnability provider): which test files the CANONICAL set
//     contains (sealed tree tests/** + sealed package.json scripts.test) vs
//     which the DECLARATION runs — an additive report, never enforcement.
//   - M1-a/D2 (readiness-profile-monotonicity provider): the declared
//     verification surface may never shrink or silently change between
//     readiness manifests of the SAME sourceCandidate.
//
// The stage-11 empirical case this models: the sealed package.json
// scripts.test enumerated 9 test files; round 4 declared `node --test <7 of
// them>`, excluding exactly the two red ones, with zero code change.
//
// Pure string/path functions only — no fs, no git, no db — so both providers
// (and their tests) share one deterministic tokenizer that cannot drift.

/** Common test-file suffixes (js/mjs/cjs/ts/mts/cts, .test/.spec). */
const TEST_FILE_RE = /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|ts)$/u;

/** Repo-relative POSIX normalization: no leading ./, forward slashes only. */
export function normalizeTestPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

export function isTestFilePath(value: string): boolean {
  return TEST_FILE_RE.test(normalizeTestPath(value));
}

/**
 * The test-file paths a command string enumerates (whitespace-tokenized,
 * normalized, de-duplicated, sorted). An empty result means the command does
 * NOT enumerate test files (opaque: `npm test`, `jest`, `echo ok`, …).
 */
export function extractTestFileTokens(command: string): string[] {
  const tokens = command.trim().split(/\s+/u);
  const files = new Set<string>();
  for (const token of tokens) {
    if (isTestFilePath(token)) files.add(normalizeTestPath(token));
  }
  return [...files].sort();
}

/**
 * Whole-directory test tokens. A directory is recognized ONLY in an
 * unambiguous shape — with a trailing separator or glob (`tests/`,
 * `tests/**`, `test/`, `__tests__`, `__tests__/**`). The BARE words
 * `test`/`tests` are deliberately NOT directories: they are the package
 * manager's script name (`npm test`), and treating them as directories would
 * misread every opaque npm-test declaration as a whole-tree run.
 */
export function extractTestDirectoryToken(
  command: string,
): 'tests' | 'test' | '__tests__' | null {
  for (const token of command.trim().split(/\s+/u)) {
    const bare = token.replace(/\\/gu, '/').replace(/['"]/gu, '');
    if (bare === 'tests/' || bare === 'tests/**') return 'tests';
    if (bare === 'test/' || bare === 'test/**') return 'test';
    if (bare === '__tests__' || bare === '__tests__/' || bare === '__tests__/**') {
      return '__tests__';
    }
  }
  return null;
}

/**
 * Does the command delegate the test surface to the package manager's `test`
 * script (`npm test`, `npm run test`, `pnpm test`, `yarn test`)? Those are
 * resolvable through the sealed package.json's scripts.test; anything else
 * opaque (jest, vitest, `node --test` with default discovery) is not.
 */
export function isNpmStyleTestCommand(command: string): boolean {
  const tokens = command.trim().replace(/['"]/gu, '').split(/\s+/u);
  const program = tokens[0] ?? '';
  if (!/^(?:npm|npm\.cmd|npm\.exe|pnpm|pnpm\.cmd|yarn|yarn\.cmd)$/u.test(program)) {
    return false;
  }
  const rest = tokens.slice(1);
  // Allow exactly `test` or `run test` (with optional trailing runner args
  // after `--`, which do not change which script runs).
  const dashDash = rest.indexOf('--');
  const head = dashDash === -1 ? rest : rest.slice(0, dashDash);
  return head.length >= 1 && head.length <= 2
    && (head[0] === 'test' || (head[0] === 'run' && head[1] === 'test'));
}

/** How a declaration's executed test-file set was derived. */
export type DeclaredTestSurfaceStatus =
  | 'declaration-enumerated'
  | 'whole-tests-directory'
  | 'resolved-via-sealed-package-json'
  | 'unresolved-opaque';

export interface DeclaredTestSurface {
  readonly status: DeclaredTestSurfaceStatus;
  /** null exactly when status === 'unresolved-opaque'. */
  readonly files: readonly string[] | null;
}

/**
 * Resolve which test files a declared testCommand executes. Enumeration in
 * the command itself wins; a whole-directory token means "everything under
 * the sealed tests/ tree"; `npm test`-style commands resolve through the
 * SEALED package.json scripts.test (same rules applied to that string);
 * anything else is honestly opaque (null) — no fabricated claims.
 */
export function resolveDeclaredTestSurface(input: {
  readonly testCommand: string;
  readonly sealedPackageJsonTestScript: string | null | undefined;
}): DeclaredTestSurface {
  const direct = extractTestFileTokens(input.testCommand);
  if (direct.length > 0) {
    return { status: 'declaration-enumerated', files: direct };
  }
  if (extractTestDirectoryToken(input.testCommand) !== null) {
    return { status: 'whole-tests-directory', files: [] };
  }
  if (isNpmStyleTestCommand(input.testCommand)) {
    const script = typeof input.sealedPackageJsonTestScript === 'string'
      ? input.sealedPackageJsonTestScript
      : null;
    if (script !== null && script.trim() !== '') {
      const scriptFiles = extractTestFileTokens(script);
      if (scriptFiles.length > 0) {
        return { status: 'resolved-via-sealed-package-json', files: scriptFiles };
      }
      if (extractTestDirectoryToken(script) !== null) {
        return { status: 'resolved-via-sealed-package-json', files: [] };
      }
    }
  }
  return { status: 'unresolved-opaque', files: null };
}

/**
 * CERTIFICATION-GAMING-REMEDY M1-b (step 4) — the additive-command surgery.
 *
 * The executed check set is DERIVED from the sealed tree; a declaration may
 * ADD test files, never remove or replace the canonical ones. Given a command
 * whose enumerated test-file surface falls short of the required set, rebuild
 * it: keep the runner program and every non-file token (flags) verbatim,
 * replace the enumerated file tokens with `targetFiles` (the union of the
 * declared and canonical files), and append what was missing. When the
 * command enumerates no files itself (directory-shaped), `targetFiles` is
 * appended as-is. Pure string surgery — the declared runner and flags are
 * never invented or swapped.
 */
export function withTestFilesExtendedTo(input: {
  readonly command: string;
  readonly targetFiles: readonly string[];
}): { readonly command: string; readonly addedFiles: readonly string[] } {
  const tokens = input.command.trim().split(/\s+/u);
  const enumerated = new Set(extractTestFileTokens(input.command));
  const target = [...new Set(input.targetFiles.map(normalizeTestPath))].sort();
  const survivorTokens = tokens.filter(token => !enumerated.has(normalizeTestPath(token)));
  const before = new Set(enumerated);
  const addedFiles = target.filter(file => !before.has(file));
  const rebuilt = [...survivorTokens, ...target].join(' ');
  return { command: rebuilt, addedFiles };
}
