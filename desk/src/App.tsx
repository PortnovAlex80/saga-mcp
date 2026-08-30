import { useCallback, useState } from 'react';
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
};

let dropCounter = 0;

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

  const selected: DeskNode | undefined = nodes.find((n) => n.selected);

  const addNode = useCallback(
    (sagaType: string, position: { x: number; y: number }) => {
      const data: DeskNodeData = { sagaType, parameters: {} };
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
      setParamText(JSON.stringify(node.data.parameters, null, 2));
      setParamError('');
    },
    []
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
          <Panel position="top-right">
            <div className="legend">
              <span className="run-info">ядро: emit/template/collect/fail локально · llm — активность (воркер-процесс)</span>
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
            <label>parameters (JSON)</label>
            <textarea value={paramText} onChange={(e) => setParamText(e.target.value)} rows={12} />
            {paramError && <p className="error">{paramError}</p>}
            <div className="row">
              <button onClick={applyParams}>Применить</button>
              <button className="danger" onClick={deleteSelected}>Удалить</button>
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
