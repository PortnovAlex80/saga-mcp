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

- палитра узлов ядра (`emit`, `template`, `collect`, `fail`) — перетащить или кликнуть;
- связывание выход → вход, инспектор JSON-параметров узла;
- кнопка **JSON**: выгрузить текущий стол как `graph_json` (тот самый формат,
  который исполняет ядро `src/kernel/`) и импортировать обратно;
- позиции узлов сохраняются в `graph_json` (`position`) — ядро их игнорирует.

## Дальше (по плану)

- кнопка **Run** → HTTP-мост к ядру (`factory_start`) и раскраска узлов
  статусами из журнала событий (W2);
- формы параметров из `parametersSchema` реестра node-types вместо JSON-текстарии;
- панель оператора (канбан, `human_required` очередь) — фаза A.
