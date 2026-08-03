import Database from 'better-sqlite3';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const DB_PATH = path.resolve('./saga4-fresh.db');
const WS = 'C:/Temp/saga4-fresh-ws';

// Fresh DB
for (const p of [DB_PATH, DB_PATH+'-shm', DB_PATH+'-wal']) { try { rmSync(p); } catch {} }
process.env.DB_PATH = DB_PATH;

const { getDb } = await import('../dist/db.js');

// Fresh git workspace
if (existsSync(WS)) { try { rmSync(WS, { recursive: true, force: true }); } catch {} }
mkdirSync(WS, { recursive: true });
execSync('git init -b main', { cwd: WS });
execSync('git config user.name Saga', { cwd: WS });
execSync('git config user.email saga@local', { cwd: WS });
writeFileSync(path.join(WS, 'README.md'), '# Fresh Epic Target\n');
execSync('git add README.md && git commit -m init', { cwd: WS });

const db = getDb();
db.pragma('foreign_keys = ON');

const idea = 'A simple TODO CLI app: add, list, complete, and delete tasks. Storage in JSON file. No external dependencies. TypeScript.';

const projectId = db.prepare("INSERT INTO projects (name, description, status, tags) VALUES (?, ?, 'active', '[]')").run('Fresh-Epic', idea).lastInsertRowid;
const epicId = db.prepare("INSERT INTO epics (project_id, name, description, status, priority, tags) VALUES (?, ?, ?, 'planned', 'high', '[]')").run(projectId, 'REQ-FRESH-1', idea).lastInsertRowid;
const repoId = db.prepare("INSERT INTO repositories (name, default_branch, metadata) VALUES (?, 'main', '{}')").run('fresh-repo').lastInsertRowid;
db.prepare("INSERT INTO project_repositories (project_id, repository_id, role, local_path, integration_branch, docs_root, status, metadata) VALUES (?, ?, 'primary', ?, 'main', NULL, 'active', '{}')").run(projectId, repoId, WS);

console.log(`Created: project=${projectId} epic=${epicId} repo=${repoId} db=${DB_PATH}`);

const baseCommit = execSync('git rev-parse HEAD', { cwd: WS }).toString().trim();

const lifecycleInput = {
  schemaVersion: 'saga3.product-delivery-lifecycle-input.v2',
  projectId, epicId, initiatedBy: 'fresh-epic',
  initiative: {
    subject: idea,
    context: 'Fresh epic for end-to-end saga4 conveyor test',
    evidence: [],
    constraints: [],
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
      repositoryRef: { repositoryName: 'fresh-repo', role: 'primary' },
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
writeFileSync(path.resolve('./fresh-lifecycle-input.json'), JSON.stringify(lifecycleInput));
console.log('Lifecycle input: ./fresh-lifecycle-input.json');
