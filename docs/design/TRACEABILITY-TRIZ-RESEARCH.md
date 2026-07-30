Теперь у меня есть полная картина. Ключевое наблюдение: артефакты уже content-addressable по своей природе — `.md` файл на диске имеет SHA-256 хеш, вычисляемый `artifactDiskHash`. Это ground truth, отделённый от volatile DB id. Подготовлю итоговый отчёт.

---

# Архитектурный анализ трассировки артефактов в saga-mcp (ТРИЗ + системный дизайн)

## 0. Фактическая модель (по результатам чтения кода)

Прежде чем формулировать ИКР, зафиксирую факты из кода, потому что они меняют диагноз.

**Два уже существующих content-addressed слоя в коде:**
- `artifact.content_hash` (SHA-256 от файла `.md` на диске) вычисляется `artifactDiskHash()` в `src/helpers/artifact-file.ts`. Это ground truth: `refreshArtifactHash` перевычисляет его при каждом `artifact_get`. Артефакт по своей физике **уже content-addressable** — его тело живёт в git-репозитории, а БД лишь индексирует его.
- `ProductRef { schemaId, ref, digest }` (`src/process-modules/domain/spi/production-envelope.ts:179`) — чистый, сериализуемый content-addressed reference, спроектированный в Wave 1 для пересечения границы Process Module. Он **уже есть**, но используется только для productions узлов, не для артефактов-требований.

**Три сосуществующих fence в формализации** (`formalization-installation.ts:960-1175`):
1. Строгий execution-fence: `process_run+module+node+intent+task+execution_id` (`matchesExecutionFence`).
2. Relaxed-fence (recovery fallback): только `process_run+module+node` (`matchesFenceRelaxed`) — это и есть тот "band-aid".
3. Exact-candidate-acceptance CAS (`sqlite-exact-candidate-acceptance.ts`) — immutable decisions, привязанные к fence + content_hash.

**Корневая проблема переформулирована:** проблема не "traces привязаны к id". Проблема в том, что **семантика трассировки (UC→PRD) и provenance трассировки (кто/когда/в каком execution её создал) смоделированы одной и той же сущностью** — строкой в `artifact_traces` с fence-метаданными в `saga3_managed_trace_productions`. Это нарушает закон минимума связности (ЗРТС): стабильный и волатильный аспекты слиты.

---

## 1. ИКР (Идеальный конечный результат)

Простыми словами, без терминов:

> **Трассировка существует сама по себе, как надпись маркером на документах, а не как строчка в журнале учёта.** Когда курьер (execution) приносит новый документ или меняет старый, надписи на нём ("этот UC происходит из этого PRD") появляются вместе с документом и остаются на нём независимо от того, кто и когда их наносил. После пересменки курьеров (restart/recovery/reset) документы с надписями остаются на столе; новому курьеру не нужно заново переписывать связи — он просто читает то, что уже написано.

ИКР-формулировка через "систему исчезает":
> Система трассировки **сама** поддерживает корректные связи между артефактами, **не требуя** от recovery/restart перерегистрации, и **не ломаясь** при смене любого id, при этом сохраняя полный audit trail того, кто и когда создал каждую связь.

Конкретные ИКР-критерии (проверяемые):
1. После `reset-saga-db.mjs`, удаляющего все сага-таблицы, граф трассировки восстанавливается **без вызова `trace_add`**.
2. Recovery с новым task/intent/execution **не нуждается** в `matchesFenceRelaxed` — fence для семантики трассировки просто не нужен.
3. Слабая модель, создающая `UC→UC-1` вместо `UC→PRD`, **не может** это сделать, потому что ссылается не на id, а на код/хеш цели — `UC-1` физически не достижим как цель связи `derived_from` для `PRD`.

---

## 2. Анализ противоречий

### Физическое противоречие (ядро)
- `artifact_id` должен быть **стабильным** (чтобы `artifact_traces.source_id`/`target_id` и `command_receipts` на него ссылались) **И** `artifact_id` должен быть **волатильным** (autoincrement — единственный существующий механизм уникальности, плюс reset срывает `sqlite_sequence`).

По ТРИЗ физическое противоречие разрешается **разделением противоречивых свойств в пространстве** (одно свойство — одному элементу системы, другое — другому). Это значит: **нужно разделить id на две сущности** — стабильный логический идентификатор и волатильный физический указатель.

### Техническое противоречие 1 (параметр ↔ фактор)
- **Параметр, который ухудшаем:** сложность recovery / связность fence с семантикой.
- **Параметр, который улучшаем:** integrity/provenance (кто создал).
- **Разрешение по Альтшуллеру:** перейти к **переходу в другое измерение** (приём #17) — вынести provenance в отдельное измерение (event log), оставив семантику в графе.

### Техническое противоречие 2
- Traces должны быть **immutable** (integrity) **НО** должны **переживать reset**.
- **Разрешение:** приём #2 (Вынесение) + #35 (Изменение физического состояния) — traces как **граф-проекция** над immutable событиями, которые могут быть переcчитаны.

---

## 3. Применимые приёмы из 40 (конкретно для этого кода)

| # | Приём | Как именно применяется |
|---|-------|----------------------|
| **#1** | Дробление | Разделить одну таблицу `artifact_traces` на: (а) **семантическое ребро** `{source_key, target_key, link_type}` (stable, без fence); (б) **provenance-event** `{event_id, edge_key, who, when, execution}` (immutable log). Это убирает `matchesFenceRelaxed` целиком. |
| **#2** | Вынесение | Вынести **stable identity** артефакта из таблицы `artifacts` в отдельную `artifact_identities` (по `(epic, type, code)` или по content-addressed `path`), на которую ссылается и `artifacts`, и `artifact_traces`. |
| **#9** | Предварительное антидействие | Заранее зарезервировать ссылку на цель трассы **до** того, как цель получит DB id — через `code`/`anchor`. Воркер пишет `trace UC→PRD` по кодам, а не по id, и физический id подставляется при валидации. Это **прямо убивает класс ошибок "UC→UC-1"**, потому что модель физически не может указать на несуществующий код-цель. |
| **#13** | Наоборот | Вместо "сначала создаём id, потом привязываем trace" — "trace существует как интенция (по коду/якорю) ещё до материализации, а создание артефакта лишь подтверждает его". Это совпадает с тем, как thinking-aloud процесс создателя: автор знает "этот UC из этого PRD" ещё до того, как обе строки в БД есть. |
| **#17** | Переход в другое измерение | Provenance поднимается из таблицы (2D) в event-log (3D время). Один и тот же `edge_key` может иметь несколько provenance-events (recovery создал его заново — это нормально, это другая запись аудита). |
| **#23** | Обратная связь | Автоматическая сверка графа трасс с `.md`-якорями при `artifact_get` — как `refreshArtifactHash` уже сверяет хеш. Граф сам себя чинит против дрейфа. |
| **#25** | Самообслуживание | Артефакт несёт свои собственные исходящие связи в `.md` (frontmatter / wiki-links). `tracker-view/docs-graph/lib/graph-snapshot.mjs` **уже** сканирует `.md` и строит граф — то есть подсистема с path-based identity **уже построена** и живёт рядом, просто не интегрирована как источник истины. |
| **#35** | Изменение физического состояния | Trace из "состояния" (current edge) переходит в "событие" (immutable fact), а текущий граф — это materialized view. |

---

## 4. Вепольный анализ (Su-Field)

Текущая вредная цепочка:
```
Артефакт(VolatileId) ── поле(ссылка) ──▶ Trace(цель по VolatileId)
       │                                       │
       └── вредное действие: reset меняет VolatileId ──▶ Trace становится dangling
```

**Вредное поле** — поле "ссылки по id" — действует разрушающе на `Trace` при изменении `VolatileId`.

**Разрешение (по правилу: разрушить вредное поле введением нового вещества S2'):**

Ввести **S2' = стабильный ключ (StableKey)** между артефактом и trace:
```
Артефакт ──(содержит)──▶ StableKey(code/path/content-hash)
StableKey ──(указывает)──▶ Trace(цель по StableKey)
```
Поле "ссылки по id" теперь **нейтрализовано**: даже если `VolatileId` меняется, `StableKey` сохраняется (он выведен из содержания/кода/пути, а не из БД). Это классическое **"введение промежуточного вещества, разрушающего вредную связь"** — один из 76 стандартных решений ВП-анализа.

---

## 5. Альтернативные подходы (оценка)

### 5.1. CQRS / Event Sourcing — ВЫСОКАЯ пригодность
- Traces = immutable events (`trace_asserted` с `source_key, target_key, link_type, who, when`).
- Текущий граф = materialized view, переcчитываемый из events.
- **Плюс:** restart не требует перерегистрации — events уже в логе; replay детерминирован.
- **Плюс:** provenance становится встроенным свойством (event сам несёт `who/when`), а не внешним fence.
- **Минус:** нужен compaction (события `trace_asserted` + `trace_retracted` могут накапливаться).
- **Вердикт:** именно это и нужно для provenance-части. См. §6.

### 5.2. Content-addressable (hash = identity) — ЧАСТИЧНО, с оговоркой
- Использовать `content_hash` как первичный ключ артефакта.
- **Плюс:** identity переживает reset (хеш выводим из файла, а файл в git).
- **Критическая оговорка:** хеш меняется при **любом** правке `.md`. Трассировка "UC-1 происходит из PRD" логически постоянна, но если PRD правят (drift), content_hash меняется — и трасса по хешу рвётся. **Значит content_hash — это identity версии, но не identity сущности.**
- **Вердикт:** content_hash подходит для **provenance/acceptance** (точная версия — `ProductRef.digest` уже это делает), но НЕ подходит для **семантики трассировки**. Для семантики нужен stable logical identity (`epic + type + code`), а content_hash — как атрибут версии.

### 5.3. DDD (aggregate boundaries) — ВЫСОКАЯ пригодность
- **Aggregate: Episode (REQ-NNN)** — это и так граница (epic_id в schema).
- **Aggregate: Artifact** — внутри эпизода. Его stable identity = `(epic_id, type, code)`. Lifecycle (draft→accepted→superseded) — внутри aggregate. id — деталь persistence, не domain identity.
- **Value Object: TraceEdge** — `{sourceKey, targetKey, linkType}`, immutable.
- **Domain Service: TraceGraph** — проекция над events.
- **Вердикт:** DDD даёт язык, в котором `matchesFenceRelaxed` даже не возникает — fence это persistence-деталь provenance, а не domain-концепт.

### 5.4. CRDT — НИЗКАЯ пригодность
- CRDT решает проблему **конкурентных merge**. Здесь нет распределённой БД; проблема в reset/recovery, не в консенсусе. CRDT добавил бы сложность без выгоды. **Отклонить.**

### 5.5. MPT (Model-Process-Tools) — уже частично
- saga уже разделяет Model (Process Module contracts) / Process (Flow) / Tools (worker MCP).
- Трассировка сейчас живёт в Tools-слое (`src/tools/artifacts.ts:handleTraceAdd`). По MPT её семантика должна жить в **Model** (доменный граф), а tools — лишь порт. `FormalizationCanonicalGraphPort` (`formalization-kernel-ports.ts:62`) уже моделирует это правильно, но создание трассы остаётся в tool-слое с fence-логикой.

---

## 6. Рекомендуемая архитектура

### 6.1. Принцип: **разделить семантику и provenance** (ТРИЗ #1 + #17)

Две независимые модели, как в CQRS:

**A. Семантический граф (stable, по StableKey)**
```sql
-- NEW: логическая identity артефакта, выведенная из (epic, type, code)
-- НЕ зависит от artifacts.id. Переживает reset.
CREATE TABLE artifact_identities (
  stable_key   TEXT PRIMARY KEY,   -- напр. "req-007/AC/AC-3" или content-anchored
  epic_key     TEXT NOT NULL,      -- "req-007" (epic.code/generation_key, не epic.id)
  artifact_type TEXT NOT NULL,
  code         TEXT NOT NULL,
  -- текущая физическая версия (указывает на artifacts.id ТЕКУЩЕГО прогона)
  current_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  current_content_hash TEXT,
  status TEXT,
  updated_at TEXT
);

-- NEW: семантическое ребро, адресуется StableKey, не id
CREATE TABLE trace_edges (
  edge_key   TEXT PRIMARY KEY,     -- hash(stable_key_src, stable_key_tgt, link_type)
  stable_key_source TEXT NOT NULL REFERENCES artifact_identities(stable_key),
  stable_key_target_kind TEXT NOT NULL,  -- 'artifact' | 'task'
  stable_key_target TEXT NOT NULL,       -- artifact_identity.stable_key или task-stable-key
  link_type  TEXT NOT NULL,
  -- НЕ хранит execution/run/intent — это provenance, см. ниже
  UNIQUE (stable_key_source, stable_key_target, link_type)
);
```

**B. Provenance как event log (immutable, волатильный)**
```sql
-- NEW: append-only аудит. Не переживает reset — и НЕ ДОЛЖЕН.
CREATE TABLE trace_provenance_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_key    TEXT NOT NULL REFERENCES trace_edges(edge_key),
  asserted_by TEXT NOT NULL,       -- execution_id / worker_id (волатильно)
  asserted_at TEXT NOT NULL,
  operation   TEXT CHECK(operation IN ('asserted','retracted')),
  -- fence здесь — для аудита "кто это записал", НЕ для валидации ребра
  process_run_id INTEGER,
  node_id TEXT
);
```

### 6.2. StableKey: что выбрать

Три кандидата, с разными trade-offs:

| Кандидат | Стабилен при reset? | Стабилен при правке файла? | Реализация |
|----------|---------------------|----------------------------|------------|
| `artifacts.id` (текущий) | **НЕТ** | да | текущая |
| `content_hash` | да | **НЕТ** | `ProductRef.digest` уже есть |
| **`(epic_key, type, code)`** | **да** | **да** | NEW — рекомендуется |
| `path` (файл на диске) | да | почти (renames) | docs-graph уже строит |

**Рекомендация: `(epic_key, type, code)` как primary StableKey + `content_hash` как version-key.** Это два ортогональных ключа:
- StableKey отвечает на "**что** это" (UC номер 2 из REQ-007) — для семантики трассировки.
- content_hash отвечает на "**какая версия**" — для provenance/acceptance.

Зачем оба: `artifact_identities` — стабильная сущность; `artifacts`-строка с конкретным `content_hash` — её текущая версия. Trace ссылается на `stable_key`; acceptance/CAS ссылается на `stable_key + content_hash` (как уже делает `ProductRef`).

### 6.3. Конкретные изменения в существующем коде

**1. `src/types.ts:191` (`ArtifactTrace`)** — добавить `stable_key_source`/`stable_key_target`, сохранить `source_id`/`target_id` как кэш текущих физических id (denormalized для быстрых JOIN).

**2. `src/tools/artifacts.ts:580-599` (`handleTraceAdd`)** — вместо (или в дополнение к) приёму `source_id`/`target_id` принимать **код цели**: `source_code`/`target_code`/`target_epic`. Разрешение кода→id идёт в момент записи, а не в момент чтения. Это приём #9 (предварительное антидействие): **структурно исключает** ошибку "UC→UC-1", потому что `derived_from` к `UC`-типу не валидируется (`buildContractSnapshot:1199-1209` уже кодирует допустимые пары типов).

**3. `formalization-installation.ts:960-1058` (`readExecutionWrites`)** — заменить двойную логику (строгий fence + `matchesFenceRelaxed` fallback) на:
   - Семантика: `trace_edges` фильтруется по `stable_key` (не по execution). Recovery ничего не перерегистрирует — ребра уже там.
   - Provenance: `trace_provenance_events` показывает, кто и когда создал ребро. Kernel resolver читает **актуальный граф**, а не "ledger за этот execution".

Это **полностью убирает `matchesFenceRelaxed`** — корневую причину сложности recovery.

**4. `sqlite-managed-production-ledger.ts`** — `saga3_managed_trace_productions` становится источником provenance-events, а не каноном ребра. Ребро канонично в `trace_edges`.

**5. `reset-saga-db.mjs`** — больше НЕ должен срывать трассировку. Достаточно переcчитать `artifact_identities.current_artifact_id` по `(epic, type, code)` после ресeedа `artifacts`. Команда:
```sql
-- после DELETE FROM artifacts + повторного импорта:
-- artifact_identities выживают (они не depend on artifacts.id)
UPDATE artifact_identities
   SET current_artifact_id = (SELECT a.id FROM artifacts a
        WHERE a.epic_id=? AND a.type=artifact_identities.artifact_type
          AND a.code=artifact_identities.code
        ORDER BY a.id DESC LIMIT 1);
```

### 6.4. Что меняется для слабой модели

Сегодня модель может вызвать `trace_add(source_id=42, target_id=43, link_type='derived_from')`, и если `43` случайно `UC-1`, то создастся `UC→UC-1`. С новой моделью:
```
trace_add(stable_source="req-007/UC/UC-1",
          stable_target="req-007/PRD/PRD-1",
          link_type="derived_from")
```
Валидатор типа (`PRD-derived_from→brief`, `UC-derived_from→PRD`) применяется к **типам StableKey**, а не к типам id. Модель не может ошибиться типом цели, потому что код цели (`PRD-1`) кодирует тип.

---

## 7. Миграционный путь (без big-bang)

По принципу **strangler fig** (постепенное вытеснение):

**Фаза 0 — Подготовка (без изменения поведения):**
- Добавить таблицы `artifact_identities`, `trace_edges`, `trace_provenance_events` (`CREATE IF NOT EXISTS`).
- Написать миграцию, которая в фоне заполняет `artifact_identities` из существующих `artifacts` (`epic_id, type, code` → `stable_key`). Нон-блокирующая.

**Фаза 1 — Двойная запись (shadow):**
- `handleTraceAdd` пишет **и** в `artifact_traces` (как сейчас), **и** в `trace_edges` + event. Чтения пока из `artifact_traces`.
- `readExecutionWrites` читает из старого, но логирует, если новый граф не сходится (детектор дрейфа).

**Фаза 2 — Переключение чтений:**
- `buildContractSnapshot` и формализационные проверки читают из `trace_edges`. Fallback `matchesFenceRelaxed` удаляется.
- `reset-saga-db.mjs` дополняется шагом переcчёта `current_artifact_id` (см. §6.3 п.5).

**Фаза 3 — Удаление legacy:**
- `artifact_traces.source_id`/`target_id` становятся кэшем; canonical только `trace_edges`.
- `saga3_managed_trace_productions` — только provenance, не канон.

**Фаза 4 (опц.) — `.md` как первоисточник:**
- Интегрировать `tracker-view/docs-graph/lib/graph-snapshot.mjs` как source-of-truth для семантического графа; `trace_edges` — его кэш. При `artifact_get` ребра сверяются с frontmatter/wiki-links `.md` (приём #23 — обратная связь).

---

## 8. Риски и митигации

| Риск | Митигация |
|------|-----------|
| **Коллизия `(epic, type, code)`** — два артефакта в одном эпизоде с тем же кодом | Уникальный индекс `UNIQUE(epic_key, type, code)` на `artifact_identities`. `code` обязателен для формализационных типов (PRD/UC/AC/FR/NFR). Для `decision`/`OQ` — auto-generated code при создании. |
| **Код эпизода волатилен** (epic_id меняется при reset) | Использовать `epic.generation_key` (он уже есть в schema, `tasks.generation_key`) или стабильный slug эпизода, а не `epic.id`. Эпизод "REQ-007" — его **имя**, а не row id. |
| **Потеря exact-acceptance** — CAS сейчас завязан на `artifact_id` + fence | `isAcceptedExact` (`sqlite-exact-candidate-acceptance.ts:398`) уже сравнивает `content_hash`. Достаточно добавить join к `artifact_identities` по `(stable_key, content_hash)`. Acceptance — это свойство **версии**, не id, и модель уже к этому готова. |
| **Производительность** — лишний JOIN | `stable_key` PRIMARY KEY, индексы на `trace_edges(stable_key_source)`. Граф трассы мал (десятки–сотни на эпизод), JOIN тривиален. |
| **Параллельные воркеры пишут одно ребро** | `trace_edges` UNIQUE по `(source, target, link_type)` → `INSERT OR IGNORE`. Provenance-events — append-only, каждый воркер пишет свой. Конфликт на уровне семантики невозможен (ребро уникально). |
| **Обратная совместимость legacy-инструментов** | Фаза 1 (двойная запись) гарантирует, что любой код, читающий `artifact_traces`, продолжает работать. `source_id`/`target_id` остаются как кэш-колонки. |
| **`verified_by`-特殊性** — сейчас нельзя удалить (`handleTraceDelete:619`) | Сохранить правило: `verified_by` ребро управляется только через `verification_evidence`. В `trace_edges` добавить CHECK: `link_type='verified_by'` нельзя ретRACTed без evidence-реверса. |
| **Слабая модель всё же шлёт id вместо кода** | Принять оба формата; если пришёл `target_id`, resolve в `stable_key` через JOIN и валидировать тип. Но **рекомендовать** в схеме `trace_add` именно коды (изменить description tool'а). |

---

## Итог (коротко)

**Корень проблемы** — не "traces привязаны к id", а **слияние двух ортогональных аспектов** (семантики связи и provenance её создания) в одной сущности с одним fence. Это нарушает ЗРТС (закон повышения степени идеальности) и порождает `matchesFenceRelaxed`-подобные заплатки при каждом восстановлении.

**ТРИЗ-разрешение**: приём **#1 (Дробление)** + **#17 (Переход в другое измерение)** — разделить на стабильный семантический граф (по `StableKey = epic/type/code`) и волатильный provenance event-log. Приём **#9 (Предварительное антидействие)** — адресовать трассы по кодам целей, структурно исключая ошибки типа `UC→UC-1`.

**Ключевое удачное обстоятельство**: saga **уже содержит оба строительных блока** — `ProductRef` (content-addressed reference, `production-envelope.ts:179`) и path-based docs-graph (`tracker-view/docs-graph`). Рекомендуемая архитектура — это завершение того, что наполовину построено, а не зелёнопольный редизайн. Миграция идёт через strangler-паттерн (двойная запись → переключение чтений → удаление legacy), без big-bang.

**Ключевые файлы для изменений:**
- `D:\Разработка\saga-mcp\src\types.ts:168-198` — `Artifact`, `ArtifactTrace` (добавить stable_key поля)
- `D:\Разработка\saga-mcp\src\tools\artifacts.ts:540-677` — `handleTraceAdd`/`handleTraceList` (приём кодов целей)
- `D:\Разработка\saga-mcp\src\process-modules\modules\formalization\formalization-installation.ts:960-1176` — `readExecutionWrites`, `matchesFenceRelaxed` (удалить после переключения на StableKey-граф)
- `D:\Разработка\saga-mcp\src\process-modules\persistence\sqlite-managed-production-ledger.ts` — `saga3_managed_trace_productions` (стать provenance-event-логом)
- `D:\Разработка\saga-mcp\src\process-modules\persistence\sqlite-exact-candidate-acceptance.ts:398-481` — `isAcceptedExact` (добавить stable_key join; CAS уже сравнивает content_hash)
- `D:\Разработка\saga-mcp\src\process-modules\domain\spi\production-envelope.ts:179-183` — `ProductRef` (образец content-addressed reference для реюза)
- `D:\Разработка\saga-mcp\tracker-view\docs-graph\lib\graph-snapshot.mjs` + `paths.mjs` — существующий path-based identity-слой (кандидат на source-of-truth в Фазе 4)
- `D:\Разработка\saga-mcp\reset-saga-db.mjs` — индикатор корневой проблемы; должен перестать срывать трассировку