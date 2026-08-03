# Wave Log — Process Modules Refactoring History

This file is the consolidated home for the **history** of refactoring waves
that touched `src/process-modules/application/`. It exists so that the
chronicle of "Wave X did Y" is preserved without polluting the source files,
which every reader (human or agent) pays for on every read.

The source files now keep only behavioral documentation — comments that help
understand the CURRENT code. Anything that narrates WHEN something changed,
cites a wave number, commit hash, or a spec section the reader does not have,
lives here instead.

This document is **historical**, not normative. It describes how the current
state came to be; the source code is the source of truth for current behavior.

## Timeline (condensed)

### Wave 1 — pure SPI layer
Introduced the driver-neutral SPI types under `domain/spi/`:
`ExecutionContextEnvelope`, `ModuleCompletion`, `NodeProductionEnvelope`,
`ProductRef`, `DriverNeutralExecutionReceipt`. Pure data types (interfaces),
no runtime edge. These are the forward shapes the later waves migrate toward.

### Wave 3 (W3-A1 … W3-A7) — driver-neutral envelope path
The big one. Added an OPTIONAL v2 driver-neutral envelope path alongside the
legacy `restoreFrame()` + magic-bindings path in `generic-flow-executor.ts`.

Key W3-A sub-steps referenced by the old source comments:
- **W3-A1** (spec §3/§4): the v2 envelope path wiring on
  `GenericFlowExecutorOptions.v2`. Activates only when v2 wiring is supplied
  AND the NodeRun repo exposes the v2 methods (`startV2` / `completeV2` /
  `readByExactCursor`). ADDITIVE — legacy runs execute the byte-identical
  `restoreFrame()` + magic-bindings path. Characterization tests proved no
  regression (the old plan's §16.9 dual-write guarantee).
- **W3-A3**: surface `installationId` / `packageDigest` on ProcessRunRecord.
  Until it landed, callers passed `null` and the assembler emitted the
  `'legacy:unpinned'` sentinel.
- **W3-A4**: `persistence/process-product-repository-v2.ts` — the exact-by-
  `(schemaId, ref, digest)` ProductRef port (spec §7). Replaced
  `listArtifactsForNodeInEpic` (the §9.11 "latest in run" imprecision).
- **W3-A5**: `execution-context-assembler.ts::assembleExecutionContext` —
  the immutable, no-fallback envelope assembler. Throws
  `UPSTREAM_PRODUCT_NOT_FOUND` on a missing declared predecessor; there is
  NO epic-scope / latest-in-run fallback (spec §9.11).
- **W3-A6**: the v2 NodeRun contract — `inputEnvelopeHash` / production
  envelope / transition cursor columns, dual-written by `startV2`/`completeV2`.
- **W3-A7**: the ContractBoundaryDecoder (shipped later; Wave 5 wired it in).

The v2 path also persisted the explicit `ModuleCompletion` column on NodeRun
so crash-resume could rebuild `NodeExecutionResult.completion` and settlement
could read the explicit certificate ref instead of falling back to magic
bindings.

### FU-A Wave 3 — crash-resume completion restore
Prefer the v2-shaped read (`readLastCompletedV2`) when the v2 channel is
active so the persisted `completion` column is visible to `restoreNodeResult`.
Without it, crash-resume after a terminal node would lose the certificate and
silently fall back to magic bindings. The §0.6.12 contract: a crash AFTER a
terminal node wrote its completion MUST be resumable with the completion intact.

### Wave 4 — settlement kernels emit explicit completion
The four module settlement kernels were migrated to emit
`completion: ModuleCompletion` in their `KernelHandlerResult`, rather than
encoding the certificate envelope into opaque `production.bindings`.

### Wave 4.5 — "Uncle Bob bridge": executor-side completion tracking
Side-channel for the LAST non-terminal `ModuleCompletion` seen across the
node chain. The terminal node (`complete-<code>`) is served by the
runtime-owned `process-outcome-emitter`, which does NOT emit a completion
(it is generic — forwards upstream bindings, not the typed completion
envelope). Without this bridge, `terminal.result.completion` was undefined,
the explicit certificate ref branch at `execute()` did not engage, and the
certificate resolved via magic bindings — which made Wave 5 (magic-bindings
deletion) unsafe.

The fix: track the LAST non-terminal completion as a side-channel (NOT
through `chainInput` — completion is a settlement-time concern, not a
data-chain value) and merge it onto `terminal.result.completion` when the
terminal emitter produced none. This was the linchpin Wave 5 needed.

`restoreLastNonTerminalCompletion` converges crash-resume and fresh runs on
the same `terminal.result.completion`.

### Wave 5 — magic-bindings deletion
Deleted the legacy magic-bindings fallback branch. After Wave 4 + Wave 4.5,
`completion` is the SOLE certificate channel — a terminal run without one is
a hard error (`SETTLEMENT_COMPLETION_MISSING`), not silent degradation.

### WAVE 6 (fourth audit, 2026-08-02) — restoreFrame retirement
The audit demanded: "Define a retention policy for legacy NodeRun rows,
perform migration or an explicit compatibility adapter at the boundary, then
remove restoreFrame + magic bindings from generic-flow-executor. Add
restoreFrame to a forbidden fallback ratchet."

Outcome:
- **Retention policy**: legacy NodeRun rows (written by the pre-Wave-3
  `nodeRunRepo.start`/`complete` path, or by the v2 path's dual-write of the
  legacy columns) carry the data the executor needs to reconstruct a
  NodeExecutionFrame: `outputRef`/`outputSchema`/`outputHash`/`outputBindings`
  → production, `executionReceipt` → receipt. These columns are RETAINED
  (dual-written by the v2 path) precisely so the boundary adapter can read
  them.
- **Boundary adapter**: `assembleFrameFromDurableNodeRuns` reads durable
  NodeRun rows DIRECTLY into a `NodeExecutionFrame` — the same shape
  `restoreFrame` produced — without the legacy mutable-bag reconstruction.
  It is the LIVE data source for every node executor's `ctx.frame`, AND for
  `declareUpstreamRefs` (v2 ProductRef derivation), AND for `mergeLegacyFrame`.
- `restoreFrame` was FULLY REMOVED: `walk()` calls the adapter by name, and
  `restoreFrame` is now in the forbidden-fallback gate
  (`no-execution-scoped-lookup.test.mjs`).

### Wave 8 — production-v2 blockers + mandatory completion
Resolved 8 production-v2 blockers. Notable for this module:

- **Wave 8 BLOCKER 1**: removed the former `runHasV2Marker` helper. It had
  gated v2 activation on a pre-existing v2-marker NodeRun row, which created
  a chicken-and-egg: a fresh run had no such row, so the first node used the
  legacy `start` path and the marker was never written — production never
  entered the v2 path. v2 now activates UNCONDITIONALLY when wiring is
  present. The marker columns (`inputEnvelopeHash` / `productionEnvelope`)
  are still WRITTEN by `startV2`/`completeV2` and still READ by the resume
  path; they just no longer gate activation.
- **Wave 8 HIGH 3** (mandatory completion): the certificate resolution is a
  SINGLE path AND a terminal run MUST produce an explicit `ModuleCompletion`.
  A terminal node that reaches settlement WITHOUT a completion is a CONTRACT
  VIOLATION — the kernel forgot to emit completion (a bug), or the
  failure-path swallowed a certificate-issuance error (HIGH 3 also removed
  those swallows). The executor MUST NOT silently degrade to
  `certificate = null`: that is silent data loss. Throw loudly. (A terminal
  completion WITHOUT `certificateRef` is still valid — non-certified
  outcome.)
- **Wave 8 HIGH 4**: `assertExplicitModuleCompletion` validates the
  completion envelope — terminal flag must be true at settlement, and when
  `certificateRef` is present its shape must be a valid content-addressed
  `ProductRef` (schemaId/ref/digest all non-empty strings).

### Wave 8.5 — mandatory terminal completion + integrity digest
The last 2 audit points. Finalized mandatory terminal completion and added
the integrity digest.

## Where each piece of removed history now lives

For traceability, the major comment blocks that were removed from the source
files and condensed into the timeline above:

- `generic-flow-executor.ts` — "W3-A1 (spec §3/§4)" import-block banner;
  the `v2` option's "byte-identical to the pre-Wave-3 executor ...
  characterization tests prove no regression (plan §16.9)" paragraph; the
  "WAVE 5 CUTOVER + WAVE 8 HIGH 3" settlement comment; the "WAVE 8 HIGH 3
  (mandatory completion)" block; the "W3-A1 + Wave 8 BLOCKER 1: chicken-and-
  egg" block; the "WAVE 6 (fourth audit 2026-08-02) — restoreFrame fully
  retired" block; the "Wave 4.5 bridge" paragraphs; the "FU-A Wave 3"
  resume-read comment; the "FU-A Wave 3: persist the explicit
  ModuleCompletion" completeV2 comment; the "W3-A1 (spec §3/§4): dual-write"
  comment; the "WAVE 6 AUDIT" multi-paragraph banner above
  `assembleFrameFromDurableNodeRuns`; the "W3-A1 v2 path helpers" banner;
  the "Wave 8 BLOCKER 1: former runHasV2Marker removed" NOTE; the
  "W3-A1 + WAVE 8 HIGH 4" `assertExplicitModuleCompletion` banner; the
  "WAVE 8 HIGH 4" inline assertions.
- `node-executor.ts` — the "Wave 3 (W3-A1)" SPI-type import comment; the
  "W3-A1 — v2 driver-neutral executor SPI (spec §3)" banner; the
  "W3-A1 (spec §3)" optional-envelope field comments; the "W3-A1 (spec §3/§4)"
  completion field comment.
- `execution-context-assembler.ts` — the "W3-A5" header block; the "WAVE 6
  STATUS" block; the "ISOLATION NOTE — W3-A4 port" block; the "W3-A4 port
  shape" banner; the various "W3-A3" / "Wave 5 migrates" / "plan §X"
  references throughout the pin-resolver and option comments.
