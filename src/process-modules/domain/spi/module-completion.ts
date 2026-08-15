/**
 * W1-A6 — ModuleCompletion: the explicit terminal envelope that replaces the
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 10.
 * Plan: §7.5.6.
 *
 * ── One-directional reference (acyclic since Wave 8 BLOCKER 2) ────────────
 *
 * `ModuleCompletion.outputEnvelope: ProcessModuleOutputEnvelope` is a
 * ONE-DIRECTIONAL edge: completion → envelope. The envelope does NOT point
 * back (the previous `ProcessModuleOutputEnvelope.completion` field was
 * removed — it created a type cycle that Delivery/Formalization closed at
 * runtime with a real back-reference, breaking JSON persistence). The model
 * is now a serializable tree.
 *
 * This file is PURE: one data type + one pure validator. No behavior.
 */

import type { ProcessModuleOutputEnvelope, ValidationResult, ValidationError } from './production-envelope.js';

// Re-export the shared validation shapes so consumers of module-completion can
// import ValidationResult / ValidationError from either file. (Type-only
// re-export; does not create a runtime edge.)
export type { ValidationResult, ValidationError } from './production-envelope.js';

// ---------------------------------------------------------------------------
// assertCanonicalSerializable — W1-A1 integration path with an inline
// isolation fallback. Same approach as production-envelope.ts; see the header
// there for the full rationale. Duplicated as a local resolver because this
// module must stay independently importable (it sits on the type cycle).
// ---------------------------------------------------------------------------

type AssertCanonical = (value: unknown) => void;

function fallbackAssertCanonicalSerializable(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    const t = typeof v;
    if (t === 'function') {
      throw new Error('not canonical serializable: function value');
    }
    if (t === 'symbol') {
      throw new Error('not canonical serializable: symbol value');
    }
    if (t === 'number' && !Number.isFinite(v as number)) {
      throw new Error('not canonical serializable: non-finite number');
    }
    if (v === null || t !== 'object') continue;
    if (v instanceof Map) {
      throw new Error('not canonical serializable: Map');
    }
    if (v instanceof Set) {
      throw new Error('not canonical serializable: Set');
    }
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
// ModuleCompletion.
// ---------------------------------------------------------------------------

/**
 * (plan §7.5.6). A module signals it is DONE by emitting a `ModuleCompletion`
 * that points back at the full output envelope and declares whether the
 * outcome is terminal.
 *
 *   `outcome`       — the module's declared outcome code (repeated here so the
 *                     completion is self-describing without dereferencing the
 *                     envelope).
 *   `outputEnvelope`— the complete immutable module output (the type cycle).
 *   `terminal`      — whether this outcome ends the module run (mirrors
 *                     OutcomeDefinition.terminal).
 */
export interface ModuleCompletion {
  readonly outcome: string;
  readonly outputEnvelope: ProcessModuleOutputEnvelope;
  readonly terminal: boolean;
}

// ---------------------------------------------------------------------------
// Validator.
// ---------------------------------------------------------------------------

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

/**
 * Validate a `ModuleCompletion`: assert canonical serializability, then check
 * `outcome` is a non-empty string and `terminal` is a boolean. The
 * `outputEnvelope` field is checked for presence and shape only (deep
 * validation of the envelope is the barrel/caller's job — the envelope is a
 * leaf with no back-reference since Wave 8 BLOCKER 2, so there is no
 * recursion concern, but we keep the shell check cheap and non-recursive).
 */
export async function validateModuleCompletion(
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
      errors: [err('NOT_OBJECT', '$', 'ModuleCompletion must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.outcome !== 'string' || v.outcome.length === 0) {
    errors.push(err('BAD_OUTCOME', 'outcome', 'outcome must be a non-empty string'));
  }
  if (typeof v.terminal !== 'boolean') {
    errors.push(err('BAD_TERMINAL', 'terminal', 'terminal must be a boolean'));
  }
  if (
    typeof v.outputEnvelope !== 'object' ||
    v.outputEnvelope === null ||
    Array.isArray(v.outputEnvelope)
  ) {
    errors.push(
      err('BAD_OUTPUT_ENVELOPE', 'outputEnvelope', 'outputEnvelope must be a plain object'),
    );
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
