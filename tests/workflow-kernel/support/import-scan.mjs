/**
 * tests/workflow-kernel/support/import-scan.mjs - resolver-based importer
 * detection for the EK-8 cutover reachability laws (WP-12).
 *
 * A file IMPORTS a package when any import specifier (static `from '...'`
 * or dynamic `import('...')`) RESOLVES into the package directory. This is
 * strictly stronger than the pre-cutover absolute-path regex scans, which
 * never saw relative specifiers at all: a kernel-internal relative import
 * (`../workshops/synthetic/bindings.js`) is now caught exactly like a
 * tools/tests absolute one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve a relative specifier against a file's directory (posix form). */
function resolveSpecifier(fromFile, spec) {
  const stack = fromFile.replaceAll('\\', '/').split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** Repo-relative or absolute package-directory match (segment-aware). */
function pointsInto(resolved, packageDirAbs) {
  return resolved === packageDirAbs || resolved.includes('/' + packageDirAbs + '/') || resolved.endsWith('/' + packageDirAbs) || resolved.startsWith(packageDirAbs + '/');
}

/** True when the file's source imports anything inside packageDirAbs. */
export function importsInto(source, fromFile, packageDirAbs) {
  const normalizedFile = fromFile.replaceAll('\\', '/');
  for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith('.')) {
      if (pointsInto(m[1].replaceAll('\\', '/'), packageDirAbs)) return true;
      continue;
    }
    if (pointsInto(resolveSpecifier(normalizedFile, m[1]), packageDirAbs)) return true;
  }
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!m[1].startsWith('.')) {
      if (pointsInto(m[1].replaceAll('\\', '/'), packageDirAbs)) return true;
      continue;
    }
    if (pointsInto(resolveSpecifier(normalizedFile, m[1]), packageDirAbs)) return true;
  }
  return false;
}

/**
 * Every file under the given roots (skipping node_modules/dist/.git) whose
 * source imports into the package directory (posix, repo-relative).
 */
export function findImporters(roots, packageDirAbs) {
  const offenders = [];
  const scan = (dir, extensions) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // the tree is absent (e.g. retired at the EK-8 purge)
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full, extensions);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      if (pointsInto(full.replaceAll('\\', '/'), packageDirAbs)) continue; // the package's own files are never "importers"
      if (importsInto(readFileSync(full, 'utf8'), full, packageDirAbs)) offenders.push(full);
    }
  };
  for (const root of roots) scan(root.dir, root.extensions);
  return offenders;
}
