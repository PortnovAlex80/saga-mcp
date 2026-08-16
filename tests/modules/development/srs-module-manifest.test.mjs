// Workshop fix D: SRS §2.2 Module Manifest parsing + plan coverage. Nothing
// previously compared the accepted plan back to the SRS's declared modules,
// so the todo planner could drop renderer/events/index.html while passing
// every id-coverage gate. The fixtures below mirror the REAL SRS formats
// observed in the workshop testbed (units/todos/snake/pomodoro/stopwatch).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseSrsModuleManifest,
  evaluateSrsModuleManifestCoverage,
} = await import('../../../dist/modules/development/domain/srs-module-manifest.js');

const UNITS_SRS = `# SRS — units

## 2 Architecture

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`data/categories\` | Static category definitions | \`data/categories.js\` |
| \`engine/conversion\` | Core conversion engine | \`engine/conversion.js\` |
| \`ui/renderer\` | DOM rendering | \`ui/renderer.js\` |
| \`app\` | Application bootstrap | \`app.js\` |

### 2.3 Port Registry

Not applicable.
`;

const TODO_SRS = `# SRS — todo

### §2.2 Module Manifest

The product consists of five logical modules within a single HTML file (\`index.html\`):

| Module | Responsibility | Public Protocol | Dependencies |
|--------|---------------|-----------------|--------------|
| \`task-model\` | Task data structure | \`validateTask(data)\` | none |
| \`renderer\` | DOM rendering | \`render(state)\` | state |

### §2.3 Port Registry
`;

const POMODORO_SRS = `# SRS — pomodoro

### §2.2 Module Manifest

| Module | Responsibility | Owned Surfaces | Dependencies |
|---|---|---|---|
| \`timer-core\` | Timer state machine | \`src/timer-core.js\` | none |
| \`app\` | Bootstrap and wiring | \`index.html\`, \`src/app.js\` | all modules |

### §2.3 Port Registry

No ports.
`;

const STOPWATCH_SRS = `# SRS — stopwatch

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| **timer-core** | Timer engine | \`js/timer.js\` |
| **app** | Bootstrap | \`index.html\`, \`js/main.js\` |

### 2.3 Port Registry
`;

test('parser: units-style table yields per-module files', () => {
  const manifest = parseSrsModuleManifest(UNITS_SRS);
  assert.equal(manifest.status, 'present');
  assert.deepEqual(manifest.sectionFiles, []);
  assert.deepEqual(
    manifest.modules.map(entry => `${entry.module}:${entry.files.join(',')}`),
    [
      'data/categories:data/categories.js',
      'engine/conversion:engine/conversion.js',
      'ui/renderer:ui/renderer.js',
      'app:app.js',
    ],
  );
});

test('parser: todo-style section declares its file only in intro prose', () => {
  const manifest = parseSrsModuleManifest(TODO_SRS);
  assert.equal(manifest.status, 'present');
  // No file-bearing column: the table contributes no module rows...
  assert.deepEqual(manifest.modules, []);
  // ...but the section-level declaration is captured.
  assert.deepEqual(manifest.sectionFiles, ['index.html']);
});

test('parser: multi-file cells and markdown emphasis in module names', () => {
  const manifest = parseSrsModuleManifest(POMODORO_SRS);
  assert.equal(manifest.status, 'present');
  const app = manifest.modules.find(entry => entry.module === 'app');
  assert.ok(app, 'app module row parsed');
  assert.deepEqual(app.files, ['index.html', 'src/app.js']);

  const stopwatch = parseSrsModuleManifest(STOPWATCH_SRS);
  const timerCore = stopwatch.modules.find(entry => entry.module === 'timer-core');
  assert.ok(timerCore, 'emphasis-stripped module name');
  assert.deepEqual(timerCore.files, ['js/timer.js']);
});

test('parser: absent section and file-less section degrade to skip statuses', () => {
  assert.equal(parseSrsModuleManifest('# SRS\n\n## §2 Architecture\n\nNo modules.\n').status, 'absent');
  assert.equal(parseSrsModuleManifest(
    '### §2.2 Module Manifest (REQUIRED)\n\n| Module | Responsibility |\n|---|---|\n| `core` | logic |\n',
  ).status, 'no-files');
});

test('parser: section ends at the next same-level heading, not at deeper ones', () => {
  const manifest = parseSrsModuleManifest(
    '## §2 Architecture\n\n### §2.2 Module Manifest\n\nintro (\`index.html\`)\n\n'
    + '#### Sub-detail\n\n| Module | Files |\n|---|---|\n| `a` | `src/a.ts` |\n\n'
    + '### §2.3 Port Registry\n\n| Module | Files |\n|---|---|\n| `b` | `src/should-not-count.ts` |\n',
  );
  assert.equal(manifest.status, 'present');
  assert.deepEqual(manifest.modules.map(entry => entry.module), ['a']);
  assert.deepEqual(manifest.sectionFiles, ['index.html']);
});

test('parser: file-like tokens exclude versions, section numbers and prose', () => {
  const manifest = parseSrsModuleManifest(
    '### §2.2 Module Manifest\n\n'
    + 'Uses v1.2 libs (e.g. lodash 3.15). Section 2.2 defines modules.\n'
    + 'Files: \`src/app.js\` and \`index.html\` plus \`src/lib/util.v2.ts\`.\n',
  );
  assert.deepEqual(manifest.sectionFiles, ['src/app.js', 'index.html', 'src/lib/util.v2.ts']);
});

test('coverage: units-style plan passes, todo-style headless plan is rejected', () => {
  const units = parseSrsModuleManifest(UNITS_SRS);
  const unitsPlan = [
    { changeScopes: ['data/', 'engine/', 'ui/'] },
    { changeScopes: ['app.js'] },
  ];
  assert.equal(
    evaluateSrsModuleManifestCoverage(units, unitsPlan).outcome,
    'covered',
  );

  const todo = parseSrsModuleManifest(TODO_SRS);
  const todoHeadlessPlan = [
    { changeScopes: ['src/task.js'] },
    { changeScopes: ['package.json', 'tests/'] },
  ];
  const rejected = evaluateSrsModuleManifestCoverage(todo, todoHeadlessPlan);
  assert.equal(rejected.outcome, 'uncovered');
  assert.equal(rejected.gaps.length, 1);
  assert.equal(rejected.gaps[0].module, '(section-level declaration)');
  assert.deepEqual(rejected.gaps[0].files, ['index.html']);

  // The accepted todo plan (index.html inside an item's scopes) passes.
  assert.equal(evaluateSrsModuleManifestCoverage(todo, [
    { changeScopes: ['index.html', 'package.json', 'tests/'] },
  ]).outcome, 'covered');
});

test('coverage: directory scopes cover descendant files; gaps list module and files', () => {
  const pomodoro = parseSrsModuleManifest(POMODORO_SRS);
  const partial = evaluateSrsModuleManifestCoverage(pomodoro, [
    { changeScopes: ['src/timer-core.js', 'index.html'] },
  ]);
  assert.equal(partial.outcome, 'uncovered');
  assert.deepEqual(partial.gaps, [
    { module: 'app', files: ['src/app.js'] },
  ]);
});

test('coverage: malformed scopes are skipped, never crash the evaluation', () => {
  const units = parseSrsModuleManifest(UNITS_SRS);
  const result = evaluateSrsModuleManifestCoverage(units, [
    { changeScopes: ['data/', 'engine/', 'ui/', 'app.js'] },
    { changeScopes: ['::bad scope::'] },
  ]);
  assert.equal(result.outcome, 'covered');
});
