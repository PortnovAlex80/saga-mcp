/**
 * workflow-kernel/development/product-acceptance.ts - the acceptance
 * contract checker of the canonical simple product (WP-08, plan phase EK-5).
 *
 * The acceptance contract (acceptance-contract.json in the fixture) OWNS:
 * browser entry, static assets, bootstrap, build/start wiring and
 * frontend/backend integration. This module verifies a product tree against
 * it with TYPED refusals - a missing integration surface is
 * MISSING_INTEGRATION_SURFACE naming the exact surface, never a silent
 * pass, and never a widened contract.
 *
 * Verification layers (mirroring the fixture's own hooks):
 *   1. contract shape + file surfaces (browser entry, assets, scripts);
 *   2. build: the deterministic build script runs and emits its manifest;
 *   3. loopback: the REAL server runs on an ephemeral port and every API
 *      surface answers its deterministic expectation over an actual socket,
 *      including the frontend integration fetch contract;
 *   4. smoke: the browser-smoke layer (entry + asset + API + rendered-text
 *      oracle);
 *   5. packaging: the local delivery input is assemblable (no external
 *      deployment).
 *
 * This module runs child processes and real sockets BY DESIGN (it is the
 * product verification boundary); it writes NOTHING into the factory
 * database - verification results enter the kernel as external Input
 * evidence through the driver.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/* The acceptance contract value                                       */
/* ------------------------------------------------------------------ */

export interface AcceptanceApiSurface {
  readonly route: string;
  readonly expect: Record<string, unknown>;
  readonly deterministic?: boolean;
}

export interface ProductAcceptanceContract {
  readonly kind: 'simple-server.acceptance-contract.v1';
  readonly product: string;
  readonly browserEntry: string;
  readonly staticAssets: readonly string[];
  readonly apiSurfaces: readonly AcceptanceApiSurface[];
  readonly bootstrap: { readonly buildCommand: string; readonly buildScript: string; readonly startCommand: string; readonly entrypoint: string };
  readonly integration: { readonly frontendFetches: readonly string[]; readonly rendersInto: string; readonly renderedShape: string };
  readonly verification: { readonly unit: string; readonly loopback: string; readonly browserSmoke: string };
  readonly packaging: { readonly input: string; readonly script: string; readonly externalDeployment: boolean };
}

export type AcceptanceRefusalReason =
  | 'CONTRACT_MALFORMED'
  | 'MISSING_INTEGRATION_SURFACE'
  | 'PRODUCT_BUILD_FAILED'
  | 'PRODUCT_LOOPBACK_FAILED'
  | 'PRODUCT_SMOKE_FAILED'
  | 'PRODUCT_PACKAGING_FAILED';

export interface AcceptanceRefusal {
  readonly refused: true;
  readonly reason: AcceptanceRefusalReason;
  readonly detail: string;
  /** The exact missing/failed surfaces (never a vague failure). */
  readonly surfaces?: readonly string[];
}

export type AcceptanceCheck =
  | { readonly ok: true; readonly verified: readonly string[]; readonly buildDigest?: string; readonly evidenceDigest: string }
  | AcceptanceRefusal;

/* ------------------------------------------------------------------ */
/* Contract loading                                                    */
/* ------------------------------------------------------------------ */

export function loadAcceptanceContract(root: string): { readonly contract: ProductAcceptanceContract } | AcceptanceRefusal {
  const path = join(root, 'acceptance-contract.json');
  if (!existsSync(path)) {
    return { refused: true, reason: 'CONTRACT_MALFORMED', detail: `no acceptance contract at ${path}` };
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProductAcceptanceContract>;
  const required: readonly (keyof ProductAcceptanceContract)[] = [
    'kind', 'product', 'browserEntry', 'staticAssets', 'apiSurfaces', 'bootstrap', 'integration', 'verification', 'packaging',
  ];
  const missing = required.filter((key) => value[key] === undefined);
  if (value.kind !== 'simple-server.acceptance-contract.v1' || missing.length > 0) {
    return { refused: true, reason: 'CONTRACT_MALFORMED', detail: `acceptance contract is malformed (missing: ${missing.join(', ')})` };
  }
  return { contract: value as ProductAcceptanceContract };
}

/* ------------------------------------------------------------------ */
/* Surface presence (the missing-integration-surface fence)            */
/* ------------------------------------------------------------------ */

/** Every file surface the contract owns must exist; list the missing ones. */
export function missingIntegrationSurfaces(root: string, contract: ProductAcceptanceContract): readonly string[] {
  const surfaces = [
    contract.browserEntry,
    ...contract.staticAssets,
    contract.bootstrap.entrypoint,
    contract.bootstrap.buildScript,
    contract.verification.unit,
    contract.verification.loopback,
    contract.verification.browserSmoke,
    contract.packaging.script,
  ];
  return surfaces.filter((surface) => !existsSync(join(root, surface)));
}

/* ------------------------------------------------------------------ */
/* Build / verify / smoke / package execution (real child processes)   */
/* ------------------------------------------------------------------ */

function runNodeScript(root: string, script: string, args: readonly string[] = []): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Start the REAL server on an ephemeral port; returns the base URL + stop(). */
async function startServer(root: string, contract: ProductAcceptanceContract): Promise<{ readonly base: string; readonly stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [join(root, contract.bootstrap.entrypoint), '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const WAIT_BUDGET_MS = 10_000;
  const outcome = await new Promise<number | Error>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: number | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`PRODUCT_LOOPBACK_FAILED: server never reported its port within ${WAIT_BUDGET_MS}ms (stderr so far: ${stderr.trim() || '(none)'})`));
    }, WAIT_BUDGET_MS);
    // ONE persistent stdout handler: the port line may span pipe chunks under
    // load, so the regex scans the whole buffer (a per-chunk match could parse
    // a truncated port number), and no once-listeners accumulate per poll.
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /listening on (\d+)/.exec(stdout);
      if (match !== null) finish(Number.parseInt(match[1], 10));
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(new Error(`PRODUCT_LOOPBACK_FAILED: server spawn failed: ${String(error)}`)));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`PRODUCT_LOOPBACK_FAILED: server exited with code ${code ?? 'null'} before reporting its port (stderr: ${stderr.trim() || '(none)'})`));
    });
  });
  if (outcome instanceof Error) {
    throw outcome;
  }
  return {
    base: `http://127.0.0.1:${outcome}`,
    stop: async () => {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

/* ------------------------------------------------------------------ */
/* The full acceptance check                                           */
/* ------------------------------------------------------------------ */

export interface AcceptanceCheckOptions {
  /** Skip child-process layers (used by fast structural assertions). */
  readonly surfacesOnly?: boolean;
}

export async function checkProductAcceptance(root: string, options: AcceptanceCheckOptions = {}): Promise<AcceptanceCheck> {
  const loaded = loadAcceptanceContract(root);
  if ('refused' in loaded) {
    return loaded;
  }
  const contract = loaded.contract;

  // 1. File surfaces.
  const missing = missingIntegrationSurfaces(root, contract);
  if (missing.length > 0) {
    return { refused: true, reason: 'MISSING_INTEGRATION_SURFACE', detail: `integration surfaces absent from the product tree: ${missing.join(', ')}`, surfaces: missing };
  }
  if (options.surfacesOnly) {
    return { ok: true, verified: ['surfaces'], evidenceDigest: digestOf(root, ['surfaces']) };
  }

  // 2. Build (deterministic manifest).
  const build = await runNodeScript(root, contract.bootstrap.buildScript);
  if (build.code !== 0) {
    return { refused: true, reason: 'PRODUCT_BUILD_FAILED', detail: `build failed (${build.code}): ${build.stderr.trim()}` };
  }
  const buildDigestMatch = /build: ([0-9a-f]{64})/.exec(build.stdout.trim());
  const buildDigest = buildDigestMatch === null ? undefined : buildDigestMatch[1];

  // 3. Loopback over the real server.
  const loopback = await runNodeScript(root, contract.verification.loopback);
  if (loopback.code !== 0) {
    return { refused: true, reason: 'PRODUCT_LOOPBACK_FAILED', detail: `loopback verification failed: ${(loopback.stderr.trim() || loopback.stdout.trim())}` };
  }
  // Cross-check the deterministic API surfaces directly over the socket.
  let live: { base: string; stop: () => Promise<void> };
  try {
    live = await startServer(root, contract);
  } catch (error) {
    return { refused: true, reason: 'PRODUCT_LOOPBACK_FAILED', detail: (error as Error).message };
  }
  try {
    for (const surface of contract.apiSurfaces) {
      const response = await fetch(`${live.base}${surface.route}`);
      const payload = await response.json();
      if (response.status !== 200 || JSON.stringify(payload) !== JSON.stringify(surface.expect)) {
        return { refused: true, reason: 'PRODUCT_LOOPBACK_FAILED', detail: `${surface.route} answered ${response.status} ${JSON.stringify(payload)} (expected ${JSON.stringify(surface.expect)})`, surfaces: [surface.route] };
      }
    }
    const html = await (await fetch(`${live.base}/`)).text();
    const js = await (await fetch(live.base + (contract.staticAssets[0] ?? '/app.js').replace('public', ''))).text();
    if (!html.includes(`src="/${contract.staticAssets[0]?.replace('public/', '') ?? 'app.js'}"`) || !js.includes(String(contract.integration.frontendFetches[0]))) {
      return { refused: true, reason: 'MISSING_INTEGRATION_SURFACE', detail: 'the browser entry/asset integration (frontend fetch of the API) is absent', surfaces: [contract.browserEntry, contract.staticAssets[0] ?? ''] };
    }
  } finally {
    await live.stop();
  }

  // 4. Browser smoke layer.
  const smoke = await runNodeScript(root, contract.verification.browserSmoke);
  if (smoke.code !== 0) {
    return { refused: true, reason: 'PRODUCT_SMOKE_FAILED', detail: `browser smoke failed: ${(smoke.stderr.trim() || smoke.stdout.trim())}` };
  }

  // 5. Local packaging input.
  const packaging = await runNodeScript(root, contract.packaging.script);
  if (packaging.code !== 0) {
    return { refused: true, reason: 'PRODUCT_PACKAGING_FAILED', detail: `local packaging failed: ${packaging.stderr.trim()}` };
  }

  const verified = ['surfaces', 'build', 'loopback', 'smoke', 'packaging'];
  return {
    ok: true,
    verified,
    ...(buildDigest !== undefined ? { buildDigest } : {}),
    evidenceDigest: digestOf(root, verified, buildDigest),
  };
}

function digestOf(root: string, verified: readonly string[], buildDigest?: string): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify({ root, verified, buildDigest }), 'utf8').digest('hex');
}
