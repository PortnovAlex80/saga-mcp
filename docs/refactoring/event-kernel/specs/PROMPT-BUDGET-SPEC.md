# PROMPT-BUDGET-SPEC — EK-1 successor admission specification for the bounded prompt and context envelope

**Work package:** WP-16 part 3 of 3 (specification author role; author is
barred from WP-05/WP-17/WP-18 implementation).
**Branch:** `ek1/wp16-prompt-budget`, base SHA `21ba0816`.
**Status:** FROZEN admission specification per plan EK-1 ("Successor
admission specifications": produce `prompt-budget-profile.schema.json`,
pin the token-counter protocol/version, classify every context source, and
define exact pre-spawn overflow, repair, retry-charge and terminal
semantics). Any later semantic change reopens EK-1 and invalidates
downstream qualification evidence.

## 1. What this specification set freezes

A `PromptBudgetProfile` is an **immutable, content-addressed value in the
installed workshop manifest**, bound into work through
`CanonicalRoleContract.promptBudgetProfileRef + digest`. It is not a
mutable workflow relation and not an additional aggregate owner. One
profile pins: the read-only provider/model limit table reference, the
exact context limit for the route pinned on the attempt, the token-counter
identity, the request/session/token/byte caps, the four layer budgets, the
output/overhead/safety reserves, and the hard byte backstop.

The value shape, the source classification and the runtime semantics are
frozen in four artifacts in this directory:

| File | Freezes |
|---|---|
| `prompt-budget-profile.schema.json` | The plan's PromptBudgetProfile block EXACTLY (14 properties, `additionalProperties: false`); positive-finite enforcement on every limit (zero/missing/unsupported fail closed; no unbounded representation); `providerModelLimitTableRef` + `$defs/ProviderModelLimitTable` (exact-key `(provider, model, version)` lookup, wildcards/defaults/fallback/priority structurally absent); `$defs/TokenCounterRef` (name/protocolVersion const-pinned to `saga-token-counter-protocol` v1) |
| `context-source-classification.json` | The closed five-class vocabulary (`mandatory-inline`, `bounded-summary`, `content-addressed-reference`, `bounded-tool-result`, `forbidden-duplication`), the per-class laws, and CS-01..CS-16 covering every current+target context source with owner package, enforcing boundary and census §7.2 provenance (PA-1..PA-10; PA-2 documented as the replaced baseline mechanism) |
| `context-envelope-semantics.md` | The exact frozen runtime semantics: accounting model and formulas, admission linearization point, `admitProviderRequest` CAS semantics, pre-spawn overflow result, repair path, retry-charge table, terminal semantics, crash windows (incl. D12 operator disposition), token-counter protocol laws, PromptAssemblyReceipt grammar, EK-12 transport requirement |
| `validate-prompt-budget.mjs` (+ `examples/`) | The deterministic validator: schema self-check against the exact plan field list, classification gate, miniature valid examples (glm-5.2 128K-class, glm-4.7 200K-class), and a 16-entry RED mutation corpus |

## 2. Baseline evidence encoded (why this exists)

1. **Elite-3 planner payload death spiral** — stage20-elite
   `RUN-TRACKER.md:214`: unbounded accumulation of gate feedback across
   retries grew a planner request to **436,283 bytes**; the provider
   rejected it pre-tool; the shim retried the **identical** request 8
   times before supervision terminalized the run. Encoded as: bounded
   recovery layer (`maxRecoveryTokens`), CS-15 forbidden unbounded
   verbatim accumulation, typed pre-spawn refusal with **no retry-budget
   charge and no identical reissue** (semantics §5.1), and repair as a
   Workplace transition with a re-profiled envelope (§5.2).
2. **`SAGA_PROMPT_MAX_BYTES ?? 0` = UNLIMITED** —
   `tracker-view/claude-runner.mjs:581` at base `21ba0816`: the only
   request cap in production is opt-in and defaults off. Encoded as: every
   limit is a positive finite integer; the successor law has **no
   unbounded representation at all** (schema `PositiveFiniteInteger`;
   RED mutations M01/M02/M03/M06 prove zero/missing/null/sentinel all
   fail).

## 3. The five laws a reader must carry away

1. **Admission linearizes immediately before final request
   serialization/network send**, after every assembly and injection; every
   cognition transport must call `activityAttempt.admitProviderRequest`
   at exactly that boundary.
2. **Receipts say `admitted` or `refused`, never `sent`.** Send/outcome
   evidence (`ProviderSendOutcome`) is a separate fact.
3. **Dynamic overflow is a typed owning-aggregate outcome** — refused
   receipt → `activityAttempt.recordProviderRefusal` →
   `ActivityAttempt:failed-typed` — with no context consumption, no
   worker-retry charge, and no identical reissue. Repair goes through
   `workplace.enterRepairWait` → `obligation:requeueRepair` →
   `workplace.admitWorkIntent` with a different profile.
4. **Crash before send redrives the same `obligation:providerSend` and the
   same request ordinal**; crash after a non-idempotent send is typed
   uncertainty (`TypedWait:effect-uncertainty`) resolved by operator
   disposition per frozen decision D12 — never a blind duplicate send.
5. **The counter is pinned or the request is refused.**
   `saga-token-counter-protocol` v1, content-addressed implementation +
   encoding; drift is a `TOKEN_COUNTER_MISMATCH` failure. Provider
   usage is postflight evidence, never the admission oracle.

## 4. EK-12 enforcement: why an instrumented transport is mandatory

The admission boundary is only real if the transport can expose **every
final pre-send request** — including mid-loop requests assembled after
tool results — to the accountant before the network.

**The current production transport cannot satisfy this** (documented
blocker, not a to-do for this WP): workers spawn through
`tools/agent-proxy/claude-shim.mjs` → `opencode run` (stream-json,
translated). The shim observes the initial stdin payload and postflight
events; mid-loop requests and retained-context re-sends are assembled
inside the opaque CLI loop and are invisible to any pre-send accountant.

Consequently, per the plan (envelope section + EK-12 phase):

- an opaque CLI loop that cannot expose every final request and receipt is
  **nonconforming and cannot pass EK-12**;
- WP-18 must supply an instrumented OpenCode transport, or fail closed
  against a pinned OpenCode interface — postflight event usage cannot
  substitute for pre-send admission;
- the EK-12 preflight acceptance probes are frozen in semantics §9:
  inject an oversized hook context and an oversized tool result in a
  non-qualifying preflight and prove the exact next provider request is
  refused by its pre-send receipt **without reaching the network**;
- EK-12 itself must pin a positive finite PromptBudgetProfile compatible
  with the exact pinned provider/model and refuse to start otherwise.

This specification does not implement the transport; it pins the contract
the transport must satisfy and the test that accepts it.

## 5. Examples are illustrative by design

`examples/` contains miniature **valid** profiles for `zai/glm-5.2`
(128K-class, illustrative 131072 context) and `zai/glm-4.7` (200K-class,
illustrative 204800) plus an illustrative exact-key limit table, all
clearly marked `illustrativeOnly`. Every example carries conservative
made-up numbers; **real production profiles and limit tables land at
EK-8**, pinned from the real `FACTORY_CLOUD_MODELS` catalog and provider
documentation. The example table's digest discipline is real: it is
computed over the canonicalized rows array, and the profiles bind it by
digest — live RED mutation 3 below shows that editing one table row
invalidates the table self-digest and every profile pin simultaneously.

## 6. Validation and reproduction

```bash
node docs/refactoring/event-kernel/specs/validate-prompt-budget.mjs            # full report
node docs/refactoring/event-kernel/specs/validate-prompt-budget.mjs --digest-only
```

Zero dependencies (node:crypto, node:fs). Exit 0 only when every green
check passes AND every RED mutation fails.

**Determinism (two consecutive runs, same tree):**

```text
run1: PASS sha256:340101e72e92416216ae72a9f66b1885e7d9554cbf483a01ab2fe49ea485e9e5
run2: PASS sha256:340101e72e92416216ae72a9f66b1885e7d9554cbf483a01ab2fe49ea485e9e5
```

**In-corpus RED mutations (16, all red):** M01 zero limit; M02 missing
limit; M03 null limit; M04 missing counter; M05 counter drift; M06
"unlimited" string sentinel; M07 extra profile field; M08
maxTotalInputTokens > effectiveInputLimit; M09 session budget below one
maximal request; M10 limit-table `fallbackModel`; M11 wildcard key; M12
profile/table limit disagreement; M13 unbound table digest; M14
unclassified source class; M15 mandatory-inline without no-silent-omission;
M16 unsupported route pin.

**Deliberate live RED mutations on the real artifacts (each reverted after
the run; baseline digest restored afterwards):**

1. Added source `CS-17 "operator mood injection"` with class
   `inline-when-feeling-generous` to `context-source-classification.json` →
   `FAIL ... is not in the closed vocabulary ... unclassified context
   sources are a spec violation, not a default`, exit 1.
2. Set `maxProviderRequests = 0` (the exact `?? 0` disease) in
   `examples/glm-5.2.prompt-budget.example.json` →
   `FAIL ... not a positive finite integer ... fail closed: 0`, exit 1.
3. Added `fallbackModel` + `priority` to a row of
   `examples/provider-model-limit-table.example.json` →
   `FAIL ... additional property not allowed — selection/fallback/priority
   semantics are structurally forbidden` (+ digest-binding cascade),
   exit 1.

## 7. Scope boundaries

- No production `src/` or kernel implementation is touched; this WP is a
  specification author deliverable (plan: implementers of WP-05/WP-17/
  WP-18 must not author these specs, and the author is barred from
  implementing them).
- Frozen inputs were read-only: the plan, PROTOCOL-DECISIONS-FROZEN.md,
  the WP-01 census, the frozen transition universe @ `d41cebe0`.
- `package.json` is coordinator-owned: wiring
  `npm run validate:ek-admission-specs` (the EK-1 exit gate that combines
  the complexity, role-contract and prompt-budget validators) is
  integration-coordinator work, not this branch.
- The PromptAssemblyReceipt grammar is frozen here as text (semantics
  §7); its machine-readable encoding is WP-18 implementation detail that
  must match this grammar.
- The concrete token-counter implementation artifact (its content-addressed
  bytes) does not exist yet; WP-18 pins it, and admission verifies the
  digest against the profile pin at runtime.
