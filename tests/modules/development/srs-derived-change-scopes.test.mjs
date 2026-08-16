/**
 * SRS-derived `requiredChangeScopes` (workshop P07/todo fix).
 *
 * The development policy used to hardcode ['package.json','tests/'] for every
 * project. Project 7 (todo) accepted an SRS mandating a single index.html
 * with embedded CSS and vanilla JavaScript — the hardcoded package.json scope
 * pushed its plan away from the SRS delivery shape until the UI was lost.
 * These tests pin the derivation rule against the real workshop SRS shapes:
 *
 *   1. todo-style single-HTML SRS (index.html only, npm only as tooling)
 *      → ['index.html', 'tests/']  (NO package.json);
 *   2. Node-style SRS (src/ + package.json declared on the file surface)
 *      → ['package.json', 'src/', 'tests/'];
 *   3. missing/blank/no-declaration SRS → null marker, the policy falls back
 *      to the historical defaults and never throws;
 *   4. the assembler reads the accepted SRS through the artifacts table +
 *      repository file and builds a validated lifecycle input from it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  DEFAULT_REQUIRED_CHANGE_SCOPES,
  deriveRequiredChangeScopesFromSrs,
} = await import(
  '../../../dist/modules/development/domain/srs-derived-change-scopes.js'
);
const { buildReferenceDevelopmentPolicy, assembleProductLifecycleInput } =
  await import('../../../dist/app/start-product-lifecycle-from-idea.js');
const { hashDevelopmentPolicy } = await import(
  '../../../dist/modules/development/domain/development-settlement-policy.js'
);
const { assertProductDeliveryLifecycleInput } = await import(
  '../../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { lifecycleInputPolicyValidation } = await import(
  '../../../dist/infrastructure/process-modules/lifecycle-input-policy-validation.js'
);
const { closeDb, getDb } = await import('../../../dist/db.js');

/**
 * Real workshop project 7 (todo) SRS shape: single HTML file, embedded CSS
 * and vanilla JavaScript, NO package.json anywhere. §2.5 lists npm ONLY as
 * tooling commands (`npm test`, `node --check src/index.js`) — the delivery
 * shape has no Node scaffolding, so package.json must NOT be required.
 */
const TODO_STYLE_SRS = `# REQ-001-todo: Software Requirements Specification

## §2 Architecture

### §2.2 Module Manifest

The product consists of five logical modules within a single HTML file (\`index.html\`):

| Module | Responsibility | Public Protocol | Dependencies |
|--------|---------------|-----------------|--------------|
| \`task-model\` | Task validation | \`validateTask(data)\` | none |
| \`storage\` | localStorage persistence | \`loadTasks()\` | task-model |
| \`renderer\` | DOM rendering | \`render(state)\` | state |
| \`events\` | Event wiring | \`init()\` | state, renderer |

### §2.5 Technology Stack

| Layer | Technology | Runnable Command |
|-------|-----------|-----------------|
| Runtime | Browser (any modern) | N/A |
| Language | Vanilla JavaScript (ES2020+) | \`node --check src/index.js\` |
| Testing | Jest + Playwright | \`npm test\`, \`npm run e2e\` |
| Build | None (single HTML file) | N/A |

## §D1 Canonical File/Module Surface

| File | Module(s) | Responsibility |
|------|-----------|---------------|
| \`index.html\` | All | Single HTML file with embedded \`<style>\` and \`<script>\` |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Create task with valid title
  module: task-model
  files: [index.html]
  invariants: [INV-1]
  test_layers: [L0, L1, L2]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker

- ac: AC-2
  title: New task appears at top of list
  module: renderer
  files: [index.html]
  invariants: []
  test_layers: [L0, L1, L2]
  pattern: A
  depends_on: [AC-1]
  ac_kind: implementation
  criticality: blocker
\`\`\`

## §12 Decision Log

Single HTML file with embedded CSS/JS; no frameworks, no Node scaffolding.
`;

/**
 * Node-style SRS: src/ layout with package.json declared on the file surface
 * (§D1 + §2.5) and tests under tests/ in the §D2 map.
 */
const NODE_STYLE_SRS = `# REQ-002-units-api: SRS

### §2.5 Technology Stack

| Layer | Technology | Runnable Command |
|-------|-----------|-----------------|
| Runtime | Node.js 20 | \`node --version\` |
| Package manager | npm | scripts in \`package.json\` (\`npm test\`) |
| Testing | Vitest | \`npm test\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`package.json\` | app | npm manifest, scripts and dependencies |
| \`src/main.ts\` | app | Bootstrap |
| \`src/util/math.ts\` | util | Conversion math |
| \`tests/main.test.ts\` | tests | L0 tests |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Convert units
  module: util
  files: [src/main.ts, src/util/math.ts, tests/main.test.ts]
  invariants: [INV-1]
  test_layers: [L0, L1]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
\`\`\`
`;

/**
 * Real workshop project 8 (units) SRS shape: multi-file vanilla product
 * (index.html + css/ + js/), §2.2 "Owned Surfaces" are MODULE-RELATIVE
 * (data/categories.js for js/data/categories.js), test strategy runs npm —
 * but package.json is never named. Only the canonical file surface counts.
 */
const UNITS_STYLE_SRS = `# REQ-001-units: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`data/categories\` | Static category definitions | \`data/categories.js\` |
| \`ui/renderer\` | DOM rendering | \`ui/renderer.js\` |
| \`app\` | Bootstrap | \`app.js\` |

## 3. Test and Verification Strategy

### 3.1 Test Layers

| Layer | Description | Tools |
|---|---|---|
| L0 | Unit tests | \`npm test\` (Vitest) |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`index.html\` | app | Entry point |
| \`css/styles.css\` | ui/renderer | Styling |
| \`js/app.js\` | app | Bootstrap |
| \`js/engine/conversion.js\` | engine/conversion | Conversion engine |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Category Selection
  module: ui/renderer
  files: [js/data/categories.js, js/ui/renderer.js]
  invariants: []
  test_layers: [L0, L1]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
\`\`\`
`;

test('todo-style single-HTML SRS derives [index.html, tests/] — no package.json', () => {
  const scopes = deriveRequiredChangeScopesFromSrs(TODO_STYLE_SRS);
  assert.ok(Array.isArray(scopes));
  assert.deepEqual(scopes, ['index.html', 'tests/']);
  assert.equal(scopes.includes('package.json'), false);
});

test('Node-style SRS with package.json on the file surface derives [package.json, src/, tests/]', () => {
  const scopes = deriveRequiredChangeScopesFromSrs(NODE_STYLE_SRS);
  assert.ok(Array.isArray(scopes));
  assert.deepEqual(scopes, ['package.json', 'src/', 'tests/']);
});

test('units-style SRS derives the canonical file surface and ignores npm tooling mentions', () => {
  const scopes = deriveRequiredChangeScopesFromSrs(UNITS_STYLE_SRS);
  assert.ok(Array.isArray(scopes));
  // §2.2 module-relative surfaces (data/, ui/, app.js) must NOT leak in as
  // required scopes — only the §D1/§D2 canonical file surface counts.
  assert.deepEqual(scopes, ['css/', 'index.html', 'js/', 'tests/']);
});

test('package.json named only in §2.5 Technology Stack still becomes required', () => {
  const srs = NODE_STYLE_SRS
    .replace('| `package.json` | app | npm manifest, scripts and dependencies |\n', '')
    .replace('  files: [src/main.ts, src/util/math.ts, tests/main.test.ts]',
      '  files: [src/main.ts, src/util/math.ts]');
  const scopes = deriveRequiredChangeScopesFromSrs(srs);
  assert.ok(Array.isArray(scopes));
  assert.deepEqual(scopes, ['package.json', 'src/', 'tests/']);
});

test('negated package.json mention in §2.5 does not become required', () => {
  const srs = TODO_STYLE_SRS.replace(
    '| Build | None (single HTML file) | N/A |',
    '| Build | None (single HTML file, no package.json) | N/A |',
  );
  const scopes = deriveRequiredChangeScopesFromSrs(srs);
  assert.deepEqual(scopes, ['index.html', 'tests/']);
});

test('missing, blank or declaration-free SRS returns the null fallback marker without throwing', () => {
  assert.equal(deriveRequiredChangeScopesFromSrs(null), null);
  assert.equal(deriveRequiredChangeScopesFromSrs(undefined), null);
  assert.equal(deriveRequiredChangeScopesFromSrs(''), null);
  assert.equal(deriveRequiredChangeScopesFromSrs('   \n\t '), null);
  assert.equal(
    deriveRequiredChangeScopesFromSrs('# SRS\n\nOnly prose, no file declarations.\n'),
    null,
  );
});

test('DEFAULT_REQUIRED_CHANGE_SCOPES keeps the historical hardcoded values', () => {
  assert.deepEqual(DEFAULT_REQUIRED_CHANGE_SCOPES, ['package.json', 'tests/']);
});

test('buildReferenceDevelopmentPolicy derives scopes and a reproducible, verifiable hash', () => {
  const todoPolicy = buildReferenceDevelopmentPolicy(TODO_STYLE_SRS);
  assert.deepEqual(todoPolicy.requiredChangeScopes, ['index.html', 'tests/']);
  assert.equal(todoPolicy.id, 'reference-development-policy');
  assert.equal(todoPolicy.version, '1.1.0');
  // Strict hash verification with the canonical module hashing.
  assert.equal(hashDevelopmentPolicy(todoPolicy), todoPolicy.contentHash);

  const again = buildReferenceDevelopmentPolicy(TODO_STYLE_SRS);
  assert.deepEqual(again, todoPolicy);

  const nodePolicy = buildReferenceDevelopmentPolicy(NODE_STYLE_SRS);
  assert.deepEqual(nodePolicy.requiredChangeScopes, ['package.json', 'src/', 'tests/']);
  assert.equal(hashDevelopmentPolicy(nodePolicy), nodePolicy.contentHash);
  assert.notEqual(nodePolicy.contentHash, todoPolicy.contentHash);
});

test('buildReferenceDevelopmentPolicy without SRS content falls back to the defaults', () => {
  const fallback = buildReferenceDevelopmentPolicy();
  assert.deepEqual(
    fallback.requiredChangeScopes,
    DEFAULT_REQUIRED_CHANGE_SCOPES,
  );
  assert.equal(hashDevelopmentPolicy(fallback), fallback.contentHash);
  const blank = buildReferenceDevelopmentPolicy('  ');
  assert.deepEqual(blank, fallback);
});

// ── assembler integration: the accepted-SRS access path ────────────────────

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function createRealGitRepo() {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga-srs-scopes-repo-'));
  git(repoDir, 'init', '-q', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'test@saga.local');
  git(repoDir, 'config', 'user.name', 'Saga Test');
  writeFileSync(path.join(repoDir, 'README.md'), '# srs scopes repo\n');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-q', '-m', 'initial');
  return repoDir;
}

function createFixture(repoDir) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-srs-scopes-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(temp, 'srs-scopes.db');
  const db = getDb();
  db.prepare(
    "INSERT INTO projects (id,name,status) VALUES (1,'SRS Scopes Product','active')",
  ).run();
  db.prepare(
    "INSERT INTO epics (id,project_id,name) VALUES (10,1,'SRS Scopes Epic')",
  ).run();
  const repoInfo = db.prepare(
    "INSERT INTO repositories (name, default_branch) VALUES ('srs-scopes-repo', 'main')",
  ).run();
  const repoId = Number(repoInfo.lastInsertRowid);
  const prInfo = db.prepare(
    `INSERT INTO project_repositories
       (project_id, repository_id, role, local_path, integration_branch, status)
     VALUES (1, ?, 'control', ?, 'main', 'active')`,
  ).run(repoId, repoDir);
  return {
    temp,
    previousDbPath,
    db,
    projectRepositoryId: Number(prInfo.lastInsertRowid),
  };
}

function cleanupFixture(fixture) {
  closeDb();
  rmSync(fixture.temp, { recursive: true, force: true });
  if (fixture.previousDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = fixture.previousDbPath;
  }
}

test('assembler derives policy scopes from an accepted file_backed SRS artifact', () => {
  const repoDir = createRealGitRepo();
  const fixture = createFixture(repoDir);
  try {
    mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    const srsPath = path.join(repoDir, 'docs', 'SRS.md');
    writeFileSync(srsPath, TODO_STYLE_SRS);
    fixture.db.prepare(
      `INSERT INTO artifacts
         (project_id, epic_id, type, code, title, path, status,
          project_repository_id, storage_kind)
       VALUES (1, 10, 'SRS', 'SRS', 'SRS', 'docs/SRS.md', 'accepted', ?,
               'file_backed')`,
    ).run(fixture.projectRepositoryId);

    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'Restart the todo product with an accepted SRS.',
      db: fixture.db,
    });
    assert.deepEqual(
      input.development.policy.requiredChangeScopes,
      ['index.html', 'tests/'],
    );
    assert.doesNotThrow(() =>
      assertProductDeliveryLifecycleInput(input, lifecycleInputPolicyValidation));
  } finally {
    cleanupFixture(fixture);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('assembler keeps the default scopes when no SRS artifact exists (fresh project)', () => {
  const repoDir = createRealGitRepo();
  const fixture = createFixture(repoDir);
  try {
    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'A fresh project with no formalization yet.',
      db: fixture.db,
    });
    assert.deepEqual(
      input.development.policy.requiredChangeScopes,
      DEFAULT_REQUIRED_CHANGE_SCOPES,
    );
    assert.doesNotThrow(() =>
      assertProductDeliveryLifecycleInput(input, lifecycleInputPolicyValidation));
  } finally {
    cleanupFixture(fixture);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('assembler derives scopes from a db_native SRS artifact and ignores non-accepted ones', () => {
  const repoDir = createRealGitRepo();
  const fixture = createFixture(repoDir);
  try {
    // A draft SRS must be ignored: only ACCEPTED material is authority.
    fixture.db.prepare(
      `INSERT INTO artifacts
         (project_id, epic_id, type, code, title, path, status,
          project_repository_id, storage_kind, metadata)
       VALUES (1, 10, 'SRS', 'SRS', 'draft SRS', 'docs/ignored.md', 'draft', ?,
               'file_backed', '{}')`,
    ).run(fixture.projectRepositoryId);
    const inputDraftOnly = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'Only a draft SRS exists.',
      db: fixture.db,
    });
    assert.deepEqual(
      inputDraftOnly.development.policy.requiredChangeScopes,
      DEFAULT_REQUIRED_CHANGE_SCOPES,
    );

    fixture.db.prepare(
      `INSERT INTO artifacts
         (project_id, epic_id, type, code, title, path, status,
          project_repository_id, storage_kind, metadata)
       VALUES (1, 10, 'SRS', 'SRS', 'accepted SRS', 'docs/db-native.md',
               'accepted', ?, 'db_native', ?)`,
    ).run(fixture.projectRepositoryId, JSON.stringify({ content: NODE_STYLE_SRS }));
    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'An accepted db_native SRS exists.',
      db: fixture.db,
    });
    assert.deepEqual(
      input.development.policy.requiredChangeScopes,
      ['package.json', 'src/', 'tests/'],
    );
  } finally {
    cleanupFixture(fixture);
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('assembler fails safe when the accepted SRS file is missing on disk', () => {
  const repoDir = createRealGitRepo();
  const fixture = createFixture(repoDir);
  try {
    fixture.db.prepare(
      `INSERT INTO artifacts
         (project_id, epic_id, type, code, title, path, status,
          project_repository_id, storage_kind)
       VALUES (1, 10, 'SRS', 'SRS', 'SRS', 'docs/missing.md', 'accepted', ?,
               'file_backed')`,
    ).run(fixture.projectRepositoryId);
    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'The accepted SRS file was deleted from the checkout.',
      db: fixture.db,
    });
    assert.deepEqual(
      input.development.policy.requiredChangeScopes,
      DEFAULT_REQUIRED_CHANGE_SCOPES,
    );
  } finally {
    cleanupFixture(fixture);
    rmSync(repoDir, { recursive: true, force: true });
  }
});
