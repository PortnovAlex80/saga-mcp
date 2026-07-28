# W1-A1 — Canonical serialization validator + negative tests

**Wave:** 1 · **Lane:** A1 · **Spec:** `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` §1 row 1, §3
**Frozen input commit:** `b0746cd` (Wave 0 checkpoint)
**Branch:** `refactor/w1-a1` (worktree `.worktrees/w1-a1`)

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full — your contract).
2. `src/process-modules/shared/canonical-json.ts` + `src/saga3/shared/discovery-canonical.ts` (the frozen `canonicalJson`/`sha256Hex` primitives — object keys sorted lexically, no whitespace, `undefined` object values dropped by JSON.stringify).
3. `docs/refactor-management/01-CODEBASE-BASELINE.md`.

## Own (only you create/edit)
- `src/process-modules/domain/spi/canonical-serialization.ts`
- `tests/spi/canonical-serialization.test.mjs`

## What to build
Export (pure data helpers, no classes):
- `isCanonicalSerializable(value): boolean` — returns false if `value` (recursively) contains any of: a function, a `Map`, a `Set`, a class instance (not a plain array/plain object), `Symbol`, non-finite number (`NaN`/`Infinity`/`-Infinity`), or `undefined` **inside an array**. Note: `undefined` as an object VALUE is dropped by `JSON.stringify`/`canonicalJson` and is therefore ACCEPTABLE (do not reject it). Recurse into plain objects and arrays only.
- `assertCanonicalSerializable(value): void` — throws `CanonicalSerializationError { code: 'CANONICAL_SERIALIZATION_INVALID'; path: string; reason: string }` with the JSON-path to the offending value.
- `canonicalJsonOrThrow(value): string` — `assertCanonicalSerializable` then `canonicalJson(value)`.

Implementation notes:
- Detect class instances via `value?.constructor !== undefined && value.constructor !== Object && value.constructor !== Array && typeof value !== 'string'` etc. — a plain object literal has `constructor === Object`. Be careful with `null` (`typeof null === 'object'`).
- Detect `Map`/`Set` via `value instanceof Map || value instanceof Set`.
- Detect `Symbol` via `typeof value === 'symbol'`.
- Detect non-finite via `typeof value === 'number' && !Number.isFinite(value)`.
- Use the existing `canonicalJson` from `../shared/canonical-json.js` for the actual serialization (do not reimplement hashing).

## Negative tests (spec §3) — must REJECT each:
function in a field · `Map` · `Set` · `undefined` inside an array · class instance · `NaN` · `Infinity` · `-Infinity` · `Symbol` value · `Symbol` key. Assert `isCanonicalSerializable` returns false AND `assertCanonicalSerializable` throws with a non-empty `path`.

## Positive tests
A plain object with nested arrays, strings, numbers, booleans, null, and `undefined` OBJECT values (dropped, not rejected) passes. `canonicalJsonOrThrow` returns the same string as `canonicalJson` for valid input. `sha256Hex` is stable.

## Anti-scope
- Do NOT modify `shared/canonical-json.ts` or `src/saga3/shared/discovery-canonical.ts` (frozen primitives).
- Do NOT touch other lanes' files. Do NOT modify existing production source.
- Do NOT create the barrel `index.ts` (W1-A8 owns).

## Verify
```
cd .worktrees/w1-a1 && npm run build && node --test tests/spi/canonical-serialization.test.mjs
```
Must PASS. Also run `node --test tests/architecture/dependency-direction.test.mjs` — ratchet must stay GREEN (your new file imports only from `../shared/canonical-json.js`, no new violations).

## Commit
One focused commit: `feat(spi): W1-A1 canonical serialization validator + negative tests`.

## Return to integrator
1. Branch + commit sha. 2. `git diff --stat b0746cd..HEAD`. 3. Passing test tail + ratchet-green confirmation. 4. The exact `CanonicalSerializationError` shape (other lanes import it). 5. "I changed no frozen contract and no existing production source." Escalate ambiguities; do not guess.
