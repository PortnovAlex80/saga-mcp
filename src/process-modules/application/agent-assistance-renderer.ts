/**
 * W5-A4 — AgentAssistanceRenderer: deterministic AgentAssistanceSnapshot from
 * ProtocolRun state + a Wave 1 AgentAssistanceDefinition.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md
 *       (lane W5-A4; exit gate §3 items 3 & 5; C031/C033).
 * Task: docs/refactor-management/05-subagent-tasks/W05-a4.md.
 * Plan: §10.4–§10.10 (assistance projection), §14.7.5/§14.7.7 (modes,
 *       deduplication, budgets), §15.15 (security: escaping, size limits,
 *       state-version dedup, cross-execution event rejection).
 *
 * The renderer is the single producer of `agent-assistance.json` (C031). It is
 * PURE: it takes durable ProtocolRun state + the per-node
 * AgentAssistanceDefinition and returns a serializable snapshot. It performs
 * NO I/O — the caller (workspace projection / context hook, W5-A5) writes the
 * snapshot to disk. Determinism: identical inputs always yield a byte-identical
 * snapshot (modulo the wall-clock `renderedAt` advisory, which the consumer
 * ignores for dedup).
 *
 * Responsibilities:
 *   - Mode selection (compact/guided/intensive) filters which semantic block
 *     kinds are emitted (§10.8). Compact trims detail-heavy blocks; guided
 *     emits everything the module declared; intensive additionally injects a
 *     retry-instruction derived from the attempt counter.
 *   - Bounded blocks (§10.7, C033): the fixed vocabulary is goal, current-step,
 *     next-action, resource-path, allowed-tools, completion-criteria,
 *     last-error, repair-fields, retry-instruction.
 *   - Budgets (C033): `maxBlocksPerEvent` caps block count (lowest-priority
 *     blocks dropped); `maxTokensPerBlock` truncates over-long content and flags
 *     it `truncated`. A token estimate (~4 chars/token) is recorded per block.
 *   - Dedup keys (§10.9, C033): every block carries a `dedupKey` = kind + hash
 *     of its (post-truncation) content, and the snapshot carries a
 *     `stateVersion` hash over the authoritative ProtocolRun state + event. The
 *     context hook suppresses re-emission when the stateVersion is unchanged.
 *   - Security (§15.15): untrusted content (last-error text lifted from a
 *     failed step's evidence/ledger, repair-field text) is escaped against
 *     prompt injection before rendering. The snapshot is execution-scoped so a
 *     stale snapshot cannot be replayed across executions.
 *
 * Anti-scope (WAVE5-WORKSPACE-TRACKER-SPEC §4): no ProtocolRun mutation, no
 * disk writes, no Markdown parsing (that is W5-A3/W5-A5). This file reads
 * ProtocolRun state and a definition, and returns pure data.
 */

import type {
  AgentAssistanceDefinition,
  AssistanceBlock,
  AssistanceBlockKind,
  AssistanceEvent,
  AssistanceEventName,
  AssistanceMode,
} from '../domain/spi/agent-assistance.js';
import type {
  ProtocolRunRecord,
  ProtocolStepRunRecord,
} from '../persistence/protocol-run.js';
import { canonicalJson, sha256Hex } from '../shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Public snapshot types.
// ---------------------------------------------------------------------------

/**
 * Schema tag for the serialized `agent-assistance.json` document. Bumped only
 * on a breaking shape change; the context hook (W5-A5) pins the version it
 * reads and refuses unknown schemas.
 */
export const AGENT_ASSISTANCE_SCHEMA = 'saga3.agent-assistance.v1' as const;
export type AgentAssistanceSchema = typeof AGENT_ASSISTANCE_SCHEMA;

/**
 * One rendered context block. Carries the post-budget `content`, a stable
 * `dedupKey` the consumer uses to suppress repetition, a `truncated` flag set
 * when `maxTokensPerBlock` cut the content, and a cheap `tokenEstimate`.
 */
export interface RenderedAssistanceBlock {
  readonly kind: AssistanceBlockKind;
  readonly content: string;
  readonly dedupKey: string;
  readonly truncated: boolean;
  readonly tokenEstimate: number;
}

/**
 * Execution scope stamped on every snapshot. Pins the snapshot to one
 * ProtocolRun + attempt + current step so the consumer can reject a snapshot
 * rendered for a different execution (§15.15 cross-execution event rejection).
 */
export interface AssistanceExecutionScope {
  readonly processRunId: number;
  readonly protocolRunId: number;
  readonly nodeProtocolId: string;
  readonly nodeProtocolVersion: string;
  readonly attempt: number;
  readonly currentStep: string | null;
}

/**
 * Accounting for the budgets applied during rendering. Surfaces how many blocks
 * were dropped for the count cap and the total token estimate emitted, so the
 * consumer can observe budget pressure.
 */
export interface AssistanceRenderStats {
  readonly blockCount: number;
  readonly totalTokenEstimate: number;
  readonly blocksDroppedForCount: number;
  readonly blocksTruncated: number;
}

/**
 * The full agent-assistance projection written to `agent-assistance.json`
 * (C031). Pure serializable data.
 */
export interface AgentAssistanceSnapshot {
  readonly schema: AgentAssistanceSchema;
  readonly executionScope: AssistanceExecutionScope;
  readonly event: AssistanceEventName;
  readonly mode: AssistanceMode;
  /**
   * Hash over the authoritative ProtocolRun state (currentStep, status,
   * attempt, latest failed step) + the event + mode. Identical stateVersion
   * ⇒ the consumer may suppress re-emission (§10.9 dedup, C033).
   */
  readonly stateVersion: string;
  readonly blocks: readonly RenderedAssistanceBlock[];
  readonly budgets: AgentAssistanceDefinition['budgets'];
  readonly stats: AssistanceRenderStats;
  /**
   * Advisory wall-clock. NOT part of stateVersion (would break determinism).
   * Consumers must not use it for dedup.
   */
  readonly renderedAt: string;
}

// ---------------------------------------------------------------------------
// Input bundle: ProtocolRun + its step ledger.
// ---------------------------------------------------------------------------

/**
 * The authoritative ProtocolRun read model the renderer projects from. The
 * caller supplies the run record and its ordered step ledger (newest attempt
 * of each step is sufficient; the renderer looks at the latest failed step
 * for the last-error block).
 */
export interface ProtocolRunView {
  readonly run: ProtocolRunRecord;
  readonly steps: readonly ProtocolStepRunRecord[];
}

// ---------------------------------------------------------------------------
// Tunable defaults. Centralized so behavior is observable and testable.
// ---------------------------------------------------------------------------

/**
 * Rough chars-per-token estimate for budget accounting. Deliberately
 * conservative (over-estimates tokens) so the budget caps err toward smaller
 * snapshots. The estimate is advisory only — it never changes WHICH content is
 * rendered, only whether `maxTokensPerBlock` truncates it.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Hard ceiling on a single block's content even when no per-block token budget
 * is declared. Defends against a runaway module-authored block or a huge
 * error blob flooding the agent context (§15.15 size limits, §17.7).
 */
export const MAX_BLOCK_CHARS = 4096;

/**
 * Hard ceiling on the number of blocks per event when no count budget is
 * declared. The fixed vocabulary has 9 kinds, so 9 is the natural ceiling.
 */
export const MAX_BLOCKS_PER_EVENT = 9;

/**
 * Per-mode allowlists of block kinds (§10.8). Compact mode drops the
 * detail-heavy kinds (resource-path, allowed-tools, completion-criteria,
 * repair-fields) and keeps only the minimal orienting set; guided emits every
 * kind the module declared; intensive additionally forces a retry-instruction
 * when the attempt counter shows a retry.
 *
 * Order is significant: when `maxBlocksPerEvent` forces drops, blocks earlier
 * in the kind priority list are kept. `BLOCK_KIND_PRIORITY` defines that order.
 */
export const MODE_BLOCK_KINDS: Readonly<Record<AssistanceMode, readonly AssistanceBlockKind[]>> = {
  compact: ['goal', 'current-step', 'next-action', 'last-error'],
  guided: [
    'goal',
    'current-step',
    'next-action',
    'resource-path',
    'allowed-tools',
    'completion-criteria',
    'last-error',
    'repair-fields',
    'retry-instruction',
  ],
  intensive: [
    'goal',
    'current-step',
    'next-action',
    'resource-path',
    'allowed-tools',
    'completion-criteria',
    'last-error',
    'repair-fields',
    'retry-instruction',
  ],
};

/**
 * Drop priority (lowest first). When the block-count budget is exceeded, the
 * kinds at the END of this list are dropped first. Retry-instruction and
 * repair-fields are the most expendable on a tight budget; goal/current-step/
 * next-action are always kept last.
 */
export const BLOCK_KIND_DROP_PRIORITY: readonly AssistanceBlockKind[] = [
  'retry-instruction',
  'repair-fields',
  'completion-criteria',
  'allowed-tools',
  'resource-path',
  'last-error',
  'next-action',
  'current-step',
  'goal',
];

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Typed error for illegal render inputs. Thrown when the event is not one the
 * definition declares, or when an execution-scope guard rejects a replay.
 */
export class AgentAssistanceRenderError extends Error {
  readonly code:
    | 'UNDECLARED_EVENT'
    | 'EXECUTION_SCOPE_MISMATCH'
    | 'INVALID_DEFINITION';
  constructor(
    code: 'UNDECLARED_EVENT' | 'EXECUTION_SCOPE_MISMATCH' | 'INVALID_DEFINITION',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AgentAssistanceRenderError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal: escaping for untrusted content (§15.15).
// ---------------------------------------------------------------------------

/**
 * Escape untrusted text so it cannot break out of the context block it is
 * placed in. Targets prompt-injection vectors: backticks (template literals),
 * `${` sequences, markdown fence openers, and C0 control bytes. Newlines and
 * tabs are preserved (they are legitimate formatting). The result is safe to
 * embed as the `content` of a RenderedAssistanceBlock.
 *
 * Applied to last-error and repair-field text lifted from runtime state
 * (failed-step evidence, error JSON). Module-authored static content is NOT
 * escaped — the module is a trusted author and escaping its declared text
 * would corrupt readable resource paths / tool lists.
 */
export function escapeUntrustedAssistanceContent(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    // Strip C0 controls except tab (\t=9), newline (\n=10), carriage return
    // (\r=13). These cannot contribute to a prompt-injection payload and
    // corrupt terminal rendering.
    if (ch < 0x20 && ch !== 9 && ch !== 10 && ch !== 13) {
      out += `\uFFFD`;
      continue;
    }
    const c = raw[i];
    if (c === '`') {
      // Prefix so a lone backtick cannot open/close a fence. Runs are collapsed
      // to a single backtick below.
      out += '\\`';
    } else if (c === '$' && raw[i + 1] === '{') {
      // Break the adjacency so neither a downstream JS template literal can
      // interpolate `${...}` NOR the raw rendered text carries the `${`
      // injection marker. `\$ {` keeps the characters visible (error text
      // stays readable) while removing the trigger sequence.
      out += '$ {';
      i++; // consume the '{'
    } else {
      out += c;
    }
  }
  // Collapse runs of three or more backticks that survived char-by-char (e.g.
  // a fence built without the ${ vector). Replace with a single backtick so a
  // rendered block cannot close/open an enclosing code fence.
  out = out.replace(/`{3,}/g, '`');
  return out;
}

// ---------------------------------------------------------------------------
// Internal: token estimate + budget truncation.
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate `content` to fit `maxChars`. Returns the (possibly truncated)
 * content plus a flag. When truncation occurs, a visible ellipsis marker is
 * appended so the agent can tell the block was trimmed. The marker is NOT
 * part of the dedup hash input — dedup uses the pre-marker truncated body so
 * two renderings of the same long content at the same budget hash identically.
 */
function applyCharBudget(
  content: string,
  maxChars: number,
): { body: string; display: string; truncated: boolean } {
  const cap = Math.min(maxChars, MAX_BLOCK_CHARS);
  if (content.length <= cap) {
    return { body: content, display: content, truncated: false };
  }
  const body = content.slice(0, cap);
  return {
    body,
    display: `${body} […] [truncated at ${cap} chars]`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Internal: runtime-derived block content from ProtocolRun state.
// ---------------------------------------------------------------------------

/**
 * Find the latest FAILED step in the ledger. Used for the last-error block on
 * post-tool-error / recovery-enter / resume events. "Latest" = highest
 * (attempt, id) among failed rows.
 */
function latestFailedStep(
  steps: readonly ProtocolStepRunRecord[],
): ProtocolStepRunRecord | null {
  let best: ProtocolStepRunRecord | null = null;
  for (const s of steps) {
    if (s.status !== 'failed') continue;
    if (
      best === null ||
      s.attempt > best.attempt ||
      (s.attempt === best.attempt && s.id > best.id)
    ) {
      best = s;
    }
  }
  return best;
}

/**
 * Build the runtime-derived blocks for the current event. These supplement the
 * module-declared static blocks with authoritative ProtocolRun state
 * (current step, last error, retry instruction). Returns blocks keyed by kind
 * so the caller can merge with module-declared content (module-declared wins
 * for static kinds; runtime-derived is the only source for current-step /
 * last-error / retry-instruction unless the module also declares them).
 */
function runtimeDerivedBlocks(
  view: ProtocolRunView,
  event: AssistanceEventName,
  mode: AssistanceMode,
): Map<AssistanceBlockKind, AssistanceBlock> {
  const out = new Map<AssistanceBlockKind, AssistanceBlock>();
  const { run, steps } = view;

  // current-step: always present (compact+). Authoritative from the run.
  if (run.currentStep !== null) {
    out.set('current-step', {
      kind: 'current-step',
      content: run.currentStep,
    });
  }

  // last-error: only on error/recovery/resume events, and only if a failed
  // step exists. The error text is untrusted → escaped.
  if (
    event === 'post-tool-error' ||
    event === 'recovery-enter' ||
    event === 'resume'
  ) {
    const failed = latestFailedStep(steps);
    if (failed !== null) {
      const evidence = failed.evidenceJson ?? '';
      // The evidence blob is opaque JSON; surface it escaped. If empty, name
      // the failed step + attempt so the agent has a lead.
      const text =
        evidence.length > 0
          ? escapeUntrustedAssistanceContent(evidence)
          : escapeUntrustedAssistanceContent(
              `step ${failed.stepId} failed on attempt ${failed.attempt}`,
            );
      out.set('last-error', { kind: 'last-error', content: text });
    }
  }

  // retry-instruction: intensive mode + a retry is in flight (attempt > 1) on
  // recovery/resume/step-enter. Guided mode only if the module declared one.
  if (
    mode === 'intensive' &&
    run.attempt > 1 &&
    (event === 'recovery-enter' ||
      event === 'resume' ||
      event === 'step-enter')
  ) {
    out.set('retry-instruction', {
      kind: 'retry-instruction',
      content: `Retry attempt ${run.attempt}: re-enter at step ${run.currentStep ?? run.entryStep}, address the last error, and re-submit.`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal: dedup key + state version hashing.
// ---------------------------------------------------------------------------

/**
 * Dedup key for one rendered block. Stable across renderings of identical
 * (kind, truncated-body). The display marker is excluded so two renderings of
 * the same over-long content at the same budget produce the same key.
 */
function blockDedupKey(kind: AssistanceBlockKind, truncatedBody: string): string {
  return `${kind}:${sha256Hex({ kind, body: truncatedBody })}`;
}

/**
 * State version for the whole snapshot. Hashed over the authoritative Protocol
 * Run state that influences rendering: identity, currentStep, status, attempt,
 * the latest failed step (id + attempt), plus the event and mode. Two
 * renderings with the same stateVersion are semantically identical and the
 * consumer may suppress the second (§10.9, C033).
 *
 * Pure data in, deterministic hash out. Wall-clock is deliberately excluded.
 */
function computeStateVersion(
  view: ProtocolRunView,
  event: AssistanceEventName,
  mode: AssistanceMode,
): string {
  const failed = latestFailedStep(view.steps);
  return sha256Hex({
    processRunId: view.run.processRunId,
    protocolRunId: view.run.id,
    nodeProtocolId: view.run.nodeProtocolId,
    currentStep: view.run.currentStep,
    status: view.run.status,
    attempt: view.run.attempt,
    latestFailedStep:
      failed === null ? null : { id: failed.id, attempt: failed.attempt },
    event,
    mode,
  });
}

// ---------------------------------------------------------------------------
// Internal: event config resolution + merge.
// ---------------------------------------------------------------------------

/**
 * Resolve the AssistanceEvent config from the definition for the requested
 * event name. Returns null when the definition declares no blocks for this
 * event (the renderer then emits a snapshot with only runtime-derived blocks,
 * or an empty block list if the mode filters them all out).
 */
function findEventConfig(
  definition: AgentAssistanceDefinition,
  event: AssistanceEventName,
): AssistanceEvent | null {
  for (const ev of definition.events) {
    if (ev.event === event) return ev;
  }
  return null;
}

/**
 * Merge module-declared static blocks with runtime-derived blocks into a
 * single ordered kind→content map.
 *
 * Precedence: for kinds that BOTH the module declares AND the runtime derives
 * (e.g. a module that hand-authors a current-step block), the module-declared
 * content wins — the module is the trusted author of its own static context.
 * Runtime-derived content is the sole source for kinds the module did not
 * declare (typical: current-step, last-error, retry-instruction).
 */
function mergeBlocks(
  declared: readonly AssistanceBlock[],
  derived: Map<AssistanceBlockKind, AssistanceBlock>,
): Map<AssistanceBlockKind, AssistanceBlock> {
  const merged = new Map<AssistanceBlockKind, AssistanceBlock>();
  // Derived first (runtime state), then declared overwrites for shared kinds.
  for (const [kind, block] of derived) {
    merged.set(kind, block);
  }
  for (const block of declared) {
    merged.set(block.kind, block);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Public: renderAssistanceSnapshot.
// ---------------------------------------------------------------------------

/**
 * Default wall-clock supplier. Exposed as an argument (via the options bag) so
 * tests can inject a fixed clock and keep snapshots fully deterministic.
 */
function defaultNow(): string {
  return new Date().toISOString();
}

/** Options bag for {@link renderAssistanceSnapshot}. */
export interface RenderAssistanceOptions {
  /**
   * Inject a fixed clock for deterministic tests. Defaults to the live
   * wall-clock. The value is advisory only and excluded from `stateVersion`.
   */
  readonly now?: () => string;
  /**
   * Override the per-block character budget for this render. When set, takes
   * precedence over `definition.budgets.maxTokensPerBlock` (converted via
   * {@link CHARS_PER_TOKEN}). Mainly for tests.
   */
  readonly maxBlockCharsOverride?: number;
}

/**
 * Render an {@link AgentAssistanceSnapshot} from ProtocolRun state + a Wave 1
 * AgentAssistanceDefinition for one lifecycle event.
 *
 * Contract:
 *   - Pure: no I/O, no side effects. Identical inputs ⇒ identical
 *     `stateVersion` and block contents (modulo `renderedAt`).
 *   - Mode-filtered: `compact` drops detail-heavy block kinds; `guided` emits
 *     every declared kind; `intensive` additionally injects a retry
 *     instruction when the attempt counter shows a retry (§10.8).
 *   - Budget-bounded: `maxBlocksPerEvent` caps block count (drops by
 *     {@link BLOCK_KIND_DROP_PRIORITY}); `maxTokensPerBlock` truncates over-long
 *     content and flags it `truncated` (§10.9, C033).
 *   - Dedup-keyed: every block carries a stable `dedupKey`; the snapshot
 *     carries a `stateVersion` the consumer uses to suppress unchanged
 *     re-emissions (§10.9, C033).
 *   - Escaped: untrusted runtime content (last-error, repair text) is escaped
 *     against prompt injection (§15.15).
 *   - Execution-scoped: the snapshot is pinned to one ProtocolRun + attempt +
 *     current step; {@link assertSnapshotExecution} rejects replay across
 *     executions (§15.15).
 *
 * Throws {@link AgentAssistanceRenderError} with code `INVALID_DEFINITION` if
 * the definition's `nodeId` is empty or its `mode` is not a known mode.
 */
export function renderAssistanceSnapshot(
  protocolRun: ProtocolRunView,
  definition: AgentAssistanceDefinition,
  event: AssistanceEventName,
  options: RenderAssistanceOptions = {},
): AgentAssistanceSnapshot {
  // --- Validate definition shell (the SPI validates deeply elsewhere; we
  //     only guard the fields the renderer switches on). ---
  if (
    typeof definition.nodeId !== 'string' ||
    definition.nodeId.length === 0
  ) {
    throw new AgentAssistanceRenderError(
      'INVALID_DEFINITION',
      'definition.nodeId must be a non-empty string',
    );
  }
  if (
    typeof definition.mode !== 'string' ||
    !(definition.mode in MODE_BLOCK_KINDS)
  ) {
    throw new AgentAssistanceRenderError(
      'INVALID_DEFINITION',
      `definition.mode must be one of ${Object.keys(MODE_BLOCK_KINDS).join('|')}`,
    );
  }

  const { run } = protocolRun;
  const mode = definition.mode;
  const allowedKinds = new Set<AssistanceBlockKind>(MODE_BLOCK_KINDS[mode]);
  const dropRank = new Map<AssistanceBlockKind, number>(
    BLOCK_KIND_DROP_PRIORITY.map((k, i) => [k, i] as const),
  );

  // --- Resolve event config (module-declared static blocks for this event). ---
  const eventConfig = findEventConfig(definition, event);
  const declaredBlocks = eventConfig?.blocks ?? [];

  // --- Merge with runtime-derived blocks. ---
  const derived = runtimeDerivedBlocks(protocolRun, event, mode);
  const merged = mergeBlocks(declaredBlocks, derived);

  // --- Filter to mode-allowed kinds, preserving module-declared order first. ---
  // Declared blocks render in their declared order; runtime-derived blocks
  // that survived filtering render after, in drop-priority order (most
  // important first).
  const declaredOrder: AssistanceBlockKind[] = [];
  for (const b of declaredBlocks) declaredOrder.push(b.kind);
  const derivedKinds = [...derived.keys()].sort(
    (a, b) => (dropRank.get(b) ?? 0) - (dropRank.get(a) ?? 0),
  );
  const orderedKinds: AssistanceBlockKind[] = [];
  const seen = new Set<AssistanceBlockKind>();
  for (const k of [...declaredOrder, ...derivedKinds]) {
    if (seen.has(k)) continue;
    if (!allowedKinds.has(k)) continue;
    if (!merged.has(k)) continue;
    seen.add(k);
    orderedKinds.push(k);
  }

  // --- Apply block-count budget (drop lowest-priority kinds). ---
  const maxBlocks =
    definition.budgets.maxBlocksPerEvent ?? MAX_BLOCKS_PER_EVENT;
  let effectiveKinds = orderedKinds;
  let blocksDroppedForCount = 0;
  if (orderedKinds.length > maxBlocks) {
    // Sort a copy by drop priority ascending (most expendable first), drop
    // from the expendable end until we fit.
    const byExpendable = [...orderedKinds].sort(
      (a, b) => (dropRank.get(a) ?? 0) - (dropRank.get(b) ?? 0),
    );
    const dropCount = orderedKinds.length - maxBlocks;
    const droppedSet = new Set<AssistanceBlockKind>(byExpendable.slice(0, dropCount));
    effectiveKinds = orderedKinds.filter((k) => !droppedSet.has(k));
    blocksDroppedForCount = dropCount;
  }

  // --- Render each block: escape if untrusted-derived, truncate to budget. ---
  const maxTokensPerBlock = definition.budgets.maxTokensPerBlock;
  const charBudget =
    options.maxBlockCharsOverride ??
    (typeof maxTokensPerBlock === 'number' && maxTokensPerBlock > 0
      ? maxTokensPerBlock * CHARS_PER_TOKEN
      : MAX_BLOCK_CHARS);

  const untrustedKinds = new Set<AssistanceBlockKind>([
    'last-error',
    'repair-fields',
  ]);

  const rendered: RenderedAssistanceBlock[] = [];
  let blocksTruncated = 0;
  let totalTokenEstimate = 0;

  for (const kind of effectiveKinds) {
    const source = merged.get(kind);
    if (source === undefined) continue;
    const needsEscape = untrustedKinds.has(kind) && !declaredHasKind(declaredBlocks, kind);
    const rawContent = needsEscape
      ? escapeUntrustedAssistanceContent(source.content)
      : source.content;
    const { body, display, truncated } = applyCharBudget(rawContent, charBudget);
    if (truncated) blocksTruncated++;
    const tokenEstimate = estimateTokens(display);
    totalTokenEstimate += tokenEstimate;
    rendered.push({
      kind,
      content: display,
      dedupKey: blockDedupKey(kind, body),
      truncated,
      tokenEstimate,
    });
  }

  const stateVersion = computeStateVersion(protocolRun, event, mode);
  const now = options.now ?? defaultNow;

  return {
    schema: AGENT_ASSISTANCE_SCHEMA,
    executionScope: {
      processRunId: run.processRunId,
      protocolRunId: run.id,
      nodeProtocolId: run.nodeProtocolId,
      nodeProtocolVersion: run.nodeProtocolVersion,
      attempt: run.attempt,
      currentStep: run.currentStep,
    },
    event,
    mode,
    stateVersion,
    blocks: rendered,
    budgets: definition.budgets,
    stats: {
      blockCount: rendered.length,
      totalTokenEstimate,
      blocksDroppedForCount,
      blocksTruncated,
    },
    renderedAt: now(),
  };
}

/**
 * Whether the module declared a block of `kind`. Used to decide precedence:
 * when the module declares a last-error/repair-fields block, its (trusted)
 * text wins and is NOT re-escaped; only runtime-derived untrusted text is
 * escaped.
 */
function declaredHasKind(
  declared: readonly AssistanceBlock[],
  kind: AssistanceBlockKind,
): boolean {
  for (const b of declared) {
    if (b.kind === kind) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public: serialize to agent-assistance.json.
// ---------------------------------------------------------------------------

/**
 * Serialize a snapshot to canonical JSON for `agent-assistance.json`
 * (C031). Canonical form guarantees byte-stable output for identical inputs,
 * so the context hook (W5-A5) can diff the file cheaply.
 */
export function serializeAssistanceSnapshot(snapshot: AgentAssistanceSnapshot): string {
  return canonicalJson(snapshot);
}

// ---------------------------------------------------------------------------
// Public: cross-execution event rejection guard (§15.15).
// ---------------------------------------------------------------------------

/**
 * Assert that `snapshot` was rendered for the ProtocolRun in `view`. Throws
 * {@link AgentAssistanceRenderError} (code `EXECUTION_SCOPE_MISMATCH`) when the
 * snapshot's execution scope does not match the current run — i.e. a snapshot
 * rendered for a previous/different execution is being replayed. The context
 * hook calls this before trusting a cached `agent-assistance.json`.
 *
 * Compared fields: processRunId, protocolRunId, nodeProtocolId, attempt,
 * currentStep. (Status is allowed to drift — a snapshot rendered at
 * status='active' may be read after the run pauses; the scope identity is what
 * matters for cross-execution rejection.)
 */
export function assertSnapshotExecution(
  snapshot: AgentAssistanceSnapshot,
  view: ProtocolRunView,
): void {
  const s = snapshot.executionScope;
  const r = view.run;
  const mismatches: string[] = [];
  if (s.processRunId !== r.processRunId) {
    mismatches.push(`processRunId ${s.processRunId} vs ${r.processRunId}`);
  }
  if (s.protocolRunId !== r.id) {
    mismatches.push(`protocolRunId ${s.protocolRunId} vs ${r.id}`);
  }
  if (s.nodeProtocolId !== r.nodeProtocolId) {
    mismatches.push(`nodeProtocolId ${s.nodeProtocolId} vs ${r.nodeProtocolId}`);
  }
  if (s.attempt !== r.attempt) {
    mismatches.push(`attempt ${s.attempt} vs ${r.attempt}`);
  }
  if (s.currentStep !== r.currentStep) {
    mismatches.push(`currentStep ${s.currentStep} vs ${r.currentStep}`);
  }
  if (mismatches.length > 0) {
    throw new AgentAssistanceRenderError(
      'EXECUTION_SCOPE_MISMATCH',
      `snapshot does not belong to this execution: ${mismatches.join('; ')}`,
    );
  }
}
