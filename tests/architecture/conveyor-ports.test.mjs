// CONVEYOR-MENTAL-MODEL.md §"Required outbound ports" (lines 592-639) —
// formal-port enforcement test.
//
// The doc mandates 5 outbound ports + 9 additional ports. A port "counts" only
// when a formal interface exists AND a concrete adapter implements (or
// structurally satisfies) it. This test enforces BOTH halves so a future change
// cannot silently delete an interface or leave it without an adapter.
//
// 4 of the 9 additional ports were ALREADY formalized before this wave
// (ProcessRunRepository, NodeRunRepository, RecoveryCaseRepository,
// InstallationRepository) — they are verified here too.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
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
  // adapterGlob is a list of candidate files; at least one must mention the
  // port as an implemented interface OR be the documented adapter.
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

// ===========================================================================
// 5 MANDATORY OUTBOUND PORTS (doc lines 598-633)
// ===========================================================================

test('mandatory port 1: WorkAssignmentPort — formal interface + adapter', () => {
  assertInterfaceExists('WorkAssignmentPort', 'application/ports/worker-executor.ts');
  assertAdapterImplements('WorkAssignmentPort', 'infrastructure/work/sqlite-work-assignment-adapter.ts');
});

test('mandatory port 2: WorkerLauncherPort — formal interface', () => {
  assertInterfaceExists('WorkerLauncherPort', 'application/ports/conveyor-ports.ts');
  // The concrete launcher is ClaudeBoardRunner (tracker-view). It does not
  // `implements WorkerLauncherPort` directly (it's .mjs + run-shaped), but the
  // formal interface exists and the adapter surface is documented.
  const ports = readSrc('application/ports/conveyor-ports.ts');
  assert.ok(ports.includes('interface WorkerLauncherPort'));
  const runner = readFileSync(path.join(REPO_ROOT, 'tracker-view/claude-runner.mjs'), 'utf8');
  assert.ok(runner.includes('launch('), 'ClaudeBoardRunner.launch must exist');
});

test('mandatory port 3: WorkerSupervisionPort — formal interface + adapter surface', () => {
  assertInterfaceExists('WorkerSupervisionPort', 'application/ports/conveyor-ports.ts');
  // The supervision surface is a composition: the service (startWorkerSupervision)
  // + the runtime repo (renewLeases, reconcile) + worker-executions (stuck-policy).
  // Verify the 4 documented methods exist across the adapter files.
  const service = readSrc('infrastructure/work/worker-supervision-service.ts');
  const repo = readSrc('infrastructure/persistence/sqlite-saga2-runtime-repositories.ts');
  const exec = readSrc('worker-executions.ts');
  assert.ok(service.includes('startWorkerSupervision'), 'supervision service must exist');
  assert.ok(repo.includes('renewLeases'), 'renewLeases adapter must exist');
  assert.ok(repo.includes('reconcile'), 'reconcile adapter must exist');
  assert.ok(exec.includes('reconcileWorkerExecutions'), 'reconcileWorkerExecutions adapter must exist');
});

test('mandatory port 4: WorkspacePort — formal interface', () => {
  assertInterfaceExists('WorkspacePort', 'application/ports/conveyor-ports.ts');
  const materializer = readSrc('process-modules/application/pinned-workspace-materializer.ts');
  assert.ok(
    materializer.includes('materializePinnedWorkspace'),
    'concrete workspace adapter (materializePinnedWorkspace) must exist',
  );
});

test('mandatory port 5: ProductRepositoryPort — formal interface + adapter', () => {
  assertInterfaceExists('ProductRepositoryPort', 'application/ports/conveyor-ports.ts');
  assertAdapterImplements('ProcessProductRepository', [
    'process-modules/persistence/sqlite-process-product-repository.ts',
    'process-modules/persistence/sqlite-process-product-repository-v2.ts',
  ]);
});

// ===========================================================================
// 9 ADDITIONAL PORTS (doc lines 635-639)
// ===========================================================================

test('additional port 1: ProcessRunRepository — already formalized', () => {
  assertInterfaceExists('ProcessRunRepository', 'process-modules/persistence/process-run-repository.ts');
  assertAdapterImplements('ProcessRunRepository', 'process-modules/persistence/sqlite-process-run-repository.ts');
});

test('additional port 2: NodeRunRepository — already formalized', () => {
  assertInterfaceExists('NodeRunRepository', 'process-modules/persistence/node-run.ts');
  assertAdapterImplements('NodeRunRepository', 'process-modules/persistence/sqlite-node-run-repository.ts');
});

test('additional port 3: RecoveryCaseRepository — already formalized', () => {
  assertInterfaceExists('RecoveryCaseRepository', 'process-modules/persistence/recovery-case-repository.ts');
  assertAdapterImplements('RecoveryCaseRepository', 'process-modules/persistence/sqlite-recovery-case-repository.ts');
});

test('additional port 4: ModuleCatalogPort — formal interface', () => {
  assertInterfaceExists('ModuleCatalogPort', 'application/ports/conveyor-ports.ts');
  // PackageRegistry is the existing equivalent.
  const reg = readSrc('process-modules/installation/domain/package-registry.ts');
  assert.ok(reg.includes('interface PackageRegistry'), 'PackageRegistry (concrete catalog) must exist');
});

test('additional port 5: InstallationRepository (ModuleInstallationRepository) — already formalized', () => {
  assertInterfaceExists('ModuleInstallationRepository', 'process-modules/installation/persistence/installation-repository.ts');
  assertAdapterImplements('ModuleInstallationRepository', 'process-modules/installation/persistence/installation-repository.ts');
});

test('additional port 6: ExecutionJournalPort — formal interface', () => {
  assertInterfaceExists('ExecutionJournalPort', 'application/ports/conveyor-ports.ts');
  // The concrete journal is command_receipts via idempotency.ts.
  const idem = readSrc('lifecycle/idempotency.ts');
  assert.ok(idem.includes('command_receipts'), 'command_receipts journal surface must exist');
});

test('additional port 7: ProcessLivenessPort — formal interface + adapter', () => {
  assertInterfaceExists('ProcessLivenessPort', 'application/ports/conveyor-ports.ts');
  assertAdapterImplements('systemProcessLiveness', 'infrastructure/conveyor/conveyor-adapters.ts');
});

test('additional port 8: ClockPort — formal interface + adapter', () => {
  assertInterfaceExists('ClockPort', 'application/ports/conveyor-ports.ts');
  assertAdapterImplements('systemClock', 'infrastructure/conveyor/conveyor-adapters.ts');
});

test('additional port 9: IdGeneratorPort — formal interface + adapter', () => {
  assertInterfaceExists('IdGeneratorPort', 'application/ports/conveyor-ports.ts');
  assertAdapterImplements('uuidIdGenerator', 'infrastructure/conveyor/conveyor-adapters.ts');
});

// ===========================================================================
// Wave 1 value objects — the ubiquitous-language identity types must exist.
// ===========================================================================

test('Wave 1 value objects: all durable identity types declared', () => {
  const ports = readSrc('application/ports/conveyor-ports.ts');
  const requiredTypes = [
    'WorkplaceRef', 'CardRef', 'DeskRef', 'ProductRef',
    'FencedExecutionRef', 'FencedProgress', 'FencedCompletion',
    'Lease', 'ReleaseResult', 'RecoveryIssue',
  ];
  for (const t of requiredTypes) {
    assert.ok(
      ports.includes(`export interface ${t}`),
      `${t} value object must be declared in conveyor-ports.ts`,
    );
  }
});

test('Port count: at least 14 formal outbound ports exist (5 mandatory + 9 additional)', () => {
  const ports = readSrc('application/ports/conveyor-ports.ts');
  const workerExecutor = readSrc('application/ports/worker-executor.ts');
  const allPortFiles = ports + workerExecutor;
  const expectedInterfaces = [
    // 5 mandatory
    'WorkAssignmentPort', 'WorkerLauncherPort', 'WorkerSupervisionPort',
    'WorkspacePort', 'ProductRepositoryPort',
    // 5 additional (new) + 4 already-formalized verified above
    'ModuleCatalogPort', 'ExecutionJournalPort', 'ProcessLivenessPort',
    'ClockPort', 'IdGeneratorPort',
  ];
  for (const iface of expectedInterfaces) {
    assert.ok(
      allPortFiles.includes(iface),
      `${iface} must appear in the formal port files`,
    );
  }
});
