import { useCallback, useEffect, useState } from 'react';
import { api, type BoardData, type Card, type CardStatus, type RunEvent, type WorkshopInfo } from './api';

// Канбан-доска. Карточка = стол одного узла одного прогона. Карточку НЕЛЬЗЯ
// перетащить в «done»: колонка выводится из журнала. Единственное действие
// оператора здесь — решение на человеческом гейте (обычное событие ядра).

const COLUMN_TITLES: Record<CardStatus, string> = {
  todo: 'Не начато',
  in_progress: 'В работе',
  review: 'На доработке',
  blocked: 'Ждёт оператора',
  done: 'Принято',
  failed: 'Отказ',
};

const TYPE_GLYPH: Record<string, string> = {
  emit: '⏺', template: '✎', collect: '⤵', fail: '✕', llm: '✦',
  gate: '⚖', effect: '⚡', split: '⑃', join: '⑂', json_parse: '{ }',
};

/** Светофор карточки: зелёный — идёт/принято, жёлтый — нужно внимание,
 *  красный — отказ. Пульсирует то, что происходит ПРЯМО СЕЙЧАС или ждёт
 *  человека. Подсказка — словами, чтобы цвет не был единственным носителем
 *  смысла. */
const DOT_TITLE: Record<CardStatus, string> = {
  todo: 'не начато: либо ждёт свободного воркера, либо ещё не дошла очередь по маршруту',
  in_progress: 'в работе прямо сейчас',
  review: 'на доработке — гейт вернул материал',
  blocked: 'ждёт решения оператора',
  done: 'принято гейтом',
  failed: 'отказ',
};

function relative(iso: string): string {
  const delta = (Date.now() - Date.parse(`${iso.replace(' ', 'T')}Z`)) / 1000;
  if (!Number.isFinite(delta)) return iso;
  if (delta < 60) return 'только что';
  if (delta < 3600) return `${Math.floor(delta / 60)} мин назад`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} ч назад`;
  return `${Math.floor(delta / 86400)} дн назад`;
}

interface Props {
  onOpenArtifacts(runId: string): void;
}

export function Board({ onOpenArtifacts }: Props) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [selected, setSelected] = useState<Card | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const [workshops, setWorkshops] = useState<Record<string, WorkshopInfo>>({});
  const [wsName, setWsName] = useState('');
  const [wsInput, setWsInput] = useState<Record<string, string>>({});
  const [startInfo, setStartInfo] = useState('');

  const refresh = useCallback(async () => {
    try {
      setData(await api.board({ active_only: activeOnly }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeOnly]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    api.workshops().then((list) => {
      setWorkshops(list);
      setWsName((current) => current || Object.keys(list)[0] || '');
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selected) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      api.runEvents(selected.run_id)
        .then((payload) => {
          if (!cancelled) setEvents(payload.events.filter((e) => e.payload_json.includes(selected.node_id)));
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selected]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (!selected) return;
      setBusy(true);
      try {
        await api.resolve(selected.run_id, selected.node_id, decision, note || undefined);
        await api.resume(selected.run_id);
        setNote('');
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [selected, note, refresh]
  );

  const retry = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.retry(selected.run_id, selected.node_id, note || undefined);
      setNote('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selected, note, refresh]);

  const startWorkshop = useCallback(async () => {
    if (!wsName) return;
    setBusy(true);
    setStartInfo('запуск…');
    try {
      const result = await api.startWorkshop(wsName, wsInput);
      setStartInfo(`run ${String(result.runId).slice(0, 8)}… → ${result.status}`);
      setWsInput({});
      await refresh();
    } catch (e) {
      setStartInfo(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [wsName, wsInput, refresh]);

  const workshop = workshops[wsName];

  return (
    <div className="board">
      <div className="board-launcher">
        <select value={wsName} onChange={(e) => { setWsName(e.target.value); setWsInput({}); }}>
          {Object.entries(workshops).map(([name, info]) => (
            <option key={name} value={name}>{info.title}</option>
          ))}
        </select>
        {workshop?.inputs.map((field) => (
          <textarea
            key={field.name}
            className="ws-input"
            rows={field.kind === 'longtext' ? 2 : 1}
            placeholder={field.placeholder ?? field.label}
            title={field.label}
            value={wsInput[field.name] ?? ''}
            onChange={(e) => setWsInput((current) => ({ ...current, [field.name]: e.target.value }))}
          />
        ))}
        <button disabled={busy || !wsName} onClick={startWorkshop}>▶ Запустить цех</button>
        <label className="check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          только активные
        </label>
        {startInfo && <span className="run-info">{startInfo}</span>}
        {error && <span className="error">{error}</span>}
      </div>

      <div className="board-columns">
        {data?.columns.map((column) => (
          <section key={column.status} className={`column col-${column.status}`}>
            <h3>
              <span>
                {(column.status === 'in_progress' || column.status === 'blocked') && column.cards.length > 0 && (
                  <span className={`dot dot-${column.status}`} />
                )}
                {COLUMN_TITLES[column.status]}
              </span>
              <span className="count">{column.cards.length}</span>
            </h3>
            {/* «Не начато» без разбора — враньё: работа ниже отказа никогда не
                поедет сама, и это должно быть видно, не открывая карточку. */}
            {column.status === 'todo' && data?.summary && column.cards.length > 0 && (
              <p className="column-note">
                {data.summary.queued > 0 && <>в очереди {data.summary.queued} · </>}
                впереди по маршруту {data.summary.ahead}
                {data.summary.stranded > 0 && (
                  <span className="error"> · стоят из-за отказа {data.summary.stranded}</span>
                )}
              </p>
            )}
            <div className="column-body">
              {column.cards.map((card) => (
                <article
                  key={card.id}
                  className={`card${selected?.id === card.id ? ' selected' : ''}`}
                  onClick={() => setSelected(card)}
                >
                  <header>
                    <span className={`dot dot-${card.status}`} title={DOT_TITLE[card.status]} />
                    <span className="glyph">{TYPE_GLYPH[card.node_type] ?? '•'}</span>
                    <b>{card.title}</b>
                  </header>
                  <div className="card-meta">
                    <span className="tag">{card.workflow}</span>
                    <span className="tag ghost">{card.run_id.slice(0, 8)}</span>
                    {card.parent && <span className="tag ghost">↳ {card.parent}</span>}
                  </div>
                  {card.blocked_by && (
                    <div className="stranded-note">
                      стоит из-за отказа <b>{card.blocked_by}</b>
                    </div>
                  )}
                  {card.reasons.length > 0 && (
                    <ul className="reasons">
                      {card.reasons.slice(0, 3).map((reason, index) => <li key={index}>{reason}</li>)}
                    </ul>
                  )}
                  <footer>
                    {card.materials > 0 && <span title="материалов на столе">📄 {card.materials}</span>}
                    {card.attempts > 1 && <span title="попыток">↻ {card.attempts}</span>}
                    {card.repairs > 0 && <span title="доработок">🛠 {card.repairs}</span>}
                    {card.effect_outcome && <span title="эффект">⚡ {card.effect_outcome}</span>}
                    <span className="when">{relative(card.updated_at)}</span>
                  </footer>
                </article>
              ))}
              {column.cards.length === 0 && <p className="hint">пусто</p>}
            </div>
          </section>
        ))}
      </div>

      <aside className="board-detail">
        {selected ? (
          <>
            <h2>{selected.title}</h2>
            <p className="card-meta">
              <span className="tag">{selected.node_type}</span>
              <span className="tag ghost">{selected.workflow}</span>
              <span className="tag ghost">run {selected.run_id.slice(0, 8)}</span>
              <span className={`st-badge st-${selected.status}`}>
                <span className={`dot dot-${selected.status}`} title={DOT_TITLE[selected.status]} />
                {COLUMN_TITLES[selected.status]}
              </span>
            </p>
            {selected.verdict && <p>вердикт гейта: <b>{selected.verdict}</b></p>}
            {selected.reasons.length > 0 && (
              <ul className="reasons">
                {selected.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
              </ul>
            )}
            {selected.action === 'operator_decision' && (
              <div className="decision">
                <label>Комментарий решения</label>
                <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="row">
                  <button disabled={busy} onClick={() => decide('approve')}>✓ Принять</button>
                  <button className="danger" disabled={busy} onClick={() => decide('reject')}>✗ Отклонить</button>
                </div>
                <p className="hint">
                  Или откройте вкладку «Артефакты» и отредактируйте материал — гейт
                  пересмотрит правку по тем же критериям.
                </p>
              </div>
            )}
            {selected.status === 'failed' && (
              <div className="decision">
                <p className="hint">
                  Попытки исчерпаны. Если причина была внешней — не было сети, лежал
                  провайдер — повторите узел: принятый выше материал не тронут.
                </p>
                <textarea rows={2} value={note} placeholder="что изменилось…"
                  onChange={(e) => setNote(e.target.value)} />
                <div className="row">
                  <button disabled={busy} onClick={retry}>↻ Повторить узел</button>
                </div>
              </div>
            )}
            <div className="row">
              <button onClick={() => onOpenArtifacts(selected.run_id)}>Артефакты прогона</button>
              <button onClick={() => api.resume(selected.run_id).then(refresh).catch(() => undefined)}>
                Подтолкнуть прогон
              </button>
            </div>
            <h3>События узла</h3>
            <ol className="events">
              {events.map((event) => (
                <li key={event.seq}>
                  <code>{event.seq}</code> {event.type}
                </li>
              ))}
              {events.length === 0 && <p className="hint">событий пока нет</p>}
            </ol>
          </>
        ) : (
          <p className="hint">кликни по карточке</p>
        )}
      </aside>
    </div>
  );
}
