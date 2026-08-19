# RE-PLAN CYCLE — второй цикл планирования с видением реальности

**Автор идеи:** оператор («если требуется порядок полок изменить — разрешение на
второй цикл планирования; планировщик уже видит ВЕСЬ код и зайдёт на цикл
рефакторинга с новой нарезкой»). **Проверено пятью независимыми архитекторами.**

## Вердикт пятёрки — единогласный

**РЕАЛИЗУЕМО и НЕ ЛОМАЕТ K10-K13** — при одном условии: цикл-2 = НОВЫЙ process
run (не мутация внутри текущего). Пять архитекторов сошлись независимо.

## Что уже работает (~60-80%)

| Кусок | Статус | Где |
|---|---|---|
| Планировщик видит репо | ✅ сейчас | allowedTools: Read, Glob, Grep, repository_checkout_list |
| Finding-set chain с stable ключами | ✅ влито | factory_gate_finding_set_chain (вчера) |
| Continuation-сервис (новые раны) | ✅ существует | factory-continuation.ts |
| Per-item гейт/ревью/акцепт | ✅ полный цикл | та же ячейка implement-work-items |
| changeScopes-схема | ✅ не меняется | development-schemas.ts:214-215 |
| Git CAS на общую ветку | ✅ несколько волн | update-ref CAS + isAncestor |

## Что нужно построить (~70-100 строк)

### 1. Триггер (~20 строк в executor repair_wait)

```
replan_required ⟺ ∃ key k:
  k is path-outside-authority
  ∧ k ∈ latest.keys ∧ k ∈ previous.keys
```

Тот же оскорбляющий путь пережил 2+ подряд отклонения = воркер НЕ МОЖЕТ
починить в своих границах → вместо terminal failed → typed re-plan mandate
через существующий recovery-feedback канал.

### 2. Case-builder для цикла-2 (~30 строк)

Новый DevelopmentCase с полями:
- `integratedHead` — текущий HEAD слитой ветки (что построено)
- `survivingKeys` — ключи замечаний из chain (что не заработало)
- `remainingACs` — непокрытые требования (что осталось)
- `cycleCount` — счётчик (для кэпа)

Подается через существующий `inputBeforeNodeRun` (generic-flow-executor:1236).

### 3. Supersede неподнятых задач (~50 строк в resolveTaskGraph)

Оставшиеся задачи цикла-1 → drained (проекции удалены, карточки — cancelled).
Новый графminted в новом process run → UNIQUE не конфликтует.

### 4. Кэп (2 правила, ~10 строк)

1. **Циклов ≤ 2** на developmentCaseHash (третий триггер = human_required)
2. **Монотонный ratchet**: триггер цикла-2 должен сработать на ключе,
   ОТСУТСТВУЮЩЕМ из терминального диагноза цикла-1 — если тот же
   path-outside-authority пережил ре-карв, планировщик воспроизвёл ожог,
   третий план не даётся.

## Экономика (Architect-3)

Re-plan выигрывает при **N=1 non-converging cross-seam defect** — потому что
распределённый ремонт authority-bound дефекта не медленный, а НЕВОЗМОЖНЫЙ
(воркер физически не может писать в чужой scope → терминал на бюджете).
Converging дефекты (разные причины) уже бесплатны до 20 по траектории —
re-plan для них не нужен.

## Безопасность авторитета (Architect-2)

Цикл-2 задачи = новые ячейки → новые головы авторитета → их собственный
гейт → ревью → акцепт. Это НОВАЯ власть поверх, не нарушение. K13
byte-identity сертифицирует «что было принято», не вечную неизменность
файлов. Цикл-1 merge остаётся доказанным через isAncestor reachability.
Pre-freeze: ничего замороженного не нарушено.

## Жизненный цикл графа (Architect-4)

Граф immutable по (process_run_id, module, cell) — второй граф = второй run.
Старый ран обязан termininate (blocked) до старта continuation (ноль
активных воркеров). 5 сделанных задач несутся вперёд как git baseline
(expectedBaseCommit), не как узлы графа. Workplaces цикла-2 не конфликтуют
(ключ = processRunId + semanticDigest).

## Что continuation-модуль фильтрует (надо разрешить)

Continuation deliberately filters OUT plan-task-graph (нет planner
inference). Для ре-плана надо ДОБАВИТЬ planner-ячейку перед
resolve-task-graph в continuation — или новое ребро. Это единственное
место, где existing flow надо расширить.

## Порядок строительства

1. Триггер в executor (can ship без остального — просто классифицирует
   scope-impossible и говорит human_required вместо молчаливого терминала)
2. Case-builder + continuation-планнер (минимальный MVP)
3. Supersede + кэп (защита от вечного цикла)
4. Integration-верификация (слой-2 из SEAM-ARCHITECT — прогон собранного)
