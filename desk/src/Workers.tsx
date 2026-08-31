import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type WorkersData, type WorkerView } from './api';

// Монитор смены: кто нанят прямо сейчас, на какой модели, сколько уже работает,
// свежо ли сердцебиение и что он производит в эту секунду.
//
// Живой текст — операционное окно (`executions.progress`, перезаписывается на
// каждом ударе сердца), а не материал. Материал — то, что воркер СДАЁТ.

function hhmmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}м ${String(s % 60).padStart(2, '0')}с` : `${s}с`;
}

/** Доля прожитого бюджета: видно, что воркер вот-вот упрётся в таймаут. */
function budget(worker: WorkerView): { used: number; label: string } | undefined {
  if (worker.status === 'new') {
    return {
      used: worker.elapsed_s / Math.max(1, worker.schedule_to_start_s),
      label: `очередь ${hhmmss(worker.elapsed_s)} из ${worker.schedule_to_start_s}с`,
    };
  }
  if (worker.start_to_close_s) {
    return {
      used: worker.elapsed_s / worker.start_to_close_s,
      label: `${hhmmss(worker.elapsed_s)} из ${hhmmss(worker.start_to_close_s)}`,
    };
  }
  return undefined;
}

/** Воркер шлёт одно поле: фазовый журнал плюс строку потока с префиксом «▶».
 *  Разделяем здесь, чтобы окно не росло: журнал сверху, мысли — одной строкой. */
const phaseLines = (progress: string): string[] =>
  progress.split('\n').filter((line) => !line.startsWith('▶'));

const tickerLine = (progress: string): string =>
  progress.split('\n').filter((line) => line.startsWith('▶')).map((line) => line.slice(2))[0] ?? '';

function WorkerCard({ worker }: { worker: WorkerView }) {
  const bar = budget(worker);
  const running = worker.status === 'running';
  return (
    <article className={`worker${worker.stale ? ' stale' : ''}`}>
      <header>
        {/* Огонёк живой модели: мигает, пока идут дельты потока. */}
        <span
          className={`dot dot-${worker.stale ? 'failed' : worker.producing ? 'in_progress' : running ? 'review' : 'todo'}`}
          title={worker.producing ? 'модель пишет прямо сейчас' : worker.silent_s === null ? 'ждёт' : `молчит ${worker.silent_s}с`}
        />
        <b>{worker.node_id}</b>
        <span className="tag">{worker.model ?? worker.worker_kind ?? '—'}</span>
        {worker.attempt > 1 && <span className="tag warn">попытка {worker.attempt}</span>}
        <span className="tag ghost">{worker.workflow}</span>
        <span className="tag ghost">{worker.run_id.slice(0, 8)}</span>
      </header>

      <div className="worker-meta">
        {running ? (
          <>
            <span>работает {hhmmss(worker.elapsed_s)}</span>
            <span title={`бюджет сердцебиения ${worker.heartbeat_s}с`}>
              пульс {worker.heartbeat_age_s === null ? '—' : hhmmss(worker.heartbeat_age_s)} назад
            </span>
            {worker.signals > 0 && (
              <span title="признаков жизни от модели: дельты потока, шаги, инструменты">
                {worker.producing ? 'пишет' : `молчит ${worker.silent_s}с`} · {worker.signals} сигналов
              </span>
            )}
          </>
        ) : (
          <span>в очереди {hhmmss(worker.elapsed_s)} — свободного места нет или ждёт интервала найма</span>
        )}
        {worker.stale && <span className="error">сердцебиение просрочено, ядро вот-вот снимет попытку</span>}
      </div>

      {bar && (
        <div className="budget" title={bar.label}>
          <i style={{ width: `${Math.min(100, Math.round(bar.used * 100))}%` }} className={bar.used > 0.8 ? 'hot' : ''} />
          <span>{bar.label}</span>
        </div>
      )}

      {worker.progress ? (
        <>
          <pre className="worker-progress">{phaseLines(worker.progress).join('\n')}</pre>
          {/* Мысли модели одной бегущей строкой: окно не растёт. */}
          {tickerLine(worker.progress) && (
            <div className={`ticker${worker.producing ? ' live' : ''}`}>{tickerLine(worker.progress)}</div>
          )}
        </>
      ) : (
        worker.prompt_preview && (
          <details className="worker-task">
            <summary>задание воркеру</summary>
            <pre>{worker.prompt_preview}</pre>
          </details>
        )
      )}
    </article>
  );
}

export function Workers() {
  const [data, setData] = useState<WorkersData | null>(null);
  const [error, setError] = useState('');
  const [maxWorkers, setMaxWorkers] = useState('');
  const [interval, setIntervalMs] = useState('');
  const [saved, setSaved] = useState('');
  const touched = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.workers();
      setData(next);
      // поля лимитов не перетираем, пока оператор их правит
      if (!touched.current) {
        setMaxWorkers(String(next.limits.max_workers));
        setIntervalMs(String(next.limits.min_spawn_interval_ms));
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const save = useCallback(async () => {
    try {
      const result = await api.setLimits({
        max_workers: Number(maxWorkers),
        min_spawn_interval_ms: Number(interval),
      });
      touched.current = false;
      setMaxWorkers(String(result.limits.max_workers));
      setIntervalMs(String(result.limits.min_spawn_interval_ms));
      setSaved(`применено: ${result.limits.max_workers} воркеров, интервал ${result.limits.min_spawn_interval_ms} мс`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [maxWorkers, interval, refresh]);

  const stats = data?.stats;

  return (
    <div className="workers">
      <div className="workers-bar">
        <span className="hire">
          нанято <b>{stats?.running ?? 0}</b> из {data?.limits.max_workers ?? '—'}
          {(stats?.queued ?? 0) > 0 && <> · в очереди <b>{stats?.queued}</b></>}
          {(stats?.stale ?? 0) > 0 && <> · <span className="error">просрочено {stats?.stale}</span></>}
        </span>
        <span className="tag ok">успешно {stats?.succeeded ?? 0}</span>
        <span className="tag warn">неудачно {stats?.failed ?? 0}</span>

        <span className="limit-field">
          <label>одновременно</label>
          <input
            type="number" min={1} max={64} value={maxWorkers}
            onChange={(e) => { touched.current = true; setMaxWorkers(e.target.value); }}
          />
        </span>
        <span className="limit-field">
          <label>интервал найма, мс</label>
          <input
            type="number" min={0} step={500} value={interval}
            onChange={(e) => { touched.current = true; setIntervalMs(e.target.value); }}
          />
        </span>
        <button onClick={save}>Применить лимит</button>
        {saved && <span className="run-info">{saved}</span>}
        {error && <span className="error">{error}</span>}
      </div>

      <div className="workers-body">
        <section>
          <h3>Смена сейчас</h3>
          {data?.live.length ? (
            data.live.map((worker) => <WorkerCard key={worker.execution_id} worker={worker} />)
          ) : (
            <p className="hint">никто не нанят — запусти цех на доске</p>
          )}
        </section>
        <section>
          <h3>Завершённые попытки</h3>
          {data?.recent.map((worker) => (
            <div key={worker.execution_id} className={`worker done st-${worker.status}`}>
              <header>
                <span className={`dot dot-${worker.status === 'success' ? 'done' : 'failed'}`} />
                <b>{worker.node_id}</b>
                <span className="tag ghost">{worker.model ?? worker.worker_kind ?? '—'}</span>
                <span className="tag ghost">{worker.status}</span>
                <span className="tag ghost">{hhmmss(worker.elapsed_s)}</span>
                {worker.usage?.output !== undefined && (
                  <span className="tag ghost" title="токенов ответа / стоимость попытки">
                    {worker.usage.output} ток.
                    {worker.usage.cost ? ` · $${worker.usage.cost.toFixed(4)}` : ''}
                  </span>
                )}
              </header>
              {/* Разбор смены: на чём встали и сколько это заняло. */}
              {worker.progress && (
                <details className="worker-task">
                  <summary>как прошло</summary>
                  <pre>{worker.progress}</pre>
                </details>
              )}
            </div>
          ))}
          {data && data.recent.length === 0 && <p className="hint">пока пусто</p>}
        </section>
      </div>
    </div>
  );
}
