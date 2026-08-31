import { nodeNames, type Desk, type DeskHook, type Skill, type WorkshopSpec } from './desks.js';
import type { GateCheck } from './kernel/gate.js';

// Компилятор цеха: список столов → декларативный граф ядра (форма n8n).
//
// Граф остаётся ЯЗЫКОМ ИСПОЛНЕНИЯ — ядро по-прежнему интерпретирует
// nodes/connections и ничего не знает про столы. Но ПИСАТЬ граф руками больше
// не нужно: то, что оператор собирает, — это столы, а топология выводится.
// Отсюда два следствия:
//   1) копипаста узлов между цехами невозможна: стол объявлен один раз;
//   2) новый цех не добавляет ни кода, ни тула, ни ручки — только данные.

export interface GraphNode {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface GraphDoc {
  nodes: Record<string, GraphNode>;
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

export const DEFAULT_MODEL = 'zai-coding-plan/glm-5.3-flash';

/** Промпт стола: навык + приложенные артефакты + вход.
 *  Если навык объявил `input_label`, вход подставляется как {{text}};
 *  иначе плейсхолдеры уже стоят внутри инструкции (например, {{title}}). */
export function buildPrompt(skill: Skill, desk: Desk): string {
  const parts = [skill.role, skill.instruction];
  if (skill.output) parts.push(skill.output);
  for (const tool of desk.tools ?? []) {
    if (tool.kind === 'attach') {
      parts.push(`Учитывай приложенный материал «${tool.label ?? tool.path}».`);
    }
  }
  if (skill.input_label) parts.push('', `${skill.input_label}:`, '{{text}}');
  return parts.join('\n');
}

function hookNode(hook: DeskHook): GraphNode {
  switch (hook.kind) {
    case 'json_array':
      return { type: 'json_parse', parameters: {} };
    case 'template':
      return { type: 'template', parameters: { template: hook.template } };
    case 'siblings':
      return {
        type: 'siblings',
        parameters: {
          ...(hook.field ? { field: hook.field } : {}),
          ...(hook.pick ? { pick: hook.pick } : {}),
        },
      };
    case 'overlay':
      return { type: 'overlay', parameters: { ...(hook.key ? { key: hook.key } : {}) } };
    case 'command':
      return {
        type: 'command',
        parameters: {
          run: hook.run,
          label: hook.label ?? hook.run,
          timeout_s: hook.timeout_s ?? 120,
          ...(hook.workdir ? { workdir: hook.workdir } : {}),
          // repo подставляется на старте, как и у эффектов
          repo: '',
        },
      };
  }
}

/** Критерии стола: контракт навыка + собственные + автоматическая проверка
 *  того, что команда-хук действительно прошла. Приёмка обязана опираться на
 *  ИСХОД команды, иначе «программа запускается» остаётся обещанием модели. */
function deskChecks(skill: Skill | undefined, desk: Desk): GateCheck[] {
  const checks: GateCheck[] = [...(skill?.checks ?? []), ...(desk.checks ?? [])];
  const hasCommand = (desk.hooks?.after ?? []).some((hook) => hook.kind === 'command');
  if (hasCommand && !checks.some((check) => check.op === 'command_ok')) {
    checks.push({ op: 'command_ok', field: 'ok' });
  }
  return checks;
}

export interface CompileOptions {
  skills: Record<string, Skill>;
  /** Модель по умолчанию для столов, которые её не объявили. */
  model?: string;
}

export interface CompiledWorkshop {
  graph: GraphDoc;
  /** Узел, в который оператор кладёт стартовый материал (если он есть). */
  entry?: string;
  /** Стол → его узлы, чтобы UI и тесты не угадывали имена. */
  map: Record<string, ReturnType<typeof nodeNames>>;
}

export function compileWorkshop(spec: WorkshopSpec, opts: CompileOptions): CompiledWorkshop {
  const nodes: GraphDoc['nodes'] = {};
  const connections: GraphDoc['connections'] = {};
  const map: CompiledWorkshop['map'] = {};
  const exitOf = new Map<string, string>();
  const publishOf = new Map<string, string>();
  /** Узел, с которого стол взял вход — им публикует стол интеграции. */
  const inputOf = new Map<string, string>();
  let entry: string | undefined;

  const connect = (from: string, to: string): void => {
    const conn = (connections[from] ??= { main: [[]] });
    conn.main[0].push({ node: to });
  };

  for (const desk of spec.desks) {
    const skill = desk.skill === undefined ? undefined : opts.skills[desk.skill];
    if (desk.skill !== undefined && !skill) {
      throw new Error(`SKILL_UNKNOWN: стол '${desk.id}' ссылается на навык '${desk.skill}'`);
    }
    if (!skill && (desk.hooks?.after ?? []).length === 0) {
      throw new Error(`DESK_EMPTY: стол '${desk.id}' без навыка обязан иметь хук — иначе он ничего не производит`);
    }
    const names = nodeNames(desk.id);
    map[desk.id] = names;

    // ── вход
    let cursor: string;
    if (desk.input.kind === 'desk' || desk.input.kind === 'publish') {
      const source = desk.input.kind === 'desk'
        ? exitOf.get(desk.input.desk)
        : publishOf.get(desk.input.desk);
      if (!source) {
        throw new Error(
          desk.input.kind === 'publish'
            ? `DESK_INPUT_INVALID: стол '${desk.id}' ждёт публикацию стола '${desk.input.desk}', а тот ничего не публикует`
            : `DESK_ORDER_INVALID: стол '${desk.id}' читает '${desk.input.desk}', который идёт позже`
        );
      }
      cursor = source;
    } else {
      nodes[names.input] = {
        type: 'emit',
        parameters: {
          items: [{ json: { text: '', ...(desk.input.kind === 'artifact' ? { source_ref: desk.input.path } : {}) } }],
        },
      };
      cursor = names.input;
      entry ??= names.input;
    }

    // ── хуки до воркера
    (desk.hooks?.before ?? []).forEach((hook, index) => {
      const name = names.before(index);
      nodes[name] = hookNode(hook);
      connect(cursor, name);
      cursor = name;
    });
    inputOf.set(desk.id, cursor);

    // ── воркер (или веер воркеров)
    const workerParameters: Record<string, unknown> = {
      mode: 'opencode',
      model: desk.model ?? opts.model ?? DEFAULT_MODEL,
      prompt: skill ? buildPrompt(skill, desk) : '',
      ...(desk.timeouts ? { timeouts: desk.timeouts } : {}),
      ...(desk.tools?.some((tool) => tool.kind === 'attach')
        ? { attach: desk.tools.filter((tool) => tool.kind === 'attach'), repo: '' }
        : {}),
    };

    // Порядок без подмены входа: материал остаётся тем, что объявил `input`,
    // а зависимости приходят воркеру дополнительным ребром (контекст).
    const ordering = (desk.depends_on ?? []).map((id) => {
      const source = exitOf.get(id);
      if (!source) throw new Error(`DESK_ORDER_INVALID: стол '${desk.id}' зависит от '${id}', который идёт позже`);
      return source;
    });

    let workerNode: string | undefined;
    if (skill && desk.fanout) {
      nodes[names.split] = {
        type: 'split',
        parameters: { child: { type: 'llm', parameters: workerParameters } },
      };
      connect(cursor, names.split);
      nodes[names.join] = { type: 'join', parameters: {} };
      connect(names.split, names.join);
      cursor = names.join;
      workerNode = names.split;
    } else if (skill) {
      nodes[names.worker] = { type: 'llm', parameters: workerParameters };
      connect(cursor, names.worker);
      cursor = names.worker;
      workerNode = names.worker;
    }
    for (const source of ordering) {
      if (source !== cursor) connect(source, cursor);
    }

    // ── хуки после воркера
    // Команда производит ДОКАЗАТЕЛЬСТВО, а не материал: она обосновывает
    // приёмку, но публиковать нужно то, что было до неё.
    let materialNode = cursor;
    let seenCommand = false;
    (desk.hooks?.after ?? []).forEach((hook, index) => {
      const name = names.after(index);
      nodes[name] = hookNode(hook);
      // Склейка читает БАЗУ (вход стола) и ЗАПЛАТКУ (то, что произвёл воркер).
      // База объявляется первой — поздний item побеждает раннего.
      if (hook.kind === 'overlay' && hook.with === 'input') {
        const base = inputOf.get(desk.id);
        if (base) connect(base, name);
      }
      connect(cursor, name);
      cursor = name;
      if (hook.kind === 'command') seenCommand = true;
      else if (!seenCommand) materialNode = name;
    });

    // ── приёмка
    const gateInput = cursor;
    const checks = deskChecks(skill, desk);
    if (checks.length > 0) {
      // Веер переделать нельзя: повторный запуск split породил бы те же
      // (уже завершённые) узлы, и гейт крутился бы вхолостую. Поэтому у
      // веерного стола бюджет доработок по умолчанию нулевой — решает человек.
      const maxRepairs = desk.max_repairs ?? (desk.fanout ? 0 : 2);
      nodes[names.gate] = {
        type: 'gate',
        parameters: {
          checks,
          // Доработку делает тот, кто произвёл материал: сценарные хуки
          // повторять бессмысленно, они детерминированы.
          ...(workerNode ? { repair_target: workerNode } : {}),
          max_repairs: maxRepairs,
          title: `${spec.title}: ${desk.title}`,
        },
      };
      connect(cursor, names.gate);
      // Команда заменяет содержимое стола ДОКАЗАТЕЛЬСТВОМ (ok/exit_code/output),
      // и критерии навыка («ответ — это JSON-массив») проверять стало бы не на
      // чем. Поэтому при наличии команды гейт судит СОЮЗ: что воркер произвёл
      // и что показал запуск.
      if (seenCommand && workerNode && workerNode !== cursor) connect(workerNode, names.gate);
      cursor = names.gate;
    }

    // ── публикация артефакта (боковая ветка от приёмки)
    if (desk.publish) {
      nodes[names.publish] = {
        type: 'effect',
        parameters: {
          mode: 'git',
          repo: '',
          branch: 'main',
          message: desk.publish.message ?? `${desk.id}: artifact`,
          ...(desk.publish.files_from === 'items'
            ? { files_from: 'items' }
            : { files: [{ path: desk.publish.path ?? `${desk.id}.md`, field: desk.publish.field ?? 'text' }] }),
        },
      };
      connect(cursor, names.publish);
      // Эффект зависит от приёмки (порядок) И от узла материала (содержимое).
      // `from: 'input'` публикует то, что стол ПРИНЯЛ на вход — так работает
      // стол интеграции: ревьюер одобряет чужой материал, публикуется он.
      // Лишнее ребро добавляем ТОЛЬКО когда материал не совпадает с тем, что
      // читает приёмка: иначе эффект получил бы один и тот же текст дважды.
      const source = desk.publish.from === 'input' ? inputOf.get(desk.id) : materialNode;
      if (source && source !== cursor && source !== gateInput) connect(source, names.publish);
      publishOf.set(desk.id, names.publish);
    }

    exitOf.set(desk.id, cursor);
  }

  return { graph: { nodes, connections }, entry, map };
}
