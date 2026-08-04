# Autonomous Decision-Making for Unverifiable Acceptance Criteria

**Дата:** 2026-07-20
**Скоуп:** Когда saga verifier физически не может проверить AC (нет GPU, нет
браузера, нет external API, нет hardware) — что ему решать самому без эскалации
к человеку? Должен ли "unknown" продвигаться до "accepted-with-caveat", и если
да — по какому фреймворку?
**Родственный документ:** `literature-2026-agentic-loops-and-escalation.md`
(покрывает retry/loop failure modes). Здесь — **ортогональный класс**:
не "агент пытается и не может починить" (Дыра E), а "агент не имеет пути
получить runtime evidence вообще".

---

## 0. Framing — два разных "stuck"

Cannon investigation зафиксировала 5 дыр (A-E). Дыры E/E+ — про retry loops:
AC verifiable в принципе, worker не может удовлетворить. Покрыто IAL/Reflexion/
specialist-routing литературой.

Здесь — другая форма:

| | Дыра E (retry loop) | Этот ресёрч (unverifiable AC) |
|---|---|---|
| Worker может запустить check? | Да (Lighthouse, tsc) — но **значение** ниже порога | **Нет** — check сам не может запуститься в окружении |
| Фикс возможен в принципе? | Да — code change | **Неизвестно или нет** — окружение лимит |
| Reflexion помогает? | Иногда | **Нет** — нечего диагностировать |
| Правильный фреймворк | Loop-termination + specialist escalation | **Decision-under-uncertainty + evidence fusion + reversibility** |

---

## 1. Taxonomy of unverifiable AC types

| Класс | Почему unverifiable | Примеры | Что доступно |
|---|---|---|---|
| **U1. Hardware-bound perf** | Нет реального GPU/CPU | "60fps с 8 планетами"; "p95 <50ms под 10k RPS" | Code-level: наличие оптимизаций; static budget: bundle size, alloc count |
| **U2. Browser/device-specific** | Нет Safari/iOS | "Работает на Safari 17"; "touch precision на iPad" | Cross-browser compat tables, feature-detection code, Playwright Chromium subset |
| **U3. External-API contract** | Не можем hit production OAuth/Stripe | "OAuth flow returns id_token within 2s" | Mock fixtures, signature crypto unit tests, schema conformance против OpenAPI |
| **U4. Proprietary-tool audits** | Нет Snyk/SonarQube коммерческой лицензии | "0 critical CVEs per Snyk" | OWASP Dependency-Check (free), Semgrep OSS rules, npm audit |
| **U5. Distributed infrastructure** | Нет реального k8s | "Survives AZ failure"; "10k concurrent WebSockets" | Chaos-mesh unit tests, capacity math от single-node |
| **U6. Human-subjective** | Нужен реальный screen reader / sighted user | "Screen-reader announces planet names"; "WCAG AAA contrast" | axe-core, ARIA-shape lint, contrast ratio math |
| **U7. Regulatory/legal** | Нужен auditor / lawyer sign-off | "GDPR Article 7 compliant"; "HIPAA audit-ready" | Code-path enumeration, data-flow diagrams, policy-as-code (OPA) |
| **U8. Real-world physics** | Нужны реальные sensors / hardware | "Calibration error <0.1° on real star tracker" | Simulation, HIL emulators, vendor spec-sheet bounds |

**Главное наблюдение:** для каждого класса есть **частичный сигнал**. Вопрос
не "evidence или нет", а "каково inferential distance от доступного evidence
до AC assertion, и достаточно ли короткое".

---

## 2. Survey of decision frameworks

### 2.1 Cynefin (Snowden)

Уже в `autonomous-recovery`. Сортирует ситуации в Clear/Complicated/Complex/
Chaotic/Confusion, предписывает стиль решения.

**Применимость к unverifiable AC:** умеренная. Большинство unverifiable AC —
**Complicated** (анализируемо, но требует экспертизы), не Complex. Cynefin
говорит "apply expert analysis, sense-make first" — но не даёт численной
процедуры.

### 2.2 OODA loop (Boyd)

Observe-Orient-Decide-Act. Schneier и Harvard Berkman Klein Centre [критика 2025](https://www.schneier.com/blog/archives/2025/10/agentic-ais-ooda-loop-problem.html):
**Orient** step — где AI агенты наиболее уязвимы к adversarial pressure.

**Применимость:** низкая как primary framework, высокая как **template** для
skill: steps map naturally to "Observe (что доступно) → Orient (fuse) →
Decide (accept/retry/escalate) → Act (record + proceed)".

### 2.3 MCDA / AHP — best fit для "should I accept?"

Multi-Criteria Decision Analysis: score options против weighted criteria. AHP
автоматизирован с LLMs: [arXiv:2402.07404](https://arxiv.org/abs/2402.07404),
[SSRN 5069656](https://www.ssrn.com/abstract=5069656). saga's `autonomous-recovery`
уже использует MCDA-style таблицу (correctness 0.30, blast-radius 0.25,
reversibility 0.20, audit-clarity 0.15, no-data-loss 0.10).

**Применимость:** **высокая.** Единственный фреймворк из набора который даёт
defensible **число** для аудита. Компонуется с reversibility (§3.4) и
evidence fusion (§4).

### 2.4 Expected Utility / Bayesian decision theory

Maximum Expected Utility: choose action maximizing EU(A|E). Empirически
([SSRN 5154002](https://papers.ssrn.com/sol3/Delivery.cfm/5154002.pdf?abstractid=5154002))
LLM агенты **систематически отклоняются** от EUT.

**Применимость:** теоретически корректно, **практически слабо**. Требует
utilities и probabilities которые агент не может калибровать. Полезно как
*normative reference*, не как operational procedure.

### 2.5 Subjective logic (Jøsang 2016) — самый релевантный

*Subjective opinion* — тройка `ω = (b, d, u)` над пропозицией X где
`b + d + u = 1`: belief, disbelief, uncertainty. См. [Jøsang, *Subjective Logic* (Springer 2016)](https://www.amazon.com/Subjective-Logic-Uncertainty-Intelligence-Foundations/dp/3319423355), [ML survey arXiv:2206.05675](https://arxiv.org/pdf/2206.05675).

**Почему идеально ложится на AC проблему:**
- `b` (belief) — от code-level evidence (оптимизации на месте)
- `d` (disbelief) — от негативного сигнала (регрессия benchmark)
- `u` (uncertainty) — от отсутствующего runtime check (нет GPU → нет frame timings)
- `u` — **точно** "epistemic uncertainty от missing observation", не noise

Subjective logic даёт **fusion operators** (cumulative fusion `⊕`, averaging
fusion) и **discounting** для trusted-source weighting — напрямую мапит на
saga's Trusted Provider registry (REQ-012).

**Применимость:** **высочайшая из всех surveyed** для representation layer.
Decision *policy* сверху (когда `(b=0.6, d=0, u=0.4)` trigger accept vs
escalate?) всё равно требует MCDA-style rule, но representation principled и
auditable.

### 2.6 Evidential Deep Learning (Sensoy 2018), conformal prediction

[Sensoy et al.](https://papers.nips.cc/paper/7580-evidential-deep-learning-to-quantify-classification-uncertainty)
— Dirichlet distribution над классами, математически эквивалент subjective
opinions через Dempster–Shafer. [Conformal prediction](https://arxiv.org/html/2510.26995v1)
— distribution-free marginal coverage guarantees.

**Применимость:** medium-low **для агента сегодня.** Это trained-model
techniques; saga worker — frozen LLM без calibration head. Но *идея*
("produce set of plausible outcomes, not point estimate") portable.

### 2.7 Confidence calibration — open problem

[Agentic Confidence Calibration (arXiv:2601.15778)](https://arxiv.org/html/2601.15778v1)
показывает: LLM self-confidence в agent settings **poorly calibrated**. Агенты
говорящие "I'm 90% sure" правы гораздо меньше 90% времени. Anthropic
["Measuring AI agent autonomy"](https://www.anthropic.com/research/measuring-agent-autonomy)
+ [Kasirzadeh & Gabriel (2025)](https://arxiv.org/abs/2504.21848) — 4 измерения
автономии.

**Импликация:** decision procedure должен опираться на **externally-verifiable
signals** (code patterns, type checks, bundle size, test passes) и
**reversibility**, НЕ на self-reported confidence.

---

## 3. "Good enough" patterns в SE — прямая применимость

### 3.1 Required vs optional checks (GitHub Actions pattern)

GitHub различает **required** checks (block merge) от **optional/informational**
(`continue-on-error: true`). См. [epiforecasts](https://epiforecasts.io/posts/2022-04-11-robust-actions/),
[Tenki Flaky Test Quarantine](https://tenki.cloud/blog/flaky-test-quarantine-github-actions).

**Маппинг на saga:** unverifiable AC должен быть **optional/informational**
verification. Saga уже имеет data model: `verification_evidence.outcome IN
('passed','unknown')` допускает transition. Gate в `src/tools/lifecycle.ts:207-233`
уже принимает `unknown`. **Чего нет — policy когда `unknown` приемлемо.**

### 3.2 Risk matrix (severity × likelihood)

5×5 матрица: (impact if AC is false) × (probability AC is false) → accept /
mitigate / avoid. [Compel framework](https://www.compelframework.org/governance/agent-governance)
применяет к AI agents.

### 3.3 Defense in depth

Когда individual signals слабые — комбинируем несколько **независимых**.
Для нас: code-review-passed + tsc-clean + bundle-size-within-budget +
6-of-6-optimizations-present + free-tool-audit-clean ⇒ joint evidence для
"60fps вероятно держится" гораздо сильнее любого single signal.

### 3.4 Reversibility как safety net (rollback, feature flags, canary)

Если wrong decision дёшево откатить — bar для autonomous acceptance падает.
Feature flags + canary + dark launches ([Harness](https://www.harness.io/blog/canary-release-feature-flags),
[LaunchDarkly dark-launch](https://launchdarkly.com/blog/guide-to-dark-launching/)).

### 3.5 Pre-mortem + Red Team

[Pre-mortem](https://medium.com/paypal-tech/pre-mortem-technically-working-backwards-1724eafbba02):
"this failed — why?" перед решением. Red Team: "что бы adversary нашёл
неправильного?" Дешёвые LLM операции, **заставляют агента генерировать
counter-evidence** перед accept.

---

## 4. Multi-agent verification "accept" решения

| Pattern | Citation | Mechanism | Сильная сторона | Слабая |
|---|---|---|---|---|
| **AI Safety via Debate** | [Irving et al. 2018](https://arxiv.org/abs/1805.00899) | Два агента спорят, judge решает | Сильный adversarial signal | Дорогой (2× agents + judge) |
| **Self-consistency** | [Wang et al. ICLR 2023](https://arxiv.org/abs/2203.11171) | N reasoning paths, majority-vote | Дёшево, validated | Не помогает когда *информации* нет |
| **Constitutional AI** | [Bai et al. 2022](https://arxiv.org/abs/2212.08073) | Self-critique против principles | Дёшево | Разделяет blind spots модели |
| **Scholar peer review** | (общий) | Reviewer независимо re-derives decision | Структурная независимость | Только так хорош, как reviewer's evidence access |

**Импликация для saga:** существующая **L2-vs-L3 структурная сепарация** Builder
и Verifier — правильный chassis. Паттерн: verifier records `outcome=unknown` с
partial evidence; **независимый arbiter skill** re-evaluate'ит partial evidence
и решает accept/retry/escalate. Arbiter должен использовать **другую decision
procedure** (MCDA + Red Team) чем verifier (run-the-check) — структурная
независимость в *judgment*, не только в *test layer*.

---

## 5. Cost-benefit эскалации vs автономии

| Cost эскалации (`worker_ask_need`) | Cost autonomous accept |
|---|---|
| Pipeline блокируется до возврата человека | Risk false-accept в integration |
| Human attention — дефицит. Anthropic документирует approval fatigue | False-accept может распространиться downstream |
| Каждый round-trip теряет hot context worker'а | Audit trail cost (надо записать rationale) |
| Human обычно имеет *меньше* контекста чем агент | Reversibility burden shifts to release engineering |

**"80% rule"** (paraphrase, не точная Anthropic цитата): для low-stakes
reversible decisions — assume + comment + stay reversible; для high-stakes
irreversible — escalate.

**Operational guidance из литературы:** автономия должна масштабироваться с
(a) confidence в *partial* evidence, (b) reversibility wrong decision, (c)
независимостью fused signals. **НЕ** с self-reported confidence.

---

## 6. Proposal для saga-mcp — `saga-arbiter` skill

### 6.1 Рекомендация: да, строить skill — с жёсткими guardrails

Unverifiable ACs — **класс**, не one-off. Cannon case — U1 (hardware-bound perf);
та же проблема возникнет на U2-U8 систематически по мере роста saga. Трактовать
каждый как human-escalation — тот же anti-pattern что `autonomous-recovery`
отвергает для Дыры E.

**Но дизайн должен уважать 3 finding'а:**

1. **НЕ доверять agent self-reported confidence** (калибровка плохая). Решать на
   *externally-verifiable* partial signals и *reversibility*.
2. **Решение должно порождать audit artifact** (subjective-opinion `(b,d,u)` +
   MCDA table + Red Team counter). Без него следующий агент/человек не сможет
   реконструировать почему `unknown` принят.
3. **Некоторые ACs — реально human-only.** Regulatory (U7), real-world safety
   (U8 high-stakes), любой AC tagged `security`/`compliance` — bypass arbiter,
   сразу escalate. Зеркалит `autonomous-recovery` "genuine human-only" Cynefin row.

### 6.2 Контр-аргумент (steel-manned)

**Качественные gates существуют именно чтобы предотвратить judgment-call
acceptance.** Если verifier не может verify — честный ответ "не знаю", честное
действие — surface to human. LLM вооружающийся MCDA матрицей чтобы оправдать
skip gate — тот же failure mode что GUARDRAILS Sign 008 ("CGAD legitimacy-wash").
Агент будет систематически over-accept.

**Rebuttal:** deny-by-default без graceful degradation = ровно Дыра E — engine
loops, human rubber-stamps, opportunity cost копится. Компромисс: **arbiter
может только `accept-with-caveat`, никогда `passed`.** Caveat записывается как
runtime observation (REQ-011 `observation_type='shadow'` или `'canary'`) —
первое production measurement либо подтверждает, либо поднимает incident. Это
конвертирует static judgment-call в falsifiable, time-bounded hypothesis —
научно честно когда measurement сейчас невозможен.

### 6.3 Skill design — `saga-arbiter`

**Trigger conditions (ALL must hold):**

1. `verification.ac` task записал `outcome='unknown'` по причине "environment
   cannot run this check" (НЕ "test crashed" или "no properties block").
2. AC НЕ tagged `security`, `compliance`, `safety`, `regulatory`.
3. Есть хотя бы один positive partial evidence в epic (passing unit tests,
   passing type check, code review approved, free-tool audit clean).
4. Blast radius bounded — feature в branch, feature-flagged, reversible <1 hour.

Если (1)-(4) любой fail → passthrough к `worker_ask_need`. Arbiter **opt-in по
структуре, не по judgment**.

**6-step decision loop** (mirror `autonomous-recovery` для muscle memory):

```
  verification.ac recorded outcome='unknown'
       │
       ▼
  1. CLASSIFY  ──── какая U1-U8 категория? какой partial evidence?
       │
       ▼
  2. SUBJECTIVE OPINION  ──── fuse evidence в (b, d, u)
       │                    b = sum positive-signal masses
       │                    d = sum negative-signal masses
       │                    u = 1 − b − d  (uncertainty от missing check)
       ▼
  3. MCDA MATRIX  ──── score 3 options против 5 критериев
       │             options: A=accept-with-caveat, B=retry-different, C=escalate
       │             criteria: evidence-strength, reversibility, blast-radius,
       │                       audit-clarity, cost-of-delay
       ▼
  4. RED TEAM  ──── generate strongest counter-argument к top-scoring option
       │            (forces evidence-generation против решения)
       ▼
  5. DECIDE  ──── если A всё ещё wins AND u < threshold AND Red Team не вытащил
       │            fatal flaw: record accept-with-caveat + observation type='shadow'
       │            else: escalate
       ▼
  6. RECORD  ──── comment с полным (b,d,u), MCDA table, Red Team counter,
                  caveat, falsifiable prediction
```

**Decision matrix template (Step 3):**

| Criterion | Weight | A: accept-with-caveat | B: retry-different | C: escalate |
|---|---:|---|---|---|
| evidence-strength | 0.30 | b | (depends) | 0 (no new info) |
| reversibility | 0.25 | high if feature-flagged | medium | n/a |
| blast-radius (low=good) | 0.20 | (1/scope) | (1/scope) | n/a |
| audit-clarity | 0.15 | high (structured) | medium | high |
| cost-of-delay (low=good) | 0.10 | low | medium | high |

**A проходит только если:** weighted score ≥ 3.5/5 **AND** `u < 0.4` **AND**
Red Team (Step 4) не вытащил ранее-uncounted `d` mass > 0.2.

**Output:**

- `verification_record` с `outcome='unknown'` (unchanged — arbiter НЕ продвигает
  до `passed`) + evidence string с MCDA table.
- `comment_add` с полным subjective-opinion triple, Red Team counter, caveat.
- `observation_record` с `observation_type='shadow'`, `observed_value='AC-<code>
  accepted-with-caveat pending runtime verification'`, `baseline_value='<AC
  assertion verbatim>'`, falsifiable prediction ("first production Lighthouse
  run покажет ≥60fps; если нет — acceptance отзывается и AC пере-открывается").
- Task → `done` с `result='arbiter: accept-with-caveat; runtime deferred to
  observation'`.

**Skill file:** `C:\Users\user\.zcode\skills\saga-arbiter\SKILL.md` (параллельно
с `autonomous-recovery`). ~200 строк, та же форма: frontmatter + 6-step loop +
Cynefin-triage guardrails + anti-patterns + "when to actually escalate".
Arbiter claims свой task kind (`workflow_stage: 'verification'`, `task_kind:
'verification.arbiter'`, `tags: ['role:reviewer', 'arbiter']`).

**Связь с existing skills:**

- **`saga-verifier`** — unchanged. Всё ещё records `unknown`.
- **`autonomous-recovery`** — unchanged. Handles gate-failure recovery. Arbiter
  — verification-stage sibling.
- **New planner rule** — когда `verification.ac` записывает `outcome='unknown'`
  по причине "environment cannot run check", orchestrator spawn'ит `arbiter`
  task (depends_on verifier task). Если arbiter эскалирует — *тогда* `worker_ask_need`.

---

## 7. Walkthrough — AC-NFR-3 (60fps, 8 planets)

| Step | Что arbiter делает | Результат |
|---|---|---|
| 1. Classify | U1 (hardware-bound perf). Partial evidence: 6/6 оптимизаций, tsc clean, jest green, bundle 410KB (<500KB budget), нет profiling регрессий | — |
| 2. Subjective opinion | `b = 0.55` (6 оптимизаций + budget + tests), `d = 0.05` (нет известных регрессий), `u = 0.40` (нет runtime frame timings) | `(0.55, 0.05, 0.40)` |
| 3. MCDA | A: 4.1 / B: 3.0 / C: 2.6 | A wins |
| 4. Red Team | "Browser GC pause on first orbit может скинуть 6 frames; Intel iGPU common case 45fps не 60; Three.js shader compile sync на first paint." Counter-masses: GC +0.05, iGPU +0.10, shader-compile +0.05 | revised `(0.55, 0.25, 0.20)` |
| 5. Decide | Red Team поднял `d` до 0.25, но не превысил 0.2 increment threshold; `u` теперь 0.20 < 0.4; score 4.1 ≥ 3.5 | **accept-with-caveat** |
| 6. Record | comment с полной таблицей; `observation_record` baseline="60fps sustained orbit, 8 planets", prediction="first production profile на reference hardware (M1/RTX 3060) показывает ≥60fps; retraction если <55fps median" | task done |

Человек-спонсор может позже прочитать comment, увидеть какие evidence fused,
какие counter-arguments сгенерированы, какое prediction falsify'нет acceptance.
Если не согласен — override до integration. **Arbiter не убрал человека — он
сжал "stuck indefinitely" в "ship with falsifiable caveat".**

---

## 8. Limitations и open questions

1. **Threshold tuning — empirично.** `u < 0.4`, MCDA `≥ 3.5/5`, Red-Team
   increment `> 0.2` — starting guesses. Калибровать против corpus прошлых
   unverifiable ACs. Пока default conservative (`u < 0.3`).
2. **Subjective-opinion mass assignment — сам judgment call.** Сколько `b`
   добавляет "tsc clean" vs "tests green"? Нужен rubric. Пока arbiter обязан
   justify каждую mass в prose.
3. **Arbiter жрёт токены.** Полный 6-step pass на сложном AC — ~30k токенов.
   Overkill для тривиальных. Classifier (Step 1) должен fast-path тривиальные
   ("всё pass кроме unverifiable, не security-tagged, feature-flagged") прямо
   в accept-with-caveat.
4. **Нет prevention rubber-stamping.** Red Team step — структурный контр. Если
   агент не может сгенерировать credible counter-argument — это само информация
   (decision лёгкий). Если strawman — audit trail покажет.
5. **Первое production measurement может никогда не прийти.** Если проект не
   достигает runtime environment с GPU — `shadow` observation остаётся open
   вечно. Это честно. Но orchestrator должен age-out stale shadows (e.g.,
   escalate если shadow >30 дней без confirmation).

---

## 9. Summary

- Cannon AC-NFR-3 case — **НЕ** instance Дыры E (retry loop). Это новый класс
  — **unverifiable AC** — с минимум 8 sub-types (U1-U8).
- Для каждого класса есть *partial* evidence. Решение не "evidence или нет", а
  "inferential distance от доступного evidence до AC assertion".
- Из surveyed frameworks **Subjective Logic (Jøsang)** — лучшее representation
  (explicit `(b, d, u)` triple, principled fusion, maps на Trusted Providers),
  **MCDA** — лучшая decision procedure (defensible, auditable, уже в
  `autonomous-recovery`).
- **Self-reported agent confidence НЕ должна быть load-bearing** — калибровка
  плохая. Решать на external evidence + reversibility.
- **Строить skill — `saga-arbiter`** — с жёсткими структурными guardrails:
  opt-in по trigger condition, никогда не продвигает `unknown` до `passed`,
  всегда emit'ит falsifiable `shadow` observation, всегда оставляет полный
  audit trail. Это конвертирует static judgment-call в time-bounded hypothesis.
- Для малого остатка genuinely human-only ACs (security, compliance,
  regulatory, real-world safety) — держать `worker_ask_need`. Arbiter и
  human-escalation — complements, не substitutes.

---

## 10. Bibliography

### Decision frameworks
- [Cynefin framework (Wikipedia)](https://en.wikipedia.org/wiki/Cynefin_framework)
- [microservices.io — GenAI agents в Complex domain (2026)](https://microservices.io/post/architecture/2026/03/01/using-genai-based-coding-agents-cynefin-complex-domain.html)
- [OODA loop (Wikipedia)](https://en.wikipedia.org/wiki/OODA_loop)
- [Schneier — Agentic AI's OODA Loop Problem (2025)](https://www.schneier.com/blog/archives/2025/10/agentic-ais-ooda-loop-problem.html)
- [Berkman Klein / Harvard — OODA Loop Problem](https://cyber.harvard.edu/story/2025-10/agentic-ais-ooda-loop-problem)
- [OODA Loop Pattern for Autonomous AI Agents (DEV)](https://dev.to/yedanyagamiaicmd/the-ooda-loop-pattern-for-autonomous-ai-agents-how-i-built-a-self-improving-system-2ap3)
- [Pre-mortem (PayPal Tech, Medium)](https://medium.com/paypal-tech/pre-mortem-technically-working-backwards-1724eafbba02)
- [Pre-mortem (CODE Magazine)](https://www.codemag.com/Article/1805011/A-Software-%2522Pre-mortem%2522)

### MCDA / risk scoring
- [AI Agents in MCDA: Automating AHP (SSRN 5069656)](https://www.ssrn.com/abstract=5069656)
- [Enhancing MCDA with AI (arXiv:2402.07404)](https://arxiv.org/abs/2402.07404)
- [Quantitative Risk Scoring for Autonomous AI Agents](https://medium.com/@ruchikd/quantitative-risk-scoring-for-autonomous-ai-agents-integrating-intent-capabilities-and-a83a78ae9ce9)
- [Compel Framework — Agent Governance](https://www.compelframework.org/governance/agent-governance)
- [Armalo — Trust Scoring](https://trust.armalo.ai/blog/trust-scoring-for-autonomous-ai-agents-architecture-and-control-model)

### Uncertainty representation
- [Jøsang — Subjective Logic (Springer 2016)](https://www.amazon.com/Subjective-Logic-Uncertainty-Intelligence-Foundations/dp/3319423355)
- [Jøsang — UiO tutorial](https://www.mn.uio.no/ifi/english/people/aca/josang/sl/)
- [Subjective Logic survey in ML/DL (arXiv:2206.05675)](https://arxiv.org/pdf/2206.05675)
- [Sensoy et al. — Evidential Deep Learning (NeurIPS 2018)](https://papers.nips.cc/paper/7580-evidential-deep-learning-to-quantify-classification-uncertainty)
- [Survey on Evidential Deep Learning (arXiv:2409.04720)](https://arxiv.org/pdf/2409.04720)
- [Conformal prediction for LLMs (arXiv:2510.26995)](https://arxiv.org/html/2510.26995v1)
- [Prune 'n Predict (ICML 2025)](https://icml.cc/virtual/2025/poster/46415)
- [LLM-as-a-Judge interval evaluations (EMNLP 2025)](https://aclanthology.org/2025.emnlp-main.569/)

### Expected utility / Bayesian
- [Russell & Norvig — Preferences and Utility](https://artint.info/html1e/ArtInt_214.html)
- [U Toronto CSC384 — Decision Making Under Uncertainty](http://www.cs.toronto.edu/~torsten/csc384-f11/lectures/csc384f11-Lecture08-DecisionMaking.pdf)
- [Understanding AI Agents' Decision-Making under Risk (SSRN 5154002)](https://papers.ssrn.com/sol3/Delivery.cfm/5154002.pdf?abstractid=5154002)

### Multi-agent verification
- [Irving, Christiano, Amodei — AI Safety via Debate (arXiv:1805.00899)](https://arxiv.org/abs/1805.00899)
- [OpenAI — AI safety via debate (blog)](https://openai.com/index/debate/)
- [Bai et al. — Constitutional AI (arXiv:2212.08073)](https://arxiv.org/abs/2212.08073)
- [Constitutional AI guide](https://mbrenndoerfer.com/writing/constitutional-ai-principle-based-alignment-through-self-critique)
- [Wang et al. — Self-Consistency (ICLR 2023, arXiv:2203.11171)](https://arxiv.org/abs/2203.11171)

### Agent autonomy / governance
- [Anthropic — Measuring AI agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)
- [Anthropic — Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Kasirzadeh & Gabriel (arXiv:2504.21848)](https://arxiv.org/abs/2504.21848)
- [Agentic Confidence Calibration (arXiv:2601.15778)](https://arxiv.org/html/2601.15778v1)
- [Partnership on AI — Real-Time Failure Detection](https://partnershiponai.org/wp-content/uploads/2025/09/agents-real-time-failure-detection.pdf)

### SE "good enough" patterns
- [Atlassian — Acceptance Criteria](https://www.atlassian.com/work-management/project-management/acceptance-criteria)
- [GitHub Actions required vs conditional checks](https://devopsdirective.com/posts/2025/08/github-actions-required-checks-for-conditional-jobs/)
- [epiforecasts — Flaky GitHub Actions](https://epiforecasts.io/posts/2022-04-11-robust-actions/)
- [Tenki — Flaky Test Quarantine](https://tenki.cloud/blog/flaky-test-quarantine-github-actions)
- [Flaky Builds in GitHub Actions (arXiv:2602.02307)](https://arxiv.org/html/2602.02307v1)
- [Harness — Canary Releases and Feature Flags](https://www.harness.io/blog/canary-release-feature-flags)
- [LaunchDarkly — Dark Launching](https://launchdarkly.com/blog/guide-to-dark-launching/)
- [Product Fruits — Dark Launch 101](https://productfruits.com/blog/dark-launch)
- [AI-Enhanced Defense-in-Depth (Nature 2025)](https://www.nature.com/articles/s41598-025-15034-4)

### Local saga-mcp context
- `investigation-2026-07-20-cannon-development-stage.md` — Дыры A-E, AC-NFR-1/AC-NFR-3 cases
- `literature-2026-agentic-loops-and-escalation.md` — retry/loop failure modes (Дыра E)
- `design-2026-07-20-worker-loop-detection.md` — S1/S2 detector
- `GUARDRAILS.md` — Signs 001-011 (особенно Sign 008 "CGAD legitimacy-wash")
- `docs/ac-verification.md` — structural coverage vs substantive verification
- `C:\Users\user\.zcode\skills\autonomous-recovery\SKILL.md` — sibling skill (Cynefin + MCDA + Red-Team-equivalent)
- `C:\Users\user\.zcode\skills\saga-verifier\SKILL.md` — upstream где `outcome='unknown'` originates
