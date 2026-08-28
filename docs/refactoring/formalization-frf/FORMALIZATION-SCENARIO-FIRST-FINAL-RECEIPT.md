# FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN — FINAL RECEIPT

**VERDICT: COMPLETE.** All twelve work packages (FRF-WP01..WP12) closed;
the scenario-first Formalization flow is the sole production path; the
final qualification passed on an immutable kit with three real-agent
projects on the REAL glm-5.3-flash route (executor-side proven).

Receipt date: 2026-08-28. Qualified by the integration coordinator under
the operator's standing autonomy directives (2026-08-25 autonomy
override; 2026-08-28 three-parallel-copies directive).

## 1. Qualification identity

| Field | Value |
|---|---|
| Qualification kit | `e7338b29e8163ed53c16911c3293858001d0b9e5f19ace357097d58b8dbb2933` |
| Qualified HEAD | `6f2255dd9eecb471a372276d12ea11e6f7c1d1f2` |
| package.json / lock digests | `551eb024…` / `5c9376af…` |
| dist tree | 509 files, hash `48710cf7c189b7c4c263f6dead455400fbf104bbe08a0391576fe4294b8dc3a7` |
| Kernel schema fingerprint | `c53efa8f284c616da61890a9c1ae275a1badee91c3d789ba744b610a1bd820c4` |
| Universe digest | `92751dedf814dc89133df6f5ff4e53a505649f0ab0e40962874007570c77c80f` |
| Admission contract digest | `8665ed0fc3233edb4da6237d3befdb146f1058fec9e5276b1fffe44e8a5b181b` (ONE formula: validator == kit, unchanged since the EK closure fix) |
| Seed | 20260826 |
| Frozen / sealed | 2026-08-27T21:03:43Z / (per series-result below) |
| Kit verified | `KIT VERIFIED … every digest matches the live tree` (pre-series) |

Lineage from the EK closure (be0d5948) through FRF: WP01 baseline
re-captured programmatically after the r5 provenance correction → WP02
graphs → WP03 contracts canonical in src → WP04–08 six cells → WP09
Development handoff (UC-FOREIGN killed at the consumer) → WP10 corpus →
**WP11 the cutover** (merge d76f88b4 + tracker 6193013a: old flow deleted,
86 files / −391,273 lines; matrix 13 groups) → **WP12 this receipt**.

## 2. Scripted qualification (kit e7338b29, on the qualified HEAD)

Full log `D:/Development/frf-wp12-scripted4.log` (2026-08-27T21:03Z):

- `npm test` — acceptance matrix **1289 pass / 0 fail**, 13 groups
  (incl. frf-corpus 30/30, frf-removal-guard, ek-manifest-guard,
  matrix-coverage). MATRIX_EXIT=0.
- `qualify:development` — 10/10 runs GREEN, normalized traces IDENTICAL
  (`da16236f3704` across 10 runs). DEV_EXIT=0.
- `qualify:projects:scripted --all` — P01..P20 all GREEN (checks 9–17
  each). SCRIPTED_EXIT=0.
- `qualify:concurrency` — concurrency proofs GREEN. CONC_EXIT=0.

Graph reconciliation, legacy-zero (--strict), test-hosting, mutation and
removal guards are standing matrix groups and ran green in the same
pass on this SHA.

## 3. Real qualification (three real-agent projects)

**Operator-approved deviation (2026-08-28 directive):** the plan's
"three consecutive" series ran as **three parallel factory copies**
(R1/R2/R3 simultaneously, each on its own fresh kernel DBs, its own
product repository and its own evidence root, send-rate cap 3 per copy
via `SAGA_OPENCODE_MAX_CONCURRENT_SENDS=3`). Each run is internally
sequential (discovery → formalization → development → delivery); the
copies share nothing but the provider quota. The rate cap itself is a
qualification-line commit (6f2255dd) — see §4 incident III.

| Run | Product | Verdict | Checks | Real provider requests | Evidence root | Sealed (UTC) |
|---|---|---|---|---|---|---|
| R1 | served Node API + browser frontend (`repo:simple-server`) | **GREEN** | 37/37 | 24/24 (2+18+2+2) | `real-20260827210853` | 2026-08-28T04:13Z |
| R2 | CLI reusable validation library (`qual:lib-validate`) | **GREEN** | 37/37 | 24/24 (2+18+2+2) | `real-20260827210905` | 2026-08-28T03:14Z |
| R3 | full-stack CRUD with persistence + browser smoke (`qual:served-crud`) | **GREEN** | 37/37 | 24/24 (2+18+2+2) | `real-20260827210914` | 2026-08-28T03:05Z |

Series logs: `D:/Development/frf-wp12-real4-R{1,2,3}.log`. Every
formalization phase ran the **eighteen requests through the six FRF
cells** (product-intent → use-cases → system-requirements → acceptance
→ what-freeze → srs-realization) — the cutover semantics in production.

**Executor-side model proof.** Kernel receipts record the pin, not the
served model (lesson of incident II). The independent oracle is the
opencode session DB: **all 104 sessions created during the series are
`glm-5.3-flash`** (0 substitutions; `opencode.db` `session.model`,
window 2026-08-27T21:05Z→seal). This is the FIRST real series in the
repo's history actually served on glm-5.3-flash.

## 4. Incidents of the qualification day (recorded, fixed, re-qualified)

**I. Hidden refusal verdict (kit 16a849a1).** One matrix failure
(material-chain ADR-053) showed a bare array diff: a load-dependent
product-verification refusal made the kernel fail-closed (settle
refused → final acceptance lawfully absent) — correct kernel behavior;
the DEFECT was observability: the test discarded `run.blockedAt` and
the refusal verdict. Fix `0586db6e`: the test asserts its happy-path
precondition with the full refused verdict in the message; the
acceptance `startServer` port probe hardened (single buffered stdout
scan — a per-chunk regex could parse a truncated port number — plus
typed spawn/exit diagnostics, no orphan once-listeners).

**II. EXECUTOR-MODEL MISMATCH (kits 16a849a1 / 2151fc69).** The kernel
pinned glm-5.3-flash in every receipt while the shim's MODEL_MAP lacked
that id and silently degraded the pin to the glm-4.7 default (stderr
note swallowed by the channel). ALL prior "flash" series — including
the EK post-closure addendum claim — actually ran glm-4.7 (275/275
sessions in the opencode DB). The first WP12 real series was killed as
mislabeled evidence. Fix `a53c2524`: map entry added; an explicit
UNMAPPED model now REFUSES (exit 86) — a pin is a pin at the executor
boundary too. The EK FINAL-RECEIPT addendum carries a correction note
(this commit). Lesson institutionalized: the serving model is proven by
the executor-side session DB, never by kernel receipts alone.

**III. UNWIRED RATE LIMIT (`6f2255dd`).** While wiring the operator's
three-copies directive: `composeProduction` never passed
`maxConcurrentSends` — the documented "limit 6" existed as a channel
capability that production wiring did not use; production sends were
unlimited. Fix: `SAGA_OPENCODE_MAX_CONCURRENT_SENDS` per copy, default
3, invalid/unset never unlimited.

Each incident: series stopped → fix committed → NEW immutable kit →
full scripted re-run → real re-launch. No red was ever waved through.

## 5. Exit criteria (plan §FRF-WP12)

- [x] Three real-agent projects pass on one immutable build
      (parallel-copies deviation operator-approved 2026-08-28, §3).
- [x] Reconciliation / legacy-zero / hosting / mutation / guards green
      on the qualified SHA (standing matrix groups, §2).
- [x] Receipt records SHAs, digests, commands, counts, results,
      residuals (this document).
- [x] Closure diff is docs-only (this receipt + tracker + EK correction;
      executable tree byte-identical to kit e7338b29).
- [x] `saga4` fast-forwards to the closure SHA; worktree clean.

## 6. Residuals (truthful)

1. **WP03 digest hardening** (carried from WP10): the contract digest
   is member-set-insensitive — a single-row member substitution inside
   an authority can pass an unchanged digest. Blocking-harness coverage
   compensates; the hardened digest formula is future work.
2. **`REAL_ROUTE_PIN` stale label** in `tools/qualify/real-series.mjs`
   (glm-4.7, EK-12 era): prewire metadata only — the engine follows the
   production pin and the receipts + session oracle carry the truth
   (§3). Post-closure cleanup candidate; touching it now would void
   this kit.
3. **Phase-duration accounting** in the real-series driver sums
   author+reviewer legs; treat reported phase ms as leg-sums, wall
   clock as seal−frozen.
4. **node_modules junction note**: clean-worktree environments need the
   junction recipe (memory: saga-mcp repo topology).
5. Elite5 (operator directive) launches on this closure line with the
   honesty-canary product brief (operator 2026-08-27/28 discussions;
   final product choice rests with the operator).
