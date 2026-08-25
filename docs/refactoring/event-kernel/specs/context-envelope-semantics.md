# Context Envelope Semantics — EK-1 frozen admission specification

**Status:** FROZEN admission specification (EK-1, "Successor admission
specifications"). Authored in WP-16 part 3, branch `ek1/wp16-prompt-budget`,
base SHA `21ba0816`. Any later semantic change REOPENS EK-1 and invalidates
downstream qualification evidence (plan law; PROTOCOL-DECISIONS-FROZEN
header law).

**Upstream authority (read-only inputs):**

- `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md`,
  section "Bounded prompt and context envelope" — the PromptBudgetProfile
  block, the effectiveInputLimit formulas and every bullet law, verbatim.
- `docs/refactoring/event-kernel/PROTOCOL-DECISIONS-FROZEN.md` (esp. D12:
  effect/send uncertainty = operator disposition command receipt, never an
  automatic duplicate of a non-idempotent external send).
- Unified transition universe `transition-universe.json` @ `d41cebe0`
  (branch `ek1/graph-reconciliation`): all command/obligation/wait/evidence
  names pinned below are quoted from it.
- WP-01 authority census `AUTHORITY-CENSUS.md` §7.2, sites PA-1..PA-10.

**Companion artifacts in this directory:** `prompt-budget-profile.schema.json`
(the frozen value shape), `context-source-classification.json` (the closed
five-class vocabulary and the full source table),
`validate-prompt-budget.mjs` (deterministic validator + RED mutation corpus),
`PROMPT-BUDGET-SPEC.md` (narrative), `examples/` (illustrative profiles).

---

## 1. Baseline evidence encoded by this spec

Two production facts are the reason these semantics exist; every rule below
must be read as their structural prevention:

1. **Elite-3 planner payload death spiral** (stage20-elite `RUN-TRACKER.md`
   line 214, evidence in `task13-evidence/`): retry prompts accumulated gate
   feedback unboundedly until the planner request hit **436,283 bytes**; the
   opencode/Z.AI API rejected it pre-tool; the shim retried the identical
   oversized request **8 times** (all `class=pre-tool-death`, ~3 min per
   spawn, 3 lost executions) until supervision terminalized the run.
2. **`SAGA_PROMPT_MAX_BYTES ?? 0` means UNLIMITED** —
   `tracker-view/claude-runner.mjs:581` at base `21ba0816`: the only request
   cap in the production pipeline is an opt-in environment variable whose
   unset/zero value disables it. A safety invariant that defaults to off is
   the baseline insufficiency this spec replaces: the successor has **no
   unbounded representation at all**.

## 2. Pinned vocabulary (frozen transition universe)

All names below are frozen by the unified universe @ `d41cebe0`; this spec
adds no state, command, receipt or wait kind:

| Role | Name |
|---|---|
| Owning aggregate | `ActivityAttempt` |
| Admission command | `activityAttempt.admitProviderRequest` |
| Send command (transport) | `cognition.sendProviderRequest` |
| Launch obligation | `obligation:launchAdmission` (`activityAttempt.create` → `activityAttempt.admitProviderRequest`) |
| Send obligation | `obligation:providerSend` (`admitProviderRequest` → `cognition.sendProviderRequest`) |
| Refusal recording | `activityAttempt.recordProviderRefusal` |
| Loss classification | `activityAttempt.classifyWorkerLoss` |
| Retry obligation | `obligation:retryAttempt` (`classifyWorkerLoss` → `activityAttempt.create`) |
| Repair entry | `workplace.enterRepairWait` → `obligation:requeueRepair` → `workplace.admitWorkIntent` |
| Repair epoch rollover | `workplace.rolloverRepairEpoch` (+ D6 truthful-failure terminality) |
| Send uncertainty wait | `TypedWait:effect-uncertainty` (D12) |
| Admission evidence | `PromptAssemblyReceipt:admitted` / `PromptAssemblyReceipt:refused` |
| Settlement evidence | `ContextEnvelopeComplianceEvidence` (predicate, no new linearization point) |
| Send/outcome evidence | `ProviderSendOutcome` (separate from admission — receipts never prove send) |
| Value types | `PromptBudgetProfile`, `CanonicalRoleContract` — immutable content-addressed values in the installed workshop manifest, never mutable relations |

## 3. The accounting model

### 3.1 What is counted

One cumulative accountant runs before **every** provider request and covers:
initial prompt, protocol skill, semantic skill, task projection, tool
schemas, hook `additionalContext`, retained assistant/tool results,
recovery history/feedback injections, workspace block, write-authority
block, desk reference. Every source is classified in
`context-source-classification.json` (closed vocabulary of five classes);
an unclassified source is a spec violation, not a default.

### 3.2 Formulas (frozen exactly as the plan states them)

```text
effectiveInputLimit = providerContextLimit
  - reservedOutputTokens
  - providerOverheadReserveTokens
  - safetyMarginTokens

requestInputTokens <= min(maxTotalInputTokens, effectiveInputLimit)
cumulativeInputTokens + requestInputTokens <= maxCumulativeSessionInputTokens
requestOrdinal <= maxProviderRequests
serializedRequestBytes <= maxPromptBytes
layerTokens <= layerBudget        // static | dynamic | recovery | toolResult
```

`providerContextLimit` is `providerContextLimitTokens` from the profile and
MUST equal the `contextLimitTokens` of the `ProviderModelLimitTable` row
keyed by the exact `(provider, model, version)` already pinned on
ActivityAttempt at `activityAttempt.create` (single route-policy
evaluation). A missing row, a wildcard match, or any inequality is a
fail-closed admission error: **zero, missing and unsupported provider/model
limits fail closed.** The limit table is a read-only lookup; it cannot
select, reroute, fallback or infer a route (schema `$defs/ProviderModelLimitTable`
structurally excludes selection fields).

### 3.3 Counter authority and the linearization point

- `ActivityAttempt` is the **sole mutable owner** of context admission. It
  stores CAS-fenced `contextRevision`, `nextRequestOrdinal` and
  `cumulativeInputTokens`. Receipts are evidence, not counter authority.
- The accountant never derives current authority by selecting a latest
  receipt or summing receipt rows.
- The **admission linearization point** is immediately before final provider
  request serialization/network send, *after* system prompts, skills, tool
  schemas, hook `additionalContext`, retained assistant/tool results and
  recovery injections. Every cognition transport must call the admission
  command at exactly that boundary.
- The transport enforces `maxOutputTokens <= reservedOutputTokens` or
  refuses a provider/model for which no conservative output bound can be
  enforced.
- Provider-reported usage is postflight evidence (divergence telemetry),
  never the admission oracle.

## 4. Admission command semantics

`activityAttempt.admitProviderRequest(expectedContextRevision, envelope)`:

1. CAS on `expectedContextRevision == contextRevision`; mismatch fails the
   command (stale assembler snapshot), consuming nothing.
2. Count the envelope with the pinned token counter (§6).
3. Atomically validate **every** limit (§3.2) plus mandatory-layer digest
   presence (no mandatory semantic layer may disappear through silent
   truncation; optional omission order is deterministic and recorded).
4. **On admission:** advance `nextRequestOrdinal`/`cumulativeInputTokens`,
   append an immutable `PromptAssemblyReceipt:admitted` to attempt
   evidence, and create exactly one idempotent
   `obligation:providerSend` naming the receipt digest and ordinal.
5. **On refusal:** append an immutable `PromptAssemblyReceipt:refused`
   persisting the rejected-envelope digest and the typed limit violation;
   counters do not advance; **no context and no worker-retry budget is
   consumed**; no `obligation:providerSend` is created. The transport never
   serializes or sends.

## 5. Overflow, repair, retry-charge and terminal semantics (exact)

### 5.1 Pre-spawn overflow result (dynamic)

Dynamic overflow (assembled request exceeds any §3.2 limit at the §3.3
boundary) produces a **typed owning-aggregate outcome**, not a spawn, not
an exception in a worker process, not a shim retry:

```text
PromptAssemblyReceipt:refused
  → activityAttempt.recordProviderRefusal
  → ActivityAttempt:failed-typed (provider refusal class)
```

- **No retry-budget charge:** the refusal is deterministic; the identical
  request cannot succeed later. `classifyWorkerLoss` must not route a
  budget-refusal to `obligation:retryAttempt` (retry is for worker loss /
  external availability / malformed results, not deterministic overflow).
- **No identical reissue:** no send obligation exists for a refused
  envelope; re-running the same assembler with the same inputs yields the
  same refusal. The Elite-3 "8 identical 436,283-byte retries" pattern is
  structurally impossible.

### 5.2 Repair path (which obligation/wake)

Recovery from dynamic overflow is a **Workplace repair transition**, not an
attempt retry:

```text
GateDecision:repair verdict / typed refusal evidence
  → workplace.enterRepairWait            (records RecoveryIssue feedback)
  → obligation:requeueRepair
  → workplace.admitWorkIntent            (with a re-profiled envelope)
```

- The re-queued WorkIntent must bind a role contract whose
  `promptBudgetProfileRef` differs (smaller layer budgets, more
  content-addressed references, bounded feedback instead of verbatim
  accumulation). Re-issuing the same profile that just refused is a spec
  violation (identical reissue).
- Repair epochs and their exhaustion follow D6
  (`workplace.rolloverRepairEpoch`; truthful-failure terminality via
  `RepairTerminalityEvidence`).

### 5.3 Static overflow

Static over-budget workshop packages (skills/tool schemas that cannot fit
`maxStaticTokens`) **fail installation/admission** of the package. They
never spawn an attempt and never reach the accountant at runtime.

### 5.4 Retry-charge semantics (summary table)

| Event | Charges worker-retry budget? | Charges cumulative input? | Creates providerSend obligation? |
|---|---|---|---|
| Admitted request | no | yes (by requestInputTokens) | yes (one, idempotent) |
| Refused (limit violation) | **no** | **no** | **no** |
| Crash before send (redrive) | no | no (already charged at admission; not re-charged) | same obligation redriven, same ordinal |
| Crash after non-idempotent send | no | already charged | no duplicate — D12 wait |
| Worker loss / malformed result | yes (via `classifyWorkerLoss` → `obligation:retryAttempt`) | per admitted requests only | per new attempt |

### 5.5 Terminal semantics

- `ContextEnvelopeComplianceEvidence` is a settlement-time predicate over
  the attempt's `PromptAssemblyReceipt` sequence plus role-digest pins; it
  introduces no new linearization point and feeds `TerminalProof:run.success`.
- A run cannot claim success with any provider request that lacks a
  pre-send admitted receipt (admitted-not-sent law: the receipt proves
  admission, `ProviderSendOutcome` proves send/outcome separately).
- Unbounded repetition terminates through repair epochs (D6) and policy
  quotas (`TypedWait:policy-quota`), never through silent payload growth.

## 6. Token-counter protocol (pinned)

**Contract name:** `saga-token-counter-protocol`, **version:** `1`
(schema consts). A profile pins one counter identity:
`{name, protocolVersion, implementationRef, digest, digestAlgorithm,
encoding}` (content-addressed; see `$defs/TokenCounterRef`).

Laws of v1:

1. **Local pure function:** `count(serializedRequestBytes, encoding) →
   tokenCount` (+ per-layer counts when applied layer-wise). No network,
   clock, randomness or provider API. It can never become the send path.
2. **Deterministic:** identical bytes + identical pinned identity
   (implementation digest + encoding) ⇒ identical counts on any machine.
3. **Counts the exact admitted form:** the input is the final serialized
   request (the same bytes the transport would serialize), after all
   assembly and injections at the §3.3 boundary.
4. **Drift = mismatch failure:** at admission the runtime verifies the
   running counter's identity digest equals the profile pin. Any mismatch
   (different implementation, different encoding, unpinned counter) is a
   typed `TOKEN_COUNTER_MISMATCH` failure and the request is refused —
   never a silent recount with a different counter, never a fallback
   estimate.
5. **Not the oracle:** provider-reported token usage may be recorded as
   postflight divergence evidence; it never overrides, replaces or
   retro-justifies admission counts.

## 7. PromptAssemblyReceipt grammar (frozen)

One immutable receipt per admission decision, appended to ActivityAttempt
evidence. `decision` is exactly **`admitted` | `refused`** — never `sent`
(send/outcome evidence is the separate `ProviderSendOutcome`).

```text
PromptAssemblyReceipt {
  decision                    // admitted | refused  (closed)
  attemptRef                  // owning ActivityAttempt
  requestOrdinal              // int, monotone per attempt (assigned on admission)
  contextRevision             // CAS revision the decision was made under
  profileRef + profileDigest  // the PromptBudgetProfile value applied
  counterIdentity {           // §6 pin actually used
    name, protocolVersion, implementationRef, digest, encoding
  }
  limitTableRef + digest      // read-only lookup artifact
  providerRoutePin            // exact (provider, model, version) from the attempt
  layerDigests[]              // NORMALIZED per-layer digests, fixed layer order
  layerTokenCounts[]          // per-layer counts from the pinned counter
  requestInputTokens          // total counted input tokens
  serializedRequestBytes      // byte backstop measurement (maxPromptBytes)
  cumulativeInputTokensAfter  // counter value after this decision (unchanged on refusal)
  limitChecks[]               // per-limit {limit, value, pass: bool}
  omissions[]                 // deterministic optional-layer omission order (admitted receipts)
  externalReferences[]        // content:// refs + digests traveling instead of raw material
  violation                   // refused only: typed limit that was exceeded
  rejectedEnvelopeDigest      // refused only: digest of the rejected envelope
}
```

Rules:

- Layer digests are computed over the **normalized** layer bytes (fixed
  serialization, no timestamps/paths), so receipts are comparable across
  machines and re-runs.
- `omissions` records only optional layers, in the deterministic omission
  order; mandatory layers cannot appear there (their absence is a refused
  receipt with a typed mandatory-layer violation).
- `externalReferences` is the audit trail of the
  content-addressed-reference and forbidden-duplication classes: what
  traveled by reference instead of being recopied.
- Receipts are append-only evidence. No production code may select "the
  latest receipt" to derive current counters (§3.3).

## 8. Crash windows (exact)

| Window | State at crash | Law |
|---|---|---|
| Before admission commits | nothing persisted | re-run `admitProviderRequest` from scratch; no send existed |
| After admission commit, before send | admitted receipt + `obligation:providerSend` exist, no `ProviderSendOutcome` | redrive the **same** obligation and **same** request ordinal — `cognition.sendProviderRequest` crash-redrive law (FWD:F058). Admission is NOT re-run: no new receipt, no new ordinal, no double cumulative charge. |
| After a non-idempotent external send, outcome unknown | send happened; outcome evidence lost | typed uncertainty: `TypedWait:effect-uncertainty`; **operator disposition command** decides (D12: receipted disposition; never an automatic duplicate send, never a blind rollback). Probe automation may only be added later as a frozen extension. |
| After idempotent send / recorded outcome | `ProviderSendOutcome` exists | continue normally (`activityAttempt.recordOutcome`) |

Hook-originated provider calls are forbidden unless they use the same
transport and admission command (a hook can never carry a private send
path around the linearization point).

## 9. Pre-send transport requirement (EK-12 enforcement)

The admission linearization point is only real if the transport exposes
**every final request** — including mid-loop requests that follow tool
results — to the accountant **before** serialization/network send.

- EK-12 refuses qualification when only initial stdin or postflight token
  events are observable; the preflight must prove an oversized hook
  context and an oversized tool result are refused by their exact next
  pre-send receipt **without reaching the network**.
- **Current shim insufficiency (documented blocker):** the production path
  spawns workers through `tools/agent-proxy/claude-shim.mjs`
  (`opencode run`, stream-json translated). Mid-loop requests (tool-result
  continuations, retained-context re-sends) are assembled **inside the
  opaque CLI loop**; the shim sees only the initial stdin payload and
  postflight events. Therefore the current transport cannot host the §3.3
  boundary for anything but the first request. Per the plan: an opaque CLI
  loop that cannot expose every final request and receipt is nonconforming
  and cannot pass EK-12; WP-18 must supply an instrumented OpenCode
  transport (or fail closed against a pinned OpenCode interface), and
  postflight event usage cannot substitute for pre-send admission.
- This spec does not implement the transport; it pins the contract the
  transport must satisfy (admission at the exact pre-send boundary; the
  EK-12 preflight probes above are the acceptance test).

## 10. Law index (plan bullet → section)

| Plan law (envelope section) | Frozen here |
|---|---|
| ActivityAttempt sole mutable owner; CAS-fenced counters; receipts not authority | §3.3, §4, §7 |
| admitProviderRequest atomic validate/advance/append/create; refusal consumes nothing | §4 |
| no latest-receipt/sum authority | §3.3, §7 |
| one cumulative accountant before every request; per-request + session budgets | §3.1–3.2 |
| receipt contains counter/version, digests, counts, ordinal, omissions, external refs | §7 |
| large products/histories as content-addressed refs, bounded summaries, chunked reads | classification CS-11..CS-13, CS-16 |
| mandatory layers never silently truncated; deterministic omission order | §4 step 3, §7 |
| static over-budget fails installation; dynamic overflow typed pre-spawn, no retry charge, no identical reissue | §5.1, §5.3 |
| positive finite limits; zero/missing/unsupported fail closed | schema `PositiveFiniteInteger`, §3.2 |
| limit table read-only, exact-key, no route selection | §3.2, schema `$defs/ProviderModelLimitTable` |
| provider usage postflight only | §3.3, §6.5 |
| linearization immediately before final serialization/send | §3.3, §9 |
| opaque CLI loop nonconforming; WP-18 instrumented transport; EK-12 | §9 |
| hook-originated provider calls forbidden without same transport+admission | §8 |
| receipt `admitted|refused` never `sent`; crash before send redrives same obligation+ordinal; post-send uncertainty typed | §7, §8 |
| transport enforces maxOutputTokens <= reservedOutputTokens | §3.3 |
