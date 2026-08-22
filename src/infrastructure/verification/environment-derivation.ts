// src/infrastructure/verification/environment-derivation.ts
//
// K19 commits 2–3 core (ADR-083 §2.1/2.2) — the DERIVED execution
// environment. The environment a candidate is certified in is derived from
// the ARTEFACT (the exact sealed tree), is one immutable identity, and is
// the same object for preparation and certification. The candidate's
// declaration is ADDITIVE — it may add to the derived environment, never
// define it.
//
// The defect this removes (break 2a): the GDesign run declared its install
// command, the code imported a package the declaration omitted, the
// worker's polluted environment hid it, and only the sterile container
// caught it — by luck. Derivation catches it BEFORE any spawn: the gap
// between what the artefact imports and what the declared environment
// provides is computed from the sealed bytes, named in a typed diagnostic,
// and closed by augmenting the install (or failing closed when there is no
// install to augment).
//
// Domain-free by construction: the scanner knows bare module specifiers,
// not languages — whatever the sealed tree's source files import as a
// non-relative name is a derived tool claim; the builtins whitelist is the
// runtime's own list, not a domain judgement.
//
// K19 image/dependency identity remainder (ADR-083 §2.1): the derived
// identity additionally binds the EXACT resolved lock material
// (`dependencyLockDigest`). Two artefacts that differ only in lock bytes are
// DIFFERENT environments — a drifted lock never reuses an identity.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';
import { sha256Hex } from '../../shared/canonical-json.js';

/** Source file suffixes the import scanner reads. */
const SCANNABLE_RE = /\.(?:mjs|cjs|js|mts|cts|ts)$/u;

/**
 * The frozen v1 lock-material universe (ADR-083 §2.1 `dependencyLockDigest`):
 * the standard resolved-lock files of the ecosystems the readiness flow
 * installs (npm/pnpm/yarn/poetry/uv/pip). A registry-name list, not a domain
 * judgement — the derivation hashes whatever EXACT lock bytes the sealed tree
 * states, for whatever ecosystem produced them. Files NOT in this universe
 * simply do not contribute lock identity (the tree honestly reports less).
 */
const LOCK_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'uv.lock',
  'requirements.txt',
] as const;

/** The runtime's own modules — never environment claims. */
const BUILTINS = new Set<string>(builtinModules);

/** Bare-specifier import/require patterns (non-relative, non-builtins). */
const IMPORT_PATTERNS = [
  /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/gu,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /require\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
];

/**
 * The dependency lock identity (ADR-083 §2.1): `dependencyLockDigest` is the
 * content digest over the EXACT resolved lock material the sealed tree
 * states. `files` names each lock file with its individual content digest —
 * an empty list is the honest statement "this artefact pins no lock
 * material", never a fabricated lock.
 */
export interface DependencyLockIdentity {
  readonly files: readonly { readonly file: string; readonly digest: string }[];
  readonly dependencyLockDigest: string;
}

export interface DerivedEnvironment {
  /** Every bare module specifier the sealed tree's sources import. */
  readonly scannedImports: readonly string[];
  /** Packages the sealed package.json declares (deps ∪ devDeps ∪ optional). */
  readonly manifestPackages: readonly string[];
  /** Packages the declared install command names explicitly. */
  readonly declaredInstallPackages: readonly string[];
  /**
   * The gap: scanned imports covered by NO manifest, NO explicit install
   * token and no builtin. In the pre-K19 world these crashed (or were
   * hidden) at run time — the GDesign class.
   */
  readonly undeclaredImports: readonly string[];
  /**
   * The dependency lock identity of the exact resolved lock material. A tree
   * whose lock bytes differ is a DIFFERENT environment — the identity never
   * reuses across lock drift (K19 remainder, ADR-083 §2.1).
   */
  readonly dependencyLock: DependencyLockIdentity;
  /** The one immutable identity of this derived environment. */
  readonly environmentDigest: string;
}

/** A bare specifier: not relative, not absolute, not a builtin, not node:-prefixed. */
function bareSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')
    || specifier.startsWith('node:')) return null;
  const pkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
  if (!pkg || BUILTINS.has(pkg)) return null;
  return pkg;
}

/** Walk the sealed tree (skipping node_modules and hidden dirs) scanning source imports. */
function scanImports(directory: string): string[] {
  const found = new Set<string>();
  const walk = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(join(directory, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && SCANNABLE_RE.test(child)) {
        let text: string;
        try {
          text = readFileSync(join(directory, child), 'utf8');
        } catch {
          continue;
        }
        for (const pattern of IMPORT_PATTERNS) {
          pattern.lastIndex = 0;
          for (const match of text.matchAll(pattern)) {
            const pkg = bareSpecifier(match[1] ?? '');
            if (pkg !== null) found.add(pkg);
          }
        }
      }
    }
  };
  walk('');
  return [...found].sort();
}

/** The sealed package.json's declared package set (deps ∪ devDeps ∪ optional). */
function readManifestPackages(directory: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const names = new Set<string>();
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(parsed[section] ?? {})) names.add(name);
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

/** Install subcommand words — never package names. */
const INSTALL_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'uninstall', 'remove', 'ci', 'update', 'sync', 'freeze',
]);

/**
 * Package-name tokens of an install command (npm/pip style: program,
 * subcommands, flags and version-pinned tokens skipped; scoped @org/pkg
 * tokens conservatively excluded — a v1 boundary, documented here).
 */
export function installCommandPackages(installCommand: string): string[] {
  const packages = new Set<string>();
  for (const token of installCommand.trim().split(/\s+/u).slice(1)) {
    if (token.startsWith('-') || token.includes(':') || token.includes('=')
      || token.includes('@') || INSTALL_SUBCOMMANDS.has(token)
      || /^[A-Za-z][A-Za-z0-9._-]*$/u.test(token) === false) {
      continue;
    }
    packages.add(token);
  }
  return [...packages].sort();
}

/**
 * Read the dependency lock identity from the EXACT sealed tree. Pure over the
 * directory's bytes — no network, no spawn, no resolution: the identity binds
 * what the artefact STATES, it does not resolve anything. A lock file that
 * exists but cannot be read is MISSING identity evidence and fails closed
 * (typed) rather than silently computing an identity without it.
 */
function readDependencyLockIdentity(directory: string): DependencyLockIdentity {
  const files: Array<{ file: string; digest: string }> = [];
  for (const file of LOCK_FILES) {
    const lockPath = join(directory, file);
    if (!existsSync(lockPath)) continue;
    let bytes: string;
    try {
      bytes = readFileSync(lockPath, 'utf8');
    } catch (error) {
      throw new Error(
        `ENVIRONMENT_DEPENDENCY_LOCK_UNREADABLE: the sealed tree states lock material "${file}" but its bytes cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    files.push({ file, digest: sha256Hex(bytes) });
  }
  return { files, dependencyLockDigest: sha256Hex(files) };
}

/**
 * Derive the execution environment from the EXACT sealed tree (already
 * extracted) and the declared install command. Pure over the directory's
 * bytes — no network, no spawn, no registry: the derivation names what the
 * artefact NEEDS, it does not resolve it.
 */
export function deriveExecutionEnvironment(input: {
  readonly directory: string;
  readonly installCommand: string | null;
}): DerivedEnvironment {
  const scannedImports = scanImports(input.directory);
  const manifestPackages = readManifestPackages(input.directory);
  const declaredInstallPackages = input.installCommand !== null
    ? installCommandPackages(input.installCommand)
    : [];
  const dependencyLock = readDependencyLockIdentity(input.directory);
  const covered = new Set([...manifestPackages, ...declaredInstallPackages]);
  const undeclaredImports = scannedImports.filter(pkg => !covered.has(pkg));
  return {
    scannedImports,
    manifestPackages,
    declaredInstallPackages,
    undeclaredImports,
    dependencyLock,
    environmentDigest: sha256Hex({
      scannedImports,
      manifestPackages,
      declaredInstallPackages,
      installCommand: input.installCommand,
      dependencyLock,
    }),
  };
}

/**
 * The additive augmentation (ADR-083 §2.2): the derived environment
 * governs; the declaration may add, never remove. When the artefact needs
 * packages the declaration omits, the install command is EXTENDED with
 * them — the same runner, the declared tokens verbatim, the gap appended.
 * The caller decides the fail-closed case (no install to augment) itself.
 */
export function augmentInstallCommand(
  installCommand: string,
  missingPackages: readonly string[],
): string {
  return `${installCommand.trim()} ${missingPackages.join(' ')}`.trim();
}
