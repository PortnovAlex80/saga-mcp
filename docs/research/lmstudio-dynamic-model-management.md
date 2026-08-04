# LM Studio Dynamic Model Management — Research Findings

**Дата:** 2026-07-20
**Гипотеза для проверки:** saga-mcp может менять модели per-task на сервере 2×RTX-3090
через REST API LM Studio.
**Главный вывод:** Гипотеза **технически осуществима**. У saga уже есть ~70%
инфраструктуры (per-episode `active_model` в metadata, atomic `settings.json`
switching, env-based per-worker routing). Не хватает lifecycle load/unload
(~150-250 LoC) и per-task-kind model policy (~50 LoC).

---

## 0. Контекст

Сейчас saga запускает **одну модель статически** (qwen3.6-35b-a3b@q4_k_xl с
контекстом 262144). Гипотеза: менять модель под тип задачи.

- Лёгкие задачи (verification, simple edits) → маленькая быстрая модель
- Тяжёлые задачи (Lighthouse optimization, refactor) → большая медленная
- Возможно **две маленькие модели параллельно** (по одной на GPU)
- Контекст per-task (меньше = быстрее)
- GPU/CPU layer split per-task
- Thinking budget per-task

---

## 1. LM Studio model lifecycle API

### 1.1 Версионирование API — ВАЖНО

LM Studio имеет **два поколения REST API**:

| Поколение | Path prefix | Статус | Что делает saga сейчас |
|---|---|---|---|
| **v0** | `/api/v0/*` | Deprecated, работает в 0.4.x | Эндпоинт `/api/v0/models` возвращает `state` + `loaded_context_length` |
| **v1 (current)** | `/api/v1/*` | Рекомендуется, GA в 0.4.0 | Канонический lifecycle API |

v1 endpoints находятся на `http://localhost:1234/api/v1/*` — **отдельно** от
OpenAI-compatible (`/v1/chat/completions`, `/v1/models`) и Anthropic-compatible
(`/v1/messages`) inference endpoints. Saga сейчас зонлит `/v1/models`
(OpenAI-совместимый, read-only); lifecycle требует другого endpoint.

### 1.2 Endpoints (v1)

| Операция | Method + Path | Body / Notes |
|---|---|---|
| **List models** | `GET /api/v1/models` | Возвращает `models[]`; у каждого `loaded_instances[]` (пусто если не в VRAM). У instance есть `instance_id`. |
| **Load a model** | `POST /api/v1/models/load` | Body: `model_path`, `context_length`, `gpu_offload_ratio` (или `gpu_layers`), `ttl`, `max_concurrent_predictions`. Возвращает новый `instance_id`. |
| **Unload a model** | `POST /api/v1/models/unload` | Body: `{ "instance_id": "<id>" }`. Освобождает VRAM. |
| **Get model status** | `GET /api/v1/models` (filter) | Тот же endpoint — `loaded_instances` length даёт статус. |
| **Update inference params** | per-request через `/v1/messages` | `temperature`, `top_p`, `max_tokens`, `reasoning_effort` едут в inference request, не через lifecycle. `context_length` требует unload+reload. |

### 1.3 JIT (Just-In-Time) auto-loading

LM Studio имеет **JIT loading mode**:
- При включении первый `/v1/messages` с `model` указывающим на выгруженную модель
  → **автозагрузка** перед serving.
- Request может нести `ttl` для контроля времени жизни.

Это **самый чистый механизм** для паттерна saga "разный `--model` per worker":
saga не нужно явно вызывать `/load` — просто spawn'ит worker с `--model <id>`
и LM Studio грузит по требованию.

**Caveats:**

- **Issue [#1751](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1751):**
  конкурентные requests в коротком окне, до того как первый закончил loading,
  могут породить **множественные instances одной модели**. Workaround: pre-load
  через `/api/v1/models/load` (atomic, возвращает `instance_id`) перед параллельными
  inference requests.
- **Issue [#1463](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1463):**
  JIT-loaded models **игнорируют per-model настройки сохранённые в UI**. Только
  параметры переданные явно в request.

### 1.4 Auth

v1 REST API принимает **Bearer token** (`Authorization: Bearer $LM_API_TOKEN`)
когда настроен. Для localhost-only обычно отключён; saga's placeholder `'lm-studio'`
паттерн работает и для inference, и для v1 lifecycle.

---

## 2. Load-time parameters

Канонический референс: [load endpoint docs](https://lmstudio.ai/docs/developer/rest/load),
CLI mirror [`lms load`](https://lmstudio.ai/docs/cli/local-models/load),
SDK type [`LLMLoadModelConfig`](https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config).

| Parameter | REST field | Effect | Default | Recommended для 2×3090 |
|---|---|---|---|---|
| **Context length** | `context_length` | KV cache size. **Доминирующий VRAM driver.** | Model max (262144) | **32768 для dev, 65536 для refactor, 262144 только для Lighthouse.** |
| **GPU offload ratio** | `gpu_offload_ratio` (0.0-1.0) или `gpu_layers` (count) | Доля transformer layers на GPU. `1.0` = full offload. | `1.0` | `1.0` для всего что влезает в VRAM |
| **TTL** | `ttl` (ms) | Auto-unload после этого idle времени. | App setting | **60000 (60s)** для dev workers |
| **Max concurrent predictions** | `max_concurrent_predictions` | Continuous-batching fanout в одном instance. | 1 | **1** для saga |
| **Main GPU** | Multi-GPU policy (0.3.14+) | Какие физические GPU. Через UI/policy. | All | Per-GPU model pinning для qwen+gemma |
| **Tensor split** | Multi-GPU allocation strategy | Как резать одну модель между GPU. | Even | Even для одной модели на двух 3090 |
| **KV cache to GPU** | (load param) | KV cache в VRAM или host RAM. | On | **On** |
| **VRAM cap strict** | (policy) | Отказ если estimate > cap. | Off | **On** — предотвращает OOM |
| **Reasoning effort** | `reasoning_effort` на `/v1/messages` | `none`/`low`/`medium`/`high`. Per-request. | Per-model UI | See §5 — buggy, проверять |

**Поля НЕ в REST API:**

- `num_cpu_expert_layers` для MoE — не exposed. Expert placement решает
  llama.cpp из GGUF metadata; косвенно через `gpu_offload_ratio`.
- `tensor_split` array — в policy UI, не в per-load REST field в 0.4.x.
- `num_batch`, `num_predict` — llama.cpp batch knobs, под "Advanced" в UI,
  **не в документированном v1 REST schema**.

---

## 3. Multi-model coexistence

### 3.1 Две модели одновременно? — ДА

LM Studio 0.3.x добавил multi-model sessions в playground; 0.4.x exposed то же
через API. Один LM Studio server может держать несколько моделей одновременно,
`model` field на `/v1/messages` маршрутизирует request к нужному instance.

### 3.2 Routing по `model` field

`POST /v1/messages` выбирает модель через `model` field:
- **Модель загружена** → request обслужен этим instance.
- **Не загружена, JIT enabled** → auto-load, потом serve. Первый request платит
  load latency.
- **Не загружена, JIT disabled** → error. Saga должна вызвать `/api/v1/models/load`.

Это **ровно хук для saga**: сейчас saga ставит `--model <id>` per worker
(уже в `claude-runner.mjs` l. 347); LM Studio маршрутизирует оттуда.

### 3.3 Memory math для 2×3090 (48 GB total VRAM)

Используя измерение с проекта ("24.87 GB model + 5.91 GB context @ 262144 =
30.78 GB" для q4_k_xl) и масштабируя context линейно с `context_length`:

| Конфигурация | Model GB | Context GB | **Total GB** | Влезает в 48 GB? |
|---|---|---|---|---|
| qwen3.6-35b q4, ctx 262144 | 24.87 | 5.91 | **30.78** | Да (одна модель, обе GPU, ~17 GB запас) |
| qwen3.6-35b q4, ctx 32768 (÷8) | 24.87 | ~0.74 | **~25.6** | Да |
| qwen3.6-35b q4, ctx 65536 (÷4) | 24.87 | ~1.48 | **~26.4** | Да |
| qwen3.6-35b q6, ctx 262144 | ~36 | ~5.91 | **~42** | Да, но впритык |
| qwen3.6-35b q6, ctx 32768 | ~36 | ~0.74 | **~36.7** | Да |
| gemma-4-12b q4 (estimate) | ~7-8 | ~0.7 @ 32768 | **~8-9** | Да |
| **qwen3.6-35b q4 + gemma-4-12b** одновременно (qwen @ 32768) | 25.6 + 9 | — | **~34.6** | **Да — ~13 GB запаса. Рекомендуемая dual-model конфигурация.** |
| Две qwen3.6-35b q4 @ 32768 одновременно | 25.6 × 2 | — | **~51** | **Нет — OOM на ~3 GB** |
| Две gemma-4-12b @ q4 | ~9 × 2 | — | **~18** | Да, легко |

**Выводы:**

1. **Один qwen + одна маленькая модель (gemma-4-12b) сосуществуют комфортно.**
   Это реалистичная "two-model" цель.
2. **Две qwen3.6-35b instances НЕ помещаются** без уменьшения context ниже 16k
   или перехода на более тяжёлый quant (q3/q2 — потеря качества).
3. Уменьшение context — **самый большой рычаг**: 262144 → 32768 освобождает
   **~5 GB** на instance qwen.
4. **Рекомендация:** saga default `context_length=32768` для dev tasks, 262144
   только для задач с тегом `lighthouse`/`large-refactor`.

### 3.4 Two-small-models-per-GPU сценарий

- GPU 0 = qwen3.6-35b q4 (25.6 GB) — заполняет GPU 0 + ~2 GB переливается на GPU 1.
- GPU 1 = gemma-4-12b q4 (9 GB) — влезает с ~15 GB запасом.

Работает, но **qwen переливается через GPU-границу**. Для чистой "одна модель
на GPU" изоляции — либо (a) меньше MoE (qwen3.6-30b-a3b @ q3 помещается в 24 GB),
либо (b) per-GPU model pinning policy.

---

## 4. Claude Code CLI interaction

### 4.1 Что уже есть в saga

- **`getActiveModel(epicId)`** (runner l. 342) читает `episode_workflows.metadata.active_model`.
- При `provider==='lmstudio'` runner ставит per-worker env и `--model <id>`.
- `POST /api/model/set` atomically swap'ает `~/.claude/settings.json`.
- Pump loop читает `active_model_limit` для cap concurrency per model.

**Saga уже реализует per-episode model selection.** Чего нет для гипотезы
(per-task-kind selection + lifecycle) — в §7.

### 4.2 Поведение при unload mid-session

Самый рисковый сценарий. Из модели LM Studio + Claude Code:
- Claude Code зовёт `POST /v1/messages` per turn. Если модель выгружена между
  turn'ами → либо JIT reload (10-30s extra latency), либо 404.
- Claude Code's retry behavior (docs) handles 429 и 5xx с backoff, но 404
  "model not found" → fatal → worker exits non-zero → saga's `recoverAssignment`
  re-queues task. **Потеря in-flight work.**
- **Safe rule для saga:** никогда не unload'ить модель пока worker с `--model`
  соответствующим ей — в `run.active`.

### 4.3 Auto-load когда `--model` указывает на выгруженную

Да, **если JIT enabled**. Иначе saga должна `POST /api/v1/models/load` перед
spawn'ом worker'а.

**Рекомендация:** включить JIT в LM Studio **и** иметь saga pre-load явно когда
load-latency бюджет позволяет. JIT — safety net; explicit load — deterministic path.

---

## 5. Thinking / reasoning budget

### 5.1 Mechanism

LM Studio добавил `reasoning_effort` support на `/v1/messages`. Зеркалит OpenAI's
enum: `none`/`low`/`medium`/`high`. Qwen3 thinking mode отвечает на это.

Отдельного `thinking_budget` field **нет**. Closest upstream — Alibaba's
`thinking_budget` (Qwen3 в thinking mode), но LM Studio surfaces только 4-level
`reasoning_effort`.

### 5.2 Баги проверять на вашем build

Три GitHub issues предупреждают что `reasoning_effort` / `enableThinking` через
API исторически **игнорируется** в пользу per-model UI setting:
- [#988](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/988)
- [#1559](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1559)
- [#1990](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1990)

**Saga должна verify на своём build** перед reliance.

### 5.3 Interaction с `--effort xhigh`

Saga runner передаёт `--effort xhigh` каждому claude invocation (l. 361).
Mapping `xhigh → high` на LM Studio стороне. Если LM Studio игнорирует (§5.2) —
fallback на UI-configured default.

**Рекомендация:** сделать `--effort` per task-kind. Verification → `low`/`none`;
complex refactor → `xhigh`. One-line change после определения mapping.

### 5.4 Speed impact

Disable thinking на Qwen3 убирает всю thinking-token phase. Saga видела
thinking peaks 15000+ tokens. At ~50 tok/s (RTX 3090) это ~300 секунд генерации
skip'ается. **Для verification задач disable thinking — крупнейший speedup,
5-10× wall-clock improvement на коротких задачах.** Больше чем любой context/model swap.

---

## 6. Performance order-of-magnitude

±50%, не официальные benchmarks.

### 6.1 Load / unload times

| Операция | Время | Source |
|---|---|---|
| Cold load qwen3.6-35b q4 from NVMe в 2×3090 | **15-30 s** | [low.li](https://low.li/story/2026/06/running-qwen-3-6-27b-locally-a-quality-build-for-rtx-3090-owners/) |
| Warm reload (OS cache hot) | 8-15 s | Estimate |
| Unload | **<1 s** | Просто drop allocation |
| LM Studio overhead vs raw llama.cpp | +3-4× cold load, +3-8% slower inference | [#1499](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1499), [aibytes.blog](https://aibytes.blog/benchmarks/local-llm-speed-test-ollama-vs-lm-studio-vs-llamacpp) |

**Scheduling:** swap стоит ~20-30s. Задачи короче 60s на маленькой модели — не
стоит swap'ать. **Policy: swap eagerly на episode boundaries, lazily на task boundaries.**

### 6.2 Inference throughput на 2×3090

| Модель + config | tok/s | Source |
|---|---|---|
| qwen3.6-35b q4, single 3090, full offload | 30-50 | [r/LocalLLM](https://www.reddit.com/r/LocalLLM/comments/1ti9w4o/) |
| qwen3.6-35b q4, 2×3090, full offload | ~60-100 | Estimate |
| qwen3.6-35b q4, single 3090, full 262k context, optimized | up to 112 tok/s | [Medium](https://medium.com/@CodePulse/one-rtx-3090-112-tokens-per-second-full-262k-context-no-api-bill-304f60029bb6) (best-case) |
| gemma-4-12b-class q4 на одной 3090 | 100-200 | Order-of-magnitude |

### 6.3 Context-length impact

Уменьшение `context_length` освобождает VRAM, но **не меняет dramatically tok/s**
для коротких prompts. tok/s доминирует layer count + batch size, не KV cache size.

**Win от smaller context:**
1. **Меньше VRAM** → multi-model coexistence.
2. **Ниже TTFT для очень длинных промптов** — 200k prompt быстрее против 32k
   cache чем 262k.

**Не ждать 5-10× tok/s gain** от одного context-shrink. 5-10× gains приходят от:
(a) disable thinking, (b) smaller model.

---

## 7. Конкретное предложение для saga-mcp

### 7.1 Что уже есть (no work)

- Per-episode `active_model` / `active_provider` / `active_model_limit`.
- Atomic `settings.json` swap с fsync + readback verify.
- Per-worker env injection для LM Studio routing.
- `--model <id>` per worker spawn.
- Natural-rotation concurrency cap by `active_model_limit`.
- Live `GET /v1/models` probe.

### 7.2 Чего не хватает — 4 gap'а

**Gap A: Нет load/unload lifecycle calls.** Saga зонлит `/v1/models` (read-only),
никогда не зовёт `/api/v1/models/load`. Полагается на JIT. Ломается для per-task-kind
swap из-за [#1751](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1751).

**Gap B: Model selection — per-episode, не per-task-kind.** Verification, dev,
review — все на одной модели.

**Gap C: Нет `context_length` policy.** Workers наследуют 262144.
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144` захардкожен (runner l. 396).

**Gap D: `--effort xhigh` захардкожен** (runner l. 361).

### 7.3 Где живёт логика — `claude-runner.mjs`

Все 4 gap'а закрываются внутри `tracker-view/claude-runner.mjs` + один helper
module. **Не в `orchestrate.ts`** (engine policy layer), **не в `tracker-view.mjs`**
(UI server). Runner — правильное место: владеет spawn boundary, уже знает
`getActiveModel`.

```
tracker-view/
  claude-runner.mjs           (+~120 LoC: loadBeforeSpawn, unloadIfCold,
                               context-token override, effort per task-kind)
  lmstudio-lifecycle.mjs      (NEW, ~80 LoC: thin client over
                               /api/v1/models/{load,unload,list})
```

Total: **~200 LoC** + ~30-LoC policy table в metadata/константе.

### 7.4 Recommended dispatch policy

```js
const POLICY = {
  'verification.ac':   { model: 'gemma-4-12b@q4',              context: 32768,  effort: 'low'  },
  'formalization.ac':  { model: 'qwen3.6-35b-a3b@q4_k_xl',     context: 65536,  effort: 'medium' },
  'development.code':  { model: 'qwen3.6-35b-a3b@q4_k_xl',     context: 98304,  effort: 'xhigh' },
  'review':            { model: 'qwen3.6-35b-a3b@q4_k_xl',     context: 98304,  effort: 'high' },
  '_default':          { model: 'qwen3.6-35b-a3b@q4_k_xl',     context: 65536,  effort: 'xhigh' },
};
```

Spawn flow:
1. Look up `task.task_kind` в POLICY (fallback на episode `active_model`, потом `_default`).
2. **`loadBeforeSpawn(modelId, { context_length, ttl: 60_000 })`** — call
   `/api/v1/models/load`. Await returned `instance_id`. Сериализует concurrent
   spawns той же модели → [#1751](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1751) не сработает.
3. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` из policy, не хардкод.
4. Заменить хардкод `'--effort', 'xhigh'` на policy value.
5. **Unload** — *не* eagerly. Поставить `ttl: 60_000` на load. Explicit unload
   только когда (a) другой policy tier нужен VRAM и (b) нет активного worker'а
   с matching `--model`.

### 7.5 Scheduling

| Событие | Действие |
|---|---|
| Episode start | Pre-load `_default` — экономит 20-30s на первом worker |
| New worker spawn | `loadBeforeSpawn(policyModel)`. Idempotent если уже загружен |
| Worker close | Ничего. TTL handles eviction |
| Episode pause > 5 min | Optional: explicit unload all instances |
| Model swap mid-episode | Don't unload. Load новую рядом. Unload старую только если VRAM нужен и нет активных workers |

### 7.6 Concurrency adjustment

- One qwen loaded → `concurrency=2` (35B saturates both GPUs)
- qwen + gemma loaded → `concurrency=3` (2 qwen + 1 gemma)
- Pure gemma → `concurrency=4`

Существующий `active_model_limit` field может нести это; policy table просто
sets per-tier.

---

## 8. Open questions — нужны эксперименты на реальном железе

1. **LM Studio version на saga box.** v0.3.x vs v0.4.x определяет `/api/v0/*` vs
   `/api/v1/*` и работает ли `reasoning_effort`. `lms --version` + `GET /api/v1/models`.
2. **Actual cold-load time** для qwen3.6-35b-a3b@q4_k_xl на этом NVMe + 2×3090.
3. **`reasoning_effort=none` реально disable thinking** на установленном build?
   Issues #988, #1990 говорят было проигнорировано.
4. **JIT auto-load срабатывает** когда Claude Code шлёт `--model <id>` для
   выгруженной модели?
5. **[#1751](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1751) воспроизводится** при 2 concurrent workers с тем же `--model`?
6. **Per-GPU model pinning** настроен в multi-GPU policy UI?
7. **Interaction thinking mode + `max_concurrent_predictions > 1`.**
8. **VRAM headroom во время long outputs.** 30.78 GB — для пустого 262k KV cache;
   он *заполняется* во время генерации.
9. **Claude Code's `--effort` mapping.** Что `xhigh` становится on the wire?
10. **Worker crash recovery on mid-task unload.** `recoverAssignment` чисто
    re-queue'ит?

---

## 9. Source list

### LM Studio official
- [REST API overview (v0 → v1)](https://lmstudio.ai/docs/developer/rest)
- [Load — `POST /api/v1/models/load`](https://lmstudio.ai/docs/developer/rest/load)
- [Unload — `POST /api/v1/models/unload`](https://lmstudio.ai/docs/developer/rest/unload)
- [List — `GET /api/v1/models`](https://lmstudio.ai/docs/developer/rest/list)
- [`lms load` CLI](https://lmstudio.ai/docs/cli/local-models/load)
- [`LLMLoadModelConfig`](https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config)
- [Idle TTL and Auto-Evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)
- [Anthropic-compatible endpoints](https://lmstudio.ai/docs/developer/anthropic-compat)
- [Claude Code integration](https://lmstudio.ai/docs/integrations/claude-code)
- [Parallel requests](https://lmstudio.ai/docs/app/advanced/parallel-requests)
- [Multi-GPU controls (0.3.14)](https://lmstudio.ai/blog/lmstudio-v0.3.14)
- [0.4.0 release (multi-model + v1 API)](https://lmstudio.ai/blog/0.4.0)
- [0.4.1 Claude Code blog](https://lmstudio.ai/blog/claudecode)
- [Changelog (reasoning_effort)](https://lmstudio.ai/changelog)

### Claude Code
- [Environment variables](https://code.claude.com/docs/en/env-vars)
- [Error reference](https://code.claude.com/docs/en/errors)

### LM Studio bug tracker
- [#1751 — On-demand loading loads multiple instances](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1751)
- [#1463 — JIT ignores saved per-model settings](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1463)
- [#988 — reasoning_effort via API doesn't work](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/988)
- [#1559 — Qwen 3.5 thinking switch](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1559)
- [#1990 — Qwen3.5 enableThinking=false ignored](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1990)
- [#1499 — Slow inference vs llama.cpp](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1499)
- [#561 — Claude Code uses settings.json not env](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/561)
- [#8500 (claude-code) — env no longer overrides settings.json v2](https://github.com/anthropics/claude-code/issues/8500)

### Benchmarks
- [low.li — Qwen 3.6 27B on RTX 3090 (15-20s load)](https://low.li/story/2026/06/running-qwen-3-6-27b-locally-a-quality-build-for-rtx-3090-owners/)
- [r/LocalLLM — Qwen3.6-35B-A3B-MTP 46-50 tok/s](https://www.reddit.com/r/LocalLLM/comments/1ti9w4o/)
- [Medium — 112 tok/s RTX 3090 262k context](https://medium.com/@CodePulse/one-rtx-3090-112-tokens-per-second-full-262k-context-no-api-bill-304f60029bb6)
- [HuggingFace — Qwen3.6-35B-A3B 120 tok/s](https://huggingface.co/Qwen/Qwen3.6-35B-A3B/discussions/37)
- [aibytes.blog — llama.cpp vs Ollama vs LM Studio](https://aibytes.blog/benchmarks/local-llm-speed-test-ollama-vs-lm-studio-vs-llamacpp)
- [Salad — Qwen 3.5 small models on 3090](https://blog.salad.com/qwen-3-5-small-models-on-saladcloud-benchmarks-cost-and-why-you-dont-need-a-mac-mini/)
- [r/LocalLLaMA — multi-model LM Studio](https://www.reddit.com/r/LocalLLaMA/comments/1biqck7/)
- [Alex Ewerlöf — local LLMs for agentic coding](https://blog.alexewerlof.com/p/local-llms-for-agentic-coding)
- [Alibaba — thinking_budget](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)

### Saga source inspected
- `tracker-view/claude-runner.mjs` (l. 89-125, 326-525)
- `tracker-view/tracker-view.mjs` (l. 5213-5532)
- `docs/research/00-research-charter-v1-final.md`

---

## 10. Bottom line

Гипотеза держится. Saga-mcp может реализовать per-task-kind model selection на
2×3090 с ~200 LoC нового кода в `claude-runner.mjs` + тонкий
`lmstudio-lifecycle.mjs` client.

**Самая ценная оптимизация — disable thinking для verification tasks**
(~5-10× wall-clock saving), за ней — **drop context_length до 32768 для routine
dev work** (free ~5 GB VRAM, даёт qwen + gemma coexistence). Swap стоит ~20-30s
→ делать на episode boundaries, не per-task.

Verify 10 open questions на реальном железе перед commit к policy table в §7.4.
