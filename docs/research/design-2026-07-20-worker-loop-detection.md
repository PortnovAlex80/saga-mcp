# Design: Loop Detection для saga-mcp воркеров

**Дата:** 2026-07-20
**Тип:** Design document (без имплементации)
**Источник:** Subagent research + реальные логи task #22 (worker-4 loop на 106 Edit)
**Связанный отчёт:** `investigation-2026-07-20-cannon-development-stage.md` (Дыра E)

---

## 1. Problem Statement

Воркер saga (`claude -p` subprocess, spawn'nutый через `tracker-view/claude-runner.mjs`)
ревьюил task #22 и застрял в edit-loop'е на 40+ минут:
- Сделал **106 Edit tool_use** вызовов
- Каждый возвращал: `<tool_use_error>No changes to make: old_string and new_string are exactly the same.</tool_use_error>`
- Модель даже осознавала loop (thinking: "I keep making the exact same edit") — но не могла выйти
- **saga-core не заметила** — pump-loop в `orchestrate.ts` проверяет только SQL state
- Контекст дорос до 96k токенов, процесс убит вручную

Это **архитектурная дыра**, не модельный баг: spawner pipe'ит JSONL stream в файл,
но относится к нему как к write-only telemetry, не как к liveness signal. Claude Code
не имеет встроенного no-progress breaker'а — harness должен его предоставить.

---

## 2. Detection Signals — надёжность

5 кандидатов, ранжированы по signal-to-noise:

| # | Signal | Надёжность | FP риск |
|---|---|---|---|
| **S1** | Идентичный `(tool_name, canonical_input)` повторён ≥ N раз подряд | **Высокая** | Очень низкая — точный хэш-матч |
| **S2** | Тот же `<tool_use_error>` текст повторён ≥ N раз подряд | **Высокая** | Низкая — только на неудачных retries |
| S3 | Нет файловых мутаций за последние K tool_use (Edit "no changes", read-only Bash) | Средне-высокая | Средняя — валидно для verifier'ов |
| S4 | Throughput collapse: много вызовов, ноль файловых правок, за окно времени | Средняя | Средняя — дублирует S3 |
| S5 | Thinking содержит "I keep", "same", "stuck", "again" | Низкая | Высокая — обычные debug-слова |

**Рекомендуемый trip:** `(S1 OR S2) AND N ≥ 5`

### Почему N=5

- **N=3 слишком агрессивно.** Легитимные retry-then-succeed: Read → Read (resolved path) → Edit.
  Verifier'ы делают 2-3 идентичных `artifact_list` с разными фильтрами.
- **N=5 ловит реальные loop'ы рано.** Task #22 сделал 106 вызовов. На 5-м (обычно <60 сек)
  trip'нем. Промежуток 3..25 в индустрии (Aider=3, LangGraph=25, Cline=50).
- **Только consecutive matches.** Любой другой tool_use между ними сбрасывает счётчик.

### Почему exact-match (S1) не fuzzy

Наблюдаемый bug производит byte-identical inputs (модель фиксируется). Fuzzy даст
false positives на легитимных re-edit'ах того же файла с другим `new_string`.

---

## 3. Detection Algorithm

```python
execution.loopDetector = {
  consecutiveIdenticalCalls: 0,
  lastCallHash: null,
  consecutiveErrorResults: 0,
  lastErrorHash: null,
  totalCalls: 0,
  totalErrors: 0,
}

CONSTANT LOOP_THRESHOLD = 5
CONSTANT CIRCUIT_BREAKER_LIMIT = 3

function onStreamEvent(execution, evt):
  if evt.type == "assistant":
    for block in evt.message.content where block.type == "tool_use":
      execution.loopDetector.totalCalls += 1
      hash = sha256(block.name + "|" + canonicalize(block.input))
      if hash == execution.loopDetector.lastCallHash:
        execution.loopDetector.consecutiveIdenticalCalls += 1
      else:
        execution.loopDetector.consecutiveIdenticalCalls = 1
        execution.loopDetector.lastCallHash = hash
      checkAndRecover(execution, "identical_tool_use")

  elif evt.type == "user":
    for block in evt.message.content where block.type == "tool_result":
      if isToolUseError(block):  # match /<tool_use_error>/ in content
        execution.loopDetector.totalErrors += 1
        errHash = sha256(extractErrorText(block))
        if errHash == execution.loopDetector.lastErrorHash:
          execution.loopDetector.consecutiveErrorResults += 1
        else:
          execution.loopDetector.consecutiveErrorResults = 1
          execution.loopDetector.lastErrorHash = errHash
        checkAndRecover(execution, "repeated_tool_error")

function checkAndRecover(execution, reason):
  trips = (consecutiveIdenticalCalls >= LOOP_THRESHOLD)
       OR (consecutiveErrorResults >= LOOP_THRESHOLD)
  if trips AND NOT execution.loopRecoveryInProgress:
    execution.loopRecoveryInProgress = true
    recoverFromLoop(execution, reason)
```

**Ключевые инварианты:**
- Счётчик сбрасывается при *любом другом* вызове (легитимный прогресс)
- `loopRecoveryInProgress` флаг → не firing повторно во время teardown
- Только `tool_use` и `tool_result` двигают счётчики. `thinking`/`text`/`system` игнорируются

---

## 4. Implementation Location

### Решение: `tracker-view/claude-runner.mjs`, НЕ `orchestrate.ts`

**Почему claude-runner.mjs архитектурно чище:**

1. **Stream уже там.** `claude-runner.mjs:417-418` pipe'ит `child.stdout/stderr` в JSONL:
   ```js
   child.stdout?.pipe(log, { end: false });
   child.stderr?.pipe(log, { end: false });
   ```
   Заменяем raw pipe на `Transform`, который (a) пишет line в log без изменений и
   (b) передаёт parsed JSON в loop detector. Один process boundary, ноль IPC.

2. **Per-execution state локален.** `lastCallHash`, счётчики, `loopRecoveryInProgress` —
   всё scoped на один `execution` объект (`claude-runner.mjs:420-432`). Никаких DB writes
   на hot path, никакого cross-process координирования.

3. **Прямой доступ к child PID.** `execution.child` — прямо там (`claude-runner.mjs:426`).
   Recovery step 1 = `child.kill('SIGTERM')`, тривиально из runner'а.

4. **Симметрия с rate-limit detection.** Кодbase уже имеет precedent stream-content-based
   решений: `detectRateLimits` (`orchestrate.ts:1012`) tail'ит JSONL для
   `api_retry.*429.*rate_limit`. Тот scanner работает из engine, потому что ему нужен
   *глобальный* concurrency эффект. Loop detection — *per-worker*, нет глобального
   side effect → должен быть на слой ниже, в runner.

5. **Recovery callback уже существует.** `this.recoverAssignment({...})` инжектируется в
   `ClaudeBoardRunner` через конструктор (`claude-runner.mjs:94`, wired в
   `orchestrate.ts:1171-1221`), делегирует в `releaseExecutionAtomically`. Runner зовёт
   напрямую — без нового IPC channel.

### Почему НЕ orchestrate.ts pump-loop

| Con | Объяснение |
|---|---|
| Нет stream доступа | Pump-loop видит только SQL state через `countActiveTasks` (`orchestrate.ts:399`) и process liveness через `reconcileWorkerExecutions` (`worker-executions.ts:237`). |
| Polling latency | `PUMP_TICK_MS = 5000` (`orchestrate.ts:70`) — worst-case 5s detection latency vs. instant в runner. |
| Coupling | Pump-loop отвечает за stage transitions, gate failures, recovery trees. Loop detection — *worker-health* concern. |
| Дублирование bookkeeping | Если engine tail'ит JSONL — дублирует parsing logic runner'а. |

### File:line anchors

| Что | Где | Как |
|---|---|---|
| `Transform` line splitter | `claude-runner.mjs:416-418` (заменить 2 `.pipe(log)` линии) | `JsonlTee` transform: `child.stdout` → `JsonlTee` → и в `log` (файл), и в `loopDetector.onLine(line)` |
| Detector state на execution | `claude-runner.mjs:420-432` (расширить literal) | `loopDetector: createLoopDetector()`, `loopRecoveryInProgress: false` |
| Recovery method | Новый method рядом с `heartbeat()` на `claude-runner.mjs:130` | `recoverFromLoop(execution, reason)` → `child.kill('SIGTERM')`, потом `this.recoverAssignment(...)`, потом heartbeat `LOOP_RECOVERED` |
| Circuit-breaker counter | DB `tasks.metadata.loop_recoveries` (JSON int) | Increment в `recoverAssignment` callback. Если `>= CIRCUIT_BREAKER_LIMIT` → tag `needs-human` |

---

## 5. Recovery Protocol

Строгий порядок. Каждый шаг идемпотентен.

```
1. SET execution.loopRecoveryInProgress = true
   (предотвращает race с close handler'ом на claude-runner.mjs:443)

2. HEARTBEAT: LOOP_DETECTED line с reason, counters, last hash
   this.heartbeat(run, execution, 'LOOP_DETECTED',
     `reason=${reason} identical=${n1}/${THRESHOLD} errors=${n2}/${THRESHOLD}
      total_calls=${total} total_errors=${errors} pid=${child.pid}`)
   → ~/.zcode/cli/worker-heartbeat.log

3. KILL child (graceful → forceful):
   try { child.kill('SIGTERM') } catch {}
   after 2000 ms: if isProcessAlive(child.pid) try { child.kill('SIGKILL') } catch {}

4. TERMINALIZE execution + RELEASE task (single atomic transaction):
   outcome = releaseExecutionAtomically(db, {
     executionId,
     terminalState: 'terminated',
     reason: `loop detected: ${reason} (${n1} identical, ${n2} errors)`,
     lastError: `loop detected: ${reason} ...`,
   })

   ТА ЖЕ функция, что recoverAssignment уже вызывает (orchestrate.ts:1198).
   Fence CAS (atomic-release.ts:229) гарантирует:
     - другой execution уже взял task → мы no-op (terminalize only)
     - needs-human tag стоит → terminalize без release (atomic-release.ts:194)
     - иначе: task возвращается в очередь

   computeRestoredStatus (atomic-release.ts:272):
     in_progress        → todo           (dev attempt died)
     review_in_progress → review         (review attempt died)

5. CIRCUIT BREAKER — инкремент per-task loop счётчика:
   UPDATE tasks
     SET metadata = json_set(COALESCE(metadata,'{}'),
                             '$.loop_recoveries',
                             COALESCE(json_extract(metadata,'$.loop_recoveries'),0) + 1),
         updated_at = datetime('now')
     WHERE id = ?

   Если новое значение >= CIRCUIT_BREAKER_LIMIT (3):
     - add 'needs-human' tag (dispatcher.ts:176 pattern)
     - comment: "Loop circuit-breaker tripped after 3 recoveries. Fresh workers
                 cannot break out; needs human inspection."
     - atomic-release.ts:194 блокирует return в очередь на следующих смертях
     - logActivity('loop_circuit_breaker')

6. CLEAR execution.loopRecoveryInProgress (в finally)
```

### State transitions

```
[in_progress]  ──loop detected──>  SIGTERM  ──>  [todo]              (re-queued)

[review_in_progress]  ──loop──>  SIGTERM  ──>  [review]              (re-queued)

После 3-го loop на той же task:
[todo/review]  ──circuit breaker──>  tag:'needs-human'  ──>  [BLOCKED]
```

---

## 6. Thresholds

| Constant | Value | Обоснование |
|---|---|---|
| `LOOP_THRESHOLD` (S1 & S2) | **5** | Консервативный край индустрии (Aider=3, LangGraph=25, Cline=50). <60 сек на trip. |
| `CIRCUIT_BREAKER_LIMIT` | **3** | Три свежих воркера с 5+ идентичными вызовами = задача структурно сломана (плохой AC, malformed artifact) |
| `SIGTERM→SIGKILL grace` | **2000 ms** | Looping worker нечего flush'ить. Tighter чем `FINISH_GRACE_MS = 30_000` (`worker-executions.ts:10`) |
| Wall-clock backstop (опционально) | **15 мин** | Если детектор как-то промахнётся. Per task_kind override: verification.ac=30 мин, development.code=15 мин |

---

## 7. Industry Parallels

### Claude Code (наш spawner)

- **[`--max-turns`](https://www.claudelog.com/faqs/what-is-max-turns-in-claude-code/)** — turn-count cap, не no-progress детектор. Не решает gap. Дешёвая first-line mitigation.
- **[anthropics/claude-code#15909](https://github.com/anthropics/claude-code/issues/15909)** — "Sub-agent stuck in infinite loop, ~27M tokens"
- **[anthropics/claude-code#19699](https://github.com/anthropics/claude-code/issues/19699)** — "Same failing command repeated verbatim" — identical failure mode
- **[anthropics/claude-code#59318](https://github.com/anthropics/claude-code/issues/59318)** — "harness must supply the stopping condition"
- **[anthropics/claude-code#35166](https://github.com/anthropics/claude-code/issues/35166)** — Feature request: detect repeated/looping patterns. Open.

### Другие фреймворки

- **LangGraph** — [`recursion_limit = 25`](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT). Step-cap, не no-progress.
- **Aider** — ["3 maximum retries on malformed edits"](https://www.reddit.com/r/ChatGPTCoding/comments/1gz8fxb/solutions_for_dead_loop_problem_in_cursor_vs_code/). Tightest в ecosystem.
- **Cursor** — [loop issues в CLI/non-interactive](https://forum.cursor.com/t/the-last-update-is-causing-the-agent-to-loop-over-the-same-step-multiple-times/122583). Без встроенного детектора.
- **Cline** — `maxSteps = 50`. Step-cap.

### Паттерны

- **[alanwest "Why your AI agent loops forever"](https://dev.to/alanwest/why-your-ai-agent-loops-forever-and-how-to-break-the-cycle-12ia)** — 3 причины: missing state, missing feedback, missing limits. Наш детектор = limit #3.
- **[Particula.tech "Stop AI Agents Looping"](https://particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress)** — `(tool, arguments, error)` tuple-dedup guard = наш S1+S2.

### Control theory

- **Deadlock detection (OS)** — "no progress in N steps". S1/S2 сильнее — детектят *negative* progress.
- **Watchdog timer** — wall-clock backstop = watchdog, per-call = liveness kick.
- **Livelock (distributed)** — state fingerprint = `(tool, input)` hash.

---

## 8. Open Questions / Trade-offs

1. **Per-task counter location.** `tasks.metadata.loop_recoveries` (JSON) vs новая колонка. JSON консистентен с кодбейзом (`metadata.worker_pid`, `metadata.worktree`).

2. **Все tools или только saga MCP?** Все. Loop был на builtin `Edit`. Whitelist saga MCP tools пропустил бы его.

3. **`--max-turns` как belt-and-suspenders?** Да, дёшево. Значение ~200 (чтобы верифаеры/planner'ы не триггерили). Не замена детектору.

4. **Circuit breaker vs infinite retry.** Circuit breaker (3 strike) лучше: 3 loop'а = структурная проблема, не flaky model. Cost: каждый loop ~96k токенов; 3 = 290k waste.

5. **Все task_kind одинаково?** Verifier'ы делают много одинаковых `artifact_list`. S1/S2 используют exact input hash → `artifact_get({id:5})` ≠ `artifact_get({id:6})`. False positives маловероятны. Override per-kind: verification N=8, others N=5.

6. **Streaming parser robustness.** NDJSON может буферизироваться кусками. Использовать `readline.createInterface` или ручной accumulator по `\n`.

7. **Два канала логирования.** Heartbeat log (operator-facing plain text) + activity_log (UI-facing, joined с existing recovery kinds).

8. **Запуск в tracker-view?** `ClaudeBoardRunner` shared между engine и tracker-view manual runs. Detector на runner class → оба пути получают его бесплатно.

---

## 9. Estimated LoC

| Компонент | Файл | LoC added | LoC test |
|---|---|---:|---:|
| `JsonlTee` Transform stream | `tracker-view/claude-runner.mjs` | ~30 | ~25 |
| `createLoopDetector()` + `onStreamEvent` + `checkAndRecover` | новый `loop-detector.mjs` | ~80 | ~120 |
| `recoverFromLoop(execution, reason)` | `tracker-view/claude-runner.mjs` | ~35 | ~40 |
| Wire в `launch()` (заменить `.pipe(log)`, init на execution) | `claude-runner.mjs:416-432` | ~10 | — |
| Extend `recoverAssignment` callback: increment `loop_recoveries` + breaker | `src/orchestrate.ts:1171-1221` | ~25 | ~30 |
| Activity log kind | `src/helpers/activity-logger.ts` | ~2 | — |
| Опционально: `--max-turns 200` | `claude-runner.mjs:357` | 1 | — |
| **Total** | | **~183** | **~215** |

Новый sibling файл `loop-detector.mjs` чище — keeps `claude-runner.mjs` focused, делает детектор unit-testable без реального child process.

---

## 10. Summary

- **Implement в `tracker-view/claude-runner.mjs`** — вставить `Transform` между `child.stdout` и JSONL log file на линиях 417-418. Runner уже владеет stream'ом, per-execution state, child PID, `recoverAssignment` callback.
- **Trip на `(S1 OR S2) AND N ≥ 5`** — S1 = identical `(tool_name, canonical_input)` hash, S2 = identical `<tool_use_error>` text hash. Ignore thinking-text (S5) — слишком шумно.
- **Recover через существующий `releaseExecutionAtomically`** (`src/lifecycle/atomic-release.ts:98`) с `terminalState: 'terminated'`. Fence CAS уже обрабатывает все race'ы; restored-status logic уже мапит `in_progress → todo`, `review_in_progress → review`.
- **Circuit-breaker на 3 loop-recoveries per task** — increment `tasks.metadata.loop_recoveries`, add `needs-human` tag (atomic-release.ts:194 уже honours).
- **~183 LoC + ~215 LoC tests.** Без изменений saga-core (только существующий `recoverAssignment` callback).
- **Индустрия согласна: это работа harness'а.** Claude Code's open issues (#15909, #19699, #59318, #35166) все заключают: harness must supply no-progress detection. LangGraph, Aider, Cline — все имеют harness-side caps. saga не должна ждать Anthropic.

---

## Sources

- [anthropics/claude-code#15909 — Sub-agent stuck in infinite loop, consumed ~27M tokens](https://github.com/anthropics/claude-code/issues/15909)
- [anthropics/claude-code#19699 — Same failing command repeated verbatim](https://github.com/anthropics/claude-code/issues/19699)
- [anthropics/claude-code#59318 — Agent repeatedly calls the same tool in an infinite loop](https://github.com/anthropics/claude-code/issues/59318)
- [anthropics/claude-code#35166 — Repeated requests hundreds of times](https://github.com/anthropics/claude-code/issues/35166)
- [anthropics/claude-code#27281 — Agent stuck "let me write the document"](https://github.com/anthropics/claude-code/issues/27281)
- [What is --max-turns in Claude Code](https://www.claudelog.com/faqs/what-is-max-turns-in-claude-code/)
- [LangGraph recursion limit (GRAPH_RECURSION_LIMIT)](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT)
- [langchain-ai/langgraph#6731 — Agent infinite looping until recursion limit](https://github.com/langchain-ai/langgraph/issues/6731)
- [Why your AI agent loops forever — alanwest, dev.to](https://dev.to/alanwest/why-your-ai-agent-loops-forever-and-how-to-break-the-cycle-12ia)
- [Stop AI Agents Looping on the Same Failed Tool Call — Particula.tech](https://particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress)
- [How to Prevent AI Agent Reasoning Loops — dev.to/aws](https://dev.to/aws/how-to-prevent-ai-agent-reasoning-loops-from-wasting-tokens-2652)
- [Aider 3-retry cap — Reddit](https://www.reddit.com/r/ChatGPTCoding/comments/1gz8fxb/solutions_for_dead_loop_problem_in_cursor_vs_code/)
- [Cursor forum: agent loops over same step](https://forum.cursor.com/t/the-last-update-is-causing-the-agent-to-loop-over-the-same-step-multiple-times/122583)
