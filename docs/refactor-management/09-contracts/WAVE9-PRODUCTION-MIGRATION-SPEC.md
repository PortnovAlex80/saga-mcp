# Wave 9 — Remaining Production Module Migrations Frozen Spec
> Frozen on `b7b4b0d` (Wave 8 checkpoint). Plan §0.12 / Phases 10-11.

## 0. Context
Wave 8 proved the migration pattern with Formalization. Wave 9 applies the same pattern to Discovery, Development, and Delivery. Each module: manifest + node protocols + resources + ports + contributions. No migration lane may modify Runtime, global registries, runner, gateway, lifecycle composition, or another module (plan §0.12.11).

## 1. Lanes (8)
| Lane | Owns |
|---|---|
| **W9-A1** | Discovery manifest + package resources + NodeProtocols + central exports |
| **W9-A2** | Discovery proposal/normalization/readiness/diagnosis/brief tool contributions + legacy engine adapter subtrees |
| **W9-A3** | Development manifest + planning/verification protocols + resources + central exports |
| **W9-A4** | Development child execution/provenance/port/handler/product contribution subtrees |
| **W9-A5** | Delivery manifest + flow protocols + resources + central exports |
| **W9-A6** | Delivery external effects/human approval/idempotency/ports/receipts/contribution subtrees |
| **W9-A7** | Shared module conformance runner + cross-module isolation checks |
| **W9-A8** | Migration compatibility/restart/recovery/exact-output/package-isolation integration tests |

## 2. Exit gate (§0.12.12)
Discovery, Development, Delivery independently pass the same installation, execution, review, recovery, restart, and output conformance kit as Formalization.

## 3. Anti-scope
- No Runtime/runner/gateway/catalog/another-module edits.
- No composition root cutover (Wave 11).
- No legacy code removal (Wave 13).
