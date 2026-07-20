# Agentic Loops — Patterns, Termination, Escalation: Literature Review

**Дата:** 2026-07-20
**Назначение:** теоретическая база для Дыра E (infinite retry) и Дыра E+ (manual hint doesn't scale)
в `investigation-2026-07-20-cannon-development-stage.md`.
**Метод:** WebSearch + WebFetch, фокус на 2024–2026 бумагах и production-фреймворках.

---

## 0. Note on the requested arxiv ID

`arxiv 2606.00001` — это **не** агентская бумага. Это *"Shu Dao: A Calligraphy Score
Framework Linking Calligraphy, Music, and Performance"* (гуманитарная). Бумаги про
agent loops с точно таким ID не существует.

Две релевантные 2026 бумаги, которые почти навернее соответствуют намерению:

- **arxiv 2607.01641** — *"When Agents Do Not Stop: Uncovering Infinite Agentic Loops in LLM Agents"* (canonical IAL paper)
- **arxiv 2606.24937** — *"The Hitchhiker's Guide to Agentic AI: From Foundations to the Frontier"* (практ. survey)

---

## 1. IAL paper (arxiv 2607.01641) — формализация нашей проблемы

**Авторы:** Xinyi Hou, Shenao Wang, et al. (preprint, July 2026).

**Главный тезис.** IAL (Infinite Agentic Loop) — *structural execution failure*
в котором агентский feedback path повторно вызывает LLM/инструменты/агенты,
потому что path **не ограничен эффективно**. Это **не обычный программный баг** —
он возникает из взаимодействия agent logic, framework semantics, runtime
observations и model behavior.

**Два вклада:**
1. **Унифицированная таксономия** — декомпозиция agent architectures и feedback
   paths в категории, объясняющие когда и как формируются IAL (model-tool,
   agent-agent, supervisor-worker, multi-tier handoff loops).
2. **IAL-SCAN** — статический анализатор, нормализующий гетерогенный agent код
   (LangGraph, CrewAI, AutoGen, custom) в framework-independent представление
   и детектирующий unbounded feedback paths. Валидирован на реальных GitHub проектах.

**Импликация для saga.** Наш кейс (worker сделал 106 одинаковых Edit) — **это
IAL**, не Claude bug. Harness (saga) не ограничил feedback path. Наш S1/S2
дизайн — **правильный механизм**: правила IAL-SCAN сводятся к "тот же
`(call, args)` повторён без termination guard".

- Abstract: https://arxiv.org/abs/2607.01641
- Full HTML: https://arxiv.org/html/2607.01641v1

---

## 2. Taxonomy of Agentic Loop Patterns

| Pattern | Citation | Termination? | No-progress detection? |
|---|---|---|---|
| **ReAct** | [Yao 2022, arXiv:2210.03629](https://arxiv.org/abs/2210.03629) | No (модель сама emit `Finish`) | **No** |
| **Plan-and-Execute** | Wang 2023 / LangChain | Implicit (plan completion) | Partial |
| **Reflexion** | [Shinn 2023, arXiv:2303.11366](https://arxiv.org/abs/2303.11366) | Trial cap (paper 6 trials) | **No** (assumes trial делает прогресс) |
| **Tree of Thoughts (ToT)** | [Yao 2023, arXiv:2305.10601](https://arxiv.org/abs/2305.10601) | **Yes** (search ends) | **Yes** (backtrack dead-end) |
| **LATS (Language Agent Tree Search)** | [Zhou 2023, arXiv:2310.04406](https://arxiv.org/abs/2310.04406) | **Yes** (iter cap + tree) | **Yes** (UCB prune) |
| **Voyager** | [Wang 2023, arXiv:2305.16291](https://arxiv.org/abs/2305.16291) | iter cap per skill | **Yes** (skill-library) |
| **AutoGPT** | [decoding-autogpt](https://maartengrootendorst.com/blog/autogpt/) | step budget | **Weak** (criticism rubber-stamps) |

**Ключевая находка:** только **tree-search (ToT, LATS)** и **skill-library
(Voyager)** паттерны имеют встроенное no-progress detection. Все linear loops
(ReAct, Reflexion, Plan-and-Execute, AutoGPT) требуют **внешних** harness guards.
Это ровно gap, в который попала saga.

---

## 3. Loop Termination Conditions — Industry Consensus

Синтез [Loop Engineering Guide](https://happycapy.ai/blog/loop-engineering-ai-agents),
[Cloudzy "Why loops fail"](https://cloudzy.com/blog/why-ai-agent-loops-fail-in-production/),
[MindStudio verifiable stop conditions](https://www.mindstudio.ai/blog/agent-loops-verifiable-stop-conditions),
и docs фреймворков:

| Mechanism | Implementations | Default | Pros | Cons |
|---|---|---|---|---|
| **Step/Turn cap** | LangGraph `recursion_limit=25`, OpenAI `max_turns`, Claude `--max-turns`, Cline `maxSteps=50` | 25 / 50 | Trivial, надёжный backstop | Тратит токены перед trip; легитимные long tasks тоже триггерят |
| **No-progress (call-hash)** | [LangChain #36139](https://github.com/langchain-ai/langchain/issues/36139), [Particula.tech](https://particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress), **saga S1** | N=3..5 | Catches exact loops за <60с; near-zero FP | Misses near-loops |
| **No-progress (error-hash)** | saga S2 | N=3..5 | Catches "same failing command verbatim" ([claude-code#19699](https://github.com/anthropics/claude-code/issues/19699)) | Только на error paths |
| **Token/cost budget** | OpenAI provider dashboards, [Stop the Agent Loop](https://medium.com/@npavfan2facts/stop-the-agent-loop-before-it-eats-your-product-7428f3d02378) | varies | Caps financial exposure | Не детектит почему — сжигает бюджет |
| **Wall-clock timeout** | saga 15-min backstop | varies | Catches silent hangs | Abrupt; теряет partial work |
| **Confidence threshold** | [Agentic Confidence Calibration, arXiv 2601.15778](https://arxiv.org/html/2601.15778v1) | research only | Теоретически optimал | **Calibration — open problem**, не production-ready |
| **Circuit breaker (cumulative)** | saga `loop_recoveries >= 3` | N/A | Detects structural task defect vs flaky model | Нужен multi-attempt corpus |
| **State-machine mandatory terminal** | [MindStudio](https://www.mindstudio.ai/blog/agent-loops-verifiable-stop-conditions) | N/A | Forces design-time exits | Upfront design discipline |

### 5-layer defense-in-depth (отраслевой консенсус, 6+ источников)

1. **Hard step cap**
2. **Token/cost budget**
3. **No-progress hash detector** (precision instrument — saga S1/S2)
4. **Circuit breaker on retry** (escalation trigger)
5. **Mandatory terminal state** (design-time)

**saga сегодня:** items 3, 4 (в дизайне), 5 (kanban с needs-human). **Не хватает
1 (step cap) и 2 (token budget).** Это **выше среднего по индустрии** —
большинство имеет только step cap.

---

## 4. Specialist Escalation Patterns — Real Implementations

### 4.1 TAO — иерархический multi-agent (arXiv 2506.12482)

[TAO](https://arxiv.org/html/2506.12482v2) — healthcare-safety system. Агенты в
**tiers**; **complexity-based escalation** маршрутизирует задачу вверх, когда
нижний tier не справился. Это академическая формулировка "generalist → specialist
→ human" эскалации — ровно то, что нужно saga для Дыры E+.

### 4.2 Aider Architect/Editor split

[Aider architect mode](https://aider.chat/2024/09/26/architect.html) (Sept 2024) —
два-model pipeline: **Architect** рассуждает о решении, **Editor** переводит план
в file edits. Признание: *"certain LLMs can't propose solutions and specify
detailed file edits in one pass."* Это паттерн для Дыры E+ — когда generalist
не справляется, эскалировать к **specialist reasoning** модели, а не retry с тем же.

### 4.3 Anthropic Agent Skills (де-факто стандарт 2025-2026)

[Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
+ [anthropics/skills GitHub](https://github.com/anthropics/skills) —
filesystem-based папки инструкций (`SKILL.md` + scripts/resources), дающие агенту
**domain-specific expertise**. Claude читает frontmatter и автоматически
маршрутизирует skill к задаче.

Связанные работы:
- [Survey: "Agent Skills from the Perspective of Procedural Memory"](https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.176857932.25697838)
- [arXiv 2602.12430 "Agent Skills for LLMs"](https://arxiv.org/html/2602.12430v3)
- [Neo4j "Agent Memory / Skills"](https://neo4j.com/labs/agent-memory/explanation/skills/)

### 4.4 Voyager — skill library (canonical precedent)

[Voyager](https://arxiv.org/abs/2305.16291) аккумулирует **verified skills** как
переиспользуемый код, обеспечивая knowledge retention и transfer. Это
оригинальная "skill library" бумага, прямой предок Anthropic Agent Skills.

---

## 5. Failure Recovery Patterns

| Pattern | Citation | Mechanism | Works when | Limitation |
|---|---|---|---|---|
| **Reflexion (verbal RL)** | [Shinn 2023](https://arxiv.org/abs/2303.11366) | After fail → self-criticism в episodic memory, reset, retry с reflection | Модель **может** диагностировать ошибку | **Не гарантирует прогресс** — если модель не может диагностировать, reflections = noise (Lighthouse case) |
| **Backtracking (tree search)** | ToT, LATS | frontier, pop на dead-end | Discrete states, cheap restarts | Expensive (k-way branch) |
| **Checkpoint/restore** | [Crab, arXiv 2604.28138](https://arxiv.org/html/2604.28138v1) | Save state, restore on fail | Long-running, fault tolerance | [Diagrid critique](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows): нет auto failure detection |
| **Human-in-the-loop escalation** | [Digital Applied HITL](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026), [Galileo](https://galileo.ai/blog/human-in-the-loop-agent-oversight) | Threshold (cost/risk/retry) → suspend, surface to human | High-stakes, low-freq | Не масштабируется — Дыра E+ именно этот limit |
| **Constitutional AI / self-critique** | [Redis overview](https://redis.io/blog/ai-human-in-the-loop/) | Critic model veto против constitution | Alignment, safety | Не помогает когда AC *технически* невыполним |

**Reflexion caveat — нагрузочный для saga.** Reflexion предполагает, что агент
**может вербально диагностировать** свой провал. Когда fail = "воркер не знает
что фикс требует `tree-shaking: true`" — Reflexion **переизлучает** ту же неверную
гипотезу. **Это и есть Дыра E+.** Reflexion не решает её; только **specialist
routing** или **external hint injection** решают.

---

## 6. Application to saga-mcp

### 6.1 Какой паттерн описывает saga сегодня?

saga = **hierarchical multi-agent system with mandatory-terminal state machine**.
Ближе всего к **TAO** (arXiv 2506.12482) по архитектуре, и к
**Reflexion-without-reflection** для worker loop.

- **Hierarchy:** orchestrator (engine) → planner → workers (generalist
  dev/verify/review) → human (escalation). TAO tier model.
- **Per-task execution:** каждый worker = один ReAct-style `claude -p` invocation
  с external harness. **Нет native Reflexion across attempts** — reflections
  теряются между retries (каждый retry = cold-start worker).
- **Termination сегодня:** SQL-state polling + (designed) S1/S2 + circuit breaker.
  **Выше industry consensus** — большинство имеет только step cap.
- **Specialist routing сегодня:** *отсутствует*. Каждая dev задача идёт в тот же
  generic `saga-worker` skill. Это gap.

### 6.2 Какой паттерн описывает Дыра E?

Lighthouse case (38 retries, worker не мог починить без hint) → две категории:

1. **Reflexion failure mode** — worker *не может вербально диагностировать*
   фикс, потому что знания (tree-shaking flag, manual chunk splitting) нет в
   контексте и не inferable из AC. Reflexion явно не решает это.
2. **IAL (Infinite Agentic Loop)** — ровно структурный fail из IAL paper.
   saga S1/S2 — правильное лекарство.

38-retry count также **триггерит saga designed circuit breaker**
(`CIRCUIT_BREAKER_LIMIT=3`). Если бы детектор был жив — кейс эскалировал бы
в `needs-human` после ~3 loops вместо 38.

### 6.3 Конкретные рекомендации

**Для Дыры E (infinite retry) — 3 добавления к существующему дизайну:**

1. **Имплементировать S1/S2 как написано.** At/above industry consensus.
   Cite [IAL paper (2607.01641)](https://arxiv.org/abs/2607.01641) и
   [LangChain #36139](https://github.com/langchain-ai/langchain/issues/36139).

2. **Добавить per-task token-cost budget** (единственный недостающий слой
   из 5-layer consensus). Token-cap дополняет wall-clock: stuck worker сжигает
   ~96k токенов/loop. Предложение: `tasks.metadata.token_budget`, default 500k,
   enforce через `usage` events в JSONL stream.

3. **Персистировать Reflexion-style reflections across retries.** Сегодня каждый
   retry cold-starts. При circuit breaker trip — сохранять последнее thinking
   worker'а + failed attempts как `recovery_context` артефакт на задаче.
   Следующий worker (или человек) читает. Это [Shinn 2023](https://arxiv.org/abs/2303.11366)
   verbal-RL паттерн, адаптированный под saga one-task-one-launch модель.

**Для Дыры E+ (manual hint doesn't scale) — 3 паттерна из литературы:**

4. **Specialist escalation via skill routing** (Anthropic Agent Skills / Voyager).
   Вместо `needs-human` как единственной эскалации — добавить `needs-specialist`
   tier: тегировать задачи `domain:bundling`, `domain:css`, etc., маршрутизировать
   к specialist worker skills. Specialist skills несут domain-specific diagnosis
   procedures.

5. **Two-model Architect/Editor split для задач, проваливших first attempt**
   (Aider pattern). Когда dev worker триггерит circuit breaker — эскалировать НЕ
   к человеку, а к **specialist architect worker** который *только* производит
   diagnosis/plan (без edits), затем hand план свежему dev worker.

6. **Verified skill-library accumulation** (Voyager). Когда человек *всё-таки*
   даёт hint — захватываем (symptom, diagnosis, fix) как переиспользуемый skill.
   В следующий раз при похожих симптомах skill инжектируется в контекст.
   Это единственный fix, чей **ROI растёт со временем**.

### 6.4 Чего литература пока не даёт

- **Calibrated confidence-based termination** — не production-ready
  ([arXiv 2601.15778](https://arxiv.org/html/2601.15778v1) показывает poor
  calibration LLM self-confidence в agent settings). Не полагаться.
- **Стандарта "agent skill libraries" на protocol level** пока нет —
  Anthropic Agent skills де-факто, но vendor-specific.
- **State of the art no-progress detection в 2026** — ровно то, что мы
  задизайнили: hash `(tool_name, canonical_input)` над sliding consecutive window
  с N=3..5 + error-text hash. IAL-SCAN обобщает это до static analysis;
  saga runtime detector — dynamic counterpart.

---

## 7. Surveys 2024–2026 — canonical references

| Survey | Citation | Зачем |
|---|---|---|
| **The Hitchhiker's Guide to Agentic AI** | [arXiv:2606.24937](https://arxiv.org/abs/2606.24937) (2026) | 2026 практ. bible |
| **When Agents Do Not Stop (IAL)** | [arXiv:2607.01641](https://arxiv.org/abs/2607.01641) (2026) | формальная IAL formalization + detector |
| **Evaluation and Benchmarking of LLM Agents: A Survey** | [arXiv:2507.21504](https://arxiv.org/html/2507.21504v1) (2025) | methodologies |
| **Exploring Autonomous Agents: Why They Fail** | [arXiv:2508.13143](https://arxiv.org/html/2508.13143v1) (2025) | failure-mode analysis |
| **Why Do Multi-Agent LLM Systems Fail?** | [NeurIPS 2025](https://neurips.cc/virtual/2025/poster/121528) | multi-agent failure taxonomy |
| **PlanGenLLMs** | [ACL 2025](https://aclanthology.org/2025.acl-long.958.pdf) | LLM planning survey |
| **Agentic Confidence Calibration** | [arXiv:2601.15778](https://arxiv.org/html/2601.15778v1) (2026) | почему confidence threshold не ready |
| **Microsoft: Taxonomy of Failure Modes in Agentic AI** | [PDF](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/final/en-us/microsoft-brand/documents/Taxonomy-of-Failure-Mode-in-Agentic-AI-Systems-Whitepaper.pdf) | industry-side taxonomy |
| **awesome-agent-failures** | [vectara/awesome-agent-failures](https://github.com/vectara/awesome-agent-failures) | curated case studies |

---

## 8. Full Bibliography

### Papers (arXiv / NeurIPS / ACL)
- **When Agents Do Not Stop: Uncovering Infinite Agentic Loops in LLM Agents** — https://arxiv.org/abs/2607.01641 — HTML: https://arxiv.org/html/2607.01641v1
- **The Hitchhiker's Guide to Agentic AI** — https://arxiv.org/abs/2606.24937
- **Reflexion: Language Agents with Verbal RL** (Shinn 2023) — https://arxiv.org/abs/2303.11366
- **Tree of Thoughts** (Yao 2023) — https://arxiv.org/abs/2305.10601
- **LATS (Language Agent Tree Search)** — https://arxiv.org/abs/2310.04406
- **Voyager** (Wang 2023) — https://arxiv.org/abs/2305.16291
- **ReAct** (Yao 2022) — https://arxiv.org/abs/2210.03629
- **TAO Hierarchical Multi-Agent** — https://arxiv.org/html/2506.12482v2
- **Agentic Confidence Calibration** — https://arxiv.org/html/2601.15778v1
- **Agent Skills for LLMs** — https://arxiv.org/html/2602.12430v3
- **Evaluation and Benchmarking of LLM Agents: A Survey** — https://arxiv.org/html/2507.21504v1
- **Exploring Autonomous Agents: Why They Fail** — https://arxiv.org/html/2508.13143v1
- **Why Do Multi-Agent LLM Systems Fail?** (NeurIPS 2025) — https://neurips.cc/virtual/2025/poster/121528
- **PlanGenLLMs** (ACL 2025) — https://aclanthology.org/2025.acl-long.958.pdf
- **Crab: Semantics-Aware Checkpoint/Restore** — https://arxiv.org/html/2604.28138v1

### Framework docs
- **LangGraph `GRAPH_RECURSION_LIMIT`** — https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT
- **LangChain feature request: no-progress detection (#36139)** — https://github.com/langchain-ai/langchain/issues/36139
- **AgentExecutor.max_iterations** — https://reference.langchain.com/python/langchain-classic/agents/agent/AgentExecutor/max_iterations
- **OpenAI Agents SDK `max_turns`** — https://openai.github.io/openai-agents-python/ref/run/
- **Claude Code `--max-turns`** — https://www.claudelog.com/faqs/what-is-max-turns-in-claude-code/
- **Aider architect mode** — https://aider.chat/2024/09/26/architect.html
- **Anthropic Agent Skills** — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- **anthropics/skills GitHub** — https://github.com/anthropics/skills
- **Cursor 2.4 Subagents** — https://www.aimakers.co/blog/cursor-2-4-subagents/
- **Microsoft Agent Framework: HITL** — https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop

### Practitioner articles
- **Loop Engineering for AI Agents** — https://happycapy.ai/blog/loop-engineering-ai-agents
- **Why AI Agent Loops Fail in Production** — https://cloudzy.com/blog/why-ai-agent-loops-fail-in-production/
- **Verifiable Stop Conditions** — https://www.mindstudio.ai/blog/agent-loops-verifiable-stop-conditions
- **Stop the Agent Loop Before It Eats Your Product** — https://medium.com/@npavfan2facts/stop-the-agent-loop-before-it-eats-your-product-7428f3d02378
- **Stop AI Agents Looping on the Same Failed Tool Call** — https://particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress
- **Why your AI agent loops forever (alanwest)** — https://dev.to/alanwest/why-your-ai-agent-loops-forever-and-how-to-break-the-cycle-12ia
- **What should happen when an AI agent gets stuck (r/LLMDevs)** — https://www.reddit.com/r/LLMDevs/comments/1ue2jok/what_should_happen_when_an_ai_agent_gets_stuck_in/
- **Human-in-the-Loop Escalation Design** — https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026
- **HITL Oversight (Galileo)** — https://galileo.ai/blog/human-in-the-loop-agent-oversight
- **Why Checkpoints Aren't Durable Execution (Diagrid)** — https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows
- **Microsoft: Taxonomy of Failure Modes (whitepaper)** — https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/final/en-us/microsoft-brand/documents/Taxonomy-of-Failure-Mode-in-Agentic-AI-Systems-Whitepaper.pdf
- **Agent Skills as Procedural Memory** — https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.176857932.25697838

### Claude Code loop issues (directly analogous)
- **#15909 — Sub-agent stuck, ~27M tokens** — https://github.com/anthropics/claude-code/issues/15909
- **#19699 — Same failing command verbatim** — https://github.com/anthropics/claude-code/issues/19699
- **#59318 — Same tool infinite loop** — https://github.com/anthropics/claude-code/issues/59318
- **#35166 — Repeated requests hundreds of times** — https://github.com/anthropics/claude-code/issues/35166
- **#27281 — Stuck "let me write the document"** — https://github.com/anthropics/claude-code/issues/27281

---

## 9. Сводка

- Запрошенный arxiv `2606.00001` — каллиграфия, не agent loops. Корректные 2026
  бумаги: **IAL (2607.01641)** и **Hitchhiker's Guide (2606.24937)**.
- **saga existing S1/S2 + circuit-breaker дизайн — at/above industry consensus.**
  Только tree-search (ToT/LATS) и skill-library (Voyager) имеют native
  no-progress detection; все linear loops нуждаются во внешних guards — saga
  именно это и проектирует.
- **Дыра E (infinite retry)** — решается существующим детектором + добавить
  token-cost budget и cross-retry reflection persistence (5-layer defense).
- **Дыра E+ (manual hint doesn't scale)** — Reflexion-failure case: worker не
  может диагностировать то, чего не знает. Три literature-backed фиксы: (a)
  specialist skill routing (Anthropic Agent Skills / TAO), (b) Architect/Editor
  two-model escalation (Aider), (c) **verified skill-library accumulation
  (Voyager) — единственная, чей ROI растёт со временем**.
- Confidence-threshold termination — не production-ready (arXiv 2601.15778).

**Связанный локальный файл:** `D:/Разработка/saga-mcp/docs/research/design-2026-07-20-worker-loop-detection.md`.
