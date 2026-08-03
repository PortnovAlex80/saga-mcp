# 04 — Quality & Risk Baseline

> Phase 4. Code quality, test coverage, security, NFRs.

## 4.1 Code Quality & Technical Debt Report

### Complexity hotspots

| File | LOC | Comment % | Complexity driver | Big-O concern | Recommendation |
|---|---|---|---|---|---|
| `tracker-view/tracker-view.mjs` | 5605 | ~10% | God Object: HTTP + UI + renderer + dispatch + recovery + model management | N/A (I/O bound) | Split into 5+ modules (§Phase 6 Seam Map) |
| `formalization-installation.ts` | 2029 | ~25% | 7 kernel handlers + traceability graph + exact-candidate-acceptance in one file | O(n) graph scan per handler call (n = artifacts in epic) | Split handlers into separate files; extract shared helpers |
| `dispatcher.ts` | 1610 | ~15% | 7 MCP handlers (worker_next/done/ask/merge/health) with complex SQL + fence logic | O(1) per claim (indexed SQL); O(n) in `worker_health` scan | Consider splitting worker_done into separate command handlers |
| `generic-flow-executor.ts` | 1482 | ~40% | Wave-archaeology comments + dual v1/v2 paths + frame assembly | O(n) walk where n = Flow nodes (typically 5-15) | Remove dead v1 path, extract Wave history to ADR |
| `sqlite-exact-candidate-acceptance.ts` | 1456 | ~20% | Atomic CAS with extensive validation | O(n) where n = candidate set (typically 1-5) | Acceptable complexity for a kernel gate |
| `scenario-runner.ts` | 1442 | ~15% | Scenario manifest execution | O(n) where n = stages × modules | Split into per-stage handlers |
| `cgad-spec-lint.mjs` | 1380 | ~15% | 18 rules, each with its own SQL query | O(n) per rule where n = rows in target table | Acceptable for a batch audit tool |
| `sqlite-development-settlement-state.ts` | 1354 | ~20% | Settlement state reconstruction from tracker | O(n) where n = tasks × evidence × repositories | Acceptable for deterministic policy input |

### Duplication

| Duplicated code | Location A | Location B | Risk | Fix |
|---|---|---|---|---|
| `ManagedProductionLedger` interface | `development-kernel-ports.ts:105-144` | `formalization-kernel-ports.ts:90-126` | Silent drift (structural typing) | Extract to `shared/managed-production.ts` |
| Canonical JSON function | `saga3/shared/discovery-canonical.ts:28-35` | `process-modules/shared/canonical-json.ts:17` (re-export) | Indirection obscures ownership | Consolidate to `shared/canonical-json.ts` |
| Acceptance baseline hash | `formalization-installation.ts:1973-1979` | `sqlite-formalization-kernel.ts:143-166` | Two implementations of same algorithm | One canonical function |
| `fallbackAssertCanonicalSerializable` | `production-envelope.ts:61-105` | `module-completion.ts:37-75` | Copy-paste between SPI siblings | Extract to shared SPI utility |
| `buildXxxModuleCompletion` (type cycle workaround) | `discovery-installation.ts:920-933` | `development-installation.ts:454-471` | Identical `null as unknown as ModuleCompletion` pattern | Fix type cycle at SPI level |

### Dependencies

| Dependency | Version | Known issues | Evidence |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.26.0 | Young SDK; breaking changes possible | `package.json` |
| `better-sqlite3` | ^12.6.0 | Native module; requires rebuild per Node version | `package.json` |
| `zod` | ^4.3.6 | Major version 4 (recent); API may still shift | `package.json` |

No CVE-flagged dependencies observed at time of analysis. The dependency surface is minimal (3 runtime deps) — this is a **strength**.

### Wave debt (unfinished refactoring)

| Debt item | Current state | Evidence | Impact |
|---|---|---|---|
| v1/v2 dual-write in GenericFlowExecutor | v1 is dead code after Wave 5 cutover; still present | `generic-flow-executor.ts:604-763` | ~400 lines dead code |
| `saga3/` cross-tree leakage | Discovery module reaches into saga3/ via dynamic import | `discovery-installation.ts:155-175` | Module not self-contained |
| `restoreFrame` retired but `assembleFrameFromDurableNodeRuns` still a boundary adapter | Wave 6 retired `restoreFrame`; adapter remains as compatibility shim | `generic-flow-executor.ts:1241-1269` | Unnecessary indirection |
| Type cycle workaround | `ModuleCompletion ↔ ProcessModuleOutputEnvelope` cycle resolved with `null as unknown as` | `module-completion.ts:110-114` | Fragile serialization |
| Composition root 780 lines | Manual wiring of all 4 modules + all repositories | `product-lifecycle-runtime.ts` | Shotgun surgery for new module |
| `tracker-view.mjs` monolith | 5605 lines, single file | `tracker-view/tracker-view.mjs` | God Object |

### Comment-to-code ratio (systemic)

Across the 15 largest TypeScript source files, an estimated **30-35% of total lines are comments** — primarily Wave-history documentation (Wave 1-6, FU-A/B/D, Slice 1-7). This is not behavioral documentation; it is change archaeology.

| File | Total lines | Estimated comment lines | Comment % |
|---|---|---|---|
| `generic-flow-executor.ts` | 1482 | ~600 | 40% |
| `formalization-installation.ts` | 2029 | ~500 | 25% |
| `discovery-installation.ts` | 1054 | ~250 | 24% |
| `delivery-installation.ts` | 1093 | ~250 | 23% |
| `development-installation.ts` | 868 | ~200 | 23% |
| `lm-node-executor.ts` | 837 | ~200 | 24% |

**Recommendation:** Extract Wave-history comments into `docs/architecture/WAVE-LOG.md`. Each file should carry behavioral documentation only.

---

## 4.2 Test Coverage Baseline

### Quantitative

| Metric | Value | Evidence |
|---|---|---|
| Test files (`.test.mjs`) | 231 | `find tests -name '*.test.mjs' \| wc -l` |
| Total test LOC | ~103,826 | `git ls-files 'tests/**/*.mjs' \| xargs wc -l` |
| Source LOC (TS) | ~109,404 | `git ls-files 'src/**/*.ts' \| xargs wc -l` |
| Test-to-source ratio | ~0.95:1 | Calculated |

### Coverage by domain

| Domain | Test files | Key tests | Gaps |
|---|---|---|---|
| **Architecture ratchets** | 5+ | `dependency-direction.test.mjs`, `no-execution-scoped-lookup.test.mjs`, `conveyor-ports.test.mjs`, `cutover-architecture-checks.test.mjs` | Comprehensive |
| **Dispatcher races** | 8 scripts | `run.mjs`, `assign-race.mjs`, `isolation.mjs`, `review-verdict-race.mjs`, `worktree-isolation.mjs`, `parallel-concurrency.mjs` | Comprehensive for claim races |
| **Process modules** | 80 | `node-durable-identity.test.mjs`, `formalization-settlement.test.mjs`, characterization tests | Module-specific handler edge cases may be under-tested |
| **Saga3** | 33 | `d4-settlement-atomicity.test.mjs`, D1-D5 tests | Authority gateway edge cases |
| **Lifecycle** | 32 | State machine + invariants | Transition budget edge cases |
| **Execution (e2e)** | 28 | `definition-of-done.test.mjs` (1577 lines), `hardening-*.test.mjs` | Real LM integration not tested (mock-claude only) |
| **Characterization** | 15 | `saga2-runtime-contracts.test.mjs`, `lifecycle-routing-mapping-lock.test.mjs` | Legacy contract preservation |

### Critical untested paths

| Path | Risk | Evidence |
|---|---|---|
| Real LM execution (no mock-claude) | High — production behavior may differ from mock | `tests/mock-claude.mjs` is used; no integration test runs real `claude -p` |
| Multi-host scenario | Medium — `supervision_locks` table exists but single-host only | `supervision_locks` schema exists; no multi-host test |
| DB corruption recovery | Medium — no corruption-handling test | SQLite WAL is robust but no explicit recovery test |
| Package store filesystem corruption | Medium — content-addressed store has no self-healing | `FilesystemModulePackageStore` has no integrity check on read beyond digest |

---

## 4.3 Security As-Is Map

### Authentication / Authorization

| Layer | Mechanism | Evidence | Assessment |
|---|---|---|---|
| MCP tool calls | Authority gateway per call | `src/index.ts:187-199`, `authorize-saga-tool-call.ts` | **Strong** — fail-closed, frozen context |
| Worker process spawning | `--disallowedTools` / `--allowedTools` CLI flags + MCP gateway | `claude-runner.mjs:823-864` | **Belt-and-suspenders** — both CLI and gateway enforce |
| SQLite DB access | Filesystem permissions (no auth) | `src/db.ts` | **Single-tenant assumption** — no DB-level auth |
| HTTP API (tracker-view) | None (no auth, localhost only) | `tracker-view.mjs` | **Open by design** — localhost:4321, no CORS, no auth headers |
| Git operations | OS-managed credentials | Worker skills | Standard |

### Secrets handling

| Secret | Storage | Risk | Evidence |
|---|---|---|---|
| Model API keys | `~/.claude/settings.json` env vars | Low (filesystem permissions) | `claude-runner.mjs:895-905` |
| DB_PATH | Environment variable | Low | `src/db.ts:14` |
| Worker execution context | `worker_executions.metadata` (JSON in SQLite) | Medium (contains authority scope, model route — not secrets per se, but sensitive metadata) | `work-assignment-core.ts:345-358` |

### Security gaps

| Gap | Risk | Evidence | Recommendation |
|---|---|---|---|
| No encryption at rest (SQLite) | Medium — idea content, brief payloads may be sensitive | `src/db.ts` (plain SQLite) | Stakeholder decision: is disk encryption sufficient? |
| No HTTP auth on tracker-view | Low (localhost only) but could be exposed | `tracker-view.mjs` | Add token-based auth if exposed beyond localhost |
| No rate limiting on MCP calls | Low (single-process, bounded by claude spawn rate) | `src/index.ts` | Acceptable for single-tenant |
| Worker JSONL logs may contain user data | Medium (no retention policy) | `claude-runner.mjs:944-947` | Add retention policy |

---

## 4.4 Non-Functional Requirements (As-Is + Stakeholder Gap List)

### NFRs observable from code

| Category | NFR | Value/Evidence | Source |
|---|---|---|---|
| **Concurrency** | Max concurrent workers | 1-10 (validated) | `dispatch-loop.ts:184-188`, `claude-runner.mjs:488-490` |
| **Timeout** | LM node execution | 30 min (`maxRunMs`) | `lm-node-executor.ts:237` |
| **Timeout** | Reserved boot | 60s | `stuck-policy.ts:59` (`RESERVED_BOOT_TIMEOUT_MS`) |
| **Timeout** | Stuck silence | 10 min | `stuck-policy.ts:63` (`STUCK_SILENCE_MS`) |
| **Timeout** | Cancel grace | 5 min + 1 min | `stuck-policy.ts:65-67` |
| **Timeout** | Lease TTL | 5 min (renewed by supervisor) | `work-assignment-core.ts:81` (`WORKER_LEASE_TTL_MS`) |
| **Timeout** | Merge lock stale | 10 min | `dispatcher.ts:72` (`MERGE_LOCK_STALE_MIN`) |
| **Timeout** | ProcessRun lease | 120s (renewed by heartbeat) | `generic-flow-executor.ts:168` |
| **Timeout** | Lifecycle lease | 120s (renewed by watchdog) | `lifecycle-orchestrator.ts:32` |
| **Reliability** | Idempotency | Command receipts (command_id + payload_hash) | `lifecycle/idempotency.ts`, `schema.ts:519-532` |
| **Reliability** | Crash recovery | Durable NodeRun + resume from last completed | `generic-flow-executor.ts:442-536` |
| **Reliability** | DB journal | WAL mode, `busy_timeout=5000`, `synchronous=NORMAL` | `db.ts:23-26` |
| **Scalability** | DB | Single SQLite file, single process | `db.ts` — architectural ceiling |
| **Observability** | Heartbeat log | `~/.zcode/cli/worker-heartbeat.log` (append-only text) | `claude-runner.mjs:395-410` |
| **Observability** | Activity log | `activity_log` table (append-only) | `schema.ts:278-288` |
| **Observability** | Stream-JSON | `claude -p --output-format stream-json` | `claude-runner.mjs:877` |

### NFR gaps requiring stakeholder input

| Category | Question | Why it cannot be derived from code | Stakeholder |
|---|---|---|---|
| **SLA** | What is the target lifecycle completion time? | No SLA constants in code. | Product owner |
| **Throughput** | How many concurrent epics/lifecycles are expected? | Single-process SQLite limits this; no multi-host code. | Product owner |
| **Availability** | What is the target uptime? Is saga-mcp expected to run 24/7 or per-session? | No availability config, health checks, or restart-on-failure logic beyond `TRACKER_AUTOSTART`. | Operations |
| **Scalability** | Is multi-host orchestration a near-term requirement? | `supervision_locks` table exists (cross-process advisory lease), but no multi-host worker spawn. | Product owner |
| **Compliance** | What regulatory scope applies (GDPR, SOC2, HIPAA)? | No compliance controls observed. | Legal/compliance |
| **Data retention** | How long should worker logs, activity_log, and evidence be retained? | No purging logic. Indefinite accumulation. | Operations |
| **Security** | Is the SQLite DB expected to be encrypted at rest? | No encryption. Filesystem permissions only. | Security |
