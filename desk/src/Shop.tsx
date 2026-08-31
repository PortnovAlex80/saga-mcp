import { useCallback, useEffect, useState } from 'react';
import { api, type DeskView, type SkillView, type WorkshopInfo } from './api';

// Вкладка «Цеха»: цех — это СПИСОК СТОЛОВ, а не нарисованный граф.
//
// Канвас отвечает на вопрос «как устроено», доска — «что происходит», а здесь
// оператор видит то, из чего работа собрана: навык, вход, инструменты, хуки,
// приёмка, выход. Топология — производная и показана справа как развёртка.

const INPUT_LABEL: Record<string, (input: DeskView['input']) => string> = {
  operator: () => 'оператор',
  desk: (input) => `материал стола «${input.desk}»`,
  publish: (input) => `публикация стола «${input.desk}»`,
  artifact: (input) => `артефакт ${input.path}`,
};

const HOOK_LABEL: Record<string, string> = {
  json_array: 'разобрать JSON-массив',
  template: 'шаблон',
  siblings: 'сводка о соседях по вееру',
  command: 'команда',
};

function Hooks({ title, hooks }: { title: string; hooks?: Array<Record<string, unknown>> }) {
  if (!hooks?.length) return null;
  return (
    <div className="desk-row">
      <span className="desk-key">{title}</span>
      <span>
        {hooks.map((hook, index) => (
          <span key={index} className="tag">
            {HOOK_LABEL[String(hook.kind)] ?? String(hook.kind)}
            {hook.kind === 'command' && <> · {String(hook.label ?? hook.run)}</>}
            {hook.workdir === 'items' && <> · кандидат</>}
          </span>
        ))}
      </span>
    </div>
  );
}

function DeskCard({ desk, skill }: { desk: DeskView; skill?: SkillView }) {
  const checks = [...(skill?.checks ?? []), ...(desk.checks ?? [])];
  const tools = desk.tools ?? [];
  const hooks = desk.hooks ?? {};
  return (
    <article className="desk-card">
      <header>
        <b>{desk.title}</b>
        <span className="tag ghost">{desk.id}</span>
        {desk.fanout && <span className="tag warn">веер: по воркеру на задачу</span>}
        {!desk.skill && <span className="tag">без модели</span>}
      </header>

      <div className="desk-row">
        <span className="desk-key">вход</span>
        <span>{INPUT_LABEL[desk.input.kind]?.(desk.input) ?? desk.input.kind}</span>
      </div>

      {skill && (
        <div className="desk-row">
          <span className="desk-key">навык</span>
          <span>
            <b>{skill.title}</b>
            <details>
              <summary>инструкция</summary>
              <pre>{[skill.role, skill.instruction, skill.output].filter(Boolean).join('\n')}</pre>
            </details>
          </span>
        </div>
      )}

      {tools.length > 0 && (
        <div className="desk-row">
          <span className="desk-key">инструменты</span>
          <span>{tools.map((tool, index) => (
            <span key={index} className="tag">{tool.kind}: {tool.path}</span>
          ))}</span>
        </div>
      )}

      <Hooks title="до работы" hooks={hooks.before} />
      <Hooks title="после работы" hooks={hooks.after} />

      {checks.length > 0 && (
        <div className="desk-row">
          <span className="desk-key">приёмка</span>
          <span>
            {checks.map((check, index) => (
              <span key={index} className="tag ok" title="критерий из навыка или стола">
                {check.op}{check.pattern ? `: ${check.pattern}` : ''}{check.value ? `: ${check.value}` : ''}
              </span>
            ))}
          </span>
        </div>
      )}

      {desk.publish && (
        <div className="desk-row">
          <span className="desk-key">выход</span>
          <span className="tag">
            {desk.publish.files_from === 'items' ? 'файлы из материала' : desk.publish.path}
          </span>
        </div>
      )}
    </article>
  );
}

export function Shop() {
  const [workshops, setWorkshops] = useState<Record<string, WorkshopInfo>>({});
  const [skills, setSkills] = useState<Record<string, SkillView>>({});
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.workshops(), api.skills()])
      .then(([list, library]) => {
        setWorkshops(list);
        setSkills(library);
        setName((current) => current || Object.keys(list)[0] || '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const current = workshops[name];

  const copySpec = useCallback(() => {
    if (current) navigator.clipboard.writeText(JSON.stringify(current.desks, null, 2));
  }, [current]);

  return (
    <div className="shop">
      <div className="shop-bar">
        <select value={name} onChange={(e) => setName(e.target.value)}>
          {Object.entries(workshops).map(([id, info]) => (
            <option key={id} value={id}>{info.title}</option>
          ))}
        </select>
        <span className="hint">
          цех = список столов; граф справа — его развёртка, а не источник истины
        </span>
        <button onClick={copySpec}>Копировать спецификацию</button>
        {error && <span className="error">{error}</span>}
      </div>

      <div className="shop-body">
        <section className="desk-list">
          {current?.desks.map((desk) => (
            <DeskCard key={desk.id} desk={desk} skill={desk.skill ? skills[desk.skill] : undefined} />
          ))}
        </section>

        <aside className="shop-graph">
          <h3>Развёртка в граф</h3>
          <ol>
            {current?.shape.map((node) => (
              <li key={node.node}>
                <code>{node.node}</code> <span className="tag ghost">{node.type}</span>
                {node.next.length > 0 && <span className="hint"> → {node.next.join(', ')}</span>}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
