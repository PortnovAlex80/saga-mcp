import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Artifact, type ArtifactBody } from './api';

// Мини-вики: артефакты завода — это материалы стола, а не отдельная сущность.
// Правка артефакта = сдача материала оператором (author=operator): тот же
// журнал, то же накопление стола, тот же гейт. Никакого второго авторитета.

/** Достаточно markdown, чтобы бриф и SRS читались; без зависимостей и без
 *  innerHTML — узлы строятся явно. */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => text.split(/\n{2,}/), [text]);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        const fence = block.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
        if (fence) return <pre key={index}><code>{fence[1]}</code></pre>;
        const heading = block.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const Tag = (['h2', 'h3', 'h4', 'h5'] as const)[heading[1].length - 1];
          return <Tag key={index}>{inline(heading[2])}</Tag>;
        }
        const lines = block.split('\n');
        if (lines.every((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line))) {
          return (
            <ul key={index}>
              {lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>)}
            </ul>
          );
        }
        return <p key={index}>{lines.map((line, i) => <Fragment key={i}>{inline(line)}<br /></Fragment>)}</p>;
      })}
    </div>
  );
}

function inline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <b key={index}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

interface Props {
  runId?: string;
  onClearRun(): void;
}

export function Wiki({ runId, onClearRun }: Props) {
  const [list, setList] = useState<Artifact[]>([]);
  const [acceptedOnly, setAcceptedOnly] = useState(false);
  const [current, setCurrent] = useState<ArtifactBody | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setList(await api.artifacts({ run_id: runId, accepted_only: acceptedOnly }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [runId, acceptedOnly]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const open = useCallback(async (artifact: Artifact) => {
    setEditing(false);
    setInfo('');
    try {
      const body = await api.artifact(artifact);
      setCurrent(body);
      setDraft(body.body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const submit = useCallback(async () => {
    if (!current) return;
    try {
      // Правится ОДИН item материала; остальные едут без изменений, чтобы
      // сданный материал остался тем же по форме, а не «текстом вместо файла».
      const items = current.items.map((item, index) =>
        index === current.index && current.field
          ? { json: { ...item.json, [current.field]: draft } }
          : item
      );
      const result = await api.submit(current.run_id, current.node_id, {
        items,
        note: note || `правка артефакта ${current.name} оператором`,
      });
      setInfo(`сдано: ${result.digest.slice(0, 12)}… → прогон ${result.run.status}`);
      setEditing(false);
      setNote('');
      await refresh();
      // Приёмка могла измениться прямо сейчас — перечитываем открытый артефакт,
      // чтобы бейдж «принят» не врал.
      setCurrent(await api.artifact(current).catch(() => current));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [current, draft, note, refresh]);

  const groups = useMemo(() => {
    const byRun = new Map<string, Artifact[]>();
    for (const artifact of list) {
      const key = `${artifact.workflow}·${artifact.run_id}`;
      byRun.set(key, [...(byRun.get(key) ?? []), artifact]);
    }
    return [...byRun.entries()];
  }, [list]);

  return (
    <div className="wiki">
      <aside className="wiki-index">
        <div className="wiki-filters">
          <label className="check">
            <input type="checkbox" checked={acceptedOnly} onChange={(e) => setAcceptedOnly(e.target.checked)} />
            только принятые
          </label>
          {runId && <button onClick={onClearRun}>все прогоны</button>}
        </div>
        {groups.map(([key, artifacts]) => (
          <section key={key}>
            <h4>{key.split('·')[0]} <span className="tag ghost">{key.split('·')[1].slice(0, 8)}</span></h4>
            {artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className={`wiki-item${current?.id === artifact.id ? ' selected' : ''}`}
                onClick={() => open(artifact)}
              >
                <b>{artifact.name}</b>
                <div className="card-meta">
                  <span className="tag">{artifact.kind}</span>
                  {artifact.accepted && <span className="tag ok">принят</span>}
                  <span className="tag ghost">{artifact.node_id}</span>
                  <span className="tag ghost">{artifact.bytes} B</span>
                </div>
              </div>
            ))}
          </section>
        ))}
        {list.length === 0 && <p className="hint">артефактов пока нет — запусти цех на доске</p>}
        {error && <p className="error">{error}</p>}
      </aside>

      <main className="wiki-body">
        {current ? (
          <>
            <header className="wiki-head">
              <div>
                <h2>{current.path ?? current.name}</h2>
                <p className="card-meta">
                  <span className="tag">{current.node_id}</span>
                  <span className="tag ghost">digest {current.digest.slice(0, 12)}…</span>
                  <span className="tag ghost">run {current.run_id.slice(0, 8)}</span>
                  {current.accepted ? <span className="tag ok">принят гейтом</span> : <span className="tag warn">не принят</span>}
                </p>
              </div>
              <div className="row">
                {current.editable && !editing && <button onClick={() => setEditing(true)}>✎ Редактировать</button>}
                {editing && <button onClick={submit}>⇪ Сдать на стол</button>}
                {editing && <button onClick={() => { setEditing(false); setDraft(current.body); }}>Отмена</button>}
              </div>
            </header>
            {info && <p className="run-info">{info}</p>}
            {editing ? (
              <>
                <textarea className="wiki-editor" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <label>Зачем правка (попадёт в журнал)</label>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="причина правки…" />
                <p className="hint">
                  Правка сдаётся как материал (author=operator) и попадает на стол узла
                  «{current.node_id}». Гейт пересмотрит ревизию по тем же критериям.
                </p>
              </>
            ) : current.kind === 'markdown' ? (
              <Markdown text={current.body} />
            ) : (
              <pre className="wiki-raw">{current.body}</pre>
            )}
          </>
        ) : (
          <p className="hint">выбери артефакт слева</p>
        )}
      </main>
    </div>
  );
}
