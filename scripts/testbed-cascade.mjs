#!/usr/bin/env node
/**
 * Overnight cascade driver — последовательные раунды W1→W2→W3 по всем
 * проектам (WORKSHOP-TEST-PLAN §1) для одной кампании. Кампанию задаёт env
 * (см. testbed-run.mjs): SAGA_TESTBED_DIR / SAGA_TESTBED_PROVIDER /
 * SAGA_TESTBED_MODEL / SAGA_TESTBED_TRACKER_PORT / SAGA_TESTBED_DOCS_TAG.
 *
 *   node scripts/testbed-cascade.mjs [--rounds=W1,W2,W3]
 *
 * Перед каждым раундом: wal_checkpoint(TRUNCATE) + копия БД в
 * snapshots/<round>-round-start.sqlite (§4.2). Лог: <testbed>/cascade.log.
 * Очередь не останавливается на неудаче отдельного проекта (testbed-queue).
 * Драйвер не следит за трекером — это работа внешнего мониторинга (cron).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTBED_DIR = process.env.SAGA_TESTBED_DIR || '.factory-testbed';
const TESTBED = path.join(ROOT, TESTBED_DIR);
const LOG = path.join(TESTBED, 'cascade.log');

const roundsArg = process.argv.find(a => a.startsWith('--rounds='));
const rounds = (roundsArg ? roundsArg.split('=')[1] : 'W1,W2,W3').split(',');

const line = s => appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`, 'utf8');

function snapshot(name) {
  const db = new Database(path.join(TESTBED, 'factory.sqlite'));
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  copyFileSync(path.join(TESTBED, 'factory.sqlite'), path.join(TESTBED, 'snapshots', `${name}.sqlite`));
  line(`snapshot ${name} written`);
}

mkdirSync(path.join(TESTBED, 'snapshots'), { recursive: true });
line(`CASCADE START rounds=${rounds.join(',')} testbed=${TESTBED_DIR} model=${process.env.SAGA_TESTBED_MODEL || 'qwen/qwen3.6-35b-a3b'}`);

for (const round of rounds) {
  try { snapshot(`${round}-round-start`); } catch (e) { line(`snapshot FAILED: ${e.message} — continuing`); }
  line(`ROUND ${round} START`);
  const r = spawnSync('node', ['scripts/testbed-queue.mjs', `--round=${round}`], {
    cwd: ROOT, encoding: 'utf8', env: process.env, maxBuffer: 1 << 26,
  });
  line(`ROUND ${round} END exit=${r.status}${r.stderr ? ` stderr_tail=${String(r.stderr).trim().slice(-300)}` : ''}`);
}

line('CASCADE DONE');
