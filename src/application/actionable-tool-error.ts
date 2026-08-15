/**
 * W6-A5 — Universal ActionableToolError.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md (W6-A5).
 * Plan: §11.8 (all validation failures use ActionableToolError), §11.9
 * (call-instance correlation), §11.10 (gateway preserves the structured error
 * across MCP serialization — must NOT flatten into one textual Error string),
 * §13.13 (src/tools/discovery-tool-args.ts has a hard-coded Discovery tracker workflow
 * and cannot serve arbitrary module tools).
 *
 * WHAT THIS MODULE OWNS
 *
 * The platform-owned, module-agnostic *shape* of an actionable validation
 * failure. Every field in §11.8 is carried as STRUCTURED DATA, not prose:
 *
 *   11.8.1  code                    — stable machine code (SCREAMING_SNAKE).
 *   11.8.2  message                 — human-readable diagnostic phrase.
 *   11.8.3  fieldPath               — dotted path to the offending argument.
 *   11.8.4  expected / actual       — the contract value vs. the received value.
 *   11.8.5  sourceOfCorrectValue    — WHERE the worker should read the right value.
 *   11.8.6  callInstanceRef         — exact call instance (§11.9 correlation).
 *   11.8.7  checklistRef            — checklist resource the worker should re-read.
 *   11.8.8  trackerRef              — tracker doc the worker should update/re-read.
 *   11.8.9  resumeStep              — the step to resume at after the repair.
 *   11.8.10 retry                   — may the caller retry, or is it terminal /
 *                                     needs-human / needs a fresh execution?
 *
 * WHY IT REPLACES THE HARD-CODED DISCOVERY STRINGS (§13.13)
 *
 * `src/tools/discovery-tool-args.ts` enriches every error with the literal
 * `'[Workflow: Read your stage tracker docs/discovery/project-<N>-discovery-stage.md, ...]'`
 * and a Discovery-only `PAYLOAD_FIELD_SOURCES` map. That bakes the Discovery
 * module identity into the platform gateway and cannot serve any other module.
 * This module makes the tracker reference, checklist reference, resume step, and
 * source-of-correct-value PARAMETERIZED: a Discovery caller passes its own
 * `trackerRef`, a Formalization caller passes a different one, and the platform
 * never switches on a module name. The hard-coded literal is replaced by
 * `renderWorkflowHint({ trackerRef, checklistRef, resumeStep })`.
 *
 * ANTI-SCOPE (spec §3)
 *
 * This lane does NOT rewrite `src/index.ts` or `src/tools/discovery-tool-args.ts`. The
 * integrator wires the universal type into the gateway at the Wave 11 cutover.
 * Here we only provide the type, validators, builder, transport round-trip, and
 * stable renderer.
 *
 * PURITY / DEPENDENCIES
 *
 * Zero source-tree dependencies: only the TypeScript standard library. This is
 * the universal error format referenced from many layers (gateway, call
 * correlation, tool handlers), so it must not import from any of them. It is
 * pure data + pure functions and is exercised by `node --test` against compiled
 * output.
 */

// ---------------------------------------------------------------------------
// Retry permission (§11.8.10).
// ---------------------------------------------------------------------------

/**
 * What the caller may do after receiving this error.
 *
 *   `'retry'`              — safe to retry after applying the repair hints
 *                            (the common case: fix the field, call again).
 *   `'do-not-retry'`       — terminal for this call; retrying will not help
 *                            (e.g. a UNIQUE violation already persisted, or a
 *                            guard authoritative denial).
 *   `'needs-human'`        — blocked; a human must answer before retry
 *                            (route to worker_ask_need).
 *   `'restart-execution'`  — the current execution/fence is invalid; the worker
 *                            must obtain a fresh execution_id before retrying.
 */
export type RetryPermission =
  | 'retry'
  | 'do-not-retry'
  | 'needs-human'
  | 'restart-execution';

export const RETRY_PERMISSION_VALUES: ReadonlySet<RetryPermission> = new Set([
  'retry',
  'do-not-retry',
  'needs-human',
  'restart-execution',
]);

// ---------------------------------------------------------------------------
// Call instance reference (§11.9).
// ---------------------------------------------------------------------------

/**
 * Exact call instance reference (§11.9: every consequential call carries a
 * platform-owned call-instance correlation value). This is a STRUCTURAL type —
 * W6-A6 (`application/call-correlation.ts`) owns the richer receipt envelope;
 * its correlation value satisfies `callId` here without an import edge.
 */
export interface CallInstanceRef {
  /** Platform-owned call-instance correlation value (never agent-inferred). */
  readonly callId: string;
  /** Logical tool name the call targeted, if known. */
  readonly toolName?: string;
  /** Execution fence token in effect, if any. */
  readonly executionId?: string;
}

// ---------------------------------------------------------------------------
// ActionableToolError (§11.8).
// ---------------------------------------------------------------------------

/**
 * The universal, module-agnostic structured validation failure (plan §11.8).
 *
 * Every field maps 1:1 to a §11.8 sub-clause. Optional fields are `undefined`
 * when not applicable (not null, not empty) so the renderer and transport layer
 * can distinguish "absent" from "present but empty".
 */
export interface ActionableToolError {
  /** §11.8.1 — stable machine code, SCREAMING_SNAKE_CASE (e.g. `BAD_ARGUMENT`). */
  readonly code: string;
  /** §11.8.2 — human-readable diagnostic phrase. */
  readonly message: string;
  /** §11.8.3 — dotted path to the offending argument (e.g. `payload.confidence`). */
  readonly fieldPath?: string;
  /** §11.8.4 — the contract value the gateway/validator expected. */
  readonly expected?: string;
  /** §11.8.4 — the received value, rendered as a stable string. */
  readonly actual?: string;
  /** §11.8.5 — WHERE the worker should read the correct value. */
  readonly sourceOfCorrectValue?: string;
  /** §11.8.6 — exact call instance reference. */
  readonly callInstanceRef?: CallInstanceRef;
  /** §11.8.7 — checklist resource reference the worker should re-read. */
  readonly checklistRef?: string;
  /** §11.8.8 — tracker document reference (parameterized; no module name). */
  readonly trackerRef?: string;
  /** §11.8.9 — the step to resume at after applying the repair. */
  readonly resumeStep?: string;
  /** §11.8.10 — retry permission. */
  readonly retry: RetryPermission;
}

/**
 * Transport envelope discriminator (§11.10). The gateway tags the structured
 * error so it can be detected and reconstructed after MCP JSON serialization
 * (which has no class identity).
 */
export const ACTIONABLE_TOOL_ERROR_ENVELOPE_KIND =
  'saga.actionable-tool-error.v1' as const;

/**
 * The JSON-safe transport envelope. This is what crosses the MCP boundary.
 * `toJSON` of an ActionableToolError must produce exactly this shape.
 */
export interface ActionableToolErrorEnvelope {
  readonly kind: typeof ACTIONABLE_TOOL_ERROR_ENVELOPE_KIND;
  readonly error: ActionableToolError;
}

// ---------------------------------------------------------------------------
// Stable-code validation.
// ---------------------------------------------------------------------------

/**
 * Stable codes are SCREAMING_SNAKE_CASE, optionally dotted/colons for nesting
 * (e.g. `BAD_ARGUMENT`, `GUARD.AUTHORITY_DENIED`, `SCHEMA_VERSION_MISMATCH`).
 * Must be ASCII letters/digits/_/./:, 1..64 chars, start with a letter.
 */
const STABLE_CODE_RE = /^[A-Z][A-Z0-9_.:/]{0,63}$/;

/**
 * Field paths are dotted references into the call arguments
 * (e.g. `payload.confidence`, `dimension_assessments.evidence_grounding`).
 * Allow alnum, _, ., [, ], - (for array indices and kebab field names).
 */
const FIELD_PATH_RE = /^[A-Za-z0-9_.[\]:\-]+$/;

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

/** Validation error raised by the actionable-error validators themselves. */
export class ActionableToolErrorSchemaError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[], message: string) {
    super(message);
    this.name = 'ActionableToolErrorSchemaError';
    this.fields = fields;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validateOptionalNonEmptyString(
  v: unknown,
  field: string,
  errors: string[],
): void {
  if (v === undefined) return;
  if (!isNonEmptyString(v)) {
    errors.push(`${field} must be a non-empty string when present`);
  }
}

/**
 * Validate a plain object as an {@link ActionableToolError}. Returns the typed
 * value on success; throws {@link ActionableToolErrorSchemaError} listing every
 * offending field otherwise. Pure.
 */
export function assertActionableToolError(value: unknown): asserts value is ActionableToolError {
  const errors: string[] = [];
  const fields: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ActionableToolErrorSchemaError(['$'], 'ActionableToolError must be a plain object');
  }
  const v = value as Record<string, unknown>;

  // §11.8.1 code — required, stable pattern.
  if (!isNonEmptyString(v.code)) {
    errors.push('code must be a non-empty string'); fields.push('code');
  } else if (!STABLE_CODE_RE.test(v.code)) {
    errors.push('code must be SCREAMING_SNAKE_CASE (A-Z, 0-9, _/.//:), start with a letter, max 64 chars');
    fields.push('code');
  }

  // §11.8.2 message — required, non-empty.
  if (!isNonEmptyString(v.message)) {
    errors.push('message must be a non-empty string'); fields.push('message');
  }

  // §11.8.3 fieldPath — optional, charset-constrained.
  if (v.fieldPath !== undefined) {
    if (!isNonEmptyString(v.fieldPath) || !FIELD_PATH_RE.test(v.fieldPath)) {
      errors.push('fieldPath must be a dotted path matching [A-Za-z0-9_.[]:-] when present');
      fields.push('fieldPath');
    }
  }

  // §11.8.4 expected/actual — optional non-empty strings.
  validateOptionalNonEmptyString(v.expected, 'expected', errors);
  if (errors.includes('expected must be a non-empty string when present')) fields.push('expected');
  validateOptionalNonEmptyString(v.actual, 'actual', errors);
  if (errors.includes('actual must be a non-empty string when present')) fields.push('actual');

  // §11.8.5 sourceOfCorrectValue — optional non-empty.
  validateOptionalNonEmptyString(v.sourceOfCorrectValue, 'sourceOfCorrectValue', errors);
  if (errors.some((e) => e.startsWith('sourceOfCorrectValue'))) fields.push('sourceOfCorrectValue');

  // §11.8.6 callInstanceRef — optional, { callId: non-empty }.
  if (v.callInstanceRef !== undefined) {
    const cir = v.callInstanceRef;
    if (typeof cir !== 'object' || cir === null || Array.isArray(cir)) {
      errors.push('callInstanceRef must be a plain object when present'); fields.push('callInstanceRef');
    } else {
      const c = cir as Record<string, unknown>;
      if (!isNonEmptyString(c.callId)) {
        errors.push('callInstanceRef.callId must be a non-empty string'); fields.push('callInstanceRef.callId');
      }
      if (c.toolName !== undefined && !isNonEmptyString(c.toolName)) {
        errors.push('callInstanceRef.toolName must be a non-empty string when present'); fields.push('callInstanceRef.toolName');
      }
      if (c.executionId !== undefined && !isNonEmptyString(c.executionId)) {
        errors.push('callInstanceRef.executionId must be a non-empty string when present'); fields.push('callInstanceRef.executionId');
      }
    }
  }

  // §11.8.7 checklistRef, §11.8.8 trackerRef, §11.8.9 resumeStep — optional non-empty.
  validateOptionalNonEmptyString(v.checklistRef, 'checklistRef', errors);
  if (errors.some((e) => e.startsWith('checklistRef'))) fields.push('checklistRef');
  validateOptionalNonEmptyString(v.trackerRef, 'trackerRef', errors);
  if (errors.some((e) => e.startsWith('trackerRef'))) fields.push('trackerRef');
  validateOptionalNonEmptyString(v.resumeStep, 'resumeStep', errors);
  if (errors.some((e) => e.startsWith('resumeStep'))) fields.push('resumeStep');

  // §11.8.10 retry — required enum.
  if (typeof v.retry !== 'string' || !RETRY_PERMISSION_VALUES.has(v.retry as RetryPermission)) {
    errors.push(`retry must be one of ${[...RETRY_PERMISSION_VALUES].join('|')}`);
    fields.push('retry');
  }

  if (errors.length > 0) {
    throw new ActionableToolErrorSchemaError(fields, errors.join('; '));
  }
}

/**
 * Type guard: true iff `value` is a valid {@link ActionableToolError}.
 */
export function isActionableToolError(value: unknown): value is ActionableToolError {
  try {
    assertActionableToolError(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

/**
 * Input to {@link buildActionableToolError}. `code` and `message` are required;
 * `retry` defaults to `'retry'`. Optional fields are omitted from the product
 * when `undefined` (never serialized as null or empty).
 */
export interface ActionableToolErrorInput {
  readonly code: string;
  readonly message: string;
  readonly fieldPath?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly sourceOfCorrectValue?: string;
  readonly callInstanceRef?: CallInstanceRef;
  readonly checklistRef?: string;
  readonly trackerRef?: string;
  readonly resumeStep?: string;
  readonly retry?: RetryPermission;
}

/**
 * Build a validated, frozen {@link ActionableToolError}. Throws
 * {@link ActionableToolErrorSchemaError} on any schema violation. `retry`
 * defaults to `'retry'` (the common case).
 *
 * `actual` may be passed as any JSON-serializable value; it is stringified via
 * {@link renderActual} so callers do not have to pre-format the offending value.
 */
export function buildActionableToolError(input: ActionableToolErrorInput): ActionableToolError {
  // Treat empty-string inputs for the optional §11.8 text fields as "present
  // but invalid": the caller meant to supply a value but gave nothing usable.
  // They must omit the field instead. This keeps the builder's contract aligned
  // with the validator (which requires these to be non-empty when present).
  for (const f of [
    'expected',
    'sourceOfCorrectValue',
    'checklistRef',
    'trackerRef',
    'resumeStep',
  ] as const) {
    const v = input[f];
    if (v !== undefined && !isNonEmptyString(v)) {
      throw new ActionableToolErrorSchemaError([f], `${f} must be a non-empty string when present; omit it instead of passing an empty string`);
    }
  }
  // `actual` may legitimately be any JSON value (number, object, ...). Only an
  // empty-string input is a misuse (renderActual('') would yield '""', hiding
  // that the caller supplied nothing useful) — reject it; omit instead.
  if (input.actual === '') {
    throw new ActionableToolErrorSchemaError(
      ['actual'],
      'actual must be a non-empty value when present; omit it instead of passing an empty string',
    );
  }
  const candidate: ActionableToolError = {
    code: input.code,
    message: input.message,
    retry: input.retry ?? 'retry',
    ...(input.fieldPath !== undefined && isNonEmptyString(input.fieldPath)
      ? { fieldPath: input.fieldPath } : {}),
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.actual !== undefined ? { actual: renderActual(input.actual) } : {}),
    ...(input.sourceOfCorrectValue !== undefined ? { sourceOfCorrectValue: input.sourceOfCorrectValue } : {}),
    ...(input.callInstanceRef !== undefined ? { callInstanceRef: input.callInstanceRef } : {}),
    ...(input.checklistRef !== undefined ? { checklistRef: input.checklistRef } : {}),
    ...(input.trackerRef !== undefined ? { trackerRef: input.trackerRef } : {}),
    ...(input.resumeStep !== undefined ? { resumeStep: input.resumeStep } : {}),
  };
  return adoptActionableToolError(candidate);
}

/**
 * Validate an already-shaped {@link ActionableToolError} and return a frozen,
 * canonical copy carrying ONLY the known fields (any stray keys are dropped).
 * Unlike {@link buildActionableToolError}, this does NOT re-render `actual` —
 * the input is treated as an already-produced error whose `actual` is already a
 * stable string. Used by {@link serializeActionableToolError} and
 * {@link deserializeActionableToolError} so a round-trip does not double-escape
 * the rendered value.
 */
function adoptActionableToolError(error: ActionableToolError): ActionableToolError {
  assertActionableToolError(error);
  const canonical: ActionableToolError = {
    code: error.code,
    message: error.message,
    retry: error.retry,
    ...(error.fieldPath !== undefined ? { fieldPath: error.fieldPath } : {}),
    ...(error.expected !== undefined ? { expected: error.expected } : {}),
    ...(error.actual !== undefined ? { actual: error.actual } : {}),
    ...(error.sourceOfCorrectValue !== undefined ? { sourceOfCorrectValue: error.sourceOfCorrectValue } : {}),
    ...(error.callInstanceRef !== undefined ? { callInstanceRef: error.callInstanceRef } : {}),
    ...(error.checklistRef !== undefined ? { checklistRef: error.checklistRef } : {}),
    ...(error.trackerRef !== undefined ? { trackerRef: error.trackerRef } : {}),
    ...(error.resumeStep !== undefined ? { resumeStep: error.resumeStep } : {}),
  };
  return Object.freeze(canonical);
}

// ---------------------------------------------------------------------------
// Actual-value rendering.
// ---------------------------------------------------------------------------

/**
 * Render an `actual` value to a stable string for §11.8.4. `undefined` becomes
 * the literal token `undefined` (so the worker sees the arg was absent, not
 * that rendering failed). Everything else uses stable JSON (sorted keys).
 */
export function renderActual(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(sortKeysStable(value));
  } catch {
    // Unserializable (function, symbol, circular) — fall back to String().
    return String(value);
  }
}

function sortKeysStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysStable);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeysStable((value as Record<string, unknown>)[k]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escaping (defense against value injection into the rendered text format).
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe interpolation into the rendered multi-line format.
 * Prevents a hostile or accidental value from forging new labeled lines (the
 * main attack vector: embedded newlines). Escapes backslash first, then
 * control chars.
 *
 *   `\` → `\\`
 *   `\n` → literal `\n`
 *   `\r` → literal `\r`
 *   `\t` → literal `\t`
 *   other < 0x20 → `\xHH`
 */
export function escapeErrorValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const cc = value.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (cc === 0x0a) out += '\\n';
    else if (cc === 0x0d) out += '\\r';
    else if (cc === 0x09) out += '\\t';
    else if (cc < 0x20) out += '\\x' + cc.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Render an {@link ActionableToolError} to a stable multi-line text form. Each
 * present field appears on its own line with a fixed label, in §11.8 order, so
 * the output is diffable and grep-detectable. Values are passed through
 * {@link escapeErrorValue} so an offending value cannot forge new lines.
 *
 * This renderer does NOT replace the structured envelope (§11.10): the gateway
 * MUST carry the structured object across MCP transport and may use this text
 */
export function renderActionableToolError(error: ActionableToolError): string {
  assertActionableToolError(error);
  const lines: string[] = [];
  lines.push(`[${escapeErrorValue(error.code)}] ${escapeErrorValue(error.message)}`);
  if (error.fieldPath !== undefined) {
    lines.push(`  Field: ${escapeErrorValue(error.fieldPath)}`);
  }
  if (error.expected !== undefined) {
    lines.push(`  Expected: ${escapeErrorValue(error.expected)}`);
  }
  if (error.actual !== undefined) {
    lines.push(`  Actual: ${escapeErrorValue(error.actual)}`);
  }
  if (error.sourceOfCorrectValue !== undefined) {
    lines.push(`  Source: ${escapeErrorValue(error.sourceOfCorrectValue)}`);
  }
  if (error.callInstanceRef !== undefined) {
    const cir = error.callInstanceRef;
    let seg = escapeErrorValue(cir.callId);
    if (cir.toolName !== undefined) seg += ` tool=${escapeErrorValue(cir.toolName)}`;
    if (cir.executionId !== undefined) seg += ` exec=${escapeErrorValue(cir.executionId)}`;
    lines.push(`  Call: ${seg}`);
  }
  if (error.checklistRef !== undefined) {
    lines.push(`  Checklist: ${escapeErrorValue(error.checklistRef)}`);
  }
  if (error.trackerRef !== undefined) {
    lines.push(`  Tracker: ${escapeErrorValue(error.trackerRef)}`);
  }
  if (error.resumeStep !== undefined) {
    lines.push(`  Resume: ${escapeErrorValue(error.resumeStep)}`);
  }
  lines.push(`  Retry: ${error.retry}`);
  return lines.join('\n');
}

/**
 * Render the workflow hint that replaces the hard-coded Discovery literal in
 * `src/tools/discovery-tool-args.ts` (§13.13). PARAMETERIZED: the caller supplies its
 * module's own `trackerRef`, `checklistRef`, and `resumeStep`, so no module
 * name is baked into the platform. Returns the empty string when no references
 * are supplied (the caller had nothing actionable to point at).
 *
 * `'[Workflow: ... tracker ..., checklist ..., retry.]'` sentence so existing
 * regex-based tests and skills keep matching, while the path tokens come from
 * the caller's contract instead of a hard-coded `docs/discovery/...` literal.
 */
export function renderWorkflowHint(opts: {
  trackerRef?: string;
  checklistRef?: string;
  resumeStep?: string;
}): string {
  const parts: string[] = [];
  if (isNonEmptyString(opts.trackerRef)) {
    parts.push(`Read your stage tracker ${opts.trackerRef}`);
  }
  if (isNonEmptyString(opts.checklistRef)) {
    parts.push(`verify checklist ${opts.checklistRef}`);
  }
  if (isNonEmptyString(opts.resumeStep)) {
    parts.push(`resume at ${opts.resumeStep}`);
  }
  parts.push('retry');
  if (parts.length === 1) return ''; // only "retry" left → nothing to hint
  return `[Workflow: ${parts.join(', ')}.]`;
}

// ---------------------------------------------------------------------------
// Transport round-trip (§11.10 — survive MCP JSON serialization).
// ---------------------------------------------------------------------------

/**
 * Serialize an {@link ActionableToolError} to the JSON-safe transport envelope.
 * The gateway attaches this envelope to the MCP error result so the structured
 * repair contract survives transport (§11.10) instead of being flattened into
 * one textual Error string.
 *
 * Validates the input and produces a frozen envelope tagged with
 * {@link ACTIONABLE_TOOL_ERROR_ENVELOPE_KIND}.
 */
export function serializeActionableToolError(error: ActionableToolError): ActionableToolErrorEnvelope {
  assertActionableToolError(error);
  // Adopt (not build) so we do not re-render an already-rendered `actual`.
  const canonical = adoptActionableToolError(error);
  return Object.freeze({
    kind: ACTIONABLE_TOOL_ERROR_ENVELOPE_KIND,
    error: canonical,
  });
}

/**
 * Deserialize a transport envelope back into a validated
 * {@link ActionableToolError}. Throws {@link ActionableToolErrorSchemaError} if
 * the envelope is malformed, wrongly kinded, or carries an invalid error.
 *
 * This is the §11.10 reconstruction side: after MCP JSON round-trip the value
 * has lost class identity, so `kind` is the only reliable discriminator.
 */
export function deserializeActionableToolError(value: unknown): ActionableToolError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ActionableToolErrorSchemaError(['$'], 'envelope must be a plain object');
  }
  const env = value as Record<string, unknown>;
  if (env.kind !== ACTIONABLE_TOOL_ERROR_ENVELOPE_KIND) {
    throw new ActionableToolErrorSchemaError(
      ['kind'],
      `envelope.kind must be ${ACTIONABLE_TOOL_ERROR_ENVELOPE_KIND}`,
    );
  }
  if (typeof env.error !== 'object' || env.error === null || Array.isArray(env.error)) {
    throw new ActionableToolErrorSchemaError(['error'], 'envelope.error must be a plain object');
  }
  // Adopt (not build): after transport, `actual` is already a rendered string.
  return adoptActionableToolError(env.error as ActionableToolError);
}

/**
 * Detect-and-reconstruct helper for gateway edges that may receive either a
 * serialized envelope OR a raw ActionableToolError object after transport.
 * Returns the validated {@link ActionableToolError}, or `null` if `value` is
 * neither shape (so the caller can fall through to its normal error handling).
 */
export function maybeDecodeActionableToolError(value: unknown): ActionableToolError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === ACTIONABLE_TOOL_ERROR_ENVELOPE_KIND) {
    try {
      return deserializeActionableToolError(value);
    } catch {
      return null;
    }
  }
  if (isActionableToolError(value)) {
    try {
      return adoptActionableToolError(value as ActionableToolError);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Thrown form (for call sites that throw across a sync handler boundary).
// ---------------------------------------------------------------------------

/**
 * Error class carrying a validated {@link ActionableToolError}. Use when a
 * handler needs to throw the structured failure across a sync boundary and a
 * gateway up-cast recovers `.actionable`. The gateway MUST prefer the
 * structured {@link serializeActionableToolError} path over reading
 * `.message` (§11.10).
 */
export class ActionableToolErrorThrown extends Error {
  readonly actionable: ActionableToolError;
  constructor(actionable: ActionableToolError) {
    super(renderActionableToolError(actionable));
    this.name = 'ActionableToolErrorThrown';
    // Adopt (not build): the caller passes an already-shaped error whose
    // `actual` may already be a rendered string; re-rendering would escape it.
    this.actionable = adoptActionableToolError(actionable);
  }
}

/**
 * Build and throw an {@link ActionableToolErrorThrown} in one step. Never
 * returns (typed `never`).
 */
export function throwActionableToolError(input: ActionableToolErrorInput): never {
  throw new ActionableToolErrorThrown(buildActionableToolError(input));
}
