# Декомпозиция плана v2 для параллельных субагентов

**План-источник:** `D:/Разработка/saga-mcp/docs/plans/SAGA-V2-PRODUCTION-READINESS.md`
**Цель:** раскидать Phase B рефакторинга на 6 независимых субагентов, работающих параллельно без git-конфликтов.
**Дата:** 2026-07-20
**Precondition:** Phase A (Cannon v2 baseline на ADR-014) завершена, baseline записан.

---

## §1. Общий контракт (ВСЕ субагенты обязаны соблюдать)

### 1.1. Целевые принципы v2

1. **Качество исполнения** — saga-worker запускает build/typecheck/lint перед `worker_done` (Дыра A)
2. **Автономия** — circuit breaker на 5 failed + loop detector S1/S2 + zombie detection (Дыры D, E, F)
3. **Полнота** — saga-arbiter для unverifiable AC + SRS §10/§11/§12 (Дыра G, ГОСТ)

### 1.2. Новый lifecycle с Circuit Breaker

```
worker spawned → reads task.metadata.{attempt_history, hint}
  → works → writes evidence + recovery_summary
    ├─ passed → done
    ├─ failed → appends to attempt_history[]
    │   ├─ n < 3 → recovery → fresh worker (читает историю)
    │   ├─ n = 3 + edit_count=0 → tag needs-specialist → route to domain skill
    │   ├─ n = 5 → tag needs-human → saga halts
    │   └─ loop detected (S1/S2) → terminate + increment loop_recoveries
    └─ unknown → saga-arbiter decides: accept-with-caveat | retry | escalate
```

### 1.3. Build-gate контракт

SRS §9 теперь содержит **runnable commands**:
```yaml
type_checker: tsc --noEmit
build_tool: npm run build
test_framework: npm test
linter: npx eslint .
```

`saga-worker` SKILL читает §9, запускает ВСЕ 4 команды, вставляет вывод в `worker_done.result`.

### 1.4. Verifier read_only enforcement

`tracker-view/claude-runner.mjs` для `execution_mode='read_only_evidence'` добавляет `--disallowedTools Edit,Write`. Verifier НЕ правит код (устраняет Дыру E++).

### 1.5. saga-arbiter MCDA + Subjective Logic

5 критериев: correctness 0.30, blast-radius 0.25, reversibility 0.20, audit-clarity 0.15, no-data-loss 0.10
4 опции: accept / accept-with-caveat / retry / escalate-to-human
Решение принимается если `belief - disbelief > 0.3 AND uncertainty <= 0.5`.

---

## §2. Карта работы — 6 независимых потоков

| Поток | Имя | Владение файлами | Зависит от |
|---|---|---|---|
| **A** | CORE-LOOP | `src/orchestrate.ts`, `src/lifecycle/atomic-release.ts`, `src/worker-executions.ts`, `src/tools/dispatcher.ts`, `src/tools/tasks.ts` | только от §1 |
| **B** | CORE-BUILD | `tracker-view/claude-runner.mjs`, `src/validators/brief.ts`, `docs/requirements/templates/.gitignore.template` (NEW), `tools/cgad-spec-lint.mjs` (R19 new rule) | от §1 |
| **C** | WORKER-VERIFIER | `skills/saga-worker/SKILL.md`, `skills/saga-verifier/SKILL.md`, `skills/saga-planner/SKILL.md` | от §1 |
| **D** | ARBITER+SPECIALISTS | **NEW** `skills/saga-arbiter/SKILL.md`, **NEW** `skills/saga-perf-tuner/SKILL.md`, **NEW** `skills/saga-type-fixer/SKILL.md`, `skills/autonomous-recovery/SKILL.md`, `src/tools/workflow.ts` (new transition) | от §1 |
| **E** | SRS-EXT+TEMPLATES | `docs/requirements/templates/SRS.md` (+§10/§11/§12), `skills/saga-architect/SKILL.md`, `skills/saga-architecture-reviewer/SKILL.md`, `src/tools/lifecycle.ts` (gate) | от §1 |
| **F** | TESTS+DOCS | `tests/lifecycle/circuit-breaker.test.mjs` (NEW), `tests/lifecycle/attempt-history.test.mjs` (NEW), `tests/loop-detector.test.mjs` (NEW), `tests/arbiter-decision.test.mjs` (NEW), `README.md`, `README.ru.md`, `docs/architecture/decisions/015-saga-v2-production-readiness.md` (NEW), `CHANGELOG.md` | **от A+B** |

### 2.1. Граф зависимостей

```
       ┌─────────────────────────────────────────────┐
       │     §1 Общий контракт (читают все 6)         │
       └──┬──────────┬──────────┬──────────┬─────────┘
          │          │          │          │
   ┌──────▼──┐ ┌─────▼────┐ ┌──▼─────┐ ┌──▼──────┐
   │A: LOOP  │ │B: BUILD  │ │C:WORKER│ │D:ARBITER│   ← параллельно (5)
   │orchestr │ │claude-rn │ │+verify │ │+specials│
   └────┬────┘ └────┬─────┘ └──┬─────┘ └────┬────┘
        │           │          │            │
        └─────┬─────┴──────────┴────────────┘
              │                                  ┌─────────────┐
        ┌─────▼─────┐                            │E: SRS+TPL   │ ← параллельно
        │F: TESTS   │ ← после A+B                │architect    │
        │+DOCS      │                            └─────────────┘
        └───────────┘
```

**Параллельные:** A, B, C, D, E стартуют одновременно.
**Зависимый:** F стартует после A+B (тесты проверяют их контракты).

---

## §3. Спецификации заданий для каждого субагента

### Поток A — CORE-LOOP (zombie + circuit breaker + attempt history + hint)

**Файлы:**
- `src/orchestrate.ts` (pump-loop)
- `src/lifecycle/atomic-release.ts`
- `src/worker-executions.ts`
- `src/tools/dispatcher.ts`
- `src/tools/tasks.ts`

**Задача:**

#### 1. Zombie detection в pump-loop
В `src/orchestrate.ts` рядом с `ZOMBIE_CHECK_TICKS` (или аналогичным tick-счётчиком), добавить для каждого `execution.state='running'`:
```typescript
if (!isProcessAlive(execution.pid)) {
  releaseExecutionAtomically(db, {
    executionId: execution.execution_id,
    terminalState: 'terminated',
    reason: 'process_dead',
    lastError: `Process ${execution.pid} is dead but state='running'`,
  });
}
```
Импортировать `isProcessAlive` из `src/worker-executions.ts` (уже экспортируется, используется в tracker-view).

#### 2. Attempt history при failed outcome
В `src/lifecycle/atomic-release.ts` функция `releaseExecutionAtomically`, при failed outcome дописывать в `task.metadata.attempt_history`:
```typescript
const attempts = JSON.parse(task.metadata?.attempt_history || '[]');
attempts.push({
  attempt_number: attempts.length + 1,
  worker_id: execution.worker_id,
  outcome: 'failed',
  recovery_summary: evidence.recovery_summary || '(no summary)',
  model: execution.metadata?.model || '(unknown)',
  context_peak: execution.metadata?.context_peak || null,
  edit_count: execution.metadata?.edit_count || 0,
  failed_at: new Date().toISOString(),
  evidence_id: evidence.id,
});
updateTaskMetadata(task.id, { attempt_history: JSON.stringify(attempts) });
```

#### 3. Circuit breaker handler
В `src/orchestrate.ts` после `releaseExecutionAtomically`:
```typescript
function onFailed(task, evidence) {
  const attempts = JSON.parse(task.metadata?.attempt_history || '[]');
  const n = attempts.length;
  const last = attempts[attempts.length - 1];
  
  if (n >= 5) {
    addTag(task.id, 'needs-human');
    haltEpisode(task.epic_id, 'circuit_breaker_5_failed');
  } else if (n >= 3 && last?.edit_count === 0) {
    addTag(task.id, 'needs-specialist');
    // dispatcher будет фильтровать по role:<specialist>
  }
}
```

#### 4. Hint channel
В `src/tools/tasks.ts` `task_update`: типизированное поле `metadata.hint` (string, optional). Не затирается при planner updates (explicit preserve в update handler).

#### 5. Dispatcher specialist routing
В `src/tools/dispatcher.ts` `claimTask`: при tag `needs-specialist` фильтровать очередь по `role:<specialist>` (если такой worker запущен с этой role).

**Запрет:** НЕ трогать tracker-view/* (поток B), skills/* (потоки C, D, E), tests/* (поток F).

**Проверка:** `npm run build` чистый. `npm test` — старые тесты зелёные.

---

### Поток B — CORE-BUILD (verifier enforce + loop detector + brief extension + gitignore template)

**Файлы:**
- `tracker-view/claude-runner.mjs`
- `src/validators/brief.ts`
- `docs/requirements/templates/.gitignore.template` (NEW)
- `tools/cgad-spec-lint.mjs` (R19 new rule)

**Задача:**

#### 1. Read_only enforcement
В `tracker-view/claude-runner.mjs` функции spawn: при `execution.execution_mode === 'read_only_evidence'` добавить к spawn args:
```
--disallowedTools Edit,Write,MultiEdit
```
Это не даст verifier'у править код. Подтверждает Дыру E++ закрытой.

#### 2. Loop detector (S1/S2)
В `tracker-view/claude-runner.mjs` над `child.stdout` поставить `Transform`:
```javascript
import { Transform } from 'stream';

const jsonlTee = new Transform({
  transform(chunk, encoding, callback) {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      this.push(line + '\n');  // pass-through to log
      try {
        const evt = JSON.parse(line);
        loopDetector.onLine(evt);
      } catch {}
    }
    callback();
  }
});

child.stdout.pipe(jsonlTee);
jsonlTee.pipe(log, { end: false });
```

#### 3. LoopDetector class
```javascript
const LOOP_THRESHOLD = 5;
const CIRCUIT_BREAKER_LIMIT = 3;

function createLoopDetector() {
  return {
    consecutiveIdenticalCalls: 0,
    lastCallHash: null,
    consecutiveErrorResults: 0,
    lastErrorHash: null,
    loopRecoveryInProgress: false,
  };
}

function onLine(execution, evt) {
  if (evt.type === 'assistant') {
    for (const block of evt.message?.content || []) {
      if (block.type !== 'tool_use') continue;
      const hash = sha256(block.name + '|' + canonicalize(block.input));
      if (hash === execution.loopDetector.lastCallHash) {
        execution.loopDetector.consecutiveIdenticalCalls += 1;
      } else {
        execution.loopDetector.consecutiveIdenticalCalls = 1;
        execution.loopDetector.lastCallHash = hash;
      }
      checkAndRecover(execution, 'identical_tool_use');
    }
  } else if (evt.type === 'user') {
    for (const block of evt.message?.content || []) {
      if (block.type !== 'tool_result') continue;
      if (isToolUseError(block)) {
        const errHash = sha256(extractErrorText(block));
        if (errHash === execution.loopDetector.lastErrorHash) {
          execution.loopDetector.consecutiveErrorResults += 1;
        } else {
          execution.loopDetector.consecutiveErrorResults = 1;
          execution.loopDetector.lastErrorHash = errHash;
        }
        checkAndRecover(execution, 'repeated_tool_error');
      }
    }
  }
}

function checkAndRecover(execution, reason) {
  const trips = execution.loopDetector.consecutiveIdenticalCalls >= LOOP_THRESHOLD
             || execution.loopDetector.consecutiveErrorResults >= LOOP_THRESHOLD;
  if (trips && !execution.loopDetector.loopRecoveryInProgress) {
    execution.loopDetector.loopRecoveryInProgress = true;
    recoverFromLoop(execution, reason);
  }
}
```

#### 4. recoverFromLoop
```javascript
async function recoverFromLoop(execution, reason) {
  // 1. Heartbeat
  this.heartbeat(execution, 'LOOP_DETECTED', `reason=${reason} ...`);
  // 2. Kill child
  try { execution.child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (isProcessAlive(execution.child.pid)) {
      try { execution.child.kill('SIGKILL'); } catch {}
    }
  }, 2000);
  // 3. Release
  await this.recoverAssignment({
    executionId: execution.execution_id,
    terminalState: 'terminated',
    reason: `loop detected: ${reason}`,
  });
  // 4. Increment loop_recoveries
  const recoveries = (task.metadata?.loop_recoveries || 0) + 1;
  updateTaskMetadata(task.id, { loop_recoveries: recoveries });
  if (recoveries >= CIRCUIT_BREAKER_LIMIT) {
    addTag(task.id, 'needs-human');
  }
}
```

#### 5. Brief extension
В `src/validators/brief.ts` `BriefPayload` добавить опциональное поле:
```typescript
model_hint?: {
  dev?: string;        // e.g. 'qwen3.6-35b-a3b@q4_k_xl'
  verification?: string; // e.g. 'gemma-4-12b@q8'
};
```

#### 6. .gitignore template
`docs/requirements/templates/.gitignore.template`:
```
# Build artifacts
dist/
build/
.next/
.nuxt/

# Dependencies
node_modules/

# Saga worktrees
.worktrees/

# Test/coverage
coverage/
playwright-report/
test-results/
.nyc_output/

# Scratch files (saga-worker scratch)
_*
*.scratch
_calc*
_tmp*

# Env
.env
.env.local

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
```

#### 7. CGAD R19 — path drift detection
В `tools/cgad-spec-lint.mjs` новое правило R19: для каждого `file_path` в SRS §D1 — проверить, что файл существует в репо после scaffold. Если нет — finding "R19: SRS §D1 file_path X не существует в репо (path drift)".

**Запрет:** НЕ трогать src/orchestrate.ts, atomic-release.ts, worker-executions.ts (поток A), skills/* (C, D, E), tests/* (F).

**Проверка:** `node --check tracker-view/claude-runner.mjs`. `npm run build`.

---

### Поток C — WORKER+VERIFIER (build-gate + recovery_summary + planner model_hint + domain tagging)

**Файлы:**
- `skills/saga-worker/SKILL.md`
- `skills/saga-verifier/SKILL.md`
- `skills/saga-planner/SKILL.md`

**Задача:**

#### 1. saga-worker: build-gate (Дыра A)
Найти строку ~165 "run the project's tests/lint here". Заменить на:
```markdown
## Step N: Prove the project still builds (MANDATORY before worker_done)

Read SRS §9 stack declaration. The architect declared runnable commands
(type_checker, build_tool, test_framework, linter). Run ALL of them:

```bash
# Example for TypeScript projects (substitute from SRS §9):
npx tsc --noEmit           # type_checker — MUST exit 0
npm test                   # test_framework — MUST be green
npm run build              # build_tool — MUST succeed
npx eslint .               # linter — MUST be clean
```

Each command MUST exit 0. If any fails, you have not finished the task —
debug and fix, then re-run. Paste actual output of each command into the
`result` field of worker_done.
```

#### 2. saga-verifier: recovery_summary (Дыра F)
Добавить обязательный шаг перед `verification_record`:
```markdown
## Step N: Write recovery_summary (REQUIRED when outcome=failed or unknown)

Before calling verification_record, you MUST write a 1-2 sentence
diagnosis of WHY the verification failed. Use comment_add with prefix
`RECOVERY:`. This becomes part of `task.metadata.attempt_history` so the
next worker (or saga-arbiter, or human) understands what was tried.

Format:
- RECOVERY: Lighthouse=78, blocker: vendor-three.js 612KB synchronous в entry chunk
- RECOVERY: tsc errors=36, top offenders: orbital.ts(9), renderer.ts(6)
- RECOVERY: AC unverifiable in headless env (no GPU, Lighthouse can't run)

If you cannot diagnose → write "RECOVERY: (unable to diagnose, evidence=N)".
```

#### 3. saga-planner: read §9 + model_hint + domain tagging
```markdown
## Step X: Read SRS §9 (NEW)

Before creating dev tasks, read SRS §9 stack declaration. For each dev task,
populate `metadata.pipeline`:
```yaml
metadata:
  pipeline:
    type_checker: tsc --noEmit
    build_tool: npm run build
    test_framework: npm test
    linter: npx eslint .
```

Also populate `metadata.model_hint`:
- dev/code tasks: same model as brief (default)
- verification tasks: faster model if available (e.g. gemma-4-12b@q8)

## Step Y: Domain tagging (NEW)

Keyword-analyze each AC title/body. Add `domain:<name>` tag:
- `lighthouse|performance|bundle|fps` → `domain:perf`
- `cross-browser|safari|firefox|edge|playwright` → `domain:browser`
- `tsc|typescript|type-error` → `domain:types`
- `wcag|aria|accessibility|a11y` → `domain:a11y`
- `security|cve|snyk|semgrep` → `domain:security`

These tags enable specialist routing when saga-worker fails 3+ times
(see circuit breaker in saga-core).
```

**Запрет:** НЕ трогать src/* (потоки A, B), skills/saga-arbiter/perf-tuner/type-fixer (поток D), skills/saga-architect/architecture-reviewer (поток E), tests/* (поток F), templates/* (поток E).

**Проверка:** Мысленно прогнать: saga-worker на AC-1 — запускает tsc, build, test, lint перед done?

---

### Поток D — ARBITER+SPECIALISTS (new skills + recovery integration + new transition)

**Файлы:**
- **NEW** `skills/saga-arbiter/SKILL.md`
- **NEW** `skills/saga-perf-tuner/SKILL.md`
- **NEW** `skills/saga-type-fixer/SKILL.md`
- `skills/autonomous-recovery/SKILL.md`
- `src/tools/workflow.ts` (NEW transition `arbiter_decided`)

**Задача:**

#### 1. saga-arbiter SKILL (NEW, ~500 строк)
Прочитать `docs/research/autonomous-decision-unverifiable-acs.md` §6 — там готовый дизайн.

Структура SKILL:
- Frontmatter: `description: "Arbiter for unverifiable ACs. Decides accept/accept-with-caveat/retry/escalate via MCDA + Subjective Logic. Runs when evidence.outcome='unknown'."`
- Preconditions: spawn'ится saga-core при verification_evidence.outcome='unknown'
- Step 1: Read unknown evidence + AC contract
- Step 2: Classify unverifiable AC type (U1-U8 из §1 taxonomy)
- Step 3: Collect partial signals (static analysis, mock tests, code inspection)
- Step 4: MCDA scoring (5 criteria × 4 options)
- Step 5: Subjective Logic opinion computation
- Step 6: Decision:
  - If `belief - disbelief > 0.3 AND uncertainty <= 0.5` → accept-with-caveat
  - If `uncertainty > 0.7` → retry once
  - If `disbelief > belief` → escalate to human
- Step 7: Write `decision` artifact + update evidence.outcome='passed' with metadata.decided_by='arbiter'
- Registering artifacts: `artifact_create(type='decision', parent_artifact_id=<AC_id>)`, `trace_add(decision → AC, 'verified_by')`

#### 2. saga-perf-tuner SKILL (NEW, ~400 строк)
Diagnosis skill для domain:perf. НЕ правит код сам — генерирует hint для dev-воркера.

Структура:
- Triggers: tag `needs-specialist + domain:perf`
- Step 1: Run bundle analysis (`npm run build`, `du -sh dist/assets/*`)
- Step 2: Identify top offenders (vendor chunks, sync imports)
- Step 3: Generate diagnosis: "Lighthouse=78, blocker: three.js 612KB sync в entry chunk. Fix: dynamic import + code-split"
- Step 4: Write to `task.metadata.hint` (НЕ Edit/Write в код!)
- Step 5: Remove tag `needs-specialist`, задача возвращается в очередь

#### 3. saga-type-fixer SKILL (NEW, ~300 строк)
Diagnosis skill для domain:types.

Структура:
- Triggers: tag `needs-specialist + domain:types`
- Step 1: Run `tsc --noEmit`, parse diagnostics
- Step 2: Group by error code (TS6133 unused, TS2304 not found, etc.)
- Step 3: Generate plan: "36 TS errors. Top: orbital.ts (9, TS6133 unused imports). Fix: remove imports X, Y, Z"
- Step 4: Write to `task.metadata.hint`

#### 4. autonomous-recovery integration
В `skills/autonomous-recovery/SKILL.md` DIAGNOSE phase: если verification gate failed с outcome=unknown → spawn `formalization.arbiter` task (а НЕ needs-human сразу).

#### 5. New workflow transition
В `src/tools/workflow.ts` добавить transition `arbiter_decided`:
```typescript
if (transition === 'arbiter_decided') {
  if (source.task_kind !== 'formalization.arbiter') {
    throw new Error(`Transition arbiter_decided requires task_kind=formalization.arbiter, got '${source.task_kind}'`);
  }
  // Arbiter обновил evidence outcome='passed' внутри своей задачи.
  // Возвращаем nothing — episode продолжит с verification→integration.
  return [];
}
```

Также в `generateNextForCompletedTask` switch:
```typescript
: task.task_kind === 'formalization.arbiter' ? 'arbiter_decided'
```

И в `inputSchema.transition` enum.

**Запрет:** НЕ трогать src/orchestrate.ts, atomic-release.ts (поток A), tracker-view/* (поток B), skills/saga-worker/verifier/planner (поток C), skills/saga-architect/reviewer (поток E), tests/* (поток F).

**Проверка:** saga-arbiter принимает MCDA решение для unverifiable AC? saga-perf-tuner генерирует hint БЕЗ правки кода?

---

### Поток E — SRS EXTENSION + TEMPLATES (ГОСТ compliance)

**Файлы:**
- `docs/requirements/templates/SRS.md` (+§10/§11/§12)
- `skills/saga-architect/SKILL.md`
- `skills/saga-architecture-reviewer/SKILL.md`
- `src/tools/lifecycle.ts` (gate)

**Задача:**

#### 1. SRS template §10/§11/§12
Прочитать `docs/research/saga-vs-gost-34-602-and-iso-12207.md` §7.1.

Добавить в `docs/requirements/templates/SRS.md`:

**§10. Supporting Systems (REQUIRED для L/XL, optional для S/M)**
8 видов обеспечения ГОСТ 34.602:
1. Информационное (БД, схемы, migrations)
2. Программное (frameworks, libraries)
3. Техническое (deployment target, hardware)
4. Лингвистическое (i18n, terminology)
5. Организационное (CI/CD pipeline, release process)
6. Методическое (docs, runbooks)
7. Правовое (licenses, compliance)
8. Эргономическое (UX guidelines, accessibility)

Каждое — либо описание, либо `n/a` с обоснованием.

**§11. External Integration Landscape (REQUIRED при наличии external integrations)**
- REST/GraphQL/gRPC endpoints (URL, auth, rate limits)
- Webhook URLs (incoming/outgoing)
- OAuth scopes
- SLA expectations

**§12. Decision Log (REQUIRED всегда, min 3 записи)**
Living document. Каждый ключевой выбор:
- `D-001`: Framework — selected React, alternatives: Vue, Svelte. Reason: team expertise.
- `D-002`: Deployment — Vercel, alternatives: Netlify, self-host. Reason: zero-config.
- `D-003`: State management — Zustand, alternatives: Redux, Context. Reason: minimal boilerplate.

#### 2. saga-architect SKILL: runnable §9 + §12 enforcement
- §9 MUST содержать runnable commands (не названия):
  ```yaml
  type_checker: tsc --noEmit      # NOT: "tsc"
  build_tool: npm run build        # NOT: "npm"
  ```
- §12 Decision Log: архитектор ОБЯЗАН создать минимум 3 decision-артефакта

#### 3. saga-architecture-reviewer: check §10/§11/§12
- Для L/XL: проверить наличие всех 3 секций
- Для S/M: только §12 обязательно (min 3 decisions)
- REJECT если §9 содержит абстрактные имена вместо команд

#### 4. lifecycle.ts: gate
В `src/tools/lifecycle.ts` `handleEpisodeTransition` formalization→planning:
- Для L/XL: требовать §10/§11/§12 в SRS
- Для S/M: только §12 с min 3 decision артефактами

**Запрет:** НЕ трогать skills/saga-arbiter/perf-tuner/type-fixer (поток D), skills/saga-worker/verifier/planner (поток C), src/orchestrate.ts (поток A), tracker-view/* (поток B), tests/* (поток F).

**Проверка:** SRS template содержит §10/§11/§12? saga-architect SKILL требует runnable §9 + 3 decisions?

---

### Поток F — TESTS + DOCS (after A+B)

**Файлы:**
- `tests/lifecycle/circuit-breaker.test.mjs` (NEW)
- `tests/lifecycle/attempt-history.test.mjs` (NEW)
- `tests/loop-detector.test.mjs` (NEW)
- `tests/arbiter-decision.test.mjs` (NEW)
- `tests/lifecycle/formalization-mechanics.test.mjs` (update — §10/§11/§12 gate)
- `tests/product-workflow.test.mjs` (update — decision log)
- `README.md`, `README.ru.md`
- `docs/architecture/decisions/015-saga-v2-production-readiness.md` (NEW)
- `CHANGELOG.md`

**Зависимость:** СТАРТУЕТ ПОСЛЕ ЗАВЕРШЕНИЯ ПОТОКОВ A+B.

**Задача:**

#### 1. circuit-breaker.test.mjs
- Test: 5 failed outcomes → tag `needs-human` + episode halted
- Test: 3 failed + edit_count=0 → tag `needs-specialist`
- Test: 3 failed + edit_count=5 → no `needs-specialist` (worker tried)
- Test: 4 failed → recovery continues, no halt

#### 2. attempt-history.test.mjs
- Test: failed outcome → appends to attempt_history
- Test: fresh worker claim reads attempt_history (visible in task_get)
- Test: recovery_summary parsed from comment_add prefix `RECOVERY:`

#### 3. loop-detector.test.mjs
- Test: JSONL stream с 5 identical tool_use → recoverFromLoop called
- Test: JSONL с 4 identical + 1 different → NOT called (counter reset)
- Test: JSONL с 5 identical tool_result errors → called
- Test: loopRecoveryInProgress flag prevents double-recovery

#### 4. arbiter-decision.test.mjs
- Test: evidence outcome=unknown → saga-arbiter task spawned
- Test: arbiter with high belief + low uncertainty → accept-with-caveat → outcome='passed'
- Test: arbiter with high uncertainty → retry
- Test: arbiter with disbelief > belief → escalate to human

#### 5. Update formalization-mechanics + product-workflow
- formalization-mechanics: для L/XL эпизодов formalization→planning требует §10/§11/§12
- product-workflow: min 3 decision artifacts required

#### 6. README + ADR-015
- README: обновить диаграмму с arbiter + specialists + circuit breaker
- ADR-015: обоснование всех 7 изменений (ссылки на 7 research-документов)

#### 7. CHANGELOG
Entry для v2: 7 изменений, ~3600 LoC, 28 файлов.

**Запрет:** НЕ трогать skills/* (потоки C, D, E), src/* (только читает).

**Проверка:** `npm test` — все зелёные.

---

## §4. План запуска и каскадной проверки

### Фаза 1 — Параллельный запуск (одновременно)

5 субагентов одновременно: A, B, C, D, E.

### Фаза 2 — Зависимый запуск (после A+B)

1 субагент: F (TESTS + DOCS).

### Фаза 3 — Каскадная проверка

#### 3.1 TypeScript + tests
- `npm run build` чистый
- `npm test` все зелёные

#### 3.2 Кросс-потоковая целостность (7 проверок)
- [ ] **3.2.1.** `isProcessAlive` (поток A) корректно импортирован из `worker-executions.ts`
- [ ] **3.2.2.** `attempt_history` (поток A) парсится из `RECOVERY:` comments (поток C verifier пишет)
- [ ] **3.2.3.** `needs-specialist` tag (поток A) маршрутизируется dispatcher'ом к domain skills (поток D)
- [ ] **3.2.4.** Loop detector (поток B) корректно вызывает `recoverAssignment` (использует releaseExecutionAtomically из потока A)
- [ ] **3.2.5.** `saga-arbiter` (поток D) корректно читает evidence (table `verification_evidence`) и пишет decision artifacts
- [ ] **3.2.6.** SRS §9 runnable commands (поток E) совместимы с saga-worker build-gate (поток C)
- [ ] **3.2.7.** formalization gate (поток E) проверяет §10/§11/§12 через lifecycle.ts (тот же файл)

#### 3.3 Smoke-test через saga
- [ ] Создать новый S-size эпизод
- [ ] Проверить: saga-worker запускает tsc/build/test перед done
- [ ] Проверить: при 3 failed → needs-specialist tag
- [ ] Проверить: при unverifiable AC → saga-arbiter spawn'ится
- [ ] Проверить: loop detector срабатывает на synthetic 5 identical calls

---

## §5. Шаблон промпта для каждого субагента

```
Ты — субагент в параллельной команде, выполняющей saga-mcp v2 (Production Readiness).

## Обязательное чтение перед стартом
1. ОБЩИЙ КОНТРАКТ: docs/plans/SAGA-V2-SUBAGENTS.md §1
2. ПОЛНЫЙ ПЛАН: docs/plans/SAGA-V2-PRODUCTION-READINESS.md
   особенно §2 (целевая архитектура), §4 (свой этап)
3. Источники (research): docs/research/audit-2026-07-20-cannon-1000-score.md
   и соответствующий дизайн-документ для твоего потока

## Твой поток: <ИМЯ_ПОТОКА>

## Файлы под твоим владением (ТОЛЬКО эти)
<список из §3>

## Запрещено трогать
<владения других потоков>

## Задача
<детальная спецификация из §3>

## По завершении
- Сообщи список изменённых файлов
- НЕ делай commit (оркестратор после каскадной проверки)
```

---

## §6. Чек-лист запуска

### Перед запуском
- [ ] Phase A (Cannon v2 baseline) завершена, baseline записан
- [ ] Ветка `saga-v2-production-readiness` создана
- [ ] `skills.backup.v2.YYYYMMDD/` создан
- [ ] `npm test` baseline снят

### Параллельный запуск (Фаза 1)
- [ ] Старт A (CORE-LOOP)
- [ ] Старт B (CORE-BUILD)
- [ ] Старт C (WORKER-VERIFIER)
- [ ] Старт D (ARBITER+SPECIALISTS)
- [ ] Старт E (SRS-EXT+TEMPLATES)

### После Фазы 1
- [ ] Все 5 потоков отчитались
- [ ] Файлы не пересекаются

### Зависимый запуск (Фаза 2)
- [ ] Старт F (TESTS+DOCS)

### Каскадная проверка (Фаза 3)
- [ ] 3.1 Build + tests
- [ ] 3.2 7 кросс-потоковых контрактов
- [ ] 3.3 Smoke-test через saga

### Финал
- [ ] Commit в ветку (НЕ master)
- [ ] Phase C: Cannon v3 run на v2
- [ ] Сравнение с baseline (661/1000)
- [ ] Merge в master если ≥800/1000
