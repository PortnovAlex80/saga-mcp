import type { Desk, WorkshopSpec } from './desks.js';

// Цеха как ДАННЫЕ: список столов, а не нарисованный граф.
//
// Один и тот же стол переиспользуется между цехами (brief живёт в discovery,
// product и factory), поэтому копипаста узлов — та самая болезнь, с которой
// начиналась saga4, — структурно невозможна.

/** Дымовые проверки: {{tools}} подставляется на старте (абсолютный путь).
 *  Статическая ловит битые ссылки и синтаксис; браузерная — то, что видит
 *  пользователь: ошибки в консоли, пустой холст, неподключившийся модуль. */
const SMOKE_STATIC = 'node "{{tools}}/smoke-static.mjs" .';
const SMOKE_BROWSER = 'node "{{tools}}/smoke-browser.mjs" .';

const briefDesk: Omit<Desk, 'input'> = {
  id: 'brief',
  title: 'Бриф продукта',
  skill: 'brief',
  publish: { path: 'discovery/brief.md', message: 'discovery: brief artifact' },
};

const srsDesk: Omit<Desk, 'input'> = {
  id: 'srs',
  title: 'SRS (FR/NFR/UC/AC)',
  skill: 'srs',
  publish: { path: 'formalization/srs.md', message: 'formalization: SRS artifact' },
};

const planDesk: Omit<Desk, 'input'> = {
  id: 'plan',
  title: 'План независимых задач',
  skill: 'plan',
};

/** Реализация: по воркеру на задачу. Бюджет доработок нулевой — переделать
 *  веер автоматически нельзя, решение принимает человек. */
const implementDesk: Desk = {
  id: 'implement',
  title: 'Параллельная реализация задач',
  skill: 'implement',
  fanout: true,
  input: { kind: 'desk', desk: 'plan' },
  // Соседи по вееру: владелец index.html должен знать, какие файлы создают
  // другие задачи, иначе сборка разъезжается ссылкой на несуществующий файл.
  hooks: { before: [{ kind: 'json_array' }, { kind: 'siblings' }] },
  // Столы не объявляют бюджетов: пока модель производит — её не трогают.
  // Сторож один — сердцебиение воркера (DEFAULT_TIMEOUTS).
};

/** Ревью — суждение о коде. */
const reviewDesk: Desk = {
  id: 'review',
  title: 'Ревью кода',
  skill: 'review',
  input: { kind: 'desk', desk: 'implement' },
};

/** Сборка: приводит куски разных воркеров к согласованному набору и ПРОВЕРЯЕТ
 *  его запуском во временном каталоге — до публикации. Отказ команды уезжает в
 *  причину гейта, а гейт возвращает работу сборщику: доработка возможна, и в
 *  репозиторий попадает только то, что запускается. */
const assembleDesk: Desk = {
  id: 'assemble',
  title: 'Сборка и запуск приложения',
  skill: 'assemble',
  // Материал сборщика — ФАЙЛЫ реализации; ревью приходит как контекст
  // (замечания) и как порядок: собираем после того, как ревьюер высказался.
  input: { kind: 'desk', desk: 'implement' },
  depends_on: ['review'],
  hooks: {
    after: [
      // Заплатка сборщика ложится на исходный набор: он правит файлы на месте
      // и отдаёт только изменённые, а неизменные приходят со входа стола.
      { kind: 'overlay', key: 'path', with: 'input' },
      { kind: 'command', run: SMOKE_STATIC, label: 'smoke-static', timeout_s: 120, workdir: 'items' },
      // Второй, более честный вопрос: страница РАБОТАЕТ? Расхождение
      // контрактов между параллельными воркерами статикой не ловится —
      // оба файла корректны, а на экране пусто (поймано живьём на Элите).
      { kind: 'command', run: SMOKE_BROWSER, label: 'smoke-browser', timeout_s: 180, workdir: 'items' },
    ],
  },
  publish: { files_from: 'items', message: 'development: assembled application' },
  max_repairs: 5,
};

/** Финальная честность: запускаем то, что РЕАЛЬНО легло в репозиторий.
 *  Здесь чинить уже нечего — расхождение с проверенным кандидатом означает
 *  проблему публикации, а это дело человека. */
const smokeDesk: Desk = {
  id: 'smoke',
  title: 'Запуск опубликованного приложения',
  input: { kind: 'publish', desk: 'assemble' },
  hooks: {
    after: [
      { kind: 'command', run: SMOKE_STATIC, label: 'smoke-published', timeout_s: 120 },
      { kind: 'command', run: SMOKE_BROWSER, label: 'browser-published', timeout_s: 180 },
    ],
  },
  max_repairs: 0,
};

/** ЗАКАЗ НА ИЗМЕНЕНИЕ. Продукт уже существует; человек поправил спецификацию.
 *
 *  Отличие от выпуска с нуля — не в столах, а в том, что лежит НА столах:
 *  рабочая копия продукта. Поэтому «внести правку» не вырождается в «написать
 *  заново», а всё, чего правка не касается, остаётся ровно как было.
 *
 *  Судит приёмка не заплатку, а продукт С ПРИМЕНЁННОЙ заплаткой: обломок
 *  запустить нельзя, и проверять его бессмысленно. */
const changePlanDesk: Desk = {
  id: 'change_plan',
  title: 'План изменений',
  skill: 'change-plan',
  input: { kind: 'operator', field: 'change', label: 'Что изменилось в спецификации' },
};

const reviseDesk: Desk = {
  id: 'revise',
  title: 'Внесение изменений',
  skill: 'revise',
  fanout: true,
  input: { kind: 'desk', desk: 'change_plan' },
  hooks: { before: [{ kind: 'json_array' }] },
};

const changeAssembleDesk: Desk = {
  id: 'change_assemble',
  title: 'Сверка и запуск изменённого продукта',
  skill: 'assemble',
  // Сборщику нужен ВЕСЬ продукт: сверять контракты по одной заплатке нельзя.
  worktree: true,
  input: { kind: 'desk', desk: 'revise' },
  hooks: {
    after: [
      { kind: 'overlay', key: 'path', with: 'input' },
      { kind: 'command', run: SMOKE_STATIC, label: 'smoke-static', timeout_s: 120, workdir: 'worktree' },
      { kind: 'command', run: SMOKE_BROWSER, label: 'smoke-browser', timeout_s: 180, workdir: 'worktree' },
    ],
  },
  publish: { files_from: 'items', message: 'change: applied specification change' },
  max_repairs: 5,
};

export const WORKSHOP_SPECS: Record<string, WorkshopSpec> = {
  factory: {
    id: 'factory',
    title: 'Завод под ключ — идея → бриф → SRS → задачи → код → запуск',
    desks: [
      { ...briefDesk, input: { kind: 'operator', field: 'idea', label: 'Идея продукта' } },
      { ...srsDesk, input: { kind: 'desk', desk: 'brief' } },
      { ...planDesk, input: { kind: 'desk', desk: 'srs' } },
      implementDesk,
      reviewDesk,
      assembleDesk,
      smokeDesk,
    ],
  },

  product: {
    id: 'product',
    title: 'Продуктовый конвейер — Discovery + Formalization единым прогоном',
    desks: [
      { ...briefDesk, input: { kind: 'operator', field: 'idea', label: 'Идея продукта' } },
      { ...srsDesk, input: { kind: 'desk', desk: 'brief' } },
    ],
  },

  discovery: {
    id: 'discovery',
    title: 'Discovery Desk — идея → бриф → артефакт',
    desks: [{ ...briefDesk, input: { kind: 'operator', field: 'idea', label: 'Идея продукта' } }],
  },

  change: {
    id: 'change',
    title: 'Заказ на изменение — правка спецификации → правка кода',
    desks: [changePlanDesk, reviseDesk, changeAssembleDesk],
  },

  formalization: {
    id: 'formalization',
    title: 'Formalization Desk — бриф → SRS (FR/NFR/UC/AC)',
    desks: [{
      ...srsDesk,
      input: {
        kind: 'artifact',
        path: 'discovery/brief.md',
        field: 'brief',
        label: 'Бриф (пусто — возьмём принятый артефакт discovery/brief.md)',
      },
    }],
  },

  development: {
    id: 'development',
    title: 'Development Desk — SRS → задачи → параллельная реализация → ревью → запуск',
    desks: [
      {
        ...planDesk,
        input: {
          kind: 'artifact',
          path: 'formalization/srs.md',
          field: 'srs',
          label: 'SRS (пусто — возьмём принятый артефакт formalization/srs.md)',
        },
      },
      implementDesk,
      reviewDesk,
      assembleDesk,
      smokeDesk,
    ],
  },
};
