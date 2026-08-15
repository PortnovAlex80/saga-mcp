/**
 * W1-A6 — Tool contribution + capability/guard bindings.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 12.
 * Plan: §11.4.
 *
 * A `ModuleToolContribution` declares one MCP tool a module contributes to the
 * runtime. `CapabilityRequirement` declares a capability the module needs.
 * `GuardBinding` binds a guard (policy) to a scope. All three are pure
 * serializable data; the runtime persists and forwards them without
 * interpreting their ref strings.
 *
 * ── ContractRef is structural here, not imported ──────────────────────────
 *
 * `inputContractRef` / `outputContractRef` reference the `ContractRef` shape
 * owned by W1-A5 (`./contract-ref.ts`). W1-A5's file is NOT present in this
 * isolated W1-A6 worktree, so importing it would fail `tsc`. Instead we
 * declare a local structural alias (`ToolContractRef`) with the SAME three
 * fields (`schemaId`, `version`, `digest`) that `ContractRef` carries. This is
 * a structural mirror, identical to how `production-envelope.ts` mirrors
 * `NodeProduction` and how `domain/recovery.ts` mirrors
 * `RecoverySourceProduction`. A later wave can unify the alias with the real
 * `ContractRef` import without touching call sites.
 *
 * This file is PURE: data types + pure validators. No behavior.
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
// ToolContractRef — structural alias of W1-A5's ContractRef.
// ---------------------------------------------------------------------------

/**
 * Structural alias of `ContractRef` from `./contract-ref.ts` (W1-A5). Same
 * three fields. See file header for why this is mirrored rather than imported.
 */
export interface ToolContractRef {
  readonly schemaId: string;
  readonly version: string;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// GuardBinding.
// ---------------------------------------------------------------------------

/**
 * Binds a guard (policy) reference to a scope. `ref` is a module-owned opaque
 * identifier (e.g. a logical guard id); `scope` names the surface the guard
 * covers (e.g. `'call'`, `'submit'`, `'node'`). Pure data.
 */
export interface GuardBinding {
  readonly ref: string;
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// CapabilityRequirement.
// ---------------------------------------------------------------------------

/**
 * Declares a capability the module requires from the runtime. `ref` + `version`
 * identify the capability; `optional` (default false) marks it as nice-to-have.
 */
export interface CapabilityRequirement {
  readonly ref: string;
  readonly version: string;
  readonly optional?: boolean;
}

// ---------------------------------------------------------------------------
// ModuleToolContribution (plan §11.4).
// ---------------------------------------------------------------------------

export type ToolIdempotency = 'none' | 'idempotent';
export type ToolSideEffect = 'none' | 'read' | 'write' | 'external';

export const TOOL_IDEMPOTENCY_VALUES: ReadonlySet<ToolIdempotency> = new Set([
  'none',
  'idempotent',
]);

export const TOOL_SIDE_EFFECT_VALUES: ReadonlySet<ToolSideEffect> = new Set([
  'none',
  'read',
  'write',
  'external',
]);

/**
 * Declares one MCP tool a module contributes to the runtime (plan §11.4).
 *
 *   `logicalId`         — namespaced tool id (e.g. `'discovery.proposal_submit'`).
 *   `version`           — tool semantic version.
 *   `inputContractRef`  — contract ref for the tool's input schema.
 *   `outputContractRef` — contract ref for the tool's output schema.
 *   `handlerRef`        — opaque reference to the handler implementation.
 *   `callTemplateRef?`  — optional call template resource reference.
 *   `checklistRef?`     — optional checklist resource reference.
 *   `errorHintRef?`     — optional error-hint resource reference.
 *   `guardBindings`     — guards bound to this tool's scopes.
 *   `idempotency`       — `'none'` (default) or `'idempotent'`.
 *   `sideEffect`        — `'none'` | `'read'` | `'write'` | `'external'`.
 */
export interface ModuleToolContribution {
  readonly logicalId: string;
  readonly version: string;
  readonly inputContractRef: ToolContractRef;
  readonly outputContractRef: ToolContractRef;
  readonly handlerRef: string;
  readonly callTemplateRef?: string;
  readonly checklistRef?: string;
  readonly errorHintRef?: string;
  readonly guardBindings: readonly GuardBinding[];
  readonly idempotency: ToolIdempotency;
  readonly sideEffect: ToolSideEffect;
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

function validateNonEmptyString(
  v: Record<string, unknown>,
  field: string,
  errors: ValidationError[],
  code: string,
): void {
  if (typeof v[field] !== 'string' || (v[field] as string).length === 0) {
    errors.push(err(code, field, `${field} must be a non-empty string`));
  }
}

function validateToolContractRef(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(err('BAD_CONTRACT_REF', path, `${path} must be a plain object`));
    return;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schemaId !== 'string' || v.schemaId.length === 0) {
    errors.push(err('BAD_SCHEMA_ID', `${path}.schemaId`, 'schemaId must be a non-empty string'));
  }
  if (typeof v.version !== 'string' || v.version.length === 0) {
    errors.push(err('BAD_VERSION', `${path}.version`, 'version must be a non-empty string'));
  }
  if (typeof v.digest !== 'string' || v.digest.length === 0) {
    errors.push(err('BAD_DIGEST', `${path}.digest`, 'digest must be a non-empty string'));
  }
}

/**
 * Validate a `GuardBinding`: assert canonical serializability, then check `ref`
 * and `scope` are non-empty strings.
 */
export async function validateGuardBinding(
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
      errors: [err('NOT_OBJECT', '$', 'GuardBinding must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  validateNonEmptyString(v, 'ref', errors, 'BAD_REF');
  validateNonEmptyString(v, 'scope', errors, 'BAD_SCOPE');
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Validate a `CapabilityRequirement`: assert canonical serializability, then
 * check `ref`/`version` are non-empty strings and `optional` (if present) is a
 * boolean.
 */
export async function validateCapabilityRequirement(
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
      errors: [err('NOT_OBJECT', '$', 'CapabilityRequirement must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  validateNonEmptyString(v, 'ref', errors, 'BAD_REF');
  validateNonEmptyString(v, 'version', errors, 'BAD_VERSION');
  if (v.optional !== undefined && typeof v.optional !== 'boolean') {
    errors.push(err('BAD_OPTIONAL', 'optional', 'optional must be a boolean if present'));
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Validate a `ModuleToolContribution`: assert canonical serializability, then
 * check every field including enum enforcement on `idempotency` and
 * `sideEffect`.
 */
export async function validateModuleToolContribution(
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
      errors: [err('NOT_OBJECT', '$', 'ModuleToolContribution must be a plain object')],
    };
  }
  const v = value as Record<string, unknown>;
  validateNonEmptyString(v, 'logicalId', errors, 'BAD_LOGICAL_ID');
  validateNonEmptyString(v, 'version', errors, 'BAD_VERSION');
  validateToolContractRef(v.inputContractRef, 'inputContractRef', errors);
  validateToolContractRef(v.outputContractRef, 'outputContractRef', errors);
  validateNonEmptyString(v, 'handlerRef', errors, 'BAD_HANDLER_REF');
  if (v.callTemplateRef !== undefined) {
    if (typeof v.callTemplateRef !== 'string' || v.callTemplateRef.length === 0) {
      errors.push(err('BAD_CALL_TEMPLATE_REF', 'callTemplateRef', 'callTemplateRef must be a non-empty string if present'));
    }
  }
  if (v.checklistRef !== undefined) {
    if (typeof v.checklistRef !== 'string' || v.checklistRef.length === 0) {
      errors.push(err('BAD_CHECKLIST_REF', 'checklistRef', 'checklistRef must be a non-empty string if present'));
    }
  }
  if (v.errorHintRef !== undefined) {
    if (typeof v.errorHintRef !== 'string' || v.errorHintRef.length === 0) {
      errors.push(err('BAD_ERROR_HINT_REF', 'errorHintRef', 'errorHintRef must be a non-empty string if present'));
    }
  }
  if (!Array.isArray(v.guardBindings)) {
    errors.push(err('BAD_GUARD_BINDINGS', 'guardBindings', 'guardBindings must be an array'));
  } else {
    for (let i = 0; i < v.guardBindings.length; i++) {
      const gr = await validateGuardBinding(v.guardBindings[i]);
      if (!gr.ok) {
        for (const e of gr.errors) {
          errors.push(err(e.code, `guardBindings[${i}].${e.path}`, e.message));
        }
      }
    }
  }
  if (
    typeof v.idempotency !== 'string' ||
    !TOOL_IDEMPOTENCY_VALUES.has(v.idempotency as ToolIdempotency)
  ) {
    errors.push(
      err(
        'BAD_IDEMPOTENCY',
        'idempotency',
        `idempotency must be one of ${[...TOOL_IDEMPOTENCY_VALUES].join('|')}`,
      ),
    );
  }
  if (
    typeof v.sideEffect !== 'string' ||
    !TOOL_SIDE_EFFECT_VALUES.has(v.sideEffect as ToolSideEffect)
  ) {
    errors.push(
      err(
        'BAD_SIDE_EFFECT',
        'sideEffect',
        `sideEffect must be one of ${[...TOOL_SIDE_EFFECT_VALUES].join('|')}`,
      ),
    );
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
