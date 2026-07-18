# saga-mcp 3.0 — Pipeline Progress UI

> Feature spec для добавления к плану 3.0.
> Прочитай вместе с `docs/saga-mcp-3.0-orchestration-plan.md`.

## Что строим

Прогресс-бар pipeline — горизонтальная цепочка стадий эпизода с live-статусом.
Визуализирует не отдельные задачи (это канбан), а **макро-движение эпизода**
от идеи до готового продукта.

## Как выглядит

```
Pipeline — REQ-001: AutoCad3D MVP

[✓ Discovery] ──→ [✓ Formalization] ──→ [● Planning] ──→ [○ Development] ──→ [○ Verification] ──→ [○ Integration] ──→ [○ Completed]
     3m                  8m                   2m                —                   —                   —                  —

Brief accepted    PRD+SRS+UC+AC done     Planner running    Waiting scaffold   Waiting evidence   Waiting merge      —
HYP-1: ≥180s     24 FR, 9 NFR           3 dev tasks        Pattern B          7 verify tasks      1 integrate        —
```

Статусы:
- `[✓]` — зелёный, стадия завершена, время показано
- `[●]` — синий pulse, стадия в работе, live-счётчик задач
- `[○]` — серый, ждёт
- `[⚠]` — красный, needs-human / gate failed
- `[✗]` — красный, cancelled

## Где показывается

1. **Канбан** (`/?project=N`) — сверху над досками, всегда виден
2. **Episode detail** (`/?project=N&tab=acceptance`) — крупно, с метаданными
3. **API** (`GET /api/episode/pipeline?epic_id=N`) — JSON для external consumers

## Данные

Из `episode_workflows`:
```json
{
  "epic_id": 124,
  "stage": "planning",
  "stages": [
    {
      "name": "discovery",
      "status": "completed",
      "started_at": "2026-07-18T06:38:39",
      "completed_at": "2026-07-18T06:42:07",
      "duration_s": 208,
      "task_count": 1,
      "summary": "Brief accepted, decision=go, HYP-1: ≥180s"
    },
    {
      "name": "formalization",
      "status": "completed",
      "started_at": "2026-07-18T06:42:07",
      "completed_at": "2026-07-18T06:50:12",
      "duration_s": 485,
      "task_count": 4,
      "summary": "PRD + SRS + UC + AC, 24 FR, 9 NFR"
    },
    {
      "name": "planning",
      "status": "in_progress",
      "started_at": "2026-07-18T06:50:12",
      "completed_at": null,
      "duration_s": null,
      "task_count": 1,
      "summary": "Planner working on decomposition"
    },
    {
      "name": "development",
      "status": "pending"
    },
    {
      "name": "verification",
      "status": "pending"
    },
    {
      "name": "integration",
      "status": "pending"
    },
    {
      "name": "completed",
      "status": "pending"
    }
  ],
  "needs_human": false,
  "last_gate_error": null
}
```

## Как вычисляются timestamps стадий

Stages НЕ хранятся в БД отдельно. Вычисляются из `activity_log`:

```sql
-- Когда стадия началась:
SELECT created_at FROM activity_log
WHERE entity_type='epic' AND entity_id=?
  AND field_name='episode_stage'
  AND new_value='<stage_name>'
ORDER BY created_at ASC LIMIT 1;

-- Когда завершена (переход к следующей):
SELECT created_at FROM activity_log
WHERE entity_type='epic' AND entity_id=?
  AND field_name='episode_stage'
  AND old_value='<stage_name>'
ORDER BY created_at ASC LIMIT 1;
```

`activity_log` уже записывает каждый `episode_transition` через `logActivity()`
в `lifecycle.ts:150`. Не нужно добавлять новые данные.

## Summary текст

Краткое описание что произошло на стадии. Вычисляется:

| Стадия | Summary |
|---|---|
| discovery | `brief accepted, decision=X, HYP-N: <target>` |
| formalization | `N FR, N NFR, N UC, N AC` (count artifacts) |
| planning | `N dev tasks, N verify tasks, Pattern X` (count tasks by kind) |
| development | `N/N tasks done, N merged` |
| verification | `N/N AC verified, N passed/N failed` |
| integration | `merged to <branch>, commit <sha>` |
| completed | `Total: Nm, N artifacts, N tasks` |

## Реализация

### Backend: `GET /api/episode/pipeline?epic_id=N`

В `tracker-view.mjs` — новый endpoint (~60 строк):

```javascript
app.get('/api/episode/pipeline', (req, res) => {
  const epicId = parseInt(req.query.epic_id);
  const ew = withDb(db => db.prepare('SELECT * FROM episode_workflows WHERE epic_id=?').get(epicId));

  const STAGES = ['discovery','formalization','planning','development','verification','integration','completed'];

  // Найти все stage transitions из activity_log
  const transitions = withDb(db => db.prepare(`
    SELECT old_value, new_value, created_at, summary
    FROM activity_log
    WHERE entity_type='epic' AND entity_id=? AND field_name='episode_stage'
    ORDER BY created_at ASC`).all(epicId));

  // Построить timeline
  const stages = STAGES.map((name, i) => {
    const enterTransition = transitions.find(t => t.new_value === name);
    const exitTransition = transitions.find(t => t.old_value === name);
    const isCurrent = ew.stage === name;
    const isPast = STAGES.indexOf(ew.stage) > i;
    const isFuture = STAGES.indexOf(ew.stage) < i;

    let status = 'pending';
    if (isPast) status = 'completed';
    if (isCurrent) status = 'in_progress';

    return {
      name,
      status,
      started_at: enterTransition?.created_at || null,
      completed_at: exitTransition?.created_at || null,
      duration_s: enterTransition && exitTransition
        ? Math.round((new Date(exitTransition.created_at) - new Date(enterTransition.created_at)) / 1000)
        : null,
      summary: computeStageSummary(epicId, name, status),
      task_count: countTasksByStage(epicId, name),
    };
  });

  res.json({
    epic_id: epicId,
    stage: ew.stage,
    stages,
    needs_human: JSON.parse(ew.metadata || '{}').needs_human || false,
    last_gate_error: JSON.parse(ew.metadata || '{}').last_gate_error || null,
  });
});
```

### Frontend: CSS + HTML (~80 строк)

В `tracker-view.mjs` — новый компонент:

```html
<div class="pipeline-bar" id="pipeline-<%= epicId %>">
  <!-- Генерируется из GET /api/episode/pipeline -->
  <!-- Каждая стадия = div.pipeline-stage -->
  <!-- Связи = div.pipeline-arrow -->
</div>
```

CSS:
```css
.pipeline-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 12px 20px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
  overflow-x: auto;
}

.pipeline-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 16px;
  border-radius: 8px;
  min-width: 100px;
  font-size: 12px;
  color: #8b949e;
}

.pipeline-stage.completed { background: rgba(35, 134, 54, 0.15); color: #3fb950; }
.pipeline-stage.in_progress { background: rgba(56, 139, 253, 0.15); color: #58a6ff; animation: pulse-blue 2s infinite; }
.pipeline-stage.needs_human { background: rgba(248, 81, 73, 0.15); color: #f85149; animation: pulse-red 1s infinite; }
.pipeline-stage.cancelled { background: rgba(248, 81, 73, 0.15); color: #f85149; }
.pipeline-stage.pending { opacity: 0.4; }

.pipeline-arrow {
  color: #30363d;
  font-size: 14px;
  flex-shrink: 0;
}

.pipeline-stage .duration {
  font-size: 10px;
  opacity: 0.7;
  margin-top: 2px;
}

.pipeline-stage .summary {
  font-size: 10px;
  opacity: 0.6;
  margin-top: 2px;
  text-align: center;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes pulse-blue {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

@keyframes pulse-red {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

JS: polling каждые 5 сек (уже есть RELOAD_SEC=5 на канбане):
```javascript
async function refreshPipeline(epicId) {
  const data = await fetch(`/api/episode/pipeline?epic_id=${epicId}`).then(r => r.json());
  const html = data.stages.map((s, i) => {
    const icon = s.status === 'completed' ? '✓' :
                 s.status === 'in_progress' ? '●' :
                 s.status === 'needs_human' ? '⚠' : '○';
    const cls = data.needs_human && s.status === 'in_progress' ? 'needs_human' : s.status;
    const dur = s.duration_s ? formatDuration(s.duration_s) : '';
    return `<div class="pipeline-stage ${cls}">${icon} ${capitalize(s.name)}<span class="duration">${dur}</span><span class="summary">${s.summary || ''}</span></div>`;
  }).join('<div class="pipeline-arrow">→</div>');
  document.getElementById(`pipeline-${epicId}`).innerHTML = html;
}
```

## Дополнительно: multiple episodes

Если в проекте несколько эпизодов — показать несколько pipeline bars.
Актуальный (in_progress) — раскрыт. Завершённые — collapsed.

## Что НЕ нужно

- WebSockets — polling достаточно (5 сек)
- Сохранение timeline в отдельной таблице — activity_log уже есть
- Анимации перехода — CSS pulse достаточно

## Интеграция с оркестратором

Pipeline UI — **только для отображения**. Не управляет потоком.
Оркестратор (движок 3.0) управляет. Pipeline показывает результат.

Но: если `needs_human=true` — pipeline показывает ⚠ + кнопку Resume рядом.
Кнопка Resume вызывает `POST /api/episode/resume` (из плана 3.0).

## Файлы

- `tracker-view/tracker-view.mjs` — endpoint + HTML template + CSS + JS
- Никаких изменений в `src/` — только frontend
