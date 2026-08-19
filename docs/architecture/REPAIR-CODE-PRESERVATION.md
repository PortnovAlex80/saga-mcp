# REPAIR CODE PRESERVATION — три архитектора сошлись

## Единый вердикт: ДЕФЕКТ, не tradeoff

Три независимых анализа сходятся: код предыдущей попытки НЕ теряется
(ветки живут в shared refs), но воркер ослеплён — никто не говорит ему
что предыдущий код существует. Та же слепота уже была починена для
artifact_change (source_snapshot), но не для git_change.

## Доказательства (по архитекторам):

**Арх-1 (сохранение):** ревьюер ВИДИТ код (явно отказывается от "latest
across repair generations"), автор — НЕТ. Асимметрия. Комментарий в коде
сам говорит "the author is blind — five submissions editing one file from
model memory" — болезнь известна.

**Арх-2 (git-механизм):** ветки НЕ удаляются (disposeDesk = мёртвый код,
branch -D только в docs-worktree). Живой прогон подтверждает: обе ветки
task-16 существуют. Скилл говорит «не повторяй отвергнутое» но не даёт
способа УВИДЕТЬ что повторять не надо. Реальный фидбек был scope-жалоба,
не код-качество — 373 строки были выброшены из-за mechanical complaint.

**Арх-3 (дизайн-альтернатива):** Formalization переносит черновики
(isFresh/isReusable), Development — нет. Корень: код в worktree (вне
workspace), carry-forward = template-scoped. Не закон, а plumbing gap.

## Решение (все трое): previous-attempt.{json,patch} на desk

При repair-provisioning (managed_review_rejections > 0):
```
git diff <merge-base>..<previousAttemptHead>
→ записать previous-attempt.patch + previous-attempt.json {branch, commitSha}
→ в execution workspace (рядом с recovery-feedback.json)
→ + одна строка в промпте
```

**Почему НЕ merge** (авто-наследование отвергнутого = anchoring bias: воркер
патчит плохое вместо переосмысления). **Почему НЕ rebase** (нарушает frozen-base
контракт). Patch-файл = видеть но не быть связанным — чистый лист сохранён,
глаза открыты.

~30 строк в provisionAuthorDesk. Нулевой conflict risk.
