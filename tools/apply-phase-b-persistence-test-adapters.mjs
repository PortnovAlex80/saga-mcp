#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

function read(file) { return readFileSync(file, 'utf8'); }
function write(file, value) { writeFileSync(file, value, 'utf8'); }
function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}
function replaceExact(file, needle, replacement, expected = 1) {
  const source = read(file);
  const found = count(source, needle);
  if (found !== expected) {
    throw new Error(`${file}: expected ${expected} anchor(s), found ${found}: ${needle.slice(0, 140)}`);
  }
  write(file, source.split(needle).join(replacement));
}
function replaceBetween(file, start, end, replacement) {
  const source = read(file);
  const starts = count(source, start);
  if (starts !== 1) throw new Error(`${file}: start anchor count=${starts}: ${start}`);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`${file}: end anchor missing: ${end}`);
  write(file, source.slice(0, from) + replacement + source.slice(to));
}

// Lifecycle mutations stay confined to an explicit lifecycle writer.
replaceExact(
  'tests/lifecycle/architecture.test.mjs',
  "    'src/lifecycle/invariant-scanner.ts',",
  "    'src/lifecycle/invariant-scanner.ts',\n    'src/lifecycle/legacy-assignment-recovery.ts',",
);

// Characterization follows the moved recovery implementation.
replaceExact(
  'tests/characterization/saga2-runtime-contracts.test.mjs',
  "    'releaseExecutionAtomically',",
  "    'recoverLegacyAssignment',",
);

// ADR-012 track tests must invoke the same public worker/persistence seams as
// production and e2e-pipeline.test.mjs.
replaceBetween(
  'tests/track-pipeline.test.mjs',
  'async function runEngine(fixture) {',
  '\n}\n\n// Kill any mock-claude children',
`async function runEngine(fixture) {
  const { orchestrate } = await import('../dist/orchestrate.js');
  const { createLegacyClaudeWorkerExecutorFactory } = await import(
    '../dist/infrastructure/workers/legacy-claude-worker-executor-factory.js'
  );
  const {
    SqliteEpisodeRuntimeRepository,
    SqliteExecutionRuntimeRepository,
    SqliteTaskRuntimeRepository,
  } = await import('../dist/infrastructure/persistence/sqlite-saga2-runtime-repositories.js');
  const { SqliteWorkspaceResolver } = await import(
    '../dist/infrastructure/workspaces/sqlite-workspace-resolver.js'
  );

  const persistence = {
    episodes: new SqliteEpisodeRuntimeRepository(),
    tasks: new SqliteTaskRuntimeRepository(),
    executions: new SqliteExecutionRuntimeRepository(),
    workspaces: new SqliteWorkspaceResolver(),
  };
  fixture.spawnedChildren = [];
  const workerExecutorFactory = createLegacyClaudeWorkerExecutorFactory({
    modelRouteReader: epicId => persistence.episodes.readWorkerModelRoute(epicId),
    spawn: (cmd, args, opts) => {
      const mockScript = path.join(sagaRoot, 'tests', 'mock-claude.mjs');
      const child = nodeSpawn(cmd, [mockScript, ...args], opts);
      fixture.spawnedChildren.push(child);
      return child;
    },
  });

  return orchestrate({
    projectId: fixture.project.id,
    epicId: fixture.epic.id,
    concurrency: 1,
    claudePath: process.execPath,
    dbPath: process.env.DB_PATH,
    lmStudioUrl: 'http://127.0.0.1:1234/v1',
    workerExecutorFactory,
    persistence,
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))),
  });
}
`);

// Model API tests must not read or overwrite the runner's shared ~/.claude.
replaceExact(
  'tests/lifecycle/concurrency-transition.test.mjs',
  "import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';",
  "import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';",
);
replaceExact(
  'tests/lifecycle/concurrency-transition.test.mjs',
  "const repoPath = path.join(temp, 'repo');\nmkdirSync(repoPath);",
  `const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);
const homePath = path.join(temp, 'home');
const claudePath = path.join(homePath, '.claude');
mkdirSync(claudePath, { recursive: true });
writeFileSync(path.join(claudePath, 'settings.json'), JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
    CLAUDE_CODE_SUBAGENT_MODEL: 'glm-4.7',
  },
  permissions: { allow: ['*'] },
}, null, 2));`,
);
replaceExact(
  'tests/lifecycle/concurrency-transition.test.mjs',
  "  ], { env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });",
  "  ], { env: { ...process.env, HOME: homePath, USERPROFILE: homePath, DB_PATH: dbPath, PORT: String(port), TRACKER_AUTOSTART: '0', TRACKER_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });",
);
replaceExact(
  'tests/lifecycle/concurrency-transition.test.mjs',
  "    assert.equal(typeof meta.active_model_limit, 'number');",
  "    assert.equal(typeof meta.active_model_limit, 'number');\n    assert.equal(meta.active_model_effort, 'high');",
);
replaceExact(
  'tests/lifecycle/concurrency-transition.test.mjs',
  "    assert.equal(meta.active_model_limit, 3, 'model limit set');",
  "    assert.equal(meta.active_model_limit, 3, 'model limit set');\n    assert.equal(meta.active_model_effort, 'high', 'model effort set');",
);

console.log('Phase B full-suite test adapters applied.');
