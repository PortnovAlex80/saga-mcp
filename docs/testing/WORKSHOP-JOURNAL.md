# Журнал по-цехового тестирования

Формат entry (одна строка таблицы на прогон; расшифровки полей — в WORKSHOP-TEST-PLAN.md §7):

```
| PID | Цех | DB | Начало | Длительность | Outcome | Воркеры (всего/lost/repair) | Рестарты движка | Артефакты | Аномалии |
```

Outcome: `pass` (stage terminal + критерий капсулы §4.5) / `fail:<код>` / `stuck`.

Дополнительные заметки по прогону — в `.factory-testbed/runs/<PID>/journal.md`.

---

## Раунд W1 — Discovery (20 прогонов)

| PID | Цех | DB | Начало | Длительность | Outcome | Воркеры | Рестарты | Артефакты | Аномалии |
|---|---|---|---|---|---|---|---|---|---|
| P20 | W1 | shared | 08:42 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P19 | W1 | shared | 08:38 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P18 | W1 | shared | 08:35 | 4m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P17 | W1 | shared | 08:32 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P16 | W1 | shared | 08:28 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P15 | W1 | shared | 08:24 | 4m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P14 | W1 | shared | 08:21 | 4m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P13 | W1 | shared | 08:17 | 4m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P12 | W1 | shared | 08:14 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P11 | W1 | shared | 08:10 | 4m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P10 | W1 | shared | 08:07 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P09 | W1 | shared | 08:04 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P08 | W1 | shared | 08:01 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P07 | W1 | shared | 07:58 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P06 | W1 | shared | 07:55 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P05 | W1 | shared | 07:48 | 6m | pass (dirty:1) | 3exited/1lost/1running | 0 | — | — |
| P04 | W1 | shared | 07:48 | 0m | pass (dirty:1) | 2exited/1lost/1running | 0 | — | — |
| P04 | W1 | shared | 07:42 | 3m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P03 | W1 | shared | 07:36 | 6m | pass (dirty:1) | 2exited/1running | 0 | — | — |
| P01 | W1 | shared | 07:15 | ~16m | pass (dirty:1) | 2 | 2 (TB-2 spin; TB-3 env) | brief:1 | harness краш после stop (без Result-блока) — docs вручную; движок спин TB-2 на verifying |
| P02 | W1 | shared | 07:30 | ~4m | pass (dirty:1) | 2 | 0 | — | Discovery за ~4 мин; тот же harness-краш после stop |
| P03 | W1 | shared | 07:33 | 6m | pass (dirty:1) | 2 | 1 (TB-2 spin #3 на verifying; resume вылечил) | — | первый PASS с Result-блоком после фикса harness |

### Сводка W1 (2026-08-15 08:45 UTC — РАУНД ЗАВЕРШЁН)
- **pass/fail/stuck: 20/0/0 (100%)** — порог 16/20 превышен
- Время: суммарно ~90 мин на 20 проектов (среднее ~3.5 мин, медиана 3 мин; P01 дольше всех ~16 мин из-за инцидентов)
- lost-воркеров: 2 (оба штатно repair'нулись); spin-зависаний TB-2: 3 (P01, P03, mars-эталон; оба testbed-случая вылечены kill+resume)
- Инциденты раунда: TB-1 (schema), TB-2×2 (root-caused: SQLite busy-spin), TB-3 (env), TB-4 (tooling), TB-5 (dead artifact)
- Качество (слепой ревью P01–P14): 21.8/25 (87%), 0 фатальных, вердикт W2 «условно» → см. W1-BLIND-REVIEW.md
- Гейт W1→W2: ✅ **GO**

## Раунд W2 — Formalization (вход из C1)

| P01 | W2 | shared | 08:46 | 37m | **pass** (полная цепочка: PRD→FR→UC→AC→SRS accepted) | ~14 | 0 | SRS:1 и вся WHAT-цепочка | первый полный W2-pass |
| P02 | W2 | shared | 09:23 | 12m | **fail: FORMALIZATION_ACCEPTANCE_HASH_DRIFT** (TB-6) | ~8 | 0 | PRD:1, UC частично | гонка repair/gate на UC; см. BUGS |


| PID | Цех | DB | Начало | Длительность | Outcome | Воркеры | Рестарты | Артефакты | Аномалии |
|---|---|---|---|---|---|---|---|---|---|
| P12 | W2 | shared | 15:06 | 0m | fail | 3exited/1lost | 0 | FR:1,NFR:1,PRD:1,RULE:1,brief:1 | {"status":"failed","current_stage_id":"s |
| P08 | W2 | shared | 15:06 | 0m | pass | 12exited/2lost | 0 | AC:19,FR:6,NFR:3,PRD:1,RULE:1,SRS:1,UC:3,brief:1 | — |
| P11 | W2 | shared | 14:55 | 0m | fail | 3exited/1lost | 0 | FR:6,NFR:1,PRD:1,RULE:1,brief:1 | {"status":"failed","current_stage_id":"s |
| P10 | W2 | shared | 14:55 | 0m | fail | 3exited/1lost | 0 | FR:7,NFR:1,PRD:1,RULE:1,brief:1 | {"status":"failed","current_stage_id":"s |
| P10 | W2 | shared | 14:15 | 33m | stalled | 3exited/1lost | 0 | FR:7,NFR:1,PRD:1,RULE:1,brief:1 | no change since 2026-08-15T14:39:56.994Z |
| P09 | W2 | shared | 14:12 | 3m | fail | 8exited/1lost | 0 | AC:18,FR:1,NFR:1,PRD:1,RULE:1,UC:8,brief:1 | {"status":"failed","current_stage_id":"s |
| P08 | W2 | shared | 12:29 | 30m | pass (dirty:1) | 12exited/1lost/1running | 0 | AC:19,FR:6,NFR:3,PRD:1,RULE:1,SRS:1,UC:3,brief:1 | — |
| P07 | W2 | shared | 12:03 | 26m | fail | 10exited/1lost | 0 | AC:42,FR:9,NFR:2,PRD:1,RULE:1,UC:6,brief:1 | {"status":"completed","current_stage_id" |
| P06 | W2 | shared | 11:20 | 42m | pass (dirty:1) | 14exited/2lost/1running | 0 | AC:10,FR:26,NFR:2,PRD:1,RULE:1,SRS:1,UC:7,brief:1 | — |
| P05 | W2 | shared | 10:46 | 35m | pass (dirty:1) | 13exited/3lost/1running | 0 | AC:32,FR:8,NFR:2,PRD:1,RULE:2,SRS:1,UC:8,brief:1 | — |
| P04 | W2 | shared | 10:26 | 19m | pass (dirty:1) | 12exited/4lost/1running | 0 | AC:11,FR:4,NFR:1,PRD:1,RULE:1,SRS:1,UC:4,brief:1 | — |
| P03 | W2 | shared | 09:34 | 28m | pass (dirty:1) | 12exited/1lost/1running | 0 | AC:9,FR:6,NFR:1,PRD:1,RULE:1,SRS:1,UC:3,brief:1 | — |
| P02 | W2 | shared | 09:23 | 12m | fail | 8exited/1lost | 0 | FR:1,NFR:1,PRD:1,RULE:1,UC:4,brief:1 | {"status":"failed","current_stage_id":"s |
| P01 | W2 | shared | 08:46 | 37m | pass (dirty:1) | 14exited/2lost/1running | 0 | AC:16,FR:5,NFR:1,PRD:1,RULE:1,SRS:1,UC:5,brief:1 | — |
| — | — | — | — | — | — | — | — | — | — |

### Сводка W2
- pass/fail/stuck: —/—/—; trace-покрытие 100% у N/20
- Семантический спот-чек (4 проекта: P02, P08, P14, P19): —
- Гейт W2→W3: ⬚ Go ⬚ No-Go

## Раунд W3 — Development (вход из C2)

| PID | Цех | DB | Начало | Длительность | Outcome | Воркеры | Рестарты | Артефакты | Аномалии |
|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — | — |

### Сводка W3
- pass/fail/stuck: —/—/—; билдится N/20; evidence у всех AC: N/20
- Порог сложности модели (последний тиры pass): —
