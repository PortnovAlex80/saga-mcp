/**
 * workflow-kernel/composition/opencode-channel.ts - the REAL production
 * provider channel of the WP-18 instrumented transport (EK-8, WP-12).
 *
 * This is the channel the pre-cutover runtime never had: every byte that
 * reaches a provider model passes the WP-18 accountant first (admission at
 * the EXACT pre-send boundary inside createAdmittingTransport), and the
 * channel itself only ever receives the ADMITTED, SERIALIZED envelope -
 * there is no opaque `opencode run` loop around it and no unaccounted
 * fallback path.
 *
 * The process boundary: the channel spawns the opencode shim
 * (tools/agent-proxy/claude-shim.mjs, the ONLY legal worker transport per
 * the operator directive of 2026-08-20) with the serialized envelope on
 * stdin and the route pin's model on argv. The three operational laws of
 * laws.ts are enforced at this boundary:
 *
 *   - LAW 1 the executor is resolved fail-closed (FACTORY_CLAUDE_BACKEND_
 *     FORBIDDEN; no fallback, no claude CLI, ever);
 *   - LAW 2 the ~/.claude/settings.json tripwire is verified before EVERY
 *     send (a mid-run change aborts the send);
 *   - LAW 3 this channel has no model-switch path at all; the composition
 *     exposes one typed operator command and it is guarded separately.
 *
 * Outcome mapping (D12-faithful):
 *   - exit 0            -> delivered (outcomeDigest = sha256 of stdout)
 *   - nonzero exit      -> thrown -> the transport maps it to channel-error
 *                          (crash window "before send": the SAME obligation
 *                          and ordinal are redriven, admission is not re-run)
 *   - timeout (killed)  -> { status: 'unknown' } -> the transport maps it to
 *                          TypedWait:effect-uncertainty; the operator
 *                          disposition command decides (D12) - an automatic
 *                          duplicate send is structurally blocked upstream.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ProviderChannelResult, ProviderNetworkChannel } from '../context-envelope/transport.js';
import type { ProviderRoutePin } from '../context-envelope/receipt.js';
import {
  ClaudeSettingsTripwire,
  resolveExecutorPath,
  type ResolvedExecutor,
} from './laws.js';

export interface OpenCodeChannelConfig {
  /** Route pin (provider/model/version) the transport was composed with. */
  readonly routePin: ProviderRoutePin;
  /** Spawn env (defaults to process.env; the shim inherits SAGA_* identity). */
  readonly env?: NodeJS.ProcessEnv;
  /** Per-send timeout in ms; a timeout kill maps to the D12 unknown outcome. */
  readonly timeoutMs?: number;
  /** Working directory for the spawned shim (defaults to cwd). */
  readonly cwd?: string;
  /** Explicit executor override (tests/laws wiring); defaults to resolveExecutorPath(). */
  readonly executor?: ResolvedExecutor;
  /**
   * Operator rate limit (2026-08-26 directive: GLM-5.3-flash default, limit 6):
   * AT MOST this many shim processes may be in flight concurrently; further
   * sends QUEUE (FIFO) at this boundary — the provider is never hammered past
   * the plan limit. 0/undefined = unlimited (single-lane drivers).
   */
  readonly maxConcurrentSends?: number;
  /** Spawn observer (diagnostics; one line per spawn). */
  /** Explicit tripwire override; defaults to a tripwire armed at construction. */
  readonly tripwire?: ClaudeSettingsTripwire;
  /** Spawn sink for tests (never used to fake results - only to observe argv). */
  readonly onSpawn?: (info: { readonly command: string; readonly args: readonly string[] }) => void;
}

/**
 * The instrumented opencode channel: the ONLY production implementation of
 * ProviderNetworkChannel. The pre-send admission, the receipt verification
 * and the serialized-bytes law all live in the transport that calls this
 * channel; this module is deliberately thin - resolve laws, spawn, hash.
 */
export class OpenCodeShimChannel implements ProviderNetworkChannel {
  private inFlight = 0;
  private readonly sendQueue: Array<() => void> = [];

  /** Rate-limit gate (FIFO): at most maxConcurrentSends shim processes alive. */
  private async acquireSendSlot(): Promise<void> {
    const cap = this.config.maxConcurrentSends ?? 0;
    if (cap <= 0 || this.inFlight < cap) { this.inFlight++; return; }
    await new Promise<void>(release => this.sendQueue.push(release));
    this.inFlight++;
  }

  private releaseSendSlot(): void {
    this.inFlight--;
    const next = this.sendQueue.shift();
    if (next) next();
  }
  private readonly executor: ResolvedExecutor;
  private readonly tripwire: ClaudeSettingsTripwire;

  constructor(private readonly config: OpenCodeChannelConfig) {
    // LAW 1 at construction: a forbidden executor aborts the composition
    // before any send can exist (fail-closed, no fallback).
    this.executor = config.executor ?? resolveExecutorPath(config.env ?? process.env);
    this.tripwire = config.tripwire ?? new ClaudeSettingsTripwire();
  }

  /** The resolved executor (for logs/diagnostics). */
  get resolvedExecutor(): ResolvedExecutor {
    return this.executor;
  }

  async send(input: {
    readonly serialized: string;
    readonly routePin: ProviderRoutePin;
    readonly maxOutputTokens: number;
  }): Promise<ProviderChannelResult> {
    await this.acquireSendSlot();
    // LAW 2 before every send: the settings tripwire must hold.
    const verify = this.tripwire.verify();
    if (!verify.ok) {
      throw verify.error;
    }
    const args = [...this.executor.args, '-p', '--model', input.routePin.model, `--max-output-tokens=${input.maxOutputTokens}`];
    this.config.onSpawn?.({ command: this.executor.command, args });
    return await new Promise<ProviderChannelResult>((resolve, reject) => {
      const child = spawn(this.executor.command, args, {
        cwd: this.config.cwd,
        env: this.config.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutMs = this.config.timeoutMs ?? 0;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            // The process was killed mid-flight: the provider may or may not
            // have completed the send. D12: unknown outcome, operator
            // disposition command decides - never an automatic duplicate.
            resolve({ status: 'unknown' });
          }, timeoutMs)
        : undefined;
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(new Error(`OPENCODE_CHANNEL_SPAWN_FAILED: ${error.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        this.releaseSendSlot();
        if (timer !== undefined) clearTimeout(timer);
        if (code === 0) {
          resolve({ status: 'delivered', outcomeDigest: 'sha256:' + createHash('sha256').update(stdout, 'utf8').digest('hex') });
          return;
        }
        // Crash-window class "before send" from the transport's point of
        // view: the same obligation + ordinal are redriven; admission is
        // NOT re-run; nothing is re-charged.
        reject(new Error(`OPENCODE_CHANNEL_EXIT_${code}: ${stderr.slice(0, 400)}`));
      });
      // The claude -p stdin-prompt contract: the EXACT admitted serialized
      // envelope is the prompt. Nothing else is appended (the accountant
      // counted these bytes and only these bytes).
      child.stdin.on('error', () => { /* closed early: the exit path handles it */ });
      child.stdin.end(input.serialized, 'utf8');
    });
  }
}
