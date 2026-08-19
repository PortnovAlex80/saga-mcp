# PREVENTIVE-HUNT — cross-layer defect census (stage-11 aftermath)

**Mission (operator directive, 2026-08-19):** stage-11 fixed ONE instance of a
generalized defect class. Before reporting to the architect, sweep ALL
architectural layers for the same classes, preventively fix what is confirmed
(red test first), and let the architect find the work already prospectively
done. Eight read-only investigator agents were dispatched, one per layer.

**The five defect classes** (generalized from the stage-10/11 kills):

- **A** — frozen/authority material holds a pointer into mutable state (rowid,
  PID, path, timestamp-as-identity, branch name) dereferenced later.
- **B** — predicate desync: two components validate the same boundary with
  different predicates (one accepts, the other rejects).
- **C** — silent drift absorption: live re-read where a frozen snapshot was
  sealed; mutation absorbed without event.
- **D** — fatal widening: local failure escapes to global scope while a scoped
  path exists but is bypassed.
- **E** — reason-blind counters: budgets counting rounds, never reason identity.

Reachability: LIVE = ordinary flow triggers it; LATENT = needs a specific but
realizable state. Severity: Critical/High/Medium/Low.

---

## Layer 1 — orchestration (modules, flow executor, obligations)

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| O-D1 | D | One worker's wrong-schema product kills whole ProcessRun+LifecycleRun incl. N-1 healthy workplaces; typed gate-verdict scoped path exists but unwired for contract-shape violations | production-cell-node-executor.ts:1652-1689 → generic-flow-executor.ts:779-789,440-452 → lifecycle-orchestrator.ts:376-384 | LIVE / **Critical** |
| O-D6+E1+B4 | D/E/B | **The B-004 livelock machine**: defer/fail/findReady have NO cap; `attempt` never compared (observed >1500); sole exits complete/abandon; abandon reachable only from boot-burial matching terminal_status='failed' ONLY → paused lifecycles defer forever, re-driving baseEngine.run every sweep | sqlite-transition-obligation-ledger.ts:380-454,262; engine-start-lifecycle-burial.ts:86-91,174-188; product-lifecycle-runtime.ts:1041-1045,1227-1233 | LIVE / **Critical** |
| O-D2 | D | Presentation-authority/carry-forward/effect-pending throws instead of parking; pendingOutcome exists unused for these | node-executor :703-726,524-530,850-851,1140-1163 | MED / High |
| O-D3 | D | Abandoned run-gate obligation → next reconciliation throws, fatalizes run | node-executor :778-783 | MED / High |
| O-D4 | D | Stale resume directive: peek throws outside try; scoped null-path one line below; also strands started NodeRun | generic-flow-executor.ts:769-780; sqlite-resume-directive-repository.ts:66-78 | MED / High |
| O-D5 | D | SETTLEMENT_COMPLETION_MISSING global throw; scoped failed-outcome channel needs flow opt-in | generic-flow-executor.ts:352-357 | MED / High |
| O-D7 | D | FINAL_ACCEPTANCE_RECEIPT_UNRESOLVED etc. thrown inside handler → identical retry forever (reason-blind) | product-lifecycle-runtime.ts:987-993,1015,1207-1225 | MED / High |
| O-B1 | B | Handoff admissibility: SQL-row predicate vs ledger-state predicate; failed obligation + satisfied postcondition = defer forever + node throws | postconditions.ts:15-134 vs node-executor:773-777,837-839,1046 | MED / High |
| O-E2..E8 | E | ALL counters reason-blind: recovery budget (max of 3 heterogeneous), epochs (diagnosis never compared), review rejections, verification retries (same-AC vs different-AC indistinguishable), maxSteps, transitionBudget, nodeRun attempt | node-executor:1740-1800; dispatcher:712-749,689-710 | LIVE / High-Med |
| O-A1 | A | Checkpoint adoption: nodeRunId/taskId/artifactRef ids of SOURCE db never validated in TARGET (content-hash only partial guard) | factory-checkpoint-service.ts:38-45,490-551 | LOW-MED / High |
| O-C2 | C | restoreLastNonTerminalCompletion swallows repo errors → SETTLEMENT_COMPLETION_MISSING later | generic-flow-executor.ts:1219-1224 | MED / Medium |

## Layer 2 — replay/checkpoint/resume

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| R-A4 | A/C | **Replay poisons replay**: 6 selector-drift entry points incl. replay's own artifact_create upsert rewriting rows capsule N-1 sealed selectors depend on; chained replays invalidate each other, no deletion needed; failed replay stays eligible in other workplaces | artifacts.ts:300-323,487-543; artifact-file.ts:33-50; capsule-replay-executor.ts:470-494; replay-claim-binder.ts:52-61 | LIVE / **High** |
| R-B3 | B | NULL-hash asymmetry: capsule sealed with NULL content_hash matches ANY live hash on replay (silent drift) | capsule-replay-executor.ts:483 | LIVE / Medium |
| R-D2 | D | Fallback sweep gated on cfa row — the exact row the failed primary path never wrote → nothing ever certifies or alarms | replay-claim-binder.ts:122-127 vs replay-capture-effect.ts:5-9 | LIVE / **High** |
| R-C6 | C | Missing candidate-set row in sweep → completely silent continue (not even stderr) | replay-claim-binder.ts:166-167 | LIVE / High(obs) |
| R-D4 | D | restore-from-checkpoint --reset-stage never touches factory_replay_capsules → claims replay the exact production the operator reset to regenerate | restore-from-checkpoint.mjs:207-303 | LIVE / **High** |
| R-D6 | D | Failed replay debris: code-null artifacts INSERT duplicates on retry → resolution space poisoned for OTHER capsules | capsule-replay-executor.ts:143-247; artifacts.ts:295-297 | LIVE / **High** |
| R-A1 | A | Checkpoint adoption: frozen head/status evidence never compared; same-id re-bound repo row misdirects artifact materialization silently | factory-checkpoint-service.ts:191-197,559-585 | REAL / High |
| R-B8 | B | adopt() never compares sourceDbNamespace — foreign checkpoint importable on numeric-id match alone | factory-checkpoint-service.ts:452-557 | MED / Medium |
| R-E1 | E | Sweep produces no counts: "0 needed" vs "0 of 12 failed" indistinguishable | replay-claim-binder.ts:113-190 | LIVE / High(obs) |
| R-clean | — | replay-capsule-selection is clean (no recency; typed conflict) | replay-capsule-selection.ts:51-65 | — |

## Layer 3 — engine/runtime

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| E-S1 | E | **Loop detector dead on opencode backend**: shim drops --output-format stream-json; ANSI text; every JSON.parse fails → 12-repetition kill can never fire → unbounded token burn (LIVE in stage-11 run now) | claude-runner.mjs:1068; claude-shim.mjs:139-167; repeated-tool-loop.mjs:9-11 | LIVE / **High** |
| E-P1 | C/D | **B-002 root**: factory.mjs engine NOT detached (comment lies), stdio inherits terminal (QuickEdit freeze), no SAGA_ENGINE_LOG, invisible to watchdog (LIVE now) | scripts/factory.mjs:142-151 | LIVE / **High** |
| E-L3 | B/C | Deferred sweeps >5min → all healthy workers' leases expire → first successful sweep TERMINATEs the whole alive cohort (lease proves supervisor ran, not worker alive) | stuck-policy.ts:412-418; worker-supervision-service.ts:305-319 | LIVE-cond / **High** |
| E-W1 | D | Watchdog stale threshold (120s) < engine's own legit synchronous sweep (13+ execs × 5s CIM) → kills healthy engine → restart ladder → failed_watchdog | engine-supervisor.mjs:43; worker-executions.ts:356-403 | HIGH-load / **High** |
| E-A6 | A | Soft-stop brake reads only controls.engine_pid — starter/factory.mjs engines never write it → brake no-op on OUR launch path | operator-soft-stop.ts:259-268 vs run-starter:159-165 | LIVE / **High** |
| E-A1 | A | POSIX kill -9 on persisted pid without birth-token/cmdline guard → PID reuse kills unrelated process | engine-administration.ts:435-441 | POSIX / HIGH |
| E-L1 | B | Controller fence never checks expires_at; renewal is the MOST contention-sensitive write (busy-retry 250ms×3 vs 5s busy_timeout) | sqlite-factory-launch-repository.ts:272-283; orchestrate-cli.ts:146-158 | LIVE / High |
| E-L2 | B | Process-run lease takeover at expiry → duplicate node execution (node runs not lease-fenced; discover loss only at next heartbeat) | sqlite-process-run-repository.ts:362-397 | MED / High |
| E-P2 | B | Engine stderr piped to panel WriteStream without 'error' handler → disk-full crashes panel; orphaned pipe freezes engine on next fatal stderr | engine-administration.ts:176-177; run-starter.ts:149-150 | MED / Med-High |
| E-W2 | D | markers-unreadable → spawn dedupe only checks pid alive → duplicate engine beside live one (B-002 interaction) | engine-supervisor.mjs:354-378 | MED / Med-High |
| E-S2 | C | Shim silently degrades unmapped model to default (glm-5.3→5.2 quota burn); durable record only in worker stderr | claude-shim.mjs:114-133 | LIVE / MED |

## Layer 4 — workplace/authority spine (K10–K13)

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| W-1 | B+D | **B-004 path 1**: crash window between acceptance-effect and final-acceptance → reconciler completes run-effects on looser postcondition → C8 gate demands in_progress (permanently false) → record-final-acceptance unsatisfiable → defer loop. Boundary evaluated by FOUR predicates | node-executor:494-504,1153-1170,837-839; postconditions:48-82,159-170 | LIVE / **Critical** |
| W-2 | B+A | **B-004 path 2**: C8 recovery writes FinalAcceptance with effectReceiptRefs=[] — immutable+digest-fenced row that the obligation postcondition can never match | node-executor:1146,907-911; cell-final-acceptance:318-346 | LIVE / High |
| W-3 | B | **B-004 path 3**: carry-forward presentations have no worker_executions row (kernel presenter by design) → replay certification throws inside recordFinalAcceptanceAndCapture | gate-repo:100-132; replay-presentation-authority:39,56-65; node-executor:1107 | LIVE / High |
| W-10 | B | Completion receipts: exact for ONE handoff kind; fabricated alias for the other FOUR (admitted in code) — the enabling substrate of W-1 | postconditions:143-172; product-lifecycle-runtime:985-995 | LIVE / Med-High |
| W-4 | A | Head stores tasks-rowid; integration/carry-forward/reviewer-digest dereference live integration_state/integrated_commit columns | head:155; production-cell-integration:78-107,195-228; carry-forward:186-208 | LIVE / Medium |
| W-5 | A | K13 acceptanceId hashes submission-rowid alias strings (stage-11 class, one layer up) | coordinator:578-593; head:227-239 | LATENT / Medium |
| W-7 | C | Reviewer replay digest from LIVE task metadata via head→task join, with silent recompute fallback | node-executor:1320-1322; product-lifecycle-runtime:445-462 | LIVE / Medium |
| W-9 | B | Revision fence checked by THREE predicates at three layers; mismatch rolls back accepted transition while decision stays terminal | coordinator:649,482; factory-start:826 | LATENT / Medium |

## Layer 5 — persistence/schema

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| S-3 | A+C | **reset-stage orphans authority heads**: runs with FKs OFF, no FK check; deletes decisions/runs/sets leaving decision-heads, attempts, commitments as dangling pointers incl. the "current repair authority" | restore-from-checkpoint.mjs:216-339 | LIVE / **High** |
| S-6 | E | Reset drops CandidateSets (attempt counter) but epoch baselines stay → negative attempts-in-epoch → ADR-075 math misfires | restore-from-checkpoint.mjs:282-291 vs epochs | LIVE / Med-High |
| S-10c/g/h | A | Immutable-semantics tables WITHOUT triggers: factory_replay_capsules (cascade-deletable!), verification_evidence, obligations' causal columns | schema.ts:1799+,927-944; replay-capsule-repo:37-48 | LATENT / Med-High |
| S-1/2 | B/C | Both reset tools stale: saga-reset-stage crashes on dead saga3_* namespace; reset-saga-db cannot complete on factory DB (masks unmigrated coverage) | saga-reset-stage.mjs:145+; reset-saga-db.mjs:18-84 | LIVE(tool-dead) / High |
| S-4/5 | B | Reset script trigger list wrong → its "defended" paths ABORT | restore-from-checkpoint.mjs:92,216-225 | LATENT / Medium |
| S-12 | B | project_delete unexecutable for real factory projects (guard predicate ≠ real FK blockers) | projects.ts:252-325 | LIVE / Medium |
| S-13 | C | SET NULL cascades silently sever verification canonical-AC bindings | schema.ts:142,110,339,400-401 | LIVE / Medium |
| S-clean | — | CHECK-vs-code: NO drift (verified all enums); K13 lazy ALTERs converge with base DDL | — | — |

## Layer 6 — config/model routing

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| C-1 | C | **Freeze misses endpoint**: provider frozen, endpoint from LIVE settings.json; one tracker click mid-epic → zai-frozen worker runs on LM Studio | work-assignment-core:588-599; claude-runner:840,1086-1101 | HIGH / **High** |
| C-4 | B | Nothing enforces FROZEN route's model limit; mid-run switch → per-account concurrency exceeds both limits | factory-model-profiles:113-124; runtime-repos:55-92 | HIGH / **High** |
| C-5 | B | **bd81b02b recurrence vector**: guard reads TRACKER's env; engine on shim + tracker without it → /api/model/set rewrites interactive channel | model-management:41-43 vs factory.mjs:130-141 | MED-HIGH / **High** |
| C-6 | B | Even guarded: first model/set CREATES settings.cloud.json with AUTH_TOKEN under ~/.claude/* | model-management:302,310,216 | LIVE / Medium |
| C-8 | C | 'factory-runtime' placeholder digest on GATE path (fail-open twin of fail-closed workspace pinning) | product-lifecycle-runtime:726-727; node-executor:1603 | MED / Med-High |
| C-11 | A | Replay authority via mutable process.env (set/delete window binds stray calls to replay execution) | claude-worker-executor-factory:671-716 | MED / Med-High |
| C-17 | D | Composition override untyped/unversioned/unmarked; silently replaces worker executor | orchestrate-cli:704-794 | MED / High |
| C-14 | B | Controls-row missing: one reader fail-closed, two fail-open with default zai | runtime-repos:66-70 vs work-assignment-core:86-90 | MED / Medium |

## Layer 7 — effects/integration/delivery

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| X-6 | D | **Sibling merge kills continuation**: carry-forward drift branches triggered by ordinary parallel-desk integration → throw + frozen authorization + IDEMPOTENCY_MISMATCH on retry → permanent death, no repair path | carry-forward:401-455,619-624 | LIVE(norm) / **High** |
| X-9 | A | Capsule replay checkout -B is the ONLY force-mover of sealed branches; failure leaves branch at baseCommit → all seal proofs permanently broken | capsule-replay-executor:580,618-621 | MED / **High** |
| X-5 | D | Transient git failure writes integration_state='conflict' indistinguishably from real conflict → observation path poisoned forever (K11 banned this for 'merged' only) | production-cell-integration:384-387,173-179 | MED-HIGH / **High** |
| X-8 | A | Delivery can never settle after publication if branch moves (branch-authority defeats tag-authority) | delivery-runtime:443-445; delivery-settlement:475-484 | LIVE / **High** |
| X-7 | A | Release continuation bakes LIVE branch head into immutable desiredStateHash → sibling merge = tag on uncertified commit, checks pass | factory-release-continuation:52-64 | MED / **High** |
| X-4 | B/E | Delivery bypasses effect protocol via per-run action keys: retry gate never fires; non-atomic pre-observe allows double execution | delivery-runtime:482-483,539-564 | LIVE / High |
| X-3 | B | absent-retry-safe erases recorded provider_effect_id from unknown row and authorizes re-execution → duplicate provider effect | external-effect-ledger:664-686,501-511 | MED / High |
| X-14 | B | Two merge authorities (dispatcher advisory-lock merge vs effect CAS) mutually invisible on same ref | dispatcher:1517-1540,1380-1440; integration:406-412 | MED / Med-High |
| X-18 | D | Git op >60s lease → throw escapes the catch block AFTER successful merge | git-integration-effect:114-126 | MED / Med-High |
| X-15 | D | Delivery provider missed the Repository-Desk consistency fix (raw pr.local_path) → different physical repo than integration/replay | local-git-tag-delivery:162-169 | MED / Med-High |
| X-1/2 | B | Same ledger state classified differently by execution vs observation path; runtime told repair then human for identical row | git-integration-effect:57-126 | HIGH / Med-High |
| X-13 | E | Five distinct conditions collapse into one reason string → spurious repairs / wrong human-parks | integration:123-137,453-458 | MED / Medium |

## Layer 8 — worker/tool surface

| ID | Class | Essence | Sites | Reach / Sev |
|---|---|---|---|---|
| T-2 | B | artifact_create upsert NULLs accepted_hash of an accepted AC (repeat create, default status draft) → frozen baseline silently degrades; verification approval breaks | artifacts.ts:264,300-323 vs :530-544; srs-contract-validator:516 | LIVE / **High** |
| T-3 | B | Frozen-baseline tag guard runs ONLY in artifact_update; the upsert path rewrites tags on frozen accepted ACs unguarded (blocker→degradable post-freeze; drift detector blind) | artifacts.ts:569-571,109-148 vs :300-323 | LIVE / **High** |
| T-5 | C | Three verification consumers read LIVE accepted_hash where baseline sealed: pinned evidence stops matching (task unapprovable) or vouches for never-frozen content — violates development.evidence-pins-candidate | lifecycle.ts:72-78; dispatcher:786-794; srs-contract-validator:506-518 | LIVE / **High** |
| T-8 | D/C | Released/exited execution can still trace_delete (no ledger liveness check, only voided-flag) — residual stage-11 class: capture fix protected resolution, not deletion liveness; ask_need terminalizes without receipt (gateway close-fence receipt-scoped) | artifacts.ts:704-737; dispatcher:1082-1178; authorize-tool-call:347-365 | LIVE / **High** |
| T-7 | D | Operator artifact_create with hashable file → writeProduct(executionRef 'system') → hard STALE_EXECUTION_CANNOT_SUBMIT; scoped refusal path exists, bypassed | artifacts.ts:370-377; product-repository:73-90 | LIVE / High |
| T-19 | D | In-process capsule replay bypasses authorizeSagaToolCall entirely (raw handlers; no allowlist/fence) + mutates shared process.env around replay | claude-worker-executor-factory:648-674 | LIVE / Med-High |
| T-1 | B | 'summary' type in handler enum + inputSchema but NOT in DB CHECK / TS union — worker following the tool description dies on generic constraint error | artifacts.ts:43,846,876; schema.ts:333; types.ts:160-168 | LIVE / Medium |
| T-6 | C | artifact_get (read-only hint) rewrites content_hash/drift_state from LIVE disk on every read — destroys last-known-good hash evidence | artifacts.ts:392; artifact-file:33-50 | LIVE / Medium |
| T-9 | C | Submission validator classifies "factory-managed" by MUTABLE task metadata (process_module_ref) while sibling gate uses workplace aggregate; metadata freely writable via task_update/Bash | dispatcher:1887-1915,2063-2074; tasks.ts:849-859 | MED / Med-High |
| T-11 | B | project_delete guard misses 'paused' (claimable everywhere else) AND never inspects worker_executions — live plain-dispatch workers deletable under | projects.ts:266-278 | LIVE / Med-High |
| T-12 | B | Three trace/evidence writers bypass the predicates trace_add enforces (import lands verified_by with no evidence + ghost execution_ids; planner/verifier traces never enter managed ledger → ledger consumers blind) | lifecycle.ts:91-95; tasks.ts:553-558; export-import:467-491 | LIVE / Medium |
| T-13 | E | Verification loop-escape counts only outcome='failed' — perpetual unknown/error verdicts ping-pong forever, never trip the escape | dispatcher:689-710 | LIVE / Medium |
| T-14 | B | worker_ask_done: no assignment/fence/project/worker-identity check (CAS only) — any worker answers ANY task's human request | dispatcher:1190-1293 | LIVE / Medium |
| T-16 | C | "Frozen" baseline view reconstructed from LIVE rows; post-freeze mutation collapses to misattributed gap reason; reopen→retag→re-accept launders tag changes past T2.1A | srs-contract-validator:273-286,460-464,506-518 | LIVE / Medium |
| T-17 | A | artifact_update never re-publishes the desk artifact-ref product → desk holds H1 while ledger says H2 (repair rounds) | artifacts.ts:370-377 vs :471-602 | LIVE / Medium |
| T-20 | C | Operator/unprovenanced writes mutate artifacts with ZERO ledger rows; ledger-verifying consumers then break; shared-DB operator access is the documented ops model | managed-production-ledger:196-197 | LIVE / Medium |
| T-4 | B | code mutation can create (epic,type,code) duplicates → upsert .get() picks arbitrary row; three identity predicates for one boundary | artifacts.ts:493-494,301-303; capsule-replay-executor:470-494 | LIVE / Medium |
| T-verified | — | Stage-11 trace_delete capture case verified FIXED (ledger append-only, deletions don't touch it); claim/auto-block dependency predicates consistent; capsule hash chain consistent | — | — |

---

## Cross-layer synthesis — the stage-10 death, fully assembled

The run died of a conspiracy, not a single bug: the sealed-snapshot rowid kill
(stage-11, FIXED) was the trigger; the fatal widening (O-D/G-frames) made it
run-terminal; the B-004 three-path livelock (W-1/2/3 + O-D6) then spun the
factory in no-reason re-dispatch; the blind journal (fixed in TASK 5) hid all
of it; the dead loop detector (E-S1) and the terminal-piped engine (E-P1)
removed the remaining safety nets. Replay self-poisoning (R-A4) and sibling-
merge continuation death (X-6) are the same story waiting for Development's
parallel desks — the stage stage-10 never reached.

## Repair queue (proposal — red test first, one commit per class)

> **CAMPAIGN STATUS (live tracker — update on every merge):**
> - Queue 1 B-004 cluster → **MERGED `ccd862a0`** (RED/GREEN independently verified).
> - Queue 2 E-S1 loop detector → branch `repair/es1-loop-detector` @ `9e38679d` reviewed
>   (shim-side `--format json` translation; 334/334; live e2e) — **MERGE HELD until the
>   live run is terminal** (the shim spawns per worker: merging mid-run changes live behavior).
> - Queue 3 E-P1/A6 spawn+brake → **MERGED `ad202db6`**.
> - Queue 4a X-6/9/5 integration substrate → branch in progress (`repair/x65-integration`).
> - Queue 4b C-1/4/5 route freeze → branch in progress (`repair/c145-route-freeze`).
> - Queue 4c R-sweep + S-tools → branch in progress (`repair/rs-replay-robustness`).
> Merges land on saga4 after independent review (diff audit + RED reproduction +
> independent suite counts); dist rebuild deferred to the run-terminal boundary.

1. **W-1/2/3 + O-D6** — the B-004 cluster: one predicate for effects-settled;
   C8 recovery must not write unrecoverable rows; carry-forward presentations
   must be replay-certifiable; defer loops need a valve (reason-identity cap
   per §15).
2. **E-S1** — revive the loop detector on opencode (shim emits parseable
   markers or detector learns ANSI) — protects the LIVE run's token budget.
3. **E-P1/A6** — factory.mjs detached + SAGA_ENGINE_LOG + controls stamp;
   brake reads launch rows too. (B-002+A-6.)
4. **X-6/X-9/X-5** — integration substrate: repair path for drift branches;
   restore sealed branch on replay failure; classify transient-vs-conflict.
5. **C-1/C-4/C-5** — freeze the endpoint; enforce frozen limits; guard reads
   the engine's actual backend.
6. **R-A4/B3/D2/D4/D6** — replay robustness: seal-time selector snapshot vs
   live read; NULL-hash strict; sweep counts + cfa-independent fallback;
   reset invalidates capsules; replay debris cleanup.
7. **O-D1** — wire the typed scoped path for contract-shape violations.
8. **S-3/S-6** — repair the repair tools (FKs on, epoch baseline reset).

## Слепота по слоям (blindsight census, 2026-08-19 18:00)

**Системный паттерн подтверждён на persistence-слое:** фабрика последовательно
ЗАПИСЫВАЕТ правильную информацию и последовательно НЕ ЧИТАЕТ её в точке решения.

### Worker/Tool слой (3 HIGH):
1. worker_done принимает repeat-minimal-work без сравнения с историей
2. Review-фидбек не доставляется громко (нет ⚠️ блока, depth=1)
3. Spawn не видит истории смертей карточки (last_error не читается)

### Persistence слой (2 HIGH + 1 MED-HIGH):
F1. factory_effect_attempts — детектор существует, reader=0 вызовов
F2. factory_external_effect_events — только MAX(sequence)
F3. recovery_epochs.last_diagnosis — пишется, не читается
F4. capsule_invalidations — 6 причин → boolean EXISTS
F5. command_receipts — ноль ретроспективы
F6. drift_state — история уничтожается при записи
F9. Мёртвые таблицы: lifecycle_events, episode_workflows

### Правильный паттерн (уже дважды в коде):
- finding-trajectory chain (влит вчера) = «читай историю в точке решения»
- readParentDefectEvidence = тот же паттерн для continuation
Оба — F1-F4 это те же паттерны без последнего вызова.

### Authority/Gate слой (8/8 подтверждены):
C1. Check providers — candidateSnapshot ВСЕГДА {} — не видят историю (HIGH)
C1a. Автор на ремонте — только latest findings, нет trajectory label (HIGH)
C2. Acceptance commit — не видит истории отказов; plan-swap laundering (MED-HIGH)
C3. Carry-forward — eligible_failure_code выброшен на границе (MED-HIGH)
C4. Effect retry — readEffectAttempts мёртвый код (MED)
C5. Head writer — UPSERT уничтожает историю (MED)
C6. Ревьюер — не видит отвергнутых кандидатов, раунд, прошлые вердикты (HIGH)
C7. AC верификаторы — изолированы по дизайну, не видят друг друга (MED-HIGH)
C8. Freeze kernel — не сверяет содержимое ветки с planned scopes (MED)

### Четыре формы слепоты:
1. Мёртвый код доставки (readEffectAttempts=0, candidateSnapshot={})
2. Поле выброшено на границе (eligible_failure_code)
3. История уничтожена (head UPSERT)
4. Сравнение отключено (reviewer findings excluded from trajectory)

### Дешевейший системный фикс:
route finding-trajectory tail в 3 существующие точки:
(a) provider parameters в gate-run-driver
(b) recovery-feedback sheet
(c) acceptance commit proof

### Lifecycle слой:
F1. Ревьюер-2 не видит историю ревью-раундов (HIGH)
F2. Автор видит только latest rejection; chain не доставляется (HIGH)
   → «Слепота ПРОИЗВОДИТ budget burn»: регресс починенного = churning = не прощается
F3. Obligation redrive игнорирует lastError (MED)
F4. Anti-cycle budget обнуляется на resume (MED)
F5. Resume не видит failed NodeRuns между checkpoint и crash (MED)
F6. Epoch last_diagnosis write-only (LOW)
F7. Burial abandon без причины (LOW/MED)

### Cross-Layer (финальный):
X1. Planner не видит SRS-текст — только hash/ref; engine читает SRS, планировщик нет (HIGH)
X2. Sills обещают phantom-поля (6 скиллов, 0 реализаций) — RECOVERY:, attempt_history (HIGH)
X3. Settlement видит только binary passed; failed AC не доходит как evidence (MED-HIGH)
X4. Certifier не видит verifier findings в continuation (MED)
X5. Operator не видит finding-SEQUENCE — только repairs count + last verdict (LOW-MED)
X6. Journal содержит reasoning (invariant.classification) который нигде больше не живёт (MED)

### ИТОГО: ~11 HIGH / ~9 MED-HIGH / ~17 MED / мёртвые данные / фиктивные контракты

### Три уровня системной проблемы:
1. Данные есть → доставка отсутствует (~30 находок)
2. Документация обещает → код не реализует (6 скиллов, 0 строк)
3. История уничтожается → append не соблюдается (UPSERT/overwrite/reset)

### Дешевейший системный фикс (паттерн уже в коде):
route finding-trajectory tail в 3 существующие точки чтения.
Правильный образец: replanContext (buildReplanCase) — «дай LM весь контекст».
