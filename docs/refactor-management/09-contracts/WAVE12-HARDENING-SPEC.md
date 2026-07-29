# Wave 12 — End-to-End & Fault-Injection Hardening Frozen Spec

> Frozen on latest Wave 11 checkpoint (TBD). Plan §0.15 / Phase 14.

## 0. Objective (§0.15.11 serial gate)
Both Product Delivery and Campaign scenarios complete repeatedly across injected failures without manual database, metadata, tracker, workspace, or artifact repair. This is the DEFINITIVE end-to-end reliability proof.

## 1. Critical constraint (§0.15.2)
**All W12 lanes are test and diagnosis owners.** They do NOT patch shared core files. Failures return to the owning subsystem and fixes integrate serially (plan §0.15.2). This wave PROVES the architecture — it doesn't change it.

## 2. Lanes (8) — all test-only

| Lane | Owns |
|---|---|
| **W12-A1** | Package mutation, corruption, version upgrade, installation retention, replay tests. Proves immutable package bytes survive source mutation, disk corruption, and version upgrades while active runs stay pinned. |
| **W12-A2** | ProcessRun, NodeRun, receipt, production crash-point tests. Injects process termination before and after every durable boundary (receipt write, production write, NodeRun complete, ProcessRun transition). Proves crash-resume from exact state. |
| **W12-A3** | ProtocolRun, Recovery, CallInstance, tool-effect, sealing crash-point tests. Injects crashes between protocol step transitions, recovery decisions, call submissions, and sealing. Proves no step is lost or skipped. |
| **W12-A4** | Lifecycle transition, mapping, lock, upgrade, cancellation, restart fault tests. Injects failures during scenario stage transitions, module-lock verification, and LifecycleRun cancellation. Proves scenario integrity under faults. |
| **W12-A5** | Invalid package, schema, capability, mapping, route, authority, structured-error security tests. Proves ALL invalid inputs are rejected BEFORE semantic work begins (fail-closed). |
| **W12-A6** | Intensive weak-model and assistance-budget scenario runs. Proves a weak model receives exact bounded guidance (current step, files, allowed tools, completion criteria, repair action) from pinned resources without module-specific runner code. |
| **W12-A7** | Repeated real Product Delivery runs with product idea A and product idea B. Proves the full pipeline completes repeatedly with different inputs, including restart mid-run. |
| **W12-A8** | Repeated Campaign runs and cross-scenario isolation. Proves Campaign completes repeatedly and does NOT interfere with concurrent Product Delivery runs. |

## 3. Exit gate (§0.15.11)
1. Both Product Delivery and Campaign reach valid terminal outcomes.
2. Across injected failures at every durable boundary.
3. Without manual DB/metadata/tracker/workspace/artifact repair.
4. Invalid packages/schemas/capabilities/mappings/routes/authority/tools fail BEFORE semantic work.
5. Weak model receives bounded guidance.
6. Cross-scenario isolation holds.
7. Ratchet green. Wave 0-11 regression green.

## 4. Anti-scope
- NO production code changes (test-only wave, §0.15.2).
- If a test reveals a bug, the test documents it + returns to the owning subsystem for a fix (serial integration).
- NO legacy code removal (Wave 13).
- NO new features — this wave PROVES existing Waves 0-11 work end-to-end.

## 5. Test design principles
- Use the REAL infrastructure (real SQLite, real filesystem store, real ScenarioRunner) — not mocks.
- Inject crashes by simulating process death (close DB, clear in-memory state, reopen).
- Assert byte-level replay equality (content hashes match across crash boundaries).
- Assert NO fallback paths activate (no epic-scope search, no latest-execution, no magic-binding).
- Each test is self-contained (creates its own tmpdir DB + store, cleans up in finally).
