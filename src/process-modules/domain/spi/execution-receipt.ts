/**
 * W1-A6 — Driver-neutral execution receipt.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row
 * (execution-receipt). Plan: §10.14, §13.16, C061.
 *
 * The existing `NodeExecutionReceipt` (in `application/node-executor.ts`)
 * already carries physical execution evidence and is pure. Wave 1 adds a
 * DRIVER-NEUTRAL variant: one that does NOT bake board/task/WorkIntent IDs
 * into its base fields. Those substrate-specific identifiers travel inside
 * `adapterData`, an opaque record the driver fills and the runtime forwards
 * without interpreting.
 *
 * Why driver-neutral? A board-driver receipt and an MCP-driver receipt share
 * the same physical shape (`schemaVersion`, `nodeRunId`, `attempt`,
 * `runtimeEvent`, `driverKind`); only their substrate payloads differ. Keeping
 * the substrate payload in `adapterData` means the runtime can persist, hash
 * and route receipts without switching on driver kind (plan §10.14, §13.16,
 * C061).
 *
 * This file is PURE: one data type + one pure validator. No behavior. It
 * imports `FlowNodeKind` from `../process-module.js` — a domain→domain edge
 * the dependency-direction ratchet permits.
 */

import type { FlowNodeKind } from '../process-module.js';

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
// DriverNeutralExecutionReceipt.
// ---------------------------------------------------------------------------

export type DriverRuntimeEvent = 'completed' | 'failed' | 'paused';

export const DRIVER_RUNTIME_EVENTS: ReadonlySet<DriverRuntimeEvent> = new Set([
  'completed',
  'failed',
  'paused',
]);

export const FLOW_NODE_KINDS: ReadonlySet<FlowNodeKind> = new Set([
  'lm',
  'kernel',
  'human',
  'composite',
]);

/**
 * Driver-neutral evidence that one physical node execution finished.
 *
 *   `schemaVersion` — the receipt schema id (e.g. `'factory.driver-neutral-receipt.v1'`).
 *   `nodeRunId`     — durable NodeRun id.
 *   `attempt`       — attempt number within the node run (1-based).
 *   `runtimeEvent`  — physical status: 'completed' | 'failed' | 'paused'.
 *   `driverKind`    — which FlowNodeKind drove the execution.
 *   `adapterData?`  — opaque substrate payload. Board/task/WorkIntent IDs and
 *                     any driver-specific evidence go HERE, not in base fields
 *                     (plan §10.14, §13.16, C061). The runtime persists and
 *                     forwards it without interpreting its keys.
 */
export interface DriverNeutralExecutionReceipt {
  readonly schemaVersion: string;
  readonly nodeRunId: number;
  readonly attempt: number;
  readonly runtimeEvent: DriverRuntimeEvent;
  readonly driverKind: FlowNodeKind;
  readonly adapterData?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Validator.
// ---------------------------------------------------------------------------

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

/**
 * Validate a `DriverNeutralExecutionReceipt`: assert canonical serializability,
 * then check `schemaVersion` is a non-empty string, `nodeRunId`/`attempt` are
 * non-negative integers, `runtimeEvent` and `driverKind` are valid enum values,
 * and `adapterData` (if present) is a plain object.
 */
export async function validateDriverNeutralExecutionReceipt(
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
      errors: [err('NOT_OBJECT', '$', 'DriverNeutralExecutionReceipt must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schemaVersion !== 'string' || v.schemaVersion.length === 0) {
    errors.push(err('BAD_SCHEMA_VERSION', 'schemaVersion', 'schemaVersion must be a non-empty string'));
  }
  if (
    typeof v.nodeRunId !== 'number' ||
    !Number.isFinite(v.nodeRunId) ||
    !Number.isInteger(v.nodeRunId) ||
    v.nodeRunId < 0
  ) {
    errors.push(err('BAD_NODE_RUN_ID', 'nodeRunId', 'nodeRunId must be a non-negative integer'));
  }
  if (
    typeof v.attempt !== 'number' ||
    !Number.isFinite(v.attempt) ||
    !Number.isInteger(v.attempt) ||
    v.attempt < 0
  ) {
    errors.push(err('BAD_ATTEMPT', 'attempt', 'attempt must be a non-negative integer'));
  }
  if (
    typeof v.runtimeEvent !== 'string' ||
    !DRIVER_RUNTIME_EVENTS.has(v.runtimeEvent as DriverRuntimeEvent)
  ) {
    errors.push(
      err(
        'BAD_RUNTIME_EVENT',
        'runtimeEvent',
        `runtimeEvent must be one of ${[...DRIVER_RUNTIME_EVENTS].join('|')}`,
      ),
    );
  }
  if (typeof v.driverKind !== 'string' || !FLOW_NODE_KINDS.has(v.driverKind as FlowNodeKind)) {
    errors.push(
      err(
        'BAD_DRIVER_KIND',
        'driverKind',
        `driverKind must be one of ${[...FLOW_NODE_KINDS].join('|')}`,
      ),
    );
  }
  if (v.adapterData !== undefined) {
    if (
      typeof v.adapterData !== 'object' ||
      v.adapterData === null ||
      Array.isArray(v.adapterData)
    ) {
      errors.push(err('BAD_ADAPTER_DATA', 'adapterData', 'adapterData must be a plain object if present'));
    }
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
