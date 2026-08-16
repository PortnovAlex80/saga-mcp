#!/usr/bin/env node
/**
 * Antifreeze layer B4 — ONE-SHOT checkpoint capture child process.
 *
 * WHY THIS EXISTS: FactoryCheckpointService.capture opens its OWN SQLite
 * connection. When capture runs INSIDE the engine process (orchestrate-cli
 * calls it after every cycle), that connection contends with the engine's
 * main connection ON THE SAME EVENT LOOP. Under a write-lock collision both
 * sides busy-spin synchronously; neither process-level retry can help
 * because the lock releaser (a timer/callback of this very process) can
 * never run — that is the TB-2 same-process deadlock class. Layer B3 only
 * BOUNDED each spin slice; this runner makes the class structurally
 * impossible: the capture connection lives in a disposable child process,
 * so the engine's event loop is never a party to the capture's lock waits.
 *
 * Contract (one-shot, no hang guarantees):
 *   node capture-cli.js --db <path> --store <root> --project <id>
 *                       [--epic <id>] [--reason <text>] [--created-by <text>]
 *                       [--hmac-key <key>] [--signature-key-id <id>]
 *                       [--include-logs]
 *
 *   success → ONE stdout line (JSON with the manifest digest) + exit 0
 *   failure → message on stderr + exit 1
 *   watchdog overrun (async hang, lingering handle) → stderr + exit 3
 *
 * The parent (capture-spawn.ts) spawns this script with stdio 'ignore' and
 * its own 120s kill timer — the watchdog here is defense-in-depth for
 * manual/CLI use. Every db handle is opened and closed INSIDE
 * FactoryCheckpointService.capture (finally blocks); this runner holds no
 * handles of its own and exits explicitly, so nothing can keep it alive.
 */

import path from 'node:path';
import { FactoryCheckpointService } from './factory-checkpoint-service.js';

/** Hard ceiling for the whole run; override with SAGA_CHECKPOINT_CHILD_TIMEOUT_MS. */
const DEFAULT_WATCHDOG_MS = 120_000;

interface ParsedFlags {
  readonly flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedFlags {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      throw new Error(`CHECKPOINT_CHILD_ARGUMENT_INVALID: unexpected argument '${token}'`);
    }
    const separator = token.indexOf('=');
    if (separator !== -1) {
      flags.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
      continue;
    }
    flags.set(name, true);
  }
  return { flags };
}

function requiredString({ flags }: ParsedFlags, name: string, envFallback?: string): string {
  const value = flags.get(name);
  const raw = typeof value === 'string' && value.trim()
    ? value.trim()
    : envFallback ? process.env[envFallback] : undefined;
  if (!raw) {
    throw new Error(`CHECKPOINT_CHILD_ARGUMENT_INVALID: --${name} is required`);
  }
  return raw;
}

function positiveId({ flags }: ParsedFlags, name: string, options: {
  required: true,
}): number;
function positiveId({ flags }: ParsedFlags, name: string, options: {
  required: false,
}): number | null;
function positiveId({ flags }: ParsedFlags, name: string, { required }: { required: boolean }):
  number | null {
  const value = flags.get(name);
  if ((value === undefined || value === true) && !required) return null;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`CHECKPOINT_CHILD_ARGUMENT_INVALID: --${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Resolve the HMAC key. Precedence: explicit flag (manual use), then the
 * dedicated parent→child env channel, then the shared-shell/env conventions
 * already used by checkpoint-cli.ts and the engine. Returns the key AND its
 * default signatureKeyId so manifest continuity is preserved when the key
 * arrives via env (the engine used 'env:SAGA_FACTORY_CHECKPOINT_HMAC_KEY').
 */
function resolveHmac({ flags }: ParsedFlags): { hmacKey: string; signatureKeyId: string | null } {
  const flagKey = flags.get('hmac-key');
  if (typeof flagKey === 'string' && flagKey) {
    return { hmacKey: flagKey, signatureKeyId: null };
  }
  const viaParent = process.env.SAGA_CAPTURE_HMAC_KEY;
  if (viaParent) {
    return {
      hmacKey: viaParent,
      signatureKeyId: process.env.SAGA_CAPTURE_SIGNATURE_KEY_ID ?? null,
    };
  }
  const sharedShell = process.env.SAGA_CHECKPOINT_HMAC_KEY;
  if (sharedShell) {
    return { hmacKey: sharedShell, signatureKeyId: 'env:SAGA_CHECKPOINT_HMAC_KEY' };
  }
  const engineKey = process.env.SAGA_FACTORY_CHECKPOINT_HMAC_KEY;
  if (engineKey) {
    return { hmacKey: engineKey, signatureKeyId: 'env:SAGA_FACTORY_CHECKPOINT_HMAC_KEY' };
  }
  return { hmacKey: '', signatureKeyId: null };
}

function signatureKeyIdFromFlag({ flags }: ParsedFlags): string | null {
  const value = flags.get('signature-key-id');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function watchdogMs(): number {
  const raw = Number(process.env.SAGA_CHECKPOINT_CHILD_TIMEOUT_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_WATCHDOG_MS;
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const limit = watchdogMs();
  // Defense-in-depth: a one-shot child must never hang. If capture stalls on
  // an async wait (db.backup) or a stray handle keeps the loop alive, force
  // an exit with a DISTINCT code (3) so the cause is greppable. Sync hangs
  // are the parent's kill-timer responsibility (see capture-spawn.ts).
  const watchdog = setTimeout(() => {
    process.stderr.write(`CHECKPOINT_CHILD_TIMEOUT: no result within ${limit}ms\n`);
    process.exit(3);
  }, limit);
  watchdog.unref();
  try {
    const hmac = resolveHmac(parsed);
    const createdByBase = (() => {
      const value = parsed.flags.get('created-by');
      return typeof value === 'string' && value.trim() ? value.trim() : 'capture-cli';
    })();
    const reason = parsed.flags.get('reason');
    // CaptureCheckpointOptions has no `reason` field; operator context is
    // folded into createdBy so nothing the caller passed is lost.
    const createdBy = typeof reason === 'string' && reason.trim()
      ? `${createdByBase} (${reason.trim()})`
      : createdByBase;
    const manifest = await new FactoryCheckpointService().capture({
      dbPath: path.resolve(requiredString(parsed, 'db', 'DB_PATH')),
      storageRoot: path.resolve(requiredString(parsed, 'store')),
      projectId: positiveId(parsed, 'project', { required: true })!,
      epicId: positiveId(parsed, 'epic', { required: false }),
      createdBy,
      includeLogs: parsed.flags.get('include-logs') === true,
      ...(hmac.hmacKey
        ? {
            hmacKey: hmac.hmacKey,
            // Explicit --signature-key-id wins; else the env channel's id;
            // else the service defaults to 'local'.
            ...(signatureKeyIdFromFlag(parsed) ?? hmac.signatureKeyId
              ? { signatureKeyId: signatureKeyIdFromFlag(parsed) ?? hmac.signatureKeyId! }
              : {}),
          }
        : {}),
    });
    // ONE stdout line — the manifest digest line of the capture contract.
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        checkpoint: manifest.payload.checkpointRef,
        digest: manifest.digest,
      })}\n`,
    );
  } finally {
    clearTimeout(watchdog);
  }
}

process.on('uncaughtException', (error) => {
  // A one-shot child exits on any surprise instead of leaking a zombie.
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});

run().then(
  () => {
    process.exit(0);
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
