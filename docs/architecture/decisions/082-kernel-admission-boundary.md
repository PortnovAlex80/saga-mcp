# ADR-082: The kernel admission boundary — what a workshop declares and what costs a kernel edit

- **Status:** Accepted
- **Date:** 2026-08-18
- **Supersedes:** nothing; first explicit statement of a boundary that already existed implicitly
- **Program:** Saga Core Renewal, release K14 (see `docs/vision/SAGA-CORE-RENEWAL-PLAN.md`).
  External opening of the boundary is owned by Controlled Change Plane release
  C12 — Semantic Adapter SDK (`docs/vision/CONTROLLED-CHANGE-PLANE-PLAN.md:671`).

---

## Context

CONVEYOR §3 (the LEGO principle) promises that workshops declare WHAT and the
runtime owns HOW: adding an ordinary workshop must not add a dispatcher, a
lifecycle engine, a submit protocol or an acceptance machine, and the kernel must
not branch on a workshop's name. The product ambition built on that promise —
assembling factories for new domains out of kernel atoms — makes the promise
load-bearing rather than aesthetic.

An audit on 2026-08-18 tested the promise against the code, starting from a
specific suspicion: that the `development` workshop had grown private machinery.

The suspicion was not confirmed, and the measurement that suggested it was
itself wrong. `development` is not the largest workshop (`discovery` is: 12,685
lines against 11,023). Its four kernel nodes are not a code-production signature
— `delivery` has the same four in the same "prepare → act → observe → settle"
shape while producing no code at all. Exactly one behavioural branch on a stage
name exists anywhere in the kernel (`linkType: 'implements' | 'depends_on'` by
`workflowStage` in `sqlite-production-cell-projection-persistence.ts`); every
other name mention is a warning set, owner metadata, a named constant, a comment,
or the legacy `epics.stage` enum.

What the audit did find is a different and more precise gap. The **mechanics** of
production are generic; the **admission ceremony** is not. Full evidence:
`docs/research/2026-08-18-kernel-surface-evidence-development-chain.md`;
reasoning: `docs/research/2026-08-18-ees-admission-judgment.md`.

## Decision

### 1. The factory is assembled from seven atom classes

| Atom | Role | Admission today |
|---|---|---|
| Flow node (`lm`, `kernel`, `human`, `composite`, `production-cell`) | structural unit of a flow | declarative |
| **Production Cell** | the universal production unit: fan-out, author/reviewer, gates, recovery, post-acceptance effect | declarative |
| KernelHandler | deterministic coordination over ports | in-repo (registered by TS installation code) |
| CheckProvider | deterministic four-valued judgment | closed manifest + `trusted_providers` trust ceremony |
| PostAcceptanceEffect | factory-owned post-acceptance transformation over a CAS ledger | closed manifest |
| PayloadContract | cross-process product decoder | closed manifest |
| Package | content-addressed declarative material (resources, schemas, skills, handler refs with digests) | declarative |

```
Workshop = Package + Cells (N, incl. fan-out) + KernelHandlers (K)
         + Capabilities (providers / effects / contracts) + lifecycle binding
Factory  = kernel (executor, gates, authority, effects, recovery, replay)
         + M workshops + lifecycles
```

### 2. Admission distance is the metric — not workshop size, not kernel-node count

**Admission distance** = the number of deliberate edits inside the kernel
repository required to plug in a new workshop of a given class.

| Tier | Produces | Admission distance today | Proof |
|---|---|---|---|
| 1 | text with review | **0** | `modules-ext/lm-marketing` — 17 files, zero runtime edits |
| 2 | deterministic computation via qualified providers | **1–2** | provider/effect code + manifest entries + a trust row |
| 3 | code, with a git candidate and runnability | **3–4** | `development` itself |

The two tiers differ in kind, not only in count. Tier 2's cost is a **trust
ceremony** — qualifying a deterministic provider, a legitimate and permanent
boundary made safe by four-valued check semantics, where an unqualified provider
yields an honest `unknown` rather than a false pass. Tier 3 adds **admission of
coordination code**, because a kernel handler writes into the authority.

Size is explicitly rejected as a signal: it measured `discovery` as the monster
and was wrong. Kernel-node count is rejected too: it measured `delivery` as
equivalent to `development` and was wrong about why.

### 3. Nothing moves out of `development` into the kernel

Everything that makes the code chain possible already lives in generic layers:
fan-out is the `materialization` field on a production cell executed by the
generic executor; the git candidate is the factory-level `git-integration` effect
with its CAS ledger, named by an opaque string the runtime never switches on;
runnability is the factory-level `local-runnability` check provider. There is
nothing to extract.

What is private to `development` is three kernel handlers — `resolve-task-graph`,
`freeze-integrated-candidate`, `bind-runnable-candidate`. Their **shape** is a
small repeatable skeleton ("canonicalize and materialize / observe and freeze /
bind a receipt"); their **body** is subject-matter validation of what a valid work
graph, a frozen integrated candidate and a runnability binding mean for the
material *code*. Body, not shape, is where the lines are.

**We do not abstract at N = 1.** There is exactly one consumer. The project's own
budget rule already forbids a new kernel abstraction before a reference
implementation and a second fixture exercise it (Controlled Change Plane §8.1).
An abstraction derived from a single consumer encodes that consumer's accidents
as contract.

### 4. The current admission distance is frozen, not reduced

Four manual admission surfaces exist and are pinned by exact counts in
`tests/architecture/kernel-admission-distance.test.mjs`:

1. `WORKSHOP_PAYLOAD_CONTRACTS`
2. `WORKSHOP_EXECUTABLE_CAPABILITIES` — `requireExecutableCapability` fails closed
   with `WORKSHOP_CAPABILITY_UNDECLARED`
3. the `register*` calls in the composition root (`src/app/product-lifecycle-runtime.ts`)
4. the lifecycle start gateway, which admits only `PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA`

Exact counts, never lower bounds: a lower bound permits exactly the silent growth
the ratchet exists to catch. Raising a number is legitimate — **in the same commit
as the admission it accounts for, with that admission stated in the message**.

The single behavioural `linkType` branch is allowlisted as the only one, and is
**not** to be fixed here: it is owned by K15 (unified vocabulary) and C5 (the
trace model owns edge types), and changing it now would silently alter persisted
projection data.

### 5. The boundary opens at C12, not before

C12's exit gate already demands what Tier 3 needs: "a minimal second fixture pack
passes the conformance kit", outside the kernel repository. The mechanisms are
built and in use — manifests pin real sha256 of installation modules (K3),
`trusted_providers` carries `trust_basis=built-in:digest` with drift detection,
binding receipts compare expected against resolved canonically. Opening admission
changes only the **source** of "expected": a package declaration instead of a
hardcoded list. That is opening a boundary, not a redesign.

Until then, opening admission — a composite capability manifest, a package
shipping its own kernel handler, a second accepted lifecycle input schema — is
forbidden.

## Consequences

**Accepted costs.** Tier 3 is honestly "LEGO with a screwdriver": a second
code-producing workshop needs one reviewed PR into the kernel. If the platform is
sold to software teams before C12, that friction is visible in a demo. The
mitigation is what GTM already prescribes: sell the reference factory, not
"add your own workshop".

**What this protects.** Opening admission weakens the desync firewall — the
lesson of LIVE-REVIEW-004. Freezing the distance first means that when C12 opens
the boundary, the conformance kit knows exactly which surfaces it must keep
parity on, and a negative cross-process drift test is writable against a known
list rather than a guess.

**A trusted handler pack is admitted whole or not at all.** A kernel handler
writes into the authority; "partially trusted handler" is not a coherent state.
C12 packs therefore pass the same review tier as kernel releases.

**Correction to the product premise.** The original framing held that if the code
chain were private, the platform claim would be false for the main scenario. That
misidentified the main scenario. Per `FROM-SOFTWARE-FACTORY-TO-ENGINEERING-PLANT`
§5 and `GO-TO-MARKET-RU-THEN-EU` §1–4, what is sold is expertise-ready
engineering calculation volumes — Tier 2. **The git candidate and runnability are
not on the main scenario's critical path.** The asymmetry is real and its business
exposure is bounded: it sets the platform roadmap, not the product's viability.

## Non-goals

- No runtime behaviour changes in this ADR.
- No generic-atom extraction from the three development handlers.
- No fix to the `linkType` branch.
- No claim that admission distance must reach zero for every tier. It is driven
  toward zero **selectively**, where a real second consumer exists.

## Enforcement

- `tests/architecture/kernel-admission-distance.test.mjs` — the four frozen
  counts and the single allowlisted behavioural branch.
- `tests/architecture/workshop-manifest-parity.test.mjs` — existing parity of the
  capability manifest across processes.
- This ADR's closure evidence is owned by K14, whose commit train already carries
  `refactor(modules): compile module definitions into Production Cells` — the
  in-core mechanism through which admission later becomes declarative. C12 then
  opens that mechanism to packages outside the kernel repository.
