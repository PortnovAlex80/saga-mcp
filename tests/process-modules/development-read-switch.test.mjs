import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SqliteDevelopmentModuleStore } from '../../dist/modules/development/infrastructure/sqlite-development-settlement-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(
  here,
  '../../src/modules/development/infrastructure/sqlite-development-settlement-state.ts',
), 'utf8');

test('Development settlement exposes no task-status read authority', () => {
  assert.equal(SqliteDevelopmentModuleStore.prototype.readRuntimeTask, undefined);
  assert.equal(SqliteDevelopmentModuleStore.prototype.readRuntimeTasks, undefined);
  assert.equal(SqliteDevelopmentModuleStore.prototype.areProjectedTasksTerminal, undefined);
});

test('Development settlement reads accepted Production Cell products, not task lifecycle state', () => {
  assert.match(source, /readAcceptedCellProducts/);
  assert.match(source, /factory_candidate_sets/);
  assert.match(source, /factory_managed_node_submissions/);
  const settlementBody = source.slice(
    source.indexOf('  buildSettlementInput(input:'),
    source.indexOf('  // ----- inner workset reconstruction'),
  );
  assert.doesNotMatch(settlementBody, /FROM tasks[\s\S]{0,160}(status|integration_state)/i);
});

test('Development freeze derives integration authority from exact Cell EffectReceipts', () => {
  const freezeBody = source.slice(
    source.indexOf('  freezeIntegratedCandidate(input:'),
    source.indexOf('  buildSettlementInput(input:'),
  );
  assert.match(freezeBody, /factory_cell_effect_receipts/);
  assert.match(freezeBody, /workplace_ref=\? AND candidate_set_ref=\?/);
  assert.match(freezeBody, /effect_id='git-integration'/);
  assert.doesNotMatch(freezeBody, /SELECT integration_state,integrated_commit\s+FROM tasks/);
});
