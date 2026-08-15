// src/application/call-correlation.ts
//
// W6-A6 — MCP call-instance correlation, common receipt envelope, and
// structured MCP serialization (plan §0.9.8, §11.9-11.10).
//
// WHAT THIS OWNS
//   §11.9 — Every consequential call carries a platform-owned call-instance
//           correlation value that the gateway validates and STRIPS before
//           module handler input decoding. Runtime must never infer which
//           workspace file produced an MCP argument object.
//   §11.10 — The gateway preserves ActionableToolError as structured data
//           across MCP serialization. It must NOT flatten the repair contract
//           into one textual Error string.
//
// DESIGN
//   This module is the transport boundary contract. It defines three things:
//
//   1. CallCorrelationId — the platform-owned call-instance identity. It is
//      minted by the gateway, carried in a reserved argument key, validated
//      on entry, and STRIPPED so the module handler never sees it (handlers
//      receive only their declared input contract — they must not branch on a
//      correlation token, and the runtime must never infer provenance from a
//      workspace file path smuggled inside an argument object).
//
//   2. CallReceipt — the common envelope every consequential call returns.
//      Carries the correlation id, the resolved logical tool identity, and
//      either a success production or a structured ActionableToolError. The
//      receipt is what crosses the MCP process boundary.
//
//   3. serializeForMcp() / ActionableToolErrorShape — the structured
//      serialization. An ActionableToolError is preserved field-for-field as
//      structured JSON content, never collapsed into a single textual Error
//      string. The companion safeFromThrown() traps arbitrary thrown values
//      and normalizes them into the structured shape so a thrown string or
//      plain Error can never bypass the contract.
//
// PARALLEL-LANE NOTE (§0.9.2)
//   ActionableToolError's full implementation (enrichment, escaping, repair
//   references) is owned by W6-A5. The ActionableToolErrorShape below is the
//   FROZEN transport contract both lanes agree on (plan §0.9.2 lists it among
//   the serial preconditions). W6-A5 may add a richer type that STRUCTURALLY
//   SATISFIES this shape; the gateway serializes whatever it is given through
//   this lens. This file therefore imports nothing from W6-A5 — the contract
//   is structural (duck-typed), keeping the lanes parallel.

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Reserved argument key.
//
// The correlation id travels inside the MCP arguments object under this key.
// It is a PLATFORM reserved name: module input contracts MUST NOT declare a
// field with this name, and the gateway strips it before decoding handler
// input. This is the single chokepoint that enforces §11.9's "runtime must
// never infer which workspace file produced an MCP argument object" — the
// only platform-injected key is this one, and it is removed before the handler
// sees the arguments.
// ---------------------------------------------------------------------------

/** Reserved MCP argument key carrying the platform call-instance correlation. */
export const CALL_CORRELATION_KEY = '__saga_call';

/**
 * Stable prefix for every minted correlation id, so a gateway can distinguish
 * a platform-minted id from an attacker-supplied or stale value at validation
 * time without parsing free-form strings.
 */
export const CALL_CORRELATION_PREFIX = 'call:';

// ---------------------------------------------------------------------------
// §11.9 — Call-instance correlation value.
// ---------------------------------------------------------------------------

/**
 * Platform-owned call-instance correlation value.
 *
 * Format: `call:<uuid>` (the prefix makes a minted id self-identifying and
 * lets {@link isValidCorrelationId} reject values that are not
 * platform-minted, e.g. a workspace file path an older runtime might have
 * tried to use as a correlation token).
 */
export type CallCorrelationId = string;

/**
 * Mint a fresh platform-owned call-instance correlation id.
 *
 * The gateway calls this once per inbound consequential tool call. The value
 * is opaque to module handlers (they never receive it — see
 * {@link stripCorrelation}).
 */
export function mintCorrelationId(): CallCorrelationId {
  return `${CALL_CORRELATION_PREFIX}${randomUUID()}`;
}

/**
 * Validate that a value is a platform-minted correlation id (§11.9 "the
 * gateway validates ... before module handler input decoding").
 *
 * Accepts only the `call:<uuid>` shape produced by {@link mintCorrelationId}.
 * Rejects anything else — including bare UUIDs, file paths, and empty
 * strings — so a non-platform value can never pose as a correlation id.
 */
export function isValidCorrelationId(value: unknown): value is CallCorrelationId {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(CALL_CORRELATION_PREFIX)) return false;
  const rest = value.slice(CALL_CORRELATION_PREFIX.length);
  // uuid v4-ish: 36 chars, 4 hyphens at the canonical positions. We do not
  // require a specific version tag — only the structural shape — so minted
  // ids remain valid if the crypto backend ever changes versions.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest);
}

/**
 * Read the correlation id from an inbound MCP arguments object WITHOUT
 * removing it. Returns null when absent or not platform-minted. Used by the
 * gateway to validate before stripping.
 */
export function readCorrelationId(args: unknown): CallCorrelationId | null {
  if (args === null || typeof args !== 'object') return null;
  const candidate = (args as Record<string, unknown>)[CALL_CORRELATION_KEY];
  return isValidCorrelationId(candidate) ? candidate : null;
}

/**
 * §11.9 STRIP step — return a copy of the arguments with the platform
 * correlation key removed, so the module handler receives only its declared
 * input contract.
 *
 * The handler MUST NOT see the correlation token: it must not branch on it,
 * log it as provenance, or echo it. Stripping at the gateway is the
 * enforcement point. If the arguments object also carried a value under the
 * reserved key that was NOT a valid platform id, that value is still stripped
 * (the key is reserved regardless) and the original is exposed via
 * {@link detectInferredProvenance} so the gateway can audit the attempt.
 *
 * Never mutates the input; returns a shallow copy with the reserved key
 * omitted. A non-object input is returned unchanged.
 */
export function stripCorrelation<T>(args: T): T {
  if (args === null || typeof args !== 'object') return args;
  const clone = { ...(args as Record<string, unknown>) };
  delete clone[CALL_CORRELATION_KEY];
  return clone as T;
}

/**
 * §11.9 invariant guard — detect any argument key whose value looks like an
 * attempt to smuggle workspace provenance (a file path) into the handler
 * input. The runtime must never infer which workspace file produced an MCP
 * argument object; if a caller tries to encode that as an argument, the
 * gateway audits it.
 *
 * Returns the list of offending keys (empty when clean). Only top-level
 * string values are inspected — this is a provenance-leak detector, not a
 * deep validator. The reserved correlation key is exempt (it is platform-owned
 * and stripped before the handler runs).
 */
export function detectInferredProvenance(args: unknown): string[] {
  if (args === null || typeof args !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === CALL_CORRELATION_KEY) continue;
    if (typeof value !== 'string') continue;
    // A workspace file path: absolute, or relative with a path separator and a
    // dotted extension. Bare tool names / ids ("task-123") are intentionally
    // NOT flagged — those are legitimate logical references, not file
    // provenance.
    if (
      (value.includes('/') || value.includes('\\')) &&
      /\.[A-Za-z0-9]{1,8}$/.test(value)
    ) {
      out.push(key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// §11.8 / §11.10 — ActionableToolError transport shape.
//
// The full ActionableToolError (enrichment, escaping, repair references) is
// owned by W6-A5. This is the FROZEN structural contract the gateway
// serializes across MCP transport. W6-A5's concrete type must structurally
// satisfy this shape. Fields mirror plan §11.8.1-11.8.10.
// ---------------------------------------------------------------------------

/**
 * Retry permission for an ActionableToolError (§11.8.10).
 * - `retryable`    — the caller may retry the same call after repairing input.
 * - `not-retryable`— the call is permanently rejected (authority, policy).
 * - `needs-human`  — retry requires a human decision first.
 */
export type RetryPermission = 'retryable' | 'not-retryable' | 'needs-human';

/**
 * Structural transport shape for an ActionableToolError (plan §11.8.1-11.8.10,
 * §11.10). This is what the gateway preserves field-for-field across MCP
 * serialization — it is never flattened into a single textual Error string.
 *
 * `callInstance` mirrors §11.8.6 (exact call instance reference) and carries
 * the {@link CallCorrelationId} of the call that failed, so the receipt and
 * the error stay correlated end-to-end.
 */
export interface ActionableToolErrorShape {
  /** §11.8.1 — stable, machine-readable error code. */
  readonly code: string;
  /** §11.8.2 — human-readable message (already escaped/sanitized by W6-A5). */
  readonly message: string;
  /** §11.8.3 — JSON-pointer-ish field path within the input (optional). */
  readonly fieldPath?: string;
  /** §11.8.4 — expected value/shape (optional). */
  readonly expected?: string;
  /** §11.8.4 — actual value/shape observed (optional). */
  readonly actual?: string;
  /** §11.8.5 — source of the correct value (optional). */
  readonly sourceOfTruth?: string;
  /** §11.8.6 — exact call instance reference (a CallCorrelationId). */
  readonly callInstance?: CallCorrelationId;
  /** §11.8.7 — checklist reference for the failing step (optional). */
  readonly checklistRef?: string;
  /** §11.8.8 — tracker reference (task/epic) for the failing step (optional). */
  readonly trackerRef?: string;
  /** §11.8.9 — resume step identifier (optional). */
  readonly resumeStep?: string;
  /** §11.8.10 — retry permission. Defaults to `retryable` when omitted. */
  readonly retry?: RetryPermission;
}

/**
 * Structurally narrow an unknown value into an ActionableToolErrorShape.
 *
 * Used by the gateway to decide whether a handler-produced failure is already
 * a structured error (preserve it verbatim per §11.10) or a raw thrown value
 * (normalize it via {@link safeFromThrown}). The test is structural so W6-A5's
 * concrete ActionableToolError class — which lands in a parallel lane — is
 * accepted without an import edge between the lanes.
 */
export function isActionableToolErrorShape(
  value: unknown,
): value is ActionableToolErrorShape {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || v.code.length === 0) return false;
  if (typeof v.message !== 'string') return false;
  // Optional string fields, if present, must be strings.
  for (const k of [
    'fieldPath',
    'expected',
    'actual',
    'sourceOfTruth',
    'checklistRef',
    'trackerRef',
    'resumeStep',
  ] as const) {
    if (k in v && typeof v[k] !== 'string' && v[k] !== undefined) return false;
  }
  if ('callInstance' in v && v.callInstance !== undefined) {
    if (!isValidCorrelationId(v.callInstance)) return false;
  }
  if ('retry' in v && v.retry !== undefined) {
    if (
      v.retry !== 'retryable' &&
      v.retry !== 'not-retryable' &&
      v.retry !== 'needs-human'
    ) {
      return false;
    }
  }
  return true;
}

/**
 * §11.10 anti-flattening guard — normalize an arbitrary thrown value into an
 * ActionableToolErrorShape WITHOUT collapsing the repair contract into one
 * textual Error string.
 *
 * - If the thrown value already structurally satisfies the shape, it is
 *   returned verbatim (its repair references, field path, retry permission
 *   are preserved — NOT stringified).
 * - Only a NON-structured throw (a plain Error, a string, or anything else)
 *   is wrapped, and even then into a structured shape carrying the message as
 *   `message` plus a `retry` permission — never a bare string.
 *
 * The correlation id of the failing call is attached as `callInstance`
 * (§11.8.6) so the error stays correlated with its receipt.
 */
export function safeFromThrown(
  thrown: unknown,
  correlation: CallCorrelationId | null,
): ActionableToolErrorShape {
  if (isActionableToolErrorShape(thrown)) {
    // Already structured: preserve verbatim. If it lacks a callInstance,
    // attach the active correlation so end-to-end correlation is guaranteed.
    if (thrown.callInstance === undefined && correlation !== null) {
      return { ...thrown, callInstance: correlation };
    }
    return thrown;
  }
  const message =
    thrown instanceof Error
      ? thrown.message
      : typeof thrown === 'string'
        ? thrown
        : 'An unknown error occurred during tool execution.';
  return {
    code: 'TOOL_UNHANDLED',
    message,
    callInstance: correlation ?? undefined,
    retry: 'retryable',
  };
}

// ---------------------------------------------------------------------------
// §11.9 — Common receipt envelope.
//
// Every consequential call returns a CallReceipt. This is the unit that
// crosses the MCP process boundary: it carries the correlation id, the
// resolved logical tool identity, and exactly one of a success production or
// a structured error. The gateway never mixes them.
// ---------------------------------------------------------------------------

/**
 * Common receipt envelope for one consequential MCP tool call.
 *
 * @property correlation  — the platform call-instance id (§11.9), present on
 *                          every consequential call so it can be traced end to
 *                          end. Null only for non-consequential (compatibility)
 *                          calls the gateway did not mint one for.
 * @property tool         — resolved logical tool name (the namespaced identity
 *                          the gateway dispatched, not the raw request alias).
 * @property ok           — outcome flag. `true` → `production` is set and
 *                          `error` is absent. `false` → `error` is a
 *                          structured ActionableToolErrorShape and `production`
 *                          is absent. Exactly one is ever present.
 * @property production   — the handler's success result (present iff ok).
 * @property error        — structured error (present iff !ok). NEVER a bare
 *                          string — see §11.10.
 */
export interface CallReceipt<TProduction = unknown> {
  readonly correlation: CallCorrelationId | null;
  readonly tool: string;
  readonly ok: boolean;
  readonly production?: TProduction;
  readonly error?: ActionableToolErrorShape;
}

/** Build a success CallReceipt. */
export function okReceipt<TProduction>(
  tool: string,
  production: TProduction,
  correlation: CallCorrelationId | null,
): CallReceipt<TProduction> {
  return { correlation, tool, ok: true, production };
}

/** Build a failure CallReceipt from a structured error. */
export function errorReceipt(
  tool: string,
  error: ActionableToolErrorShape,
  correlation: CallCorrelationId | null,
): CallReceipt {
  return { correlation, tool, ok: false, error };
}

// ---------------------------------------------------------------------------
// §11.10 — Structured MCP serialization.
//
// MCP CallToolResult carries content as a list of typed content blocks. The
// naive gateway flattens an error into `text: "Error: <msg>"`, which destroys
// the repair contract. This serializer preserves the structured shape:
//
//   - A success receipt serializes its production as one text block of
//     pretty-printed JSON (preserving handler output shape).
//   - A failure receipt serializes its ActionableToolError as one text block
//     of pretty-printed JSON carrying EVERY field, AND tags the result with
//     isError: true. The agent therefore receives a machine-readable repair
//     contract, not a flattened string it would have to re-parse.
//
// The serialized error object always carries a `kind: 'ActionableToolError'`
// discriminant and the `callInstance` correlation, so the receiving side can
// distinguish a structured error from an arbitrary success body that happens
// to contain an `error` field.
// ---------------------------------------------------------------------------

/** Discriminant written onto every serialized ActionableToolError body. */
export const SERIALIZED_ERROR_KIND = 'ActionableToolError' as const;

/**
 * The serialized form of an ActionableToolError as it appears inside an MCP
 * text content block. Always carries the `kind` discriminant and correlation.
 */
export interface SerializedActionableToolError extends ActionableToolErrorShape {
  readonly kind: typeof SERIALIZED_ERROR_KIND;
}

/**
 * Mark an ActionableToolErrorShape with the serialized-error discriminant and
 * guarantee its `callInstance` is populated, so the receiver can tell a
 * structured error apart from an arbitrary success body.
 */
export function serializeError(
  error: ActionableToolErrorShape,
  correlation: CallCorrelationId | null,
): SerializedActionableToolError {
  return {
    ...error,
    kind: SERIALIZED_ERROR_KIND,
    callInstance: error.callInstance ?? correlation ?? undefined,
  };
}

/**
 * Minimal MCP CallToolResult shape this serializer targets. We define it
 * locally rather than importing the SDK type, so this contract has no runtime
 * dependency on the MCP SDK and can be unit-tested in isolation.
 */
export interface McpCallToolResult {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text: string;
  }>;
  readonly isError?: boolean;
}

/**
 * §11.10 — Serialize a CallReceipt into an MCP CallToolResult that PRESERVES
 * the structured error across transport.
 *
 * Success: one text block of pretty-printed JSON of the production; `isError`
 * is absent (falsy).
 *
 * Failure: one text block of pretty-printed JSON of the
 * {@link SerializedActionableToolError} (carrying code, message, fieldPath,
 * expected/actual, repair references, retry permission, AND the correlation
 * id); `isError: true`.
 *
 * The error is NEVER flattened into `text: "Error: <message>"`. The repair
 * contract survives byte-for-byte.
 */
export function serializeForMcp(receipt: CallReceipt): McpCallToolResult {
  if (receipt.ok) {
    return {
      content: [
        { type: 'text', text: JSON.stringify(receipt.production ?? null, null, 2) },
      ],
    };
  }
  // Failure path: preserve the FULL structured error. The correlation on the
  // receipt is the source of truth for the call instance (§11.8.6).
  const body = serializeError(
    receipt.error as ActionableToolErrorShape,
    receipt.correlation,
  );
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

/**
 * §11.10 receiver-side counterpart — parse an MCP CallToolResult back into a
 * structured ActionableToolError when present, or null when the result is a
 * success (or a non-structured body).
 *
 * Used by transport-conformance tests and by any receiver that must recover
 * the repair contract from the wire. Recognizes a structured error by the
 * {@link SERIALIZED_ERROR_KIND} discriminant; without it, a body is treated
 * as ordinary handler production (returning null), matching the rule that an
 * error must be explicitly marked, not inferred from a field name.
 */
export function parseStructuredError(
  result: McpCallToolResult,
): SerializedActionableToolError | null {
  if (!result.isError) return null;
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as Record<string, unknown>).kind === SERIALIZED_ERROR_KIND &&
        isActionableToolErrorShape(parsed)
      ) {
        return parsed as SerializedActionableToolError;
      }
    } catch {
      // what §11.10 forbids the gateway from producing; on the receive side
      // we treat it as "no structured error recoverable" rather than guessing.
      continue;
    }
  }
  return null;
}
