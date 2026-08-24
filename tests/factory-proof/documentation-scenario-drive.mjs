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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScenario } from './scenario-runner.mjs';
import { buildDocumentationRuntimeCase } from './documentation-scenario-pack.mjs';

const REPO_ROOT = process.cwd();
const engineProbe = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/modules/documentation/application/pdf/pdfkit-documentation-render-provider.js')).href
);
const renderCapability = engineProbe.pdfKitDocumentationRenderProvider.probe();
const engineAvailable = renderCapability.available === true;

const requested = process.env.DOCUMENTATION_SCENARIO ?? process.argv[2] ?? '';
const scenarioId = requested
  || (engineAvailable ? 'documentation/happy-documented' : 'documentation/missing-engine-blocked');
if (scenarioId === 'documentation/happy-documented' && !engineAvailable) {
  process.stderr.write(
    `DOCUMENTATION_ENGINE_UNAVAILABLE: ${renderCapability.reason ?? 'render engine missing'} — `
      + 'documentation/happy-documented requires pdfkit + dejavu-fonts-ttf. '
      + 'Documentation renders settle honestly typed-blocked until the orchestrator admits them.\n',
  );
  process.exit(2);
}

const runtime = buildDocumentationRuntimeCase(scenarioId);

// ── ENVIRONMENT SELECTION: the production start path reads these ──────────
const docsRoot = mkdtempSync(path.join(tmpdir(), 'saga-documentation-proof-'));
process.env.SAGA_FACTORY_LIFECYCLE = 'product-documentation';
process.env.SAGA_DOCS_OUTPUT_ROOT = path.join(docsRoot, 'factory-docs');
process.env.SAGA_REPO_ROOT = REPO_ROOT;

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
