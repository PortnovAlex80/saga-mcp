import Database from 'better-sqlite3';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const DB_PATH = path.resolve('./saga4-velocity.db');
const WS = 'C:/Temp/saga4-velocity-ws';

// Fresh DB
for (const p of [DB_PATH, DB_PATH+'-shm', DB_PATH+'-wal']) { try { rmSync(p); } catch {} }
process.env.DB_PATH = DB_PATH;

const { getDb } = await import('./dist/db.js');

// Fresh git workspace
if (existsSync(WS)) { try { rmSync(WS, { recursive: true, force: true }); } catch {} }
mkdirSync(WS, { recursive: true });
execSync('git init -b main', { cwd: WS });
execSync('git config user.name Saga', { cwd: WS });
execSync('git config user.email saga@local', { cwd: WS });
writeFileSync(path.join(WS, 'README.md'), '# Sprint Velocity Calculator\n');
execSync('git add README.md && git commit -m init', { cwd: WS });

const db = getDb();
db.pragma('foreign_keys = ON');

const idea = 'Sprint Velocity Calculator — a CLI tool that reads sprint history from a JSON file (sprints with completed/planned story points), calculates average velocity, standard deviation, confidence intervals (P50/P80/P90), trend analysis, and forecasts the next sprint range. Simple TypeScript CLI, no external runtime deps, JSON file storage.';

const projectId = db.prepare("INSERT INTO projects (name, description, status, tags) VALUES (?, ?, 'active', '[]')").run('Velocity-Calc', idea).lastInsertRowid;
const epicId = db.prepare("INSERT INTO epics (project_id, name, description, status, priority, tags) VALUES (?, ?, ?, 'planned', 'high', '[]')").run(projectId, 'REQ-VEL-1', idea).lastInsertRowid;
const repoId = db.prepare("INSERT INTO repositories (name, default_branch, metadata) VALUES (?, 'main', '{}')").run('velocity-repo').lastInsertRowid;
db.prepare("INSERT INTO project_repositories (project_id, repository_id, role, local_path, integration_branch, docs_root, status, metadata) VALUES (?, ?, 'primary', ?, 'main', NULL, 'active', '{}')").run(projectId, repoId, WS);

console.log(`Created: project=${projectId} epic=${epicId} repo=${repoId} db=${DB_PATH}`);

const baseCommit = execSync('git rev-parse HEAD', { cwd: WS }).toString().trim();

const lifecycleInput = {
  schemaVersion: 'saga3.product-delivery-lifecycle-input.v2',
  projectId, epicId, initiatedBy: 'velocity-bootstrap',
  initiative: {
    subject: idea,
    context: 'Sprint velocity forecasting CLI tool — TypeScript, JSON storage, percentile-based prediction',
    evidence: [],
    constraints: ['TypeScript', 'No external runtime dependencies', 'JSON file storage'],
  },
  development: {
    policy: {
      id: 'reference-development-policy',
      version: '1',
      contentHash: '5eb756156e244802f9987ec46b0a5b699b06536f2fe1d0fd4ef86498d4a24e28',
    },
    repositories: [{
      expectedBaseCommit: baseCommit,
      integrationBranch: 'main',
      repositoryRef: { repositoryName: 'velocity-repo', role: 'primary' },
    }],
  },
  delivery: {
    mode: 'deferred',
    operatorAuthorization: null,
    policy: null,
    deferredProfile: {
      schemaVersion: 'saga3.delivery-deferred-profile.v1',
      source: 'start-from-idea',
      reason: 'authorization-required',
      profileHash: '6b77d3fa3ec10d1d24a53513d2da58992b01e82170bee07b6097d564ea0aa119',
    },
  },
};
writeFileSync(path.resolve('./velocity-lifecycle-input.json'), JSON.stringify(lifecycleInput));
console.log('Lifecycle input: ./velocity-lifecycle-input.json');
console.log('\n=== LAUNCH COMMAND ===');
console.log(`DB_PATH='${DB_PATH}' \\`);
console.log(`SAGA_REPO_ROOT='.' \\`);
console.log(`SAGA_PRODUCT_LIFECYCLE_COMPOSITION='./hex-composition.mjs' \\`);
console.log(`SAGA_CLAUDE_PATH='node tests/mock-claude.mjs' \\`);
console.log(`SAGA_PRODUCT_LIFECYCLE_INPUT='./velocity-lifecycle-input.json' \\`);
console.log(`node dist/orchestrate-cli.js ${projectId} ${epicId} --concurrency=1`);
