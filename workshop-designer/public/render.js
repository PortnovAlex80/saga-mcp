window.WD = window.WD || {};
(() => {
  const W = window.WD;
  const E = W.escape;
  const center = (n) => ({
    x: (Number(n.x) || 0) + (n.kind === 'production-cell' ? 110 : 95),
    y: (Number(n.y) || 0) + (n.kind === 'production-cell' ? 63 : 53),
  });

  W.renderNodes = () => {
    const layer = W.byId('node-layer');
    const s = W.state;
    layer.innerHTML = s.design.nodes.map((n) => {
      const kind = n.kind === 'production-cell' ? 'РАБОЧИЙ СТОЛ' : n.kind === 'kernel' ? 'АВТОМАТ' : 'ЧЕЛОВЕК';
      const chips = n.kind === 'production-cell'
        ? (n.productContracts || []).slice(0, 2).map((p) => `<span class="chip">${E(p.schemaRef)}</span>`).join('')
        : (n.outputSchema ? `<span class="chip">${E(n.outputSchema)}</span>` : '');
      const foot = n.kind === 'production-cell'
        ? `<div class="node-foot"><span class="badge qc">ОТК</span>${n.review?.enabled ? '<span class="badge review">R</span>' : ''}<span class="badge repair">↺${Number(n.recovery?.maxAttempts || 0)}</span><span class="skill">${E(n.author?.skillRef || '—')}</span></div>`
        : n.kind === 'kernel'
          ? `<div class="node-foot"><span class="badge qc">AUTO</span><span class="skill">${E(n.handler || '—')}</span></div>`
          : `<div class="node-foot"><span class="badge review">HUMAN</span><span class="skill">${E(n.interactionContract || '—')}</span></div>`;
      return `<article class="factory-node ${n.kind}${n.id === s.selectedNodeId ? ' selected' : ''}${s.connectingFrom && s.connectingFrom !== n.id ? ' connect-target' : ''}" data-node-id="${E(n.id)}" style="left:${Number(n.x) || 0}px;top:${Number(n.y) || 0}px"><div class="node-head"><span class="node-kind">${kind}</span><span class="node-id">${E(n.id)}</span></div><div class="node-title">${E(n.label || '(без названия)')}</div><div class="chips">${chips}</div>${foot}</article>`;
    }).join('');
    layer.querySelectorAll('.factory-node').forEach((el) => {
      if (W.onNodePointerDown) el.addEventListener('pointerdown', W.onNodePointerDown);
      if (W.onNodeClick) el.addEventListener('click', W.onNodeClick);
    });
    W.renderSearch();
  };

  W.renderEdges = () => {
    const by = new Map(W.state.design.nodes.map((n) => [n.id, n]));
    W.byId('edge-layer').innerHTML = W.state.design.transitions.map((e) => {
      const a = by.get(e.from);
      const b = by.get(e.to);
      if (!a || !b) return '';
      const p = center(a);
      const q = center(b);
      const dx = Math.max(70, Math.abs(q.x - p.x) * 0.42);
      const d = `M ${p.x} ${p.y} C ${p.x + dx} ${p.y}, ${q.x - dx} ${q.y}, ${q.x} ${q.y}`;
      const lx = (p.x + q.x) / 2;
      const ly = (p.y + q.y) / 2 - 5;
      return `<path class="edge-hit" data-edge-id="${E(e.id)}" d="${d}"></path><path class="edge-line${e.id === W.state.selectedEdgeId ? ' selected' : ''}" d="${d}"></path><text class="edge-label" x="${lx}" y="${ly}" text-anchor="middle">${E(e.on || 'event')}</text>`;
    }).join('');
    W.byId('edge-layer').querySelectorAll('.edge-hit').forEach((el) => el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      W.selectEdge?.(el.dataset.edgeId);
    }));
  };

  W.renderSearch = () => {
    const q = String(W.byId('node-search')?.value || '').trim().toLowerCase();
    document.querySelectorAll('.factory-node').forEach((el) => {
      const n = W.node(el.dataset.nodeId);
      const hit = !q || JSON.stringify(n).toLowerCase().includes(q);
      el.classList.toggle('search-dim', Boolean(q) && !hit);
      el.classList.toggle('search-hit', Boolean(q) && hit);
    });
  };

  W.renderStatus = () => {
    const checks = W.validate(W.state.design);
    const fail = checks.filter((x) => x.level === 'fail').length;
    const warn = checks.filter((x) => x.level === 'warn').length;
    W.byId('status-summary').textContent = `${W.state.design.nodes.length} узлов · ${W.state.design.transitions.length} переходов · ${fail ? `${fail} ошибок` : 'структура без ошибок'}${warn ? ` · ${warn} предупрежд.` : ''}`;
    W.byId('module-name').value = W.state.design.displayName;
    const n = W.node(W.state.selectedNodeId);
    W.byId('breadcrumb').textContent = n ? `Цех › ${n.kind} › ${n.label}` : W.state.selectedEdgeId ? 'Цех › переход' : 'Цех · выберите элемент';
    W.byId('connect-btn').disabled = !W.state.selectedNodeId || Boolean(W.state.connectingFrom);
    W.byId('delete-btn').disabled = !(W.state.selectedNodeId || W.state.selectedEdgeId);
  };

  W.renderProof = () => {
    const checks = W.validate(W.state.design);
    const pass = checks.filter((x) => x.level === 'pass').length;
    const fail = checks.filter((x) => x.level === 'fail').length;
    const warn = checks.filter((x) => x.level === 'warn').length;
    const score = Math.round(pass / Math.max(1, checks.length) * 100);
    W.byId('proof-score').textContent = `${score}%`;
    W.byId('proof-stats').innerHTML = `<span class="proof-stat"><b>${W.state.design.nodes.length}</b> nodes</span><span class="proof-stat"><b>${W.state.design.transitions.length}</b> transitions</span><span class="proof-stat"><b>${pass}</b> passed</span><span class="proof-stat"><b>${warn}</b> warnings</span><span class="proof-stat"><b>${fail}</b> failures</span>`;
    W.byId('proof-list').innerHTML = checks.map((x) => `<div class="proof-item ${x.level}"><span class="proof-icon">${x.level === 'pass' ? '✓' : x.level === 'warn' ? '!' : '×'}</span><span class="proof-name">${E(x.name)}</span><span class="proof-detail">${E(x.detail)}</span></div>`).join('');
  };

  W.renderAll = () => {
    W.renderNodes();
    W.renderEdges();
    W.renderInspector?.();
    W.renderStatus();
    if (W.state.mode === 'proof') W.renderProof();
  };
})();
