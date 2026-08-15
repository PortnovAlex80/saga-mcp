/**
 * W1-A6 — Agent assistance definition: the structured context blocks the module
 * declares for each lifecycle event an LM agent encounters.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 13.
 * Plan: §10 (LM Execution Cell), §13.16–13.18.
 *
 * An `AgentAssistanceDefinition` is attached per node. It declares the
 * assistance `mode`, the `events` at which context blocks fire, and the
 * `budgets` that bound assistance. All pure serializable data — the runtime
 * persists and forwards the definition; an assistance renderer (Wave 5) turns
 * it into the prompt the agent sees.
 *
 * This file is PURE: data types + one pure validator. No behavior.
 */

import type { ValidationError, ValidationResult } from './production-envelope.js';
export type { ValidationError, ValidationResult } from './production-envelope.js';

// ---------------------------------------------------------------------------
// assertCanonicalSerializable — W1-A1 integration path with inline fallback.
// ---------------------------------------------------------------------------

type AssertCanonical = (value: unknown) => void;

function fallbackAssertCanonicalSerializable(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    const t = typeof v;
    if (t === 'function') throw new Error('not canonical serializable: function value');
    if (t === 'symbol') throw new Error('not canonical serializable: symbol value');
    if (t === 'number' && !Number.isFinite(v as number)) {
      throw new Error('not canonical serializable: non-finite number');
    }
    if (v === null || t !== 'object') continue;
    if (v instanceof Map) throw new Error('not canonical serializable: Map');
    if (v instanceof Set) throw new Error('not canonical serializable: Set');
    if (!Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('not canonical serializable: non-plain object');
      }
    }
    const iter = Array.isArray(v)
      ? (v as unknown[])
      : Object.values(v as Record<string, unknown>);
    for (let i = 0; i < iter.length; i++) {
      const child = iter[i];
      if (child === undefined && Array.isArray(v)) {
        throw new Error('not canonical serializable: undefined in array');
      }
      stack.push(child);
    }
  }
}

let _assertCanonicalSync: AssertCanonical = fallbackAssertCanonicalSerializable;
void (async () => {
  try {
    // Variable specifier so tsc does not resolve-check the sibling-lane file.
    const spec = './canonical-serialization.js';
    const mod = (await import(spec)) as {
      assertCanonicalSerializable?: AssertCanonical;
    };
    if (typeof mod.assertCanonicalSerializable === 'function') {
      _assertCanonicalSync = mod.assertCanonicalSerializable;
    }
  } catch {
    // isolation fallback already assigned synchronously
  }
})();

// ---------------------------------------------------------------------------
// Enums.
// ---------------------------------------------------------------------------

export type AssistanceMode = 'compact' | 'guided' | 'intensive';

export const ASSISTANCE_MODES: ReadonlySet<AssistanceMode> = new Set([
  'compact',
  'guided',
  'intensive',
]);

export type AssistanceEventName =
  | 'step-enter'
  | 'post-tool-success'
  | 'post-tool-error'
  | 'before-submit'
  | 'recovery-enter'
  | 'resume';

export const ASSISTANCE_EVENT_NAMES: ReadonlySet<AssistanceEventName> = new Set([
  'step-enter',
  'post-tool-success',
  'post-tool-error',
  'before-submit',
  'recovery-enter',
  'resume',
]);

export type AssistanceBlockKind =
  | 'goal'
  | 'current-step'
  | 'next-action'
  | 'resource-path'
  | 'allowed-tools'
  | 'completion-criteria'
  | 'last-error'
  | 'repair-fields'
  | 'retry-instruction';

export const ASSISTANCE_BLOCK_KINDS: ReadonlySet<AssistanceBlockKind> = new Set([
  'goal',
  'current-step',
  'next-action',
  'resource-path',
  'allowed-tools',
  'completion-criteria',
  'last-error',
  'repair-fields',
  'retry-instruction',
]);

// ---------------------------------------------------------------------------
// AssistanceBlock.
// ---------------------------------------------------------------------------

/**
 * One structured context block delivered to the agent. `kind` discriminates the
 * block (a fixed vocabulary the renderer switches on); `content` is the
 * human-readable text for that block. Pure data.
 */
export interface AssistanceBlock {
  readonly kind: AssistanceBlockKind;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// AssistanceEvent.
// ---------------------------------------------------------------------------

/**
 * The set of context blocks that fire at one lifecycle event. `event`
 * discriminates the lifecycle moment; `blocks` is the ordered list of blocks
 * rendered into the agent prompt at that moment.
 */
export interface AssistanceEvent {
  readonly event: AssistanceEventName;
  readonly blocks: readonly AssistanceBlock[];
}

// ---------------------------------------------------------------------------
// AssistanceBudgets.
// ---------------------------------------------------------------------------

/**
 * Budgets bounding agent assistance for one node. All optional and defaulting
 * to undefined (unlimited) so a module declares only the budgets it cares
 * about. When present, values are non-negative integers.
 *
 *   `maxTokensPerBlock` — cap on rendered tokens per block.
 *   `maxBlocksPerEvent` — cap on the number of blocks rendered per event.
 *   `maxRetriesBeforeEscalate` — recovery retries before assistance escalates.
 */
export interface AssistanceBudgets {
  readonly maxTokensPerBlock?: number;
  readonly maxBlocksPerEvent?: number;
  readonly maxRetriesBeforeEscalate?: number;
}

// ---------------------------------------------------------------------------
// AgentAssistanceDefinition.
// ---------------------------------------------------------------------------

/**
 * Per-node agent assistance definition. `mode` sets the overall verbosity;
 * `events` map lifecycle events to context blocks; `budgets` bound the
 * assistance. Pure data.
 */
export interface AgentAssistanceDefinition {
  readonly nodeId: string;
  readonly mode: AssistanceMode;
  readonly events: readonly AssistanceEvent[];
  readonly budgets: AssistanceBudgets;
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

/**
 * Validate an `AssistanceBlock`: assert canonical serializability, then check
 * `kind` is a valid block kind and `content` is a string.
 */
export async function validateAssistanceBlock(
  value: unknown,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  try {
    _assertCanonicalSync(value);
  } catch (e) {
    errors.push(err('NOT_CANONICAL', '$', (e as Error).message));
    return { ok: false, errors };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      errors: [err('NOT_OBJECT', '$', 'AssistanceBlock must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.kind !== 'string' ||
    !ASSISTANCE_BLOCK_KINDS.has(v.kind as AssistanceBlockKind)
  ) {
    errors.push(
      err(
        'BAD_KIND',
        'kind',
        `kind must be one of ${[...ASSISTANCE_BLOCK_KINDS].join('|')}`,
      ),
    );
  }
  if (typeof v.content !== 'string') {
    errors.push(err('BAD_CONTENT', 'content', 'content must be a string'));
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function validateBudgets(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(err('BAD_BUDGETS', path, `${path} must be a plain object`));
    return;
  }
  const v = value as Record<string, unknown>;
  const numericFields = ['maxTokensPerBlock', 'maxBlocksPerEvent', 'maxRetriesBeforeEscalate'];
  for (const f of numericFields) {
    if (v[f] !== undefined) {
      if (
        typeof v[f] !== 'number' ||
        !Number.isFinite(v[f] as number) ||
        !Number.isInteger(v[f] as number) ||
        (v[f] as number) < 0
      ) {
        errors.push(
          err('BAD_BUDGET', `${path}.${f}`, `${f} must be a non-negative integer if present`),
        );
      }
    }
  }
}

/**
 * Validate an `AgentAssistanceDefinition`: assert canonical serializability,
 * then check `nodeId`, `mode` (enum), `events` (each validated, with `event`
 * enum enforcement), and `budgets`.
 */
export async function validateAgentAssistanceDefinition(
  value: unknown,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  try {
    _assertCanonicalSync(value);
  } catch (e) {
    errors.push(err('NOT_CANONICAL', '$', (e as Error).message));
    return { ok: false, errors };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      errors: [err('NOT_OBJECT', '$', 'AgentAssistanceDefinition must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.nodeId !== 'string' || v.nodeId.length === 0) {
    errors.push(err('BAD_NODE_ID', 'nodeId', 'nodeId must be a non-empty string'));
  }
  if (typeof v.mode !== 'string' || !ASSISTANCE_MODES.has(v.mode as AssistanceMode)) {
    errors.push(
      err('BAD_MODE', 'mode', `mode must be one of ${[...ASSISTANCE_MODES].join('|')}`),
    );
  }
  if (!Array.isArray(v.events)) {
    errors.push(err('BAD_EVENTS', 'events', 'events must be an array'));
  } else {
    for (let i = 0; i < v.events.length; i++) {
      const ev = v.events[i];
      // validate the event shell synchronously (canonical already asserted)
      if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) {
        errors.push(err('BAD_EVENT', `events[${i}]`, 'event must be a plain object'));
        continue;
      }
      const e = ev as Record<string, unknown>;
      if (
        typeof e.event !== 'string' ||
        !ASSISTANCE_EVENT_NAMES.has(e.event as AssistanceEventName)
      ) {
        errors.push(
          err(
            'BAD_EVENT_NAME',
            `events[${i}].event`,
            `event must be one of ${[...ASSISTANCE_EVENT_NAMES].join('|')}`,
          ),
        );
      }
      if (!Array.isArray(e.blocks)) {
        errors.push(
          err('BAD_BLOCKS', `events[${i}].blocks`, 'blocks must be an array'),
        );
      } else {
        for (let j = 0; j < e.blocks.length; j++) {
          const br = await validateAssistanceBlock(e.blocks[j]);
          if (!br.ok) {
            for (const be of br.errors) {
              errors.push(err(be.code, `events[${i}].blocks[${j}].${be.path}`, be.message));
            }
          }
        }
      }
    }
  }
  validateBudgets(v.budgets, 'budgets', errors);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
