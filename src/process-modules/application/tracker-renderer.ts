/**
 * W5-A3 — TrackerRenderer: deterministic tracker Markdown from ProtocolRun state.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md
 * Task: docs/refactor-management/05-subagent-tasks/W05-a3.md
 * Plan: §0.8 (Wave 5) / Phase 6 / exit gate §0.8.12 item 2 (C027).
 *
 * Replaces the mutable, model-flipped Markdown checkbox tracker
 * (`tool-templates/.../stage-tracker.md` + `tracker-reminder.mjs`) with a
 * deterministic projection of the durable ProtocolRun state machine owned by
 * Wave 4 (`application/protocol-runtime.ts`).
 *
 * C027 — the renderer MUST NOT emit model-authored Markdown checkboxes
 * via regex and the model flips them; that loop is what this lane deletes.
 * Instead, every step's status is computed from the step-run's durable
 * `status` field and rendered as a FIXED, read-only symbol token. The model
 * cannot change the tracker by editing Markdown; only the ProtocolRuntime
 * state machine advances it.
 *
 * Pure: reads the three inputs (`protocolRun`, `stepRuns`, `module`) and
 * returns a string. No I/O, no clocks, no module-name switching. Same input
 * → byte-identical output (deterministic ordering: steps in declaration
 * order, evidence in attachment order, no locale-dependent sorting).
 *
 * Ownership: this file is owned by W5-A3 exclusively. It depends only on
 * Wave 4 records (`ProtocolRunRecord` / `ProtocolStepRunRecord`) and the
 * Wave 1 SPI (`NodeProtocolDefinition`), both of which are frozen on the
 * Wave 4 checkpoint `e87809b`.
 */

import type {
  NodeProtocolDefinition,
  ProtocolStep,
} from '../domain/spi/node-protocol.js';
import type {
  ProtocolRunRecord,
  ProtocolStepRunRecord,
  ProtocolStepRunStatus,
} from './protocol-runtime.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * The fixed, read-only symbol rendered for each step. These are deliberately
 * NOT Markdown checkboxes: they are uppercase tokens that no model is asked
 * to flip. C027.
 */
export type TrackerStepSymbol = 'DONE' | 'DOING' | 'PENDING' | 'SKIPPED' | 'FAILED';

/**
 * Render options. All fields optional; defaults are chosen for determinism
 * and stable diffs:
 *   - `emitEvidenceSummary` (default true): append a per-step evidence line
 *     counting attached receipts by category. The model cannot mutate it.
 *   - `emitRunHeader` (default true): emit the run-identity + status block
 *     at the top of the document.
 */
export interface RenderTrackerOptions {
  readonly emitEvidenceSummary?: boolean;
  readonly emitRunHeader?: boolean;
}

/**
 * Deterministic TrackerRenderer. Stateless; the class is a namespace so
 * callers can wire it through DI alongside other application services and
 * mock it in tests. `renderTracker` is also exported as a free function.
 */
export class TrackerRenderer {
  renderTracker(
    protocolRun: ProtocolRunRecord,
    stepRuns: readonly ProtocolStepRunRecord[],
    module: NodeProtocolDefinition,
    options?: RenderTrackerOptions,
  ): string {
    return renderTracker(protocolRun, stepRuns, module, options);
  }
}

// ---------------------------------------------------------------------------
// Status → symbol mapping (single source of truth; C027).
// ---------------------------------------------------------------------------

/**
 * Map a durable `ProtocolStepRunStatus` to the read-only tracker symbol.
 *
 * `pending`      → PENDING  (not yet started)
 * `in_progress`  → DOING    (cursor is on this step attempt)
 * `completed`    → DONE     (step attempt sealed with required evidence)
 * `skipped`      → SKIPPED  (declared non-applicable by the runtime)
 * `failed`       → FAILED   (attempt exhausted without completion)
 *
 * The mapping is total (exhaustive over the status union), so adding a new
 * status to `ProtocolStepRunStatus` produces a compile error here.
 */
export function symbolForStatus(status: ProtocolStepRunStatus): TrackerStepSymbol {
  switch (status) {
    case 'pending':
      return 'PENDING';
    case 'in_progress':
      return 'DOING';
    case 'completed':
      return 'DONE';
    case 'skipped':
      return 'SKIPPED';
    case 'failed':
      return 'FAILED';
    default: {
      // Exhaustiveness guard: a new status member must be handled here.
      const exhaustive: never = status;
      throw new Error(`TrackerRenderer: unhandled ProtocolStepRunStatus "${String(exhaustive)}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Core renderer.
// ---------------------------------------------------------------------------

/**
 * Deterministically render tracker Markdown for one ProtocolRun.
 *
 * Inputs:
 *   - `protocolRun`   — the durable run record (status, cursor, attempt).
 *   - `stepRuns`      — every step-run row for this run, in any order; the
 *                       renderer re-orders deterministically (see below).
 *   - `module`        — the NodeProtocolDefinition whose steps are rendered.
 *
 * Determinism rules:
 *   1. Steps render in DECLARATION order (`module.steps[]`), never in
 *      insertion or DB-row order. This keeps the diff stable when a step is
 *      re-attempted.
 *   2. For each step, the LATEST attempt wins (highest `attempt` with a
 *      non-`pending` status; falls back to the highest attempt overall).
 *   3. Evidence categories are counted and rendered in fixed category order.
 *   4. No timestamps, no random IDs, no locale-dependent sorting.
 *
 * Output: a single Markdown string, newline-terminated.
 */
export function renderTracker(
  protocolRun: ProtocolRunRecord,
  stepRuns: readonly ProtocolStepRunRecord[],
  module: NodeProtocolDefinition,
  options?: RenderTrackerOptions,
): string {
  validateInputs(protocolRun, stepRuns, module);

  const emitHeader = options?.emitRunHeader ?? true;
  const emitEvidence = options?.emitEvidenceSummary ?? true;

  // Index step runs by stepId → latest attempt. Only runs belonging to this
  // protocolRun are considered; the caller is expected to pass the run's own
  // step runs but we filter defensively.
  const latestByStep = indexLatestAttemptPerStep(stepRuns, protocolRun.id);

  const lines: string[] = [];
  if (emitHeader) {
    lines.push(...renderRunHeader(protocolRun, module));
    lines.push('');
  }

  lines.push('## Step Progress');
  lines.push('');
  lines.push('> Read-only projection from ProtocolRun state. Do not edit; the runtime advances it.');
  lines.push('');

  for (const step of module.steps) {
    const stepRun = latestByStep.get(step.id) ?? null;
    lines.push(...renderStep(step, stepRun, protocolRun, emitEvidence));
    lines.push('');
  }

  // Recovery entry steps (declared on the module) get a separate block so a
  // reader can see where the runtime will route on `enter-recovery-node`.
  if (module.recoveryEntrySteps.length > 0) {
    lines.push(...renderRecoveryEntries(module, latestByStep, emitEvidence));
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

function validateInputs(
  protocolRun: ProtocolRunRecord,
  stepRuns: readonly ProtocolStepRunRecord[],
  module: NodeProtocolDefinition,
): void {
  if (!protocolRun) {
    throw new Error('TrackerRenderer: protocolRun is required');
  }
  if (!module) {
    throw new Error('TrackerRenderer: module (NodeProtocolDefinition) is required');
  }
  // The run's nodeProtocolId is the runtime binding; we do NOT require it to
  // equal module.id (the runtime owns that binding and may project a run
  // against a fresher module version for read-only rendering). We DO require
  // the run to reference a non-empty protocol id, otherwise the header would
  // be meaningless.
  if (!protocolRun.nodeProtocolId) {
    throw new Error('TrackerRenderer: protocolRun.nodeProtocolId must be non-empty');
  }
  if (!Array.isArray(stepRuns)) {
    throw new Error('TrackerRenderer: stepRuns must be an array');
  }
  for (const sr of stepRuns) {
    if (!sr || typeof sr !== 'object') {
      throw new Error('TrackerRenderer: every stepRun must be an object');
    }
    if (sr.protocolRunId !== protocolRun.id) {
      throw new Error(
        `TrackerRenderer: stepRun ${sr.id} belongs to run ${sr.protocolRunId}, not ${protocolRun.id}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Indexing: pick the latest attempt per step (deterministic).
// ---------------------------------------------------------------------------

/**
 * For each stepId, keep the row that represents the step's CURRENT state.
 *
 * Primary key: HIGHER attempt number. The runtime's `currentStep`+`attempt`
 * always point at the live attempt; a step's effective tracker status is the
 * status of its latest attempt (the runtime never re-opens an old attempt —
 * `retryStep` bumps the counter and opens a fresh row). Showing the highest
 * attempt therefore matches what the runtime is actually doing right now.
 *
 * Secondary tiebreak (only matters if two rows share an attempt number, which
 * the persistence UNIQUE(run, step, attempt) constraint forbids in practice):
 * more-progressed status wins. Order (highest first):
 *   completed / skipped / failed   — sealed terminal states.
 *   in_progress                    — open work.
 *   pending                        — not yet started.
 */
function indexLatestAttemptPerStep(
  stepRuns: readonly ProtocolStepRunRecord[],
  runId: number,
): Map<string, ProtocolStepRunRecord> {
  const out = new Map<string, ProtocolStepRunRecord>();
  for (const sr of stepRuns) {
    if (sr.protocolRunId !== runId) continue;
    const incumbent = out.get(sr.stepId);
    if (!incumbent || prefersOver(sr, incumbent)) {
      out.set(sr.stepId, sr);
    }
  }
  return out;
}

function prefersOver(a: ProtocolStepRunRecord, b: ProtocolStepRunRecord): boolean {
  if (a.attempt !== b.attempt) return a.attempt > b.attempt;
  return rankStepRun(a) > rankStepRun(b);
}

function rankStepRun(sr: ProtocolStepRunRecord): number {
  switch (sr.status) {
    case 'completed':
      return 4;
    case 'skipped':
      return 3;
    case 'failed':
      return 3;
    case 'in_progress':
      return 2;
    case 'pending':
      return 1;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Header block.
// ---------------------------------------------------------------------------

function renderRunHeader(
  run: ProtocolRunRecord,
  module: NodeProtocolDefinition,
): string[] {
  const lines: string[] = [];
  lines.push(`# Protocol Tracker — ${module.id}@${module.version}`);
  lines.push('');
  lines.push(`- protocol_run_id: \`${run.id}\``);
  lines.push(`- process_run_id: \`${run.processRunId}\``);
  lines.push(`- node_run_id: ${run.nodeRunId === null ? '(none)' : `\`${run.nodeRunId}\``}`);
  lines.push(`- node_protocol_id: \`${run.nodeProtocolId}\``);
  lines.push(`- node_protocol_version: \`${run.nodeProtocolVersion}\``);
  lines.push(`- entry_step: \`${run.entryStep}\``);
  lines.push(`- current_step: ${run.currentStep === null ? '(not started)' : `\`${run.currentStep}\``}`);
  lines.push(`- current_attempt: \`${run.attempt}\``);
  lines.push(`- run_status: \`${run.status}\``);
  if (run.completedAt !== null) {
    lines.push(`- completed_at: \`${run.completedAt}\``);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Per-step block.
// ---------------------------------------------------------------------------

function renderStep(
  step: ProtocolStep,
  stepRun: ProtocolStepRunRecord | null,
  run: ProtocolRunRecord,
  emitEvidence: boolean,
): string[] {
  const lines: string[] = [];
  const isCurrent = run.currentStep === step.id;
  const symbol = stepRun === null ? 'PENDING' : symbolForStatus(stepRun.status);
  const cursor = isCurrent ? ' *<-- current*' : '';
  const attemptSuffix = stepRun === null
    ? ''
    : ` (attempt ${stepRun.attempt})`;

  // Step heading uses the symbol token, NOT a Markdown checkbox (C027).
  lines.push(`### [${symbol}] ${step.id}${attemptSuffix}${cursor}`);
  lines.push('');
  // Inline the instructions verbatim; the module owns their content. Trim
  // trailing whitespace per line but preserve internal structure.
  const instructions = step.instructions.trim();
  if (instructions.length > 0) {
    for (const instructionLine of instructions.split('\n')) {
      lines.push(`> ${instructionLine}`);
    }
    lines.push('');
  }

  // Allowed tools + resources: render as plain comma lists (no checkboxes).
  if (step.allowedTools.length > 0) {
    lines.push(`- allowed_tools: ${step.allowedTools.join(', ')}`);
  }
  if (step.resources.length > 0) {
    lines.push(`- resources: ${step.resources.join(', ')}`);
  }

  // Evidence summary — deterministic count per category, fixed category order.
  if (emitEvidence) {
    lines.push(...renderEvidenceSummary(step, stepRun));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Evidence summary.
// ---------------------------------------------------------------------------

/**
 * Render the evidence attached to a step attempt against the step's declared
 * requirements. The model cannot edit this: it is computed from the durable
 * `evidence[]` array on the step run.
 *
 * Format:
 *   - evidence: 2 attached, 1 required (missing: artifact-reference)
 *   - evidence: 1 attached, 0 required
 *   - evidence: (no attempts yet)
 */
const EVIDENCE_CATEGORY_ORDER = [
  'tool-receipt',
  'artifact-reference',
  'trace-reference',
  'human-receipt',
  'external-receipt',
  'module-verifier-receipt',
] as const;

function renderEvidenceSummary(
  step: ProtocolStep,
  stepRun: ProtocolStepRunRecord | null,
): string[] {
  if (stepRun === null) {
    return ['- evidence: (no attempts yet)'];
  }
  const required = step.evidenceRequirements.filter((r) => r.required);
  const attached = stepRun.evidence;

  if (required.length === 0) {
    return [`- evidence: ${attached.length} attached, 0 required`];
  }

  // Compute missing required requirements (deterministic: declaration order).
  const have = new Set(attached.map((e) => `${e.category}|${e.contractRef}`));
  const missing = required.filter(
    (r) => !have.has(`${r.category}|${r.contractRef}`),
  );

  if (missing.length === 0) {
    // Group attached evidence counts by category in fixed order.
    const counts = countByCategory(attached.map((e) => e.category));
    const breakdown = EVIDENCE_CATEGORY_ORDER.filter((c) => counts.has(c))
      .map((c) => `${c}=${counts.get(c)}`)
      .join(', ');
    return [
      `- evidence: ${attached.length} attached, ${required.length} required (satisfied${breakdown ? `; ${breakdown}` : ''})`,
    ];
  }

  const missingDesc = missing
    .map((m) => `${m.category}:${m.contractRef}`)
    .join(', ');
  return [
    `- evidence: ${attached.length} attached, ${required.length} required (missing: ${missingDesc})`,
  ];
}

function countByCategory(categories: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of categories) {
    out.set(c, (out.get(c) ?? 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recovery entry block.
// ---------------------------------------------------------------------------

function renderRecoveryEntries(
  module: NodeProtocolDefinition,
  latestByStep: Map<string, ProtocolStepRunRecord>,
  emitEvidence: boolean,
): string[] {
  const lines: string[] = [];
  lines.push('## Recovery Entry Steps');
  lines.push('');
  for (const stepId of module.recoveryEntrySteps) {
    const step = module.steps.find((s) => s.id === stepId);
    if (!step) continue; // defensive; validateNodeProtocolDefinition forbids this.
    const stepRun = latestByStep.get(stepId) ?? null;
    const symbol = stepRun === null ? 'PENDING' : symbolForStatus(stepRun.status);
    const attemptSuffix = stepRun === null ? '' : ` (attempt ${stepRun.attempt})`;
    lines.push(`- [${symbol}] ${step.id}${attemptSuffix} — recovery entry`);
    if (emitEvidence && stepRun !== null) {
      const summary = renderEvidenceSummary(step, stepRun)[0];
      if (summary) lines.push(`  ${summary}`);
    }
  }
  return lines;
}
