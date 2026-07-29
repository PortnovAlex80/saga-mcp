# Wave 8 — Formalization Vertical-Slice Pilot Frozen Spec
> Frozen on `5bf74bf` (Wave 7 checkpoint). Plan §0.11 / Phase 9.

## 0. Context
Wave 8 is the FIRST production module migration. Formalization (PRD/SRS/UC/AC) migrates to run through pinned package resources + standard interfaces. This is the proof-of-concept for Waves 9-11. Plan §0.11.11 serial gate: "Formalization runs completely through pinned package resources with no fallback context, global resource lookup, or direct infrastructure dependency."

## 1. Lanes (8)
| Lane | Owns |
|---|---|
| **W8-A1** | Formalization package manifest (NEW: `modules/formalization/package/` — manifest, resource index, contract refs, package exports). ONLY lane that edits the central manifest. |
| **W8-A2** | Product-contract node protocols + package-local resources (PRD node protocol + resources) |
| **W8-A3** | Use-case node protocols + package-local resources |
| **W8-A4** | Acceptance + reconciliation node protocols + package-local resources |
| **W8-A5** | Architecture + recovery node protocols + package-local resources |
| **W8-A6** | Formalization ports + handler adapters (remove global DB/infra access — inject module ports) |
| **W8-A7** | Verifier/acceptance/exact-product/output/reviewer/recovery contributions |
| **W8-A8** | Tests: author/review/kernel/retry/recovery/restart/settlement/package-isolation conformance |

## 2. Exit gate (§0.11.11)
1. Formalization runs through pinned package resources. 2. No global skill/template lookup. 3. No direct infrastructure dependency. 4. No fallback context. 5. Ratchet green. 6. Wave 0-7 regression green.

## 3. Anti-scope
- No changes to other modules (Discovery/Development/Delivery — Wave 9).
- No composition root cutover (Wave 11).
- No legacy code removal (Wave 13).
- Additive: legacy formalization path preserved alongside.
