# W1-A5 — ContractRef + ContractSchemaRegistry port + in-memory codec

**Wave:** 1 · **Lane:** A5 · **Spec:** §1 rows 2,3
**Frozen input commit:** `b0746cd` · **Branch:** `refactor/w1-a5` · **Worktree:** `.worktrees/w1-a5`

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full).
2. `src/process-modules/shared/canonical-json.ts` (`sha256Hex`).
3. `src/process-modules/domain/process-module.ts` (`SchemaReference { id: string }` — the existing opaque ref; ContractRef is its richer sibling).

## Own (only you)
- `src/process-modules/domain/spi/contract-ref.ts`
- `src/process-modules/domain/spi/contract-schema-registry.ts`
- `tests/spi/contract-schema-registry.test.mjs`

## What to build
### `contract-ref.ts`
- `ContractRef { schemaId: string; version: string; digest: string }` — pure readonly. `digest` = `sha256Hex` of the canonical schema document. Wave 1 does NOT compute real schema digests (no schemas registered yet); instead export `computeContractRefDigest(canonicalSchemaDocument: unknown): string` that delegates to `sha256Hex` so callers can produce a digest when they have a document. A Wave-1 caller without a document may use the literal `'pending@wave-2'` placeholder digest (documented).

### `contract-schema-registry.ts`
- PORT `ContractSchemaRegistry` (interface): `register(ref: ContractRef, codec: ContractSchemaCodec): void` · `has(ref): boolean` · `encode(ref, value): string` (canonical JSON string) · `decode(ref, bytes: string): unknown` · `validateOrThrow(ref, value): void`.
- `ContractSchemaCodec { encode(value): string; decode(bytes): unknown; validateOrThrow(value): void }` — pure interface (no functions in persisted data, but the codec IS a runtime object with functions; that's fine — it's not persisted).
- ADAPTER `InMemoryContractSchemaRegistry implements ContractSchemaRegistry` — uses a `Map<key, ContractSchemaCodec>` keyed by `${schemaId}@${version}`. `validateOrThrow` rejects unknown refs with `CONTRACT_SCHEMA_UNKNOWN`. `encode`/`decode` round-trip via the codec.
- The registry is a RUNTIME object (behavioral) — that's correct; only the `ContractRef` value is persisted.

## Tests
- `ContractRef` round-trips through canonical JSON (it's pure).
- `InMemoryContractSchemaRegistry`: register a stub codec (e.g. one that validates `{ typeof value === 'object' }`); `validateOrThrow` passes valid, throws on invalid; `encode`/`decode` round-trip; unknown ref throws `CONTRACT_SCHEMA_UNKNOWN`.
- `computeContractRefDigest` returns `sha256Hex` of input.
- Negative: a `ContractRef` carrying a function/Symbol in `digest` fails `assertCanonicalSerializable` (import from W1-A1's `canonical-serialization.ts` — if A1 hasn't landed in your worktree, import the path; it resolves at integration).

## Anti-scope
- Do NOT register real production schemas (Wave 2/3 do that).
- Do NOT modify existing production source. Do NOT touch other lanes' files.

## Verify
```
cd .worktrees/w1-a5 && npm run build && node --test tests/spi/contract-schema-registry.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```

## Commit
`feat(spi): W1-A5 ContractRef + ContractSchemaRegistry port + in-memory codec`.

## Return
1. Branch + sha. 2. diff --stat. 3. test tail + ratchet green. 4. The exported symbol names (`ContractRef`, `ContractSchemaRegistry`, `ContractSchemaCodec`, `InMemoryContractSchemaRegistry`, `computeContractRefDigest`) — other lanes import them. 5. Confirmation. Escalate ambiguities.
