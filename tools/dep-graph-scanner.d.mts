// Type declarations for the plain-Node dependency-graph scanner tool.
//
// tools/dep-graph-scanner.mjs is a repo-wide source import scanner (W0-A1).
// It is consumed by tests/architecture/dependency-direction.test.mjs and by
// src/application/module-conformance-runner.ts (W9-A7 cross-module isolation).
// These declarations give both consumers a typed surface without converting
// the tool itself to TypeScript.

/**
 * A dependency graph: for each scanned source file (repo-relative POSIX path),
 * the list of repo-relative POSIX import targets it depends on.
 */
export type DependencyGraph = Record<string, readonly string[]>;

export interface ScanOptions {
  /** Repository root to resolve against (defaults to process.cwd()). */
  rootDir?: string;
}

/**
 * Scan TypeScript sources under `<rootDir>/src/` and produce, for each source
 * file, the list of repo-relative import targets it depends on. Bare
 * specifiers (node:fs, @scope/pkg, ...) are ignored.
 */
export function scanDependencyGraph(options?: ScanOptions): DependencyGraph;

/**
 * Resolve a relative import specifier (`./x`, `../y`) from a source file to a
 * repo-relative POSIX path, trying the literal specifier then `.ts/.tsx/.mjs/.js/.json/index.*`.
 * Returns null when no candidate file exists on disk.
 */
export function resolveImport(
  fromFile: string,
  spec: string,
  rootDir?: string,
): string | null;

/**
 * Extract the relative import specifiers (`./...`, `../...`) from a source
 * string. Returns the captured specifiers in source order.
 */
export function extractRelativeSpecifiers(source: string): readonly string[];
