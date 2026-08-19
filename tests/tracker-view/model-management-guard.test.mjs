/**
 * C-5 + C-6 residue (stage-11 PREVENTIVE-HUNT Layer 6) — the settings.json
 * switch guard must not depend only on the TRACKER's env.
 *
 * claudeSettingsSwitchDisabled reads process.env of the tracker process. The
 * ENGINE is a separate detached host: engine on the agent-proxy shim +
 * tracker without SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS / SAGA_REAL_CLAUDE_PATH
 * → the guard passes → POST /api/model/set rewrites ~/.claude/settings.json —
 * the operator's interactive channel (the bd81b02b "4.5 grid" recurrence
 * vector).
 *
 * The fix consults the DURABLE routing truth as well:
 *   - the engine spawn stamps a worker-backend marker next to the engine log
 *     (factory_launch_requests.engine_log_path + '.worker-backend');
 *   - post-C-1 frozen routes carry endpoint.backend on active
 *     worker_executions.
 * ANY 'agent-proxy' evidence among ACTIVE runs → refuse the switch.
 *
 * C-6 residue: the guarded path must not even CREATE settings.cloud.json
 * (getOrCreateCloudTemplate captured the cloud AUTH_TOKEN before the disabled
 * check).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = mkdtempSync(path.join(os.tmpdir(), 'saga-model-mgmt-guard-'));

const { SCHEMA_SQL } = await import('../../dist/schema.js');
const {
  createModelManagementApi,
  resolveClaudeSettingsSwitchGuard,
} = await import('../../tracker-view/model-management.mjs');

function makeHome() {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function writeCloudSettings(home) {
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'user-cloud-token',
    },
  };
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  return settings;
}

function makeDb() {
  const dbPath = path.join(root, `db-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'guard-p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (7,1,'guard-e')").run();
  return { db, dbPath };
}

/** Seed an ACTIVE launch whose engine stamped the agent-proxy backend marker. */
function seedActiveShimLaunch(db, backend = 'agent-proxy') {
  const engineLog = path.join(root, `engine-${Math.random().toString(36).slice(2, 8)}.log`);
  writeFileSync(engineLog, 'engine log bytes', 'utf8');
  writeFileSync(`${engineLog}.worker-backend`, backend, 'utf8');
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES ('ord-1',1,7,'existing_project','running')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_launch_requests
       (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,
        concurrency,state,engine_log_path,engine_pid,engine_spawned_at)
     VALUES ('lau-1','ord-1','resume',1,7,'operator','idem-1',2,'running',?,4242,datetime('now'))`,
  ).run(engineLog);
  return engineLog;
}

function makeApi({ home, db }) {
  const responses = [];
  const api = createModelManagementApi({
    runtimeConfig: {
      lmStudioUrl: 'http://localhost:1234/v1',
      zaiBaseUrl: 'https://api.z.ai/api/anthropic',
    },
    homeDir: home,
    withDb: fn => fn(db),
    withDbWrite: fn => fn(db),
    respondJson: (res, status, body) => responses.push({ status, body }),
    readJsonRequest: (req, onFields) => onFields(req.body),
    workerModel: 'glm-4.7',
  });
  return { api, responses };
}

function postModelSet(api, body) {
  api.handleModelSet({ body }, {});
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const CLEAN_ENV = {
  SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS: undefined,
  SAGA_REAL_CLAUDE_PATH: undefined,
  SAGA_CLAUDE_PATH: undefined,
};

// ---------------------------------------------------------------------------
// Pure decision function (preferred extraction).
// ---------------------------------------------------------------------------
test('guard decision: env markers alone disable the switch', () => {
  assert.deepEqual(
    resolveClaudeSettingsSwitchGuard({
      env: { SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS: '1' },
    }),
    { disabled: true, reasons: ['env:SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS'] },
  );
  assert.equal(
    resolveClaudeSettingsSwitchGuard({
      env: { SAGA_REAL_CLAUDE_PATH: 'node D:/tools/agent-proxy/claude-shim.mjs' },
    }).disabled,
    true,
  );
});

test('guard decision: no env markers and no durable evidence → switch allowed', () => {
  assert.deepEqual(
    resolveClaudeSettingsSwitchGuard({ env: {}, activeBackendEvidence: [] }),
    { disabled: false, reasons: [] },
  );
});

test('guard decision: DURABLE agent-proxy evidence alone disables the switch (no env markers)', () => {
  const decision = resolveClaudeSettingsSwitchGuard({
    env: {},
    activeBackendEvidence: [
      { source: 'launch:lau-1', backend: 'claude-cli' },
      { source: 'frozen-route', backend: 'agent-proxy' },
    ],
  });
  assert.equal(decision.disabled, true);
  assert.deepEqual(decision.reasons, ['durable:frozen-route']);
});

// ---------------------------------------------------------------------------
// HTTP surface through the real module (stubbed req/res).
// ---------------------------------------------------------------------------
test('C-5: /api/model/set refuses the settings.json switch when an ACTIVE launch runs the shim, tracker env clean', () => {
  const home = makeHome();
  const original = writeCloudSettings(home);
  const { db } = makeDb();
  seedActiveShimLaunch(db);
  const { api, responses } = makeApi({ home, db });

  withEnv(CLEAN_ENV, () => postModelSet(api, { model: 'glm-4.7', epic_id: 7 }));

  const settingsNow = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(
    settingsNow,
    original,
    'settings.json must stay byte-identical: the engine runs the shim, settings.json belongs to the interactive claude',
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.ok, true);
  assert.match(
    responses[0].body.note,
    /durable/i,
    'the refusal note must cite the durable routing truth',
  );
  db.close();
});

test('C-5: /api/model/set also refuses when only a FROZEN ROUTE of an active execution proves the shim (no launch marker)', () => {
  const home = makeHome();
  const original = writeCloudSettings(home);
  const { db } = makeDb();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata)
     VALUES ('e-shim-1','r',1,7,1,'w1','host','running','executing',?)`,
  ).run(JSON.stringify({
    execution_context: {
      model_route: {
        provider: 'zai', model: 'glm-4.7', effort: 'high',
        endpoint: { backend: 'agent-proxy', base_url: null },
      },
    },
  }));
  const { api, responses } = makeApi({ home, db });

  withEnv(CLEAN_ENV, () => postModelSet(api, { model: 'glm-5.2', epic_id: 7 }));

  const settingsNow = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settingsNow, original,
    'frozen-route evidence of an in-flight shim execution must block the switch');
  assert.equal(responses[0].body.ok, true);
  db.close();
});

test('C-5: a TERMINAL launch marker does not block; a claude-cli marker does not block', () => {
  const home = makeHome();
  writeCloudSettings(home);
  const { db } = makeDb();
  seedActiveShimLaunch(db, 'claude-cli');
  const { api, responses } = makeApi({ home, db });

  withEnv(CLEAN_ENV, () => postModelSet(api, { model: 'glm-4.7', epic_id: 7 }));

  assert.equal(responses[0].body.ok, true);
  const settingsNow = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(
    settingsNow.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    'glm-4.7',
    'a claude-backend factory keeps the documented settings.json switch working',
  );
  db.close();
});

test('C-6 residue: guarded switch (env marker) never CREATES settings.cloud.json', () => {
  const home = makeHome();
  writeCloudSettings(home);
  const { db } = makeDb();
  const { api } = makeApi({ home, db });

  withEnv({ SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS: '1' }, () =>
    postModelSet(api, { model: 'glm-4.7', epic_id: 7 }));

  assert.equal(
    existsSync(path.join(home, '.claude', 'settings.cloud.json')),
    false,
    'the guarded path must not capture the cloud AUTH_TOKEN into a template',
  );
  db.close();
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
