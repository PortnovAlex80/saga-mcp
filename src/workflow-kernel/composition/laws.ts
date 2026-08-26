/**
 * workflow-kernel/composition/laws.ts - the OPERATIONAL LAW of the
 * production cognition transport (EK-8, WP-12).
 *
 * These laws are NOT legacy to delete: they are carried forward from the
 * operator directive of 2026-08-20 (AGENTS.md "OPENCODE ONLY") and the
 * pre-cutover tracker-view/claude-runner.mjs enforcement, which the
 * LEGACY-DELETION-MANIFEST §H names explicitly:
 *
 *   "the claude-CLI prohibition with fail-closed executor resolution
 *    (tracker-view/claude-runner.mjs) and the ~/.claude/settings.json
 *    sha256 tripwire + SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS (AGENTS.md
 *    directive) - carried into the WP-18 transport and the EK-10 runbook."
 *
 * Re-implemented here because their old host file died with the EK-8
 * cutover. The wording of the forbidden-executor patterns and the
 * fail-closed error are preserved deliberately: operators match these
 * strings against their runbooks.
 *
 *   LAW 1 (claude-CLI prohibition): every executor resolution path that
 *     resolves to the claude CLI (the bare `claude` default, a claude
 *     binary path, the VS Code extension binary) ABORTS the spawn with
 *     FACTORY_CLAUDE_BACKEND_FORBIDDEN. There is NO silent fallback:
 *     forgetting the env makes the first worker fail loudly instead of
 *     billing Anthropic.
 *
 *   LAW 2 (settings.json tripwire): ~/.claude/settings.json is not ours.
 *     Its sha256 is captured when the composition arms and re-verified
 *     before every channel send; a change mid-run is an ABORT condition -
 *     investigate, never edit it back.
 *
 *   LAW 3 (SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS): no code path of this
 *     runtime may rewrite ~/.claude/settings.json. The operator model-set
 *     command refuses unless SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS is set
 *     in the environment (the env is the operator's promise, checked at
 *     use, never written by us).
 *
 * PURITY: node builtins only. No provider SDK, no spawn here (the channel
 * in opencode-channel.ts composes these laws with the process boundary).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The env var that pins the ONLY legal worker transport (the opencode shim). */
export const SAGA_REAL_CLAUDE_PATH_ENV = 'SAGA_REAL_CLAUDE_PATH';

/** The secondary spelling the legacy runner also accepted. */
export const SAGA_CLAUDE_PATH_ENV = 'SAGA_CLAUDE_PATH';

/** The env var that must be set before any model-switch command runs. */
export const SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS_ENV = 'SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS';

/** The typed fail-closed refusal of LAW 1. */
export class FactoryClaudeBackendForbiddenError extends Error {
  readonly code = 'FACTORY_CLAUDE_BACKEND_FORBIDDEN';
  readonly resolvedExecutor: string;

  constructor(resolvedExecutor: string) {
    super(
      'FACTORY_CLAUDE_BACKEND_FORBIDDEN: the factory moved to opencode '
        + '(tools/agent-proxy/claude-shim.mjs on the official Z.AI Coding Plan '
        + 'provider). Spawning the claude CLI is forbidden — claude became too '
        + `expensive. Resolved executor: '${resolvedExecutor}'. Set `
        + `${SAGA_REAL_CLAUDE_PATH_ENV}="node <repo>/tools/agent-proxy/claude-shim.mjs" `
        + '(and SAGA_CLAUDE_PATH to the same value) before starting the factory.',
    );
    this.name = 'FactoryClaudeBackendForbiddenError';
    this.resolvedExecutor = resolvedExecutor;
  }
}

/** The typed ABORT of LAW 2 (the tripwire fired mid-run). */
export class ClaudeSettingsTripwireAbortedError extends Error {
  readonly code = 'FACTORY_CLAUDE_SETTINGS_TRIPWIRE_ABORT';
  readonly before: string;
  readonly after: string;

  constructor(before: string, after: string) {
    super(
      'FACTORY_CLAUDE_SETTINGS_TRIPWIRE_ABORT: ~/.claude/settings.json changed '
        + `during the run (sha256 ${before.slice(0, 16)}… -> ${after.slice(0, 16)}…). `
        + 'That file is not ours; a mid-run change is an ABORT condition. Investigate, '
        + 'never edit it back. (AGENTS.md operator directive, carried into the '
        + 'WP-18 transport by LEGACY-DELETION-MANIFEST §H.)',
    );
    this.name = 'ClaudeSettingsTripwireAbortedError';
    this.before = before;
    this.after = after;
  }
}

/** The typed refusal of LAW 3. */
export class ModelSwitchWouldTouchClaudeSettingsError extends Error {
  readonly code = 'FACTORY_MODEL_SWITCH_SETTINGS_GUARD';

  constructor() {
    super(
      `FACTORY_MODEL_SWITCH_SETTINGS_GUARD: the operator model-set command refuses to run `
        + `unless ${SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS_ENV}=1 is present in the `
        + 'environment. This runtime never reads ~/.claude/settings.json for routing and '
        + 'never rewrites it; the env var is the operator-side tripwire law '
        + '(AGENTS.md directive, LEGACY-DELETION-MANIFEST §H).',
    );
    this.name = 'ModelSwitchWouldTouchClaudeSettingsError';
  }
}

/* ------------------------------------------------------------------ */
/* LAW 1: fail-closed executor resolution                              */
/* ------------------------------------------------------------------ */

/**
 * True iff the resolved executor is the forbidden claude CLI. Same patterns
 * as the retired tracker-view/claude-runner.mjs guard (operational law):
 * the blessed agent-proxy shim is carved out first, then every claude-CLI
 * spelling (bare name, binary path, VS Code extension binary) is forbidden.
 */
export function isForbiddenClaudeCli(executor: string | undefined): boolean {
  if (!executor) return false;
  const s = String(executor).trim().toLowerCase();
  if (s.includes('agent-proxy')) return false; // blessed opencode shim
  if (s === 'claude' || s === 'claude.exe' || s === 'claude.cmd' || s === 'claude.ps1' || s === 'claude.sh') return true;
  if (/[\\/]claude(\.exe|\.cmd|\.ps1|\.sh)?$/.test(s)) return true;
  if (s.includes('anthropic.claude-code') || s.includes('claude-code')) return true;
  return false;
}

/** The resolved compound executor of the one legal transport. */
export interface ResolvedExecutor {
  /** The process to spawn (e.g. `node`). */
  readonly command: string;
  /** Its argv prefix (e.g. the shim path). */
  readonly args: readonly string[];
  /** The raw env value that resolved here (for logs/refusals). */
  readonly raw: string;
}

/**
 * Resolve the worker executor FAIL-CLOSED (LAW 1). The resolution order is
 * SAGA_REAL_CLAUDE_PATH, then SAGA_CLAUDE_PATH, then the forbidden `claude`
 * default - so a forgotten env aborts loudly with
 * FACTORY_CLAUDE_BACKEND_FORBIDDEN (exactly like the retired runner: there
 * is no claude fallback anymore, and never a silent one).
 */
export function resolveExecutorPath(env: NodeJS.ProcessEnv = process.env): ResolvedExecutor {
  const raw = env[SAGA_REAL_CLAUDE_PATH_ENV] ?? env[SAGA_CLAUDE_PATH_ENV] ?? 'claude';
  if (isForbiddenClaudeCli(raw)) {
    throw new FactoryClaudeBackendForbiddenError(raw);
  }
  const trimmed = raw.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex > 0) {
    return { command: trimmed.slice(0, spaceIndex), args: [trimmed.slice(spaceIndex + 1)], raw: trimmed };
  }
  return { command: trimmed, args: [], raw: trimmed };
}

/* ------------------------------------------------------------------ */
/* LAW 2: the ~/.claude/settings.json sha256 tripwire                  */
/* ------------------------------------------------------------------ */

/** The absolute path of the operator-machine settings file (not ours). */
export function claudeSettingsPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

/** sha256 of the settings file, or 'absent' when it does not exist. */
export function claudeSettingsDigest(home: string = os.homedir()): string {
  try {
    return 'sha256:' + createHash('sha256').update(readFileSync(claudeSettingsPath(home), 'utf8'), 'utf8').digest('hex');
  } catch {
    return 'absent';
  }
}

/**
 * The mid-run tripwire. Arm once when the composition starts; verify before
 * every channel send. A digest change ABORTS the send (LAW 2): the file is
 * a tripwire only, never edited by us.
 */
export class ClaudeSettingsTripwire {
  private readonly armed: string;
  private readonly home: string;

  constructor(home: string = os.homedir()) {
    this.home = home;
    this.armed = claudeSettingsDigest(home);
  }

  /** The armed baseline (for logs and tests). */
  get baseline(): string {
    return this.armed;
  }

  /**
   * Verify the file is byte-identical to the armed baseline (the SAME home
   * the tripwire was armed against). Returns ok, or the ABORT condition
   * (the caller must not reach the network send).
   */
  verify(): { readonly ok: true } | { readonly ok: false; readonly error: ClaudeSettingsTripwireAbortedError } {
    const now = claudeSettingsDigest(this.home);
    if (now === this.armed) return { ok: true };
    return { ok: false, error: new ClaudeSettingsTripwireAbortedError(this.armed, now) };
  }
}

/* ------------------------------------------------------------------ */
/* LAW 3: the model-switch settings guard                              */
/* ------------------------------------------------------------------ */

/**
 * The guard every operator model-set path must call first: refuses unless
 * the operator pinned SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS (LAW 3). This
 * runtime never writes the settings file; the guard exists so a future
 * model-switch command cannot regress into the pre-cutover behavior.
 */
export function assertModelSwitchSkipsClaudeSettings(env: NodeJS.ProcessEnv = process.env): void {
  if (env[SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS_ENV] !== undefined && env[SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS_ENV] !== '0') {
    return;
  }
  throw new ModelSwitchWouldTouchClaudeSettingsError();
}
