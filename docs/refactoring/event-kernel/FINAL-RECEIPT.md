# Event-Projected Kernel Greenfield Refactoring — FINAL RECEIPT

Executor: integration coordinator (autonomous, operator standing directive).
Plan: docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md — all
phases EK-0…EK-13 complete. This receipt is the EK-13 closure artifact.

## Identities (non-self-referential by construction)

- **qualificationSourceSha:** `00261a0d7e99dc4070f5abb10b1bff79b9918bc7` —
  the immutable source whose executable tree, build and product runs are
  qualified. Bound by kit `123504a46b312b467cf39ea9df4e562099653ebc8a7e83e47ba4b35d0c208b28`.
- **closureSha:** the commit containing this receipt (docs-only; recorded
  externally). Its executable tree is byte-identical to
  qualificationSourceSha: every commit after `00261a0d` touches only
  `docs/**` (qualification records, tracker, census, ADRs, this receipt).
  This receipt does not embed its own commit hash.

## Predecessor

- CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN complete; completion receipt
  `docs/factory-run/qualification-adr096/COMPLETION-RECEIPT.md` (closing SHA
  `bacf4f82`); ADR-053 CLOSED; residuals transferred to this plan by its
  transfer rule (6 structural Development tokens, 2 Delivery, 10
  documentation families, 9 low authority seams, CC-41/42 refusals, CC-U2,
  EK-12 pre-send blocker — all consumed or resolved below).

## EK-1 admission identity

- Original EK admission receipt: `docs/refactoring/event-kernel/EK-ADMISSION-RECEIPT.json`,
  digest `7635a4bdc0f9ee5a…` (preserved verbatim; recorded in the kit).
- EK-1 source SHA: `21ba0816` (census base).
- admissionContractDigest at EK-1: `d1d6f85763eb613d…`.
- Final recomputed ACD at qualificationSourceSha (validator formula):
  `d1f9272c330f28c6…` — matches the immutable kit exactly. The delta is the
  frozen EK-8 amendments (spec digests re-frozen with re-validation); the
  original receipt digest above is preserved unchanged.
- Three frozen specification digests: complexity budget `f9da8b1a434ec44f…`,
  canonical role contract schema + prompt budget profile — pinned in the kit
  (`4c8a0abab026a819…` role-contract manifest; `5648ae361d8cd78e…`
  PromptBudgetProfile; token counter `53c1b9cddbf6bc6a…`).

## Qualification build identity (kit 123504a4…)

| Item | Digest / value |
|---|---|
| source HEAD | `00261a0d` |
| dist tree | `32edf199c794f929…` (390 files) |
| schema fingerprint | `c53efa8f284c616d…` |
| transition universe | `92751dedf814dc89…` (53 commands / 49 obligations / 5 waits / 28 proofs / 67 evidence kinds; 32 reconciliation entries, 0 silently accepted) |
| actor version | `0563af342f32228b…` |
| seed | 20260826 |
| ACD (final) | `b4ffd16479cfd46f…` (kit formula) / `d1f9272c…` (validator formula) |

## Qualification tables (all on kit 123504a4 @ 00261a0d)

**EK-11 Development reliability — 10/10 GREEN, identical normalized traces**
(`series/dev-20260826164500.json`; evidence manifest `23ae0004…`).

**EK-11 scripted corpus — 20/20 GREEN, actual product outputs** (P01–P20;
build/test/browser-or-API-or-CLI smoke/local package receipts;
`series/projects-20260826164530.json`; manifest `2575c2e7…`).

**EK-11 concurrency — GREEN** (Proof A four-way isolation 20/20; Proof B
diamond-at-cap-2 7/7, deterministic barrier, peak==2 by world state;
`series/concurrency-20260826164626.json`; manifest `4d1820fe…`).

**EK-12 real OpenCode full conveyor — R1/R2/R3 consecutive GREEN, 37/37
checks each** (81/65/136 min; fresh DB+repo per run; complete
idea→Discovery→Formalization→Development→Delivery path; per-request
pre-send PromptAssemblyReceipt completeness; independent product
verification; `series/real-20260826094711.json`, allGreen; 142 evidence
files; manifest `3b965061…`). Superseded bring-up iterations preserved as
honest history (36 evidence roots; findings fixed and pinned:
NODE_UNDECLARED regression; concurrency diamond rung; model-answers-not-serves).

## Clean-checkout blocking commands (qualificationSourceSha, fresh worktree)

- `npm run build` — clean.
- Acceptance matrix: workflow-kernel **737/737**; project-corpus 33/33;
  architecture 67/67; kept-tooling 27/27; ek-manifest-guard 7/7;
  ek-admission 1/1; ek-removal-guard 10/10; ek-evidence-kit 3/3;
  cc-proof-registry 26/26; matrix-coverage 19/19.
- `npm test` (full matrix, sequential): **836 pass / 1 fail / 0 skip** — the
  single failure is the claude-shim provider-retry T3 under full-matrix load
  (30s timeout exceeded at 34.5s); isolated rerun **52/52** and the
  architecture group rerun **67/67** green. Recorded as load-flakiness with
  the isolated greens, not silently dropped.
- `node tools/ek-legacy-zero.mjs --strict` — **ALL FIVE LAWS GREEN** (empty
  allowlist: L1 0, L2 0, L3 0, L4 0, L5 0).
- `npm run validate:ek-admission-specs` — ALL GREEN.
- `npm run test:workflow-complexity` — **COMPLEXITY_CHECK_GREEN**, 16/16
  binding dimensions, zero waivers.
- Authority census re-run: builder **0 unclassified**, validator **0
  violations** — the post-cutover kernel classified (every table one
  sole-writer repository; extended census committed in docs).
- Transition-universe reconciliation: VALID (see digests above).
- Kanban rebuild from zero: proven by the projection mutation battery
  (delete-all-rows / forged-rows / stopped-projector-rebuild → identical
  normalized trace + byte-identical board), hosted in workflow-kernel.
- Mutation & fault-schedule results: harness 6/6 registered mutations killed
  (4 baseline suites green); WP-13B crash matrix 16 fault points × restart →
  identical normalized worlds; corpus RED/GREEN families green.

## ADR registry closure (this commit)

- **ADR-097** (event-projected workflow kernel): registry closureState
  `planned` → `implemented` — the kernel is the ONE production runtime
  (EK-8 cutover complete, legacy-zero 5/5, Kanban a disposable projection)
  and is qualified end-to-end (scripted + real series above).
- **ADR-098** (freeze successor contracts in EK-1): all nine closure
  checkboxes marked `[x]` with evidence pointers (admission receipt digests;
  validator mutation kills; complexity second-path kills; one role digest
  across launch paths; prompt-budget coverage; real-lane pre-send receipts;
  EK-8 zero debt; this receipt's recorded vectors/digests; the
  qualificationSourceSha/closureSha separation proven by this receipt).
  Registry closureState `planned` → `implemented`.

## Complexity, roles and prompt accounting (final, no waiver)

- Complexity vector: 16 binding dimensions GREEN (conjunctive envelope);
  zero temporary legacy/replacement debt (legacy-zero L-laws all 0);
  `workshops.nameBranchLiterals = 0`.
- Exactly ONE role-binding compilation path (WP-17 compiler/resolver; zero
  fallback resolvers) and ONE cumulative context accountant (WP-18 envelope;
  admission at the exact pre-send boundary; RUNNING_COUNTER_IDENTITY pinned
  in the production composition).
- Role-contract manifest digest `4c8a0abab026a819…`; PromptBudgetProfile
  digest `5648ae361d8cd78e…`; token counter `53c1b9cddbf6bc6a…`; the real
  lane's per-run receipt-completeness is recorded per EK-12 series (37/37
  checks include the receipt law).

## Known residuals (exact)

1. **Drain-oracle kernel finding** (WP-13D finding 3): after full settlement
   the obligation frontier keeps structural lane rows
   (`materializeWorkplace.production-cell`, `runGate.*`, `runEffects`,
   `advanceProcessFlow*`); a drain-closed invariant is therefore undeclared.
   Deferred WITH justification (frontier API design decision), recorded in
   the EXECUTION-TRACKER findings ledger; it does not touch any
   architecture law, deletion, schema policy or qualifying run.
2. Elite-2 operator console (the saga4-side human-gate UI) retired with the
   old runtime at EK-8; its LAW (typed wait + operator disposition) is the
   native kernel semantics (D5/D12) exercised in qualification (p16/p17,
   delivery pause, R-series). The Elite-2 production proof is evidence-kit
   corpus entry 3.
3. The claude-shim T3 load-flakiness (documented above; isolated green).

No residual in an architecture law, legacy deletion, schema policy or
qualifying run remains open.

---

## SUPERSEDING CLOSURE (2026-08-27, audit round 3 repair cycle)

The first closure (commit containing this receipt's original text) was
REJECTED by external audit round 3 (nine findings). This SUPERSEDING closure
records the repaired cycle:

- **qualificationSourceSha:** `7bc0e67b` (kit `a39e8c9c3b744d9b3e806520b4846f63f0d685deff5f7d40200a2b4cc28ae297`):
  includes the audit repairs — zero quarantine (the last entry removed WITH
  its file; G1a/G3 inverted to the zero-quarantine law; manifest row updated),
  the shim T3 load-safe budget, the census classification of the post-cutover
  kernel (0 unclassified / 0 violations), and the saga4 reconciliation MERGE
  (origin/saga4 brought in by a true merge, supersession documented — never
  a reset).
- **admissionContractDigest:** ONE formula — the validator self-hashes via
  fileURLToPath; validator == kit == `8665ed0fc3233edb4da6237d3befdb146f1058fec9e5276b1fffe44e8a5b181b`
  (the historical d1d6f857/d1f9272c/b4ffd164 divergence was the Windows
  URL-pathname mangling; fixed at the source).
- **EK-11 re-qualification on kit a39e8c9c:** Development 10/10 identical
  traces (`dev-20260826185605`); corpus 20/20 (`projects-20260826185618`);
  concurrency GREEN 20/20 + 7/7 (`concurrency-20260826185705`).
- **EK-12 re-qualification on kit a39e8c9c:** R1/R2/R3 consecutive GREEN,
  37/37 checks each — 24 real provider requests per run (route zai/glm-4.7
  via the opencode shim; pre-send receipt completeness 100%). Series record
  `real-20260826185718` (allGreen), 137 evidence files, manifest `4ef474d4…`.
  In-series incidents, honestly recorded: one 2h17m stalled provider call
  killed by the coordinator and recovered by the kernel's crash-window
  redrive (R2 development, still GREEN 2/2); the driver's authored-copy cwd
  quirk (products swept to qualification/stray-products-r1).
- **Full npm test at the final SHA:** 932 pass / 0 fail / 0 skip (`npmtest-final4`);
  the two intermediate red runs are documented (mid-run .desk sweep by the
  coordinator; the stale manifest row fixed in this closure).
- **The complete matrix list (11 groups):** workflow-kernel 737, project-corpus
  33, architecture 67, kept-tooling 27, ek-manifest-guard 7, ek-admission 1,
  ek-removal-guard 10, ek-mutation-coverage 2, ek-evidence-kit 3,
  cc-proof-registry 26, matrix-coverage 19.
- **closureSha:** the commit containing this superseding section; the diff
  from 7bc0e67b to it is docs-only (84 files, all under docs/) — the
  executable tree is byte-identical to qualificationSourceSha.
---

## POST-CLOSURE QUALIFICATION ADDENDUM (2026-08-27, operator correction cycle)

The operator correction (2026-08-27): three post-closure commits (the
GLM-5.3-flash default route + rate limit 6 b218f42b, the single-run engine
verify 07b9b1f2, the front clones 5c158608, plus the manifest
classification fix 97090928) had NOT passed full re-qualification when
FRF-WP01 briefly built on them. Corrected path: OFFICIAL FULL QUALIFICATION
of the advanced line, then saga4 advances, then FRF re-baselines.

- qualificationSourceSha: 97090928 (kit f86dc68d2e03d2d224f98a6ad7041bd90e774dc97e83d4fb0ff9ed353749b6e4; route zai/glm-5.3-flash, ACD 8665ed0f)
- EK-11 on kit f86dc68d: Development 10/10 identical traces; corpus 20/20; concurrency GREEN (20/20 + 7/7).
- EK-12 on kit f86dc68d, REAL series on glm-5.3-flash: R1/R2/R3 consecutive GREEN, 37/37 checks each, 24 real provider requests per run (148/88/87 min; the flash route materially faster than the qualified glm-4.7 series 130/268/135). Series record real-20260827073118 (allGreen), 137 evidence files, manifest d7fb9620.
- FRF-WP01 research captured at 5c158608 is stamped RESEARCH-ONLY with a BASE CAVEAT; the FRF baseline of record is re-taken from the advanced saga4.
- saga4 advances to the commit carrying this addendum (docs-only diff 97090928 to addendum, the same closure-allowlist class as v2).

## POST-CLOSURE CORRECTION (2026-08-28): the addendum's flash route claim is FALSE

The POST-CLOSURE QUALIFICATION ADDENDUM above records the EK-12 series on
kit f86dc68d as "REAL series on glm-5.3-flash". That claim is falsified by
the executor-side oracle (opencode session DB): every one of the 275
sessions ever served through the agent-proxy shim before 2026-08-27T21:05Z
ran `glm-4.7` — glm-5.3-flash never executed once. The shim's MODEL_MAP
lacked a glm-5.3-flash entry and silently degraded the kernel's explicit
pin to the glm-4.7 default; kernel receipts recorded the PIN, not the
served model.

Reading of the addendum, corrected:

- The kit f86dc68d series honestly qualified the zai/glm-4.7 route
  (37/37 × 3, all checks and evidence valid AS a glm-4.7 qualification).
- Its "glm-5.3-flash" attribution — including the 148/88/87 min
  flash-vs-4.7 speed comparison — is void.
- The first genuine glm-5.3-flash real series is the FRF WP12 series
  (kit e7338b29, 2026-08-27/28): all 104 executor sessions flash-verified.
  See docs/refactoring/formalization-frf/FORMALIZATION-SCENARIO-FIRST-FINAL-RECEIPT.md §3–4.

Root-cause fix: commit a53c2524 (map entry + unmapped-model fail-closed
exit 86). Standing rule: the serving model is proven by the executor-side
session DB, never by kernel receipts alone.
