#!/usr/bin/env node
// tests/factory-proof/formalization-scenario-drive.mjs
//
// Execute ONE Formalization closure scenario on a fresh canonical Factory and
// print one ScenarioEvidenceBundle JSON line. Each scenario is isolated so DB,
// composition singletons and actor closure state cannot leak between cases.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScenario } from './scenario-runner.mjs';
import {
  FORMALIZATION_CLOSURE_SCENARIOS,
  buildFormalizationUnifiedRuntimeCase,
} from './formalization-resilience-pack.mjs';
import { FORMALIZATION_HANDLER_KEYS } from './formalization-scenario-pack.mjs';
import {
  FORMALIZATION_RESTART_IDEA,
  runFormalizationRestartProof,
} from './formalization-restart-proof.mjs';
import {
  runFormalizationRetryExhaustionProof,
} from './formalization-retry-exhaustion-proof.mjs';

const REPO_ROOT = process.cwd();
const scenarioId = process.env.FORMALIZATION_SCENARIO ?? process.argv[2] ?? '';
if (!scenarioId) {
  throw new Error(
    `FORMALIZATION_SCENARIO required; known=${FORMALIZATION_CLOSURE_SCENARIOS.map(s => s.id).join(',')}`,
  );
}

const harness = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
);
const manifest = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { bootstrapFreshHarness } = harness;
const { HARNESS_CONCURRENCY_CEILING } = manifest;

const runtime = buildFormalizationUnifiedRuntimeCase(scenarioId);

// The shared historical W9 fixtures predate the kernel-gate artifact-acceptance
// cutover and still ask artifact_create(status:'accepted') for Formalization
// authors. Under the current production contract a worker may only publish
// candidate material; formalization.accept-exact-products.v1 commits
// accepted_hash/status after the Gate. Normalize only the scripted cognition
// stimulus here — never production state or authority.
const formalizationAuthorKeys = new Set([
  FORMALIZATION_HANDLER_KEYS.productAuthor,
  FORMALIZATION_HANDLER_KEYS.useCasesAuthor,
  FORMALIZATION_HANDLER_KEYS.acceptanceAuthor,
  FORMALIZATION_HANDLER_KEYS.reconciliationAuthor,
  FORMALIZATION_HANDLER_KEYS.architectureAuthor,
]);

function currentAuthorityHandlers(handlers) {
  const normalized = { ...handlers };
  for (const key of formalizationAuthorKeys) {
    const original = normalized[key];
    if (typeof original !== 'function') continue;
    normalized[key] = context => {
      const upstream = context.handlers.artifact_create;
      const authoritySafeHandlers = {
        ...context.handlers,
        artifact_create(input) {
          if (!input || typeof input !== 'object') return upstream(input);
          const next = structuredClone(input);
          if (next.status === 'accepted') next.status = 'draft';
          return upstream(next);
        },
      };
      return original({ ...context, handlers: authoritySafeHandlers });
    };
  }
  return Object.freeze(normalized);
}

const runtimeHandlers = currentAuthorityHandlers(runtime.handlers);

// The legacy trace field `effectReceipts` is the generic transition/effect
// table. Production Cell post-acceptance effects use the stricter
// factory_cell_effect_receipts ledger. Until all callers migrate to the latter,
// replace only the happy-path oracle here with one against the exact Cell ledger.
const runtimeOracles = scenarioId === 'formalization/happy-formalized'
  ? [
      ...(runtime.oracles ?? []).filter(oracle =>
        oracle.id !== 'formalization.accept-products.effect-receipts'),
      {
        id: 'formalization.accept-products.cell-effect-receipts',
        evaluate({ durableTrace }) {
          const rows = (durableTrace.cellEffectReceipts ?? []).filter(row =>
            row.effect_id === 'formalization.accept-exact-products.v1');
          const workplaces = new Set(rows.map(row => row.workplace_ref));
          return {
            passed: rows.length >= 5 && workplaces.size >= 5,
            evidenceRefs: rows.map(row => String(row.effect_receipt_ref)),
            details: { count: rows.length, workplaces: [...workplaces].sort() },
          };
        },
      },
    ]
  : runtime.oracles;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  // PROOF_KEEP_DIR: retain the temp harness (DB + repo) for post-mortem.
  ...(process.env.PROOF_KEEP_DIR ? { tempDir: process.env.PROOF_KEEP_DIR } : {}),
  idea: runtime.specialDrive === 'formalization-restart-idempotency'
    ? FORMALIZATION_RESTART_IDEA
    : `Unified Formalization proof scenario: ${scenarioId}`,
});

try {
  let bundle;
  if (runtime.specialDrive === 'formalization-restart-idempotency') {
    bundle = await runFormalizationRestartProof({
      scenario: runtime.scenario,
      bootstrap,
      handlers: runtimeHandlers,
      concurrencyCap: HARNESS_CONCURRENCY_CEILING,
    });
  } else if (runtime.specialDrive === 'formalization-retry-exhaustion') {
    bundle = await runFormalizationRetryExhaustionProof({
      scenario: runtime.scenario,
      bootstrap,
      handlers: runtimeHandlers,
      concurrencyCap: HARNESS_CONCURRENCY_CEILING,
      targetName: runtime.targetName,
    });
  } else {
    bundle = await runScenario({
      scenario: runtime.scenario,
      bootstrap,
      proofModes: ['Durable', 'CanonicalFast'],
      handlers: runtimeHandlers,
      crashPoint: runtime.crashPoint,
      oracles: runtimeOracles,
      actorEvidence: runtime.actorEvidence,
      faultJournal: runtime.faultJournal,
      externalWorldJournal: runtime.externalWorldJournal,
      driveOptions: {
        scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
        pollMs: 5,
        maxEmptyDispatchStreak: 12,
        ...runtime.driveOptions,
      },
    });
  }
  process.stdout.write(JSON.stringify(bundle) + '\n');
  if (bundle.verdict !== 'pass') process.exitCode = 1;
} finally {
  bootstrap.cleanup();
}
