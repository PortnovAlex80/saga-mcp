/**
 * workflow-kernel/domain/digest.ts - the ONE deterministic canonical
 * serialization + digest rule of the workflow kernel (WP-05, plan EK-2).
 *
 * Frozen rule (identical to docs/refactoring/event-kernel/specs/validate-role-contract.mjs,
 * section "Frozen canonicalization + slot-fingerprint rule"):
 *   1. recursively sort object keys (lexicographic by UTF-16 code unit);
 *   2. compact JSON.stringify (no whitespace);
 *   3. sha256 over the UTF-8 encoding;
 *   4. slot fingerprints exclude named top-level self-referencing keys
 *      (contractDigest + roleContractRef; manifestDigest; etc).
 *
 * tests/workflow-kernel/model/digest.test.mjs proves behavioral equality with
 * the frozen validator's exported functions on identical inputs.
 *
 * PURITY: node:crypto only (deterministic hashing, no I/O).
 */

import { createHash } from 'node:crypto';
import type { CanonicalRoleContract, CanonicalRoleContractReference } from './types.js';

/** Recursively sort object keys (lexicographic by UTF-16 code unit; JS default). */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: recursively key-sorted, compact JSON.stringify. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** sha256 hex of the canonical JSON of the value. */
export function sha256OfCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** sha256 hex of the canonical JSON of the value minus excluded top-level keys. */
export function digestExcluding(value: object, excludedKeys: readonly string[]): string {
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!excludedKeys.includes(key)) copy[key] = source[key];
  }
  return createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex');
}

/** contractDigest = sha256(canonicalJson(contract minus {contractDigest, roleContractRef})). */
export function contractDigestOf(contract: CanonicalRoleContract): string {
  return digestExcluding(contract, ['contractDigest', 'roleContractRef']);
}

/** The self-addressing content reference derived from the slot fingerprint. */
export function roleContractRefOf(digest: string): string {
  return `sha256:${digest}`;
}

/** The exact reference/digest pair pinned on WorkIntent and ActivityAttempt. */
export function pinRoleContract(contract: CanonicalRoleContract): CanonicalRoleContractReference {
  const digest = contractDigestOf(contract);
  return { roleContractRef: `sha256:${digest}`, roleContractDigest: digest };
}

/** Deep equality under the canonical rule. */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
