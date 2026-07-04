# AC-verification — содержательный gate для критериев приёмки

> **Addendum к saga-planner и saga-worker.** Решает GUARDRAILS Sign 006:
> `implements` (структурный coverage) ≠ `verified_by` (содержательная проверка).
> Без этого gate'а reviewer APPROVE'ит по «тесты green», не сверяя что тесты
> утверждают то, что AC требует.

## Проблема (Sign 006)

`artifact_coverage(link_type:'implements')` отвечает на вопрос «есть ли связь
AC→task». Это структурная проверка. Она НЕ отвечает «удовлетворяет ли код
конкретному Given/When/Then из AC». Worker пишет тесты сам → может написать
тесты про что-то другое, и reviewer видит «green» не зная покрывают ли они AC.

## Решение — AC-verification задачи

Planner создаёт **отдельную задачу** для каждого AC, ПОСЛЕ того как dev-задачи
готовы (или хотя бы одна dev-задача implements этот AC). Эта задача проверяет
AC содержательно.

### Что planner делает иначе

Старый flow planner'а:
```
AC-1 ──implements──▶ task #N (dev)
AC-2 ──implements──▶ task #M (dev)
...
artifact_coverage → 0 gaps  ← структурно
```

Новый flow planner'а:
```
AC-1 ──implements──▶ task #N (dev)
AC-2 ──implements──▶ task #M (dev)
...
AC-1 ──verified_by──▶ task #X (AC-verification, depends_on [N])  ← содержательно
AC-2 ──verified_by──▶ task #Y (AC-verification, depends_on [M])
...
artifact_coverage(link_type:'verified_by') → 0 gaps  ← содержательный gate
```

**Правило:** для каждого AC из AC-006 (или любого эпизода), planner создаёт
ровно ОДНУ AC-verification задачу. Эта задача:
- `depends_on` все dev-задачи, которые `implements` этот AC
- `tags`: `["role:reviewer", "ac-verification", "ac:<code>"]`
- `priority`: high (блокирует INTEGRATE)

### Что AC-verification задача делает

Задача берёт конкретный AC (Given/When/Then с эталоном из AC-документа) и:

1. **Идентифицирует assertion.** Находит в коде тест-кейс, который соответствует
   этому AC. Способ: grep по AC-коду в тестах (`// AC-1` comment, или test name
   содержит `AC-1`), или прямой вызов функции с эталонными входами.

2. **Прогоняет.** Запускает конкретный test-case (или прямой вызов с эталоном).

3. **Сверяет.** Сравнивает фактический результат с эталоном из AC.
   - AC-1: `100000@12%/12m monthly → totalAmount=112682.50` → реально 112682.5 ✅
   - Если не совпадает → FAIL, задача `changes_requested`, dev-задача возвращается.

4. **Trace.** `trace_add(AC → AC-verification-task, link_type:'verified_by')` +
   комментарий с фактическими числами.

5. **Gate.** Если все AC-verification задачи APPROVED → INTEGRATE может стартовать.
   Если хоть одна FAIL → dev-задача возвращается на доработку.

### Что меняется в saga-worker (reviewer phase)

Solo-worker review dev-задачи: APPROVE по «тесты green» — этого **недостаточно**.
Добавить шаг: перед APPROVE, проверить, что тесты **содержательно** покрывают AC.
Способ: прочитать AC из AC-документа, найти соответствующий тест, сверить assertion.

Но это дублирует AC-verification задачу. Решение: **reviewer APPROVE'ит по тестам,
AC-verification задача — отдельная, после review, перед INTEGRATE.**

```
dev-task → review (тесты green) → done → merge в dev
                                            ↓
                            AC-verification (содержательная сверка)
                                            ↓
                                        APPROVED
                                            ↓
                                       INTEGRATE
```

### Метрики

- `artifact_coverage(type:'AC', link_type:'implements')` — структурно (есть ли dev-задача)
- `artifact_coverage(type:'AC', link_type:'verified_by')` — содержательно (проверен ли AC)
- Оба должны показать 0 gaps перед INTEGRATE

## Impl roadmap

1. saga-planner SKILL.md: добавить правило «после dev-задач, создать AC-verification задачи»
2. saga-worker SKILL.md: добавить шаг в solo-review — сверить AC-assertion (не только green)
3. (Будущее) saga-mcp: `ac_verify` MCP tool — авто-прогон AC-эталонов (сейчас ручной)

## Связь

- GUARDRAILS Sign 006 (AC coverage ≠ satisfaction)
- REQ-006 demo: числа AC-1 проверены вручную, не workflow → это и есть gap
- `verified_by` link_type уже в enum saga-mcp (artifact_traces), не использовался
