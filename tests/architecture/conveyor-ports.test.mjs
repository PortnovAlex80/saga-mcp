// Conveyor outbound-port enforcement test.
//
// HISTORY (Wave 1C / FU-E / ADR-022): an earlier version of this test enforced
// a "14 ports" count by asserting 8 global ports + ~19 value objects lived in
// conveyor-ports.ts. A dead-port inventory found 7 of those 8 ports and ALL
// value objects had ZERO production importers — their responsibilities are
// carried by MODULE-LOCAL equivalents (Wave 7 decomposition) that express
// module-specific shapes a global port cannot. ADR-022 retired the global
// declarations; this test no longer asserts them. Keeping an assertion for a
// dead interface would re-centralize an interface the architecture has
// inverted, so the assertions were deleted, not weakened.
//
// What this test STILL enforces:
//   1. The ONE surviving global port — IdGeneratorPort — is (a) declared and
//      (b) ACTUALLY IMPORTED by ≥4 production files. The import-graph check
//      makes the test FAIL if IdGeneratorPort stops being used, so the
//      declaration can never silently go dead again.
//   2. The module-local / already-formalized ports that the doc still names
//      (WorkAssignmentPort, ProcessRunRepository, NodeRunRepository,
//      RecoveryCaseRepository, ModuleInstallationRepository) keep a real
//      interface + adapter.
//
// The retired global ports (WorkerLauncherPort, WorkerSupervisionPort,
// WorkspacePort, ProductRepositoryPort, ModuleCatalogPort,
// ExecutionJournalPort, ProcessLivenessPort, ClockPort) and the value objects
// are INTENTIONALLY NOT asserted here — they live at the module boundary now
// (see ADR-022 for the per-port live location).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = (...p) => path.join(REPO_ROOT, 'src', ...p);
function readSrc(...p) {
  const full = SRC(...p);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// Helper: assert a TypeScript interface by name exists in a source file.
// ---------------------------------------------------------------------------
function assertInterfaceExists(portName, relPath) {
  const src = readSrc(...relPath.split('/'));
  assert.ok(src !== null, `${relPath} not found (looking for ${portName})`);
  // Match `export interface PortName` or `export type { PortName }`.
  const re = new RegExp(`export (?:interface|type)\\s+${portName}\\b`);
  assert.ok(
    re.test(src),
    `${portName} interface/type not declared in ${relPath}`,
  );
}

// ---------------------------------------------------------------------------
// Helper: assert a concrete adapter exists somewhere under src/ that either
// `implements <PortName>` or is documented as the adapter.
// ---------------------------------------------------------------------------
function assertAdapterImplements(portName, adapterGlob) {
  const candidates = Array.isArray(adapterGlob) ? adapterGlob : [adapterGlob];
  for (const rel of candidates) {
    const src = readSrc(...rel.split('/'));
    if (src && (src.includes(`implements ${portName}`) || src.includes(portName))) {
      return;
    }
  }
  assert.fail(
    `no concrete adapter found implementing/satisfying ${portName} `
    + `in candidates: ${candidates.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Helper: count production .ts files under src/ (recursively) that import a
// given identifier from a given module-path suffix. Excludes the declaration
// file itself and this test. Used to prove an interface is ACTUALLY USED,
// not just declared.
// ---------------------------------------------------------------------------
function countProductionImporters(identifier, modulePathSuffix, declRelPath) {
  const declAbs = path.join(REPO_ROOT, 'src', ...declRelPath.split('/'));
  const hits = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        if (full === declAbs) continue;
        const src = readFileSync(full, 'utf8');
        // import (type) { …identifier… } from '…modulePathSuffix'
        const importRe = new RegExp(
          `import(?:\\s+type)?\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${modulePathSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
        );
        if (importRe.test(src)) hits.push(full);
      }
    }
  }
  walk(SRC());
  return hits;
}

// ===========================================================================
// SURVIVING GLOBAL PORT: IdGeneratorPort — declared AND used.
// ===========================================================================

test('IdGeneratorPort — formal interface + concrete adapter', () => {
  assertInterfaceExists('IdGeneratorPort', 'application/ports/conveyor-ports.ts');
  assertAdapterImplements('uuidIdGenerator', 'infrastructure/conveyor/conveyor-adapters.ts');
});

test('IdGeneratorPort — imported by the exact live production consumers (import-graph proof)', () => {
  // IdGeneratorPort is the ONE surviving global port. It must stay genuinely
  // cross-module: if production stops importing it, the declaration is dead
  // and should either be inlined or deleted — NOT kept for a port count.
  // This test FAILS the moment usage drops, preventing silent rot.
  const importers = countProductionImporters(
    'IdGeneratorPort',
    'conveyor-ports.js',
    'application/ports/conveyor-ports.ts',
  );
  assert.deepEqual(
    importers.map((f) => path.relative(REPO_ROOT, f).replaceAll('\\', '/')).sort(),
    [
      'src/app/dispatch-loop.ts',
      'src/infrastructure/conveyor/conveyor-adapters.ts',
      'src/shared/conveyor/assign-one-card.ts',
    ],
    'IdGeneratorPort importer set must stay exact; additions and removals require an explicit architecture decision',
  );
});

// ===========================================================================
// Already-formalized MODULE-LOCAL ports (verified elsewhere, still named in
// the doc). These are NOT global conveyor ports — they live in their module
// persistence files. Asserted here to catch accidental removal.
// ===========================================================================

test('WorkAssignmentPort — formal interface + adapter (declared in worker-executor.ts)', () => {
  assertInterfaceExists('WorkAssignmentPort', 'application/ports/worker-executor.ts');
  assertAdapterImplements('WorkAssignmentPort', 'infrastructure/work/sqlite-work-assignment-adapter.ts');
});

test('module-local port: ProcessRunRepository — already formalized', () => {
  assertInterfaceExists('ProcessRunRepository', 'process-modules/persistence/process-run-repository.ts');
  assertAdapterImplements('ProcessRunRepository', 'process-modules/persistence/sqlite-process-run-repository.ts');
});

test('module-local port: NodeRunRepository — already formalized', () => {
  assertInterfaceExists('NodeRunRepository', 'process-modules/persistence/node-run.ts');
  assertAdapterImplements('NodeRunRepository', 'process-modules/persistence/sqlite-node-run-repository.ts');
});

test('module-local port: RecoveryCaseRepository — already formalized', () => {
  assertInterfaceExists('RecoveryCaseRepository', 'process-modules/persistence/recovery-case-repository.ts');
  assertAdapterImplements('RecoveryCaseRepository', 'process-modules/persistence/sqlite-recovery-case-repository.ts');
});

test('module-local port: ModuleInstallationRepository — already formalized', () => {
  assertInterfaceExists('ModuleInstallationRepository', 'process-modules/installation/persistence/installation-repository.ts');
  assertAdapterImplements('ModuleInstallationRepository', 'process-modules/installation/persistence/installation-repository.ts');
});

// ===========================================================================
// NEGATIVE assertion: the retired global ports MUST NOT come back as dead
// declarations in conveyor-ports.ts. (They may legitimately live at a module
// boundary elsewhere; this only forbids re-centralizing them in the global
// catalog file.) ADR-022 is the spec change that justifies this.
// ===========================================================================

test('retired global ports are NOT re-declared in conveyor-ports.ts (ADR-022)', () => {
  const ports = readSrc('application/ports/conveyor-ports.ts');
  const retired = [
    'WorkerLauncherPort',
    'WorkerSupervisionPort',
    'WorkspacePort',
    'ProductRepositoryPort',
    'ModuleCatalogPort',
    'ExecutionJournalPort',
    'ProcessLivenessPort',
    'ClockPort',
    // retired value objects (declared only here, 0 importers, or shadowed by
    // live module-local declarations)
    'WorkplaceRef',
    'DeskRef',
    'CardRef',
    'ProductRef',
    'Product',
    'Lease',
    'FencedExecutionRef',
    'FencedProgress',
    'FencedCompletion',
    'ReleaseResult',
    'CompletionResult',
    'ProcessExitObservation',
    'RecoveryIssue',
    'ReconcileResult',
    'WorkerLaunchContext',
    'LaunchRef',
    'JournalRecord',
    'ModuleSelector',
    'CatalogEntry',
    // retired re-export (canonical decl stays in worker-executor.ts; the
    // re-export from the global catalog had 0 importers)
    'WorkAssignmentPort',
  ];
  const leaked = retired.filter((name) =>
    new RegExp(`export (?:interface|type|type\\s*\\{)\\s+${name}\\b`).test(ports));
  assert.deepEqual(
    leaked,
    [],
    `conveyor-ports.ts must not re-declare retired ports/value objects (ADR-022); found: ${leaked.join(', ')}`,
  );
});
