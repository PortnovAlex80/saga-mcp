# Saga5 Desk (W1 skeleton)

Визуальный стол конвейера — React + React Flow (`@xyflow/react`, MIT).
Порт фазы W1 из [SAGA5-REBUILD-PLAN.md](../docs/plans/SAGA5-REBUILD-PLAN.md):
палитра узлов, связывание, инспектор параметров, сериализация в `graph_json`.

## Запуск

```bash
cd desk
npm install
npm run dev   # http://localhost:5173
```

## Что умеет v0

- палитра узлов ядра (`emit`, `template`, `collect`, `fail`, `llm`) — перетащить или кликнуть;
- связывание выход → вход, инспектор JSON-параметров узла;
- кнопка **JSON**: выгрузка/импорт `graph_json` (тот самый формат, который
  исполняет ядро `src/kernel/`);
- кнопка **Run**: прогон через мост ядра (см. ниже), поллинг статуса рана;
- позиции узлов сохраняются в `graph_json` (`position`) — ядро их игнорирует.

## Запуск с мостом ядра (M2)

```bash
# терминал 1: мост (ядро + свип + спавн воркеров + статика desk/dist)
DB_PATH=.saga.db npm run bridge      # http://localhost:4455 — тут уже есть собранный desk

# терминал 2 (для живой разработки стола):
cd desk && npm run dev               # http://localhost:5173, /api проксируется на 4455
```

`llm`-узел — активность: режим `mode: 'echo'` работает без сети
(детерминированный воркер), режим `'api'` зовёт OpenAI-совместимый endpoint
через env `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.

## Дальше (по плану)

- overlay прогона: раскраска узлов статусами из журнала событий (W2);
- формы параметров из `parametersSchema` реестра node-types вместо JSON-текстарии;
- панель оператора (канбан, `human_required` очередь) — фаза A.
