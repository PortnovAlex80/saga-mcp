# ТЗ: RE-PLAN CYCLE — второй цикл планирования (implementation spec)

**Оператор:** «re-plan тоже будет на механике траектории? Не помешало бы.
Плюс, так как re-plan видит весь код, он может максимально включить
параллельность задач. Продумай, отдай полное качественное ТЗ.»

## 0. Что строим

Механизм второго цикла планирования Development-цеха: когда cross-seam
дефект (воркер не может починить в своих границах) распознаётся,
планировщик перезапускается — видя ВЕСЬ код цикла-1 + finding-историю —
и нарезает НОВУЮ группу задач, включая задачи рефакторинга общих
поверхностей и максимально возможную параллельность.

## 1. Триггер — на механике траектории (принцип оператора)

Re-plan триггер живёт В ТОЙ ЖЕ finding-set chain, что и trajectory-бюджет.
Это НЕ отдельный механизм — это третья строка в существующей таблице
классификации:

| Класс | Условие | Маршрут |
|---|---|---|
| converging | строгое подмножество, 0 новых, fatal не растёт | → waive budget (≤20) |
| spinning | байт-идентичное множество | → stop (после 3) |
| churning | новые ключи / severity-рост | → stop (после 3) |
| **scope-impossible** (NEW) | тот же `path-outside-authority` ключ ∈ latest ∧ ∈ previous | → **re-plan mandate** |

**Реализация:** расширить `trajectory()` в finding-trajectory.ts —
новый вердикт `'scope-impossible'` возвращается когда ВСЕ условия:
1. trajectory(prev, latest) === 'spinning' или 'churning'
2. ∃ ключ k: k имеет код `path-outside-authority` ∧ k ∈ latest.keys ∧ k ∈ prev.keys

Это ~15 строк в чистом модуле. Existing тесты остаются зелёными.

**Executor routing:** в `repair_wait` ветке (production-cell-node-executor),
после trajectory-классификации — новый маршрут:

```typescript
if (traj === 'scope-impossible' && canReplan) {
  // Не terminal failed, не requeue — re-plan mandate
  return replanMandatoryOutcome(workplace, survivingKeys);
}
```

## 2. Параллельность цикла-2 (ключевое улучшение оператора)

Планировщик цикла-2 видит ВЕСЬ интегрированный код → он может нарезать
ЗАДАЧИ МАКСИМАЛЬНО ПАРАЛЛЕЛЬНО, потому что знает реальные интерфейсы.

**Что видит планировщик цикла-2 (case-builder):**

```typescript
interface ReplanDevelopmentCase {
  // СТАНДАРТНЫЕ поля (наследуются от цикла-1):
  formalizationCertificate: ...;  // НЕ меняется
  solutionContract: ...;         // НЕ меняется
  srs: ...;                     // НЕ меняется
  acceptanceCriteria: ...;       // НЕ меняется

  // НОВЫЕ поля цикла-2:
  replanContext: {
    cycleNumber: 2;                        // для кэпа
    cycle1Diagnosis: {
      survivingKeys: string[];             // от finding-set chain
      completedItems: string[];            // какие задачи Ц1 закрыты
      scopeViolations: PathScopePair[];    // какие пути в чьих scope'ах
    };
    integratedRepoState: {
      headCommit: string;                  // HEAD integration branch
      fileTree: string[];                  // список всех файлов
      moduleBoundaries: InterfacePair[];   // какие модули экспортируют что
    };
    parallelismHint: {
      maxConcurrency: number;              // из model profile (=2)
      nonOverlappingGroups: ItemKey[][];   // группы, которые МОГУТ идти параллельно
    };
  };
}
```

**Что планировщик ДОЛЖЕН сделать в цикле-2 (проверяется гейтом):**

1. **Извлечь общую поверхность**: если ≥2 задач цикла-1 имели path-outside-authority
   на одни и те же файлы → эти файлы = shared surface → НОВАЯ задача-base-item
   с scope, покрывающим shared surface, от которой зависят потребители.

2. **Нарезать параллельно**: планировщик видит реальные интерфейсы →
   scope'ы могут быть НЕ-перекрывающимися → НЕ нужны dependency-рёбра →
   ширина графа > 1 → concurrency=2 реально работает.

3. **Новый check-plan для цикла-2**: гейт проверяет:
   - Coverage: все `implementationRequired` AC покрыты
   - **Parallelism**: если две задачи имеют НЕ-перекрывающиеся scope'ы,
     НЕ существует dependency-ребра между ними (анти-паттерн сериализации)
   - **Shared-surface extraction**: для каждой пары задач с
     path-outside-authority в Ц1, либо scope'ы разведены, либо
     существует base-item, которому обе зависят

## 3. Case-builder (новый, ~40 строк)

Вызывается из executor'а при scope-impossible вердикте:

```typescript
function buildReplanCase(db, workplace, survivingKeys): ReplanDevelopmentCase {
  // 1. Прочитать finding-set chain → survivingKeys + scopeViolations
  // 2. Прочитать integration branch HEAD → headCommit
  // 3. Прочитать git file tree → fileTree
  // 4. Прочитать completed items из задач цикла-1
  // 5. Собрать parallelismHint из model profile
  return enrichedCase;
}
```

Через существующий `inputBeforeNodeRun` (generic-flow-executor:1236-1279).

## 4. Continuation-планировщик (~30 строк)

Continuation-модуль сегодня фильтрует plan-task-graph (детерминистический).
Для цикла-2 надо РАЗРЕШИТЬ planner-ячейку в continuation:

```typescript
// В development-continuation-process-module.ts:
// Добавить узел 'replan-task-graph' ПЕРЕД 'resolve-task-graph'
// (или заменить фильтр на условный: если cycleNumber > 1 → planner)
```

## 5. Supersede неподнятых задач (~50 строк)

При старте цикла-2, в `resolveTaskGraph`:
- Прочитать remaining задачи цикла-1 (status IN ('todo', 'review'))
- Пометить их metadata.$.superseded_by = <cycle2RunId>
- Drain их workplace-проекций (kanban → cancelled)

## 6. Кэп и ratchet (~10 строк)

- `replanCycleCount` в lifecycle_run metadata (increment при каждом re-plan)
- Кэп: 2 цикла на developmentCaseHash. Третий триггер scope-impossible →
  `human_required` с полным диагнозом (survivingKeys + оба графа).
- Монотонный ratchet: триггер Ц2 должен сработать на ключе, ОТСУТСТВУЮЩЕМ
  из терминального диагноза Ц1. Тот же ключ пережил ре-карв → не даём Ц3.

## 7. Тесты (RED-first)

| # | Что проверяет | RED |
|---|---|---|
| T1 | trajectory() возвращает 'scope-impossible' при 2 подряд path-outside-authority | модуль отсутствует |
| T2 | repair_wait маршрутизирует scope-impossible → replan mandate (не terminal) | assertion |
| T3 | Case-builder включает survivingKeys + integratedHead + fileTree | assertion |
| T4 | Цикл-2 граф: не-перекрывающиеся scope'ы БЕЗ dependency-рёбер (parallelism check) | assertion |
| T5 | Shared-surface: path-outside-authority в Ц1 → base-item в Ц2 | assertion |
| T6 | Supersede: remaining Ц1 задачи → cancelled + projections drained | assertion |
| T7 | Кэп: 3-й триггер → human_required, не 3-й цикл | assertion |
| T8 | Ratchet: тот же ключ в Ц2-диагнозе → нет Ц3 | assertion |
| T9 | Траектория budget НЕ конфликтует: converging по-прежнему waived, spinning по-прежнему stopped | existing tests green |

## 8. Порядок строительства

1. `trajectory()` extension + T1 (чистый модуль, ноль зависимостей)
2. Executor routing + T2
3. Case-builder + T3
4. Continuation-планировщик + T4/T5 (parallelism + shared-surface check)
5. Supersede + T6
6. Кэп + T7/T8
7. Full regression: все существующие тесты зелёные + T9

## 9. Дизайн-документы

- REPLAN-CYCLE-DESIGN.md — архитектура (5 архитекторов)
- SEAM-ARCHITECT-DESIGN.md — предыстория (3 архитектора)
- FINDING-TRAJECTORY-BUDGET.md — механика траектории (foundation)
