# Case 03 — Kickstart создаёт слишком много артефактов

Date: 2026-07-23
Branch: `master` (старый v2 движок)
Episode: epic 15 / project 14 / «World»
Model: `qwen3.6-35b-a3b@q4_k_xl` через LM Studio

## Что должно быть по канону

### Контракт saga-kickstart SKILL

Discovery = **1 артефакт `type:'brief'`** + 1 decision ∈ {go, fast-track,
clarify, reject}. Других артефактов нет.

Из SKILL.md:
> Discovery creates one REQ epic and `type:'brief'` artifact inside the
> current logical product.
>
> Postcondition: Brief artifact accepted, decision ∈ {go, fast-track,
> clarify, reject}
>
> saga-mcp tools this skill calls:
> - `artifact_create({ type: 'brief' })` — persists the discovery brief
> - `extractInputs` — builds `00-inputs.md` helper
> - `AskUser` — last resort only

### Переход brief_accepted (workflow.ts:97-113)

После завершения `discovery.kickstart` движок читает **brief** артефакт:
- ищет `artifacts WHERE epic_id=? AND type='brief' ORDER BY id DESC LIMIT 1`
- если нет brief → ошибка «Kickstart must register a brief via
  artifact_create({type:'brief'}) before completing»
- если decision='go' → создаёт ОДНУ задачу `formalization.prd`

То есть:
```
kickstart task done
  → reads brief artifact (1 шт, type='brief')
  → creates formalization.prd task (1 шт)
  → saga-product picks PRD → creates PRD artifact (1 шт)
  → ...
```

Каждый последующий этап сам создаёт свои артефакты. PRD/UC/AC создаются
воркерами `saga-product`/`saga-analyst`, НЕ `saga-kickstart`.

## Что произошло на практике

За один шаг kickstart (task #123, 10:30:50 → 10:43:40, ~13 минут)
модель создала **7 артефактов** в один присест:

```
10:38:43  #95 PRD/PRD-1     accepted   ← НЕ должна!
10:38:48  #96 UC/UC-1        accepted   ← НЕ должна!
10:38:54  #97 AC/AC-1        accepted   ← НЕ должна!
10:38:58  #98 AC/AC-2        accepted   ← НЕ должна!
10:39:01  #99 AC/AC-3        accepted   ← НЕ должна!
10:39:04  #100 AC/AC-4       accepted   ← НЕ должна!
10:43:40  #101 brief/BRIEF-001 draft    ← ОНА должна (но поздно и draft)
```

### Что не так

1. **Kickstart лезет в formalization.** PRD/UC/AC — это артефакты ЭТАПА 2
   (formalization), их создают saga-product (PRD), saga-analyst (UC/AC).
   Kickstart создал их сам — нарушил single-responsibility.

2. **Нарушен pipeline.** Если brief не выполнен, PRD/UC/AC не должны
   существовать. Сейчас они `accepted` в DB ДО того как brief перешёл в
   `accepted` (brief ещё draft!).

3. **Brief создан последним и в draft.** По канону brief — ПЕРВЫЙ артефакт,
   который создаёт kickstart, и он должен быть `accepted`. Здесь наоборот:
   сначала «накропали» PRD/UC/AC (за 5 секунд друг за другом!), а brief
   создали через 5 минут, да ещё в draft.

4. **Task #123 перешла в review_in_progress, не done.** Переход
   `brief_accepted` не сработал, потому что:
   - либо не было brief артефакта на момент worker_done
   - либо decision не равен 'go' (т.к. brief draft и без decision)

5. **7 артефактов за 5 секунд** (10:38:43 → 10:39:04) — модель просто
   пробежала по канонической section list из SKILL и создала всё что
   нашла. Это не семантическая работа, это «исполнение буквы инструкции
   без понимания».

## Корневая причина

`saga-kickstart` SKILL.md описывает не только свой этап (Discovery), но и
**весь flow целиком** — какие артефакты потом создают PRD/UC/AC. Модель
`qwen3.6-35b-a3b` (и другие слабые LM) не отличает «это создаёшь ты» от
«это описано для контекста, создаёт другой skill». Она читает «PRD section
list» и сразу создаёт PRD.

SKILL содержит:
- «BRIEF-004 §2 (artifact 77) — 12-section brief layout» — это contract
  для kickstart ✓
- «saga-mcp tools this skill calls» — только `artifact_create({type:'brief'})` ✓

НО также описывает downstream:
- «decision=go → saga-product (PRD, Этап 2)»
- «prd_accepted → UC»
- «saga-mcp SCAFFOLD task #215»

Слабая модель читает это как «надо создать PRD».

## Как должно быть

### Правильный kickstart (1 запуск = 1 artifact)

```
worker spawn (task #123 discovery.kickstart)
  → Read saga-kickstart/SKILL.md
  → extractInputs() (helper file 00-inputs.md, не artifact)
  → build brief (12 sections per BRIEF-004)
  → artifact_create({type:'brief', path:'...', status:'accepted'})
    └── contains decision_matrix + decision='go'/'fast-track'/...
  → worker_done
  → workflow.ts brief_accepted transition fires
    └── creates formalization.prd task (одну)
```

Дальше — saga-product:
```
worker spawn (task formalization.prd)
  → Read saga-product/SKILL.md
  → artifact_create({type:'PRD', path:'01-prd.md'})
  → worker_done → workflow.ts prd_accepted → UC task
```

И т.д. — каждый этап создаёт только свои артефакты.

### Что мы видим вместо этого

Kickstart одним заходом создал 7 артефактов. Это значит:
- formalization этап уже не нужен (PRD/UC/AC уже есть)
- planner получит «готовые» ACs без подлинной formalization работы
- pipeline сломан: downstream ждёт свои триггеры, но артефакты уже в БД

## Возможные фиксы (НЕ применяем — по требованию пользователя)

1. **Жёстче prompt saga-worker для discovery.kickstart.** Запретить
   любой `artifact_create` кроме `type:'brief'`. Например:
   > «You are a Discovery kickstart worker. You may call
   > `artifact_create` ONLY with `type:'brief'`. Any other artifact type
   > (PRD, UC, AC, SRS) is created by a DIFFERENT worker in a DIFFERENT
   > task. Creating them here is a protocol violation.»

2. **MCP-level guard.** В `mcp__saga__artifact_create` проверять
   `task.task_kind` и запрещать типы не из своего stage. Например для
   task_kind='discovery.kickstart' разрешить только `type:'brief'`.

3. **Урезать SKILL.md.** Убрать из kickstart описание downstream (что
   делает saga-product) — оставить только свой контракт. Тогда модель
   не «соблазнится» создать PRD.

4. **Валидация в workflow.ts.** На transition `brief_accepted` — если в
   эпизоде уже есть PRD/UC/AC до перехода, это подозрительно. Не блокировать,
   но logged warning.

## Сводка наблюдения

| Метрика | Канон | Реальность |
|---|---|---|
| Артефактов за kickstart | **1** (brief) | 7 (1 brief + 1 PRD + 1 UC + 4 AC) |
| Brief status | accepted (с decision) | draft (без decision) |
| Task после kickstart | done → fires brief_accepted | review_in_progress (transition не сработал) |
| Следующий task в epic | 1 (formalization.prd) | 0 (pipeline стоит) |
| Время kickstart | 2-5 минут | 13 минут (модель возилась с PRD/UC/AC) |

**Инфраструктура saga (движок, диспетчер, MCP, фронт) работает корректно.**
Модель выполняет работу не того этапа — создаёт downstream артефакты
вместо своего. Это вопрос skill prompt + model capability, не баг
движка.
