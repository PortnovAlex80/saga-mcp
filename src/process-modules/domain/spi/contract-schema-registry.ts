/**
 * W1-A5 — ContractSchemaRegistry port + in-memory adapter.
 *
 * This module separates the two concerns the spec names explicitly:
 *
 *   1. `ContractRef` (a PURE value, in `contract-ref.ts`) — the persisted
 *      identity+version+digest tuple that travels through every manifest.
 *   2. `ContractSchemaRegistry` (a RUNTIME object — THIS file) — the
 *      behavioral port that knows how to `encode`/`decode`/`validateOrThrow`
 *      against the schema identified by a `ContractRef`.
 *
 * That separation is load-bearing: the persisted artifact (a manifest, an
 * installation row, a certificate) carries only the pure `ContractRef`. The
 * registry holds the codec (which IS a function-carrying runtime object) and
 * is reconstructed at process start. Nothing with a function in it is ever
 * persisted.
 *
 * Wave 1 ships only the in-memory adapter and the port. Wave 2/3 register
 * real production codecs; until then the registry is exercised by tests with
 * stub codecs.
 *
 * Errors: unknown refs raise an `Error` whose `message` starts with the
 * literal `CONTRACT_SCHEMA_UNKNOWN` token so callers can branch on the
 * spec-mandated code.
 */

import type { ContractRef } from './contract-ref.js';

/**
 * Behavioral codec for a single contract schema.
 *
 * `encode` produces the canonical JSON string form of a value; `decode` is
 * its left inverse; `validateOrThrow` rejects shape violations. A codec is a
 * runtime object (it carries functions) and is NEVER persisted — only the
 * `ContractRef` it is registered under is persisted.
 */
export interface ContractSchemaCodec {
  /** Canonical-JSON string form of `value`. Throws on shape violations. */
  encode(value: unknown): string;
  /** Left inverse of `encode`: returns a value structurally equal to the original. */
  decode(bytes: string): unknown;
  /** Throw on shape violation; return normally when `value` matches the schema. */
  validateOrThrow(value: unknown): void;
}

/**
 * PORT — the schema registry every runtime module talks to.
 *
 * Implementations:
 *   - `InMemoryContractSchemaRegistry` (Wave 1, this file — Map-keyed).
 *   - A Wave 2+ content-addressed/filesystem-backed registry (out of scope here).
 *
 * Lookup key is the `${schemaId}@${version}` pair from `ContractRef`. The
 * `digest` is part of the persisted identity but is NOT the lookup key: two
 * registrations under the same `(schemaId, version)` with different digests
 * would be a module-authoring error and is the caller's responsibility
 * (Wave 1's in-memory adapter simply overwrites on re-register, matching
 * `Map#set` semantics).
 */
export interface ContractSchemaRegistry {
  /** Bind `codec` under `ref`'s `${schemaId}@${version}`. Idempotent per key. */
  register(ref: ContractRef, codec: ContractSchemaCodec): void;
  /** True iff a codec has been registered under `ref`'s key. */
  has(ref: ContractRef): boolean;
  /** Canonical JSON string form of `value` under `ref`'s codec. */
  encode(ref: ContractRef, value: unknown): string;
  /** Decode `bytes` under `ref`'s codec (left inverse of `encode`). */
  decode(ref: ContractRef, bytes: string): unknown;
  /**
   * Throw on shape violation OR on an unknown `ref`. Unknown refs raise an
   * error whose message begins with the `CONTRACT_SCHEMA_UNKNOWN` token.
   */
  validateOrThrow(ref: ContractRef, value: unknown): void;
}

/**
 * Error code (literal token) carried at the start of the `message` of any
 * `Error` thrown because a `ContractRef` has no codec registered. Spec-mandated.
 */
export const CONTRACT_SCHEMA_UNKNOWN = 'CONTRACT_SCHEMA_UNKNOWN';

/**
 * Build the Map key for a `ContractRef`. The key intentionally excludes
 * `digest`: the registry indexes by logical identity `(schemaId, version)`,
 * not by content hash.
 */
export function contractSchemaRegistryKey(ref: ContractRef): string {
  return `${ref.schemaId}@${ref.version}`;
}

/**
 * Wave-1 in-memory adapter: a `Map<string, ContractSchemaCodec>` keyed by
 * `${schemaId}@${version}`. Suitable for tests and for the bootstrap of a
 * single process; NOT durable across restarts (Wave 2 brings persistence).
 */
export class InMemoryContractSchemaRegistry implements ContractSchemaRegistry {
  private readonly codecs = new Map<string, ContractSchemaCodec>();

  register(ref: ContractRef, codec: ContractSchemaCodec): void {
    this.codecs.set(contractSchemaRegistryKey(ref), codec);
  }

  has(ref: ContractRef): boolean {
    return this.codecs.has(contractSchemaRegistryKey(ref));
  }

  encode(ref: ContractRef, value: unknown): string {
    const codec = this.requireCodec(ref);
    return codec.encode(value);
  }

  decode(ref: ContractRef, bytes: string): unknown {
    const codec = this.requireCodec(ref);
    return codec.decode(bytes);
  }

  validateOrThrow(ref: ContractRef, value: unknown): void {
    const codec = this.requireCodec(ref);
    codec.validateOrThrow(value);
  }

  private requireCodec(ref: ContractRef): ContractSchemaCodec {
    const codec = this.codecs.get(contractSchemaRegistryKey(ref));
    if (!codec) {
      throw new Error(
        `${CONTRACT_SCHEMA_UNKNOWN}: no codec registered for ${contractSchemaRegistryKey(ref)} (digest=${ref.digest})`,
      );
    }
    return codec;
  }
}
