/**
 * W1-A6 — Recovery definitions: re-export the existing module-agnostic
 * recovery contracts from `domain/recovery.ts` and add the pure definition
 * types the plan names but the domain did not yet carry.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 11.
 * Plan: §8.10 (RecoveryAction), RecoveryPolicyBinding.
 *
 * This file does NOT modify `domain/recovery.ts` (Wave 1 anti-scope). It only
 * imports from it — a domain→domain edge the dependency-direction ratchet
 * permits. PURE: data types + one pure validator, no behavior.
 */

import type { ValidationError, ValidationResult } from './production-envelope.js';
export type { ValidationError, ValidationResult } from './production-envelope.js';

// Re-export the existing module-agnostic recovery contracts so consumers of the
// new SPI surface can import the full recovery vocabulary from one place.
export type {
  RecoveryIssue,
  RecoveryFeedback,
  RecoveryFinding,
  RecoverySubjectRef,
  RecoveryReasonCode,
  RecoveryDisposition,
  RecoveryFindingSeverity,
  RecoverySourceProduction,
} from '../recovery.js';
// Schema-id constants are `as const` values, not types — re-export them as
// runtime values too.
export {
  RECOVERY_ISSUE_SCHEMA,
  RECOVERY_FEEDBACK_SCHEMA,
} from '../recovery.js';

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
// RecoveryAction — the runtime-owned recovery action union (plan §8.10).
// ---------------------------------------------------------------------------

/**
 * The set of recovery actions the generic runtime may take when a verifier
 * node emits a RecoveryIssue. Plan §8.10. The runtime owns HOW the issue is
 * retried; this union is the closed vocabulary of actions it may choose.
 *
 *   'retry-current-node'   — re-execute the node that failed.
 *   'return-to-producer'   — route feedback back to the producing node.
 *   'enter-recovery-node'  — jump to a declared repair node.
 *   'request-human'        — park for a human decision.
 *   'pause-external'       — pause an external-side process.
 *   'escalate'             — escalate beyond the module's recovery budget.
 *   'terminate'            — end the run.
 */
export type RecoveryAction =
  | 'retry-current-node'
  | 'return-to-producer'
  | 'enter-recovery-node'
  | 'request-human'
  | 'pause-external'
  | 'escalate'
  | 'terminate';

export const RECOVERY_ACTIONS: ReadonlySet<RecoveryAction> = new Set([
  'retry-current-node',
  'return-to-producer',
  'enter-recovery-node',
  'request-human',
  'pause-external',
  'escalate',
  'terminate',
]);

// ---------------------------------------------------------------------------
// RecoveryPolicyBinding — per-node recovery action map.
// ---------------------------------------------------------------------------

/**
 * Binds a flow node to a recovery action map. `nodeId` identifies the verifier
 * node; `actionMap` maps module-owned reason/event codes to runtime actions.
 * The keys of `actionMap` are module vocabulary (opaque to the runtime); the
 * values MUST be members of `RecoveryAction`.
 */
export interface RecoveryPolicyBinding {
  readonly nodeId: string;
  readonly actionMap: Readonly<Record<string, RecoveryAction>>;
}

// ---------------------------------------------------------------------------
// Validator.
// ---------------------------------------------------------------------------

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

/**
 * Validate a `RecoveryPolicyBinding`: assert canonical serializability, then
 * check `nodeId` is a non-empty string and every value in `actionMap` is a
 * valid `RecoveryAction`.
 */
export async function validateRecoveryPolicyBinding(
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
      errors: [err('NOT_OBJECT', '$', 'RecoveryPolicyBinding must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.nodeId !== 'string' || v.nodeId.length === 0) {
    errors.push(err('BAD_NODE_ID', 'nodeId', 'nodeId must be a non-empty string'));
  }
  if (typeof v.actionMap !== 'object' || v.actionMap === null || Array.isArray(v.actionMap)) {
    errors.push(err('BAD_ACTION_MAP', 'actionMap', 'actionMap must be a plain object'));
  } else {
    const map = v.actionMap as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      const action = map[key];
      if (typeof action !== 'string' || !RECOVERY_ACTIONS.has(action as RecoveryAction)) {
        errors.push(
          err(
            'BAD_ACTION',
            `actionMap.${key}`,
            `action must be one of ${[...RECOVERY_ACTIONS].join('|')}`,
          ),
        );
      }
    }
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
