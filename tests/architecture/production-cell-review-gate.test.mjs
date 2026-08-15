import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Development final review uses universal review-verdict gate, not pass-through product contract', () => {
  const source = readFileSync('src/process-modules/modules/development/development-process-module.ts', 'utf8');
  assert.match(source, /IMPLEMENTATION_FINAL_PLAN = buildCheckPlan/);
  assert.match(source, /REVIEW_VERDICT_CHECK_PROVIDER_ID/);
  assert.match(source, /repairTargetRoleOnFailure: 'author'/);
  assert.match(source, /repairTargetRoleOnIndeterminate: 'reviewer'/);
  assert.doesNotMatch(
    source,
    /IMPLEMENTATION_FINAL_PLAN =\s*buildProductContractCheckPlan/,
    'review verdict must not be accepted by an unconditional product-contract gate',
  );
});

test('GateRun identity includes assessment CandidateSets and coordinator obeys explicit reviewer target', () => {
  const driver = readFileSync('src/process-modules/application/gate-run-driver.ts', 'utf8');
  const coordinator = readFileSync('src/process-modules/application/production-cell-coordinator.ts', 'utf8');
  assert.match(driver, /assessmentCandidateSetRefs,/);
  assert.doesNotMatch(driver, /repairTargetRole:\s*verdict === 'repair_required' \? 'author'/);
  assert.match(coordinator, /decision\.repairTargetRole === 'reviewer'/);
});
