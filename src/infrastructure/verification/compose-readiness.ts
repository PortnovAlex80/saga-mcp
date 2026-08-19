import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import {
  commandFailureDetail,
  ReadinessExecutionError,
} from './readiness-executor.js';

/**
 * SEAM-ARCHITECT Layer 2 (a) — docker compose verification of the assembled
 * whole. The COMPOSITION of steps is the provider's; WHERE they run is the
 * runner's concern (mirroring the ReadinessExecutor substrate seam): the
 * default {@link CliComposeRunner} shells out to the docker compose CLI, and
 * tests inject a fake — the probe mechanics are testable without docker.
 *
 * Modes (SAGA_LOCAL_RUNNABILITY_COMPOSE):
 *   - 'up' (default): config validation, then `up --wait` under a bounded
 *     timeout, then `down`. The full integration proof.
 *   - 'config': config validation only — the mandatory minimum. Compose files
 *     are still validated structurally wherever a declaration is present.
 *
 * Fail-closed policy: a declared compose whose runner is unavailable throws
 * LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE (ReadinessExecutionError → outcome
 * 'failed', NOT 'error') — the profile declared a compose substrate, so the
 * provider refuses to silently skip it.
 */

/** Which compose steps this verification run executes. */
export type ComposeMode = 'config' | 'up';

export const DEFAULT_COMPOSE_UP_TIMEOUT_MS = 180_000;
const COMPOSE_DOWN_TIMEOUT_MS = 60_000;
const COMPOSE_CONFIG_TIMEOUT_MS = 60_000;

export interface ComposeDeclaration {
  /** Compose file path relative to the candidate root (validated). */
  readonly file: string;
  /** Optional `docker compose -p` project name. */
  readonly projectName?: string;
}

/** One typed compose step result — never a boolean. */
export interface ComposeStepResult {
  readonly step: 'compose-config' | 'compose-up';
  readonly status: 'passed' | 'failed';
  /** Failure detail (stderr tail) — present on failure. */
  readonly detail?: string;
}

/**
 * The injectable compose substrate. All methods synchronous (the gate-run
 * driver rejects async providers). `down` is best-effort cleanup and returns
 * nothing — a failed down after a passed verification must not mask the
 * result; a failed down after a FAILED up is recorded by the caller from the
 * up result.
 */
export interface ComposeRunner {
  /** `docker compose -f <file> config --quiet` — structural validation. */
  configValidate(directory: string, declaration: ComposeDeclaration): ComposeStepResult;
  /** Start the declared composition and wait for health, bounded by timeoutMs. */
  up(
    directory: string,
    declaration: ComposeDeclaration,
    timeoutMs: number,
  ): ComposeStepResult;
  /** Stop and remove the composition (best-effort, always runs after up). */
  down(directory: string, declaration: ComposeDeclaration): void;
}

/** Validate a typed compose declaration from a frozen readiness profile. */
export function validateComposeDeclaration(raw: unknown): ComposeDeclaration | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as { file?: unknown; projectName?: unknown };
  if (typeof value.file !== 'string' || value.file.trim() === '') return null;
  const file = value.file.trim();
  // The compose file must live INSIDE the extracted candidate tree: reject
  // absolute paths and any `..` segment (traversal out of the sealed tree).
  if (isAbsolute(file) || file.split(/[\\/]/u).includes('..')) return null;
  if (value.projectName !== undefined
    && (typeof value.projectName !== 'string' || value.projectName.trim() === '')) {
    return null;
  }
  return {
    file,
    ...(value.projectName !== undefined
      ? { projectName: (value.projectName as string).trim() }
      : {}),
  };
}

/** Read the compose mode from the environment ('up' by default, 'config' opt-down). */
export function composeModeFromEnvironment(): ComposeMode {
  const raw = (process.env.SAGA_LOCAL_RUNNABILITY_COMPOSE ?? 'up').toLowerCase();
  return raw === 'config' ? 'config' : 'up';
}

function composeArgs(
  declaration: ComposeDeclaration,
  command: string,
): string[] {
  return [
    ...(declaration.projectName !== undefined
      ? ['-p', declaration.projectName]
      : []),
    '-f', join('.', declaration.file),
    command,
  ];
}

/** Default CLI substrate — `docker compose` exactly the way a human runs it. */
export class CliComposeRunner implements ComposeRunner {
  configValidate(
    directory: string,
    declaration: ComposeDeclaration,
  ): ComposeStepResult {
    try {
      execFileSync('docker', [
        'compose', ...composeArgs(declaration, 'config'), '--quiet',
      ], {
        cwd: directory,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: COMPOSE_CONFIG_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { step: 'compose-config', status: 'passed' };
    } catch (error) {
      const detail = commandFailureDetail(
        `docker compose -f ${declaration.file}`,
        ['config'],
        error,
      );
      // ENOENT / not-installed CLI is a SUBSTRATE failure (fail closed with a
      // typed code); a non-zero config exit is a candidate defect.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ReadinessExecutionError(
          'LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE',
          'compose is declared but the docker compose CLI is unavailable: ' + detail,
        );
      }
      return { step: 'compose-config', status: 'failed', detail };
    }
  }

  up(
    directory: string,
    declaration: ComposeDeclaration,
    timeoutMs: number,
  ): ComposeStepResult {
    try {
      execFileSync('docker', [
        'compose', ...composeArgs(declaration, 'up'),
        '-d', '--wait', '--timeout', String(Math.ceil(timeoutMs / 1000)),
      ], {
        cwd: directory,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { step: 'compose-up', status: 'passed' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ReadinessExecutionError(
          'LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE',
          'compose is declared but the docker compose CLI is unavailable: '
            + commandFailureDetail('docker compose', ['up'], error),
        );
      }
      return {
        step: 'compose-up',
        status: 'failed',
        detail: commandFailureDetail(
          `docker compose -f ${declaration.file}`,
          ['up -d --wait'],
          error,
        ),
      };
    }
  }

  down(directory: string, declaration: ComposeDeclaration): void {
    try {
      execFileSync('docker', [
        'compose', ...composeArgs(declaration, 'down'),
        '--timeout', '30',
      ], {
        cwd: directory,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: COMPOSE_DOWN_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // Best-effort cleanup: a failed down must not mask the real result.
    }
  }
}
