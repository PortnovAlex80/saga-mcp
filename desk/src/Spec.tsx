import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ProductDocument } from './api';

// СПЕЦИФИКАЦИИ — документы продукта, которыми человек управляет заводом.
//
// Правка здесь не проходит приёмку, и это намеренно: спецификация — то, чего
// человек хочет, а приёмка судит работу завода. Судить желание заказчика
// заводу нечем и незачем.
//
// Сохранение и «внести изменения» — РАЗНЫЕ действия. Человек может править
// документ несколько раз, прежде чем позвать завод; и наоборот — заказ идёт не
// от новой редакции целиком, а от РАЗНИЦЫ с принятой версией, иначе любое
// уточнение превращалось бы в переписывание продукта заново.

export function Spec() {
  const [docs, setDocs] = useState<ProductDocument[]>([]);
  const [repo, setRepo] = useState('');
  const [current, setCurrent] = useState<ProductDocument | undefined>();
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.documents();
      setRepo(data.repo);
      setDocs(data.documents);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const open = useCallback(async (doc: ProductDocument) => {
    const full = await api.document(doc.path).catch(() => doc);
    setCurrent(full);
    setDraft(full.content);
    setInfo('');
    setNote('');
  }, []);

  const dirty = useMemo(
    () => current !== undefined && draft !== current.content,
    [current, draft]
  );

  const save = useCallback(async (apply: boolean) => {
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.saveDocument({
        path: current.path,
        content: draft,
        note: note || undefined,
        apply,
      });
      if (!saved.changed) {
        setInfo('содержимое не изменилось — сохранять нечего');
      } else if (saved.run) {
        setInfo(`сохранено ${saved.commit.slice(0, 8)} · заказ на изменение: прогон ${saved.run.runId.slice(0, 8)}… (${saved.run.status})`);
      } else {
        setInfo(`сохранено ${saved.commit.slice(0, 8)} · завод пока не звали`);
      }
      setNote('');
      await refresh();
      setCurrent(await api.document(current.path).catch(() => current));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [current, draft, note, refresh]);

  return (
    <div className="spec">
      <aside className="spec-list">
        <h3>Спецификации</h3>
        <p className="muted small">{repo}</p>
        {docs.length === 0 && <p className="muted">Пока нет документов: запустите цех.</p>}
        {docs.map((doc) => (
          <button
            key={doc.path}
            className={current?.path === doc.path ? 'spec-item active' : 'spec-item'}
            onClick={() => open(doc)}
          >
            <b>{doc.path}</b>
            <span className="muted small">
              {doc.author === undefined ? '' : doc.author}
              {doc.commit ? ` · ${doc.commit.slice(0, 8)}` : ''}
            </span>
          </button>
        ))}
      </aside>

      <section className="spec-editor">
        {!current && <p className="muted">Выберите документ слева.</p>}
        {current && (
          <>
            <header>
              <b>{current.path}</b>
              {dirty && <span className="tag warn">есть несохранённая правка</span>}
            </header>
            <textarea
              className="spec-text"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
            />
            <input
              className="spec-note"
              placeholder="чем вызвана правка (попадёт в коммит)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="spec-actions">
              <button disabled={busy || !dirty} onClick={() => save(false)}>
                Сохранить
              </button>
              <button
                className="primary"
                disabled={busy || !dirty}
                title="Сохранить правку и заказать заводу изменение кода — по РАЗНИЦЕ, а не заново"
                onClick={() => save(true)}
              >
                Сохранить и внести изменения
              </button>
              {info && <span className="run-info">{info}</span>}
              {error && <span className="error">{error}</span>}
            </div>
            <p className="muted small">
              Завод получит не новую редакцию целиком, а разницу с принятой версией,
              и будет править существующий код, а не писать его заново.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
