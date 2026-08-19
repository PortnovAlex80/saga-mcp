# AC-DRIFT REMEDY — три архитектора закрывают потерю требований

Контекст: форензик-вердикт (следователь agent_f19e303e) зафиксировал точку
смерли docker compose up / TS-бэкенда / Chrome-клиента — задача 3 формализации
(brief+PRD переписал ордер без них; мост `brief_payload` — 6 полей решения,
`src/validators/brief.ts:45-64` — контент не переносит). Восемь слепых
механизмов, readiness не заметит (команды из self-declared профиля продукта).
Полный вердикт: `docs/factory-run/stage11/ARCHITECT-HANDOVER-DRAFT.md`.

Три независимых архитектора, три угла:
- А1 — мост контента discovery→formalization (**повторный запуск — первый остановился**)
- А2 — requirement-coverage рэтчет (в работе)
- А3 — конец цепочки: происхождение профиля проверки ✅ (ниже)

---

## А3 (конец цепочки): VERIFICATION WARRANT — разделить WHAT и HOW

### Диагноз

Readiness-профиль сегодня — **сертификация, автором которой является
проверяемый**. ADR-053/LR-03/LR-04 решили реальную проблему (не угадывать
readiness по incidental-файлам, явный профиль, fail-closed), но отдали
авторитет не тому принципалу: замороженный кандидат — *субъект* сертификации
и одновременно *автор* сертификационных команд (`development-schemas.ts:296-311`
— «authority is the accepted product contract»; авторство —
`payload.readiness` продукта, `development-check-providers.ts:288`). Freeze
даёт неизменность, но не правильность происхождения. Ирония: в enum
трейс-линков `artifact_traces.link_type` (`schema.ts:481`) тип **`verified_by`
уже существует** — но никто не пишет его из ордерной стороны. Заказ лежит в
`factory_orders.source_body` + digest — контент-адресован, бессмертен… и не
связан ни с одной проверкой.

### Дизайн: разделить WHAT и HOW

**Принцип: продукт авторитарен для HOW (install/serve-детали — он их правда
знает), ордер авторитарен для WHAT (какие promises существуют и какая
проверка закрывает каждый).**

**Q1 — происхождение.** Цепочка: `factory_orders.source_body`
(digest-pinned) → на discovery-settlement извлекается **verification
warrant** — типизированный реестр constraints (id, класс, canonical
evidence). Владелец — **order-run** (lifecycle): реестр пишется один раз,
пока constraints ещё видны (readiness-ассессор в инциденте все три
валидировал — он их видел, но не сериализовал), контент-адресуется по
digest. Formalization владеет покрытием AC→warrant; development settlement
только **цитирует** warrant как `warrantRef`. Ордер сказал «docker compose
up» → строка warrant класс=execution, canonicalCommand=`docker compose up` —
**неприкосновенна для профиля**: провайдер исполняет её сам, поверх головы
профиля.

**Q2 — классы.**
- **(a) статические (TS-бэкенд):** не задача сертификатора гонять tsc.
  Строка warrant класс=material с декларативным probe-спеком
  (`{files:["tsconfig.json"], glob:"src/**/*.ts", minCount:1}`) —
  детерминированная фаза в сертификаторе. Первая сеть — coverage-ratchet
  формализации (передний край, А1/А2); material-probe — вторая, механическая.
- **(b) исполнимые (docker compose up + served probe):** warrant-команда
  исполняется провайдером напрямую (`local-runnability-check-provider.ts:
  541-551` — phases[] уже готов принять `warrant:*`), дальше существующая
  served-механика (loopback-probe, clean shutdown, :561-577) как
  универсальное «отвечает». **SEAM слой 2** гоняет то же на собранном целом
  до settlement и пишет трейс `verified_by: warrant-line → evidence-digest`;
  сертификатор может закрыть строку линком, если digest пиннит тот же
  candidateHash — для этого `verified_by` и существует.
- **(c) человек-проверяемые (Chrome «чувствуется»):** класс=human — не fail,
  а **громкая незакрытость**: терминальный сертификат обязан нести «human
  checks outstanding: [...]». Дефект сегодня не в том, что человек не
  проверил, а в том, что ничто не *фиксирует* непроверенность.

**Q3 — fail-closed vs environment-aware.** Отличить грех продукта от греха
машины. Окружение оператора — precondition строки warrant (`requires:
docker`). Docker недоступен → типизированный исход
**`warrant-blocked-environment`**: прогон не 'failed' (это не дефект
продукта) и не зелёный — он *заморожен для решения оператора*: поставить
docker или **waive** с явной записью в сертификат. Никогда тихой подмены,
никогда смерти продукта за грех машины. Переиспользует уже правильную форму
`selectReadinessExecutor` (:612-625): declared-vs-available + типизированный
код, но с третьим исходом вместо бинарного.

**Q4 — стык с А2.** Позиция: **оба, разные теоремы**. Формализация обязана
фейлить свой ratchet — это её дефект. Но warrant-проверка в конце — не
дублирование, а независимое доказательство другой теоремы: formalization
доказывает «AC покрывает ордер», readiness — «сертификат покрывает ордер».
Потеря требует двух независимых отказов, второй — механический. Критично:
сертификатор **не перечитывает ордер** (новый оракул, LLM, «operator's
voice, not a spec») — он диффирует phases против замороженного реестра.

### Touchpoints

1. `src/modules/discovery/domain/discovery-settlement-policy.ts` —
   извлечение warrant-реестра, запись по order_ref.
2. `src/validators/brief.ts:45-64` — `BriefPayload` += перенос реестра через
   мост (стык с передним краем).
3. `src/modules/development/domain/development-schemas.ts:427-431` —
   `DevelopmentReadinessManifest` += `warrantRef`.
4. `src/modules/development/application/development-check-providers.ts:
   365-401` — валидация manifest: из shape-only → warrant-coverage.
5. `src/infrastructure/verification/local-runnability-check-provider.ts:
   518-570` — warrant-фазы, material-probes, исход
   `warrant-blocked-environment`.
6. SEAM слой 2 (`repair/blindsight-integration-verify`) — пишет
   `verified_by`-линки с digest-пиннингом.
7. Терминальный отчёт — секции outstanding-human и waived-lines с
   провенансом override.

### Отвергнутое

- Чеклист «requirements met» в профиле продукта — та же самосертификация,
  многословнее.
- LLM-перечитывание ордера в конце — недетерминированный оракул, сцепление
  конца с прозой.
- Жёсткий терминальный fail на любой дыре — превращает дефект формализации
  в труп после 9 часов; честный красный + repair-issue по слою 3 полезнее.
- «Docker как обязательный субстрат» — команды warrant и субстрат фабрики
  суть разное: `docker compose up` проверяет compose-контракт *продукта*.

### Что НЕ покрывает (честно)

Качество извлечения реестра из прозы (сам шаг LLM-judged и может дрейфовать;
защита — discovery-ассессор, не этот слой); передний край (мост brief,
SRS→AC back-edge — территория А1/А2, дизайн *зависит* от реестра, но не
строит его); стоимость двойного исполнения (частично гасится digest-pinned
линками); семантическую честность исполнения (exit 0 у compose ≠ «Chrome
чувствуется»); злоупотребление waive — нужен operator-only канал override,
здесь только обозначен.

---

## А1 (мост контента): МОСТ-ОБЯЗАТЕЛЬСТВО ✅ (с эмпирической поправкой форензика)

### Поправка к вердикту следователя (проверено по живой БД stage11, readonly)

«Единственный мост brief_payload контент не переносит» — **неточно в
локализации**. Контент границу УЖЕ пересёк: FormalizationCase (коммит
`6c191b9a`, до прогона) несёт `discoveryProposalPayload` целиком → он в
`tasks.metadata.process_node_input` задачи 3 (там `assumptions` =
Chrome/Docker/TypeScript, `candidate_scope` = докинг+compose) → он в самом
spawn-промпте (`claude-runner.mjs` buildPrompt: `JSON.stringify(task)`).
**Автор видел все три требования.** brief_payload — не вход, а ВЫХОД
(запись решения автора, `artifacts.ts:268`). Настоящий дефект: **нет
обязанности реакции** — доставленные данные не обязательны к потреблению.
Это не «данные не доставлены» (форма census), а «не enforced». (Греп
следователя по логу сессии — ноль вхождений — совместимо: слова были в
промпте, модель их ни разу не эхнула/не искала.)

### Дизайн

Принцип: копия уже едет (sealed по ref+hash+payload — одна authority,
ADR-053); недостающее — типизированный реестр constraints с per-ID
диспозицией, enforced детерминированным гейтом. Стык с А3: его warrant-реестр
= этот же реестр (извлечение на discovery-settlement, владелец order-run);
А1 переносит и обязывает, А3 в конце исполняет.

1. **Извлечение** (владелец order-run): discovery-settlement-records +
   settlement-service → `{id: ord-c-NNN, class: execution|material|human,
   text, evidenceRef}`, digest-pinned.
2. **Перенос**: `product-delivery-lifecycle.ts:313-323` (outputMapping) +
   `:348-360` (inputMapping) → FormalizationCase +=
   `constraintRegisterRef/Digest/Register` (`formalization-schemas.ts:19-33`).
3. **Доставка бесплатна**: реестр в `process_node_input`
   (`sqlite-production-cell-projection-persistence.ts:116`) и в промпт;
   скилл saga-product += шаг «отрендерить реестр в brief §constraints с
   диспозицией по каждому ID» + шаблон артефакта с полем
   `constraint_register`.
4. **Enforcement (сердце)**: `formalization-contract-validator.ts:55-75` —
   детерминированный дифф: ID реестра (из кейса) минус диспозиции
   `{id: accepted|waived, reason?, evidence?}` в метаданных brief. Непустой
   остаток → `FORMALIZATION_CONSTRAINT_UNDISPOSED`, типизированные per-ID
   SubmissionGap (`relation: covers_constraint`) — автор на repair получает
   ровно список ID через существующий recovery-feedback путь. Typed-ID, не
   string-match: реакция обязательна, формулировка свободна; waived требует
   reason и течёт дальше.
5. **Передача А3**: formalization settlement
   (`formalization-production-cell-installation.ts:187-231`) цитирует реестр
   + диспозиции как `warrantRef`.

### Отвергнуто

Дублировать proposal второй authority (нарушает ADR-053); ссылка+обязанность
читать (это сегодня — прогон доказал: прочитал и переписал без последствий);
расширять BriefPayload контентом (чужой слой, decision-запись); LLM-оракул
на гейте (отвергнут и А3); `artifact_traces target_type='constraint'` (миграция
CHECK-словаря ради того, что метаданные+дифф дают сейчас).

### Не покрывает

Качество извлечения реестра (LLM-шаг, граница А3); constraints, умершие
внутри discovery (мост начинается с реестра); честность диспозиции (гейт
требует наличие реакции, не правдивость — backstop А3); AC→constraint
back-edge и SRS-восстановление (территория А2); abuse waive (operator-only
канал — обозначено А3); fan-out 1:N (сейчас 1:1).

## А2 (coverage рэтчет): ⏳ в работе

## Синтез трёх: ⏳ после возврата А1+А2
