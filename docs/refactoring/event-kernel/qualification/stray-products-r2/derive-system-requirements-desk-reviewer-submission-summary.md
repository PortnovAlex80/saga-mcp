# derive-system-requirements desk (reviewer) — r2 review record

Round: stray-products-r2 · reviewed candidate of record: SR-Derive-System-Requirements-001
(`sha256:86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df`, submission FS-Derive-System-Requirements-001 `sha256:05e713efdd1847bf18fc21ed335a981db1963020417e0a2078eef62fe2e824aa`,
trace `sha256:fd0b0b1f7470cd7825a0c83082b96b503ef3dabdcf70a92369050418a8706e26`) · verdict: **repair**

## What was independently verified (nothing trusted by declaration)

- **80 recomputations** (`derive-system-requirements-desk-reviewer-verify.mjs`), rule
  `sha256(canonicalJson)` per `src/workflow-kernel/domain/digest.ts`:
  **77 pass / 3 fail**. Full evidence:
  `derive-system-requirements-desk-reviewer-verification.json` (VV-Derive-System-Requirements-001,
  `sha256:d81d23475ca309756165e65a109b7df94786636cfe794661ce7eea5b1f1a4f5b`).
- The candidate is **content-integrity-clean at the digest layer**: the author trio
  self-addresses recompute; all **4 requirement seals** recompute and the bundle is
  **SEALED by the real kernel WP03 validator** (`validateRequirementsBundle`, seal
  `sha256:60083eb4…`) against the universe derived by the **real** `deriveAcceptedUniverse`.
- Both upstream folds **re-derive independently** through the real validators + real cell
  folds (prd `a30229a7…`, uc `184981e5…`) — the pins are byte-exact to the material they bind.
- Trace graph: 13/13 relationships resolve; requirement/PRD-member/terminal/constraint
  coverage blocks equal the edge sets; 0 edges touch the carried unknown.
- The real cell gate re-runs to **accepted** and the negative probes confirm it refuses
  (foreign lineage → upstream-repair, stale pin → repair, scope violation → terminal-reject).
- All **8 reviewer-envelope content addresses** travel inside the artifact and match exactly.

## Workspace-law adjudication

The reviewer frame projects **"1 accepted upstream revision"** (`sha256:65fe9a225a4425880513ae5321cce4d9b75c44e88fb3054f5e7f997b6956ee66`).
Verdict: **UNRESOLVABLE — author 0 upheld at the desk layer.** 213 workspace files scanned:
zero raw-byte, zero canonical-JSON, zero `.content` hits (the single textual mention is the
verification evidence itself). This is the desk's **first** reviewer stage — no prior reviewer
verdict exists and the final gate never ran, so no accepted revision of
derive-system-requirements can exist. Stale shell metadata (same family as `745cadc1…`),
recorded for the shell owner.

## Why repair (not accepted, not upstream-repair)

The kernel cannot see acceptance status: the WP03 validators and cell folds consume whatever
set they are handed. Whether that set is **accepted** material is desk-review authority —
and it fails:

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | **Fabricated upstream acceptance status.** `materialAuthority` asserts "the accepted define-product-intent bundle and the accepted model-use-cases scenario bundle"; `revisionPinsMatchAcceptedRevisions=true`; evidence kinds `accepted-*`. All false: the intent candidate of record (`a06dbc57…`) carries verdict **repair** across every reviewer emission (`e49d8d11…`, `6c9c8324…` — its deviating "accepted" was withdrawn by its own author — `04632094…`; CR-001..003 verdictOfRecord repair) with **no adjudication record in the round**; the UC bundle (`24f0aff2…`) was authored **in violation of its own desk's hold** (UH-Model-Use-Cases-001: contention-open, hold-no-authoring) and has **never passed a reviewer stage**. The pins are byte-exact to UNACCEPTED revisions — and the author trio contradicts itself ("0 accepted upstream revisions" vs "the accepted … bundle"). The exact stray-product class the UC hold warned about, one desk further down. |
| CRIT-2 | CRITICAL | **Inherited fabricated disposition.** The brief and self-check 8 restate "prd:scope-2 out_of_scope at intent freeze" as fact. Recomputed capsule material: SC-2 (`cb291aa7…`) is a bare claim; CERT-1 (`03972527…`) is a subject-level go — **no exclusion decision exists** (CRIT-1 of both intent reviews). Zero derivation edges from prd:scope-2 are defensible while contested; ratifying the exclusion as settled is not. |
| MAJ-1 | MAJOR | `governingContractRef` `sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837` **resolves to no content** workspace-wide (213-file scan; 71 textual claimants recompute otherwise — the r1 CRIT-003 digest-drift family; FR-002 RA-2 still open). This desk bound the anchor anyway. |
| ADV-1..5 | advisory | Kernel submission is driver-executed (attestation); verification surfaces are desk-authored pins, not realized suites; terminal wording template quirk (discovery owner); stale envelope projections; single-seat namespace enforcement (driver). |

Not `upstream-repair` because the false claims live in **this candidate's own artifacts** — the
author desk could and should have held (the UH-Model-Use-Cases-001 pattern) instead of renaming
contended material into acceptance. Upstream defects are routed explicitly: RA-2 →
define-product-intent, RA-3 → model-use-cases.

## Required actions (RA-1..RA-5 in FR-Derive-System-Requirements-001, `sha256:d31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0`)

1. **RA-1 (CRITICAL, this desk's author):** hold, or reissue against genuinely accepted
   revisions with honest contention status (no "accepted" wording, no `accepted-*` evidence
   kinds, `revisionPinsMatchAcceptedRevisions` false, scope-2 recorded as upstream-contested).
2. **RA-2 (CRITICAL, define-product-intent):** settle under driver/human adjudication
   (`workplace.resolveHumanResponse`), then restore claim:scope-2 as carried boundary material
   or cite a genuinely recorded decision address.
3. **RA-3 (MAJOR, model-use-cases + driver):** reconcile the hold violation (record the
   adjudication or withdraw/supersede the bundle) and run the UC reviewer stage.
4. **RA-4 (MAJOR, contract layer):** re-seal so `sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837` resolves; update it across r2.
5. **RA-5 (PROCESS, driver/shell):** single-seat namespaces; refresh envelope projections.

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | `sha256:d81d23475ca309756165e65a109b7df94786636cfe794661ce7eea5b1f1a4f5b` |
| review | formalization-review | `sha256:d31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0` |
| trace | reviewer-verdict-trace | `sha256:e97b710f129eb9d15caf31294d170f0fa7b4b5d3b3941304d0a76074072637ba` |
| submission | FS-Derive-System-Requirements-002 | `sha256:f7e0e85c6992402209563516bd1b9de73a56bf1eaacf7a392dc910f65b17f9d0` |
| reproducible verifier | — | `derive-system-requirements-desk-reviewer-verify.mjs` (plain `node`, no deps) |

Pinned timestamp 2026-08-28T00:00:00Z across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere. Verifier evidence:
`derive-system-requirements-desk-reviewer-verify-out.json` (80 checks, 77 pass / 3 fail).
