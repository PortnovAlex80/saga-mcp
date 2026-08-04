# saga-flow — обзор архитектуры

**saga-flow** — система управления проектами на основе saga-mcp, где рои
AI-агентов работают в каждой цепочке: от идеи одной фразой до работающего
продукта. Это надстройка над saga-mcp (Jira-like MCP tracker) + набор
ZCode skills/agents, кодирующих роли и процедуры.

---

## Принцип

Идея входит одной фразой, выходит реализацией. Между ними — цепочка этапов,
на каждом работает свой рой агентов. Система — маршрутизатор + трассировщик,
не кодовая база.

```
ИДЕЯ (одна фраза от бизнеса)
   │
   ▼ ┌─────────────────────────────────────────────┐
     │  1. DISCOVERY (saga-kickstart)              │
     │  РОЙ: 3 ассесора параллельно                │
     │    ├ product-assessor  — зачем, кому, ценность
     │    ├ system-assessor   — масштаб, кого коснётся
     │    └ risk-assessor     — что не знаем, гипотезы
     │  СИНТЕЗ: orchestrator сводит → decision      │
     │  АРТЕФАКТ: brief                             │
     │  РЕШЕНИЕ: go / fast-track / clarify / reject│
     └──────────────┬──────────────────────────────┘
                    │
        ┌───────────┼───────────┬───────────────┐
        ▼           ▼           ▼               ▼
     go        fast-track    clarify         reject
        │           │           │               │
        │           │     ←вопросы бизнесу      ▼
        │           ▼      (brief открыт)   эпик closed
        │      прямо в kanban                    │
        │      (минуя PRD)                       │
        ▼                                           │
     ┌─────────────────────────────────────────┐   │
     │  2. FORMALIZATION Part 1 (ЧТО)          │   │
     │  saga-product    → PRD (+FR/NFR/RULE)   │   │
     │  saga-analyst    → UC → AC              │   │
     │  saga-reconciler → baseline_hash freeze │   │
     │  АРТЕФАКТЫ: PRD → UC → AC               │   │
     └──────────────┬──────────────────────────┘   │
                    ▼                               │
     ┌─────────────────────────────────────────┐   │
     │  2b. FORMALIZATION Part 2 (КАК)         │   │
     │  saga-architect → SRS ПОСЛЕ AC          │   │
     │    (видит замороженные AC + complexity) │   │
     │  АРТЕФАКТЫ: SRS (стиль, порты, §D DECOMP)│   │
     └──────────────┬──────────────────────────┘   │
                    ▼                               │
     ┌─────────────────────────────────────────┐   │
     │  3. PLANNING (saga-planner)             │   │
     │  Читает все accepted AC → создаёт граф  │   │
     │  dev-задач с depends_on                 │   │
     │  Pattern A (sequence) / Pattern B       │   │
     │  (scaffold+parallel)                    │   │
     │  + AC-verification задачи (verified_by) │   │
     └──────────────┬──────────────────────────┘   │
                    ▼                               │
     ┌─────────────────────────────────────────┐   │
     │  4. EXECUTION (рой saga-worker)         │   │
     │  Каждый: claim → worktree → код → done  │   │
     │  Независимые — параллельно              │   │
     │  Зависимые — по depends_on              │   │
     └──────────────┬──────────────────────────┘   │
                    ▼                               │
     ┌─────────────────────────────────────────┐   │
     │  5. AC-VERIFICATION (saga-worker)        │   │
     │  Содержательная сверка эталонов AC       │   │
     │  с реальным выводом кода                 │   │
     │  Двойной gate: implements + verified_by  │   │
     └──────────────┬──────────────────────────┘   │
                    ▼                               │
     ┌─────────────────────────────────────────┐   │
     │  6. REVIEW + INTEGRATION                │   │
     │  Solo-worker review + merge-lock        │   │
     │  Post-merge build check                 │   │
     └──────────────┬──────────────────────────┘   │
                    ▼                               │
                ГОТОВО ─────────────────────────────┘
```

---

## Топология агентов — паттерн чередуется

| Этап | Топология | Почему |
|---|---|---|
| Discovery | **Рой (3 параллельно)** | Три независимых взгляда |
| Formalization Part 1 (UC+AC+Reconcile) | **Цепь (последовательно)** | UC невозможен без PRD; AC без UC; Reconcile без AC |
| Formalization Part 2 (SRS) | **Один (после AC)** | Архитектор выбирает стиль, видя замороженные AC + brief complexity (ADR-014) |
| Planning | **Один** | Нужно видеть ВСЕ AC сразу + §D DECOMP из SRS |
| Execution | **Рой (N параллельно)** | Независимые задачи |
| AC-verification | **Один на AC** | Содержательная сверка |
| Review/merge | **Один + блокировка** | merge-lock = критическая секция |

---

## Точки маршрутизации (где интеллект)

Система умная не потому, что агенты умные, а потому что решения принимаются
на потоке, до того как код написан:

**Решение 1 (Discovery): обрабатывать ли вообще?**
- `go` → полный цикл formalization
- `fast-track` → мимо PRD, в kanban (для XS/S tech-task)
- `clarify` → стоп, вопросы бизнесу
- `reject` → закрыть

**Решение 2 (Planning): как дробить и sequencing?**
- Pattern A (sequence) — chain same-file ACs
- Pattern B (scaffold+parallel) — shared_mutation_risk=true
- + AC-verification задачи для каждого AC

**Решение 3 (Discovery): скольких проектов касается?**
- `affected-projects` в brief → `impact:<project>` теги на dev-задачах

---

## Механика зависимостей (3 слоя)

| Механизм | Где | Что говорит воркеру |
|---|---|---|
| `depends_on` | trace в графе | «Жди X» (sequencing) |
| `impact:<project>` | tags на task | «Не навреди проекту Y» |
| trace к артефакту | graph edge | «Связано с конкретным AC» |

---

## Артефакты (вертикаль)

```
theme       ← бизнес-доска (Марс)
  brief     ← discovery (idea → decision)
    prd → fr/nfr/rule   (PRD родитель FR/NFR/RULE с ADR-014)
      ├── uc → ac →(implements)→ dev-tasks     (UC/AC пишутся по PRD, ДО SRS)
      │                    ↘ (verified_by) → ac-verification-tasks
      └── srs (ПОСЛЕ AC) → decomp §D            (SRS родитель DECOMP, архитектор видит AC)
```

---

## Трассировка — dual-write + ленивая сверка

| Зона | Источник истины |
|---|---|
| Граф трассировки (AC→FR, AC→task) | БД (artifact_traces по ID) |
| Текст требования | `.md`-файл (пользователь правит свободно) |
| Адрес артефакта | `path#code` (якорь = code, не хэш заголовка) |

Drift-детекция — ленивая, без демона (в момент чтения).

---

## AC-verification gate (Sign 006)

```
artifact_coverage(type:'AC', link_type:'implements')  → 0 gaps  ← структурно
artifact_coverage(type:'AC', link_type:'verified_by') → 0 gaps  ← содержательно
```

Оба должны показать 0 gaps перед INTEGRATE. `implements` без `verified_by` —
это coverage gap, эпизод НЕ готов к integration.

---

## Ссылки

- **Установка:** `docs/INSTALL.md`
- **AC-verification дизайн:** `docs/ac-verification.md`
- **GUARDRAILS (6 Sign'ов):** harmess `GUARDRAILS.md`
- **kickstart дизайн:** harmess `docs/requirements/kickstart-design.md`
- **Demo полного флоу:** harmess `docs/requirements/REQ-006-deposit-s/00-demo-full-flow.md`
- **ZCode subagents howto:** harmess `docs/zcode-subagents-howto.md`
