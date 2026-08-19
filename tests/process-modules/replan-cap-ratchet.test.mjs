// tests/process-modules/replan-cap-ratchet.test.mjs
//
// RE-PLAN CYCLE (REPLAN-CYCLE-TZ §6) — the anti-eternal-loop rules, units
// T7/T8 of 9.
//
//   T7 CAP    — at most 2 re-plan cycles per case lineage. The THIRD
//               scope-impossible trigger is denied: human_required with the
//               full diagnosis, never a third cycle.
//   T8 RATCHET— the monotonic burn requirement: each new cycle's mandate must
//               fire on at least one key ABSENT from every prior mandate of
//               the lineage. The SAME path-outside-authority key surviving
//               the re-carve means the planner reproduced the burn — no
//               cycle 3.
//
// The count (replanCycleCount) is realized as the append-only
// factory_replan_mandates ledger (K13 house pattern): one row per minted
// mandate, keyed by the case lineage; factory_lifecycle_runs carries no
// metadata column.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import {
  decideReplanCycle,
  REPLAN_CYCLE_CAP,
} from '../../dist/process-modules/domain/workplace/replan-cycle-policy.js';
import { SqliteReplanMandateLedger } from '../../dist/infrastructure/workplace/sqlite-replan-mandate-ledger.js';

const SPACECRAFT_KEY = 'development.implementation-scope.v1:path-outside-authority'
  + '::Git paths [src/physics/spacecraft.js] are outside frozen changeScopes '
  + '[package.json, src/game/, tests/].';
const VFX_KEY = 'development.implementation-scope.v1:path-outside-authority'
  + '::Git paths [src/render/vfx.js] are outside frozen changeScopes [src/ui/].';

function mandate(cycleNumber, survivingKeys) {
  return { cycleNumber, survivingKeys };
}

test('T7 RED: the THIRD trigger is denied by the cap — human_required, never a third cycle', () => {
  assert.equal(REPLAN_CYCLE_CAP, 2, 'at most two re-plan cycles per case lineage');
  const first = decideReplanCycle({ survivingKeys: [SPACECRAFT_KEY], priorMandates: [] });
  assert.deepEqual(
    { allowed: first.allowed, reason: first.reason, cycle: first.cycleNumber },
    { allowed: true, reason: 'mint', cycle: 2 },
    'the first trigger mints cycle 2',
  );
  const second = decideReplanCycle({
    survivingKeys: [VFX_KEY],
    priorMandates: [mandate(2, [SPACECRAFT_KEY])],
  });
  assert.deepEqual(
    { allowed: second.allowed, reason: second.reason, cycle: second.cycleNumber },
    { allowed: true, reason: 'mint', cycle: 3 },
    'a trigger on a NEW key after cycle 2 may mint cycle 3 (novel burn)',
  );
  const third = decideReplanCycle({
    survivingKeys: [SPACECRAFT_KEY, VFX_KEY],
    priorMandates: [mandate(2, [SPACECRAFT_KEY]), mandate(3, [VFX_KEY])],
  });
  assert.equal(third.allowed, false, 'the third trigger NEVER mints a cycle');
  assert.equal(third.reason, 'cap');
  assert.match(third.diagnosis, /src\/physics\/spacecraft\.js/,
    'the denial carries the full diagnosis — the surviving keys are named');
  assert.match(third.diagnosis, /cycle 2|cycle 3/,
    'both prior graph burns are named in the diagnosis');
});

test('T8 RED: the SAME key in the cycle-2 diagnosis is a ratchet denial — no cycle 3', () => {
  const same = decideReplanCycle({
    survivingKeys: [SPACECRAFT_KEY],
    priorMandates: [mandate(2, [SPACECRAFT_KEY])],
  });
  assert.equal(same.allowed, false,
    'the key that triggered cycle 2 surviving the re-carve means the planner reproduced the burn');
  assert.equal(same.reason, 'ratchet');
  assert.match(same.diagnosis, /src\/physics\/spacecraft\.js/);
  const novel = decideReplanCycle({
    survivingKeys: [SPACECRAFT_KEY, VFX_KEY],
    priorMandates: [mandate(2, [SPACECRAFT_KEY])],
  });
  assert.deepEqual(
    { allowed: novel.allowed, reason: novel.reason, cycle: novel.cycleNumber },
    { allowed: true, reason: 'mint', cycle: 3 },
    'a genuinely NEW cross-seam burn still earns its cycle (the ratchet is monotonic, not a lock)',
  );
});

test('ledger: mandates are counted per case lineage and the decision is idempotent per workplace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replan-ledger-'));
  const db = new Database(join(dir, 'ledger.sqlite'));
  try {
    db.exec(SCHEMA_SQL);
    ensureFactoryProcessRunSchema(db);
    db.prepare('INSERT INTO projects (name) VALUES (?)').run('ledger-test');
    db.prepare('INSERT INTO epics (id, project_id, name) VALUES (1, 1, ?)').run('ledger-test');
    db.prepare(
      `INSERT INTO factory_process_runs
         (id, project_id, epic_id, module_name, module_version, module_ref_key,
          idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
       VALUES (?, 1, 1, 'solution-development', '1.0.0', 'solution-development@1.0.0',
               ?, 'generic-flow', 'x', '{}', 'h')`,
    ).run(7, 'run:7');
    const ledger = new SqliteReplanMandateLedger(db);
    const workplaceRef = {
      processRunId: 7,
      moduleRef: 'solution-development@1.0.0',
      productionCellId: 'development-implementation',
      workKey: 'impl-physics-core',
    };
    const first = ledger.canReplan({ workplaceRef, role: 'author', survivingKeys: [SPACECRAFT_KEY] });
    assert.deepEqual(
      { allowed: first.allowed, reason: first.reason, cycleNumber: first.cycleNumber },
      { allowed: true, reason: 'mint', cycleNumber: 2 },
    );
    // Replay of the SAME workplace mandate (crash between record and park):
    // the recorded decision is returned verbatim — no double mint, no
    // accidental ratchet denial against its own row.
    const replay = ledger.canReplan({ workplaceRef, role: 'author', survivingKeys: [SPACECRAFT_KEY] });
    assert.deepEqual(
      { allowed: replay.allowed, reason: replay.reason, cycleNumber: replay.cycleNumber },
      { allowed: true, reason: 'mint', cycleNumber: 2 },
      'a replayed decision is idempotent',
    );
    const count = db.prepare('SELECT COUNT(*) AS n FROM factory_replan_mandates').get().n;
    assert.equal(count, 1, 'the replay appended nothing');
    // A DIFFERENT workplace of the same lineage mints the next cycle...
    const second = ledger.canReplan({
      workplaceRef: { ...workplaceRef, workKey: 'impl-render-vfx' },
      role: 'author',
      survivingKeys: [VFX_KEY],
    });
    assert.deepEqual(
      { allowed: second.allowed, reason: second.reason, cycleNumber: second.cycleNumber },
      { allowed: true, reason: 'mint', cycleNumber: 3 },
    );
    // ...and the lineage is now at the cap: the third trigger is denied.
    const third = ledger.canReplan({
      workplaceRef: { ...workplaceRef, workKey: 'impl-audio-mixer' },
      role: 'author',
      survivingKeys: ['dev:path-outside-authority::Git paths [src/audio/mixer.js] are outside frozen changeScopes [src/audio/].'],
    });
    assert.equal(third.allowed, false);
    assert.equal(third.reason, 'cap');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
