# WORKSHOP-STATUS — живой статус по-цехового тестирования

> **Для любой сессии/агента:** этот файл — первая точка входа. Читай его, чтобы
> узнать состояние завода, НЕ трогая ничего. Обновляется оператором или
> рабочей сессией после каждого значимого события (прогон/остановка/инцидент).

**Обновлено:** 2026-08-15 12:29 UTC (P07/W2: ✖)
**Текущая фаза:** Раунд W2 Formalization (переход 08:46; W1 закрыт 20/20 GO; W2-монитор временный активен)
**Пространство:** одна БД `.factory-testbed/factory.sqlite`, фронт `http://localhost:4321`
**Модель:** `qwen/qwen3.6-35b-a3b` (LM Studio :1234), параллелизм строго 1, один проект одновременно

## Сетка прогресса 20×3

Легенда: `⬚` не начинался · `🔄` идёт · `✅` pass (граница §4.5 чистая) ·
`✖` fail · `⏸` приостановлен · `↻` перезапуск из снапшота. Колонка W = цех.

| PID | Проект | Тир | W1 Discovery | W2 Formaliz. | W3 Development | Примечание |
|---|---|---|---|---|---|---|
| P01 | counter | XS | ✅ | ✅ | ⬚ | граница dirty (1 карт.) |
| P02 | stopwatch | XS | ✅ | ✖ | ⬚ | fail |
| P03 | tips | XS | ✅ | ✅ | ⬚ | граница dirty (1 карт.) |
| P04 | themes | XS | ✅ | ✅ | ⬚ | граница dirty (1 карт.) |
| P05 | todo | S | ✅ | ✅ | ⬚ | граница dirty (1 карт.) |
| P06 | units | S | ✅ | ✅ | ⬚ | граница dirty (1 карт.) |
| P07 | snake | S | ✅ | ✖ | ⬚ | fail |
| P08 | pomodoro | S | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P09 | kanban | M | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P10 | expenses | M | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P11 | markdown | M | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P12 | typing | M | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P13 | mars | L | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P14 | sortviz | L | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P15 | sudoku | L | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P16 | tetris | L | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P17 | sheets | XL | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P18 | elite | XL | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P19 | mario3d | XXL | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P20 | interp | XXL | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |

## Экспресс-проверка из любой сессии (read-only, копипаст)

Все команды из корня репо. Ничего не меняют.

```bash
# 1. Трекер жив? (и какая БД у него)
curl -s http://localhost:4321/api/heartbeat

# 2. LM Studio жив + модель + контекст
curl -s --max-time 3 http://localhost:1234/v1/models | grep -o 'qwen/qwen3.6-35b-a3b' | head -1

# 3. Движки/воркеры сейчас (пусто = завод стоит)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'orchestrate-cli|claude.*--bare' } | Select-Object ProcessId,Name | Format-Table -HideTableHeaders"

# 4. Сводка по всем проектам: lifecycle + карточки + последний heartbeat
node -e "
const D=require('better-sqlite3');
const db=new D('.factory-testbed/factory.sqlite',{readonly:true});
for(const r of db.prepare(\`
  SELECT p.id pid, substr(p.name,1,18) name, lr.id lrid, lr.status lc, lr.current_stage_id stage,
    (SELECT count(*) FROM tasks t WHERE t.epic_id=(SELECT max(id) FROM epics e WHERE e.project_id=p.id)) tasks,
    (SELECT count(*) FROM tasks t WHERE t.epic_id=(SELECT max(id) FROM epics e WHERE e.project_id=p.id) AND t.status='done') done,
    (SELECT max(heartbeat_at) FROM worker_executions we WHERE we.project_id=p.id) hb
  FROM projects p
  LEFT JOIN factory_order_runs c ON c.order_ref=(SELECT min(order_ref) FROM factory_orders WHERE project_id=p.id)
  LEFT JOIN factory_lifecycle_runs lr ON lr.id=c.lifecycle_run_id
  ORDER BY p.id\`).all())
  console.log(String(r.pid).padEnd(3), r.name.padEnd(18), ('L'+(r.lrid??'-')).padEnd(5), String(r.lc??'-').padEnd(10), String(r.stage??'-').padEnd(24), (r.done+'/'+r.tasks).padEnd(7), 'hb:', r.hb??'-');
db.close();"

# 5. Артефакты по проекту N (epic = последний эпик проекта)
node -e "
const D=require('better-sqlite3');
const db=new D('.factory-testbed/factory.sqlite',{readonly:true});
const pid=process.argv[1]||1;
const epic=db.prepare('SELECT max(id) id FROM epics WHERE project_id=?').get(pid).id;
for(const r of db.prepare('SELECT type,status,count(*) n FROM artifacts WHERE epic_id=? GROUP BY type,status ORDER BY type').all(epic)) console.log(r.type.padEnd(10), r.status, 'x'+r.n);
db.close();" <N>
```

Доска человеческим глазом: `http://localhost:4321/?project=<PID>` ·
сводка всех: `http://localhost:4321/` · админка: `/admin`.

## Правила для наблюдающей сессии

1. **Read-only.** Не kill'ить процессы, не resume'ить, не трогать БД. Любое
   вмешательство — только через оператора или рабочую сессию (кто ведёт прогон).
2. Отчёт — в формате цепочки цехов (quickstart §7a):
   `Discovery ✅ | Formalization 🔄 use-cases | Development ⬚` + одна строка
   деталей (номер карточки, heartbeat свежесть, аномалия).
3. `hb` старше ~5 мин при живом движке = подозрение на спин KI-1 — сообщить,
   не лечить самостоятельно (если ты не рабочая сессия с watchdog).
4. После завершения наблюдения — НЕ обновляй этот файл, если тебя не просили
   (обновляет рабочая сессия/оператор, чтобы не было двух писателей).

## Последние события (журнал-хвост, новые сверху)

| Время (UTC) | Событие |
|---|---|
| 2026-08-15 10:28 | P03 W2 ✅ 28m. P04: 25-мин лиз-гонка перезапусков (TB-7, self-healed), formalization идёт (product-contract ✅, use-cases 🔄) |
| 2026-08-15 09:45 | W2: P01 — первый полный PASS формализации (SRS accepted). P02 — terminal FAIL FORMALIZATION_ACCEPTANCE_HASH_DRIFT (TB-6: редактирование UC-черновика между двумя accept-гейтами). P03 идёт |
| 2026-08-15 08:46 | W1 РАУНД ЗАВЕРШЁН: 20/20 PASS (~90 мин). Гейт GO. Снапшот W2-round-start. W2-очередь + временный W2-монитор запущены |
| 2026-08-15 08:35 | Слепой ревью W1-артефактов (P01–P14): 21.8/25 ср, 0 фатальных; «условного» вердикта W2-готовности; полный отчёт W1-BLIND-REVIEW.md |
| 2026-08-15 07:57 | W1: P01–P05 ✅ (все dirty-1), P06 🔄. Инциденты: TB-2 spin ×3 (root-caused: SQLite busy-spin), TB-3 env, TB-4 psKill-суицид (fixed), клинап процессов. Harness: авто-ворекавери stall→kill→resume |
| 2026-08-15 | План согласован; список обновлён играми (snake/tetris/elite/mario3d); мониторинг-док создан |
| 2026-08-13 | Эталонный прогон mars-ballistic (отдельная БД): Discovery+Formalization до SRS, инциденты KI-1..KI-5 |
