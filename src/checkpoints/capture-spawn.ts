/**
 * Antifreeze layer B4 — parent side of the one-shot capture child
 * (src/checkpoints/capture-cli.ts).
 *
 * TB-2 same-process deadlock class (docs/testing/WORKSHOP-BUGS.md): the
 * checkpoint capture opens its OWN SQLite connection. Run in-process (the
 * engine's post-cycle capture path), that connection and the engine's main
 * connection contend on ONE event loop — under a write-lock collision each
 * side busy-spins synchronously and the lock releaser (a timer of this very
 * process) can never run. Layer B3 bounded every spin slice; this module
 * removes the class STRUCTURALLY: the capture connection only ever exists
 * in a disposable child process. If the child wedges on a lock, the parent
 * kills it after a hard timeout — the engine cycle loses one checkpoint
 * (already non-fatal) instead of freezing.
 *
 * Spawn contract:
 *   - executable: process.execPath, script: sibling capture-cli.js in dist
 *   - env inherited (all SAGA_* flow through); the HMAC key travels via the
 *     dedicated SAGA_CAPTURE_HMAC_KEY env var, NEVER argv (process listings)
 *   - stdio 'ignore' — no pipes at all, so neither side can block on the
 *     other's draining (the layer-A stdout-backpressure lesson)
 *   - hard timeout (default 120s, SAGA_CHECKPOINT_CHILD_TIMEOUT_MS): on
 *     expiry the child is SIGKILLed and the capture resolves as an error
 *   - success is reported via the store's `latest-<project>-<epic>` pointer
 *     file — no stdout parsing, no pipes, a plain file read
 *
 * SAGA_CHECKPOINT_CHILD=0 restores the legacy in-process path (tests,
 * debugging) through the SAME entry point the engine uses.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CaptureCheckpointOptions,
  FactoryCheckpointManifest,
} from './factory-checkpoint-service.js';

export const DEFAULT_CAPTURE_CHILD_TIMEOUT_MS = 120_000;

/** Test seams: override the child executable/script and the kill timeout. */
export interface CaptureChildConfig {
  readonly executable?: string;
  readonly script?: string;
  readonly timeoutMs?: number;
}

export interface ChildCaptureResult {
  /** Checkpoint ref from the store pointer; null only if unreadable. */
  readonly checkpointRef: string | null;
}

function defaultChildScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'capture-cli.js');
}

function envTimeoutMs(): number | null {
  const raw = Number(process.env.SAGA_CHECKPOINT_CHILD_TIMEOUT_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

function readLatestCheckpointRef(
  storageRoot: string,
  projectId: number,
  epicId: number | null,
): string | null {
  try {
    return readFileSync(
      path.join(storageRoot, `latest-${projectId}-${epicId ?? 'all'}`),
      'utf8',
    ).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run ONE checkpoint capture in a one-shot child process and await its exit.
 * Rejects on spawn failure, non-zero exit code, signal death, or timeout —
 * the caller (engine cycle) already treats capture failure as non-fatal.
 */
export function captureCheckpointViaChild(
  options: CaptureCheckpointOptions,
  config: CaptureChildConfig = {},
): Promise<ChildCaptureResult> {
  const executable = config.executable ?? process.execPath;
  const script = config.script ?? defaultChildScript();
  const timeoutMs = config.timeoutMs ?? envTimeoutMs() ?? DEFAULT_CAPTURE_CHILD_TIMEOUT_MS;
  const args = [
    script,
    '--db', options.dbPath,
    '--store', options.storageRoot,
    '--project', String(options.projectId),
  ];
  if (options.epicId !== undefined && options.epicId !== null) {
    args.push('--epic', String(options.epicId));
  }
  if (options.createdBy) {
    args.push('--created-by', options.createdBy);
  }
  if (options.includeLogs === true) {
    args.push('--include-logs');
  }
  if (options.signatureKeyId) {
    args.push('--signature-key-id', options.signatureKeyId);
  }
  // Inherit the full environment (SAGA_* must flow); the HMAC key travels
  // through a dedicated env var so it never appears in a process listing.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.hmacKey) {
    env.SAGA_CAPTURE_HMAC_KEY = options.hmacKey;
    if (options.signatureKeyId) {
      env.SAGA_CAPTURE_SIGNATURE_KEY_ID = options.signatureKeyId;
    }
  }

  return new Promise<ChildCaptureResult>((resolve, reject) => {
    // stdio 'ignore': the antifreeze rule — no pipe the child (or a frozen
    // parent loop) could ever block on. windowsHide keeps consoles clean.
    const child = spawn(executable, args, { stdio: 'ignore', env, windowsHide: true });
    let timedOut = false;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Hard kill: the child is disposable by design. On win32 this maps to
      // TerminateProcess; the 'exit' event below settles the promise.
      child.kill('SIGKILL');
      // Safety net if the signal is somehow delayed: never wait forever.
      setTimeout(() => finish(() => reject(new Error(
        `CHECKPOINT_CHILD_TIMEOUT: child did not exit ${timeoutMs}ms after kill`,
      ))), 10_000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      finish(() => reject(new Error(`CHECKPOINT_CHILD_SPAWN_FAILED: ${error.message}`)));
    });
    child.on('exit', (code, signal) => {
      if (timedOut) {
        finish(() => reject(new Error(
          `CHECKPOINT_CHILD_TIMEOUT: capture child killed after ${timeoutMs}ms`,
        )));
        return;
      }
      if (signal !== null) {
        finish(() => reject(new Error(`CHECKPOINT_CHILD_KILLED: signal ${signal}`)));
        return;
      }
      if (code !== 0) {
        finish(() => reject(new Error(`CHECKPOINT_CHILD_FAILED: exit code ${code}`)));
        return;
      }
      finish(() => resolve({
        checkpointRef: readLatestCheckpointRef(
          options.storageRoot,
          options.projectId,
          options.epicId ?? null,
        ),
      }));
    });
  });
}

export interface IsolatedCaptureOutcome {
  readonly checkpointRef: string;
  /** 'child' = one-shot process (default), 'in-process' = SAGA_CHECKPOINT_CHILD=0. */
  readonly mode: 'child' | 'in-process';
  /** Present only on the in-process path (the child path has no manifest object). */
  readonly manifest?: FactoryCheckpointManifest;
}

/**
 * The single capture entry point for production callers. Default: one-shot
 * child process (layer B4). SAGA_CHECKPOINT_CHILD=0 → legacy in-process
 * capture through the SAME service, for tests and debugging.
 */
export async function captureCheckpointIsolated(
  options: CaptureCheckpointOptions,
  config: CaptureChildConfig = {},
): Promise<IsolatedCaptureOutcome> {
  if (process.env.SAGA_CHECKPOINT_CHILD === '0') {
    const { FactoryCheckpointService } = await import('./factory-checkpoint-service.js');
    const manifest = await new FactoryCheckpointService().capture(options);
    return { checkpointRef: manifest.payload.checkpointRef, mode: 'in-process', manifest };
  }
  const result = await captureCheckpointViaChild(options, config);
  return {
    checkpointRef: result.checkpointRef ?? '(published; ref unavailable — see store manifests)',
    mode: 'child',
  };
}
