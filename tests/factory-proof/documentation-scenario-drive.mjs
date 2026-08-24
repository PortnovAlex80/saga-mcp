#!/usr/bin/env node
// tests/factory-proof/documentation-scenario-drive.mjs
//
// Execute ONE Documentation scenario through the UNIFIED conformance kernel:
// buildDocumentationRuntimeCase → runScenario → ScenarioEvidenceBundle v1.
//
// This file owns only ENVIRONMENT SELECTION. The lifecycle input is assembled
// by the PRODUCTION start path itself: with SAGA_FACTORY_LIFECYCLE=
// product-documentation, `assembleProductLifecycleInput` injects the
// documentation profile (kinds + output root) exactly as an operator launch
// would — the drive never hand-builds lifecycle input or authority rows.
// The evidence pipeline — canonical composition, drive, read-only trace,
// independent oracles, bundle digest — belongs to scenario-runner.mjs, the
// same kernel every other workshop drives through. No per-workshop mini-runner.
//
// Scenario selection: `DOCUMENTATION_SCENARIO=<id>` or argv[2]. Without an
// explicit choice the drive probes the REAL render provider and picks
// honestly — engine present → `documentation/happy-documented`, engine
// absent → `documentation/missing-engine-blocked` (the pdfkit engine is an
// OPTIONAL dependency; its absence is a provable typed-blocked state, never
// a crash).

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { runScenario } from './scenario-runner.mjs';
import { buildDocumentationRuntimeCase } from './documentation-scenario-pack.mjs';

const REPO_ROOT = process.cwd();
const engineProbe = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/modules/documentation/application/pdf/pdfkit-documentation-render-provider.js')).href
);
const renderCapability = engineProbe.pdfKitDocumentationRenderProvider.probe();
const engineAvailable = renderCapability.available === true;

// ── FONT SELECTION (test-side environment selection only — the production
// resolver order stays env → dejavu package, unchanged) ────────────────────
// The render capability needs an embedded Cyrillic-capable TTF. Preferred
// source is the dejavu-fonts-ttf package; when it is not installed, the
// DOCUMENTED SAGA_DOCS_FONT override may point at a system font (the drive
// proposes Windows Arial — Cyrillic-capable, used read-only at render time,
// never redistributed). With neither present the happy spine is honestly
// undrivable and the drive stays on the blocked spine.
function selectDocumentationFont() {
  if (process.env.SAGA_DOCS_FONT) return process.env.SAGA_DOCS_FONT;
  const requireHere = createRequire(import.meta.url);
  try {
    requireHere.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
    return null; // the dejavu package is installed — production resolution finds it
  } catch {
    // fall through to the system font proposal
  }
  for (const candidate of [
    'C:\\Windows\\Fonts\\arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const selectedFont = selectDocumentationFont();
if (selectedFont) process.env.SAGA_DOCS_FONT = selectedFont;
// Re-probe AFTER font selection: availability is engine AND fonts.
const effectiveCapability = engineProbe.pdfKitDocumentationRenderProvider.probe();
const effectivelyAvailable = effectiveCapability.available === true;

const requested = process.env.DOCUMENTATION_SCENARIO ?? process.argv[2] ?? '';
let scenarioId = requested
  || (effectivelyAvailable ? 'documentation/happy-documented' : 'documentation/missing-engine-blocked');

// The blocked spine is the capability-ABSENT witness: it must be drivable in
// ANY environment. Pointing the DOCUMENTED SAGA_DOCS_FONT override at a
// nonexistent path is the honest "operator font missing" state — the
// provider's candidate list replaces the dejavu variants when the override
// is set, so font resolution deterministically fails and the render kernel
// settles the honest typed blocked outcome.
const blockedCapabilityPin = 'documentation/missing-engine-blocked';
if (scenarioId === blockedCapabilityPin) {
  process.env.SAGA_DOCS_FONT = 'C:\\__saga-proof__absent-font.ttf';
  const pinned = engineProbe.pdfKitDocumentationRenderProvider.probe();
  if (pinned.available === true) {
    process.stderr.write(
      'DOCUMENTATION_BLOCKED_SPINE_UNDRIVABLE: the render capability is available even '
        + 'with the font override pinned absent — this environment cannot honestly prove '
        + 'the capability-absent spine. Drive documentation/happy-documented instead.\n',
    );
    process.exit(2);
  }
  scenarioId = blockedCapabilityPin;
}
if (scenarioId === 'documentation/happy-documented' && !effectivelyAvailable) {
  process.stderr.write(
    `DOCUMENTATION_RENDER_CAPABILITY_UNAVAILABLE: ${effectiveCapability.reason ?? 'render capability missing'} — `
      + 'documentation/happy-documented needs pdfkit AND a Cyrillic TTF (dejavu-fonts-ttf or '
      + 'SAGA_DOCS_FONT). Documentation renders settle honestly typed-blocked until then.\n',
  );
  process.exit(2);
}

const runtime = buildDocumentationRuntimeCase(scenarioId);

// ── ENVIRONMENT SELECTION: the production start path reads these ──────────
const docsRoot = mkdtempSync(path.join(tmpdir(), 'saga-documentation-proof-'));
process.env.SAGA_FACTORY_LIFECYCLE = 'product-documentation';
process.env.SAGA_DOCS_OUTPUT_ROOT = path.join(docsRoot, 'factory-docs');
process.env.SAGA_REPO_ROOT = REPO_ROOT;
if (scenarioId === 'documentation/happy-documented') {
  // The rendered PDFs stay in this temp dir as the run's artifacts (the
  // oracles verify them against the persisted render receipts in-flight).
  process.stderr.write(
    `[documentation-drive] scenario=${scenarioId} font=${selectedFont ?? 'dejavu-fonts-ttf'} `
      + `outputRoot=${process.env.SAGA_DOCS_OUTPUT_ROOT}\n`,
  );
}

const harness = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
);
const { bootstrapFreshHarness } = harness;
const manifest = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { HARNESS_CONCURRENCY_CEILING } = manifest;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  ...(process.env.PROOF_KEEP_DIR ? { tempDir: process.env.PROOF_KEEP_DIR } : {}),
  idea: 'Unified Documentation proof: PDF documentation set through the real product-documentation lifecycle',
});

try {
  const input = bootstrap.lifecycleInput;
  if (!input || typeof input !== 'object' || !('documentation' in input)) {
    throw new Error(
      'DOCUMENTATION_PROOF_INPUT_PROFILE_MISSING: the production assembler did not inject the '
        + 'documentation profile although SAGA_FACTORY_LIFECYCLE=product-documentation was set',
    );
  }

  // ── THE UNIFIED KERNEL ──
  const { productDocumentationLifecycle } = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/process-modules/lifecycles/product-documentation-lifecycle.js')).href);
  const bundle = await runScenario({
    scenario: runtime.scenario,
    bootstrap,
    proofModes: ['Durable', 'CanonicalFast'],
    handlers: runtime.handlers,
    oracles: runtime.oracles,
    lifecycleDefinition: productDocumentationLifecycle,
    driveOptions: {
      launchRef: bootstrap.launchRef,
      scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
      ...(runtime.driveOptions ?? {}),
    },
  });

  process.stdout.write(JSON.stringify(bundle) + '\n');
  bootstrap.cleanup();
  process.exit(bundle.verdict === 'pass' ? 0 : 1);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  bootstrap.cleanup();
  process.exit(2);
}
