# Framework Profiles — saga-code-reviewer

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

A **framework profile** sharpens the four review axes (`axes.md`) with the
framework-specific failure modes that a generic read would miss. The reviewer
picks ONE profile per task based on the changed files and applies that profile's
rules as refinement of the axes — never as a replacement for them.

> **Saga product repos are TypeScript-first.** The TypeScript profile is the
> default and the most thoroughly specified below. React and Vue profiles apply
> only when a task touches UI components. Rust applies to the (rare) Rust
> product repositories; if no Rust file is in the diff, skip that profile.

## How to pick the profile

Inspect the changed-files list from `git diff --name-only origin/dev...HEAD`:

| If the diff contains... | Apply profile |
|---|---|
| Any `*.tsx` / `*.jsx` with hooks or components | **React 19** |
| Any `*.vue` (SFC) | **Vue 3** |
| Any `*.rs` | **Rust** |
| Any `*.ts` / `*.tsx` / `*.mts` / `*.cts` (always, for saga) | **TypeScript** (default) |
| A query/mutation client (`@tanstack/react-query`, `@tanstack/vue-query`) | Add **TanStack Query v5** overlay |

Multiple profiles can stack (e.g. a React + TanStack task applies React 19 PLUS
the TanStack overlay PLUS the TypeScript default). The TypeScript default
always applies to saga repos even when another profile is primary.

---

## TypeScript profile (default for all saga repos)

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill (reference/typescript.md) -->

Refines the axes with TS-specific failure modes that tsc cannot always catch.

### Type system
- **TS-1.** `any` introduced by the diff (explicit `: any`, or implicit via
  missing annotation on an inferred-from-`any` value) → `advisory`, unless the
  diff also adds an `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
  with a one-line justification. Required use of `any` at a port boundary with
  no alternative is `advisory`; lazy `any` to silence a type error is `fail`
  (correctness C5).
- **TS-2.** Non-null assertion (`x!.y`) added where a guard (`if (x)`, optional
  chaining `x?.y`) would be equally clear → `advisory`. An assertion that
  contradicts a type declaring `null | undefined` → `fail` (correctness C2).
- **TS-3.** `as <Type>` cast that narrows in a way the runtime cannot honor
  (e.g. `as KnownKind` over a value typed as `unknown`/`any` with no runtime
  check) → `fail` (correctness C5 — defeats the type contract).
- **TS-4.** Tuple vs array confusion: a function signature that declares a
  rest parameter or array return where a fixed tuple is the actual contract →
  `advisory`.
- **TS-5.** `enum` vs union: a new `enum` introduced where a string-literal
  union would do (no mapping of values, no runtime reflection needed) →
  `advisory` (union is lighter and tree-shakes better).

### Strict-mode surface
- **TS-6.** `strict`, `strictNullChecks`, `noImplicitAny` are the saga default
  (`tsconfig.json`). A diff that weakens these flags, OR adds a per-file
  `// @ts-nocheck` / `// @ts-ignore` without a justifying comment → `fail`.
- **TS-7.** `ts-expect-error` directives that are no longer suppressing a real
  error (tsc reports `Unused '@ts-expect-error'`) → `fail` (the deterministic
  `tsc` check catches this; TS-7 is the semantic "do not paper over errors"
  rule).

### Async & error paths
- **TS-8.** `async` function whose body has no `await` → `advisory` (the
  function returns a Promise unnecessarily; either await something or drop
  `async`).
- **TS-9.** Floating (un-awaited) Promise — a call to an `async` function whose
  return value is discarded in a context where rejection matters (handler,
  worker entrypoint, lifecycle hook) → `fail` (correctness C1). Use `void` only
  where fire-and-forget is intentional and a top-level handler exists.
- **TS-10.** `Promise.all` over a list that contains side-effectful async
  functions with shared mutable closure state → `advisory` (correctness C4
  overlap).

### Module shape
- **TS-11.** New `export =` or `namespace` syntax in a file that should be
  ESM → `advisory` (saga repos are ESM; CommonJS/namespace escape hatches need
  a reason).
- **TS-12.** Barrel-file (`index.ts`) re-export added that re-exports a name
  already exported elsewhere in the barrel → `advisory` (ambiguous re-export).

---

## React 19 profile

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill (reference/react.md) -->

Applies when the diff touches `*.tsx` / `*.jsx`. Refines performance and
correctness axes for the React 19 + RSC model.

### Hooks rules (hard)
- **R-1.** Conditional or loop-wrapped hook call → `fail` (correctness; the
  Rules of Hooks are non-negotiable and the deterministic `eslint-plugin-react-hooks`
  should also flag this — if it slipped past, fail).
- **R-2.** `useEffect` with a dependency that is an object/array recreated every
  render (causing the effect to fire every render) → `advisory` (performance P5).
  Memoize the dep, or move the derivation inside the effect.
- **R-3.** `useEffect` that performs a side effect that should be an event
  handler (deriving from props that change on user action) → `advisory`
  (maintainability M6 — wrong idiom).

### Performance & re-render
- **R-4.** `useMemo` / `useCallback` added with NO dependency on a hot path —
  i.e. the memoized value is cheap to recompute, or the component does not
  render often → `advisory` (do not add memoization cargo-cult style).
- **R-5.** Conversely, a child component re-rendering on every parent render
  because a prop is an inline-created object/array AND the child is expensive
  → `advisory` (performance P5).

### React 19 / RSC specifics
- **R-6.** A Server Component (`'use server'` or no `'use client'`) that imports
  a client-only API (`window`, `document`, `localStorage`, a state hook) →
  `fail` (correctness; RSC boundary violation).
- **R-7.** `use()` of a promise or context inside a condition or loop → `fail`
  (correctness; `use`, like hooks, must be called unconditionally at the top
  level).
- **R-8.** `ref` as a prop forwarded to a child without `forwardRef` where the
  child is a function component pre-React-19 — in React 19 `ref` is a regular
  prop, so the diff should not add `forwardRef` boilerplate to new React 19
  components → `advisory` (maintainability M6 — outdated idiom).

### Forms & state
- **R-9.** Direct DOM mutation (`element.style.x = ...`, `document.querySelector`
  inside a component) where React state would track the same thing → `advisory`
  (maintainability; let React own the DOM).
- **R-10.** Uncontrolled-to-controlled input switch mid-render (the same input
  is controlled in one branch and uncontrolled in another) → `fail`
  (correctness C2 — React will warn at runtime and the field will misbehave).

---

## Vue 3 profile

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill (reference/vue.md) -->

Applies when the diff touches `*.vue` (Single-File Components) or `defineComponent`
usage. Refines performance and correctness for the Composition API + reactivity
system.

### Reactivity
- **V-1.** Destructuring a `reactive(...)` object, or destructuring `props`
  without `toRefs` / `toRef` → `fail` (correctness; the destructured bindings
  lose reactivity silently).
- **V-2.** `watch` / `watchEffect` over a reactive object without `deep: true`
  when the watcher body depends on a nested property → `advisory` (correctness
  C2 overlap — the watcher will not fire on nested change).
- **V-3.** Mutating `props` directly (`props.x = y`) → `fail` (correctness;
  Vue forbids this and emits a warning).
- **V-4.** `computed` whose getter has a side effect (writes state, fires a
  request) → `fail` (correctness C1 / maintainability; computed must be pure).

### Template & SFC
- **V-5.** `v-for` without a stable `:key`, or with `:key` set to the array
  index when the list can reorder → `fail` (correctness; leads to wrong DOM
  reconciliation).
- **V-6.** `v-html` on a value that includes any user-controlled segment →
  `fail` (security S2 — XSS vector).
- **V-7.** `defineProps` / `defineEmits` declared with runtime types where the
  project's convention is `PropType<T>` / a generic form — or vice versa — →
  `advisory` (maintainability M6 — pick one idiom and stay consistent).

### Lifecycle
- **V-8.** `onMounted` that starts an async operation without an
  `onBeforeUnmount` cleanup (the async result can resolve after unmount) →
  `advisory` (correctness C4 / performance P3 overlap).
- **V-9.** A `watch` or `watchEffect` created in a non-setup context (inside an
  event handler) and never `stop()`-ed → `advisory` (performance P3 leak).

---

## Rust profile

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill (reference/rust.md) -->

Applies when the diff touches `*.rs`. Saga product repos are TS-first, so this
profile is rarely used, but it is kept here for the rare Rust component. The
Rust compiler catches memory-safety issues; the reviewer focuses on what the
compiler cannot.

### `unsafe` (highest priority)
- **RU-1.** Any new `unsafe { ... }` block → `fail` UNLESS the diff also adds
  a `// SAFETY: ...` comment explaining the invariant the caller/uphold-er is
  relying on. Unjustified `unsafe` is the single hardest defect to audit later.
- **RU-2.** `unsafe impl` of a auto-trait (`Send`, `Sync`) → `fail` without a
  multi-line SAFETY justification and (preferably) a follow-up issue linked in
  the result.

### Ownership & borrowing
- **RU-3.** `.clone()` inside a hot loop or on a large structure where a borrow
  would work → `advisory` (performance P1). The compiler accepts the borrow;
  the clone is the easy-not-correct path.
- **RU-4.** `Rc<RefCell<...>>` (or `Arc<Mutex<...>>`) introduced where single-
  ownership would do → `advisory` (maintainability; shared mutable state is a
  smell).

### Error handling
- **RU-5.** `.unwrap()` / `.expect(...)` on a `Result` in a path that can
  actually fail (network, parse, IO) → `fail` (correctness C1). In a test or a
  `const`-context known-infallible path, `unwrap` is fine.
- **RU-6.** `panic!` / `todo!` / `unimplemented!` introduced in a library
  function that callers will reach in production → `fail`. In a binary's main
  before init, `advisory`.
- **RU-7.** `Box<dyn Error>` returned where a concrete `thiserror` enum matches
  the project convention → `advisory` (maintainability M6).

### Cancellation & async (Tokio)
- **RU-8.** `.await` inside a `Drop` or while holding a `MutexGuard` / lock
  across `.await` without a comment → `advisory` (correctness C4 — cancellation
  safety).
- **RU-9.** `spawn(...)` without storing or joining the `JoinHandle` AND without
  a comment on why fire-and-forget is safe → `advisory` (performance P3 leak
  / correctness).

---

## TanStack Query v5 overlay

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

Applies on top of React or Vue profile when the diff uses
`@tanstack/react-query` or `@tanstack/vue-query` v5.

### Query keys
- **TQ-1.** New query with a key that is not an array, or that inlines an
  object whose key order is not stable → `fail` (correctness; TanStack
  serializes keys and unstable shape causes cache misses).
- **TQ-2.** A query key that duplicates an existing key's shape but for a
  different query → `advisory` (maintainability; will cause cache collisions).

### Stale time & cache
- **TQ-3.** `staleTime: 0` (the default) on a query against a slow / expensive
  backend, with no `placeholderData` or `keepPreviousData` → `advisory`
  (performance P5 — will refetch on every mount).
- **TQ-4.** `gcTime` / `cacheTime` lowered below the project's default without
  a reason → `advisory`.

### Mutation & invalidation
- **TQ-5.** A mutation `onSuccess` that does NOT call
  `queryClient.invalidateQueries(...)` for the queries the mutation changes →
  `fail` (correctness; the UI will show stale data).
- **TQ-6.** `queryClient.setQueryData` used to optimistically update a query
  whose shape does not match the mutation response → `fail` (correctness C5 —
  cache poisoning).

### v5 specifics
- **TQ-7.** Use of the v4 API (`useQuery(['key'], fn, options)` positional
  signature) in a v5 codebase → `fail` (correctness; v5 requires the object
  form `useQuery({ queryKey, queryFn, ...options })`).
- **TQ-8.** `useMutation` without an explicit `mutationKey` when the same
  mutation is invoked from multiple components and deduplication is expected →
  `advisory`.

---

## Applying a profile in the verdict

When a profile is in play, the `worker_done.result` MUST name the applied
profile(s) and surface profile-tagged findings under their axis:

```
Profile: typescript, react19, tanstack-v5

Axes:
- security: pass
- performance: advisory (P5 / R-5 — child re-renders on every parent render in src/ui/list.tsx; memoize the inline prop at line 42)
- maintainability: pass
- correctness: fail (TQ-5 — mutation onSuccess in src/ui/save.tsx does not invalidate the list query; UI will show stale data)
```

If a reviewer is unsure which profile applies (e.g. ambiguous file extensions,
mixed-language diff), apply the TypeScript default and flag the ambiguity as an
`advisory` under maintainability. Do NOT block on profile selection.

## What the profiles do NOT do

- They do not replace the deterministic craft checks (tsc, eslint, jscpd).
- They do not re-derive requirements; the AC is the frozen baseline.
- They do not introduce a new governance path; the verdict still routes through
  `worker_done`.
- They do not authorize self-approval of any kind (R5).
