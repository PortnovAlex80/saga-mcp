# Review Axes — saga-code-reviewer

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

This file defines the **four review axes** the code reviewer applies to every
`development.code` task in the review buffer. Each axis produces a per-axis
verdict (`pass` / `fail` / `advisory`) that aggregates into the single
governance verdict emitted via `worker_done(verdict='approved'|'changes_requested')`.

> **CGAD alignment.** These axes are the **craft** layer (L0 deterministic
> evidence) — they complement, never replace, the L3 property-test verification
> that `saga-verifier` runs against the frozen AC contract. A failing craft axis
> routes the task back to a fresh Builder (`changes_requested` → `todo`); it
> does NOT touch the baseline or the episode stage.

> **No external "approve" shortcut.** EXT-3's original "autonomous approve"
> wording is dropped. The reviewer never self-authorizes completion. The verdict
> is evidence: hard-axis failures force `changes_requested`; only a clean sweep
> across all axes permits `approved`, and even then the transition is enacted by
> `worker_done`, not by an inline approval call.

## How the axes combine with the existing craft checks

The four axes below are **semantic** (about the meaning of the code). The seven
craft checks already in `SKILL.md` (`tsc --noEmit`, file size, scratch
detection, duplication, ESLint delta, coverage delta, build sanity) are
**deterministic** (about measurable artifacts). Every review runs BOTH:

| Layer | Source | Examples |
|---|---|---|
| Deterministic craft checks | `SKILL.md` §"What to review" | tsc exit code, line count, jscpd %, eslint delta |
| Semantic axes (this file) | EXT-3, ported | security sub-checks, perf sub-checks, ... |

A hard failure on EITHER layer forces `changes_requested`. The deterministic
checks are cheap and unambiguous; run them first. Then walk the four axes for
the semantic read.

## Aggregation rule

| Axis outcome pattern | Final verdict |
|---|---|
| All four axes `pass` AND all deterministic checks pass | `approved` |
| Any axis `fail` (hard sub-check) OR any deterministic hard check fails | `changes_requested` |
| Axes `pass` but ≥ 1 `advisory` (soft sub-check) | `approved` with advisory text in `result` |
| 2+ axes `advisory` (even if none `fail`) | `changes_requested` (signal of accumulated debt) |

---

## Axis 1 — Security

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill (reference/security-review-guide.md) -->

Reviewer asks: **does this diff introduce a vector an attacker can use?** This is
NOT a full SRS-level security review (that is `saga-architecture-reviewer`'s
OWASP/ASVS pass). This is a targeted read of the changed lines.

### Sub-checks (port from EXT-3 security-review-guide)

- **S1. Input validation at trust boundaries.** Any new function that reads
  external input (HTTP body, file path, CLI arg, MCP tool arg, env var, message
  from another worker) MUST validate before use. Missing validation at a
  boundary → `fail`. Internal-only helpers → `pass` with no note.
- **S2. Injection surface.** Diff adds string concatenation into a shell
  command, SQL query, HTML template, or path.join with user-controlled segment
  → `fail` unless a sanitizer/parameterization is visible in the same diff.
- **S3. Secret handling.** Diff writes a literal that looks like a key/token
  (`AKIA...`, `-----BEGIN`, hex ≥ 32 chars assigned to a `*_KEY`/`*_TOKEN`
  name), OR logs a secret-bearing object → `fail`. Use of `process.env.NAME`
  with no echo → `pass`.
- **S4. Authn/Authz on new endpoints.** A new HTTP/MCP handler that mutates
  state or reads private data without an auth check visible in the diff →
  `fail`. If the route is mounted under an authenticated parent, that counts.
- **S5. Dependency provenance.** Diff adds a new `import` from a package not
  already in `package.json` OR a new entry to `package.json` dependencies →
  `advisory` (flag for supply-chain review; not a hard block at this layer).
- **S6. Prompt/tool-abuse (agentic surface only).** If the diff is inside a
  prompt template, tool dispatcher, or model-call wrapper: any string
  interpolation of untrusted text into the prompt without delimiting/escaping
  → `fail` (prompt injection vector). N/A for non-agentic code.

> **OWASP depth lives elsewhere.** Full OWASP:2025 / ASVS 5.0 coverage is
> `saga-architecture-reviewer/security-axes.md`. Do not expand S1–S6 into a
> second OWASP pass here — that duplicates the architecture review.

---

## Axis 2 — Performance

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

Reviewer asks: **does this diff introduce an obvious complexity cliff?** This is
static reasoning, not profiling. Deep profiling is `saga-perf-tuner`'s job.

### Sub-checks

- **P1. Algorithmic complexity.** A new loop nested inside another loop over the
  same growing collection (O(n²) or worse) where n is unbounded (request count,
  file list, DB rows) → `advisory` if the collection is bounded and small,
  `fail` if it is unbounded and the diff shows no cap/pagination.
- **P2. N+1 queries / repeated I/O.** Diff calls an async resource (DB, fetch,
  fs.readFile) inside a loop without batching → `fail`. Use `Promise.all`,
  `IN (...)`, or a bulk API.
- **P3. Leaks.** Diff opens a handle (file, socket, timer, event listener,
  DB connection, worktree) without a matching close/release in scope → `fail`.
  Look for `addEventListener` / `setInterval` / `fs.open` without a cleanup.
- **P4. Synchronous blocking on the hot path.** Diff adds a `*Sync` fs call,
  `child_process.execSync`, or a long CPU loop on a request/worker path that
  must stay async → `advisory` (build scripts may legitimately use Sync; worker
  handlers may not).
- **P5. Reactivity / memoization correctness (UI only).** Unbounded
  re-render: `useEffect` with no dep array, or a `computed`/`watch` over a
  growing object → `advisory`. See `frameworks.md` for framework-specific
  detail.
- **P6. Cold-start bloat.** Diff adds a top-level `import` of a heavy module
  (moment, lodash full, a giant generated client) into a file that runs at
  startup → `advisory`.

> **Measure-first is not this skill.** If a finding needs a profile to confirm,
> mark `advisory` and route a follow-up to `saga-perf-tuner`. The reviewer
> blocks only on complexity that is obvious from the diff.

---

## Axis 3 — Maintainability

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

Reviewer asks: **will the next agent (or human) be able to read and change this
safely?**

### Sub-checks

- **M1. Naming.** Names (`function`, `class`, `const`, file) say what the thing
  IS, not how it is implemented or when it was added. `handleX` / `tmp2` /
  `data2` / `NewHandler` → `advisory`. A name that actively misleads (e.g.
  `isReady` that returns a count) → `fail`.
- **M2. Dead code & commented-out blocks.** Diff adds commented-out code, or
  new `export`s with no caller anywhere in the diff or `src/` → `advisory`.
  (The deterministic `tsc TS6133` check already catches unused locals; M2 is
  about exported dead surface and commented blocks tsc cannot see.)
- **M3. File cohesion.** A changed file now spans ≥ 3 unrelated responsibilities
  (mixing e.g. serialization, validation, and I/O with no shared abstraction)
  → `advisory`. This layers on top of the deterministic 500-line rule; a file
  under 500 lines can still be incohesive.
- **M4. Magic values.** Diff introduces an unexplained literal (timeout, retry
  count, threshold, status code) in logic (not in a test fixture) without a
  named constant or an inline comment → `advisory`.
- **M5. Doc on public surface.** A new `export`ed function/type with non-obvious
  behavior has no doc comment (`/** ... */`) → `advisory`. Trivial getters/
  setters are exempt.
- **M6. Consistency with neighbors.** The diff introduces a style that
  contradicts the surrounding module (e.g. class methods in a file that is all
  functional, callbacks in an async/await file, `null` in a `undefined`-idiom
  file) → `advisory`.

---

## Axis 4 — Correctness (craft-level, not behavior)

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

Reviewer asks: **does the code do what its signatures claim, locally?** This is
NOT "does it satisfy the AC" — that is `saga-verifier`'s L3 job. This axis catches
local defects that a property test might miss on a happy-path run.

### Sub-checks

- **C1. Error handling.** A `try/catch` (or `.catch`, or `Result`/`Either` match)
  that swallows the error (empty block, `console.log` only, or returns a
  default without rethrowing or marking failure) on a path where the caller
  cannot otherwise detect failure → `fail`.
- **C2. Nullish/undefined access.** Diff indexes (`x.y`, `x[i]`, `x!`) into a
  value whose type or assignment shows it can be `null`/`undefined`, without a
  guard → `fail`. (tsc with `strict` catches many; C2 catches the rest, e.g.
  non-null assertions that defeat tsc.)
- **C3. Boundary conditions.** Off-by-one, empty-collection, or `>=` vs `>`
  errors visible in the diff → `fail` when obvious. If non-obvious, defer to
  the verifier's property tests and mark `advisory`.
- **C4. Concurrency correctness.** A new `await` inside a loop where iteration
  depends on the previous iteration's result is fine; a shared mutable
  captured by concurrent closures without synchronization → `fail` when the
  race is visible in the diff.
- **C5. Type-port contract (saga-specific).** If the diff touches a Port (an
  interface declared as the SRS §2b Port Registry contract), the implementation
  type must match the Port exactly — no extra required fields, no narrower
  return type that violates substitutability. Mismatch → `fail`. (This catches
  the Cannon `TrajectoryResult` vs `OrbitResult` drift class.)
- **C6. Idempotency / retry-safety.** If the task's `metadata.hint` or the AC
  properties declare the operation idempotent or retryable, the diff must not
  introduce a side effect that breaks that (e.g. push-to-array without a guard
  on retry) → `fail`.

> **Behavior is the verifier's call.** C1–C6 are about local, static defects.
  If a sub-check needs the AC's property tests to discriminate, do NOT invent a
  verdict here — emit `advisory` and let `saga-verifier` decide.

---

## Recording the axis read

The reviewer's `worker_done.result` MUST include an **Axes** block, one line per
axis, so the next Builder (or a re-review) can see the semantic read, not just
the deterministic numbers:

```
Axes:
- security: pass
- performance: advisory (P1 — O(n²) over request list in src/handlers/bulk.ts:88; list is capped at 100, non-blocking)
- maintainability: pass
- correctness: pass
```

On `changes_requested`, the BLOCKERS list must prefix each item with its axis
tag, e.g. `[security S2]`, `[correctness C5]`, so the Builder can see which
axis the fix belongs to.

## What these axes do NOT do

- They do not change the episode stage. Verdict → `worker_done` → transition.
- They do not authorize a retry or a degradation. R5: no-self-authorization.
- They do not replace L3 property tests. Behavior is `saga-verifier`.
- They do not re-derive the AC. The AC is the frozen baseline; axes audit craft
  against the diff, not against reinterpreted requirements.
