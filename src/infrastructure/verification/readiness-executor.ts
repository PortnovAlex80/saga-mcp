/**
 * The executor seam for the local-runnability check provider (Phase-1
 * dockerization).
 *
 * The provider proves the exact sealed product runnable by running its
 * profile-stated install/test/serve commands. WHERE those commands execute —
 * on the host or inside a worker-declared Docker image — is the executor's
 * concern. This interface decouples the COMMAND AUTHORITY (the frozen readiness
 * profile) from the SUBSTRATE (host vs docker), so the provider's flow is
 * identical for both:
 *
 *   1. extract the sealed git tree
 *   2. validate the readiness profile
 *   3. select an executor (host by default; docker when the profile declares
 *      environment.image and docker is available)
 *   4. executor.runCommand(install?) → executor.runCommand(test) → optionally
 *      executor.runServed(start) → executor.dispose()
 *
 * Both executors are SYNCHRONOUS (the gate-run-driver rejects async providers).
 * The host executor preserves the exact pre-Phase-1 behavior (npm/node routing,
 * JVM env selection, ./ stripping, detached process tree kill). The docker
 * executor runs commands via `docker run` against a named volume populated from
 * the git archive tar.
 */

/**
 * Substrate identity for evidence. `substrate` and `image` are additive fields
 * in the readiness observation — they are part of the evidence digest at no
 * extra cost, so a host-passed and a docker-passed result for the same candidate
 * produce distinct (correct) digests.
 */
export interface ExecutorDescription {
  readonly substrate: 'host' | 'docker';
  /** Docker image reference, present only for the docker substrate. */
  readonly image?: string;
  /**
   * Host build-system detection (gradle/maven/npm/null). Present only for the
   * host substrate where it informed JVM env selection; meaningless under
   * docker (the image IS the environment).
   */
  readonly detectedBuildSystem?: 'gradle' | 'maven' | 'npm' | null;
}

/**
 * Evidence captured from a served probe. The port is always present;
 * substrate-specific fields (pid for host, containerName for docker) are
 * optional. stdout/stderr digests are best-effort captured output for evidence.
 */
export interface ServeEvidence {
  readonly port: number;
  /** OS pid of the detached serve process (host only). */
  readonly pid?: number;
  /** Docker container name (docker only). */
  readonly containerName?: string;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
}

/**
 * The execution substrate for one readiness check. All methods are synchronous.
 *
 * Lifecycle: the provider calls runCommand (0..N), then optionally runServed,
 * then dispose() exactly once in a finally block. The docker executor lazily
 * prepares its volume on the first runCommand/runServed call; the host executor
 * is stateless.
 */
export interface ReadinessExecutor {
  /**
   * Run one profile-stated contract command (install or test). Throws on
   * non-zero exit or timeout with a readable detail (stderr/stdout tail) so the
   * provider records a decodable 'failed' diagnostic.
   */
  runCommand(command: string, timeoutMs: number): void;
  /**
   * Start the served command, probe loopback until it answers, then shut it
   * down. Throws on any lifecycle failure (process exited, probe timeout,
   * termination failure). The caller records the returned evidence in the
   * passed observation.
   */
  runServed(startCommand: string, probeTimeoutMs: number, port: number): ServeEvidence;
  /** Substrate identity for the evidence observation. */
  describe(): ExecutorDescription;
  /**
   * Release substrate resources. For docker this removes the named volume; for
   * host it is a no-op. Safe to call once, in the provider's finally block.
   */
  dispose(): void;
}

/**
 * A substrate-level failure that carries a specific diagnostic code (e.g.
 * LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE) so the provider can encode it into a
 * decodable check-diagnostic. Thrown by the docker executor when the substrate
 * itself is the failure (daemon down, pull failed) — distinct from a command
 * failure (non-zero exit), which throws a plain Error with a detail string.
 */
export class ReadinessExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReadinessExecutionError';
    this.code = code;
  }
}

/**
 * Build a readable failure detail from a child-process error, preserving the
 * command's stderr/stdout (compiler errors, test failures) so the verifier's
 * recovery-feedback actually tells the worker WHAT broke — not just that it did.
 * Shared between the host executor (npm/node routing failures) and the docker
 * executor (docker run failures) so the diagnostic format is identical.
 */
export function commandFailureDetail(
  executable: string,
  args: readonly string[],
  error: unknown,
): string {
  const e = error as { stdout?: unknown; stderr?: unknown; message?: string; code?: unknown };
  const cmd = `${executable} ${(args || []).join(' ')}`.trim();
  // execFileSync returns stdout/stderr as Buffers unless encoding is set —
  // decode both shapes so compiler/test output never silently disappears.
  const asText = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v)) return v.toString('utf-8');
    return '';
  };
  const stderr = asText(e.stderr);
  const stdout = asText(e.stdout);
  const tail = (s: string): string => s.slice(-3000);
  const timedOut = e.code === 'ETIMEDOUT';
  const parts = [
    timedOut ? `command timed out (${cmd})` : `command failed (${cmd})`,
    stderr ? `--- stderr ---\n${tail(stderr)}` : '',
    !stderr && stdout ? `--- stdout ---\n${tail(stdout)}` : '',
  ].filter(Boolean);
  const detail = parts.join('\n');
  return detail || (e.message ?? 'command failed');
}
