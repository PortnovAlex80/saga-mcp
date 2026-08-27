/**
 * reconciliation.test.mjs - the report-only reconciliation laws
 * (FRF-WP06; the F-2 finding fix):
 *   - THE COMPUTED VERDICT: the report carries the ACTUAL gaps verdict -
 *     a snapshot with any gap yields 'gaps' with named findings, the
 *     repaired snapshot yields 'consistent' with none. A hardcoded
 *     'consistent' (the installed defect, forward finding F-2) cannot
 *     produce both and is killed;
 *   - forward and reverse gaps are named with typed reasons;
 *   - the reconciler NEVER mutates its inputs (byte-for-byte deep
 *     clone compare) and returns a deep-frozen report;
 *   - determinism: the same snapshot yields the same report digest;
 *   - fail-closed: a missing chain layer is a named gap, not a skip;
 *   - row continuity: rows keep the installed
 *     formalization.what-reconciliation.v1 row shape.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..');
const FIXTURES = join(HERE, 'fixtures');
const moduleImport = (path) => import(pathToFileURL(path).href);
const cell = () => moduleImport(join(ROOT, 'src/workflow-kernel/workshops/formalization/cells/acceptance/index.mjs'));

const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inputs = () => load(join(FIXTURES, 'green/acceptance-universe-inputs.json'));
const greenBundle = () => load(join(FIXTURES, 'green/acceptance-bundle.json'));

/** The complete green chain snapshot (every layer present and closed). */
function greenSnapshot() {
  const i = inputs();
  return {
    universe: undefined, // filled by the caller after acceptanceUniverseFrom
    requirements: i.requirementsBundle.requirements,
    acceptance: greenBundle(),
    prd: {
      memberIds: ['prd:boundary-1', 'prd:constraint-1', 'prd:outcome-1', 'prd:scope-1', 'prd:scope-2', 'prd:terminal-1', 'prd:unknown-1'],
      scenarioRequiredMemberIds: ['prd:outcome-1', 'prd:scope-2'],
      directRequirementMemberIds: ['prd:constraint-1'],
      deferredMemberIds: ['prd:unknown-1'],
    },
    useCases: i.useCases,
    sourceClaims: {
      claimIds: ['claim:outcome-1', 'claim:scope-2', 'claim:constraint-1', 'claim:scope-1'],
      claimToMember: {
        'claim:outcome-1': 'prd:outcome-1',
        'claim:scope-2': 'prd:scope-2',
        'claim:constraint-1': 'prd:constraint-1',
        'claim:scope-1': 'prd:scope-1',
      },
    },
  };
}

async function greenChain() {
  const c = await cell();
  const universe = c.acceptanceUniverseFrom(inputs());
  assert.equal(universe.ok, true);
  const snapshot = greenSnapshot();
  snapshot.universe = universe.universe;
  return { c, snapshot };
}

test('the green closed chain reconciles consistent with zero findings', async () => {
  const { c, snapshot } = await greenChain();
  const report = c.reconcileWhat(snapshot);
  assert.equal(report.verdict, 'consistent');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.schemaVersion, 'formalization.what-reconciliation.v1');
});

test('THE F-2 KILL: the verdict is COMPUTED from the actual findings, both directions', async () => {
  const { c, snapshot } = await greenChain();
  // Introduce exactly one gap: an uncovered requirement (drop its criterion).
  const gapped = structuredClone(snapshot);
  gapped.acceptance.criteria = gapped.acceptance.criteria.filter((entry) => entry.criterionId !== 'ac:retention-1');
  const gapReport = c.reconcileWhat(gapped);
  assert.equal(gapReport.verdict, 'gaps', 'a snapshot with a real gap MUST carry verdict gaps (never a hardcoded consistent)');
  assert.equal(gapReport.gaps.length, 1);
  assert.equal(gapReport.findings[0].reason, 'COVERAGE_GAP');
  assert.match(gapReport.findings[0].detail, /nfr:retention-1/);
  // Repair the same snapshot: the SAME function must now say consistent -
  // a hardcoded verdict cannot produce both.
  const repaired = structuredClone(gapped);
  repaired.acceptance.deferrals.push({ requirementId: 'nfr:retention-1', disposition: 'deferred', owner: 'compliance', reason: 'retention window renegotiation pending' });
  const repairedReport = c.reconcileWhat(repaired);
  assert.equal(repairedReport.verdict, 'consistent');
  assert.deepEqual(repairedReport.findings, []);
});

test('forward and reverse gaps are both named with typed reasons', async () => {
  const { c, snapshot } = await greenChain();
  // Reverse gap: a foreign criterion binding.
  const reverse = structuredClone(snapshot);
  reverse.acceptance.criteria[0].bindsTo.requirementRefs = ['fr:ghost'];
  const reverseReport = c.reconcileWhat(reverse);
  assert.equal(reverseReport.verdict, 'gaps');
  const reverseFinding = reverseReport.findings.find((f) => f.direction === 'reverse');
  assert.equal(reverseFinding.reason, 'FOREIGN_LINEAGE');
  assert.equal(reverseFinding.layer, 'acceptance');
  // Forward gap: scenario survival - an accepted UC with no requirement.
  const forward = structuredClone(snapshot);
  forward.requirements = forward.requirements.filter((entry) => entry.requirementId !== 'fr:batch-1');
  // NOTE: removing fr:batch-1 also uncovers branch coverage and requirement
  // coverage - all named; the scenario-survival finding must be among them.
  const forwardReport = c.reconcileWhat(forward);
  assert.equal(forwardReport.verdict, 'gaps');
  const survival = forwardReport.findings.find((f) => f.layer === 'scenario');
  assert.ok(survival, 'the scenario survival gap is named');
  assert.match(survival.detail, /uc:batch-1/);
  // Forward gap: scenario_required intent member reaching no requirement.
  const intent = structuredClone(snapshot);
  intent.prd.scenarioRequiredMemberIds = ['prd:terminal-1'];
  const intentReport = c.reconcileWhat(intent);
  const intentFinding = intentReport.findings.find((f) => f.layer === 'intent');
  assert.equal(intentFinding.reason, 'COVERAGE_GAP');
  assert.match(intentFinding.detail, /prd:terminal-1/);
});

test('REPORT-ONLY: the reconciler never mutates its inputs (byte-for-byte)', async () => {
  const { c, snapshot } = await greenChain();
  const gapped = structuredClone(snapshot);
  gapped.acceptance.criteria = gapped.acceptance.criteria.filter((entry) => entry.criterionId !== 'ac:retention-1');
  const before = JSON.stringify(gapped);
  const report = c.reconcileWhat(gapped);
  assert.equal(JSON.stringify(gapped), before, 'the snapshot is byte-identical after reconciliation');
  // The report is deep-frozen: no finding, gap, or row can be patched.
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.findings));
  assert.ok(Object.isFrozen(report.gaps));
  assert.ok(Object.isFrozen(report.rows));
  assert.throws(() => { report.verdict = 'consistent'; }, TypeError);
  assert.throws(() => { report.findings.push({}); }, TypeError);
  // Reconciliation of the SAME snapshot twice yields the identical digest.
  const again = c.reconcileWhat(gapped);
  assert.equal(again.reportDigest, report.reportDigest);
});

test('fail-closed: a missing chain layer is a named gap, never a silent skip', async () => {
  const { c, snapshot } = await greenChain();
  const layerless = structuredClone(snapshot);
  delete layerless.prd;
  const report = c.reconcileWhat(layerless);
  assert.equal(report.verdict, 'gaps');
  const layerFinding = report.findings.find((f) => f.reason === 'MISSING_LINEAGE' && /complete accepted chain/.test(f.detail));
  assert.ok(layerFinding, 'the absent layer is named');
  const universeless = c.reconcileWhat({ ...structuredClone(snapshot), universe: undefined });
  assert.equal(universeless.verdict, 'gaps');
  assert.ok(universeless.findings.some((f) => f.subject === 'universe'));
});

test('row continuity: rows keep the installed what-reconciliation row shape', async () => {
  const { c, snapshot } = await greenChain();
  const report = c.reconcileWhat(snapshot);
  assert.ok(report.rows.length > 0);
  for (const row of report.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['criterionRefs', 'memberRef', 'requirementRefs', 'scenarioRef', 'sourceClaimRef']);
    assert.ok(snapshot.sourceClaims.claimIds.includes(row.sourceClaimRef));
  }
  const outcomeRow = report.rows.find((row) => row.sourceClaimRef === 'claim:outcome-1');
  assert.deepEqual(outcomeRow.requirementRefs, ['fr:cart-1']);
  assert.deepEqual([...outcomeRow.criterionRefs].sort(), ['ac:checkout-alt-1', 'ac:checkout-end-1']);
});

test('the report digest is deterministic and content-derived', async () => {
  const { c, snapshot } = await greenChain();
  const a = c.reconcileWhat(snapshot);
  const b = c.reconcileWhat(structuredClone(snapshot));
  assert.equal(a.reportDigest, b.reportDigest);
  assert.match(a.reportDigest, /^sha256:[0-9a-f]{64}$/);
  // A report-content change (a new named gap) changes the digest.
  const changed = structuredClone(snapshot);
  changed.acceptance.criteria = changed.acceptance.criteria.filter((entry) => entry.criterionId !== 'ac:retention-1');
  const changedReport = c.reconcileWhat(changed);
  assert.notEqual(changedReport.reportDigest, a.reportDigest);
});
