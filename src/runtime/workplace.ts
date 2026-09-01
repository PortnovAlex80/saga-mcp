import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// РАБОЧЕЕ МЕСТО — стол, материализованный в каталог.
//
// До сих пор рабочий получал один промпт и пустую песочницу: он знал ЗАДАНИЕ,
// но не знал ПУТИ к цели и ничего не знал о том, что здесь уже пробовали.
// Приёмка умела только отвергнуть — направить она не умеет.
//
// Стол — это МЕСТО. Каталог живёт столько же, сколько узел: следующий рабочий
// приходит на то же место, находит трекер с отметками предшественника и
// замечания приёмки. «Нанимают следующего НА ТО ЖЕ место с обратной связью»
// перестаёт быть метафорой конвейера и становится физикой каталога.

/** Файлы стола. Они принадлежат ЗАВОДУ, а не продукту: рабочий их ведёт,
 *  но в урожай они не попадают никогда. */
export const TRACKER = 'TRACKER.md';
export const FEEDBACK = 'FEEDBACK.md';
export const CHECKLIST = 'CHECKLIST.md';
export const WORKPLACE_FILES: readonly string[] = [TRACKER, FEEDBACK, CHECKLIST];

export interface WorkplacePlan {
  /** Цех и стол — чтобы рабочий знал, где стоит. */
  workshop?: string;
  desk: string;
  /** Одной строкой: зачем этот стол существует. */
  goal: string;
  /** Путь к цели: шаги, которые рабочий отмечает по мере выполнения. */
  steps: string[];
  /** Самопроверка перед сдачей. */
  checklist: string[];
  /** Границы записи: только эти файлы рабочему разрешено создавать и менять. */
  owns?: string[];
  /** Замечания приёмки за прошлый круг. */
  feedback?: string | null;
  /** Какой круг работы идёт на этом месте. */
  round: number;
}

/** Каталог места — по прогону и узлу, а НЕ по попытке: место переживает
 *  рабочего. Имя узла может содержать `::` (веер), поэтому нормализуем. */
export function workplaceDir(runId: string, nodeId: string): string {
  const safe = nodeId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(tmpdir(), 'saga5-workplace', runId, safe);
}

function renderTracker(plan: WorkplacePlan): string {
  const head = plan.workshop ? `${plan.workshop} · ${plan.desk}` : plan.desk;
  const lines = [
    `# Рабочий стол: ${head}`,
    '',
    '> Это ТВОЙ путь к цели. Веди его: отмечай `[x]`, как только по шагу есть',
    '> durable-результат (файл записан, проверка пройдена). Следующий рабочий',
    '> на этом месте — возможно, ты сам после доработки — читает именно это.',
    '',
    '## Цель стола',
    '',
    plan.goal,
    '',
    '## Счётчик',
    '',
    `- круг работы на этом месте: \`${plan.round}\``,
    `- замечания приёмки: \`${plan.feedback ? `есть — читай ${FEEDBACK}` : 'нет'}\``,
    '',
  ];
  if (plan.owns && plan.owns.length > 0) {
    lines.push(
      '## Граница записи',
      '',
      'Тебе разрешено создавать и менять ТОЛЬКО эти файлы:',
      '',
      ...plan.owns.map((file) => `- \`${file}\``),
      '',
      'Файл вне границы завод не примет — он будет отброшен вместе с работой,',
      'которая на него опирается. Если цель СТОЛА действительно требует другого',
      'файла — не создавай его молча: напиши в ответе строку',
      '`ГРАНИЦА: <нужный файл> — <зачем>` и сделай остальное. Расширение границы',
      'решает завод, а не рабочий.',
      '',
    );
  }
  lines.push('## Шаги', '');
  for (const [index, step] of plan.steps.entries()) {
    lines.push(`- [ ] ${index + 1}. ${step}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderChecklist(plan: WorkplacePlan): string {
  return [
    `# Самопроверка перед сдачей: ${plan.desk}`,
    '',
    'Пройди по списку ДО того, как закончишь ответ. Приёмка проверяет то же',
    'самое, но она умеет только отвергнуть — а ты умеешь исправить.',
    '',
    ...plan.checklist.map((item) => `- [ ] ${item}`),
    '',
  ].join('\n');
}

function renderFeedback(plan: WorkplacePlan): string {
  return [
    `# Замечания приёмки (круг ${plan.round - 1} → ${plan.round})`,
    '',
    '> Работу на этом месте не приняли. Это НЕ повод начинать с нуля: читай,',
    '> что именно не сошлось, и устраняй причину. Всё, что не названо здесь,',
    '> менять не нужно.',
    '',
    String(plan.feedback ?? '').trim(),
    '',
  ].join('\n');
}

/** Обустроить место: путь, самопроверка и — если это не первый круг —
 *  замечания предшественника. Возвращает каталог. */
export function materializeWorkplace(dir: string, plan: WorkplacePlan): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, TRACKER), renderTracker(plan), 'utf8');
  writeFileSync(path.join(dir, CHECKLIST), renderChecklist(plan), 'utf8');
  const feedbackPath = path.join(dir, FEEDBACK);
  if (plan.feedback && plan.feedback.trim()) {
    writeFileSync(feedbackPath, renderFeedback(plan), 'utf8');
  } else if (existsSync(feedbackPath)) {
    // Замечания прошлого круга сняты — оставлять их значит врать рабочему.
    rmSync(feedbackPath, { force: true });
  }
  return dir;
}

/** Строки промпта, направляющие рабочего к его пути. Промпт — единственный
 *  канал, которым мы владеем целиком: хуки opencode в 1.18.18 ненадёжны, а
 *  инструкция, подложенная в вывод инструмента, справедливо читается моделью
 *  как инъекция (проверено живьём). Поэтому путь лежит файлом, а промпт на
 *  него указывает. */
export function workplaceBriefing(plan: WorkplacePlan): string {
  const lines = [
    '',
    '=== РАБОЧЕЕ МЕСТО ===',
    `Ты за столом «${plan.desk}». В рабочем каталоге лежит твой путь к цели.`,
  ];
  if (plan.feedback && plan.feedback.trim()) {
    lines.push(
      `СНАЧАЛА прочитай ${FEEDBACK}: работу на этом месте уже не приняли,`,
      'и переделывать вслепую нельзя.'
    );
  }
  lines.push(
    `Прочитай ${TRACKER} — это цель стола и шаги. Веди его: отмечай сделанное,`,
    'чтобы следующий рабочий на этом месте видел, где ты остановился.',
    `Перед тем как закончить, пройди ${CHECKLIST}.`
  );
  if (plan.owns && plan.owns.length > 0) {
    lines.push(
      `Граница записи — только: ${plan.owns.join(', ')}. Файл вне границы завод отбросит.`
    );
  }
  lines.push('=====================', '');
  return lines.join('\n');
}

/** Что рабочий уже успел отметить — для журнала и для доски. */
export function trackerProgress(dir: string): { done: number; total: number } | undefined {
  try {
    const text = readFileSync(path.join(dir, TRACKER), 'utf8');
    const total = (text.match(/^- \[[ x]\] /gm) ?? []).length;
    const done = (text.match(/^- \[x\] /gm) ?? []).length;
    return total > 0 ? { done, total } : undefined;
  } catch {
    return undefined;
  }
}
