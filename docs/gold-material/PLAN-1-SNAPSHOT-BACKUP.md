# План 1: Snapshot/Backup золотого прогона

## Цель
Сохранить полный слепок factory-прогона (Discovery→Formalization→Development) для воспроизводимого тестирования.

## Что захватить

### Обязательно (критично):
| Объект | Размер | Что содержит |
|--------|--------|-------------|
| `factory.sqlite` (checkpointed) | ~3 MB | 110 таблиц, 26 tasks, 13 capsules, 47 obligations |
| git repo (gc, без node_modules) | ~2 MB | HEAD=fc2299c, 7 веток, интеграционные коммиты |
| `docs/` (golden artifacts) | 1.2 MB | PRD, FR, NFR, UC, AC, RULE, SRS + per-execution traces |
| Worker logs (27 jsonl, gzip) | ~4 MB | GLM-4.7 inference traces: thinking tokens, tool calls |
| 6 module packages | few MB | deterministic replay digest anchors |
| `factory-execution-routes.json` | 105 B | route policy с digest в БД |

### Выкинуть (регенерируемое):
- `node_modules` (41 MB) — `npm ci`
- `coverage/` — дериватив jest
- `.factory-worktrees/` (42 MB) — восстанавливается из git

**Итого: ~10-15 MB** (вместо 66 MB)

## Структура директории

```
tests/golden-runs/production-run-001-20260812/
├── MANIFEST.json           # git anchors, module digests, row counts
├── db/
│   └── factory.sqlite      # post-checkpoint, single file
├── repo/
│   └── product/            # git gc, без node_modules/coverage
├── worker-logs/
│   └── *.jsonl             # 27 файлов из board-runs
├── modules/
│   └── package-store/      # 6 digest directories
├── policy/
│   └── factory-execution-routes.json
└── meta/
    ├── git-refs.txt
    ├── db-row-counts.json
    └── log-path-index.json
```

## Команды создания

```bash
# 1. DB checkpoint (WAL → single file)
node -e "
  const db = new Database('...factory.sqlite');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
"
cp factory.sqlite tests/golden-runs/.../db/

# 2. Git repo (gc + exclude heavy dirs)
cd product && git gc --aggressive --prune=now
rsync -a --exclude node_modules --exclude coverage product/ tests/golden-runs/.../repo/product/

# 3. Worker logs (collect by log_path from DB, not glob)
node -e "
  const db = new Database('...', {readonly:true});
  const paths = db.prepare('SELECT log_path FROM worker_executions WHERE log_path IS NOT NULL').all();
  // copy each path preserving board-ID structure
"

# 4. Module packages (only 6 digests from factory_module_installations)
node -e "
  const db = new Database('...', {readonly:true});
  const digests = db.prepare('SELECT DISTINCT package_digest FROM factory_module_installations').all();
  // copy each from .saga/package-store/<hash[:2]>/<hash[:4]>/<hash>/
"
```

## Восстановление + integrity checks

```bash
# A. Restore DB
cp db/factory.sqlite target/factory.sqlite

# B. Verify anchors
assert(git show-ref == meta/git-refs.txt)
assert(5 integrated_commit hashes match git log)
assert(27 worker_executions.log_path files exist)
assert(integrity_check == 'ok')
assert(route_policy digest matches)
```

## Версионирование

MANIFEST.json содержит:
- `run_id`: production-run-001
- `dev_tip`: c99aaac (git)
- `model`: glm-4.7
- `db_sha256`: <hash>
- `lifecycle`: {discovery: go, formalization: formalized, development: ...}
