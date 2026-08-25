/**
 * purity.test-support.mjs - shared source-scan helpers for the purity tests
 * and the workshop-branch mutation. Scans the kernel source tree the same
 * way the frozen complexity driver does.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const KERNEL_SRC = path.join(REPO_ROOT, 'src', 'workflow-kernel');
export const DOMAIN_SRC = path.join(KERNEL_SRC, 'domain');

const PROD_SOURCE = (name) => /\.(ts|mjs|js)$/.test(name) && !/\.test\.|\.spec\./.test(name);

export function listKernelSourceFiles() {
  const acc = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return acc;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (PROD_SOURCE(entry.name)) acc.push(p);
    }
    return acc;
  };
  return walk(KERNEL_SRC);
}

export function scanKernelSources() {
  const files = listKernelSourceFiles();
  let workshopNameLiterals = 0;
  const importPattern = /import\s[^;]*from\s+['"]([^'"]+)['"]/g;
  const imports = new Set();
  const relationLiterals = new Set();
  const authorityLiterals = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    workshopNameLiterals += (source.match(/['"`](discovery|formalization|development|delivery|documentation)['"`]/g) ?? []).length;
    for (const match of source.matchAll(importPattern)) imports.add(match[1]);
    for (const match of source.matchAll(/relation:([A-Z][A-Za-z0-9]*)/g)) relationLiterals.add(match[1]);
    for (const match of source.matchAll(/authority:([A-Z][A-Za-z0-9]*)/g)) authorityLiterals.add(match[1]);
  }
  return {
    fileCount: files.length,
    workshopNameLiterals,
    imports: [...imports].sort(),
    relationLiterals: [...relationLiterals].sort(),
    authorityLiterals: [...authorityLiterals].sort(),
  };
}

/**
 * Imports of the PURE package only (src/workflow-kernel/domain/**). The
 * import-purity law binds the pure package: EK-3's sole-writer repositories
 * live lawfully under src/workflow-kernel/persistence/** and are the only
 * place where the SQLite driver may be imported (EK-2 exit criterion: "The
 * pure package has no import from persistence, UI or workshop modules").
 */
export function scanDomainImports() {
  const files = listKernelSourceFiles().filter((file) => file.startsWith(DOMAIN_SRC + path.sep));
  const importPattern = /imports[^;]*froms+['"]([^'"]+)['"]/g;
  const imports = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) imports.add(match[1]);
  }
  return [...imports].sort();
}
