window.WD = window.WD || {};
(() => {
  const W = window.WD;
  let saveTimer = null;
  let drag = null;
  let suppressClick = false;

  W.toast = (message) => {
    const el = W.byId('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => el.classList.add('hidden'), 2600);
  };

  W.changed = ({ render = true } = {}) => {
    W.state.dirty = true;
    const save = W.byId('save-state');
    save.textContent = 'SAVING…';
    save.classList.add('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(W.STORAGE_KEY, JSON.stringify(W.state.design));
        W.state.dirty = false;
        save.textContent = 'SAVED LOCALLY';
        save.classList.remove('dirty');
      } catch (error) {
        save.textContent = 'LOCAL SAVE FAILED';
        W.toast(`Не удалось сохранить draft: ${error.message}`);
      }
    }, 160);
    if (render) W.renderAll();
  };

  W.selectNode = (id) => {
    W.state.inspectModule = false;
    W.state.selectedNodeId = id;
    W.state.selectedEdgeId = null;
    W.renderAll();
  };

  W.selectEdge = (id) => {
    W.state.inspectModule = false;
    W.state.selectedNodeId = null;
    W.state.selectedEdgeId = id;
    W.renderAll();
  };

  W.onNodePointerDown = (event) => {
    if (event.button !== 0 || W.state.connectingFrom) return;
    const el = event.currentTarget;
    const node = W.node(el.dataset.nodeId);
    if (!node) return;
    W.state.inspectModule = false;
    W.state.selectedNodeId = node.id;
    W.state.selectedEdgeId = null;
    W.renderInspector();
    W.renderStatus();
    document.querySelectorAll('.factory-node').forEach((x) => x.classList.toggle('selected', x.dataset.nodeId === node.id));
    drag = { node, el, x: event.clientX, y: event.clientY, ox: Number(node.x) || 0, oy: Number(node.y) || 0, moved: false };
    el.setPointerCapture?.(event.pointerId);
  };

  W.onNodeClick = (event) => {
    event.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const id = event.currentTarget.dataset.nodeId;
    if (W.state.connectingFrom) {
      if (id === W.state.connectingFrom) return W.cancelConnect();
      createConnection(W.state.connectingFrom, id);
      return;
    }
    W.selectNode(id);
  };

  function pointerMove(event) {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.node.x = Math.max(12, drag.ox + dx);
    drag.node.y = Math.max(35, drag.oy + dy);
    drag.el.style.left = `${drag.node.x}px`;
    drag.el.style.top = `${drag.node.y}px`;
    W.renderEdges();
  }

  function pointerUp() {
    if (!drag) return;
    if (drag.moved) {
      suppressClick = true;
      W.changed({ render: false });
      W.renderStatus();
    }
    drag = null;
  }

  function createConnection(from, to) {
    const source = W.node(from);
    const defaultEvent = source?.kind === 'production-cell' ? 'domain.accepted' : source?.kind === 'human' ? 'domain.approved' : 'domain.completed';
    W.state.design.transitions.push(W.edge(from, to, defaultEvent));
    W.state.connectingFrom = null;
    W.state.selectedNodeId = null;
    W.state.selectedEdgeId = W.state.design.transitions.at(-1).id;
    W.byId('connect-banner').classList.add('hidden');
    W.changed();
  }

  W.cancelConnect = () => {
    W.state.connectingFrom = null;
    W.byId('connect-banner').classList.add('hidden');
    W.renderNodes();
    W.renderStatus();
  };

  function startConnect() {
    if (!W.state.selectedNodeId) return;
    W.state.connectingFrom = W.state.selectedNodeId;
    W.byId('connect-banner').classList.remove('hidden');
    W.renderNodes();
    W.renderStatus();
  }

  W.deleteSelected = () => {
    if (W.state.selectedEdgeId) {
      W.state.design.transitions = W.state.design.transitions.filter((e) => e.id !== W.state.selectedEdgeId);
      W.state.selectedEdgeId = null;
      W.changed();
      return;
    }
    const id = W.state.selectedNodeId;
    if (!id) return;
    const node = W.node(id);
    if (!confirm(`Удалить «${node?.label || id}» и все его переходы?`)) return;
    W.state.design.nodes = W.state.design.nodes.filter((n) => n.id !== id);
    W.state.design.transitions = W.state.design.transitions.filter((e) => e.from !== id && e.to !== id);
    W.state.design.terminalNodeIds = W.state.design.terminalNodeIds.filter((x) => x !== id);
    if (W.state.design.entryNodeId === id) W.state.design.entryNodeId = '';
    W.state.selectedNodeId = null;
    W.changed();
  };

  function addNode(kind) {
    const d = W.state.design;
    const n = d.nodes.length + 1;
    const stage = W.byId('stage');
    const x = stage.scrollLeft + 90 + (n % 3) * 34;
    const y = stage.scrollTop + 90 + (n % 4) * 30;
    let node;
    if (kind === 'production-cell') node = W.makeCell(W.uid('desk'), 'Новый рабочий стол', x, y, 'input.schema.v1', 'output.schema.v1');
    else if (kind === 'human') node = W.makeHuman(W.uid('human'), 'Решение человека', x, y);
    else node = W.makeKernel(W.uid('kernel'), 'Новый автомат', x, y);
    d.nodes.push(node);
    W.state.selectedNodeId = node.id;
    W.state.selectedEdgeId = null;
    W.state.inspectModule = false;
    W.changed();
  }

  function setMode(mode) {
    W.state.mode = mode;
    document.querySelectorAll('.modes [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const proof = W.byId('proof');
    for (const el of [document.querySelector('.palette'), document.querySelector('.stage-wrap'), document.querySelector('.inspector')]) {
      el.classList.toggle('hidden', mode === 'proof');
    }
    proof.classList.toggle('hidden', mode !== 'proof');
    if (mode === 'proof') W.renderProof();
  }

  function fitStage() {
    if (!W.state.design.nodes.length) return;
    const xs = W.state.design.nodes.map((n) => Number(n.x) || 0);
    const ys = W.state.design.nodes.map((n) => Number(n.y) || 0);
    W.byId('stage').scrollTo({ left: Math.max(0, Math.min(...xs) - 60), top: Math.max(0, Math.min(...ys) - 60), behavior: 'smooth' });
  }

  function compileDraft() {
    const d = W.state.design;
    const outcomes = [...new Set(d.nodes.filter((n) => n.terminalOutcome).map((n) => n.terminalOutcome))];
    return {
      format: 'saga.process-module.design-draft.v0',
      installable: false,
      warning: 'NOT INSTALLABLE. Compile through an authoritative ProcessModule compiler and production conformance gates before use.',
      identity: { name: d.id, version: d.version, kind: W.slug(d.displayName), displayName: d.displayName, description: d.description },
      inputContract: { id: d.inputContract },
      outputContract: { id: d.outputContract },
      outcomes: outcomes.map((code) => ({ code, terminal: true })),
      flow: {
        id: d.id,
        version: d.version,
        entryNodeId: d.entryNodeId,
        terminalNodeIds: [...d.terminalNodeIds],
        nodes: d.nodes.map(exportNode),
        transitions: d.transitions.map(({ from, to, on }) => ({ from, to, on })),
      },
      designTimeConformance: W.validate(d),
      sourceDesign: W.clone(d),
    };
  }

  function exportNode(n) {
    const base = {
      id: n.id,
      label: n.label,
      kind: n.kind,
      description: n.description || '',
      inputSchema: n.inputSchema ? { id: n.inputSchema } : undefined,
      outputSchema: n.outputSchema ? { id: n.outputSchema } : undefined,
    };
    if (n.kind === 'production-cell') {
      return {
        ...base,
        cellDefinitionDraft: {
          id: n.id,
          inputSelectors: W.clone(n.inputSelectors || []),
          author: W.clone(n.author || {}),
          productContracts: W.clone(n.productContracts || []),
          authorGate: W.clone(n.authorGate || {}),
          review: n.review?.enabled ? W.clone(n.review) : undefined,
          recovery: W.clone(n.recovery || {}),
          postAcceptanceEffect: n.postAcceptanceEffect || undefined,
        },
      };
    }
    if (n.kind === 'kernel') return { ...base, handler: n.handler, emitsOutcome: n.terminalOutcome || undefined };
    if (n.kind === 'human') return { ...base, interactionContract: { id: n.interactionContract } };
    return base;
  }

  function exportDraft() {
    const payload = compileDraft();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${W.slug(W.state.design.displayName)}.workshop-draft.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    W.toast('Design draft экспортирован. Он не является installable Process Module.');
  }

  async function importDraft(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const source = parsed?.format === 'saga.process-module.design-draft.v0' ? parsed.sourceDesign : parsed;
      if (!source || !Array.isArray(source.nodes) || !Array.isArray(source.transitions)) throw new Error('нет nodes/transitions');
      W.state.design = W.normalize(source);
      W.state.selectedNodeId = null;
      W.state.selectedEdgeId = null;
      W.state.connectingFrom = null;
      W.state.inspectModule = false;
      W.changed();
      fitStage();
      W.toast('Draft импортирован.');
    } catch (error) {
      W.toast(`Импорт не выполнен: ${error.message}`);
    }
  }

  function resetDemo() {
    if (!confirm('Вернуть пример Formalization? Текущий local draft будет заменён.')) return;
    W.state.design = W.clone(W.template);
    W.state.selectedNodeId = null;
    W.state.selectedEdgeId = null;
    W.state.connectingFrom = null;
    W.state.inspectModule = false;
    W.changed();
    setTimeout(fitStage, 20);
  }

  function keyboard(event) {
    const tag = String(event.target?.tagName || '').toLowerCase();
    const editing = ['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable;
    if (event.key === 'Escape' && W.state.connectingFrom) {
      event.preventDefault();
      W.cancelConnect();
      return;
    }
    if (event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      W.byId('node-search').focus();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !editing && (W.state.selectedNodeId || W.state.selectedEdgeId)) {
      event.preventDefault();
      W.deleteSelected();
    }
  }

  function init() {
    W.state.inspectModule = false;
    W.byId('module-name').value = W.state.design.displayName;
    W.byId('module-name').addEventListener('input', (e) => {
      W.state.design.displayName = e.target.value;
      W.changed({ render: false });
      W.renderStatus();
    });
    document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addNode(b.dataset.add)));
    document.querySelectorAll('.modes [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    W.byId('connect-btn').addEventListener('click', startConnect);
    W.byId('delete-btn').addEventListener('click', W.deleteSelected);
    W.byId('fit-btn').addEventListener('click', fitStage);
    W.byId('node-search').addEventListener('input', W.renderSearch);
    W.byId('module-settings').addEventListener('click', () => {
      W.state.inspectModule = true;
      W.state.selectedNodeId = null;
      W.state.selectedEdgeId = null;
      W.renderAll();
    });
    W.byId('reset-btn').addEventListener('click', resetDemo);
    W.byId('export-btn').addEventListener('click', exportDraft);
    W.byId('import-btn').addEventListener('click', () => W.byId('import-file').click());
    W.byId('import-file').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) importDraft(f);
      e.target.value = '';
    });
    W.byId('stage').addEventListener('click', (e) => {
      if (e.target !== W.byId('stage') && e.target !== W.byId('node-layer')) return;
      W.state.selectedNodeId = null;
      W.state.selectedEdgeId = null;
      W.state.inspectModule = false;
      W.renderAll();
    });
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    document.addEventListener('keydown', keyboard);
    W.renderAll();
    setTimeout(fitStage, 30);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
