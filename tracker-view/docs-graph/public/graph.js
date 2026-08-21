// Specification Workspace — documentation graph frontend.
//
// Renders the unified documentation graph (Saga artifacts + Markdown docs +
// traces) as a read-only projection. Editing remains delegated to editor.js.

(() => {
  'use strict';

  const ACCENT = '#22d3ee';
  const TYPE_COLORS = {
    PRD: '#58a6ff', SRS: '#a371f7', UC: '#3fb950', AC: '#f1c40f',
    FR: '#e67e22', NFR: '#1abc9c', decision: '#9b59b6', theme: '#e84393',
    brief: '#f39c12', doc: '#8b949e', task: '#d19a66', RULE: '#56d364',
    SPEC: '#79c0ff', OQ: '#f85149', hypothesis: '#bc8cff',
    business_metric: '#ffa657', summary: '#6e7681',
  };
  const DEFAULT_COLOR = '#8b949e';

  const LINK_COLORS = {
    parent: '#30363d', covers: '#a371f7', implements: '#3fb950',
    derived_from: '#8b949e', depends_on: '#f39c12', verified_by: '#1abc9c',
    superseded_by: '#e74c3c', implements_spec: '#79c0ff',
  };
  const LINK_GLYPH = {
    parent: '↓ parent', covers: '↳ covers', implements: '↳ impl',
    derived_from: '↳ from', depends_on: '↳ dep', verified_by: '↳ verify',
    superseded_by: '↳ super', implements_spec: '↳ spec',
  };
  const TASK_EDGE_TYPES = new Set(['implements', 'verified_by', 'depends_on']);

  let cy = null;
  let currentSnapshot = null;
  let selectedNodeId = null;

  async function init() {
    if (typeof cytoscape === 'undefined') {
      banner('Не удалось загрузить библиотеку графа. Проверьте доступ к CDN.', 'error');
      return;
    }
    if (typeof window.dagre !== 'undefined' && typeof window.cytoscapeDagre !== 'undefined') {
      cytoscape.use(window.cytoscapeDagre);
    }

    cy = cytoscape({
      container: document.getElementById('cy'),
      wheelSensitivity: 0.2,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (e) => colorFor(e.data('type')),
            'label': 'data(label)',
            'color': '#e6edf3',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'text-wrap': 'wrap',
            'text-max-width': '120px',
            'font-size': '11px',
            'font-family': '-apple-system, "Segoe UI", sans-serif',
            'width': (e) => nodeSize(e),
            'height': (e) => nodeSize(e),
            'shape': (e) => e.data('kind') === 'task' ? 'diamond' : 'round-rectangle',
            'border-width': 0,
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'node:selected',
          style: { 'border-width': 3, 'border-color': ACCENT, 'border-opacity': 1 },
        },
        {
          selector: 'edge',
          style: {
            'width': 1.5,
            'line-color': (e) => LINK_COLORS[e.data('linkType')] || '#484f58',
            'target-arrow-color': (e) => LINK_COLORS[e.data('linkType')] || '#484f58',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.8,
            'opacity': 0.82,
            'overlay-opacity': 0,
          },
        },
        { selector: 'edge:selected', style: { 'width': 3, 'opacity': 1 } },
        { selector: '.faded', style: { 'opacity': 0.12 } },
        { selector: '.highlighted', style: { 'opacity': 1, 'border-width': 2, 'border-color': ACCENT } },
        {
          selector: 'node.search-match',
          style: { 'opacity': 1, 'border-width': 3, 'border-color': ACCENT, 'border-opacity': 0.9 },
        },
      ],
      elements: [],
    });

    cy.on('select', 'node', (evt) => {
      selectedNodeId = evt.target.id();
      renderSidePanel(selectedNodeId);
      focusNodeContext(evt.target);
    });
    cy.on('select', 'edge', (evt) => {
      const edge = evt.target();
      highlightNeighborhood(edge.source(), edge.target());
    });
    cy.on('unselect', 'node', (evt) => {
      if (evt.target.id() === selectedNodeId) selectedNodeId = null;
      if (!currentSearchQuery()) restoreVisualFocus();
    });

    document.getElementById('refresh-btn').addEventListener('click', loadGraph);
    document.getElementById('layout-select').addEventListener('change', runLayout);
    document.getElementById('hide-task-edges').addEventListener('change', applyEdgeFilter);

    const search = document.getElementById('graph-search');
    if (search) {
      search.addEventListener('input', applySearchFilter);
      search.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        search.value = '';
        search.blur();
        applySearchFilter();
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = String(event.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable || !search) return;
      event.preventDefault();
      search.focus();
      search.select();
    });

    await loadProjects();
    const fromUrl = new URLSearchParams(location.search).get('project');
    if (fromUrl) document.getElementById('project-select').value = fromUrl;
    document.getElementById('project-select').addEventListener('change', loadGraph);
    if (document.getElementById('project-select').value) loadGraph();
  }

  async function loadProjects() {
    try {
      const r = await fetch('/api/projects');
      const j = await r.json();
      const sel = document.getElementById('project-select');
      sel.innerHTML = '<option value="">— выберите проект —</option>';
      for (const p of j.projects || []) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} · ${p.artifact_count || 0} артеф.`;
        sel.appendChild(opt);
      }
    } catch (e) {
      banner('Не удалось загрузить список проектов: ' + e.message, 'error');
    }
  }

  async function loadGraph() {
    const pid = document.getElementById('project-select').value;
    if (!pid) return;
    banner('Обновление графа…', 'info', 700);
    try {
      const r = await fetch(`/api/graph?project=${encodeURIComponent(pid)}`);
      const j = await r.json();
      if (!r.ok || !j.available) {
        showEmpty(j.reason || j.error || 'unknown');
        return;
      }
      currentSnapshot = j;
      selectedNodeId = null;
      renderGraph(j);
      const s = j.stats || {};
      setStats(`${s.artifactCount || 0} артефактов · ${s.docCount || 0} документов · ${s.taskCount || 0} задач · ${s.edgeCount || 0} связей`);
      applySearchFilter();
    } catch (e) {
      banner('Ошибка загрузки графа: ' + e.message, 'error');
    }
  }

  function renderGraph(snapshot) {
    cy.elements().remove();
    const hideTaskEdges = document.getElementById('hide-task-edges').checked;
    const nodes = (snapshot.nodes || []).map((n) => ({
      data: { id: n.id, label: nodeLabel(n), type: n.type, kind: n.kind, raw: n },
    }));
    const edges = (snapshot.edges || [])
      .filter((e) => !hideTaskEdges || !isTaskEdge(e))
      .map((e, i) => ({
        data: { id: `e${i}:${e.source}->${e.target}:${e.linkType}`, source: e.source, target: e.target, linkType: e.linkType },
      }));
    cy.add([...nodes, ...edges]);
    runLayout();
    cy.fit(undefined, 60);
  }

  function runLayout() {
    const sel = document.getElementById('layout-select').value;
    const opts = sel === 'dagre'
      ? { name: 'dagre', rankDir: 'TB', nodeSep: 44, rankSep: 74, animate: false }
      : sel === 'breadthfirst'
        ? { name: 'breadthfirst', directed: true, padding: 30, animate: false }
        : sel === 'cose'
          ? { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 100 }
          : sel === 'circle'
            ? { name: 'circle', animate: false }
            : sel === 'concentric'
              ? { name: 'concentric', animate: false }
              : { name: 'grid' };
    const layout = cy.layout(opts);
    layout.one('layoutstop', () => cy.fit(undefined, 60));
    layout.run();
  }

  function applyEdgeFilter() {
    if (!currentSnapshot) return;
    renderGraph(currentSnapshot);
    applySearchFilter();
  }

  function colorFor(type) { return TYPE_COLORS[type] || DEFAULT_COLOR; }
  function nodeSize(ele) {
    if (ele.data('kind') === 'task') return 28;
    if (ele.data('kind') !== 'artifact') return 34;
    return new Set(['PRD', 'SRS', 'UC']).has(ele.data('type')) ? 52 : 38;
  }
  function nodeLabel(n) {
    if (n.kind === 'artifact' && n.code) return n.code;
    if (n.kind === 'task' && n.taskId) return `#${n.taskId}`;
    if (n.path) {
      const last = n.path.split('/').at(-1).replace(/\.md$/i, '');
      return last.length > 28 ? last.slice(0, 25) + '…' : last;
    }
    return n.title || '?';
  }
  function isTaskEdge(edge) { return TASK_EDGE_TYPES.has(edge.linkType); }

  function renderSidePanel(nodeId) {
    const node = (currentSnapshot.nodes || []).find((n) => n.id === nodeId);
    if (!node) return;
    const panel = document.getElementById('side-panel');
    panel.classList.remove('empty');
    const outgoing = (currentSnapshot.edges || []).filter((e) => e.source === nodeId);
    const incoming = (currentSnapshot.edges || []).filter((e) => e.target === nodeId);

    panel.innerHTML = `
      <div class="node-card">
        <div class="header">
          <span class="type-badge ${escapeAttr(node.type)}">${escapeHtml(node.type || '?')}</span>
          ${node.code ? `<span class="code-tag">${escapeHtml(node.code)}</span>` : ''}
          ${node.status ? `<span><span class="status-dot ${escapeAttr(node.status)}"></span>${escapeHtml(node.status)}</span>` : ''}
        </div>
        <h2 class="node-title">${escapeHtml(node.title || '(без названия)')}</h2>
        <div class="kv-list">
          ${kv('Тип', node.kind)}
          ${kv('Путь', node.path)}
          ${node.epicName ? kv('Эпик', node.epicName) : ''}
          ${kv('Hash', shortHash(node.contentHash))}
          ${node.driftState ? kv('Drift', node.driftState) : ''}
          ${node.mtime ? kv('Изменён', new Date(node.mtime).toLocaleString('ru-RU')) : ''}
          ${(node.tags && node.tags.length) ? kv('Теги', node.tags.join(', ')) : ''}
        </div>
        ${node.path ? `<button class="edit-btn" data-path="${escapeAttr(node.path)}">Редактировать документ</button>` : ''}
        ${outgoing.length ? `
          <div><div class="section-title">Исходящие связи (${outgoing.length})</div>
          <div class="edge-list">${outgoing.map(edgeRow(currentSnapshot, 'out')).join('')}</div></div>` : ''}
        ${incoming.length ? `
          <div><div class="section-title">Входящие связи (${incoming.length})</div>
          <div class="edge-list">${incoming.map(edgeRow(currentSnapshot, 'in')).join('')}</div></div>` : ''}
      </div>`;

    panel.querySelectorAll('.edge-row').forEach((row) => {
      row.addEventListener('click', () => {
        const targetId = row.dataset.target;
        if (!targetId) return;
        const target = cy.getElementById(targetId);
        target.select();
        cy.animate({ center: { eles: target }, duration: 160 });
      });
    });
    panel.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (window.docsGraphEditor && btn.dataset.path) window.docsGraphEditor.openForPath(btn.dataset.path);
      });
    });
  }

  function edgeRow(snapshot, dir) {
    return (edge) => {
      const otherId = dir === 'out' ? edge.target : edge.source;
      const other = (snapshot.nodes || []).find((n) => n.id === otherId) || {};
      const glyph = LINK_GLYPH[edge.linkType] || edge.linkType;
      const label = other.code || other.title || other.path || otherId;
      return `<div class="edge-row" data-target="${escapeAttr(otherId)}"><span class="glyph">${escapeHtml(glyph)}</span><span>${escapeHtml(truncate(String(label), 36))}</span></div>`;
    };
  }

  function focusNodeContext(node) {
    if (!node || node.empty()) return;
    cy.elements().removeClass('faded highlighted search-match');
    const edges = node.connectedEdges();
    const keep = node.union(edges).union(edges.connectedNodes());
    cy.elements().not(keep).addClass('faded');
    keep.addClass('highlighted');
    node.removeClass('highlighted');
  }

  function highlightNeighborhood(a, b) {
    cy.elements().removeClass('faded highlighted search-match');
    const direct = cy.elements(`edge[source="${a.id()}"][target="${b.id()}"], edge[source="${b.id()}"][target="${a.id()}"]`);
    const keep = cy.collection().union(a).union(b).union(direct);
    cy.elements().not(keep).addClass('faded');
    keep.addClass('highlighted');
  }

  function currentSearchQuery() {
    return String(document.getElementById('graph-search')?.value || '').trim().toLocaleLowerCase('ru-RU');
  }

  function applySearchFilter() {
    if (!cy) return;
    const input = document.getElementById('graph-search');
    const query = currentSearchQuery();
    input?.closest('.workspace-search')?.classList.toggle('has-query', Boolean(query));
    if (!query) {
      restoreVisualFocus();
      return;
    }

    cy.elements().removeClass('faded highlighted search-match');
    const matches = cy.nodes().filter((node) => nodeMatchesQuery(node.data('raw') || {}, query));
    if (matches.empty()) {
      cy.elements().addClass('faded');
      setSearchCount(0);
      return;
    }
    const contextEdges = matches.connectedEdges();
    const keep = matches.union(contextEdges).union(contextEdges.connectedNodes());
    cy.elements().not(keep).addClass('faded');
    matches.addClass('search-match');
    setSearchCount(matches.length);
    if (matches.length === 1) cy.animate({ center: { eles: matches }, duration: 160 });
  }

  function nodeMatchesQuery(node, query) {
    return [node.code, node.title, node.path, node.type, node.status, node.epicName, ...(Array.isArray(node.tags) ? node.tags : [])]
      .filter(Boolean).join(' ').toLocaleLowerCase('ru-RU').includes(query);
  }

  function setSearchCount(count) {
    const input = document.getElementById('graph-search');
    if (input) input.setAttribute('aria-description', count === 1 ? 'Найден 1 узел' : `Найдено узлов: ${count}`);
  }

  function restoreVisualFocus() {
    if (!cy) return;
    if (currentSearchQuery()) return applySearchFilter();
    cy.elements().removeClass('faded highlighted search-match');
    if (!selectedNodeId) return;
    const selected = cy.getElementById(selectedNodeId);
    if (selected && !selected.empty()) focusNodeContext(selected);
  }

  function showEmpty(reason) {
    document.getElementById('side-panel').classList.add('empty');
    const reasons = {
      'project-not-found': 'Проект не найден.',
      'no-artifacts-table': 'В этой БД нет таблицы artifacts (старая версия Saga).',
    };
    const text = reasons[reason] || 'Граф пуст.';
    if (cy) cy.elements().remove();
    document.getElementById('cy').innerHTML = `<div class="empty-state"><div class="big">${escapeHtml(text)}</div><div>Выберите другой проект.</div></div>`;
    setStats('');
  }

  function banner(msg, kind = 'info', ttl = 0) {
    let el = document.querySelector('.banner');
    if (!el) {
      el = document.createElement('div');
      el.className = 'banner';
      document.body.appendChild(el);
    }
    el.className = `banner ${kind}`;
    el.textContent = msg;
    clearTimeout(el.__ttl);
    if (ttl > 0) el.__ttl = setTimeout(() => el.remove(), ttl);
  }
  function setStats(text) { document.getElementById('stats').textContent = text; }
  function kv(key, value) {
    if (value == null || value === '') return '';
    return `<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(String(value))}</span></div>`;
  }
  function shortHash(hash) { return !hash ? null : hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash; }
  function truncate(value, n) { return value.length > n ? value.slice(0, n - 1) + '…' : value; }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }

  document.addEventListener('DOMContentLoaded', init);
  window.__docsGraphReload = loadGraph;
})();
