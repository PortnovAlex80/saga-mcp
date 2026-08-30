import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  useReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge,
} from '@xyflow/react';
import { nodeTypes } from './nodes';
import {
  NODE_TYPES,
  DEMO_GRAPH,
  toGraphDoc,
  fromGraphDoc,
  type DeskNode,
  type DeskNodeData,
  type GraphDoc,
} from './graph';

const NODE_COLORS: Record<string, string> = {
  emit: '#4ade80',
  template: '#60a5fa',
  collect: '#f472b6',
  fail: '#f87171',
  llm: '#a78bfa',
  gate: '#fbbf24',
  effect: '#2dd4bf',
};

let dropCounter = 0;

/** Defaults that make a dropped node runnable as-is: the llm activity talks
 *  to the real model through the opencode CLI (Z.AI coding plan). */
const DEFAULT_PARAMETERS: Record<string, Record<string, unknown>> = {
  llm: {
    mode: 'opencode',
    model: 'zai-coding-plan/glm-5.3-flash',
    prompt: '{{text}}',
  },
  gate: {
    checks: [{ op: 'nonempty' }],
    max_repairs: 2,
  },
  effect: {
    mode: 'git',
    repo: '',
    branch: 'main',
    message: 'apply desk material',
    files: [{ path: 'index.html', field: 'text' }],
  },
};

function Desk() {
  const [nodes, setNodes, onNodesChange] = useNodesState<DeskNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { screenToFlowPosition } = useReactFlow();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [paramText, setParamText] = useState('');
  const [paramError, setParamError] = useState('');
  const [runInfo, setRunInfo] = useState('');
  const [running, setRunning] = useState(false);
  const [workshops, setWorkshops] = useState<Record<string, { title: string; graph: GraphDoc }>>({});
  const [wsName, setWsName] = useState('');
  const [ideaText, setIdeaText] = useState('');

  useEffect(() => {
    fetch('/api/workshops')
      .then((r) => r.json())
      .then((list) => {
        setWorkshops(list);
        const first = Object.keys(list)[0];
        if (first) setWsName(first);
      })
      .catch(() => {
        /* мост не поднят — цеха можно нарисовать руками */
      });
  }, []);

  const selected: DeskNode | undefined = nodes.find((n) => n.selected);

  const addNode = useCallback(
    (sagaType: string, position: { x: number; y: number }) => {
      const data: DeskNodeData = {
        sagaType,
        parameters: DEFAULT_PARAMETERS[sagaType] ? { ...DEFAULT_PARAMETERS[sagaType] } : {},
      };
      setNodes((current) => {
        let id = `${sagaType}_${++dropCounter}`;
        while (current.some((n) => n.id === id)) id = `${sagaType}_${++dropCounter}`;
        return [...current, { id, type: 'saga', position, data }];
      });
    },
    [setNodes]
  );

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) => addEdge({ ...connection, id: `${connection.source}->${connection.target}` }, eds)),
    [setEdges]
  );

  const openInspector = useCallback(
    (node: DeskNode) => {
      const first = (node.data.parameters.items as Array<{ json?: Record<string, unknown> }> | undefined)?.[0];
      const text = first?.json?.text;
      setIdeaText(typeof text === 'string' ? text : '');
      setParamText(JSON.stringify(node.data.parameters, null, 2));
      setParamError('');
    },
    []
  );

  /** Дружественное поле идеи для emit-узлов: правим items[0].json.text,
   *  не заставляя оператора редактировать JSON. */
  const onIdeaChange = useCallback(
    (text: string) => {
      setIdeaText(text);
      if (!selected) return;
      setNodes((current) =>
        current.map((n) => {
          if (n.id !== selected.id) return n;
          const items = Array.isArray(n.data.parameters.items)
            ? [...(n.data.parameters.items as Array<Record<string, unknown>>)]
            : [{ json: {} }];
          items[0] = { ...items[0], json: { ...(items[0]?.json ?? {}), text } };
          return { ...n, data: { ...n.data, parameters: { ...n.data.parameters, items } } };
        })
      );
    },
    [selected, setNodes]
  );

  const applyParams = useCallback(() => {
    if (!selected) return;
    try {
      const parameters = JSON.parse(paramText) as Record<string, unknown>;
      setNodes((current) =>
        current.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, parameters } } : n))
      );
      setParamError('');
    } catch (error) {
      setParamError(error instanceof Error ? error.message : String(error));
    }
  }, [selected, paramText, setNodes]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    setNodes((current) => current.filter((n) => n.id !== selected.id));
    setEdges((current) => current.filter((e) => e.source !== selected.id && e.target !== selected.id));
  }, [selected, setNodes, setEdges]);

  const loadDoc = useCallback(
    (doc: GraphDoc) => {
      const { nodes: docNodes, edges: docEdges } = fromGraphDoc(doc);
      setNodes(docNodes);
      setEdges(docEdges);
    },
    [setNodes, setEdges]
  );

  const runOnKernel = useCallback(async () => {
    setRunning(true);
    setRunInfo('запуск…');
    try {
      const doc = toGraphDoc(nodes, edges);
      const res = await fetch('/api/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'desk-run', graph_json: JSON.stringify(doc) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      let status: string = data.status;
      for (let i = 0; i < 75 && (status === 'running' || status === 'new'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const poll = await fetch(`/api/runs/${data.runId}`);
        const polled = await poll.json();
        status = polled.run?.status ?? status;
      }
      setRunInfo(`run ${String(data.runId).slice(0, 8)}… → ${status}`);
    } catch (error) {
      setRunInfo(`ошибка: ${error instanceof Error ? error.message : String(error)} (мост запущен? npm run bridge)`);
    } finally {
      setRunning(false);
    }
  }, [nodes, edges]);

  const importGraph = useCallback(() => {
    try {
      loadDoc(JSON.parse(importText) as GraphDoc);
      setParamError('');
      setDrawerOpen(false);
    } catch (error) {
      setParamError(`Import: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [importText, loadDoc]);

  return (
    <div className="desk">
      <aside
        className="palette"
        onDragOver={(e) => e.preventDefault()}
      >
        <h2>Узлы</h2>
        {NODE_TYPES.map((t) => (
          <div
            key={t}
            className="palette-item"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/saga-node-type', t)}
            onClick={(e) => {
              const position = screenToFlowPosition({ x: e.clientX + 40, y: e.clientY + 40 });
              addNode(t, position);
            }}
          >
            <span className="swatch" style={{ background: NODE_COLORS[t] ?? '#94a3b8' }} />
            {t}
          </div>
        ))}
        <p className="hint">перетащи на стол или кликни</p>
      </aside>

      <div
        className="desk-canvas"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const sagaType = e.dataTransfer.getData('application/saga-node-type');
          if (!sagaType) return;
          addNode(sagaType, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => openInspector(node)}
          nodeTypes={nodeTypes}
          fitView
        >
          <Background gap={18} />
          <Controls />
          <MiniMap pannable />
          <Panel position="top-left">
            <div className="toolbar">
              {Object.keys(workshops).length > 0 && (
                <>
                  <select value={wsName} onChange={(e) => setWsName(e.target.value)}>
                    {Object.entries(workshops).map(([name, w]) => (
                      <option key={name} value={name}>{w.title}</option>
                    ))}
                  </select>
                  <button onClick={() => loadDoc(workshops[wsName].graph)}>Открыть цех</button>
                </>
              )}
              <button onClick={() => loadDoc(DEMO_GRAPH)}>Demo</button>
              <button onClick={() => { setNodes([]); setEdges([]); }}>Clear</button>
              <button onClick={() => { setImportText(JSON.stringify(toGraphDoc(nodes, edges), null, 2)); setDrawerOpen(true); }}>
                JSON
              </button>
              <button
                disabled={running || nodes.length === 0}
                onClick={runOnKernel}
                title="Построить прогон через мост ядра (npm run bridge)"
              >
                ▶ Run
              </button>
              {runInfo && <span className="run-info">{runInfo}</span>}
            </div>
          </Panel>
        </ReactFlow>
      </div>

      <aside className="inspector">
        <h2>Инспектор</h2>
        {selected ? (
          <>
            <p>
              <b>{selected.id}</b> <span className="tag">{selected.data.sagaType}</span>
            </p>
            {selected.data.sagaType === 'emit' ? (
              <>
                <label>Идея (текст задачи)</label>
                <textarea
                  value={ideaText}
                  onChange={(e) => onIdeaChange(e.target.value)}
                  rows={8}
                  placeholder="опиши идею или задачу…"
                />
                <details>
                  <summary>parameters (JSON)</summary>
                  <textarea value={paramText} onChange={(e) => setParamText(e.target.value)} rows={8} />
                  <button onClick={applyParams}>Применить JSON</button>
                </details>
              </>
            ) : (
              <>
                <label>parameters (JSON)</label>
                <textarea value={paramText} onChange={(e) => setParamText(e.target.value)} rows={12} />
                {paramError && <p className="error">{paramError}</p>}
                <div className="row">
                  <button onClick={applyParams}>Применить</button>
                  <button className="danger" onClick={deleteSelected}>Удалить</button>
                </div>
              </>
            )}
            <div className="row">
              {selected.data.sagaType === 'emit' && (
                <button className="danger" onClick={deleteSelected}>Удалить</button>
              )}
            </div>
          </>
        ) : (
          <p className="hint">кликни по узлу на столе</p>
        )}
      </aside>

      {drawerOpen && (
        <div className="drawer">
          <div className="drawer-card">
            <h2>graph_json</h2>
            <label>текущий стол (копируй в проект)</label>
            <textarea readOnly value={importText} rows={10} />
            <div className="row">
              <button onClick={() => navigator.clipboard.writeText(importText)}>Копировать</button>
            </div>
            <label>импорт: вставь graph_json и загрузи</label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={10}
            />
            <div className="row">
              <button onClick={importGraph}>Загрузить на стол</button>
              <button onClick={() => setDrawerOpen(false)}>Закрыть</button>
            </div>
            {paramError && <p className="error">{paramError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <header className="desk-header">
        <b>Saga5 Desk</b>
        <span>визуальный стол конвейера · W1 skeleton</span>
      </header>
      <Desk />
    </ReactFlowProvider>
  );
}
