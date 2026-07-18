/**
 * Canonical command payload hashing.
 *
 * Source: blueprint §7.1 (docs/architecture/passive-worker-kernel-blueprint.md:355-370)
 *         and §10 (line 462, 467-470).
 *
 * Why canonical: a retry must produce the same payload_hash byte-for-byte, so
 * the receipt lookup matches. JSON.stringify in JS leaves object key order
 * implementation-defined and is sensitive to key insertion order. We:
 *   - recursively sort object keys alphabetically;
 *   - render scalars in a fixed form (numbers via String(), strings as-is,
 *     booleans lowercase, null as 'null');
 *   - render arrays in array order (we do NOT sort arrays — sequence matters);
 *   - then sha256 the result.
 *
 * Pure. No DB, no clock, no I/O.
 */

import { createHash, type Hash } from 'node:crypto';

/**
 * Produce a stable canonical-string form of any JSON-compatible value.
 * Throws on undefined / functions / symbols / BigInt — these have no JSON form
 * and would silently corrupt the hash if coerced.
 */
export function canonicalJson(value: unknown): string {
  return renderCanonical(value, new Set<object>());
}

/**
 * SHA-256 hex of canonicalJson(value). Used as `payload_hash` in command_receipts.
 */
export function hashPayload(value: unknown): string {
  const h: Hash = createHash('sha256');
  h.update(canonicalJson(value), 'utf8');
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Internal renderer.
// ---------------------------------------------------------------------------

function renderCanonical(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new Error('canonicalJson: undefined is not representable');
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      // String() matches JSON.stringify for finite numbers. Reject NaN/Infinity
      // — they have no stable JSON form and would serialize to null silently.
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: non-finite number ${value}`);
      }
      return String(value);
    case 'string':
      return quoteString(value);
    case 'bigint':
      throw new Error('canonicalJson: bigint is not representable; convert to string first');
    case 'function':
    case 'symbol':
      throw new Error(`canonicalJson: ${typeof value} is not representable`);
    case 'object': {
      if (seen.has(value as object)) {
        throw new Error('canonicalJson: cycle detected');
      }
      seen.add(value as object);
      try {
        if (Array.isArray(value)) {
          return '[' + value.map((v) => renderCanonical(v, seen)).join(',') + ']';
        }
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const body = keys
          .map((k) => quoteString(k) + ':' + renderCanonical((value as Record<string, unknown>)[k], seen))
          .join(',');
        return '{' + body + '}';
      } finally {
        seen.delete(value as object);
      }
    }
    default:
      throw new Error(`canonicalJson: unrecognized typeof ${typeof value}`);
  }
}

/**
 * Minimal JSON string quoting. Matches JSON.stringify for ASCII and uses
 * explicit \u escapes for non-ASCII to keep the form stable across runtimes.
 */
function quoteString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';          // "
    else if (c === 0x5c) out += '\\\\';    // \
    else if (c === 0x0a) out += '\\n';     // LF
    else if (c === 0x0d) out += '\\r';     // CR
    else if (c === 0x09) out += '\\t';     // TAB
    else if (c === 0x08) out += '\\b';     // backspace
    else if (c === 0x0c) out += '\\f';     // form feed
    else if (c < 0x20) out += '\\u' + hex4(c);
    else if (c < 0x7f) out += s[i];
    else out += '\\u' + hex4(c);
  }
  out += '"';
  return out;
}

function hex4(code: number): string {
  return code.toString(16).padStart(4, '0').toUpperCase();
}
