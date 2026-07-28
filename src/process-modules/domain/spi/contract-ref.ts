/**
 * W1-A5 — ContractRef: the richer sibling of `SchemaReference`.
 *
 * `SchemaReference { id: string }` (in `domain/process-module.ts`) is the
 * existing opaque schema reference. `ContractRef` extends that idea with two
 * additional pieces of identity:
 *   - `version` — the schema's semantic version (independent of the module
 *     version it happens to be carried by);
 *   - `digest`  — `sha256Hex` of the canonical schema document, content-
 *     addressing the exact JSON the codec will encode/decode against.
 *
 * Wave 1 does NOT register any real production schemas (Wave 2/3 do that).
 * Three properties hold:
 *
 *   1. `ContractRef` is a PURE serializable value — three primitive strings,
 *      no functions, no Maps/Sets, no class instances. It round-trips through
 *      `canonicalJson` / `JSON.parse` byte-for-byte.
 *   2. `computeContractRefDigest(canonicalSchemaDocument)` is the single
 *      canonical way for a Wave-1 caller that HAS a schema document to mint
 *      the matching `digest`. It delegates to `sha256Hex`.
 *   3. A Wave-1 caller WITHOUT a schema document (because no schemas are
 *      registered yet) may use the literal placeholder
 *      `CONTRACT_REF_PENDING_DIGEST = 'pending@wave-2'`. This is documented
 *      and intended — it lets manifest types carry a `ContractRef` field
 *      before the real codec registry exists.
 *
 * Anti-scope: this file owns NO behavior beyond digest computation. The
 * `ContractSchemaRegistry` port + in-memory adapter live in
 * `contract-schema-registry.ts`.
 */

import { sha256Hex } from '../../shared/canonical-json.js';

/**
 * Pure, serializable reference to a contract schema.
 *
 * `schemaId` + `version` form the logical identity (the key the registry
 * indexes by); `digest` content-addresses the exact schema document so that
 * two modules advertising `saga3.foo.v1` cannot silently disagree on shape.
 */
export interface ContractRef {
  readonly schemaId: string;
  readonly version: string;
  readonly digest: string;
}

/**
 * Placeholder digest for Wave-1 callers that carry a `ContractRef` field on a
 * manifest type but do not yet have a real schema document to hash (no
 * production schemas are registered until Wave 2/3). A Wave-2+ caller MUST
 * replace this with `computeContractRefDigest(document)`.
 */
export const CONTRACT_REF_PENDING_DIGEST = 'pending@wave-2';

/**
 * Compute the canonical `digest` for a `ContractRef` from its schema document.
 *
 * The argument is the canonical schema document (a JSON-serializable value).
 * The return value is `sha256Hex` of that document — lowercase hex, computed
 * over the same canonical JSON form used by every other content-addressed
 * artifact in the platform (formalization baseline hash, certificate hash,
 * NodeRun output hash). Delegating to `sha256Hex` guarantees that.
 *
 * Wave 1 callers usually do not have a document and use
 * `CONTRACT_REF_PENDING_DIGEST` instead; this function is the integration
 * point Wave 2/3 wires up against.
 */
export function computeContractRefDigest(canonicalSchemaDocument: unknown): string {
  return sha256Hex(canonicalSchemaDocument);
}
