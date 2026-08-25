/**
 * purity.test.mjs - the pure package has NO import from persistence, UI or
 * workshop modules (WP-05 exit criterion), the relation/authority kind
 * literals are exactly the frozen sets, and no workshop name appears in the
 * kernel (mutation h).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { scanKernelSources, scanDomainImports, listKernelSourceFiles } from './purity.test-support.mjs';

const scan = scanKernelSources();
// The import-purity law binds the PURE package (src/workflow-kernel/domain/**);
// the EK-3 sole-writer repositories under src/workflow-kernel/persistence/**
// lawfully import the SQLite driver and nothing else outside node builtins.
const domainImports = scanDomainImports();

test('the kernel exists and contains the domain sources', () => {
  assert.ok(scan.fileCount >= 15, `found ${scan.fileCount} kernel source files`);
});

test('no import from persistence, UI, workshop, tracker or provider modules', () => {
  const forbidden = [
    /persistence/,
    /better-sqlite3/,
    /sqlite/,
    /^ui\b|\/ui\//,
    /modules\//,
    /workshop/,
    /tracker/,
    /claude/,
    /opencode/,
    /anthropic/,
    /react|vue|svelte/,
  ];
  for (const imported of domainImports) {
    for (const rx of forbidden) {
      assert.ok(!rx.test(imported), `the pure package imports forbidden module path: ${imported}`);
    }
  }
});

test('the only non-relative imports are node builtins', () => {
  for (const imported of domainImports) {
    if (imported.startsWith('.')) continue;
    assert.ok(imported.startsWith('node:'), `unexpected external import in the pure package: ${imported}`);
  }
});

test('relation kind literals are exactly the frozen 22', () => {
  const expected = [
    'ActivityAttempt', 'CandidateSet', 'CellFinalAcceptance', 'EffectReceipt', 'FactoryRun', 'GateDecision',
    'KanbanCard', 'LifecycleRun', 'NodeRun', 'ProcessRun', 'PromptAssemblyReceipt', 'ProtocolMetadata',
    'StageRun', 'TerminalProof', 'TransitionObligation', 'TypedWait', 'WorkIntent', 'WorkItem',
    'WorkItemDependency', 'WorkflowEvent', 'Workplace', 'WorkplaceProductionRevision',
  ].sort();
  assert.deepEqual(scan.relationLiterals, expected);
});

test('authority kind literals are exactly the frozen 4', () => {
  assert.deepEqual(scan.authorityLiterals, ['Input', 'InstalledWorkshopManifest', 'Planning', 'TargetOwnerCapability'].sort());
});

test('zero workshop-name literals in the kernel (mutation h)', () => {
  assert.equal(scan.workshopNameLiterals, 0);
});

test('every kernel source file lives under src/workflow-kernel (owned paths only)', () => {
  for (const file of listKernelSourceFiles()) {
    const normalized = file.replaceAll('\\', '/');
    assert.ok(normalized.includes('/src/workflow-kernel/'), `kernel file outside the owned path: ${normalized}`);
  }
});
