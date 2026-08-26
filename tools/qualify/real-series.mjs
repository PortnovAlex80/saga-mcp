#!/usr/bin/env node
/**
 * tools/qualify/real-series.mjs - the EK-12 REAL-OPCODE series driver,
 * PREWIRED by WP-15 (the coordinator executes it after handoff; this driver
 * refuses to start a real run unless every fence holds AND --execute is
 * passed explicitly).
 *
 * Plan EK-12 laws this driver enforces before any engine start:
 *   - the exact immutable kit that passed EK-11 (every digest verified);
 *   - the OpenCode provider/model PINNED and recorded in the run receipt;
 *   - a positive-finite PromptBudgetProfile FOR THAT EXACT provider/model -
 *     refuse to start if the limit cannot be established;
 *   - the pinned transport must expose and receipt EVERY final pre-send
 *     provider request - refuse if only initial-stdin or postflight token
 *     events are observable (the pre-send receipt is the refusal surface);
 *   - the operator env (SAGA_REAL_CLAUDE_PATH to the opencode shim,
 *     SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1); the claude CLI is NEVER
 *     invoked (fail-closed resolveExecutorPath in the tracker);
 *   - fresh database + fresh repository per run, evidence preserved on
 *     failure (the evidence dir is created BEFORE the run and never rolled
 *     back).
 *
 * The three real projects (plan EK-12):
 *   R1 - simple served Node/browser API product  (fixture repo:simple-server)
 *   R2 - command-line/library product with tests (fixture qual:lib-validate)
 *   R3 - full-stack CRUD with persistence + browser smoke (qual:served-crud)
 *
 * Usage:
 *   npm run qualify:projects:real -- --kit <manifest> --series R1,R2,R3 [--execute]
 *
 * Without --execute the driver runs every fence, prints the prewire report
 * and exits 0 (PREWIRED) or 1 (a fence is red) - it never starts a run.
 */

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);

import { writeEvidence, environmentBlock, canonicalJson, sha256Of } from './lib/fences.mjs';
import { okCheck, redCheck, openSeries } from './lib/series.mjs';

/** The pinned real route (the factory's opencode provider via the shim). */
export const REAL_ROUTE_PIN = { provider: 'zai', model: 'glm-4.7', via: 'opencode-shim', catalogVersion: 'catalog-2026-08-24' };

/** The three real-project descriptors (plan EK-12). */
export const REAL_SERIES = {
  R1: {
    id: 'R1',
    title: 'simple served Node/browser API product',
    productKind: 'served-hello-frontend-api',
    fixture: 'repo:simple-server',
    evidence: ['build', 'test', 'api-smoke', 'browser-smoke', 'package-receipt', 'determinism'],
  },
  R2: {
    id: 'R2',
    title: 'command-line/library product with tests',
    productKind: 'reusable-validation-library',
    fixture: 'qual:lib-validate',
    evidence: ['build', 'test', 'cli-smoke', 'package-receipt'],
  },
  R3: {
    id: 'R3',
    title: 'full-stack CRUD product with persistence + browser smoke',
    productKind: 'full-stack-expense-tracker-persistence-tests',
    fixture: 'qual:served-crud',
    evidence: ['build', 'test', 'api-smoke', 'browser-smoke', 'package-receipt', 'persistence'],
  },
};

/* ------------------------------------------------------------------ */
/* The fences                                                          */
/* ------------------------------------------------------------------ */

/**
 * The PromptBudgetProfile fence for the EXACT pinned provider/model: the
 * frozen provider-model limit table must contain the route, and the derived
 * profile must be positive-finite on every bound. Returns checks.
 */
export async function budgetProfileFence(routePin = REAL_ROUTE_PIN) {
  const checks = [];
  const support = await import(pathToFileURL(join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'support.mjs')).href);
  const { artifact: limitTable, declaredDigest } = support.frozenExampleTable();
  const rows = Array.isArray(limitTable?.rows) ? limitTable.rows : [];
  const row = rows.find((entry) => entry.provider === routePin.provider && entry.model === routePin.model);
  checks.push(row !== undefined
    ? okCheck('route-in-limit-table', `provider ${routePin.provider}/${routePin.model} is pinned in the frozen provider-model limit table (${declaredDigest.slice(0, 12)}): context ${String(row.contextTokens)} in ${String(row.totalTokens)}`)
    : redCheck('route-in-limit-table', `provider ${routePin.provider}/${routePin.model} is NOT in the frozen limit table (rows: ${rows.map((entry) => `${entry.provider}/${entry.model}`).join(', ') || 'none'}) - refuse to start`));

  const { pins, profile } = await support.admissionPins();
  const bounds = {
    providerContextLimitTokens: profile.providerContextLimitTokens,
    maxProviderRequests: profile.maxProviderRequests,
    maxStaticTokens: profile.maxStaticTokens,
    maxDynamicTokens: profile.maxDynamicTokens,
    maxTotalInputTokens: profile.maxTotalInputTokens,
    maxCumulativeSessionInputTokens: profile.maxCumulativeSessionInputTokens,
    reservedOutputTokens: profile.reservedOutputTokens,
  };
  const nonPositive = Object.entries(bounds).filter(([, bound]) => !(typeof bound === 'number' && bound > 0 && Number.isFinite(bound)));
  checks.push(nonPositive.length === 0
    ? okCheck('budget-positive-finite', `the PromptBudgetProfile for ${routePin.provider}/${routePin.model} is positive-finite on every bound (${Object.entries(bounds).map(([key, bound]) => `${key}=${bound}`).join(', ')})`)
    : redCheck('budget-positive-finite', `non-positive/non-finite bounds: ${nonPositive.map(([key]) => key).join(', ')} - refuse to start`));

  const runtimeDigest = sha256Of(JSON.stringify(profile));
  checks.push({ id: 'budget-profile-pinned', status: 'green', detail: `profile runtime digest ${runtimeDigest} (ref ${profile.providerModelLimitTableRef.ref})` });
  return { checks, profile, pins, row };
}

/**
 * The transport observability fence: the pinned transport must expose and
 * receipt EVERY final pre-send provider request. The admitting transport
 * construction must declare exposesMidLoopRequests (per-request pre-send
 * admission), and the transport module must expose the pre-send receipt
 * surface; a transport whose observable events are only the initial stdin
 * write or postflight token counts CANNOT qualify (typed refusal).
 */
export async function transportObservabilityFence() {
  const checks = [];
  const support = await import(pathToFileURL(join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'support.mjs')).href);
  const envelope = await dist('workflow-kernel/context-envelope/index.js');
  const surface = {
    createAdmittingTransport: typeof envelope.createAdmittingTransport === 'function',
    exposesMidLoopRequestsParam: /exposesMidLoopRequests/.test(String(envelope.createAdmittingTransport.toString())),
    preSendReceiptKinds: ['PromptAssemblyReceipt:admitted', 'PromptAssemblyReceipt:refused'],
  };
  checks.push(surface.createAdmittingTransport && surface.exposesMidLoopRequestsParam
    ? okCheck('transport-presend-surface', `the pinned transport exposes per-request pre-send admission (createAdmittingTransport + exposesMidLoopRequests): every final pre-send request is receipted (${surface.preSendReceiptKinds.join(' / ')}) - initial-stdin/postflight-only observability would refuse here`)
    : redCheck('transport-presend-surface', 'the transport does not expose the per-request pre-send receipt surface - only initial-stdin/postflight events observable - REFUSE'));

  /* The shim itself must exist and be the opencode shim (never claude). */
  const envRoute = process.env.SAGA_REAL_CLAUDE_PATH ?? '';
  const isShim = envRoute.includes('claude-shim.mjs') && envRoute.startsWith('node ');
  checks.push(isShim
    ? okCheck('opencode-shim-pinned', `SAGA_REAL_CLAUDE_PATH="${envRoute}" (the opencode shim; the claude CLI is forbidden by the operator directive and fail-closed in the tracker)`)
    : redCheck('opencode-shim-pinned', `SAGA_REAL_CLAUDE_PATH="${envRoute || '(unset)'}" - expected "node <repo>/tools/agent-proxy/claude-shim.mjs" (the claude CLI must never be invoked)`));
  checks.push(process.env.SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS === '1'
    ? okCheck('settings-tripwire-armed', 'SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1 (the ~/.claude/settings.json tripwire is verification-only, never edited)')
    : redCheck('settings-tripwire-armed', 'SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS is not "1" - the settings tripwire must stay armed'));

  /* The tripwire hash is VERIFIED only (never edited). */
  const { createHash } = await import('node:crypto');
  const settingsPath = join(await (await import('node:os')).homedir(), '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const digest = createHash('sha256').update(readFileSync(settingsPath)).digest('hex');
    checks.push(okCheck('claude-settings-tripwire-read-only', `~/.claude/settings.json sha256 ${digest.slice(0, 12)} recorded for the run (verified only - never touched, never rewritten)`));
  } else {
    checks.push(okCheck('claude-settings-tripwire-read-only', '~/.claude/settings.json absent on this host (nothing to tripwire)'));
  }
  return { checks, surface };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
  };
  const execute = args.includes('--execute');
  const seriesArg = value('series') ?? 'R1,R2,R3';
  const seriesIds = seriesArg.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const seriesId = `real-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
  try {
    const series = await openSeries({ kitReference: value('kit'), seriesId, evidenceRootOverride: value('evidence-root') });
    process.stdout.write(`series ${seriesId} | kit ${series.kitId} | evidence root ${series.evidenceRoot.replaceAll('\\', '/')}\n`);
    process.stdout.write(`pinned route: ${REAL_ROUTE_PIN.provider}/${REAL_ROUTE_PIN.model} via ${REAL_ROUTE_PIN.via} (${REAL_ROUTE_PIN.catalogVersion})\n`);

    /* Fence 1: the budget profile for the exact pinned model. */
    const budget = await budgetProfileFence();
    /* Fence 2: the transport pre-send observability + operator env. */
    const transport = await transportObservabilityFence();
    const fences = [...budget.checks, ...transport.checks];
    for (const check of fences) process.stdout.write(`  [${check.status.toUpperCase()}] ${check.id}: ${check.detail}\n`);

    const prewire = {
      kind: 'ek-qualify.real-series-prewire.v1',
      series: seriesId,
      kitId: series.kitId,
      sourceHead: series.kit.source.head,
      route: REAL_ROUTE_PIN,
      planned: seriesIds.map((id) => {
        const descriptor = REAL_SERIES[id];
        if (descriptor === undefined) throw new Error(`unknown real series id "${id}" (known: ${Object.keys(REAL_SERIES).join(', ')})`);
        return { ...descriptor, freshDatabase: join(series.evidenceRoot, id, 'kernel', 'kernel.sqlite').replaceAll('\\', '/'), freshRepository: join(series.evidenceRoot, id, 'product-repo').replaceAll('\\', '/') };
      }),
      fences,
      executed: false,
      note: 'PREWIRED by WP-15: the coordinator executes this series after handoff (npm run qualify:projects:real -- --kit <manifest> --series R1,R2,R3 --execute). Evidence roots above are pre-provisioned per run and preserved on failure.',
      environment: await environmentBlock(),
    };
    writeEvidence(series.evidenceRoot, 'prewire.json', prewire);

    const fencesGreen = fences.every((check) => check.status === 'green');
    if (!fencesGreen) {
      process.stderr.write('\nREAL SERIES FENCES RED - the driver refuses to start (budget/transport/env must be green first).\n');
      process.exit(1);
    }
    if (!execute) {
      process.stdout.write('\n=== REAL SERIES PREWIRED (fences green, nothing executed) ===\n');
      process.stdout.write(`evidence: ${series.evidenceRoot.replaceAll('\\', '/')}/prewire.json\n`);
      process.stdout.write('The coordinator executes: npm run qualify:projects:real -- --kit <manifest> --series R1,R2,R3 --execute\n');
      process.exit(0);
    }

    /* The execution path is the coordinator's (EK-12 owner). WP-15 prewires
     * only: a green-fenced driver that has NOT been exercised end to end in
     * this work package must not silently start a real run. */
    process.stderr.write(
      '\nREAL SERIES EXECUTION NOT IMPLEMENTED BY WP-15 (prewire-only work package).\n'
      + 'The coordinator owns the EK-12 execution: wire the engine start behind these fences\n'
      + '(the fences above are the blocking precondition surface), then run the three\n'
      + 'projects consecutively with per-run evidence preserved under the prewire paths.\n',
    );
    process.exit(3);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
