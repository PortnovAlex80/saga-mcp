# Saga · Завод изнутри — демо презентации

Кинематографичная визуализация конвейера saga4: **ЗАВОД → ЦЕХ → РАБОЧИЙ СТОЛ**,
в палитре питч-дека (navy `#0A0F1E` + янтарь `#FFB020`). Без сборки и зависимостей.

## Запуск

Любой статический сервер из этой папки:

```bash
node -e "require('http').createServer((q,s)=>{const f=require('fs'),p=require('path');const u=decodeURIComponent(q.url.split('?')[0]);f.readFile(p.join(__dirname,u==='/'?'index.html':u),(e,d)=>{if(e){s.writeHead(404);s.end();return}s.writeHead(200,{'Content-Type':u.endsWith('.css')?'text/css':u.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});s.end(d)})}).listen(8641)"
# → http://localhost:8641/
```

или `python -m http.server 8641`, или просто открыть `index.html` двойным кликом.

## Управление

| Действие | Эффект |
|---|---|
| `Space` / ▶⏸ | пауза-пуск киноленты |
| клик по таймлайну | перемотка на момент |
| `⟲ кинотеатр` | перезапуск ролика (~95 с) |
| `✈ свободный режим` | колесо — зум сквозь уровни, drag — панорама, клик по корпусам/столам — погружение |
| ЗАВОД / ЦЕХ / СТОЛ (сверху), клавиши `1`–`3` | переход на уровень |

## Сценарий (акты)

1. **Завод (0–15с)** — заказ-капсула въезжает в ворота, диспетчер зажигает цеха.
2. **Конструкторское бюро (15–35с)** — столы PRD→SRS→UC/AC, гейты, заморозка
   AC-контракта печатью `sha256:…`.
3. **Рабочий стол (35–70с)** — Metro-верстак: инструменты на pegboard, точные
   материалы с fence, приборы deny-by-default, крафт → **БРАК + дефектная
   ведомость** → ремонт → **ПРИНЯТО** → merge-кран.
4. **Рой (70–95с)** — параллельные worktree-столы, replay ×4 («завод помнит —
   ОТК не спит»), отгрузка `ProductRevision v1.0 · ready-to-run`.

## Словарь кадров ↔ реальный домен saga4

| В кадре | В заводе |
|---|---|
| Рабочий стол | Workplace / Desk (`product_read` / `product_submit`) |
| Робот за столом (бейдж модели) | WorkerExecution; модель ортогональна |
| Поднос с накладной `cs:4471` | CandidateSet (seal + digest) |
| Гейт-арка, клейма ПРИНЯТО/БРАК | GateRun → GateDecision (append-only) |
| Красная дефектная ведомость | RecoveryIssue → возврат на тот же стол |
| Заморозка контракта печатью | hash-frozen AC-контракт |
| Кран-балка, сварка | Effect: Git merge → main (CAS) |
| Шлейфы роботов во втором прогоне | ReplayCapsule HIT; гейты всё равно CURRENT |
| Канбан-доска над столами | tasks.status — проекция, не авторитет |

## Служебные режимы

- `?still=СЕК` — один статичный кадр без анимации (для скриншотов/превью);
  `document.title` получает самодиагностику: `fill/amber/cyan` — доли пикселей
  на canvas (проверка, что сцена реально нарисована).
- Ошибка рантайма показывается красным блоком по центру страницы.

Снять ключевые кадры в PNG (headless Chrome):

```bash
for t in 9 20 33 45 53 57 64 68 77 83 92; do
  "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless \
    --user-data-dir=$(mktemp -d) --window-size=1600,900 --virtual-time-budget=2500 \
    --screenshot="shot-$t.png" "http://localhost:8641/?still=$t"
done
```

## Файлы

- `index.html` — разметка, HUD, субтитры, панель управления
- `demo.css` — стиль питч-дека
- `demo.js` — сцены Factory/Workshop/Desk, режиссёр таймлайна, свободный режим,
  отладочные хуки
