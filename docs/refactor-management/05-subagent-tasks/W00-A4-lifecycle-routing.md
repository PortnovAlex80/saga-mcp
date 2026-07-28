# W0-A4 — Characterization: lifecycle routing, mapping, lock, restart

**Wave:** 0 · **Lane:** A4 · **Plan ref:** §0.3.5, §13.8–13.11, §13.21, §13.26–13.27
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a4`

## Context

- Plan §6 (Lifecycle Scenario Package), §13.8–13.11 + §13.21 + §13.26–13.27.
- Baseline sections: `lifecycle.ts`, `lifecycle-orchestrator.ts`, `lifecycle-router.ts`, `lifecycle-mapper.ts`, `product-delivery-lifecycle.ts`.

## Architecture rule served

Lock lifecycle orchestration mechanics — the parts plan §13.25–13.30 says to
PRESERVE (durable snapshots, hashes, leases, restart, transactional stage
completion, common executor shape, restricted mapping) — and pin the parts plan
§13.8–13.11/§13.21 say to CHANGE (routeResolver function, definition hash
dropping functions, resolving installation at stage time instead of pinning at
start, cumulative-frame handoff).

## What you OWN

- `tests/characterization/lifecycle-routing-mapping-lock.test.mjs` — NEW, single file.

## What to characterize

1. **`lifecycle-router.ts`** (`routeProcessOutcome`, `validateLifecycleDefinition`):
   - With a `routeResolver` function present, it is called FIRST and its result wins over the static `outcomeRoutes` table. (Pin this — it is the non-serializable behavior Wave 7 replaces.)
   - With no resolver, the static table routes by outcome name.
   - `validateLifecycleDefinition`: rejects missing entry stage, routes targeting nonexistent stages, missing outcome coverage. Pin each rejection.
   - Local `Set` for stage-id validation (note: not persisted — pin that validation is runtime-only).

2. **`lifecycle-mapper.ts`** (`mapLifecycleValues`, `resolveLifecyclePath`):
   - JSON-path reads from root / prior-stage outputs / runtime fields.
   - Hardening: paths containing `__proto__`, `prototype`, `constructor` are rejected. Pin each rejection case.
   - Literal values pass through.

3. **`lifecycle-orchestrator.ts`** (definition hash + lease + restart):
   - `definitionHash` via `canonicalJson` — assert that a `routeResolver` function field contributes ONLY a present-vs-absent bit (i.e. hashing the same definition with and without a resolver function yields hashes that differ only by the resolver's presence, NOT its body). This pins the §13.9 smell.
   - Lease acquisition on a lifecycle run (assert lease token shape; assert a second acquirer is rejected while the lease is held).
   - Restart: a lifecycle run persisted mid-stage reloads and resumes (use the sqlite repo against a tmpdir DB). Pin the resume point semantics.

4. **`product-delivery-lifecycle.ts`**:
   - The `routeResolver` is attached via `Object.defineProperty(..., {enumerable:false})`. Pin that `Object.keys(definition)` does NOT include `routeResolver` but `definition.routeResolver` is a function. (This is the dodge Wave 7 removes.)
   - The `discoveryGate: 'permissive'|'strict'` switch is implemented inside the resolver. Pin the two routing outcomes.
   - Stage order is `product-discovery` → `solution-formalization` → `solution-development` → `delivery-release`.

5. **Cumulative-frame handoff** (§13.21):
   - Pin that a transition persists a cumulative frame containing root input + all prior stage payloads (the behavior Wave 7 replaces with content-addressed single-output storage). Use a 3-stage mock lifecycle and assert the third stage's input envelope contains data from stage 1.

6. **Transactional stage completion** (§13.27 — PRESERVE):
   - Pin that stage completion + next-stage creation occur in one transaction (a failure between them rolls both back). Construct a scenario where the next-stage insert fails and assert the completion is not persisted.

## Anti-scope

- Do NOT edit production source.
- Do NOT replace `routeResolver` or cumulative-frame (Waves 7's job).
- Do NOT touch other lanes' files.

## Exit criteria

- [ ] Test file passes today.
- [ ] Each of the 6 areas has at least one assertion.
- [ ] For each pinned "smell" (resolver-first, hash-drops-function-body, defineProperty dodge, cumulative frame), add a `// WAVE 7 WILL CHANGE THIS` comment so the eventual diff is obvious.
- [ ] No production source modified.

## Return to integrator

1. Branch name. 2. `git diff --stat`. 3. Passing test summary. 4. List of pinned smells destined for Wave 7. 5. Confirmation.
