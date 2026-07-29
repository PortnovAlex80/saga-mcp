// tools/scenario-authoring-kit/scenario-authoring-kit.contract.test.mjs
//
// W10-A6 Scenario Authoring Kit — the end-to-end contract / proof test.
//
// This test proves a developer can scaffold a NEW scenario and validate it
// using ONLY the kit — no Runtime, global runner, gateway, catalog, or
// existing-module source involved (WAVE10-EXTENSIBILITY-SPEC §0, §3, exit
// gate #4). It is the kit's own §0.13.10 evidence.
//
// Three layers:
//   1. Template parity — manifest.template.json and definition.template.mjs
//      describe the SAME scenario with the SAME {{TOKEN}} set. Drift between
//      the two is a build break.
//   2. Scaffold -> validate loop — scaffolding produces a manifest that passes
//      validateScenarioManifest with zero errors.
//   3. Real-world positive — the kit validator accepts the W0-A7 campaign
//      fixture manifest (the seed the production Wave 10 campaign scenario
//      upgrades), proving the validator is not over-fit to its own template.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateScenarioManifest } from './scenario-validator.mjs';
import {
  scaffoldScenario,
  substitute,
  extractTokens,
} from './scenario-scaffold.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KIT_DIR = __dirname;
const TEMPLATES_DIR = path.join(KIT_DIR, 'templates');
const REPO_ROOT = path.resolve(KIT_DIR, '..', '..');
const CAMPAIGN_FIXTURE_MANIFEST = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'synthetic-scenarios',
  'campaign',
  'manifest.json',
);

function readTpl(name) {
  return readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Layer 1: template token parity.
// ---------------------------------------------------------------------------

test('kit: manifest and definition templates carry the same token set', () => {
  const manifestTokens = extractTokens(readTpl('manifest.template.json'));
  const defTokens = extractTokens(readTpl('definition.template.mjs'));
  assert.deepEqual(
    manifestTokens.sort(),
    defTokens.sort(),
    'manifest.template.json and definition.template.mjs must use the same {{TOKEN}} set',
  );
});

test('kit: every template token is substituted by the scaffold defaults', () => {
  const manifestTpl = readTpl('manifest.template.json');
  const tokens = extractTokens(manifestTpl);
  assert.ok(tokens.length >= 8, 'template should carry a non-trivial token set');
  const out = substitute(manifestTpl, Object.fromEntries(tokens.map((t) => [t, 'X'])));
  assert.equal(extractTokens(out).length, 0, 'unsubstituted tokens remain');
});

// ---------------------------------------------------------------------------
// Layer 2: scaffold -> validate loop (the core authoring flow).
// ---------------------------------------------------------------------------

test('kit: scaffold produces a manifest that validates with zero errors', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w10-a6-scaffold-'));
  try {
    const { written, vars } = scaffoldScenario('my-scenario', dir);
    assert.ok(written.some((f) => f.endsWith('manifest.json')));
    assert.ok(written.some((f) => f.endsWith('definition.mjs')));

    const manifestPath = path.join(dir, 'manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest.json was written');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    const { summary, findings } = validateScenarioManifest(manifest);
    assert.equal(
      summary.errors,
      0,
      `scaffolded manifest must validate clean; findings: ${JSON.stringify(findings)}`,
    );
    assert.equal(manifest.identity.name, 'my-scenario');
    assert.equal(manifest.entryStageId, vars.ENTRY_STAGE_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kit: scaffold honours --set-style overrides and still validates', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w10-a6-overrides-'));
  try {
    const { vars } = scaffoldScenario('custom', dir, {
      overrides: {
        MODULE_NAME_1: 'lm-marketing',
        MODULE_VERSION_1: '1.2.0',
        ENTRY_STAGE_ID: 'ideate',
        ENTRY_STAGE_DISPLAY_NAME: 'Ideate',
        OUTCOME_1: 'idea-ready',
        STAGE_2_ID: 'ship',
        TERMINAL_STATUS_OK: 'custom-shipped',
        TERMINAL_STATUS_FAIL: 'custom-aborted',
      },
    });
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.stages[0].moduleRef.name, 'lm-marketing');
    assert.equal(manifest.stages[0].moduleRef.version, '1.2.0');
    assert.equal(manifest.entryStageId, 'ideate');
    assert.deepEqual(manifest.terminalStatuses, ['custom-shipped', 'custom-aborted']);
    // the overridden OUTCOME_1 must wire stage1 -> stage2.
    assert.deepEqual(manifest.stages[0].outcomeRoutes['idea-ready'], { type: 'stage', stageId: 'ship' });
    // and the entry stage display name flowed through.
    assert.equal(manifest.stages[0].displayName, 'Ideate');

    const { summary } = validateScenarioManifest(manifest);
    assert.equal(summary.errors, 0, JSON.stringify(vars));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kit: scaffold refuses non-empty target without --force', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w10-a6-busy-'));
  try {
    // place a file so the dir is non-empty
    scaffoldScenario('first', path.join(dir, 'first'));
    assert.throws(
      () => scaffoldScenario('second', path.join(dir, 'first')),
      /not empty/i,
    );
    // force works.
    scaffoldScenario('second', path.join(dir, 'first'), { force: true });
    const manifest = JSON.parse(
      readFileSync(path.join(dir, 'first', 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.identity.name, 'second');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kit: scaffold rejects non-kebab scenario names', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'w10-a6-name-'));
  try {
    assert.throws(() => scaffoldScenario('Bad Name', dir), /kebab-case/i);
    assert.throws(() => scaffoldScenario('UPPER', dir), /kebab-case/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Layer 3: real-world positive — the kit validator accepts the W0-A7
// campaign fixture manifest (plan §0.3.8, the seed the Wave 10 production
// campaign scenario upgrades). Proves the validator is not over-fit to its
// own template.
// ---------------------------------------------------------------------------

test('kit: validator accepts the W0-A7 campaign fixture manifest', () => {
  // The fixture is the frozen seed; skip gracefully if a future wave moves it.
  if (!existsSync(CAMPAIGN_FIXTURE_MANIFEST)) {
    test.skip('campaign fixture manifest not present at expected path');
    return;
  }
  const manifest = JSON.parse(readFileSync(CAMPAIGN_FIXTURE_MANIFEST, 'utf8'));
  const { summary, findings } = validateScenarioManifest(manifest, {
    // Campaign fixture declares these module outcomes (definition.mjs). Feeding
    // them proves the V6 completeness rule works against a real manifest.
    moduleOutcomes: {
      'synthetic-lm-marketing': ['campaign-drafted'],
      'synthetic-external-seo': ['ranking-fetched'],
      'synthetic-kernel-analytics': ['metrics-computed'],
      'synthetic-human-director-approval': ['approved', 'rejected'],
    },
  });
  assert.equal(
    summary.errors,
    0,
    `campaign fixture must validate clean; findings: ${JSON.stringify(findings)}`,
  );
  // the fixture reuses external-seo in two stages — a reachability warning is
  // acceptable but no hard errors.
  assert.equal(summary.ok, true);
});

// ---------------------------------------------------------------------------
// Layer 4: the kit imports ZERO production source.
// ---------------------------------------------------------------------------

test('kit: validator module text imports no production source', () => {
  const validatorSrc = readFileSync(path.join(KIT_DIR, 'scenario-validator.mjs'), 'utf8');
  const scaffoldSrc = readFileSync(path.join(KIT_DIR, 'scenario-scaffold.mjs'), 'utf8');
  const forbidden = [
    /from\s+['"][^'"]*src\//,
    /from\s+['"][^'"]*modules\/catalog/,
    /from\s+['"][^'"]*process-modules\/(composition|application|persistence|modules)/,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(validatorSrc, re, 'validator imports production source — breaks §3');
    assert.doesNotMatch(scaffoldSrc, re, 'scaffold imports production source — breaks §3');
  }
  // Only node: built-ins and intra-kit relative imports allowed.
  for (const src of [validatorSrc, scaffoldSrc]) {
    const importSpecs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of importSpecs) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
        `unexpected import '${spec}' — kit may only import node: built-ins and intra-kit modules`,
      );
    }
  }
});
